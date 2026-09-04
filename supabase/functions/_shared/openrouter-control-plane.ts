import { ApiError } from './errors.ts';
import { asObject } from './validation.ts';

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANAGEMENT_RESPONSE_BYTES = 4 * 1024 * 1024;

export const DISABLED_OPENROUTER_PLUGINS = Object.freeze([
  Object.freeze({ id: 'web', enabled: false }),
  Object.freeze({ id: 'file-parser', enabled: false }),
  Object.freeze({ id: 'response-healing', enabled: false }),
  Object.freeze({ id: 'pareto-router', enabled: false }),
  Object.freeze({ id: 'context-compression', enabled: false }),
]);

export interface OpenRouterEmployeeControlPlane {
  managementApiKey: string;
  apiKeyHash: string;
  workspaceId: string;
}

export interface OpenRouterControlPlanePolicy {
  model: string;
  providerTag: string;
  providerMetadataName: string;
  priceCeilingsUsdPerMillionTokens: {
    prompt: number;
    completion: number;
  };
}

export type ControlPlaneFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function unavailable(): never {
  throw new ApiError(503, 'provider_unavailable', undefined, 5);
}

function page(value: unknown): { data: unknown[]; totalCount: number } {
  const envelope = asObject(value);
  if (
    !Array.isArray(envelope.data) || envelope.data.length > 100 ||
    !Number.isSafeInteger(envelope.total_count) || (envelope.total_count as number) < 0 ||
    envelope.total_count !== envelope.data.length
  ) unavailable();
  return { data: envelope.data, totalCount: envelope.total_count as number };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) unavailable();
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 2 || bytes.byteLength > MAX_MANAGEMENT_RESPONSE_BYTES) unavailable();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    unavailable();
  }
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) || value.length > 200 ||
    value.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 200)
  ) unavailable();
  return value as string[];
}

