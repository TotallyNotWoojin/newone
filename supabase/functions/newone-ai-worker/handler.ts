import {
  type ClientEnvironment,
  createAdminClient,
  loadClientEnvironment,
} from '../_shared/clients.ts';
import { safeEqual } from '../_shared/crypto.ts';
import { ApiError, asApiError } from '../_shared/errors.ts';
import {
  buildRequestMeta,
  ensureSecureTransport,
  errorResponse,
  jsonResponse,
  loadRuntimeConfig,
  parseJson,
  requestId,
  type RequestMeta,
  type RuntimeConfig,
} from '../_shared/http.ts';
import {
  loadOpenRouterEnvironment,
  type OpenRouterEnvironment,
  OpenRouterLanguageProcessor,
  type SummaryResult,
} from '../_shared/openrouter.ts';
import { asRpcClient, invokeRpc, invokeVoidRpc } from '../_shared/rpc.ts';
import {
  asObject,
  bool,
  integer,
  normalizedString,
  onlyKeys,
  uuid,
} from '../_shared/validation.ts';

export const AI_WORKLOADS = ['language_detection', 'translation', 'summary'] as const;
export type AiWorkload = typeof AI_WORKLOADS[number];

interface AiJob {
  id: string;
  organizationId: string;
  topic: AiWorkload;
  attempts: number;
}

interface PolicyResolution {
  aiPolicyVersion: number;
  processorId: string;
}

interface DetectionSource extends PolicyResolution {
  sourceBody: string;
  sourceSha256: string;
}

interface TranslationSource extends PolicyResolution {
  sourceBody: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceSha256: string;
}

export interface SummarySourceResolution extends PolicyResolution {
  sourceFingerprint: string;
  language: string;
  sources: Array<{ messageId: string; body: string }>;
}

type Resolution<T> = { authorized: false } | { authorized: true; source: T };

export interface AiWorkerDependencies {
  runtimeConfig: RuntimeConfig;
  clientEnvironment: ClientEnvironment;
  openRouterEnvironment: OpenRouterEnvironment;
  workerToken: string;
  workloads: AiWorkload[];
  setCorrelationId?(correlationId: string): void;
  claim(workerId: string, workload: AiWorkload, limit: number): Promise<unknown>;
  resolveDetection(workerId: string, job: AiJob): Promise<Resolution<DetectionSource>>;
  resolveTranslation(workerId: string, job: AiJob): Promise<Resolution<TranslationSource>>;
  resolveSummary(workerId: string, job: AiJob): Promise<Resolution<SummarySourceResolution>>;
  completeDetection(
    workerId: string,
    job: AiJob,
    source: DetectionSource,
    result: Awaited<ReturnType<OpenRouterLanguageProcessor['detectLanguage']>>,
  ): Promise<void>;
  completeTranslation(
    workerId: string,
    job: AiJob,
    source: TranslationSource,
    result: Awaited<ReturnType<OpenRouterLanguageProcessor['translate']>>,
  ): Promise<void>;
  completeSummary(
    workerId: string,
    job: AiJob,
    source: SummarySourceResolution,
    result: SummaryResult,
  ): Promise<void>;
  terminalFailure(
    workerId: string,
    job: AiJob,
    sourceHash: string | null,
    code: string,
  ): Promise<void>;
  retryFailure(workerId: string, job: AiJob, code: string, retrySeconds: number): Promise<void>;
  processorFactory(environment: OpenRouterEnvironment): OpenRouterLanguageProcessor;
}

function requiredSecret(name: string, minimumLength: number): string {
  const value = Deno.env.get(name)?.trim() ?? '';
  if (value.length < minimumLength) throw new Error(`${name} is not configured`);
  return value;
}

