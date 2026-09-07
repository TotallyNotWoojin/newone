import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import {
  ConversationList,
  attachContextMenu,
  conversationRowActions,
} from '@/features/chat/conversation-list';

let mockWorkspace: any;

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conversation-beach',
    title: 'Beach trip',
    subtitle: '3 people',
    lastMessage: 'Bring the umbrella',
    kind: 'group',
    unreadCount: 0,
    pinned: false,
    lastActivity: '18:00',
    avatarColor: '#496D62',
    initials: 'BT',
    presence: 'offline',
    priority: 'normal',
    muted: false,
    managementOnly: false,
    ...overrides,
  } as any;
}

function listProps(overrides: Record<string, unknown> = {}) {
  return {
    conversations: [conversation()],
    filter: 'all',
    search: '',
    onFilterChange: jest.fn(),
    onSearchChange: jest.fn(),
    onSelect: jest.fn(),
    onCompose: jest.fn(),
    ...overrides,
  } as any;
}

beforeEach(() => {
  mockWorkspace = { conversationAvatarUrls: {}, people: [] };
});

describe('what a chat row offers', () => {
  test('a one-to-one chat is deleted; a group is left, and it says so', () => {
    expect(conversationRowActions({ kind: 'direct' }).map((action) => action.key))
      .toEqual(['markUnread', 'mute', 'archive', 'delete']);
    expect(conversationRowActions({ kind: 'group' }).map((action) => action.key))
      .toEqual(['markUnread', 'mute', 'archive', 'leave']);
    expect(conversationRowActions({ kind: 'group' }).at(-1)).toMatchObject({
      labelKey: 'chat.leaveGroup',
      destructive: true,
    });
    expect(conversationRowActions({ kind: 'direct' }).at(-1)).toMatchObject({
      labelKey: 'chat.deleteChat',
      destructive: true,
    });
  });

  test('the first two actions answer the row as it stands', () => {
    expect(conversationRowActions({ kind: 'direct', unreadCount: 3 })[0]).toMatchObject({
      key: 'markRead',
    });
    expect(conversationRowActions({ kind: 'direct', unreadCount: 0 })[0]).toMatchObject({
      key: 'markUnread',
    });
    expect(conversationRowActions({ kind: 'direct', muted: true })[1]).toMatchObject({
      key: 'unmute',
    });
    expect(conversationRowActions({ kind: 'direct', muted: false })[1]).toMatchObject({
      key: 'mute',
    });
    // Nothing in the set is destructive except the last one.
    expect(conversationRowActions({ kind: 'group' }).filter((action) => action.destructive))
      .toHaveLength(1);
  });
});

describe('reaching those actions with a mouse', () => {
  test('a right-click on the row opens them, and the listener is taken away again', () => {
    const open = jest.fn();
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    const node = {
      addEventListener: jest.fn((event: string, handler: (payload: unknown) => void) => {
        (listeners[event] ??= []).push(handler);
      }),
      removeEventListener: jest.fn((event: string, handler: (payload: unknown) => void) => {
        listeners[event] = (listeners[event] ?? []).filter((item) => item !== handler);
      }),
    };

    const detach = attachContextMenu(node, open);
    expect(node.addEventListener).toHaveBeenCalledWith('contextmenu', expect.any(Function));

    const preventDefault = jest.fn();
    listeners.contextmenu![0]!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);

    // A plain browser event with nothing to prevent is still handled.
    listeners.contextmenu![0]!({});
    expect(open).toHaveBeenCalledTimes(2);

    detach?.();
    expect(node.removeEventListener).toHaveBeenCalled();
    expect(listeners.contextmenu).toHaveLength(0);
  });

  test('a phone view is not a DOM node, so nothing is attached', () => {
    expect(attachContextMenu(null, jest.fn())).toBeUndefined();
    expect(attachContextMenu({}, jest.fn())).toBeUndefined();
  });
});

describe('the row on screen', () => {
  test('hovering shows the actions and moving away puts them back', async () => {
    const onRowAction = jest.fn();
    await render(<ConversationList {...listProps({ onRowAction })} />);
    expect(screen.queryByRole('button', { name: 'chat.archive' })).toBeNull();

    const row = screen.getByRole('button', { name: 'Beach trip' });
    await fireEvent(row, 'hoverIn');
    expect(screen.getByRole('button', { name: 'chat.archive' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.leaveGroup' })).toBeTruthy();

    await fireEvent(row, 'hoverOut');
    expect(screen.queryByRole('button', { name: 'chat.archive' })).toBeNull();
  });

  test('a long press opens them on a phone, and one tap runs the action and closes', async () => {
    const onRowAction = jest.fn();
    const onSelect = jest.fn();
    await render(<ConversationList {...listProps({ onRowAction, onSelect })} />);

    const row = screen.getByRole('button', { name: 'Beach trip' });
    await fireEvent(row, 'longPress');
    expect(screen.getByRole('button', { name: 'chat.markUnread' })).toBeTruthy();

    // While the actions are open the row itself closes them instead of opening
    // the chat, the way a phone behaves.
    await fireEvent.press(row);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'chat.markUnread' })).toBeNull();

    await fireEvent(row, 'longPress');
    await fireEvent.press(screen.getByRole('button', { name: 'chat.mute' }));
    expect(onRowAction).toHaveBeenCalledWith('mute', expect.objectContaining({ id: 'conversation-beach' }));
    expect(screen.queryByRole('button', { name: 'chat.mute' })).toBeNull();

    await fireEvent.press(row);
    expect(onSelect).toHaveBeenCalledWith('conversation-beach');
  });

  test('a row with no actions wired stays a plain row', async () => {
    const onSelect = jest.fn();
    await render(<ConversationList {...listProps({ onSelect })} />);
    const row = screen.getByRole('button', { name: 'Beach trip' });
    await fireEvent(row, 'longPress');
    expect(screen.queryByRole('button', { name: 'chat.archive' })).toBeNull();
    await fireEvent.press(row);
    expect(onSelect).toHaveBeenCalledWith('conversation-beach');
  });

  test('a chat put back to unread reads as unread and offers to be read again', async () => {
    const onRowAction = jest.fn();
    await render(<ConversationList {...listProps({
      onRowAction,
      markedUnreadIds: ['conversation-beach'],
    })} />);

    expect(screen.getByText('1')).toBeTruthy();
    const row = screen.getByRole('button', { name: 'Beach trip' });
    await fireEvent(row, 'hoverIn');
    expect(screen.getByRole('button', { name: 'chat.markRead' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.markUnread' })).toBeNull();
  });

  test('scrolling away offers a way back to the newest', async () => {
    await render(<ConversationList {...listProps({
      conversations: [conversation(), conversation({ id: 'other', title: 'Other chat' })],
    })} />);
    expect(screen.queryByRole('button', { name: 'chat.jumpToLatest' })).toBeNull();

    const list = screen.getByTestId('conversation-list');
    await fireEvent.scroll(list, { nativeEvent: { contentOffset: { y: 900 } } });
    const jump = screen.getByRole('button', { name: 'chat.jumpToLatest' });

    await fireEvent.press(jump);
    expect(screen.queryByRole('button', { name: 'chat.jumpToLatest' })).toBeNull();

    // Near the top it stays out of the way.
    await fireEvent.scroll(list, { nativeEvent: { contentOffset: { y: 12 } } });
    expect(screen.queryByRole('button', { name: 'chat.jumpToLatest' })).toBeNull();
  });
});
