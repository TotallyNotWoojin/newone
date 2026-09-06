import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import SearchScreen from '@/app/search';
import { PERSONAL_REALM_ORGANIZATION_ID } from '@/constants/personal-realm';
import { RepositoryError } from '@/data/repositories/contracts';
import { searchCopy } from '@/features/search/search-copy';

jest.setTimeout(20_000);

const copy = searchCopy('en');
const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockWidth = 1280;
let mockWorkspace: Record<string, any>;
let mockSearch: jest.Mock<(..._args: unknown[]) => Promise<any>>;
let mockSearchRepositoryContext: { getSession: () => Promise<unknown> };
let mockSupabaseClient: { auth: { getSession: () => Promise<unknown> } } | null;

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
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
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));
jest.mock('@/data/repositories/bff-search-repository', () => ({
  BffSearchRepository: jest.fn().mockImplementation((context: unknown) => {
    mockSearchRepositoryContext = context as { getSession: () => Promise<unknown> };
    return { search: (...mockArgs: unknown[]) => mockSearch(...mockArgs) };
  }),
}));
jest.mock('@/lib/supabase', () => ({ getSupabaseClient: () => mockSupabaseClient }));

function result(overrides: Record<string, unknown>) {
  return {
    type: 'messages',
    id: '101',
    title: 'Message result',
    snippet: 'Matched message text.',
    conversationId: 'conversation-main',
    occurredAt: '2026-08-04T18:00:00.000Z',
    matchedSource: 'translation',
    matchedLanguage: 'es',
    ...overrides,
  };
}

const firstPage = {
  results: [
    result({}),
    result({ type: 'conversations', id: 'conversation-main', title: 'Conversation result', matchedSource: 'conversation', matchedLanguage: null, occurredAt: '2026-08-04T17:00:00.000Z' }),
    result({ type: 'people', id: 'person-result', title: 'Person result', conversationId: null, matchedSource: 'profile', matchedLanguage: null, occurredAt: '2026-08-04T16:00:00.000Z' }),
    result({ type: 'announcements', id: 'announcement-result', title: 'Announcement result', matchedSource: 'announcement', matchedLanguage: null, occurredAt: '2026-08-04T15:00:00.000Z' }),
    result({ type: 'handoffs', id: 'handoff-result', title: 'Handoff result', snippet: null, matchedSource: 'handoff', matchedLanguage: null, occurredAt: '2026-08-04T14:00:00.000Z' }),
    result({ id: '999', title: 'Management-only leak', conversationId: 'conversation-management', matchedSource: 'original', matchedLanguage: 'en', occurredAt: '2026-08-04T13:00:00.000Z' }),
  ],
  nextCursor: 'controlled.cursor',
  hasMore: true,
};

function workspace() {
  return {
    capabilities: [],
    conversations: [
      { id: 'conversation-main', title: 'Plant Operations', managementOnly: false, unreadCount: 0 },
      { id: 'conversation-management', title: 'Management', managementOnly: true, unreadCount: 0 },
    ],
    currentUser: null,
    organizationId: 'organization-a',
    people: [
      { id: 'membership-self', displayName: 'Jordan Lee', suspended: false, roleLabel: 'Supervisor', preferredLanguage: 'en' },
      { id: 'membership-ana', displayName: 'Ana Torres', suspended: false, roleLabel: 'Operator', preferredLanguage: 'es' },
      { id: 'membership-suspended', displayName: 'Suspended User', suspended: true, roleLabel: 'Operator', preferredLanguage: 'en' },
    ],
    updates: [],
    selectConversation: jest.fn(),
  };
}

beforeEach(() => {
  mockWidth = 1280;
  mockSupabaseClient = null;
  mockWorkspace = workspace();
  mockSearch = jest.fn<(..._args: unknown[]) => Promise<any>>()
    .mockResolvedValueOnce(firstPage)
    .mockResolvedValueOnce({
      results: [
        result({}),
        result({ id: '102', title: 'Second page message', matchedSource: 'attachment_filename', matchedLanguage: 'en', occurredAt: '2026-08-04T12:00:00.000Z' }),
      ],
      nextCursor: null,
      hasMore: false,
    });
});

