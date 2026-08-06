import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError, fromDatabaseError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  type ApiDependencies,
  createApiHandler,
  rateLimitOperation,
} from '../newone-api/handler.ts';
import {
  apiPath,
  configuredPublicAppUrl,
  executeCommand,
  type MatchedRoute,
  matchRoute,
  parseCommand,
  type ParsedCommand,
  type RouteKind,
} from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const actorUserId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const conversationId = '40000000-0000-4000-8000-000000000004';
const targetUserId = '50000000-0000-4000-8000-000000000005';
const requestId = '60000000-0000-4000-8000-000000000006';
const reportId = '70000000-0000-4000-8000-000000000007';
const exampleId = '80000000-0000-4000-8000-000000000008';

Deno.test('rate-limit operation aliases preserve command-specific policy buckets', () => {
  assertEquals(rateLimitOperation('conversation.direct'), 'conversation.direct.create');
  assertEquals(rateLimitOperation('conversation.group'), 'conversation.group.create');
  assertEquals(rateLimitOperation('attachment.grant'), 'attachment.upload.create');
  assertEquals(rateLimitOperation('message.send'), 'message.send');
});

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(['https://app.newone.example']),
  accessCookieName: 'newone_access',
  refreshCookieName: 'newone_refresh',
  csrfCookieName: 'newone_csrf',
  maxJsonBytes: 65536,
  networkHashKey: 'network-key-that-is-long-enough-123',
  cursorSigningKey: 'cursor-key-that-is-long-enough-1234',
  allowHttpLocal: false,
};

function route(kind: RouteKind, status: number): MatchedRoute {
  return { kind, status, template: `/coverage/${kind}`, params: {} };
}

function command(values: Record<string, unknown>): ParsedCommand {
  return { organizationId, values };
}

