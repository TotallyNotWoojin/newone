import type { MessageKey } from '@/i18n/catalog';

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code.toLocaleLowerCase() : '';
}

/** Maps stable transport/domain codes to local copy; upstream English is never rendered. */
export function errorMessageKey(error: unknown): MessageKey {
  const code = errorCode(error);
  if (
    code === 'network_unavailable'
    || code.includes('unreachable')
    || code.includes('timeout')
    || code.startsWith('upload_http_5')
  ) return 'errors.network';
  if (
    code === 'authentication_required'
    || code === 'csrf_required'
    || code === 'session_revoked'
    || code === 'http_401'
  ) return 'errors.session';
  if (code.includes('membership') || code === 'profile_required') return 'errors.membership';
  if (
    code.includes('aal2')
    || code.includes('recent_auth')
    || code === 'mfa_required'
  ) return 'errors.stepUp';
  if (code === 'forbidden' || code === 'http_403' || code === 'permission_denied') {
    return 'errors.permission';
  }
  if (code === 'http_429' || code.includes('rate_limit')) return 'errors.rateLimit';
  if (code === 'invalid_response') return 'errors.invalidResponse';
  if (
    code.includes('unconfigured')
    || code === 'dependency_unavailable'
    || code === 'http_502'
    || code === 'http_503'
  ) return 'errors.unavailable';
  if (code.includes('invitation')) return 'errors.invitation';
  if (code === 'conflict' || code === 'http_409') return 'errors.conflict';
  if (
    code === 'bad_request'
    || code === 'invalid_query'
    || code.startsWith('file_')
    || code.startsWith('image_')
    || code === 'http_400'
    || code === 'http_422'
  ) return 'errors.invalidRequest';
  return 'errors.action';
}
