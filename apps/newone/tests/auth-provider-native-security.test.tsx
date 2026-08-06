import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';
import { AppState, type AppStateStatus, Text } from 'react-native';

import { AuthProvider, useAuth } from '@/state/auth';

const mockGetSession = jest.fn();
const mockOnAuthStateChange = jest.fn();
const mockSetSession = jest.fn();
const mockSignOut = jest.fn();
const mockRefreshSession = jest.fn();
const mockStartAutoRefresh = jest.fn();
const mockStopAutoRefresh = jest.fn();
const mockUnsubscribe = jest.fn();
const mockRemoveAppStateListener = jest.fn();
const mockRemoveAllChannels = jest.fn();
const mockValidateNativeMembership = jest.fn();
const mockRequestNativeOtp = jest.fn();
const mockVerifyNativeOtp = jest.fn();
const mockRequestNativeRecoveryOtp = jest.fn();
const mockVerifyNativeRecoveryOtp = jest.fn();
const mockPurgeUser = jest.fn();
const mockTranslate = (mockKey: string) => mockKey;

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
let mockSupabaseClient: typeof mockSupabase | null = mockSupabase;
let mockAuthStateCallback: ((event: string, session: ReturnType<typeof nativeSession> | null) => void) | null = null;
let mockAppStateCallback: ((state: AppStateStatus) => void) | null = null;

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
  getSupabaseClient: () => mockSupabaseClient,
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
    requestWebOtp: jest.fn(),
    requestWebRecoveryOtp: jest.fn(),
    signOutWebSession: jest.fn(),
    validateNativeMembership: (mockInput: unknown) => mockValidateNativeMembership(mockInput),
    verifyNativeOtp: (mockInput: unknown) => mockVerifyNativeOtp(mockInput),
    verifyNativeRecoveryOtp: (mockInput: unknown) => mockVerifyNativeRecoveryOtp(mockInput),
    verifyWebOtp: jest.fn(),
    verifyWebRecoveryOtp: jest.fn(),
    WebAuthError: ControlledWebAuthError,
  };
});

const userId = '10000000-0000-4000-8000-000000000001';
const otherUserId = '20000000-0000-4000-8000-000000000002';

