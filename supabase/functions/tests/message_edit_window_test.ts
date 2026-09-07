// Backlog 45 and 47(e): editing and unsending both close fifteen minutes after
// a message is sent. private.validate_message_update() is the authority and
// names the case; the gateway has to carry that name through as its own code so
// the app can say what happened instead of "not permitted".
import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError, DEFAULT_MESSAGES, fromDatabaseError } from '../_shared/errors.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals } from './assert.ts';

const organizationId = '00000000-0000-4000-8000-000000000001';
const conversationId = '00000000-0000-4000-8000-000000000002';
const actorId = '00000000-0000-4000-8000-000000000010';
const sessionId = '00000000-0000-4000-8000-000000000020';
const messageId = '9001';

const actor = {
  user: { id: actorId },
  claims: { sub: actorId, sessionId, aal: 'aal1', issuedAt: 1, expiresAt: 9999999999 },
  token: 'token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

const editRoute = () => {
  const route = matchRoute('PATCH', `/v2/messages/${messageId}`);
  assert(route, 'the edit route must exist');
  return route;
};

function rejectingActor(message: string): AuthenticatedActor {
  return {
    ...actor,
    adminClient: {
      rpc() {
        return Promise.resolve({ data: null, error: { code: '42501', message } });
      },
    },
  } as unknown as AuthenticatedActor;
}

Deno.test('a late edit becomes its own client code, not a bare refusal', () => {
  const error = fromDatabaseError({ code: '42501', message: 'message_edit_window_closed' });
  assertEquals(error.status, 403);
  assertEquals(error.code, 'message_edit_window_closed');
  assert(error.message.includes('15 minutes'), 'the default copy names the window');
  assertEquals(DEFAULT_MESSAGES.message_edit_window_closed, error.message);
});

Deno.test('a late unsend becomes its own client code', () => {
  const error = fromDatabaseError({ code: '42501', message: 'message_unsend_window_closed' });
  assertEquals(error.status, 403);
  assertEquals(error.code, 'message_unsend_window_closed');
  assert(error.message.includes('15 minutes'), 'the default copy names the window');
});

Deno.test('every other permission refusal stays the generic one', () => {
  for (
    const message of [
      'message edit is not permitted',
      'message deletion is not permitted',
      'message mutation requires current policy access',
    ]
  ) {
    const error = fromDatabaseError({ code: '42501', message });
    assertEquals(error.status, 403);
    assertEquals(error.code, 'forbidden');
  }
});

Deno.test('the edit route carries the window refusal out as 403', async () => {
  const route = editRoute();
  const command = parseCommand(route, { organizationId, conversationId, body: 'Second thoughts' });
  let thrown: unknown;
  try {
    await executeCommand(route, command, rejectingActor('message_edit_window_closed'), 'edit-key-1', 'a'.repeat(64));
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof ApiError, 'the route must reject with an ApiError');
  assertEquals((thrown as ApiError).code, 'message_edit_window_closed');
  assertEquals((thrown as ApiError).status, 403);
});

Deno.test('the same route carries the unsend refusal out as 403', async () => {
  const route = editRoute();
  const command = parseCommand(route, { organizationId, conversationId, delete: true });
  assertEquals(command.values.delete, true);
  let thrown: unknown;
  try {
    await executeCommand(route, command, rejectingActor('message_unsend_window_closed'), 'unsend-key-1', 'a'.repeat(64));
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof ApiError, 'the route must reject with an ApiError');
  assertEquals((thrown as ApiError).code, 'message_unsend_window_closed');
  assertEquals((thrown as ApiError).status, 403);
});

Deno.test('editing and unsending still reach their own RPCs when the window is open', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: { message_id: 9001 }, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const route = editRoute();
  await executeCommand(
    route,
    parseCommand(route, { organizationId, conversationId, body: 'Second thoughts' }),
    rpcActor,
    'edit-key-2',
    'a'.repeat(64),
  );
  await executeCommand(
    route,
    parseCommand(route, { organizationId, conversationId, delete: true }),
    rpcActor,
    'unsend-key-2',
    'a'.repeat(64),
  );
  assertEquals(calls.map((call) => call.name), ['bff_edit_message', 'bff_delete_message']);
  assertEquals(calls[0]?.args.p_body, 'Second thoughts');
  assert(!('p_body' in (calls[1]?.args ?? {})), 'unsending sends no body');
});
