import { sha256Hex } from '../_shared/crypto.ts';
import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  CONTROL_PLANE_PREFLIGHT_TTL_MS,
  parseOpenRouterEmployeeControlPlane,
  resetControlPlanePreflightCache,
} from '../_shared/openrouter-control-plane.ts';
import {
  type OpenRouterEnvironment,
  OpenRouterLanguageProcessor,
  parseOpenRouterPolicy,
} from '../_shared/openrouter.ts';
import { type AiWorkerDependencies, createAiWorkerHandler } from '../newone-ai-worker/handler.ts';
import { assertEquals, assertRejects } from './assert.ts';

// The AI worker used to re-prove the OpenRouter employee control plane (four
// management-API calls) for every job. These cases pin the five-minute
// module-scope cache: a second job inside the window makes no management
// calls, expiry re-proves, and a failed proof is never remembered.

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
const sourceBody = 'Hold line MX-27 at 2.5 bar.';

const employeeEnvironment: OpenRouterEnvironment = {
  apiKey: 'completion-key-that-is-long-enough',
  dataClassification: 'employee',
  employeeControlPlane: parseOpenRouterEmployeeControlPlane(
    'management-key-that-is-long-enough',
    apiKeyHash,
    workspaceId,
  ),
  policy: parseOpenRouterPolicy(JSON.stringify(policyValue)),
};

function managementResponse(url: string, byokDisabled = true): Response {
  if (url.includes(`/keys/${apiKeyHash}`)) {
    return Response.json({
      data: {
        hash: apiKeyHash,
        workspace_id: workspaceId,
        disabled: false,
        expires_at: null,
        limit_remaining: 10,
      },
    });
  }
  if (url.includes('/byok?')) {
    const data = byokDisabled
      ? []
      : [{ workspace_id: workspaceId, provider: 'google-vertex', disabled: false }];
    return Response.json({ data, total_count: data.length });
  }
  if (url.includes('/guardrails?')) {
    const data = [{
      id: '00000000-0000-4000-8000-000000000701',
      name: `Workspace ${workspaceId} Default`,
      workspace_id: workspaceId,
      enforce_zdr_google: true,
      content_filter_builtins: null,
      content_filters: null,
      allowed_models: [policyValue.model],
      allowed_providers: [policyValue.providerTag],
      ignored_models: null,
      ignored_providers: null,
    }];
    return Response.json({ data, total_count: data.length });
  }
  if (url.endsWith('/endpoints/zdr')) {
    return Response.json({
      data: [{
        model_id: policyValue.model,
        tag: policyValue.providerTag,
        provider_name: policyValue.providerMetadataName,
        status: 0,
        supports_implicit_caching: false,
        supported_parameters: ['structured_outputs', 'response_format'],
        pricing: { prompt: '0.0000002', completion: '0.0000008' },
      }],
    });
  }
  return new Response(null, { status: 404 });
}

function directMetadata() {
  return {
    requested: policyValue.model,
    strategy: 'direct',
    attempt: 1,
    is_byok: false,
    endpoints: {
      total: 12,
      available: [{ provider: 'Google', model: 'qwen/qwen3-235b-a22b-07-25', selected: true }],
    },
    pipeline: [],
  };
}

/**
 * A fetcher that serves the management proofs and the completion route and
 * counts each class of call. Completions alternate between the synthetic
 * probe (first call of each job) and the real translation.
 */
