#!/usr/bin/env node
// What the app does the instant after a successful signup: load the
// workspace via POST /v2/bootstrap with the fresh session. Verifies the
// very first screen a new consumer sees can actually load.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/bootstrap-probe.mjs
import { resolveApiUrl } from '../../apps/newone/src/config/api-routing.mjs';
import { EXPECTED_PROJECT_REF, makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, loadAccessToken, projectKeys, signupUser } from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1');

const SUPABASE_URL = `https://${EXPECTED_PROJECT_REF}.supabase.co`;
const keys = projectKeys(loadAccessToken());
const user = await signupUser(keys, { runId: makeRunId(), label: 'boot', language: 'en' });
console.log('signed up:', user.username);

const url = resolveApiUrl({ path: '/v2/bootstrap', platform: 'ios', apiBase: '/api', supabaseUrl: SUPABASE_URL });
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: keys.publishableKey,
    Authorization: `Bearer ${user.accessToken}`,
  },
  body: JSON.stringify({ organizationId: null }),
  signal: AbortSignal.timeout(30_000),
});
const payload = await response.json().catch(() => null);
console.log('bootstrap status:', response.status);
if (response.status !== 200) fail('bootstrap failed — this is the post-signup bounce', JSON.stringify(payload).slice(0, 600));
const data = payload?.data ?? payload;
console.log('schemaVersion:', data?.schemaVersion, '| org:', data?.organization?.id === PERSONAL_REALM_ID ? 'personal realm' : data?.organization?.id);
// The payload is kept only when somewhere to keep it is named: this pointed at
// a session scratchpad that stopped existing, and the probe then failed after
// the check it exists to make had already passed.
if (process.env.NEWONE_PROBE_OUT) {
  const fs = await import('node:fs');
  fs.writeFileSync(`${process.env.NEWONE_PROBE_OUT}/bootstrap-payload.json`, JSON.stringify(payload, null, 1));
  console.log('payload written to', process.env.NEWONE_PROBE_OUT);
}
console.log('PASS: first-screen bootstrap loads for a fresh consumer');
