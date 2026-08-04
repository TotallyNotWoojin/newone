import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError } from '../_shared/errors.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const actorId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const conversationId = '40000000-0000-4000-8000-000000000004';
const policyId = '50000000-0000-4000-8000-000000000005';
const publishedVersionId = '60000000-0000-4000-8000-000000000006';
const memberOne = '70000000-0000-4000-8000-000000000007';
const memberTwo = '80000000-0000-4000-8000-000000000008';
const siteId = '90000000-0000-4000-8000-000000000009';
const teamId = 'a0000000-0000-4000-8000-00000000000a';
const selectorFingerprint = 'a'.repeat(64);
const previewFingerprint = 'b'.repeat(64);
const membershipFingerprint = 'c'.repeat(64);

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

const policySpec = {
  siteIds: [siteId],
  departmentIds: [],
  teamIds: [teamId],
  lineIds: [],
  unitIds: [],
  includeDescendants: true,
  operationalRoles: ['quality lead', 'supervisor'],
  membershipRoles: ['manager', 'member'],
  shiftMode: 'scheduled',
  scheduledShiftStartsAt: '2026-08-04T20:00:00.000Z',
  scheduledShiftEndsAt: '2026-08-05T08:00:00.000Z',
} as const;

const policySpecSnake = {
  site_ids: policySpec.siteIds,
  department_ids: policySpec.departmentIds,
  team_ids: policySpec.teamIds,
  line_ids: policySpec.lineIds,
  unit_ids: policySpec.unitIds,
  include_descendants: true,
  operational_roles: policySpec.operationalRoles,
  membership_roles: policySpec.membershipRoles,
  shift_mode: 'scheduled',
  scheduled_shift_starts_at: policySpec.scheduledShiftStartsAt,
  scheduled_shift_ends_at: policySpec.scheduledShiftEndsAt,
};

Deno.test('dynamic-group routes expose the complete recent-AAL2 CAS lifecycle and no legacy sync', () => {
  const list = matchRoute('POST', '/v2/dynamic-groups/policies/query');
  const save = matchRoute('POST', '/v2/dynamic-groups/policies');
  const preview = matchRoute('POST', `/v2/dynamic-groups/${policyId}/preview`);
  const publish = matchRoute('POST', `/v2/dynamic-groups/${policyId}/publish`);
  const pause = matchRoute('POST', `/v2/dynamic-groups/${policyId}/pause`);
  assert(list && save && preview && publish && pause);
  assertEquals(list.kind, 'dynamic_group.list');
  assertEquals(list.idempotencyRequired, false);
  assertEquals(save.status, 201);
  assertEquals(preview.idempotencyRequired, false);
  for (const route of [list, save, preview, publish, pause]) {
    assertEquals(route.requireAal2, true);
    assertEquals(route.recentAuthSeconds, 900);
  }
  assertEquals(matchRoute('POST', `/v2/dynamic-groups/${policyId}/sync`), null);
});

Deno.test('dynamic-group request DTOs are exact, bounded, canonical, and version bound', async () => {
  const save = matchRoute('POST', '/v2/dynamic-groups/policies');
  const preview = matchRoute('POST', `/v2/dynamic-groups/${policyId}/preview`);
  const publish = matchRoute('POST', `/v2/dynamic-groups/${policyId}/publish`);
  const pause = matchRoute('POST', `/v2/dynamic-groups/${policyId}/pause`);
  assert(save && preview && publish && pause);
  assertEquals(
    parseCommand(save, {
      organizationId,
      conversationId,
      policyId,
      expectedVersion: 2,
      policySpec,
      maximumMembers: 750,
    }).values,
    {
      conversationId,
      policyId,
      expectedVersion: 2,
      policySpec: policySpecSnake,
      maximumMembers: 750,
    },
  );
  assertEquals(parseCommand(preview, { organizationId, expectedVersion: 3 }).values, {
    policyId,
    expectedVersion: 3,
    sampleLimit: 50,
  });
  assertEquals(
    parseCommand(publish, {
      organizationId,
      expectedVersion: 3,
      previewFingerprint,
    }).values,
    { policyId, expectedVersion: 3, previewFingerprint },
  );
  assertEquals(
    parseCommand(pause, {
      organizationId,
      expectedVersion: 3,
      reason: 'The shift roster is being replaced',
    }).values,
    { policyId, expectedVersion: 3, reason: 'The shift roster is being replaced' },
  );

  for (
    const [route, body] of [
      [save, {
        organizationId,
        conversationId,
        policyId,
        expectedVersion: 2,
        policySpec: { ...policySpec, sql: 'true' },
        maximumMembers: 750,
      }],
      [save, {
        organizationId,
        conversationId,
        policyId,
        expectedVersion: 2,
        policySpec: {
          ...policySpec,
          scheduledShiftEndsAt: '2026-10-05T08:00:00.000Z',
        },
        maximumMembers: 750,
      }],
      [preview, { organizationId, expectedVersion: 0, sampleLimit: 50 }],
      [publish, { organizationId, expectedVersion: 3, previewFingerprint: 'NOT-A-HASH' }],
      [pause, { organizationId, expectedVersion: 3, reason: 'x' }],
    ] as const
  ) await assertRejects(() => parseCommand(route, body));
});

