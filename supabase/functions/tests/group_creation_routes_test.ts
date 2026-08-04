import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError } from '../_shared/errors.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const actorId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const conversationId = '40000000-0000-4000-8000-000000000004';
const firstMemberId = '50000000-0000-4000-8000-000000000005';
const secondMemberId = '60000000-0000-4000-8000-000000000006';
const avatarAttachmentId = '70000000-0000-4000-8000-000000000007';
const avatarPath = `${organizationId}/${conversationId}/${actorId}/${avatarAttachmentId}/upload`;

const actor = {
  user: { id: actorId },
  claims: {
    sub: actorId,
    sessionId,
    aal: 'aal2',
    issuedAt: 1,
    expiresAt: 9999999999,
  },
  token: 'token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

const creationBody = {
  organizationId,
  name: 'Packaging handoff',
  description: 'Coordinate packaging and dispatch.',
  memberAssignments: [
    { membershipId: firstMemberId, role: 'owner' },
    { membershipId: secondMemberId, role: 'admin' },
  ],
  kind: 'team',
  unitId: null,
  historyPolicy: 'since_join',
  postingMode: 'admins_only',
  joinPolicy: 'approval_required',
  incidentSeverity: null,
  incidentClassification: null,
} as const;

const creationReceipt = {
  conversation_id: conversationId,
  kind: 'team',
  name: 'Packaging handoff',
  description: 'Coordinate packaging and dispatch.',
  history_policy: 'since_join',
  history_disclosure: {
    policy: 'since_join',
    visible_from: '2026-08-04T20:00:00.000Z',
    label_key: 'conversation.history.since_join',
  },
  posting_mode: 'admins_only',
  join_policy: 'approval_required',
  configured_join_policy: 'approval_required',
  visibility: 'organization',
  member_count: 3,
  member_limit: 500,
  is_read_only: false,
};

Deno.test('group creation and candidate routes expose distinct strict contracts', () => {
  const create = matchRoute('POST', '/v2/conversations/group');
  const candidates = matchRoute('POST', '/v2/conversations/group/candidates/query');
  assert(create && candidates);
  assertEquals(create.kind, 'conversation.group');
  assertEquals(create.status, 201);
  assertEquals(candidates.kind, 'conversation.group.candidates');
  assertEquals(candidates.status, 200);
  assertEquals(candidates.idempotencyRequired, false);
  assertEquals(parseCommand(candidates, { organizationId, query: null, limit: 25 }).values, {
    query: '',
    limit: 25,
  });
});

Deno.test('group creation parser maps exact atomic assignments and rejects ambiguous policy input', async () => {
  const route = matchRoute('POST', '/v2/conversations/group');
  assert(route);
  const command = parseCommand(route, creationBody);
  assertEquals(command.values, {
    name: creationBody.name,
    description: creationBody.description,
    memberAssignments: [
      { user_id: firstMemberId, role: 'owner' },
      { user_id: secondMemberId, role: 'admin' },
    ],
    kind: 'team',
    unitId: null,
    historyPolicy: 'since_join',
    postingMode: 'admins_only',
    joinPolicy: 'approval_required',
    incidentSeverity: null,
    incidentClassification: null,
  });
  for (
    const body of [
      { ...creationBody, hidden: true },
      { ...creationBody, memberAssignments: [] },
      {
        ...creationBody,
        memberAssignments: [
          { membershipId: firstMemberId, role: 'member' },
          { membershipId: firstMemberId, role: 'admin' },
        ],
      },
      {
        ...creationBody,
        memberAssignments: [{ membershipId: firstMemberId, role: 'manager' }],
      },
      { ...creationBody, kind: 'announcement' },
      { ...creationBody, kind: 'shift', joinPolicy: 'approval_required' },
      { ...creationBody, incidentSeverity: 'critical' },
    ]
  ) await assertRejects(() => parseCommand(route, body));
});

Deno.test('group creation commits all roles in one v2 RPC and validates the authoritative receipt', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: creationReceipt, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const route = matchRoute('POST', '/v2/conversations/group');
  assert(route);
  const result = await executeCommand(
    route,
    parseCommand(route, creationBody),
    rpcActor,
    'group-create-command-0001',
    'a'.repeat(64),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.name, 'bff_create_group_conversation_v2');
  assertEquals(calls[0]?.args.p_member_assignments, [
    { user_id: firstMemberId, role: 'owner' },
    { user_id: secondMemberId, role: 'admin' },
  ]);
  assertEquals(calls[0]?.args.p_posting_mode, 'admins_only');
  assertEquals(calls[0]?.args.p_join_policy, 'approval_required');
  assertEquals(result.body, {
    conversationId,
    kind: 'team',
    name: 'Packaging handoff',
    description: 'Coordinate packaging and dispatch.',
    historyPolicy: 'since_join',
    historyDisclosure: {
      policy: 'since_join',
      visibleFrom: '2026-08-04T20:00:00.000Z',
      labelKey: 'conversation.history.since_join',
    },
    postingMode: 'admins_only',
    joinPolicy: 'approval_required',
    configuredJoinPolicy: 'approval_required',
    visibility: 'organization',
    memberCount: 3,
    memberLimit: 500,
    isReadOnly: false,
  });
});

