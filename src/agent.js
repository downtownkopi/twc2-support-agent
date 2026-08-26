// LLM conversation loop — see "LLM Agent Implementation" section of
// .meta/designs/worker-chat-support-service.md, as amended by A1/A2/A3
// (2026-08-26): provider swapped from Anthropic to OpenRouter, model to
// Qwen-Plus, for cost. Uses OpenRouter's OpenAI-compatible
// /chat/completions API via the `openai` SDK with a custom baseURL — not
// the Anthropic Messages API.
//
// Qwen3 Coder Flash (A2's pick) was tested end-to-end and reliably failed
// to emit a real tool call once the full system prompt + multi-turn
// history combined — it fell back to raw `<function=...>` text instead of
// a structured tool_calls response (reproduced 5/5, see A3). Qwen-Plus was
// verified against the identical failing payload, 5/5 clean.
//
// Prompt caching: Qwen-Plus supports OpenRouter's explicit cache_control
// on message content blocks (same `{ type: "ephemeral" }` marker as
// Anthropic). The system prompt is the cached block since it's identical
// every turn.
//
// Streams text chunks via `onTextChunk` per the design doc's streaming
// guidance: text is streamed as it arrives, but tool-call argument deltas
// are fully accumulated (across chunks, keyed by delta index) before a
// tool is ever executed — never dispatched from partial JSON. Retries
// (see openStreamWithRetry) cover stream *creation*. Mid-stream failures
// get exactly one retry-with-restart (see streamOnce, amendment A8) —
// discovered via testing that the Alibaba backend occasionally aborts a
// stream with an intermittent content-moderation false-positive; the
// retry tells the client (onRestart) to discard the partial bubble first,
// so the worker never sees a stitched-together or duplicated reply.

import OpenAI from 'openai';
import { verifyWorkerIdentity, submitMcStatusIntake, submitMcCertificateAttachment } from './mainServerClient.js';
import {
  checkIdentityLockout,
  recordIdentityFailure,
  resetIdentityFailures,
  checkChatRateLimit,
  checkUploadRateLimit,
} from './rateLimit.js';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': process.env.PUBLIC_URL || 'https://support.camans.twc2.org.sg',
    'X-Title': 'TWC2 Support Chat',
  },
});

const MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen-plus';
// Separate vision-capable model for ID-photo OCR (see design doc amendment
// A7) — the main chat model (Qwen-Plus) is text-only. MiMo-V2.5 is a
// reasoning model: it spends tokens on an internal reasoning trace before
// the final JSON, so it needs a much larger max_tokens budget than a plain
// extraction call would (verified empirically — 300 truncated mid-reasoning,
// 1500 completes cleanly).
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || 'xiaomi/mimo-v2.5';
const VISION_MAX_TOKENS = 1500;
const CHAT_MAX_TURNS = Number(process.env.CHAT_MAX_TURNS || 25);
const MAX_RETRIES = 3;

// Single source of truth for TWC2's real office details, confirmed against
// TWC2's own site (twc2.org.sg/info-for-clients-2021/basic-info-english).
// Before this, every "visit the office" message was either vague (no
// address at all) or, worse, the model would confidently state a
// plausible-sounding but entirely made-up Singapore address — seen live
// giving three different fake addresses across three separate replies.
// Grounding both the static messages and the system prompt in one real
// value fixes that at the source instead of hoping the model recalls
// TWC2's actual address correctly on its own.
const TWC2_OFFICE = {
  name: 'TWC2 (Transient Workers Count Too)',
  address: '180B Bencoolen Street #09-01, The Bencoolen, Singapore 189648',
  hours: 'Monday–Friday, 9am–5pm',
  mapsUrl: 'https://maps.app.goo.gl/gEXggT5Lg4znrnUs7',
};
const OFFICE_VISIT_LINE =
  `${TWC2_OFFICE.name}, ${TWC2_OFFICE.address} (open ${TWC2_OFFICE.hours}). Map: ${TWC2_OFFICE.mapsUrl}`;

const LOCKOUT_MESSAGE =
  `For your security, this session is temporarily locked after too many attempts. Please visit the TWC2 office in person, or try again later.\n\n${OFFICE_VISIT_LINE}`;
