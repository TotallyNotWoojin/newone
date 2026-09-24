import { sha256Hex } from '../_shared/crypto.ts';
import { ApiError } from '../_shared/errors.ts';
import {
  parseOpenRouterEmployeeControlPlane,
  resetControlPlanePreflightCache,
} from '../_shared/openrouter-control-plane.ts';
import {
  type OpenRouterEnvironment,
  OpenRouterLanguageProcessor,
  parseOpenRouterFallbackProviders,
  parseOpenRouterPolicy,
  resetFallbackEligibilityCache,
  resetRouteProbeCache,
} from '../_shared/openrouter.ts';
import { assertEquals, assertRejects } from './assert.ts';

// Google Vertex, the only provider the policy pinned, answered "too busy"
// (a 429 OpenRouter passed on from upstream) to a share of translations and
// summaries for hours on Sep 23 2026, and with nowhere else to go they
// waited minutes. The owner chose Google first with zero-data-retention
// fallbacks. These cases pin what a fallback has to clear before it is used,
// and that an answer from anyone else is still refused.

const workspaceId = '00000000-0000-4000-8000-000000000700';
const apiKeyHash = 'a'.repeat(64);
const policyValue = {
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
  priceCeilingsUsdPerMillionTokens: { prompt: 0.25, completion: 1 },
};
const policy = parseOpenRouterPolicy(JSON.stringify(policyValue));
const FALLBACKS = [
  { tag: 'nebius/fp8', name: 'Nebius' },
  { tag: 'parasail/fp8', name: 'Parasail' },
  { tag: 'deepinfra/fp8', name: 'DeepInfra' },
];

function environment(fallbacks = FALLBACKS): OpenRouterEnvironment {
  return {
    apiKey: 'completion-key-that-is-long-enough',
    dataClassification: 'employee',
    employeeControlPlane: parseOpenRouterEmployeeControlPlane(
      'management-key-that-is-long-enough',
      apiKeyHash,
      workspaceId,
    ),
    policy,
    fallbackProviders: fallbacks,
  };
}

function zdrEndpoint(tag: string, providerName: string, extra: Record<string, unknown> = {}) {
  return {
    model_id: policyValue.model,
    tag,
    provider_name: providerName,
    status: 0,
    supports_implicit_caching: false,
    supported_parameters: ['structured_outputs', 'response_format'],
    pricing: { prompt: '0.0000002', completion: '0.0000008' },
    ...extra,
  };
}

interface FakeOptions {
  allowedProviders: string[] | null;
  /** DeepInfra caches prompts here, so it must not qualify. */
  deepInfraCaches?: boolean;
  /** The metadata the completion answers with. */
  metadata: (route: string[]) => Record<string, unknown>;
}

