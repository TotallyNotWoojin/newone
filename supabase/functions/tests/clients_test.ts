import {
  authenticateByClaims,
  createAdminClient,
  createPublicClient,
  createUserClient,
} from '../_shared/clients.ts';
import { ApiError } from '../_shared/errors.ts';
import { assertEquals } from './assert.ts';

const environment = {
  url: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_test_value',
  secretKey: 'sb_secret_test_value',
};

Deno.test('public Auth client sends publishable apikey without a fake bearer identity', async () => {
  let headers = new Headers();
  const client = createPublicClient(environment, async (_input, init) => {
    headers = new Headers(init?.headers);
    return new Response(JSON.stringify({ message: 'test stop' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  await client.auth.signInWithOtp({
    email: 'member@example.com',
    options: { shouldCreateUser: false },
  });
  assertEquals(headers.get('apikey'), environment.publishableKey);
  assertEquals(headers.get('authorization'), null);
});

Deno.test('authenticated client keeps apikey separate from the user bearer JWT', async () => {
  let headers = new Headers();
  const client = createUserClient(
    environment,
    'user-access-jwt',
    async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ message: 'test stop' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
  await client.auth.getUser('user-access-jwt');
  assertEquals(headers.get('apikey'), environment.publishableKey);
  assertEquals(headers.get('authorization'), 'Bearer user-access-jwt');
});

Deno.test('server client sends opaque secret in apikey without a fake bearer JWT', async () => {
  let headers = new Headers();
  const client = createAdminClient(
    environment,
    { 'X-Request-Id': '00000000-0000-4000-8000-000000000001' },
    async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
  await client.from('organizations').select('id').limit(1);
  assertEquals(headers.get('apikey'), environment.secretKey);
  assertEquals(headers.get('authorization'), null);
  assertEquals(headers.get('x-newone-server'), 'edge-function');
  assertEquals(headers.get('x-request-id'), '00000000-0000-4000-8000-000000000001');
});

// A signed access token as the Auth service issues one, signed with `key`.
async function signedToken(
  key: CryptoKey,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const head = `${encode({ alg: 'ES256', kid, typ: 'JWT' })}.${encode(claims)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head)),
  );
  const tail = btoa(String.fromCharCode(...signature)).replaceAll('+', '-').replaceAll('/', '_')
    .replaceAll('=', '');
  return `${head}.${tail}`;
}

Deno.test('the API and read functions know the caller from a signed token without asking the Auth service', async () => {
  // Each test project URL gets its own key cache inside supabase-js.
  const project = { ...environment, url: 'https://claims-project.supabase.co' };
  const kid = 'claims-key-1';
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const stranger = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'ES256', use: 'sig' };
  const asked: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(new URL(url).pathname);
    if (url.endsWith('/auth/v1/.well-known/jwks.json')) {
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'not expected' }), { status: 500 });
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `${project.url}/auth/v1`,
    aud: 'authenticated',
    role: 'authenticated',
    sub: '00000000-0000-4000-8000-0000000000aa',
    session_id: '00000000-0000-4000-8000-0000000000bb',
    aal: 'aal1',
    iat: now - 60,
    exp: now + 3600,
  };

  const actor = await authenticateByClaims(project, await signedToken(pair.privateKey, kid, claims), fetcher);
  assertEquals(actor.user.id, claims.sub);
  assertEquals(actor.claims.sessionId, claims.session_id);
  // A second request reuses the published keys; neither asks the Auth service who this is.
  await authenticateByClaims(project, await signedToken(pair.privateKey, kid, claims), fetcher);
  assertEquals(asked, ['/auth/v1/.well-known/jwks.json']);

  const refused = async (token: string) => {
    try {
      await authenticateByClaims(project, token, fetcher);
    } catch (error) {
      return error instanceof ApiError ? error.status : -1;
    }
    return 200;
  };
  assertEquals(await refused(await signedToken(stranger.privateKey, kid, claims)), 401);
  assertEquals(await refused(await signedToken(pair.privateKey, kid, { ...claims, exp: now - 1 })), 401);
  assertEquals(
    await refused(await signedToken(pair.privateKey, kid, { ...claims, iss: 'https://other.supabase.co/auth/v1' })),
    401,
  );
  assertEquals(await refused(await signedToken(pair.privateKey, kid, { ...claims, role: 'anon' })), 401);
  assertEquals(await refused(await signedToken(pair.privateKey, kid, { ...claims, aud: 'other' })), 401);
  assertEquals(await refused(await signedToken(pair.privateKey, kid, { ...claims, session_id: undefined })), 401);
  assertEquals(await refused('not-a-token'), 401);
});