const RATE_LIMIT_MESSAGE = "You're sending messages a bit fast — please slow down and try again in a moment.";
const OUTAGE_MESSAGE =
  `Having trouble right now — please try again in a moment, or visit the TWC2 office in person.\n\n${OFFICE_VISIT_LINE}`;
const TURN_CAP_MESSAGE =
  `This conversation has gone on a while without finishing — please visit the TWC2 office in person so a caseworker can help directly.\n\n${OFFICE_VISIT_LINE}`;
const UPLOAD_LIMIT_MESSAGE =
  `You've uploaded a few photos already this session — please type your details instead, or visit the TWC2 office in person.\n\n${OFFICE_VISIT_LINE}`;
const UNREADABLE_ID_MESSAGE =
  "I couldn't clearly read your ID card from that photo. Please try a clearer, well-lit photo, or type your full name, FIN, and year of birth instead.";

const BASE_SYSTEM_PROMPT = `You are a support assistant for TWC2 (Transient Workers Count Too), helping migrant workers submit updates about their MC (medical certificate) status.

Before discussing any case matter, you must verify who you're speaking with:
1. Ask for the worker's full name, FIN, and year of birth (just the 4-digit year, not the full date). Mention they can also upload a photo of their ID card instead of typing, if that's easier.
2. Call the verify_identity tool with those three fields.
3. If it returns no match, tell the worker you could not verify their details. Say this could be because the details don't exactly match our records, OR because they're a new client who hasn't registered with TWC2 in person yet — either way, they should visit the TWC2 office in person (registration for new clients can only happen there). Do not guess at corrections or retry with modified details yourself — if the worker wants to try again with corrected details, let them restate the details and call verify_identity again. Never tell a worker definitively that they are or aren't an existing client — always give both possibilities together, exactly as above.
4. If it returns a match, the tool result includes the employer currently on file for their case. Ask the worker to confirm they currently work there (e.g. "Just to confirm, are you currently working at [employer]?") before moving on to MC status questions. If they confirm, proceed normally. If they say no or give a different employer: don't treat this as a failed identity check — the verify_identity match already confirmed who they are. If the tool result also listed other jobs on file, read those out and ask which one (if any) is their current job — this is just to help a caseworker sort out the record later, not something you resolve yourself. Either way, note what the worker told you and continue with MC status questions as normal.

Whenever you mention TWC2's office or tell a worker to visit in person, for any reason (including offering it as an option for urgent help), always give this exact address and link — never invent, guess, or approximate an address: ${TWC2_OFFICE.name}, ${TWC2_OFFICE.address}, open ${TWC2_OFFICE.hours}. Map: ${TWC2_OFFICE.mapsUrl}

If a message tells you the worker uploaded an ID photo and gives you OCR-extracted values, those are already shown to the worker on screen — do not restate the name, FIN, or year of birth yourself in your reply. Just briefly confirm you've read their ID and ask them to flag anything that's wrong, then call verify_identity with the confirmed (or corrected) values. Treat this exactly like typed values otherwise: an OCR read is not itself proof of identity — the same verify_identity check applies regardless of how the details arrived.

Once verified, ask about their MC status conversationally: current MC status, when they received the MC information, when the MC expires, cumulative MC days, light-duty (LD) expiry and cumulative days if applicable, and any remarks. When the worker describes their status in their own words (e.g. "I'm on MC", "back on light duty", "no MC now"), map it to exactly one of submit_mc_status's four mcStatus categories — do not invent a different phrasing. Mention they can also upload a photo of their MC or light-duty certificate instead of typing these details — the details get read automatically and the photo itself is kept on file for the caseworker.

Before calling submit_mc_status, recap what you've gathered in plain language and ask the worker to confirm it's correct. Only call submit_mc_status after they confirm.

After a successful submission, the tool result includes a reference number — give it to the worker exactly as provided (e.g. "Your reference number is TWC2-123 — please keep this for your records") and tell them a caseworker will review it. Also mention this is not an emergency channel — if they need urgent or in-person help, give them the TWC2 office address and link (see below).

If the worker asks a general question about sick leave entitlements (not about their specific case — that's for a caseworker), you may answer using this reference: Singapore's Employment Act 1968, Section 89 (2020 Revised Edition, in force from 5 December 2025). After at least 6 months of service, an employee is entitled to paid outpatient sick leave of up to 14 days per year (up to 60 days per year if hospitalised), certified by a medical practitioner; shorter tiered entitlements apply for 3 to 6 months of service. The employer must be notified within 48 hours if the MC is not from an employer-appointed doctor, or the absence may be treated as unauthorised. The employer pays the employee's gross rate of pay for each certified sick leave day. Always present this as general information, not advice on their specific case — tell them to confirm anything case-specific with a TWC2 caseworker.

Do not use that Section 89 reference at all if the MC relates to a workplace injury, accident, or any dispute with the employer — those are typically governed by the Work Injury Compensation Act instead, which has different rules and entitlements. In that situation, do not guess at what applies — tell the worker a caseworker needs to look at their specific case, and continue collecting their MC status as normal.

When writing dates in your replies to the worker, use a plain readable format like "28 September 2026" — not dashes or slashes (e.g. not "2026-09-28" or "28/09/2026"). This only applies to text you show the worker: submit_mc_status's date arguments must still be ISO 8601 (YYYY-MM-DD), since that's what the system parses.

Keep responses short and clear — many workers are communicating in a non-native language.`;

