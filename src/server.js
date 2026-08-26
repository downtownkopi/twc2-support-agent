import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import sharp from 'sharp';
import { getOrCreateSession, touch, withSessionLock } from './sessionStore.js';
import { runTurn, submitIdPhoto, submitMcCertificatePhoto } from './agent.js';
import { verifyTurnstile } from './captcha.js';
import { SUPPORTED_LANGUAGES, GREETINGS } from './languages.js';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Max dimension after resize — controls vision-model token cost, not just
// upload size. sharp strips EXIF/metadata by default (no withMetadata()
// call), which matters here: phone photos routinely embed GPS coordinates,
// and there's no reason a worker's location should reach a third-party API
// just because they photographed their ID card or MC certificate.
const PHOTO_MAX_DIMENSION = 1600;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5099);

const app = express();

// This service sits behind Cloudflare / an edge proxy (see design doc,
// Hosting section) — trust the one hop in front of it so req.ip and
// cf-connecting-ip resolve correctly instead of always seeing the proxy's IP.
app.set('trust proxy', 1);

// Scoped per-route, not a blanket app.use — /api/chat/upload-id needs a much
// larger limit (image payloads) than the text routes, and Express runs
// middleware in registration order regardless of which route eventually
// matches, so a global small limit would reject uploads before they ever
// reached the route-specific parser.
const jsonBody = express.json({ limit: '32kb' });
app.use(express.static(path.join(__dirname, '..', 'public')));

function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

// IP-based floor under every /api/* route, independent of session ID.
// The per-session limiters in rateLimit.js (chat/min, uploads/session,
// identity attempts) are all keyed by session.id — but session.id is a
// client-supplied header (X-Session-Id), not signed or verified, so an
// attacker gets a fresh, empty counter for free just by minting a new UUID
// per request. This sits underneath those as defense-in-depth, and is the
// only thing capping /api/chat/start at all — that route has no
// session-scoped limiter since it runs before any session exists, and
// every hit costs a real LLM call (the bootstrap greeting).
const generalApiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(getClientIp(req)),
  message: { error: 'rate_limited' },
});

const startChatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(getClientIp(req)),
  message: { error: 'rate_limited' },
});

// Tighter than the general 60/min floor — a single upload costs far more
// than a single chat message (large-body JSON.parse + base64 decode on the
// main thread, plus real CPU time for sharp's resize/re-encode), so the
// general limit alone lets an attacker spend their whole per-minute budget
// on the most expensive request type available. Applied on top of, not
// instead of, generalApiLimiter below.
const uploadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(getClientIp(req)),
  message: { error: 'rate_limited' },
});

app.use('/api', generalApiLimiter);

// Session ID comes from an explicit X-Session-Id header (client generates
// and persists it in localStorage — see public/index.html), not a
// Set-Cookie'd browser cookie. Discovered via live debugging (design doc
// amendment A13): Safari was silently not sending the session cookie back
// on every single request, so every message landed as a brand-new,
// memory-less session — the "forgets everything" bug wasn't in the LLM
// flow at all. Cookies are also known to behave unpredictably in in-app
// browsers (WhatsApp, Facebook Messenger) that workers are realistically
// likely to open this link from, so an explicit application-level header
// (not policed by any browser cookie jar) is the more robust choice for
// this specific audience, not just a Safari workaround.
function getOrIssueSession(req) {
  const sessionId = req.get('X-Session-Id') || randomUUID();
  const session = getOrCreateSession(sessionId);
  touch(session);
  return session;
}

function startSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Called once, right after the worker picks a language on the picker
// screen — see design doc amendment A6. Used to generate the greeting via a
// real model call every time; now serves a static, pre-verified greeting
// per language instead (see languages.js, GREETINGS) — the bootstrap
// instruction never varied, so the model was re-deriving an identical
// output on every hit of the one endpoint reachable before any
// session/identity exists to rate-limit against.
app.post('/api/chat/start', startChatLimiter, jsonBody, async (req, res) => {
  const languageCode = req.body?.language;
  const languageName = SUPPORTED_LANGUAGES[languageCode];
  const greeting = GREETINGS[languageCode];
  if (!languageName || !greeting) {
    return res.status(400).json({ error: 'unsupported language' });
  }

  const session = getOrIssueSession(req);

  await withSessionLock(session.id, async () => {
    const sendEvent = startSSE(res);
    if (session.messages.length === 0) {
      session.preferredLanguage = languageName;
      session.messages.push({ role: 'assistant', content: greeting });
    }
    sendEvent('chunk', { text: greeting });
    sendEvent('done', { reply: greeting });
    res.end();
  });
});

