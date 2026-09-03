#!/usr/bin/env node
// The no-shortcuts user simulation: does exactly what a human with a phone
// does, against the live hosted system.
//   1. Obtains a REAL disposable mailbox (Guerrilla Mail public API).
//   2. Signs up through URLs resolved by the app's OWN routing module.
//   3. Waits for the verification email to arrive IN THE MAILBOX and
//      extracts the code from the message body — no admin backdoor.
//   4. Verifies the code and asserts a live session.
// If any seam a real user crosses is broken — routing, gateway, auth
// semantics, mail dispatch, mail delivery — this fails where they fail.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/real-user-smoke.mjs
import { randomBytes, randomUUID } from 'node:crypto';
import { resolveApiUrl } from '../../apps/newone/src/config/api-routing.mjs';
import { EXPECTED_PROJECT_REF, makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, loadAccessToken, projectKeys } from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') {
  fail('Set NEWONE_HOSTED_E2E=1 to run the real-user smoke');
}

const SUPABASE_URL = `https://${EXPECTED_PROJECT_REF}.supabase.co`;
const GUERRILLA = 'https://api.guerrillamail.com/ajax.php';

async function guerrilla(params) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${GUERRILLA}?${query}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) fail(`mailbox API failed (${response.status})`);
  return await response.json();
}

// 1. Real disposable inbox.
const inbox = await guerrilla({ f: 'get_email_address', lang: 'en' });
const email = inbox.email_addr;
const sid = inbox.sid_token;
if (!email || !sid) fail('could not obtain a disposable mailbox', inbox);
console.log('mailbox:', email);

// 2. Signup through the app's own URL resolution.
const keys = projectKeys(loadAccessToken());
const runId = makeRunId();
const username = `e2e_real_${randomBytes(3).toString('hex')}`;
const installationId = randomUUID();
const headers = {
  'Content-Type': 'application/json',
  apikey: keys.publishableKey,
  'x-newone-installation-id': installationId,
  'x-newone-client-platform': 'ios',
};
async function viaApp(path, body) {
  const url = resolveApiUrl({ path, platform: 'ios', apiBase: '/api', supabaseUrl: SUPABASE_URL });
  if (!url) fail(`app routing cannot resolve ${path}`);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

const request = await viaApp('/v2/auth/native/signup/request', {
  destination: email,
  username,
  displayName: 'Real User Smoke',
  language: 'en',
  installationId,
});
const requestStatus = request.payload?.data?.status ?? request.payload?.status;
if (request.status !== 202 || requestStatus !== 'code_sent') {
  fail(`signup request refused (${request.status})`, request.payload);
}
console.log('signup requested; watching the real inbox...');

// 3. Poll the actual mailbox for the code, like a human refreshing email.
let code = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline && !code) {
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const list = await guerrilla({ f: 'get_email_list', offset: 0, sid_token: sid });
  for (const message of list.list ?? []) {
    const full = await guerrilla({ f: 'fetch_email', email_id: message.mail_id, sid_token: sid });
    const body = `${full.mail_subject ?? ''} ${full.mail_body ?? ''}`.replace(/<[^>]+>/g, ' ');
    const match = body.match(/\b(\d{6})\b/);
    if (match) { code = match[1]; break; }
  }
}
if (!code) {
  fail('verification email NEVER ARRIVED in the real mailbox within 2 minutes — this is what a stuck user experiences');
}
console.log('verification email arrived; code extracted from the message body');

// 4. Verify like the app would.
const verify = await viaApp('/v2/auth/native/signup/verify', {
  destination: email,
  code,
  installationId,
});
const verifyData = verify.payload?.data ?? verify.payload ?? {};
if (verify.status !== 200) fail(`verify failed (${verify.status})`, verify.payload);
if (verifyData.signup?.organizationId !== PERSONAL_REALM_ID) {
  fail('signup receipt missing/incorrect', verifyData.signup);
}
if (typeof verifyData.session?.accessToken !== 'string') fail('no session issued');
console.log(`PASS: full real-user journey — inbox ${email} → @${verifyData.signup.username} with a live session`);
