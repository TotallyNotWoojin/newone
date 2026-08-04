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
import { requireIdempotencyKey } from '../_shared/security.ts';
import { asObject, normalizedString, oneOf, onlyKeys, uuid } from '../_shared/validation.ts';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface OwnerIdentity {
  userId: string;
  email: string;
  confirmed: boolean;
  deleted: boolean;
}

interface BootstrapInput {
  ownerUserId: string;
  ownerEmail: string;
  organizationName: string;
  organizationSlug: string;
  idempotencyKey: string;
  requestDigest: string;
}

export interface BootstrapDependencies {
  runtimeConfig: RuntimeConfig;
  clientEnvironment: ClientEnvironment;
  bootstrapToken: string | null;
  setCorrelationId?(correlationId: string): void;
  inspectOwner(userId: string): Promise<OwnerIdentity>;
  bootstrap(input: BootstrapInput): Promise<unknown>;
}

function configuredBootstrapToken(): string | null {
  const raw = Deno.env.get('NEWONE_BOOTSTRAP_TOKEN');
  if (raw === undefined || raw.trim() === '') return null;
  const token = raw.trim();
  if (token.length < 32 || token.length > 4096 || /\s/.test(token)) {
    throw new Error('NEWONE_BOOTSTRAP_TOKEN must be a 32-4096 character non-whitespace secret');
  }
  return token;
}

export function defaultBootstrapDependencies(): BootstrapDependencies {
  const runtimeConfig = loadRuntimeConfig();
  const clientEnvironment = loadClientEnvironment();
  const bootstrapToken = configuredBootstrapToken();
  let admin = createAdminClient(clientEnvironment);
  return {
    runtimeConfig,
    clientEnvironment,
    bootstrapToken,
    setCorrelationId(correlationId) {
      admin = createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId });
    },
    async inspectOwner(userId) {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error || !data.user || data.user.id !== userId || !data.user.email) {
        throw new ApiError(403, 'forbidden');
      }
      return {
        userId: uuid(data.user.id),
        email: parseEmail(data.user.email),
        confirmed: typeof data.user.email_confirmed_at === 'string',
        deleted: typeof data.user.deleted_at === 'string',
      };
    },
    async bootstrap(input) {
      return await invokeRpc(asRpcClient(admin), 'bff_bootstrap_organization', {
        p_owner_user_id: input.ownerUserId,
        p_name: input.organizationName,
        p_slug: input.organizationSlug,
        p_idempotency_key: input.idempotencyKey,
        p_request_sha256: input.requestDigest,
      });
    },
  };
}

function parseEmail(value: unknown): string {
  const email = (normalizedString(value, { min: 3, max: 254 }) as string).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, 'bad_request');
  return email;
}

function fallbackMeta(request: Request): RequestMeta {
  return { requestId: requestId(request), origin: null, corsHeaders: new Headers() };
}

function authenticateBootstrap(
  request: Request,
  expectedToken: string | null,
  expectedServerKey: string,
): void {
  if (expectedToken === null) throw new ApiError(404, 'not_found');
  if (request.headers.has('origin') || request.headers.has('cookie')) {
    throw new ApiError(403, 'forbidden');
  }
  const provided = request.headers.get('x-newone-bootstrap-token') ?? '';
  const apiKey = request.headers.get('apikey') ?? '';
  if (
    request.headers.has('authorization') || !safeEqual(apiKey, expectedServerKey) ||
    !safeEqual(provided, expectedToken)
  ) throw new ApiError(401, 'unauthorized');
}

function publicBootstrapResult(value: unknown, expectedOwnerId: string): unknown {
  try {
    const row = asObject(value);
    const ownerUserId = uuid(row.owner_user_id);
    if (ownerUserId !== expectedOwnerId || row.bootstrapped !== true) throw new Error('invalid');
    return {
      organizationId: uuid(row.organization_id),
      ownerUserId,
      membershipRole: oneOf(row.membership_role, ['owner'] as const),
      membershipStatus: oneOf(row.membership_status, ['active'] as const),
      rootUnitId: uuid(row.root_unit_id),
      bootstrapped: true,
    };
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

export function createBootstrapHandler(
  dependencyFactory: () => BootstrapDependencies = defaultBootstrapDependencies,
): (request: Request) => Promise<Response> {
  let dependencies: BootstrapDependencies | undefined;
  return async (request: Request): Promise<Response> => {
    let meta = fallbackMeta(request);
    try {
      dependencies ??= dependencyFactory();
      ensureSecureTransport(request, dependencies.runtimeConfig);
      meta = buildRequestMeta(request, dependencies.runtimeConfig);
      dependencies.setCorrelationId?.(meta.requestId);
      authenticateBootstrap(
        request,
        dependencies.bootstrapToken,
        dependencies.clientEnvironment.secretKey,
      );
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
      const parsed = await parseJson(request, dependencies.runtimeConfig);
      const body = asObject(parsed.value);
      onlyKeys(body, ['ownerUserId', 'ownerEmail', 'organizationName', 'organizationSlug']);
      const ownerUserId = uuid(body.ownerUserId);
      const ownerEmail = parseEmail(body.ownerEmail);
      const organizationName = normalizedString(body.organizationName, {
        min: 1,
        max: 160,
      }) as string;
      const organizationSlug = normalizedString(body.organizationSlug, {
        min: 3,
        max: 63,
      }) as string;
      if (!SLUG_PATTERN.test(organizationSlug)) throw new ApiError(400, 'bad_request');
      const identity = await dependencies.inspectOwner(ownerUserId);
      if (
        identity.userId !== ownerUserId || identity.email !== ownerEmail ||
        !identity.confirmed || identity.deleted
      ) throw new ApiError(403, 'forbidden');
      const idempotencyKey = requireIdempotencyKey(request);
      const result = await dependencies.bootstrap({
        ownerUserId,
        ownerEmail,
        organizationName,
        organizationSlug,
        idempotencyKey,
        requestDigest: parsed.digest,
      });
      return jsonResponse(meta, 201, publicBootstrapResult(result, ownerUserId));
    } catch (error) {
      const safe = asApiError(error);
      if (safe.status >= 500) {
        console.error(JSON.stringify({
          event: 'newone_bootstrap_failure',
          correlation_id: meta.requestId,
          code: safe.code,
        }));
      }
      return errorResponse(meta, error);
    }
  };
}
