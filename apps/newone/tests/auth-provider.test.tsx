import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AuthRetryableFetchError } from '@supabase/supabase-js';
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
const mockVerifyNativePassword = jest.fn();
const mockSetNativePassword = jest.fn();
const mockRequestNativeSignup = jest.fn();
const mockVerifyNativeSignup = jest.fn();
const mockDeleteNativeAccount = jest.fn();
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
    deleteNativeAccount: (mockInput: unknown) => mockDeleteNativeAccount(mockInput),
    deleteWebAccount: jest.fn(),
    getWebRealtimeToken: jest.fn(),
    getWebSession: jest.fn(),
    refreshWebSession: jest.fn(),
    requestNativeOtp: (mockInput: unknown) => mockRequestNativeOtp(mockInput),
    requestNativeRecoveryOtp: (mockInput: unknown) => mockRequestNativeRecoveryOtp(mockInput),
    requestNativeSignup: (mockInput: unknown) => mockRequestNativeSignup(mockInput),
    requestWebOtp: jest.fn(),
    requestWebRecoveryOtp: jest.fn(),
    requestWebSignup: jest.fn(),
    setNativePassword: (mockInput: unknown) => mockSetNativePassword(mockInput),
    setWebPassword: jest.fn(),
    signOutWebSession: jest.fn(),
    validateNativeMembership: (mockInput: unknown) => mockValidateNativeMembership(mockInput),
    verifyNativeOtp: (mockInput: unknown) => mockVerifyNativeOtp(mockInput),
    verifyNativePassword: (mockInput: unknown) => mockVerifyNativePassword(mockInput),
    verifyNativeRecoveryOtp: (mockInput: unknown) => mockVerifyNativeRecoveryOtp(mockInput),
    verifyNativeSignup: (mockInput: unknown) => mockVerifyNativeSignup(mockInput),
    verifyWebOtp: jest.fn(),
    verifyWebPassword: jest.fn(),
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
  mockDeleteNativeAccount.mockImplementation(async () => ({ status: 'deleted' }));
  mockVerifyNativePassword.mockImplementation(async () => ({
    authenticated: true,
    user: { id: userId, hasPassword: true },
    memberships: [{ organizationId: 'org-a' }],
    session: {
      accessToken: accessToken('aal1'),
      refreshToken: 'controlled-refresh-token',
      expiresIn: 3600,
    },
  }));
  mockSetNativePassword.mockImplementation(async () => ({ passwordSet: true }));
  mockPurgeUser.mockImplementation(async () => undefined);
});

