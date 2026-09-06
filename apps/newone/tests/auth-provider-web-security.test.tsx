import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';
import { AppState, type AppStateStatus, Platform, Text } from 'react-native';

import { WebAuthError } from '@/lib/web-auth';
import { AuthProvider, useAuth } from '@/state/auth';

const mockGetWebSession = jest.fn();
const mockRefreshWebSession = jest.fn();
const mockGetWebRealtimeToken = jest.fn();
const mockRequestWebOtp = jest.fn();
const mockRequestWebRecoveryOtp = jest.fn();
const mockRequestWebSignup = jest.fn();
const mockVerifyWebOtp = jest.fn();
const mockVerifyWebRecoveryOtp = jest.fn();
const mockVerifyWebSignup = jest.fn();
const mockSignOutWebSession = jest.fn();
const mockDeleteWebAccount = jest.fn();
const mockInitializeStore = jest.fn();
const mockGetCache = jest.fn();
const mockPutCache = jest.fn();
const mockRemoveCache = jest.fn();
const mockPurgeUser = jest.fn();
const mockRemoveAllChannels = jest.fn();
const mockRemoveAppStateListener = jest.fn();
const mockTranslate = (mockKey: string) => mockKey;
let mockAppStateCallback: ((state: AppStateStatus) => void) | null = null;
let mockIntervalCallback: (() => void) | null = null;
let mockRealtimeClient: { removeAllChannels: typeof mockRemoveAllChannels } | null = {
  removeAllChannels: mockRemoveAllChannels,
};
const mockNativeSetInterval = globalThis.setInterval.bind(globalThis);

jest.mock('@/config/runtime', () => ({
  publicRuntimeConfig: { offlineCacheEnabled: true },
  runtimeMode: 'web',
}));

jest.mock('@/data/persistence/client-store', () => ({
  clientStore: {
    getCache: (...mockArgs: unknown[]) => mockGetCache(...mockArgs),
    initialize: (...mockArgs: unknown[]) => mockInitializeStore(...mockArgs),
    purgeUser: (...mockArgs: unknown[]) => mockPurgeUser(...mockArgs),
    putCache: (...mockArgs: unknown[]) => mockPutCache(...mockArgs),
    removeCache: (...mockArgs: unknown[]) => mockRemoveCache(...mockArgs),
  },
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: mockTranslate }),
}));

jest.mock('@/lib/supabase', () => ({
  getRealtimeClient: () => mockRealtimeClient,
  getSupabaseClient: () => null,
  isNativeSupabaseConfigured: false,
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
    deleteNativeAccount: jest.fn(),
    deleteWebAccount: (...mockArgs: unknown[]) => mockDeleteWebAccount(...mockArgs),
    getWebRealtimeToken: (...mockArgs: unknown[]) => mockGetWebRealtimeToken(...mockArgs),
    getWebSession: (...mockArgs: unknown[]) => mockGetWebSession(...mockArgs),
    refreshWebSession: (...mockArgs: unknown[]) => mockRefreshWebSession(...mockArgs),
    requestNativeOtp: jest.fn(),
    requestNativeRecoveryOtp: jest.fn(),
    requestNativeSignup: jest.fn(),
    requestWebOtp: (...mockArgs: unknown[]) => mockRequestWebOtp(...mockArgs),
    requestWebRecoveryOtp: (...mockArgs: unknown[]) => mockRequestWebRecoveryOtp(...mockArgs),
    requestWebSignup: (...mockArgs: unknown[]) => mockRequestWebSignup(...mockArgs),
    signOutWebSession: (...mockArgs: unknown[]) => mockSignOutWebSession(...mockArgs),
    validateNativeMembership: jest.fn(),
    verifyNativeOtp: jest.fn(),
    verifyNativeRecoveryOtp: jest.fn(),
    verifyNativeSignup: jest.fn(),
    verifyWebOtp: (...mockArgs: unknown[]) => mockVerifyWebOtp(...mockArgs),
    verifyWebRecoveryOtp: (...mockArgs: unknown[]) => mockVerifyWebRecoveryOtp(...mockArgs),
    verifyWebSignup: (...mockArgs: unknown[]) => mockVerifyWebSignup(...mockArgs),
    WebAuthError: ControlledWebAuthError,
  };
});

