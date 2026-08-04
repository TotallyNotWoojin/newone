import {
  signConversationMemberCandidateCursor,
  signMessageCursor,
  signSearchCursor,
  verifyConversationMemberCandidateCursor,
  verifyMessageCursor,
  verifySearchCursor,
} from '../_shared/cursors.ts';
import { assertEquals, assertRejects } from './assert.ts';

const environment = { get: () => 'cursor-signing-key-that-is-at-least-32-characters' };
const organizationId = '00000000-0000-4000-8000-000000000001';
const conversationId = '00000000-0000-4000-8000-000000000002';
const tamperLastCharacter = (value: string): string =>
  `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;

Deno.test('message cursors are opaque, signed, expiring, and tenant-bound', async () => {
  const cursor = await signMessageCursor({
    organizationId,
    conversationId,
    boundaryMessageId: '101',
    direction: 'older',
  }, environment);
  const decoded = await verifyMessageCursor(
    cursor,
    { organizationId, conversationId },
    environment,
  );
  assertEquals(decoded.boundaryMessageId, '101');
  assertEquals(decoded.direction, 'older');

  await assertRejects(() =>
    verifyMessageCursor(
      tamperLastCharacter(cursor),
      { organizationId, conversationId },
      environment,
    )
  );
  await assertRejects(() =>
    verifyMessageCursor(cursor, {
      organizationId: '00000000-0000-4000-8000-000000000099',
      conversationId,
    }, environment)
  );
});

Deno.test('conversation member candidate cursors bind every request field and expire', async () => {
  const actorUserId = '00000000-0000-4000-8000-000000000003';
  const signingKey = 'member-candidate-signing-key-that-is-at-least-32-characters';
  const databaseCursor = btoa(JSON.stringify({ version: 1, after: 'member-50' }));
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  try {
    Date.now = () => now;
    const cursor = await signConversationMemberCandidateCursor({
      organizationId,
      actorUserId,
      conversationId,
      query: '  OPERATIONS  ',
      pageSize: 50,
      databaseCursor,
    }, signingKey);
    const decoded = await verifyConversationMemberCandidateCursor(cursor, {
      organizationId,
      actorUserId,
      conversationId,
      query: 'operations',
      pageSize: 50,
    }, signingKey);
    assertEquals(decoded.databaseCursor, databaseCursor);
    assertEquals(decoded.normalizedQuery, 'operations');

    await assertRejects(() =>
      verifyConversationMemberCandidateCursor(
        tamperLastCharacter(cursor),
        { organizationId, actorUserId, conversationId, query: 'operations', pageSize: 50 },
        signingKey,
      )
    );
    now += 15 * 60 * 1000 + 1;
    await assertRejects(() =>
      verifyConversationMemberCandidateCursor(
        cursor,
        { organizationId, actorUserId, conversationId, query: 'operations', pageSize: 50 },
        signingKey,
      )
    );
  } finally {
    Date.now = originalNow;
  }
});

Deno.test('search cursors sign the database boundary and bind it to tenant and actor', async () => {
  const actorUserId = '00000000-0000-4000-8000-000000000003';
  const signingKey = 'search-cursor-signing-key-that-is-at-least-32-characters';
  const databaseCursor = btoa(JSON.stringify({ version: 1, id: '101' }));
  const cursor = await signSearchCursor({
    organizationId,
    actorUserId,
    databaseCursor,
  }, signingKey);
  const decoded = await verifySearchCursor(cursor, {
    organizationId,
    actorUserId,
  }, signingKey);
  assertEquals(decoded.databaseCursor, databaseCursor);

  await assertRejects(() =>
    verifySearchCursor(
      tamperLastCharacter(cursor),
      { organizationId, actorUserId },
      signingKey,
    )
  );
  await assertRejects(() =>
    verifySearchCursor(cursor, {
      organizationId,
      actorUserId: '00000000-0000-4000-8000-000000000099',
    }, signingKey)
  );
  await assertRejects(() =>
    verifySearchCursor(cursor, {
      organizationId: '00000000-0000-4000-8000-000000000099',
      actorUserId,
    }, signingKey)
  );
});
