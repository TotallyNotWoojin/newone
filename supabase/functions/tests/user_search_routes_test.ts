import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError, fromDatabaseError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  createReadHandler,
  defaultReadDependencies,
  parseUserSearchResponse,
  type ReadDependencies,
} from '../newone-read/handler.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const actor = {
  user: { id: '00000000-0000-4000-8000-000000000010' },
  claims: {
    sub: '00000000-0000-4000-8000-000000000010',
    sessionId: '00000000-0000-4000-8000-000000000020',
    aal: 'aal1',
    issuedAt: 1,
    expiresAt: 9999999999,
  },
  token: 'access-token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(['https://app.newone.example']),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65536,
  networkHashKey: 'n'.repeat(32),
  cursorSigningKey: 'c'.repeat(32),
  allowHttpLocal: false,
};

const organizationId = '00000000-0000-4000-8000-000000000001';
const foundUserId = '00000000-0000-4000-8000-000000000031';
const secondUserId = '00000000-0000-4000-8000-000000000032';

function dependencies(overrides: Partial<ReadDependencies> = {}): ReadDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: 'secret',
    },
    authenticateActor: async () => actor,
    resolveOrganization: async () => ({ organizationId, principalContext: {} }),
    authorize: async () => {},
    rateLimit: async () => {},
    loadBootstrap: async () => ({ selectedOrganizationId: organizationId }),
    loadPreferences: async () => ({ organizationId }),
    loadMessages: async () => ({ messages: [], page: {} }),
    loadPins: async () => ({ schemaVersion: 1, pins: [] }),
    loadMedia: async () => ({ schemaVersion: 1, items: [], hasMore: false }),
    loadSearch: async () => ({ results: [], nextCursor: null, hasMore: false }),
    loadUserSearch: async () => ({ users: [] }),
    loadAudit: async () => ({}),
    recordAuditDenial: async () => {},
    ...overrides,
  };
}

function request(body: unknown, withAuthorization = true): Request {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Origin: 'https://app.newone.example',
  });
  if (withAuthorization) {
    headers.set('Authorization', 'Bearer access-token-that-is-long-enough');
  }
  return new Request('https://app.newone.example/api/newone/v2/users/search', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

Deno.test('username search authorizes, rate limits, and forwards the bounded query', async () => {
  const calls: string[] = [];
  let input: unknown;
  const handler = createReadHandler(() =>
    dependencies({
      authorize: async (_actor, requestedOrganizationId, policy) => {
        calls.push(`authorize:${requestedOrganizationId}:${policy.operation}`);
      },
      rateLimit: async (_request, _config, _actor, requestedOrganizationId, operation) => {
        calls.push(`rate:${requestedOrganizationId}:${operation}`);
      },
      loadUserSearch: async (_actor, value) => {
        calls.push('load');
        input = value;
        return {
          users: [{
            userId: foundUserId,
            username: 'jordan_lee',
            displayName: 'Jordan Lee',
            avatarPath: null,
            connectionState: 'none',
          }],
        };
      },
    })
  );
  const response = await handler(request({ organizationId, query: 'jor' }));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('cache-control'), 'private, no-store');
  assertEquals(calls, [
    `authorize:${organizationId}:user.search.read`,
    `rate:${organizationId}:user.search.read`,
    'load',
  ]);
  assertEquals(input, { organizationId, query: 'jor', limit: 10 });
  assertEquals(await response.json(), {
    users: [{
      userId: foundUserId,
      username: 'jordan_lee',
      displayName: 'Jordan Lee',
      avatarPath: null,
      connectionState: 'none',
    }],
  });
});

Deno.test('username search accepts only the documented body envelope and bounds', async () => {
  let input: unknown;
  let loads = 0;
  const handler = createReadHandler(() =>
    dependencies({
      loadUserSearch: async (_actor, value) => {
        loads += 1;
        input = value;
        return { users: [] };
      },
    })
  );
  const explicit = await handler(request({ organizationId, query: '  jordan ', limit: 25 }));
  assertEquals(explicit.status, 200);
  assertEquals(input, { organizationId, query: 'jordan', limit: 25 });

  for (
    const invalid of [
      { organizationId },
      { organizationId, query: '' },
      { organizationId, query: '   ' },
      { organizationId, query: 42 },
      { organizationId, query: 'j'.repeat(65) },
      { organizationId, query: 'jordan', limit: 0 },
      { organizationId, query: 'jordan', limit: 26 },
      { organizationId, query: 'jordan', limit: 10.5 },
      { organizationId, query: 'jordan', cursor: 'not-a-supported-key' },
      { query: 'jordan' },
    ]
  ) {
    assertEquals((await handler(request(invalid))).status, 400);
  }
  assertEquals(loads, 1);
});

Deno.test('username search requires an authenticated caller before any lookup', async () => {
  let loaded = false;
  const handler = createReadHandler(() =>
    dependencies({
      loadUserSearch: async () => {
        loaded = true;
        return { users: [] };
      },
    })
  );
  const response = await handler(request({ organizationId, query: 'jordan' }, false));
  assertEquals(response.status, 401);
  assertEquals((await response.json()).error.code, 'unauthorized');
  assertEquals(loaded, false);
});

