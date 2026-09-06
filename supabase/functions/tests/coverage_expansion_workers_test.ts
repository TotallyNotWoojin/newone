import { ApiError } from '../_shared/errors.ts';
import type { ExpoReceiptResult } from '../_shared/expo-push.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import type {
  OpenRouterEnvironment,
  OpenRouterLanguageProcessor,
  SummaryResult,
} from '../_shared/openrouter.ts';
import {
  type AiWorkerDependencies,
  createAiWorkerHandler,
  summaryPersistence,
  type SummarySourceResolution,
} from '../newone-ai-worker/handler.ts';
import { type BootstrapDependencies, createBootstrapHandler } from '../newone-bootstrap/handler.ts';
import {
  createMaintenanceWorkerHandler,
  type MaintenanceWorkerDependencies,
  parseHandoffResult,
  parseObligationResult,
  parsePromotionResult,
} from '../newone-maintenance-worker/handler.ts';
import {
  createPushReceiptWorkerHandler,
  type PushReceiptWorkerDependencies,
} from '../newone-push-receipt-worker/handler.ts';
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
const bootstrapToken = 'bootstrap-token-that-is-at-least-32-characters';
const secretKey = 'server-secret-key';
const organizationId = '00000000-0000-4000-8000-000000000001';
const ownerUserId = '00000000-0000-4000-8000-000000000010';
const announcementId = '00000000-0000-4000-8000-000000000080';
const secondAnnouncementId = '00000000-0000-4000-8000-000000000085';
const recipientId = '00000000-0000-4000-8000-000000000082';
const secondRecipientId = '00000000-0000-4000-8000-000000000083';
const handoffId = '00000000-0000-4000-8000-000000000081';
const secondHandoffId = '00000000-0000-4000-8000-000000000084';

function maintenanceDependencies(
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
      processed: 0,
      promoted: 0,
      blocked: 0,
      announcement_ids: [],
      blocked_announcement_ids: [],
      snapshot_basis: 'reevaluated_at_scheduled_publish',
    }),
    processAnnouncementObligations: async () => ({
      processed: 0,
      reminders_enqueued: 0,
      escalations_enqueued: 0,
      sms_fallback_available: false,
      announcement_recipient_keys: [],
    }),
    processOverdueHandoffs: async () => ({
      processed: 0,
      reminders_enqueued: 0,
      escalations_enqueued: 0,
      sms_fallback_available: false,
      handoff_keys: [],
    }),
    ...overrides,
  };
}

