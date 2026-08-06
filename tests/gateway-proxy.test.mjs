import assert from 'node:assert/strict';
import test from 'node:test';

import {
  functionsOrigin,
  publishableKey,
  proxyNewoneRequest,
  sessionCookieHeader,
  sessionSetCookies,
  selectUpstreamFunction,
} from '../api/[...path].mjs';

const FUNCTIONS_ORIGIN = 'https://example.supabase.co/functions/v1';
const PUBLISHABLE_KEY = 'sb_publishable_test_project_key_1234567890';
const WEB_GATEWAY_SHARED_SECRET = 'test-web-gateway-shared-secret-value-0001';

process.env.NEWONE_WEB_GATEWAY_SHARED_SECRET = WEB_GATEWAY_SHARED_SECRET;

test('gateway selects auth, read, and command functions without confusing session commands', () => {
  assert.equal(selectUpstreamFunction('/v2/auth/otp/request', 'POST'), 'newone-auth');
  assert.equal(selectUpstreamFunction('/v2/auth/session', 'GET'), 'newone-auth');
  assert.equal(selectUpstreamFunction('/v2/auth/invitations/redeem', 'POST'), 'newone-auth');
  assert.equal(selectUpstreamFunction('/v2/auth/mfa/verify', 'POST'), 'newone-auth');
  assert.equal(selectUpstreamFunction('/v2/auth/recovery/otp/request', 'POST'), 'newone-auth');
  assert.equal(selectUpstreamFunction('/v2/auth/recovery/otp/verify', 'POST'), 'newone-auth');
  assert.equal(selectUpstreamFunction('/v2/auth/recovery/cases', 'POST'), 'newone-auth');
  assert.equal(selectUpstreamFunction('/v2/auth/recovery/cases/query', 'POST'), 'newone-auth');
  assert.equal(
    selectUpstreamFunction(
      '/v2/auth/recovery/cases/00000000-0000-4000-8000-000000000001/execute',
      'POST',
    ),
    'newone-auth',
  );
  assert.equal(selectUpstreamFunction('/v2/auth/sessions/list', 'POST'), 'newone-api');
  assert.equal(selectUpstreamFunction('/v2/auth/sessions/abc/revoke', 'POST'), 'newone-api');
  assert.equal(selectUpstreamFunction('/v2/bootstrap', 'GET'), 'newone-read');
  assert.equal(selectUpstreamFunction('/v2/bootstrap', 'POST'), 'newone-read');
  assert.equal(selectUpstreamFunction('/v2/search', 'POST'), 'newone-read');
  assert.equal(
    selectUpstreamFunction('/v2/preferences/organization/query', 'POST'),
    'newone-read',
  );
  assert.equal(
    selectUpstreamFunction(
      '/v2/conversations/00000000-0000-4000-8000-000000000001/messages/query',
      'POST',
    ),
    'newone-read',
  );
  assert.equal(selectUpstreamFunction('/v2/conversations/abc/messages', 'GET'), 'newone-read');
  assert.equal(selectUpstreamFunction('/v2/conversations/abc/messages', 'POST'), 'newone-api');
  assert.equal(selectUpstreamFunction('/v1/messages', 'GET'), null);
});

test('gateway accepts only a pinned HTTPS Supabase Functions origin', () => {
  assert.equal(functionsOrigin(`${FUNCTIONS_ORIGIN}/`), FUNCTIONS_ORIGIN);
  assert.throws(() => functionsOrigin('http://example.test/functions/v1'));
  assert.throws(() => functionsOrigin('https://user:pass@example.test/functions/v1'));
  assert.throws(() => functionsOrigin('https://example.test/other'));
  assert.throws(() => functionsOrigin('https://attacker.example/functions/v1'));
  assert.throws(() => functionsOrigin('https://example.supabase.co/other/functions/v1'));
});

test('gateway accepts only a public Supabase project key', () => {
  assert.equal(publishableKey(` ${PUBLISHABLE_KEY} `), PUBLISHABLE_KEY);
  assert.throws(() => publishableKey(''));
  assert.throws(() => publishableKey(['sb', 'secret', 'do', 'not', 'forward', '1234567890'].join('_')));
  assert.throws(() => publishableKey('key with spaces 12345678901234567890'));
});

