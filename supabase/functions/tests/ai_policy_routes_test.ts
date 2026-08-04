import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError } from '../_shared/errors.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000010';
const sessionId = '00000000-0000-4000-8000-000000000020';

Deno.test('AI policy query requires AAL2 while update defers enable-only freshness to SQL', () => {
  const read = matchRoute('POST', '/v2/admin/ai-policy/query');
  const update = matchRoute('PATCH', '/v2/admin/ai-policy');
  assert(read && update);
  assertEquals(read.kind, 'organization.ai_policy.read');
  assertEquals(update.kind, 'organization.ai_policy.update');
  assertEquals(read.requireAal2, true);
  assertEquals(update.requireAal2, true);
  assertEquals(read.recentAuthSeconds, undefined);
  assertEquals(update.recentAuthSeconds, undefined);
  assertEquals(read.idempotencyRequired, false);
  assertEquals(update.idempotencyRequired, undefined);
});

Deno.test('AI policy parser accepts only coherent exact provider-bound policies', async () => {
  const read = matchRoute('POST', '/v2/admin/ai-policy/query');
  const update = matchRoute('PATCH', '/v2/admin/ai-policy');
  assert(read && update);
  assertEquals(parseCommand(read, { organizationId }).values, {});
  assertEquals(parseCommand(update, {
    organizationId,
    enabled: true,
    approvedUseCases: ['translation', 'language_detection'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    expectedVersion: 0,
    reason: 'Approve the reviewed route.',
  }).values, {
    enabled: true,
    approvedUseCases: ['language_detection', 'translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    expectedVersion: 0,
    reason: 'Approve the reviewed route.',
  });
  assertEquals(parseCommand(update, {
    organizationId,
    enabled: false,
    approvedUseCases: [],
    providerAllowlist: [],
    routePolicy: 'deny',
    expectedVersion: 4,
    reason: 'Revoke AI egress.',
  }).values.routePolicy, 'deny');

  const base = {
    organizationId,
    enabled: true,
    approvedUseCases: ['translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    expectedVersion: 1,
    reason: 'Approve the reviewed route.',
  };
  for (const body of [
    { ...base, rawPrompt: 'secret' },
    { ...base, approvedUseCases: null },
    { ...base, providerAllowlist: null },
    { ...base, routePolicy: null },
    { ...base, approvedUseCases: [] },
    { ...base, providerAllowlist: [] },
    { ...base, providerAllowlist: ['Google-Vertex/us-south1'] },
    { ...base, providerAllowlist: ['google vertex/us-south1'] },
    { ...base, providerAllowlist: [`a${'x'.repeat(160)}`] },
    { ...base, providerAllowlist: ['/google-vertex'] },
    { ...base, providerAllowlist: ['google-vertex/us-south1', 'google-vertex/us-south1'] },
    { ...base, enabled: false, routePolicy: 'deny' },
    { ...base, expectedVersion: -1 },
  ]) await assertRejects(() => parseCommand(update, body));
});

Deno.test('AI policy commands map only exact public DTO fields to scoped RPC arguments', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    user: { id: actorId },
    claims: { sub: actorId, sessionId, aal: 'aal2', issuedAt: 1, expiresAt: 9999999999 },
    token: 'token',
    userClient: {},
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            organization_id: organizationId,
            enabled: true,
            policy_version: 3,
            approved_use_cases: ['translation'],
            provider_allowlist: ['google-vertex/us-south1'],
            route_policy: 'approved_zero_retention',
            tenant_approved: true,
            global_kill_switch_still_required: true,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const read = matchRoute('POST', '/v2/admin/ai-policy/query');
  const update = matchRoute('PATCH', '/v2/admin/ai-policy');
  assert(read && update);
  const readResult = await executeCommand(
    read,
    parseCommand(read, { organizationId }),
    rpcActor,
    '',
    'a'.repeat(64),
  );
  const updateResult = await executeCommand(update, parseCommand(update, {
    organizationId,
    enabled: true,
    approvedUseCases: ['translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    expectedVersion: 2,
    reason: 'Approve the reviewed route.',
  }), rpcActor, 'ai-policy-key-0001', 'b'.repeat(64));
  assertEquals(readResult.body, {
    organizationId,
    enabled: true,
    policyVersion: 3,
    approvedUseCases: ['translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    tenantApproved: true,
    globalKillSwitchStillRequired: true,
  });
  assertEquals(updateResult.body, readResult.body);
  assertEquals(calls.map((call) => call.name), [
    'bff_get_organization_ai_policy',
    'bff_set_organization_ai_policy_v2',
  ]);
  assertEquals(calls[0]?.args, {
    p_actor_user_id: actorId,
    p_organization_id: organizationId,
    p_session_id: sessionId,
  });
  assertEquals(calls[1]?.args, {
    p_actor_user_id: actorId,
    p_organization_id: organizationId,
    p_session_id: sessionId,
    p_idempotency_key: 'ai-policy-key-0001',
    p_request_sha256: 'b'.repeat(64),
    p_enabled: true,
    p_approved_use_cases: ['translation'],
    p_provider_allowlist: ['google-vertex/us-south1'],
    p_route_policy: 'approved_zero_retention',
    p_expected_version: 2,
    p_reason: 'Approve the reviewed route.',
  });
});

Deno.test('AI policy Edge response fails closed before cross-tenant or extra fields can leave the server', async () => {
  const read = matchRoute('POST', '/v2/admin/ai-policy/query');
  const update = matchRoute('PATCH', '/v2/admin/ai-policy');
  assert(read && update);
  const baseReceipt = {
    organization_id: organizationId,
    enabled: true,
    policy_version: 3,
    approved_use_cases: ['translation'],
    provider_allowlist: ['google-vertex/us-south1'],
    route_policy: 'approved_zero_retention',
    tenant_approved: true,
    global_kill_switch_still_required: true,
  };
  const actorFor = (data: Record<string, unknown>) => ({
    user: { id: actorId },
    claims: { sub: actorId, sessionId, aal: 'aal2', issuedAt: 1, expiresAt: 9999999999 },
    token: 'token',
    userClient: {},
    adminClient: {
      rpc: () => Promise.resolve({ data, error: null }),
    },
  } as unknown as AuthenticatedActor);
  for (const data of [
    { ...baseReceipt, organization_id: '00000000-0000-4000-8000-000000000099' },
    { ...baseReceipt, private_internal_note: 'must not leave the Edge boundary' },
  ]) {
    await assertRejects(
      () => executeCommand(
        read,
        parseCommand(read, { organizationId }),
        actorFor(data),
        '',
        'c'.repeat(64),
      ),
      (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
    );
  }
  await assertRejects(
    () => executeCommand(update, parseCommand(update, {
      organizationId,
      enabled: true,
      approvedUseCases: ['translation'],
      providerAllowlist: ['google-vertex/us-south1'],
      routePolicy: 'approved_zero_retention',
      expectedVersion: 2,
      reason: 'Approve the reviewed route.',
    }), actorFor({ ...baseReceipt, policy_version: 4 }), 'ai-policy-key-0002', 'd'.repeat(64)),
    (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
  );
});
