import { canonicalJson, safeEqual, sha256Hex } from './crypto.ts';
import { ApiError, asApiError } from './errors.ts';

export interface RuntimeConfig {
  allowedOrigins: Set<string>;
  accessCookieName: string;
  refreshCookieName: string;
  csrfCookieName: string;
  maxJsonBytes: number;
  networkHashKey: string;
  cursorSigningKey?: string;
  webGatewaySharedSecret?: string;
  allowHttpLocal: boolean;
}

export interface RequestMeta {
  requestId: string;
  origin: string | null;
  corsHeaders: Headers;
}

export interface ParsedJson {
  value: unknown;
  digest: string;
}

const COOKIE_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const HOST_COOKIE_NAMES = {
  access: '__Host-newone_access',
  refresh: '__Host-newone_refresh',
  csrf: '__Host-newone_csrf',
} as const;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const MIN_JSON_BYTES = 1024;
const MAX_JSON_BYTES = 1024 * 1024;

function booleanEnvironmentValue(value: string | undefined, name: string): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function configuredCookieName(value: string | undefined, fallback: string, name: string): string {
  const candidate = value ?? fallback;
  if (!COOKIE_NAME_PATTERN.test(candidate)) {
    throw new Error(`${name} must be a valid cookie name`);
  }
  return candidate;
}

function canonicalOrigin(value: string, allowHttpLocal: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NEWONE_ALLOWED_WEB_ORIGINS contains an invalid origin');
  }
  if (
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== '' && url.pathname !== '/') ||
    (url.protocol !== 'https:' && !(
      allowHttpLocal && url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname)
    ))
  ) {
    throw new Error('NEWONE_ALLOWED_WEB_ORIGINS must contain canonical HTTPS origins');
  }
  return url.origin;
}