Deno.test('uncovered API command branches execute their exact scoped RPCs', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const actor = {
    user: { id: actorUserId },
    claims: { sub: actorUserId, sessionId, aal: 'aal2', issuedAt: 1, expiresAt: 9999999999 },
    token: 'token',
    userClient: {},
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: { rpc_name: name }, error: null });
      },
    },
  } as unknown as AuthenticatedActor;

  const cases: Array<{
    kind: RouteKind;
    status: number;
    rpc: string;
    values: Record<string, unknown>;
  }> = [
    {
      kind: 'conversation.direct',
      status: 201,
      rpc: 'bff_create_direct_conversation',
      values: { targetUserId },
    },
    {
      kind: 'conversation.update',
      status: 200,
      rpc: 'bff_update_conversation',
      values: { conversationId, patch: { name: 'Coverage' } },
    },
    {
      kind: 'organization.conversation_controls.update',
      status: 200,
      rpc: 'bff_update_organization_conversation_controls',
      values: {
        defaultJoinPolicy: 'approval_required',
        defaultGroupMemberLimit: 50,
        joinRequestExpiryDays: 7,
        maxPendingJoinRequestsPerUser: 4,
        reason: 'Coverage exercise',
      },
    },
    {
      kind: 'organization.policy.update',
      status: 200,
      rpc: 'bff_update_organization_policy',
      values: {
        messageRetentionDays: 365,
        allowMemberDirectMessages: true,
        dmPolicy: 'request_first',
        requireMfaForAdmins: true,
        shiftScheduleAuthoritative: false,
        groupCreationPolicy: 'managers',
        allowExternalGuests: true,
        externalGuestMaxAccessDays: 30,
        expectedVersion: 1,
        reason: 'Coverage exercise',
      },
    },
    {
      kind: 'conversation.controls.update',
      status: 200,
      rpc: 'bff_update_conversation_controls',
      values: {
        conversationId,
        postingMode: 'admins_only',
        joinPolicy: 'approval_required',
        visibility: 'organization',
        reason: 'Coverage exercise',
      },
    },
    {
      kind: 'conversation.join.request',
      status: 201,
      rpc: 'bff_request_conversation_join',
      values: { conversationId },
    },
    {
      kind: 'conversation.join.cancel',
      status: 200,
      rpc: 'bff_cancel_conversation_join_request',
      values: { requestId, expectedVersion: 1 },
    },
    {
      kind: 'conversation.join.decide',
      status: 200,
      rpc: 'bff_decide_conversation_join_request',
      values: { requestId, expectedVersion: 1, decision: 'approved', reason: 'Approved' },
    },
    {
      kind: 'conversation.discover.query',
      status: 200,
      rpc: 'bff_list_discoverable_conversations',
      values: { limit: 25 },
    },
    {
      kind: 'conversation.join.query',
      status: 200,
      rpc: 'bff_list_conversation_join_requests',
      values: { conversationId, limit: 25 },
    },
    {
      kind: 'conversation.member.add',
      status: 201,
      rpc: 'bff_add_conversation_member',
      values: { conversationId, targetUserId, role: 'admin' },
    },
    {
      kind: 'conversation.member.remove',
      status: 200,
      rpc: 'bff_remove_conversation_member',
      values: { conversationId, targetUserId },
    },
    {
      kind: 'ai_output.error.report',
      status: 201,
      rpc: 'bff_report_ai_output_error',
      values: {
        outputKind: 'translation',
        translationId: '42',
        summaryId: null,
        category: 'incorrect_meaning',
        details: 'Meaning changed',
        highConsequence: true,
        qualityUseConsent: false,
        consentVersion: 'consent-v1',
      },
    },
    {
      kind: 'ai_output.error_report.review',
      status: 200,
      rpc: 'bff_review_ai_output_error_report',
      values: { reportId, expectedVersion: 1, outcome: 'confirmed_error', reviewNote: 'Confirmed' },
    },
    {
      kind: 'ai_output.regression.propose',
      status: 201,
      rpc: 'bff_propose_ai_regression_example',
      values: {
        reportId,
        expectedReportVersion: 1,
        sourceLanguage: 'en',
        deidentifiedSourceText: 'Source text',
        deidentifiedObservedOutput: 'Observed text',
        deidentifiedExpectedOutput: 'Expected text',
        deidentificationAttested: true,
        attestationVersion: 'attestation-v1',
      },
    },
    {
      kind: 'ai_output.regression.decide',
      status: 200,
      rpc: 'bff_decide_ai_regression_example',
      values: { exampleId, expectedVersion: 1, decision: 'approved', decisionNote: 'Approved' },
    },
    {
      kind: 'attachment.state',
      status: 200,
      rpc: 'bff_get_attachment_state',
      values: { attachmentId: requestId },
    },
    {
      kind: 'member.list',
      status: 200,
      rpc: 'bff_list_admin_members',
      values: { afterUserId: null, limit: 50 },
    },
    {
      kind: 'member.suspend',
      status: 200,
      rpc: 'bff_suspend_member',
      values: { targetUserId, reason: 'Policy violation' },
    },
  ];

  for (const item of cases) {
    const before = calls.length;
    const result = await executeCommand(
      route(item.kind, item.status),
      command(item.values),
      actor,
      'coverage-idempotency-key',
      'a'.repeat(64),
    );
    assertEquals(result.status, item.status);
    assertEquals(calls[before]?.name, item.rpc);
  }

  await assertRejects(
    () =>
      executeCommand(
        route('conversation.member.role.update', 200),
        command({
          conversationId,
          targetUserId,
          expectedRole: 'member',
          newRole: 'admin',
        }),
        {
          ...actor,
          adminClient: {
            rpc() {
              return Promise.resolve({
                data: {
                  conversation_id: conversationId,
                  user_id: targetUserId,
                  previous_role: 'member',
                  role: 'owner',
                },
                error: null,
              });
            },
          },
        } as unknown as AuthenticatedActor,
        'coverage-idempotency-key',
        'b'.repeat(64),
      ),
    (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
  );

  await assertRejects(
    () =>
      executeCommand(
        {
          kind: 'not-a-route',
          status: 200,
          template: '/invalid',
          params: {},
        } as unknown as MatchedRoute,
        command({}),
        actor,
        '',
        'c'.repeat(64),
      ),
    (error) => error instanceof ApiError && error.code === 'internal_error',
  );
});

