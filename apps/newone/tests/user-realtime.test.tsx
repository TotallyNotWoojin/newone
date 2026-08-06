import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, render, waitFor } from '@testing-library/react-native';

import {
  parseInboxInvalidation,
  useUserRealtime,
  type InboxInvalidation,
  type RealtimeState,
} from '@/data/realtime/use-user-realtime';

const mockSetAuth = jest.fn();
const mockRemoveAllChannels = jest.fn();
const mockRemoveChannel = jest.fn();
const mockGetRealtimeClient = jest.fn();

type SubscriptionStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';
type BroadcastHandler = (payload?: unknown) => void;

const subscriptions = new Map<string, (status: SubscriptionStatus) => void>();
const broadcasts = new Map<string, BroadcastHandler>();
const channelOptions = new Map<string, unknown>();
const channels = new Map<string, { topic: string }>();

jest.mock('@/lib/supabase', () => ({
  getRealtimeClient: () => mockGetRealtimeClient(),
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
      };
      channels.set(topic, channel);
      channelOptions.set(topic, options);
      return channel;
    },
    removeAllChannels: mockRemoveAllChannels,
    removeChannel: mockRemoveChannel,
  };
}

function RealtimeHarness(props: {
  enabled?: boolean;
  onAccessEnded: () => void;
  onInvalidate: (event: InboxInvalidation) => void;
  onReconcile: () => void;
  onStateChange: (state: RealtimeState) => void;
}) {
  useUserRealtime({
    enabled: props.enabled ?? true,
    organizationId: 'org-a',
    userId: 'user-a',
    accessToken: 'controlled-access-token',
    onAccessEnded: props.onAccessEnded,
    onInvalidate: props.onInvalidate,
    onReconcile: props.onReconcile,
    onStateChange: props.onStateChange,
  });
  return null;
}

beforeEach(() => {
  subscriptions.clear();
  broadcasts.clear();
  channelOptions.clear();
  channels.clear();
  mockSetAuth.mockImplementation(async () => undefined);
  mockRemoveAllChannels.mockImplementation(async () => undefined);
  mockRemoveChannel.mockImplementation(async () => undefined);
  mockGetRealtimeClient.mockImplementation(() => controlledClient());
});

describe('database Broadcast invalidation parser', () => {
  const snakeCaseEnvelope = {
    schema_version: 1,
    event_id: '30000000-0000-4000-8000-000000000003',
    event: 'workspace.invalidated',
    organization_id: 'org-a',
    occurred_at: '2026-08-04T22:00:00.000Z',
    conversation_id: 'conversation-a',
    entity_type: 'message',
    entity_id: 'message-a',
    version_id: null,
    reason: 'message_changed',
  };

  test('normalizes the real snake_case realtime.send envelope', () => {
    expect(parseInboxInvalidation(
      { payload: { payload: snakeCaseEnvelope } },
      'workspace.invalidated',
      'org-a',
    )).toEqual({
      schemaVersion: 1,
      eventId: '30000000-0000-4000-8000-000000000003',
      event: 'workspace.invalidated',
      organizationId: 'org-a',
      occurredAt: '2026-08-04T22:00:00.000Z',
      conversationId: 'conversation-a',
      entityType: 'message',
      entityId: 'message-a',
      versionId: undefined,
      reason: 'message_changed',
    });
  });

  test('retains camelCase compatibility for directly emitted clients', () => {
    expect(parseInboxInvalidation({
      payload: {
        schemaVersion: 1,
        eventId: 'event-12345678',
        event: 'workspace.invalidated',
        organizationId: 'org-a',
        occurredAt: '2026-08-04T22:00:00.000Z',
        conversationId: 'conversation-a',
        entityType: 'receipt',
        entityId: 'message-a',
        versionId: 'version-a',
      },
    }, 'workspace.invalidated', 'org-a')).toMatchObject({
      eventId: 'event-12345678',
      organizationId: 'org-a',
      conversationId: 'conversation-a',
      entityType: 'receipt',
      entityId: 'message-a',
      versionId: 'version-a',
    });
  });

  test('fails closed for conflicting aliases and invalid tenant or time data', () => {
    expect(parseInboxInvalidation({
      ...snakeCaseEnvelope,
      organizationId: 'different-org',
    }, 'workspace.invalidated', 'org-a')).toBeNull();
    expect(parseInboxInvalidation({
      ...snakeCaseEnvelope,
      organization_id: 'different-org',
    }, 'workspace.invalidated', 'org-a')).toBeNull();
    expect(parseInboxInvalidation({
      ...snakeCaseEnvelope,
      occurred_at: 'not-a-date',
    }, 'workspace.invalidated', 'org-a')).toBeNull();
    expect(parseInboxInvalidation({
      ...snakeCaseEnvelope,
      event_id: 'short',
    }, 'workspace.invalidated', 'org-a')).toBeNull();
    expect(parseInboxInvalidation(null, 'workspace.invalidated', 'org-a')).toBeNull();
  });
});