Deno.test('dynamic-group list uses the scoped service RPC and rejects widened policy metadata', async () => {
  let widened = false;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            policies: [{
              policy_id: policyId,
              conversation_id: conversationId,
              conversation_name: 'Night quality team',
              conversation_kind: 'team',
              conversation_unit_id: teamId,
              status: 'active',
              version: 2,
              draft_state: 'published',
              policy_spec: policySpecSnake,
              maximum_members: 750,
              selector_fingerprint: selectorFingerprint,
              published_version_id: publishedVersionId,
              last_preview_fingerprint: previewFingerprint,
              last_previewed_at: '2026-08-04T20:00:00.000Z',
              last_synced_at: '2026-08-04T20:01:00.000Z',
              next_evaluation_at: '2026-08-05T08:00:00.000Z',
              source_changed_at: null,
              created_at: '2026-08-04T19:00:00.000Z',
              updated_at: '2026-08-04T20:01:00.000Z',
              ...(widened ? { member_emails: ['private@example.com'] } : {}),
            }],
            limit: 25,
            next_after_policy_id: null,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const route = matchRoute('POST', '/v2/dynamic-groups/policies/query');
  assert(route);
  const command = parseCommand(route, { organizationId, afterPolicyId: null, limit: 25 });
  const result = await executeCommand(route, command, rpcActor, '', 'd'.repeat(64));
  assertEquals(calls[0], {
    name: 'bff_list_dynamic_group_policies',
    args: {
      p_actor_user_id: actorId,
      p_organization_id: organizationId,
      p_session_id: sessionId,
      p_after_policy_id: null,
      p_limit: 25,
    },
  });
  assertEquals((result.body as { policies: unknown[] }).policies.length, 1);
  widened = true;
  await assertRejects(
    () => executeCommand(route, command, rpcActor, '', 'd'.repeat(64)),
    (error) => error instanceof ApiError && error.status === 503,
  );
});