test('gateway proxies query, method, cookies, CSRF, and Origin while removing hop headers', async () => {
  let captured;
  const response = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/messages?after=cursor', {
      headers: {
        Authorization: 'Bearer browser-controlled',
        apikey: 'browser-controlled',
        'CF-Connecting-IP': '203.0.113.99',
        Cookie: '__Host-newone_access=opaque',
        'X-Forwarded-For': '203.0.113.42',
        'X-Vercel-Forwarded-For': '203.0.113.97',
        Origin: 'https://app.newone.example',
        Connection: 'keep-alive',
        Forwarded: 'host=attacker.example;proto=http',
        'X-Forwarded-Host': 'attacker.example',
        'X-Newone-Worker-Token': 'attacker-controlled',
        'X-Real-IP': '203.0.113.98',
        'X-Supabase-Auth': 'attacker-controlled',
        'X-CSRF-Token': 'csrf',
      },
    }),
    {
      functionsOrigin: FUNCTIONS_ORIGIN,
      publishableKey: PUBLISHABLE_KEY,
      fetch: async (url, init) => {
        captured = { url, init };
        return Response.json({ ok: true }, { headers: { 'Cache-Control': 'public' } });
      },
    },
  );

  assert.equal(
    captured.url,
    `${FUNCTIONS_ORIGIN}/newone-read/v2/messages?after=cursor`,
  );
  assert.equal(captured.init.method, 'GET');
  assert.equal(captured.init.headers.get('cookie'), '__Host-newone_access=opaque');
  assert.equal(captured.init.headers.get('origin'), 'https://app.newone.example');
  assert.equal(captured.init.headers.get('x-csrf-token'), 'csrf');
  assert.equal(captured.init.headers.get('connection'), null);
  assert.equal(captured.init.headers.get('forwarded'), null);
  assert.equal(captured.init.headers.get('x-forwarded-host'), null);
  assert.equal(captured.init.headers.get('x-forwarded-for'), null);
  assert.equal(captured.init.headers.get('authorization'), null);
  assert.equal(captured.init.headers.get('apikey'), PUBLISHABLE_KEY);
  assert.equal(captured.init.headers.get('cf-connecting-ip'), null);
  assert.equal(captured.init.headers.get('x-newone-worker-token'), null);
  assert.equal(captured.init.headers.get('x-real-ip'), null);
  assert.equal(captured.init.headers.get('x-vercel-forwarded-for'), null);
  assert.equal(captured.init.headers.get('x-supabase-auth'), null);
  assert.equal(captured.init.headers.get('x-newone-gateway'), 'web');
  assert.equal(captured.init.headers.get('x-newone-gateway-network-peer'), '203.0.113.42');
  assert.match(captured.init.headers.get('x-newone-gateway-timestamp'), /^\d{10}$/);
  assert.match(captured.init.headers.get('x-newone-gateway-network-signature'), /^[0-9a-f]{64}$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true });
});

