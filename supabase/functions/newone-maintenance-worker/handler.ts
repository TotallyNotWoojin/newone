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
import { asRpcClient, invokeRpc } from '../_shared/rpc.ts';
import { asObject, integer, normalizedString, onlyKeys, uuid } from '../_shared/validation.ts';

interface PromotionResult {
  processed: number;
  promoted: number;
  announcementIds: string[];
}

interface ObligationResult {
  processed: number;
  remindersEnqueued: number;
  escalationsEnqueued: number;
  announcementRecipientKeys: string[];
}

interface HandoffResult {
  processed: number;
  remindersEnqueued: number;
  escalationsEnqueued: number;
  handoffKeys: string[];
}

export interface MaintenanceWorkerDependencies {
  runtimeConfig: RuntimeConfig;
  clientEnvironment: ClientEnvironment;
  workerToken: string;
  setCorrelationId?(correlationId: string): void;
  promote(workerId: string, limit: number): Promise<unknown>;
  processAnnouncementObligations(workerId: string, limit: number): Promise<unknown>;
  processOverdueHandoffs(workerId: string, limit: number): Promise<unknown>;
}

function requiredSecret(name: string, minimum: number): string {
  const value = Deno.env.get(name)?.trim() ?? '';
  if (value.length < minimum) throw new Error(`${name} is not configured`);
  return value;
}

export function defaultMaintenanceWorkerDependencies(): MaintenanceWorkerDependencies {
  const runtimeConfig = loadRuntimeConfig();
  const clientEnvironment = loadClientEnvironment();
  const workerToken = requiredSecret('NEWONE_WORKER_TOKEN', 32);
  let admin = createAdminClient(clientEnvironment);
  return {
    runtimeConfig,
    clientEnvironment,
    workerToken,
    setCorrelationId(correlationId) {
      admin = createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId });
    },
    promote(workerId, limit) {
      return invokeRpc(asRpcClient(admin), 'bff_promote_due_announcements', {
        p_worker_id: workerId,
        p_limit: limit,
      });
    },
    processAnnouncementObligations(workerId, limit) {
      return invokeRpc(asRpcClient(admin), 'bff_process_announcement_obligations', {
        p_worker_id: workerId,
        p_limit: limit,
      });
    },
    processOverdueHandoffs(workerId, limit) {
      return invokeRpc(asRpcClient(admin), 'bff_process_overdue_handoffs', {
        p_worker_id: workerId,
        p_limit: limit,
      });
    },
  };
}

function fallbackMeta(request: Request): RequestMeta {
  return { requestId: requestId(request), origin: null, corsHeaders: new Headers() };
}

function authenticateWorker(
  request: Request,
  expectedWorkerToken: string,
  expectedServerKey: string,
): void {
  if (
    request.headers.has('authorization') || request.headers.has('origin') ||
    request.headers.has('cookie') ||
    !safeEqual(request.headers.get('apikey') ?? '', expectedServerKey) ||
    !safeEqual(request.headers.get('x-newone-worker-token') ?? '', expectedWorkerToken)
  ) throw new ApiError(401, 'unauthorized');
}

function uuidList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  const values = value.map(uuid);
  if (new Set(values).size !== values.length) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return values;
}

function recipientKeys(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  const keys = value.map((entry) => {
    const key = normalizedString(entry, { min: 80, max: 100 }) as string;
    const match = /^([0-9a-f-]{36}):([0-9a-f-]{36}):(escalated|reminder:([1-9][0-9]{0,2}))$/i
      .exec(key);
    if (!match?.[1] || !match[2]) {
      throw new ApiError(503, 'dependency_unavailable', undefined, 30);
    }
    uuid(match[1]);
    uuid(match[2]);
    if (match[4] !== undefined) integer(Number(match[4]), 1, 1000);
    return key;
  });
  if (new Set(keys).size !== keys.length) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return keys;
}

function handoffKeys(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  const keys = value.map((entry) => {
    const key = normalizedString(entry, { min: 46, max: 60 }) as string;
    const match = /^([0-9a-f-]{36}):(escalated|reminder:([1-9][0-9]{0,2}))$/i.exec(key);
    if (!match?.[1]) throw new ApiError(503, 'dependency_unavailable', undefined, 30);
    uuid(match[1]);
    if (match[3] !== undefined) integer(Number(match[3]), 1, 1000);
    return key;
  });
  if (new Set(keys).size !== keys.length) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return keys;
}

