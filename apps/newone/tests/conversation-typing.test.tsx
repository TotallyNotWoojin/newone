import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import {
  TYPING_BROADCAST_INTERVAL_MS,
  TYPING_EXPIRY_MS,
  parseTypingPeer,
} from '@/data/realtime/use-conversation-typing';
import type { Message } from '@/domain/types';
import { ConversationPane } from '@/features/chat/conversation-pane';

const mockSetAuth = jest.fn<(_token: string) => Promise<void>>(async () => undefined);
const mockRemoveChannel = jest.fn<(_channel: unknown) => Promise<void>>(async () => undefined);
const mockGetRealtimeClient = jest.fn<() => unknown>();
const mockSend = jest.fn<(_message: unknown) => Promise<string>>(async () => 'ok');

type SubscriptionStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';
type BroadcastHandler = (payload?: unknown) => void;

const subscriptions = new Map<string, (status: SubscriptionStatus) => void>();
const broadcasts = new Map<string, BroadcastHandler>();
const channelOptions = new Map<string, unknown>();
const channels = new Map<string, { topic: string }>();

jest.mock('@/lib/supabase', () => ({
  getRealtimeClient: () => mockGetRealtimeClient(),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: false })),
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: false })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

let mockWorkspace: Record<string, any>;

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

function controlledClient() {
  return {
    realtime: { setAuth: mockSetAuth },
    channel: (topic: string, options: unknown) => {
      const channel = {
        topic,
        on: (_kind: string, filter: { event: string }, handler: BroadcastHandler) => {
          broadcasts.set(`${topic}:${filter.event}`, handler);
          return channel;
        },
        subscribe: (handler: (status: SubscriptionStatus) => void) => {
          subscriptions.set(topic, handler);
          return channel;
        },
        send: (message: unknown) => mockSend(message),
      };
      channels.set(topic, channel);
      channelOptions.set(topic, options);
      return channel;
    },
    removeChannel: mockRemoveChannel,
  };
}

const self = {
  id: 'user-self',
  displayName: 'Jordan Lee',
  initials: 'JL',
  avatarColor: '#123456',
  roleLabel: 'Supervisor',
  role: 'manager',
  site: 'Denver',
  department: 'Operations',
  preferredLanguage: 'en',
  presence: 'online',
  connectionState: 'self',
};

const colleague = {
  id: 'user-colleague',
  displayName: 'Ana Torres',
  initials: 'AT',
  avatarColor: '#654321',
  roleLabel: 'Operator',
  role: 'employee',
  site: 'Denver',
  department: 'Operations',
  preferredLanguage: 'es',
  presence: 'away',
  connectionState: 'connected',
};

const candidate = {
  id: 'user-candidate',
  displayName: 'Morgan Park',
  initials: 'MP',
  avatarColor: '#336699',
  roleLabel: 'Technician',
  role: 'employee',
  site: 'Denver',
  department: 'Maintenance',
  preferredLanguage: 'en',
  presence: 'offline',
  connectionState: 'available',
};

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conversation-main',
    organizationId: 'organization-a',
    title: 'Plant Operations',
    initials: 'PO',
    avatarColor: '#225544',
    kind: 'group',
    subtitle: 'Live shift coordination',
    participantCount: 3,
    unreadCount: 0,
    pinned: false,
    favorite: false,
    muted: false,
    notificationLevel: 'all',
    translationMode: 'off',
    priority: 'normal',
    myRole: 'member',
    canManage: false,
    canManageConversation: false,
    memberIds: [self.id, colleague.id, candidate.id],
    historyPolicy: 'all',
    postingMode: 'all_members',
    canPost: true,
    ...overrides,
  } as any;
}

async function noopSend(
  _text: string,
  _replyTo?: Message,
  _mentionUserIds?: string[],
): Promise<void> {}

function buildWorkspace() {
  return {
    actionBusy: null,
    actionError: null,
    actions: [],
    aiOutputErrorReports: [],
    connectivity: 'online',
    conversationAvatarUrls: {},
    conversations: [conversation()],
    currentUser: self,
    messageDisplayLanguage: 'en',
    messagePagination: {},
    organizationId: 'organization-a',
    people: [self, colleague, candidate],
    realtimeToken: 'controlled-realtime-token',
    summaries: [],
    unreadDividerIds: {},
    hasCapability: jest.fn(() => false),
    clearActionError: jest.fn(),
    downloadAttachment: jest.fn(async () => true),
    ensureMessageLoaded: jest.fn(async () => true),
    loadMyAiOutputErrorReports: jest.fn(async () => true),
    loadOlderMessages: jest.fn(async () => true),
    markConversationRead: jest.fn(async () => true),
    observeConversation: jest.fn(async () => true),
    requestConversationSummary: jest.fn(async () => true),
    sendAttachment: jest.fn(async () => true),
  };
}

