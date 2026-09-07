// Backlog 47(f): naming somebody in a group notifies them.
//
// The resolver does the work in SQL — a mention now gets through a temporary
// mute, and the title of a notification that names you starts with "@". What
// this file guards is the contract that made those two changes shippable on
// their own: the delivery shape did not grow a key, so the worker's strict page
// parser accepts a mention-marked delivery exactly as it accepts any other, and
// the marked title reaches Expo unchanged rather than being trimmed away.
import { parsePushPage, type PushJob } from '../newone-outbox-worker/handler.ts';
import { assert, assertEquals } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000002';
const mentionedUserId = '20000000-0000-4000-8000-000000000003';
const conversationId = '40000000-0000-4000-8000-000000000004';
const deviceId = '60000000-0000-4000-8000-000000000006';
const installationId = '70000000-0000-4000-8000-000000000007';
const projectId = '90000000-0000-4000-8000-000000000009';
const job: PushJob = { id: '50', organizationId, attempts: 1, topic: 'push' };

function deliveryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_id: deviceId,
    attempt_id: '52',
    dispatch_status: 'pending',
    dispatchable: true,
    next_attempt_at: null,
    user_id: userId,
    installation_id: installationId,
    platform: 'ios',
    push_token_type: 'expo',
    push_project_id: projectId,
    push_environment: 'production',
    push_token_ciphertext: 'ciphertext:' + 'x'.repeat(60),
    locale: 'en-US',
    app_version: '3.3.0',
    currently_off_shift: false,
    notification_class: 'routine',
    critical_category: null,
    quiet_hours_override: false,
    quiet_hours_override_reason: null,
    content_title: 'Ana · North gate',
    content_body: 'Can you confirm?',
    translation_pending: false,
    preferences: {
      notification_preview: 'content',
      sound_enabled: true,
      vibration_enabled: true,
      shift_aware_suppression: false,
      time_zone: 'UTC',
      quiet_hours_start: null,
      quiet_hours_end: null,
      quiet_days: [0, 1, 2, 3, 4, 5, 6],
    },
    ...overrides,
  };
}

function page(deliveries: Record<string, unknown>[]): Record<string, unknown> {
  return {
    job_id: '50',
    event: {
      event_type: 'message.changed',
      organization_id: organizationId,
      conversation_id: conversationId,
      message_id: '99',
      state: 'published',
    },
    deliveries,
    has_more: false,
    next_device_id: null,
  };
}

Deno.test('a mention-marked title survives the worker’s page parser unchanged', () => {
  const parsed = parsePushPage(
    page([
      deliveryRow({ user_id: mentionedUserId, content_title: '@ Ana · North gate' }),
      deliveryRow({ device_id: installationId, attempt_id: '53' }),
    ]),
    job,
  );
  assertEquals(parsed.deliveries.map((delivery) => delivery.contentTitle), [
    '@ Ana · North gate',
    'Ana · North gate',
  ]);
  assertEquals(parsed.deliveries.map((delivery) => delivery.userId), [mentionedUserId, userId]);
});

Deno.test('the mention marker needs no new delivery key, so the worker is unchanged', () => {
  // The resolver marks a mention inside content_title rather than beside it.
  // A delivery carrying an unknown key is refused outright, which is exactly
  // why the marker had to go where it went.
  const parsed = parsePushPage(page([deliveryRow({ content_title: '@ Ana' })]), job);
  assertEquals(parsed.deliveries.length, 1);
  let thrown: unknown;
  try {
    parsePushPage(page([deliveryRow({ mentioned: true })]), job);
  } catch (error) {
    thrown = error;
  }
  assert(thrown, 'an unknown delivery key must still be refused');
});

Deno.test('the marker fits inside the title the parser is willing to carry', () => {
  const longest = '@ ' + 'a'.repeat(198);
  assertEquals(longest.length, 200);
  const parsed = parsePushPage(page([deliveryRow({ content_title: longest })]), job);
  assertEquals(parsed.deliveries[0]?.contentTitle, longest);
  let thrown: unknown;
  try {
    parsePushPage(page([deliveryRow({ content_title: '@ ' + 'a'.repeat(199) })]), job);
  } catch (error) {
    thrown = error;
  }
  assert(thrown, 'a title past the cap is still refused');
});

Deno.test('a notification with no content at all is still a valid delivery', () => {
  const parsed = parsePushPage(page([deliveryRow({ content_title: null, content_body: null })]), job);
  assertEquals(parsed.deliveries[0]?.contentTitle, null);
  assertEquals(parsed.deliveries[0]?.contentBody, null);
});
