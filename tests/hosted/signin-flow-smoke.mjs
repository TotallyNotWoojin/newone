// Returning sign-in smoke (v3.2) against the deployed gateway.
//
// One synthetic account walks the whole road a returning member takes:
// signup with a password → sign out → account lookup → password sign-in →
// wrong password refused → "Forgot password?" (recovery code, minted through
// the admin API) → new password saved through the recovering session → that
// same session is still accepted afterwards (defect AF) → the new password
// signs in and the old one is refused. Also: an unknown address answers
// exists:false, and the phone path stays inert (400).
//
// Usage: node tests/hosted/signin-flow-smoke.mjs
import { randomBytes, randomUUID } from 'node:crypto';
import { adminRequest, fail, gatewayPost, loadAccessToken, projectKeys, signupUser } from './smoke-lib.mjs';

const keys = projectKeys(loadAccessToken());
const runId = `si${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const password = `Smoke-${runId}-pw!`;
const user = await signupUser(keys, { runId, label: 'si', language: 'en', password });
console.log('1. signed up with a password:', user.username);

const data = (result) => result.payload?.data ?? result.payload ?? {};
const lookup = async (destination, installationId) => gatewayPost('newone-auth', '/v2/auth/native/account/lookup', keys, {
  installationId,
  body: { destinationType: 'email', destination, installationId, appVersion: '3.2.0', locale: 'en' },
});

// "Sign out": the returning device is a fresh installation with no session.
const device = randomUUID();
const found = await lookup(user.email, device);
if (found.status !== 200 || data(found).exists !== true || data(found).hasPassword !== true) {
  fail(`lookup did not report an account with a password (${found.status})`, found.payload);
}
console.log('2. lookup:', data(found));

const signIn = async (candidate) => gatewayPost('newone-auth', '/v2/auth/native/password/verify', keys, {
  installationId: device,
  body: { destinationType: 'email', destination: user.email, password: candidate, installationId: device, appVersion: '3.2.0', locale: 'en' },
});
const signedIn = await signIn(password);
if (signedIn.status !== 200 || typeof data(signedIn).session?.accessToken !== 'string') {
  fail(`password sign-in failed (${signedIn.status})`, signedIn.payload);
}
console.log('3. password sign-in:', signedIn.status);

const wrong = await signIn(`${password}x`);
if (wrong.status !== 401) fail(`a wrong password was not refused with 401 (${wrong.status})`, wrong.payload);
console.log('4. wrong password refused:', wrong.status, wrong.payload?.error?.code);

const unknown = await lookup(`${runId}-nobody@example.test`, device);
if (unknown.status !== 200 || data(unknown).exists !== false) {
  fail(`an unknown address did not answer exists:false (${unknown.status})`, unknown.payload);
}
console.log('5. unknown address:', data(unknown));

// Forgot password: recovery code request, minted code, verify.
const forgotDevice = randomUUID();
const requested = await gatewayPost('newone-auth', '/v2/auth/native/recovery/otp/request', keys, {
  installationId: forgotDevice,
  body: { destinationType: 'email', destination: user.email, installationId: forgotDevice, appVersion: '3.2.0', locale: 'en' },
});
if (requested.status !== 202) fail(`recovery code request was not accepted (${requested.status})`, requested.payload);
const link = await adminRequest(keys.adminKey, '/admin/generate_link', {
  method: 'POST',
  body: JSON.stringify({ type: 'magiclink', email: user.email }),
});
const code = String(link?.email_otp ?? link?.properties?.email_otp ?? '');
if (!/^[0-9]{6,10}$/.test(code)) fail('no recovery code could be minted');
const recovered = await gatewayPost('newone-auth', '/v2/auth/native/recovery/otp/verify', keys, {
  installationId: forgotDevice,
  body: { destinationType: 'email', destination: user.email, code, installationId: forgotDevice, appVersion: '3.2.0', locale: 'en' },
});
const recoveryToken = data(recovered).session?.accessToken;
if (recovered.status !== 200 || typeof recoveryToken !== 'string' || data(recovered).recovery?.currentSessionPreserved !== true) {
  fail(`recovery code verify failed (${recovered.status})`, recovered.payload);
}
console.log('6. forgot password: code verified, other sessions revoked:', data(recovered).recovery?.otherSessionsRevoked);

const newPassword = `Smoke-${runId}-new!`;
const weak = await gatewayPost('newone-auth', '/v2/auth/password/set', keys, {
  installationId: forgotDevice, accessToken: recoveryToken, body: { password: 'short' },
});
if (weak.status !== 400 || weak.payload?.error?.code !== 'weak_password') fail(`a weak new password was not refused by name (${weak.status})`, weak.payload);
const set = await gatewayPost('newone-auth', '/v2/auth/password/set', keys, {
  installationId: forgotDevice, accessToken: recoveryToken, body: { password: newPassword },
});
if (set.status !== 200 || data(set).passwordSet !== true) fail(`new password was not saved (${set.status})`, set.payload);
console.log('7. new password saved through the recovering session:', set.status);

const alive = await gatewayPost('newone-auth', '/v2/auth/password/set', keys, {
  installationId: forgotDevice, accessToken: recoveryToken, body: { password: newPassword },
});
if (alive.status !== 200) fail(`the recovering session was signed out by its own password write (${alive.status})`, alive.payload);
console.log('8. same session still accepted after the write:', alive.status);

const withNew = await signIn(newPassword);
if (withNew.status !== 200) fail(`the new password does not sign in (${withNew.status})`, withNew.payload);
const withOld = await signIn(password);
if (withOld.status !== 401) fail(`the old password still signs in (${withOld.status})`, withOld.payload);
console.log('9. new password signs in, old one refused:', withNew.status, withOld.status);

const phone = await gatewayPost('newone-auth', '/v2/auth/native/account/lookup', keys, {
  installationId: device,
  body: { destinationType: 'phone', destination: '+12025550123', installationId: device },
});
if (phone.status !== 400) fail(`a phone lookup was not refused (${phone.status})`, phone.payload);
console.log('10. phone lookup inert:', phone.status);
console.log('SIGN-IN FLOW SMOKE OK');
