// Maintenance script: (re-)capture the model's real greeting per language,
// using the exact same code path (startConversation) the live app used to
// call on every /api/chat/start hit — not a hand-written translation. The
// live server now serves the frozen result from languages.js's GREETINGS
// instead of calling the model each time (see server.js). Re-run this and
// paste the output back into GREETINGS whenever the system prompt's
// substance changes enough that the frozen greeting could drift out of
// sync with what the agent actually does. Requires OPENROUTER_API_KEY etc.
// from .env — run with `set -a; source .env; set +a; node capture-greetings.mjs`.
import { writeFileSync } from 'node:fs';
import { startConversation } from './src/agent.js';
import { SUPPORTED_LANGUAGES } from './src/languages.js';

function newSession(id) {
  return {
    id,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    messages: [],
    verified: false,
    workerId: null,
    turnCount: 0,
    preferredLanguage: null,
    identityFailCount: 0,
    lockedUntil: null,
    uploadCount: 0,
    pendingIdExtraction: null,
    pendingReferenceNumber: null,
  };
}

const results = {};
for (const [code, name] of Object.entries(SUPPORTED_LANGUAGES)) {
  const session = newSession(`capture-${code}`);
  const { reply } = await startConversation(session, name, { ip: '127.0.0.1' });
  results[code] = reply;
  console.log(`--- ${name} (${code}) ---`);
  console.log(reply);
  console.log();
}

writeFileSync('./captured-greetings.json', JSON.stringify(results, null, 2));
console.log('Saved to captured-greetings.json');
