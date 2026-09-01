import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';
import { Platform, Text } from 'react-native';

import { AuthProvider, useAuth } from '@/state/auth';

const mockGetSession = jest.fn();
const mockOnAuthStateChange = jest.fn();
const mockSetSession = jest.fn();
const mockSignOut = jest.fn();
const mockRefreshSession = jest.fn();
const mockStartAutoRefresh = jest.fn();
const mockStopAutoRefresh = jest.fn();
const mockRemoveAllChannels = jest.fn();
const mockValidateNativeMembership = jest.fn();
const mockRequestNativeOtp = jest.fn();
const mockVerifyNativeOtp = jest.fn();
const mockRequestNativeRecoveryOtp = jest.fn();
const mockVerifyNativeRecoveryOtp = jest.fn();
const mockRequestNativeSignup = jest.fn();
const mockVerifyNativeSignup = jest.fn();
const mockPurgeUser = jest.fn();
const mockTranslate = (key: string) => key;

const mockSupabase = {
  auth: {
    getSession: mockGetSession,
    onAuthStateChange: mockOnAuthStateChange,
    setSession: mockSetSession,
    signOut: mockSignOut,
    refreshSession: mockRefreshSession,
    startAutoRefresh: mockStartAutoRefresh,
    stopAutoRefresh: mockStopAutoRefresh,
  },
};

jest.mock('@/config/runtime', () => ({
  publicRuntimeConfig: { offlineCacheEnabled: false },
  runtimeMode: 'native',
}));

jest.mock('@/data/persistence/client-store', () => ({
  clientStore: {
    getCache: jest.fn(),
    initialize: jest.fn(async () => undefined),
    purgeUser: (mockUserId: string) => mockPurgeUser(mockUserId),
    putCache: jest.fn(async () => undefined),
    removeCache: jest.fn(async () => undefined),
  },
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: mockTranslate }),
}));

jest.mock('@/lib/supabase', () => ({
  getRealtimeClient: () => ({ removeAllChannels: mockRemoveAllChannels }),
  getSupabaseClient: () => mockSupabase,
  isNativeSupabaseConfigured: true,
}));

jest.mock('@/lib/web-auth', () => {
  class ControlledWebAuthError extends Error {
    readonly code: string;

    constructor(mockMessage: string, mockCode: string) {
      super(mockMessage);
      this.code = mockCode;
      this.name = 'WebAuthError';
    }
  }
  return {
    getWebRealtimeToken: jest.fn(),
    getWebSession: jest.fn(),
    refreshWebSession: jest.fn(),
    requestNativeOtp: (mockInput: unknown) => mockRequestNativeOtp(mockInput),
    requestNativeRecoveryOtp: (mockInput: unknown) => mockRequestNativeRecoveryOtp(mockInput),
    requestNativeSignup: (mockInput: unknown) => mockRequestNativeSignup(mockInput),
    requestWebOtp: jest.fn(),
    requestWebRecoveryOtp: jest.fn(),
    requestWebSignup: jest.fn(),
    signOutWebSession: jest.fn(),
    validateNativeMembership: (mockInput: unknown) => mockValidateNativeMembership(mockInput),
    verifyNativeOtp: (mockInput: unknown) => mockVerifyNativeOtp(mockInput),
    verifyNativeRecoveryOtp: (mockInput: unknown) => mockVerifyNativeRecoveryOtp(mockInput),
    verifyNativeSignup: (mockInput: unknown) => mockVerifyNativeSignup(mockInput),
    verifyWebOtp: jest.fn(),
    verifyWebRecoveryOtp: jest.fn(),
    verifyWebSignup: jest.fn(),
    WebAuthError: ControlledWebAuthError,
  };
});

const userId = '10000000-0000-4000-8000-000000000001';

