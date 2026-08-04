import type { Href } from 'expo-router';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef } from 'react';

import { notificationDestination } from '@/device/notification-route.mjs';

interface NotificationNavigationOptions {
  enabled: boolean;
  organizationId: string | null;
  badgeCount: number;
}

function responseKey(response: Notifications.NotificationResponse) {
  return `${response.notification.request.identifier}:${response.actionIdentifier}`;
}

/** Handles foreground, background, and cold-start notification taps exactly once. */
export function useNotificationNavigation({
  enabled,
  organizationId,
  badgeCount,
}: NotificationNavigationOptions) {
  const router = useRouter();
  const enabledRef = useRef(enabled);
  const organizationIdRef = useRef(organizationId);
  const pendingRef = useRef<Notifications.NotificationResponse | null>(null);
  const handledRef = useRef(new Set<string>());

  useEffect(() => {
    enabledRef.current = enabled;
    organizationIdRef.current = organizationId;
  }, [enabled, organizationId]);

  const clearLastResponse = useCallback(() => {
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  }, []);

  const handleResponse = useCallback((response: Notifications.NotificationResponse) => {
    const key = responseKey(response);
    if (handledRef.current.has(key)) return;
    const destination = notificationDestination(response.notification.request.content.data);

    if (
      response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER
      || !destination
    ) {
      handledRef.current.add(key);
      clearLastResponse();
      return;
    }

    if (!enabledRef.current || !organizationIdRef.current) {
      pendingRef.current = response;
      return;
    }

    handledRef.current.add(key);
    pendingRef.current = null;
    clearLastResponse();
    void Notifications.setBadgeCountAsync(0).catch(() => false);
    if (destination.organizationId !== organizationIdRef.current) return;
    router.push(destination.href as Href);
  }, [clearLastResponse, router]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    let active = true;
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (active && response) handleResponse(response);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      subscription.remove();
    };
  }, [handleResponse]);

  useEffect(() => {
    if (enabled && organizationId && pendingRef.current) handleResponse(pendingRef.current);
  }, [enabled, handleResponse, organizationId]);

  useEffect(() => {
    if (!enabled || !organizationId) return;
    const boundedBadgeCount = Math.min(99, Math.max(0, Math.trunc(badgeCount)));
    void Notifications.setBadgeCountAsync(boundedBadgeCount).catch(() => false);
  }, [badgeCount, enabled, organizationId]);
}