describe('authorized workspace search screen', () => {
  test('keeps the query field above the iOS keyboard on a 390-wide device', async () => {
    mockWidth = 390;
    const view = await render(<SearchScreen />);
    const surface = screen.getAllByTestId(/^controlled-keyboard-surface:/)
      .find((instance) => within(instance).queryByLabelText('search.placeholder'));
    expect(surface).toBeDefined();
    expect(surface!.props.testID).toBe('controlled-keyboard-surface:padding');
    const scroll = surface!.queryAll((instance) => instance.props.keyboardShouldPersistTaps === 'handled')[0];
    expect(scroll).toBeDefined();
    expect(scroll!.props.keyboardDismissMode).toBe('interactive');
    expect(within(scroll!).getByLabelText('search.placeholder')).toBeTruthy();
    view.unmount();
  });

  test('applies server filters, paginates without duplicates, suppresses management-only results, and routes every result type', async () => {
    const view = await render(<SearchScreen />);
    expect(screen.getByText('search.privateTitle')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suspended User' })).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'search.people' }));
    await fireEvent.press(screen.getByRole('button', { name: 'search.messages' }));
    await fireEvent.press(screen.getByRole('button', { name: copy.anyConversation }));
    await fireEvent.press(screen.getByRole('button', { name: copy.anyLanguage }));
    await fireEvent.press(screen.getByRole('button', { name: copy.anyMessageField }));
    await fireEvent.press(screen.getByRole('button', { name: copy.anySender }));

    await fireEvent.changeText(screen.getByLabelText('search.placeholder'), 'pump safety');
    await fireEvent.press(screen.getByRole('button', { name: copy.sourceLabels.translation }));
    await fireEvent.press(screen.getByRole('button', { name: 'Ana Torres' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Plant Operations' }));
    await fireEvent.press(screen.getByRole('button', { name: copy.languageLabels.es }));
    await fireEvent.changeText(screen.getByLabelText(copy.fromDate), '2026-08-01');
    await fireEvent.changeText(screen.getByLabelText(copy.toDate), '2026-08-04');
    expect(screen.getByText(copy.messageFilterNotice)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'search.submit' }));

    await waitFor(() => expect(screen.getByText('Message result')).toBeTruthy());
    expect(mockSearch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      organizationId: 'organization-a',
      query: 'pump safety',
      types: ['messages'],
      cursor: null,
      senderMembershipId: 'membership-ana',
      matchSources: ['translation'],
      conversationId: 'conversation-main',
      language: 'es',
      dateFrom: expect.any(String),
      dateTo: expect.any(String),
    }));
    expect(screen.queryByText('Management-only leak')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'search.loadMore' }));
    await waitFor(() => expect(screen.getByText('Second page message')).toBeTruthy());
    expect(screen.getAllByText('Message result')).toHaveLength(1);
    expect(mockSearch).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'controlled.cursor' }));

    await fireEvent.press(screen.getByRole('button', { name: copy.openResult('Message result') }));
    expect(mockWorkspace.selectConversation).toHaveBeenCalledWith('conversation-main');
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]', params: { id: 'conversation-main', messageId: '101' },
    });
    await fireEvent.press(screen.getByRole('button', { name: copy.openResult('Conversation result') }));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]', params: { id: 'conversation-main' },
    });
    await fireEvent.press(screen.getByRole('button', { name: copy.openResult('Person result') }));
    await fireEvent.press(screen.getByRole('button', { name: copy.openResult('Announcement result') }));
    await fireEvent.press(screen.getByRole('button', { name: copy.openResult('Handoff result') }));
    expect(mockRouter.replace.mock.calls.slice(-3)).toEqual([['/people'], ['/updates'], ['/handoffs']]);

    await fireEvent.press(screen.getByRole('button', { name: copy.clearFilters }));
    expect(screen.queryByRole('button', { name: copy.clearFilters })).toBeNull();
    await view.unmount();
  });

  test('validates query and calendar ranges locally, then maps repository failures to localized stable copy', async () => {
    mockSearch = jest.fn<(..._args: unknown[]) => Promise<any>>()
      .mockRejectedValue(new RepositoryError('raw upstream detail', 'network_unavailable', true));
    const view = await render(<SearchScreen />);
    await fireEvent.changeText(screen.getByLabelText('search.placeholder'), 'x');
    await fireEvent.press(screen.getByRole('button', { name: 'search.submit' }));
    expect(screen.getByText('search.validation')).toBeTruthy();
    expect(mockSearch).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText('search.placeholder'), 'valid query');
    await fireEvent.changeText(screen.getByLabelText(copy.fromDate), 'not-a-date');
    await fireEvent.press(screen.getByRole('button', { name: 'search.submit' }));
    expect(screen.getByText(copy.invalidDate)).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText(copy.fromDate), '2026-08-04');
    await fireEvent.changeText(screen.getByLabelText(copy.toDate), '2026-08-01');
    await fireEvent.press(screen.getByRole('button', { name: 'search.submit' }));
    expect(screen.getByText(copy.invalidDateRange)).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText(copy.fromDate), '2000-08-01');
    await fireEvent.changeText(screen.getByLabelText(copy.toDate), '2026-08-01');
    await fireEvent.press(screen.getByRole('button', { name: 'search.submit' }));
    expect(screen.getByText(copy.invalidDateRange)).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText(copy.fromDate), '2026-08-04');
    await fireEvent.changeText(screen.getByLabelText(copy.toDate), '2026-08-05');
    await fireEvent.press(screen.getByRole('button', { name: 'search.submit' }));
    await waitFor(() => expect(screen.getByText('errors.network')).toBeTruthy());
    expect(screen.queryByText('raw upstream detail')).toBeNull();
    await view.unmount();
  });

  test('invalidates in-flight results immediately when conversation authorization changes', async () => {
    let resolveSearch!: (value: unknown) => void;
    mockSearch = jest.fn(() => new Promise((resolve) => { resolveSearch = resolve; }));
    const view = await render(<SearchScreen />);
    await fireEvent.changeText(screen.getByLabelText('search.placeholder'), 'pump safety');
    await fireEvent.press(screen.getByRole('button', { name: 'search.submit' }));
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(1));

    mockWorkspace = {
      ...mockWorkspace,
      conversations: mockWorkspace.conversations.map((conversation: Record<string, unknown>) => (
        conversation.id === 'conversation-main' ? { ...conversation, managementOnly: true } : conversation
      )),
    };
    await view.rerender(<SearchScreen />);
    resolveSearch({ ...firstPage, nextCursor: null, hasMore: false });
    await waitFor(() => expect(screen.getByText('search.privateTitle')).toBeTruthy());
    expect(screen.queryByText('Message result')).toBeNull();
    await view.unmount();
  });

  test('supports mobile submit editing, empty results, and non-repository failures', async () => {
    mockWidth = 390;
    mockWorkspace = {
      ...workspace(),
      conversations: [{
        id: 'conversation-main', title: 'Plant Operations', managementOnly: false, unreadCount: 0,
      }],
    };
    mockSearch = jest.fn<(..._args: unknown[]) => Promise<any>>().mockResolvedValue({
      results: [], nextCursor: null, hasMore: false,
    });
    const emptyView = await render(<SearchScreen />);
    expect(screen.queryByText('search.heading')).toBeNull();
    await expect(mockSearchRepositoryContext.getSession()).resolves.toBeNull();
    const controlledSession = { access_token: 'controlled-access-token' };
    mockSupabaseClient = {
      auth: { getSession: async () => ({ data: { session: controlledSession } }) },
    };
    await expect(mockSearchRepositoryContext.getSession()).resolves.toBe(controlledSession);
    await fireEvent.changeText(screen.getByLabelText('search.placeholder'), 'mobile query');
    await fireEvent(screen.getByLabelText('search.placeholder'), 'submitEditing');
    await waitFor(() => expect(screen.getByText('search.empty')).toBeTruthy());
    await emptyView.unmount();

    mockSearch = jest.fn<(..._args: unknown[]) => Promise<any>>()
      .mockRejectedValue(new TypeError('controlled non-repository failure'));
    const errorView = await render(<SearchScreen />);
    await fireEvent.changeText(screen.getByLabelText('search.placeholder'), 'generic failure');
    await fireEvent.press(screen.getByRole('button', { name: 'search.submit' }));
    await waitFor(() => expect(screen.getByText('search.error')).toBeTruthy());
    await errorView.unmount();
  });
});

