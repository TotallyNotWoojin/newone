const AUTH_PATHS = new Set([
  '/v2/auth/otp/request',
  '/v2/auth/otp/verify',
  '/v2/auth/native/otp/request',
  '/v2/auth/native/otp/verify',
  '/v2/auth/signup/request',
  '/v2/auth/signup/verify',
  '/v2/auth/native/signup/request',
  '/v2/auth/native/signup/verify',
  '/v2/auth/account/delete',
  '/v2/auth/recovery/otp/request',
  '/v2/auth/recovery/otp/verify',
  '/v2/auth/native/recovery/otp/request',
  '/v2/auth/native/recovery/otp/verify',
  '/v2/auth/recovery/cases',
  '/v2/auth/recovery/cases/query',
  '/v2/auth/session',
  '/v2/auth/session/refresh',
  '/v2/auth/sign-out',
  '/v2/auth/realtime-token',
  '/v2/auth/invitations/redeem',
  // Password sign-in and set-password (v3). Missing from this table they
  // routed to the API function and answered 404 — found by the device suite.
  '/v2/auth/password/verify',
  '/v2/auth/native/password/verify',
  '/v2/auth/password/set',
  // Account lookup (v3.2): the first step of every returning sign-in.
  '/v2/auth/account/lookup',
  '/v2/auth/native/account/lookup',
  '/v2/auth/mfa/factors',
  '/v2/auth/mfa/enroll',
  '/v2/auth/mfa/challenge',
  '/v2/auth/mfa/verify',
  '/v2/auth/mfa/unenroll',
]);

const READ_PATHS = new Set([
  '/v2/bootstrap',
  '/v2/preferences/organization/query',
  '/v2/search',
  '/v2/users/search',
  '/v2/admin/audit/query',
]);

function safeApiPath(path) {
  return typeof path === 'string'
    && path.startsWith('/v2/')
    && path.length <= 2048
    && !path.includes('\\')
    && !path.includes('//')
    && !/[\r\n]/.test(path)
    && !/%(?:00|0d|0a|2e|2f|5c)/i.test(path)
    && !path.split('/').some((segment) => segment === '.' || segment === '..');
}

export function supabaseProjectOrigin(value) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash
      || parsed.pathname !== '/'
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.supabase\.co$/.test(parsed.hostname)
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Accept only short-lived Storage grants issued by the configured Supabase
 * project. A compromised or malformed BFF response must never turn a native
 * `fetch`/`Linking.openURL` call into an arbitrary-origin request.
 */
export function resolveStorageSignedUrl({ signedUrl, supabaseUrl, action }) {
  if (
    typeof signedUrl !== 'string'
    || signedUrl.length < 1
    || signedUrl.length > 8192
    || /[\s\\\r\n]/.test(signedUrl)
    || /%(?:00|0a|0d|2e|2f|5c|25(?:00|0a|0d|2e|2f|5c))/i.test(signedUrl)
    || !['upload', 'download'].includes(action)
  ) return null;

  const projectOrigin = supabaseProjectOrigin(supabaseUrl);
  if (!projectOrigin) return null;

  try {
    const parsed = new URL(signedUrl);
    const prefix = action === 'upload'
      ? '/storage/v1/object/upload/sign/'
      : '/storage/v1/object/sign/';
    if (
      parsed.origin !== projectOrigin
      || parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.hash
      || !parsed.pathname.startsWith(prefix)
      || parsed.pathname.length > 4096
    ) return null;

    const segments = parsed.pathname.slice(prefix.length).split('/');
    if (segments.length < 2 || segments.some((segment) => !segment)) return null;
    for (const segment of segments) {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return null;
      }
      if (
        decoded === '.'
        || decoded === '..'
        || decoded.includes('/')
        || decoded.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(decoded)
      ) return null;
    }

    const allowedQuery = action === 'upload' ? new Set(['token']) : new Set(['token', 'download']);
    if ([...parsed.searchParams.keys()].some((key) => !allowedQuery.has(key))) return null;
    const tokens = parsed.searchParams.getAll('token');
    if (
      tokens.length !== 1
      || tokens[0].length < 16
      || tokens[0].length > 4096
      || /[\s\u0000-\u001f\u007f]/.test(tokens[0])
    ) return null;
    const downloads = parsed.searchParams.getAll('download');
    if (
      downloads.length > 1
      || downloads.some((value) => value.length > 255 || /[\r\n\u0000]/.test(value))
    ) return null;

    return parsed.toString();
  } catch {
    return null;
  }
}

function projectFunctionsBase(value, projectOrigin) {
  try {
    const parsed = new URL(value);
    if (
      !projectOrigin
      || parsed.origin !== projectOrigin
      || parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash
      || parsed.pathname.replace(/\/+$/, '') !== '/functions/v1'
    ) return null;
    return `${projectOrigin}/functions/v1`;
  } catch {
    return null;
  }
}

export function edgeFunctionForPath(path) {
  if (!safeApiPath(path)) return null;
  if (
    AUTH_PATHS.has(path)
    || /^\/v2\/auth\/recovery\/cases\/[0-9a-f-]{36}\/(?:verify|approve|reject|execute)$/i
      .test(path)
  ) return 'newone-auth';
  if (
    READ_PATHS.has(path)
    || /^\/v2\/conversations\/[0-9a-f-]{36}\/messages\/query$/i.test(path)
  ) return 'newone-read';
  return 'newone-api';
}

/**
 * Web is deliberately same-origin and native is deliberately direct-to-Edge.
 * No arbitrary absolute API hosts are accepted for either trust boundary.
 * A browser build that opted into `webDirect` (bearer tokens, no cookie
 * gateway) is routed exactly like native: straight to the project's Edge
 * Functions.
 */
export function resolveApiUrl({ path, platform, apiBase, supabaseUrl, webDirect = false }) {
  const functionName = edgeFunctionForPath(path);
  if (!functionName || typeof apiBase !== 'string') return null;

  if (platform === 'web' && webDirect !== true) {
    return apiBase.replace(/\/+$/, '') === '/api' ? `/api${path}` : null;
  }

  const projectOrigin = supabaseProjectOrigin(supabaseUrl);
  if (!projectOrigin) return null;
  let functionsBase = null;
  if (apiBase.startsWith('/')) {
    if (apiBase.replace(/\/+$/, '') !== '/api') return null;
    functionsBase = `${projectOrigin}/functions/v1`;
  } else {
    functionsBase = projectFunctionsBase(apiBase, projectOrigin);
  }
  return functionsBase ? `${functionsBase}/${functionName}${path}` : null;
}

export function directEdgeRequestHeaders({ platform, publishableKey, accessToken, webDirect = false }) {
  if (platform === 'web' && webDirect !== true) return {};
  const key = typeof publishableKey === 'string' ? publishableKey.trim() : '';
  if (
    key.length < 20
    || key.length > 2048
    || !/^[A-Za-z0-9._-]+$/.test(key)
    || /^sb_secret_/i.test(key)
  ) return null;
  return {
    apikey: key,
    ...(typeof accessToken === 'string' && accessToken.length > 0
      ? { Authorization: `Bearer ${accessToken}` }
      : {}),
  };
}
