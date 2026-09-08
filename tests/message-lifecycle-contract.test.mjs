import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  compareMessageIds,
  firstUnreadMessageId,
  latestIncomingServerMessage,
  mergeTimelineMessages,
} from '../apps/newone/src/data/reconciliation/message-timeline.mjs';

function serverMessage(serverId, createdAt, overrides = {}) {
  return {
    id: `server-${serverId}`,
    serverId,
    conversationId: 'conversation-1',
    createdAt,
    isOwn: false,
    deliveryState: 'sent',
    ...overrides,
  };
}

test('timeline merge preserves exact bigint order, optimistic identity, and concurrent arrivals', () => {
  assert.equal(compareMessageIds('900719925474099312345', '900719925474099312346'), -1);
  assert.equal(compareMessageIds('000101', '101'), 0);

  const optimistic = {
    id: 'local-command-1',
    clientMessageId: 'client-command-1',
    conversationId: 'conversation-1',
    createdAt: '2026-08-04T12:00:02.000Z',
    isOwn: true,
    deliveryState: 'sending',
  };
  const existing = [
    serverMessage('900719925474099312345', '2026-08-04T12:00:00.000Z'),
    serverMessage('900719925474099312346', '2026-08-04T12:00:01.000Z'),
    optimistic,
    serverMessage('900719925474099312349', '2026-08-04T12:00:04.000Z'),
  ];
  const incoming = [
    serverMessage('900719925474099312343', '2026-08-04T11:59:58.000Z'),
    serverMessage('900719925474099312344', '2026-08-04T11:59:59.000Z'),
    serverMessage('900719925474099312346', '2026-08-04T12:00:01.000Z', {
      deliveryState: 'read',
      receipt: { scope: 'self', delivered: true, deliveredAt: '2026-08-04T12:00:02.000Z', read: true, readAt: '2026-08-04T12:00:03.000Z' },
    }),
    serverMessage('900719925474099312347', '2026-08-04T12:00:02.000Z', {
      id: 'server-900719925474099312347',
      clientMessageId: 'client-command-1',
      isOwn: true,
      deliveryState: 'sent',
    }),
    serverMessage('900719925474099312348', '2026-08-04T12:00:03.000Z'),
  ];

  const merged = mergeTimelineMessages(existing, incoming);
  assert.deepEqual(
    merged.map((message) => message.serverId),
    [
      '900719925474099312343',
      '900719925474099312344',
      '900719925474099312345',
      '900719925474099312346',
      '900719925474099312347',
      '900719925474099312348',
      '900719925474099312349',
    ],
  );
  assert.equal(merged.filter((message) => message.serverId === '900719925474099312346').length, 1);
  assert.equal(merged.find((message) => message.serverId === '900719925474099312346').deliveryState, 'read');
  assert.equal(merged.find((message) => message.serverId === '900719925474099312347').id, 'local-command-1');
});

test('unread anchoring ignores own messages and chooses the newest incoming read target', () => {
  const messages = [
    serverMessage('100', '2026-08-04T12:00:00.000Z'),
    serverMessage('101', '2026-08-04T12:00:01.000Z', { isOwn: true }),
    serverMessage('102', '2026-08-04T12:00:02.000Z'),
    serverMessage('103', '2026-08-04T12:00:03.000Z'),
  ];
  assert.equal(firstUnreadMessageId(messages, '100', 2), 'server-102');
  assert.equal(firstUnreadMessageId(messages, null, 3), 'server-100');
  assert.equal(firstUnreadMessageId(messages, '100', 0), null);
  assert.equal(latestIncomingServerMessage(messages)?.serverId, '103');
});

test('receipt lifecycle stays behind the idempotent BFF and exposes aggregate-only sender data', () => {
  const repository = readFileSync('apps/newone/src/data/repositories/bff-command-repository.ts', 'utf8');
  const reads = readFileSync('apps/newone/src/data/repositories/web-read-repository.ts', 'utf8');
  const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
  const webStore = readFileSync('apps/newone/src/data/persistence/client-store.web.ts', 'utf8');

  assert.match(repository, /\/v2\/messages\/\$\{encodeURIComponent\(input\.messageId\)\}\/receipt/);
  assert.match(repository, /idempotencyKey:\s*input\.idempotencyKey/);
  assert.match(repository, /state:\s*input\.state/);
  assert.match(workspace, /kind:\s*'message_receipt'/);
  assert.match(workspace, /clientStore\.enqueue\(command\)/);
  assert.match(webStore, /'message_receipt'/);
  assert.doesNotMatch(`${repository}\n${workspace}`, /\.from\(['"]message_receipts['"]\)/);

  assert.match(reads, /isOwn && scope !== 'aggregate'/);
  assert.match(reads, /!isOwn && scope !== 'self'/);
  assert.match(reads, /'userId' in receipt[\s\S]*'recipientId' in receipt[\s\S]*'recipients' in receipt[\s\S]*'details' in receipt/);
  assert.match(reads, /visibleReadCount > visibleReadEligibleCount/);
  assert.match(reads, /visibleReadEligibleCount > recipientCount/);
});

test('history paging rejects stale cursors and the UI preserves position without stealing scroll', () => {
  const reads = readFileSync('apps/newone/src/data/repositories/web-read-repository.ts', 'utf8');
  const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
  const pane = readFileSync('apps/newone/src/features/chat/conversation-pane.tsx', 'utf8');

  assert.match(reads, /payload\.schemaVersion !== 1/);
  assert.match(reads, /payload\.conversationId !== input\.conversationId/);
  assert.match(reads, /compareMessageIds\(cursor, input\.after\) >= 0/);
  assert.match(workspace, /latest\.cursors\[conversationId\] !== cursor/);
  assert.match(workspace, /mergeMessages\(latest\.messages\[conversationId\] \?\? \[\], page\.items\)/);
  // The timeline is an inverted list (3e56060, 2026-09-05), so prepending older
  // pages no longer needs the hand-rolled prependAnchor offset maths: the
  // platform pins the visible content instead. The property — a page of history
  // must not move what the reader is looking at — is asserted on that guarantee.
  assert.match(pane, /\binverted\b/);
  assert.match(pane, /maintainVisibleContentPosition=\{\{ minIndexForVisible: 0/);
  // Arriving messages still only pull the view down when the reader is already
  // at the bottom, or when the message is their own. v3.4: both cases scroll
  // explicitly — the platform's own autoscroll gave up whenever anything else
  // changed height, and the newest message ended up behind the composer.
  assert.match(pane, /if \(tail\?\.isOwn\) \{[\s\S]{0,600}scrollToOffset\(\{ offset: 0, animated: false \}\)/);
  assert.match(
    pane,
    /if \(nearBottomRef\.current\) \{[\s\S]{0,600}if \(!tail\?\.isOwn\) listRef\.current\?\.scrollToOffset\(\{ offset: 0, animated: true \}\)/,
  );
  assert.match(pane, /if \(nearBottomRef\.current\) \{/);
  assert.match(
    pane,
    /setNewMessageCount\(\(count\) => count \+ appendedMessageCount\(messages, previousTailRef\.current\)\)/,
  );
  assert.match(pane, /styles\.newMessageJump/);
});
