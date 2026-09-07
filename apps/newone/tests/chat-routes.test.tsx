import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import ConversationScreen from '@/app/conversation/[id]';
import ChatsScreen from '@/app/index';
import { PERSONAL_REALM_ORGANIZATION_ID } from '@/constants/personal-realm';

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
};
let mockParams: { id?: string; messageId?: string } = {};
let mockWidth = 1280;
let mockWorkspace: Record<string, any>;
let mockConversationListProps: Record<string, any> | null = null;
let mockConversationPaneProps: Record<string, any> | null = null;
let mockConversationDetailsProps: Record<string, any> | null = null;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
  // The screen marks itself as the chat on screen while it is focused, so the
  // notification handler can stay quiet for it.
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(effect, [effect]);
  },
}));

jest.mock('@/hooks/use-hydration-safe-window-dimensions', () => ({
  useHydrationSafeWindowDimensions: () => ({ width: mockWidth, height: 900 }),
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

jest.mock('@/components/navigation/app-scaffold', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    AppScaffold: ({ children, current, hideMobileTabs, mobileHeader }: Record<string, any>) => (
      <ReactNative.View
        accessibilityLabel={`scaffold:${current}`}
        testID="controlled-app-scaffold"
        data-hide-mobile-tabs={hideMobileTabs}>
        {mobileHeader}
        {children}
      </ReactNative.View>
    ),
    MobileBrandHeader: ({ right, subtitle, title }: Record<string, any>) => (
      <ReactNative.View testID="controlled-mobile-header">
        <ReactNative.Text>{title}</ReactNative.Text>
        <ReactNative.Text>{subtitle}</ReactNative.Text>
        {right}
      </ReactNative.View>
    ),
  };
});

jest.mock('@/components/workspace/workspace-state', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    WorkspaceStatusBanner: () => <ReactNative.Text>controlled-status-banner</ReactNative.Text>,
    WorkspaceStatePanel: ({ resource }: { resource: string }) => (
      <ReactNative.Text>{`controlled-state:${resource}`}</ReactNative.Text>
    ),
  };
});

jest.mock('@/features/chat/conversation-list', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ConversationList: (props: Record<string, any>) => {
      mockConversationListProps = props;
      return (
        <ReactNative.View testID="controlled-conversation-list">
          <ReactNative.Text>{props.desktop ? 'desktop-list' : 'mobile-list'}</ReactNative.Text>
          <ReactNative.Pressable
            accessibilityLabel="controlled select conversation"
            accessibilityRole="button"
            onPress={() => props.onSelect('conversation-secondary')}
          />
          <ReactNative.Pressable
            accessibilityLabel="controlled compose"
            accessibilityRole="button"
            onPress={props.onCompose}
          />
          <ReactNative.Pressable
            accessibilityLabel="controlled open message hit"
            accessibilityRole="button"
            onPress={() => props.onOpenSuggestion({
              kind: 'message',
              key: 'message:message-secondary',
              conversationId: 'conversation-secondary',
              messageId: 'message-secondary',
              title: 'Secondary operations',
              subtitle: 'hit',
            })}
          />
          <ReactNative.Pressable
            accessibilityLabel="controlled open chat hit"
            accessibilityRole="button"
            onPress={() => props.onOpenSuggestion({
              kind: 'conversation',
              key: 'conversation:conversation-secondary',
              conversationId: 'conversation-secondary',
              title: 'Secondary operations',
              subtitle: '',
              group: true,
            })}
          />
          <ReactNative.Pressable
            accessibilityLabel="controlled open filters"
            accessibilityRole="button"
            onPress={props.onOpenAdvancedSearch}
          />
          <ReactNative.Pressable
            accessibilityLabel="controlled open pinned"
            accessibilityRole="button"
            onPress={props.onOpenPinned}
          />
          <ReactNative.Text>{`controlled-unread:${(props.markedUnreadIds ?? []).join('|')}`}</ReactNative.Text>
          {['markUnread', 'markRead', 'mute', 'unmute', 'archive', 'delete', 'leave'].map((action) => (
            <ReactNative.Pressable
              accessibilityLabel={`controlled row ${action}`}
              accessibilityRole="button"
              key={action}
              onPress={() => props.onRowAction(action, props.conversations[0])}
            />
          ))}
        </ReactNative.View>
      );
    },
  };
});