describe('personal realm search', () => {
  const people = [
    {
      userId: 'user-sam', username: 'sam_stranger', displayName: 'Sam Stranger',
      avatarPath: null, connectionState: 'none',
    },
    {
      userId: 'user-ana', username: 'ana_accepted', displayName: null,
      avatarPath: null, connectionState: 'accepted',
    },
  ];
  function consumerWorkspace(overrides: Record<string, unknown> = {}) {
    return {
      ...workspace(),
      organizationId: PERSONAL_REALM_ORGANIZATION_ID,
      searchUsers: jest.fn(async (..._mockArgs: unknown[]) => people as unknown[]),
      openOrCreateDirectConversation: jest.fn(
        async (..._mockArgs: unknown[]) => 'conversation-direct' as string | null,
      ),
      ...overrides,
    };
  }

  test('searches people and messages as you type, lists people first, and opens a chat from a result on desktop', async () => {
    mockWorkspace = consumerWorkspace();
    const view = await render(<SearchScreen />);
    // Compact consumer surface: no page header, no filter panel, no submit
    // button; one line says what to type.
    expect(screen.queryByText('search.heading')).toBeNull();
    expect(screen.queryByLabelText(copy.filters)).toBeNull();
    expect(screen.queryByRole('button', { name: 'search.submit' })).toBeNull();
    expect(screen.getByText('search.startHint')).toBeTruthy();
    expect(screen.queryByText('search.privateTitle')).toBeNull();

    const input = screen.getByLabelText('search.placeholderPeopleMessages');
    await fireEvent.changeText(input, 'S');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(mockWorkspace.searchUsers).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();

    await fireEvent.changeText(input, 'Sa');
    await fireEvent.changeText(input, 'Sam');
    await waitFor(() => expect(screen.getByText('Sam Stranger')).toBeTruthy());
    expect(mockWorkspace.searchUsers).toHaveBeenCalledTimes(1);
    expect(mockWorkspace.searchUsers).toHaveBeenCalledWith('Sam');
    expect(screen.getByText('search.people')).toBeTruthy();
    expect(screen.getByText('@sam_stranger')).toBeTruthy();
    expect(screen.getByText('ana_accepted')).toBeTruthy();
    // Messages ran once with the same query and only the consumer types.
    await waitFor(() => expect(screen.getByText('Message result')).toBeTruthy());
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: PERSONAL_REALM_ORGANIZATION_ID,
      query: 'Sam',
      types: ['conversations', 'messages'],
    }));
    // The section label is the only "Messages" text: rows carry no type
    // eyebrow and no match-source chatter.
    expect(screen.getByText('search.messages')).toBeTruthy();
    expect(screen.queryByText(copy.resultMatchLabels.translation)).toBeNull();
    expect(screen.queryByText('Management-only leak')).toBeNull();

    await fireEvent.press(screen.getAllByRole('button', { name: 'people.message' })[0]!);
    await waitFor(() => expect(mockWorkspace.openOrCreateDirectConversation).toHaveBeenCalledWith(
      'user-sam', { displayName: 'Sam Stranger', username: 'sam_stranger' },
    ));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    await view.unmount();
  });

  test('shows consumer empty states, resets on a cleared query, and routes to the chat on mobile', async () => {
    mockWidth = 390;
    mockWorkspace = consumerWorkspace({ searchUsers: jest.fn(async (..._mockArgs: unknown[]) => [] as unknown[]) });
    mockSearch = jest.fn<(..._args: unknown[]) => Promise<any>>().mockResolvedValue({
      results: [], nextCursor: null, hasMore: false,
    });
    const view = await render(<SearchScreen />);
    expect(screen.getByText('search.subtitleConsumer')).toBeTruthy();
    expect(screen.queryByText('search.subtitle')).toBeNull();

    const input = screen.getByLabelText('search.placeholderPeopleMessages');
    await fireEvent.changeText(input, 'nobody');
    await waitFor(() => expect(screen.getByText('people.usernameNoResults')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('search.noMatchesConsumer')).toBeTruthy());
    expect(screen.queryByText('search.empty')).toBeNull();
    expect(screen.queryByText('search.startHint')).toBeNull();

    // Clearing the query drops both sections and restores the hint.
    await fireEvent.changeText(input, '');
    await waitFor(() => expect(screen.getByText('search.startHint')).toBeTruthy());
    expect(screen.queryByText('people.usernameNoResults')).toBeNull();
    expect(screen.queryByText('search.noMatchesConsumer')).toBeNull();

    mockWorkspace.searchUsers.mockResolvedValue([people[0]]);
    await fireEvent.changeText(input, 'sam');
    await waitFor(() => expect(screen.getByText('Sam Stranger')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'people.message' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-direct' },
    }));
    // A refused open stays put.
    mockWorkspace.openOrCreateDirectConversation.mockResolvedValueOnce(null);
    mockRouter.push.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: 'people.message' }));
    await waitFor(() => expect(mockWorkspace.openOrCreateDirectConversation).toHaveBeenCalledTimes(2));
    expect(mockRouter.push).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('keeps workspace copy and the submit flow for organizations', async () => {
    mockWidth = 390;
    mockWorkspace = workspace();
    await render(<SearchScreen />);
    expect(screen.getByText('search.subtitle')).toBeTruthy();
    expect(screen.getByLabelText('search.placeholder')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'search.submit' })).toBeTruthy();
    expect(screen.queryByText('search.subtitleConsumer')).toBeNull();
    expect(screen.queryByText('search.startHint')).toBeNull();
  });
});
