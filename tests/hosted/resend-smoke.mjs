#!/usr/bin/env node
// Real-inbox reproduction of the "Resend code" lockout seen on device:
//   1. Sign up with a REAL disposable mailbox and wait for code #1.
//   2. Tap "Resend" (the same signup request again) and wait for code #2.
//   3. Prove code #2 signs the user in (and record whether code #1 still works),
//      so a resend can never strand a real person.
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/resend-smoke.mjs
import { randomBytes, randomUUID } from 'node:crypto';
import { resolveApiUrl } from '../../apps/newone/src/config/api-routing.mjs';
import { EXPECTED_PROJECT_REF } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, loadAccessToken, projectKeys } from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1 to run the resend smoke');
const SUPABASE_URL = `https://${EXPECTED_PROJECT_REF}.supabase.co`;
const GUERRILLA = 'https://api.guerrillamail.com/ajax.php';
async function guerrilla(params) {
  const response = await fetch(`${GUERRILLA}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) fail(`mailbox API failed (${response.status})`);
  return await response.json();
}
const inbox = await guerrilla({ f: 'get_email_address', lang: 'en' });
const email = inbox.email_addr; const sid = inbox.sid_token;
if (!email || !sid) fail('could not obtain a disposable mailbox', inbox);
console.log('mailbox:', email);

const keys = projectKeys(loadAccessToken());
const installationId = randomUUID();
const username = `e2e_resend_${randomBytes(3).toString('hex')}`;
const headers = { 'Content-Type': 'application/json', apikey: keys.publishableKey, 'x-newone-installation-id': installationId, 'x-newone-client-platform': 'ios' };
async function viaApp(path, body) {
  const url = resolveApiUrl({ path, platform: 'ios', apiBase: '/api', supabaseUrl: SUPABASE_URL });
  if (!url) fail(`app routing cannot resolve ${path}`);
  const started = Date.now();
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return { status: response.status, ms: Date.now() - started, payload: await response.json().catch(() => null) };
}
const seen = new Set();
async function waitForCode(label, timeoutMs) {
  const deadline = Date.now() + timeoutMs; const started = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const list = await guerrilla({ f: 'get_email_list', offset: 0, sid_token: sid });
    for (const message of list.list ?? []) {
      if (seen.has(message.mail_id)) continue;
      const full = await guerrilla({ f: 'fetch_email', email_id: message.mail_id, sid_token: sid });
      const body = `${full.mail_subject ?? ''} ${full.mail_body ?? ''}`.replace(/<[^>]+>/g, ' ');
      const match = body.match(/\b(\d{6})\b/);
      seen.add(message.mail_id);
      if (match) { console.log(`${label}: email arrived after ${Math.round((Date.now() - started) / 1000)}s (mail_id ${message.mail_id})`); return match[1]; }
    }
  }
  return null;
}
const body = { destination: email, username, displayName: 'Resend Smoke', language: 'en', installationId };
const first = await viaApp('/v2/auth/native/signup/request', body);
const firstStatus = first.payload?.data?.status ?? first.payload?.status;
if (first.status !== 202 || firstStatus !== 'code_sent') fail(`first request refused (${first.status})`, first.payload);
console.log(`request #1 accepted in ${first.ms}ms`);
const code1 = await waitForCode('code #1', 120_000);
if (!code1) fail('code #1 never arrived');

// Human taps "Resend code" (the app re-posts the same request after the cooldown).
await new Promise((r) => setTimeout(r, 3_000));
const second = await viaApp('/v2/auth/native/signup/request', body);
const secondStatus = second.payload?.data?.status ?? second.payload?.status;
console.log(`resend responded ${second.status} ${secondStatus ?? ''} in ${second.ms}ms`, second.status !== 202 ? JSON.stringify(second.payload) : '');
if (second.status !== 202 || secondStatus !== 'code_sent') fail('resend refused — the app would show an error instead of the "we sent a new code" confirmation', second.payload);
const code2 = await waitForCode('code #2', 180_000);
if (!code2) {
  fail(`RESEND LOCKOUT REPRODUCED: gateway confirmed the resend but no second email reached the real inbox in 180s (code #1 was ${code1})`);
}
console.log(`code #2 ${code2 === code1 ? 'is the SAME as' : 'differs from'} code #1`);

// Which codes work now? Try the OLD code first (what a confused human does), then the new one.
const oldTry = await viaApp('/v2/auth/native/signup/verify', { destination: email, code: code1, installationId });
console.log(`old code after resend -> ${oldTry.status} ${oldTry.payload?.error?.code ?? oldTry.payload?.code ?? ''}`);
let session = oldTry.status === 200 ? oldTry.payload?.data ?? oldTry.payload : null;
if (!session) {
  const newTry = await viaApp('/v2/auth/native/signup/verify', { destination: email, code: code2, installationId });
  if (newTry.status !== 200) fail(`NEW code rejected after resend (${newTry.status}) — user is locked out`, newTry.payload);
  session = newTry.payload?.data ?? newTry.payload;
  console.log('new code accepted');
}
if (session?.signup?.organizationId !== PERSONAL_REALM_ID || typeof session?.session?.accessToken !== 'string') fail('verify succeeded but no consumer session', session);
console.log(`PASS: resend path — @${session.signup.username} signed in with the ${session === (oldTry.payload?.data ?? oldTry.payload) ? 'old' : 'new'} code`);