describe('sessions that last', () => {
  test('a refused token is refreshed and checked once more; the session stays and nothing signs out', async () => {
    mockValidateNativeMembership
      .mockImplementationOnce(async () => {
        throw { code: 'http_401' };
      })
      .mockImplementationOnce(async () => ({ organizationId: 'org-a' }));
    mockRefreshSession.mockImplementationOnce(async () => ({
      data: { session: { ...nativeSession('aal1'), access_token: accessToken('aal1', 'session-refreshed') } },
      error: null,
    }));
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockValidateNativeMembership).toHaveBeenCalledTimes(2);
    expect(mockValidateNativeMembership).toHaveBeenLastCalledWith({
      accessToken: accessToken('aal1', 'session-refreshed'),
      userId,
    });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(currentAuth().sessionId).toBe('session-refreshed');
    expect(currentAuth().error).toBeNull();
  });

  test('a refused token whose refresh has no network keeps the stored session', async () => {
    mockValidateNativeMembership.mockImplementationOnce(async () => {
      throw { code: 'http_401' };
    });
    mockRefreshSession.mockImplementationOnce(async () => ({
      data: { session: null },
      error: new AuthRetryableFetchError('offline', 0),
    }));
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(currentAuth().sessionId).toBe('session-native');
  });

  test('a token still refused after a fresh one is a verdict and signs out with a plain message', async () => {
    mockValidateNativeMembership
      .mockImplementationOnce(async () => {
        throw { code: 'http_401' };
      })
      .mockImplementationOnce(async () => {
        throw { code: 'membership_required' };
      });
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('signed-out:errors.membership')).toBeTruthy());
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  test('a launch without network keeps the launch screen and signs in once the refresh goes through', async () => {
    mockGetSession
      .mockImplementationOnce(async () => ({
        data: { session: null },
        error: new AuthRetryableFetchError('offline', 0),
      }))
      .mockImplementationOnce(async () => ({ data: { session: nativeSession() }, error: null }));
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(screen.getByText('loading')).toBeTruthy();
    await waitFor(() => expect(mockGetSession).toHaveBeenCalledTimes(1));
    expect(screen.getByText('loading')).toBeTruthy();
    expect(screen.queryByText(/signed-out/)).toBeNull();
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy(), { timeout: 4000 });
    expect(mockGetSession).toHaveBeenCalledTimes(2);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  test('a stored session the client itself has given up on shows the plain signed-out message', async () => {
    mockGetSession.mockImplementationOnce(async () => ({
      data: { session: null },
      error: Object.assign(new Error('Invalid Refresh Token'), { name: 'AuthApiError' }),
    }));
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('signed-out:errors.session')).toBeTruthy());
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  test('refreshSession forces a refresh and only reports a lost session for a real rejection', async () => {
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await currentAuth().refreshSession();
    });
    expect(outcome).toBe(true);

    mockRefreshSession.mockImplementationOnce(async () => ({
      data: { session: null },
      error: new AuthRetryableFetchError('offline', 0),
    }));
    await act(async () => {
      outcome = await currentAuth().refreshSession();
    });
    expect(outcome).toBe(true);
    expect(screen.getByText('signed-in')).toBeTruthy();

    mockRefreshSession.mockImplementationOnce(async () => ({
      data: { session: null },
      error: Object.assign(new Error('Invalid Refresh Token'), { name: 'AuthApiError' }),
    }));
    await act(async () => {
      outcome = await currentAuth().refreshSession();
    });
    expect(outcome).toBe(false);
  });
});

