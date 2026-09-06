import { describe, expect, test } from '@jest/globals';

import type { Message } from '@/domain/types';
import {
  appendedMessageCount,
  buildTimelineRows,
  MEDIA_MAX_HEIGHT,
  mediaFrame,
  mediaMaxWidth,
  messageKey,
} from '@/features/chat/timeline-layout';

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    conversationId: 'conversation-main',
    senderId: 'peer',
    senderName: 'Peer',
    senderInitials: 'P',
    senderColor: '#000000',
    originalText: `text ${overrides.id}`,
    sourceLanguage: 'en',
    translationState: 'not_requested',
    sentAt: '12:00',
    isOwn: false,
    deliveryState: 'sent',
    priority: 'normal',
    ...overrides,
  } as Message;
}

describe('buildTimelineRows', () => {
  test('reverses into newest-first rows and flags a day change from the message above', () => {
    const rows = buildTimelineRows([
      message({ id: 'a', dayLabel: 'Yesterday' }),
      message({ id: 'b', dayLabel: 'Yesterday' }),
      message({ id: 'c', dayLabel: 'Today' }),
    ], { groupConversation: true });
    expect(rows.map((row) => row.key)).toEqual(['c', 'b', 'a']);
    expect(rows.map((row) => row.showDateSeparator)).toEqual([true, false, true]);
  });

  test('shows the sender only for the first incoming message of a run, never for own or system rows', () => {
    const rows = buildTimelineRows([
      message({ id: 'p1', senderId: 'peer' }),
      message({ id: 'p2', senderId: 'peer' }),
      message({ id: 'me', senderId: 'self', isOwn: true }),
      message({ id: 'sys', senderId: 'peer', systemEvent: { eventType: 'conversation.created', targetUserId: null } }),
      message({ id: 'q1', senderId: 'other' }),
    ], { groupConversation: true });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.showSender]));
    expect(byKey).toEqual({ p1: true, p2: false, me: false, sys: false, q1: true });
  });

  test('never shows senders in a direct chat and marks the unread divider row', () => {
    const rows = buildTimelineRows([
      message({ id: 'read' }),
      message({ id: 'unread' }),
    ], { groupConversation: false, unreadDividerId: 'unread' });
    expect(rows.every((row) => !row.showSender)).toBe(true);
    expect(rows.find((row) => row.key === 'unread')?.showUnreadDivider).toBe(true);
    expect(rows.find((row) => row.key === 'read')?.showUnreadDivider).toBe(false);
  });

  test('returns no rows for an empty thread', () => {
    expect(buildTimelineRows([], { groupConversation: true })).toEqual([]);
  });
});

describe('appendedMessageCount', () => {
  const thread = [
    message({ id: 'local-1', clientMessageId: 'c1' }),
    message({ id: 'server-2', serverId: '2' }),
    message({ id: 'server-3', serverId: '3' }),
  ];

  test('counts the messages after the previously known tail', () => {
    expect(appendedMessageCount(thread, '2')).toBe(1);
    expect(appendedMessageCount(thread, 'c1')).toBe(2);
  });

  test('falls back to one when the previous tail is gone, unknown, or there was none', () => {
    expect(appendedMessageCount(thread, 'missing')).toBe(1);
    expect(appendedMessageCount(thread, null)).toBe(1);
    expect(appendedMessageCount([], 'anything')).toBe(0);
  });
});

describe('messageKey', () => {
  test('prefers the server id, then the client id, then the local id', () => {
    expect(messageKey({ id: 'x', serverId: '9', clientMessageId: 'c' })).toBe('9');
    expect(messageKey({ id: 'x', clientMessageId: 'c' })).toBe('c');
    expect(messageKey({ id: 'x' })).toBe('x');
  });
});

describe('mediaFrame', () => {
  test('fits landscape media to the width and portrait media to the height cap', () => {
    expect(mediaFrame(16 / 9, 300)).toEqual({ width: 300, height: 169 });
    expect(mediaFrame(0.5, 300)).toEqual({ width: 160, height: MEDIA_MAX_HEIGHT });
  });

  test('uses a 4:3 default until the natural size is known and tolerates junk ratios', () => {
    expect(mediaFrame(null, 240)).toEqual({ width: 240, height: 180 });
    expect(mediaFrame(Number.NaN, 240)).toEqual({ width: 240, height: 180 });
    expect(mediaFrame(-2, 240)).toEqual({ width: 240, height: 180 });
  });

  test('bounds the bubble media width to 80% of the row and caps it on wide panes', () => {
    expect(mediaMaxWidth(360, true)).toBe(Math.floor((360 - 24 - 34) * 0.8) - 6);
    expect(mediaMaxWidth(360, false)).toBeGreaterThan(mediaMaxWidth(360, true));
    expect(mediaMaxWidth(1400, false)).toBe(360);
    expect(mediaMaxWidth(100, true)).toBe(120);
  });
});
