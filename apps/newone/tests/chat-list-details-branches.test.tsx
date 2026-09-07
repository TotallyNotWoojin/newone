import { fireEvent, render, screen } from '@testing-library/react-native';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { ConversationDetails } from '@/features/chat/conversation-details';
import { ConversationList } from '@/features/chat/conversation-list';

let mockWorkspace: any;

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conversation-alpha',
    title: 'Alpha Crew',
    subtitle: 'North wing',
    lastMessage: 'Valve ready',
    kind: 'group',
    unreadCount: 0,
    pinned: false,
    lastActivity: '18:00',
    avatarColor: '#496D62',
    initials: 'AC',
    presence: 'offline',
    priority: 'normal',
    muted: false,
    mutedUntil: null,
    notificationLevel: 'all',
    translationPair: null,
    participantCount: 4,
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
  mockWorkspace = {
    conversationAvatarUrls: {},
    people: [],
    actionBusy: null,
    respondConnection: jest.fn(async (..._mockArgs: unknown[]) => true),
  };
});

describe('conversation list branch behavior', () => {
  test('filters management records, every inbox kind, and every searchable field', async () => {
    const records = [
      conversation(),
      conversation({ id: 'direct', title: 'Direct Person', subtitle: 'Support', lastMessage: 'Ready', kind: 'direct', unreadCount: 1 }),
      conversation({ id: 'team', title: 'Team Room', subtitle: 'South', lastMessage: 'Shift', kind: 'team' }),
      conversation({ id: 'shift', title: 'Shift Room', subtitle: 'East', lastMessage: 'Handoff', kind: 'shift' }),
      conversation({ id: 'announcement', title: 'Official Notice', subtitle: 'Company', lastMessage: 'Policy', kind: 'announcement' }),
      conversation({ id: 'managed', title: 'Hidden Managed', managementOnly: true, unreadCount: 99 }),
    ];
    const props = listProps({ conversations: records });
    const view = await render(<ConversationList {...props} />);
    expect(screen.queryByText('Hidden Managed')).toBeNull();

    await view.rerender(<ConversationList {...props} search="alpha" />);
    expect(screen.getByText('Alpha Crew')).toBeTruthy();
    await view.rerender(<ConversationList {...props} search="valve" />);
    expect(screen.getByText('Alpha Crew')).toBeTruthy();
    await view.rerender(<ConversationList {...props} search="north" />);
    expect(screen.getByText('Alpha Crew')).toBeTruthy();
    await view.rerender(<ConversationList {...props} search="no-match" />);
    expect(screen.getByText('chat.noResults')).toBeTruthy();

    await view.rerender(<ConversationList {...props} filter="unread" />);
    expect(screen.getByText('Direct Person')).toBeTruthy();
    expect(screen.queryByText('Alpha Crew')).toBeNull();
    await view.rerender(<ConversationList {...props} filter="direct" />);
    expect(screen.getByText('Direct Person')).toBeTruthy();
    await view.rerender(<ConversationList {...props} filter="groups" />);
    expect(screen.getByText('Team Room')).toBeTruthy();
    expect(screen.getByText('Shift Room')).toBeTruthy();
    await view.rerender(<ConversationList {...props} filter="announcements" />);
    expect(screen.getByText('Official Notice')).toBeTruthy();
  });

  test('renders pinned, safety, muted, selected, unread, official, and divider row states', async () => {
    const onSelect = jest.fn();
    await render(<ConversationList {...listProps({
      conversations: [
        conversation({ id: 'official', title: 'Pinned Official', kind: 'announcement', pinned: true }),
        conversation({ id: 'safety', title: 'Safety Group', priority: 'safety', unreadCount: 3 }),
        conversation({ id: 'muted', title: 'Muted Direct', kind: 'direct', muted: true, presence: 'away' }),
      ],
      desktop: true,
      selectedId: 'safety',
      onSelect,
    })} />);
    expect(screen.getByText('chat.workspace')).toBeTruthy();
    expect(screen.getByText('3 chat.unreadCount')).toBeTruthy();
    expect(screen.getByText('chat.recent')).toBeTruthy();
    await fireEvent.press(screen.getByText('Safety Group'));
    expect(onSelect).toHaveBeenCalledWith('safety');
    await fireEvent.press(screen.getByRole('button', { name: 'chat.newMenu' }));
  });

  test('shows only discoverable groups outside the management shell and handles join/cancel actions', async () => {
    const onRequestJoin = jest.fn(async () => true);
    const onCancelJoin = jest.fn(async () => true);
    const pending = { requestId: 'request-controlled', conversationId: 'pending', status: 'pending' };
    await render(<ConversationList {...listProps({
      conversations: [conversation({ id: 'managed-discoverable', managementOnly: true })],
      discoverableConversations: [
        {
          conversationId: 'managed-discoverable', name: 'Never Discoverable', description: null,
          memberCount: 1, historyDisclosure: { labelKey: 'history.hidden' }, myJoinRequest: null,
        },
        {
          conversationId: 'open', name: 'Open Safety', description: null,
          memberCount: 8, historyDisclosure: { labelKey: 'history.sinceJoin' }, myJoinRequest: null,
        },
        {
          conversationId: 'pending', name: 'Pending Safety', description: 'Approval pending',
          memberCount: 4, historyDisclosure: { labelKey: 'history.sinceJoin' }, myJoinRequest: pending,
        },
      ],
      onRequestJoin,
      onCancelJoin,
    })} />);
    expect(screen.queryByText('Never Discoverable')).toBeNull();
    expect(screen.getByText('8 chat.currentMembers')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'chat.requestToJoin' }));
    await fireEvent.press(screen.getByRole('button', { name: 'chat.cancelJoinRequest' }));
    expect(onRequestJoin).toHaveBeenCalledWith('open');
    expect(onCancelJoin).toHaveBeenCalledWith(pending);
  });
});

