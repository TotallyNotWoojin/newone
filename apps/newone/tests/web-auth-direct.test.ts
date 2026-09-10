import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Platform } from 'react-native';

import { requestNativeOtp, verifyNativeOtp } from '@/lib/web-auth';

let mockTransport: 'cookie' | 'bearer' = 'bearer';

jest.mock('@/config/runtime', () => ({
  apiUrlFor: (mockPath: string) => `https://project.supabase.co/functions/v1/newone-auth${mockPath}`,
  get edgeSessionTransport() {
    return mockTransport;
  },
  isApiConfigured: true,
  nativeEdgeRequestHeaders: (mockAccessToken?: string) => ({
    apikey: 'sb_publishable_controlled_test_key',
    ...(mockAccessToken ? { Authorization: `Bearer ${mockAccessToken}` } : {}),
  }),
  publicRuntimeConfig: {
    apiUrl: 'https://project.supabase.co/functions/v1',
    supabase: { url: 'https://project.supabase.co', publishableKey: 'sb_publishable_controlled_test_key' },
  },
}));

jest.mock('@/lib/installation-id', () => ({
  getInstallationId: async () => '40000000-0000-4000-8000-000000000004',
}));

const originalFetch = globalThis.fetch;
const controlledFetch = jest.fn();
let platformRestore: { restore: () => void } | null = null;

function queueJson(payload: unknown, status = 200) {
  controlledFetch.mockImplementationOnce(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

beforeEach(() => {
  mockTransport = 'bearer';
  controlledFetch.mockReset();
  globalThis.fetch = controlledFetch as unknown as typeof fetch;
  platformRestore = jest.replaceProperty(Platform, 'OS', 'web');
});

afterEach(() => {
  platformRestore?.restore();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('direct (bearer) web sign-in', () => {
  test('uses the token-returning routes and identifies itself honestly as web', async () => {
    queueJson({ data: { accepted: true, channel: { type: 'email', configured: true } } });

    await expect(requestNativeOtp({
      destinationType: 'email',
      destination: 'member@example.test',
    })).resolves.toEqual({ accepted: true, channel: { type: 'email', configured: true } });

    const [url, init] = controlledFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://project.supabase.co/functions/v1/newone-auth/v2/auth/native/otp/request');
    expect(init.credentials).toBeUndefined();
    expect(init.headers).toMatchObject({
      apikey: 'sb_publishable_controlled_test_key',
      'X-Newone-Client-Platform': 'web',
      'X-Newone-Installation-Id': '40000000-0000-4000-8000-000000000004',
    });
    expect(init.headers).not.toHaveProperty('X-CSRF-Token');
    expect(JSON.parse(String(init.body)).installationId).toBe('40000000-0000-4000-8000-000000000004');
  });

  test('accepts the session envelope so the Supabase client can adopt the tokens', async () => {
    queueJson({
      data: {
        authenticated: true,
        user: { id: 'user-web' },
        memberships: [],
        sessionId: 'session-web',
        aal: 'aal1',
        session: { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 },
      },
    });
    const verified = await verifyNativeOtp({
      destinationType: 'email',
      destination: 'member@example.test',
      code: '123456',
    });
    expect(verified.session).toEqual({ accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 });
    expect(verified.user.id).toBe('user-web');
  });

  test('stays unavailable on web while the cookie gateway is the configured transport', async () => {
    mockTransport = 'cookie';
    await expect(requestNativeOtp({
      destinationType: 'email',
      destination: 'member@example.test',
    })).rejects.toMatchObject({ code: 'gateway_unconfigured' });
    expect(controlledFetch).not.toHaveBeenCalled();
  });
});
