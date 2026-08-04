import type { AuthenticatedActor } from '../_shared/clients.ts';
import { signConversationMemberCandidateCursor } from '../_shared/cursors.ts';
import { ApiError } from '../_shared/errors.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const actorId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const conversationId = '40000000-0000-4000-8000-000000000004';
const nextCursor = 'eyJ2ZXJzaW9uIjoxfQ==';
const cursorSigningKey = 'member-candidate-cursor-signing-key-at-least-32-characters';

const actor = {
  user: { id: actorId },
  claims: {
    sub: actorId,
    sessionId,
    aal: 'aal1',
    issuedAt: 1,
    expiresAt: 9999999999,
  },
  token: 'token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

const candidateRows = Array.from({ length: 13 }, (_, index) => {
  const suffix = String(index + 10).padStart(12, '0');
  return {
    user_id: `50000000-0000-4000-8000-${suffix}`,
    display_name: `Candidate ${String(index + 1).padStart(2, '0')}`,
    avatar_path: `avatars/${suffix}.png`,
    role_label: 'Operations',
    membership_type: index === 12 ? 'contractor' : 'employee',
  };
});

Deno.test('conversation member candidate route is bounded, exact, and cursor-aware', async () => {
  const route = matchRoute(
    'POST',
    `/v2/conversations/${conversationId}/member-candidates/query`,
  );
  assert(route);
  assertEquals(route.kind, 'conversation.member.candidates');
  assertEquals(route.status, 200);
  assertEquals(route.idempotencyRequired, false);
  assertEquals(
    parseCommand(route, {
      organizationId,
      query: '  Candidate  ',
      cursor: null,
      limit: 100,
    }).values,
    {
      conversationId,
      query: 'Candidate',
      cursor: null,
      limit: 100,
    },
  );

  for (
    const body of [
      { organizationId, query: '', cursor: null, limit: 101 },
      { organizationId, query: '', cursor: '', limit: 50 },
      { organizationId, query: '', cursor: null, limit: 50, hidden: true },
    ]
  ) await assertRejects(() => parseCommand(route, body));
});

Deno.test('candidate query maps the service-only RPC and preserves pages larger than twelve', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let widened = false;
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            candidates: candidateRows.map((candidate, index) => ({
              ...candidate,
              ...(widened && index === 0 ? { private_email: 'private@example.com' } : {}),
            })),
            next_cursor: nextCursor,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const route = matchRoute(
    'POST',
    `/v2/conversations/${conversationId}/member-candidates/query`,
  );
  assert(route);
  const command = parseCommand(route, {
    organizationId,
    query: 'candidate',
    cursor: null,
    limit: 13,
  });
  const result = await executeCommand(
    route,
    command,
    rpcActor,
    '',
    'a'.repeat(64),
    undefined,
    cursorSigningKey,
  );

  assertEquals(calls[0], {
    name: 'bff_list_conversation_member_candidates',
    args: {
      p_actor_user_id: actorId,
      p_organization_id: organizationId,
      p_session_id: sessionId,
      p_conversation_id: conversationId,
      p_query: 'candidate',
      p_cursor: null,
      p_limit: 13,
    },
  });
  const body = result.body as { candidates: unknown[]; nextCursor: string | null };
  assertEquals(body.candidates.length, 13);
  assert(typeof body.nextCursor === 'string');
  assertEquals(body.nextCursor === nextCursor, false);
  assert(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(body.nextCursor));
  assertEquals(body.candidates[12], {
    userId: candidateRows[12]?.user_id,
    displayName: 'Candidate 13',
    avatarPath: candidateRows[12]?.avatar_path,
    roleLabel: 'Operations',
    membershipType: 'contractor',
  });

  await executeCommand(
    route,
    parseCommand(route, {
      organizationId,
      query: 'candidate',
      cursor: body.nextCursor,
      limit: 13,
    }),
    rpcActor,
    '',
    'b'.repeat(64),
    undefined,
    cursorSigningKey,
  );
  assertEquals(calls[1]?.args.p_cursor, nextCursor);

  widened = true;
  await assertRejects(
    () =>
      executeCommand(
        route,
        command,
        rpcActor,
        '',
        'a'.repeat(64),
        undefined,
        cursorSigningKey,
      ),
    (error) => error instanceof ApiError && error.status === 503,
  );
});

