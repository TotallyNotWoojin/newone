import { useCallback, useEffect, useRef, useState } from 'react';

import { getRealtimeClient } from '@/lib/supabase';

export const TYPING_BROADCAST_INTERVAL_MS = 3000;
export const TYPING_EXPIRY_MS = 6000;

const TYPING_EVENT = 'typing';
const STOPPED_EVENT = 'stopped';

export interface TypingPeer {
  userId: string;
  displayName: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Parse a typing broadcast body. Realtime-js wraps Broadcast bodies in
 * `payload`; accept both shapes but validate every field, and drop the local
 * user's own events even if the server echoes them back.
 */
export function parseTypingPeer(raw: unknown, selfUserId: string): TypingPeer | null {
  const outer = record(raw);
  const value = record(outer.payload ?? outer);
  const userId = value.userId;
  const displayName = value.displayName;
  if (typeof userId !== 'string' || userId.length === 0 || userId === selfUserId) return null;
  if (typeof displayName !== 'string' || displayName.length === 0) return null;
  return { userId, displayName };
}

/**
 * Ephemeral typing hints for one open conversation.
 *
 * The channel is broadcast-only and carries no message data; membership
 * authorization is enforced server-side for the private topic. Peers expire
 * locally 6 seconds after their last event so a dropped `stopped` broadcast
 * can never pin a stale indicator.
 */
export function useConversationTyping(input: {
  enabled: boolean;
  organizationId: string;
  conversationId: string;
  userId: string;
  displayName: string;
  accessToken?: string;
}) {
  const { enabled, organizationId, conversationId, userId, displayName, accessToken } = input;
  const [typingPeers, setTypingPeers] = useState<TypingPeer[]>([]);
  const channelRef = useRef<{
    send: (message: { type: 'broadcast'; event: string; payload: TypingPeer }) => Promise<unknown>;
  } | null>(null);
  const subscribedRef = useRef(false);
  const lastBroadcastAtRef = useRef(0);
  const expiryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const identityRef = useRef({ userId, displayName });

  useEffect(() => {
    identityRef.current = { userId, displayName };
  }, [displayName, userId]);

  useEffect(() => {
    const client = getRealtimeClient();
    if (!enabled || !client || !organizationId || !conversationId || !userId || !accessToken) {
      return;
    }

    let active = true;
    const expiryTimers = expiryTimersRef.current;
    const removePeer = (peerUserId: string) => {
      const timer = expiryTimers.get(peerUserId);
      if (timer) clearTimeout(timer);
      expiryTimers.delete(peerUserId);
      setTypingPeers((current) => current.filter((peer) => peer.userId !== peerUserId));
    };
    let channel: ReturnType<typeof client.channel> | null = null;

    void client.realtime.setAuth(accessToken).then(() => {
      if (!active) return;
      channel = client.channel(`org:${organizationId}:conversation:${conversationId}:typing`, {
        config: { private: true, broadcast: { self: false, ack: false } },
      });
      channel.on('broadcast', { event: TYPING_EVENT }, (payload) => {
        if (!active) return;
        const peer = parseTypingPeer(payload, identityRef.current.userId);
        if (!peer) return;
        const existing = expiryTimers.get(peer.userId);
        if (existing) clearTimeout(existing);
        expiryTimers.set(peer.userId, setTimeout(() => {
          if (active) removePeer(peer.userId);
        }, TYPING_EXPIRY_MS));
        setTypingPeers((current) => {
          const others = current.filter((item) => item.userId !== peer.userId);
          return [...others, peer];
        });
      });
      channel.on('broadcast', { event: STOPPED_EVENT }, (payload) => {
        if (!active) return;
        const peer = parseTypingPeer(payload, identityRef.current.userId);
        if (peer) removePeer(peer.userId);
      });
      channel.subscribe((status) => {
        if (!active) return;
        subscribedRef.current = status === 'SUBSCRIBED';
      });
      channelRef.current = channel;
    }).catch(() => {
      // Typing hints are best-effort presence; messaging stays authoritative.
    });

    return () => {
      active = false;
      subscribedRef.current = false;
      lastBroadcastAtRef.current = 0;
      for (const timer of expiryTimers.values()) clearTimeout(timer);
      expiryTimers.clear();
      setTypingPeers([]);
      channelRef.current = null;
      if (channel) void client.removeChannel(channel);
    };
  }, [accessToken, conversationId, enabled, organizationId, userId]);

  const notifyTyping = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || !subscribedRef.current) return;
    const now = Date.now();
    if (now - lastBroadcastAtRef.current < TYPING_BROADCAST_INTERVAL_MS) return;
    lastBroadcastAtRef.current = now;
    void channel.send({
      type: 'broadcast',
      event: TYPING_EVENT,
      payload: { userId: identityRef.current.userId, displayName: identityRef.current.displayName },
    });
  }, []);

  const notifyStopped = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || !subscribedRef.current || lastBroadcastAtRef.current === 0) return;
    lastBroadcastAtRef.current = 0;
    void channel.send({
      type: 'broadcast',
      event: STOPPED_EVENT,
      payload: { userId: identityRef.current.userId, displayName: identityRef.current.displayName },
    });
  }, []);

  return { typingPeers, notifyTyping, notifyStopped };
}
