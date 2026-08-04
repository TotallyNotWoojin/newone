import {
  type ClientEnvironment,
  createAdminClient,
  loadClientEnvironment,
} from '../_shared/clients.ts';
import { safeEqual } from '../_shared/crypto.ts';
import { ApiError, asApiError } from '../_shared/errors.ts';
import { ExpoPushClient, type ExpoReceiptResult } from '../_shared/expo-push.ts';
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
import { asRpcClient, invokeRpc } from '../_shared/rpc.ts';
import { asObject, integer, normalizedString, onlyKeys, uuid } from '../_shared/validation.ts';

interface ReceiptClaim {
  attemptId: string;
  organizationId: string;
  jobId: string;
  deviceId: string;
  providerTicketId: string;
  providerAcceptedAt: string;
}

export interface PushReceiptWorkerDependencies {
  runtimeConfig: RuntimeConfig;
  clientEnvironment: ClientEnvironment;
  workerToken: string;
  setCorrelationId?(correlationId: string): void;
  claim(workerId: string, limit: number): Promise<unknown>;
  poll(providerTicketIds: string[]): Promise<ExpoReceiptResult[]>;
  record(
    workerId: string,
    claim: ReceiptClaim,
    result: ExpoReceiptResult | { result: 'expired'; errorCode: string },
  ): Promise<void>;
  now(): Date;
}

function requiredSecret(name: string, minimum: number): string {
  const value = Deno.env.get(name)?.trim() ?? '';
  if (value.length < minimum) throw new Error(`${name} is not configured`);
  return value;
}

function positiveBigint(value: unknown): string {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^[1-9][0-9]{0,18}$/.test(text)) throw new ApiError(503, 'dependency_unavailable');
  return text;
}

function parseClaims(value: unknown, limit: number): ReceiptClaim[] {
  try {
    const envelope = asObject(value);
    onlyKeys(envelope, ['receipts']);
    if (!Array.isArray(envelope.receipts) || envelope.receipts.length > limit) {
      throw new Error('invalid');
    }
    return envelope.receipts.map((entry) => {
      const row = asObject(entry);
      onlyKeys(row, [
        'attempt_id',
        'organization_id',
        'job_id',
        'device_id',
        'provider_ticket_id',
        'provider_accepted_at',
      ]);
      const providerAcceptedAt = normalizedString(row.provider_accepted_at, {
        min: 10,
        max: 40,
      }) as string;
      if (!Number.isFinite(Date.parse(providerAcceptedAt))) throw new Error('invalid');
      return {
        attemptId: positiveBigint(row.attempt_id),
        organizationId: uuid(row.organization_id),
        jobId: positiveBigint(row.job_id),
        deviceId: uuid(row.device_id),
        providerTicketId: normalizedString(row.provider_ticket_id, {
          min: 1,
          max: 500,
        }) as string,
        providerAcceptedAt,
      };
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) throw error;
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
}

export function defaultPushReceiptWorkerDependencies(): PushReceiptWorkerDependencies {
  const runtimeConfig = loadRuntimeConfig();
  const clientEnvironment = loadClientEnvironment();
  const workerToken = requiredSecret('NEWONE_WORKER_TOKEN', 32);
  const expo = new ExpoPushClient(requiredSecret('NEWONE_EXPO_ACCESS_TOKEN', 20));
  let admin = createAdminClient(clientEnvironment);
  return {
    runtimeConfig,
    clientEnvironment,
    workerToken,
    setCorrelationId(correlationId) {
      admin = createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId });
    },
    claim(workerId, limit) {
      return invokeRpc(asRpcClient(admin), 'bff_claim_push_receipts', {
        p_worker_id: workerId,
        p_limit: limit,
        p_lease_seconds: 60,
      });
    },
    poll(providerTicketIds) {
      return expo.receipts(providerTicketIds);
    },
    async record(workerId, claim, result) {
      const recorded = asObject(
        await invokeRpc(asRpcClient(admin), 'bff_record_push_receipt', {
          p_worker_id: workerId,
          p_attempt_id: claim.attemptId,
          p_result: result.result,
          p_error_code: result.errorCode,
        }),
      );
      if (positiveBigint(recorded.attempt_id) !== claim.attemptId) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 30);
      }
      normalizedString(recorded.status, { min: 1, max: 40 });
    },
    now: () => new Date(),
  };
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

export function createPushReceiptWorkerHandler(
  dependencyFactory: () => PushReceiptWorkerDependencies = defaultPushReceiptWorkerDependencies,
): (request: Request) => Promise<Response> {
  let dependencies: PushReceiptWorkerDependencies | undefined;
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
      const limit = body.limit === undefined ? 100 : integer(body.limit, 1, 100);
      const workerId = crypto.randomUUID();
      const claims = parseClaims(await dependencies.claim(workerId, limit), limit);
      const now = dependencies.now().getTime();
      const expired = claims.filter((claim) =>
        now - Date.parse(claim.providerAcceptedAt) >= 24 * 60 * 60 * 1000
      );
      const active = claims.filter((claim) => !expired.includes(claim));
      const results = active.length > 0
        ? await dependencies.poll(active.map((claim) => claim.providerTicketId))
        : [];
      if (results.length !== active.length) {
        throw new ApiError(503, 'provider_unavailable', undefined, 60);
      }
      const resultByTicket = new Map(results.map((result) => [result.providerTicketId, result]));
      let delivered = 0;
      let pending = 0;
      let failed = 0;
      for (const claim of active) {
        const result = resultByTicket.get(claim.providerTicketId);
        if (!result) throw new ApiError(503, 'provider_unavailable', undefined, 60);
        await dependencies.record(workerId, claim, result);
        if (result.result === 'delivered') delivered += 1;
        else if (result.result === 'pending') pending += 1;
        else failed += 1;
      }
      for (const claim of expired) {
        await dependencies.record(workerId, claim, {
          result: 'expired',
          errorCode: 'receipt_expired',
        });
        failed += 1;
      }
      return jsonResponse(meta, 200, {
        claimed: claims.length,
        delivered,
        pending,
        failed,
      });
    } catch (error) {
      const safe = asApiError(error);
      if (safe.status >= 500) {
        console.error(JSON.stringify({
          event: 'newone_push_receipt_worker_failure',
          correlation_id: meta.requestId,
          code: safe.code,
        }));
      }
      return errorResponse(meta, error);
    }
  };
}