const TOPIC = 'org:organization-a:conversation:conversation-main:typing';

async function flushChannelSetup() {
  await act(async () => {});
}

beforeEach(() => {
  jest.useFakeTimers();
  subscriptions.clear();
  broadcasts.clear();
  channelOptions.clear();
  channels.clear();
  mockSetAuth.mockImplementation(async () => undefined);
  mockRemoveChannel.mockImplementation(async () => undefined);
  mockSend.mockImplementation(async () => 'ok');
  mockGetRealtimeClient.mockImplementation(() => controlledClient());
  mockWorkspace = buildWorkspace();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('typing broadcast parser', () => {
  test('accepts wrapped and direct payloads while failing closed on invalid ones', () => {
    expect(parseTypingPeer(
      { payload: { userId: colleague.id, displayName: colleague.displayName } },
      self.id,
    )).toEqual({ userId: colleague.id, displayName: colleague.displayName });
    expect(parseTypingPeer(
      { userId: colleague.id, displayName: colleague.displayName },
      self.id,
    )).toEqual({ userId: colleague.id, displayName: colleague.displayName });
    expect(parseTypingPeer({ payload: { userId: self.id, displayName: self.displayName } }, self.id)).toBeNull();
    expect(parseTypingPeer({ payload: { userId: '', displayName: 'Nameless' } }, self.id)).toBeNull();
    expect(parseTypingPeer({ payload: { userId: colleague.id, displayName: '' } }, self.id)).toBeNull();
    expect(parseTypingPeer({ payload: { userId: 42, displayName: 'Machine' } }, self.id)).toBeNull();
    expect(parseTypingPeer(null, self.id)).toBeNull();
  });
});

describe('conversation typing indicators over the private broadcast channel', () => {
  test('joins the private typing topic and throttles composer typing broadcasts to one per interval', async () => {
    const view = await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await flushChannelSetup();

    expect(mockSetAuth).toHaveBeenCalledWith('controlled-realtime-token');
    expect(channelOptions.get(TOPIC)).toEqual({
      config: { private: true, broadcast: { self: false, ack: false } },
    });

    // Not yet subscribed: no broadcast leaves the client.
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'ear');
    expect(mockSend).not.toHaveBeenCalled();

    await act(async () => subscriptions.get(TOPIC)?.('SUBSCRIBED'));
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'early');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: self.id, displayName: self.displayName },
    });

    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'early and often');
    expect(mockSend).toHaveBeenCalledTimes(1);

    await act(async () => jest.advanceTimersByTime(TYPING_BROADCAST_INTERVAL_MS));
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'early and often again');
    expect(mockSend).toHaveBeenCalledTimes(2);

    await fireEvent.press(screen.getByLabelText('chat.send'));
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(mockSend.mock.calls[2]?.[0]).toMatchObject({ event: 'stopped' });

    await view.unmount();
    expect(mockRemoveChannel).toHaveBeenCalledWith(channels.get(TOPIC));
  });

  test('emits a final stopped event on clear and on blur only after typing was announced', async () => {
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await flushChannelSetup();
    await act(async () => subscriptions.get(TOPIC)?.('SUBSCRIBED'));

    // Blur before any announcement stays silent.
    await fireEvent(screen.getByLabelText('chat.message'), 'blur');
    expect(mockSend).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'draft');
    expect(mockSend).toHaveBeenCalledTimes(1);
    await fireEvent.changeText(screen.getByLabelText('chat.message'), '');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1]?.[0]).toMatchObject({ event: 'stopped' });

    // Cleared twice does not repeat the stopped event.
    await fireEvent.changeText(screen.getByLabelText('chat.message'), '   ');
    expect(mockSend).toHaveBeenCalledTimes(2);

    await act(async () => jest.advanceTimersByTime(TYPING_BROADCAST_INTERVAL_MS));
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'draft again');
    expect(mockSend).toHaveBeenCalledTimes(3);
    await fireEvent(screen.getByLabelText('chat.message'), 'blur');
    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(mockSend.mock.calls[3]?.[0]).toMatchObject({ event: 'stopped' });
  });

  test('shows one or several typing peers, ignores self, and expires peers after silence', async () => {
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} mobile />);
    await flushChannelSetup();
    await act(async () => subscriptions.get(TOPIC)?.('SUBSCRIBED'));

    // Own echoes never render an indicator.
    await act(async () => broadcasts.get(`${TOPIC}:typing`)?.({
      payload: { userId: self.id, displayName: self.displayName },
    }));
    expect(screen.queryByText('chat.typingSingle')).toBeNull();

    await act(async () => broadcasts.get(`${TOPIC}:typing`)?.({
      payload: { userId: colleague.id, displayName: colleague.displayName },
    }));
    expect(screen.getByText('chat.typingSingle')).toBeTruthy();

    await act(async () => broadcasts.get(`${TOPIC}:typing`)?.({
      payload: { userId: candidate.id, displayName: candidate.displayName },
    }));
    expect(screen.getByText('chat.typingSeveral')).toBeTruthy();

    // A stopped event removes only that peer; invalid stopped payloads are ignored.
    await act(async () => broadcasts.get(`${TOPIC}:stopped`)?.({
      payload: { userId: self.id, displayName: self.displayName },
    }));
    expect(screen.getByText('chat.typingSeveral')).toBeTruthy();
    await act(async () => broadcasts.get(`${TOPIC}:stopped`)?.({
      payload: { userId: candidate.id, displayName: candidate.displayName },
    }));
    expect(screen.getByText('chat.typingSingle')).toBeTruthy();

    // A repeated event extends the peer's expiry window.
    await act(async () => jest.advanceTimersByTime(TYPING_EXPIRY_MS - 1000));
    await act(async () => broadcasts.get(`${TOPIC}:typing`)?.({
      payload: { userId: colleague.id, displayName: colleague.displayName },
    }));
    await act(async () => jest.advanceTimersByTime(TYPING_EXPIRY_MS - 1000));
    expect(screen.getByText('chat.typingSingle')).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(1000));
    expect(screen.queryByText('chat.typingSingle')).toBeNull();
  });

  test('tears down and rejoins when the open conversation changes', async () => {
    const view = await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await flushChannelSetup();
    await act(async () => subscriptions.get(TOPIC)?.('SUBSCRIBED'));
    await act(async () => broadcasts.get(`${TOPIC}:typing`)?.({
      payload: { userId: colleague.id, displayName: colleague.displayName },
    }));
    expect(screen.getByText('chat.typingSingle')).toBeTruthy();

    const nextConversation = conversation({ id: 'conversation-two', title: 'Maintenance', initials: 'MT' });
    await view.rerender(<ConversationPane conversation={nextConversation} messages={[]} onSend={noopSend} />);
    await flushChannelSetup();

    expect(mockRemoveChannel).toHaveBeenCalledWith(channels.get(TOPIC));
    const nextTopic = 'org:organization-a:conversation:conversation-two:typing';
    expect(channels.has(nextTopic)).toBe(true);
    // Peers from the previous conversation are dropped with the old channel.
    expect(screen.queryByText('chat.typingSingle')).toBeNull();
  });

  test('stays inert without a realtime client, without a token, and after auth rejection', async () => {
    mockGetRealtimeClient.mockImplementation(() => null);
    const withoutClient = await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await flushChannelSetup();
    expect(mockSetAuth).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'quiet');
    expect(mockSend).not.toHaveBeenCalled();
    await withoutClient.unmount();

    mockGetRealtimeClient.mockImplementation(() => controlledClient());
    mockWorkspace = { ...buildWorkspace(), realtimeToken: null };
    const withoutToken = await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await flushChannelSetup();
    expect(mockSetAuth).not.toHaveBeenCalled();
    await withoutToken.unmount();

    mockWorkspace = buildWorkspace();
    mockSetAuth.mockImplementationOnce(async () => {
      throw new Error('controlled socket authentication failure');
    });
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await flushChannelSetup();
    expect(channels.size).toBe(0);
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'still quiet');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('stops broadcasting after the channel closes beneath the composer', async () => {
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await flushChannelSetup();
    await act(async () => subscriptions.get(TOPIC)?.('SUBSCRIBED'));
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'first');
    expect(mockSend).toHaveBeenCalledTimes(1);

    await act(async () => subscriptions.get(TOPIC)?.('CLOSED'));
    await act(async () => jest.advanceTimersByTime(TYPING_BROADCAST_INTERVAL_MS));
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'first and more');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
