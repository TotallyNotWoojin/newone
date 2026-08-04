import type { RuntimeConfig } from '../_shared/http.ts';
import { type BootstrapDependencies, createBootstrapHandler } from '../newone-bootstrap/handler.ts';
import { assert, assertEquals } from './assert.ts';

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65_536,
  networkHashKey: 'n'.repeat(32),
  allowHttpLocal: false,
};
const bootstrapToken = 'bootstrap-token-that-is-at-least-32-characters';
const ownerUserId = '00000000-0000-4000-8000-000000000010';
const ownerEmail = 'owner@example.com';

function dependencies(overrides: Partial<BootstrapDependencies> = {}): BootstrapDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: 'server-secret',
    },
    bootstrapToken,
    inspectOwner: async () => ({
      userId: ownerUserId,
      email: ownerEmail,
      confirmed: true,
      deleted: false,
    }),
    bootstrap: async () => ({
      organization_id: '00000000-0000-4000-8000-000000000001',
      owner_user_id: ownerUserId,
      membership_role: 'owner',
      membership_status: 'active',
      root_unit_id: '00000000-0000-4000-8000-000000000030',
      bootstrapped: true,
    }),
    ...overrides,
  };
}

function request(token = bootstrapToken, extraHeaders: HeadersInit = {}): Request {
  return new Request('https://project.supabase.co/functions/v1/newone-bootstrap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'bootstrap-request-0001',
      'X-Newone-Bootstrap-Token': token,
      apikey: 'server-secret',
      ...extraHeaders,
    },
    body: JSON.stringify({
      ownerUserId,
      ownerEmail,
      organizationName: 'Acme Operations',
      organizationSlug: 'acme-operations',
    }),
  });
}

Deno.test('bootstrap binds an exact confirmed pre-provisioned owner and is idempotency-ready', async () => {
  let input: Record<string, unknown> | undefined;
  const handler = createBootstrapHandler(() =>
    dependencies({
      bootstrap: async (value) => {
        input = value as unknown as Record<string, unknown>;
        return {
          organization_id: '00000000-0000-4000-8000-000000000001',
          owner_user_id: ownerUserId,
          membership_role: 'owner',
          membership_status: 'active',
          root_unit_id: '00000000-0000-4000-8000-000000000030',
          bootstrapped: true,
        };
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 201);
  assertEquals((await response.json()).ownerUserId, ownerUserId);
  assertEquals(input?.idempotencyKey, 'bootstrap-request-0001');
  assert(typeof input?.requestDigest === 'string' && input.requestDigest.length === 64);
});

Deno.test('bootstrap is disabled without a configured token and rejects browser contexts', async () => {
  let inspected = false;
  const disabled = createBootstrapHandler(() =>
    dependencies({
      bootstrapToken: null,
      inspectOwner: async () => {
        inspected = true;
        throw new Error('must not inspect');
      },
    })
  );
  assertEquals((await disabled(request())).status, 404);
  assertEquals(inspected, false);

  const browser = createBootstrapHandler(() => dependencies());
  assertEquals(
    (await browser(request(bootstrapToken, { Origin: 'https://app.example' }))).status,
    403,
  );
  assertEquals((await browser(request('wrong-bootstrap-token'))).status, 401);
  assertEquals(
    (await browser(request(bootstrapToken, {
      apikey: '',
      Authorization: 'Bearer server-secret',
    }))).status,
    401,
  );
});

Deno.test('bootstrap rejects owner email mismatch, unconfirmed users, and unknown fields', async () => {
  let bootstrapped = false;
  const mismatch = createBootstrapHandler(() =>
    dependencies({
      inspectOwner: async () => ({
        userId: ownerUserId,
        email: 'different@example.com',
        confirmed: true,
        deleted: false,
      }),
      bootstrap: async () => {
        bootstrapped = true;
        return {};
      },
    })
  );
  assertEquals((await mismatch(request())).status, 403);
  assertEquals(bootstrapped, false);

  const unconfirmed = createBootstrapHandler(() =>
    dependencies({
      inspectOwner: async () => ({
        userId: ownerUserId,
        email: ownerEmail,
        confirmed: false,
        deleted: false,
      }),
    })
  );
  assertEquals((await unconfirmed(request())).status, 403);

  const unknown = new Request('https://project.supabase.co/functions/v1/newone-bootstrap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'bootstrap-request-0001',
      'X-Newone-Bootstrap-Token': bootstrapToken,
      apikey: 'server-secret',
    },
    body: JSON.stringify({
      ownerUserId,
      ownerEmail,
      organizationName: 'Acme',
      organizationSlug: 'acme',
      role: 'owner',
    }),
  });
  assertEquals((await createBootstrapHandler(() => dependencies())(unknown)).status, 400);
});