function workerRequest(
  path: string,
  body: Record<string, unknown> = {},
  headers: HeadersInit = {},
  method = 'POST',
): Request {
  return new Request(`https://project.supabase.co/functions/v1/${path}`, {
    method,
    headers: {
      apikey: secretKey,
      'X-Newone-Worker-Token': workerToken,
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

async function rejectsDependency(run: () => unknown | Promise<unknown>): Promise<void> {
  await assertRejects(
    run,
    (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
  );
}

Deno.test('maintenance result parsers reject each incoherent identity and count shape', async () => {
  const validPromotion = {
    processed: 2,
    promoted: 1,
    blocked: 1,
    announcement_ids: [announcementId],
    blocked_announcement_ids: [secondAnnouncementId],
    snapshot_basis: 'reevaluated_at_scheduled_publish',
  };
  const invalidPromotions: unknown[] = [
    { ...validPromotion, announcement_ids: null },
    { ...validPromotion, promoted: 0, announcement_ids: [announcementId] },
    {
      ...validPromotion,
      promoted: 2,
      blocked: 0,
      announcement_ids: [announcementId, announcementId],
      blocked_announcement_ids: [],
    },
    { ...validPromotion, processed: 1 },
    { ...validPromotion, promoted: 0 },
    { ...validPromotion, blocked: 0 },
    { ...validPromotion, blocked_announcement_ids: [announcementId] },
    { ...validPromotion, snapshot_basis: 'scheduled_without_reevaluation' },
  ];
  for (const value of invalidPromotions) {
    await rejectsDependency(() => parsePromotionResult(value, 2));
  }

  const reminderKey = `${announcementId}:${recipientId}:reminder:1`;
  const escalationKey = `${secondAnnouncementId}:${secondRecipientId}:escalated`;
  const validObligation = {
    processed: 2,
    reminders_enqueued: 1,
    escalations_enqueued: 1,
    sms_fallback_available: false,
    announcement_recipient_keys: [reminderKey, escalationKey],
  };
  const invalidObligations: unknown[] = [
    { ...validObligation, announcement_recipient_keys: null },
    { ...validObligation, processed: 1 },
    {
      ...validObligation,
      announcement_recipient_keys: ['x'.repeat(80), escalationKey],
    },
    {
      ...validObligation,
      announcement_recipient_keys: [reminderKey, reminderKey],
    },
    { ...validObligation, reminders_enqueued: 2, escalations_enqueued: 1 },
  ];
  for (const value of invalidObligations) {
    await rejectsDependency(() => parseObligationResult(value, 2));
  }

  const validHandoff = {
    processed: 2,
    reminders_enqueued: 1,
    escalations_enqueued: 1,
    sms_fallback_available: false,
    handoff_keys: [`${handoffId}:reminder:1`, `${secondHandoffId}:escalated`],
  };
  const invalidHandoffs: unknown[] = [
    { ...validHandoff, handoff_keys: null },
    { ...validHandoff, processed: 1 },
    { ...validHandoff, handoff_keys: ['x'.repeat(46), `${secondHandoffId}:escalated`] },
    {
      ...validHandoff,
      handoff_keys: [`${handoffId}:reminder:1`, `${handoffId}:reminder:1`],
    },
    { ...validHandoff, reminders_enqueued: 2, escalations_enqueued: 1 },
  ];
  for (const value of invalidHandoffs) await rejectsDependency(() => parseHandoffResult(value, 2));
});

Deno.test('maintenance handler exercises explicit limits, transport guards, and dependency failures', async () => {
  const correlations: string[] = [];
  const handler = createMaintenanceWorkerHandler(() =>
    maintenanceDependencies({ setCorrelationId: (value) => correlations.push(value) })
  );
  const success = await handler(workerRequest('newone-maintenance-worker', {
    announcementPromotionLimit: 1,
    announcementObligationLimit: 2,
    handoffLimit: 3,
  }));
  assertEquals(success.status, 200);
  assertEquals(correlations.length, 1);

  assertEquals(
    (await createMaintenanceWorkerHandler(() => maintenanceDependencies())(
      workerRequest('newone-maintenance-worker', {}, {}, 'GET'),
    )).status,
    405,
  );
  for (
    const headers of [
      { Cookie: 'session=value' },
      { Authorization: 'Bearer service-key' },
      { apikey: '' },
    ] as Array<Record<string, string>>
  ) {
    assertEquals(
      (await createMaintenanceWorkerHandler(() => maintenanceDependencies())(
        workerRequest('newone-maintenance-worker', {}, headers),
      )).status,
      401,
    );
  }
  assertEquals(
    (await createMaintenanceWorkerHandler(() =>
      maintenanceDependencies({
        runtimeConfig: {
          ...runtimeConfig,
          allowedOrigins: new Set(['https://browser.example']),
        },
      })
    )(
      workerRequest('newone-maintenance-worker', {}, { Origin: 'https://browser.example' }),
    )).status,
    401,
  );
  const failed = await createMaintenanceWorkerHandler(() =>
    maintenanceDependencies({
      promote: () => Promise.reject(new Error('database offline')),
    })
  )(workerRequest('newone-maintenance-worker'));
  assertEquals(failed.status, 500);
});

interface ReceiptShape {
  attempt_id: string;
  organization_id: string;
  job_id: string;
  device_id: string;
  provider_ticket_id: string;
  provider_accepted_at: string;
}

function receipt(ticket: string, attempt: string, acceptedAt: string): ReceiptShape {
  return {
    attempt_id: attempt,
    organization_id: organizationId,
    job_id: String(700 + Number(attempt)),
    device_id: '00000000-0000-4000-8000-000000000060',
    provider_ticket_id: ticket,
    provider_accepted_at: acceptedAt,
  };
}

function receiptDependencies(
  overrides: Partial<PushReceiptWorkerDependencies> = {},
): PushReceiptWorkerDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey,
    },
    workerToken,
    claim: async () => ({ receipts: [] }),
    poll: async () => [],
    record: async () => {},
    now: () => new Date('2026-08-04T12:00:00Z'),
    ...overrides,
  };
}

Deno.test('receipt worker validates dependency claims and every provider result state', async () => {
  const malformed: unknown[] = [
    { receipts: 'not-an-array' },
    { receipts: [{}, {}] },
    { receipts: [{ ...receipt('ticket-1', '1', '2026-08-04T11:00:00Z'), attempt_id: 0 }] },
    {
      receipts: [{
        ...receipt('ticket-1', '1', '2026-08-04T11:00:00Z'),
        provider_accepted_at: 'not-a-date',
      }],
    },
  ];
  for (const claim of malformed) {
    const response = await createPushReceiptWorkerHandler(() =>
      receiptDependencies({ claim: async () => claim })
    )(workerRequest('newone-push-receipt-worker', { limit: 1 }));
    assertEquals(response.status, 503);
  }

  const claims = [
    receipt('ticket-delivered', '1', '2026-08-04T11:00:00Z'),
    receipt('ticket-pending', '2', '2026-08-04T11:00:00Z'),
    receipt('ticket-failed', '3', '2026-08-04T11:00:00Z'),
  ];
  const results: ExpoReceiptResult[] = [
    { providerTicketId: 'ticket-delivered', result: 'delivered', errorCode: null },
    { providerTicketId: 'ticket-pending', result: 'pending', errorCode: null },
    {
      providerTicketId: 'ticket-failed',
      result: 'permanent_failure',
      errorCode: 'MessageTooBig',
    },
  ];
  const recorded: string[] = [];
  const outcome = await createPushReceiptWorkerHandler(() =>
    receiptDependencies({
      claim: async () => ({ receipts: claims }),
      poll: async () => results,
      record: async (_worker, claim, result) => {
        recorded.push(`${claim.attemptId}:${result.result}`);
      },
    })
  )(workerRequest('newone-push-receipt-worker', {}));
  assertEquals(outcome.status, 200);
  assertEquals(await outcome.json(), { claimed: 3, delivered: 1, pending: 1, failed: 1 });
  assertEquals(recorded, ['1:delivered', '2:pending', '3:permanent_failure']);
});

Deno.test('receipt worker rejects browser contexts and provider result cardinality drift', async () => {
  const valid = receipt('ticket-1', '1', '2026-08-04T11:00:00Z');
  assertEquals(
    (await createPushReceiptWorkerHandler(() => receiptDependencies())(
      workerRequest('newone-push-receipt-worker', {}, {}, 'GET'),
    )).status,
    405,
  );
  for (
    const headers of [
      { Origin: 'https://browser.example' },
      { Cookie: 'session=value' },
      { Authorization: 'Bearer service-key' },
      { apikey: '' },
    ] as Array<Record<string, string>>
  ) {
    const response = await createPushReceiptWorkerHandler(() => receiptDependencies())(
      workerRequest('newone-push-receipt-worker', {}, headers),
    );
    assertEquals(response.status, headers.Origin || headers.Cookie ? 403 : 401);
  }

  const mismatch = await createPushReceiptWorkerHandler(() =>
    receiptDependencies({ claim: async () => ({ receipts: [valid] }) })
  )(workerRequest('newone-push-receipt-worker'));
  assertEquals(mismatch.status, 503);

  const missing = await createPushReceiptWorkerHandler(() =>
    receiptDependencies({
      claim: async () => ({
        receipts: [valid, receipt('ticket-2', '2', '2026-08-04T11:00:00Z')],
      }),
      poll: async () => [
        { providerTicketId: 'ticket-1', result: 'delivered', errorCode: null },
        { providerTicketId: 'ticket-1', result: 'delivered', errorCode: null },
      ],
    })
  )(workerRequest('newone-push-receipt-worker'));
  assertEquals(missing.status, 503);
});

function bootstrapDependencies(
  overrides: Partial<BootstrapDependencies> = {},
): BootstrapDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey,
    },
    bootstrapToken,
    inspectOwner: async () => ({
      userId: ownerUserId,
      email: 'owner@example.com',
      confirmed: true,
      deleted: false,
    }),
    bootstrap: async () => ({
      organization_id: organizationId,
      owner_user_id: ownerUserId,
      membership_role: 'owner',
      membership_status: 'active',
      root_unit_id: '00000000-0000-4000-8000-000000000030',
      bootstrapped: true,
    }),
    ...overrides,
  };
}

