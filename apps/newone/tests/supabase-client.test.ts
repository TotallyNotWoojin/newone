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
}) {
  jest.resetModules();
  const clients: Record<string, unknown>[] = [];
  const createClient = jest.fn((url: string, key: string, options: Record<string, unknown>) => {
    const instance = { instance: clients.length + 1, url, key, options };
    clients.push(instance);
    return instance;
  });
  const authStorage = { name: 'controlled-secure-storage' };

  jest.doMock('react-native-url-polyfill/auto', () => ({}));
  jest.doMock('react-native', () => ({ Platform: { OS: input.platform } }));
  jest.doMock('@supabase/supabase-js', () => ({ createClient }));
  jest.doMock('@/config/runtime', () => ({
    isNativeSupabaseConfigured: input.nativeConfigured,
    isApiConfigured: input.apiConfigured,
    isSupabaseConfigured: Boolean(input.supabase),
    publicRuntimeConfig: { supabase: input.supabase },
  }));
  jest.doMock('@/lib/secure-storage', () => ({ authStorage }));

  const supabase = jest.requireActual<typeof import('@/lib/supabase')>('@/lib/supabase');
  return { authStorage, clients, createClient, supabase };
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
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
        global: { headers: { 'x-client-info': 'newone-expo/web-realtime-only' } },
      },
    );
  });
});
