import { useEffect } from 'react';

import { getRealtimeClient } from '@/lib/supabase';

export type RealtimeState = 'idle' | 'connecting' | 'subscribed' | 'degraded' | 'error';

export type InboxEventName = 'workspace.invalidated';

export interface InboxInvalidation {
  schemaVersion: 1;
  eventId: string;
  event: InboxEventName;
  organizationId: string;
  occurredAt: string;
  conversationId?: string;
  entityType?: string;
  entityId?: string;
  versionId?: string;
  reason?: string;
}

const INBOX_EVENT: InboxEventName = 'workspace.invalidated';

const CONTROL_EVENTS = [
  'membership.revoked',
  'session.revoked',
  'membership.generation_mismatch',
] as const;

/** No realtime heartbeat inside this window means the socket is presumed dead. */
const HEARTBEAT_TIMEOUT_MS = 60_000;
/** Resubscribe backoff after a channel error, close, or heartbeat timeout: 1s, 2s, 4s… capped at 30s. */
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function aliasedValue(
  value: Record<string, unknown>,
  camelCaseKey: string,
  snakeCaseKey: string,
): { valid: true; value: unknown } | { valid: false; value: undefined } {
  const hasCamelCase = Object.prototype.hasOwnProperty.call(value, camelCaseKey);
  const hasSnakeCase = Object.prototype.hasOwnProperty.call(value, snakeCaseKey);
  if (
    hasCamelCase
    && hasSnakeCase
    && value[camelCaseKey] !== value[snakeCaseKey]
  ) {
    return { valid: false, value: undefined };
  }
  return {
    valid: true,
    value: hasCamelCase ? value[camelCaseKey] : value[snakeCaseKey],
  };
}

export function parseInboxInvalidation(
  raw: unknown,
  expectedEvent: InboxEventName,
  organizationId: string,
): InboxInvalidation | null {
  // Realtime-js wraps Broadcast bodies in `payload`. Database Broadcast can
  // additionally wrap the application envelope one level deeper. Accept both,
  // but validate every field before allowing the event to trigger a refetch.
  const outer = record(raw);
  const first = record(outer.payload ?? outer);
  const value = record(first.payload ?? first);
  const schemaVersion = aliasedValue(value, 'schemaVersion', 'schema_version');
  const eventId = aliasedValue(value, 'eventId', 'event_id');
  const envelopeOrganizationId = aliasedValue(value, 'organizationId', 'organization_id');
  const occurredAt = aliasedValue(value, 'occurredAt', 'occurred_at');
  const conversationId = aliasedValue(value, 'conversationId', 'conversation_id');
  const entityType = aliasedValue(value, 'entityType', 'entity_type');
  const entityId = aliasedValue(value, 'entityId', 'entity_id');
  const versionId = aliasedValue(value, 'versionId', 'version_id');
  if (
    !schemaVersion.valid
    || !eventId.valid
    || !envelopeOrganizationId.valid
    || !occurredAt.valid
    || !conversationId.valid
    || !entityType.valid
    || !entityId.valid
    || !versionId.valid
  ) return null;
  if (
    schemaVersion.value !== 1
    || value.event !== expectedEvent
    || envelopeOrganizationId.value !== organizationId
    || typeof eventId.value !== 'string'
    || eventId.value.length < 8
    || typeof occurredAt.value !== 'string'
    || Number.isNaN(Date.parse(occurredAt.value))
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    eventId: eventId.value,
    event: expectedEvent,
    organizationId,
    occurredAt: occurredAt.value,
    conversationId: optionalText(conversationId.value),
    entityType: optionalText(entityType.value),
    entityId: optionalText(entityId.value),
    versionId: optionalText(versionId.value),
    reason: optionalText(value.reason),
  };
}

/**
 * Subscribe only to this user's private invalidation and control topics.
 *
 * Broadcasts never carry authoritative workspace data. They only prompt a
 * bounded, session-aware API refetch. That keeps cached Realtime authorization
 * from becoming a data leak if organization or conversation access changes.
 *
 * Beyond the initial join, this hook is a self-healing connection: a channel
 * error, an unexpected close, or a missed heartbeat all mark the connection
 * 'degraded' and drive an automatic resubscribe with exponential backoff
 * (1s, 2s, 4s… capped at 30s) until a fresh pair of channels is fully
 * subscribed again. Bumping `resubscribeNonce` forces an immediate full
 * teardown and reconnect — used on app foreground/resume — and always uses
 * whatever `accessToken` is current at that moment.
 */
