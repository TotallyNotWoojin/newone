import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseConversationDepartureReceipt } from '../apps/newone/src/data/repositories/conversation-departure-dto.mjs';
import {
  conversationOutboxCommandIds,
  redactDepartedConversation,
} from '../apps/newone/src/features/chat/conversation-departure-state.mjs';

const conversationId = '00000000-0000-4000-8000-000000000081';

test('departure receipt requires the exact history and access-loss guarantees', () => {
  const receipt = parseConversationDepartureReceipt({
    conversationId,
    left: true,
    roleAtDeparture: 'owner',
    ownershipTransferred: true,
    historyPreserved: true,
    futureAccessRevoked: true,
    leftAt: '2026-08-04T12:00:00Z',
  }, conversationId);
  assert.equal(receipt.ownershipTransferred, true);
  assert.throws(() => parseConversationDepartureReceipt({
    ...receipt,
    futureAccessRevoked: false,
  }, conversationId));
  assert.throws(() => parseConversationDepartureReceipt({
    ...receipt,
    replacementOwnerMembershipId: 'leaked-extra-field',
  }, conversationId));
});

test('successful departure removes every conversation-scoped client projection', () => {
  const snapshot = {
    conversations: [{ id: conversationId }, { id: 'kept' }],
    messages: { [conversationId]: [{ id: 'secret' }], kept: [{ id: 'visible' }] },
    cursors: { [conversationId]: '9', kept: '10' },
    handoffs: [{ id: 'h1', conversationId }, { id: 'h2', conversationId: 'kept' }],
    summaries: [{ id: 's1', conversationId }],
    actions: [{ id: 'a1', conversationId }],
    moderationReports: [{ id: 'r1', conversationId }],
    auditEvents: [{ id: 'e1', entityId: conversationId }, { id: 'e2', entityId: 'kept' }],
  };
  const redacted = redactDepartedConversation(snapshot, conversationId);
  assert.deepEqual(redacted.conversations.map((item) => item.id), ['kept']);
  assert.equal(conversationId in redacted.messages, false);
  assert.equal(conversationId in redacted.cursors, false);
  assert.deepEqual(redacted.handoffs.map((item) => item.id), ['h2']);
  assert.deepEqual(redacted.summaries, []);
  assert.deepEqual(redacted.actions, []);
  assert.deepEqual(redacted.moderationReports, []);
  assert.deepEqual(redacted.auditEvents.map((item) => item.id), ['e2']);
});

test('departure purges only outbox commands scoped to that conversation', () => {
  const ids = conversationOutboxCommandIds([
    { id: 'send', payload: { conversationId } },
    { id: 'receipt', payload: { conversationId } },
    { id: 'other', payload: { conversationId: 'kept' } },
    { id: 'global', payload: { versionId: 'update' } },
  ], conversationId);
  assert.deepEqual(ids, ['send', 'receipt']);
});

test('client and Edge contracts require explicit confirmation and optional transfer', async () => {
  const [repository, routes, copy] = await Promise.all([
    readFile(new URL('../apps/newone/src/data/repositories/bff-command-repository.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/newone-api/routes.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/features/chat/conversation-departure-copy.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(repository, /confirmHistoryAndAccessLoss: input\.confirmHistoryAndAccessLoss/);
  assert.match(repository, /replacementOwnerMembershipId: input\.replacementOwnerMembershipId \?\? null/);
  assert.match(routes, /bff_leave_conversation/);
  assert.match(routes, /bool\(body\.confirmHistoryAndAccessLoss\) !== true/);
  // Reworded for consumers in d7854dd (2026-09-05). The property is unchanged:
  // the leave dialog must say, in all three locales, that leaving stops
  // delivery without deleting what was already said.
  assert.match(copy, /You’ll stop receiving messages from this group\. Your earlier messages stay\./);
  assert.match(copy, /이 그룹의 메시지를 더 받지 않게 됩니다\. 이전에 보낸 메시지는 남습니다\./);
  assert.match(copy, /Dejarás de recibir mensajes de este grupo\. Tus mensajes anteriores se conservan\./);
});
