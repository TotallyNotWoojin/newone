import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  createOutboxWorkerHandler,
  notificationSuppressed,
  type OutboxWorkerDependencies,
  parsePushPage,
  providerPushData,
  type PushDelivery,
  type PushEvent,
  type PushJob,
} from '../newone-outbox-worker/handler.ts';
import { assertEquals, assertRejects } from './assert.ts';

const organizationId = '00000000-0000-4000-8000-000000000001';
const conversationId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';
const deviceId = '00000000-0000-4000-8000-000000000004';
const installationId = '00000000-0000-4000-8000-000000000005';
const projectId = '00000000-0000-4000-8000-000000000006';
const workerToken = 'worker-token-that-is-at-least-32-characters';
const secretKey = 'server-secret-key';
const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65_536,
  networkHashKey: 'n'.repeat(32),
  allowHttpLocal: false,
};

const job: PushJob = { id: '50', organizationId, topic: 'push', attempts: 1 };
const rawDelivery = {
  attempt_id: '70',
  device_id: deviceId,
  dispatch_status: 'pending',
  dispatchable: true,
  next_attempt_at: null,
  user_id: userId,
  installation_id: installationId,
  platform: 'ios',
  push_token_type: 'expo',
  push_project_id: projectId,
  push_environment: 'production',
  push_token_ciphertext: 'x'.repeat(80),
  locale: 'en-US',
  app_version: '1.0.0',
  currently_off_shift: false,
  notification_class: 'routine',
  critical_category: null,
  quiet_hours_override: false,
  quiet_hours_override_reason: null,
  preferences: {
    notification_preview: 'generic',
    sound_enabled: true,
    vibration_enabled: true,
    shift_aware_suppression: false,
    time_zone: 'UTC',
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_days: [],
  },
};
const rawEvent = {
  event_type: 'message.changed',
  organization_id: organizationId,
  conversation_id: conversationId,
  message_id: '42',
};
const basePage = {
  job_id: '50',
  event: rawEvent,
  deliveries: [rawDelivery],
  has_more: false,
  next_device_id: null,
};

