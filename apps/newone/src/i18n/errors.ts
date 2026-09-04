import type { MessageKey } from '@/i18n/catalog';

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code.toLocaleLowerCase() : '';
}

/** Maps stable transport/domain codes to local copy; upstream English is never rendered. */
export function errorMessageKey(error: unknown): MessageKey {
  const code = errorCode(error);
  if (code === 'username_taken') return 'auth.usernameTaken';
  if (code === 'username_reserved') return 'auth.usernameReserved';
  if (code === 'invalid_username') return 'auth.usernameInvalid';
  if (code === 'invalid_display_name') return 'auth.displayNameInvalid';
  if (code === 'invalid_language') return 'auth.languageInvalid';
  if (code === 'signup_expired') return 'auth.signupExpired';
  if (code === 'push_needs_device') return 'errors.pushNeedsDevice';
  if (code === 'push_unconfigured') return 'errors.pushUnconfigured';
  if (code === 'notification_permission_denied' || code === 'notification_permission_required') {
    return 'errors.notificationDenied';
  }
  if (code === 'push_token_unavailable') return 'errors.pushTokenUnavailable';
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
  if (code.includes('message_request') && (code.includes('cap') || code.includes('limit'))) {
    return 'errors.messageRequestCap';
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

/**
 * Stable code plus a short correlation id for failures that only have the
 * generic fallback copy, so a member can quote an otherwise indistinguishable
 * failure to support. Specific copy stays clean and returns an empty string.
 */
export function errorIdentifier(error: unknown): string {
  if (errorMessageKey(error) !== 'errors.action') return '';
  const code = errorCode(error);
  if (!code) return '';
  const correlationId = error && typeof error === 'object' && 'correlationId' in error
    && typeof error.correlationId === 'string'
    ? error.correlationId.slice(0, 8)
    : '';
  return correlationId ? `${code} · ${correlationId}` : code;
}
