import { ApiError } from '../_shared/errors.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { OpenRouterLanguageProcessor, parseOpenRouterPolicy } from '../_shared/openrouter.ts';
import {
  parseOpenRouterEmployeeControlPlane,
  resetControlPlanePreflightCache,
  verifyOpenRouterEmployeeControlPlane,
} from '../_shared/openrouter-control-plane.ts';
import { assertEquals, assertRejects } from './assert.ts';

const workspaceId = '00000000-0000-4000-8000-000000000700';
const apiKeyHash = 'a'.repeat(64);
const controls = parseOpenRouterEmployeeControlPlane(
  'management-key-that-is-long-enough',
  apiKeyHash,
  workspaceId,
);
const policy = {
  model: 'qwen/qwen3-235b-a22b-2507',
  providerTag: 'google-vertex/us-south1',
  providerMetadataName: 'Google',
  priceCeilingsUsdPerMillionTokens: { prompt: 0.25, completion: 1 },
};
const providerModelReceipt = 'qwen/qwen3-235b-a22b-07-25';
const runtimePolicy = parseOpenRouterPolicy(JSON.stringify({
  policyVersion: '2026-08-04.2',
  employeeDataEgressEnabled: true,
  ...policy,
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
}));

function responseFor(url: string, overrides: Record<string, unknown> = {}): Response {
  if (url.includes(`/keys/${apiKeyHash}`)) {
    return Response.json({
      data: {
        hash: apiKeyHash,
        workspace_id: workspaceId,
        disabled: false,
        expires_at: null,
        limit_remaining: 10,
        ...overrides.key as object,
      },
    });
  }
  if (url.includes('/byok?')) {
    const data = overrides.byok ?? [];
    return Response.json({ data, total_count: Array.isArray(data) ? data.length : 0 });
  }
  if (url.includes('/guardrails?')) {
    const data = overrides.guardrails ?? [{
      id: '00000000-0000-4000-8000-000000000701',
      name: `Workspace ${workspaceId} Default`,
      workspace_id: workspaceId,
      enforce_zdr_google: true,
      content_filter_builtins: null,
      content_filters: null,
      allowed_models: [policy.model],
      allowed_providers: [policy.providerTag],
      ignored_models: null,
      ignored_providers: null,
    }];
    return Response.json({ data, total_count: Array.isArray(data) ? data.length : 0 });
  }
  if (url.endsWith('/endpoints/zdr')) {
    const data = overrides.zdr ?? [{
      model_id: policy.model,
      tag: policy.providerTag,
      provider_name: policy.providerMetadataName,
      status: 0,
      supports_implicit_caching: false,
      supported_parameters: ['structured_outputs', 'response_format'],
      pricing: { prompt: '0.0000002', completion: '0.0000008' },
    }];
    return Response.json({ data });
  }
  return new Response(null, { status: 404 });
}

function fetcher(overrides: Record<string, unknown> = {}) {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  return {
    seen,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      seen.push({ url, authorization });
      return responseFor(url, overrides);
    },
  };
}

Deno.test('employee control-plane check proves key, workspace, no BYOK, guardrails, and exact uncached ZDR endpoint', async () => {
  const mock = fetcher();
  await verifyOpenRouterEmployeeControlPlane(controls, policy, mock.fetch);
  assertEquals(mock.seen.length, 4);
  assertEquals(mock.seen.filter((entry) => entry.authorization !== null).length, 3);
  assertEquals(
    mock.seen.find((entry) => entry.url.endsWith('/endpoints/zdr'))?.authorization,
    null,
  );
});

Deno.test('employee control-plane check fails before content egress for BYOK, filters, caching, and identity drift', async () => {
  const failures = [
    { key: { workspace_id: '00000000-0000-4000-8000-000000000799' } },
    {
      byok: [{
        workspace_id: workspaceId,
        provider: 'google-vertex',
        disabled: false,
      }],
    },
    {
      guardrails: [{
        name: `Workspace ${workspaceId} Default`,
        workspace_id: workspaceId,
        enforce_zdr_google: true,
        content_filter_builtins: [{ slug: 'email', action: 'redact' }],
        content_filters: null,
        allowed_models: null,
        allowed_providers: null,
        ignored_models: null,
        ignored_providers: null,
      }],
    },
    {
      zdr: [{
        model_id: policy.model,
        tag: policy.providerTag,
        provider_name: policy.providerMetadataName,
        status: 0,
        supports_implicit_caching: true,
        supported_parameters: ['structured_outputs', 'response_format'],
        pricing: { prompt: '0.0000002', completion: '0.0000008' },
      }],
    },
  ];
  for (const override of failures) {
    const mock = fetcher(override);
    await assertRejects(
      () => verifyOpenRouterEmployeeControlPlane(controls, policy, mock.fetch),
      (error) => error instanceof ApiError && error.code === 'provider_unavailable',
    );
  }
});

