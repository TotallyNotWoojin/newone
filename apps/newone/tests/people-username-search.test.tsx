import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
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

// The test renderer exposes host elements only, so the keyboard-avoiding
// surface records its behavior on a host view for assertions.
jest.mock('react-native', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  const KeyboardSurface = ({ behavior, children, style }: {
    behavior?: string;
    children?: ReactNode;
    style?: unknown;
  }) => (
    <ReactNative.View style={style as undefined} testID={`controlled-keyboard-surface:${behavior ?? 'none'}`}>
      {children}
    </ReactNative.View>
  );
  return new Proxy(ReactNative, {
    get(target, property, receiver) {
      if (property === 'KeyboardAvoidingView') return KeyboardSurface;
      return Reflect.get(target, property, receiver);
    },
  });
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
    openOrCreateDirectConversation: jest.fn(
      async (..._mockArgs: unknown[]) => 'conversation-direct' as string | null,
    ),
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

describe('personal-realm people search', () => {
  test('debounces queries as typed, lists compact rows with handles, and opens a chat with anyone on desktop', async () => {
    mockWorkspace.searchUsers.mockResolvedValue([
      searchResult(),
      searchResult({
        userId: 'user-ivy', username: 'ivy_incoming', displayName: 'Ivy Incoming',
        connectionState: 'pending_incoming',
      }),
      searchResult({
        userId: 'user-ana', username: 'ana_accepted', displayName: null,
        connectionState: 'accepted',
      }),
    ]);
    const view = await render(<PeopleScreen />);

    expect(isPersonalRealm(mockWorkspace.organizationId)).toBe(true);
    // No explanatory chrome: the search field stands alone above the list.
    expect(screen.queryByText('people.descriptionConsumer')).toBeNull();
    expect(screen.queryByText('people.heading')).toBeNull();
    expect(screen.getByText('people.emptyConsumer')).toBeTruthy();
    expect(screen.getByText('people.emptyConsumerBody')).toBeTruthy();
    expect(screen.queryByText('status.emptyPeople')).toBeNull();

    const input = screen.getByLabelText('people.usernameSearch');
    await fireEvent.changeText(input, 'S');
    await fireEvent.changeText(input, 'SA');
    await fireEvent.changeText(input, 'SAM');
    await waitFor(() => expect(mockWorkspace.searchUsers).toHaveBeenCalledTimes(1));
    // The query reaches the service exactly as typed: matching is
    // case-insensitive server-side and also covers display names.
    expect(mockWorkspace.searchUsers).toHaveBeenCalledWith('SAM');

    await waitFor(() => expect(screen.getByText('Sam Stranger')).toBeTruthy());
    expect(screen.getByText('@sam_stranger')).toBeTruthy();
    // A null display name falls back to the username.
    expect(screen.getByText('ana_accepted')).toBeTruthy();
    // While a search is active the known-people list steps aside.
    expect(screen.queryByText('people.eyebrowConsumer')).toBeNull();
    // Every result carries the same single action, whatever its connection
    // state: strangers, pending requests and friends alike.
    expect(screen.getAllByRole('button', { name: 'people.message' })).toHaveLength(3);
    for (const gone of [
      'people.connect', 'people.accept', 'people.decline', 'people.cancelRequest',
    ]) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }

    await fireEvent.press(screen.getAllByRole('button', { name: 'people.message' })[0]!);
    await waitFor(() => expect(mockWorkspace.openOrCreateDirectConversation).toHaveBeenCalledWith(
      'user-stranger', { displayName: 'Sam Stranger', username: 'sam_stranger' },
    ));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    // The hint falls back to the handle when there is no display name.
    await fireEvent.press(screen.getAllByRole('button', { name: 'people.message' })[2]!);
    await waitFor(() => expect(mockWorkspace.openOrCreateDirectConversation).toHaveBeenCalledWith(
      'user-ana', { displayName: 'ana_accepted', username: 'ana_accepted' },
    ));
    await view.unmount();
  });

  test('enforces the minimum query, renders empty results, ignores stale responses, and routes on mobile', async () => {
    mockWidth = 390;
    mockWorkspace.searchUsers
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([searchResult()]);
    mockWorkspace.openOrCreateDirectConversation.mockResolvedValueOnce(null);
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

    // A refused open (blocked, offline) stays on the screen without navigating.
    await fireEvent.press(screen.getByRole('button', { name: 'people.message' }));
    await waitFor(() => expect(mockWorkspace.openOrCreateDirectConversation).toHaveBeenCalledTimes(1));
    expect(mockRouter.push).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'people.message' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-direct' },
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
    // Clearing the query brings the known-people list back.
    expect(screen.getByText('people.emptyConsumer')).toBeTruthy();
    await view.unmount();
  });

  test('keeps the search and its first results above the iOS keyboard on a 390-wide device', async () => {
    mockWidth = 390;
    mockWorkspace.searchUsers.mockResolvedValue([searchResult()]);
    const view = await render(<PeopleScreen />);
    const input = screen.getByLabelText('people.usernameSearch');
    const surface = screen.getAllByTestId(/^controlled-keyboard-surface:/)
      .find((instance) => within(instance).queryByLabelText('people.usernameSearch'));
    expect(surface).toBeDefined();
    // iOS pads the surface by the keyboard height; the scroll surface keeps
    // result taps alive and lets a drag dismiss the keyboard interactively.
    expect(surface!.props.testID).toBe('controlled-keyboard-surface:padding');
    const scroll = surface!.queryAll((instance) => instance.props.keyboardShouldPersistTaps === 'handled')[0];
    expect(scroll).toBeDefined();
    expect(scroll!.props.keyboardDismissMode).toBe('interactive');
    expect(within(scroll!).getByLabelText('people.usernameSearch')).toBeTruthy();

    await fireEvent.changeText(input, 'sam');
    await waitFor(() => expect(screen.getByText('Sam Stranger')).toBeTruthy());
    // The first result renders inside the same keyboard-aware surface as the field.
    expect(within(surface!).getByText('Sam Stranger')).toBeTruthy();
    await view.unmount();
  });

  test('offers the manage sheet on a search result the directory already knows', async () => {
    const known = person({
      id: 'user-stranger', displayName: 'Sam Stranger', username: 'sam_stranger',
      site: '', department: '', blockedByMe: true,
    });
    mockWorkspace = baseWorkspace({ people: [self, known] });
    mockWorkspace.searchUsers.mockResolvedValue([searchResult()]);
    const view = await render(<PeopleScreen />);
    await fireEvent.changeText(screen.getByLabelText('people.usernameSearch'), 'sam');
    await waitFor(() => expect(screen.getByText('Sam Stranger')).toBeTruthy());
    // The directory's block state wins over the raw result: no Message button,
    // the badge instead, and the manage control leads to Unblock.
    expect(screen.queryByRole('button', { name: 'people.message' })).toBeNull();
    expect(screen.getByText('people.blocked')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('people.manage'));
    expect(screen.getByText('people.manageTitle · Sam Stranger')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'people.unblock' }));
    await waitFor(() => expect(mockWorkspace.setPersonBlocked).toHaveBeenCalledWith('user-stranger', false));
    await view.unmount();
  });

  test('keeps workspace organizations on the untouched directory surface', async () => {
    mockWorkspace = baseWorkspace({
      organizationId: 'organization-a',
      people: [self, person({ id: 'user-avail', displayName: 'Avery Available' })],
    });
    const view = await render(<PeopleScreen />);
    expect(screen.queryByLabelText('people.usernameSearch')).toBeNull();
    expect(screen.getByText('people.eyebrow')).toBeTruthy();
    expect(screen.getByText('people.description')).toBeTruthy();
    expect(screen.getByText('Avery Available')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'people.connect' }));
    await waitFor(() => expect(mockWorkspace.updateConnection).toHaveBeenCalledWith('user-avail'));
    expect(mockWorkspace.searchUsers).not.toHaveBeenCalled();
    expect(screen.getAllByLabelText('people.manage').length).toBeGreaterThan(0);
    await fireEvent.press(screen.getAllByLabelText('people.manage')[0]!);
    expect(screen.getByText('people.manageDescription')).toBeTruthy();
    expect(screen.getByText('people.blockNotice')).toBeTruthy();
    await view.unmount();

    // A workspace org with a self-only directory keeps the existing state panel.
    mockWorkspace = baseWorkspace({ organizationId: 'organization-a' });
    const emptyView = await render(<PeopleScreen />);
    expect(screen.queryByLabelText('people.usernameSearch')).toBeNull();
    expect(screen.queryByLabelText('people.search')).toBeNull();
    await emptyView.unmount();
  });
});

