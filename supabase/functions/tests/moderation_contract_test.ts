import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError } from '../_shared/errors.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000010';
const sessionId = '00000000-0000-4000-8000-000000000020';
const conversationId = '00000000-0000-4000-8000-000000000030';
const caseId = '00000000-0000-4000-8000-000000000040';
const investigatorId = '00000000-0000-4000-8000-000000000050';

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

Deno.test('moderation routes require recent AAL2 and mutations require idempotency', () => {
  const routes = [
    matchRoute('POST', '/v2/moderation/cases/query'),
    matchRoute('POST', `/v2/moderation/cases/${caseId}/query`),
    matchRoute('POST', `/v2/moderation/cases/${caseId}/assign`),
    matchRoute('POST', `/v2/moderation/cases/${caseId}/claim`),
    matchRoute('POST', `/v2/moderation/cases/${caseId}/transition`),
  ];
  for (const route of routes) {
    assert(route);
    assertEquals(route.requireAal2, true);
    assertEquals(route.recentAuthSeconds, 300);
  }
  assertEquals(routes[0]?.idempotencyRequired, false);
  assertEquals(routes[1]?.idempotencyRequired, false);
  assertEquals(routes[2]?.idempotencyRequired, undefined);
  assertEquals(routes[3]?.idempotencyRequired, undefined);
  assertEquals(routes[4]?.idempotencyRequired, undefined);
});

Deno.test('message report parsing fails closed without exact versioned consent and bounded context', async () => {
  const route = matchRoute('POST', '/v2/messages/41/report');
  assert(route);
  const valid = {
    organizationId,
    conversationId,
    category: 'privacy',
    details: 'Operational report details.\nSecond line is permitted.',
    consentToShare: true,
    contextBefore: 2,
    contextAfter: 1,
    noticeVersion: 'moderation-report-v2',
  };
  const parsed = parseCommand(route, valid);
  assertEquals(parsed.values, {
    conversationId,
    messageId: '41',
    category: 'privacy',
    details: valid.details,
    consentToShare: true,
    contextBefore: 2,
    contextAfter: 1,
    noticeVersion: 'moderation-report-v2',
  });
  await assertRejects(() => parseCommand(route, { ...valid, consentToShare: false }));
  await assertRejects(() => parseCommand(route, { ...valid, noticeVersion: 'legacy' }));
  await assertRejects(() => parseCommand(route, { ...valid, contextBefore: 3 }));
  await assertRejects(() =>
    parseCommand(route, {
      ...valid,
      reporterUserId: actorId,
    })
  );
  assertEquals(
    parseCommand(route, { ...valid, noticeVersion: 'moderation-share-v1' }).values.noticeVersion,
    'moderation-share-v1',
  );
});

Deno.test('group and member reports accept only target-free v2 consent bodies', async () => {
  const groupRoute = matchRoute('POST', `/v2/conversations/${conversationId}/report`);
  const memberRoute = matchRoute('POST', `/v2/people/${investigatorId}/report`);
  assert(groupRoute && memberRoute);
  const valid = {
    organizationId,
    category: 'threat',
    details: 'Bounded safety details.',
    consentToShare: true,
    noticeVersion: 'moderation-report-v2',
  };
  assertEquals(parseCommand(groupRoute, valid).values, {
    conversationId,
    category: 'threat',
    details: valid.details,
    consentToShare: true,
    noticeVersion: 'moderation-report-v2',
  });
  assertEquals(parseCommand(memberRoute, valid).values, {
    subjectUserId: investigatorId,
    category: 'threat',
    details: valid.details,
    consentToShare: true,
    noticeVersion: 'moderation-report-v2',
  });
  for (const route of [groupRoute, memberRoute]) {
    await assertRejects(() => parseCommand(route, { ...valid, consentToShare: false }));
    await assertRejects(() => parseCommand(route, { ...valid, noticeVersion: 'moderation-share-v1' }));
    await assertRejects(() => parseCommand(route, { ...valid, contextBefore: 1 }));
    await assertRejects(() => parseCommand(route, { ...valid, targetLabel: 'client supplied' }));
  }
});