function countingFetcher(sourceSha256: string, options: { byokDisabled?: boolean } = {}) {
  const counts = { management: 0, completions: 0 };
  let probeNext = true;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.endsWith('/chat/completions')) {
      counts.management += 1;
      return managementResponse(url, options.byokDisabled ?? true);
    }
    counts.completions += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const format = body.response_format as { json_schema: { name: string } };
    if (format.json_schema.name === 'newone_employee_egress_route_probe') {
      probeNext = false;
      return Response.json({
        id: 'gen-probe',
        model: policyValue.model,
        choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        openrouter_metadata: directMetadata(),
      });
    }
    probeNext = true;
    return Response.json({
      id: 'gen-employee',
      model: policyValue.model,
      choices: [{
        message: {
          content: JSON.stringify({
            translatedText: 'Mantenga __NEWONE_PROTECTED_0001__ a __NEWONE_PROTECTED_0002__.',
            sourceFingerprint: sourceSha256.slice(0, 16),
          }),
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      openrouter_metadata: directMetadata(),
    });
  };
  return { counts, fetch, probePending: () => probeNext };
}

function dependencies(
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  sourceSha256: string,
  jobIds: number[],
): AiWorkerDependencies {
  let claimed = 0;
  // The worker drains its queue within one request, so hand out at most one
  // job per worker id: the test measures preflight calls across requests.
  let lastWorker: string | null = null;
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public_value',
      secretKey,
    },
    openRouterEnvironment: employeeEnvironment,
    workerToken,
    workloads: ['translation'],
    claim: async (workerId) => {
      // Each worker request claims the next job id; nothing beyond the list.
      if (workerId === lastWorker) return { jobs: [] };
      lastWorker = workerId;
      const id = jobIds[claimed];
      claimed += 1;
      return {
        jobs: id === undefined ? [] : [{
          id,
          organization_id: organizationId,
          topic: 'translation',
          payload: {},
          attempts: 1,
        }],
      };
    },
    resolveDetection: async () => ({ authorized: false }),
    resolveTranslation: async () => ({
      authorized: true,
      source: {
        sourceBody,
        sourceLanguage: 'en',
        targetLanguage: 'es',
        sourceSha256,
        aiPolicyVersion: 1,
        processorId: policyValue.providerTag,
      },
    }),
    resolveSummary: async () => ({ authorized: false }),
    completeDetection: async () => {},
    completeTranslation: async () => {},
    completeSummary: async () => {},
    terminalFailure: async () => {},
    retryFailure: async () => {},
    processorFactory: (environment) => new OpenRouterLanguageProcessor(environment, fetcher),
  };
}

function request(): Request {
  return new Request('https://project.supabase.co/functions/v1/newone-ai-worker', {
    method: 'POST',
    headers: {
      apikey: secretKey,
      'X-Newone-Worker-Token': workerToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 1 }),
  });
}

Deno.test('a second AI job inside the five-minute window makes no control-plane preflight calls', async () => {
  let nowMs = 1_800_000_000_000;
  resetControlPlanePreflightCache(() => nowMs);
  try {
    const sourceSha256 = await sha256Hex(sourceBody);
    const fetcher = countingFetcher(sourceSha256);
    const handler = createAiWorkerHandler(() => dependencies(fetcher.fetch, sourceSha256, [1, 2, 3]));

    const first = await handler(request());
    assertEquals(first.status, 200);
    assertEquals((await first.json()).completed, 1);
    // Cold cache: the four management proofs, then the probe and the
    // translation completion.
    assertEquals(fetcher.counts, { management: 4, completions: 2 });

    nowMs += CONTROL_PLANE_PREFLIGHT_TTL_MS - 1;
    const second = await handler(request());
    assertEquals(second.status, 200);
    assertEquals((await second.json()).completed, 1);
    // Warm cache: no management call; the synthetic route probe still
    // precedes the employee text on every completion.
    assertEquals(fetcher.counts, { management: 4, completions: 4 });

    nowMs += 1;
    const third = await handler(request());
    assertEquals(third.status, 200);
    assertEquals((await third.json()).completed, 1);
    // Expired: the proofs run again and are cached afresh.
    assertEquals(fetcher.counts, { management: 8, completions: 6 });
  } finally {
    resetControlPlanePreflightCache();
  }
});

Deno.test('a failed control-plane proof is never cached and a clock jump backwards re-proves', async () => {
  let nowMs = 1_800_000_000_000;
  resetControlPlanePreflightCache(() => nowMs);
  try {
    const sourceSha256 = await sha256Hex(sourceBody);
    const failing = countingFetcher(sourceSha256, { byokDisabled: false });
    const processor = new OpenRouterLanguageProcessor(employeeEnvironment, failing.fetch);
    const translate = () =>
      processor.translate({
        sourceBody,
        sourceLanguage: 'en',
        targetLanguage: 'es',
        sourceSha256,
        correlationId: '00000000-0000-4000-8000-000000000710',
      });
    await assertRejects(
      translate,
      (error) => error instanceof ApiError && error.code === 'provider_unavailable',
    );
    await assertRejects(
      translate,
      (error) => error instanceof ApiError && error.code === 'provider_unavailable',
    );
    // Both attempts proved (and failed) against the management API and
    // neither transmitted employee text.
    assertEquals(failing.counts, { management: 8, completions: 0 });

    const healthy = countingFetcher(sourceSha256);
    const healthyProcessor = new OpenRouterLanguageProcessor(employeeEnvironment, healthy.fetch);
    const healthyTranslate = () =>
      healthyProcessor.translate({
        sourceBody,
        sourceLanguage: 'en',
        targetLanguage: 'es',
        sourceSha256,
        correlationId: '00000000-0000-4000-8000-000000000711',
      });
    await healthyTranslate();
    assertEquals(healthy.counts, { management: 4, completions: 2 });
    await healthyTranslate();
    assertEquals(healthy.counts, { management: 4, completions: 4 });

    // A clock that moves backwards (skew, restart) invalidates the entry
    // instead of extending it.
    nowMs -= 1;
    await healthyTranslate();
    assertEquals(healthy.counts, { management: 8, completions: 6 });
  } finally {
    resetControlPlanePreflightCache();
  }
});