async function rejectsPage(value: unknown): Promise<void> {
  await assertRejects(
    () => parsePushPage(value, job),
    (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
  );
}

function pageWithDelivery(
  delivery: Record<string, unknown>,
  preferences: Record<string, unknown> = {},
) {
  return {
    ...basePage,
    deliveries: [{
      ...rawDelivery,
      ...delivery,
      preferences: { ...rawDelivery.preferences, ...preferences },
    }],
  };
}

Deno.test('outbox push page rejects timestamp, cursor, organization, and cardinality drift', async () => {
  for (const timestamp of [1, 'short', 'x'.repeat(41), '2026-99-99T99:99:99Z']) {
    await rejectsPage(pageWithDelivery({ next_attempt_at: timestamp }));
  }
  await rejectsPage({
    ...basePage,
    event: { ...rawEvent, organization_id: conversationId },
  });
  await rejectsPage({ ...basePage, deliveries: Array.from({ length: 501 }, () => rawDelivery) });
  await rejectsPage({ ...basePage, has_more: false, next_device_id: deviceId });
  const paged = parsePushPage({ ...basePage, has_more: true, next_device_id: deviceId }, job);
  assertEquals(paged.hasMore, true);
  assertEquals(paged.nextDeviceId, deviceId);
  const scheduled = parsePushPage(
    pageWithDelivery({ next_attempt_at: '2026-08-04T12:00:00Z', locale: null }),
    job,
  );
  assertEquals(scheduled.deliveries[0]?.locale, null);
});

Deno.test('outbox push page rejects malformed quiet-time preferences and dispatchability', async () => {
  await rejectsPage(pageWithDelivery({ dispatchable: false }));
  await rejectsPage(pageWithDelivery({}, { quiet_days: 'monday' }));
  await rejectsPage(pageWithDelivery({}, { quiet_days: [0, 1, 2, 3, 4, 5, 6, 0] }));
  await rejectsPage(pageWithDelivery({}, { quiet_days: [1, 1] }));
  await rejectsPage(pageWithDelivery({}, { quiet_hours_start: '25:00', quiet_hours_end: '06:00' }));
  await rejectsPage(pageWithDelivery({}, { quiet_hours_start: '22:00', quiet_hours_end: null }));
  await rejectsPage(pageWithDelivery({}, { quiet_hours_start: null, quiet_hours_end: '06:00' }));
});

Deno.test('outbox push page rejects incoherent routine and override classifications', async () => {
  const invalid: Array<Record<string, unknown>> = [
    { notification_class: 'routine', critical_category: 'safety' },
    {
      notification_class: 'routine',
      quiet_hours_override: true,
      critical_category: 'safety',
      quiet_hours_override_reason: 'Safety override',
    },
    { notification_class: 'routine', quiet_hours_override_reason: 'Unexpected reason' },
    {
      notification_class: 'urgent',
      quiet_hours_override: true,
      critical_category: null,
      quiet_hours_override_reason: 'Urgent override',
    },
    {
      notification_class: 'urgent',
      quiet_hours_override: true,
      critical_category: 'operations',
      quiet_hours_override_reason: null,
    },
  ];
  for (const delivery of invalid) await rejectsPage(pageWithDelivery(delivery));

  const valid = parsePushPage(
    pageWithDelivery({
      notification_class: 'urgent',
      quiet_hours_override: true,
      critical_category: 'operations',
      quiet_hours_override_reason: 'Operational incident',
    }),
    job,
  );
  assertEquals(valid.deliveries[0]?.quietHoursOverride, true);
});

Deno.test('outbox event binding rejects missing identifiers for every event family', async () => {
  for (
    const event of [
      { event_type: 'announcement.changed', organization_id: organizationId },
      { event_type: 'handoff.changed', organization_id: organizationId },
      { event_type: 'conversation.changed', organization_id: organizationId },
    ]
  ) {
    await rejectsPage({ ...basePage, event });
  }
});

const event: PushEvent = {
  eventType: 'message.changed',
  organizationId,
  conversationId,
  messageId: '42',
};
const delivery: PushDelivery = {
  attemptId: '70',
  deviceId,
  userId,
  installationId,
  platform: 'ios',
  pushTokenType: 'expo',
  pushProjectId: projectId,
  pushEnvironment: 'production',
  protectedToken: 'x'.repeat(80),
  locale: 'en-US',
  currentlyOffShift: false,
  notificationClass: 'routine',
  criticalCategory: null,
  quietHoursOverride: false,
  overrideReason: null,
  preferences: {
    notificationPreview: 'generic',
    soundEnabled: true,
    vibrationEnabled: true,
    shiftAwareSuppression: false,
    timeZone: 'UTC',
    quietHoursStart: null,
    quietHoursEnd: null,
    quietDays: [],
  },
};

function quietDelivery(start: string, end: string, days: number[]): PushDelivery {
  return {
    ...delivery,
    preferences: {
      ...delivery.preferences,
      quietHoursStart: start,
      quietHoursEnd: end,
      quietDays: days,
    },
  };
}

Deno.test('notification suppression evaluates equal, daytime, overnight, and invalid zones', () => {
  const mondayNoon = new Date('2026-08-03T12:00:00Z');
  assertEquals(
    notificationSuppressed(quietDelivery('10:00', '10:00', [1]), event, mondayNoon),
    true,
  );
  assertEquals(
    notificationSuppressed(quietDelivery('10:00', '10:00', []), event, mondayNoon),
    false,
  );
  assertEquals(
    notificationSuppressed(quietDelivery('10:00', '14:00', [1]), event, mondayNoon),
    true,
  );
  assertEquals(
    notificationSuppressed(quietDelivery('10:00', '14:00', []), event, mondayNoon),
    false,
  );
  assertEquals(
    notificationSuppressed(
      quietDelivery('10:00', '14:00', [1]),
      event,
      new Date('2026-08-03T15:00:00Z'),
    ),
    false,
  );
  assertEquals(
    notificationSuppressed(
      quietDelivery('22:00', '06:00', [1]),
      event,
      new Date('2026-08-03T23:00:00Z'),
    ),
    true,
  );
  assertEquals(
    notificationSuppressed(
      quietDelivery('22:00', '06:00', [1]),
      event,
      new Date('2026-08-04T02:00:00Z'),
    ),
    true,
  );
  assertEquals(
    notificationSuppressed(quietDelivery('22:00', '06:00', [1]), event, mondayNoon),
    false,
  );
  assertEquals(
    notificationSuppressed(
      {
        ...quietDelivery('10:00', '14:00', [1]),
        preferences: {
          ...quietDelivery('10:00', '14:00', [1]).preferences,
          timeZone: 'Invalid/Zone',
        },
      },
      event,
      mondayNoon,
    ),
    true,
  );
});

Deno.test('notification suppression short-circuits override and shift predicates safely', () => {
  assertEquals(
    notificationSuppressed({ ...delivery, quietHoursOverride: true }, event),
    false,
  );
  assertEquals(
    notificationSuppressed({
      ...delivery,
      notificationClass: 'urgent',
      quietHoursOverride: true,
      overrideReason: null,
    }, event),
    false,
  );
  assertEquals(
    notificationSuppressed({
      ...delivery,
      preferences: { ...delivery.preferences, shiftAwareSuppression: true },
      currentlyOffShift: false,
    }, event),
    false,
  );
});

Deno.test('provider payload omits absent optional event identifiers', () => {
  assertEquals(providerPushData({ eventType: 'conversation.changed', organizationId }, delivery), {
    event_type: 'conversation.changed',
    organization_id: organizationId,
    notification_preview: 'generic',
    notification_class: 'routine',
  });
});

function outboxDependencies(
  overrides: Partial<OutboxWorkerDependencies> = {},
): OutboxWorkerDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey,
    },
    workerToken,
    topics: ['push'],
    claim: async () => ({ topics: ['push'], jobs: [] }),
    dispatchPush: async () => {},
    dispatchRealtime: async () => {},
    expandModeration: async () => {},
    purgeStorage: async () => {},
    executeSessionRevoke: async () => {},
    dispatchDynamicGroup: async () => {},
    complete: async () => {},
    fail: async () => {},
    ...overrides,
  };
}