describe('personal realm known-people list', () => {
  const friend = person({
    id: 'user-friend', displayName: 'Ana Friend', username: 'ana_friend',
    connectionState: 'connected', site: '', department: '', roleLabel: 'Member',
  });
  const incoming = person({
    id: 'user-incoming', displayName: 'Ian Incoming', connectionState: 'pending',
    connectionRequestDirection: 'incoming', site: '', department: '',
  });
  const stranger = person({
    id: 'user-known-stranger', displayName: 'Sam Available', username: 'sam_available',
    site: '', department: '',
  });
  const blocked = person({ id: 'user-blocked', displayName: 'Bailey Blocked', blockedByMe: true });

  test('lists everyone known with one Message action each, whatever the connection state, on desktop', async () => {
    mockWorkspace = baseWorkspace({ people: [self, friend, incoming, stranger, blocked] });
    const view = await render(<PeopleScreen />);

    expect(screen.getByText('people.eyebrowConsumer')).toBeTruthy();
    for (const name of ['Ana Friend', 'Ian Incoming', 'Sam Available', 'Bailey Blocked']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.getByText('@ana_friend')).toBeTruthy();
    expect(screen.getByText('@sam_available')).toBeTruthy();
    expect(screen.queryByText('Jordan Lee')).toBeNull();
    // Requests, connections, and the workplace directory chrome are gone.
    for (const absent of [
      'people.eyebrow', 'people.description',
      'people.directory', 'people.safeFields', 'status.emptyPeople', 'status.emptyPeopleBody',
    ]) {
      expect(screen.queryByText(absent)).toBeNull();
    }
    for (const gone of [
      'people.accept', 'people.decline', 'people.cancelRequest', 'people.connect', 'people.removeConnection',
    ]) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
    expect(screen.queryByLabelText('people.search')).toBeNull();
    // A blocked person keeps only the manage control; Unblock lives there.
    expect(screen.getAllByRole('button', { name: 'people.message' })).toHaveLength(3);
    expect(screen.getByText('people.blocked')).toBeTruthy();

    await fireEvent.press(screen.getAllByRole('button', { name: 'people.message' })[1]!);
    await waitFor(() =>
      expect(mockWorkspace.openOrCreateDirectConversation).toHaveBeenCalledWith('user-incoming'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');

    await fireEvent.press(screen.getAllByLabelText('people.manage')[3]!);
    expect(screen.getByText('people.manageTitle · Bailey Blocked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'people.unblock' })).toBeTruthy();
    // No privacy lecture in the consumer manage sheet.
    expect(screen.queryByText('people.blockNotice')).toBeNull();
    expect(screen.queryByText('people.blockNoticeConsumer')).toBeNull();
    expect(screen.queryByText('people.manageDescription')).toBeNull();
    await view.unmount();
  });

  test('keeps the mobile header consumer-flavored and empties gracefully', async () => {
    mockWidth = 390;
    mockWorkspace = baseWorkspace({ people: [self, friend] });
    const view = await render(<PeopleScreen />);
    expect(screen.getByText('people.subtitleConsumer')).toBeTruthy();
    expect(screen.queryByText('people.subtitle')).toBeNull();
    expect(screen.queryByText('people.eyebrowConsumer')).toBeTruthy();
    expect(screen.getByText('Ana Friend')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'people.message' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-direct' },
    }));
    await view.unmount();

    // A consumer who knows nobody yet sees the one-line invitation to search.
    mockWorkspace = baseWorkspace();
    const alone = await render(<PeopleScreen />);
    expect(screen.getByText('people.emptyConsumer')).toBeTruthy();
    expect(screen.getByText('people.emptyConsumerBody')).toBeTruthy();
    expect(screen.queryByText('status.emptyPeople')).toBeNull();
    await alone.unmount();
  });
});