Deno.test('moderation case parsers reject expanded evidence metadata and invalid lifecycle input', async () => {
  const queryRoute = matchRoute('POST', '/v2/moderation/cases/query');
  const assignRoute = matchRoute('POST', `/v2/moderation/cases/${caseId}/assign`);
  const claimRoute = matchRoute('POST', `/v2/moderation/cases/${caseId}/claim`);
  const transitionRoute = matchRoute('POST', `/v2/moderation/cases/${caseId}/transition`);
  assert(queryRoute && assignRoute && claimRoute && transitionRoute);
  assertEquals(
    parseCommand(queryRoute, {
      organizationId,
      statuses: ['open', 'in_review'],
      cursor: {
        beforeUpdatedAt: '2026-08-04T12:00:00.000Z',
        beforeCaseId: caseId,
      },
      limit: 25,
    }).values.limit,
    25,
  );
  assertEquals(
    parseCommand(assignRoute, {
      organizationId,
      investigatorUserId: investigatorId,
      expectedVersion: 2,
      reason: 'Approved independent assignment.',
    }).values.investigatorUserId,
    investigatorId,
  );
  assertEquals(
    parseCommand(claimRoute, {
      organizationId,
      expectedVersion: 1,
      reason: 'Claimed under active scoped grant.',
    }).values.expectedVersion,
    1,
  );
  const transition = parseCommand(transitionRoute, {
    organizationId,
    status: 'resolved',
    expectedVersion: 3,
    reason: 'Resolved against the cited policy.',
    evidenceMetadata: {
      policyCode: 'AUP.4.2',
      severity: 'high',
      referenceIds: ['CASE-42'],
    },
  });
  assertEquals(transition.values.evidenceMetadata, {
    reference_ids: ['CASE-42'],
    policy_code: 'AUP.4.2',
    severity: 'high',
  });
  await assertRejects(() =>
    parseCommand(queryRoute, {
      organizationId,
      statuses: ['open', 'open'],
    })
  );
  await assertRejects(() =>
    parseCommand(transitionRoute, {
      organizationId,
      status: 'resolved',
      expectedVersion: 3,
      reason: 'No evidence metadata.',
      evidenceMetadata: {},
    })
  );
  await assertRejects(() =>
    parseCommand(transitionRoute, {
      organizationId,
      status: 'resolved',
      expectedVersion: 3,
      reason: 'Client tried to attach message text.',
      evidenceMetadata: { messageBody: 'must never pass' },
    })
  );
});

