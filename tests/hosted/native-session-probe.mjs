#!/usr/bin/env node
// Reproduces the app's post-verify session activation with the REAL client
// library the app ships (supabase-js from apps/newone/node_modules), using
// real gateway tokens, mirroring src/state/auth.tsx verifySignup/verifyOtp:
//   setSession({ access_token, refresh_token }) -> error? user id mismatch?
// Covers both the signup verify and the returning-member verify paths.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/native-session-probe.mjs
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { EXPECTED_PROJECT_REF, makeRunId } from './lib.mjs';
import { adminRequest, fail, gatewayPost, loadAccessToken, projectKeys, signupUser } from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1');
const require = createRequire(join(process.cwd(), 'apps/newone/package.json'));
const { createClient } = require('@supabase/supabase-js');
const version = require('@supabase/supabase-js/package.json').version;
console.log('supabase-js (app copy):', version);

const keys = projectKeys(loadAccessToken());
const url = `https://${EXPECTED_PROJECT_REF}.supabase.co`;

function appLikeClient() {
  // Same options as src/lib/supabase.ts minus OS storage (in-memory here).
  return createClient(url, keys.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false, flowType: 'pkce' },
    global: { headers: { 'x-client-info': 'newone-expo/ios' } },
  });
}

async function activate(label, gatewayData) {
  const client = appLikeClient();
  const { data, error } = await client.auth.setSession({
    access_token: gatewayData.session.accessToken,
    refresh_token: gatewayData.session.refreshToken,
  });
  const mismatch = !error && data?.session && data.session.user.id !== gatewayData.user.id;
  console.log(`[${label}] setSession error:`, error ? `${error.name}: ${error.message}` : 'none',
    '| session:', data?.session ? 'yes' : 'NO', '| user match:', mismatch ? 'MISMATCH' : 'ok');
  if (error || !data?.session || mismatch) {
    console.log(`[${label}] gateway user id:`, gatewayData.user?.id, '| session user id:', data?.session?.user?.id);
    console.log(`[${label}] token exp (s from now):`,
      JSON.parse(Buffer.from(gatewayData.session.accessToken.split('.')[1], 'base64url').toString()).exp - Math.floor(Date.now() / 1000));
    return false;
  }
  return true;
}

// 1. Signup verify path — capture the FULL gateway response this time.
const runId = makeRunId();
const user = await signupUser(keys, { runId, label: 'sess', language: 'en' });
console.log('signed up', user.username);
// Re-run a fresh returning-member sign-in to get a full verify payload for BOTH paths.
const installationId = randomUUID();
const req = await gatewayPost('newone-auth', '/v2/auth/native/otp/request', keys, {
  installationId,
  body: { destination: user.email, destinationType: 'email', installationId },
});
console.log('returning request:', req.status);
const link = await adminRequest(keys.adminKey, '/admin/generate_link', {
  method: 'POST', body: JSON.stringify({ type: 'magiclink', email: user.email }),
});
const otp = String(link?.email_otp ?? link?.properties?.email_otp ?? '');
const verify = await gatewayPost('newone-auth', '/v2/auth/native/otp/verify', keys, {
  installationId,
  body: { destination: user.email, destinationType: 'email', code: otp, installationId },
});
if (verify.status !== 200) fail(`returning verify failed (${verify.status})`, verify.payload);
const returning = verify.payload?.data ?? verify.payload;
console.log('returning verify payload keys:', Object.keys(returning).join(','));
const okReturning = await activate('returning-signin', returning);

// 2. Signup verify path with a brand-new identity, full payload captured.
const runId2 = makeRunId();
const email2 = `${runId2}-sess2@example.test`;
const inst2 = randomUUID();
const r2 = await gatewayPost('newone-auth', '/v2/auth/native/signup/request', keys, {
  installationId: inst2,
  body: { destination: email2, username: `e2e_sess2_${runId2.slice(-6)}`.replace(/-/g, ''), displayName: 'Sess Two', language: 'en', installationId: inst2 },
});
if (r2.status !== 202) fail(`signup request failed (${r2.status})`, r2.payload);
const link2 = await adminRequest(keys.adminKey, '/admin/generate_link', {
  method: 'POST', body: JSON.stringify({ type: 'magiclink', email: email2 }),
});
const otp2 = String(link2?.email_otp ?? link2?.properties?.email_otp ?? '');
const v2 = await gatewayPost('newone-auth', '/v2/auth/native/signup/verify', keys, {
  installationId: inst2,
  body: { destination: email2, code: otp2, installationId: inst2 },
});
if (v2.status !== 200) fail(`signup verify failed (${v2.status})`, v2.payload);
const signup = v2.payload?.data ?? v2.payload;
const okSignup = await activate('signup', signup);

if (!okReturning || !okSignup) fail('client session activation FAILS with real gateway tokens — this is the bounce');
console.log('PASS: the app\'s own session activation succeeds for signup and returning sign-in');
