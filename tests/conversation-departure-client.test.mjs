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
  assert.match(copy, /Existing messages and company records stay preserved/);
  assert.match(copy, /기존 메시지와 회사 기록은 보존됩니다/);
  assert.match(copy, /Los mensajes y registros existentes de la empresa se conservan/);
});
