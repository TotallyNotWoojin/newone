import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

const MAX_GATEWAY_BODY_BYTES = 128 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;
const FUNCTION_ORIGIN_ENV = 'NEWONE_SUPABASE_FUNCTIONS_ORIGIN';
const PUBLISHABLE_KEY_ENV = 'SUPABASE_PUBLISHABLE_KEY';
const WEB_GATEWAY_SECRET_ENV = 'NEWONE_WEB_GATEWAY_SHARED_SECRET';
const UNAVAILABLE_NETWORK_PEER = 'gateway-peer-unavailable';
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']);
const SESSION_COOKIE_NAMES = new Set([
  '__Host-newone_access',
  '__Host-newone_refresh',
  '__Host-newone_csrf',
]);

const AUTH_GATEWAY_PATHS = new Set([
  '/v2/auth/otp/request',
  '/v2/auth/otp/verify',
  '/v2/auth/recovery/otp/request',
  '/v2/auth/recovery/otp/verify',
  '/v2/auth/recovery/cases',
  '/v2/auth/recovery/cases/query',
  '/v2/auth/session',
  '/v2/auth/session/refresh',
  '/v2/auth/sign-out',
  '/v2/auth/realtime-token',
  '/v2/auth/invitations/redeem',
  '/v2/auth/mfa/factors',
  '/v2/auth/mfa/enroll',
  '/v2/auth/mfa/challenge',
  '/v2/auth/mfa/verify',
  '/v2/auth/mfa/unenroll',
]);

const READ_GATEWAY_PATHS = new Set([
  '/v2/bootstrap',
  '/v2/preferences/organization/query',
  '/v2/search',
]);

const REQUEST_HEADERS_TO_REMOVE = [
  // Web authentication terminates at the HttpOnly Newone cookie contract.
  // Native bearer clients call the Edge Functions directly; forwarding a
  // browser-supplied bearer/API key would create an ambiguous second auth path.
  'authorization',
  'apikey',
  'cf-connecting-ip',
  'connection',
  'content-encoding',
  'content-length',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
  'x-forwarded-host',
  'x-forwarded-for',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'x-vercel-protection-bypass',
];

