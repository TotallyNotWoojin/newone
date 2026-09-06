// Server-side mute (backlog 13): a delivery whose registration carries
// notifications_muted is settled as skipped by the outbox worker. Nothing is
// submitted to Expo for it, the attempt is recorded as a permanent outcome with
// the notifications_muted code, and a pending translation never holds the job
// for a muted recipient.
import { protectPushToken } from '../_shared/device-secrets.ts';
import {
  defaultOutboxWorkerDependencies,
  MUTED_DELIVERY_ERROR_CODE,
  mutedSubmissionResult,
  parsePushPage,
  type PushJob,
} from '../newone-outbox-worker/handler.ts';
import { assert, assertEquals } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000002';
const conversationId = '40000000-0000-4000-8000-000000000004';
const workerId = '80000000-0000-4000-8000-000000000008';
const mutedDeviceId = '60000000-0000-4000-8000-000000000006';
const openDeviceId = '60000000-0000-4000-8000-000000000007';
const mutedInstallationId = '70000000-0000-4000-8000-000000000007';
const openInstallationId = '70000000-0000-4000-8000-000000000008';
const projectId = '90000000-0000-4000-8000-000000000009';
const job: PushJob = { id: '50', organizationId, attempts: 1, topic: 'push' };

const environment: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-coverage',
  SUPABASE_SECRET_KEY: 'server-secret-key-for-coverage',
  NEWONE_ALLOWED_WEB_ORIGINS: 'https://app.newone.example',
  NEWONE_NETWORK_HASH_KEY: 'network-key-that-is-long-enough-for-coverage',
  NEWONE_CURSOR_SIGNING_KEY: 'cursor-key-that-is-long-enough-for-coverage',
  NEWONE_PUBLIC_APP_URL: 'https://app.newone.example',
  NEWONE_WORKER_TOKEN: 'worker-token-that-is-long-enough-for-coverage',
  NEWONE_EXPO_ACCESS_TOKEN: 'expo-token-that-is-long-enough',
  NEWONE_EXPO_PROJECT_ID: projectId,
  NEWONE_PUSH_ENVIRONMENT: 'production',
  NEWONE_PUSH_TOKEN_KEY_V1: btoa('k'.repeat(32)).replaceAll('+', '-').replaceAll('/', '_').replace(
    /=+$/,
    '',
  ),
  NEWONE_OUTBOX_TOPICS: 'push',
};

function deliveryRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    device_id: openDeviceId,
    attempt_id: '52',
    dispatch_status: 'pending',
    dispatchable: true,
    next_attempt_at: null,
    user_id: userId,
    installation_id: openInstallationId,
    platform: 'ios',
    push_token_type: 'expo',
    push_project_id: projectId,
    push_environment: 'production',
    push_token_ciphertext: 'ciphertext:' + 'x'.repeat(60),
    locale: 'en-US',
    app_version: '3.1.0',
    currently_off_shift: false,
    notification_class: 'routine',
    critical_category: null,
    quiet_hours_override: false,
    quiet_hours_override_reason: null,
    content_title: 'Ana',
    content_body: 'hola',
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

Deno.test('push page parser reads notifications_muted and defaults it to false', () => {
  const parsed = parsePushPage(
    page([
      deliveryRow({ notifications_muted: true }),
      deliveryRow({ device_id: mutedDeviceId, attempt_id: '51', notifications_muted: false }),
      deliveryRow({ device_id: mutedInstallationId, attempt_id: '53' }),
    ]),
    job,
  );
  assertEquals(parsed.deliveries.map((delivery) => delivery.notificationsMuted), [
    true,
    false,
    false,
  ]);
  const muted = mutedSubmissionResult(parsed.deliveries[0]!);
  assertEquals(muted, {
    attemptId: '52',
    result: 'permanent_failure',
    providerTicketId: null,
    errorCode: MUTED_DELIVERY_ERROR_CODE,
  });
});

interface Recorded {
  rpc: Array<{ name: string; args: Record<string, unknown> }>;
  expoSends: Array<Array<Record<string, unknown>>>;
}