function bootstrapRequest(
  body: Record<string, unknown> = {},
  headers: HeadersInit = {},
  method = 'POST',
): Request {
  return new Request('https://project.supabase.co/functions/v1/newone-bootstrap', {
    method,
    headers: {
      apikey: secretKey,
      'X-Newone-Bootstrap-Token': bootstrapToken,
      'Idempotency-Key': 'coverage-bootstrap-key',
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(method === 'POST'
      ? {
        body: JSON.stringify({
          ownerUserId,
          ownerEmail: 'owner@example.com',
          organizationName: 'Coverage Organization',
          organizationSlug: 'coverage-organization',
          ...body,
        }),
      }
      : {}),
  });
}

Deno.test('bootstrap rejects method, cookie, owner-state, and public receipt drift', async () => {
  assertEquals(
    (await createBootstrapHandler(() => bootstrapDependencies())(bootstrapRequest({}, {}, 'GET')))
      .status,
    405,
  );
  assertEquals(
    (await createBootstrapHandler(() => bootstrapDependencies())(
      bootstrapRequest({}, { Cookie: 'session=value' }),
    )).status,
    403,
  );
  assertEquals(
    (await createBootstrapHandler(() => bootstrapDependencies())(
      bootstrapRequest({ ownerEmail: 'invalid-email' }),
    )).status,
    400,
  );
  assertEquals(
    (await createBootstrapHandler(() => bootstrapDependencies())(
      bootstrapRequest({ organizationSlug: 'Not A Slug' }),
    )).status,
    400,
  );
  for (
    const identity of [
      { userId: organizationId, email: 'owner@example.com', confirmed: true, deleted: false },
      { userId: ownerUserId, email: 'owner@example.com', confirmed: true, deleted: true },
    ]
  ) {
    const response = await createBootstrapHandler(() =>
      bootstrapDependencies({ inspectOwner: async () => identity })
    )(bootstrapRequest());
    assertEquals(response.status, 403);
  }
  for (
    const result of [
      {
        organization_id: organizationId,
        owner_user_id: organizationId,
        membership_role: 'owner',
        membership_status: 'active',
        root_unit_id: '00000000-0000-4000-8000-000000000030',
        bootstrapped: true,
      },
      {
        organization_id: organizationId,
        owner_user_id: ownerUserId,
        membership_role: 'owner',
        membership_status: 'active',
        root_unit_id: '00000000-0000-4000-8000-000000000030',
        bootstrapped: false,
      },
    ]
  ) {
    const response = await createBootstrapHandler(() =>
      bootstrapDependencies({ bootstrap: async () => result })
    )(bootstrapRequest());
    assertEquals(response.status, 503);
  }
});

const openRouterEnvironment: OpenRouterEnvironment = {
  apiKey: 'openrouter-test-key-that-is-long-enough',
  dataClassification: 'synthetic',
  policy: {
    policyVersion: '2026-08-04.2',
    employeeDataEgressEnabled: true,
    model: 'qwen/qwen3-235b-a22b-2507',
    providerTag: 'google-vertex/us-south1',
    providerMetadataName: 'Google',
    requirements: {
      zeroDataRetention: true,
      structuredOutputs: true,
      responseFormat: true,
      allowFallbacks: false,
      dataCollection: 'deny',
      cache: false,
      implicitCaching: false,
      bringYourOwnKeys: false,
      managementControlPlanePreflight: true,
      syntheticRouteProbe: true,
      plugins: false,
      webSearch: false,
      tools: false,
    },
    priceCeilingsUsdPerMillionTokens: { prompt: 10, completion: 30 },
    maxSourceCharacters: 20_000,
    timeoutMilliseconds: 15_000,
  },
};

const summarySource: SummarySourceResolution = {
  sources: [{ messageId: '3', body: 'Keep the line stopped.' }],
  sourceFingerprint: 'c'.repeat(64),
  language: 'en',
  aiPolicyVersion: 2,
  processorId: openRouterEnvironment.policy.providerTag,
};

function summaryResult(overrides: Partial<SummaryResult> = {}): SummaryResult {
  return {
    primaryTopic: 'Line handoff',
    summary: 'The line was handed off safely.',
    keyTopics: [{ text: 'Line status', sourceRefs: ['s0001'] }],
    decisions: [{ text: 'Keep the line stopped.', sourceRefs: ['s0001'] }],
    actionItems: [{ text: 'Inspect valve.', sourceRefs: ['s0001'], owner: null, due: null }],
    ambiguities: [{ text: 'Restart time is unknown.', sourceRefs: ['s0001'] }],
    sourceFingerprint: 'c'.repeat(64),
    sourceMap: { s0001: '3' },
    model: openRouterEnvironment.policy.model,
    providerRoute: openRouterEnvironment.policy.providerTag,
    policyVersion: openRouterEnvironment.policy.policyVersion,
    generationId: 'summary-generation',
    promptTokens: 24,
    completionTokens: 18,
    ...overrides,
  };
}

function aiDependencies(overrides: Partial<AiWorkerDependencies> = {}): AiWorkerDependencies {
  const detector = {
    detectedSourceLanguage: 'ko' as const,
    confidence: 0.99,
    ambiguous: false,
    sourceSha256: 'a'.repeat(64),
    method: 'deterministic:script-v1' as const,
    model: null,
    providerRoute: null,
    policyVersion: openRouterEnvironment.policy.policyVersion,
    generationId: null,
  };
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey,
    },
    openRouterEnvironment,
    workerToken,
    workloads: ['language_detection'],
    claim: async (_worker, workload) => ({
      jobs: [{
        id: '1',
        organization_id: organizationId,
        topic: workload,
        payload: {},
        attempts: 1,
      }],
    }),
    resolveDetection: async () => ({
      authorized: true,
      source: {
        sourceBody: '작업을 중지합니다.',
        sourceSha256: 'a'.repeat(64),
        aiPolicyVersion: 2,
        processorId: openRouterEnvironment.policy.providerTag,
      },
    }),
    resolveTranslation: async () => ({ authorized: false }),
    resolveSummary: async () => ({ authorized: false }),
    completeDetection: async () => {},
    completeTranslation: async () => {},
    completeSummary: async () => {},
    terminalFailure: async () => {},
    retryFailure: async () => {},
    processorFactory: () => ({
      detectLanguage: async () => detector,
      translate: async () => {
        throw new Error('translation must not run');
      },
      summarize: async () => {
        throw new Error('summary must not run');
      },
    } as unknown as OpenRouterLanguageProcessor),
    ...overrides,
  };
}

