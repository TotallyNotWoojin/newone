#!/usr/bin/env node
// A chat with the newest message belongs at the top of the list, under any
// favourites. The list was ordered by conversations.updated_at, which nothing
// bumps when a message arrives, so a chat could carry a message from today and
// still sit below one last renamed a week ago.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/chat-order-smoke.mjs
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
const bootstrap = async (actor) => (await gatewayPost('newone-read', '/v2/bootstrap', keys, {
  installationId: actor.installationId, accessToken: actor.accessToken,
  body: { organizationId: ORG, selectedConversationId: null, beforeMessageId: null, conversationLimit: 100, timelineLimit: 30 },
})).payload;
const order = async (actor) => (await bootstrap(actor)).conversations.map((c) => c.conversationId);
const send = (actor, conversationId, body) => api(actor, 'POST', `/v2/conversations/${conversationId}/messages`, {
  clientMessageId: randomUUID(), kind: 'text', body,
});

const me = await signupUser(keys, { runId, label: 'order0', language: 'en' });
const first = await signupUser(keys, { runId, label: 'order1', language: 'en' });
const second = await signupUser(keys, { runId, label: 'order2', language: 'en' });
const third = await signupUser(keys, { runId, label: 'order3', language: 'en' });

const open = async (person) => {
  const created = await api(me, 'POST', '/v2/conversations/direct', { targetMembershipId: person.userId });
  const id = created.payload?.conversationId;
  if (!id) fail('could not open a chat', created.payload);
  return id;
};
const chatA = await open(first);
const chatB = await open(second);
const chatC = await open(third);

await send(first, chatA, 'first');
await send(second, chatB, 'second');
await send(third, chatC, 'third');

let ids = await order(me);
if (ids[0] !== chatC) fail('the newest message is not at the top', ids.slice(0, 3));
console.log('ok  the chat with the newest message is first');

// A message into the oldest chat brings it up, which is the whole complaint.
await send(first, chatA, 'and now this one is newest');
ids = await order(me);
if (ids[0] !== chatA) fail('a received message did not move its chat to the top', ids.slice(0, 3));
console.log('ok  a received message moves its chat to the top');

// My own message counts too.
await send(me, chatB, 'mine');
ids = await order(me);
if (ids[0] !== chatB) fail('sending did not move the chat to the top', ids.slice(0, 3));
console.log('ok  sending moves the chat to the top');

// Favourites stay above the rest however new the others are.
await api(me, 'PATCH', `/v2/conversations/${chatC}/preferences`, { isFavorite: true });
await send(first, chatA, 'newest again');
ids = await order(me);
if (ids[0] !== chatC) fail('a favourite did not stay at the top', ids.slice(0, 3));
if (ids[1] !== chatA) fail('below the favourite, the newest message is not first', ids.slice(0, 3));
console.log('ok  favourites stay on top, the rest by newest message');

// A chat with no messages at all still has a place in the order.
const empty = await api(me, 'POST', '/v2/conversations/group', {
  name: `Order ${runId.slice(-8)}`, kind: 'group',
  memberAssignments: [
    { membershipId: second.userId, role: 'member' },
    { membershipId: third.userId, role: 'member' },
  ],
});
if (empty.status !== 201) fail('could not create the group', empty.payload);
ids = await order(me);
if (!ids.includes(empty.payload.conversationId)) {
  fail('a chat with no messages fell out of the list', {
    created: empty.status, id: empty.payload?.conversationId, listed: ids.length, ids,
  });
}
console.log('ok  a chat with no messages keeps its place');
console.log('PASS chat ordering');
