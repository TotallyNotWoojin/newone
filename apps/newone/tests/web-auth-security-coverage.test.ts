import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Platform } from 'react-native';

import {
  challengeWebMfa,
  enrollWebMfa,
  getWebCsrfToken,
  getWebRealtimeToken,
  getWebSession,
  listWebMfaFactors,
  redeemNativeInvitation,
  refreshWebSession,
  requestNativeOtp,
  requestNativeRecoveryOtp,
  requestNativeSignup,
  requestWebOtp,
  requestWebRecoveryOtp,
  requestWebSignup,
  unenrollWebMfa,
  validateNativeMembership,
  verifyNativeOtp,
  verifyNativeRecoveryOtp,
  verifyWebMfa,
  verifyWebOtp,
  verifyWebRecoveryOtp,
} from '@/lib/web-auth';

const mockRuntimeBoundary: {
  apiConfigured: boolean;
  apiBase: string | null;
  apiUrlMode: 'absolute' | 'relative' | 'unavailable';
  headersAvailable: boolean;
  platform: 'android' | 'ios' | 'web';
} = {
  apiConfigured: true,
  apiBase: '/api',
  apiUrlMode: 'absolute',
  headersAvailable: true,
  platform: 'web',
};

jest.mock('@/config/runtime', () => ({
  apiUrlFor: (path: string) => {
    if (mockRuntimeBoundary.apiUrlMode === 'unavailable') return null;
    if (mockRuntimeBoundary.apiUrlMode === 'relative') return `/api${path}`;
    return `https://app.example.test/api${path}`;
  },
  get isApiConfigured() {
    return mockRuntimeBoundary.apiConfigured;
  },
  nativeEdgeRequestHeaders: (accessToken?: string) => (
    mockRuntimeBoundary.headersAvailable
      ? {
          apikey: 'sb_publishable_controlled_test_key',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        }
      : null
  ),
  publicRuntimeConfig: {
    get apiUrl() {
      return mockRuntimeBoundary.apiBase;
    },
    supabase: null,
  },
}));
jest.mock('@/lib/installation-id', () => ({
  getInstallationId: async () => '30000000-0000-4000-8000-000000000003',
}));

const originalFetch = globalThis.fetch;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
const controlledFetch = jest.fn();

function usePlatform(platform: 'android' | 'ios' | 'web') {
  mockRuntimeBoundary.platform = platform;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
}

