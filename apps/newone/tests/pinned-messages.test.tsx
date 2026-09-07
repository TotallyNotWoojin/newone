import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { PinnedMessage } from '@/data/repositories/contracts';
import {
  groupPinsByConversation,
  pinnedPreview,
  pinnedTimeLabel,
  PinnedMessagesModal,
} from '@/features/chat/pinned-messages';

let mockWorkspace: Record<string, any>;

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

function pin(overrides: Partial<PinnedMessage> = {}): PinnedMessage {
  return {
    conversationId: 'chat-a',
    messageId: '10',
    senderId: 'user-other',
    senderName: 'Ana Torres',
    text: 'Bring the tickets',
    attachmentKind: null,
    sentAt: '2026-09-01T10:00:00.000Z',
    pinnedAt: '2026-09-02T10:00:00.000Z',
    canUnpin: true,
    ...overrides,
  };
}

const conversations = [
  { id: 'chat-a', title: 'Ana Torres' },
  { id: 'chat-b', title: 'Weekend plans' },
];

beforeEach(() => {
  mockWorkspace = {
    conversations,
    loadPinnedMessages: jest.fn(async () => [pin()]),
    unpinMessage: jest.fn(async () => true),
  };
});

describe('pin rows', () => {
  test('an attachment pin says in one word what was sent', () => {
    const t = ((key: string) => key) as any;
    expect(pinnedPreview(pin({ text: '  ' , attachmentKind: 'image' }), t)).toBe('chat.attachmentPhoto');
    expect(pinnedPreview(pin({ text: '', attachmentKind: 'video' }), t)).toBe('chat.attachmentVideo');
    expect(pinnedPreview(pin({ text: '', attachmentKind: 'voice' }), t)).toBe('chat.attachmentVoice');
    expect(pinnedPreview(pin({ text: '', attachmentKind: 'file' }), t)).toBe('chat.attachmentFile');
    expect(pinnedPreview(pin({ text: 'Hello' }), t)).toBe('Hello');
    expect(pinnedPreview(pin({ text: '', attachmentKind: null }), t)).toBe('');
  });

  test('an unreadable time leaves the row without one', () => {
    expect(pinnedTimeLabel('nonsense', 'en')).toBe('');
    expect(pinnedTimeLabel('2026-09-01T10:00:00.000Z', 'en')).not.toBe('');
  });

  test('today shows a clock and another day shows a date', () => {
    const today = new Date();
    today.setHours(9, 5, 0, 0);
    // A time today reads as a time; anything older reads as a day.
    expect(pinnedTimeLabel(today.toISOString(), 'en')).toMatch(/[0-9]:[0-9]{2}/);
    expect(pinnedTimeLabel('2026-01-02T10:00:00.000Z', 'en')).not.toMatch(/:/);
  });
});

describe('grouping pins by chat', () => {
  test('keeps the newest-first order and drops chats the device does not know', () => {
    const titleFor = (id: string) => conversations.find((item) => item.id === id)?.title;
    const groups = groupPinsByConversation([
      pin({ conversationId: 'chat-b', messageId: '30' }),
      pin({ conversationId: 'chat-a', messageId: '20' }),
      pin({ conversationId: 'chat-b', messageId: '25' }),
      pin({ conversationId: 'chat-gone', messageId: '5' }),
    ], titleFor);
    expect(groups.map((group) => group.conversationId)).toEqual(['chat-b', 'chat-a']);
    expect(groups[0].title).toBe('Weekend plans');
    expect(groups[0].pins.map((entry) => entry.messageId)).toEqual(['30', '25']);
    expect(groups[1].pins.map((entry) => entry.messageId)).toEqual(['20']);
  });
});

