import { ApiError } from '../_shared/errors.ts';
import { parseSummaryResolution } from '../newone-ai-worker/handler.ts';
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
import { assert, assertEquals } from './assert.ts';

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
const secretKey = 'sb_secret_server_value';
const organizationId = '00000000-0000-4000-8000-000000000001';
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

const detectionResult = {
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
const translationResult = {
  translatedText: 'Hola',
  sourceLanguage: 'ko',
  targetLanguage: 'es',
  sourceSha256: 'b'.repeat(64),
  model: openRouterEnvironment.policy.model,
  providerRoute: openRouterEnvironment.policy.providerTag,
  policyVersion: openRouterEnvironment.policy.policyVersion,
  generationId: 'translation-generation',
  promptTokens: 12,
  completionTokens: 4,
  protectedTokenCount: 0,
  invariantStatus: 'passed' as const,
};
const summaryResult: SummaryResult = {
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
};

function fakeProcessor(overrides: Partial<OpenRouterLanguageProcessor> = {}) {
  return {
    detectLanguage: async () => detectionResult,
    translate: async () => translationResult,
    summarize: async () => summaryResult,
    ...overrides,
  } as unknown as OpenRouterLanguageProcessor;
}

function onceClaim(topics: AiWorkerDependencies['workloads'] = ['language_detection', 'translation', 'summary']) {
  const pending = new Set(topics);
  return async (_workerId: string, workload: AiWorkerDependencies['workloads'][number]) => {
    if (!pending.has(workload)) return { jobs: [] };
    pending.delete(workload);
    return {
      jobs: [{
        id: workload === 'language_detection' ? 1 : workload === 'translation' ? 2 : 3,
        organization_id: organizationId,
        topic: workload,
        payload: {},
        attempts: 1,
      }],
    };
  };
}

function dependencies(
  overrides: Partial<AiWorkerDependencies> = {},
): AiWorkerDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public_value',
      secretKey,
    },
    openRouterEnvironment,
    workerToken,
    workloads: ['language_detection', 'translation', 'summary'],
    // Like the database, a claim hands a job out once; the worker now keeps
    // claiming until the queue is empty, so the mock must run dry.
    claim: onceClaim(),
    resolveDetection: async () => ({
      authorized: true,
      source: {
        sourceBody: '작업을 중지합니다.',
        sourceSha256: 'a'.repeat(64),
        aiPolicyVersion: 2,
        processorId: openRouterEnvironment.policy.providerTag,
      },
    }),
    resolveTranslation: async () => ({
      authorized: true,
      source: {
        sourceBody: '안녕하세요',
        sourceLanguage: 'ko',
        targetLanguage: 'es',
        sourceSha256: 'b'.repeat(64),
        aiPolicyVersion: 2,
        processorId: openRouterEnvironment.policy.providerTag,
      },
    }),
    resolveSummary: async () => ({
      authorized: true,
      source: {
        sources: [{ messageId: '3', body: 'Keep the line stopped.' }],
        sourceFingerprint: 'c'.repeat(64),
        language: 'en',
        aiPolicyVersion: 2,
        processorId: openRouterEnvironment.policy.providerTag,
      },
    }),
    completeDetection: async () => {},
    completeTranslation: async () => {},
    completeSummary: async () => {},
    terminalFailure: async () => {},
    retryFailure: async () => {},
    processorFactory: () => fakeProcessor(),
    ...overrides,
  };
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://project.supabase.co/functions/v1/newone-ai-worker', {
    method: 'POST',
    headers: {
      apikey: secretKey,
      'X-Newone-Worker-Token': workerToken,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ limit: 3 }),
  });
}