const RESPONSE_HEADERS_TO_REMOVE = [
  // The browser gateway is intentionally same-origin only. Never allow an
  // upstream function's CORS policy to turn authenticated BFF responses into
  // a cross-origin data channel (including between sibling subdomains, where
  // SameSite cookies may still be attached).
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'access-control-max-age',
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function cookiePairs(rawCookie) {
  if (!rawCookie || rawCookie.length > 12 * 1024 || /[\r\n\0]/.test(rawCookie)) return [];
  const selected = new Map();
  for (const part of rawCookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (
      !SESSION_COOKIE_NAMES.has(name) || selected.has(name) || value.length > 4096 ||
      /[\x00-\x20\x7f;,]/.test(value)
    ) continue;
    selected.set(name, `${name}=${value}`);
  }
  return [...selected.values()];
}

export function sessionCookieHeader(rawCookie) {
  const selected = cookiePairs(rawCookie);
  return selected.length > 0 ? selected.join('; ') : null;
}

function cookieAttributes(setCookie) {
  if (!setCookie || setCookie.length > 4096 || /[\r\n\0]/.test(setCookie)) return null;
  const parts = setCookie.split(';').map((value) => value.trim()).filter(Boolean);
  const pair = parts.shift();
  if (!pair) return null;
  const separator = pair.indexOf('=');
  if (separator <= 0) return null;
  const name = pair.slice(0, separator);
  const value = pair.slice(separator + 1);
  if (
    !SESSION_COOKIE_NAMES.has(name) || value.length > 3072 ||
    /[\x00-\x20\x7f;,]/.test(value)
  ) return null;

  const attributes = new Map();
  for (const rawAttribute of parts) {
    const attributeSeparator = rawAttribute.indexOf('=');
    const key = (attributeSeparator < 0
      ? rawAttribute
      : rawAttribute.slice(0, attributeSeparator)).trim().toLowerCase();
    const attributeValue = attributeSeparator < 0
      ? ''
      : rawAttribute.slice(attributeSeparator + 1).trim();
    if (!key || attributes.has(key)) return null;
    attributes.set(key, attributeValue);
  }

  if (
    !attributes.has('secure') || attributes.get('path') !== '/' ||
    attributes.get('samesite')?.toLowerCase() !== 'strict' ||
    attributes.has('domain')
  ) return null;
  const isCsrf = name === '__Host-newone_csrf';
  if (isCsrf === attributes.has('httponly')) return null;

  const allowedAttributes = new Set([
    'secure', 'httponly', 'path', 'samesite', 'max-age', 'expires', 'priority',
  ]);
  if ([...attributes.keys()].some((key) => !allowedAttributes.has(key))) return null;
  if (attributes.has('max-age') && !/^-?\d{1,10}$/.test(attributes.get('max-age'))) return null;

  return setCookie;
}

export function sessionSetCookies(headers) {
  const rawCookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [];
  const selected = new Map();
  for (const rawCookie of rawCookies) {
    const safe = cookieAttributes(rawCookie);
    if (!safe) throw new TypeError('unsafe_upstream_cookie');
    const name = safe.slice(0, safe.indexOf('='));
    if (selected.has(name)) throw new TypeError('duplicate_upstream_cookie');
    selected.set(name, safe);
  }
  return [...selected.values()];
}

function problem(status, code, message) {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/problem+json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

export function selectUpstreamFunction(pathname, method) {
  if (pathname === '/v2/health') return 'newone-api';
  if (!pathname.startsWith('/v2/')) return null;
  if (
    AUTH_GATEWAY_PATHS.has(pathname) ||
    /^\/v2\/auth\/recovery\/cases\/[0-9a-f-]{36}\/(?:verify|approve|reject|execute)$/i
      .test(pathname)
  ) return 'newone-auth';
  if (
    READ_GATEWAY_PATHS.has(pathname) ||
    /^\/v2\/conversations\/[0-9a-f-]{36}\/messages\/query$/i.test(pathname)
  ) return 'newone-read';
  if (method === 'GET' || method === 'HEAD') return 'newone-read';
  return 'newone-api';
}

export function functionsOrigin(rawValue) {
  if (!rawValue) throw new Error(`${FUNCTION_ORIGIN_ENV} is required`);
  const parsed = new URL(rawValue);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname.endsWith('.supabase.co')
  ) {
    throw new Error(`${FUNCTION_ORIGIN_ENV} must be a hosted Supabase HTTPS origin without credentials`);
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path !== '/functions/v1') {
    throw new Error(`${FUNCTION_ORIGIN_ENV} must use the exact /functions/v1 path`);
  }
  return `${parsed.origin}${path}`;
}

export function publishableKey(rawValue) {
  const value = rawValue?.trim();
  if (
    !value || value.length < 20 || value.length > 2048 ||
    !/^[A-Za-z0-9._-]+$/.test(value) || /^sb_secret_/i.test(value)
  ) {
    throw new Error(`${PUBLISHABLE_KEY_ENV} must contain a Supabase publishable key`);
  }
  return value;
}

export function webGatewaySharedSecret(rawValue) {
  if (
    typeof rawValue !== 'string' || rawValue.length < 32 || rawValue.length > 4096 ||
    /[\r\n\0]/.test(rawValue)
  ) {
    throw new Error(`${WEB_GATEWAY_SECRET_ENV} must contain an independent secret`);
  }
  return rawValue;
}

function gatewayNetworkPeer(request) {
  const candidate = request.headers.get('x-forwarded-for')?.trim() ?? '';
  // Vercel overwrites X-Forwarded-For at ingress. A missing or malformed value
  // gets a stable fallback bucket instead of trusting any alternative header.
  return candidate.length <= 64 && isIP(candidate) !== 0
    ? candidate
    : UNAVAILABLE_NETWORK_PEER;
}

export function gatewayNetworkAttestation(request, secret, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  const peer = gatewayNetworkPeer(request);
  const message = `newone-gateway-ip-v1\n${timestamp}\n${peer}`;
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  return { timestamp, peer, signature };
}

function publicPath(requestUrl) {
  const url = new URL(requestUrl);
  if (!url.pathname.startsWith('/api/')) return null;
  const path = url.pathname.slice('/api'.length);
  if (
    !path.startsWith('/v2/') || path.length > 2048 || url.search.length > 8192 ||
    path.includes('\\') || path.includes('//') || /[\r\n]/.test(path) ||
    /%(?:00|0d|0a|2e|2f|5c)/i.test(path) ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  ) return null;
  return { path, search: url.search };
}

function isSafeBrowserRequest(request) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return false;
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  if (request.method === 'OPTIONS') {
    return !origin || origin === new URL(request.url).origin;
  }
  return Boolean(origin && origin === new URL(request.url).origin);
}