function fakeOpenRouter(options: FakeOptions) {
  const routes: string[][] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes(`/keys/${apiKeyHash}`)) {
      return Response.json({
        data: { hash: apiKeyHash, workspace_id: workspaceId, disabled: false, expires_at: null, limit_remaining: 10 },
      });
    }
    if (url.includes('/byok?')) return Response.json({ data: [], total_count: 0 });
    if (url.includes('/guardrails?')) {
      const data = [{
        id: '00000000-0000-4000-8000-000000000701',
        name: `Workspace ${workspaceId} Default`,
        workspace_id: workspaceId,
        enforce_zdr_google: true,
        content_filter_builtins: null,
        content_filters: null,
        allowed_models: [policyValue.model],
        allowed_providers: options.allowedProviders,
        ignored_models: null,
        ignored_providers: null,
      }];
      return Response.json({ data, total_count: data.length });
    }
    if (url.endsWith('/endpoints/zdr')) {
      return Response.json({
        data: [
          zdrEndpoint(policyValue.providerTag, 'Google'),
          zdrEndpoint('nebius/fp8', 'Nebius'),
          zdrEndpoint('parasail/fp8', 'Parasail'),
          zdrEndpoint('deepinfra/fp8', 'DeepInfra', { supports_implicit_caching: options.deepInfraCaches ?? true }),
        ],
      });
    }
    if (!url.endsWith('/chat/completions')) return new Response(null, { status: 404 });
    const body = JSON.parse(String(init?.body)) as {
      provider: { only: string[]; order: string[]; allow_fallbacks: boolean; zdr: boolean; data_collection: string };
      response_format: { json_schema: { name: string } };
    };
    routes.push(body.provider.order);
    // The route stays zero-retention and never reaches past its own list.
    assertEquals(body.provider.only, body.provider.order);
    assertEquals(body.provider.allow_fallbacks, false);
    assertEquals(body.provider.zdr, true);
    assertEquals(body.provider.data_collection, 'deny');
    if (body.response_format.json_schema.name === 'newone_employee_egress_route_probe') {
      return Response.json({
        id: 'gen-probe',
        model: policyValue.model,
        choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        openrouter_metadata: options.metadata(body.provider.order),
      });
    }
    return Response.json({
      id: 'gen-employee',
      model: policyValue.model,
      choices: [{
        message: {
          content: JSON.stringify({
            translatedText: 'Mantenga la línea.',
            sourceFingerprint: (sourceSha256 as string).slice(0, 16),
          }),
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      openrouter_metadata: options.metadata(body.provider.order),
    });
  };
  return { fetch, routes };
}

let sourceSha256: string | null = null;
const sourceBody = 'Hold the line.';

function reset() {
  resetControlPlanePreflightCache();
  resetRouteProbeCache();
  resetFallbackEligibilityCache();
}

/** Google refused, the next provider answered. */
function servedByFallback(provider: string) {
  return () => ({
    requested: policyValue.model,
    strategy: 'fallback',
    attempt: 2,
    is_byok: false,
    endpoints: {
      total: 12,
      available: [
        { provider: 'Google', model: 'qwen/qwen3-235b-a22b-07-25', selected: false },
        { provider, model: 'qwen/qwen3-235b-a22b-07-25', selected: true },
      ],
    },
    attempts: [
      { provider: 'Google', model: 'qwen/qwen3-235b-a22b-07-25', status: 429 },
      { provider, model: 'qwen/qwen3-235b-a22b-07-25', status: 200 },
    ],
    pipeline: [],
  });
}

async function translate(fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, env = environment()) {
  sourceSha256 = await sha256Hex(sourceBody);
  return await new OpenRouterLanguageProcessor(env, fetcher).translate({
    sourceBody,
    sourceLanguage: 'en',
    targetLanguage: 'es',
    sourceSha256,
    correlationId: '00000000-0000-4000-8000-000000000900',
    introducedTokenPolicy: 'allow',
  });
}

Deno.test('the fallback list is read strictly and never repeats the pinned route', () => {
  assertEquals(parseOpenRouterFallbackProviders(undefined, policy), []);
  assertEquals(parseOpenRouterFallbackProviders(JSON.stringify([
    { tag: 'google-vertex/us-south1', name: 'Google' },
    { tag: 'nebius/fp8', name: 'Nebius' },
    { tag: 'nebius/fp8', name: 'Nebius' },
  ]), policy), [{ tag: 'nebius/fp8', name: 'Nebius' }]);
  // Anything malformed leaves the pinned route on its own.
  assertEquals(parseOpenRouterFallbackProviders('{"tag":"nebius/fp8"}', policy), []);
  assertEquals(parseOpenRouterFallbackProviders(JSON.stringify([{ tag: 'Bad Tag', name: 'X' }]), policy), []);
  assertEquals(parseOpenRouterFallbackProviders(JSON.stringify([{ tag: 'nebius/fp8', name: 'Nebius', extra: 1 }]), policy), []);
});

Deno.test('only zero-retention fallbacks without prompt caching that the guardrail allows join the route, Google first', async () => {
  reset();
  const fake = fakeOpenRouter({
    allowedProviders: [policyValue.providerTag, 'nebius', 'deepinfra/fp8'],
    metadata: servedByFallback('Nebius'),
  });
  const result = await translate(fake.fetch);
  assertEquals(result.translatedText, 'Mantenga la línea.');
  // Parasail is not in the guardrail's allowed providers; DeepInfra caches.
  for (const route of fake.routes) assertEquals(route, [policyValue.providerTag, 'nebius/fp8']);
});

Deno.test('a guardrail that allows only Google keeps the pinned route alone, as before', async () => {
  reset();
  const fake = fakeOpenRouter({
    allowedProviders: [policyValue.providerTag],
    metadata: () => ({
      requested: policyValue.model,
      strategy: 'direct',
      attempt: 1,
      is_byok: false,
      endpoints: { total: 12, available: [{ provider: 'Google', model: 'qwen/qwen3-235b-a22b-07-25', selected: true }] },
      pipeline: [],
    }),
  });
  await translate(fake.fetch);
  for (const route of fake.routes) assertEquals(route, [policyValue.providerTag]);
});

Deno.test('an answer from a provider outside the route is refused even with fallbacks', async () => {
  reset();
  const fake = fakeOpenRouter({
    allowedProviders: null,
    deepInfraCaches: true,
    metadata: servedByFallback('DeepInfra'),
  });
  await assertRejects(
    () => translate(fake.fetch),
    (error) => error instanceof ApiError && error.code === 'provider_unavailable',
  );
});

Deno.test('without fallbacks the pinned route still insists on one direct attempt', async () => {
  reset();
  const fake = fakeOpenRouter({ allowedProviders: null, metadata: servedByFallback('Nebius') });
  await assertRejects(
    () => translate(fake.fetch, environment([])),
    (error) => error instanceof ApiError && error.code === 'provider_unavailable',
  );
});