describe('private Realtime subscription lifecycle', () => {
  test('joins both private topics, reconciles, normalizes invalidations, and ends access once', async () => {
    const onInvalidate = jest.fn();
    const onReconcile = jest.fn();
    const onAccessEnded = jest.fn();
    const onStateChange = jest.fn();
    const view = await render(
      <RealtimeHarness
        onAccessEnded={onAccessEnded}
        onInvalidate={onInvalidate}
        onReconcile={onReconcile}
        onStateChange={onStateChange}
      />,
    );

    await waitFor(() => expect(mockSetAuth).toHaveBeenCalledWith('controlled-access-token'));
    const inboxTopic = 'org:org-a:user:user-a:inbox';
    const controlTopic = 'org:org-a:user:user-a:control';
    expect(channelOptions.get(inboxTopic)).toEqual({
      config: { private: true, broadcast: { ack: true, self: false } },
    });
    expect(channelOptions.get(controlTopic)).toEqual({
      config: { private: true, broadcast: { ack: true, self: false } },
    });

    await act(async () => {
      subscriptions.get(inboxTopic)?.('SUBSCRIBED');
      subscriptions.get(controlTopic)?.('SUBSCRIBED');
    });
    expect(onStateChange).toHaveBeenLastCalledWith('subscribed');
    expect(onReconcile).toHaveBeenCalledTimes(1);

    await act(async () => {
      broadcasts.get(`${inboxTopic}:workspace.invalidated`)?.({
        payload: {
          schema_version: 1,
          event_id: '40000000-0000-4000-8000-000000000004',
          event: 'workspace.invalidated',
          organization_id: 'org-a',
          occurred_at: '2026-08-04T22:05:00.000Z',
          conversation_id: 'conversation-a',
          entity_type: 'message',
          entity_id: 'message-a',
          version_id: null,
          reason: 'message_changed',
        },
      });
    });
    expect(onInvalidate).toHaveBeenCalledWith(expect.objectContaining({
      eventId: '40000000-0000-4000-8000-000000000004',
      conversationId: 'conversation-a',
    }));

    await act(async () => {
      broadcasts.get(`${controlTopic}:membership.revoked`)?.();
      await Promise.resolve();
      broadcasts.get(`${controlTopic}:session.revoked`)?.();
    });
    expect(mockRemoveAllChannels).toHaveBeenCalledTimes(1);
    expect(onAccessEnded).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(mockRemoveChannel).toHaveBeenCalledWith(channels.get(inboxTopic));
    expect(mockRemoveChannel).toHaveBeenCalledWith(channels.get(controlTopic));
    expect(onStateChange).toHaveBeenLastCalledWith('idle');
  });

  test('reports channel errors, closed channels, and authentication rejection', async () => {
    const onStateChange = jest.fn();
    const stableCallbacks = {
      onAccessEnded: jest.fn(),
      onInvalidate: jest.fn(),
      onReconcile: jest.fn(),
    };
    const view = await render(
      <RealtimeHarness {...stableCallbacks} onStateChange={onStateChange} />,
    );
    await waitFor(() => expect(subscriptions.size).toBe(2));
    const inboxTopic = 'org:org-a:user:user-a:inbox';
    const controlTopic = 'org:org-a:user:user-a:control';
    await act(async () => {
      subscriptions.get(inboxTopic)?.('CHANNEL_ERROR');
      subscriptions.get(controlTopic)?.('TIMED_OUT');
      subscriptions.get(inboxTopic)?.('CLOSED');
    });
    expect(onStateChange).toHaveBeenCalledWith('error');
    expect(onStateChange).toHaveBeenCalledWith('connecting');
    await view.unmount();

    mockSetAuth.mockImplementationOnce(async () => {
      throw new Error('controlled socket authentication failure');
    });
    const rejectedState = jest.fn();
    await render(<RealtimeHarness {...stableCallbacks} onStateChange={rejectedState} />);
    await waitFor(() => expect(rejectedState).toHaveBeenCalledWith('error'));
  });

  test('stays idle without an enabled authenticated subscription', async () => {
    const onStateChange = jest.fn();
    await render(
      <RealtimeHarness
        enabled={false}
        onAccessEnded={jest.fn()}
        onInvalidate={jest.fn()}
        onReconcile={jest.fn()}
        onStateChange={onStateChange}
      />,
    );
    expect(onStateChange).toHaveBeenCalledWith('idle');
    expect(mockSetAuth).not.toHaveBeenCalled();
  });
});
