import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Platform } from 'react-native';

import {
  challengeWebMfa,
  enrollWebMfa,
  getWebCsrfToken,
  getWebSession,
  listWebMfaFactors,
  redeemNativeInvitation,
  requestNativeOtp,
  requestNativeRecoveryOtp,
  requestNativeSignup,
  requestWebSignup,
  signOutWebSession,
  validateNativeMembership,
  verifyNativeOtp,
  verifyNativeRecoveryOtp,
  verifyNativeSignup,
  verifyWebMfa,
  verifyWebSignup,
  WebAuthError,
} from '@/lib/web-auth';

jest.mock('@/config/runtime', () => ({
  apiUrlFor: (mockPath: string) => `https://coverage-test.supabase.co/functions/v1/newone-auth${mockPath}`,
  isApiConfigured: true,
  nativeEdgeRequestHeaders: (mockAccessToken?: string) => ({
    apikey: 'sb_publishable_controlled_test_key',
    ...(mockAccessToken ? { Authorization: `Bearer ${mockAccessToken}` } : {}),
  }),
  publicRuntimeConfig: {
    apiUrl: '/api',
    supabase: {
      publishableKey: 'sb_publishable_controlled_test_key',
      url: 'https://coverage-test.supabase.co',
    },
  },
}));

jest.mock('@/lib/installation-id', () => ({
  getInstallationId: async () => '20000000-0000-4000-8000-000000000002',
}));

const originalFetch = globalThis.fetch;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const controlledFetch = jest.fn();