function accessToken(aal: 'aal1' | 'aal2', sessionId = 'session-native') {
  const payload = btoa(JSON.stringify({ aal, session_id: sessionId }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${payload}.signature`;
}

function nativeSession(aal: 'aal1' | 'aal2' = 'aal2') {
  return {
    access_token: accessToken(aal),
    refresh_token: 'controlled-refresh-token',
    user: { id: userId },
  };
}

let observedAuth: ReturnType<typeof useAuth> | null = null;

function AuthProbe() {
  const auth = useAuth();
  useEffect(() => {
    observedAuth = auth;
  }, [auth]);
  return (
    <Text>
      {auth.loading ? 'loading' : auth.authenticated ? 'signed-in' : 'signed-out'}
      {auth.error ? `:${auth.error}` : ''}
    </Text>
  );
}

function currentAuth() {
  if (!observedAuth) throw new Error('AuthProvider has not published state.');
  return observedAuth;
}

beforeEach(() => {
  observedAuth = null;
  mockGetSession.mockImplementation(async () => ({
    data: { session: nativeSession() },
    error: null,
  }));
  mockOnAuthStateChange.mockImplementation(() => ({
    data: { subscription: { unsubscribe: jest.fn() } },
  }));
  mockSetSession.mockImplementation(async () => ({
    data: { session: nativeSession() },
    error: null,
  }));
  mockSignOut.mockImplementation(async () => ({ error: null }));
  mockRefreshSession.mockImplementation(async () => ({
    data: { session: nativeSession('aal2') },
    error: null,
  }));
  mockRemoveAllChannels.mockImplementation(async () => undefined);
  mockValidateNativeMembership.mockImplementation(async () => ({ organizationId: 'org-a' }));
  mockRequestNativeOtp.mockImplementation(async () => ({
    accepted: true,
    channel: { type: 'email', configured: true },
  }));
  mockRequestNativeRecoveryOtp.mockImplementation(async () => ({
    accepted: true,
    channel: { type: 'email', configured: true },
  }));
  mockVerifyNativeOtp.mockImplementation(async () => ({
    authenticated: true,
    user: { id: userId },
    memberships: [{ organizationId: 'org-a' }],
    session: {
      accessToken: accessToken('aal2'),
      refreshToken: 'controlled-refresh-token',
      expiresIn: 3600,
    },
  }));
  mockVerifyNativeRecoveryOtp.mockImplementation(async () => ({
    authenticated: true,
    user: { id: userId },
    memberships: [{ organizationId: 'org-a' }],
    recovery: { otherSessionsRevoked: 4 },
    session: {
      accessToken: accessToken('aal2'),
      refreshToken: 'controlled-refresh-token',
      expiresIn: 3600,
    },
  }));
  mockRequestNativeSignup.mockImplementation(async () => ({ status: 'code_sent' }));
  mockVerifyNativeSignup.mockImplementation(async () => ({
    authenticated: true,
    user: { id: userId },
    memberships: [{ organizationId: 'org-personal' }],
    signup: { username: 'river_runner_7', organizationId: 'org-personal' },
    session: {
      accessToken: accessToken('aal1'),
      refreshToken: 'controlled-refresh-token',
      expiresIn: 3600,
    },
  }));
  mockPurgeUser.mockImplementation(async () => undefined);
});

describe('native authentication state machine', () => {
  test('restores only a membership-validated session and derives AAL claims', async () => {
    expect(Platform.OS).toBe('ios');
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    expect(mockValidateNativeMembership).toHaveBeenCalledWith({
      accessToken: accessToken('aal2'),
      userId,
    });
    expect(currentAuth().user?.id).toBe(userId);
    expect(currentAuth().sessionId).toBe('session-native');
    expect(currentAuth().assuranceLevel).toBe('aal2');
  });

  test('rejects a stored session when authoritative membership is gone', async () => {
    mockValidateNativeMembership.mockImplementationOnce(async () => {
      throw { code: 'membership_required' };
    });
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('signed-out:errors.membership')).toBeTruthy());
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  test('retains the last session only for a retryable membership dependency failure', async () => {
    mockValidateNativeMembership.mockImplementationOnce(async () => {
      throw { code: 'http_503' };
    });
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  test('activates OTP and recovery sessions through the real provider transitions', async () => {
    mockGetSession.mockImplementationOnce(async () => ({ data: { session: null }, error: null }));
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());

    await expect(currentAuth().requestOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'controlled-captcha-input',
    })).resolves.toEqual({ channelConfigured: true });

    await act(async () => {
      await currentAuth().verifyOtp({
        destinationType: 'email',
        destination: 'employee@example.test',
        code: '123456',
      });
    });
    expect(screen.getByText('signed-in')).toBeTruthy();

    await expect(currentAuth().requestRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      captchaToken: 'controlled-captcha-input',
    })).resolves.toEqual({ channelConfigured: true });
    let recoveryResult: { otherSessionsRevoked: number } | undefined;
    await act(async () => {
      recoveryResult = await currentAuth().verifyRecoveryOtp({
        destinationType: 'email',
        destination: 'employee@example.test',
        code: '654321',
      });
    });
    expect(recoveryResult).toEqual({ otherSessionsRevoked: 4 });
  });

  test('activates a consumer signup session through the same native activation contract', async () => {
    mockGetSession.mockImplementationOnce(async () => ({ data: { session: null }, error: null }));
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());

    const signupInput = {
      destination: 'new.person@example.test',
      username: 'river_runner_7',
      displayName: 'River Runner',
      language: 'ko' as const,
      captchaToken: 'controlled-captcha-input',
    };
    await expect(currentAuth().requestSignup(signupInput)).resolves.toBeUndefined();
    expect(mockRequestNativeSignup).toHaveBeenCalledWith(signupInput);

    await act(async () => {
      await currentAuth().verifySignup({
        destination: 'new.person@example.test',
        code: '123456',
      });
    });
    expect(mockVerifyNativeSignup).toHaveBeenCalledWith({
      destination: 'new.person@example.test',
      code: '123456',
    });
    expect(screen.getByText('signed-in')).toBeTruthy();
    expect(currentAuth().user?.id).toBe(userId);
  });

  test('rejects a signup activation whose local session does not match the gateway user', async () => {
    mockGetSession.mockImplementationOnce(async () => ({ data: { session: null }, error: null }));
    mockSetSession.mockImplementationOnce(async () => ({
      data: { session: { ...nativeSession(), user: { id: 'intruder-user' } } },
      error: null,
    }));
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());

    await expect(currentAuth().verifySignup({
      destination: 'new.person@example.test',
      code: '123456',
    })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(screen.getByText('signed-out')).toBeTruthy();
  });

  test('refreshes assurance and always removes credentials and user-scoped data on sign-out', async () => {
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());

    let assurance: 'aal1' | 'aal2' | null = null;
    await act(async () => {
      assurance = await currentAuth().refreshAssurance();
    });
    expect(assurance).toBe('aal2');
    await act(async () => {
      await currentAuth().signOut();
    });

    expect(mockRemoveAllChannels).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    expect(screen.getByText('signed-out')).toBeTruthy();
  });
});
