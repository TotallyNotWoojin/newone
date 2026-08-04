import type { AuthenticatedActor } from './clients.ts';
import { hmacSha256Hex, safeEqual } from './crypto.ts';
import { ApiError } from './errors.ts';
import type { RuntimeConfig } from './http.ts';
import { asRpcClient, firstRow, invokeRpc, invokeVoidRpc } from './rpc.ts';

export interface AuthorizationPolicy {
  operation: string;
  requireAal2?: boolean;
  recentAuthSeconds?: number;
}

export interface AuthorizationResult {
  role: string;
  membershipStatus: 'active';
}

interface AuthorizationRpcResult {
  allowed?: boolean;
  role?: string;
  membership_status?: string;
}

interface RateLimitRpcResult {
  allowed?: boolean;
  retry_after_seconds?: number;
}

export type IdempotencyStart =
  | { state: 'started' }
  | { state: 'replay'; status: number; body: unknown }
  | { state: 'conflict' }
  | { state: 'in_progress'; retryAfterSeconds: number };

interface IdempotencyRpcResult {
  state?: string;
  response_status?: number;
  response_body?: unknown;
  retry_after_seconds?: number;
}

export function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key')?.trim();
  if (!value || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new ApiError(400, 'bad_request');
  }
  return value;
}

function forwardedIp(request: Request): string {
  // Deployment contract: the hosting gateway must append or overwrite the
  // network peer in X-Forwarded-For. The left side can contain caller-controlled
  // or upstream-proxy values, so only the final non-empty hop is considered.
  // This behavior must be canary-verified on every production ingress; the
  // resulting hash is a supplemental abuse signal, never authentication.
  // Never fall back to CF-Connecting-IP, X-Real-IP, or X-Vercel-Forwarded-For:
  // direct callers can manufacture those before reaching this gateway.
  const hops = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return (hops.at(-1) ?? 'gateway-peer-unavailable').slice(0, 128);
}

const GATEWAY_ATTESTATION_MAX_SKEW_SECONDS = 120;
const NETWORK_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const NETWORK_PEER_PATTERN = /^[0-9A-Fa-f:.]{3,64}$/;

async function attestedGatewayPeer(request: Request, config: RuntimeConfig): Promise<string> {
  const secret = config.webGatewaySharedSecret ?? '';
  if (secret.length < 32) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  const timestampText = request.headers.get('x-newone-gateway-timestamp') ?? '';
  const peer = request.headers.get('x-newone-gateway-network-peer') ?? '';
  const signature = request.headers.get('x-newone-gateway-network-signature') ?? '';
  if (
    !/^\d{10}$/.test(timestampText) ||
    !(peer === 'gateway-peer-unavailable' || NETWORK_PEER_PATTERN.test(peer)) ||
    !NETWORK_SIGNATURE_PATTERN.test(signature)
  ) {
    throw new ApiError(403, 'forbidden');
  }
  const timestamp = Number(timestampText);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp) > GATEWAY_ATTESTATION_MAX_SKEW_SECONDS
  ) {
    throw new ApiError(403, 'forbidden');
  }
  const expected = await hmacSha256Hex(
    secret,
    `newone-gateway-ip-v1\n${timestampText}\n${peer}`,
  );
  if (!safeEqual(signature, expected)) throw new ApiError(403, 'forbidden');
  return peer;
}

export async function networkFingerprint(
  request: Request,
  config: RuntimeConfig,
): Promise<string> {
  if (config.networkHashKey.length < 32) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  const peer = request.headers.get('x-newone-gateway') === 'web'
    ? await attestedGatewayPeer(request, config)
    : forwardedIp(request);
  return await hmacSha256Hex(config.networkHashKey, peer);
}

export async function authorizeRequest(
  actor: AuthenticatedActor,
  organizationId: string,
  policy: AuthorizationPolicy,
): Promise<AuthorizationResult> {
  const result = firstRow(
    await invokeRpc<AuthorizationRpcResult | AuthorizationRpcResult[]>(
      asRpcClient(actor.adminClient),
      'bff_authorize_request',
      {
        p_actor_user_id: actor.user.id,
        p_organization_id: organizationId,
        p_session_id: actor.claims.sessionId,
        p_operation: policy.operation,
        p_require_aal2: policy.requireAal2 ?? false,
        p_recent_auth_seconds: policy.recentAuthSeconds ?? null,
      },
    ),
  );
  if (!result.allowed || result.membership_status !== 'active' || typeof result.role !== 'string') {
    throw new ApiError(403, 'forbidden');
  }
  return { role: result.role, membershipStatus: 'active' };
}

export async function enforceRateLimit(
  request: Request,
  config: RuntimeConfig,
  actor: AuthenticatedActor,
  organizationId: string,
  operation: string,
): Promise<void> {
  const ipHash = await networkFingerprint(request, config);
  const result = firstRow(
    await invokeRpc<RateLimitRpcResult | RateLimitRpcResult[]>(
      asRpcClient(actor.adminClient),
      'bff_consume_rate_limit',
      {
        p_actor_user_id: actor.user.id,
        p_organization_id: organizationId,
        p_session_id: actor.claims.sessionId,
        p_operation: operation,
        p_ip_hash: ipHash,
      },
    ),
  );
  if (!result.allowed) {
    const retryAfter = Number.isSafeInteger(result.retry_after_seconds)
      ? Math.max(1, Math.min(86400, result.retry_after_seconds as number))
      : 60;
    throw new ApiError(429, 'rate_limited', undefined, retryAfter);
  }
}

export async function beginIdempotency(
  actor: AuthenticatedActor,
  organizationId: string,
  route: string,
  key: string,
  digest: string,
): Promise<IdempotencyStart> {
  const result = firstRow(
    await invokeRpc<IdempotencyRpcResult | IdempotencyRpcResult[]>(
      asRpcClient(actor.adminClient),
      'bff_begin_idempotency',
      {
        p_actor_user_id: actor.user.id,
        p_organization_id: organizationId,
        p_route: route,
        p_idempotency_key: key,
        p_request_sha256: digest,
      },
    ),
  );
  if (result.state === 'started') return { state: 'started' };
  if (
    result.state === 'replay' && Number.isSafeInteger(result.response_status) &&
    (result.response_status as number) >= 200 && (result.response_status as number) <= 599
  ) {
    return {
      state: 'replay',
      status: result.response_status as number,
      body: result.response_body,
    };
  }
  if (result.state === 'conflict') return { state: 'conflict' };
  if (result.state === 'in_progress') {
    return {
      state: 'in_progress',
      retryAfterSeconds: Number.isSafeInteger(result.retry_after_seconds)
        ? Math.max(1, Math.min(60, result.retry_after_seconds as number))
        : 2,
    };
  }
  throw new ApiError(503, 'dependency_unavailable', undefined, 5);
}

export async function completeIdempotency(
  actor: AuthenticatedActor,
  organizationId: string,
  route: string,
  key: string,
  digest: string,
  status: number,
  body: unknown,
): Promise<void> {
  await invokeVoidRpc(
    asRpcClient(actor.adminClient),
    'bff_complete_idempotency',
    {
      p_actor_user_id: actor.user.id,
      p_organization_id: organizationId,
      p_route: route,
      p_idempotency_key: key,
      p_request_sha256: digest,
      p_status: status,
      p_response: body,
    },
  );
}