Deno.test('candidate response rejects cursors that claim another partial page', async () => {
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc() {
        return Promise.resolve({
          data: { candidates: candidateRows.slice(0, 12), next_cursor: nextCursor },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const route = matchRoute(
    'POST',
    `/v2/conversations/${conversationId}/member-candidates/query`,
  );
  assert(route);
  await assertRejects(
    () =>
      executeCommand(
        route,
        parseCommand(route, { organizationId, query: '', cursor: null, limit: 13 }),
        rpcActor,
        '',
        'a'.repeat(64),
        undefined,
        cursorSigningKey,
      ),
    (error) => error instanceof ApiError && error.status === 503,
  );
});

Deno.test('dynamic-policy fail-closed empty candidate pages remain empty at the Edge boundary', async () => {
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc() {
        return Promise.resolve({
          data: { candidates: [], next_cursor: null },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const route = matchRoute(
    'POST',
    `/v2/conversations/${conversationId}/member-candidates/query`,
  );
  assert(route);
  const result = await executeCommand(
    route,
    parseCommand(route, { organizationId, query: '', cursor: null, limit: 50 }),
    rpcActor,
    '',
    'a'.repeat(64),
    undefined,
    cursorSigningKey,
  );
  assertEquals(result.body, { candidates: [], nextCursor: null });
});

Deno.test('member candidate continuation rejects tamper and every bound-field mismatch before RPC', async () => {
  let calls = 0;
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc() {
        calls += 1;
        return Promise.resolve({ data: { candidates: [], next_cursor: null }, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const cursor = await signConversationMemberCandidateCursor({
    organizationId,
    actorUserId: actorId,
    conversationId,
    query: 'candidate',
    pageSize: 13,
    databaseCursor: nextCursor,
  }, cursorSigningKey);
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`;
  const otherOrganizationId = '10000000-0000-4000-8000-000000000099';
  const otherActorId = '20000000-0000-4000-8000-000000000099';
  const otherConversationId = '40000000-0000-4000-8000-000000000099';
  const cases = [
    {
      organizationId,
      conversationId,
      query: 'candidate',
      limit: 13,
      cursor: tampered,
      actor: rpcActor,
    },
    { organizationId, conversationId, query: 'different', limit: 13, cursor, actor: rpcActor },
    { organizationId, conversationId, query: 'candidate', limit: 12, cursor, actor: rpcActor },
    {
      organizationId,
      conversationId: otherConversationId,
      query: 'candidate',
      limit: 13,
      cursor,
      actor: rpcActor,
    },
    {
      organizationId: otherOrganizationId,
      conversationId,
      query: 'candidate',
      limit: 13,
      cursor,
      actor: rpcActor,
    },
    {
      organizationId,
      conversationId,
      query: 'candidate',
      limit: 13,
      cursor,
      actor: { ...rpcActor, user: { id: otherActorId } } as unknown as AuthenticatedActor,
    },
  ];
  for (const item of cases) {
    const route = matchRoute(
      'POST',
      `/v2/conversations/${item.conversationId}/member-candidates/query`,
    );
    assert(route);
    await assertRejects(
      () =>
        executeCommand(
          route,
          parseCommand(route, {
            organizationId: item.organizationId,
            query: item.query,
            cursor: item.cursor,
            limit: item.limit,
          }),
          item.actor,
          '',
          'c'.repeat(64),
          undefined,
          cursorSigningKey,
        ),
      (error) => error instanceof ApiError && error.status === 400,
    );
  }
  assertEquals(calls, 0);
});