jest.mock('@/features/chat/conversation-pane', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ConversationPane: (props: Record<string, any>) => {
      mockConversationPaneProps = props;
      return (
        <ReactNative.View testID="controlled-conversation-pane">
          <ReactNative.Text>{props.conversation?.title ?? 'no-conversation'}</ReactNative.Text>
          <ReactNative.Text>{props.mobile ? 'mobile-pane' : 'desktop-pane'}</ReactNative.Text>
          {props.onBack ? (
            <ReactNative.Pressable
              accessibilityLabel="controlled conversation back"
              accessibilityRole="button"
              onPress={props.onBack}
            />
          ) : null}
          <ReactNative.Pressable
            accessibilityLabel="controlled send"
            accessibilityRole="button"
            onPress={() => props.onSend('Controlled route message', 'reply-message', ['user-mentioned'])}
          />
        </ReactNative.View>
      );
    },
  };
});

jest.mock('@/features/chat/pinned-messages', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    PinnedMessagesModal: (props: Record<string, any>) => (
      <ReactNative.View testID="controlled-pinned-sheet">
        <ReactNative.Text>{`controlled-pinned:${props.conversationId ?? 'every-chat'}`}</ReactNative.Text>
        <ReactNative.Pressable
          accessibilityLabel="controlled open pinned message"
          accessibilityRole="button"
          onPress={() => props.onOpenMessage('conversation-secondary', 'message-secondary')}
        />
      </ReactNative.View>
    ),
  };
});

jest.mock('@/features/search/workspace-search-panel', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    WorkspaceSearchPanel: (props: Record<string, any>) => (
      <ReactNative.View testID="controlled-search-panel">
        <ReactNative.Text>{`controlled-filters:${props.initialQuery}`}</ReactNative.Text>
        <ReactNative.Pressable
          accessibilityLabel="controlled close filters"
          accessibilityRole="button"
          onPress={props.onClose}
        />
      </ReactNative.View>
    ),
  };
});

jest.mock('@/features/chat/conversation-details', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ConversationDetails: (props: Record<string, any>) => {
      mockConversationDetailsProps = props;
      return <ReactNative.Text>{`controlled-details:${props.conversation.title}`}</ReactNative.Text>;
    },
  };
});

function conversation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id === 'conversation-primary' ? 'Primary operations' : 'Secondary operations',
    managementOnly: false,
    ...overrides,
  };
}

function baseWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ready',
    organizationId: '20000000-0000-4000-8000-000000000001',
    organizationName: 'Controlled Company',
    currentUser: null,
    conversations: [
      conversation('conversation-primary'),
      conversation('conversation-secondary'),
      conversation('conversation-management', { title: 'Management review', managementOnly: true }),
    ],
    selectedConversationId: 'conversation-primary',
    messages: {
      'conversation-primary': [{ id: 'message-primary', body: 'Primary message' }],
      'conversation-secondary': [{ id: 'message-secondary', body: 'Secondary message' }],
    },
    inboxFilter: 'all',
    inboxSearch: '',
    markConversationRead: jest.fn(async () => undefined),
    updateConversationPreferences: jest.fn(async (..._mockArgs: unknown[]) => true),
    leaveConversation: jest.fn(async (..._mockArgs: unknown[]) => true),
    people: [],
    searchUsers: jest.fn(async (..._mockArgs: unknown[]) => [] as unknown[]),
    discoverableConversations: [{ id: 'conversation-discoverable' }],
    selectConversation: jest.fn(),
    setInboxFilter: jest.fn(),
    setInboxSearch: jest.fn(),
    requestConversationJoin: jest.fn(async () => true),
    cancelConversationJoinRequest: jest.fn(async () => true),
    sendMessage: jest.fn(async () => true),
    ...overrides,
  };
}

beforeEach(() => {
  mockWidth = 1280;
  mockParams = {};
  mockWorkspace = baseWorkspace();
  mockConversationListProps = null;
  mockConversationPaneProps = null;
  mockConversationDetailsProps = null;
});