Deno.test('database idempotency unavailability is distinguished from other 55000 failures', () => {
  const idempotency = fromDatabaseError({
    code: '55000',
    message: 'idempotency key is unavailable',
  });
  assertEquals(idempotency.status, 409);
  assertEquals(idempotency.code, 'idempotency_conflict');

  const other = fromDatabaseError({ code: '55000', message: 'another prerequisite failed' });
  assertEquals(other.status, 503);
  assertEquals(other.code, 'dependency_unavailable');
});

Deno.test('uncovered route parsers accept exact DTOs and reject boundary expansion', async () => {
  const cases: Array<[string, string, Record<string, unknown>, RouteKind]> = [
    ['PATCH', `/v2/conversations/${conversationId}`, {
      organizationId,
      name: null,
      description: 'Description',
      isArchived: true,
    }, 'conversation.update'],
    ['PATCH', '/v2/admin/conversation-controls', {
      organizationId,
      defaultJoinPolicy: 'approval_required',
      defaultGroupMemberLimit: 50,
      joinRequestExpiryDays: 7,
      maxPendingJoinRequestsPerUser: 5,
      reason: 'Policy update',
    }, 'organization.conversation_controls.update'],
    ['PATCH', '/v2/admin/organization-policy', {
      organizationId,
      messageRetentionDays: 365,
      allowMemberDirectMessages: true,
      dmPolicy: 'request_first',
      requireMfaForAdmins: true,
      shiftScheduleAuthoritative: false,
      groupCreationPolicy: 'managers',
      allowExternalGuests: true,
      externalGuestMaxAccessDays: 30,
      expectedVersion: 1,
      reason: 'Policy update',
    }, 'organization.policy.update'],
    ['POST', `/v2/conversations/${conversationId}/join-requests`, {
      organizationId,
    }, 'conversation.join.request'],
    ['POST', `/v2/conversation-join-requests/${requestId}/cancel`, {
      organizationId,
      expectedVersion: 1,
    }, 'conversation.join.cancel'],
    ['POST', `/v2/conversation-join-requests/${requestId}/decision`, {
      organizationId,
      expectedVersion: 1,
      decision: 'rejected',
      reason: 'Not eligible',
    }, 'conversation.join.decide'],
    ['POST', `/v2/conversations/${conversationId}/join-requests/query`, {
      organizationId,
    }, 'conversation.join.query'],
    ['POST', `/v2/conversations/${conversationId}/members`, {
      organizationId,
      membershipId: targetUserId,
    }, 'conversation.member.add'],
    ['DELETE', `/v2/conversations/${conversationId}/members/${targetUserId}`, {
      organizationId,
    }, 'conversation.member.remove'],
    ['POST', `/v2/attachments/${requestId}/state`, { organizationId }, 'attachment.state'],
    ['POST', '/v2/admin/members/query', { organizationId }, 'member.list'],
    ['POST', `/v2/admin/members/${targetUserId}/suspend`, {
      organizationId,
      reason: 'Policy violation',
    }, 'member.suspend'],
  ];

  for (const [method, path, body, expectedKind] of cases) {
    const matched = matchRoute(method, path);
    assert(matched);
    assertEquals(matched.kind, expectedKind);
    assertEquals(parseCommand(matched, body).organizationId, organizationId);
  }

  assertEquals(apiPath('https://api.newone.example/v2'), '/v2');
  assertEquals(apiPath('https://api.newone.example/custom/path'), '/custom/path');
  assertEquals(
    apiPath('https://api.newone.example/functions/v1/newone-api/v2/health'),
    '/v2/health',
  );
  assertEquals(matchRoute('POST', `/v2/conversations/${conversationId}/members/%E0%A4%A`), null);

  const controls = matchRoute('PATCH', `/v2/conversations/${conversationId}/controls`);
  assert(controls);
  await assertRejects(() =>
    parseCommand(controls, { organizationId, reason: 'No fields changed' })
  );

  const update = matchRoute('PATCH', `/v2/conversations/${conversationId}`);
  assert(update);
  await assertRejects(() => parseCommand(update, { organizationId }));

  await assertRejects(() =>
    parseCommand(
      {
        kind: 'not-a-route',
        status: 200,
        template: '/invalid',
        params: {},
      } as unknown as MatchedRoute,
      { organizationId },
    )
  );

  assertEquals(
    configuredPublicAppUrl({ get: () => 'https://app.newone.example/' }),
    'https://app.newone.example',
  );
  for (const value of ['not a URL', 'http://app.newone.example', 'https://user@app.example']) {
    await assertRejects(() => configuredPublicAppUrl({ get: () => value }));
  }
});