test('gateway preserves independent secure session cookies from the auth function', async () => {
  const response = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/auth/otp/verify', {
      method: 'POST',
      headers: {
        Origin: 'https://app.newone.example',
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
    {
      functionsOrigin: FUNCTIONS_ORIGIN,
      publishableKey: PUBLISHABLE_KEY,
      fetch: async () => {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('Set-Cookie', '__Host-newone_access=access; Path=/; Secure; HttpOnly; SameSite=Strict');
        headers.append('Set-Cookie', '__Host-newone_refresh=refresh; Path=/; Secure; HttpOnly; SameSite=Strict');
        headers.append('Set-Cookie', '__Host-newone_csrf=csrf; Path=/; Secure; SameSite=Strict');
        return new Response('{"authenticated":true}', { status: 200, headers });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.getSetCookie().length, 3);
  assert(response.headers.getSetCookie().every((value) => value.startsWith('__Host-newone_')));
});

test('gateway forwards only Newone session cookies and rejects unsafe upstream cookies', async () => {
  assert.equal(
    sessionCookieHeader(
      'analytics=private; __Host-newone_access=access.jwt; unrelated=value; __Host-newone_csrf=csrf-token',
    ),
    '__Host-newone_access=access.jwt; __Host-newone_csrf=csrf-token',
  );
  assert.equal(sessionCookieHeader('analytics=private'), null);

  const safeHeaders = new Headers();
  safeHeaders.append(
    'Set-Cookie',
    '__Host-newone_access=access; Path=/; Secure; HttpOnly; SameSite=Strict',
  );
  safeHeaders.append(
    'Set-Cookie',
    '__Host-newone_csrf=csrf; Path=/; Secure; SameSite=Strict',
  );
  assert.equal(sessionSetCookies(safeHeaders).length, 2);

  for (const unsafeCookie of [
    'other=value; Path=/; Secure; HttpOnly; SameSite=Strict',
    '__Host-newone_access=access; Path=/; Secure; SameSite=Strict',
    '__Host-newone_csrf=csrf; Path=/; Secure; HttpOnly; SameSite=Strict',
    '__Host-newone_refresh=refresh; Domain=attacker.example; Path=/; Secure; HttpOnly; SameSite=Strict',
    '__Host-newone_refresh=refresh; Path=/; Secure; HttpOnly; SameSite=None',
  ]) {
    const headers = new Headers();
    headers.append('Set-Cookie', unsafeCookie);
    assert.throws(() => sessionSetCookies(headers));
  }

  const response = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/auth/session'),
    {
      functionsOrigin: FUNCTIONS_ORIGIN,
      publishableKey: PUBLISHABLE_KEY,
      fetch: async () => new Response('{}', {
        headers: {
          'Set-Cookie': 'other=value; Path=/; Secure; HttpOnly; SameSite=Strict',
        },
      }),
    },
  );
  assert.equal(response.status, 502);
});

test('gateway rejects unknown paths, bad configuration, compressed bodies, and oversized bodies safely', async () => {
  const missing = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/internal/secrets'),
    { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY },
  );
  assert.equal(missing.status, 404);

  const unconfigured = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/bootstrap'),
    { functionsOrigin: 'http://unsafe.example/functions/v1', publishableKey: PUBLISHABLE_KEY },
  );
  assert.equal(unconfigured.status, 503);

  const missingGatewaySecret = process.env.NEWONE_WEB_GATEWAY_SHARED_SECRET;
  delete process.env.NEWONE_WEB_GATEWAY_SHARED_SECRET;
  try {
    const unsigned = await proxyNewoneRequest(
      new Request('https://app.newone.example/api/v2/bootstrap'),
      { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY },
    );
    assert.equal(unsigned.status, 503);
  } finally {
    process.env.NEWONE_WEB_GATEWAY_SHARED_SECRET = missingGatewaySecret;
  }

  const oversized = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/conversations', {
      method: 'POST',
      headers: { Origin: 'https://app.newone.example' },
      body: 'x'.repeat(128 * 1024 + 1),
    }),
    { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY },
  );
  assert.equal(oversized.status, 413);

  const compressed = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/conversations', {
      method: 'POST',
      headers: {
        Origin: 'https://app.newone.example',
        'Content-Encoding': 'gzip',
      },
      body: 'compressed-placeholder',
    }),
    { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY },
  );
  assert.equal(compressed.status, 415);
  assert.equal((await compressed.json()).error.code, 'unsupported_media_type');

  for (const unsafePath of [
    '/api/v2/%2e%2e/auth/session',
    '/api/v2/conversations%2fadmin',
    '/api/v2//health',
    '/prefix/api/v2/health',
  ]) {
    const unsafe = await proxyNewoneRequest(
      new Request(`https://app.newone.example${unsafePath}`),
      { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY },
    );
    assert.equal(unsafe.status, 404);
  }
});

test('gateway rejects unhandled methods and upstream redirects', async () => {
  const method = await proxyNewoneRequest(
    {
      method: 'TRACE',
      url: 'https://app.newone.example/api/v2/health',
      headers: new Headers(),
    },
    { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY },
  );
  assert.equal(method.status, 405);

  const redirect = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/health'),
    {
      functionsOrigin: FUNCTIONS_ORIGIN,
      publishableKey: PUBLISHABLE_KEY,
      fetch: async () => new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example/' },
      }),
    },
  );
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.get('location'), null);
});

test('gateway rejects cross-site and originless browser mutations before upstream work', async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return Response.json({ ok: true });
  };
  const crossSite = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/conversations', {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: '{}',
    }),
    { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY, fetch },
  );
  assert.equal(crossSite.status, 403);

  const originless = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/conversations', {
      method: 'POST',
      body: '{}',
    }),
    { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY, fetch },
  );
  assert.equal(originless.status, 403);
  assert.equal(called, false);
});

