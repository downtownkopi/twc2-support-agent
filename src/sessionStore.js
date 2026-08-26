// In-memory session store. Single-instance only — see Tradeoffs in
// .meta/designs/worker-chat-support-service.md ("In-memory rate-limit/session
// store vs Redis"). Revisit if this service is ever horizontally scaled.

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min idle -> session dropped
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map();

function createSession(sessionId) {
  const now = Date.now();
  const session = {
    id: sessionId,
    createdAt: now,
    lastActivityAt: now,
    messages: [], // Anthropic Messages API history for this conversation
    verified: false,
    workerId: null, // server-side only; never sent to the client
    turnCount: 0,
    preferredLanguage: null, // set once via /api/chat/start, e.g. "Tamil"
    identityFailCount: 0,
    lockedUntil: null, // epoch ms; null = not locked out
    uploadCount: 0, // ID-photo uploads this session — capped, see rateLimit.js
    pendingIdExtraction: null, // set after OCR, cleared once verify_identity is actually called — see agent.js runTurn
    pendingReferenceNumber: null, // set after a successful submit_mc_status, cleared once the reply actually states it — see agent.js runTurn
  };
  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.lastActivityAt > SESSION_IDLE_TIMEOUT_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function getOrCreateSession(sessionId) {
  return getSession(sessionId) || createSession(sessionId);
}

function touch(session) {
  session.lastActivityAt = Date.now();
}

function sweep() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivityAt > SESSION_IDLE_TIMEOUT_MS) {
      sessions.delete(id);
    }
  }
}

setInterval(sweep, SWEEP_INTERVAL_MS).unref();

// Serializes handling per session — see design doc amendment A12. Two
// concurrent requests against the same session (a double-tap, a message
// sent right as an upload is still processing, multiple tabs) previously
// raced against the same session.messages array with no ordering
// guarantee; client-side button-disabling only discourages this from the
// UI, it doesn't prevent it (nothing stops a second real HTTP request from
// arriving). This is a standard promise-chain mutex: each call queues
// behind whatever's currently running for that session ID and runs once
// its predecessor settles, success or failure.
const sessionLocks = new Map();
function withSessionLock(sessionId, fn) {
  const tail = sessionLocks.get(sessionId) || Promise.resolve();
  const result = tail.then(fn, fn);
  sessionLocks.set(sessionId, result.catch(() => {}));
  return result;
}

export { getOrCreateSession, getSession, touch, withSessionLock };
