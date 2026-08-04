import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectContract } from '../scripts/verify-edge-database-contract.mjs';

test('edge/database contract reports missing RPCs and function configuration drift', () => {
  const report = inspectContract({
    edgeSources: [
      "await invokeRpc(client, 'bff_present', {}); await invokeRpc(client, 'bff_missing', {});",
    ],
    migrations: [
      'create or replace function public.bff_present() returns jsonb language sql as $$ select null::jsonb $$;',
    ],
    config: '[functions.present]\nverify_jwt = false\n\n[functions.stale]\nverify_jwt = true\n',
    functionNames: ['present', 'unconfigured'],
  });
  assert.deepEqual(report.missingRpcs, ['bff_missing']);
  assert.deepEqual(report.unconfiguredFunctions, ['unconfigured']);
  assert.deepEqual(report.staleFunctionConfig, ['stale']);
});

test('edge/database contract accepts defined RPCs and explicit function policies', () => {
  const report = inspectContract({
    edgeSources: ["await invokeVoidRpc(client, 'bff_present', {});"],
    migrations: [
      'create function private.bff_present() returns void language sql as $$ select null $$;',
    ],
    config: '[functions.present]\nverify_jwt = false\n',
    functionNames: ['present'],
  });
  assert.deepEqual(report.missingRpcs, []);
  assert.deepEqual(report.unconfiguredFunctions, []);
  assert.deepEqual(report.staleFunctionConfig, []);
});