function noContentFilters(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

export function parseOpenRouterEmployeeControlPlane(
  managementApiKey: string | undefined,
  apiKeyHash: string | undefined,
  workspaceId: string | undefined,
): OpenRouterEmployeeControlPlane {
  const key = managementApiKey?.trim() ?? '';
  const hash = apiKeyHash?.trim().toLowerCase() ?? '';
  const workspace = workspaceId?.trim().toLowerCase() ?? '';
  if (key.length < 20 || !SHA256_PATTERN.test(hash) || !UUID_PATTERN.test(workspace)) {
    throw new ApiError(503, 'ai_processing_disabled');
  }
  return { managementApiKey: key, apiKeyHash: hash, workspaceId: workspace };
}

export async function verifyOpenRouterEmployeeControlPlane(
  controls: OpenRouterEmployeeControlPlane,
  policy: OpenRouterControlPlanePolicy,
  fetcher: ControlPlaneFetch,
  signal?: AbortSignal,
): Promise<void> {
  const baseProvider = policy.providerTag.split('/')[0];
  if (!baseProvider) unavailable();
  const managementHeaders = {
    'Authorization': `Bearer ${controls.managementApiKey}`,
    'Accept': 'application/json',
  };
  const workspace = encodeURIComponent(controls.workspaceId);
  const provider = encodeURIComponent(baseProvider);
  const [keyResponse, byokResponse, guardrailResponse, zdrResponse] = await Promise.all([
    fetcher(`${OPENROUTER_API}/keys/${controls.apiKeyHash}`, {
      headers: managementHeaders,
      signal,
    }),
    fetcher(
      `${OPENROUTER_API}/byok?workspace_id=${workspace}&provider=${provider}&limit=100&offset=0`,
      { headers: managementHeaders, signal },
    ),
    fetcher(
      `${OPENROUTER_API}/guardrails?workspace_id=${workspace}&limit=100&offset=0`,
      { headers: managementHeaders, signal },
    ),
    fetcher(`${OPENROUTER_API}/endpoints/zdr`, {
      headers: { 'Accept': 'application/json' },
      signal,
    }),
  ]).catch(() => unavailable());

  const [keyPayload, byokPayload, guardrailPayload, zdrPayload] = await Promise.all([
    boundedJson(keyResponse),
    boundedJson(byokResponse),
    boundedJson(guardrailResponse),
    boundedJson(zdrResponse),
  ]);

  const key = asObject(asObject(keyPayload).data);
  if (
    key.hash !== controls.apiKeyHash || key.workspace_id !== controls.workspaceId ||
    key.disabled !== false ||
    (key.expires_at !== null &&
      (typeof key.expires_at !== 'string' || Date.parse(key.expires_at) <= Date.now() + 60_000)) ||
    (key.limit_remaining !== null &&
      (typeof key.limit_remaining !== 'number' || !Number.isFinite(key.limit_remaining) ||
        key.limit_remaining <= 0))
  ) unavailable();

  const byok = page(byokPayload);
  if (byok.totalCount > 100) unavailable();
  for (const entry of byok.data) {
    const credential = asObject(entry);
    if (
      credential.workspace_id !== controls.workspaceId || credential.provider !== baseProvider ||
      credential.disabled !== true
    ) unavailable();
  }

  const guardrails = page(guardrailPayload);
  if (guardrails.totalCount < 1 || guardrails.totalCount > 100) unavailable();
  let workspaceDefaultCount = 0;
  for (const entry of guardrails.data) {
    const guardrail = asObject(entry);
    if (guardrail.workspace_id !== controls.workspaceId) unavailable();
    if (guardrail.name === `Workspace ${controls.workspaceId} Default`) {
      workspaceDefaultCount += 1;
      if (guardrail.enforce_zdr_google !== true) unavailable();
    }
    if (
      !noContentFilters(guardrail.content_filter_builtins ?? null) ||
      !noContentFilters(guardrail.content_filters ?? null)
    ) unavailable();
    const allowedModels = stringArrayOrNull(guardrail.allowed_models ?? null);
    const allowedProviders = stringArrayOrNull(guardrail.allowed_providers ?? null);
    const ignoredModels = stringArrayOrNull(guardrail.ignored_models ?? null);
    const ignoredProviders = stringArrayOrNull(guardrail.ignored_providers ?? null);
    if (
      (allowedModels !== null && !allowedModels.includes(policy.model)) ||
      (allowedProviders !== null &&
        !allowedProviders.includes(baseProvider) &&
        !allowedProviders.includes(policy.providerTag)) ||
      ignoredModels?.includes(policy.model) ||
      ignoredProviders?.includes(baseProvider) || ignoredProviders?.includes(policy.providerTag)
    ) unavailable();
  }
  if (workspaceDefaultCount !== 1) unavailable();

  const zdrEnvelope = asObject(zdrPayload);
  if (!Array.isArray(zdrEnvelope.data) || zdrEnvelope.data.length > 20_000) unavailable();
  const eligible = zdrEnvelope.data.filter((entry) => {
    const endpoint = asObject(entry);
    const supported = Array.isArray(endpoint.supported_parameters)
      ? endpoint.supported_parameters
      : [];
    const prompt = Number(asObject(endpoint.pricing).prompt) * 1_000_000;
    const completion = Number(asObject(endpoint.pricing).completion) * 1_000_000;
    return endpoint.model_id === policy.model && endpoint.tag === policy.providerTag &&
      endpoint.provider_name === policy.providerMetadataName && endpoint.status === 0 &&
      endpoint.supports_implicit_caching === false &&
      supported.includes('structured_outputs') && supported.includes('response_format') &&
      Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0 &&
      prompt <= policy.priceCeilingsUsdPerMillionTokens.prompt &&
      completion <= policy.priceCeilingsUsdPerMillionTokens.completion;
  });
  if (eligible.length < 1) unavailable();
}

// ---------------------------------------------------------------------------
// Preflight cache
// ---------------------------------------------------------------------------

/**
 * The four management-API proofs above describe workspace state that changes
 * on the order of days, yet the worker re-ran them for every job: a
 * detection followed by a translation cost eight management calls before any
 * tenant text moved. A successful proof is remembered in module scope for
 * five minutes per (key hash, workspace, model, route, ceilings) tuple.
 *
 * Fail-closed properties are preserved: a failed or aborted proof is never
 * cached (the error propagates and the next job re-proves), a proof for a
 * different key/workspace/route never satisfies another, an expired or
 * clock-skewed entry is discarded before re-proving, and the cache holds no
 * secret material (the management key is not part of the key).
 */
export const CONTROL_PLANE_PREFLIGHT_TTL_MS = 5 * 60_000;

interface PreflightCacheEntry {
  key: string;
  verifiedAt: number;
}

let preflightClock: () => number = Date.now;
let preflightCache: PreflightCacheEntry | null = null;

/**
 * Optional persistence for the proof: the Edge isolate is recycled between
 * most invocations, so the module-scope cache alone rarely survives long
 * enough to be hit. `lookup` returns the verified time for a key (null when
 * unknown or expired) and `record` stores a fresh success. A lookup failure is
 * a miss and a record failure is ignored: persistence only ever removes work,
 * never authorizes egress on its own, and the five-minute window applies to
 * whatever it returns.
 */
export interface ControlPlaneProofStore {
  lookup(cacheKey: string): Promise<number | null>;
  record(cacheKey: string, verifiedAt: number): Promise<void>;
}

/** SHA-256 over the tuple so the persisted key carries no material at all. */
async function persistedProofKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const preflightResetHooks: Array<(clock: () => number) => void> = [];

/**
 * Other proof caches (the route probe in openrouter.ts) register here so one
 * reset clears every cache and installs the same clock.
 */
export function registerPreflightResetHook(hook: (clock: () => number) => void): void {
  preflightResetHooks.push(hook);
}

/** Drops the cached proof and installs the clock the cache reads (tests). */
export function resetControlPlanePreflightCache(clock: () => number = Date.now): void {
  preflightCache = null;
  preflightClock = clock;
  for (const hook of preflightResetHooks) hook(clock);
}

function preflightCacheKey(
  controls: OpenRouterEmployeeControlPlane,
  policy: OpenRouterControlPlanePolicy,
): string {
  return JSON.stringify([
    controls.apiKeyHash,
    controls.workspaceId,
    policy.model,
    policy.providerTag,
    policy.providerMetadataName,
    policy.priceCeilingsUsdPerMillionTokens.prompt,
    policy.priceCeilingsUsdPerMillionTokens.completion,
  ]);
}

/**
 * verifyOpenRouterEmployeeControlPlane behind the five-minute cache. Resolves
 * with whether the proof was served from cache; rejects exactly as the
 * uncached proof does.
 */
export async function verifyOpenRouterEmployeeControlPlaneCached(
  controls: OpenRouterEmployeeControlPlane,
  policy: OpenRouterControlPlanePolicy,
  fetcher: ControlPlaneFetch,
  signal?: AbortSignal,
  store?: ControlPlaneProofStore,
): Promise<{ cached: boolean; persisted?: boolean }> {
  const key = preflightCacheKey(controls, policy);
  const now = preflightClock();
  if (
    preflightCache !== null && preflightCache.key === key &&
    now >= preflightCache.verifiedAt &&
    now - preflightCache.verifiedAt < CONTROL_PLANE_PREFLIGHT_TTL_MS
  ) {
    return { cached: true };
  }
  // Anything stale, skewed, or for another tuple is forgotten before the
  // proof runs, so a failure below leaves nothing that could authorize egress.
  preflightCache = null;
  if (store) {
    const persistedKey = await persistedProofKey(key);
    let verifiedAt: number | null = null;
    try {
      verifiedAt = await store.lookup(persistedKey);
    } catch {
      verifiedAt = null;
    }
    if (
      verifiedAt !== null && Number.isFinite(verifiedAt) && now >= verifiedAt &&
      now - verifiedAt < CONTROL_PLANE_PREFLIGHT_TTL_MS
    ) {
      preflightCache = { key, verifiedAt };
      return { cached: true, persisted: true };
    }
    await verifyOpenRouterEmployeeControlPlane(controls, policy, fetcher, signal);
    const provenAt = preflightClock();
    preflightCache = { key, verifiedAt: provenAt };
    try {
      await store.record(persistedKey, provenAt);
    } catch {
      // Persistence is an optimisation; the in-memory proof already stands.
    }
    return { cached: false, persisted: false };
  }
  await verifyOpenRouterEmployeeControlPlane(controls, policy, fetcher, signal);
  preflightCache = { key, verifiedAt: preflightClock() };
  return { cached: false };
}
