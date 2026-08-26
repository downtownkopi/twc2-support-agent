// Two independent limiters, per .meta/designs/worker-chat-support-service.md:
//   1. General chat: messages/min per session.
//   2. Identity-match: tighter, session-primary + IP-secondary, with lockout.
// In-memory only — see sessionStore.js note on single-instance scope.

const IDENTITY_MAX_ATTEMPTS = Number(process.env.IDENTITY_MATCH_MAX_ATTEMPTS || 4);
const IDENTITY_LOCKOUT_MS = Number(process.env.IDENTITY_LOCKOUT_MINUTES || 30) * 60 * 1000;
const CHAT_MESSAGES_PER_MINUTE = Number(process.env.CHAT_MESSAGES_PER_MINUTE || 15);
// Tighter than general chat — each upload costs a real vision-model call
// regardless of what the image contains, so this caps cost/abuse
// independent of the identity-match limiter above (an OCR miss doesn't
// count as an identity failure, so it needs its own ceiling).
const UPLOAD_MAX_PER_SESSION = Number(process.env.ID_UPLOAD_MAX_PER_SESSION || 6);

// IP-level tracking outlives any single session (session gets a fresh
// identityFailCount on cookie clear; IP does not).
const ipIdentityState = new Map(); // ip -> { failCount, lockedUntil }
const IP_LOCKOUT_MULTIPLIER = 3; // looser cap than per-session, catches multi-session abuse

function getIpState(ip) {
  let state = ipIdentityState.get(ip);
  if (!state) {
    state = { failCount: 0, lockedUntil: null };
    ipIdentityState.set(ip, state);
  }
  return state;
}

function checkIdentityLockout(session, ip) {
  const now = Date.now();
  if (session.lockedUntil && session.lockedUntil > now) {
    return { locked: true, retryAfterMs: session.lockedUntil - now };
  }
  const ipState = getIpState(ip);
  if (ipState.lockedUntil && ipState.lockedUntil > now) {
    return { locked: true, retryAfterMs: ipState.lockedUntil - now };
  }
  return { locked: false };
}

function recordIdentityFailure(session, ip) {
  session.identityFailCount += 1;
  const ipState = getIpState(ip);
  ipState.failCount += 1;

  const now = Date.now();
  if (session.identityFailCount >= IDENTITY_MAX_ATTEMPTS) {
    session.lockedUntil = now + IDENTITY_LOCKOUT_MS;
  }
  if (ipState.failCount >= IDENTITY_MAX_ATTEMPTS * IP_LOCKOUT_MULTIPLIER) {
    ipState.lockedUntil = now + IDENTITY_LOCKOUT_MS;
  }

  return {
    lockedOut: session.lockedUntil !== null && session.lockedUntil > now,
    attemptsRemaining: Math.max(0, IDENTITY_MAX_ATTEMPTS - session.identityFailCount),
    // Attempt #1 is frictionless; captcha required starting attempt #2 — see design doc.
    captchaRequired: session.identityFailCount >= 1,
  };
}

function resetIdentityFailures(session) {
  session.identityFailCount = 0;
  session.lockedUntil = null;
}

function checkUploadRateLimit(session) {
  if (session.uploadCount >= UPLOAD_MAX_PER_SESSION) {
    return { allowed: false };
  }
  session.uploadCount += 1;
  return { allowed: true };
}

function checkChatRateLimit(session) {
  const now = Date.now();
  if (!session.messageTimestamps) session.messageTimestamps = [];
  session.messageTimestamps = session.messageTimestamps.filter((t) => now - t < 60_000);
  if (session.messageTimestamps.length >= CHAT_MESSAGES_PER_MINUTE) {
    return { allowed: false };
  }
  session.messageTimestamps.push(now);
  return { allowed: true };
}

// Periodic sweep so ipIdentityState doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of ipIdentityState) {
    const staleAndUnlocked = !state.lockedUntil && state.failCount === 0;
    const lockoutExpiredLongAgo = state.lockedUntil && now - state.lockedUntil > IDENTITY_LOCKOUT_MS;
    if (staleAndUnlocked || lockoutExpiredLongAgo) {
      ipIdentityState.delete(ip);
    }
  }
}, 60 * 60 * 1000).unref();

export {
  checkIdentityLockout,
  recordIdentityFailure,
  resetIdentityFailures,
  checkChatRateLimit,
  checkUploadRateLimit,
  IDENTITY_MAX_ATTEMPTS,
};