function outboxRequest(headers: HeadersInit = {}, method = 'POST'): Request {
  return new Request('https://project.supabase.co/functions/v1/newone-outbox-worker', {
    method,
    headers: {
      apikey: secretKey,
      'X-Newone-Worker-Token': workerToken,
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
}

Deno.test('outbox handler covers default limits, method guard, and credential absence', async () => {
  const observed: number[] = [];
  const correlations: string[] = [];
  const success = await createOutboxWorkerHandler(() =>
    outboxDependencies({
      setCorrelationId: (value) => correlations.push(value),
      claim: async (_worker, _topics, limit) => {
        observed.push(limit);
        return { topics: ['push'], jobs: [] };
      },
    })
  )(outboxRequest());
  assertEquals(success.status, 200);
  assertEquals(observed, [3]);
  assertEquals(correlations.length, 1);

  assertEquals(
    (await createOutboxWorkerHandler(() => outboxDependencies())(outboxRequest({}, 'GET'))).status,
    405,
  );
  for (
    const headers of [
      { apikey: '' },
      { 'X-Newone-Worker-Token': '' },
      { Cookie: 'session=value' },
    ] as Array<Record<string, string>>
  ) {
    const response = await createOutboxWorkerHandler(() => outboxDependencies())(
      outboxRequest(headers),
    );
    assertEquals(response.status, headers.Cookie ? 403 : 401);
  }
  const origin = await createOutboxWorkerHandler(() =>
    outboxDependencies({
      runtimeConfig: {
        ...runtimeConfig,
        allowedOrigins: new Set(['https://browser.example']),
      },
    })
  )(outboxRequest({ Origin: 'https://browser.example' }));
  assertEquals(origin.status, 403);
});
