import { describe, expect, jest, test } from '@jest/globals';

type ControlledSupabaseConfig = {
  url: string;
  publishableKey: string;
} | null;

function loadSupabase(input: {
  platform: 'ios' | 'android' | 'web';
  nativeConfigured: boolean;
  apiConfigured: boolean;
  supabase: ControlledSupabaseConfig;
  /** Defaults to the native rule: configured native platforms hold the session directly. */
  directConfigured?: boolean;
}) {
  jest.resetModules();
  const clients: Record<string, unknown>[] = [];
  const createClient = jest.fn((url: string, key: string, options: Record<string, unknown>) => {
    const instance = { instance: clients.length + 1, url, key, options };
    clients.push(instance);
    return instance;
  });
  const authStorage = { name: 'controlled-secure-storage' };
  const networkListeners: (() => void)[] = [];

  jest.doMock('react-native-url-polyfill/auto', () => ({}));
  jest.doMock('react-native', () => ({ Platform: { OS: input.platform } }));
  jest.doMock('@supabase/supabase-js', () => ({ createClient }));
  jest.doMock('@/config/runtime', () => ({
    isNativeSupabaseConfigured: input.nativeConfigured,
    isDirectEdgeConfigured: input.directConfigured ?? (input.nativeConfigured && input.platform !== 'web'),
    isApiConfigured: input.apiConfigured,
    isSupabaseConfigured: Boolean(input.supabase),
    publicRuntimeConfig: { supabase: input.supabase },
  }));
  jest.doMock('@/lib/secure-storage', () => ({ authStorage }));
  jest.doMock('@/lib/network-return', () => ({
    onNetworkReturn: (listener: () => void) => {
      networkListeners.push(listener);
      return () => undefined;
    },
  }));

  const supabase = jest.requireActual<typeof import('@/lib/supabase')>('@/lib/supabase');
  return { authStorage, clients, createClient, networkListeners, supabase };
}

const configured = {
  url: 'https://controlled-project.supabase.co',
  publishableKey: 'sb_publishable_controlled_public_value',
};

