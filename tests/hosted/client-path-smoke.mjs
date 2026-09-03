#!/usr/bin/env node
// Client-to-server contract smoke, no mocks anywhere in the chain:
// 1. Extracts every /v2/* path literal from the REAL client source files.
// 2. Resolves each through the REAL client routing module (web + native) —
//    any unrouted or misrouted path fails the run (the class of bug where
//    the client cannot even construct a URL, invisible to unit tests that
//    mock the routing seam and to server smokes that bypass the client).
// 3. Performs one REAL signup against the hosted backend using a URL the
//    client's own resolver produced, proving the resolved routes are the
//    routes the deployed gateway actually serves.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/client-path-smoke.mjs
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiUrl } from '../../apps/newone/src/config/api-routing.mjs';
import { EXPECTED_PROJECT_REF, makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, adminRequest, fail, loadAccessToken, projectKeys } from './smoke-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUPABASE_URL = `https://${EXPECTED_PROJECT_REF}.supabase.co`;
const CLIENT_SOURCES = [
  'apps/newone/src/lib/web-auth.ts',
  'apps/newone/src/data/repositories/web-read-repository.ts',
  'apps/newone/src/data/repositories/bff-command-repository.ts',
  'apps/newone/src/data/repositories/bff-search-repository.ts',
];

// 1-2. Every static /v2 literal in client source must resolve on both platforms.
const paths = new Set();
for (const source of CLIENT_SOURCES) {
  const text = readFileSync(join(ROOT, source), 'utf8');
  for (const match of text.matchAll(/['"`](\/v2\/[a-z0-9/_-]+)['"`]/g)) {
    paths.add(match[1]);
  }
}
if (paths.size < 10) fail(`suspiciously few client paths extracted (${paths.size})`);
const unrouted = [];
for (const path of [...paths].sort()) {
  const nativeUrl = resolveApiUrl({ path, platform: 'ios', apiBase: '/api', supabaseUrl: SUPABASE_URL });
  const webUrl = resolveApiUrl({ path, platform: 'web', apiBase: '/api', supabaseUrl: SUPABASE_URL });
  if (!nativeUrl || !webUrl) unrouted.push(`${path} (native: ${nativeUrl ? 'ok' : 'NULL'}, web: ${webUrl ? 'ok' : 'NULL'})`);
}
if (unrouted.length > 0) {
  fail(`client references ${unrouted.length} path(s) the routing table cannot resolve:\n  ${unrouted.join('\n  ')}`);
}
console.log(`routing: all ${paths.size} client path literals resolve on web and native`);

if (process.env.NEWONE_HOSTED_E2E !== '1') {
  console.log('PASS (static only): set NEWONE_HOSTED_E2E=1 to also run the live signup through resolved URLs');
  process.exit(0);
}

// 3. Real signup through the client-resolved native URLs.
const keys = projectKeys(loadAccessToken());
const runId = makeRunId();
const email = `${runId}-clientpath@example.test`;
const username = `e2e_cp_${randomBytes(3).toString('hex')}`;
const installationId = randomUUID();
const headers = {
  'Content-Type': 'application/json',
  apikey: keys.publishableKey,
  'x-newone-installation-id': installationId,
  'x-newone-client-platform': 'ios',
};
async function viaResolvedUrl(path, body) {
  const url = resolveApiUrl({ path, platform: 'ios', apiBase: '/api', supabaseUrl: SUPABASE_URL });
  if (!url) fail(`resolver returned null for ${path}`);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

const request = await viaResolvedUrl('/v2/auth/native/signup/request', {
  destination: email, username, displayName: 'Client Path Smoke', language: 'en', installationId,
});
const requestStatus = request.payload?.data?.status ?? request.payload?.status;
if (request.status !== 202 || requestStatus !== 'code_sent') {
  fail(`resolved-URL signup request failed (${request.status})`, request.payload);
}
const link = await adminRequest(keys.adminKey, '/admin/generate_link', {
  method: 'POST', body: JSON.stringify({ type: 'magiclink', email }),
});
const otp = String(link?.email_otp ?? link?.properties?.email_otp ?? '');
if (!/^[0-9]{6,10}$/.test(otp)) fail('no OTP for client-path smoke');
const verify = await viaResolvedUrl('/v2/auth/native/signup/verify', { destination: email, code: otp, installationId });
const verifyData = verify.payload?.data ?? verify.payload ?? {};
if (verify.status !== 200 || verifyData.signup?.organizationId !== PERSONAL_REALM_ID) {
  fail(`resolved-URL signup verify failed (${verify.status})`, verify.payload);
}
console.log(`PASS: live signup through client-resolved URLs (${email})`);
