import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import PeopleScreen from '@/app/people';
import { PERSONAL_REALM_ORGANIZATION_ID, isPersonalRealm } from '@/constants/personal-realm';

jest.setTimeout(20_000);

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
};

let mockWidth = 1280;
let mockWorkspace: Record<string, any>;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: ({ children, ...props }: { children: ReactNode }) => (
      <ReactNative.View {...props}>{children}</ReactNative.View>
    ),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

jest.mock('@/hooks/use-hydration-safe-window-dimensions', () => ({
  useHydrationSafeWindowDimensions: () => ({ width: mockWidth, height: 900 }),
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

const self = {
  id: 'user-self',
  membershipId: 'membership-self',
  displayName: 'Jordan Lee',
  initials: 'JL',
  avatarColor: '#123456',
  roleLabel: 'Member',
  role: 'employee',
  site: 'Company-wide',
  department: 'General',
  preferredLanguage: 'en',
  presence: 'online',
  connectionState: 'self',
};

function person(overrides: Record<string, unknown>) {
  return {
    id: 'user-person',
    membershipId: 'membership-person',
    displayName: 'Taylor Person',
    initials: 'TP',
    avatarColor: '#654321',
    roleLabel: 'Technician',
    role: 'employee',
    site: 'Denver',
    department: 'Maintenance',
    preferredLanguage: 'en',
    presence: 'offline',
    connectionState: 'available',
    ...overrides,
  };
}

function searchResult(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-stranger',
    username: 'sam_stranger',
    displayName: 'Sam Stranger',
    avatarPath: null,
    connectionState: 'none',
    ...overrides,
  };
}

function baseWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    actionBusy: null,
    actionError: null,
    capabilities: [],
    connectivity: 'online',
    conversations: [],
    currentUser: self,
    failedOutboxCount: 0,
    handoffs: [],
    messages: {},
    offlineQueueAvailable: true,
    organizationId: PERSONAL_REALM_ORGANIZATION_ID,
    outboxCount: 0,
    people: [self],
    realtimeState: 'subscribed',
    status: 'ready',
    units: [],
    updates: [],
    clearActionError: jest.fn(),
    hasCapability: jest.fn(() => false),
    refresh: jest.fn(async () => undefined),
    searchUsers: jest.fn(async (..._mockArgs: unknown[]) => [] as unknown[]),
    sendMessageRequest: jest.fn(
      async (..._mockArgs: unknown[]) => 'conversation-request' as string | null,
    ),
    openOrCreateDirectConversation: jest.fn(async (..._mockArgs: unknown[]) => 'conversation-direct'),
    updateConnection: jest.fn(async (..._mockArgs: unknown[]) => true),
    respondConnection: jest.fn(async (..._mockArgs: unknown[]) => true),
    removeConnection: jest.fn(async (..._mockArgs: unknown[]) => true),
    saveContact: jest.fn(async (..._mockArgs: unknown[]) => true),
    removeSavedContact: jest.fn(async (..._mockArgs: unknown[]) => true),
    setPersonBlocked: jest.fn(async (..._mockArgs: unknown[]) => true),
    reportMember: jest.fn(async (..._mockArgs: unknown[]) => true),
    ...overrides,
  };
}

beforeEach(() => {
  mockWidth = 1280;
  mockWorkspace = baseWorkspace();
});

