import { sha256Hex } from '../_shared/crypto.ts';
import { ApiError } from '../_shared/errors.ts';
import {
  type FetchLike,
  loadOpenRouterEnvironment,
  type OpenRouterEnvironment,
  OpenRouterLanguageProcessor,
  parseOpenRouterPolicy,
} from '../_shared/openrouter.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const policyInput = {
  policyVersion: 'coverage-v1',
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
  priceCeilingsUsdPerMillionTokens: { prompt: 0.25, completion: 1 },
};

const providerModel = 'qwen/qwen3-235b-a22b-07-25';
const policy = parseOpenRouterPolicy(JSON.stringify(policyInput));
const environment: OpenRouterEnvironment = {
  apiKey: 'coverage-openrouter-key-that-is-long-enough',
  dataClassification: 'synthetic',
  policy,
};

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requested: policy.model,
    strategy: 'direct',
    attempt: 1,
    is_byok: false,
    endpoints: {
      total: 1,
      available: [{ provider: policy.providerMetadataName, model: providerModel, selected: true }],
    },
    ...overrides,
  };
}

function completion(
  output: unknown,
  overrides: Record<string, unknown> = {},
  responseInit?: ResponseInit,
): Response {
  return Response.json({
    id: 'coverage-generation',
    model: policy.model,
    choices: [{ message: { content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
    openrouter_metadata: metadata(),
    ...overrides,
  }, responseInit);
}

function processor(fetcher: FetchLike): OpenRouterLanguageProcessor {
  return new OpenRouterLanguageProcessor(environment, fetcher);
}

async function providerFailure(run: () => Promise<unknown>): Promise<void> {
  await assertRejects(
    run,
    (error) => error instanceof ApiError && error.code === 'provider_unavailable',
  );
}

async function badRequest(run: () => Promise<unknown>): Promise<void> {
  await assertRejects(
    run,
    (error) => error instanceof ApiError && error.code === 'bad_request',
  );
}

Deno.test('OpenRouter policy and environment validate every fail-closed requirement', async () => {
  for (const model of ['Bad Model', 'vendor/model:free']) {
    await assertRejects(async () =>
      parseOpenRouterPolicy(JSON.stringify({ ...policyInput, model }))
    );
  }
  await assertRejects(async () =>
    parseOpenRouterPolicy(JSON.stringify({ ...policyInput, providerTag: 'bad tag' }))
  );
  await assertRejects(async () =>
    parseOpenRouterPolicy(JSON.stringify({ ...policyInput, providerMetadataName: '*invalid' }))
  );

  for (const key of Object.keys(policyInput.requirements)) {
    const requirements = {
      ...policyInput.requirements,
      [key]: key === 'dataCollection' ? 'allow' : !policyInput.requirements[
        key as keyof typeof policyInput.requirements
      ],
    };
    await assertRejects(async () =>
      parseOpenRouterPolicy(JSON.stringify({ ...policyInput, requirements }))
    );
  }

  for (
    const priceCeilingsUsdPerMillionTokens of [
      { prompt: '1', completion: 1 },
      { prompt: Number.NaN, completion: 1 },
      { prompt: 0, completion: 1 },
      { prompt: 1, completion: '1' },
      { prompt: 1, completion: Number.POSITIVE_INFINITY },
      { prompt: 1, completion: -1 },
    ]
  ) {
    await assertRejects(async () =>
      parseOpenRouterPolicy(JSON.stringify({ ...policyInput, priceCeilingsUsdPerMillionTokens }))
    );
  }

  const valid = new Map<string, string>([
    ['NEWONE_AI_DATA_EGRESS_APPROVED', 'true'],
    ['OPENROUTER_API_KEY', 'completion-key-that-is-long-enough'],
    ['NEWONE_OPENROUTER_POLICY_JSON', JSON.stringify(policyInput)],
    ['OPENROUTER_MANAGEMENT_API_KEY', 'management-key-that-is-long-enough'],
    ['NEWONE_OPENROUTER_API_KEY_HASH', 'a'.repeat(64)],
    ['NEWONE_OPENROUTER_WORKSPACE_ID', '00000000-0000-4000-8000-000000000700'],
  ]);
  const env = (overrides: Record<string, string | undefined>) => ({
    get(key: string): string | undefined {
      return key in overrides ? overrides[key] : valid.get(key);
    },
  });
  for (
    const overrides of [
      { NEWONE_AI_DATA_EGRESS_APPROVED: 'false' },
      { OPENROUTER_API_KEY: undefined },
      { OPENROUTER_API_KEY: 'short' },
      { NEWONE_OPENROUTER_POLICY_JSON: undefined },
      { NEWONE_OPENROUTER_POLICY_JSON: '{' },
    ]
  ) {
    await assertRejects(
      async () => loadOpenRouterEnvironment(env(overrides)),
      (error) => error instanceof ApiError && error.code === 'ai_processing_disabled',
    );
  }
  const configured = loadOpenRouterEnvironment(env({
    NEWONE_PUBLIC_APP_URL: ' https://coverage.example ',
    NEWONE_OPENROUTER_APP_NAME: ' Coverage ',
  }));
  assertEquals(configured.siteUrl, 'https://coverage.example');
  assertEquals(configured.siteName, 'Coverage');
  const minimal = loadOpenRouterEnvironment(env({}));
  assert(!('siteUrl' in minimal));
  assert(!('siteName' in minimal));
});

Deno.test('OpenRouter completion rejects malformed transport envelopes and route metadata', async () => {
  const sourceBody = 'Coverage source body';
  const sourceSha256 = await sha256Hex(sourceBody);
  const request = {
    sourceBody,
    sourceLanguage: 'en',
    targetLanguage: 'es',
    sourceSha256,
    correlationId: '10000000-0000-4000-8000-000000000001',
  };
  const validOutput = {
    translatedText: 'Texto de cobertura',
    sourceFingerprint: sourceSha256.slice(0, 16),
  };

  await providerFailure(() =>
    processor(async () => Promise.reject(new Error('network'))).translate(request)
  );
  for (const retryAfter of ['7200', 'invalid']) {
    await providerFailure(() =>
      processor(async () =>
        new Response('busy', {
          status: 429,
          headers: { 'retry-after': retryAfter },
        })
      ).translate(request)
    );
  }
  for (
    const response of [
      new Response('{', { status: 200 }),
      new Response(JSON.stringify('not-an-object'), { status: 200 }),
      new Response('x'.repeat(131073), { status: 200 }),
      completion(validOutput, { model: 'wrong/model' }),
      completion(validOutput, { choices: null }),
      completion(validOutput, { choices: [] }),
      completion(validOutput, { choices: [null] }),
      completion(validOutput, { choices: [{ message: null }] }),
      completion(validOutput, { choices: [{ message: { content: null } }] }),
      completion(validOutput, {
        choices: [{ message: { content: 'x'.repeat(65537) } }],
      }),
      completion(validOutput, { choices: [{ message: { content: '{' } }] }),
    ]
  ) {
    await providerFailure(() => processor(async () => response.clone()).translate(request));
  }

  const endpoint = {
    provider: policy.providerMetadataName,
    model: providerModel,
    selected: true,
  };
  const invalidMetadata: Record<string, unknown>[] = [
    metadata({ requested: 'wrong/model' }),
    metadata({ strategy: 'fallback' }),
    metadata({ attempt: 2 }),
    metadata({ is_byok: true }),
    metadata({ endpoints: null }),
    metadata({ endpoints: { total: '1', available: [endpoint] } }),
    metadata({ endpoints: { total: 0, available: [endpoint] } }),
    metadata({ endpoints: { total: 101, available: [endpoint] } }),
    metadata({ endpoints: { total: 1, available: null } }),
    metadata({ endpoints: { total: 1, available: [] } }),
    metadata({ endpoints: { total: 1, available: Array(101).fill(endpoint) } }),
    metadata({ endpoints: { total: 1, available: [endpoint, endpoint] } }),
    metadata({ endpoints: { total: 1, available: [null] } }),
    metadata({ endpoints: { total: 1, available: [{ ...endpoint, model: '*' }] } }),
    metadata({ endpoints: { total: 1, available: [{ ...endpoint, provider: 'Other' }] } }),
    metadata({ endpoints: { total: 1, available: [{ ...endpoint, selected: 'yes' }] } }),
    metadata({ endpoints: { total: 1, available: [{ ...endpoint, selected: false }] } }),
    metadata({ attempts: 'invalid' }),
    metadata({ attempts: [] }),
    metadata({ attempts: [null] }),
    metadata({ attempts: [{ provider: 'Other', model: providerModel, status: 200 }] }),
    metadata({ attempts: [{ provider: 'Google', model: '*', status: 200 }] }),
    metadata({ attempts: [{ provider: 'Google', model: providerModel, status: '200' }] }),
    metadata({ attempts: [{ provider: 'Google', model: providerModel, status: 199 }] }),
    metadata({ attempts: [{ provider: 'Google', model: providerModel, status: 300 }] }),
    metadata({ pipeline: 'invalid' }),
    metadata({ pipeline: Array(21).fill({}) }),
    metadata({ pipeline: [{}] }),
  ];
  for (const openrouterMetadata of invalidMetadata) {
    await providerFailure(() =>
      processor(async () => completion(validOutput, { openrouter_metadata: openrouterMetadata }))
        .translate(request)
    );
  }

  const withoutOptionalReceipts = await processor(async () =>
    completion(validOutput, {
      id: 42,
      usage: null,
      openrouter_metadata: metadata({
        attempts: [{ provider: 'Google', model: providerModel, status: 204 }],
        pipeline: [],
      }),
    })
  ).translate(request);
  assertEquals(withoutOptionalReceipts.generationId, null);
  assertEquals(withoutOptionalReceipts.promptTokens, null);
  assertEquals(withoutOptionalReceipts.completionTokens, null);
});

Deno.test('OpenRouter translation and detection validate each request and structured output field', async () => {
  const sourceBody = 'Coverage source body';
  const sourceSha256 = await sha256Hex(sourceBody);
  const base = {
    sourceBody,
    sourceLanguage: 'en',
    targetLanguage: 'es',
    sourceSha256,
    correlationId: '10000000-0000-4000-8000-000000000001',
  };
  for (
    const override of [
      { sourceLanguage: '*' },
      { targetLanguage: '*' },
      { targetLanguage: 'en' },
      { sourceBody: '' },
      { sourceBody: 'x'.repeat(20001) },
      { sourceSha256: 'x' },
      { sourceSha256: '0'.repeat(64) },
    ]
  ) {
    await badRequest(() =>
      processor(async () => {
        throw new Error('provider must not be called');
      }).translate({ ...base, ...override })
    );
  }

  const validOutput = {
    translatedText: 'Texto de cobertura',
    sourceFingerprint: sourceSha256.slice(0, 16),
  };
  for (
    const output of [
      { ...validOutput, extra: true },
      { ...validOutput, sourceLanguage: 'ko' },
      { ...validOutput, targetLanguage: 'ko' },
      { ...validOutput, sourceSha256: '0'.repeat(64) },
    ]
  ) {
    await providerFailure(() => processor(async () => completion(output)).translate(base));
  }

  const detectionBase = {
    sourceBody: 'This neutral sentence invokes provider classification',
    sourceSha256: '',
    correlationId: base.correlationId,
  };
  detectionBase.sourceSha256 = await sha256Hex(detectionBase.sourceBody);
  for (
    const override of [
      { sourceBody: '' },
      { sourceBody: 'x'.repeat(20001) },
      { sourceSha256: 'x' },
      { sourceSha256: '0'.repeat(64) },
    ]
  ) {
    await badRequest(() =>
      processor(async () => {
        throw new Error('provider must not be called');
      }).detectLanguage({ ...detectionBase, ...override })
    );
  }
  const mixed = '한글 mixed language text';
  const mixedSha256 = await sha256Hex(mixed);
  const mixedResult = await processor(async () =>
    completion({
      detectedSourceLanguage: 'und',
      confidence: 0.5,
      ambiguous: true,
      sourceFingerprint: String(mixedSha256).slice(0, 16),
    })
  ).detectLanguage({
    sourceBody: mixed,
    sourceSha256: mixedSha256,
    correlationId: base.correlationId,
  });
  assertEquals(mixedResult.detectedSourceLanguage, 'und');

  const detectionOutput = {
    detectedSourceLanguage: 'en',
    confidence: 0.9,
    ambiguous: false,
    sourceFingerprint: String(detectionBase.sourceSha256).slice(0, 16),
  };
  for (
    const output of [
      { ...detectionOutput, extra: true },
      { ...detectionOutput, detectedSourceLanguage: 'fr' },
      { ...detectionOutput, sourceSha256: '0'.repeat(64) },
      { ...detectionOutput, ambiguous: 'false' },
      { ...detectionOutput, confidence: '0.9' },
      { ...detectionOutput, confidence: Number.NaN },
      { ...detectionOutput, confidence: -0.1 },
      { ...detectionOutput, confidence: 1.1 },
    ]
  ) {
    await providerFailure(() =>
      processor(async () => completion(output)).detectLanguage(detectionBase)
    );
  }
  // A named language flagged ambiguous is the model's judgment about a short
  // text, not a provider fault: the language and its confidence are kept.
  const flagged = await processor(async () =>
    completion({ ...detectionOutput, ambiguous: true, confidence: 0.6 })
  ).detectLanguage(detectionBase);
  assertEquals(flagged.detectedSourceLanguage, 'en');
  assertEquals(flagged.ambiguous, false);
  assertEquals(flagged.confidence, 0.6);
  // An undetermined language is always ambiguous, whatever the flag says.
  const undetermined = await processor(async () =>
    completion({ ...detectionOutput, detectedSourceLanguage: 'und', ambiguous: false })
  ).detectLanguage(detectionBase);
  assertEquals(undetermined.detectedSourceLanguage, 'und');
  assertEquals(undetermined.ambiguous, true);
});

Deno.test('OpenRouter summary validates source bounds and evidence provenance', async () => {
  const base = {
    language: 'en',
    sourceFingerprint: 'a'.repeat(64),
    sources: [{ messageId: '1', body: 'Stable coverage source' }],
    correlationId: '10000000-0000-4000-8000-000000000001',
  };
  for (
    const override of [
      { language: '*' },
      { sourceFingerprint: 'x' },
      { sources: [] },
      { sources: [{ messageId: '0', body: 'text' }] },
      { sources: [{ messageId: '1', body: 'text' }, { messageId: '1', body: 'text' }] },
      { sources: [{ messageId: '1', body: '' }] },
      { sources: [{ messageId: '1', body: 'x'.repeat(20001) }] },
    ]
  ) {
    await badRequest(() =>
      processor(async () => {
        throw new Error('provider must not be called');
      }).summarize({ ...base, ...override })
    );
  }

  // Over the cap is the reader's problem to fix (a shorter range), so it is
  // terminal rather than a bad request that would be retried elsewhere.
  await assertRejects(
    () =>
      processor(async () => {
        throw new Error('provider must not be called');
      }).summarize({ ...base, sources: Array(2001).fill({ messageId: '1', body: 'text' }) }),
    (error) => error instanceof ApiError && error.status === 422 && error.message === 'summary_range_too_long',
  );

  const validOutput = {
    primaryTopic: 'Coverage topic',
    summary: 'Coverage summary',
    keyTopics: [{ text: 'Topic', sourceRefs: ['s0001'] }],
    decisions: [{ text: 'Decision', sourceRefs: ['s0001'] }],
    actionItems: [{ text: 'Action', sourceRefs: ['s0001'], owner: null, due: null }],
    ambiguities: [{ text: 'Ambiguity', sourceRefs: ['s0001'] }],
  };
  for (
    const output of [
      { ...validOutput, extra: true },
      { ...validOutput, actionItems: 'invalid' },
      { ...validOutput, actionItems: Array(51).fill(validOutput.actionItems[0]) },
      { ...validOutput, actionItems: [{ ...validOutput.actionItems[0], extra: true }] },
      { ...validOutput, keyTopics: 'invalid' },
      { ...validOutput, keyTopics: Array(51).fill(validOutput.keyTopics[0]) },
      { ...validOutput, keyTopics: [{ text: 'Topic', sourceRefs: [] }] },
      { ...validOutput, keyTopics: [{ text: 'Topic', sourceRefs: 's0001' }] },
      { ...validOutput, keyTopics: [{ text: 'Topic', sourceRefs: ['s9999'] }] },
      { ...validOutput, keyTopics: [{ text: 'Topic', sourceRefs: ['s0001', 's0001'] }] },
      { ...validOutput, decisions: [{ text: '99 psi', sourceRefs: ['s0001'] }] },
      {
        ...validOutput,
        ambiguities: [{ text: '__NEWONE_PROTECTED_9999__', sourceRefs: ['s0001'] }],
      },
    ]
  ) {
    await assertRejects(() => processor(async () => completion(output)).summarize(base));
  }

  const result = await processor(async () =>
    completion({
      ...validOutput,
      actionItems: [{
        text: 'Action',
        sourceRefs: ['s0001'],
        owner: 'Coverage owner',
        due: 'Soon',
      }],
    })
  ).summarize(base);
  assertEquals(result.actionItems[0]?.owner, 'Coverage owner');
  assertEquals(result.actionItems[0]?.due, 'Soon');
});