describe('Supabase client boundaries', () => {
  test('fails closed when native configuration, public project data, or platform requirements are absent', () => {
    const unconfigured = loadSupabase({
      platform: 'ios',
      nativeConfigured: false,
      apiConfigured: false,
      supabase: null,
    });
    expect(unconfigured.supabase.getSupabaseClient()).toBeNull();
    expect(unconfigured.createClient).not.toHaveBeenCalled();
    expect(unconfigured.supabase.isSupabaseConfigured).toBe(false);
    expect(unconfigured.supabase.isNativeSupabaseConfigured).toBe(false);
    expect(unconfigured.supabase.isWebAuthBlocked).toBe(false);

    const missingProject = loadSupabase({
      platform: 'android',
      nativeConfigured: true,
      apiConfigured: true,
      supabase: null,
    });
    expect(missingProject.supabase.getSupabaseClient()).toBeNull();
    expect(missingProject.createClient).not.toHaveBeenCalled();

    const webCannotUseNativeSession = loadSupabase({
      platform: 'web',
      nativeConfigured: true,
      apiConfigured: true,
      supabase: configured,
    });
    expect(webCannotUseNativeSession.supabase.getSupabaseClient()).toBeNull();
    expect(webCannotUseNativeSession.createClient).not.toHaveBeenCalled();
    expect(webCannotUseNativeSession.supabase.isWebAuthBlocked).toBe(false);

    const blockedWeb = loadSupabase({
      platform: 'web',
      nativeConfigured: false,
      apiConfigured: false,
      supabase: configured,
    });
    expect(blockedWeb.supabase.isWebAuthBlocked).toBe(true);
  });

  test.each(['ios', 'android'] as const)(
    'creates one secure PKCE native client and reuses it for realtime on %s',
    (platform) => {
      const { authStorage, createClient, supabase } = loadSupabase({
        platform,
        nativeConfigured: true,
        apiConfigured: true,
        supabase: configured,
      });

      const first = supabase.getSupabaseClient();
      expect(first).not.toBeNull();
      expect(supabase.getSupabaseClient()).toBe(first);
      expect(supabase.getRealtimeClient()).toBe(first);
      expect(createClient).toHaveBeenCalledTimes(1);
      expect(createClient).toHaveBeenCalledWith(
        configured.url,
        configured.publishableKey,
        {
          auth: {
            storage: authStorage,
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false,
            flowType: 'pkce',
          },
          global: {
            headers: { 'x-client-info': `newone-expo/${platform}` },
          },
        },
      );
    },
  );

  test('a direct (bearer) web build gets a persisted PKCE client and keeps the sessionless realtime socket', () => {
    const { authStorage, createClient, supabase } = loadSupabase({
      platform: 'web',
      nativeConfigured: false,
      directConfigured: true,
      apiConfigured: true,
      supabase: configured,
    });

    const client = supabase.getSupabaseClient();
    expect(client).not.toBeNull();
    expect(supabase.getSupabaseClient()).toBe(client);
    expect(createClient).toHaveBeenNthCalledWith(
      1,
      configured.url,
      configured.publishableKey,
      {
        auth: {
          storage: authStorage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
          flowType: 'pkce',
        },
        global: { headers: { 'x-client-info': 'newone-expo/web' } },
      },
    );
    // Realtime on web still uses the token-only socket client fed by the auth state.
    const realtime = supabase.getRealtimeClient();
    expect(realtime).not.toBe(client);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(supabase.isDirectEdgeConfigured).toBe(true);
    expect(supabase.isWebAuthBlocked).toBe(false);
  });

  test('fails closed when web realtime has no public project configuration', () => {
    const { createClient, supabase } = loadSupabase({
      platform: 'web',
      nativeConfigured: false,
      apiConfigured: true,
      supabase: null,
    });

    expect(supabase.getRealtimeClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  test('creates a sessionless web realtime client once and never enables browser token persistence', () => {
    const { createClient, supabase } = loadSupabase({
      platform: 'web',
      nativeConfigured: false,
      apiConfigured: true,
      supabase: configured,
    });

    const first = supabase.getRealtimeClient();
    expect(first).not.toBeNull();
    expect(supabase.getRealtimeClient()).toBe(first);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(
      configured.url,
      configured.publishableKey,
      {
        accessToken: expect.any(Function),
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
        global: { headers: { 'x-client-info': 'newone-expo/web-realtime-only' } },
      },
    );
  });

  test('the web realtime socket asks for the session token whenever it re-authenticates by itself', async () => {
    // realtime-js calls the client's token callback after every join and on
    // every reconnect, ignoring the token set by hand. supabase-js's default
    // callback answered with the publishable key for this session-less client,
    // so channels rejoined as anonymous and were refused (Sep 14 2026).
    const { createClient, supabase } = loadSupabase({
      platform: 'web',
      nativeConfigured: false,
      apiConfigured: true,
      supabase: configured,
    });
    supabase.getRealtimeClient();
    const options = createClient.mock.calls[0][2] as { accessToken: () => Promise<string | null> };
    await expect(options.accessToken()).resolves.toBeNull();
    supabase.setRealtimeAccessToken('session-token-1');
    await expect(options.accessToken()).resolves.toBe('session-token-1');
    supabase.setRealtimeAccessToken(null);
    await expect(options.accessToken()).resolves.toBeNull();
  });

  test('the web realtime socket reconnects the moment the network returns, not on its backoff', () => {
    // Phoenix waited 1 s, 2 s, 5 s, then 10 s between tries and never
    // listened for the network, so typing sent while it waited was lost
    // (Sep 23 2026).
    const { clients, networkListeners, supabase } = loadSupabase({
      platform: 'web',
      nativeConfigured: false,
      apiConfigured: true,
      supabase: configured,
    });
    supabase.getRealtimeClient();
    supabase.getRealtimeClient();
    expect(networkListeners).toHaveLength(1);

    const socket = fakeSocket({ connected: false, channels: 2 });
    clients[0].realtime = socket;
    networkListeners[0]();
    expect(socket.reconnectTimer.reset).toHaveBeenCalledTimes(1);
    expect(socket.reconnectTimer.callback).toHaveBeenCalledTimes(1);
  });

  test('a reconnect is only forced for a dropped socket that still has channels to carry', () => {
    const { supabase } = loadSupabase({
      platform: 'web',
      nativeConfigured: false,
      apiConfigured: true,
      supabase: configured,
    });
    const reconnect = (socket: ReturnType<typeof fakeSocket> | undefined) => (
      supabase.reconnectRealtimeNow(socket as unknown as Parameters<typeof supabase.reconnectRealtimeNow>[0])
    );
    const connected = fakeSocket({ connected: true, channels: 2 });
    const connecting = fakeSocket({ connecting: true, channels: 2 });
    const closedOnPurpose = fakeSocket({ channels: 0 });
    const dropped = fakeSocket({ channels: 1 });

    expect(reconnect(undefined)).toBe(false);
    expect(reconnect(connected)).toBe(false);
    expect(reconnect(connecting)).toBe(false);
    expect(reconnect(closedOnPurpose)).toBe(false);
    for (const socket of [connected, connecting, closedOnPurpose]) {
      expect(socket.reconnectTimer.callback).not.toHaveBeenCalled();
    }
    expect(reconnect(dropped)).toBe(true);
    expect(dropped.reconnectTimer.reset).toHaveBeenCalledTimes(1);
    expect(dropped.reconnectTimer.callback).toHaveBeenCalledTimes(1);
  });
});

function fakeSocket(input: { connected?: boolean; connecting?: boolean; channels: number }) {
  return {
    isConnected: () => input.connected ?? false,
    isConnecting: () => input.connecting ?? false,
    getChannels: () => Array.from({ length: input.channels }, (_, index) => ({ topic: `topic-${index}` })),
    reconnectTimer: { reset: jest.fn(), callback: jest.fn() },
  };
}