// The worker picks a language up front (see design doc amendment A6) rather
// than relying on auto-detection from their first message, which is
// unreliable for short/ambiguous opening messages. This directive is
// prepended so the model commits to that language for the whole
// conversation instead of guessing turn by turn.
// The model has no real-time awareness of the current date — its training
// cutoff, not the actual date, is its default assumption. Without this, a
// worker saying "I've had MC since yesterday" gets resolved against
// whatever the model guesses the year is (seen live: guessed 2024). Computed
// fresh per request, not baked in at startup, since this is a long-running
// process. Singapore time, since that's TWC2's actual timezone.
function getCurrentDateContext() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  return `Today's date is ${today} (Singapore time, YYYY-MM-DD format). Use this to resolve any relative dates the worker mentions, e.g. "yesterday", "last week", "since Monday" — do not guess a year from training data.`;
}

function buildSystemPrompt(preferredLanguage) {
  const languageDirective = preferredLanguage
    ? `The worker has selected "${preferredLanguage}" as their preferred language. Always write your replies in ${preferredLanguage}, using its native script, regardless of what language the worker writes in — unless they explicitly ask you to switch languages.\n\n`
    : '';
  return `${getCurrentDateContext()}\n\n${languageDirective}${BASE_SYSTEM_PROMPT}`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'verify_identity',
      description:
        "Verify the worker's identity by matching their full name, FIN, and year of birth against TWC2's records. Call this before discussing any case matter. Returns whether the details matched — no other information.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Worker's full name, as given" },
          fin: { type: 'string', description: "Worker's FIN (Foreign Identification Number)" },
          yearOfBirth: { type: 'string', description: "Worker's birth year, 4 digits (YYYY) — not the full date of birth" },
        },
        required: ['name', 'fin', 'yearOfBirth'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_mc_status',
      description:
        'Submit the collected MC status update for caseworker review. Only call this after identity verification succeeded and the worker has confirmed the recap is correct.',
      parameters: {
        type: 'object',
        properties: {
          // Enum matches the live "MC status" dropdown in the main app
          // exactly (server/tableAndColumns "mc-statuses"/"mc_status" —
          // confirmed 2026-08-26: MC, Light duty, No MC or LD, Other). Free
          // text here (e.g. "On MC") doesn't match any dropdown option in
          // the review-queue UI, so the caseworker sees no value selected.
          // If that dropdown's options ever change in the main app, this
          // enum must be updated to match.
          mcStatus: {
            type: 'string',
            enum: ['MC', 'Light duty', 'No MC or LD', 'Other'],
            description:
              "Worker's current status, mapped to exactly one of these four categories — never free text. Use 'Other' with mcStatusMore filled in if none of the first three fit.",
          },
          mcStatusMore: { type: 'string', description: "Explanation, only used when mcStatus is 'Other'" },
          dateMcInfoReceived: { type: 'string', description: 'ISO 8601 date' },
          dateMcExpires: { type: 'string', description: 'ISO 8601 date' },
          mcDaysCumul: { type: 'number', description: 'Cumulative MC days' },
          dateLdExpires: { type: 'string', description: 'ISO 8601 date, light-duty expiry, if applicable' },
          ldDaysCumul: { type: 'number', description: 'Cumulative light-duty days, if applicable' },
          mcStatusRemarks: { type: 'string', description: 'Free-text remarks' },
        },
        required: ['mcStatus', 'dateMcInfoReceived'],
      },
    },
  },
];