describe('chats index route', () => {
  test.each([
    ['loading', [conversation('conversation-primary')]],
    ['error', [conversation('conversation-primary')]],
    ['ready', [conversation('conversation-management', { managementOnly: true })]],
  ])('renders the authoritative workspace state for %s data', async (status, conversations) => {
    mockWorkspace = baseWorkspace({ status, conversations });
    const view = await render(<ChatsScreen />);

    expect(screen.getByText('controlled-state:chats')).toBeTruthy();
    expect(screen.queryByTestId('controlled-conversation-list')).toBeNull();

    await view.unmount();
  });

  test('wires the desktop three-panel experience to workspace commands', async () => {
    mockWidth = 1500;
    const view = await render(<ChatsScreen />);

    expect(screen.getByText('desktop-list')).toBeTruthy();
    expect(screen.getByText('Primary operations')).toBeTruthy();
    expect(screen.getByText('controlled-details:Primary operations')).toBeTruthy();
    expect(mockConversationDetailsProps?.conversation.id).toBe('conversation-primary');

    await fireEvent.press(screen.getByRole('button', { name: 'controlled select conversation' }));
    expect(mockWorkspace.selectConversation).toHaveBeenCalledWith('conversation-secondary');
    expect(mockRouter.push).not.toHaveBeenCalledWith(expect.objectContaining({
      pathname: '/conversation/[id]',
    }));

    await fireEvent.press(screen.getByRole('button', { name: 'controlled compose' }));
    await fireEvent.press(screen.getByRole('button', { name: 'chat.newGroup' }));
    expect(mockRouter.push).toHaveBeenCalledWith('./new-group');

    await act(async () => {
      mockConversationListProps?.onFilterChange('unread');
      mockConversationListProps?.onSearchChange('north line');
      await mockConversationListProps?.onRequestJoin('conversation-discoverable');
      await mockConversationListProps?.onCancelJoin('request-controlled');
    });
    expect(mockWorkspace.setInboxFilter).toHaveBeenCalledWith('unread');
    expect(mockWorkspace.setInboxSearch).toHaveBeenCalledWith('north line');
    expect(mockWorkspace.requestConversationJoin).toHaveBeenCalledWith('conversation-discoverable');
    expect(mockWorkspace.cancelConversationJoinRequest).toHaveBeenCalledWith('request-controlled');

    await fireEvent.press(screen.getByRole('button', { name: 'controlled send' }));
    expect(mockWorkspace.sendMessage).toHaveBeenCalledWith(
      'conversation-primary',
      'Controlled route message',
      'reply-message',
      ['user-mentioned'],
    );

    await view.unmount();
  });

  test('the chats browsing row opens the pins from every chat and lands on one', async () => {
    const view = await render(<ChatsScreen />);
    expect(screen.queryByTestId('controlled-pinned-sheet')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'controlled open pinned' }));
    // No chat is named, so the sheet gathers pins across the whole inbox.
    expect(screen.getByText('controlled-pinned:every-chat')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'controlled open pinned message' }));
    expect(mockWorkspace.selectConversation).toHaveBeenCalledWith('conversation-secondary');
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-secondary', messageId: 'message-secondary' },
    });

    await view.unmount();
  });

  test('removes management-only selection from the ordinary inbox and omits narrow desktop details', async () => {
    mockWidth = 1000;
    mockWorkspace = baseWorkspace({ selectedConversationId: 'conversation-management' });
    const view = await render(<ChatsScreen />);

    await waitFor(() => expect(mockWorkspace.selectConversation).toHaveBeenCalledWith(
      'conversation-primary',
    ));
    expect(screen.getByText('Management review')).toBeTruthy();
    expect(screen.queryByText('controlled-details:Management review')).toBeNull();

    await view.unmount();
  });

  test('routes mobile selection to the focused conversation route and handles missing selection', async () => {
    mockWidth = 390;
    mockWorkspace = baseWorkspace({ selectedConversationId: 'conversation-not-present' });
    const view = await render(<ChatsScreen />);

    expect(screen.getByText('mobile-list')).toBeTruthy();
    expect(screen.getByText('Controlled Company · chat.onShift')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'controlled select conversation' }));
    expect(mockWorkspace.selectConversation).toHaveBeenCalledWith('conversation-secondary');
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-secondary' },
    });

    await view.unmount();
  });

  test('the "+" on the header is two rows: add a friend, or make a group', async () => {
    mockWidth = 390;
    const view = await render(<ChatsScreen />);
    expect(screen.queryByRole('button', { name: 'chat.newGroup' })).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'chat.newMenu' }));
    expect(screen.getByRole('button', { name: 'people.addFriendTitle' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.newGroup' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'people.addFriendTitle' }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/people', params: { add: '1' } });
    expect(screen.queryByRole('button', { name: 'chat.newGroup' })).toBeNull();

    // The list's own compose control opens the same two rows.
    await fireEvent.press(screen.getByRole('button', { name: 'controlled compose' }));
    await fireEvent.press(screen.getByRole('button', { name: 'chat.newGroup' }));
    expect(mockRouter.push).toHaveBeenCalledWith('./new-group');

    await view.unmount();
  });

  test('opens a chat and an exact message from the one search field on Chats', async () => {
    mockWidth = 390;
    const view = await render(<ChatsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'controlled open chat hit' }));
    expect(mockWorkspace.selectConversation).toHaveBeenCalledWith('conversation-secondary');
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-secondary' },
    });

    mockRouter.push.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: 'controlled open message hit' }));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-secondary', messageId: 'message-secondary' },
    });

    await view.unmount();
  });

  test('keeps a chat selected in place when a desktop search hit is a whole conversation', async () => {
    mockWidth = 1500;
    const view = await render(<ChatsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'controlled open chat hit' }));
    expect(mockWorkspace.selectConversation).toHaveBeenCalledWith('conversation-secondary');
    expect(mockRouter.push).not.toHaveBeenCalled();

    await view.unmount();
  });

  test('the workplace filter panel opens from the field and closes again; consumers never get it', async () => {
    mockWidth = 390;
    const view = await render(<ChatsScreen />);
    expect(mockConversationListProps?.onOpenAdvancedSearch).toBeInstanceOf(Function);

    await fireEvent.press(screen.getByRole('button', { name: 'controlled open filters' }));
    expect(screen.getByText('controlled-filters:')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'controlled close filters' }));
    expect(screen.queryByTestId('controlled-search-panel')).toBeNull();
    await view.unmount();

    mockWorkspace = baseWorkspace({ organizationId: PERSONAL_REALM_ORGANIZATION_ID });
    const consumerView = await render(<ChatsScreen />);
    expect(mockConversationListProps?.onOpenAdvancedSearch).toBeUndefined();
    await consumerView.unmount();
  });

  test('row actions reach the preferences the server already has, and unread is remembered here', async () => {
    mockWidth = 390;
    const view = await render(<ChatsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'controlled row markUnread' }));
    expect(screen.getByText('controlled-unread:conversation-primary')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'controlled row markRead' }));
    expect(screen.getByText('controlled-unread:')).toBeTruthy();
    expect(mockWorkspace.markConversationRead).toHaveBeenCalledWith('conversation-primary');

    await fireEvent.press(screen.getByRole('button', { name: 'controlled row mute' }));
    expect(mockWorkspace.updateConversationPreferences).toHaveBeenCalledWith(
      'conversation-primary', { notificationLevel: 'none' },
    );
    await fireEvent.press(screen.getByRole('button', { name: 'controlled row unmute' }));
    expect(mockWorkspace.updateConversationPreferences).toHaveBeenCalledWith(
      'conversation-primary', { notificationLevel: 'all', mutedUntil: null },
    );
    await fireEvent.press(screen.getByRole('button', { name: 'controlled row archive' }));
    expect(mockWorkspace.updateConversationPreferences).toHaveBeenCalledWith(
      'conversation-primary', { isArchived: true },
    );

    await view.unmount();
  });

  test('leaving a group says leaving, deleting a chat says deleting, and both can be kept', async () => {
    mockWidth = 390;
    const view = await render(<ChatsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'controlled row leave' }));
    expect(screen.getByText('chat.leaveGroupTitle')).toBeTruthy();
    expect(screen.getByText('chat.leaveGroupBody')).toBeTruthy();
    expect(screen.queryByText('chat.deleteChatBody')).toBeNull();
    // Keeping it does nothing at all.
    await fireEvent.press(screen.getByRole('button', { name: 'chat.keepChat' }));
    expect(mockWorkspace.leaveConversation).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'controlled row leave' }));
    await fireEvent.press(screen.getByRole('button', { name: 'chat.leaveGroup' }));
    expect(mockWorkspace.leaveConversation).toHaveBeenCalledWith('conversation-primary');

    await fireEvent.press(screen.getByRole('button', { name: 'controlled row delete' }));
    expect(screen.getByText('chat.deleteChatTitle')).toBeTruthy();
    expect(screen.getByText('chat.deleteChatBody')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'chat.deleteChat' }));
    expect(mockWorkspace.updateConversationPreferences).toHaveBeenCalledWith(
      'conversation-primary', { isArchived: true },
    );

    await view.unmount();
  });

  test('replaces the workspace subtitle with the consumer handle in the personal realm', async () => {
    mockWidth = 390;
    mockWorkspace = baseWorkspace({
      organizationId: PERSONAL_REALM_ORGANIZATION_ID,
      currentUser: { username: 'river_runner_7' },
    });
    const view = await render(<ChatsScreen />);

    expect(screen.getByText('@river_runner_7')).toBeTruthy();
    expect(screen.queryByText('Controlled Company · chat.onShift')).toBeNull();

    await view.unmount();
  });

  test('renders no subtitle for a personal-realm account without a username on desktop', async () => {
    mockWidth = 1280;
    mockWorkspace = baseWorkspace({ organizationId: PERSONAL_REALM_ORGANIZATION_ID });
    const view = await render(<ChatsScreen />);

    expect(screen.queryByText('Controlled Company · chat.onShift')).toBeNull();
    expect(screen.queryByText(/chat\.onShift/)).toBeNull();

    await view.unmount();
  });

  test('renders no subtitle before the bootstrap says which realm the account is in', async () => {
    mockWidth = 390;
    // Before the bootstrap the provider exposes an empty organizationId while
    // the organization name and a cached handle may already be present. The
    // workplace line must not flash for a consumer during that window.
    mockWorkspace = baseWorkspace({
      status: 'loading',
      organizationId: '',
      currentUser: { username: 'river_runner_7' },
    });
    const view = await render(<ChatsScreen />);

    expect(screen.queryByText(/chat\.onShift/)).toBeNull();
    expect(screen.queryByText('Controlled Company · chat.onShift')).toBeNull();
    expect(screen.queryByText('@river_runner_7')).toBeNull();

    await view.unmount();
  });
});