export function parsePromotionResult(value: unknown, limit: number): PromotionResult {
  const row = asObject(value);
  onlyKeys(row, ['processed', 'promoted', 'announcement_ids']);
  const processed = integer(row.processed, 0, limit);
  const promoted = integer(row.promoted, 0, processed);
  const announcementIds = uuidList(row.announcement_ids, promoted);
  if (announcementIds.length !== promoted) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return { processed, promoted, announcementIds };
}

export function parseObligationResult(value: unknown, limit: number): ObligationResult {
  const row = asObject(value);
  onlyKeys(row, [
    'processed',
    'reminders_enqueued',
    'escalations_enqueued',
    'sms_fallback_available',
    'announcement_recipient_keys',
  ]);
  if (row.sms_fallback_available !== false) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  const processed = integer(row.processed, 0, limit);
  const remindersEnqueued = integer(row.reminders_enqueued, 0, processed);
  const escalationsEnqueued = integer(row.escalations_enqueued, 0, processed);
  if (remindersEnqueued + escalationsEnqueued > processed) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  const announcementRecipientKeys = recipientKeys(
    row.announcement_recipient_keys,
    processed,
  );
  if (announcementRecipientKeys.length !== remindersEnqueued + escalationsEnqueued) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return {
    processed,
    remindersEnqueued,
    escalationsEnqueued,
    announcementRecipientKeys,
  };
}

export function parseHandoffResult(value: unknown, limit: number): HandoffResult {
  const row = asObject(value);
  onlyKeys(row, [
    'processed',
    'reminders_enqueued',
    'escalations_enqueued',
    'sms_fallback_available',
    'handoff_keys',
  ]);
  if (row.sms_fallback_available !== false) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  const processed = integer(row.processed, 0, limit);
  const remindersEnqueued = integer(row.reminders_enqueued, 0, processed);
  const escalationsEnqueued = integer(row.escalations_enqueued, 0, processed);
  if (remindersEnqueued + escalationsEnqueued > processed) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  const keys = handoffKeys(row.handoff_keys, processed);
  if (keys.length !== remindersEnqueued + escalationsEnqueued) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return { processed, remindersEnqueued, escalationsEnqueued, handoffKeys: keys };
}

export function createMaintenanceWorkerHandler(
  dependencyFactory: () => MaintenanceWorkerDependencies = defaultMaintenanceWorkerDependencies,
): (request: Request) => Promise<Response> {
  let dependencies: MaintenanceWorkerDependencies | undefined;
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
      onlyKeys(body, [
        'announcementPromotionLimit',
        'announcementObligationLimit',
        'handoffLimit',
      ]);
      const promotionLimit = body.announcementPromotionLimit === undefined
        ? 50
        : integer(body.announcementPromotionLimit, 1, 100);
      const obligationLimit = body.announcementObligationLimit === undefined
        ? 100
        : integer(body.announcementObligationLimit, 1, 100);
      const handoffLimit = body.handoffLimit === undefined
        ? 100
        : integer(body.handoffLimit, 1, 100);
      const workerId = crypto.randomUUID();
      const promotions = parsePromotionResult(
        await dependencies.promote(workerId, promotionLimit),
        promotionLimit,
      );
      const announcements = parseObligationResult(
        await dependencies.processAnnouncementObligations(workerId, obligationLimit),
        obligationLimit,
      );
      const handoffs = parseHandoffResult(
        await dependencies.processOverdueHandoffs(workerId, handoffLimit),
        handoffLimit,
      );
      return jsonResponse(meta, 200, {
        promotions,
        announcementObligations: announcements,
        overdueHandoffs: handoffs,
        smsFallbackAvailable: false,
      });
    } catch (error) {
      const safe = asApiError(error);
      if (safe.status >= 500) {
        console.error(JSON.stringify({
          event: 'newone_maintenance_worker_failure',
          correlation_id: meta.requestId,
          code: safe.code,
        }));
      }
      return errorResponse(meta, error);
    }
  };
}
