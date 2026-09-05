import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';
import { Platform, Text } from 'react-native';

import { AuthProvider, useAuth } from '@/state/auth';

const mockGetSession = jest.fn();
const mockOnAuthStateChange = jest.fn();
const mockSignOut = jest.fn();
const mockStartAutoRefresh = jest.fn();
const mockStopAutoRefresh = jest.fn();
const mockUnsubscribe = jest.fn();
const mockValidateNativeMembership = jest.fn();
const mockGetWebSession = jest.fn();
const mockGetWebRealtimeToken = jest.fn();
const mockPurgeUser = jest.fn();
const mockRemoveAllChannels = jest.fn();
// Stable reference: a fresh `t` per render would re-run the provider's session effect.
const mockTranslate = (mockKey: string) => mockKey;

const mockSupabase = {
  auth: {
    getSession: mockGetSession,
    onAuthStateChange: mockOnAuthStateChange,
    setSession: jest.fn(),
    signOut: mockSignOut,
    refreshSession: jest.fn(),
    startAutoRefresh: mockStartAutoRefresh,
    stopAutoRefresh: mockStopAutoRefresh,
  },
};

// A web build that opted into direct bearer auth: runtimeMode stays 'web',
// but the session is carried by the Supabase client exactly as on native.
jest.mock('@/config/runtime', () => ({
  publicRuntimeConfig: { offlineCacheEnabled: false },
  runtimeMode: 'web',
  edgeSessionTransport: 'bearer',
}));

jest.mock('@/data/persistence/client-store', () => ({
  clientStore: {
    getCache: jest.fn(async () => null),
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
    deleteWebAccount: jest.fn(),
    getWebRealtimeToken: (...mockArgs: unknown[]) => mockGetWebRealtimeToken(...mockArgs),
    getWebSession: (...mockArgs: unknown[]) => mockGetWebSession(...mockArgs),
    refreshWebSession: jest.fn(),
    requestNativeOtp: jest.fn(),
    requestNativeRecoveryOtp: jest.fn(),
    requestNativeSignup: jest.fn(),
    requestWebOtp: jest.fn(),
    requestWebRecoveryOtp: jest.fn(),
    requestWebSignup: jest.fn(),
    signOutWebSession: jest.fn(),
    validateNativeMembership: (mockInput: unknown) => mockValidateNativeMembership(mockInput),
    verifyNativeOtp: jest.fn(),
    verifyNativeRecoveryOtp: jest.fn(),
    verifyNativeSignup: jest.fn(),
    verifyWebOtp: jest.fn(),
    verifyWebRecoveryOtp: jest.fn(),
    verifyWebSignup: jest.fn(),
    WebAuthError: ControlledWebAuthError,
  };
});

const userId = '10000000-0000-4000-8000-000000000001';

function encodedToken(claims: unknown) {
  const payload = btoa(JSON.stringify(claims))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${payload}.signature`;
}

const accessToken = encodedToken({ session_id: 'session-direct-web', aal: 'aal1' });

function directSession() {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-token',
    user: { id: userId, email: 'member@example.test' },
  };
}

let observedAuth: ReturnType<typeof useAuth> | null = null;

function Probe() {
  const auth = useAuth();
  useEffect(() => {
    observedAuth = auth;
  }, [auth]);
  return (
    <Text testID="probe">
      {JSON.stringify({
        authenticated: auth.authenticated,
        loading: auth.loading,
        mode: auth.mode,
        userId: auth.user?.id ?? null,
        realtimeToken: auth.realtimeToken,
        sessionId: auth.sessionId,
        aal: auth.assuranceLevel,
      })}
    </Text>
  );
}

function probeState() {
  return JSON.parse(screen.getByTestId('probe').props.children as string) as {
    authenticated: boolean;
    loading: boolean;
    mode: string;
    userId: string | null;
    realtimeToken: string | null;
    sessionId: string | null;
    aal: string | null;
  };
}

let platformRestore: { restore: () => void } | null = null;

beforeEach(() => {
  observedAuth = null;
  platformRestore = jest.replaceProperty(Platform, 'OS', 'web');
  mockGetSession.mockImplementation(async () => ({ data: { session: directSession() }, error: null }));
  mockOnAuthStateChange.mockImplementation(() => ({
    data: { subscription: { unsubscribe: mockUnsubscribe } },
  }));
  mockValidateNativeMembership.mockImplementation(async () => ({ organizationId: 'org-personal' }));
  mockSignOut.mockImplementation(async () => ({ error: null }));
  mockPurgeUser.mockImplementation(async () => undefined);
  mockRemoveAllChannels.mockImplementation(async () => undefined);
});

afterEach(() => {
  platformRestore?.restore();
});

describe('AuthProvider on web with direct bearer transport', () => {
  test('restores the Supabase session, validates membership over bearer auth, and never touches the cookie gateway', async () => {
    await render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(probeState().loading).toBe(false));
    expect(probeState()).toEqual({
      authenticated: true,
      loading: false,
      mode: 'web',
      userId,
      // Realtime reuses the access token directly, as native does.
      realtimeToken: accessToken,
      sessionId: 'session-direct-web',
      aal: 'aal1',
    });
    expect(mockValidateNativeMembership).toHaveBeenCalledWith({ accessToken, userId });
    expect(mockGetWebSession).not.toHaveBeenCalled();
    expect(mockGetWebRealtimeToken).not.toHaveBeenCalled();
  });

  test('signs out locally through the Supabase client and purges the member cache', async () => {
    await render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(probeState().authenticated).toBe(true));

    await act(async () => {
      await observedAuth?.signOut();
    });

    expect(mockRemoveAllChannels).toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    expect(probeState().authenticated).toBe(false);
    expect(probeState().realtimeToken).toBeNull();
  });
});
