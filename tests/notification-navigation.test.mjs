import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { notificationDestination } from '../apps/newone/src/device/notification-route.mjs';

const organizationId = '00000000-0000-4000-8000-000000000001';
const conversationId = '00000000-0000-4000-8000-000000000002';
const announcementId = '00000000-0000-4000-8000-000000000003';
const handoffId = '00000000-0000-4000-8000-000000000004';

test('push envelopes map only server-known event shapes to internal routes', () => {
  assert.deepEqual(notificationDestination({
    event_type: 'message.changed',
    organization_id: organizationId,
    conversation_id: conversationId,
    message_id: 41,
  }), {
    organizationId,
    href: `/conversation/${conversationId}`,
    key: `message:${conversationId}:41`,
  });
  assert.equal(notificationDestination({
    event_type: 'announcement.changed',
    organization_id: organizationId,
    announcement_id: announcementId,
  })?.href, '/updates');
  assert.equal(notificationDestination({
    event_type: 'handoff.changed',
    organization_id: organizationId,
    handoff_id: handoffId,
  })?.href, '/handoffs');
});

test('push envelopes cannot inject URLs or malformed tenant/entity identifiers', () => {
  const attempts = [
    { event_type: 'message.changed', organization_id: organizationId, url: 'https://evil.test' },
    { event_type: 'message.changed', organization_id: organizationId, conversation_id: '../admin', message_id: 1 },
    { event_type: 'message.changed', organization_id: organizationId, conversation_id: conversationId, message_id: 0 },
    { event_type: 'announcement.changed', organization_id: 'not-a-uuid', announcement_id: announcementId },
    { event_type: 'unknown', organization_id: organizationId, conversation_id: conversationId },
  ];
  for (const attempt of attempts) assert.equal(notificationDestination(attempt), null);
});

test('native notification bridge covers cold start, response replay, tenant binding, and badges', () => {
  const nativeBridge = readFileSync(
    'apps/newone/src/device/notification-navigation.native.ts',
    'utf8',
  );
  assert.match(nativeBridge, /getLastNotificationResponseAsync/);
  assert.match(nativeBridge, /addNotificationResponseReceivedListener/);
  assert.match(nativeBridge, /clearLastNotificationResponseAsync/);
  assert.match(nativeBridge, /destination\.organizationId !== organizationIdRef\.current/);
  assert.match(nativeBridge, /handledRef/);
  assert.match(nativeBridge, /setBadgeCountAsync/);
  assert.doesNotMatch(nativeBridge, /Linking\.openURL|data\.url|data\.href/);
});