Deno.test('candidate query uses the service-only scoped RPC and rejects widened output', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let widened = false;
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            candidates: [{
              user_id: firstMemberId,
              display_name: 'Luis Ortega',
              avatar_path: null,
              job_title: 'Contract operator',
              membership_role: 'member',
              membership_type: 'guest',
              access_expires_at: '2026-09-03T20:00:00.000Z',
              ...(widened ? { email: 'private@example.com' } : {}),
            }],
            limit: 25,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const route = matchRoute('POST', '/v2/conversations/group/candidates/query');
  assert(route);
  const command = parseCommand(route, { organizationId, query: 'luis', limit: 25 });
  const result = await executeCommand(route, command, rpcActor, '', 'b'.repeat(64));
  assertEquals(calls[0], {
    name: 'bff_list_group_creation_candidates',
    args: {
      p_actor_user_id: actorId,
      p_organization_id: organizationId,
      p_session_id: sessionId,
      p_query: 'luis',
      p_limit: 25,
    },
  });
  assertEquals(result.body, {
    candidates: [{
      userId: firstMemberId,
      displayName: 'Luis Ortega',
      avatarPath: null,
      jobTitle: 'Contract operator',
      membershipRole: 'member',
      membershipType: 'guest',
      accessExpiresAt: '2026-09-03T20:00:00.000Z',
    }],
    limit: 25,
  });
  widened = true;
  await assertRejects(
    () => executeCommand(route, command, rpcActor, '', 'b'.repeat(64)),
    (error) => error instanceof ApiError && error.status === 503,
  );
});

Deno.test('member role CAS requires recent AAL2 and binds both path identities into the digest', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            conversation_id: args.p_conversation_id,
            user_id: args.p_target_user_id,
            previous_role: args.p_expected_role,
            role: args.p_new_role,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  for (
    const [targetId, newRole] of [
      [firstMemberId, 'admin'],
      [secondMemberId, 'owner'],
    ] as const
  ) {
    const route = matchRoute(
      'PATCH',
      `/v2/conversations/${conversationId}/members/${targetId}/role`,
    );
    assert(route);
    assertEquals(route.requireAal2, true);
    assertEquals(route.recentAuthSeconds, 900);
    await executeCommand(
      route,
      parseCommand(route, { organizationId, expectedRole: 'member', newRole }),
      rpcActor,
      `role-command-${newRole}`,
      'c'.repeat(64),
    );
  }
  assertEquals(calls.map((call) => call.name), [
    'bff_update_conversation_member_role',
    'bff_update_conversation_member_role',
  ]);
  assertEquals(calls[0]?.args.p_conversation_id, conversationId);
  assertEquals(calls[0]?.args.p_target_user_id, firstMemberId);
  assertEquals(calls[0]?.args.p_expected_role, 'member');
  assertEquals(calls[0]?.args.p_new_role, 'admin');
  assert(
    calls[0]?.args.p_request_sha256 !== calls[1]?.args.p_request_sha256,
    'target identity must change the role-update idempotency digest',
  );
  const route = matchRoute(
    'PATCH',
    `/v2/conversations/${conversationId}/members/${firstMemberId}/role`,
  );
  assert(route);
  await assertRejects(() =>
    parseCommand(route, { organizationId, expectedRole: 'member', newRole: 'member' })
  );
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      expectedRole: 'member',
      newRole: 'admin',
      untrustedUserId: secondMemberId,
    })
  );
});

