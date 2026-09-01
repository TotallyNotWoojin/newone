import { describe, expect, test } from '@jest/globals';

import { RepositoryError, isOfflineError } from '@/data/repositories/contracts';
import { errorMessageKey } from '@/i18n/errors';

describe('safe client error classification', () => {
  test.each<[string, ReturnType<typeof errorMessageKey>]>([
    ['network_unavailable', 'errors.network'],
    ['upstream_timeout', 'errors.network'],
    ['upload_http_503', 'errors.network'],
    ['authentication_required', 'errors.session'],
    ['csrf_required', 'errors.session'],
    ['session_revoked', 'errors.session'],
    ['http_401', 'errors.session'],
    ['membership_required', 'errors.membership'],
    ['profile_required', 'errors.membership'],
    ['aal2_required', 'errors.stepUp'],
    ['recent_auth_required', 'errors.stepUp'],
    ['mfa_required', 'errors.stepUp'],
    ['forbidden', 'errors.permission'],
    ['http_403', 'errors.permission'],
    ['permission_denied', 'errors.permission'],
    ['http_429', 'errors.rateLimit'],
    ['rate_limit_exceeded', 'errors.rateLimit'],
    ['invalid_response', 'errors.invalidResponse'],
    ['gateway_unconfigured', 'errors.unavailable'],
    ['dependency_unavailable', 'errors.unavailable'],
    ['http_502', 'errors.unavailable'],
    ['http_503', 'errors.unavailable'],
    ['invitation_rejected', 'errors.invitation'],
    ['username_taken', 'auth.usernameTaken'],
    ['username_reserved', 'auth.usernameReserved'],
    ['invalid_username', 'auth.usernameInvalid'],
    ['invalid_display_name', 'auth.displayNameInvalid'],
    ['invalid_language', 'auth.languageInvalid'],
    ['signup_expired', 'auth.signupExpired'],
    ['conflict', 'errors.conflict'],
    ['http_409', 'errors.conflict'],
    ['bad_request', 'errors.invalidRequest'],
    ['invalid_query', 'errors.invalidRequest'],
    ['file_too_large', 'errors.invalidRequest'],
    ['image_optimization_failed', 'errors.invalidRequest'],
    ['http_400', 'errors.invalidRequest'],
    ['http_422', 'errors.invalidRequest'],
    ['unknown_code', 'errors.action'],
  ])('%s maps to %s without displaying transport copy', (code, key) => {
    expect(errorMessageKey({ code, message: 'upstream text must not render' })).toBe(key);
  });

  test('malformed and absent codes use the generic localized action', () => {
    expect(errorMessageKey(null)).toBe('errors.action');
    expect(errorMessageKey({ code: 401 })).toBe('errors.action');
    expect(errorMessageKey(new Error('secret upstream failure'))).toBe('errors.action');
  });

  test('offline detection requires the exact repository network code', () => {
    expect(isOfflineError(new RepositoryError('offline', 'network_unavailable', true))).toBe(true);
    expect(isOfflineError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isOfflineError(new RepositoryError('retryable dependency', 'http_503', true))).toBe(false);
    expect(isOfflineError(new RepositoryError('denied', 'forbidden', false))).toBe(false);
    expect(isOfflineError('not an error')).toBe(false);
  });
});