function queueJson(payload: unknown, status = 200) {
  controlledFetch.mockImplementationOnce(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function queueInvalidJson(status = 200) {
  controlledFetch.mockImplementationOnce(async () => new Response('controlled invalid JSON response', {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function setWebEnvironment(csrf = 'csrf-controlled-value') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://app.example.test' } },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: `__Host-newone_csrf=${encodeURIComponent(csrf)}` },
  });
}

function restoreDescriptor(
  key: 'document' | 'window',
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, key);
  }
}

function webSession(overrides: Record<string, unknown> = {}) {
  return {
    authenticated: true,
    user: { id: 'user-web' },
    ...overrides,
  };
}

function recoveryReceipt(overrides: Record<string, unknown> = {}) {
  return {
    ...webSession(),
    recovered: true,
    recovery: {
      currentSessionPreserved: true,
      otherSessionsRevoked: 0,
      securityEventRecorded: true,
      securityNoticeState: 'recorded',
    },
    ...overrides,
  };
}

function nativeSession(overrides: Record<string, unknown> = {}) {
  return {
    ...webSession(),
    memberships: [{ organizationId: 'org-a' }],
    session: {
      accessToken: 'controlled-access-token',
      refreshToken: 'controlled-refresh-token',
      expiresIn: 3600,
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockRuntimeBoundary.apiConfigured = true;
  mockRuntimeBoundary.apiBase = '/api';
  mockRuntimeBoundary.apiUrlMode = 'absolute';
  mockRuntimeBoundary.headersAvailable = true;
  usePlatform('web');
  controlledFetch.mockReset();
  globalThis.fetch = controlledFetch as unknown as typeof fetch;
  setWebEnvironment();
});

afterEach(() => {
  restoreDescriptor('window', originalWindowDescriptor);
  restoreDescriptor('document', originalDocumentDescriptor);
  if (originalPlatformDescriptor) {
    Object.defineProperty(Platform, 'OS', originalPlatformDescriptor);
  }
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('web identity response and security contracts', () => {
  test('requests and verifies OTPs with explicit client binding fields', async () => {
    queueJson({ accepted: true, channel: { type: 'phone', configured: false } });
    queueJson(webSession({
      user: { id: 'user-web', phone: '+15555550100' },
      organization: { id: 'org-a' },
      aal: 'aal1',
    }));
    queueJson(webSession());

    await expect(requestWebOtp({
      destinationType: 'phone',
      destination: '+15555550100',
      invitationToken: 'invitation-controlled-input',
      employeeCode: 'EMP-123',
      captchaToken: 'captcha-controlled-input',
    })).resolves.toEqual({
      accepted: true,
      channel: { type: 'phone', configured: false },
    });
    await expect(verifyWebOtp({
      destinationType: 'phone',
      destination: '+15555550100',
      invitationToken: null,
      employeeCode: '',
      code: '123456',
    })).resolves.toMatchObject({
      user: { id: 'user-web', phone: '+15555550100' },
      aal: 'aal1',
    });
    await expect(verifyWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      invitationToken: 'invitation-controlled-input',
      employeeCode: 'EMP-123',
      code: '123456',
    })).resolves.toMatchObject({ user: { id: 'user-web' } });

    const firstBody = JSON.parse(String((controlledFetch.mock.calls[0]?.[1] as RequestInit).body));
    const secondBody = JSON.parse(String((controlledFetch.mock.calls[1]?.[1] as RequestInit).body));
    expect(firstBody).toMatchObject({
      installationId: '30000000-0000-4000-8000-000000000003',
      invitationToken: 'invitation-controlled-input',
      employeeCode: 'EMP-123',
      appVersion: null,
    });
    expect(secondBody).not.toHaveProperty('invitationToken');
    expect(secondBody).not.toHaveProperty('employeeCode');
  });

  test('omits the captcha token key from web auth requests when no token is available', async () => {
    queueJson({ accepted: true, channel: { type: 'email', configured: true } });
    queueJson({ accepted: true, channel: { type: 'email', configured: true } });
    queueJson({ status: 'code_sent' });

    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
    })).resolves.toMatchObject({ accepted: true });
    await expect(requestWebRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: null,
    })).resolves.toMatchObject({ accepted: true });
    await expect(requestWebSignup({
      destination: 'new.person@example.test',
      username: 'river_runner_7',
      displayName: 'River Runner',
      language: 'en',
    })).resolves.toEqual({ status: 'code_sent' });

    expect(controlledFetch).toHaveBeenCalledTimes(3);
    for (const call of controlledFetch.mock.calls) {
      const body = JSON.parse(String((call[1] as RequestInit).body));
      expect(body).not.toHaveProperty('captchaToken');
      expect(body).toHaveProperty('installationId', '30000000-0000-4000-8000-000000000003');
    }
  });

  test('requests and verifies a complete web recovery receipt', async () => {
    queueJson({ data: { accepted: true, channel: { type: 'email', configured: true } } });
    queueJson({ data: recoveryReceipt({
      user: { id: 'user-web', email: 'employee@example.test' },
      csrfToken: 'rotated-csrf',
      sessionId: 'session-a',
    }) });

    await expect(requestWebRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).resolves.toMatchObject({ accepted: true });
    await expect(verifyWebRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '654321',
    })).resolves.toMatchObject({
      authenticated: true,
      recovery: { otherSessionsRevoked: 0, securityNoticeState: 'recorded' },
    });

    const body = JSON.parse(String((controlledFetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toHaveProperty('appVersion');
  });

  test.each([
    ['unauthenticated session', { authenticated: false }],
    ['missing recovery confirmation', { recovered: false }],
    ['current session not preserved', {
      recovery: {
        currentSessionPreserved: false,
        otherSessionsRevoked: 0,
        securityEventRecorded: true,
        securityNoticeState: 'recorded',
      },
    }],
    ['non-integer revocation count', {
      recovery: {
        currentSessionPreserved: true,
        otherSessionsRevoked: 1.5,
        securityEventRecorded: true,
        securityNoticeState: 'recorded',
      },
    }],
    ['negative revocation count', {
      recovery: {
        currentSessionPreserved: true,
        otherSessionsRevoked: -1,
        securityEventRecorded: true,
        securityNoticeState: 'recorded',
      },
    }],
    ['missing security event', {
      recovery: {
        currentSessionPreserved: true,
        otherSessionsRevoked: 0,
        securityEventRecorded: false,
        securityNoticeState: 'recorded',
      },
    }],
    ['invalid notice state', {
      recovery: {
        currentSessionPreserved: true,
        otherSessionsRevoked: 0,
        securityEventRecorded: true,
        securityNoticeState: 42,
      },
    }],
  ])('rejects a recovery receipt with %s', async (_label, overrides) => {
    queueJson({ data: recoveryReceipt(overrides) });
    await expect(verifyWebRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '654321',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('refreshes a session, returns realtime credentials, and unenrolls MFA', async () => {
    queueJson({ data: webSession({
      user: { id: 'user-web', email: 'employee@example.test', phone: '+15555550100' },
      organization: { id: 'org-a', role: 'admin' },
      csrfToken: 'rotated-csrf',
      sessionId: 'session-a',
      aal: 'aal2',
    }) });
    queueJson({ data: { accessToken: 'realtime-token', expiresAt: '2030-01-01T00:00:00Z' } });
    queueJson({ data: { unenrolled: true } });

    await expect(refreshWebSession()).resolves.toMatchObject({
      organization: { id: 'org-a', role: 'admin' },
      aal: 'aal2',
    });
    await expect(getWebRealtimeToken()).resolves.toEqual({
      accessToken: 'realtime-token',
      expiresAt: '2030-01-01T00:00:00Z',
    });
    await expect(unenrollWebMfa('factor-a')).resolves.toBeUndefined();
  });

  test.each([
    [{ expiresAt: '2030-01-01T00:00:00Z' }],
    [{ accessToken: 'realtime-token' }],
  ])('rejects incomplete realtime credentials', async (receipt) => {
    queueJson({ data: receipt });
    await expect(getWebRealtimeToken()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('normalizes absent and malformed MFA factors without inventing identities', async () => {
    queueJson({ data: {} });
    queueJson({ data: { factors: [
      null,
      { id: 42, status: 'verified' },
      { id: 'factor-a', friendlyName: 42, status: 'pending' },
    ] } });

    await expect(listWebMfaFactors()).resolves.toEqual([]);
    await expect(listWebMfaFactors()).resolves.toEqual([
      { id: 'factor-a', friendlyName: undefined, status: 'unverified' },
    ]);
  });

  test.each([
    [{ factor: null }],
    [{ factor: { id: 'factor-a', totp: {} } }],
    [{ factor: { id: 'factor-a', totp: { qrCode: 'qr' } } }],
  ])('rejects an incomplete authenticator enrollment', async (receipt) => {
    queueJson({ data: receipt });
    await expect(enrollWebMfa()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('rejects invalid challenge and verification receipts', async () => {
    queueJson({ data: { challenge: null } });
    queueJson({ data: { verified: false, aal: 'aal2' } });
    queueJson({ data: { verified: true, aal: 'aal1' } });

    await expect(challengeWebMfa('factor-a')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(verifyWebMfa({
      factorId: 'factor-a',
      challengeId: 'challenge-a',
      code: '123456',
    })).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(verifyWebMfa({
      factorId: 'factor-a',
      challengeId: 'challenge-a',
      code: '123456',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('classifies safe web transport and HTTP errors', async () => {
    controlledFetch.mockImplementationOnce(async () => {
      throw new Error('controlled transport failure');
    });
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'network_unavailable' });

    queueJson({ error: { code: 'session_expired' } }, 401);
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'session_expired', message: 'Your web session has expired.' });

    queueJson({ code: 'rate_limited' }, 429);
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'rate_limited' });

    queueInvalidJson(503);
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'http_503' });

    queueInvalidJson();
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('accepts a direct success payload when the gateway omits a data wrapper', async () => {
    queueJson({ accepted: true, channel: { type: 'email', configured: true } });
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).resolves.toMatchObject({ accepted: true });
  });

  test('preserves security configuration errors instead of misclassifying them as network outages', async () => {
    mockRuntimeBoundary.apiBase = 'https://different-origin.example.test/api';
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'gateway_origin_mismatch' });

    mockRuntimeBoundary.apiBase = '/api';
    mockRuntimeBoundary.apiUrlMode = 'unavailable';
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });

    mockRuntimeBoundary.apiUrlMode = 'absolute';
    mockRuntimeBoundary.apiConfigured = false;
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });

    mockRuntimeBoundary.apiConfigured = true;
    mockRuntimeBoundary.apiBase = null;
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });

    mockRuntimeBoundary.apiBase = '/api';
    usePlatform('ios');
    await expect(requestWebOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });
  });

  test('can resolve the configured web gateway when no browser window exists', async () => {
    Reflect.deleteProperty(globalThis, 'window');
    queueJson({ data: webSession() });
    await expect(getWebSession()).resolves.toMatchObject({ user: { id: 'user-web' } });
  });

  test('returns null when the CSRF cookie is absent from an existing cookie jar', () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { cookie: 'unrelated=value' },
    });
    expect(getWebCsrfToken()).toBeNull();
  });
});

