import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createCoalescedRunner } from '../apps/newone/src/data/reconciliation/coalesced-runner.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('realtime invalidation bursts serialize and coalesce to one follow-up reconciliation', async () => {
  const gates = [deferred(), deferred()];
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const runner = createCoalescedRunner(async () => {
    const call = calls++;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await gates[call].promise;
    active -= 1;
  });

  const first = runner.run();
  await Promise.resolve();
  const second = runner.run();
  const third = runner.run();
  assert.equal(first, second);
  assert.equal(first, third);
  assert.equal(calls, 1);

  gates[0].resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  gates[1].resolve();
  await first;
  assert.equal(maximumActive, 1);
  assert.equal(calls, 2);
});

test('workspace subscription follows snapshot presence and never loading status', () => {
  const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
  const realtimeCall = workspace.slice(
    workspace.indexOf('useUserRealtime({'),
    workspace.indexOf('const markMessage'),
  );
  assert.match(realtimeCall, /Boolean\(snapshot\)/);
  assert.doesNotMatch(realtimeCall, /status\s*===\s*['"]ready['"]/);
  assert.match(workspace, /createCoalescedRunner/);
  assert.match(workspace, /requestedIdentity !== refreshIdentityRef\.current/);
});