async function openStream(session) {
  return client.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: 'system',
        content: [
          { type: 'text', text: buildSystemPrompt(session.preferredLanguage), cache_control: { type: 'ephemeral' } },
        ],
      },
      ...session.messages,
    ],
    tools: TOOLS,
    stream: true,
  });
}

// Retries only stream *creation* (connection/auth/rate-limit errors before
// any token arrives) — once iteration starts, a failure is surfaced to the
// caller as-is rather than retried, per the file-level comment above.
async function openStreamWithRetry(session) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      return await openStream(session);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

// Consumes one streamed completion: forwards text deltas to onTextChunk as
// they arrive, accumulates tool_call deltas by index (id/name/arguments
// each arrive fragmented across chunks and must be concatenated), and
// returns the fully-assembled result once the stream ends.
async function consumeStream(stream, onTextChunk) {
  let text = '';
  const toolCallsByIndex = [];
  let finishReason = null;

  try {
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        onTextChunk(delta.content);
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallsByIndex[idx]) {
            toolCallsByIndex[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          const acc = toolCallsByIndex[idx];
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.function.name += tc.function.name;
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        }
      }
    }
  } catch (err) {
    // The Alibaba backend has been observed throwing on a trailing frame
    // *after* a complete, coherent reply had already streamed in full and
    // sent a real finish_reason (see design doc amendment A11) — not just
    // before any content, which is what streamOnce's restart-and-retry (A8)
    // was built to handle. A first attempt at this fix accepted *any*
    // already-streamed text as final, but that let through genuinely
    // truncated replies too (an error can also cut in mid-generation,
    // before any finish_reason chunk — text.length > 0 alone doesn't mean
    // "complete", it can just mean "partial"). The reliable signal is
    // finishReason: the model only sends it once, on the real final chunk,
    // so if we captured one before the error, generation had already
    // legitimately finished and the error is just trailing noise — safe to
    // keep. If no finish_reason ever arrived, this is a genuine mid-
    // generation failure and must go through the normal restart-and-retry
    // path instead of showing the worker a sentence cut off mid-word.
    if (!finishReason) throw err;
    // eslint-disable-next-line no-console
    console.error('stream errored after a real finish_reason already arrived — keeping the completed reply', err);
  }

  return { text, toolCalls: toolCallsByIndex.filter(Boolean), finishReason };
}

// Sent alongside a submit_mc_status intake so the caseworker reviewing it
// can see the actual conversation, not just the extracted fields — see
// design doc amendment A14. Filters session.messages down to what the
// worker actually saw: drops tool role messages (raw tool_result payloads,
// meaningless to a caseworker), assistant turns with no visible text (pure
// tool-call steps), and the hidden synthetic instructions this file injects
// for bootstrapping/OCR/nudging — all of those are wrapped in parentheses
// by convention (see startConversation, submitIdPhoto, runTurn's A9 nudge),
// which doubles as the filter marker here.
function buildTranscript(session) {
  return session.messages
    .filter((message) => {
      if (message.role === 'tool') return false;
      if (typeof message.content !== 'string' || !message.content) return false;
      if (message.role === 'user' && message.content.startsWith('(')) return false;
      return true;
    })
    .map((message) => ({
      role: message.role === 'user' ? 'worker' : 'assistant',
      text: message.content,
    }));
}