// Separate, larger body-size limit than the main chat route — this is the
// only endpoint that accepts image payloads. See design doc amendment A7.
app.post('/api/chat/upload-id', uploadLimiter, express.json({ limit: '12mb' }), async (req, res) => {
  const { imageBase64, mimeType } = req.body || {};

  if (typeof imageBase64 !== 'string' || !ALLOWED_IMAGE_TYPES.has(mimeType)) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  let rawBuffer;
  try {
    rawBuffer = Buffer.from(imageBase64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  let processedBuffer;
  try {
    // Re-encoding (not just passing the upload through) is itself a content
    // validation step — sharp throws on anything that isn't a real,
    // decodable image, regardless of what mimeType the client claimed.
    processedBuffer = await sharp(rawBuffer)
      .rotate() // apply EXIF orientation before that metadata gets stripped
      .resize({ width: PHOTO_MAX_DIMENSION, height: PHOTO_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (err) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  const session = getOrIssueSession(req);
  const ip = getClientIp(req);

  await withSessionLock(session.id, async () => {
    const sendEvent = startSSE(res);
    try {
      const { reply } = await submitIdPhoto(
        session,
        processedBuffer,
        'image/jpeg',
        ip,
        (chunk) => sendEvent('chunk', { text: chunk }),
        () => sendEvent('restart', {}),
        (extracted) => sendEvent('extracted', extracted),
      );
      sendEvent('done', { reply });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('id photo upload failed', err);
      sendEvent('error', {
        message: 'Having trouble right now — please try again in a moment, or visit the TWC2 office in person.',
      });
    }
    res.end();
  });
});

// Same shape as /api/chat/upload-id (large body limit, sharp re-encode as
// validation + EXIF strip) but for a worker's MC/light-duty certificate
// photo, taken after identity is already verified — see agent.js,
// submitMcCertificatePhoto.
app.post('/api/chat/upload-mc-certificate', uploadLimiter, express.json({ limit: '12mb' }), async (req, res) => {
  const { imageBase64, mimeType } = req.body || {};

  if (typeof imageBase64 !== 'string' || !ALLOWED_IMAGE_TYPES.has(mimeType)) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  let rawBuffer;
  try {
    rawBuffer = Buffer.from(imageBase64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  let processedBuffer;
  try {
    processedBuffer = await sharp(rawBuffer)
      .rotate()
      .resize({ width: PHOTO_MAX_DIMENSION, height: PHOTO_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (err) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  const session = getOrIssueSession(req);
  const ip = getClientIp(req);

  await withSessionLock(session.id, async () => {
    const sendEvent = startSSE(res);
    try {
      const { reply } = await submitMcCertificatePhoto(
        session,
        processedBuffer,
        'image/jpeg',
        ip,
        (chunk) => sendEvent('chunk', { text: chunk }),
        () => sendEvent('restart', {}),
        (extracted) => sendEvent('extracted-mc', extracted),
      );
      sendEvent('done', { reply });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('MC certificate photo upload failed', err);
      sendEvent('error', {
        message: 'Having trouble right now — please try again in a moment, or visit the TWC2 office in person.',
      });
    }
    res.end();
  });
});

app.post('/api/chat', jsonBody, async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.slice(0, 4000) : '';
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const session = getOrIssueSession(req);
  const ip = getClientIp(req);

  await withSessionLock(session.id, async () => {
    // Captcha required starting identity-match attempt #2 — see design doc.
    if (!session.verified && session.identityFailCount >= 1) {
      const captchaOk = await verifyTurnstile(req.body?.captchaToken, ip);
      if (!captchaOk) {
        res.status(400).json({ error: 'captcha_required' });
        return;
      }
    }

    // SSE from here on — headers must be set before the first write, and
    // the captcha short-circuit above must stay plain JSON (it returns
    // before any model call, so there's nothing to stream).
    const sendEvent = startSSE(res);

    try {
      const { reply } = await runTurn(
        session,
        message,
        { ip },
        (chunk) => sendEvent('chunk', { text: chunk }),
        () => sendEvent('restart', {}),
      );
      sendEvent('done', { reply });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('chat turn failed', err);
      sendEvent('error', {
        message: 'Having trouble right now — please try again in a moment, or visit the TWC2 office in person.',
      });
    }
    res.end();
  });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`support-service listening on :${PORT}`);
});