Deno.test('username search maps rate-limit denials to the standard 429 envelope', async () => {
  let loaded = false;
  const throttledGateway = createReadHandler(() =>
    dependencies({
      rateLimit: async () => {
        throw new ApiError(429, 'rate_limited', undefined, 30);
      },
      loadUserSearch: async () => {
        loaded = true;
        return { users: [] };
      },
    })
  );
  const gatewayResponse = await throttledGateway(request({ organizationId, query: 'jordan' }));
  assertEquals(gatewayResponse.status, 429);
  assertEquals(gatewayResponse.headers.get('retry-after'), '30');
  assertEquals((await gatewayResponse.json()).error.code, 'rate_limited');
  assertEquals(loaded, false);

  const throttledDatabase = createReadHandler(() =>
    dependencies({
      loadUserSearch: async () => {
        throw fromDatabaseError({
          code: 'P0001',
          message: 'username search rate limit exceeded',
        });
      },
    })
  );
  const databaseResponse = await throttledDatabase(request({ organizationId, query: 'jordan' }));
  assertEquals(databaseResponse.status, 429);
  assertEquals(databaseResponse.headers.get('retry-after'), '60');
  assertEquals((await databaseResponse.json()).error.code, 'rate_limited');
});

async function withReadEnvironment(run: () => Promise<void>): Promise<void> {
  const environment: Record<string, string> = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-user-search',
    SUPABASE_SECRET_KEY: 'secret-key-for-user-search',
    NEWONE_ALLOWED_WEB_ORIGINS: 'https://app.newone.example',
    NEWONE_NETWORK_HASH_KEY: 'network-key-that-is-long-enough-for-tests',
    NEWONE_CURSOR_SIGNING_KEY: 'cursor-key-that-is-long-enough-for-tests',
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test('default username search dependency binds the session identity to the service RPC', async () => {
  await withReadEnvironment(async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpcActor = {
      ...actor,
      adminClient: {
        rpc(name: string, args: Record<string, unknown>) {
          calls.push({ name, args });
          return Promise.resolve({
            data: {
              users: [{
                user_id: foundUserId,
                username: 'jordan_lee',
                display_name: 'Jordan Lee',
                avatar_path: 'avatars/jordan.webp',
                connection_state: 'pending_outgoing',
              }, {
                // display_name/avatar_path are stripped when null in database rows.
                user_id: secondUserId,
                username: 'jordana',
                connection_state: 'none',
              }],
            },
            error: null,
          });
        },
      },
    } as unknown as AuthenticatedActor;
    const result = await defaultReadDependencies().loadUserSearch(rpcActor, {
      organizationId,
      query: 'jordan',
      limit: 10,
    });
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.name, 'bff_search_users_by_username');
    assertEquals(calls[0]?.args, {
      p_actor_user_id: actor.user.id,
      p_organization_id: organizationId,
      p_session_id: actor.claims.sessionId,
      p_query: 'jordan',
      p_limit: 10,
    });
    assertEquals(result, {
      users: [{
        userId: foundUserId,
        username: 'jordan_lee',
        displayName: 'Jordan Lee',
        avatarPath: 'avatars/jordan.webp',
        connectionState: 'pending_outgoing',
      }, {
        userId: secondUserId,
        username: 'jordana',
        displayName: null,
        avatarPath: null,
        connectionState: 'none',
      }],
    });
  });
});

Deno.test('default username search dependency maps database rejections to gateway statuses', async () => {
  await withReadEnvironment(async () => {
    const load = (response: { data: unknown; error: unknown }) =>
      defaultReadDependencies().loadUserSearch(
        {
          ...actor,
          adminClient: { rpc: () => Promise.resolve(response) },
        } as unknown as AuthenticatedActor,
        { organizationId, query: 'jordan', limit: 10 },
      );
    // Personal-realm-only capability: 22023 surfaces as a 400 client error.
    await assertRejects(
      () => load({ data: null, error: { code: '22023' } }),
      (error) =>
        error instanceof ApiError && error.status === 400 &&
        error.code === 'bad_request',
    );
    await assertRejects(
      () =>
        load({
          data: null,
          error: { code: 'P0001', message: 'username search rate limit exceeded' },
        }),
      (error) =>
        error instanceof ApiError && error.status === 429 &&
        error.code === 'rate_limited' && error.retryAfterSeconds === 60,
    );
    await assertRejects(
      () => load({ data: { users: 'not-an-array' }, error: null }),
      (error) =>
        error instanceof ApiError && error.status === 503 &&
        error.code === 'dependency_unavailable',
    );
  });
});

Deno.test('username search response parser admits only constrained directory rows', async () => {
  const row = {
    user_id: foundUserId,
    username: 'jordan_lee',
    display_name: 'Jordan Lee',
    avatar_path: null,
    connection_state: 'accepted',
  };
  assertEquals(parseUserSearchResponse({ users: [row] }, 10), {
    users: [{
      userId: foundUserId,
      username: 'jordan_lee',
      displayName: 'Jordan Lee',
      avatarPath: null,
      connectionState: 'accepted',
    }],
  });
  for (
    const invalid of [
      { users: [row, row] },
      { users: [{ ...row, connection_state: 'blocked' }] },
      { users: [{ ...row, username: 'Jordan Lee' }] },
      { users: [{ ...row, username: 'ab' }] },
      { users: [{ ...row, user_id: 'not-a-uuid' }] },
      { users: [{ ...row, membership_role: 'admin' }] },
      { users: {} },
      { people: [] },
    ]
  ) {
    await assertRejects(
      () => Promise.resolve(parseUserSearchResponse(invalid, 10)),
      (error) =>
        error instanceof ApiError && error.status === 503 &&
        error.code === 'dependency_unavailable',
    );
  }
  await assertRejects(
    () => Promise.resolve(parseUserSearchResponse({ users: [row] }, 0)),
    (error) => error instanceof ApiError && error.status === 503,
  );
  assert(parseUserSearchResponse({ users: [] }, 10).users.length === 0);
});