async function executeTool(toolCall, session, ip) {
  const name = toolCall.function.name;
  let input;
  try {
    input = JSON.parse(toolCall.function.arguments || '{}');
  } catch (err) {
    return { content: `Malformed arguments for ${name}.`, isError: true };
  }

  if (name === 'verify_identity') {
    const { name: workerName, fin, yearOfBirth } = input;
    // Whatever happens below, the tool actually got invoked — clear the
    // OCR-pending-confirmation flag (see runTurn) so a later, unrelated
    // no-match retry can't trigger a stale forced-nudge.
    session.pendingIdExtraction = null;

    let match, employerName, otherJobs;
    try {
      ({ match, employerName, otherJobs } = await verifyWorkerIdentity({ nameOfWorker: workerName, finNumber: fin, yearOfBirth }));
    } catch (err) {
      return { content: 'Identity verification service is temporarily unavailable.', isError: true };
    }

    if (match) {
      session.verified = true;
      resetIdentityFailures(session);
      // Identity fields are re-sent at submit time — the intake endpoint
      // does its own worker/job/problem matching (same as the existing
      // caseworker-facing intake flow), so this service doesn't need to
      // hold a separate worker_id.
      session.identityFields = { nameOfWorker: workerName, finNumber: fin, yearOfBirth };
      // employerName is the current job on file, otherJobs is every other
      // job on record — the model asks the worker to confirm the primary
      // one out loud as a sanity check (see system prompt), only surfacing
      // otherJobs if that confirmation fails. Neither is a security
      // control (the DB match above already is).
      let content = employerName ? `match: true; employer on file: ${employerName}` : 'match: true';
      if (otherJobs?.length > 0) {
        content += `; other jobs on file (mention only if the primary employer is not confirmed): ${JSON.stringify(otherJobs)}`;
      }
      return { content, isError: false };
    }

    recordIdentityFailure(session, ip);
    // No partial feedback — same generic result regardless of which field
    // was wrong. See design doc, Identity Verification Flow.
    return { content: 'match: false', isError: false };
  }

  if (name === 'submit_mc_status') {
    if (!session.verified || !session.identityFields) {
      return { content: 'Cannot submit before identity is verified.', isError: true };
    }

    try {
      const result = await submitMcStatusIntake({
        ...session.identityFields,
        ...input,
        chatTranscript: buildTranscript(session),
      });
      // TWC2-{id} is just PendingChange.id, formatted — same identifier
      // shown in the review-queue table (see reviewQueue/index.jsx), so a
      // worker quoting it back matches exactly what the caseworker sees.
      // Tracked on the session too — runTurn force-relays it if the model
      // doesn't actually say it (same non-compliance risk as A9).
      session.pendingReferenceNumber = result.pendingChangeId;
      return { content: `submitted; reference number: TWC2-${result.pendingChangeId}`, isError: false };
    } catch (err) {
      return { content: 'Submission failed — please try again shortly.', isError: true };
    }
  }

  return { content: `Unknown tool: ${name}`, isError: true };
}

// Wraps one model call with a single restart-and-retry. Discovered via
// testing (see design doc amendment A8): the Alibaba backend occasionally
// aborts a stream mid-reply with "Output data may contain inappropriate
// content" — an intermittent false-positive, not a deterministic block
// (the exact same payload both failed and succeeded across repeated direct
// tests). This contradicts the file's general "don't retry mid-stream"
// rule, which assumed failures meant a real duplicated-reply risk — this
// specific failure mode is provider-side flakiness worth one clean retry.
// onRestart tells the caller to discard whatever partial text already
// reached the client before the retry's chunks start arriving.
async function streamOnce(session, onTextChunk, onRestart) {
  try {
    return await consumeStream(await openStreamWithRetry(session), onTextChunk);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('model stream failed, retrying once', err);
    onRestart();
    return await consumeStream(await openStreamWithRetry(session), onTextChunk);
  }
}

// Shared by runTurn, startConversation, and submitIdPhoto: streams a
// completion, executes any tool_calls (looping until the model produces a
// plain text reply instead), and returns the final reply. Callers are
// responsible for pushing whatever triggered this (typed text, a bootstrap
// greeting instruction, or an OCR-result summary) onto session.messages
// first — this function only handles the streaming/tool-loop mechanics.
async function continueConversation(session, ip, onTextChunk, onRestart = () => {}) {
  let result;
  try {
    result = await streamOnce(session, onTextChunk, onRestart);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('model stream failed twice, giving up', err);
    return { reply: OUTAGE_MESSAGE };
  }

  while (result.finishReason === 'tool_calls') {
    session.messages.push({
      role: 'assistant',
      content: result.text || null,
      tool_calls: result.toolCalls,
    });

    for (const toolCall of result.toolCalls) {
      const toolResult = await executeTool(toolCall, session, ip);
      session.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult.isError ? `Error: ${toolResult.content}` : toolResult.content,
      });
    }

    try {
      result = await streamOnce(session, onTextChunk, onRestart);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('model stream failed twice (tool loop), giving up', err);
      return { reply: OUTAGE_MESSAGE };
    }
  }

  session.messages.push({ role: 'assistant', content: result.text });
  return { reply: result.text };
}

