import { ApiError } from '../_shared/errors.ts';
import {
  accessCredential,
  buildRequestMeta,
  ensureSecureTransport,
  loadRuntimeConfig,
  parseJson,
  type RuntimeConfig,
  verifyCsrf,
} from '../_shared/http.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const config: RuntimeConfig = {
  allowedOrigins: new Set(['https://app.newone.example']),
  accessCookieName: 'newone_access',
  refreshCookieName: 'newone_refresh',
  csrfCookieName: 'newone_csrf',
  maxJsonBytes: 64,
  networkHashKey: 'x'.repeat(32),
  allowHttpLocal: false,
};

Deno.test('CORS uses an exact credentialed allowlist and never a wildcard', () => {
  const request = new Request('https://api.newone.example/v2/test', {
    headers: { Origin: 'https://app.newone.example' },
  });
  const meta = buildRequestMeta(request, config);
  assertEquals(meta.corsHeaders.get('access-control-allow-origin'), 'https://app.newone.example');
  assertEquals(meta.corsHeaders.get('access-control-allow-credentials'), 'true');
  assertEquals(
    meta.corsHeaders.get('access-control-allow-methods'),
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  );
  assert(meta.corsHeaders.get('access-control-allow-origin') !== '*');
});

Deno.test('CORS rejects an unlisted browser origin', async () => {
  await assertRejects(
    () =>
      buildRequestMeta(
        new Request('https://api.newone.example/v2/test', {
          headers: { Origin: 'https://attacker.example' },
        }),
        config,
      ),
    (error) => error instanceof ApiError && error.code === 'origin_not_allowed',
  );
});

Deno.test('cookie authentication requires a matching double-submit CSRF token', async () => {
  const missing = new Request('https://api.newone.example/v2/test', {
    method: 'POST',
    headers: { Cookie: 'newone_access=jwt; newone_csrf=expected' },
  });
  const credential = accessCredential(missing, config);
  assert(credential.viaCookie);
  await assertRejects(
    () => verifyCsrf(missing, config, credential.viaCookie),
    (error) => error instanceof ApiError && error.code === 'csrf_failed',
  );

  const valid = new Request('https://api.newone.example/v2/test', {
    method: 'POST',
    headers: {
      Cookie: 'newone_access=jwt; newone_csrf=expected',
      'X-CSRF-Token': 'expected',
    },
  });
  verifyCsrf(valid, config, accessCredential(valid, config).viaCookie);
});

Deno.test('JSON parsing enforces declared and actual request limits', async () => {
  const valid = await parseJson(
    new Request('https://api.newone.example/v2/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'ok' }),
    }),
    config,
  );
  assertEquals(valid.value, { value: 'ok' });
  assert(/^[0-9a-f]{64}$/.test(valid.digest));

  await assertRejects(
    () =>
      parseJson(
        new Request('https://api.newone.example/v2/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 'x'.repeat(100) }),
        }),
        config,
      ),
    (error) => error instanceof ApiError && error.code === 'payload_too_large',
  );
});

Deno.test('JSON parsing accepts parameters but rejects JSONP lookalike media types', async () => {
  const parsed = await parseJson(
    new Request('https://api.newone.example/v2/test', {
      method: 'POST',
      headers: { 'Content-Type': 'Application/JSON; Charset=UTF-8' },
      body: JSON.stringify({ valid: true }),
    }),
    config,
  );
  assertEquals(parsed.value, { valid: true });

  await assertRejects(
    () =>
      parseJson(
        new Request('https://api.newone.example/v2/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/jsonp' },
          body: JSON.stringify({ valid: false }),
        }),
        config,
      ),
    (error) => error instanceof ApiError && error.code === 'unsupported_media_type',
  );
});

function testEnvironment(values: Record<string, string>): Pick<typeof Deno.env, 'get'> {
  return { get: (name: string) => values[name] };
}

