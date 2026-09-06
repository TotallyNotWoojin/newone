// Password-session smoke against the deployed gateway.
//
// Defect AF: a member who saved a password from a signed-in session was signed
// out by the write itself (the admin password update revokes every session).
// A synthetic account signs up without a password, saves one through
// /v2/auth/password/set, and the SAME session must still be accepted; the new
// password must sign in and the route must refuse a short one.
//
// Usage: node tests/hosted/password-session-smoke.mjs
import { randomBytes, randomUUID } from 'node:crypto';
import { fail, gatewayPost, loadAccessToken, projectKeys, signupUser } from './smoke-lib.mjs';

const keys = projectKeys(loadAccessToken());
const runId = `pw${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const user = await signupUser(keys, { runId, label: 'pw', language: 'en' });
console.log('1. signed up without a password:', user.username);

const short = await gatewayPost('newone-auth', '/v2/auth/password/set', keys, {
  installationId: user.installationId, accessToken: user.accessToken, body: { password: 'short' },
});
if (short.status !== 400) fail(`a short password was not refused (${short.status})`, short.payload);
console.log('2. short password refused:', short.status, short.payload?.error?.code);

const password = `Smoke-${runId}-pw!`;
const set = await gatewayPost('newone-auth', '/v2/auth/password/set', keys, {
  installationId: user.installationId, accessToken: user.accessToken, body: { password },
});
if (set.status !== 200 || set.payload?.passwordSet !== true) fail(`password set failed (${set.status})`, set.payload);
console.log('3. password saved:', set.status);

const again = await gatewayPost('newone-auth', '/v2/auth/password/set', keys, {
  installationId: user.installationId, accessToken: user.accessToken, body: { password },
});
if (again.status !== 200) fail(`the session that saved the password was signed out (${again.status})`, again.payload);
console.log('4. same session still authenticated after the write:', again.status);

const installationId = randomUUID();
const verify = await gatewayPost('newone-auth', '/v2/auth/native/password/verify', keys, {
  installationId,
  body: { destinationType: 'email', destination: user.email, password, installationId, appVersion: '3.0.0', locale: 'en' },
});
if (verify.status !== 200) fail(`password sign-in failed (${verify.status})`, verify.payload);
console.log('5. password sign-in:', verify.status);

const wrong = await gatewayPost('newone-auth', '/v2/auth/native/password/verify', keys, {
  installationId,
  body: { destinationType: 'email', destination: user.email, password: `${password}x`, installationId, appVersion: '3.0.0', locale: 'en' },
});
if (wrong.status === 200) fail('a wrong password signed in');
console.log('6. wrong password refused:', wrong.status);
console.log('PASSWORD SESSION SMOKE OK');