function aiRequest(body: Record<string, unknown> = {}, headers: HeadersInit = {}, method = 'POST') {
  return workerRequest('newone-ai-worker', body, headers, method);
}

Deno.test('AI worker rejects malformed claim envelopes and exhausts a bounded workload limit', async () => {
  const malformed: unknown[] = [
    { jobs: 'not-an-array' },
    { jobs: [{}, {}] },
    {
      jobs: [{
        id: '1',
        organization_id: organizationId,
        topic: 'translation',
        payload: {},
        attempts: 1,
      }],
    },
    {
      jobs: [{
        id: 0,
        organization_id: organizationId,
        topic: 'language_detection',
        payload: {},
        attempts: 1,
      }],
    },
  ];
  for (const claim of malformed) {
    const response = await createAiWorkerHandler(() =>
      aiDependencies({ claim: async () => claim })
    )(aiRequest({ limit: 1 }));
    assertEquals(response.status, 503);
  }

  const calls: string[] = [];
  const bounded = await createAiWorkerHandler(() =>
    aiDependencies({
      workloads: ['language_detection', 'translation', 'summary'],
      claim: async (_worker, workload) => {
        calls.push(workload);
        return {
          jobs: [{
            id: '1',
            organization_id: organizationId,
            topic: workload,
            payload: {},
            attempts: 1,
          }],
        };
      },
    })
  )(aiRequest({ limit: 1 }));
  assertEquals(bounded.status, 200);
  // Round one stops at the limit after the first workload; the drain round
  // then finds nothing new in any workload and ends the pass.
  assertEquals(calls, ['language_detection', 'language_detection', 'translation', 'summary']);
});

