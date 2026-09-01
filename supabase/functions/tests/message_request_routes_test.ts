import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError, fromDatabaseError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  type ApiDependencies,
  createApiHandler,
  rateLimitOperation,
} from '../newone-api/handler.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
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
  token: 'token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(['https://app.newone.example']),
  accessCookieName: 'newone_access',
  refreshCookieName: 'newone_refresh',
  csrfCookieName: 'newone_csrf',
  maxJsonBytes: 65536,
  networkHashKey: 'x'.repeat(32),
  allowHttpLocal: false,
};
const organizationId = '00000000-0000-4000-8000-000000000001';
const targetUserId = '00000000-0000-4000-8000-000000000050';
const conversationId = '00000000-0000-4000-8000-000000000060';
const template = '/v2/contacts/message-requests';

function messageRequestRoute() {
  const route = matchRoute('POST', template);
  assert(route);
  return route;
}

function commandRequest(options: {
  body?: unknown;
  idempotencyKey?: string | null;
  withAuthorization?: boolean;
} = {}): Request {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Origin: 'https://app.newone.example',
  });
  if (options.withAuthorization !== false) {
    headers.set('Authorization', 'Bearer access-token');
  }
  if (options.idempotencyKey !== null) {
    headers.set('Idempotency-Key', options.idempotencyKey ?? 'message-request-0001');
  }
  return new Request(`https://api.newone.example${template}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      options.body ?? { organizationId, targetUserId, body: 'Hello from the search result.' },
    ),
  });
}

Deno.test('message request route registers the command kind with idempotency required', () => {
  const route = messageRequestRoute();
  assertEquals(route.kind, 'contact.message_request');
  assertEquals(route.status, 201);
  assertEquals(route.requireAal2, undefined);
  assertEquals(route.idempotencyRequired, undefined);
  assertEquals(rateLimitOperation('contact.message_request'), 'contact.message_request');
});

Deno.test('message request handler authenticates, authorizes, rate limits, and requires the idempotency header', async () => {
  const calls: string[] = [];
  const dependencies: ApiDependencies = {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'pk',
      secretKey: 'sk',
    },
    authenticateActor: async (_environment, token) => {
      calls.push(`auth:${token}`);
      return actor;
    },
    authorize: async (_actor, requestedOrganizationId, policy) => {
      calls.push(`authorize:${requestedOrganizationId}:${policy.operation}`);
    },
    rateLimit: async (_request, _config, _actor, requestedOrganizationId, operation) => {
      calls.push(`rate:${requestedOrganizationId}:${operation}`);
    },
    execute: async (route, command, _actor, key) => {
      calls.push(`execute:${route.kind}:${key}:${command.values.targetUserId}`);
      return {
        status: 201,
        body: { connectionStatus: 'pending', conversationId, messageId: '101' },
      };
    },
  };
  const handler = createApiHandler(() => dependencies);

  const created = await handler(commandRequest());
  assertEquals(created.status, 201);
  assertEquals(created.headers.get('cache-control'), 'private, no-store');
  assertEquals(await created.json(), {
    connectionStatus: 'pending',
    conversationId,
    messageId: '101',
  });
  assertEquals(calls, [
    'auth:access-token',
    `authorize:${organizationId}:contact.message_request`,
    `rate:${organizationId}:contact.message_request`,
    `execute:contact.message_request:message-request-0001:${targetUserId}`,
  ]);

  calls.length = 0;
  const missingKey = await handler(commandRequest({ idempotencyKey: null }));
  assertEquals(missingKey.status, 400);
  assertEquals(calls.some((call) => call.startsWith('execute:')), false);

  calls.length = 0;
  const unauthenticated = await handler(commandRequest({ withAuthorization: false }));
  assertEquals(unauthenticated.status, 401);
  assertEquals((await unauthenticated.json()).error.code, 'unauthorized');
  assertEquals(calls, []);
});

Deno.test('message request handler maps database cooldown and rate-limit rejections to 429', async () => {
  const handler = createApiHandler(() => ({
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'pk',
      secretKey: 'sk',
    },
    authenticateActor: async () => actor,
    authorize: async () => {},
    rateLimit: async () => {},
    execute: async () => {
      throw fromDatabaseError({
        code: 'P0001',
        message: 'contact request is pending, accepted, or in cooldown',
      });
    },
  }));
  const response = await handler(commandRequest());
  assertEquals(response.status, 429);
  assertEquals(response.headers.get('retry-after'), '60');
  assertEquals((await response.json()).error.code, 'rate_limited');
});

Deno.test('message request body validation reuses the send-message bounds and exact keys', async () => {
  const route = messageRequestRoute();
  const command = parseCommand(route, {
    organizationId,
    targetUserId,
    body: 'Hi! We met at the site tour.',
  });
  assertEquals(command.organizationId, organizationId);
  assertEquals(command.values, {
    targetUserId,
    body: 'Hi! We met at the site tour.',
  });
  const longest = parseCommand(route, { organizationId, targetUserId, body: 'b'.repeat(20000) });
  assertEquals((longest.values.body as string).length, 20000);

  for (
    const invalid of [
      { organizationId, targetUserId },
      { organizationId, targetUserId, body: '' },
      { organizationId, targetUserId, body: ' \n\t ' },
      { organizationId, targetUserId, body: 'b'.repeat(20001) },
      { organizationId, targetUserId, body: 42 },
      { organizationId, targetUserId, body: null },
      { organizationId, body: 'Missing target.' },
      { organizationId, targetUserId: 'not-a-uuid', body: 'Hello.' },
      { organizationId, targetMembershipId: targetUserId, body: 'Wrong key.' },
      { organizationId, targetUserId, body: 'Hello.', clientMessageId: conversationId },
      { targetUserId, body: 'Missing organization.' },
    ]
  ) {
    await assertRejects(
      () => Promise.resolve(parseCommand(route, invalid)),
      (error) => error instanceof ApiError && error.status === 400,
    );
  }
});

Deno.test('message request execution wraps the atomic RPC in the shared idempotency ledger', async () => {
  const route = messageRequestRoute();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    userClient: new Proxy({}, {
      get() {
        throw new Error('message requests may not bypass the BFF RPC');
      },
    }),
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        const data = name === 'bff_begin_idempotency'
          ? { state: 'started' }
          : name === 'bff_send_message_request'
          ? {
            connection_status: 'pending',
            conversation_id: conversationId,
            message_id: 424242,
          }
          : { state: 'completed' };
        return Promise.resolve({ data, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const result = await executeCommand(
    route,
    parseCommand(route, { organizationId, targetUserId, body: 'Hello from search.' }),
    rpcActor,
    'message-request-0001',
    'a'.repeat(64),
  );
  assertEquals(result.status, 201);
  assertEquals(result.body, {
    connectionStatus: 'pending',
    conversationId,
    messageId: '424242',
  });
  assertEquals(calls.map((call) => call.name), [
    'bff_begin_idempotency',
    'bff_send_message_request',
    'bff_complete_idempotency',
  ]);
  // The atomic RPC carries the exact session identity and nothing else.
  assertEquals(calls[1]?.args, {
    p_actor_user_id: actor.user.id,
    p_organization_id: organizationId,
    p_session_id: actor.claims.sessionId,
    p_target_user_id: targetUserId,
    p_body: 'Hello from search.',
  });
  assertEquals(calls[0]?.args, {
    p_actor_user_id: actor.user.id,
    p_organization_id: organizationId,
    p_route: template,
    p_idempotency_key: 'message-request-0001',
    p_request_sha256: 'a'.repeat(64),
  });
  assertEquals(calls[2]?.args, {
    p_actor_user_id: actor.user.id,
    p_organization_id: organizationId,
    p_route: template,
    p_idempotency_key: 'message-request-0001',
    p_request_sha256: 'a'.repeat(64),
    p_status: 201,
    p_response: {
      connectionStatus: 'pending',
      conversationId,
      messageId: '424242',
    },
  });
});

Deno.test('message request replays and idempotency contention never resend the message', async () => {
  const route = messageRequestRoute();
  const command = parseCommand(route, { organizationId, targetUserId, body: 'Hello again.' });
  const recorded = { connectionStatus: 'pending', conversationId, messageId: '424242' };
  const run = (beginState: Record<string, unknown>) => {
    const calls: string[] = [];
    const rpcActor = {
      ...actor,
      adminClient: {
        rpc(name: string) {
          calls.push(name);
          if (name === 'bff_begin_idempotency') {
            return Promise.resolve({ data: beginState, error: null });
          }
          throw new Error(`unexpected RPC ${name}`);
        },
      },
    } as unknown as AuthenticatedActor;
    return {
      calls,
      result: executeCommand(route, command, rpcActor, 'message-request-0001', 'a'.repeat(64)),
    };
  };

  const replay = run({ state: 'replay', response_status: 201, response_body: recorded });
  assertEquals(await replay.result, { status: 201, body: recorded });
  assertEquals(replay.calls, ['bff_begin_idempotency']);

  const conflict = run({ state: 'conflict' });
  await assertRejects(
    () => conflict.result,
    (error) =>
      error instanceof ApiError && error.status === 409 &&
      error.code === 'idempotency_conflict',
  );
  assertEquals(conflict.calls, ['bff_begin_idempotency']);

  const inProgress = run({ state: 'in_progress', retry_after_seconds: 2 });
  await assertRejects(
    () => inProgress.result,
    (error) =>
      error instanceof ApiError && error.status === 409 &&
      error.code === 'idempotency_conflict' && error.retryAfterSeconds === 2,
  );
  assertEquals(inProgress.calls, ['bff_begin_idempotency']);
});

Deno.test('message request execution maps database rejections without completing the ledger', async () => {
  const route = messageRequestRoute();
  const command = parseCommand(route, { organizationId, targetUserId, body: 'Hello.' });
  const run = (response: { data: unknown; error: unknown }) => {
    const calls: string[] = [];
    const rpcActor = {
      ...actor,
      adminClient: {
        rpc(name: string) {
          calls.push(name);
          if (name === 'bff_begin_idempotency') {
            return Promise.resolve({ data: { state: 'started' }, error: null });
          }
          return Promise.resolve(response);
        },
      },
    } as unknown as AuthenticatedActor;
    return {
      calls,
      result: executeCommand(route, command, rpcActor, 'message-request-0001', 'a'.repeat(64)),
    };
  };

  const cases = [
    {
      error: { code: 'P0001', message: 'contact request rate limit exceeded' },
      status: 429,
      code: 'rate_limited',
    },
    {
      error: { code: 'P0001', message: 'contact request is pending, accepted, or in cooldown' },
      status: 429,
      code: 'rate_limited',
    },
    {
      error: { code: '42501', message: 'visible relationship target required' },
      status: 403,
      code: 'forbidden',
    },
    // Personal-realm-only capability and other malformed input classes.
    {
      error: { code: '22023', message: 'message requests are a personal-realm capability' },
      status: 400,
      code: 'bad_request',
    },
  ] as const;
  for (const item of cases) {
    const attempt = run({ data: null, error: item.error });
    await assertRejects(
      () => attempt.result,
      (error) =>
        error instanceof ApiError && error.status === item.status &&
        error.code === item.code,
    );
    assertEquals(attempt.calls, ['bff_begin_idempotency', 'bff_send_message_request']);
  }

  const malformed = run({
    data: { connection_status: 'accepted', conversation_id: conversationId, message_id: 1 },
    error: null,
  });
  await assertRejects(
    () => malformed.result,
    (error) =>
      error instanceof ApiError && error.status === 503 &&
      error.code === 'dependency_unavailable',
  );
  assertEquals(malformed.calls, ['bff_begin_idempotency', 'bff_send_message_request']);
});