Deno.test('save then preview call v2 RPCs and reject stale or overlapping receipts', async () => {
  let staleSave = false;
  let overlappingPreview = false;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (name === 'bff_save_dynamic_group_policy_v2') {
          return Promise.resolve({
            data: {
              policy_id: policyId,
              conversation_id: conversationId,
              version: staleSave ? 2 : 3,
              draft_state: 'draft',
              selector_fingerprint: selectorFingerprint,
              requires_preview: true,
              published_version_id: publishedVersionId,
            },
            error: null,
          });
        }
        return Promise.resolve({
          data: {
            policy_id: policyId,
            policy_version: 3,
            preview_fingerprint: previewFingerprint,
            selector_fingerprint: selectorFingerprint,
            membership_state_fingerprint: membershipFingerprint,
            evaluated_at: '2026-08-04T20:00:00.000Z',
            valid_until: '2026-08-04T20:05:00.000Z',
            eligible_count: 2,
            added_count: 1,
            removed_count: 1,
            unchanged_count: 1,
            added_sample_user_ids: [memberOne],
            removed_sample_user_ids: [overlappingPreview ? memberOne : actorId],
            unchanged_sample_user_ids: [memberTwo],
            next_boundary_at: '2026-08-05T08:00:00.000Z',
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const saveRoute = matchRoute('POST', '/v2/dynamic-groups/policies');
  const previewRoute = matchRoute('POST', `/v2/dynamic-groups/${policyId}/preview`);
  assert(saveRoute && previewRoute);
  const saveCommand = parseCommand(saveRoute, {
    organizationId,
    conversationId,
    policyId,
    expectedVersion: 2,
    policySpec,
    maximumMembers: 750,
  });
  const save = await executeCommand(
    saveRoute,
    saveCommand,
    rpcActor,
    'dynamic-group-save-0001',
    'd'.repeat(64),
  );
  assertEquals(save.status, 200);
  assertEquals(calls[0]?.name, 'bff_save_dynamic_group_policy_v2');
  assertEquals(calls[0]?.args.p_policy_spec, policySpecSnake);
  const previewRouteCommand = parseCommand(previewRoute, {
    organizationId,
    expectedVersion: 3,
    sampleLimit: 25,
  });
  const preview = await executeCommand(
    previewRoute,
    previewRouteCommand,
    rpcActor,
    '',
    'e'.repeat(64),
  );
  assertEquals(preview.status, 200);
  assertEquals(calls[1]?.name, 'bff_preview_dynamic_group_v2');
  assertEquals(calls[1]?.args.p_expected_version, 3);

  staleSave = true;
  await assertRejects(
    () =>
      executeCommand(
        saveRoute,
        saveCommand,
        rpcActor,
        'dynamic-group-save-0002',
        'f'.repeat(64),
      ),
    (error) => error instanceof ApiError && error.status === 503,
  );
  overlappingPreview = true;
  await assertRejects(
    () => executeCommand(previewRoute, previewRouteCommand, rpcActor, '', 'e'.repeat(64)),
    (error) => error instanceof ApiError && error.status === 503,
  );
});

Deno.test('publish binds the exact preview and pause binds exact version and reason', async () => {
  let widened = false;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: name === 'bff_publish_dynamic_group_policy'
            ? {
              policy_id: policyId,
              policy_version: 3,
              published_version_id: publishedVersionId,
              status: 'active',
              draft_state: 'published',
              eligible_count: 2,
              added_count: 1,
              removed_count: 1,
              unchanged_count: 1,
              selector_fingerprint: selectorFingerprint,
              next_evaluation_at: '2026-08-05T08:00:00.000Z',
              ...(widened ? { member_ids: [memberOne, memberTwo] } : {}),
            }
            : {
              policy_id: policyId,
              policy_version: 3,
              status: 'paused',
              paused_at: '2026-08-04T20:06:00.000Z',
            },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const publishRoute = matchRoute('POST', `/v2/dynamic-groups/${policyId}/publish`);
  const pauseRoute = matchRoute('POST', `/v2/dynamic-groups/${policyId}/pause`);
  assert(publishRoute && pauseRoute);
  const publishCommand = parseCommand(publishRoute, {
    organizationId,
    expectedVersion: 3,
    previewFingerprint,
  });
  await executeCommand(
    publishRoute,
    publishCommand,
    rpcActor,
    'dynamic-group-publish-0001',
    'f'.repeat(64),
  );
  assertEquals(calls[0]?.args.p_preview_fingerprint, previewFingerprint);
  assertEquals(calls[0]?.args.p_expected_version, 3);
  const pauseCommand = parseCommand(pauseRoute, {
    organizationId,
    expectedVersion: 3,
    reason: 'The roster source is under maintenance',
  });
  await executeCommand(
    pauseRoute,
    pauseCommand,
    rpcActor,
    'dynamic-group-pause-0001',
    '1'.repeat(64),
  );
  assertEquals(calls[1]?.args.p_reason, 'The roster source is under maintenance');
  widened = true;
  await assertRejects(
    () =>
      executeCommand(
        publishRoute,
        publishCommand,
        rpcActor,
        'dynamic-group-publish-0002',
        '2'.repeat(64),
      ),
    (error) => error instanceof ApiError && error.status === 503,
  );
});
