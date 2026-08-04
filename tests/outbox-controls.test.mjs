import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  editUnattemptedMessageCommand,
  retryFailedMessageCommand,
  visibleMessageOutbox,
} from '../apps/newone/src/data/persistence/outbox-controls.mjs';

const userId = '00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-000000000002';
const conversationId = '00000000-0000-4000-8000-000000000003';

function command(patch = {}) {
  const clientMessageId = '00000000-0000-4000-8000-000000000004';
  return {
    id: '00000000-0000-4000-8000-000000000005',
    organizationId,
    userId,
    kind: 'send_message',
    payload: {
      organizationId,
      conversationId,
      clientMessageId,
      idempotencyKey: clientMessageId,
      body: 'original',
      languageCode: 'en',
    },
    createdAt: '2026-08-04T12:00:00.000Z',
    attempts: 0,
    state: 'queued',
    ...patch,
  };
}

test('outbox presentation is identity scoped and does not expose receipt/device commands', () => {
  const visible = visibleMessageOutbox([
    command(),
    command({ id: '00000000-0000-4000-8000-000000000006', kind: 'message_receipt' }),
    command({ id: '00000000-0000-4000-8000-000000000007', userId: '00000000-0000-4000-8000-000000000099' }),
  ], userId, organizationId);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].body, 'original');
  assert.equal(visible[0].canEdit, true);
  assert.equal(visible[0].deliveryAmbiguous, false);
});

test('only never-attempted queued messages can be edited without changing idempotency', () => {
  const original = command();
  const edited = editUnattemptedMessageCommand(original, ' corrected ');
  assert.equal(edited?.payload.body, 'corrected');
  assert.equal(edited?.payload.idempotencyKey, original.payload.idempotencyKey);
  assert.equal(editUnattemptedMessageCommand(command({ attempts: 1 }), 'unsafe'), null);
  assert.equal(editUnattemptedMessageCommand(command({ state: 'failed' }), 'unsafe'), null);
});

test('retry preserves identity and attempt history while clearing only terminal UI state', () => {
  const failed = command({
    state: 'failed',
    attempts: 2,
    lastErrorCode: 'membership_inactive',
    payload: { ...command().payload, mentionUserIds: ['00000000-0000-4000-8000-000000000008'] },
  });
  const retried = retryFailedMessageCommand(failed);
  assert.equal(retried?.state, 'queued');
  assert.equal(retried?.attempts, 2);
  assert.equal(retried?.lastErrorCode, undefined);
  assert.equal(retried?.payload.idempotencyKey, failed.payload.idempotencyKey);
  assert.deepEqual(retried?.payload.mentionUserIds, failed.payload.mentionUserIds);
});

test('tampered mention metadata is not exposed or retried from the encrypted outbox', () => {
  const duplicate = '00000000-0000-4000-8000-000000000008';
  assert.equal(visibleMessageOutbox([
    command({ payload: { ...command().payload, mentionUserIds: [duplicate, duplicate] } }),
  ], userId, organizationId).length, 0);
  assert.equal(visibleMessageOutbox([
    command({ payload: { ...command().payload, mentionUserIds: ['not-a-uuid'] } }),
  ], userId, organizationId).length, 0);
});

test('workspace exposes encrypted queue inspection and bounded local controls', () => {
  const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
  assert.match(workspace, /messageOutbox: VisibleMessageOutboxItem\[\]/);
  assert.match(workspace, /editUnattemptedMessageCommand\(command, body\)/);
  assert.match(workspace, /retryFailedMessageCommand\(command\)/);
  assert.match(workspace, /clientStore\.removeOutbox\(outboxId\)/);
  assert.match(workspace, /item\.deliveryAmbiguous/);
  assert.match(workspace, /void refresh\(\)/);
});