Deno.test('employee control-plane configuration rejects missing or malformed management identity', async () => {
  for (
    const values of [
      ['', apiKeyHash, workspaceId],
      ['management-key-that-is-long-enough', 'not-a-hash', workspaceId],
      ['management-key-that-is-long-enough', apiKeyHash, 'not-a-workspace'],
    ] as const
  ) {
    await assertRejects(
      () => Promise.resolve(parseOpenRouterEmployeeControlPlane(values[0], values[1], values[2])),
      (error) => error instanceof ApiError && error.code === 'ai_processing_disabled',
    );
  }
});

function directMetadata() {
  return {
    requested: policy.model,
    strategy: 'direct',
    attempt: 1,
    is_byok: false,
    endpoints: {
      total: 12,
      available: [{ provider: 'Google', model: providerModelReceipt, selected: true }],
    },
    pipeline: [],
  };
}

Deno.test('employee processor proves controls with synthetic content before sending employee text', async () => {
  // The processor caches a successful proof in module scope; each case
  // starts from a cold cache so it exercises the live proof.
  resetControlPlanePreflightCache();
  const sourceBody = 'Hold line MX-27 at 2.5 bar.';
  const sourceSha256 = await sha256Hex(sourceBody);
  const completionBodies: Record<string, unknown>[] = [];
  const processor = new OpenRouterLanguageProcessor({
    apiKey: 'completion-key-that-is-long-enough',
    dataClassification: 'employee',
    employeeControlPlane: controls,
    policy: runtimePolicy,
  }, async (input, init) => {
    const url = String(input);
    if (!url.endsWith('/chat/completions')) return responseFor(url);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    completionBodies.push(body);
    if (completionBodies.length === 1) {
      return Response.json({
        id: 'gen-probe',
        model: policy.model,
        choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        openrouter_metadata: directMetadata(),
      });
    }
    return Response.json({
      id: 'gen-employee',
      model: policy.model,
      choices: [{
        message: {
          content: JSON.stringify({
            translatedText: 'Mantenga __NEWONE_PROTECTED_0001__ a __NEWONE_PROTECTED_0002__.',
            sourceLanguage: 'en',
            targetLanguage: 'es',
            sourceSha256,
          }),
        },
      }],
      openrouter_metadata: directMetadata(),
    });
  });
  const result = await processor.translate({
    sourceBody,
    sourceLanguage: 'en',
    targetLanguage: 'es',
    sourceSha256,
    correlationId: '00000000-0000-4000-8000-000000000702',
  });
  assertEquals(completionBodies.length, 2);
  assertEquals(JSON.stringify(completionBodies[0]).includes('MX-27'), false);
  assertEquals(JSON.stringify(completionBodies[1]).includes('__NEWONE_PROTECTED_0001__'), true);
  assertEquals(result.translatedText, 'Mantenga MX-27 a 2.5 bar.');
});

Deno.test('employee processor never sends employee text when pre-egress controls fail', async () => {
  // The processor caches a successful proof in module scope; each case
  // starts from a cold cache so it exercises the live proof.
  resetControlPlanePreflightCache();
  const sourceBody = 'Private employee line MX-27.';
  const sourceSha256 = await sha256Hex(sourceBody);
  const completionBodies: string[] = [];
  const processor = new OpenRouterLanguageProcessor({
    apiKey: 'completion-key-that-is-long-enough',
    dataClassification: 'employee',
    employeeControlPlane: controls,
    policy: runtimePolicy,
  }, async (input, init) => {
    const url = String(input);
    if (url.includes('/byok?')) {
      return responseFor(url, {
        byok: [{ workspace_id: workspaceId, provider: 'google-vertex', disabled: false }],
      });
    }
    if (url.endsWith('/chat/completions')) completionBodies.push(String(init?.body));
    return responseFor(url);
  });
  await assertRejects(
    () =>
      processor.translate({
        sourceBody,
        sourceLanguage: 'en',
        targetLanguage: 'es',
        sourceSha256,
        correlationId: '00000000-0000-4000-8000-000000000703',
      }),
    (error) => error instanceof ApiError && error.code === 'provider_unavailable',
  );
  assertEquals(completionBodies.length, 0);
});