function copyRequestHeaders(request, upstreamPublishableKey, gatewaySecret, now) {
  const headers = new Headers(request.headers);
  for (const name of REQUEST_HEADERS_TO_REMOVE) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith('x-newone-') || name.startsWith('x-supabase-') ||
      name.startsWith('x-vercel-')
    ) headers.delete(name);
  }
  const cookie = sessionCookieHeader(request.headers.get('cookie'));
  if (cookie) headers.set('Cookie', cookie);
  else headers.delete('Cookie');
  headers.set('Accept-Encoding', 'identity');
  // Supabase's current API-key contract keeps the public project key in
  // `apikey`; a user session belongs only in Authorization/cookies. The BFF
  // replaces this header so a browser cannot choose the upstream project key.
  headers.set('apikey', upstreamPublishableKey);
  headers.set('X-Newone-Gateway', 'web');
  const attestation = gatewayNetworkAttestation(request, gatewaySecret, now);
  headers.set('X-Newone-Gateway-Timestamp', attestation.timestamp);
  headers.set('X-Newone-Gateway-Network-Peer', attestation.peer);
  headers.set('X-Newone-Gateway-Network-Signature', attestation.signature);
  return headers;
}

function copyResponseHeaders(upstream) {
  const cookies = sessionSetCookies(upstream.headers);
  const headers = new Headers(upstream.headers);
  for (const name of RESPONSE_HEADERS_TO_REMOVE) headers.delete(name);
  headers.delete('set-cookie');
  headers.delete('location');
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

async function requestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const contentEncoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    throw new TypeError('unsupported_content_encoding');
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_GATEWAY_BODY_BYTES) {
    throw new RangeError('request_too_large');
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_GATEWAY_BODY_BYTES) throw new RangeError('request_too_large');
  return body.byteLength === 0 ? undefined : body;
}

export async function proxyNewoneRequest(request, options = {}) {
  if (!ALLOWED_METHODS.has(request.method)) {
    return problem(405, 'method_not_allowed', 'The request method is not allowed.');
  }
  const route = publicPath(request.url);
  if (!route) return problem(404, 'not_found', 'The requested service route does not exist.');

  if (!isSafeBrowserRequest(request)) {
    return problem(403, 'origin_not_allowed', 'The request origin is not allowed.');
  }

  const upstreamFunction = selectUpstreamFunction(route.path, request.method);
  if (!upstreamFunction) {
    return problem(404, 'not_found', 'The requested service route does not exist.');
  }

  let origin;
  let upstreamPublishableKey;
  let gatewaySecret;
  try {
    origin = functionsOrigin(
      options.functionsOrigin ?? process.env[FUNCTION_ORIGIN_ENV],
    );
    upstreamPublishableKey = publishableKey(
      options.publishableKey ?? process.env.SUPABASE_PUBLISHABLE_KEY,
    );
    gatewaySecret = webGatewaySharedSecret(
      options.gatewaySharedSecret ?? process.env[WEB_GATEWAY_SECRET_ENV],
    );
  } catch {
    return problem(503, 'gateway_unconfigured', 'The secure service gateway is unavailable.');
  }

  let body;
  try {
    body = await requestBody(request);
  } catch (error) {
    if (error instanceof TypeError && error.message === 'unsupported_content_encoding') {
      return problem(415, 'unsupported_media_type', 'Compressed request bodies are not accepted.');
    }
    if (error instanceof RangeError) {
      return problem(413, 'payload_too_large', 'The request body is too large.');
    }
    return problem(400, 'bad_request', 'The request body could not be read.');
  }

  const target = `${origin}/${upstreamFunction}${route.path}${route.search}`;
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutSignal =
    options.signal ??
    (typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      : undefined);

  try {
    const upstream = await fetchImplementation(target, {
      method: request.method,
      headers: copyRequestHeaders(request, upstreamPublishableKey, gatewaySecret, options.now),
      body,
      redirect: 'manual',
      signal: timeoutSignal,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return problem(502, 'upstream_unavailable', 'The secure service gateway returned an invalid response.');
    }
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyResponseHeaders(upstream),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return problem(
      timedOut ? 504 : 502,
      timedOut ? 'upstream_timeout' : 'upstream_unavailable',
      'The secure service gateway could not complete the request.',
    );
  }
}

export const GET = proxyNewoneRequest;
export const HEAD = proxyNewoneRequest;
export const POST = proxyNewoneRequest;
export const PATCH = proxyNewoneRequest;
export const PUT = proxyNewoneRequest;
export const DELETE = proxyNewoneRequest;
export const OPTIONS = proxyNewoneRequest;
