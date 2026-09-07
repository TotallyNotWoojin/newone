import { describe, expect, test } from '@jest/globals';

import {
  messageEditWindowMs,
  messageEditWindowOpen,
} from '@/features/chat/message-edit-window';

const now = Date.parse('2026-09-08T12:00:00.000Z');
const sentAgo = (ms: number) => new Date(now - ms).toISOString();

const own = (createdAt: string | undefined, overrides: Record<string, unknown> = {}) => ({
  isOwn: true,
  serverId: 'message-1',
  deleted: false,
  createdAt,
  ...overrides,
}) as Parameters<typeof messageEditWindowOpen>[0];

describe('the fifteen-minute window on editing and unsending', () => {
  test('is fifteen minutes', () => {
    expect(messageEditWindowMs).toBe(900_000);
  });

  test('is open on a message you just sent', () => {
    expect(messageEditWindowOpen(own(sentAgo(0)), now)).toBe(true);
    expect(messageEditWindowOpen(own(sentAgo(60_000)), now)).toBe(true);
  });

  test('is open right up to the fifteenth minute and shut after it', () => {
    expect(messageEditWindowOpen(own(sentAgo(messageEditWindowMs - 1000)), now)).toBe(true);
    expect(messageEditWindowOpen(own(sentAgo(messageEditWindowMs)), now)).toBe(false);
    expect(messageEditWindowOpen(own(sentAgo(messageEditWindowMs + 1000)), now)).toBe(false);
    expect(messageEditWindowOpen(own(sentAgo(24 * 60 * 60 * 1000)), now)).toBe(false);
  });

  test('stays open when the phone’s clock runs behind the server’s', () => {
    expect(messageEditWindowOpen(own(new Date(now + 30_000).toISOString()), now)).toBe(true);
  });

  test('is shut on somebody else’s message, a queued one, and a deleted one', () => {
    const justSent = sentAgo(1000);
    expect(messageEditWindowOpen(own(justSent, { isOwn: false }), now)).toBe(false);
    expect(messageEditWindowOpen(own(justSent, { serverId: undefined }), now)).toBe(false);
    expect(messageEditWindowOpen(own(justSent, { deleted: true }), now)).toBe(false);
  });

  test('is shut when there is no timestamp to judge by', () => {
    expect(messageEditWindowOpen(own(undefined), now)).toBe(false);
    expect(messageEditWindowOpen(own('not a date'), now)).toBe(false);
  });

  test('reads the wall clock when it is not given one', () => {
    expect(messageEditWindowOpen(own(new Date().toISOString()))).toBe(true);
    expect(messageEditWindowOpen(own('2020-01-01T00:00:00.000Z'))).toBe(false);
  });
});