const userId = '10000000-0000-4000-8000-000000000001';
const otherUserId = '20000000-0000-4000-8000-000000000002';

function webSession(overrides: Record<string, unknown> = {}) {
  return {
    authenticated: true,
    user: { id: userId, email: 'employee@example.test' },
    organization: { id: 'org-a', role: 'member' },
    sessionId: 'session-web',
    aal: 'aal2',
    ...overrides,
  };
}

function offlineIdentity(id: string) {
  return JSON.stringify({
    version: 1,
    userId: id,
    savedAt: new Date().toISOString(),
  });
}

function authError(code: string) {
  return new WebAuthError('controlled auth failure', code);
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
let platformRestore: { restore: () => void } | null = null;

function AuthProbe() {
  const auth = useAuth();
  useEffect(() => {
    observedAuth = auth;
  }, [auth]);
  return (
    <Text>
      {auth.loading ? 'loading' : auth.authenticated ? 'signed-in' : 'signed-out'}
      {auth.error ? `:${auth.error}` : ''}
      {auth.realtimeToken ? `:${auth.realtimeToken}` : ''}
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
  mockAppStateCallback = null;
  mockIntervalCallback = null;
  mockRealtimeClient = { removeAllChannels: mockRemoveAllChannels };
  platformRestore = jest.replaceProperty(Platform, 'OS', 'web');
  mockGetWebSession.mockImplementation(async () => webSession());
  mockRefreshWebSession.mockImplementation(async () => webSession());
  mockGetWebRealtimeToken.mockImplementation(async () => ({ accessToken: 'realtime-web-token' }));
  mockRequestWebOtp.mockImplementation(async () => ({
    accepted: true,
    channel: { type: 'email', configured: true },
  }));
  mockRequestWebRecoveryOtp.mockImplementation(async () => ({
    accepted: true,
    channel: { type: 'phone', configured: false },
  }));
  mockVerifyWebOtp.mockImplementation(async () => webSession());
  mockVerifyWebRecoveryOtp.mockImplementation(async () => ({
    ...webSession(),
    recovery: { otherSessionsRevoked: 6 },
  }));
  mockRequestWebSignup.mockImplementation(async () => ({ status: 'code_sent' }));
  mockVerifyWebSignup.mockImplementation(async () => ({
    ...webSession(),
    signup: { username: 'river_runner_7', organizationId: 'org-personal' },
  }));
  mockSignOutWebSession.mockImplementation(async () => undefined);
  mockDeleteWebAccount.mockImplementation(async () => ({ status: 'deleted' }));
  mockInitializeStore.mockImplementation(async () => undefined);
  mockGetCache.mockImplementation(async () => null);
  mockPutCache.mockImplementation(async () => undefined);
  mockRemoveCache.mockImplementation(async () => undefined);
  mockPurgeUser.mockImplementation(async () => undefined);
  mockRemoveAllChannels.mockImplementation(async () => undefined);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((
    _mockType: string,
    mockCallback: (state: AppStateStatus) => void,
  ) => {
    mockAppStateCallback = mockCallback;
    return { remove: mockRemoveAppStateListener };
  });
  type ControlledSetInterval = (
    mockCallback: () => void,
    mockDelay?: number,
  ) => NodeJS.Timeout;
  const controlledSetInterval: ControlledSetInterval = (mockCallback, mockDelay) => {
    if (mockDelay === 4 * 60 * 1000) {
      mockIntervalCallback = mockCallback;
      return 71 as unknown as NodeJS.Timeout;
    }
    return mockNativeSetInterval(mockCallback, mockDelay) as unknown as NodeJS.Timeout;
  };
  const intervalSpy = jest.spyOn(globalThis, 'setInterval') as unknown as {
    mockImplementation: (implementation: ControlledSetInterval) => void;
  };
  intervalSpy.mockImplementation(controlledSetInterval);
});

afterEach(() => {
  platformRestore?.restore();
  platformRestore = null;
  observedAuth = null;
});

describe('web authentication security state machine', () => {
  test('restores a server session, rotates the offline identity, and refreshes the private realtime token', async () => {
    mockGetCache.mockImplementationOnce(async () => offlineIdentity(otherUserId));
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    expect(currentAuth()).toMatchObject({
      user: { id: userId },
      sessionId: 'session-web',
      assuranceLevel: 'aal2',
      session: null,
    });
    await waitFor(() => expect(mockPutCache).toHaveBeenCalled());
    expect(mockPurgeUser).toHaveBeenCalledWith(otherUserId);

    mockGetWebRealtimeToken.mockImplementationOnce(async () => ({ accessToken: 'rotated-realtime-token' }));
    await act(async () => {
      mockIntervalCallback?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('signed-in:rotated-realtime-token')).toBeTruthy());
    await view.unmount();
  });

  test('refreshes a rejected cookie session and accepts nullable assurance metadata', async () => {
    mockGetWebSession.mockImplementationOnce(async () => {
      throw authError('http_401');
    });
    mockRefreshWebSession.mockImplementationOnce(async () => webSession({
      sessionId: undefined,
      aal: undefined,
    }));
    mockGetCache.mockImplementationOnce(async () => offlineIdentity(userId));
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    expect(currentAuth().sessionId).toBeNull();
    expect(currentAuth().assuranceLevel).toBeNull();
    expect(mockPurgeUser).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('uses only a bounded valid offline identity during a network outage', async () => {
    mockGetWebSession.mockImplementationOnce(async () => {
      throw authError('network_unavailable');
    });
    mockGetCache.mockImplementationOnce(async () => offlineIdentity(userId));
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    expect(currentAuth()).toMatchObject({
      user: { id: userId },
      sessionId: null,
      assuranceLevel: null,
      error: null,
    });
    await view.unmount();
  });

  test.each([
    ['missing offline identity', null],
    ['invalid offline identity', '{not-valid-json'],
  ])('shows the stable network error for %s', async (_label, cached) => {
    mockGetWebSession.mockImplementationOnce(async () => {
      throw authError('network_unavailable');
    });
    mockGetCache.mockImplementationOnce(async () => cached);
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-out:errors.network')).toBeTruthy());
    await view.unmount();
  });

  test('handles offline-store failure without trusting an identity', async () => {
    mockGetWebSession.mockImplementationOnce(async () => {
      throw authError('network_unavailable');
    });
    mockInitializeStore.mockImplementationOnce(async () => {
      throw new Error('controlled offline store failure');
    });
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-out:errors.network')).toBeTruthy());
    await view.unmount();
  });

  test.each([
    ['http_401', true, null],
    ['csrf_required', false, null],
    ['session_revoked', true, 'errors.session'],
    ['unexpected_gateway_failure', false, 'errors.action'],
  ])('classifies %s restoration without rendering upstream details', async (code, forgets, errorKey) => {
    mockGetWebSession.mockImplementationOnce(async () => {
      throw authError(String(code));
    });
    if (code === 'http_401') {
      mockRefreshWebSession.mockImplementationOnce(async () => {
        throw authError('http_401');
      });
    }
    mockGetCache.mockImplementationOnce(async () => offlineIdentity(userId));
    const view = await renderProvider();
    const expected = errorKey ? `signed-out:${errorKey}` : 'signed-out';
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
    if (forgets) {
      expect(mockRemoveCache).toHaveBeenCalled();
    } else {
      expect(mockRemoveCache).not.toHaveBeenCalled();
    }
    await view.unmount();
  });

  test('refreshes only on active lifecycle events and clears a server-revoked cookie session', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    mockRefreshWebSession.mockClear();
    await act(async () => {
      mockAppStateCallback?.('background');
      await Promise.resolve();
    });
    expect(mockRefreshWebSession).not.toHaveBeenCalled();

    mockRefreshWebSession.mockImplementationOnce(async () => webSession({
      user: { id: otherUserId },
      sessionId: 'session-rotated',
      aal: 'aal1',
    }));
    await act(async () => {
      mockAppStateCallback?.('active');
      await Promise.resolve();
    });
    await waitFor(() => expect(currentAuth().user?.id).toBe(otherUserId));
    expect(currentAuth().assuranceLevel).toBe('aal1');

    mockRefreshWebSession.mockImplementationOnce(async () => {
      throw authError('unexpected_gateway_failure');
    });
    await act(async () => {
      mockAppStateCallback?.('active');
      await Promise.resolve();
    });
    expect(currentAuth().user?.id).toBe(otherUserId);

    mockRefreshWebSession.mockImplementationOnce(async () => {
      throw authError('http_401');
    });
    await act(async () => {
      mockAppStateCallback?.('active');
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());
    expect(mockRemoveCache).toHaveBeenCalled();
    await view.unmount();
  });

  test('forwards web OTP inputs and commits verified and recovered sessions', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    const otpInput = {
      destinationType: 'email' as const,
      destination: 'employee@example.test',
      invitationToken: 'controlled-invitation',
      employeeCode: 'E-100',
      captchaToken: 'controlled-captcha-token',
    };
    await expect(currentAuth().requestOtp(otpInput)).resolves.toEqual({ channelConfigured: true });
    expect(mockRequestWebOtp).toHaveBeenCalledWith(otpInput);
    await expect(currentAuth().requestRecoveryOtp({
      destinationType: 'phone',
      destination: '+15555550100',
      captchaToken: 'controlled-captcha-token',
    })).resolves.toEqual({ channelConfigured: false });

    mockVerifyWebOtp.mockImplementationOnce(async () => webSession({ sessionId: undefined, aal: undefined }));
    await act(async () => {
      await currentAuth().verifyOtp({
        destinationType: 'email',
        destination: 'employee@example.test',
        invitationToken: 'controlled-invitation',
        employeeCode: 'E-100',
        code: '123456',
      });
    });
    expect(currentAuth().sessionId).toBeNull();
    expect(currentAuth().assuranceLevel).toBeNull();

    let recovery: { otherSessionsRevoked: number } | undefined;
    await act(async () => {
      recovery = await currentAuth().verifyRecoveryOtp({
        destinationType: 'phone',
        destination: '+15555550100',
        code: '654321',
      });
    });
    expect(recovery).toEqual({ otherSessionsRevoked: 6, hasPassword: false });
    expect(currentAuth().sessionId).toBe('session-web');
    await view.unmount();
  });

  test('forwards consumer signup inputs and commits verified signup sessions identically with or without a receipt', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    const signupInput = {
      destination: 'new.person@example.test',
      username: 'river_runner_7',
      displayName: 'River Runner',
      language: 'es' as const,
    password: 'correct horse battery',
      captchaToken: 'controlled-captcha-token',
    };
    await expect(currentAuth().requestSignup(signupInput)).resolves.toBeUndefined();
    expect(mockRequestWebSignup).toHaveBeenCalledWith(signupInput);

    mockVerifyWebSignup.mockImplementationOnce(async () => webSession({
      sessionId: undefined,
      aal: undefined,
    }));
    await act(async () => {
      await currentAuth().verifySignup({
        destination: 'new.person@example.test',
        code: '123456',
        password: 'correct horse battery',
      });
    });
    expect(mockVerifyWebSignup).toHaveBeenCalledWith({
      destination: 'new.person@example.test',
      code: '123456',
      password: 'correct horse battery',
    });
    expect(currentAuth().sessionId).toBeNull();
    expect(currentAuth().assuranceLevel).toBeNull();

    await act(async () => {
      await currentAuth().verifySignup({
        destination: 'new.person@example.test',
        code: '654321',
        password: 'correct horse battery',
      });
    });
    expect(currentAuth().sessionId).toBe('session-web');
    expect(currentAuth().user?.id).toBe(userId);
    await view.unmount();
  });

  test('refreshes assurance from the authoritative web session', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    mockGetWebSession.mockImplementationOnce(async () => webSession({ sessionId: undefined, aal: undefined }));
    let assurance: 'aal1' | 'aal2' | null | undefined;
    await act(async () => {
      assurance = await currentAuth().refreshAssurance();
    });
    expect(assurance).toBeNull();
    expect(currentAuth().sessionId).toBeNull();
    await view.unmount();
  });

  test('always completes signed-in web teardown when socket, sign-out, and cache operations fail', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    mockRemoveAllChannels.mockImplementationOnce(async () => {
      throw new Error('controlled socket failure');
    });
    mockSignOutWebSession.mockImplementationOnce(async () => {
      throw new Error('controlled already-revoked session');
    });
    mockInitializeStore.mockImplementationOnce(async () => {
      throw new Error('controlled cache failure');
    });
    await act(async () => {
      await currentAuth().signOut();
    });
    expect(screen.getByText('signed-out')).toBeTruthy();
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    await view.unmount();
  });

  test('deletes the web account server-side first and then runs the sign-out teardown', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());

    await act(async () => {
      await currentAuth().deleteAccount();
    });

    expect(mockDeleteWebAccount).toHaveBeenCalledTimes(1);
    expect(mockSignOutWebSession).not.toHaveBeenCalled();
    expect(mockRemoveAllChannels).toHaveBeenCalled();
    expect(mockRemoveCache).toHaveBeenCalled();
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    expect(screen.getByText('signed-out')).toBeTruthy();
    await view.unmount();
  });

  test('completes web deletion teardown when socket and cache maintenance fail', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    mockRemoveAllChannels.mockImplementationOnce(async () => {
      throw new Error('controlled socket failure');
    });
    mockInitializeStore.mockImplementationOnce(async () => {
      throw new Error('controlled cache failure');
    });

    await act(async () => {
      await currentAuth().deleteAccount();
    });

    expect(mockDeleteWebAccount).toHaveBeenCalledTimes(1);
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    expect(screen.getByText('signed-out')).toBeTruthy();
    await view.unmount();
  });

  test('a rejected web deletion keeps the cookie session and local caches intact', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    mockDeleteWebAccount.mockImplementationOnce(async () => {
      throw authError('recent_auth_required');
    });

    await act(async () => {
      await expect(currentAuth().deleteAccount()).rejects.toMatchObject({
        code: 'recent_auth_required',
      });
    });

    expect(mockRemoveCache).not.toHaveBeenCalled();
    expect(mockPurgeUser).not.toHaveBeenCalled();
    expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy();
    await view.unmount();
  });

  test('ends web access and records a stable local state even when remote teardown was already revoked', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    mockRealtimeClient = null;
    mockSignOutWebSession.mockImplementationOnce(async () => {
      throw new Error('controlled already-revoked session');
    });
    mockInitializeStore.mockImplementationOnce(async () => {
      throw new Error('controlled cache failure');
    });
    await act(async () => {
      await currentAuth().endAccess();
    });
    expect(screen.getByText('signed-out:errors.accessEnded')).toBeTruthy();
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    await view.unmount();
  });

  test('supports idempotent teardown when no web identity was restored', async () => {
    mockGetWebSession.mockImplementationOnce(async () => {
      throw authError('csrf_required');
    });
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());
    await act(async () => {
      await currentAuth().signOut();
      await currentAuth().endAccess();
    });
    expect(mockSignOutWebSession).not.toHaveBeenCalled();
    expect(mockPurgeUser).not.toHaveBeenCalled();
    expect(screen.getByText('signed-out:errors.accessEnded')).toBeTruthy();
    await view.unmount();
  });

  test('drops failed realtime tokens and ignores async completions after teardown', async () => {
    mockGetWebRealtimeToken.mockImplementationOnce(async () => {
      throw new Error('controlled realtime-token failure');
    });
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in')).toBeTruthy());
    expect(currentAuth().realtimeToken).toBeNull();
    await view.unmount();

    const pendingSession = deferred<ReturnType<typeof webSession>>();
    mockGetWebSession.mockImplementationOnce(() => pendingSession.promise);
    const waiting = await renderProvider();
    await waiting.unmount();
    pendingSession.resolve(webSession());
    await act(async () => {
      await pendingSession.promise;
    });

    const pendingRejection = deferred<never>();
    mockGetWebSession.mockImplementationOnce(() => pendingRejection.promise);
    const rejecting = await renderProvider();
    await rejecting.unmount();
    pendingRejection.reject(authError('network_unavailable'));
    await act(async () => {
      await pendingRejection.promise.catch(() => undefined);
    });
  });

  test('does not commit lifecycle or realtime refreshes after unmount', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    const pendingLifecycle = deferred<ReturnType<typeof webSession>>();
    mockRefreshWebSession.mockImplementationOnce(() => pendingLifecycle.promise);
    await act(async () => {
      mockAppStateCallback?.('active');
    });
    const pendingRealtime = deferred<{ accessToken: string }>();
    mockGetWebRealtimeToken.mockImplementationOnce(() => pendingRealtime.promise);
    mockIntervalCallback?.();
    await view.unmount();
    pendingLifecycle.resolve(webSession({ user: { id: otherUserId } }));
    pendingRealtime.resolve({ accessToken: 'late-realtime-token' });
    await act(async () => {
      await Promise.all([pendingLifecycle.promise, pendingRealtime.promise]);
    });

    const rejectedLifecycle = deferred<never>();
    mockGetWebSession.mockImplementationOnce(async () => webSession());
    const rejecting = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());
    mockRefreshWebSession.mockImplementationOnce(() => rejectedLifecycle.promise);
    await act(async () => {
      mockAppStateCallback?.('active');
    });
    await rejecting.unmount();
    rejectedLifecycle.reject(authError('http_401'));
    await act(async () => {
      await rejectedLifecycle.promise.catch(() => undefined);
    });
  });

  test('isolates offline cache maintenance failures from session restoration and lifecycle revocation', async () => {
    mockInitializeStore.mockImplementationOnce(async () => {
      throw new Error('controlled remember failure');
    });
    const view = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-in:realtime-web-token')).toBeTruthy());

    mockInitializeStore.mockImplementationOnce(async () => {
      throw new Error('controlled lifecycle remember failure');
    });
    mockRefreshWebSession.mockImplementationOnce(async () => webSession({ aal: 'aal1' }));
    await act(async () => {
      mockAppStateCallback?.('active');
      await Promise.resolve();
    });
    await waitFor(() => expect(currentAuth().assuranceLevel).toBe('aal1'));

    mockInitializeStore.mockImplementationOnce(async () => {
      throw new Error('controlled lifecycle forget failure');
    });
    mockRefreshWebSession.mockImplementationOnce(async () => {
      throw authError('http_401');
    });
    await act(async () => {
      mockAppStateCallback?.('active');
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('signed-out')).toBeTruthy());
    await view.unmount();

    mockGetWebSession.mockImplementationOnce(async () => {
      throw authError('session_revoked');
    });
    mockInitializeStore.mockImplementationOnce(async () => {
      throw new Error('controlled restore forget failure');
    });
    const revoked = await renderProvider();
    await waitFor(() => expect(screen.getByText('signed-out:errors.session')).toBeTruthy());
    await revoked.unmount();
  });
});
