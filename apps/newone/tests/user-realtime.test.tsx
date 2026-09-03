import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
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
const mockOnHeartbeat = jest.fn();

type SubscriptionStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';
type HeartbeatStatus = 'sent' | 'ok' | 'error' | 'timeout' | 'disconnected';
type BroadcastHandler = (payload?: unknown) => void;

const subscriptions = new Map<string, (status: SubscriptionStatus) => void>();
const broadcasts = new Map<string, BroadcastHandler>();
const channelOptions = new Map<string, unknown>();
const channels = new Map<string, { topic: string }>();
let heartbeatCallback: ((status: HeartbeatStatus) => void) | null = null;

jest.mock('@/lib/supabase', () => ({
  getRealtimeClient: () => mockGetRealtimeClient(),
}));

function emitHeartbeat(status: HeartbeatStatus) {
  heartbeatCallback?.(status);
}

function controlledClient() {
  return {
    realtime: {
      setAuth: mockSetAuth,
      onHeartbeat: (callback: (status: HeartbeatStatus) => void) => {
        mockOnHeartbeat(callback);
        heartbeatCallback = callback;
      },
    },
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
  accessToken?: string;
  resubscribeNonce?: number;
  onAccessEnded: () => void;
  onInvalidate: (event: InboxInvalidation) => void;
  onReconcile: () => void;
  onStateChange: (state: RealtimeState) => void;
}) {
  useUserRealtime({
    enabled: props.enabled ?? true,
    organizationId: 'org-a',
    userId: 'user-a',
    accessToken: props.accessToken ?? 'controlled-access-token',
    resubscribeNonce: props.resubscribeNonce,
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
  heartbeatCallback = null;
  mockSetAuth.mockImplementation(async () => undefined);
  mockRemoveAllChannels.mockImplementation(async () => undefined);
  mockRemoveChannel.mockImplementation(async () => undefined);
  mockOnHeartbeat.mockClear();
  mockGetRealtimeClient.mockImplementation(() => controlledClient());
});

afterEach(() => {
  jest.useRealTimers();
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

  test('marks the connection degraded on a channel error, tears down both channels, and ignores stale post-degrade signals', async () => {
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
      // Both channels share one socket outage: these arrive from the same
      // (now superseded) generation and must not restart or extend the retry.
      subscriptions.get(controlTopic)?.('TIMED_OUT');
      subscriptions.get(inboxTopic)?.('CLOSED');
    });
    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual(['connecting', 'degraded']);
    expect(mockRemoveChannel).toHaveBeenCalledTimes(2);
    await view.unmount();

    mockSetAuth.mockImplementationOnce(async () => {
      throw new Error('controlled socket authentication failure');
    });
    const rejectedState = jest.fn();
    await render(<RealtimeHarness {...stableCallbacks} onStateChange={rejectedState} />);
    await waitFor(() => expect(rejectedState).toHaveBeenCalledWith('error'));
  });

  test('degrades and tears down both channels when the control channel itself errors or closes', async () => {
    const onStateChange = jest.fn();
    const stableCallbacks = {
      onAccessEnded: jest.fn(),
      onInvalidate: jest.fn(),
      onReconcile: jest.fn(),
    };
    const controlTopic = 'org:org-a:user:user-a:control';
    await render(<RealtimeHarness {...stableCallbacks} onStateChange={onStateChange} />);
    await waitFor(() => expect(subscriptions.size).toBe(2));
    await act(async () => { subscriptions.get(controlTopic)?.('CHANNEL_ERROR'); });
    expect(onStateChange).toHaveBeenLastCalledWith('degraded');
    expect(mockRemoveChannel).toHaveBeenCalledTimes(2);
  });

  test('resubscribes after a channel error with 1s/2s/4s backoff capped at 30s, and resets the backoff once fully subscribed again', async () => {
    jest.useFakeTimers();
    const onStateChange = jest.fn();
    const stableCallbacks = {
      onAccessEnded: jest.fn(),
      onInvalidate: jest.fn(),
      onReconcile: jest.fn(),
    };
    const inboxTopic = 'org:org-a:user:user-a:inbox';
    const controlTopic = 'org:org-a:user:user-a:control';
    const view = await render(
      <RealtimeHarness {...stableCallbacks} onStateChange={onStateChange} />,
    );
    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(mockSetAuth).toHaveBeenCalledTimes(1);

    // First failure: retries after 1s.
    await act(async () => { subscriptions.get(inboxTopic)?.('CHANNEL_ERROR'); });
    expect(onStateChange).toHaveBeenLastCalledWith('degraded');
    await act(async () => { await jest.advanceTimersByTimeAsync(999); });
    expect(mockSetAuth).toHaveBeenCalledTimes(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(1); });
    expect(mockSetAuth).toHaveBeenCalledTimes(2);

    // Second failure: retries after 2s.
    await act(async () => { subscriptions.get(inboxTopic)?.('CHANNEL_ERROR'); });
    await act(async () => { await jest.advanceTimersByTimeAsync(1_999); });
    expect(mockSetAuth).toHaveBeenCalledTimes(2);
    await act(async () => { await jest.advanceTimersByTimeAsync(1); });
    expect(mockSetAuth).toHaveBeenCalledTimes(3);

    // Third failure: retries after 4s.
    await act(async () => { subscriptions.get(inboxTopic)?.('CHANNEL_ERROR'); });
    await act(async () => { await jest.advanceTimersByTimeAsync(3_999); });
    expect(mockSetAuth).toHaveBeenCalledTimes(3);
    await act(async () => { await jest.advanceTimersByTimeAsync(1); });
    expect(mockSetAuth).toHaveBeenCalledTimes(4);

    // This attempt succeeds fully: both channels subscribe, resetting the backoff.
    await act(async () => {
      subscriptions.get(inboxTopic)?.('SUBSCRIBED');
      subscriptions.get(controlTopic)?.('SUBSCRIBED');
    });
    expect(onStateChange).toHaveBeenLastCalledWith('subscribed');

    // A fresh failure now retries after 1s again, not a continued/longer delay.
    await act(async () => { subscriptions.get(inboxTopic)?.('CHANNEL_ERROR'); });
    await act(async () => { await jest.advanceTimersByTimeAsync(999); });
    expect(mockSetAuth).toHaveBeenCalledTimes(4);
    await act(async () => { await jest.advanceTimersByTimeAsync(1); });
    expect(mockSetAuth).toHaveBeenCalledTimes(5);

    await view.unmount();
    jest.clearAllTimers();
  });

  test('caps the resubscribe backoff at 30s across repeated failures', async () => {
    jest.useFakeTimers();
    const onStateChange = jest.fn();
    const stableCallbacks = {
      onAccessEnded: jest.fn(),
      onInvalidate: jest.fn(),
      onReconcile: jest.fn(),
    };
    const inboxTopic = 'org:org-a:user:user-a:inbox';
    const view = await render(
      <RealtimeHarness {...stableCallbacks} onStateChange={onStateChange} />,
    );
    await act(async () => { await jest.advanceTimersByTimeAsync(0); });

    // Delays escalate 1s, 2s, 4s, 8s, 16s, then cap at 30s from the sixth failure on.
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    let setAuthCalls = mockSetAuth.mock.calls.length;
    for (const delay of delays) {
      await act(async () => { subscriptions.get(inboxTopic)?.('CHANNEL_ERROR'); });
      await act(async () => { await jest.advanceTimersByTimeAsync(delay - 1); });
      expect(mockSetAuth).toHaveBeenCalledTimes(setAuthCalls);
      await act(async () => { await jest.advanceTimersByTimeAsync(1); });
      setAuthCalls += 1;
      expect(mockSetAuth).toHaveBeenCalledTimes(setAuthCalls);
    }

    await view.unmount();
    jest.clearAllTimers();
  });

  test('marks the connection degraded and resubscribes after 60s with no heartbeat', async () => {
    jest.useFakeTimers();
    const onStateChange = jest.fn();
    const stableCallbacks = {
      onAccessEnded: jest.fn(),
      onInvalidate: jest.fn(),
      onReconcile: jest.fn(),
    };
    const inboxTopic = 'org:org-a:user:user-a:inbox';
    const controlTopic = 'org:org-a:user:user-a:control';
    const view = await render(
      <RealtimeHarness {...stableCallbacks} onStateChange={onStateChange} />,
    );
    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    await act(async () => {
      subscriptions.get(inboxTopic)?.('SUBSCRIBED');
      subscriptions.get(controlTopic)?.('SUBSCRIBED');
    });
    expect(mockOnHeartbeat).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenLastCalledWith('subscribed');

    // A healthy heartbeat keeps resetting the 60s watchdog.
    await act(async () => { await jest.advanceTimersByTimeAsync(59_000); });
    await act(async () => { emitHeartbeat('ok'); });
    await act(async () => { await jest.advanceTimersByTimeAsync(59_000); });
    expect(onStateChange).not.toHaveBeenCalledWith('degraded');
    expect(mockRemoveChannel).not.toHaveBeenCalled();

    // Silence for the full 60s window degrades the connection and retries.
    await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });
    expect(onStateChange).toHaveBeenLastCalledWith('degraded');
    expect(mockRemoveChannel).toHaveBeenCalledTimes(2);
    await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });
    expect(mockSetAuth).toHaveBeenCalledTimes(2);

    await view.unmount();
    jest.clearAllTimers();
  });

  test('resubscribeNonce forces a full teardown and reconnect using the current access token', async () => {
    const onStateChange = jest.fn();
    const stableCallbacks = {
      onAccessEnded: jest.fn(),
      onInvalidate: jest.fn(),
      onReconcile: jest.fn(),
    };
    const inboxTopic = 'org:org-a:user:user-a:inbox';
    const controlTopic = 'org:org-a:user:user-a:control';
    const view = await render(
      <RealtimeHarness {...stableCallbacks} accessToken="first-token" resubscribeNonce={0} onStateChange={onStateChange} />,
    );
    await waitFor(() => expect(mockSetAuth).toHaveBeenCalledWith('first-token'));
    const firstInbox = channels.get(inboxTopic);
    const firstControl = channels.get(controlTopic);
    await act(async () => {
      subscriptions.get(inboxTopic)?.('SUBSCRIBED');
      subscriptions.get(controlTopic)?.('SUBSCRIBED');
    });
    expect(onStateChange).toHaveBeenLastCalledWith('subscribed');

    // Foregrounding after a possible session refresh: same nonce is a no-op…
    await view.rerender(
      <RealtimeHarness {...stableCallbacks} accessToken="first-token" resubscribeNonce={0} onStateChange={onStateChange} />,
    );
    expect(mockSetAuth).toHaveBeenCalledTimes(1);

    // …but a bumped nonce tears down every private channel and reconnects
    // with whatever access token is current, even though nothing errored.
    await view.rerender(
      <RealtimeHarness {...stableCallbacks} accessToken="refreshed-token" resubscribeNonce={1} onStateChange={onStateChange} />,
    );
    await waitFor(() => expect(mockSetAuth).toHaveBeenCalledWith('refreshed-token'));
    expect(mockRemoveChannel).toHaveBeenCalledWith(firstInbox);
    expect(mockRemoveChannel).toHaveBeenCalledWith(firstControl);
    expect(channels.get(inboxTopic)).not.toBe(firstInbox);

    await act(async () => {
      subscriptions.get(inboxTopic)?.('SUBSCRIBED');
      subscriptions.get(controlTopic)?.('SUBSCRIBED');
    });
    expect(onStateChange).toHaveBeenLastCalledWith('subscribed');
    await view.unmount();
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