Deno.test('conversation avatar routes reject raw paths and enforce bounded image commands', async () => {
  const grant = matchRoute('POST', `/v2/conversations/${conversationId}/avatar/grants`);
  const query = matchRoute('POST', `/v2/conversations/${conversationId}/avatar/query`);
  const activate = matchRoute(
    'POST',
    `/v2/conversations/${conversationId}/avatar/${avatarAttachmentId}/activate`,
  );
  const remove = matchRoute('DELETE', `/v2/conversations/${conversationId}/avatar`);
  const genericUpdate = matchRoute('PATCH', `/v2/conversations/${conversationId}`);
  assert(grant && query && activate && remove && genericUpdate);
  assertEquals(query.idempotencyRequired, false);
  assertEquals(
    parseCommand(grant, {
      organizationId,
      fileName: 'team-photo.webp',
      mimeType: 'image/webp',
      byteSize: 5 * 1024 * 1024,
      sha256Hex: 'a'.repeat(64),
    }).values,
    {
      conversationId,
      fileName: 'team-photo.webp',
      mimeType: 'image/webp',
      byteSize: 5 * 1024 * 1024,
      sha256Hex: 'a'.repeat(64),
    },
  );
  assertEquals(
    parseCommand(activate, {
      organizationId,
      expectedAvatarPath: null,
    }).values.expectedAvatarPath,
    null,
  );
  assertEquals(
    parseCommand(remove, {
      organizationId,
      expectedAvatarPath: avatarPath,
    }).values.expectedAvatarPath,
    avatarPath,
  );
  for (
    const invalid of [
      { fileName: 'team-photo.webp', mimeType: 'image/gif', byteSize: 100 },
      { fileName: '../team-photo.webp', mimeType: 'image/webp', byteSize: 100 },
      { fileName: 'team-photo.webp', mimeType: 'image/webp', byteSize: 5 * 1024 * 1024 + 1 },
    ]
  ) {
    await assertRejects(() =>
      parseCommand(grant, {
        organizationId,
        ...invalid,
        sha256Hex: 'a'.repeat(64),
      })
    );
  }
  await assertRejects(() =>
    parseCommand(genericUpdate, {
      organizationId,
      avatarPath,
    })
  );
  await assertRejects(() =>
    parseCommand(remove, {
      organizationId,
      expectedAvatarPath: avatarPath.replace(organizationId, firstMemberId),
    })
  );
});