Deno.test('runtime config validates and canonicalizes its security boundaries', async () => {
  const loaded = loadRuntimeConfig(testEnvironment({
    NEWONE_ALLOWED_WEB_ORIGINS: 'https://APP.Newone.Example:443,http://localhost:8081',
    NEWONE_ALLOW_HTTP_LOCAL: 'true',
    NEWONE_NETWORK_HASH_KEY: 'n'.repeat(32),
    NEWONE_CURSOR_SIGNING_KEY: 'c'.repeat(32),
    NEWONE_MAX_JSON_BYTES: '65536',
  }));
  assertEquals(
    [...loaded.allowedOrigins],
    ['https://app.newone.example', 'http://localhost:8081'],
  );
  assertEquals(loaded.accessCookieName, '__Host-newone_access');
  assertEquals(loaded.cursorSigningKey, 'c'.repeat(32));

  const localCookieNames = loadRuntimeConfig(testEnvironment({
    NEWONE_ALLOW_HTTP_LOCAL: 'true',
    NEWONE_NETWORK_HASH_KEY: 'n'.repeat(32),
    NEWONE_ACCESS_COOKIE_NAME: 'newone_access',
    NEWONE_REFRESH_COOKIE_NAME: 'newone_refresh',
    NEWONE_CSRF_COOKIE_NAME: 'newone_csrf',
  }));
  assertEquals(localCookieNames.accessCookieName, 'newone_access');

  const invalidConfigurations: Array<Record<string, string>> = [
    { NEWONE_MAX_JSON_BYTES: 'NaN' },
    { NEWONE_MAX_JSON_BYTES: '1000000000' },
    { NEWONE_ACCESS_COOKIE_NAME: 'bad cookie' },
    { NEWONE_ACCESS_COOKIE_NAME: 'newone_access' },
    { NEWONE_REFRESH_COOKIE_NAME: 'newone_refresh' },
    { NEWONE_CSRF_COOKIE_NAME: 'newone_csrf' },
    { NEWONE_ACCESS_COOKIE_NAME: 'same', NEWONE_REFRESH_COOKIE_NAME: 'same' },
    { NEWONE_ALLOWED_WEB_ORIGINS: 'http://not-local.example' },
    { NEWONE_ALLOWED_WEB_ORIGINS: 'https://app.example/path' },
    { NEWONE_ALLOW_HTTP_LOCAL: 'yes' },
    { NEWONE_CURSOR_SIGNING_KEY: 'too-short' },
  ];
  for (const values of invalidConfigurations) {
    await assertRejects(
      () =>
        loadRuntimeConfig(testEnvironment({
          NEWONE_NETWORK_HASH_KEY: 'n'.repeat(32),
          ...values,
        })),
      (error) => error instanceof Error,
    );
  }
});

Deno.test('transport accepts native HTTPS and an exact hosted Supabase TLS boundary', async () => {
  ensureSecureTransport(
    new Request('https://api.newone.example/v2/test'),
    config,
    testEnvironment({}),
  );
  ensureSecureTransport(
    new Request('http://project-ref.supabase.co/functions/v1/newone-api/v2/test', {
      headers: { 'X-Forwarded-Proto': 'https' },
    }),
    config,
    testEnvironment({ SUPABASE_URL: 'https://project-ref.supabase.co' }),
  );

  const rejected: Array<{
    url: string;
    headers: Record<string, string>;
    environment: Record<string, string>;
  }> = [
    {
      url: 'http://project-ref.supabase.co/functions/v1/newone-api/v2/test',
      headers: { 'X-Forwarded-Proto': 'https' },
      environment: {},
    },
    {
      url: 'http://attacker.example/functions/v1/newone-api/v2/test',
      headers: { 'X-Forwarded-Proto': 'https' },
      environment: { SUPABASE_URL: 'https://project-ref.supabase.co' },
    },
    {
      url: 'http://project-ref.supabase.co/functions/v1/newone-api/v2/test',
      headers: { 'X-Forwarded-Proto': 'http' },
      environment: { SUPABASE_URL: 'https://project-ref.supabase.co' },
    },
    {
      url: 'http://project-ref.supabase.co/functions/v1/newone-api/v2/test',
      headers: { 'X-Forwarded-Proto': 'https, http' },
      environment: { SUPABASE_URL: 'https://project-ref.supabase.co' },
    },
    {
      url: 'http://project-ref.supabase.co/functions/v1/newone-api/v2/test',
      headers: { 'X-Forwarded-Proto': 'https' },
      environment: { SUPABASE_URL: 'https://project-ref.supabase.co/untrusted-path' },
    },
  ];
  for (const candidate of rejected) {
    await assertRejects(
      () =>
        ensureSecureTransport(
          new Request(candidate.url, { headers: candidate.headers }),
          config,
          testEnvironment(candidate.environment),
        ),
      (error) => error instanceof ApiError && error.code === 'bad_request',
    );
  }
});

Deno.test('request origin must already be canonical', async () => {
  await assertRejects(
    () =>
      buildRequestMeta(
        new Request('https://api.newone.example/v2/test', {
          headers: { Origin: 'https://APP.Newone.Example:443' },
        }),
        config,
      ),
    (error) => error instanceof ApiError && error.code === 'origin_not_allowed',
  );
});
