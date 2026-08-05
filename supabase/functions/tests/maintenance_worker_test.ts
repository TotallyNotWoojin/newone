import type { RuntimeConfig } from '../_shared/http.ts';
import {
  createMaintenanceWorkerHandler,
  type MaintenanceWorkerDependencies,
  parseHandoffResult,
  parseObligationResult,
  parsePromotionResult,
} from '../newone-maintenance-worker/handler.ts';
import { assertEquals, assertRejects } from './assert.ts';

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65_536,
  networkHashKey: 'n'.repeat(32),
  allowHttpLocal: false,
};
const workerToken = 'worker-token-that-is-at-least-32-characters';
const secretKey = 'server-secret-key';
const announcementId = '00000000-0000-4000-8000-000000000080';
const handoffId = '00000000-0000-4000-8000-000000000081';
const escalatedHandoffId = '00000000-0000-4000-8000-000000000084';
const recipientId = '00000000-0000-4000-8000-000000000082';
const escalatedRecipientId = '00000000-0000-4000-8000-000000000083';
const announcementRecipientKey = `${announcementId}:${recipientId}:reminder:1`;

function dependencies(
  overrides: Partial<MaintenanceWorkerDependencies> = {},
): MaintenanceWorkerDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey,
    },
    workerToken,
    promote: async () => ({
      processed: 1,
      promoted: 1,
      blocked: 0,
      announcement_ids: [announcementId],
      blocked_announcement_ids: [],
      snapshot_basis: 'reevaluated_at_scheduled_publish',
    }),
    processAnnouncementObligations: async () => ({
      processed: 2,
      reminders_enqueued: 1,
      escalations_enqueued: 1,
      sms_fallback_available: false,
      announcement_recipient_keys: [
        announcementRecipientKey,
        `${announcementId}:${escalatedRecipientId}:escalated`,
      ],
    }),
    processOverdueHandoffs: async () => ({
      processed: 2,
      reminders_enqueued: 1,
      escalations_enqueued: 1,
      sms_fallback_available: false,
      handoff_keys: [`${handoffId}:reminder:1`, `${escalatedHandoffId}:escalated`],
    }),
    ...overrides,
  };
}

function request(token = workerToken): Request {
  return new Request(
    'https://project.supabase.co/functions/v1/newone-maintenance-worker',
    {
      method: 'POST',
      headers: {
        apikey: secretKey,
        'X-Newone-Worker-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );
}

Deno.test('maintenance worker promotes schedules then enqueues notice and handoff escalation', async () => {
  const calls: string[] = [];
  const handler = createMaintenanceWorkerHandler(() =>
    dependencies({
      promote: async () => {
        calls.push('promote');
        return {
          processed: 1,
          promoted: 1,
          blocked: 0,
          announcement_ids: [announcementId],
          blocked_announcement_ids: [],
          snapshot_basis: 'reevaluated_at_scheduled_publish',
        };
      },
      processAnnouncementObligations: async () => {
        calls.push('announcement-obligations');
        return {
          processed: 2,
          reminders_enqueued: 1,
          escalations_enqueued: 1,
          sms_fallback_available: false,
          announcement_recipient_keys: [
            announcementRecipientKey,
            `${announcementId}:${escalatedRecipientId}:escalated`,
          ],
        };
      },
      processOverdueHandoffs: async () => {
        calls.push('handoff-escalations');
        return {
          processed: 2,
          reminders_enqueued: 1,
          escalations_enqueued: 1,
          sms_fallback_available: false,
          handoff_keys: [`${handoffId}:reminder:1`, `${escalatedHandoffId}:escalated`],
        };
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(calls, ['promote', 'announcement-obligations', 'handoff-escalations']);
  assertEquals(await response.json(), {
    promotions: {
      processed: 1,
      promoted: 1,
      blocked: 0,
      announcementIds: [announcementId],
      blockedAnnouncementIds: [],
      snapshotBasis: 'reevaluated_at_scheduled_publish',
    },
    announcementObligations: {
      processed: 2,
      remindersEnqueued: 1,
      escalationsEnqueued: 1,
      announcementRecipientKeys: [
        announcementRecipientKey,
        `${announcementId}:${escalatedRecipientId}:escalated`,
      ],
    },
    overdueHandoffs: {
      processed: 2,
      remindersEnqueued: 1,
      escalationsEnqueued: 1,
      handoffKeys: [`${handoffId}:reminder:1`, `${escalatedHandoffId}:escalated`],
    },
    smsFallbackAvailable: false,
  });
});

Deno.test('maintenance worker requires dual service authentication before any RPC', async () => {
  let called = false;
  const handler = createMaintenanceWorkerHandler(() =>
    dependencies({
      promote: async () => {
        called = true;
        return { processed: 0, promoted: 0, announcement_ids: [] };
      },
    })
  );
  assertEquals((await handler(request('wrong-token'))).status, 401);
  assertEquals(called, false);
});

Deno.test('maintenance results fail closed if SMS is falsely reported available', async () => {
  await assertRejects(() =>
    parseObligationResult({
      processed: 0,
      reminders_enqueued: 0,
      escalations_enqueued: 0,
      sms_fallback_available: true,
      announcement_recipient_keys: [],
    }, 100)
  );
  await assertRejects(() =>
    parseHandoffResult({
      processed: 0,
      reminders_enqueued: 0,
      escalations_enqueued: 0,
      sms_fallback_available: true,
      handoff_keys: [],
    }, 100)
  );
});

Deno.test('maintenance results bind enqueue counts to canonical recipient keys', async () => {
  await assertRejects(() =>
    parseObligationResult({
      processed: 1,
      reminders_enqueued: 1,
      escalations_enqueued: 0,
      sms_fallback_available: false,
      announcement_recipient_keys: [`${announcementId}:recipient-1`],
    }, 100)
  );
  await assertRejects(() =>
    parseObligationResult({
      processed: 1,
      reminders_enqueued: 1,
      escalations_enqueued: 0,
      sms_fallback_available: false,
      announcement_recipient_keys: [],
    }, 100)
  );
  await assertRejects(() =>
    parseHandoffResult({
      processed: 1,
      reminders_enqueued: 0,
      escalations_enqueued: 1,
      sms_fallback_available: false,
      handoff_keys: [],
    }, 100)
  );
});

Deno.test('promotion results bind promoted and blocked schedules to reevaluation evidence', async () => {
  assertEquals(
    parsePromotionResult({
      processed: 1,
      promoted: 0,
      blocked: 1,
      announcement_ids: [],
      blocked_announcement_ids: [announcementId],
      snapshot_basis: 'reevaluated_at_scheduled_publish',
    }, 100),
    {
      processed: 1,
      promoted: 0,
      blocked: 1,
      announcementIds: [],
      blockedAnnouncementIds: [announcementId],
      snapshotBasis: 'reevaluated_at_scheduled_publish',
    },
  );
  await assertRejects(() =>
    parsePromotionResult({
      processed: 1,
      promoted: 1,
      blocked: 1,
      announcement_ids: [announcementId],
      blocked_announcement_ids: [announcementId],
      snapshot_basis: 'scheduled_without_audience_reevaluation',
    }, 100)
  );
});