Deno.test('AI worker skips denied translation and summary and survives failed failure recording', async () => {
  for (const workload of ['translation', 'summary'] as const) {
    const response = await createAiWorkerHandler(() =>
      aiDependencies({
        workloads: [workload],
        claim: async () => ({
          jobs: [{
            id: '1',
            organization_id: organizationId,
            topic: workload,
            payload: {},
            attempts: 1,
          }],
        }),
      })
    )(aiRequest({}));
    assertEquals(response.status, 200);
    assertEquals((await response.json()).skipped, 1);
  }

  const failureEvents: string[] = [];
  const failed = await createAiWorkerHandler(() =>
    aiDependencies({
      resolveDetection: async () => {
        throw new ApiError(400, 'bad_request');
      },
      retryFailure: async (_worker, _job, code, seconds) => {
        failureEvents.push(`${code}:${seconds}`);
        throw new Error('lease write failed');
      },
    })
  )(aiRequest());
  assertEquals(failed.status, 200);
  assertEquals((await failed.json()).failed, 1);
  assertEquals(failureEvents, ['bad_request:15']);
});

Deno.test('AI worker covers method, browser-context, and terminal-attempt guards', async () => {
  assertEquals(
    (await createAiWorkerHandler(() => aiDependencies())(aiRequest({}, {}, 'GET'))).status,
    405,
  );
  for (
    const headers of [
      { Origin: 'https://browser.example' },
      { Cookie: 'session=value' },
      { apikey: '' },
    ] as Array<Record<string, string>>
  ) {
    const response = await createAiWorkerHandler(() => aiDependencies())(aiRequest({}, headers));
    assertEquals(response.status, headers.Origin || headers.Cookie ? 403 : 401);
  }

  const terminal: string[] = [];
  const response = await createAiWorkerHandler(() =>
    aiDependencies({
      claim: async () => ({
        jobs: [{
          id: '1',
          organization_id: organizationId,
          topic: 'language_detection',
          payload: {},
          attempts: 10,
        }],
      }),
      processorFactory: () => ({
        detectLanguage: async () => {
          throw new ApiError(503, 'provider_unavailable');
        },
      } as unknown as OpenRouterLanguageProcessor),
      terminalFailure: async (_worker, _job, _hash, code) => {
        terminal.push(code);
      },
    })
  )(aiRequest());
  assertEquals(response.status, 200);
  assertEquals(terminal, ['provider_unavailable']);
});

