import { createAdminClient, createPublicClient, createUserClient } from '../_shared/clients.ts';
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
