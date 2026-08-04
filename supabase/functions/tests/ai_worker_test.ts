import { ApiError } from '../_shared/errors.ts';
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
    claim: async (_workerId, workload) => ({
      jobs: [{
        id: workload === 'language_detection' ? 1 : workload === 'translation' ? 2 : 3,
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

Deno.test('summary persistence keeps source evidence and remains within database limits', () => {
  const source: SummarySourceResolution = {
    sources: [{ messageId: '3', body: 'Keep the line stopped.' }],
    sourceFingerprint: 'c'.repeat(64),
    language: 'en',
    aiPolicyVersion: 2,
    processorId: openRouterEnvironment.policy.providerTag,
  };
  const persisted = summaryPersistence(summaryResult, source);
  assertEquals(persisted.keyTopics, ['Line status [sources:s0001]']);
  assertEquals(persisted.decisions[0], {
    text: 'Keep the line stopped.',
    sourceRefs: ['s0001'],
    sourceMessageIds: ['3'],
  });
  assertEquals(persisted.actionItems[0]?.sourceMessageIds, ['3']);
  assert(JSON.stringify(persisted.provenance).includes('summary-generation'));
});
