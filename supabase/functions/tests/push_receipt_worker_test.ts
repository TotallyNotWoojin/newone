import type { ExpoReceiptResult } from '../_shared/expo-push.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  createPushReceiptWorkerHandler,
  type PushReceiptWorkerDependencies,
} from '../newone-push-receipt-worker/handler.ts';
import { assertEquals } from './assert.ts';

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
const serverKey = 'server-secret-key';

function dependencies(
  overrides: Partial<PushReceiptWorkerDependencies> = {},
): PushReceiptWorkerDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: serverKey,
    },
    workerToken,
    claim: async () => ({
      receipts: [{
        attempt_id: 801,
        organization_id: '00000000-0000-4000-8000-000000000001',
        job_id: 701,
        device_id: '00000000-0000-4000-8000-000000000060',
        provider_ticket_id: 'ticket-001',
        provider_accepted_at: '2026-08-03T10:00:00Z',
      }],
    }),
    poll: async () => [{
      providerTicketId: 'ticket-001',
      result: 'delivered',
      errorCode: null,
    }],
    record: async () => {},
    now: () => new Date('2026-08-03T10:16:00Z'),
    ...overrides,
  };
}

function request(token = workerToken): Request {
  return new Request('https://project.supabase.co/functions/v1/newone-push-receipt-worker', {
    method: 'POST',
    headers: {
      apikey: serverKey,
      'X-Newone-Worker-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 100 }),
  });
}

Deno.test('receipt worker records provider handoff separately from ticket acceptance', async () => {
  const recorded: ExpoReceiptResult[] = [];
  const handler = createPushReceiptWorkerHandler(() =>
    dependencies({
      record: async (_workerId, _claim, result) => {
        if ('providerTicketId' in result) recorded.push(result);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { claimed: 1, delivered: 1, pending: 0, failed: 0 });
  assertEquals(recorded[0]?.result, 'delivered');
});

Deno.test('receipt worker expires tickets after provider retention and never polls them', async () => {
  const events: string[] = [];
  const handler = createPushReceiptWorkerHandler(() =>
    dependencies({
      now: () => new Date('2026-08-04T10:00:01Z'),
      poll: async () => {
        events.push('poll');
        return [];
      },
      record: async (_workerId, _claim, result) => {
        events.push(`record:${result.result}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(events, ['record:expired']);
  assertEquals((await response.json()).failed, 1);
});

Deno.test('receipt worker requires dual service authentication before claiming', async () => {
  let claimed = false;
  const handler = createPushReceiptWorkerHandler(() =>
    dependencies({
      claim: async () => {
        claimed = true;
        return { receipts: [] };
      },
    })
  );
  assertEquals((await handler(request('wrong-token'))).status, 401);
  assertEquals(claimed, false);
});