// onTextChunk is called with each text fragment as it streams in (may be a
// no-op — caller decides whether to forward it to the client). Returns the
// final full reply once the turn (including any tool_calls round-trips)
// completes, same contract as before streaming was added.
async function runTurn(session, userText, { ip }, onTextChunk = () => {}, onRestart = () => {}) {
  if (!session.verified) {
    const lockout = checkIdentityLockout(session, ip);
    if (lockout.locked) {
      return { reply: LOCKOUT_MESSAGE };
    }
  }

  const chatLimit = checkChatRateLimit(session);
  if (!chatLimit.allowed) {
    return { reply: RATE_LIMIT_MESSAGE };
  }

  session.turnCount += 1;
  if (session.turnCount > CHAT_MAX_TURNS) {
    return { reply: TURN_CAP_MESSAGE };
  }

  session.messages.push({ role: 'user', content: userText });
  const result = await continueConversation(session, ip, onTextChunk, onRestart);

  // Safety net for a submission whose reference number didn't actually make
  // it into the reply — same non-compliance risk as the A9 nudge below,
  // just for submit_mc_status instead of verify_identity. Runs at most once
  // per submission (cleared either way below).
  if (session.pendingReferenceNumber) {
    const refNumber = session.pendingReferenceNumber;
    session.pendingReferenceNumber = null;
    if (!result.reply.includes(`TWC2-${refNumber}`)) {
      onRestart();
      session.messages.push({
        role: 'user',
        content:
          `(Reminder: the submission already succeeded — reference number TWC2-${refNumber}. Tell the worker ` +
          `this reference number now, plainly, e.g. "Your reference number is TWC2-${refNumber} — please keep ` +
          'this for your records." Do not ask any further questions about their MC status.)',
      });
      return continueConversation(session, ip, onTextChunk, onRestart);
    }
  }

  // Safety net for a confirmed-but-not-acted-on OCR extraction — see design
  // doc amendment A9. Testing showed the model occasionally (not
  // reliably reproducible, so not something a prompt tweak alone can be
  // trusted to fix) responds to the worker's confirmation without actually
  // calling verify_identity, effectively re-asking for details it already
  // has. executeTool clears pendingIdExtraction the moment verify_identity
  // is genuinely called, so if it's still set here, that didn't happen —
  // force it with the known-correct values rather than hope a further
  // typed reply gets it right. Runs at most once per upload (the field is
  // cleared below regardless of outcome, so this can't loop).
  if (session.pendingIdExtraction && !session.verified) {
    const { name, fin, yearOfBirth } = session.pendingIdExtraction;
    session.pendingIdExtraction = null;
    onRestart();
    session.messages.push({
      role: 'user',
      content:
        `(Reminder: OCR previously extracted these identity details, already shown to the worker on screen — ` +
        `name: "${name}", FIN: "${fin}", year of birth: "${yearOfBirth}". Do not restate these values in your ` +
        "reply. If the worker's last message confirmed these are correct, call verify_identity now with " +
        'these values — do not ask them to retype anything. If they instead gave corrected details, use ' +
        'those corrected details for verify_identity instead.)',
    });
    return continueConversation(session, ip, onTextChunk, onRestart);
  }

  return result;
}

// One-shot vision call to OCR an uploaded ID photo. Returns the extracted
// fields, or null if the model couldn't read the card (or says so itself)
// — callers must not treat a parse failure as a hallucinated/partial
// result. This is OCR only, not identity proof: whatever comes back still
// goes through the normal verify_identity DB match, same as typed input
// (see design doc amendment A7) — a wrong or even adversarially-crafted
// OCR read has no more power than a worker mistyping their own details.
async function extractIdFromImage(imageBuffer, mimeType) {
  const base64 = imageBuffer.toString('base64');
  const completion = await client.chat.completions.create({
    model: VISION_MODEL,
    max_tokens: VISION_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Extract the full name, FIN, and year of birth (4-digit year only) from this ID card photo. ' +
              'If you cannot clearly read all three fields, or this does not look like an ID card, respond with ' +
              'exactly {"error": "unreadable"}. Otherwise respond with ONLY this JSON, no other text: ' +
              '{"name": "...", "fin": "...", "yearOfBirth": "..."}',
          },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
  });

  const raw = completion.choices[0].message.content || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return null;
  }

  if (parsed.error || !parsed.name || !parsed.fin || !parsed.yearOfBirth) return null;
  return { name: parsed.name, fin: parsed.fin, yearOfBirth: String(parsed.yearOfBirth) };
}