function configuredWorkloads(): AiWorkload[] {
  const raw = Deno.env.get('NEWONE_AI_WORKLOADS')?.trim() || AI_WORKLOADS.join(',');
  const values = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (
    values.length === 0 || values.length > AI_WORKLOADS.length ||
    new Set(values).size !== values.length
  ) {
    throw new Error('NEWONE_AI_WORKLOADS must contain unique supported workloads');
  }
  return values.map((value) => {
    if (!(AI_WORKLOADS as readonly string[]).includes(value)) {
      throw new Error('NEWONE_AI_WORKLOADS contains an unsupported workload');
    }
    return value as AiWorkload;
  });
}

function positiveBigint(value: unknown): string {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^[1-9][0-9]{0,18}$/.test(text)) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return text;
}

function language(value: unknown): string {
  const result = normalizedString(value, { min: 2, max: 35 }) as string;
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(result)) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return result;
}

function sha256(value: unknown): string {
  const result = normalizedString(value, { min: 64, max: 64 }) as string;
  if (!/^[0-9a-f]{64}$/.test(result)) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return result;
}

function parseClaim(value: unknown, expectedTopic: AiWorkload, limit: number): AiJob[] {
  try {
    const envelope = asObject(value);
    onlyKeys(envelope, ['jobs']);
    if (!Array.isArray(envelope.jobs) || envelope.jobs.length > limit) throw new Error('invalid');
    return envelope.jobs.map((entry) => {
      const row = asObject(entry);
      onlyKeys(row, ['id', 'organization_id', 'topic', 'payload', 'attempts']);
      if (row.topic !== expectedTopic) throw new Error('invalid');
      // The database resolver, not the queue payload, is the only source of
      // employee content or authorization. Validate only bounded identity here.
      asObject(row.payload);
      return {
        id: positiveBigint(row.id),
        organizationId: uuid(row.organization_id),
        topic: expectedTopic,
        attempts: integer(row.attempts, 1, 1000),
      };
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
}

function policyResolution(
  value: unknown,
  expectedOrganizationId: string,
  expectedProcessorId: string,
): { row: Record<string, unknown>; policy: PolicyResolution } | { denied: true } {
  const row = asObject(value);
  if (row.authorized === false) {
    if (row.provider_egress_allowed !== false) {
      throw new ApiError(503, 'dependency_unavailable', undefined, 30);
    }
    return { denied: true };
  }
  if (
    row.authorized !== true || row.provider_egress_allowed !== true ||
    row.organization_id !== expectedOrganizationId || row.processor_id !== expectedProcessorId ||
    row.route_policy !== 'approved_zero_retention' ||
    row.provider_route_policy !== 'zero_retention_only'
  ) throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  return {
    row,
    policy: {
      aiPolicyVersion: integer(row.ai_policy_version, 1, 2_147_483_647),
      processorId: expectedProcessorId,
    },
  };
}

function parseDetectionResolution(
  value: unknown,
  job: AiJob,
  provider: string,
): Resolution<DetectionSource> {
  const resolved = policyResolution(value, job.organizationId, provider);
  if ('denied' in resolved) return { authorized: false };
  const row = resolved.row;
  positiveBigint(row.message_id);
  uuid(row.conversation_id);
  return {
    authorized: true,
    source: {
      ...resolved.policy,
      sourceBody: normalizedString(row.source_body, {
        min: 1,
        max: 20_000,
        trim: false,
      }) as string,
      sourceSha256: sha256(row.source_sha256),
    },
  };
}

function parseTranslationResolution(
  value: unknown,
  job: AiJob,
  provider: string,
): Resolution<TranslationSource> {
  const resolved = policyResolution(value, job.organizationId, provider);
  if ('denied' in resolved) return { authorized: false };
  const row = resolved.row;
  positiveBigint(row.message_id);
  positiveBigint(row.translation_id);
  uuid(row.conversation_id);
  const sourceLanguage = language(row.source_language);
  const targetLanguage = language(row.target_language);
  if (sourceLanguage === targetLanguage) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return {
    authorized: true,
    source: {
      ...resolved.policy,
      sourceBody: normalizedString(row.source_body, {
        min: 1,
        max: 20_000,
        trim: false,
      }) as string,
      sourceLanguage,
      targetLanguage,
      sourceSha256: sha256(row.source_sha256),
    },
  };
}

function parseSummaryResolution(
  value: unknown,
  job: AiJob,
  provider: string,
): Resolution<SummarySourceResolution> {
  const resolved = policyResolution(value, job.organizationId, provider);
  if ('denied' in resolved) return { authorized: false };
  const row = resolved.row;
  uuid(row.summary_id);
  uuid(row.conversation_id);
  uuid(row.requested_by_user_id);
  if (!Array.isArray(row.messages) || row.messages.length < 1 || row.messages.length > 200) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  const sources = row.messages.map((entry) => {
    const message = asObject(entry);
    const messageId = positiveBigint(message.message_id);
    return {
      messageId,
      body: normalizedString(message.body, { min: 1, max: 20_000, trim: false }) as string,
    };
  });
  if (new Set(sources.map((source) => source.messageId)).size !== sources.length) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return {
    authorized: true,
    source: {
      ...resolved.policy,
      sourceFingerprint: sha256(row.source_fingerprint),
      language: language(row.language_code),
      sources,
    },
  };
}

function retryDelay(job: AiJob, error: ApiError): number {
  return Math.max(
    5,
    Math.min(3600, error.retryAfterSeconds ?? Math.min(3600, 15 * 2 ** job.attempts)),
  );
}

function terminal(error: ApiError, attempts: number): boolean {
  return attempts >= 10 || error.code === 'ai_output_needs_review' || error.status === 400 ||
    error.status === 422;
}

function failureCode(error: unknown): string {
  return asApiError(error).code.slice(0, 120);
}

function evidenceText(text: string, refs: string[], maximum: number): string {
  const suffix = ` [sources:${refs.join(',')}]`;
  const value = `${text}${suffix}`;
  if (value.length > maximum) throw new ApiError(422, 'ai_output_needs_review');
  return value;
}

function sourceMessageIds(result: SummaryResult, refs: string[]): string[] {
  return refs.map((reference) => {
    const messageId = result.sourceMap[reference];
    if (!messageId) throw new ApiError(422, 'ai_output_needs_review');
    return messageId;
  });
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function summaryPersistence(result: SummaryResult, source: SummarySourceResolution) {
  const keyTopics = result.keyTopics.map((entry) =>
    evidenceText(entry.text, entry.sourceRefs, 500)
  );
  const ambiguities = result.ambiguities.map((entry) =>
    evidenceText(entry.text, entry.sourceRefs, 2000)
  );
  const decisions = result.decisions.map((entry) => ({
    text: entry.text,
    sourceRefs: entry.sourceRefs,
    sourceMessageIds: sourceMessageIds(result, entry.sourceRefs),
  }));
  const actionItems = result.actionItems.map((entry) => ({
    text: entry.text,
    sourceRefs: entry.sourceRefs,
    sourceMessageIds: sourceMessageIds(result, entry.sourceRefs),
    owner: entry.owner,
    due: entry.due,
  }));
  if (jsonBytes(decisions) > 32_768 || jsonBytes(actionItems) > 32_768) {
    throw new ApiError(422, 'ai_output_needs_review');
  }
  const provenance = {
    contractVersion: 1,
    organizationAiPolicyVersion: source.aiPolicyVersion,
    routePolicyVersion: result.policyVersion,
    providerRoute: result.providerRoute,
    generationId: result.generationId,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    sourceMap: result.sourceMap,
    evidenceEncoding: 'inline-source-refs-v1',
    humanReviewRequired: true,
  };
  if (jsonBytes(provenance) > 16_384) throw new ApiError(422, 'ai_output_needs_review');
  return { keyTopics, decisions, actionItems, ambiguities, provenance };
}

export function defaultAiWorkerDependencies(): AiWorkerDependencies {
  const runtimeConfig = loadRuntimeConfig();
  const clientEnvironment = loadClientEnvironment();
  const openRouterEnvironment = loadOpenRouterEnvironment();
  const workerToken = requiredSecret('NEWONE_WORKER_TOKEN', 32);
  const workloads = configuredWorkloads();
  let admin = createAdminClient(clientEnvironment);
  const provider = openRouterEnvironment.policy.providerTag;
  return {
    runtimeConfig,
    clientEnvironment,
    openRouterEnvironment,
    workerToken,
    workloads,
    setCorrelationId(correlationId) {
      admin = createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId });
    },
    claim(workerId, workload, limit) {
      const rpc = workload === 'language_detection'
        ? 'bff_claim_language_detection_jobs'
        : workload === 'translation'
        ? 'bff_claim_translation_jobs'
        : 'bff_claim_summary_jobs';
      return invokeRpc(asRpcClient(admin), rpc, {
        p_worker_id: workerId,
        p_limit: limit,
        p_lease_seconds: workload === 'summary' ? 300 : 120,
      });
    },
    async resolveDetection(workerId, job) {
      return parseDetectionResolution(
        await invokeRpc(asRpcClient(admin), 'bff_resolve_language_detection_job_source', {
          p_worker_id: workerId,
          p_job_id: job.id,
          p_provider: provider,
        }),
        job,
        provider,
      );
    },
    async resolveTranslation(workerId, job) {
      return parseTranslationResolution(
        await invokeRpc(asRpcClient(admin), 'bff_resolve_translation_job_for_egress', {
          p_worker_id: workerId,
          p_job_id: job.id,
          p_provider: provider,
        }),
        job,
        provider,
      );
    },
    async resolveSummary(workerId, job) {
      return parseSummaryResolution(
        await invokeRpc(asRpcClient(admin), 'bff_resolve_summary_job_sources', {
          p_worker_id: workerId,
          p_job_id: job.id,
          p_provider: provider,
        }),
        job,
        provider,
      );
    },
    async completeDetection(workerId, job, source, result) {
      await invokeRpc(asRpcClient(admin), 'bff_complete_language_detection_job', {
        p_worker_id: workerId,
        p_job_id: job.id,
        p_source_sha256: source.sourceSha256,
        p_detection_state: result.ambiguous ? 'ambiguous' : 'completed',
        p_detected_language: result.detectedSourceLanguage,
        p_method: result.method,
        p_confidence: result.confidence,
      });
    },
    async completeTranslation(workerId, job, source, result) {
      await invokeVoidRpc(asRpcClient(admin), 'bff_complete_translation_job', {
        p_worker_id: workerId,
        p_job_id: job.id,
        p_source_sha256: source.sourceSha256,
        p_translated_body: result.translatedText,
        p_provider: source.processorId,
        p_model: result.model,
        p_confidence: null,
      });
    },
    async completeSummary(workerId, job, source, result) {
      const persisted = summaryPersistence(result, source);
      await invokeRpc(asRpcClient(admin), 'bff_complete_summary_job', {
        p_worker_id: workerId,
        p_job_id: job.id,
        p_source_fingerprint: source.sourceFingerprint,
        p_primary_topic: result.primaryTopic,
        p_summary_body: result.summary,
        p_key_topics: persisted.keyTopics,
        p_decisions: persisted.decisions,
        p_action_items: persisted.actionItems,
        p_ambiguities: persisted.ambiguities,
        p_provider: source.processorId,
        p_model: result.model,
        p_provenance: persisted.provenance,
      });
    },
    async terminalFailure(workerId, job, sourceHash, code) {
      if (job.topic === 'language_detection') {
        if (!sourceHash) throw new ApiError(503, 'dependency_unavailable', undefined, 30);
        await invokeRpc(asRpcClient(admin), 'bff_fail_language_detection_job', {
          p_worker_id: workerId,
          p_job_id: job.id,
          p_source_sha256: sourceHash,
          p_method: 'newone-detector-v1',
          p_error_code: code,
        });
        return;
      }
      if (job.topic === 'summary') {
        await invokeRpc(asRpcClient(admin), 'bff_fail_summary_job', {
          p_worker_id: workerId,
          p_job_id: job.id,
          p_failure_code: code,
        });
        return;
      }
      if (!sourceHash) throw new ApiError(503, 'dependency_unavailable', undefined, 30);
      await invokeRpc(asRpcClient(admin), 'bff_fail_translation_job', {
        p_worker_id: workerId,
        p_job_id: job.id,
        p_source_sha256: sourceHash,
        p_provider: provider,
        p_error_code: code,
      });
    },
    async retryFailure(workerId, job, code, retrySeconds) {
      await invokeVoidRpc(asRpcClient(admin), 'bff_fail_outbox_job', {
        p_worker_id: workerId,
        p_job_id: job.id,
        p_error_code: code,
        p_retry_seconds: retrySeconds,
      });
    },
    processorFactory(environment) {
      return new OpenRouterLanguageProcessor(environment);
    },
  };
}

async function processJob(
  dependencies: AiWorkerDependencies,
  processor: OpenRouterLanguageProcessor,
  workerId: string,
  correlationId: string,
  job: AiJob,
): Promise<'completed' | 'skipped' | 'failed'> {
  let sourceHash: string | null = null;
  try {
    if (job.topic === 'language_detection') {
      const resolution = await dependencies.resolveDetection(workerId, job);
      if (!resolution.authorized) return 'skipped';
      sourceHash = resolution.source.sourceSha256;
      const result = await processor.detectLanguage({
        sourceBody: resolution.source.sourceBody,
        sourceSha256: resolution.source.sourceSha256,
        correlationId,
      });
      await dependencies.completeDetection(workerId, job, resolution.source, result);
      return 'completed';
    }
    if (job.topic === 'translation') {
      const resolution = await dependencies.resolveTranslation(workerId, job);
      if (!resolution.authorized) return 'skipped';
      sourceHash = resolution.source.sourceSha256;
      const result = await processor.translate({
        sourceBody: resolution.source.sourceBody,
        sourceLanguage: resolution.source.sourceLanguage,
        targetLanguage: resolution.source.targetLanguage,
        sourceSha256: resolution.source.sourceSha256,
        correlationId,
      });
      await dependencies.completeTranslation(workerId, job, resolution.source, result);
      return 'completed';
    }
    const resolution = await dependencies.resolveSummary(workerId, job);
    if (!resolution.authorized) return 'skipped';
    sourceHash = resolution.source.sourceFingerprint;
    const result = await processor.summarize({
      sources: resolution.source.sources,
      sourceFingerprint: resolution.source.sourceFingerprint,
      language: resolution.source.language,
      correlationId,
    });
    await dependencies.completeSummary(workerId, job, resolution.source, result);
    return 'completed';
  } catch (error) {
    const safe = asApiError(error);
    try {
      if (terminal(safe, job.attempts) && sourceHash) {
        await dependencies.terminalFailure(workerId, job, sourceHash, safe.code.slice(0, 120));
      } else {
        await dependencies.retryFailure(
          workerId,
          job,
          safe.code.slice(0, 120),
          retryDelay(job, safe),
        );
      }
    } catch {
      // The active lease remains the only source of truth. It will expire and
      // be retried; never claim completion when a terminal write failed.
    }
    console.error(JSON.stringify({
      event: 'newone_ai_job_failed',
      correlation_id: correlationId,
      job_id: job.id,
      workload: job.topic,
      code: failureCode(error),
    }));
    return 'failed';
  }
}

function authenticateWorker(
  request: Request,
  expectedWorkerToken: string,
  expectedServerKey: string,
): void {
  const apiKey = request.headers.get('apikey') ?? '';
  const workerToken = request.headers.get('x-newone-worker-token') ?? '';
  if (
    request.headers.has('authorization') || !safeEqual(apiKey, expectedServerKey) ||
    !safeEqual(workerToken, expectedWorkerToken)
  ) throw new ApiError(401, 'unauthorized');
  if (request.headers.has('cookie') || request.headers.has('origin')) {
    throw new ApiError(403, 'forbidden');
  }
}

function fallbackMeta(request: Request): RequestMeta {
  return { requestId: requestId(request), origin: null, corsHeaders: new Headers() };
}

// Drain budget per invocation: well inside the wake/cron HTTP timeout so the
// caller never drops a working pass, and bounded rounds so a pathological
// queue cannot pin a single isolate.
const AI_WORKER_DRAIN_BUDGET_MS = 6_000;
const AI_WORKER_MAX_ROUNDS = 8;

export function createAiWorkerHandler(
  dependencyFactory: () => AiWorkerDependencies = defaultAiWorkerDependencies,
): (request: Request) => Promise<Response> {
  let dependencies: AiWorkerDependencies | undefined;
  return async (request: Request): Promise<Response> => {
    let meta = fallbackMeta(request);
    try {
      dependencies ??= dependencyFactory();
      ensureSecureTransport(request, dependencies.runtimeConfig);
      meta = buildRequestMeta(request, dependencies.runtimeConfig);
      dependencies.setCorrelationId?.(meta.requestId);
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
      authenticateWorker(
        request,
        dependencies.workerToken,
        dependencies.clientEnvironment.secretKey,
      );
      const body = asObject((await parseJson(request, dependencies.runtimeConfig)).value);
      onlyKeys(body, ['limit']);
      const limit = body.limit === undefined ? 3 : integer(body.limit, 1, 10);
      const workerId = crypto.randomUUID();
      const processor = dependencies.processorFactory(dependencies.openRouterEnvironment);
      const results: Array<'completed' | 'skipped' | 'failed'> = [];
      // Completing a detection enqueues the translation for the same message.
      // Claiming a single batch and returning left that follow-up job waiting
      // for the next wake or the 10-second cron (measured: ~4s detection then
      // ~7s translation). Keep claiming until the AI queue is empty or the
      // time budget is spent, so a message is translated in one pass.
      const startedAt = Date.now();
      // A claim leases a job, so the database never hands the same id back
      // within this pass; treat a repeat as "nothing new" and stop rather than
      // process it twice.
      const seen = new Set<string>();
      let claimed = 0;
      let rounds = 0;
      while (rounds < AI_WORKER_MAX_ROUNDS && Date.now() - startedAt < AI_WORKER_DRAIN_BUDGET_MS) {
        const jobs: AiJob[] = [];
        for (const workload of dependencies.workloads) {
          const remaining = limit - jobs.length;
          if (remaining <= 0) break;
          jobs.push(
            ...parseClaim(
              await dependencies.claim(workerId, workload, remaining),
              workload,
              remaining,
            ).filter((job) => !seen.has(job.id)),
          );
        }
        rounds += 1;
        if (jobs.length === 0) break;
        for (const job of jobs) seen.add(job.id);
        claimed += jobs.length;
        for (const job of jobs) {
          results.push(await processJob(dependencies, processor, workerId, meta.requestId, job));
        }
      }
      return jsonResponse(meta, 200, {
        claimed,
        completed: results.filter((result) => result === 'completed').length,
        skipped: results.filter((result) => result === 'skipped').length,
        failed: results.filter((result) => result === 'failed').length,
        workloads: dependencies.workloads,
      });
    } catch (error) {
      const safe = asApiError(error);
      if (safe.status >= 500) {
        console.error(JSON.stringify({
          event: 'newone_ai_worker_failure',
          correlation_id: meta.requestId,
          code: safe.code,
        }));
      }
      return errorResponse(meta, error);
    }
  };
}