export function loadRuntimeConfig(env: Pick<typeof Deno.env, 'get'> = Deno.env): RuntimeConfig {
  const allowHttpLocal = booleanEnvironmentValue(
    env.get('NEWONE_ALLOW_HTTP_LOCAL'),
    'NEWONE_ALLOW_HTTP_LOCAL',
  );
  const origins = (env.get('NEWONE_ALLOWED_WEB_ORIGINS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => canonicalOrigin(value, allowHttpLocal));
  const accessCookieName = configuredCookieName(
    env.get('NEWONE_ACCESS_COOKIE_NAME'),
    HOST_COOKIE_NAMES.access,
    'NEWONE_ACCESS_COOKIE_NAME',
  );
  const refreshCookieName = configuredCookieName(
    env.get('NEWONE_REFRESH_COOKIE_NAME'),
    HOST_COOKIE_NAMES.refresh,
    'NEWONE_REFRESH_COOKIE_NAME',
  );
  const csrfCookieName = configuredCookieName(
    env.get('NEWONE_CSRF_COOKIE_NAME'),
    HOST_COOKIE_NAMES.csrf,
    'NEWONE_CSRF_COOKIE_NAME',
  );
  if (new Set([accessCookieName, refreshCookieName, csrfCookieName]).size !== 3) {
    throw new Error('cookie names must be distinct');
  }
  if (
    !allowHttpLocal && (
      accessCookieName !== HOST_COOKIE_NAMES.access ||
      refreshCookieName !== HOST_COOKIE_NAMES.refresh ||
      csrfCookieName !== HOST_COOKIE_NAMES.csrf
    )
  ) {
    throw new Error('hosted deployments require the fixed __Host Newone cookie names');
  }
  const maxJsonBytes = Number(env.get('NEWONE_MAX_JSON_BYTES') ?? '65536');
  if (
    !Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < MIN_JSON_BYTES ||
    maxJsonBytes > MAX_JSON_BYTES
  ) {
    throw new Error(
      `NEWONE_MAX_JSON_BYTES must be an integer between ${MIN_JSON_BYTES} and ${MAX_JSON_BYTES}`,
    );
  }
  const networkHashKey = env.get('NEWONE_NETWORK_HASH_KEY') ?? '';
  if (networkHashKey.length < 32 || networkHashKey.length > 4096) {
    throw new Error('NEWONE_NETWORK_HASH_KEY must contain between 32 and 4096 characters');
  }
  const cursorSigningKey = env.get('NEWONE_CURSOR_SIGNING_KEY') ?? '';
  if (
    cursorSigningKey && (
      cursorSigningKey.length < 32 || cursorSigningKey.length > 4096 ||
      /[\r\n\0]/.test(cursorSigningKey)
    )
  ) {
    throw new Error(
      'NEWONE_CURSOR_SIGNING_KEY must contain between 32 and 4096 characters',
    );
  }
  const webGatewaySharedSecret = env.get('NEWONE_WEB_GATEWAY_SHARED_SECRET') ?? '';
  if (
    webGatewaySharedSecret && (
      webGatewaySharedSecret.length < 32 || webGatewaySharedSecret.length > 4096 ||
      /[\r\n\0]/.test(webGatewaySharedSecret)
    )
  ) {
    throw new Error(
      'NEWONE_WEB_GATEWAY_SHARED_SECRET must contain between 32 and 4096 characters',
    );
  }

  return {
    allowedOrigins: new Set(origins),
    accessCookieName,
    refreshCookieName,
    csrfCookieName,
    maxJsonBytes,
    networkHashKey,
    cursorSigningKey: cursorSigningKey || undefined,
    webGatewaySharedSecret,
    allowHttpLocal,
  };
}

export function requestId(request: Request): string {
  const supplied = request.headers.get('x-correlation-id');
  if (
    supplied &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)
  ) {
    return supplied.toLowerCase();
  }
  return crypto.randomUUID();
}

function isTrustedSupabaseHttpsProxyRequest(
  requestUrl: URL,
  request: Request,
  env: Pick<typeof Deno.env, 'get'>,
): boolean {
  if (
    requestUrl.protocol !== 'http:' ||
    request.headers.get('x-forwarded-proto') !== 'https'
  ) return false;

  const rawSupabaseUrl = env.get('SUPABASE_URL')?.trim() ?? '';
  if (!rawSupabaseUrl) return false;
  try {
    const publicUrl = new URL(rawSupabaseUrl);
    return publicUrl.protocol === 'https:' &&
      !publicUrl.username && !publicUrl.password && !publicUrl.search && !publicUrl.hash &&
      (publicUrl.pathname === '' || publicUrl.pathname === '/') &&
      publicUrl.host === requestUrl.host;
  } catch {
    return false;
  }
}

export function ensureSecureTransport(
  request: Request,
  config: Pick<RuntimeConfig, 'allowHttpLocal'>,
  env: Pick<typeof Deno.env, 'get'> = Deno.env,
): void {
  const url = new URL(request.url);
  if (url.protocol === 'https:') return;
  if (
    config.allowHttpLocal && url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  ) return;
  // Hosted Edge Functions terminate TLS at Supabase's gateway. The user
  // runtime receives an internal http URL for the canonical project host and
  // an exact gateway-supplied x-forwarded-proto=https marker. Trust that
  // marker only when it agrees with the injected canonical HTTPS project URL.
  if (isTrustedSupabaseHttpsProxyRequest(url, request, env)) return;
  throw new ApiError(400, 'bad_request');
}

export function buildRequestMeta(request: Request, config: RuntimeConfig): RequestMeta {
  const suppliedOrigin = request.headers.get('origin');
  let origin: string | null = null;
  if (suppliedOrigin) {
    try {
      origin = new URL(suppliedOrigin).origin;
    } catch {
      throw new ApiError(403, 'origin_not_allowed');
    }
    if (origin !== suppliedOrigin || !config.allowedOrigins.has(origin)) {
      throw new ApiError(403, 'origin_not_allowed');
    }
  }

  const headers = new Headers({
    'Access-Control-Allow-Headers':
      'apikey, authorization, content-type, idempotency-key, x-correlation-id, x-csrf-token, ' +
      'x-newone-client-platform, x-newone-installation-id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return { requestId: requestId(request), origin, corsHeaders: headers };
}

export function preflight(meta: RequestMeta): Response {
  const headers = new Headers(meta.corsHeaders);
  headers.set('X-Correlation-Id', meta.requestId);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(null, { status: 204, headers });
}

export function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  const raw = request.headers.get('cookie');
  if (!raw) return cookies;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      throw new ApiError(400, 'bad_request');
    }
  }
  return cookies;
}

