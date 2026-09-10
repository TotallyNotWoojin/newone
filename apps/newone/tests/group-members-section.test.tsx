import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { GroupMembersSection } from '@/features/chat/group-members-section';
import type { Conversation } from '@/domain/types';

const mockRouter = { back: jest.fn(), push: jest.fn(), replace: jest.fn() };
let mockWorkspace: Record<string, any>;

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));

const self = {
  id: 'user-self', displayName: 'Jordan Lee', initials: 'JL', avatarColor: '#123456',
  roleLabel: '', role: 'employee', site: '', department: '', preferredLanguage: 'en',
  presence: 'online', connectionState: 'self',
};

function person(overrides: Record<string, unknown>) {
  return {
    ...self, id: 'user-ana', displayName: 'Ana Friend', username: 'ana_friend',
    initials: 'AF', connectionState: 'connected', presence: 'offline', ...overrides,
  };
}

function workspaceWith(overrides: Record<string, unknown> = {}) {
  return {
    // The section is a consumer feature: the workplace realm keeps its own
    // member controls, so the component renders only in the personal realm.
    organizationId: '11111111-1111-4111-8111-111111111111',
    currentUser: self,
    people: [
      self,
      person({}),
      person({ id: 'user-sam', displayName: 'Sam Stranger', username: 'sam_stranger', initials: 'SS', connectionState: 'available' }),
    ],
    openOrCreateDirectConversation: jest.fn(async (..._args: unknown[]) => 'conversation-direct'),
    updateConnection: jest.fn(async (..._args: unknown[]) => true),
    setPersonMuted: jest.fn(async (..._args: unknown[]) => true),
    setPersonBlocked: jest.fn(async (..._args: unknown[]) => true),
    removeConversationMember: jest.fn(async (..._args: unknown[]) => true),
    ...overrides,
  };
}

function group(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conversation-group',
    title: 'Weekend trip',
    initials: 'WT',
    avatarColor: '#496D62',
    kind: 'group',
    subtitle: '',
    lastMessage: '',
    lastActivity: '',
    unreadCount: 0,
    pinned: false,
    favorite: false,
    muted: false,
    myRole: 'owner',
    memberIds: ['user-self', 'user-ana', 'user-sam'],
    memberRoles: { 'user-self': 'owner', 'user-ana': 'admin', 'user-sam': 'member' },
    ...overrides,
  };
}

beforeEach(() => {
  mockWorkspace = workspaceWith();
});

describe('group members section', () => {
  test('lists every member on one compact line behind a single control', async () => {
    await render(<GroupMembersSection conversation={group()} />);
    expect(screen.getByText('group.membersTitle')).toBeTruthy();
    expect(screen.getByText('Jordan Lee · group.memberYou')).toBeTruthy();
    expect(screen.getByText('Ana Friend')).toBeTruthy();
    expect(screen.getByText('@ana_friend')).toBeTruthy();
    // Only one control per row, and none on your own row.
    expect(screen.getByRole('button', { name: 'group.memberActions Ana Friend' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'group.memberActions Jordan Lee' })).toBeNull();
    // The actions stay closed until asked for.
    expect(screen.queryByRole('button', { name: 'group.memberMessage Jordan Lee' })).toBeNull();
  });

  test('a member row offers message, add as friend, mute, block and removal', async () => {
    await render(<GroupMembersSection conversation={group()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberActions Sam Stranger' }));

    await fireEvent.press(screen.getByRole('button', { name: 'group.memberMessage Sam Stranger' }));
    await waitFor(() => expect(mockWorkspace.openOrCreateDirectConversation)
      .toHaveBeenCalledWith('user-sam'));
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-direct' },
    });

    // Message leaves for the one-to-one chat, so the sheet closes behind it.
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberActions Sam Stranger' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberAddFriend Sam Stranger' }));
    expect(mockWorkspace.updateConnection).toHaveBeenCalledWith('user-sam');

    await fireEvent.press(screen.getByRole('button', { name: 'group.memberMute Sam Stranger' }));
    expect(mockWorkspace.setPersonMuted).toHaveBeenCalledWith('user-sam', true);

    await fireEvent.press(screen.getByRole('button', { name: 'group.memberBlock Sam Stranger' }));
    expect(mockWorkspace.setPersonBlocked).toHaveBeenCalledWith('user-sam', true);

    // Reporting is reachable from the conversation the person is in, which is
    // where a reviewer looks for it; the form itself stays in Contacts rather
    // than being carried a second time by the chat.
    mockRouter.push.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberReport Sam Stranger' }));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/people', params: { report: 'user-sam' },
    });
    // It closes behind itself, so returning does not land back on the sheet.
    await waitFor(() => expect(
      screen.queryByRole('button', { name: 'group.memberBlock Sam Stranger' }),
    ).toBeNull());
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberActions Sam Stranger' }));

    await fireEvent.press(screen.getByRole('button', { name: 'group.memberRemove Sam Stranger' }));
    await waitFor(() => expect(mockWorkspace.removeConversationMember)
      .toHaveBeenCalledWith('conversation-group', 'user-sam'));
    // Removing closes the row it was opened from.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'group.memberMute Sam Stranger' })).toBeNull());
  });

  test('an already connected member is not offered a friend request', async () => {
    await render(<GroupMembersSection conversation={group()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberActions Ana Friend' }));
    expect(screen.queryByRole('button', { name: 'group.memberAddFriend Ana Friend' })).toBeNull();
    expect(screen.getByRole('button', { name: 'group.memberMute Ana Friend' })).toBeTruthy();
  });

  test('a plain member cannot remove anyone', async () => {
    await render(<GroupMembersSection conversation={group({ myRole: 'member' })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberActions Ana Friend' }));
    expect(screen.queryByRole('button', { name: 'group.memberRemove Ana Friend' })).toBeNull();
    expect(screen.getByRole('button', { name: 'group.memberBlock Ana Friend' })).toBeTruthy();
  });

  test('mute and block read back from the row, and reverse', async () => {
    mockWorkspace = workspaceWith({
      people: [self, person({ mutedByMe: true, blockedByMe: true })],
    });
    await render(<GroupMembersSection conversation={group({
      memberIds: ['user-self', 'user-ana'],
      memberRoles: { 'user-self': 'owner', 'user-ana': 'member' },
    })} />);
    expect(screen.getByText('@ana_friend · group.memberMuted · group.memberBlocked')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberActions Ana Friend' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberUnmute Ana Friend' }));
    expect(mockWorkspace.setPersonMuted).toHaveBeenCalledWith('user-ana', false);
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberUnblock Ana Friend' }));
    expect(mockWorkspace.setPersonBlocked).toHaveBeenCalledWith('user-ana', false);
  });

  test('a one-to-one chat has no members section at all', async () => {
    const view = await render(<GroupMembersSection conversation={group({ kind: 'direct' })} />);
    expect(view.toJSON()).toBeNull();
  });

  test('a host can take over where Message lands', async () => {
    const onOpenConversation = jest.fn();
    await render(
      <GroupMembersSection conversation={group()} onOpenConversation={onOpenConversation} />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberActions Ana Friend' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.memberMessage Ana Friend' }));
    await waitFor(() => expect(onOpenConversation).toHaveBeenCalledWith('conversation-direct'));
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});