Deno.test('AI worker processes detector, recipient-derived translation, and structured summary jobs', async () => {
  const events: string[] = [];
  const handler = createAiWorkerHandler(() =>
    dependencies({
      completeDetection: async (_workerId, job, source, result) => {
        events.push(`${job.topic}:${source.processorId}:${result.detectedSourceLanguage}`);
      },
      completeTranslation: async (_workerId, job, source, result) => {
        events.push(
          `${job.topic}:${source.sourceLanguage}-${source.targetLanguage}:${result.translatedText}`,
        );
      },
      completeSummary: async (_workerId, job, source, result) => {
        events.push(`${job.topic}:${source.sourceFingerprint}:${result.primaryTopic}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    claimed: 3,
    completed: 3,
    skipped: 0,
    failed: 0,
    workloads: ['language_detection', 'translation', 'summary'],
  });
  assertEquals(events, [
    'language_detection:google-vertex/us-south1:ko',
    'translation:ko-es:Hola',
    `summary:${'c'.repeat(64)}:Line handoff`,
  ]);
});

Deno.test('tenant-denied resolver result skips provider egress and is not reported as completed', async () => {
  let providerCalled = false;
  const handler = createAiWorkerHandler(() =>
    dependencies({
      workloads: ['language_detection'],
      resolveDetection: async () => ({ authorized: false }),
      processorFactory: () =>
        fakeProcessor({
          detectLanguage: async () => {
            providerCalled = true;
            return detectionResult;
          },
        }),
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals((await response.json()).skipped, 1);
  assertEquals(providerCalled, false);
});

Deno.test('invariant failures take a terminal path while transient failures retain a bounded retry', async () => {
  const events: string[] = [];
  const terminalHandler = createAiWorkerHandler(() =>
    dependencies({
      workloads: ['language_detection'],
      processorFactory: () =>
        fakeProcessor({
          detectLanguage: async () => {
            throw new ApiError(422, 'ai_output_needs_review');
          },
        }),
      terminalFailure: async (_workerId, job, sourceHash, code) => {
        events.push(`terminal:${job.topic}:${sourceHash}:${code}`);
      },
      retryFailure: async () => {
        events.push('retry');
      },
    })
  );
  assertEquals((await terminalHandler(request())).status, 200);
  assertEquals(events, [
    `terminal:language_detection:${'a'.repeat(64)}:ai_output_needs_review`,
  ]);

  events.length = 0;
  const retryHandler = createAiWorkerHandler(() =>
    dependencies({
      workloads: ['translation'],
      processorFactory: () =>
        fakeProcessor({
          translate: async () => {
            throw new ApiError(503, 'provider_unavailable', undefined, 45);
          },
        }),
      terminalFailure: async () => {
        events.push('terminal');
      },
      retryFailure: async (_workerId, job, code, retry) => {
        events.push(`retry:${job.topic}:${code}:${retry}`);
      },
    })
  );
  assertEquals((await retryHandler(request())).status, 200);
  assertEquals(events, ['retry:translation:provider_unavailable:45']);
});

Deno.test('AI worker accepts opaque service key only in apikey and rejects a fake bearer key', async () => {
  let claimed = false;
  const handler = createAiWorkerHandler(() =>
    dependencies({
      workloads: ['language_detection'],
      claim: async () => {
        claimed = true;
        return { jobs: [] };
      },
    })
  );
  const response = await handler(request({ Authorization: `Bearer ${secretKey}` }));
  assertEquals(response.status, 401);
  assertEquals(claimed, false);
});

Deno.test('a detection completion enqueues the translation and the same pass drains it', async () => {
  const events: string[] = [];
  let translationReady = false;
  const handler = createAiWorkerHandler(() =>
    dependencies({
      workloads: ['language_detection', 'translation'],
      claim: async (_workerId, workload) => {
        if (workload === 'language_detection' && !events.length) {
          return { jobs: [{ id: 1, organization_id: organizationId, topic: workload, payload: {}, attempts: 1 }] };
        }
        if (workload === 'translation' && translationReady) {
          translationReady = false;
          return { jobs: [{ id: 2, organization_id: organizationId, topic: workload, payload: {}, attempts: 1 }] };
        }
        return { jobs: [] };
      },
      completeDetection: async (_workerId, job) => {
        events.push(job.topic);
        translationReady = true;
      },
      completeTranslation: async (_workerId, job) => {
        events.push(job.topic);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    claimed: 2,
    completed: 2,
    skipped: 0,
    failed: 0,
    workloads: ['language_detection', 'translation'],
  });
  assertEquals(events, ['language_detection', 'translation']);
});

Deno.test('summary persistence keeps source evidence and remains within database limits', () => {
  const source: SummarySourceResolution = {
    sources: [{ messageId: '3', body: 'Keep the line stopped.' }],
    sourceFingerprint: 'c'.repeat(64),
    language: 'en',
    aiPolicyVersion: 2,
    processorId: openRouterEnvironment.policy.providerTag,
  };
  const persisted = summaryPersistence(summaryResult, source);
  // Stored text is what people read; citations travel in provenance instead.
  assertEquals(persisted.keyTopics, ['Line status']);
  assertEquals(persisted.ambiguities, ['Restart time is unknown.']);
  assertEquals(persisted.provenance.evidence, {
    keyTopics: [{ sourceRefs: ['s0001'] }],
    ambiguities: [{ sourceRefs: ['s0001'] }],
  });
  assertEquals(persisted.provenance.evidenceEncoding, 'provenance-evidence-v2');
  assertEquals(persisted.decisions[0], {
    text: 'Keep the line stopped.',
    sourceRefs: ['s0001'],
    sourceMessageIds: ['3'],
  });
  assertEquals(persisted.actionItems[0]?.sourceMessageIds, ['3']);
  assert(JSON.stringify(persisted.provenance).includes('summary-generation'));
});

// Defect M (Sep 4 2026): a thread with a photo and a voice note made the
// summary fail with bad_request (bodiless sources) and the row stayed
// "processing" because the terminal failure needed a source hash.
Deno.test('summary resolution drops bodiless attachment and system messages and fails when nothing is left', () => {
  const job = { id: '3', organizationId, topic: 'summary' as const, payload: {}, attempts: 1 };
  const provider = openRouterEnvironment.policy.providerTag;
  const row = (messages: unknown[]) => ({
    authorized: true,
    provider_egress_allowed: true,
    organization_id: organizationId,
    processor_id: provider,
    route_policy: 'approved_zero_retention',
    provider_route_policy: 'zero_retention_only',
    ai_policy_version: 2,
    summary_id: '11111111-1111-4111-8111-111111111111',
    conversation_id: '22222222-2222-4222-8222-222222222222',
    requested_by_user_id: '33333333-3333-4333-8333-333333333333',
    source_fingerprint: 'c'.repeat(64),
    language_code: 'en',
    messages,
  });
  const resolved = parseSummaryResolution(
    row([
      { message_id: '3', body: 'Keep the line stopped.' },
      { message_id: '4', body: null },
      { message_id: '5', body: '' },
    ]),
    job,
    provider,
  );
  assert(resolved.authorized);
  assertEquals(resolved.authorized && resolved.source.sources.map((source) => source.messageId), ['3']);
  let code = '';
  try {
    parseSummaryResolution(row([{ message_id: '4', body: null }]), job, provider);
  } catch (error) {
    code = error instanceof ApiError ? error.code : 'other';
  }
  assertEquals(code, 'summary_no_text_sources');
});

Deno.test('summary resolution labels speakers relative to the requester', () => {
  const job = { id: '3', organizationId, topic: 'summary' as const, payload: {}, attempts: 1 };
  const provider = openRouterEnvironment.policy.providerTag;
  const requester = '33333333-3333-4333-8333-333333333333';
  const resolved = parseSummaryResolution({
    authorized: true,
    provider_egress_allowed: true,
    organization_id: organizationId,
    processor_id: provider,
    route_policy: 'approved_zero_retention',
    provider_route_policy: 'zero_retention_only',
    ai_policy_version: 2,
    summary_id: '11111111-1111-4111-8111-111111111111',
    conversation_id: '22222222-2222-4222-8222-222222222222',
    requested_by_user_id: requester,
    source_fingerprint: 'c'.repeat(64),
    language_code: 'en',
    messages: [
      { message_id: '3', body: 'Monday?', sender_user_id: requester.toUpperCase(), created_at: '2026-09-04 10:00:00+00' },
      { message_id: '4', body: 'Works.', sender_user_id: '44444444-4444-4444-8444-444444444444' },
      { message_id: '5', body: 'Same for me.', sender_user_id: '55555555-5555-4555-8555-555555555555' },
      { message_id: '6', body: 'Great.', sender_user_id: '44444444-4444-4444-8444-444444444444' },
      { message_id: '7', body: 'No sender here.' },
    ],
  }, job, provider);
  assert(resolved.authorized);
  assertEquals(resolved.authorized && resolved.source.sources, [
    { messageId: '3', body: 'Monday?', speaker: 'you' },
    { messageId: '4', body: 'Works.', speaker: 'participant 1' },
    { messageId: '5', body: 'Same for me.', speaker: 'participant 2' },
    { messageId: '6', body: 'Great.', speaker: 'participant 1' },
    { messageId: '7', body: 'No sender here.' },
  ]);
});

Deno.test('a summary that cannot run is failed terminally without a source hash', async () => {
  const terminal: Array<{ topic: string; sourceHash: string | null; code: string }> = [];
  let retried = 0;
  const handler = createAiWorkerHandler(() =>
    dependencies({
      claim: onceClaim(['summary']),
      resolveSummary: async () => {
        throw new ApiError(400, 'summary_no_text_sources');
      },
      terminalFailure: async (_workerId, job, sourceHash, code) => {
        terminal.push({ topic: job.topic, sourceHash, code });
      },
      retryFailure: async () => {
        retried += 1;
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(terminal, [{ topic: 'summary', sourceHash: null, code: 'summary_no_text_sources' }]);
  assertEquals(retried, 0);
});

// v3.1: first names reach the prose, the reader's scope reaches the model,
// and a range that is too long (or refused) fails with the reader's remedy
// as the stored code.
Deno.test('summary resolution labels senders by first name, keeps namesakes apart, and passes the scope', () => {
  const job = { id: '3', organizationId, topic: 'summary' as const, payload: {}, attempts: 1 };
  const provider = openRouterEnvironment.policy.providerTag;
  const requester = '33333333-3333-4333-8333-333333333333';
  const resolved = parseSummaryResolution({
    authorized: true,
    provider_egress_allowed: true,
    organization_id: organizationId,
    processor_id: provider,
    route_policy: 'approved_zero_retention',
    provider_route_policy: 'zero_retention_only',
    ai_policy_version: 2,
    summary_id: '11111111-1111-4111-8111-111111111111',
    conversation_id: '22222222-2222-4222-8222-222222222222',
    requested_by_user_id: requester,
    source_fingerprint: 'c'.repeat(64),
    language_code: 'en',
    scope_kind: 'last_7_days',
    scope_subject: 'the trip',
    messages: [
      { message_id: '3', body: 'Monday?', sender_user_id: requester, sender_display_name: 'Jordan Lee' },
      { message_id: '4', body: 'Works.', sender_user_id: '44444444-4444-4444-8444-444444444444', sender_display_name: 'Diego Ruiz' },
      { message_id: '5', body: 'Same.', sender_user_id: '55555555-5555-4555-8555-555555555555', sender_display_name: 'Ana Torres' },
      { message_id: '6', body: 'Me too.', sender_user_id: '66666666-6666-4666-8666-666666666666', sender_display_name: 'Ana Kim' },
      { message_id: '7', body: '좋아요', sender_user_id: '77777777-7777-4777-8777-777777777777', sender_display_name: '이지수' },
      { message_id: '8', body: 'Sure.', sender_user_id: '88888888-8888-4888-8888-888888888888', sender_display_name: '!!!' },
      { message_id: '9', body: 'Great.', sender_user_id: '44444444-4444-4444-8444-444444444444', sender_display_name: 'Diego Ruiz' },
      { message_id: '10', body: 'Ok', sender_user_id: '99999999-9999-4999-8999-999999999999' },
    ],
  }, job, provider);
  assert(resolved.authorized);
  if (!resolved.authorized) return;
  assertEquals(resolved.source.scopeKind, 'last_7_days');
  assertEquals(resolved.source.subject, 'the trip');
  assertEquals(resolved.source.sources.map((source) => source.speaker), [
    'you', 'Diego', 'Ana', 'Ana Kim', '이지수', 'participant 1', 'Diego', 'participant 2',
  ]);
  // No names, no scope: the older resolver shape still works.
  const legacy = parseSummaryResolution({
    authorized: true,
    provider_egress_allowed: true,
    organization_id: organizationId,
    processor_id: provider,
    route_policy: 'approved_zero_retention',
    provider_route_policy: 'zero_retention_only',
    ai_policy_version: 2,
    summary_id: '11111111-1111-4111-8111-111111111111',
    conversation_id: '22222222-2222-4222-8222-222222222222',
    requested_by_user_id: requester,
    source_fingerprint: 'c'.repeat(64),
    language_code: 'en',
    messages: [{ message_id: '3', body: 'Hi', sender_user_id: '44444444-4444-4444-8444-444444444444' }],
  }, job, provider);
  assert(legacy.authorized);
  if (!legacy.authorized) return;
  assertEquals(legacy.source.scopeKind, null);
  assertEquals(legacy.source.subject, null);
  assertEquals(legacy.source.sources[0]?.speaker, 'participant 1');
  // Over the cap: terminal, with the reader's remedy as the reason.
  let reason = '';
  try {
    parseSummaryResolution({
      authorized: true,
      provider_egress_allowed: true,
      organization_id: organizationId,
      processor_id: provider,
      route_policy: 'approved_zero_retention',
      provider_route_policy: 'zero_retention_only',
      ai_policy_version: 2,
      summary_id: '11111111-1111-4111-8111-111111111111',
      conversation_id: '22222222-2222-4222-8222-222222222222',
      requested_by_user_id: requester,
      source_fingerprint: 'c'.repeat(64),
      language_code: 'en',
      messages: Array.from({ length: 2001 }, (_, index) => ({ message_id: String(index + 1), body: 'Hi' })),
    }, job, provider);
  } catch (error) {
    reason = error instanceof ApiError ? `${error.status}:${error.code}:${error.message}` : 'other';
  }
  assertEquals(reason, '422:ai_output_needs_review:summary_range_too_long');
});

Deno.test('the subject reaches the processor and a too-long or refused summary stores the remedy as its code', async () => {
  const subjects: Array<string | null | undefined> = [];
  const terminal: string[] = [];
  const run = async (failure: ApiError | null) => {
    const handler = createAiWorkerHandler(() =>
      dependencies({
        claim: onceClaim(['summary']),
        resolveSummary: async () => ({
          authorized: true,
          source: {
            sources: [{ messageId: '3', body: 'Keep the line stopped.', speaker: 'Diego' }],
            sourceFingerprint: 'c'.repeat(64),
            language: 'en',
            aiPolicyVersion: 2,
            processorId: openRouterEnvironment.policy.providerTag,
            scopeKind: 'today',
            subject: 'the trip',
          },
        }),
        processorFactory: () =>
          fakeProcessor({
            summarize: async (request) => {
              subjects.push(request.subject);
              if (failure) throw failure;
              return summaryResult;
            },
          }),
        terminalFailure: async (_workerId, _job, _sourceHash, code) => {
          terminal.push(code);
        },
      })
    );
    return (await (await handler(request())).json()) as Record<string, number>;
  };
  assertEquals((await run(null)).completed, 1);
  assertEquals(subjects, ['the trip']);
  await run(new ApiError(422, 'ai_output_needs_review', 'summary_range_too_long'));
  await run(new ApiError(422, 'ai_output_needs_review', 'provider_refused'));
  await run(new ApiError(422, 'ai_output_needs_review'));
  await run(new ApiError(422, 'ai_output_needs_review', 'summary_prose_empty'));
  assertEquals(terminal, [
    'summary_range_too_long',
    'provider_refused',
    'ai_output_needs_review',
    'summary_prose_empty',
  ]);
});

Deno.test('summary persistence records the slice count and keeps only the cited source references', () => {
  const source: SummarySourceResolution = {
    sources: [{ messageId: '3', body: 'Keep the line stopped.' }],
    sourceFingerprint: 'c'.repeat(64),
    language: 'en',
    aiPolicyVersion: 2,
    processorId: openRouterEnvironment.policy.providerTag,
  };
  const wide: SummaryResult = {
    ...summaryResult,
    sourceMap: Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`s${String(index + 1).padStart(4, '0')}`, String(index + 3)])),
    sliceCount: 14,
  };
  const persisted = summaryPersistence(wide, source);
  assertEquals(persisted.provenance.slices, 14);
  assertEquals(persisted.provenance.sourceMap, { s0001: '3' });
  assertEquals(summaryPersistence(summaryResult, source).provenance.slices, 1);
});
