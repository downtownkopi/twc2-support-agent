// Cloudflare Turnstile verification — required starting identity-match
// attempt #2 (see design doc, Identity Verification Flow).

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET_KEY) {
    // Local dev without a configured Turnstile secret — don't block.
    return true;
  }
  if (!token) return false;

  const body = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token, remoteip: ip });
  const response = await fetch(VERIFY_URL, { method: 'POST', body });
  const data = await response.json();
  return Boolean(data.success);
}

export { verifyTurnstile };
