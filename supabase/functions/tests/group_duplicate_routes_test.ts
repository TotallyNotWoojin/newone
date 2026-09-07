// One group per set of people. When the service answers "you already have
// this group", the route reports it as its own outcome rather than pretending
// something was created.
import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError } from '../_shared/errors.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const actorId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const existingConversationId = '40000000-0000-4000-8000-00000000000a';
const firstMemberId = '50000000-0000-4000-8000-000000000005';
const secondMemberId = '60000000-0000-4000-8000-000000000006';

const actor = {
  user: { id: actorId },
  claims: { sub: actorId, sessionId, aal: 'aal1', issuedAt: 1, expiresAt: 9999999999 },
  token: 'token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

const creationBody = {
  organizationId,
  name: 'Weekend trip',
  description: null,
  memberAssignments: [
    { membershipId: firstMemberId, role: 'member' },
    { membershipId: secondMemberId, role: 'member' },
  ],
  kind: 'group',
  unitId: null,
  historyPolicy: 'since_join',
  postingMode: 'all_members',
  joinPolicy: 'invite_only',
  incidentSeverity: null,
  incidentClassification: null,
} as const;

function actorAnswering(payload: unknown): AuthenticatedActor {
  return {
    ...actor,
    adminClient: {
      rpc(_name: string, _args: Record<string, unknown>) {
        return Promise.resolve({ data: payload, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
}

async function createWith(payload: unknown) {
  const route = matchRoute('POST', '/v2/conversations/group');
  assert(route);
  return await executeCommand(
    route,
    parseCommand(route, creationBody),
    actorAnswering(payload),
    'group-duplicate-command-0001',
    'b'.repeat(64),
  );
}

Deno.test('an existing member set answers 200 with the group that already holds it', async () => {
  const result = await createWith({
    already_exists: true,
    conversation_id: existingConversationId,
  });
  // Nothing was created, so it is not a 201.
  assertEquals(result.status, 200);
  assertEquals(result.body, { alreadyExists: true, conversationId: existingConversationId });
});

Deno.test('the existing-group answer carries the id and nothing else', async () => {
  for (
    const payload of [
      { already_exists: true },
      { already_exists: true, conversation_id: existingConversationId, name: 'Weekend trip' },
      { already_exists: true, conversation_id: 'not-a-uuid' },
    ]
  ) {
    await assertRejects(
      () => createWith(payload),
      (error) => error instanceof ApiError && error.status === 503,
      'an unrecognised existing-group answer must not reach the app',
    );
  }
});

Deno.test('a group that really was created still answers 201 with its full receipt', async () => {
  const result = await createWith({
    conversation_id: existingConversationId,
    kind: 'group',
    name: 'Weekend trip',
    description: null,
    history_policy: 'since_join',
    history_disclosure: {
      policy: 'since_join',
      visible_from: '2026-09-08T20:00:00.000Z',
      label_key: 'conversation.history.since_join',
    },
    posting_mode: 'all_members',
    join_policy: 'invite_only',
    configured_join_policy: 'invite_only',
    visibility: 'invite_only',
    member_count: 3,
    member_limit: 500,
    is_read_only: false,
  });
  assertEquals(result.status, 201);
  assertEquals((result.body as Record<string, unknown>).conversationId, existingConversationId);
  assertEquals((result.body as Record<string, unknown>).memberCount, 3);
});