async function withMutedDispatch(
  deliveries: (
    tokens: { muted: string; open: string },
  ) => Record<string, unknown>[],
  run: (recorded: Recorded) => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  const originalFetch = globalThis.fetch;
  const recorded: Recorded = { rpc: [], expoSends: [] };
  try {
    const tokens = {
      muted: await protectPushToken('ExpoPushToken[mutedmutedmuted01]', {
        organizationId,
        userId,
        installationId: mutedInstallationId,
      }),
      open: await protectPushToken('ExpoPushToken[openopenopenopen1]', {
        organizationId,
        userId,
        installationId: openInstallationId,
      }),
    };
    const rows = deliveries(tokens);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.hostname === 'exp.host') {
        recorded.expoSends.push(body as Array<Record<string, unknown>>);
        return Response.json({
          data: (body as unknown[]).map((_entry, index) => ({
            status: 'ok',
            id: `ticket-${index + 1}`,
          })),
          errors: [],
        });
      }
      const marker = '/rest/v1/rpc/';
      const index = url.pathname.indexOf(marker);
      if (index < 0) throw new Error(`unexpected fetch ${url}`);
      const name = decodeURIComponent(url.pathname.slice(index + marker.length));
      const args = body as Record<string, unknown>;
      recorded.rpc.push({ name, args });
      switch (name) {
        case 'bff_resolve_push_job':
          return Response.json(page(rows));
        case 'bff_record_push_submission':
          return Response.json({ attempt_id: args.p_attempt_id, status: 'recorded' });
        case 'bff_complete_push_dispatch_job':
          return Response.json({
            job_id: '50',
            dispatch_completed: true,
            provider_delivery_pending: 0,
          });
        default:
          throw new Error(`unexpected rpc ${name}`);
      }
    }) as typeof fetch;
    await run(recorded);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test('muted registrations are settled as skipped while the rest of the page is sent', async () => {
  await withMutedDispatch(
    (tokens) => [
      deliveryRow({
        device_id: mutedDeviceId,
        attempt_id: '51',
        installation_id: mutedInstallationId,
        push_token_ciphertext: tokens.muted,
        notifications_muted: true,
        // A pending translation must not hold the job for a muted recipient.
        translation_pending: true,
      }),
      deliveryRow({ push_token_ciphertext: tokens.open, notifications_muted: false }),
    ],
    async (recorded) => {
      const dependencies = defaultOutboxWorkerDependencies();
      await dependencies.dispatchPush(workerId, job, workerId);

      // Exactly one provider submission, for the open device only.
      assertEquals(recorded.expoSends.length, 1);
      assertEquals(recorded.expoSends[0]?.length, 1);
      assertEquals(recorded.expoSends[0]?.[0]?.to, 'ExpoPushToken[openopenopenopen1]');

      const submissions = recorded.rpc.filter((call) => call.name === 'bff_record_push_submission');
      assertEquals(submissions.length, 2);
      const muted = submissions.find((call) => call.args.p_attempt_id === '51');
      const open = submissions.find((call) => call.args.p_attempt_id === '52');
      assert(muted && open);
      assertEquals(muted.args.p_result, 'permanent_failure');
      assertEquals(muted.args.p_error_code, MUTED_DELIVERY_ERROR_CODE);
      assertEquals(muted.args.p_provider_ticket_id, null);
      assertEquals(open.args.p_result, 'accepted');
      assertEquals(open.args.p_provider_ticket_id, 'ticket-1');

      // The job completed in the same pass: no translation hold, no retry.
      assertEquals(
        recorded.rpc.filter((call) => call.name === 'bff_complete_push_dispatch_job').length,
        1,
      );
    },
  );
});

Deno.test('a page of only muted registrations completes without touching the provider', async () => {
  await withMutedDispatch(
    (tokens) => [
      deliveryRow({
        device_id: mutedDeviceId,
        attempt_id: '51',
        installation_id: mutedInstallationId,
        push_token_ciphertext: tokens.muted,
        notifications_muted: true,
      }),
    ],
    async (recorded) => {
      const dependencies = defaultOutboxWorkerDependencies();
      await dependencies.dispatchPush(workerId, job, workerId);
      assertEquals(recorded.expoSends.length, 0);
      assertEquals(
        recorded.rpc.map((call) => call.name),
        ['bff_resolve_push_job', 'bff_record_push_submission', 'bff_complete_push_dispatch_job'],
      );
      assertEquals(recorded.rpc[1]?.args.p_error_code, MUTED_DELIVERY_ERROR_CODE);
    },
  );
});
