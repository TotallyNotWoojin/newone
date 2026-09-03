#!/usr/bin/env node
// Real-device simulation: the actual app binary in the iPhone simulator,
// driven by Maestro taps, with the verification code read from a REAL
// disposable mailbox. Nothing is mocked and no admin backdoor is used —
// this is precisely a human's first-run experience.
//
// Prereqs: app installed on a booted simulator (npx expo run:ios), maestro.
// Usage: node tests/device/run-signup.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FLOWS = join(dirname(fileURLToPath(import.meta.url)), 'flows');
const MAESTRO = `${process.env.HOME}/.maestro/bin/maestro`;
const GUERRILLA = 'https://api.guerrillamail.com/ajax.php';

function fail(message, extra) {
  console.error(`FAIL: ${message}`);
  if (extra !== undefined) console.error(extra);
  process.exit(1);
}
async function guerrilla(params) {
  const response = await fetch(`${GUERRILLA}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) fail(`mailbox API ${response.status}`);
  return await response.json();
}
// Target simulator: DEVICE env (udid) lets two simulators play two humans.
const DEVICE = process.env.DEVICE ?? '084E6094-8685-40DA-AB64-9DF887F48842';
function maestro(flow, env) {
  const args = ['--device', DEVICE, 'test'];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push(join(FLOWS, flow));
  try {
    const out = execFileSync(MAESTRO, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
    console.log(out.split('\n').filter((l) => /✅|❌|Flow|Passed|Failed/.test(l)).join('\n'));
    return true;
  } catch (error) {
    console.error(String(error.stdout ?? '').split('\n').slice(-25).join('\n'));
    console.error(String(error.stderr ?? '').slice(-800));
    return false;
  }
}

// 1. Real inbox.
const inbox = await guerrilla({ f: 'get_email_address', lang: 'en' });
const email = inbox.email_addr;
const sid = inbox.sid_token;
if (!email || !sid) fail('no mailbox', inbox);
const username = `sim_human_${randomBytes(3).toString('hex')}`;
console.log('mailbox:', email, '| username:', username);

// 2. Fill the form and submit — real taps on the real app.
if (!maestro('signup-request.yaml', { EMAIL: email, USERNAME: username })) fail('sign-up form flow failed on device');
console.log('form submitted on device; waiting for the real email...');

// 3. Wait for the code in the real inbox.
let code = null;
const deadline = Date.now() + 120_000;
while (!code && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const list = await guerrilla({ f: 'get_email_list', offset: 0, sid_token: sid });
  for (const message of list.list ?? []) {
    const full = await guerrilla({ f: 'fetch_email', email_id: message.mail_id, sid_token: sid });
    const text = `${full.mail_subject ?? ''} ${full.mail_body ?? ''}`.replace(/<[^>]+>/g, ' ');
    const match = text.match(/\b(\d{6})\b/);
    if (match) { code = match[1]; break; }
  }
}
if (!code) fail('verification email never arrived in the real inbox');
console.log('code arrived in inbox');

// 4. Type the code on the device and expect the Chats screen.
if (!maestro('signup-verify.yaml', { CODE: code })) fail('code entry did not land in the app — THIS IS THE USER\'S BOUNCE');
console.log(`signed in on device as ${username}`);
if (process.env.ONLY_SIGNUP === '1') {
  console.log(`PASS: signup only — ${username} <${email}> signed in on ${DEVICE}`);
  process.exit(0);
}

// 5. Force-quit, relaunch (session must persist), then sign out from Settings.
if (!maestro('relaunch-and-signout.yaml', {})) fail('relaunch persistence or sign-out failed on device');
console.log('relaunch kept the session; signed out via Settings');

// 6. Returning sign-in: same human, same inbox, fresh code.
if (!maestro('returning-request.yaml', { EMAIL: email })) fail('returning sign-in form flow failed on device');
console.log('returning sign-in requested; waiting for the real email...');
const seenBefore = code;
code = null;
const deadline2 = Date.now() + 120_000;
while (!code && Date.now() < deadline2) {
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const list = await guerrilla({ f: 'get_email_list', offset: 0, sid_token: sid });
  for (const message of list.list ?? []) {
    const full = await guerrilla({ f: 'fetch_email', email_id: message.mail_id, sid_token: sid });
    const text = `${full.mail_subject ?? ''} ${full.mail_body ?? ''}`.replace(/<[^>]+>/g, ' ');
    const match = text.match(/\b(\d{6})\b/);
    if (match && match[1] !== seenBefore) { code = match[1]; break; }
  }
}
if (!code) fail('returning sign-in code never arrived in the real inbox');
if (!maestro('returning-verify.yaml', { CODE: code })) fail('returning code entry did not land in the app');
console.log(`PASS: full human lifecycle on device — signup, relaunch, sign out, sign back in (${username})`);
