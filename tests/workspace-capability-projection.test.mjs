import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseWorkspaceCapabilities,
  WORKSPACE_CAPABILITIES,
} from '../apps/newone/src/data/repositories/capability-dto.mjs';

test('owner capability projection filters before bounding the server list', () => {
  const serverProjection = [
    'actions.confirm',
    'actions.propose',
    'attachments.upload',
    'audit.read',
    'communications.publish',
    'contacts.manage',
    'conversation.direct.create',
    'conversation.manage',
    'directory.manage',
    'directory.read',
    'employee.use',
    'handoff.manage',
    'invites.manage',
    'language.review',
    'members.security',
    'message.preservation.manage',
    'message.send',
    'messaging.read',
    'recovery.manage',
    'reports.assign',
    'reports.investigate',
    'roles.manage',
    'roles.read',
    'sessions.revoke',
    'summary.request',
    'unit.manage',
    'ai.policy.manage',
  ].sort();

  assert.ok(serverProjection.length > WORKSPACE_CAPABILITIES.length);
  assert.deepEqual(
    parseWorkspaceCapabilities(serverProjection),
    WORKSPACE_CAPABILITIES,
  );
  for (const securityCapability of [
    'reports.assign',
    'reports.investigate',
    'roles.manage',
    'roles.read',
    'sessions.revoke',
    'unit.manage',
  ]) {
    assert.ok(parseWorkspaceCapabilities(serverProjection).includes(securityCapability));
  }
});

test('unknown, duplicate, and malformed capabilities do not widen client authority', () => {
  assert.deepEqual(parseWorkspaceCapabilities([
    'unit.manage',
    'root.all',
    'unit.manage',
    null,
    42,
  ]), ['unit.manage']);
  assert.deepEqual(parseWorkspaceCapabilities(null), []);
});