export interface AccessCredential {
  token: string;
  viaCookie: boolean;
}

export function accessCredential(request: Request, config: RuntimeConfig): AccessCredential {
  const authorization = request.headers.get('authorization');
  const cookieToken = parseCookies(request).get(config.accessCookieName);
  let bearer: string | undefined;
  if (authorization) {
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
    if (!match?.[1]) throw new ApiError(401, 'unauthorized');
    bearer = match[1];
  }
  if (bearer && cookieToken && !safeEqual(bearer, cookieToken)) {
    throw new ApiError(401, 'unauthorized');
  }
  const token = bearer ?? cookieToken;
  if (!token || token.length > 8192) throw new ApiError(401, 'unauthorized');
  return { token, viaCookie: !bearer && Boolean(cookieToken) };
}

export function verifyCsrf(
  request: Request,
  config: RuntimeConfig,
  cookieAuthenticated: boolean,
): void {
  if (!cookieAuthenticated) return;
  const cookie = parseCookies(request).get(config.csrfCookieName);
  const header = request.headers.get('x-csrf-token');
  if (!cookie || !header || cookie.length > 256 || !safeEqual(cookie, header)) {
    throw new ApiError(403, 'csrf_failed');
  }
}

export async function parseJson(request: Request, config: RuntimeConfig): Promise<ParsedJson> {
  const contentType = request.headers.get('content-type') ?? '';
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    throw new ApiError(415, 'unsupported_media_type');
  }
  const encoding = request.headers.get('content-encoding')?.toLowerCase();
  if (encoding && encoding !== 'identity') {
    throw new ApiError(415, 'unsupported_content_encoding');
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared < 0 || declared > config.maxJsonBytes) {
    throw new ApiError(413, 'payload_too_large');
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new ApiError(400, 'invalid_json');
  if (bytes.byteLength > config.maxJsonBytes) throw new ApiError(413, 'payload_too_large');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
  return { value, digest: await sha256Hex(canonicalJson(value)) };
}

function baseHeaders(meta: RequestMeta): Headers {
  const headers = new Headers(meta.corsHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Correlation-Id', meta.requestId);
  return headers;
}

export function jsonResponse(
  meta: RequestMeta,
  status: number,
  body: unknown,
  extra?: HeadersInit,
): Response {
  const headers = baseHeaders(meta);
  if (extra) new Headers(extra).forEach((value, key) => headers.append(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(meta: RequestMeta, error: unknown): Response {
  const apiError = asApiError(error);
  const headers = new Headers();
  if (apiError.retryAfterSeconds !== undefined) {
    headers.set('Retry-After', String(apiError.retryAfterSeconds));
  }
  return jsonResponse(meta, apiError.status, {
    error: {
      code: apiError.code,
      message: apiError.message,
      correlationId: meta.requestId,
      ...(apiError.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: apiError.retryAfterSeconds }),
    },
  }, headers);
}

export function cookie(
  name: string,
  value: string,
  options: { maxAge: number; httpOnly?: boolean; path?: string },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path ?? '/'}`,
    'Secure',
    options.httpOnly === false ? '' : 'HttpOnly',
    'SameSite=Strict',
  ].filter(Boolean).join('; ');
}