// Entry point for an uploaded ID-card photo — see design doc amendment A7.
// OCR runs once, then the result is injected as a synthetic user-role
// message (not the raw image — that never touches session.messages or gets
// stored) describing what was read, and the normal conversation loop takes
// over from there: the model must still recap and confirm before calling
// verify_identity, exactly as it does for typed details.
async function submitIdPhoto(
  session,
  imageBuffer,
  mimeType,
  ip,
  onTextChunk = () => {},
  onRestart = () => {},
  onExtracted = () => {},
) {
  if (!session.verified) {
    const lockout = checkIdentityLockout(session, ip);
    if (lockout.locked) {
      return { reply: LOCKOUT_MESSAGE };
    }
  }

  const uploadLimit = checkUploadRateLimit(session);
  if (!uploadLimit.allowed) {
    return { reply: UPLOAD_LIMIT_MESSAGE };
  }

  let extracted;
  try {
    extracted = await extractIdFromImage(imageBuffer, mimeType);
  } catch (err) {
    return { reply: OUTAGE_MESSAGE };
  }

  if (!extracted) {
    return { reply: UNREADABLE_ID_MESSAGE };
  }

  session.turnCount += 1;
  if (session.turnCount > CHAT_MAX_TURNS) {
    return { reply: TURN_CAP_MESSAGE };
  }

  // Tracked so runTurn can force verify_identity with these exact values if
  // the model, on a later turn, fails to actually call the tool despite the
  // worker having confirmed — see design doc amendment A9.
  session.pendingIdExtraction = extracted;

  // The extracted fields are shown to the worker directly via this event
  // (rendered client-side as a plain structured card, not LLM output) —
  // see design doc amendment A10. The model is deliberately told not to
  // restate them in its own reply: testing found the Alibaba backend's
  // content-moderation filter reliably (not just occasionally, as first
  // thought — see A8) blocks completions whose *text* recites an ID-number-
  // like string, but never blocked a plain tool call carrying the same
  // value as a structured argument. Keeping the raw FIN out of the model's
  // free-text output sidesteps the trigger instead of retrying around it.
  onExtracted(extracted);

  session.messages.push({
    role: 'user',
    content:
      `(The worker uploaded a photo of their ID card. OCR extracted — name: "${extracted.name}", ` +
      `FIN: "${extracted.fin}", year of birth: "${extracted.yearOfBirth}". These details are already shown ` +
      "to the worker on screen — do not restate them yourself. Just briefly confirm you've read their ID and " +
      "ask them to let you know if anything shown is wrong. Once they confirm it's correct (or give you " +
      'corrected details instead), call verify_identity with the confirmed values, per your instructions.)',
  });

  return continueConversation(session, ip, onTextChunk, onRestart);
}

// One-shot vision call to OCR an uploaded MC/light-duty certificate photo —
// same non-authoritative role as extractIdFromImage: this only saves the
// worker from typing, submit_mc_status still requires the worker's
// confirmation before anything is submitted for review.
async function extractMcCertificateFromImage(imageBuffer, mimeType) {
  const base64 = imageBuffer.toString('base64');
  const completion = await client.chat.completions.create({
    model: VISION_MODEL,
    max_tokens: VISION_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'This is a photo of a medical certificate (MC) or light-duty certificate. Extract what you can read. ' +
              'Respond with ONLY this JSON, no other text: {"mcStatus": one of "MC", "Light duty", "No MC or LD", ' +
              '"Other", "dateMcInfoReceived": ISO 8601 date the certificate was issued, "dateMcExpires": ISO 8601 ' +
              'date it expires / last day covered, "mcDaysCumul": integer number of days covered, "dateLdExpires": ' +
              'ISO 8601 date or null if no separate light-duty period is stated, "ldDaysCumul": integer or null}. ' +
              'If you cannot clearly read the certificate, or this does not look like a medical/light-duty ' +
              'certificate, respond with exactly {"error": "unreadable"} instead.',
          },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
  });

  const raw = completion.choices[0].message.content || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return null;
  }

  if (parsed.error || !parsed.mcStatus || !parsed.dateMcInfoReceived) return null;
  return parsed;
}

