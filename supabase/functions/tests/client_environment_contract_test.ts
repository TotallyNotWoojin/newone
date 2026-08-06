import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { loadClientEnvironment } from '../_shared/clients.ts';

function environment(values: Record<string, string | undefined>) {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}

Deno.test('client environment prefers singular modern keys over managed sets and legacy keys', () => {
  assertEquals(loadClientEnvironment(environment({
    SUPABASE_URL: ' https://project.supabase.co ',
    SUPABASE_PUBLISHABLE_KEY: ' modern-publishable ',
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'set-publishable' }),
    SUPABASE_ANON_KEY: 'legacy-anon',
    SUPABASE_SECRET_KEY: ' modern-secret ',
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'set-secret' }),
    SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role',
  })), {
    url: 'https://project.supabase.co',
    publishableKey: 'modern-publishable',
    secretKey: 'modern-secret',
  });
});

Deno.test('client environment prefers hosted managed key sets over legacy JWT keys', () => {
  assertEquals(loadClientEnvironment(environment({
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: ' set-publishable ' }),
    SUPABASE_ANON_KEY: 'legacy-anon',
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: ' set-secret ' }),
    SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role',
  })), {
    url: 'https://project.supabase.co',
    publishableKey: 'set-publishable',
    secretKey: 'set-secret',
  });
});

Deno.test('client environment retains legacy keys only as the final compatibility fallback', () => {
  assertEquals(loadClientEnvironment(environment({
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_ANON_KEY: 'legacy-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role',
  })), {
    url: 'https://project.supabase.co',
    publishableKey: 'legacy-anon',
    secretKey: 'legacy-service-role',
  });
});

Deno.test('managed key sets fail closed when their JSON contract is malformed', () => {
  assertThrows(
    () => loadClientEnvironment(environment({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEYS: 'not-json',
      SUPABASE_ANON_KEY: 'legacy-anon',
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'set-secret' }),
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role',
    })),
    Error,
    'SUPABASE_PUBLISHABLE_KEYS must be a JSON object with a default key',
  );
});

Deno.test('client environment rejects missing or empty required values', () => {
  assertThrows(
    () => loadClientEnvironment(environment({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: '   ' }),
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'secret' }),
    })),
    Error,
    'Supabase URL, publishable key, and server secret key are required',
  );
});
