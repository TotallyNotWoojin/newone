import { afterEach, describe, expect, jest, test } from '@jest/globals';

type RuntimeModule = typeof import('@/config/runtime');

const controlledEnvKeys = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_TURNSTILE_SITE_KEY',
  'EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN',
  'EXPO_PUBLIC_SUPPORT_CONTACT_LABEL',
  'EXPO_PUBLIC_SUPPORT_CONTACT_URL',
  'EXPO_PUBLIC_EAS_PROJECT_ID',
  'EXPO_PUBLIC_PUSH_ENVIRONMENT',
  'EXPO_PUBLIC_OFFLINE_CACHE_ENABLED',
] as const;

const originalEnv = Object.fromEntries(controlledEnvKeys.map((key) => [key, process.env[key]]));

function setEnvironment(values: Partial<Record<(typeof controlledEnvKeys)[number], string>>) {
  for (const key of controlledEnvKeys) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function loadRuntime(platform: 'web' | 'ios' | 'android', values: Parameters<typeof setEnvironment>[0]) {
  jest.resetModules();
  setEnvironment(values);
  jest.doMock('react-native', () => ({ Platform: { OS: platform } }));
  return require('@/config/runtime') as RuntimeModule;
}

afterEach(() => {
  jest.dontMock('react-native');
  jest.resetModules();
  for (const key of controlledEnvKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('validated public runtime configuration', () => {
  test('builds the same-origin web runtime and exposes only public configuration', () => {
    const runtime = loadRuntime('web', {
      EXPO_PUBLIC_SUPABASE_URL: 'https://coverage-project.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_controlled_key_123456789',
      EXPO_PUBLIC_API_URL: '/api/',
      EXPO_PUBLIC_TURNSTILE_SITE_KEY: 'controlled-turnstile-site-key',
      EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN: 'https://challenge.newone.test/',
      EXPO_PUBLIC_SUPPORT_CONTACT_LABEL: 'Security desk',
      EXPO_PUBLIC_SUPPORT_CONTACT_URL: 'mailto:security@newone.test',
      EXPO_PUBLIC_EAS_PROJECT_ID: '10000000-0000-4000-8000-000000000001',
      EXPO_PUBLIC_PUSH_ENVIRONMENT: 'production',
      EXPO_PUBLIC_OFFLINE_CACHE_ENABLED: 'true',
    });

    expect(runtime.isSupabaseConfigured).toBe(true);
    expect(runtime.isApiConfigured).toBe(true);
    expect(runtime.isNativeSupabaseConfigured).toBe(false);
    expect(runtime.runtimeMode).toBe('web');
    expect(runtime.publicRuntimeConfig).toEqual({
      apiUrl: '/api',
      supabase: {
        url: 'https://coverage-project.supabase.co',
        publishableKey: 'sb_publishable_controlled_key_123456789',
      },
      turnstileSiteKey: 'controlled-turnstile-site-key',
      turnstileChallengeOrigin: 'https://challenge.newone.test',
      supportContact: { label: 'Security desk', url: 'mailto:security@newone.test' },
      easProjectId: '10000000-0000-4000-8000-000000000001',
      pushEnvironment: 'production',
      offlineCacheEnabled: true,
    });
    expect(runtime.apiUrlFor('/v2/auth/session')).toBe('/api/v2/auth/session');
    expect(runtime.nativeEdgeRequestHeaders('controlled-access-token')).toEqual({});
  });

  test('builds a direct native Edge runtime with separated API-key and bearer headers', () => {
    const runtime = loadRuntime('ios', {
      EXPO_PUBLIC_SUPABASE_URL: 'https://coverage-project.supabase.co/',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_controlled_key_123456789',
      EXPO_PUBLIC_API_URL: 'https://coverage-project.supabase.co/functions/v1/',
      EXPO_PUBLIC_SUPPORT_CONTACT_LABEL: 'Call security',
      EXPO_PUBLIC_SUPPORT_CONTACT_URL: 'tel:+1 (303) 555-0100',
      EXPO_PUBLIC_PUSH_ENVIRONMENT: 'preview',
    });

    expect(runtime.runtimeMode).toBe('native');
    expect(runtime.isNativeSupabaseConfigured).toBe(true);
    expect(runtime.publicRuntimeConfig.supportContact).toEqual({
      label: 'Call security',
      url: 'tel:+1 (303) 555-0100',
    });
    expect(runtime.apiUrlFor('/v2/bootstrap')).toBe(
      'https://coverage-project.supabase.co/functions/v1/newone-read/v2/bootstrap',
    );
    expect(runtime.nativeEdgeRequestHeaders('controlled-access-token')).toEqual({
      apikey: 'sb_publishable_controlled_key_123456789',
      Authorization: 'Bearer controlled-access-token',
    });
    expect(runtime.nativeEdgeRequestHeaders()).toEqual({
      apikey: 'sb_publishable_controlled_key_123456789',
    });
  });

  test('fails closed on absent and secret credentials', () => {
    const absent = loadRuntime('web', {});
    expect(absent.runtimeMode).toBe('web_locked');
    expect(absent.isSupabaseConfigured).toBe(false);
    expect(absent.isApiConfigured).toBe(false);
    expect(absent.publicRuntimeConfig).toEqual({
      apiUrl: null,
      supabase: null,
      turnstileSiteKey: null,
      turnstileChallengeOrigin: null,
      supportContact: null,
      easProjectId: null,
      pushEnvironment: null,
      offlineCacheEnabled: false,
    });
    expect(absent.apiUrlFor('/v2/bootstrap')).toBeNull();

    const secret = loadRuntime('android', {
      EXPO_PUBLIC_SUPABASE_URL: 'https://coverage-project.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ['sb', 'secret', 'controlled-test-value'].join('_'),
      EXPO_PUBLIC_API_URL: '/api',
    });
    expect(secret.runtimeMode).toBe('unconfigured');
    expect(secret.isNativeSupabaseConfigured).toBe(false);
    expect(secret.nativeEdgeRequestHeaders('token')).toBeNull();
  });

  test.each([
    ['protocol-relative API URL', { EXPO_PUBLIC_API_URL: '//attacker.test' }],
    ['backslash API URL', { EXPO_PUBLIC_API_URL: '/api\\redirect' }],
    ['cleartext API URL', { EXPO_PUBLIC_API_URL: 'http://coverage-project.supabase.co/functions/v1' }],
    ['unparseable API URL', { EXPO_PUBLIC_API_URL: 'not a URL' }],
    ['root-only API path', { EXPO_PUBLIC_API_URL: '/' }],
    ['foreign native API origin', {
      EXPO_PUBLIC_SUPABASE_URL: 'https://coverage-project.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_controlled_key_123456789',
      EXPO_PUBLIC_API_URL: 'https://other-project.supabase.co/functions/v1',
    }],
  ])('rejects %s', (_label, overrides) => {
    const runtime = loadRuntime('android', overrides);
    expect(runtime.isApiConfigured).toBe(false);
    expect(runtime.runtimeMode).toBe('unconfigured');
  });

  test.each([
    ['challenge credentials', {
      EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN: 'https://user:pass@challenge.newone.test/',
    }],
    ['challenge subpath', {
      EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN: 'https://challenge.newone.test/widget',
    }],
    ['support label newline', {
      EXPO_PUBLIC_SUPPORT_CONTACT_LABEL: 'Security\nDesk',
      EXPO_PUBLIC_SUPPORT_CONTACT_URL: 'https://support.newone.test/help',
    }],
    ['support URL credentials', {
      EXPO_PUBLIC_SUPPORT_CONTACT_LABEL: 'Security desk',
      EXPO_PUBLIC_SUPPORT_CONTACT_URL: 'https://user:pass@support.newone.test/',
    }],
    ['malformed support URL', {
      EXPO_PUBLIC_SUPPORT_CONTACT_LABEL: 'Security desk',
      EXPO_PUBLIC_SUPPORT_CONTACT_URL: 'not a support URL',
    }],
  ])('drops invalid optional public configuration: %s', (_label, overrides) => {
    const runtime = loadRuntime('web', { EXPO_PUBLIC_API_URL: '/api', ...overrides });
    if ('EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN' in overrides) {
      expect(runtime.publicRuntimeConfig.turnstileChallengeOrigin).toBeNull();
    } else if (overrides.EXPO_PUBLIC_SUPPORT_CONTACT_LABEL?.includes('\n')) {
      expect(runtime.publicRuntimeConfig.supportContact).toBeNull();
    } else {
      expect(runtime.publicRuntimeConfig.supportContact).toEqual({ label: 'Security desk', url: null });
    }
  });

  test('accepts an HTTPS support URL without credentials', () => {
    const runtime = loadRuntime('web', {
      EXPO_PUBLIC_API_URL: '/api',
      EXPO_PUBLIC_SUPPORT_CONTACT_LABEL: 'Help center',
      EXPO_PUBLIC_SUPPORT_CONTACT_URL: 'https://support.newone.test/help',
    });
    expect(runtime.publicRuntimeConfig.supportContact).toEqual({
      label: 'Help center',
      url: 'https://support.newone.test/help',
    });
  });
});
