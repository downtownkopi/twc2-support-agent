// Client for calling the main camans server's intake API over the private
// (localhost/internal) network — see .meta/designs/worker-chat-support-service.md.
//
// Signing scheme confirmed against server/app/middleware/verifyIntakeSignature.js:
// HMAC-SHA256 over `${timestamp}.${rawBody}`, sent as headers
// `X-Intake-Timestamp` / `X-Intake-Signature`. Request rejected if older
// than 5 minutes (main server's MAX_REQUEST_AGE_MS). Secret must match the
// main server's `CHAT_INTAKE_HMAC_SECRET` env var exactly.
//
// Field names for the MC status payload (nameOfWorker, finNumber,
// yearOfBirth, mcStatus, etc.) confirmed against
// server/app/controllers/case-management/mcStatus.controller.js
// (createFromIntake / verifyWorkerIdentity).

import { createHmac } from 'node:crypto';

const MAIN_SERVER_INTERNAL_URL = process.env.MAIN_SERVER_INTERNAL_URL || 'http://127.0.0.1:4000';
const INTAKE_HMAC_SECRET = process.env.INTAKE_HMAC_SECRET || '';

function signBody(timestamp, bodyString) {
  return createHmac('sha256', INTAKE_HMAC_SECRET).update(`${timestamp}.${bodyString}`).digest('hex');
}

async function signedPost(path, body) {
  const bodyString = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = signBody(timestamp, bodyString);

  const response = await fetch(`${MAIN_SERVER_INTERNAL_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Intake-Timestamp': timestamp,
      'X-Intake-Signature': signature,
    },
    body: bodyString,
  });

  return response;
}

// Returns { match, employerName, otherJobs }. employerName (current job on
// file) and otherJobs (every other job on record, each with its own most
// recent problem's status — only present when match is true) are a
// second-factor sanity check the agent asks the worker to confirm out
// loud — not a security control, the name+FIN+year match already is that.
// No other partial-field feedback on the match itself, see design doc.
async function verifyWorkerIdentity({ nameOfWorker, finNumber, yearOfBirth }) {
  const response = await signedPost('/api/intake/verify-worker', {
    nameOfWorker,
    finNumber,
    yearOfBirth,
  });

  if (!response.ok) {
    throw new Error(`verify-worker request failed: ${response.status}`);
  }

  const data = await response.json();
  return {
    match: Boolean(data.match),
    employerName: data.employerName || null,
    otherJobs: Array.isArray(data.otherJobs) ? data.otherJobs : [],
  };
}

// Existing endpoint, field names confirmed from mcStatus.controller.js.
async function submitMcStatusIntake(payload) {
  const response = await signedPost('/api/intake/mc-status', payload);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`mc-status intake failed: ${response.status} ${errorBody}`);
  }

  return response.json();
}

// Attaches a worker-uploaded MC/light-duty certificate photo to their case
// (as a PendingChange targeting ordinaryAttachment — see
// ordinaryAttachmentIntake.controller.js). Identity fields resolve the
// worker/job/problem the same way submitMcStatusIntake does; this doesn't
// require the worker to have confirmed anything about the photo's
// contents first — the raw photo is evidence for the caseworker regardless
// of whether OCR could read it.
async function submitMcCertificateAttachment({ nameOfWorker, finNumber, yearOfBirth, imageBase64, mimeType }) {
  const response = await signedPost('/api/intake/mc-certificate', {
    nameOfWorker,
    finNumber,
    yearOfBirth,
    imageBase64,
    mimeType,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`mc-certificate intake failed: ${response.status} ${errorBody}`);
  }

  return response.json();
}

export { verifyWorkerIdentity, submitMcStatusIntake, submitMcCertificateAttachment };
