#!/usr/bin/env node
// Marking a chat unread used to live in the Chats screen's own state, so it
// did not survive a relaunch and never reached the reader's other devices.
// It is a preference now. Reading the chat takes it back.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/mark-unread-smoke.mjs
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
const marked = async (actor, conversationId) => {
  const row = (await bootstrap(actor)).conversations.find((c) => c.conversationId === conversationId);
  if (!row) fail('the chat is not in the list', conversationId);
  return row.preferences?.manuallyUnread === true;
};

const me = await signupUser(keys, { runId, label: 'unread0', language: 'en' });
const them = await signupUser(keys, { runId, label: 'unread1', language: 'en' });
const opened = await api(me, 'POST', '/v2/conversations/direct', { targetMembershipId: them.userId });
const conversationId = opened.payload?.conversationId;
if (!conversationId) fail('could not open a chat', opened.payload);

const sent = await api(them, 'POST', `/v2/conversations/${conversationId}/messages`, {
  clientMessageId: randomUUID(), kind: 'text', body: 'first',
});
const messageId = sent.payload?.messageId;
if (!messageId) fail('could not send', sent.payload);

if (await marked(me, conversationId)) fail('a fresh chat is already marked unread');
console.log('ok  a chat nobody marked is not marked');

const mark = await api(me, 'PATCH', `/v2/conversations/${conversationId}/preferences`, { manuallyUnread: true });
if (mark.status !== 200) fail(`marking unread was refused (${mark.status})`, mark.payload);
if (!await marked(me, conversationId)) fail('the mark did not survive the round trip');
console.log('ok  the mark is on the server, so a relaunch and another device see it');

// A second reader's list is their own.
if (await marked(them, conversationId)) fail("one reader's mark reached the other person");
console.log('ok  the mark belongs to the reader who made it');

// Reading the chat takes it back, without anyone asking.
const receipt = await api(me, 'POST', `/v2/messages/${messageId}/receipt`, {
  conversationId, state: 'read',
});
if (receipt.status !== 200 && receipt.status !== 201 && receipt.status !== 202) {
  fail(`the read receipt was refused (${receipt.status})`, receipt.payload);
}
if (await marked(me, conversationId)) fail('reading the chat left it marked unread');
console.log('ok  reading the chat clears the mark');

// And it can be taken back by hand.
await api(me, 'PATCH', `/v2/conversations/${conversationId}/preferences`, { manuallyUnread: true });
if (!await marked(me, conversationId)) fail('could not mark it again');
await api(me, 'PATCH', `/v2/conversations/${conversationId}/preferences`, { manuallyUnread: false });
if (await marked(me, conversationId)) fail('unmarking did not clear it');
console.log('ok  it can be unmarked by hand');
console.log('PASS mark unread');
