import {
  authenticate,
  type AuthenticatedActor,
  type ClientEnvironment,
  createAdminClient,
  loadClientEnvironment,
} from '../_shared/clients.ts';
import { safeEqual } from '../_shared/crypto.ts';
import { ApiError, asApiError, fromDatabaseError, DEFAULT_MESSAGES } from '../_shared/errors.ts';
import {
  accessCredential,
  buildRequestMeta,
  ensureSecureTransport,
  errorResponse,
  jsonResponse,
  loadRuntimeConfig,
  parseJson,
  preflight,
  requestId,
  type RequestMeta,
  type RuntimeConfig,
  verifyCsrf,
} from '../_shared/http.ts';
import {
  type AuthorizationPolicy,
  authorizeRequest,
  enforceRateLimit,
  requireIdempotencyKey,
} from '../_shared/security.ts';
import { asRpcClient, invokeRpc } from '../_shared/rpc.ts';
import {
  apiPath,
  type CommandResult,
  configuredPublicAppUrl,
  executeCommand,
  type MatchedRoute,
  matchRoute,
  parseCommand,
  type ParsedCommand,
  type RouteKind,
} from './routes.ts';

const RATE_LIMIT_OPERATION_ALIASES = {
  'conversation.direct': 'conversation.direct.create',
  'conversation.group': 'conversation.group.create',
  'attachment.grant': 'attachment.upload.create',
} satisfies Partial<Record<RouteKind, string>>;

export function rateLimitOperation(kind: RouteKind): string {
  return RATE_LIMIT_OPERATION_ALIASES[kind as keyof typeof RATE_LIMIT_OPERATION_ALIASES] ?? kind;
}

export interface ApiDependencies {
  runtimeConfig: RuntimeConfig;
  clientEnvironment: ClientEnvironment;
  publicAppUrl?: string;
  readinessToken?: string | null;
  checkReadiness?(requestId: string): Promise<void>;
  authenticateActor(environment: ClientEnvironment, token: string): Promise<AuthenticatedActor>;
  authorize(
    actor: AuthenticatedActor,
    organizationId: string,
    policy: AuthorizationPolicy,
  ): Promise<unknown>;
  rateLimit(
    request: Request,
    config: RuntimeConfig,
    actor: AuthenticatedActor,
    organizationId: string,
    operation: string,
  ): Promise<void>;
  execute(
    route: MatchedRoute,
    command: ParsedCommand,
    actor: AuthenticatedActor,
    idempotencyKey: string,
    requestDigest: string,
    publicAppUrl?: string,
    cursorSigningKey?: string,
  ): Promise<CommandResult>;
}

export function defaultDependencies(): ApiDependencies {
  const runtimeConfig = loadRuntimeConfig();
  const clientEnvironment = loadClientEnvironment();
  const rawReadinessToken = Deno.env.get('NEWONE_WORKER_TOKEN')?.trim() ?? '';
  const readinessToken = rawReadinessToken.length >= 32 ? rawReadinessToken : null;
  return {
    runtimeConfig,
    clientEnvironment,
    publicAppUrl: configuredPublicAppUrl(),
    readinessToken,
    async checkReadiness(correlationId) {
      const { error } = await createAdminClient(clientEnvironment, {
        'X-Request-Id': correlationId,
      }).from('organizations').select('id').limit(1);
      if (error) throw fromDatabaseError(error);
    },
    authenticateActor: authenticate,
    authorize: authorizeRequest,
    rateLimit: enforceRateLimit,
    execute: executeCommand,
  };
}

function authenticateReadiness(request: Request, dependencies: ApiDependencies): void {
  if (dependencies.readinessToken === null || dependencies.readinessToken === undefined) {
    throw new ApiError(404, 'not_found');
  }
  if (
    request.headers.has('origin') || request.headers.has('cookie') ||
    request.headers.has('authorization')
  ) throw new ApiError(403, 'forbidden');
  const apiKey = request.headers.get('apikey') ?? '';
  const readinessToken = request.headers.get('x-newone-readiness-token') ?? '';
  if (
    !safeEqual(apiKey, dependencies.clientEnvironment.secretKey) ||
    !safeEqual(readinessToken, dependencies.readinessToken)
  ) throw new ApiError(401, 'unauthorized');
}

function fallbackMeta(request: Request): RequestMeta {
  return { requestId: requestId(request), origin: null, corsHeaders: new Headers() };
}

