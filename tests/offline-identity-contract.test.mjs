import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  parseOfflineIdentity,
  retainSessionForMembershipFailure,
  serializeOfflineIdentity,
} from '../apps/newone/src/data/persistence/offline-identity.mjs';

const userId = '00000000-0000-4000-8000-000000000001';
const now = Date.parse('2026-08-04T12:00:00.000Z');

test('offline identity is bounded to a valid user and expires without sliding on reopen', () => {
  const serialized = serializeOfflineIdentity(userId, now);
  assert.equal(parseOfflineIdentity(serialized, now + 1_000), userId);
  assert.equal(parseOfflineIdentity(serialized, now + 25 * 60 * 60 * 1_000), null);
  assert.equal(serializeOfflineIdentity('not-a-user', now), null);
  assert.equal(parseOfflineIdentity('{"version":1}', now), null);
});

test('native membership bootstrap retains a session only for transient failures', () => {
  for (const code of ['network_unavailable', 'dependency_unavailable', 'http_408', 'http_429', 'http_500', 'http_503']) {
    assert.equal(retainSessionForMembershipFailure({ code }), true, code);
  }
  for (const code of ['membership_required', 'session_revoked', 'http_401', 'http_403', 'invalid_response']) {
    assert.equal(retainSessionForMembershipFailure({ code }), false, code);
  }
});

test('auth and workspace tear down definitive server revocation but permit encrypted offline restore', () => {
  const auth = readFileSync('apps/newone/src/state/auth.tsx', 'utf8');
  const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
  assert.match(auth, /retainSessionForMembershipFailure/);
  assert.match(auth, /parseOfflineIdentity/);
  assert.match(workspace, /definitiveWorkspaceAccessFailure/);
  assert.match(workspace, /endAccessRef\.current\(\)/);
});