Deno.test('moderation commands map only to scoped RPC arguments', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const responses: Record<string, Record<string, unknown>> = {
    bff_report_target_v3: {
      report_id: caseId,
      status: 'open',
      target_type: 'message',
      created: true,
      reporter_identity_protected: true,
      target_not_notified: true,
      notice_version: 'moderation-report-v2',
      context_before: 1,
      context_after: 1,
    },
    bff_query_moderation_cases: {
      schema_version: 1,
      cases: [],
      next_cursor: null,
      content_included: false,
      reporter_identity_included: false,
      requires_explicit_assignment_for_evidence: true,
    },
    bff_read_moderation_case: { schema_version: 1, case: {}, scope: {} },
    bff_assign_moderation_case: {
      case_id: caseId,
      status: 'assigned',
      record_version: 2,
    },
    bff_claim_moderation_case: {
      case_id: caseId,
      status: 'assigned',
      record_version: 2,
    },
    bff_transition_moderation_case: {
      case_id: caseId,
      status: 'in_review',
      record_version: 3,
    },
  };
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        const data = responses[name];
        if (!data) return Promise.resolve({ data: null, error: { code: 'PGRST202' } });
        return Promise.resolve({ data, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const digest = 'a'.repeat(64);
  const commands: Array<{
    route: NonNullable<ReturnType<typeof matchRoute>>;
    body: Record<string, unknown>;
    key: string;
  }> = [];
  const add = (path: string, body: Record<string, unknown>, key: string) => {
    const route = matchRoute('POST', path);
    assert(route);
    commands.push({ route, body, key });
  };
  add('/v2/messages/41/report', {
    organizationId,
    conversationId,
    category: 'harassment',
    consentToShare: true,
    contextBefore: 1,
    contextAfter: 1,
    noticeVersion: 'moderation-report-v2',
  }, 'report-idempotency-0001');
  add(`/v2/conversations/${conversationId}/report`, {
    organizationId,
    category: 'harassment',
    consentToShare: true,
    noticeVersion: 'moderation-report-v2',
  }, 'group-report-idempotency-0001');
  add(`/v2/people/${investigatorId}/report`, {
    organizationId,
    category: 'harassment',
    consentToShare: true,
    noticeVersion: 'moderation-report-v2',
  }, 'member-report-idempotency-0001');
  add('/v2/moderation/cases/query', {
    organizationId,
    statuses: ['open'],
  }, '');
  add(`/v2/moderation/cases/${caseId}/query`, { organizationId }, '');
  add(`/v2/moderation/cases/${caseId}/assign`, {
    organizationId,
    investigatorUserId: investigatorId,
    expectedVersion: 1,
    reason: 'Independent assignment.',
  }, 'assign-idempotency-0001');
  add(`/v2/moderation/cases/${caseId}/claim`, {
    organizationId,
    expectedVersion: 1,
    reason: 'Scoped claim.',
  }, 'claim-idempotency-0001');
  add(`/v2/moderation/cases/${caseId}/transition`, {
    organizationId,
    status: 'in_review',
    expectedVersion: 2,
    reason: 'Review started.',
    evidenceMetadata: {},
  }, 'transition-idempotency-0001');
  for (const command of commands) {
    await executeCommand(
      command.route,
      parseCommand(command.route, command.body),
      rpcActor,
      command.key,
      digest,
    );
  }
  assertEquals(calls.map((call) => call.name), [
    'bff_report_target_v3',
    'bff_report_target_v3',
    'bff_report_target_v3',
    'bff_query_moderation_cases',
    'bff_read_moderation_case',
    'bff_assign_moderation_case',
    'bff_claim_moderation_case',
    'bff_transition_moderation_case',
  ]);
  assertEquals(calls[0]?.args.p_consent_to_share, true);
  assertEquals(calls[0]?.args.p_notice_version, 'moderation-report-v2');
  assertEquals(calls[0]?.args.p_target_type, 'message');
  assertEquals(calls[1]?.args.p_target_type, 'group');
  assertEquals(calls[1]?.args.p_context_before, 0);
  assertEquals(calls[1]?.args.p_context_after, 0);
  assertEquals(calls[2]?.args.p_target_type, 'member');
  assertEquals(calls[2]?.args.p_subject_user_id, investigatorId);
  assertEquals(calls[5]?.args.p_investigator_user_id, investigatorId);
  assertEquals(calls[7]?.args.p_evidence_metadata, {});
  assertEquals(new Set(calls.slice(0, 3).map((call) => call.args.p_request_sha256)).size, 3);
  for (const call of calls) {
    assertEquals(call.args.p_actor_user_id, actorId);
    assertEquals(call.args.p_organization_id, organizationId);
    assertEquals(call.args.p_session_id, sessionId);
    assert(!('p_reporter_user_id' in call.args));
  }
});

Deno.test('invalid moderation DTOs are reported as bad requests, not trusted dependency errors', async () => {
  const route = matchRoute('POST', `/v2/moderation/cases/${caseId}/assign`);
  assert(route);
  await assertRejects(
    () =>
      parseCommand(route, {
        organizationId,
        investigatorUserId: investigatorId,
        expectedVersion: 0,
        reason: 'No.',
      }),
    (error) => error instanceof ApiError && error.status === 400,
  );
});