function whereThrown(error: unknown): string {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  const frames = stack.split('\n').slice(1).map((line) => line.trim()).filter((line) => line.startsWith('at '));
  return frames.slice(0, 3).map((line) => line.replace(/^at /, '').replace(/file:\/\/\/[^\s]*\/functions\//, '')).join(' < ').slice(0, 300);
}

function logSafeFailure(meta: RequestMeta, route: MatchedRoute | null, error: unknown): void {
  const safe = asApiError(error);
  // Client-caused rejections carry no payload but are logged too: a 400 on
  // device registration went unseen for a day because only 5xx was recorded.
  console.error(JSON.stringify({
    event: safe.status < 500 ? 'newone_api_rejected' : 'newone_api_failure',
    correlation_id: meta.requestId,
    route: route?.template ?? 'unmatched',
    code: safe.code,
    status: safe.status,
    ...(safe.status < 500 && safe.message && safe.message !== DEFAULT_MESSAGES[safe.code] ? { detail: safe.message.slice(0, 200) } : {}),
    // The throw site, so a generic 400 can be traced without guessing.
    ...(safe.status === 400 ? { where: whereThrown(error) } : {}),
  }));
}

function healthResponse(request: Request): Response {
  const correlationId = requestId(request);
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Correlation-Id': correlationId,
  });
  const body = JSON.stringify({ service: 'newone-api', version: 'v2', status: 'ok' });
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

function ensureHealthTransport(request: Request): void {
  ensureSecureTransport(request, {
    allowHttpLocal: Deno.env.get('NEWONE_ALLOW_HTTP_LOCAL') === 'true',
  });
}

export function createApiHandler(
  dependencyFactory: () => ApiDependencies = defaultDependencies,
): (request: Request) => Promise<Response> {
  let dependencies: ApiDependencies | undefined;
  return async (request: Request): Promise<Response> => {
    let meta = fallbackMeta(request);
    let route: MatchedRoute | null = null;
    try {
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        apiPath(request.url) === '/v2/health'
      ) {
        ensureHealthTransport(request);
        return healthResponse(request);
      }
      dependencies ??= dependencyFactory();
      const config = dependencies.runtimeConfig;
      ensureSecureTransport(request, config);
      meta = buildRequestMeta(request, config);
      if (apiPath(request.url) === '/v2/ready') {
        if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed');
        authenticateReadiness(request, dependencies);
        if (!dependencies.checkReadiness) {
          throw new ApiError(503, 'dependency_unavailable', undefined, 5);
        }
        await dependencies.checkReadiness(meta.requestId);
        return jsonResponse(meta, 200, {
          service: 'newone-api',
          version: 'v2',
          status: 'ready',
          checks: { database: 'ok' },
        });
      }
      if (request.method === 'OPTIONS') return preflight(meta);

      route = matchRoute(request.method, apiPath(request.url));
      if (!route) throw new ApiError(404, 'not_found');

      const parsed = await parseJson(request, config);
      const command = parseCommand(route, parsed.value);
      const credential = accessCredential(request, config);
      verifyCsrf(request, config, credential.viaCookie);
      const authenticatedActor = await dependencies.authenticateActor(
        dependencies.clientEnvironment,
        credential.token,
      );
      const actor: AuthenticatedActor = {
        ...authenticatedActor,
        adminClient: createAdminClient(dependencies.clientEnvironment, {
          'X-Request-Id': meta.requestId,
        }),
      };

      const auditPreRateLimited = route.kind === 'audit.export';
      if (auditPreRateLimited) {
        // Establish an active organization/session before consuming a tenant
        // bucket, then rate-limit before the privileged recent-AAL2 check so
        // repeated denied export probes cannot grow the audit ledger without
        // bound. The database reauthorizes every step as well.
        await dependencies.authorize(actor, command.organizationId, {
          operation: route.kind,
        });
        await dependencies.rateLimit(
          request,
          config,
          actor,
          command.organizationId,
          rateLimitOperation(route.kind),
        );
      }

      try {
        await dependencies.authorize(actor, command.organizationId, {
          operation: route.kind,
          requireAal2: route.requireAal2,
          recentAuthSeconds: route.recentAuthSeconds,
        });
      } catch (error) {
        throw error;
      }
      if (!auditPreRateLimited) {
        await dependencies.rateLimit(
          request,
          config,
          actor,
          command.organizationId,
          rateLimitOperation(route.kind),
        );
      }

      const idempotencyKey = route.idempotencyRequired === false
        ? ''
        : requireIdempotencyKey(request);
      const result = await dependencies.execute(
        route,
        command,
        actor,
        idempotencyKey,
        parsed.digest,
        dependencies.publicAppUrl,
        dependencies.runtimeConfig.cursorSigningKey,
      );
      return jsonResponse(meta, result.status, result.body);
    } catch (error) {
      logSafeFailure(meta, route, error);
      return errorResponse(meta, error);
    }
  };
}