export function useUserRealtime(input: {
  enabled: boolean;
  organizationId: string;
  userId: string;
  accessToken?: string;
  resubscribeNonce?: number;
  onInvalidate: (event: InboxInvalidation) => void;
  onReconcile: () => void;
  onAccessEnded: () => void;
  onStateChange: (state: RealtimeState) => void;
}) {
  const {
    enabled,
    organizationId,
    userId,
    accessToken,
    resubscribeNonce,
    onInvalidate,
    onReconcile,
    onAccessEnded,
    onStateChange,
  } = input;

  useEffect(() => {
    const client = getRealtimeClient();
    if (!enabled || !client || !organizationId || !userId || !accessToken) {
      onStateChange('idle');
      return;
    }

    let active = true;
    let accessEnded = false;
    let inboxSubscribed = false;
    let controlSubscribed = false;
    let inbox: ReturnType<typeof client.channel> | null = null;
    let control: ReturnType<typeof client.channel> | null = null;
    let generation = 0;
    let retryCount = 0;
    let degraded = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    const clearHeartbeatTimer = () => {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    const armHeartbeatWatchdog = () => {
      clearHeartbeatTimer();
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = null;
        // A stale watchdog from before the last outage started must not
        // disrupt an already-in-progress backoff retry cycle.
        if (!active || accessEnded || degraded) return;
        enterDegraded();
      }, HEARTBEAT_TIMEOUT_MS);
    };
    const teardownChannels = () => {
      if (inbox) { void client.removeChannel(inbox); inbox = null; }
      if (control) { void client.removeChannel(control); control = null; }
      inboxSubscribed = false;
      controlSubscribed = false;
    };
    const scheduleRetry = () => {
      if (!active || accessEnded) return;
      clearRetryTimer();
      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * (2 ** retryCount),
        MAX_RECONNECT_DELAY_MS,
      );
      retryCount += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!active || accessEnded) return;
        void connect();
      }, delay);
    };
    // Channel status callbacks are already scoped to one connection attempt
    // via isCurrent(), so two channels erroring from the same socket outage
    // can only ever call this once per generation — no separate guard is
    // needed here, and a genuinely new failure on a later retry attempt must
    // always be free to restart the backoff sequence.
    const enterDegraded = () => {
      if (!active || accessEnded) return;
      generation += 1;
      teardownChannels();
      degraded = true;
      onStateChange('degraded');
      scheduleRetry();
    };
    const updateCombinedState = () => {
      if (!active) return;
      if (inboxSubscribed && controlSubscribed) {
        degraded = false;
        retryCount = 0;
        clearRetryTimer();
        armHeartbeatWatchdog();
        onStateChange('subscribed');
      } else if (!degraded) {
        onStateChange('connecting');
      }
    };
    const endAccess = () => {
      if (!active || accessEnded) return;
      accessEnded = true;
      clearRetryTimer();
      clearHeartbeatTimer();
      // Removing the socket first prevents subsequent cached events from
      // racing the local session teardown.
      void client.removeAllChannels().finally(onAccessEnded);
    };

    const connect = async () => {
      if (!active || accessEnded) return;
      const myGeneration = ++generation;
      const isCurrent = () => active && !accessEnded && generation === myGeneration;
      if (!degraded) onStateChange('connecting');
      try {
        await client.realtime.setAuth(accessToken);
      } catch {
        if (!isCurrent()) return;
        if (degraded) enterDegraded();
        else onStateChange('error');
        return;
      }
      if (!isCurrent()) return;

      inbox = client.channel(`org:${organizationId}:user:${userId}:inbox`, {
        config: { private: true, broadcast: { ack: true, self: false } },
      });
      inbox.on('broadcast', { event: INBOX_EVENT }, (payload) => {
        if (!isCurrent()) return;
        const parsed = parseInboxInvalidation(payload, INBOX_EVENT, organizationId);
        if (parsed) onInvalidate(parsed);
      });
      inbox.subscribe((status) => {
        if (!isCurrent()) return;
        if (status === 'SUBSCRIBED') {
          inboxSubscribed = true;
          updateCombinedState();
          // Refetch after every successful join. This closes the gap created by
          // disconnects, background suspension, and server fanout retries.
          onReconcile();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          inboxSubscribed = false;
          enterDegraded();
        }
      });

      control = client.channel(`org:${organizationId}:user:${userId}:control`, {
        config: { private: true, broadcast: { ack: true, self: false } },
      });
      for (const event of CONTROL_EVENTS) {
        control.on('broadcast', { event }, () => {
          if (!isCurrent()) return;
          endAccess();
        });
      }
      control.subscribe((status) => {
        if (!isCurrent()) return;
        if (status === 'SUBSCRIBED') {
          controlSubscribed = true;
          updateCombinedState();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          controlSubscribed = false;
          enterDegraded();
        }
      });
    };

    client.realtime.onHeartbeat?.((status: string) => {
      if (!active || accessEnded) return;
      if (status === 'ok') armHeartbeatWatchdog();
    });
    armHeartbeatWatchdog();

    void connect();

    return () => {
      active = false;
      onStateChange('idle');
      clearRetryTimer();
      clearHeartbeatTimer();
      teardownChannels();
    };
  }, [
    accessToken,
    enabled,
    onAccessEnded,
    onInvalidate,
    onReconcile,
    onStateChange,
    organizationId,
    resubscribeNonce,
    userId,
  ]);
}