describe('personal-realm username discovery on the people screen', () => {
  test('debounces lowercase-normalized queries and drives every connection-state action on desktop', async () => {
    mockWorkspace.searchUsers.mockResolvedValue([
      searchResult(),
      searchResult({
        userId: 'user-ivy', username: 'ivy_incoming', displayName: 'Ivy Incoming',
        connectionState: 'pending_incoming',
      }),
      searchResult({
        userId: 'user-iris', username: 'iris_incoming', displayName: 'Iris Incoming',
        connectionState: 'pending_incoming',
      }),
      searchResult({
        userId: 'user-oscar', username: 'oscar_outgoing', displayName: 'Oscar Outgoing',
        connectionState: 'pending_outgoing', avatarPath: 'avatars/oscar.jpg',
      }),
      searchResult({
        userId: 'user-ana', username: 'ana_accepted', displayName: null,
        connectionState: 'accepted',
      }),
    ]);
    const view = await render(<PeopleScreen />);

    // The consumer realm keeps the search surface even with a self-only directory.
    expect(isPersonalRealm(mockWorkspace.organizationId)).toBe(true);
    expect(screen.getByText('people.usernameSearchTitle')).toBeTruthy();
    expect(screen.getByText('people.usernameSearchHint')).toBeTruthy();
    expect(screen.getByText('status.emptyPeople')).toBeTruthy();

    const input = screen.getByLabelText('people.usernameSearch');
    await fireEvent.changeText(input, 'S');
    await fireEvent.changeText(input, 'SA');
    await fireEvent.changeText(input, 'SAM');
    await waitFor(() => expect(mockWorkspace.searchUsers).toHaveBeenCalledTimes(1));
    expect(mockWorkspace.searchUsers).toHaveBeenCalledWith('sam');

    await waitFor(() => expect(screen.getByText('Sam Stranger')).toBeTruthy());
    expect(screen.getByText('@sam_stranger')).toBeTruthy();
    // A null display name falls back to the username.
    expect(screen.getByText('ana_accepted')).toBeTruthy();

    // 'none' state offers a message request plus connect; compose then navigate.
    await fireEvent.press(screen.getByRole('button', { name: 'people.sendMessageRequest' }));
    expect(screen.getByText('people.messageRequestTitle · Sam Stranger')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('people.messageRequestLabel'), '  Hi Sam!  ');
    await fireEvent.press(screen.getByRole('button', { name: 'people.messageRequestSend' }));
    await waitFor(() => expect(mockWorkspace.sendMessageRequest).toHaveBeenCalledWith(
      'user-stranger', '  Hi Sam!  ', 'Sam Stranger',
    ));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'people.cancelRequest' })).toHaveLength(2));

    // pending_incoming exposes the existing accept and decline responses.
    await fireEvent.press(screen.getAllByRole('button', { name: 'people.accept' })[0]!);
    await waitFor(() =>
      expect(mockWorkspace.respondConnection).toHaveBeenCalledWith('user-ivy', 'accepted'));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'people.message' })).toHaveLength(2));

    await fireEvent.press(screen.getByRole('button', { name: 'people.decline' }));
    await waitFor(() =>
      expect(mockWorkspace.respondConnection).toHaveBeenCalledWith('user-iris', 'declined'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'people.sendMessageRequest' })).toBeTruthy());

    // pending_outgoing cancels through the existing connection removal.
    await fireEvent.press(screen.getAllByRole('button', { name: 'people.cancelRequest' })[1]!);
    await waitFor(() => expect(mockWorkspace.removeConnection).toHaveBeenCalledWith('user-oscar'));

    // Connect on a search result reaches updateConnection with the user's UUID.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'people.connect' })).toHaveLength(2));
    await fireEvent.press(screen.getAllByRole('button', { name: 'people.connect' })[0]!);
    await waitFor(() => expect(mockWorkspace.updateConnection).toHaveBeenCalledWith('user-iris'));

    // accepted results reuse the existing message action.
    await fireEvent.press(screen.getAllByRole('button', { name: 'people.message' })[0]!);
    await waitFor(() =>
      expect(mockWorkspace.openOrCreateDirectConversation).toHaveBeenCalledWith('user-ivy'));
    await view.unmount();
  });

  test('enforces the minimum query, renders empty results, retries a failed send, and routes on mobile', async () => {
    mockWidth = 390;
    mockWorkspace.searchUsers
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([searchResult()]);
    mockWorkspace.sendMessageRequest.mockResolvedValueOnce(null);
    const view = await render(<PeopleScreen />);

    const input = screen.getByLabelText('people.usernameSearch');
    await fireEvent.changeText(input, 'z');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockWorkspace.searchUsers).not.toHaveBeenCalled();

    await fireEvent.changeText(input, 'zz');
    await waitFor(() => expect(screen.getByText('people.usernameNoResults')).toBeTruthy());

    await fireEvent.changeText(input, 'sam');
    await waitFor(() => expect(screen.getByText('Sam Stranger')).toBeTruthy());
    expect(screen.queryByText('people.usernameNoResults')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'people.sendMessageRequest' }));
    await fireEvent.changeText(screen.getByLabelText('people.messageRequestLabel'), 'Hello Sam');
    await fireEvent.press(screen.getByRole('button', { name: 'people.messageRequestSend' }));
    await waitFor(() => expect(mockWorkspace.sendMessageRequest).toHaveBeenCalledTimes(1));
    // A rejected request keeps the compose modal open without navigating.
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(screen.getByText('people.messageRequestTitle · Sam Stranger')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'people.messageRequestSend' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-request' },
    }));

    // A response for a superseded query is discarded.
    let resolveSearch!: (value: unknown) => void;
    mockWorkspace.searchUsers.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSearch = resolve; }),
    );
    await fireEvent.changeText(input, 'stale');
    await waitFor(() => expect(mockWorkspace.searchUsers).toHaveBeenCalledWith('stale'));
    await fireEvent.changeText(input, '');
    resolveSearch([searchResult({ userId: 'user-stale', username: 'stale_user', displayName: 'Stale User' })]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Stale User')).toBeNull();
    await view.unmount();
  });

  test('keeps workspace organizations on the untouched directory surface', async () => {
    mockWorkspace = baseWorkspace({
      organizationId: 'organization-a',
      people: [self, person({ id: 'user-avail', displayName: 'Avery Available' })],
    });
    const view = await render(<PeopleScreen />);
    expect(screen.queryByText('people.usernameSearchTitle')).toBeNull();
    expect(screen.queryByLabelText('people.usernameSearch')).toBeNull();
    expect(screen.getByText('Avery Available')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'people.connect' }));
    await waitFor(() => expect(mockWorkspace.updateConnection).toHaveBeenCalledWith('user-avail'));
    expect(mockWorkspace.searchUsers).not.toHaveBeenCalled();
    expect(screen.getAllByLabelText('people.manage').length).toBeGreaterThan(0);
    await view.unmount();

    // A workspace org with a self-only directory keeps the existing state panel.
    mockWorkspace = baseWorkspace({ organizationId: 'organization-a' });
    const emptyView = await render(<PeopleScreen />);
    expect(screen.queryByLabelText('people.usernameSearch')).toBeNull();
    expect(screen.queryByLabelText('people.search')).toBeNull();
    await emptyView.unmount();
  });
});