// Entry point for an uploaded MC/light-duty certificate photo. Unlike
// submitIdPhoto, this requires identity to already be verified (there's no
// case to attach a certificate to otherwise). Two independent things
// happen on every upload, regardless of each other's outcome: (1) the raw
// photo is attached to the worker's case as a PendingChange targeting
// ordinaryAttachment — evidence for the caseworker even if OCR fails — and
// (2) OCR is attempted so the worker doesn't have to type their MC details,
// injected as a synthetic message the model must still recap and get
// confirmed before calling submit_mc_status, same as typed input.
async function submitMcCertificatePhoto(
  session,
  imageBuffer,
  mimeType,
  ip,
  onTextChunk = () => {},
  onRestart = () => {},
  onExtracted = () => {},
) {
  if (!session.verified || !session.identityFields) {
    return { reply: 'Please verify your identity first before uploading your MC certificate.' };
  }

  const uploadLimit = checkUploadRateLimit(session);
  if (!uploadLimit.allowed) {
    return { reply: UPLOAD_LIMIT_MESSAGE };
  }

  const [attachmentResult, extractionResult] = await Promise.allSettled([
    submitMcCertificateAttachment({
      ...session.identityFields,
      imageBase64: imageBuffer.toString('base64'),
      mimeType,
    }),
    extractMcCertificateFromImage(imageBuffer, mimeType),
  ]);

  if (attachmentResult.status === 'rejected') {
    // eslint-disable-next-line no-console
    console.error('failed to attach MC certificate photo', attachmentResult.reason);
  }

  session.turnCount += 1;
  if (session.turnCount > CHAT_MAX_TURNS) {
    return { reply: TURN_CAP_MESSAGE };
  }

  const extracted = extractionResult.status === 'fulfilled' ? extractionResult.value : null;
  const attached = attachmentResult.status === 'fulfilled';

  if (!extracted) {
    session.messages.push({
      role: 'user',
      content:
        `(The worker uploaded a photo of their MC/light-duty certificate.${attached ? " It's been attached to their " +
          'case for the caseworker to see, but' : ' The attachment could not be saved, and'} the details on it ` +
        'could not be automatically read. Briefly let the worker know, then ask them to describe their MC status ' +
        'in their own words instead.)',
    });
    return continueConversation(session, ip, onTextChunk, onRestart);
  }

  onExtracted(extracted);

  session.messages.push({
    role: 'user',
    content:
      `(OCR read the worker's uploaded MC/light-duty certificate photo, already shown to the worker on screen: ` +
      `${JSON.stringify(extracted)}.${attached ? " It's also been attached to their case for the caseworker to see." : ' The attachment itself could not be saved, but the reading above is still usable.'} ` +
      'Recap these details in plain language and ask the worker to confirm they are correct before calling ' +
      'submit_mc_status — do not ask them to retype anything unless they say something is wrong.)',
  });

  return continueConversation(session, ip, onTextChunk, onRestart);
}

// Originally called on every /api/chat/start hit (see design doc amendment
// A6) to generate the opening greeting via the model itself, rather than 13
// hand-translated strings baked into the client (translation-quality risk,
// and drifts out of sync with the system prompt's actual wording over
// time). The live server now serves a frozen, pre-verified greeting per
// language instead (languages.js, GREETINGS) — the bootstrap instruction
// below never varied, so this was a real, billable model call producing an
// identical result every time, on the one endpoint reachable before any
// session/identity exists to rate-limit against. Kept here for
// capture-greetings.mjs, which re-derives GREETINGS from this exact code
// path whenever the system prompt changes enough to need it.
async function startConversation(session, languageName, { ip } = {}, onTextChunk = () => {}, onRestart = () => {}) {
  if (session.messages.length > 0) {
    // Already started (e.g. duplicate call) — don't re-greet or reset state.
    return { reply: '' };
  }

  session.preferredLanguage = languageName;
  session.messages.push({
    role: 'user',
    content:
      '(The worker just opened this chat and selected their language. Greet them briefly and ask for their full name, FIN, and year of birth, per your instructions.)',
  });

  return continueConversation(session, ip, onTextChunk, onRestart);
}

export { runTurn, startConversation, submitIdPhoto, submitMcCertificatePhoto };