Deno.test('conversation avatar upload and read grants remain server-authorized and narrowly signed', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const signedReads: Array<{ path: string; seconds: number; options: unknown }> = [];
  let authorized = true;
  const adminClient = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === 'bff_create_conversation_avatar_upload') {
        return Promise.resolve({
          data: {
            attachment_id: avatarAttachmentId,
            message_id: 101,
            bucket_id: 'message-attachments',
            storage_path: avatarPath,
            scan_status: 'pending',
            maximum_byte_size: 5 * 1024 * 1024,
          },
          error: null,
        });
      }
      assertEquals(name, 'bff_authorize_conversation_avatar_download');
      return Promise.resolve({
        data: authorized
          ? {
            authorized: true,
            conversation_id: conversationId,
            attachment_id: avatarAttachmentId,
            bucket_id: 'message-attachments',
            storage_path: avatarPath,
            mime_type: 'image/webp',
            byte_size: 100,
          }
          : { authorized: false },
        error: null,
      });
    },
    storage: {
      from(bucket: string) {
        assertEquals(bucket, 'message-attachments');
        return {
          createSignedUploadUrl(path: string, options: unknown) {
            assertEquals(path, avatarPath);
            assertEquals(options, { upsert: false });
            return Promise.resolve({
              data: { signedUrl: 'https://storage.example/avatar-upload', token: 'upload-token' },
              error: null,
            });
          },
          createSignedUrl(path: string, seconds: number, options?: unknown) {
            signedReads.push({ path, seconds, options });
            return Promise.resolve({
              data: { signedUrl: 'https://storage.example/avatar-read' },
              error: null,
            });
          },
        };
      },
    },
  };
  const avatarActor = { ...actor, adminClient } as unknown as AuthenticatedActor;
  const grantRoute = matchRoute('POST', `/v2/conversations/${conversationId}/avatar/grants`);
  assert(grantRoute);
  const grant = await executeCommand(
    grantRoute,
    parseCommand(grantRoute, {
      organizationId,
      fileName: 'team-photo.webp',
      mimeType: 'image/webp',
      byteSize: 100,
      sha256Hex: 'b'.repeat(64),
    }),
    avatarActor,
    'avatar-grant-0001',
    'c'.repeat(64),
  );
  assertEquals(calls[0]?.name, 'bff_create_conversation_avatar_upload');
  assertEquals(calls[0]?.args.p_conversation_id, conversationId);
  assertEquals(grant.body, {
    grant: {
      action: 'upload',
      attachmentId: avatarAttachmentId,
      messageId: '101',
      bucket: 'message-attachments',
      path: avatarPath,
      scanStatus: 'pending',
      maximumByteSize: 5 * 1024 * 1024,
      signedUrl: 'https://storage.example/avatar-upload',
      token: 'upload-token',
      expiresInSeconds: 7200,
    },
  });

  const queryRoute = matchRoute('POST', `/v2/conversations/${conversationId}/avatar/query`);
  assert(queryRoute);
  const queryCommand = parseCommand(queryRoute, {
    organizationId,
    attachmentId: avatarAttachmentId,
  });
  const read = await executeCommand(queryRoute, queryCommand, avatarActor, '', 'd'.repeat(64));
  assertEquals(calls[1], {
    name: 'bff_authorize_conversation_avatar_download',
    args: {
      p_actor_user_id: actorId,
      p_organization_id: organizationId,
      p_session_id: sessionId,
      p_conversation_id: conversationId,
      p_attachment_id: avatarAttachmentId,
    },
  });
  assertEquals(signedReads, [{ path: avatarPath, seconds: 120, options: undefined }]);
  assertEquals(read.body, {
    attachmentId: avatarAttachmentId,
    signedUrl: 'https://storage.example/avatar-read',
    expiresInSeconds: 120,
  });

  authorized = false;
  await assertRejects(
    () => executeCommand(queryRoute, queryCommand, avatarActor, '', 'e'.repeat(64)),
    (error) => error instanceof ApiError && error.status === 404,
  );
  assertEquals(signedReads.length, 1);
});

Deno.test('conversation avatar activation and removal are compare-and-set lifecycle commands', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (name === 'bff_activate_conversation_avatar') {
          return Promise.resolve({
            data: {
              conversation_id: conversationId,
              attachment_id: avatarAttachmentId,
              avatar_path: avatarPath,
              previous_avatar_path: null,
              activated: true,
            },
            error: null,
          });
        }
        assertEquals(name, 'bff_remove_conversation_avatar');
        return Promise.resolve({
          data: {
            conversation_id: conversationId,
            previous_avatar_path: avatarPath,
            avatar_path: null,
            removed: true,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const activateRoute = matchRoute(
    'POST',
    `/v2/conversations/${conversationId}/avatar/${avatarAttachmentId}/activate`,
  );
  assert(activateRoute);
  const activation = await executeCommand(
    activateRoute,
    parseCommand(activateRoute, { organizationId, expectedAvatarPath: null }),
    rpcActor,
    'avatar-activate-0001',
    'f'.repeat(64),
  );
  assertEquals(activation.body, {
    conversationId,
    attachmentId: avatarAttachmentId,
    avatarPath,
    previousAvatarPath: null,
    activated: true,
  });
  const removeRoute = matchRoute('DELETE', `/v2/conversations/${conversationId}/avatar`);
  assert(removeRoute);
  const removal = await executeCommand(
    removeRoute,
    parseCommand(removeRoute, { organizationId, expectedAvatarPath: avatarPath }),
    rpcActor,
    'avatar-remove-0001',
    '1'.repeat(64),
  );
  assertEquals(removal.body, {
    conversationId,
    previousAvatarPath: avatarPath,
    avatarPath: null,
    removed: true,
  });
  assertEquals(calls.map((call) => call.name), [
    'bff_activate_conversation_avatar',
    'bff_remove_conversation_avatar',
  ]);
  assertEquals(calls[0]?.args.p_expected_avatar_path, null);
  assertEquals(calls[1]?.args.p_expected_avatar_path, avatarPath);
});
