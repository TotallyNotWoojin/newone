import { useEffect } from 'react';

import { getRealtimeClient } from '@/lib/supabase';

export type RealtimeState = 'idle' | 'connecting' | 'subscribed' | 'error';

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
 */
export function useUserRealtime(input: {
  enabled: boolean;
  organizationId: string;
  userId: string;
  accessToken?: string;
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

    const updateCombinedState = () => {
      if (!active) return;
      onStateChange(inboxSubscribed && controlSubscribed ? 'subscribed' : 'connecting');
    };
    const endAccess = () => {
      if (!active || accessEnded) return;
      accessEnded = true;
      // Removing the socket first prevents subsequent cached events from
      // racing the local session teardown.
      void client.removeAllChannels().finally(onAccessEnded);
    };

    onStateChange('connecting');
    void client.realtime.setAuth(accessToken).then(() => {
      if (!active) return;

      inbox = client.channel(`org:${organizationId}:user:${userId}:inbox`, {
        config: { private: true, broadcast: { ack: true, self: false } },
      });
      inbox.on('broadcast', { event: INBOX_EVENT }, (payload) => {
        if (!active || accessEnded) return;
        const parsed = parseInboxInvalidation(payload, INBOX_EVENT, organizationId);
        if (parsed) onInvalidate(parsed);
      });
      inbox.subscribe((status) => {
        if (!active || accessEnded) return;
        if (status === 'SUBSCRIBED') {
          inboxSubscribed = true;
          updateCombinedState();
          // Refetch after every successful join. This closes the gap created by
          // disconnects, background suspension, and server fanout retries.
          onReconcile();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          inboxSubscribed = false;
          onStateChange('error');
        } else if (status === 'CLOSED') {
          inboxSubscribed = false;
          updateCombinedState();
        }
      });

      control = client.channel(`org:${organizationId}:user:${userId}:control`, {
        config: { private: true, broadcast: { ack: true, self: false } },
      });
      for (const event of CONTROL_EVENTS) {
        control.on('broadcast', { event }, endAccess);
      }
      control.subscribe((status) => {
        if (!active || accessEnded) return;
        if (status === 'SUBSCRIBED') {
          controlSubscribed = true;
          updateCombinedState();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          controlSubscribed = false;
          onStateChange('error');
        } else if (status === 'CLOSED') {
          controlSubscribed = false;
          updateCombinedState();
        }
      });
    }).catch(() => {
      if (active) onStateChange('error');
    });

    return () => {
      active = false;
      onStateChange('idle');
      if (inbox) void client.removeChannel(inbox);
      if (control) void client.removeChannel(control);
    };
  }, [
    accessToken,
    enabled,
    onAccessEnded,
    onInvalidate,
    onReconcile,
    onStateChange,
    organizationId,
    userId,
  ]);
}