describe('passwords', () => {
  test('a code sign-in for an account without a password raises the one-time offer until it is dismissed', async () => {
    mockGetSession.mockImplementationOnce(async () => ({ data: { session: null }, error: null }));
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());
    expect(currentAuth().passwordPromptPending).toBe(false);

    let outcome: { hasPassword: boolean } | undefined;
    await act(async () => {
      outcome = await currentAuth().verifyOtp({
        destinationType: 'email',
        destination: 'employee@example.test',
        code: '123456',
      });
    });
    expect(outcome).toEqual({ hasPassword: false });
    expect(screen.getByText('signed-in')).toBeTruthy();
    expect(currentAuth().passwordPromptPending).toBe(true);
    expect(currentAuth().hasPassword).toBe(false);

    await act(async () => {
      currentAuth().dismissPasswordPrompt();
    });
    expect(currentAuth().passwordPromptPending).toBe(false);
  });

  test('setPassword uses the live bearer, marks the account, and pulls the stamped session', async () => {
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    expect(currentAuth().hasPassword).toBe(false);
    mockRefreshSession.mockImplementationOnce(async () => ({
      data: {
        session: {
          ...nativeSession('aal2'),
          user: { id: userId, app_metadata: { newone_password_set_at: '2026-09-05T00:00:00Z' } },
        },
      },
      error: null,
    }));

    await act(async () => {
      await currentAuth().setPassword('correct horse battery');
    });
    expect(mockSetNativePassword).toHaveBeenCalledWith({
      accessToken: accessToken('aal2'),
      password: 'correct horse battery',
    });
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(currentAuth().hasPassword).toBe(true);
    expect(currentAuth().passwordPromptPending).toBe(false);
    expect(screen.getByText('signed-in')).toBeTruthy();
  });

  test('a rejected setPassword changes nothing locally', async () => {
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    mockSetNativePassword.mockImplementationOnce(async () => {
      throw Object.assign(new Error('too short'), { code: 'weak_password' });
    });

    await act(async () => {
      await expect(currentAuth().setPassword('short')).rejects.toMatchObject({ code: 'weak_password' });
    });
    expect(currentAuth().hasPassword).toBe(false);
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  test('signInWithPassword activates the gateway session through the same native contract and never raises the offer', async () => {
    mockGetSession.mockImplementationOnce(async () => ({ data: { session: null }, error: null }));
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());

    const input = {
      destinationType: 'email' as const,
      destination: 'employee@example.test',
      password: 'correct horse battery',
    };
    await act(async () => {
      await currentAuth().signInWithPassword(input);
    });
    expect(mockVerifyNativePassword).toHaveBeenCalledWith(input);
    expect(mockSetSession).toHaveBeenCalledWith({
      access_token: accessToken('aal1'),
      refresh_token: 'controlled-refresh-token',
    });
    expect(screen.getByText('signed-in')).toBeTruthy();
    expect(currentAuth().passwordPromptPending).toBe(false);
  });

  test('a password activation whose local session does not match the gateway user is refused', async () => {
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

    await expect(currentAuth().signInWithPassword({
      destinationType: 'email',
      destination: 'employee@example.test',
      password: 'correct horse battery',
    })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(screen.getByText('signed-out')).toBeTruthy();
  });
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
    expect(recoveryResult).toEqual({ otherSessionsRevoked: 4, hasPassword: false });
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
    password: 'correct horse battery',
      captchaToken: 'controlled-captcha-input',
    };
    await expect(currentAuth().requestSignup(signupInput)).resolves.toBeUndefined();
    expect(mockRequestNativeSignup).toHaveBeenCalledWith(signupInput);

    await act(async () => {
      await currentAuth().verifySignup({
        destination: 'new.person@example.test',
        code: '123456',
        password: 'correct horse battery',
      });
    });
    expect(mockVerifyNativeSignup).toHaveBeenCalledWith({
      destination: 'new.person@example.test',
      code: '123456',
      password: 'correct horse battery',
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
      password: 'correct horse battery',
    })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(screen.getByText('signed-out')).toBeTruthy();
  });

  test('deletes the native account with the active bearer session then finishes full teardown', async () => {
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());

    await act(async () => {
      await currentAuth().deleteAccount();
    });

    expect(mockDeleteNativeAccount).toHaveBeenCalledWith({ accessToken: accessToken('aal2') });
    expect(mockRemoveAllChannels).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    expect(screen.getByText('signed-out')).toBeTruthy();
  });

  test('completes native deletion teardown even when the socket and local sign-out fail', async () => {
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    mockRemoveAllChannels.mockImplementationOnce(async () => {
      throw new Error('controlled socket failure');
    });
    mockSignOut.mockImplementationOnce(async () => {
      throw new Error('controlled local sign-out failure');
    });

    await act(async () => {
      await currentAuth().deleteAccount();
    });

    expect(mockDeleteNativeAccount).toHaveBeenCalledTimes(1);
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    expect(screen.getByText('signed-out')).toBeTruthy();
  });

  test('a rejected deletion leaves the native session and local data untouched', async () => {
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    mockDeleteNativeAccount.mockImplementationOnce(async () => {
      throw Object.assign(new Error('controlled rejection'), { code: 'recent_auth_required' });
    });

    await act(async () => {
      await expect(currentAuth().deleteAccount()).rejects.toMatchObject({
        code: 'recent_auth_required',
      });
    });

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockPurgeUser).not.toHaveBeenCalled();
    expect(screen.getByText('signed-in')).toBeTruthy();
  });

  test('refuses account deletion without an authenticated native session', async () => {
    mockGetSession.mockImplementationOnce(async () => ({ data: { session: null }, error: null }));
    await render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());

    await expect(currentAuth().deleteAccount()).rejects.toMatchObject({
      code: 'authentication_required',
    });
    expect(mockDeleteNativeAccount).not.toHaveBeenCalled();
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