Deno.test('summary persistence rejects unbound and oversized evidence payloads', async () => {
  await rejectsDependency(() => {
    throw new ApiError(503, 'dependency_unavailable');
  });
  await assertRejects(
    () =>
      summaryPersistence(
        summaryResult({ keyTopics: [{ text: 'x'.repeat(501), sourceRefs: [] }] }),
        summarySource,
      ),
    (error) => error instanceof ApiError && error.code === 'ai_output_needs_review',
  );
  await assertRejects(
    () =>
      summaryPersistence(
        summaryResult({ ambiguities: [{ text: 'x'.repeat(2001), sourceRefs: [] }] }),
        summarySource,
      ),
    (error) => error instanceof ApiError && error.code === 'ai_output_needs_review',
  );
  await assertRejects(
    () =>
      summaryPersistence(
        summaryResult({ decisions: [{ text: 'missing', sourceRefs: ['unknown'] }] }),
        summarySource,
      ),
    (error) => error instanceof ApiError && error.code === 'ai_output_needs_review',
  );
  await assertRejects(
    () =>
      summaryPersistence(
        summaryResult({ keyTopics: [{ text: 'Unbound topic', sourceRefs: ['s0404'] }] }),
        summarySource,
      ),
    (error) => error instanceof ApiError && error.code === 'ai_output_needs_review',
  );
  await assertRejects(
    () =>
      summaryPersistence(
        summaryResult({
          decisions: Array.from({ length: 100 }, (_, index) => ({
            text: `${index}:${'x'.repeat(400)}`,
            sourceRefs: ['s0001'],
          })),
        }),
        summarySource,
      ),
    (error) => error instanceof ApiError && error.code === 'ai_output_needs_review',
  );
  await assertRejects(
    () =>
      summaryPersistence(
        summaryResult({
          actionItems: Array.from({ length: 100 }, (_, index) => ({
            text: `${index}:${'x'.repeat(400)}`,
            sourceRefs: ['s0001'],
            owner: null,
            due: null,
          })),
        }),
        summarySource,
      ),
    (error) => error instanceof ApiError && error.code === 'ai_output_needs_review',
  );
  await assertRejects(
    () =>
      summaryPersistence(
        summaryResult({
          sourceMap: { s0001: '3', huge: 'x'.repeat(17_000) },
          keyTopics: [{ text: 'Line status', sourceRefs: ['huge'] }],
        }),
        summarySource,
      ),
    (error) => error instanceof ApiError && error.code === 'ai_output_needs_review',
  );
});
