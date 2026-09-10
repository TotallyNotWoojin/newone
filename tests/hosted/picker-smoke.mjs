#!/usr/bin/env node
// The people picker in a group: it offers someone who left so they can be
// added back (20260908090000), and every candidate carries its @handle
// (20260909230000). Both live in the same function, and releasing a migration
// held since before the first one silently reverted it — caught by groups-05
// on the device suite, so this is here to catch it without a simulator.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/picker-smoke.mjs
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID, fail, gatewayPost, gatewayRequest, loadAccessToken, projectKeys, signupUser,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1');
const keys = projectKeys(loadAccessToken());
const ORG = PERSONAL_REALM_ID;
const runId = makeRunId();

const api = (actor, method, path, body) => gatewayRequest('newone-api', method, path, keys, {
  installationId: actor.installationId, accessToken: actor.accessToken,
  idempotencyKey: randomUUID(), body: { organizationId: ORG, ...body },
});
const candidates = async (actor, conversationId, query = '') => {
  const response = await gatewayPost(
    'newone-api', `/v2/conversations/${conversationId}/member-candidates/query`, keys,
    {
      installationId: actor.installationId, accessToken: actor.accessToken,
      body: { organizationId: ORG, query },
    },
  );
  if (response.status !== 200) fail(`the picker was refused (${response.status})`, response.payload);
  const list = (response.payload?.data ?? response.payload)?.candidates;
  if (!Array.isArray(list)) fail('the picker returned no candidate list', response.payload);
  return list;
};

const owner = await signupUser(keys, { runId, label: 'pick0', language: 'en' });
const stays = await signupUser(keys, { runId, label: 'pick1', language: 'en' });
const leaves = await signupUser(keys, { runId, label: 'pick2', language: 'en' });

const group = await api(owner, 'POST', '/v2/conversations/group', {
  name: `Picker ${runId.slice(-8)}`, kind: 'group',
  memberAssignments: [
    { membershipId: stays.userId, role: 'member' },
    { membershipId: leaves.userId, role: 'member' },
  ],
});
if (group.status !== 201) fail('could not create the group', group.payload);
const conversationId = group.payload.conversationId;

// Every candidate carries its handle, which is what the picker searches by.
const all = await candidates(owner, '' || conversationId);
if (!all.length) fail('the picker offered nobody at all');
if (!all.some((c) => typeof c.username === 'string' && c.username.length > 0)) {
  fail('no candidate carried a @handle', all.slice(0, 3));
}
console.log(`ok  ${all.length} candidates, carrying @handles`);

// Searching by handle finds the person.
const byHandle = await candidates(owner, conversationId, stays.username);
if (byHandle.length) fail('someone already in the group was offered', byHandle.slice(0, 2));
console.log('ok  someone already in the group is not offered');

// The one that matters: a person who left must be offered again.
const left = await api(leaves, 'POST', `/v2/conversations/${conversationId}/leave`, { confirmHistoryAndAccessLoss: true });
if (left.status !== 200 && left.status !== 204) fail(`leaving failed (${left.status})`, left.payload);
const afterLeaving = await candidates(owner, conversationId, leaves.username);
if (!afterLeaving.some((c) => c.userId === leaves.userId || c.user_id === leaves.userId)) {
  fail('someone who left the group is not offered back', afterLeaving.slice(0, 3));
}
console.log('ok  someone who left is offered back, searchable by @handle');
console.log('PASS picker');