describe('pending counterparts in the chat list', () => {
  const requester = {
    id: 'user-requester', displayName: 'Riley Requester', initials: 'RR', avatarColor: '#225544',
    roleLabel: '', presence: 'online', connectionState: 'pending', connectionRequestDirection: 'incoming',
  };
  const friend = {
    id: 'user-friend', displayName: 'Ana Friend', initials: 'AF', avatarColor: '#334455',
    roleLabel: '', presence: 'away', connectionState: 'connected',
  };

  test('a direct thread whose counterpart is still pending is an ordinary row with no request section', async () => {
    mockWorkspace.people = [requester, friend];
    const pendingThread = conversation({
      id: 'pending-thread', title: 'Riley Requester', kind: 'direct', directParticipantId: 'user-requester',
      lastMessage: 'Hi! We met at the market.', unreadCount: 1,
    });
    const settled = conversation({
      id: 'settled', title: 'Ana Friend', kind: 'direct', directParticipantId: 'user-friend',
      lastMessage: 'See you soon',
    });
    await render(<ConversationList {...listProps({ conversations: [pendingThread, settled] })} />);
    expect(screen.queryByText('chat.requests')).toBeNull();
    expect(screen.queryByText('chat.requestsHint')).toBeNull();
    expect(screen.queryByRole('button', { name: 'people.accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'people.decline' })).toBeNull();
    expect(screen.getByText('Riley Requester')).toBeTruthy();
    expect(screen.getByText('Hi! We met at the market.')).toBeTruthy();
    expect(screen.getByText('Ana Friend')).toBeTruthy();
    expect(mockWorkspace.respondConnection).not.toHaveBeenCalled();
  });
});

describe('conversation detail notification states', () => {
  test.each([
    [conversation({ mutedUntil: '2999-01-01T00:00:00.000Z' }), 'Timed mute ends'],
    [conversation({ notificationLevel: 'mentions' }), 'Mentions only'],
    [conversation({ notificationLevel: 'none' }), 'Muted until changed'],
    [conversation({ muted: true }), 'Muted until changed'],
    [conversation({ notificationLevel: 'all', translationPair: 'ES → EN' }), 'All activity'],
  ])('renders authoritative notification state %#', async (record, expected) => {
    await render(<ConversationDetails conversation={record} />);
    expect(screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
  });

  test('renders direct and announcement identity variants and translation fallback', async () => {
    const view = await render(<ConversationDetails conversation={conversation({
      id: 'direct', kind: 'direct', participantCount: undefined, translationPair: null,
    })} />);
    expect(screen.queryByText(/chat.membersLower/)).toBeNull();
    expect(screen.getByText('chat.off')).toBeTruthy();

    await view.rerender(<ConversationDetails conversation={conversation({
      id: 'announcement', kind: 'announcement', participantCount: undefined,
    })} />);
    expect(screen.getByText('0 chat.membersLower')).toBeTruthy();
  });
});