function encodedToken(claims: unknown) {
  const payload = btoa(JSON.stringify(claims))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${payload}.signature`;
}

function accessToken(aal: 'aal1' | 'aal2', sessionId = 'session-native') {
  return encodedToken({ aal, session_id: sessionId });
}

function nativeSession(
  aal: 'aal1' | 'aal2' = 'aal2',
  id = userId,
  token = accessToken(aal),
) {
  return {
    access_token: token,
    refresh_token: 'controlled-refresh-token',
    user: { id },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
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

async function renderProvider() {
  return render(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>,
  );
}

beforeEach(() => {
  observedAuth = null;
  mockAuthStateCallback = null;
  mockAppStateCallback = null;
  mockSupabaseClient = mockSupabase;
  mockGetSession.mockImplementation(async () => ({
    data: { session: nativeSession() },
    error: null,
  }));
  mockOnAuthStateChange.mockImplementation((...mockArgs: unknown[]) => {
    mockAuthStateCallback = mockArgs[0] as NonNullable<typeof mockAuthStateCallback>;
    return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
  });
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
    channel: { type: 'email', configured: false },
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
  mockPurgeUser.mockImplementation(async () => undefined);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((
    _mockType: string,
    mockCallback: (state: AppStateStatus) => void,
  ) => {
    mockAppStateCallback = mockCallback;
    return { remove: mockRemoveAppStateListener };
  });
});

afterEach(() => {
  observedAuth = null;
});

describe('native authentication security state machine', () => {
  test('fails closed for absent, errored, and rejected stored sessions', async () => {
    mockGetSession.mockImplementationOnce(async () => ({
      data: { session: null },
      error: { message: 'controlled session failure' },
    }));
    const errored = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-out:errors.session')).toBeTruthy());
    await errored.unmount();

    mockGetSession.mockImplementationOnce(async () => ({ data: { session: null }, error: null }));
    const empty = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());
    await empty.unmount();

    mockGetSession.mockImplementationOnce(async () => {
      throw new Error('controlled storage rejection');
    });
    const rejected = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-out:errors.session')).toBeTruthy());
    await rejected.unmount();
  });

  test.each([
    ['missing payload', 'header', null, null],
    ['invalid payload', 'header.***.signature', null, null],
    ['untrusted claim types', encodedToken({ aal: 'aal3', session_id: 42 }), null, null],
    ['valid aal1', accessToken('aal1', 'session-aal1'), 'session-aal1', 'aal1'],
  ])('derives no authority from %s JWT claims', async (_label, token, expectedSessionId, expectedAal) => {
    mockGetSession.mockImplementationOnce(async () => ({
      data: { session: nativeSession('aal2', userId, String(token)) },
      error: null,
    }));
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    expect(currentAuth().sessionId).toBe(expectedSessionId);
    expect(currentAuth().assuranceLevel).toBe(expectedAal);
    await view.unmount();
  });

  test('ignores stale auth events, handles signed-out cleanup, and controls refresh by app state', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());

    await act(async () => {
      mockAuthStateCallback?.('TOKEN_REFRESHED', nativeSession('aal2', otherUserId));
      mockAppStateCallback?.('background');
      mockAppStateCallback?.('active');
    });
    expect(currentAuth().user?.id).toBe(userId);
    expect(mockStopAutoRefresh).toHaveBeenCalled();
    expect(mockStartAutoRefresh).toHaveBeenCalled();

    await act(async () => {
      mockAuthStateCallback?.('SIGNED_OUT', null);
    });
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    expect(screen.getByText('signed-out')).toBeTruthy();

    await act(async () => {
      mockAuthStateCallback?.('TOKEN_REFRESHED', null);
    });
    expect(mockPurgeUser).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
    expect(mockRemoveAppStateListener).toHaveBeenCalled();
    mockAuthStateCallback?.('SIGNED_IN', nativeSession());
    expect(screen.queryByText('signed-in')).toBeNull();
  });

  test('does not commit a restoration or membership result after unmount', async () => {
    const pendingSession = deferred<{
      data: { session: ReturnType<typeof nativeSession> };
      error: null;
    }>();
    mockGetSession.mockImplementationOnce(() => pendingSession.promise);
    const waitingForSession = await renderProvider();
    await waitingForSession.unmount();
    pendingSession.resolve({ data: { session: nativeSession() }, error: null });
    await act(async () => {
      await pendingSession.promise;
    });

    const pendingMembership = deferred<{ organizationId: string }>();
    mockGetSession.mockImplementationOnce(async () => ({ data: { session: nativeSession() }, error: null }));
    mockValidateNativeMembership.mockImplementationOnce(() => pendingMembership.promise);
    const waitingForMembership = await renderProvider();
    await waitFor(() => expect(mockValidateNativeMembership).toHaveBeenCalled());
    await waitingForMembership.unmount();
    pendingMembership.resolve({ organizationId: 'org-a' });
    await act(async () => {
      await pendingMembership.promise;
    });
  });

  test('does not commit a rejected restoration after unmount', async () => {
    const pendingSession = deferred<never>();
    mockGetSession.mockImplementationOnce(() => pendingSession.promise);
    const view = await renderProvider();
    await view.unmount();
    pendingSession.reject(new Error('controlled rejection after teardown'));
    await act(async () => {
      await pendingSession.promise.catch(() => undefined);
    });
  });

  test('keeps activation atomic and rejects each malformed native OTP session receipt', async () => {
    mockGetSession.mockImplementationOnce(async () => ({ data: { session: null }, error: null }));
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());

    mockSetSession.mockImplementationOnce(async () => {
      mockAuthStateCallback?.('SIGNED_IN', nativeSession());
      return { data: { session: nativeSession() }, error: null };
    });
    await act(async () => {
      await currentAuth().verifyOtp({
        destinationType: 'email',
        destination: 'employee@example.test',
        code: '123456',
      });
    });
    expect(screen.getByText('signed-in')).toBeTruthy();

    for (const malformed of [
      { data: { session: nativeSession() }, error: { message: 'set failed' } },
      { data: { session: null }, error: null },
      { data: { session: nativeSession('aal2', otherUserId) }, error: null },
    ]) {
      mockSetSession.mockImplementationOnce(async () => malformed);
      await expect(currentAuth().verifyOtp({
        destinationType: 'email',
        destination: 'employee@example.test',
        code: '123456',
      })).rejects.toMatchObject({ code: 'invalid_response' });
    }
    expect(mockSignOut).toHaveBeenCalledTimes(3);
    await view.unmount();
  });

  test('rejects each malformed native recovery receipt and preserves the receipt count on success', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());

    for (const malformed of [
      { data: { session: nativeSession() }, error: { message: 'set failed' } },
      { data: { session: null }, error: null },
      { data: { session: nativeSession('aal2', otherUserId) }, error: null },
    ]) {
      mockSetSession.mockImplementationOnce(async () => malformed);
      await expect(currentAuth().verifyRecoveryOtp({
        destinationType: 'phone',
        destination: '+15555550100',
        code: '654321',
      })).rejects.toMatchObject({ code: 'invalid_response' });
    }

    let result: { otherSessionsRevoked: number } | undefined;
    await act(async () => {
      result = await currentAuth().verifyRecoveryOtp({
        destinationType: 'phone',
        destination: '+15555550100',
        code: '654321',
      });
    });
    expect(result).toEqual({ otherSessionsRevoked: 4 });
    await view.unmount();
  });

  test('forwards native request inputs and handles all assurance refresh outcomes', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());

    const otpInput = {
      destinationType: 'phone' as const,
      destination: '+15555550100',
      invitationToken: 'controlled-invitation',
      employeeCode: 'E-100',
      captchaToken: 'controlled-captcha-token',
    };
    await expect(currentAuth().requestOtp(otpInput)).resolves.toEqual({ channelConfigured: true });
    expect(mockRequestNativeOtp).toHaveBeenCalledWith(otpInput);
    await expect(currentAuth().requestRecoveryOtp({
      destinationType: 'phone',
      destination: '+15555550100',
      captchaToken: 'controlled-captcha-token',
    })).resolves.toEqual({ channelConfigured: false });

    mockRefreshSession.mockImplementationOnce(async () => ({
      data: { session: null },
      error: { message: 'controlled refresh error' },
    }));
    let refreshedAssurance: 'aal1' | 'aal2' | null | undefined;
    await act(async () => {
      refreshedAssurance = await currentAuth().refreshAssurance();
    });
    expect(refreshedAssurance).toBeNull();
    mockRefreshSession.mockImplementationOnce(async () => ({ data: { session: null }, error: null }));
    await expect(currentAuth().refreshAssurance()).resolves.toBeNull();
    mockRefreshSession.mockImplementationOnce(async () => ({
      data: { session: nativeSession('aal2', userId, encodedToken({ aal: 'aal3' })) },
      error: null,
    }));
    await act(async () => {
      refreshedAssurance = await currentAuth().refreshAssurance();
    });
    expect(refreshedAssurance).toBeNull();
    await view.unmount();
  });

  test('finishes local sign-out and access revocation when sockets and identity teardown fail', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    mockRemoveAllChannels.mockImplementationOnce(async () => {
      throw new Error('controlled socket failure');
    });
    mockSignOut.mockImplementationOnce(async () => {
      throw new Error('controlled local sign-out failure');
    });
    await act(async () => {
      await currentAuth().signOut();
    });
    expect(screen.getByText('signed-out')).toBeTruthy();
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    await view.unmount();

    const accessView = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    mockRemoveAllChannels.mockImplementationOnce(async () => {
      throw new Error('controlled socket failure');
    });
    await act(async () => {
      await currentAuth().endAccess();
    });
    expect(screen.getByText('signed-out:errors.accessEnded')).toBeTruthy();
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    await accessView.unmount();
  });

  test('fails unavailable native activation closed and supports teardown without a client', async () => {
    mockSupabaseClient = null;
    const view = await renderProvider();
    expect(screen.getByText('loading')).toBeTruthy();
    await expect(currentAuth().verifyOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '123456',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });
    await expect(currentAuth().verifyRecoveryOtp({
      destinationType: 'email',
      destination: 'employee@example.test',
      code: '654321',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });
    await expect(currentAuth().refreshAssurance()).resolves.toBeNull();
    await act(async () => {
      await currentAuth().signOut();
      await currentAuth().endAccess();
    });
    expect(screen.getByText('loading:errors.accessEnded')).toBeTruthy();
    await view.unmount();
  });

  test('requires the provider boundary', async () => {
    function InvalidProbe() {
      useAuth();
      return null;
    }
    await expect(render(<InvalidProbe />)).rejects.toThrow('useAuth must be used inside AuthProvider');
  });
});