Deno.test('a cached proof for one workspace never satisfies another key, workspace, or route', async () => {
  resetControlPlanePreflightCache(() => 1_800_000_000_000);
  try {
    const sourceSha256 = await sha256Hex(sourceBody);
    const fetcher = countingFetcher(sourceSha256);
    const processor = new OpenRouterLanguageProcessor(employeeEnvironment, fetcher.fetch);
    await processor.translate({
      sourceBody,
      sourceLanguage: 'en',
      targetLanguage: 'es',
      sourceSha256,
      correlationId: '00000000-0000-4000-8000-000000000712',
    });
    assertEquals(fetcher.counts.management, 4);

    const otherWorkspace: OpenRouterEnvironment = {
      ...employeeEnvironment,
      employeeControlPlane: parseOpenRouterEmployeeControlPlane(
        'management-key-that-is-long-enough',
        apiKeyHash,
        '00000000-0000-4000-8000-000000000799',
      ),
    };
    const other = new OpenRouterLanguageProcessor(otherWorkspace, fetcher.fetch);
    // The management fixture answers for the original workspace only, so the
    // other workspace's proof fails closed; a cache hit would have let the
    // probe through.
    await assertRejects(
      () =>
        other.translate({
          sourceBody,
          sourceLanguage: 'en',
          targetLanguage: 'es',
          sourceSha256,
          correlationId: '00000000-0000-4000-8000-000000000713',
        }),
      (error) => error instanceof ApiError && error.code === 'provider_unavailable',
    );
    assertEquals(fetcher.counts, { management: 8, completions: 2 });
  } finally {
    resetControlPlanePreflightCache();
  }
});

Deno.test('a fresh isolate reuses a persisted control-plane proof and makes no management calls', async () => {
  resetControlPlanePreflightCache();
  const sourceSha256 = await sha256Hex(sourceBody);
  const fetcher = countingFetcher(sourceSha256);
  const recorded: string[] = [];
  const store = {
    lookup: async (cacheKey: string) => {
      recorded.push(`lookup:${cacheKey.length}`);
      return Date.now() - 30_000;
    },
    record: async (cacheKey: string) => {
      recorded.push(`record:${cacheKey.length}`);
    },
  };
  const base = dependencies(fetcher.fetch, sourceSha256, [41]);
  const handler = createAiWorkerHandler(() => ({
    ...base,
    openRouterEnvironment: { ...employeeEnvironment, controlPlaneProofStore: store },
  }));
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals((await response.json()).completed, 1);
  // Only the route probe and the real completion touched the provider.
  assertEquals(fetcher.counts, { management: 0, completions: 2 });
  assertEquals(recorded, ['lookup:64']);
});

Deno.test('an unknown or expired persisted proof re-proves and records the new proof under a hashed key', async () => {
  resetControlPlanePreflightCache();
  const sourceSha256 = await sha256Hex(sourceBody);
  const fetcher = countingFetcher(sourceSha256);
  const recorded: string[] = [];
  const store = {
    lookup: async () => Date.now() - 6 * 60_000,
    record: async (cacheKey: string) => {
      recorded.push(cacheKey);
    },
  };
  const base = dependencies(fetcher.fetch, sourceSha256, [42]);
  const handler = createAiWorkerHandler(() => ({
    ...base,
    openRouterEnvironment: { ...employeeEnvironment, controlPlaneProofStore: store },
  }));
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals((await response.json()).completed, 1);
  assertEquals(fetcher.counts, { management: 4, completions: 2 });
  assertEquals(recorded.length, 1);
  assertEquals(/^[0-9a-f]{64}$/.test(recorded[0] ?? ''), true);
});