test('gateway rejects cross-origin reads and strips every upstream CORS capability', async () => {
  let called = false;
  const crossOriginRead = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/bootstrap', {
      headers: {
        Origin: 'https://attacker.newone.example',
        'Sec-Fetch-Site': 'same-site',
      },
    }),
    {
      functionsOrigin: FUNCTIONS_ORIGIN,
      publishableKey: PUBLISHABLE_KEY,
      fetch: async () => {
        called = true;
        return Response.json({ private: true });
      },
    },
  );
  assert.equal(crossOriginRead.status, 403);
  assert.equal(called, false);

  const sameOriginRead = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/bootstrap', {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    }),
    {
      functionsOrigin: FUNCTIONS_ORIGIN,
      publishableKey: PUBLISHABLE_KEY,
      fetch: async () => Response.json(
        { private: true },
        {
          headers: {
            'Access-Control-Allow-Origin': 'https://attacker.newone.example',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Expose-Headers': 'X-Private-Token',
          },
        },
      ),
    },
  );
  assert.equal(sameOriginRead.status, 200);
  assert.equal(sameOriginRead.headers.get('access-control-allow-origin'), null);
  assert.equal(sameOriginRead.headers.get('access-control-allow-credentials'), null);
  assert.equal(sameOriginRead.headers.get('access-control-expose-headers'), null);
});

test('gateway covers preflight, declared-size, and unreadable-body failure contracts', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };
  const originlessPreflight = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/health', { method: 'OPTIONS' }),
    { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY, fetch },
  );
  assert.equal(originlessPreflight.status, 204);

  const sameOriginPreflight = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.newone.example' },
    }),
    { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY, fetch },
  );
  assert.equal(sameOriginPreflight.status, 204);

  const declaredOversize = await proxyNewoneRequest(
    new Request('https://app.newone.example/api/v2/conversations', {
      method: 'POST',
      headers: {
        Origin: 'https://app.newone.example',
        'Content-Length': String(128 * 1024 + 1),
      },
      body: '{}',
    }),
    { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY, fetch },
  );
  assert.equal(declaredOversize.status, 413);

  const unreadable = await proxyNewoneRequest(
    {
      method: 'POST',
      url: 'https://app.newone.example/api/v2/conversations',
      headers: new Headers({ Origin: 'https://app.newone.example' }),
      arrayBuffer: async () => {
        throw new Error('controlled test stream failure');
      },
    },
    { functionsOrigin: FUNCTIONS_ORIGIN, publishableKey: PUBLISHABLE_KEY, fetch },
  );
  assert.equal(unreadable.status, 400);
  assert.equal((await unreadable.json()).error.code, 'bad_request');
  assert.equal(calls, 2);
});

test('gateway rejects malformed origins, keys, secrets, cookies, and duplicate attributes', () => {
  for (const invalidOrigin of [
    undefined,
    'https://example.supabase.co/functions/v1?query=1',
    'https://example.supabase.co/functions/v1#fragment',
  ]) {
    assert.throws(() => functionsOrigin(invalidOrigin));
  }
  assert.throws(() => publishableKey(`sb_publishable_${'x'.repeat(2050)}`));
  assert.throws(() => publishableKey(
    ['sb', 'secret', 'server', 'credentials', 'are', 'not', 'public'].join('_'),
  ));

  assert.equal(sessionCookieHeader(`bad=${'x'.repeat(13 * 1024)}`), null);
  assert.equal(sessionCookieHeader('__Host-newone_access=first; __Host-newone_access=second'),
    '__Host-newone_access=first');
  assert.equal(sessionCookieHeader('__Host-newone_access=bad,value'), null);

  for (const unsafeCookie of [
    '__Host-newone_access=value; Path=/; Path=/; Secure; HttpOnly; SameSite=Strict',
    '__Host-newone_access=value; Path=/; Secure; HttpOnly; SameSite=Strict; Unknown=yes',
    '__Host-newone_access=value; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=forever',
  ]) {
    const headers = new Headers({ 'Set-Cookie': unsafeCookie });
    assert.throws(() => sessionSetCookies(headers));
  }
});