describe('PinnedMessagesModal', () => {
  test("a chat's pins list newest first and jump to the message", async () => {
    mockWorkspace.loadPinnedMessages = jest.fn(async () => [
      pin({ messageId: '30', text: 'Newest', pinnedAt: '2026-09-03T10:00:00.000Z' }),
      pin({ messageId: '20', text: 'Older', pinnedAt: '2026-09-02T10:00:00.000Z' }),
    ]);
    const onOpenMessage = jest.fn();
    const onClose = jest.fn();
    await render(
      <PinnedMessagesModal
        conversationId="chat-a"
        onClose={onClose}
        onOpenMessage={onOpenMessage}
        visible
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/Newest/)).toBeTruthy());
    expect(mockWorkspace.loadPinnedMessages).toHaveBeenCalledWith('chat-a');
    // No chat headings inside one chat: the sheet already names it.
    expect(screen.queryByText('Ana Torres')).toBeNull();
    fireEvent.press(screen.getByLabelText(/Newest/));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenMessage).toHaveBeenCalledWith('chat-a', '30');
  });

  test('nothing pinned says so instead of showing an empty sheet', async () => {
    mockWorkspace.loadPinnedMessages = jest.fn(async () => []);
    await render(
      <PinnedMessagesModal
        conversationId="chat-a"
        onClose={() => undefined}
        onOpenMessage={() => undefined}
        visible
      />,
    );
    await waitFor(() => expect(screen.getByText('chat.pinnedEmpty')).toBeTruthy());
  });

  test('a read the server refuses is an empty list, not a stuck spinner', async () => {
    mockWorkspace.loadPinnedMessages = jest.fn(async () => null);
    await render(
      <PinnedMessagesModal
        conversationId="chat-a"
        onClose={() => undefined}
        onOpenMessage={() => undefined}
        visible
      />,
    );
    await waitFor(() => expect(screen.getByText('chat.pinnedEmpty')).toBeTruthy());
  });

  test('unpinning from the row removes it and leaves the rest', async () => {
    mockWorkspace.loadPinnedMessages = jest.fn(async () => [
      pin({ messageId: '30', senderName: 'Ana Torres', text: 'Keep me' }),
      pin({ messageId: '20', senderName: 'Sam Diaz', text: 'Drop me' }),
    ]);
    await render(
      <PinnedMessagesModal
        conversationId="chat-a"
        onClose={() => undefined}
        onOpenMessage={() => undefined}
        visible
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('chat.unpin: Sam Diaz')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('chat.unpin: Sam Diaz'));
    await waitFor(() => expect(screen.queryByLabelText('chat.unpin: Sam Diaz')).toBeNull());
    expect(mockWorkspace.unpinMessage).toHaveBeenCalledWith('chat-a', '20');
    expect(screen.getByLabelText('chat.unpin: Ana Torres')).toBeTruthy();
  });

  test('a pin nobody may unpin offers no unpin control', async () => {
    mockWorkspace.loadPinnedMessages = jest.fn(async () => [pin({ canUnpin: false })]);
    await render(
      <PinnedMessagesModal
        conversationId="chat-a"
        onClose={() => undefined}
        onOpenMessage={() => undefined}
        visible
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/Bring the tickets/)).toBeTruthy());
    expect(screen.queryByLabelText('chat.unpin: Ana Torres')).toBeNull();
  });

  test('a refused unpin leaves the row where it is', async () => {
    mockWorkspace.loadPinnedMessages = jest.fn(async () => [pin({ senderName: 'Sam Diaz' })]);
    mockWorkspace.unpinMessage = jest.fn(async () => false);
    await render(
      <PinnedMessagesModal
        conversationId="chat-a"
        onClose={() => undefined}
        onOpenMessage={() => undefined}
        visible
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('chat.unpin: Sam Diaz')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('chat.unpin: Sam Diaz'));
    await waitFor(() => expect(mockWorkspace.unpinMessage).toHaveBeenCalled());
    expect(screen.getByLabelText('chat.unpin: Sam Diaz')).toBeTruthy();
  });

  test('no pins anywhere invites the reader to make one', async () => {
    mockWorkspace.loadPinnedMessages = jest.fn(async () => []);
    await render(
      <PinnedMessagesModal onClose={() => undefined} onOpenMessage={() => undefined} visible />,
    );
    await waitFor(() => expect(screen.getByText('chat.pinnedEmptyAll')).toBeTruthy());
  });

  test('across every chat the rows sit under the chat that holds them', async () => {
    mockWorkspace.loadPinnedMessages = jest.fn(async () => [
      pin({ conversationId: 'chat-b', messageId: '30', text: 'Ferry at six' }),
      pin({ conversationId: 'chat-a', messageId: '20', text: 'Bring the tickets' }),
    ]);
    const onOpenMessage = jest.fn();
    await render(
      <PinnedMessagesModal
        onClose={() => undefined}
        onOpenMessage={onOpenMessage}
        visible
      />,
    );
    await waitFor(() => expect(screen.getByText('Weekend plans')).toBeTruthy());
    expect(mockWorkspace.loadPinnedMessages).toHaveBeenCalledWith(null);
    expect(screen.getByText('Ana Torres')).toBeTruthy();
    fireEvent.press(screen.getByLabelText(/Ferry at six/));
    expect(onOpenMessage).toHaveBeenCalledWith('chat-b', '30');
  });
});