function jsonResponse(payload: unknown, status = 200) {
  controlledFetch.mockImplementationOnce(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

beforeEach(() => {
  controlledFetch.mockReset();
  globalThis.fetch = controlledFetch as unknown as typeof fetch;
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('native identity gateway client', () => {
  test('sends the device-bound OTP request and validates the accepted channel', async () => {
    jsonResponse({
      data: { accepted: true, channel: { type: 'email', configured: true } },
    });

    await expect(requestNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      invitationToken: null,
      employeeCode: null,
      captchaToken: 'controlled-captcha-input',
    })).resolves.toEqual({
      accepted: true,
      channel: { type: 'email', configured: true },
    });

    const [url, init] = controlledFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v2/auth/native/otp/request');
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Newone-Client-Platform': 'ios',
      'X-Newone-Installation-Id': '20000000-0000-4000-8000-000000000002',
      apikey: 'sb_publishable_controlled_test_key',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      destinationType: 'email',
      destination: 'employee@example.test',
      invitationToken: null,
      employeeCode: null,
      captchaToken: 'controlled-captcha-input',
      installationId: '20000000-0000-4000-8000-000000000002',
    });
  });

  test('rejects an invalid OTP receipt instead of inferring success', async () => {
    jsonResponse({ data: { accepted: true, channel: { type: 'carrier-pigeon' } } });
    await expect(requestNativeRecoveryOtp({
      destinationType: 'phone',
      destination: '+15555550100',
      captchaToken: 'controlled-captcha-input',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('accepts only a complete native session envelope', async () => {
    jsonResponse({
      data: {
        authenticated: true,
        user: { id: 'user-a', email: 'employee@example.test' },
        organization: { id: 'org-a', role: 'member' },
        aal: 'aal2',
        memberships: [{ organizationId: 'org-a' }],
        session: {
          accessToken: 'controlled-access-token',
          refreshToken: 'controlled-refresh-token',
          expiresIn: 3600,
        },
      },
    });
    await expect(verifyNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '123456',
    })).resolves.toMatchObject({
      user: { id: 'user-a' },
      aal: 'aal2',
      session: { expiresIn: 3600 },
    });

    jsonResponse({
      data: {
        authenticated: true,
        user: { id: 'user-a' },
        memberships: [],
        session: { accessToken: 'missing-refresh', expiresIn: 3600 },
      },
    });
    await expect(verifyNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '123456',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('validates the complete recovery security receipt', async () => {
    jsonResponse({
      data: {
        authenticated: true,
        recovered: true,
        user: { id: 'user-a' },
        memberships: [{ organizationId: 'org-a' }],
        recovery: {
          currentSessionPreserved: true,
          otherSessionsRevoked: 3,
          securityEventRecorded: true,
          securityNoticeState: 'queued',
        },
        session: {
          accessToken: 'controlled-access-token',
          refreshToken: 'controlled-refresh-token',
          expiresIn: 3600,
        },
      },
    });
    await expect(verifyNativeRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '654321',
    })).resolves.toMatchObject({
      recovery: {
        currentSessionPreserved: true,
        otherSessionsRevoked: 3,
        securityEventRecorded: true,
        securityNoticeState: 'queued',
      },
    });

    jsonResponse({
      data: {
        authenticated: true,
        recovered: true,
        user: { id: 'user-a' },
        memberships: [],
        recovery: {
          currentSessionPreserved: false,
          otherSessionsRevoked: 3,
          securityEventRecorded: true,
          securityNoticeState: 'queued',
        },
      },
    });
    await expect(verifyNativeRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '654321',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('requires the exact user and at least one active membership', async () => {
    jsonResponse({
      data: {
        currentUserId: 'user-a',
        selectedOrganizationId: 'org-a',
        activeMemberships: [{ organizationId: 'org-a' }],
      },
    });
    await expect(validateNativeMembership({
      accessToken: 'controlled-access-token',
      userId: 'user-a',
    })).resolves.toEqual({ organizationId: 'org-a' });

    jsonResponse({ error: { code: 'session_revoked' } }, 403);
    await expect(validateNativeMembership({
      accessToken: 'revoked-token',
      userId: 'user-a',
    })).rejects.toMatchObject({ code: 'membership_required' });

    jsonResponse({ data: { currentUserId: 'other-user', activeMemberships: [] } });
    await expect(validateNativeMembership({
      accessToken: 'controlled-access-token',
      userId: 'user-a',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('activates invitations only from an explicit server receipt', async () => {
    jsonResponse({ data: { activated: true, organizationId: 'org-a' } });
    await expect(redeemNativeInvitation({
      accessToken: 'controlled-access-token',
      invitationToken: 'controlled-invitation-input',
    })).resolves.toMatchObject({ activated: true, organizationId: 'org-a' });

    jsonResponse({ data: { activated: false } }, 409);
    await expect(redeemNativeInvitation({
      accessToken: 'controlled-access-token',
      invitationToken: 'expired-invitation-input',
    })).rejects.toMatchObject({ code: 'invitation_rejected' });
  });

  test('sends the exact native consumer signup request and accepts only a code_sent receipt', async () => {
    jsonResponse({ data: { status: 'code_sent' } });
    await expect(requestNativeSignup({
      destination: 'new.person@example.test',
      username: 'river_runner_7',
      displayName: 'River Runner',
      language: 'es',
      captchaToken: 'controlled-captcha-input',
    })).resolves.toEqual({ status: 'code_sent' });

    const [url, init] = controlledFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v2/auth/native/signup/request');
    expect(JSON.parse(String(init.body))).toEqual({
      destination: 'new.person@example.test',
      username: 'river_runner_7',
      displayName: 'River Runner',
      language: 'es',
      captchaToken: 'controlled-captcha-input',
      installationId: '20000000-0000-4000-8000-000000000002',
    });

    jsonResponse({ data: { status: 'queued' } });
    await expect(requestNativeSignup({
      destination: 'new.person@example.test',
      username: 'river_runner_7',
      displayName: 'River Runner',
      language: 'es',
      captchaToken: 'controlled-captcha-input',
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('verifies native signup sessions with and without a new-account receipt', async () => {
    jsonResponse({ data: {
      authenticated: true,
      user: { id: 'user-new', email: 'new.person@example.test' },
      memberships: [{ organizationId: 'org-personal' }],
      signup: { username: 'river_runner_7', organizationId: 'org-personal' },
      session: {
        accessToken: 'controlled-access-token',
        refreshToken: 'controlled-refresh-token',
        expiresIn: 3600,
      },
    } });
    await expect(verifyNativeSignup({
      destination: 'new.person@example.test',
      code: '123456',
    })).resolves.toMatchObject({
      user: { id: 'user-new' },
      signup: { username: 'river_runner_7', organizationId: 'org-personal' },
      session: { expiresIn: 3600 },
    });
    const [url, init] = controlledFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v2/auth/native/signup/verify');
    expect(JSON.parse(String(init.body))).toEqual({
      destination: 'new.person@example.test',
      code: '123456',
      installationId: '20000000-0000-4000-8000-000000000002',
    });

    jsonResponse({ data: {
      authenticated: true,
      user: { id: 'user-existing' },
      memberships: [{ organizationId: 'org-personal' }],
      session: {
        accessToken: 'controlled-access-token',
        refreshToken: 'controlled-refresh-token',
        expiresIn: 3600,
      },
    } });
    const silentSignIn = await verifyNativeSignup({
      destination: 'existing.person@example.test',
      code: '123456',
    });
    expect(silentSignIn.user.id).toBe('user-existing');
    expect(silentSignIn).not.toHaveProperty('signup');

    jsonResponse({ data: {
      authenticated: true,
      user: { id: 'user-new' },
      memberships: [{ organizationId: 'org-personal' }],
      session: { accessToken: 'missing-refresh', expiresIn: 3600 },
    } });
    await expect(verifyNativeSignup({
      destination: 'new.person@example.test',
      code: '123456',
    })).rejects.toMatchObject({ code: 'invalid_response' });

    jsonResponse({ error: { code: 'signup_expired' } }, 410);
    await expect(verifyNativeSignup({
      destination: 'new.person@example.test',
      code: '123456',
    })).rejects.toMatchObject({ code: 'signup_expired' });
  });

  test('classifies network failures without echoing transport details', async () => {
    controlledFetch.mockImplementationOnce(async () => {
      throw new Error('sensitive network implementation detail');
    });
    await expect(requestNativeOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'controlled-captcha-input',
    })).rejects.toEqual(expect.objectContaining({
      name: 'WebAuthError',
      code: 'network_unavailable',
    }));
  });
});

describe('same-origin web identity client', () => {
  test('requires the host-only CSRF cookie for authenticated web calls', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      expect(getWebCsrfToken()).toBeNull();
      await expect(getWebSession()).rejects.toBeInstanceOf(WebAuthError);
      await expect(getWebSession()).rejects.toMatchObject({ code: 'csrf_required' });
      expect(controlledFetch).not.toHaveBeenCalled();
    } finally {
      platform.restore();
    }
  });

  test('parses a valid web session and sends the exact CSRF header', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://app.example.test' } },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { cookie: 'other=value; __Host-newone_csrf=csrf%20value' },
    });
    jsonResponse({
      data: {
        authenticated: true,
        user: { id: 'user-web', email: 'web@example.test' },
        organization: { id: 'org-web', role: 'manager' },
        csrfToken: 'rotated-csrf',
        sessionId: 'session-web',
        aal: 'aal2',
      },
    });
    try {
      await expect(getWebSession()).resolves.toEqual({
        authenticated: true,
        user: { id: 'user-web', email: 'web@example.test' },
        organization: { id: 'org-web', role: 'manager' },
        csrfToken: 'rotated-csrf',
        sessionId: 'session-web',
        aal: 'aal2',
      });
      expect(controlledFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v2/auth/session'),
        expect.objectContaining({
          credentials: 'include',
          headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf value' }),
        }),
      );
    } finally {
      platform.restore();
    }
  });

  test('validates MFA factors, enrollment, challenge, verification, and sign-out receipts', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://app.example.test' } },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { cookie: '__Host-newone_csrf=csrf-value' },
    });
    jsonResponse({ data: { factors: [
      { id: 'factor-a', friendlyName: 'Work phone', status: 'verified' },
      { id: '', status: 'verified' },
      { id: 'factor-b', status: 'unverified' },
    ] } });
    jsonResponse({ data: { factor: { id: 'factor-c', totp: { qrCode: 'qr', secret: 'secret' } } } });
    jsonResponse({ data: { challenge: { id: 'challenge-a' } } });
    jsonResponse({ data: { verified: true, aal: 'aal2' } });
    jsonResponse({ data: { signedOut: true } });
    try {
      await expect(listWebMfaFactors()).resolves.toEqual([
        { id: 'factor-a', friendlyName: 'Work phone', status: 'verified' },
        { id: 'factor-b', friendlyName: undefined, status: 'unverified' },
      ]);
      await expect(enrollWebMfa('Authenticator')).resolves.toEqual({
        factorId: 'factor-c',
        qrCode: 'qr',
        secret: 'secret',
      });
      await expect(challengeWebMfa('factor-c')).resolves.toEqual({ challengeId: 'challenge-a' });
      await expect(verifyWebMfa({
        factorId: 'factor-c',
        challengeId: 'challenge-a',
        code: '123456',
      })).resolves.toBeUndefined();
      await expect(signOutWebSession()).resolves.toBeUndefined();
      expect(controlledFetch).toHaveBeenCalledTimes(5);
    } finally {
      platform.restore();
    }
  });

  test('sends the web signup request and verifies sessions with an optional signup receipt', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://app.example.test' } },
    });
    jsonResponse({ data: { status: 'code_sent' } });
    jsonResponse({ data: {
      authenticated: true,
      user: { id: 'user-new', email: 'new.person@example.test' },
      sessionId: 'session-new',
      aal: 'aal1',
      signup: { username: 'river_runner_7', organizationId: 'org-personal' },
    } });
    jsonResponse({ data: {
      authenticated: true,
      user: { id: 'user-existing' },
    } });
    jsonResponse({ error: { code: 'username_taken' } }, 409);
    jsonResponse({ error: { code: 'signup_expired' } }, 410);
    try {
      await expect(requestWebSignup({
        destination: 'new.person@example.test',
        username: 'river_runner_7',
        displayName: 'River Runner',
        language: 'ko',
        captchaToken: 'controlled-captcha-input',
      })).resolves.toEqual({ status: 'code_sent' });
      const [requestUrl, requestInit] = controlledFetch.mock.calls[0] as [string, RequestInit];
      expect(requestUrl).toContain('/v2/auth/signup/request');
      expect(requestInit.credentials).toBe('include');
      const requestBody = JSON.parse(String(requestInit.body));
      expect(requestBody).toMatchObject({
        destination: 'new.person@example.test',
        username: 'river_runner_7',
        displayName: 'River Runner',
        language: 'ko',
        captchaToken: 'controlled-captcha-input',
        installationId: '20000000-0000-4000-8000-000000000002',
      });
      expect(requestBody).toHaveProperty('locale');
      expect(requestBody).toHaveProperty('appVersion');

      await expect(verifyWebSignup({
        destination: 'new.person@example.test',
        code: '123456',
      })).resolves.toMatchObject({
        user: { id: 'user-new' },
        sessionId: 'session-new',
        aal: 'aal1',
        signup: { username: 'river_runner_7', organizationId: 'org-personal' },
      });
      const [verifyUrl, verifyInit] = controlledFetch.mock.calls[1] as [string, RequestInit];
      expect(verifyUrl).toContain('/v2/auth/signup/verify');
      expect(JSON.parse(String(verifyInit.body))).toMatchObject({
        destination: 'new.person@example.test',
        code: '123456',
        installationId: '20000000-0000-4000-8000-000000000002',
      });

      const silentSignIn = await verifyWebSignup({
        destination: 'existing.person@example.test',
        code: '123456',
      });
      expect(silentSignIn.user.id).toBe('user-existing');
      expect(silentSignIn).not.toHaveProperty('signup');

      await expect(requestWebSignup({
        destination: 'new.person@example.test',
        username: 'river_runner_7',
        displayName: 'River Runner',
        language: 'en',
        captchaToken: 'controlled-captcha-input',
      })).rejects.toMatchObject({ code: 'username_taken' });
      await expect(verifyWebSignup({
        destination: 'new.person@example.test',
        code: '123456',
      })).rejects.toMatchObject({ code: 'signup_expired' });
    } finally {
      platform.restore();
    }
  });
});