function apiDependencies(overrides: Partial<ApiDependencies> = {}): ApiDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable-key',
      secretKey: 'server-secret',
    },
    readinessToken: 'readiness-token-that-is-at-least-32-characters',
    authenticateActor: async () =>
      ({
        user: { id: actorUserId },
        claims: {
          sub: actorUserId,
          sessionId,
          aal: 'aal2',
          issuedAt: 1,
          expiresAt: 9999999999,
        },
        token: 'access-token',
        userClient: {},
        adminClient: {},
      }) as unknown as AuthenticatedActor,
    authorize: async () => {},
    rateLimit: async () => {},
    execute: async () => ({ status: 200, body: { ok: true } }),
    ...overrides,
  };
}

Deno.test('API handler covers HEAD, preflight, readiness, unmatched, and safe audit-denial failures', async () => {
  const health = createApiHandler(() => apiDependencies());
  const head = await health(
    new Request('https://api.newone.example/v2/health', { method: 'HEAD' }),
  );
  assertEquals(head.status, 200);
  assertEquals(await head.text(), '');

  const insecure = await health(new Request('http://api.newone.example/v2/health'));
  assertEquals(insecure.status, 400);

  const missingReadiness = createApiHandler(() => apiDependencies({ readinessToken: null }));
  assertEquals(
    (await missingReadiness(new Request('https://api.newone.example/v2/ready'))).status,
    404,
  );

  const forbiddenReadiness = createApiHandler(() => apiDependencies());
  assertEquals(
    (await forbiddenReadiness(
      new Request('https://api.newone.example/v2/ready', {
        headers: { Origin: 'https://app.newone.example' },
      }),
    )).status,
    403,
  );

  const noCheck = createApiHandler(() => apiDependencies({ checkReadiness: undefined }));
  const readinessHeaders = {
    apikey: 'server-secret',
    'X-Newone-Readiness-Token': 'readiness-token-that-is-at-least-32-characters',
  };
  assertEquals(
    (await noCheck(
      new Request('https://api.newone.example/v2/ready', {
        headers: readinessHeaders,
      }),
    )).status,
    503,
  );
  assertEquals(
    (await noCheck(
      new Request('https://api.newone.example/v2/ready', {
        method: 'POST',
        headers: readinessHeaders,
      }),
    )).status,
    405,
  );

  const preflight = await createApiHandler(() => apiDependencies())(
    new Request('https://api.newone.example/v2/conversations/direct', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.newone.example',
        'Access-Control-Request-Method': 'POST',
      },
    }),
  );
  assertEquals(preflight.status, 204);

  const unmatched = await createApiHandler(() => apiDependencies())(
    new Request('https://api.newone.example/v2/does-not-exist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  assertEquals(unmatched.status, 404);

  let denialWrites = 0;
  const denial = createApiHandler(() =>
    apiDependencies({
      authorize: async (_actor, _org, policy) => {
        if (policy.requireAal2) throw new ApiError(403, 'forbidden');
      },
      recordAuditDenial: async () => {
        denialWrites += 1;
        throw new Error('audit sink unavailable');
      },
    })
  );
  const now = Date.now();
  const response = await denial(
    new Request('https://api.newone.example/v2/admin/audit/export', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'coverage-request',
      },
      body: JSON.stringify({
        organizationId,
        reasonCode: 'incident_investigation',
        format: 'json',
        dateFrom: new Date(now - 60_000).toISOString(),
        dateTo: new Date(now).toISOString(),
      }),
    }),
  );
  assertEquals(response.status, 403);
  assertEquals(denialWrites, 1);
});
