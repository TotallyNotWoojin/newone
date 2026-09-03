import type { AuthenticatedActor } from '../_shared/clients.ts';
import { rateLimitOperation } from '../newone-api/handler.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '7c000000-0000-4000-8000-000000000001';
const actorUserId = '7c000000-0000-4000-8000-000000000003';
const sessionId = '7c000000-0000-4000-8000-000000000004';
const otherUserId = '7c000000-0000-4000-8000-000000000005';

function profileRoute() {
  const route = matchRoute('PATCH', '/v2/profile');
  assert(route);
  return route;
}

function actorWith(rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  return {
    user: { id: actorUserId },
    claims: {
      sub: actorUserId,
      sessionId,
      aal: 'aal1',
      issuedAt: 1,
      expiresAt: 9999999999,
    },
    token: 'token',
    userClient: {},
    adminClient: { rpc },
  } as unknown as AuthenticatedActor;
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    user_id: actorUserId,
    display_name: 'Alice Renamed',
    status_message: 'On shift',
    ...overrides,
  };
}

Deno.test('profile update registers as an idempotent PATCH command with its own rate-limit bucket', () => {
  const route = profileRoute();
  assertEquals(route.kind, 'profile.update');
  assertEquals(route.status, 200);
  assertEquals(route.requireAal2, undefined);
  assertEquals(route.recentAuthSeconds, undefined);
  assertEquals(route.idempotencyRequired, undefined);
  assertEquals(rateLimitOperation('profile.update'), 'profile.update');
  assertEquals(matchRoute('POST', '/v2/profile'), null);
  assertEquals(matchRoute('PATCH', `/v2/profile/${otherUserId}`), null);
});

Deno.test('profile update trims the display name and normalizes the status message', () => {
  const route = profileRoute();
  assertEquals(
    parseCommand(route, {
      organizationId,
      displayName: '  Alice Renamed  ',
      statusMessage: ' On shift ',
    }),
    { organizationId, values: { displayName: 'Alice Renamed', statusMessage: 'On shift' } },
  );
  for (
    const body of [
      { organizationId, displayName: 'Alice' },
      { organizationId, displayName: 'Alice', statusMessage: null },
      { organizationId, displayName: 'Alice', statusMessage: '' },
      { organizationId, displayName: 'Alice', statusMessage: '   ' },
    ]
  ) {
    assertEquals(parseCommand(route, body).values, { displayName: 'Alice', statusMessage: null });
  }
  assertEquals(
    parseCommand(route, {
      organizationId,
      displayName: 'n'.repeat(120),
      statusMessage: 's'.repeat(280),
    }).values,
    { displayName: 'n'.repeat(120), statusMessage: 's'.repeat(280) },
  );
});

Deno.test('profile update rejects bounds violations and foreign keys before any RPC', async () => {
  const route = profileRoute();
  for (
    const body of [
      { organizationId },
      { organizationId, displayName: '' },
      { organizationId, displayName: '   ' },
      { organizationId, displayName: null },
      { organizationId, displayName: 42 },
      { organizationId, displayName: 'n'.repeat(121) },
      { organizationId, displayName: 'Alice', statusMessage: 's'.repeat(281) },
      { organizationId, displayName: 'Alice', statusMessage: 42 },
      { organizationId, displayName: 'Alice', username: 'stolen_handle' },
      { organizationId, displayName: 'Alice', userId: otherUserId },
      { displayName: 'Alice' },
    ]
  ) {
    await assertRejects(
      () => Promise.resolve(parseCommand(route, body)),
      (error) => (error as { status?: number }).status === 400,
    );
  }
});

Deno.test('profile update calls the service-only RPC for the actor and projects the receipt', async () => {
  const route = profileRoute();
  const command = parseCommand(route, {
    organizationId,
    displayName: '  Alice Renamed ',
    statusMessage: 'On shift',
  });
  let rpcName: string | null = null;
  let rpcArgs: Record<string, unknown> | null = null;
  const actor = actorWith((name, args) => {
    rpcName = name;
    rpcArgs = args;
    return Promise.resolve({ data: receipt(), error: null });
  });
  const result = await executeCommand(route, command, actor, 'profile-0001', 'a'.repeat(64));
  assertEquals(rpcName, 'bff_update_profile');
  assertEquals(rpcArgs, {
    p_actor_user_id: actorUserId,
    p_organization_id: organizationId,
    p_session_id: sessionId,
    p_display_name: 'Alice Renamed',
    p_status_message: 'On shift',
  });
  assertEquals(result.status, 200);
  assertEquals(result.body, {
    userId: actorUserId,
    displayName: 'Alice Renamed',
    statusMessage: 'On shift',
  });

  const cleared = await executeCommand(
    route,
    parseCommand(route, { organizationId, displayName: 'Alice' }),
    actorWith(() =>
      Promise.resolve({
        data: receipt({ display_name: 'Alice', status_message: null }),
        error: null,
      })
    ),
    'profile-0002',
    'b'.repeat(64),
  );
  assertEquals(rpcArgs, {
    p_actor_user_id: actorUserId,
    p_organization_id: organizationId,
    p_session_id: sessionId,
    p_display_name: 'Alice Renamed',
    p_status_message: 'On shift',
  });
  assertEquals(cleared.body, { userId: actorUserId, displayName: 'Alice', statusMessage: null });
});

Deno.test('profile update fails closed on a malformed or foreign dependency receipt', async () => {
  const route = profileRoute();
  const command = parseCommand(route, { organizationId, displayName: 'Alice' });
  for (
    const data of [
      receipt({ user_id: otherUserId }),
      receipt({ username: 'leaked_handle' }),
      { user_id: actorUserId, display_name: 'Alice' },
      receipt({ display_name: '' }),
      receipt({ display_name: 'n'.repeat(121) }),
      receipt({ status_message: 's'.repeat(281) }),
      receipt({ status_message: 7 }),
      null,
      [],
    ]
  ) {
    await assertRejects(
      () =>
        executeCommand(
          route,
          command,
          actorWith(() => Promise.resolve({ data, error: null })),
          'profile-0003',
          'c'.repeat(64),
        ),
      (error) => (error as { status?: number }).status === 503,
    );
  }
});