describe('focused conversation route', () => {
  test('selects the URL conversation and wires focus, back, messages, and send behavior', async () => {
    mockParams = { id: 'conversation-secondary', messageId: 'message-secondary' };
    const view = await render(<ConversationScreen />);

    await waitFor(() => expect(mockWorkspace.selectConversation).toHaveBeenCalledWith(
      'conversation-secondary',
    ));
    expect(screen.getByText('Secondary operations')).toBeTruthy();
    expect(screen.getByText('mobile-pane')).toBeTruthy();
    expect(mockConversationPaneProps?.focusMessageId).toBe('message-secondary');
    expect(mockConversationPaneProps?.messages).toEqual([
      { id: 'message-secondary', body: 'Secondary message' },
    ]);
    expect(screen.getByTestId('controlled-app-scaffold').props['data-hide-mobile-tabs']).toBe(true);

    await fireEvent.press(screen.getByRole('button', { name: 'controlled conversation back' }));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'controlled send' }));
    expect(mockWorkspace.sendMessage).toHaveBeenCalledWith(
      'conversation-secondary',
      'Controlled route message',
      'reply-message',
      ['user-mentioned'],
    );

    await view.unmount();
  });

  test.each(['loading', 'error'])('renders workspace status instead of a pane while %s', async (status) => {
    mockParams = { id: 'conversation-primary' };
    mockWorkspace = baseWorkspace({ status });
    const view = await render(<ConversationScreen />);

    expect(screen.getByText('controlled-state:chats')).toBeTruthy();
    expect(screen.queryByTestId('controlled-conversation-pane')).toBeNull();

    await view.unmount();
  });

  test('renders a safe empty pane when route identity and authoritative data are absent', async () => {
    mockParams = {};
    mockWorkspace = baseWorkspace({ conversations: [], messages: {} });
    const view = await render(<ConversationScreen />);

    expect(screen.getByText('no-conversation')).toBeTruthy();
    expect(mockConversationPaneProps?.messages).toEqual([]);
    expect(mockWorkspace.selectConversation).not.toHaveBeenCalled();

    await view.unmount();
  });
});