describe('native identity response and security contracts', () => {
  beforeEach(() => {
    usePlatform('ios');
  });

  test('rejects unsupported and incomplete native gateway configurations', async () => {
    usePlatform('web');
    await expect(requestNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });

    usePlatform('ios');
    mockRuntimeBoundary.apiUrlMode = 'unavailable';
    await expect(requestNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });

    mockRuntimeBoundary.apiUrlMode = 'relative';
    await expect(requestNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });

    mockRuntimeBoundary.apiUrlMode = 'absolute';
    mockRuntimeBoundary.headersAvailable = false;
    await expect(requestNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });
    expect(controlledFetch).not.toHaveBeenCalled();
  });

  test('omits the captcha token key from native auth requests when no token is available', async () => {
    queueJson({ accepted: true, channel: { type: 'email', configured: true } });
    queueJson({ accepted: true, channel: { type: 'phone', configured: true } });
    queueJson({ status: 'code_sent' });

    await expect(requestNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
    })).resolves.toMatchObject({ accepted: true });
    await expect(requestNativeRecoveryOtp({
      destinationType: 'phone',
      destination: '+15555550100',
      captchaToken: '',
    })).resolves.toMatchObject({ accepted: true });
    await expect(requestNativeSignup({
      destination: 'new.person@example.test',
      username: 'river_runner_7',
      displayName: 'River Runner',
      language: 'en',
      captchaToken: null,
    })).resolves.toEqual({ status: 'code_sent' });

    expect(controlledFetch).toHaveBeenCalledTimes(3);
    for (const call of controlledFetch.mock.calls) {
      const body = JSON.parse(String((call[1] as RequestInit).body));
      expect(body).not.toHaveProperty('captchaToken');
      expect(body).toHaveProperty('installationId', '30000000-0000-4000-8000-000000000003');
    }
  });

  test('supports Android and classifies malformed and rejected native responses', async () => {
    usePlatform('android');
    queueJson({ accepted: true, channel: { type: 'phone', configured: true } });
    await expect(requestNativeRecoveryOtp({
      destinationType: 'phone',
      destination: '+15555550100',
      captchaToken: 'captcha-controlled-input',
    })).resolves.toMatchObject({ accepted: true });
    expect(controlledFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ 'X-Newone-Client-Platform': 'android' }),
    }));

    queueJson({ error: { code: 'rate_limited' } }, 429);
    await expect(requestNativeRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'rate_limited' });

    queueJson({ code: 'request_rejected' }, 400);
    await expect(requestNativeRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'request_rejected' });

    queueInvalidJson(502);
    await expect(requestNativeRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'http_502' });

    queueInvalidJson();
    await expect(requestNativeRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'captcha-controlled-input',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test.each([
    [{ accessToken: 42, refreshToken: 'refresh', expiresIn: 3600 }],
    [{ accessToken: 'access', refreshToken: 42, expiresIn: 3600 }],
    [{ accessToken: 'access', refreshToken: 'refresh', expiresIn: 1.5 }],
  ])('rejects incomplete native OTP session credentials', async (session) => {
    queueJson({ data: nativeSession({ session }) });
    await expect(verifyNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '123456',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('rejects native OTP sessions without a membership array', async () => {
    queueJson({ data: nativeSession({ memberships: null }) });
    await expect(verifyNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '123456',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test.each([
    [{ accessToken: 42, refreshToken: 'refresh', expiresIn: 3600 }, []],
    [{ accessToken: 'access', refreshToken: 42, expiresIn: 3600 }, []],
    [{ accessToken: 'access', refreshToken: 'refresh', expiresIn: 1.5 }, []],
    [{ accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 }, null],
  ])('rejects incomplete native recovery credentials', async (session, memberships) => {
    queueJson({ data: recoveryReceipt({ session, memberships }) });
    await expect(verifyNativeRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '654321',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('classifies membership configuration and transport failures', async () => {
    mockRuntimeBoundary.apiUrlMode = 'unavailable';
    await expect(validateNativeMembership({ accessToken: 'access', userId: 'user-a' }))
      .rejects.toMatchObject({ code: 'gateway_unconfigured' });

    mockRuntimeBoundary.apiUrlMode = 'absolute';
    mockRuntimeBoundary.headersAvailable = false;
    await expect(validateNativeMembership({ accessToken: 'access', userId: 'user-a' }))
      .rejects.toMatchObject({ code: 'gateway_unconfigured' });

    mockRuntimeBoundary.headersAvailable = true;
    controlledFetch.mockImplementationOnce(async () => {
      throw new Error('controlled membership transport failure');
    });
    await expect(validateNativeMembership({ accessToken: 'access', userId: 'user-a' }))
      .rejects.toMatchObject({ code: 'network_unavailable' });

    queueInvalidJson(500);
    await expect(validateNativeMembership({ accessToken: 'access', userId: 'user-a' }))
      .rejects.toMatchObject({ code: 'http_500' });
  });

  test.each([
    [401, { error: { code: 'anything' } }],
    [403, { error: { code: 'anything' } }],
    [409, { error: { code: 'forbidden' } }],
    [409, { error: { code: 'SESSION_REVOKED' } }],
    [409, { code: 'membership_required' }],
  ])('maps status %s membership denials to membership_required', async (status, payload) => {
    queueJson(payload, status);
    await expect(validateNativeMembership({ accessToken: 'access', userId: 'user-a' }))
      .rejects.toMatchObject({ code: 'membership_required' });
  });

  test.each([
    [{ currentUserId: 'other', selectedOrganizationId: 'org-a', activeMemberships: [{}] }],
    [{ currentUserId: 'user-a', selectedOrganizationId: null, activeMemberships: [{}] }],
    [{ currentUserId: 'user-a', selectedOrganizationId: 'org-a', activeMemberships: null }],
    [{ currentUserId: 'user-a', selectedOrganizationId: 'org-a', activeMemberships: [] }],
  ])('rejects an invalid membership success receipt', async (receipt) => {
    queueJson(receipt);
    await expect(validateNativeMembership({ accessToken: 'access', userId: 'user-a' }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('accepts a direct membership success payload', async () => {
    queueJson({
      currentUserId: 'user-a',
      selectedOrganizationId: 'org-a',
      activeMemberships: [{ organizationId: 'org-a' }],
    });
    await expect(validateNativeMembership({ accessToken: 'access', userId: 'user-a' }))
      .resolves.toEqual({ organizationId: 'org-a' });
  });

  test('rejects incomplete invitation gateway configuration', async () => {
    mockRuntimeBoundary.apiUrlMode = 'unavailable';
    await expect(redeemNativeInvitation({ accessToken: 'access', invitationToken: 'invite' }))
      .rejects.toMatchObject({ code: 'gateway_unconfigured' });

    mockRuntimeBoundary.apiUrlMode = 'relative';
    await expect(redeemNativeInvitation({ accessToken: 'access', invitationToken: 'invite' }))
      .rejects.toMatchObject({ code: 'gateway_unconfigured' });

    mockRuntimeBoundary.apiUrlMode = 'absolute';
    mockRuntimeBoundary.headersAvailable = false;
    await expect(redeemNativeInvitation({ accessToken: 'access', invitationToken: 'invite' }))
      .rejects.toMatchObject({ code: 'gateway_unconfigured' });
  });

  test('rejects malformed invitation receipts and accepts a direct activation receipt', async () => {
    controlledFetch.mockImplementationOnce(async () => {
      throw new Error('controlled invitation transport failure');
    });
    await expect(redeemNativeInvitation({ accessToken: 'access', invitationToken: 'invite' }))
      .rejects.toMatchObject({ code: 'network_unavailable' });

    queueInvalidJson();
    await expect(redeemNativeInvitation({ accessToken: 'access', invitationToken: 'invite' }))
      .rejects.toMatchObject({ code: 'invitation_rejected' });

    queueJson({ activated: true }, 409);
    await expect(redeemNativeInvitation({ accessToken: 'access', invitationToken: 'invite' }))
      .rejects.toMatchObject({ code: 'invitation_rejected' });

    queueJson({ activated: true, organizationId: 'org-a' });
    await expect(redeemNativeInvitation({ accessToken: 'access', invitationToken: 'invite' }))
      .resolves.toMatchObject({ activated: true, organizationId: 'org-a' });
  });
});
