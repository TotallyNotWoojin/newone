import type { AuthenticatedActor } from '../_shared/clients.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import { type ApiDependencies, createApiHandler } from '../newone-api/handler.ts';
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

Deno.test('public health is sanitized and does not initialize privileged dependencies', async () => {
  let initialized = false;
  const handler = createApiHandler(() => {
    initialized = true;
    throw new Error('should not initialize');
  });
  const response = await handler(new Request('https://api.newone.example/v2/health'));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { service: 'newone-api', version: 'v2', status: 'ok' });
  assertEquals(response.headers.get('cache-control'), 'no-store');
  assertEquals(initialized, false);
});

Deno.test('readiness is service-authenticated and checks database dependencies', async () => {
  let checks = 0;
  const handler = createApiHandler(() => ({
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'pk',
      secretKey: 'server-secret',
    },
    readinessToken: 'readiness-token-that-is-at-least-32-characters',
    checkReadiness: async () => {
      checks += 1;
    },
    authenticateActor: async () => actor,
    authorize: async () => {},
    rateLimit: async () => {},
    execute: async () => ({ status: 200, body: {} }),
  }));
  const url = 'https://api.newone.example/v2/ready';
  assertEquals((await handler(new Request(url))).status, 401);
  assertEquals(checks, 0);
  const response = await handler(
    new Request(url, {
      headers: {
        apikey: 'server-secret',
        'X-Newone-Readiness-Token': 'readiness-token-that-is-at-least-32-characters',
      },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    service: 'newone-api',
    version: 'v2',
    status: 'ready',
    checks: { database: 'ok' },
  });
  assertEquals(checks, 1);
});

Deno.test('API handler authenticates, authorizes, rate limits, validates, and returns no-store responses', async () => {
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
    authorize: async (_actor, _org, policy) => {
      calls.push(`authorize:${policy.operation}`);
    },
    rateLimit: async (_request, _config, _actor, _org, operation) => {
      calls.push(`rate:${operation}`);
    },
    execute: async (route, command, _actor, key) => {
      calls.push(`execute:${route.kind}:${key}:${command.values.targetUserId}`);
      return { status: 201, body: { conversation: { id: 'test' } } };
    },
  };
  const handler = createApiHandler(() => dependencies);
  const response = await handler(
    new Request(
      'https://api.newone.example/functions/v1/newone-api/v2/conversations/direct',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'request-0001',
          Origin: 'https://app.newone.example',
        },
        body: JSON.stringify({
          organizationId: '00000000-0000-4000-8000-000000000001',
          targetMembershipId: '00000000-0000-4000-8000-000000000002',
        }),
      },
    ),
  );
  assertEquals(response.status, 201);
  assertEquals(response.headers.get('cache-control'), 'private, no-store');
  assertEquals(response.headers.get('access-control-allow-origin'), 'https://app.newone.example');
  assertEquals(calls, [
    'auth:access-token',
    'authorize:conversation.direct',
    'rate:conversation.direct.create',
    'execute:conversation.direct:request-0001:00000000-0000-4000-8000-000000000002',
  ]);
});

Deno.test('unknown privileged fields are rejected before authentication', async () => {
  let authenticated = false;
  const handler = createApiHandler(() => ({
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'pk',
      secretKey: 'sk',
    },
    authenticateActor: async () => {
      authenticated = true;
      return actor;
    },
    authorize: async () => {},
    rateLimit: async () => {},
    execute: async () => ({ status: 200, body: {} }),
  }));
  const response = await handler(
    new Request('https://api.newone.example/v2/conversations/direct', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'request-0001',
      },
      body: JSON.stringify({
        organizationId: '00000000-0000-4000-8000-000000000001',
        targetMembershipId: '00000000-0000-4000-8000-000000000002',
        role: 'owner',
      }),
    }),
  );
  assertEquals(response.status, 400);
  assert(!authenticated);
});

Deno.test('server-derived translation routing never accepts client-selected targets', async () => {
  const route = matchRoute(
    'POST',
    '/v2/conversations/00000000-0000-4000-8000-000000000030/messages',
  );
  assert(route);
  const command = parseCommand(route, {
    organizationId: '00000000-0000-4000-8000-000000000001',
    clientMessageId: '00000000-0000-4000-8000-000000000040',
    kind: 'text',
    body: 'Original survives.',
    languageCode: 'en',
    mentionUserIds: ['00000000-0000-4000-8000-000000000050'],
  });
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      clientMessageId: '00000000-0000-4000-8000-000000000041',
      kind: 'text',
      body: 'Do not let clients expand AI routing.',
      translationTargets: ['ko'],
    })
  );
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      clientMessageId: '00000000-0000-4000-8000-000000000041',
      kind: 'attachment',
      metadata: { fileName: 'client-chosen.pdf', mimeType: 'application/pdf' },
    })
  );
  const calls: string[] = [];
  const rpcClient = {
    rpc(name: string) {
      calls.push(name);
      if (name === 'bff_send_message') {
        return Promise.resolve({
          data: {
            message_id: '101',
            client_nonce: '00000000-0000-4000-8000-000000000040',
            translation_targets: ['ko'],
            original_committed: true,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { code: 'PGRST202' } });
    },
  };
  const rpcActor = { ...actor, adminClient: rpcClient } as unknown as AuthenticatedActor;
  const result = await executeCommand(
    route,
    command,
    rpcActor,
    'message-request-001',
    'a'.repeat(64),
  );
  assertEquals(result.status, 201);
  assertEquals(result.body, {
    messageId: '101',
    clientMessageId: '00000000-0000-4000-8000-000000000040',
    originalCommitted: true,
    translationTargets: ['ko'],
  });
  assertEquals(calls, ['bff_send_message']);
  assertEquals(command.values.metadata, {
    mentionUserIds: ['00000000-0000-4000-8000-000000000050'],
  });
});

Deno.test('translation retry, correction, and summary commands map only to authoritative RPCs', async () => {
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const correctionId = '00000000-0000-4000-8000-000000000060';
  const summaryId = '00000000-0000-4000-8000-000000000070';
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const responses: Record<string, Record<string, unknown>> = {
    bff_enqueue_translation: {
      translation_id: '501',
      status: 'queued',
      retried: true,
    },
    bff_propose_translation_correction: { correction_id: correctionId, status: 'pending' },
    bff_review_translation_correction: {
      correction_id: correctionId,
      decision: 'approved',
      reviewed_at: '2026-08-04T12:00:00Z',
    },
    bff_request_conversation_summary: {
      summary_id: summaryId,
      version_number: 1,
      status: 'queued',
      source_fingerprint: 'a'.repeat(64),
      deduplicated: false,
    },
    bff_request_conversation_summary_scope: {
      summary_id: summaryId,
      version_number: 2,
      status: 'queued',
      source_fingerprint: 'a'.repeat(64),
      source_message_count: 143,
      scope_kind: 'last_7_days',
      scope_subject: 'the trip',
      deduplicated: false,
    },
    bff_create_manual_summary: {
      summary_id: summaryId,
      version_number: 2,
      status: 'draft',
      output_fingerprint: 'b'.repeat(64),
    },
    bff_review_conversation_summary: {
      summary_id: summaryId,
      status: 'approved',
      human_reviewed: true,
    },
    bff_set_summary_policy: {
      conversation_id: conversationId,
      mode: 'message_count',
      message_count_threshold: 50,
      human_review_required: true,
      automatic_publish: false,
    },
  };
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: responses[name], error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const cases = [
    {
      method: 'POST',
      path: '/v2/messages/101/translations',
      body: { organizationId, conversationId, targetLanguage: 'ko' },
      rpc: 'bff_enqueue_translation',
    },
    {
      method: 'POST',
      path: '/v2/messages/101/translations/ko/corrections',
      body: {
        organizationId,
        conversationId,
        correctedBody: '검토된 번역',
        rationale: 'Safety term',
      },
      rpc: 'bff_propose_translation_correction',
    },
    {
      method: 'POST',
      path: `/v2/translation-corrections/${correctionId}/review`,
      body: { organizationId, decision: 'approved', note: 'Terminology checked' },
      rpc: 'bff_review_translation_correction',
    },
    {
      method: 'POST',
      path: `/v2/conversations/${conversationId}/summaries`,
      body: { organizationId, sourceMessageIds: ['101', '102'], languageCode: 'es' },
      rpc: 'bff_request_conversation_summary',
    },
    {
      // v3.1: the reader names a range and a subject; the server picks the messages.
      method: 'POST',
      path: `/v2/conversations/${conversationId}/summaries`,
      body: {
        organizationId,
        languageCode: 'en',
        range: { kind: 'last_7_days', subject: '  the trip ', fromMessageId: null, utcOffsetMinutes: 540 },
      },
      rpc: 'bff_request_conversation_summary_scope',
    },
    {
      method: 'POST',
      path: `/v2/conversations/${conversationId}/summaries/manual`,
      body: {
        organizationId,
        sourceMessageIds: ['101', '102'],
        languageCode: 'es',
        primaryTopic: 'Cambio de turno',
        summary: 'La línea se detuvo y requiere inspección.',
        keyTopics: ['Línea 4'],
        decisions: [{ text: 'Detener la línea', sourceMessageIds: ['101'] }],
        actionItems: [{ text: 'Inspeccionar', sourceMessageIds: ['102'], owner: null, due: null }],
        ambiguities: ['Hora de reinicio'],
      },
      rpc: 'bff_create_manual_summary',
    },
    {
      method: 'POST',
      path: `/v2/summaries/${summaryId}/review`,
      body: { organizationId, decision: 'approve', note: 'Sources checked' },
      rpc: 'bff_review_conversation_summary',
    },
    {
      method: 'PUT',
      path: `/v2/conversations/${conversationId}/summary-policy`,
      body: { organizationId, mode: 'message_count', messageCountThreshold: 50 },
      rpc: 'bff_set_summary_policy',
    },
  ];
  const results = [];
  for (const [index, item] of cases.entries()) {
    const route = matchRoute(item.method, item.path);
    assert(route);
    results.push(
      await executeCommand(
        route,
        parseCommand(route, item.body),
        rpcActor,
        `translation-summary-${index}`,
        String(index).repeat(64),
      ),
    );
  }
  assertEquals(calls.map((call) => call.name), cases.map((item) => item.rpc));
  assertEquals(results[0]?.body, { translationId: '501', status: 'queued', retried: true });
  assertEquals(calls[4]?.args.p_scope_kind, 'last_7_days');
  assertEquals(calls[4]?.args.p_scope_subject, 'the trip');
  assertEquals(calls[4]?.args.p_from_message_id, null);
  assertEquals(calls[4]?.args.p_utc_offset_minutes, 540);
  assertEquals(calls[4]?.args.p_language_code, 'en');
  assertEquals('p_source_message_ids' in (calls[4]?.args ?? {}), false);
  assertEquals(results[4]?.body, {
    summaryId,
    versionNumber: 2,
    status: 'queued',
    sourceFingerprint: 'a'.repeat(64),
    sourceMessageCount: 143,
    scopeKind: 'last_7_days',
    scopeSubject: 'the trip',
    deduplicated: false,
  });
  assertEquals(calls[5]?.args.p_decisions, [{
    text: 'Detener la línea',
    source_message_ids: ['101'],
  }]);
  assertEquals(calls[5]?.args.p_action_items, [{
    text: 'Inspeccionar',
    source_message_ids: ['102'],
    owner: null,
    due: null,
  }]);
  assertEquals(calls[7]?.args.p_message_count_threshold, 50);
  for (const call of calls) {
    assertEquals(call.args.p_actor_user_id, actor.user.id);
    assertEquals(call.args.p_session_id, actor.claims.sessionId);
    assertEquals(call.args.p_organization_id, organizationId);
  }
});

Deno.test('summary and translation routes reject client policy expansion and unsupported evidence', async () => {
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const summaryId = '00000000-0000-4000-8000-000000000070';
  const translationRoute = matchRoute('POST', '/v2/messages/101/translations');
  const requestRoute = matchRoute('POST', `/v2/conversations/${conversationId}/summaries`);
  const manualRoute = matchRoute('POST', `/v2/conversations/${conversationId}/summaries/manual`);
  const reviewRoute = matchRoute('POST', `/v2/summaries/${summaryId}/review`);
  const policyRoute = matchRoute('PUT', `/v2/conversations/${conversationId}/summary-policy`);
  assert(translationRoute && requestRoute && manualRoute && reviewRoute && policyRoute);
  await assertRejects(() =>
    parseCommand(translationRoute, {
      organizationId,
      conversationId,
      targetLanguage: 'ko',
      provider: 'client-chosen',
    })
  );
  await assertRejects(() =>
    parseCommand(requestRoute, {
      organizationId,
      sourceMessageIds: ['101', '101'],
      languageCode: 'es',
    })
  );
  // A range request names one of the five ranges, never message ids as well,
  // with a subject of at most 200 characters and a plausible UTC offset.
  for (
    const range of [
      { kind: 'someday' },
      { kind: 'today', subject: 'x'.repeat(201) },
      { kind: 'today', utcOffsetMinutes: 901 },
      { kind: 'unread', fromMessageId: 'abc' },
      { kind: 'today', extra: true },
    ]
  ) {
    await assertRejects(() => parseCommand(requestRoute, { organizationId, languageCode: 'es', range }));
  }
  await assertRejects(() =>
    parseCommand(requestRoute, {
      organizationId,
      languageCode: 'es',
      sourceMessageIds: ['101'],
      range: { kind: 'today' },
    })
  );
  const unread = parseCommand(requestRoute, {
    organizationId,
    languageCode: 'es',
    range: { kind: 'unread', fromMessageId: '9007199254740993', subject: null },
  });
  assertEquals(unread.values.range, {
    kind: 'unread',
    subject: null,
    fromMessageId: '9007199254740993',
    utcOffsetMinutes: 0,
  });
  await assertRejects(() =>
    parseCommand(manualRoute, {
      organizationId,
      sourceMessageIds: ['101'],
      languageCode: 'es',
      primaryTopic: 'Topic',
      summary: 'Summary',
      keyTopics: [],
      decisions: [{ text: 'Unsupported', sourceMessageIds: ['999'] }],
      actionItems: [],
      ambiguities: [],
    })
  );
  await assertRejects(() =>
    parseCommand(reviewRoute, {
      organizationId,
      decision: 'reject',
      note: 'x',
    })
  );
  await assertRejects(() =>
    parseCommand(policyRoute, {
      organizationId,
      mode: 'message_count',
    })
  );
  await assertRejects(() =>
    parseCommand(policyRoute, {
      organizationId,
      mode: 'manual',
      messageCountThreshold: 50,
    })
  );
});

Deno.test('message and contact mutations use only transactional command RPCs', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    userClient: new Proxy({}, {
      get() {
        throw new Error('direct user-client access is forbidden for commands');
      },
    }),
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: { ok: true }, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const cases = [
    {
      method: 'PATCH',
      path: '/v2/messages/101',
      body: {
        organizationId: '00000000-0000-4000-8000-000000000001',
        conversationId: '00000000-0000-4000-8000-000000000030',
        body: 'edited',
      },
      rpc: 'bff_edit_message',
    },
    {
      method: 'PATCH',
      path: '/v2/messages/101',
      body: {
        organizationId: '00000000-0000-4000-8000-000000000001',
        conversationId: '00000000-0000-4000-8000-000000000030',
        delete: true,
      },
      rpc: 'bff_delete_message',
    },
    {
      method: 'POST',
      path: '/v2/messages/101/reactions',
      body: {
        organizationId: '00000000-0000-4000-8000-000000000001',
        conversationId: '00000000-0000-4000-8000-000000000030',
        emoji: '👍',
        active: false,
      },
      rpc: 'bff_remove_message_reaction',
    },
    {
      method: 'POST',
      path: '/v2/contacts/connections',
      body: {
        organizationId: '00000000-0000-4000-8000-000000000001',
        targetMembershipId: '00000000-0000-4000-8000-000000000050',
      },
      rpc: 'bff_request_contact',
    },
    {
      method: 'POST',
      path: '/v2/contacts/connections/00000000-0000-4000-8000-000000000050/respond',
      body: {
        organizationId: '00000000-0000-4000-8000-000000000001',
        decision: 'accepted',
      },
      rpc: 'bff_respond_contact',
    },
    {
      method: 'DELETE',
      path: '/v2/contacts/connections/00000000-0000-4000-8000-000000000050',
      body: { organizationId: '00000000-0000-4000-8000-000000000001' },
      rpc: 'bff_remove_contact',
    },
    {
      method: 'PATCH',
      path: '/v2/contacts/saved/00000000-0000-4000-8000-000000000050',
      body: { organizationId, alias: 'Night shift lead', isFavorite: true },
      rpc: 'bff_update_saved_contact',
    },
    {
      method: 'DELETE',
      path: '/v2/contacts/saved/00000000-0000-4000-8000-000000000050',
      body: { organizationId },
      rpc: 'bff_remove_saved_contact',
    },
    {
      method: 'PUT',
      path: '/v2/people/00000000-0000-4000-8000-000000000050/block',
      body: { organizationId },
      rpc: 'bff_set_member_block',
    },
    {
      method: 'DELETE',
      path: '/v2/people/00000000-0000-4000-8000-000000000050/block',
      body: { organizationId },
      rpc: 'bff_set_member_block',
    },
  ];

  for (const [index, item] of cases.entries()) {
    const route = matchRoute(item.method, item.path);
    assert(route);
    const command = parseCommand(route, item.body);
    await executeCommand(route, command, rpcActor, `command-${index}-0001`, 'a'.repeat(64));
  }

  assertEquals(calls.map((call) => call.name), cases.map((item) => item.rpc));
  for (const call of calls) {
    assertEquals(call.args.p_actor_user_id, actor.user.id);
    assertEquals(call.args.p_session_id, actor.claims.sessionId);
    assertEquals(call.args.p_organization_id, '00000000-0000-4000-8000-000000000001');
  }
});

Deno.test('Must workflow routes map strict public inputs to atomic database RPCs', async () => {
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const entityId = '00000000-0000-4000-8000-000000000080';
  const cases = [
    {
      path: '/v2/preferences/organization',
      method: 'PATCH',
      body: {
        organizationId,
        uiLanguage: 'ko',
        messageLanguage: null,
        timeZone: 'America/Los_Angeles',
        quietHoursStart: '22:00',
        quietHoursEnd: '06:30',
        quietDays: [6, 0],
        notificationPreview: 'generic',
        soundEnabled: true,
        vibrationEnabled: false,
        shiftAwareSuppression: true,
        readVisibility: 'contacts',
      },
      rpc: 'bff_update_organization_preferences',
    },
    {
      path: `/v2/conversations/${conversationId}/preferences`,
      method: 'PATCH',
      body: { organizationId, isArchived: true, notificationLevel: 'mentions' },
      rpc: 'bff_update_conversation_preferences',
    },
    {
      path: '/v2/messages/101/pin',
      method: 'POST',
      body: { organizationId, conversationId, pinned: true },
      rpc: 'bff_set_message_pin',
    },
    {
      path: '/v2/messages/101/receipt',
      method: 'POST',
      body: { organizationId, conversationId, state: 'read' },
      rpc: 'bff_mark_message_receipt',
    },
    {
      path: '/v2/messages/101/hide',
      method: 'POST',
      body: { organizationId, conversationId },
      rpc: 'bff_hide_message_for_me',
    },
    {
      path: '/v2/messages/101/forward',
      method: 'POST',
      body: {
        organizationId,
        sourceConversationId: conversationId,
        targetConversationId: '00000000-0000-4000-8000-000000000031',
        clientMessageId: '00000000-0000-4000-8000-000000000082',
      },
      rpc: 'bff_forward_message',
    },
    {
      path: '/v2/messages/101/translations/ko/corrections',
      method: 'POST',
      body: { organizationId, conversationId, correctedBody: '교정', rationale: 'Terminology' },
      rpc: 'bff_propose_translation_correction',
    },
    {
      path: `/v2/translation-corrections/${entityId}/review`,
      method: 'POST',
      body: { organizationId, decision: 'approved', note: 'Verified' },
      rpc: 'bff_review_translation_correction',
    },
    {
      path: `/v2/updates/${entityId}/corrections`,
      method: 'POST',
      body: {
        organizationId,
        clientMessageId: '00000000-0000-4000-8000-000000000081',
        title: 'Corrected update',
        body: 'Corrected details',
        priority: 'important',
        requiresAcknowledgement: true,
        expiresAt: null,
        reason: 'Incorrect instruction',
      },
      rpc: 'bff_correct_announcement',
    },
    {
      path: `/v2/handoffs/${entityId}/corrections`,
      method: 'POST',
      body: {
        organizationId,
        expectedVersionId: '00000000-0000-4000-8000-000000000099',
        expectedVersionNumber: 3,
        title: 'Corrected handoff',
        details: 'Corrected operational details',
        sourceLanguage: 'en',
        shiftStartedAt: '2026-08-03T08:00:00Z',
        shiftEndedAt: '2026-08-03T16:00:00Z',
        reason: 'Wrong pressure value',
      },
      rpc: 'bff_correct_handoff_v2',
    },
    {
      path: '/v2/actions/proposals',
      method: 'POST',
      body: { organizationId, conversationId, sourceMessageId: '101', title: 'Inspect pump' },
      rpc: 'bff_propose_operational_action',
    },
    {
      path: `/v2/actions/${entityId}/confirm`,
      method: 'POST',
      body: { organizationId, assigneeMembershipId: actor.user.id, dueAt: null },
      rpc: 'bff_confirm_operational_action',
    },
    {
      path: `/v2/actions/${entityId}/status`,
      method: 'POST',
      body: { organizationId, status: 'in_progress', note: 'Started' },
      rpc: 'bff_transition_operational_action',
    },
    {
      path: '/v2/dynamic-groups/policies',
      method: 'POST',
      body: {
        organizationId,
        conversationId,
        policyId: null,
        expectedVersion: 0,
        policySpec: {
          siteIds: [],
          departmentIds: [],
          teamIds: [],
          lineIds: [],
          unitIds: [],
          includeDescendants: true,
          operationalRoles: [],
          membershipRoles: ['manager', 'member'],
          shiftMode: 'none',
          scheduledShiftStartsAt: null,
          scheduledShiftEndsAt: null,
        },
        maximumMembers: 500,
      },
      rpc: 'bff_save_dynamic_group_policy_v2',
    },
    {
      path: `/v2/dynamic-groups/${entityId}/preview`,
      method: 'POST',
      body: { organizationId, expectedVersion: 1, sampleLimit: 25 },
      rpc: 'bff_preview_dynamic_group_v2',
    },
    {
      path: `/v2/dynamic-groups/${entityId}/publish`,
      method: 'POST',
      body: { organizationId, expectedVersion: 1, previewFingerprint: 'd'.repeat(64) },
      rpc: 'bff_publish_dynamic_group_policy',
    },
    {
      path: `/v2/dynamic-groups/${entityId}/pause`,
      method: 'POST',
      body: { organizationId, expectedVersion: 1, reason: 'Shift policy retired' },
      rpc: 'bff_pause_dynamic_group_policy',
    },
    {
      path: '/v2/glossary/proposals',
      method: 'POST',
      body: {
        organizationId,
        termId: null,
        sourceLanguage: 'en',
        targetLanguage: 'ko',
        sourceTerm: 'lockout',
        translatedTerm: '잠금',
        definition: 'Safety isolation procedure',
        reason: null,
      },
      rpc: 'bff_propose_glossary_term',
    },
    {
      path: `/v2/glossary/versions/${entityId}/review`,
      method: 'POST',
      body: { organizationId, decision: 'changes_requested', note: 'Clarify context' },
      rpc: 'bff_review_glossary_version',
    },
    {
      path: '/v2/admin/role-assignments',
      method: 'POST',
      body: {
        organizationId,
        targetMembershipId: actor.user.id,
        roleName: 'site_admin',
        scopeType: 'unit',
        unitId: entityId,
        expiresAt: '2030-08-03T16:00:00Z',
        reason: 'Delegated site administration',
      },
      rpc: 'bff_grant_role_assignment',
    },
    {
      path: `/v2/admin/role-assignments/${entityId}/revoke`,
      method: 'POST',
      body: { organizationId, reason: 'Assignment no longer required' },
      rpc: 'bff_revoke_role_assignment',
    },
    {
      path: '/v2/admin/role-assignments/query',
      method: 'POST',
      body: { organizationId, targetMembershipId: actor.user.id, limit: 25 },
      rpc: 'bff_list_role_assignments',
    },
  ];
  const called: string[] = [];
  const adminClient = {
    rpc(name: string, args: Record<string, unknown>) {
      called.push(name);
      const dynamicData = name === 'bff_save_dynamic_group_policy_v2'
        ? {
          policy_id: entityId,
          conversation_id: conversationId,
          version: 1,
          draft_state: 'draft',
          selector_fingerprint: 'c'.repeat(64),
          requires_preview: true,
          published_version_id: null,
        }
        : name === 'bff_preview_dynamic_group_v2'
        ? {
          policy_id: args.p_policy_id,
          policy_version: args.p_expected_version,
          preview_fingerprint: 'd'.repeat(64),
          selector_fingerprint: 'c'.repeat(64),
          membership_state_fingerprint: 'e'.repeat(64),
          evaluated_at: '2026-08-04T20:00:00.000Z',
          valid_until: '2026-08-04T20:05:00.000Z',
          eligible_count: 1,
          added_count: 1,
          removed_count: 0,
          unchanged_count: 0,
          added_sample_user_ids: [actor.user.id],
          removed_sample_user_ids: [],
          unchanged_sample_user_ids: [],
          next_boundary_at: null,
        }
        : name === 'bff_publish_dynamic_group_policy'
        ? {
          policy_id: args.p_policy_id,
          policy_version: args.p_expected_version,
          published_version_id: '00000000-0000-4000-8000-000000000081',
          status: 'active',
          draft_state: 'published',
          eligible_count: 1,
          added_count: 1,
          removed_count: 0,
          unchanged_count: 0,
          selector_fingerprint: 'c'.repeat(64),
          next_evaluation_at: null,
        }
        : name === 'bff_pause_dynamic_group_policy'
        ? {
          policy_id: args.p_policy_id,
          policy_version: args.p_expected_version,
          status: 'paused',
          paused_at: '2026-08-04T20:06:00.000Z',
        }
        : null;
      return Promise.resolve({
        data: dynamicData ?? (name === 'bff_update_conversation_preferences'
          ? { conversation_id: conversationId, is_hidden: true }
          : { ok: true }),
        error: null,
      });
    },
  };
  for (const [index, item] of cases.entries()) {
    const route = matchRoute(item.method, item.path);
    assert(route);
    const command = parseCommand(route, item.body);
    await executeCommand(
      route,
      command,
      { ...actor, adminClient } as unknown as AuthenticatedActor,
      route.idempotencyRequired === false ? '' : `must-command-${index}-0001`,
      'e'.repeat(64),
    );
  }
  assertEquals(called, cases.map((item) => item.rpc));
  for (
    const item of cases.filter((entry) =>
      entry.rpc.includes('review') || entry.rpc.includes('dynamic_group') ||
      entry.rpc === 'bff_correct_announcement' || entry.rpc.includes('role_assignment')
    )
  ) {
    const route = matchRoute(item.method, item.path);
    assert(route);
    assertEquals(route.requireAal2, true);
    assertEquals(route.recentAuthSeconds, 900);
  }
});

Deno.test('organization preference patch enforces paired quiet hours and bounded quiet days', async () => {
  const route = matchRoute('PATCH', '/v2/preferences/organization');
  assert(route);
  await assertRejects(() => parseCommand(route, { organizationId, quietHoursStart: '22:00' }));
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      quietHoursStart: '22:00',
      quietHoursEnd: null,
    })
  );
  await assertRejects(() => parseCommand(route, { organizationId, quietDays: [1, 1] }));
  const command = parseCommand(route, {
    organizationId,
    quietHoursStart: null,
    quietHoursEnd: null,
    quietDays: [6, 0, 3],
  });
  assertEquals(command.values.patch, {
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_days: [0, 3, 6],
  });
});

Deno.test('message receipts accept only monotonic states and bind exact identity to the atomic RPC', async () => {
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const route = matchRoute('POST', '/v2/messages/9007199254740993123/receipt');
  assert(route);
  await assertRejects(() => parseCommand(route, { organizationId, conversationId, state: 'seen' }));
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      conversationId,
      state: 'read',
      userId: actor.user.id,
    })
  );

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    userClient: new Proxy({}, {
      get() {
        throw new Error('receipt commands may not bypass the BFF RPC');
      },
    }),
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            conversation_id: conversationId,
            message_id: '9007199254740993123',
            scope: 'self',
            delivered_at: '2026-08-04T12:00:00.000Z',
            read_at: args.p_state === 'read' ? '2026-08-04T12:00:01.000Z' : null,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;

  for (const [index, state] of ['delivered', 'read'].entries()) {
    const result = await executeCommand(
      route,
      parseCommand(route, { organizationId, conversationId, state }),
      rpcActor,
      `receipt-command-${index + 1}`,
      'f'.repeat(64),
    );
    assertEquals(result.body, {
      conversationId,
      messageId: '9007199254740993123',
      scope: 'self',
      deliveredAt: '2026-08-04T12:00:00.000Z',
      readAt: state === 'read' ? '2026-08-04T12:00:01.000Z' : null,
    });
  }
  assertEquals(calls.map((call) => call.name), [
    'bff_mark_message_receipt',
    'bff_mark_message_receipt',
  ]);
  assertEquals(
    calls.map((call) => ({
      organizationId: call.args.p_organization_id,
      conversationId: call.args.p_conversation_id,
      messageId: call.args.p_message_id,
      state: call.args.p_state,
      actorUserId: call.args.p_actor_user_id,
      sessionId: call.args.p_session_id,
    })),
    [
      {
        organizationId,
        conversationId,
        messageId: '9007199254740993123',
        state: 'delivered',
        actorUserId: actor.user.id,
        sessionId: actor.claims.sessionId,
      },
      {
        organizationId,
        conversationId,
        messageId: '9007199254740993123',
        state: 'read',
        actorUserId: actor.user.id,
        sessionId: actor.claims.sessionId,
      },
    ],
  );
});

Deno.test('announcement and handoff acknowledgements bind the exact path version', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: { accepted: true }, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const announcementVersionId = '00000000-0000-4000-8000-000000000091';
  const handoffVersionId = '00000000-0000-4000-8000-000000000092';
  const deviceId = '00000000-0000-4000-8000-000000000093';
  for (
    const [method, path, body] of [
      [
        'POST',
        `/v2/updates/${announcementVersionId}/acknowledgements`,
        { organizationId, deviceId, attestation: { understood: true } },
      ],
      ['POST', `/v2/handoffs/${handoffVersionId}/sign`, { organizationId }],
      [
        'POST',
        `/v2/handoffs/${handoffVersionId}/acknowledge`,
        { organizationId, note: 'Reviewed current version' },
      ],
    ] as const
  ) {
    const route = matchRoute(method, path);
    assert(route);
    await executeCommand(
      route,
      parseCommand(route, body),
      rpcActor,
      `version-command-${calls.length + 1}`,
      'e'.repeat(64),
    );
  }
  assertEquals(
    calls.map(({ name, args }) => ({
      name,
      version: args.p_announcement_version_id ?? args.p_handoff_version_id,
    })),
    [
      { name: 'bff_acknowledge_announcement', version: announcementVersionId },
      { name: 'bff_sign_handoff', version: handoffVersionId },
      { name: 'bff_acknowledge_handoff', version: handoffVersionId },
    ],
  );
  assertEquals(
    calls.some(({ args }) => 'p_announcement_id' in args || 'p_handoff_id' in args),
    false,
  );
  assertEquals(calls[0]?.args.p_device_id, deviceId);
  assertEquals(calls[0]?.args.p_attestation, { understood: true });
});

Deno.test('group history and incident lifecycle are server-authorized command contracts', async () => {
  const memberId = '00000000-0000-4000-8000-000000000031';
  const incidentId = '00000000-0000-4000-8000-000000000032';
  const createdGroupId = '00000000-0000-4000-8000-000000000033';
  const createRoute = matchRoute('POST', '/v2/conversations/group');
  const closeRoute = matchRoute('POST', `/v2/conversations/${incidentId}/incident/close`);
  assert(createRoute);
  assert(closeRoute);
  assertEquals(closeRoute.requireAal2, true);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: name === 'bff_create_group_conversation_v2'
            ? {
              conversation_id: createdGroupId,
              kind: 'incident',
              name: 'Line 4 incident',
              description: 'Coordinate the active safety response.',
              history_policy: 'since_join',
              history_disclosure: {
                policy: 'since_join',
                visible_from: '2026-08-04T12:00:00.000Z',
                label_key: 'conversation.history.since_join',
              },
              posting_mode: 'admins_only',
              join_policy: 'invite_only',
              configured_join_policy: 'invite_only',
              visibility: 'invite_only',
              member_count: 2,
              member_limit: 500,
              is_read_only: false,
            }
            : { ok: true },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  await executeCommand(
    createRoute,
    parseCommand(createRoute, {
      organizationId,
      name: 'Line 4 incident',
      description: 'Coordinate the active safety response.',
      memberAssignments: [{ membershipId: memberId, role: 'admin' }],
      kind: 'incident',
      unitId: null,
      historyPolicy: 'since_join',
      postingMode: 'admins_only',
      joinPolicy: 'invite_only',
      incidentSeverity: 'critical',
      incidentClassification: 'safety',
    }),
    rpcActor,
    'incident-create-0001',
    '1'.repeat(64),
  );
  await executeCommand(
    closeRoute,
    parseCommand(closeRoute, { organizationId, reason: 'Area made safe and reviewed' }),
    rpcActor,
    'incident-close-0001',
    '2'.repeat(64),
  );
  assertEquals(calls[0]?.name, 'bff_create_group_conversation_v2');
  assertEquals(calls[0]?.args.p_member_assignments, [{ user_id: memberId, role: 'admin' }]);
  assertEquals(calls[0]?.args.p_description, 'Coordinate the active safety response.');
  assertEquals(calls[0]?.args.p_history_policy, 'since_join');
  assertEquals(calls[0]?.args.p_posting_mode, 'admins_only');
  assertEquals(calls[0]?.args.p_join_policy, 'invite_only');
  assertEquals(calls[0]?.args.p_incident_severity, 'critical');
  assertEquals(calls[0]?.args.p_incident_classification, 'safety');
  assertEquals(calls[1]?.name, 'bff_close_incident');
  assertEquals(calls[1]?.args.p_conversation_id, incidentId);
  await assertRejects(() =>
    parseCommand(createRoute, {
      organizationId,
      name: 'Invalid incident',
      kind: 'incident',
      incidentSeverity: null,
      incidentClassification: null,
    })
  );
});

Deno.test('scheduled critical updates validate acknowledgement policy and expose preview/cancel RPCs', async () => {
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const announcementId = '00000000-0000-4000-8000-000000000033';
  const scheduledAt = '2030-08-10T10:00:00Z';
  const route = matchRoute('POST', '/v2/updates');
  const previewRoute = matchRoute('POST', '/v2/updates/audience/preview');
  const cancelRoute = matchRoute('POST', `/v2/updates/${announcementId}/cancel`);
  assert(route);
  assert(previewRoute);
  assert(cancelRoute);
  assertEquals(previewRoute.requireAal2, true);
  assertEquals(previewRoute.recentAuthSeconds, 900);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: { announcement_id: announcementId }, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const command = parseCommand(route, {
    organizationId,
    conversationId,
    clientMessageId: '00000000-0000-4000-8000-000000000034',
    title: 'Emergency shutdown',
    body: 'Follow the posted shutdown procedure.',
    languageCode: 'en',
    priority: 'emergency',
    requiresAcknowledgement: true,
    scheduledAt,
    notificationClass: 'critical',
    criticalCategory: 'safety',
    quietHoursOverrideReason: 'Immediate shutdown instructions require off-shift delivery.',
    acknowledgementSchema: {
      schemaVersion: 1,
      attestationRequired: true,
      attestationPrompt: 'I have read and understood the shutdown procedure.',
      requiredKeys: ['understood'],
      carryForwardOnCorrection: false,
    },
    reminderPolicy: {
      enabled: true,
      deadlineAt: '2030-08-10T12:00:00Z',
      intervalSeconds: 900,
      maximumReminders: 4,
      escalateAfterSeconds: 1800,
      smsFallback: false,
    },
  });
  const created = await executeCommand(
    route,
    command,
    rpcActor,
    'scheduled-update-0001',
    '3'.repeat(64),
  );
  assertEquals(created.status, 202);
  assertEquals(calls[0]?.name, 'bff_create_announcement');
  assertEquals(calls[0]?.args.p_scheduled_at, scheduledAt.replace('Z', '.000Z'));
  assertEquals(calls[0]?.args.p_acknowledgement_schema, {
    schema_version: 1,
    attestation_required: true,
    attestation_prompt: 'I have read and understood the shutdown procedure.',
    required_keys: ['understood'],
    carry_forward_on_correction: false,
  });
  assertEquals(calls[0]?.args.p_reminder_policy, {
    enabled: true,
    deadline_at: '2030-08-10T12:00:00.000Z',
    interval_seconds: 900,
    maximum_reminders: 4,
    escalate_after_seconds: 1800,
    sms_fallback: false,
  });
  assertEquals(calls[0]?.args.p_critical_category, 'safety');
  assertEquals(
    calls[0]?.args.p_quiet_hours_override_reason,
    'Immediate shutdown instructions require off-shift delivery.',
  );
  await executeCommand(
    previewRoute,
    parseCommand(previewRoute, { organizationId, conversationId, limit: 20 }),
    rpcActor,
    '',
    '4'.repeat(64),
  );
  await executeCommand(
    cancelRoute,
    parseCommand(cancelRoute, { organizationId, reason: 'Replaced by current instructions' }),
    rpcActor,
    'scheduled-update-cancel-0001',
    '5'.repeat(64),
  );
  assertEquals(calls[1]?.name, 'bff_preview_announcement_audience');
  assertEquals(calls[2]?.name, 'bff_cancel_scheduled_announcement');
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      conversationId,
      clientMessageId: '00000000-0000-4000-8000-000000000035',
      title: 'Invalid SMS fallback',
      body: 'SMS is not configured.',
      languageCode: 'en',
      requiresAcknowledgement: true,
      reminderPolicy: {
        enabled: true,
        deadlineAt: '2030-08-10T12:00:00Z',
        intervalSeconds: 900,
        maximumReminders: 1,
        escalateAfterSeconds: null,
        smsFallback: true,
      },
    })
  );
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      conversationId,
      clientMessageId: '00000000-0000-4000-8000-000000000038',
      title: 'Unproven override',
      body: 'Critical class without an audited reason must fail.',
      languageCode: 'en',
      notificationClass: 'critical',
    })
  );
});

Deno.test('critical update management, read state, and evidence receipts stay scoped to authoritative RPCs', async () => {
  const announcementId = '00000000-0000-4000-8000-000000000041';
  const versionId = '00000000-0000-4000-8000-000000000042';
  const installationId = '00000000-0000-4000-8000-000000000043';
  const manageRoute = matchRoute('POST', '/v2/updates/manage/list');
  const nonAckRoute = matchRoute(
    'POST',
    `/v2/updates/${announcementId}/non-acknowledgers`,
  );
  const readRoute = matchRoute('POST', `/v2/updates/${announcementId}/read`);
  const acknowledgementRoute = matchRoute(
    'POST',
    `/v2/updates/${versionId}/acknowledgements`,
  );
  assert(manageRoute);
  assert(nonAckRoute);
  assert(readRoute);
  assert(acknowledgementRoute);
  assertEquals(
    [manageRoute.requireAal2, nonAckRoute.requireAal2],
    [true, true],
  );
  assertEquals(
    [manageRoute.recentAuthSeconds, nonAckRoute.recentAuthSeconds],
    [300, 300],
  );
  assertEquals(
    [manageRoute.idempotencyRequired, nonAckRoute.idempotencyRequired],
    [false, false],
  );

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        const data = name === 'bff_list_managed_announcements'
          ? {
            updates: [],
            generated_at: '2026-08-04T12:00:00Z',
            sms_fallback_available: false,
          }
          : name === 'bff_list_announcement_non_acknowledgers'
          ? {
            announcement_id: announcementId,
            announcement_version_id: versionId,
            version_number: 2,
            deadline_at: null,
            people: [],
            has_more: false,
            next_after_user_id: null,
            privacy_scope: 'notice_response_state_only',
          }
          : name === 'bff_mark_announcement_read'
          ? {
            announcement_id: announcementId,
            delivered_at: '2026-08-04T12:00:00Z',
            read_at: '2026-08-04T12:00:01Z',
          }
          : {
            announcement_id: announcementId,
            announcement_version_id: versionId,
            acknowledged_at: '2026-08-04T12:00:02Z',
            session_id: actor.claims.sessionId,
            device_id: null,
            installation_id: installationId,
            platform: 'web',
            client_family: 'desktop',
            session_evidence_captured: true,
          };
        return Promise.resolve({ data, error: null });
      },
    },
  } as unknown as AuthenticatedActor;

  const managed = await executeCommand(
    manageRoute,
    parseCommand(manageRoute, { organizationId, limit: 25 }),
    rpcActor,
    '',
    '6'.repeat(64),
  );
  const nonAcknowledgers = await executeCommand(
    nonAckRoute,
    parseCommand(nonAckRoute, { organizationId, afterUserId: null, limit: 20 }),
    rpcActor,
    '',
    '7'.repeat(64),
  );
  const read = await executeCommand(
    readRoute,
    parseCommand(readRoute, { organizationId }),
    rpcActor,
    'announcement-read-0001',
    '8'.repeat(64),
  );
  const acknowledgement = await executeCommand(
    acknowledgementRoute,
    parseCommand(acknowledgementRoute, {
      organizationId,
      deviceId: null,
      attestation: { confirmed: true },
    }),
    rpcActor,
    'announcement-ack-0001',
    '9'.repeat(64),
  );

  assertEquals(managed.body, {
    updates: [],
    generatedAt: '2026-08-04T12:00:00Z',
    smsFallbackAvailable: false,
  });
  assertEquals(nonAcknowledgers.body, {
    announcementId,
    announcementVersionId: versionId,
    versionNumber: 2,
    deadlineAt: null,
    people: [],
    hasMore: false,
    nextAfterUserId: null,
    privacyScope: 'notice_response_state_only',
  });
  assertEquals(read.body, {
    announcementId,
    deliveredAt: '2026-08-04T12:00:00Z',
    readAt: '2026-08-04T12:00:01Z',
  });
  assertEquals(acknowledgement.body, {
    announcementId,
    announcementVersionId: versionId,
    acknowledgedAt: '2026-08-04T12:00:02Z',
    sessionId: actor.claims.sessionId,
    deviceId: null,
    installationId,
    platform: 'web',
    clientFamily: 'desktop',
    sessionEvidenceCaptured: true,
  });
  assertEquals(calls.map((call) => call.name), [
    'bff_list_managed_announcements',
    'bff_list_announcement_non_acknowledgers',
    'bff_mark_announcement_read',
    'bff_acknowledge_announcement',
  ]);
  assertEquals(calls[1]?.args.p_announcement_id, announcementId);
  assertEquals(calls[1]?.args.p_after_user_id, null);
  assertEquals(calls[2]?.args.p_announcement_id, announcementId);
  assertEquals(calls[3]?.args.p_announcement_version_id, versionId);
  assertEquals(calls[3]?.args.p_attestation, { confirmed: true });
});

Deno.test('priority mapping rejects class spoofing and incomplete quiet-hours authorization', async () => {
  const conversationId = '00000000-0000-4000-8000-000000000050';
  const publishRoute = matchRoute('POST', '/v2/updates');
  assert(publishRoute);
  const base = {
    organizationId,
    conversationId,
    clientMessageId: '00000000-0000-4000-8000-000000000051',
    title: 'Operations notice',
    body: 'Use the current procedure.',
    languageCode: 'en',
    requiresAcknowledgement: false,
  };

  await assertRejects(() =>
    parseCommand(publishRoute, {
      ...base,
      priority: 'normal',
      notificationClass: 'critical',
      criticalCategory: 'operations',
      quietHoursOverrideReason: 'Client-selected critical class.',
    })
  );
  await assertRejects(() =>
    parseCommand(publishRoute, {
      ...base,
      priority: 'important',
      notificationClass: 'urgent',
      criticalCategory: 'operations',
    })
  );
  await assertRejects(() =>
    parseCommand(publishRoute, {
      ...base,
      priority: 'emergency',
      notificationClass: 'critical',
      quietHoursOverrideReason: 'Category is intentionally missing.',
    })
  );
  await assertRejects(() =>
    parseCommand(publishRoute, {
      ...base,
      priority: 'normal',
      notificationClass: 'routine',
      criticalCategory: 'operations',
      quietHoursOverrideReason: 'Routine notices cannot override quiet hours.',
    })
  );

  const accepted = parseCommand(publishRoute, {
    ...base,
    priority: 'important',
    notificationClass: 'urgent',
    criticalCategory: 'operations',
    quietHoursOverrideReason: 'Authorized operational interruption.',
  });
  assertEquals(accepted.values.notificationClass, 'urgent');
  assertEquals(accepted.values.criticalCategory, 'operations');
});

Deno.test('handoff versions bind authorized source messages, deadlines, and signing devices', async () => {
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const handoffVersionId = '00000000-0000-4000-8000-000000000036';
  const deviceId = '00000000-0000-4000-8000-000000000037';
  const createRoute = matchRoute('POST', '/v2/handoffs');
  const signRoute = matchRoute('POST', `/v2/handoffs/${handoffVersionId}/sign`);
  assert(createRoute);
  assert(signRoute);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: { ok: true }, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  await executeCommand(
    createRoute,
    parseCommand(createRoute, {
      organizationId,
      conversationId,
      title: 'Night shift handoff',
      details: 'Line 4 remains stopped pending maintenance clearance.',
      sourceLanguage: 'en',
      shiftStartedAt: '2030-08-10T00:00:00Z',
      shiftEndedAt: '2030-08-10T08:00:00Z',
      sourceMessageIds: ['101', 102],
      acknowledgementDueAt: '2030-08-10T08:30:00Z',
    }),
    rpcActor,
    'handoff-source-0001',
    '6'.repeat(64),
  );
  await executeCommand(
    signRoute,
    parseCommand(signRoute, { organizationId, deviceId }),
    rpcActor,
    'handoff-sign-device-0001',
    '7'.repeat(64),
  );
  assertEquals(calls[0]?.name, 'bff_create_handoff');
  assertEquals(calls[0]?.args.p_source_message_ids, ['101', '102']);
  assertEquals(calls[0]?.args.p_acknowledgement_due_at, '2030-08-10T08:30:00.000Z');
  assertEquals(calls[1]?.name, 'bff_sign_handoff');
  assertEquals(calls[1]?.args.p_device_id, deviceId);
});

Deno.test('handoff corrections bind the exact expected immutable version to the CAS RPC', async () => {
  const handoffId = '00000000-0000-4000-8000-000000000038';
  const expectedVersionId = '00000000-0000-4000-8000-000000000039';
  const correctionRoute = matchRoute('POST', `/v2/handoffs/${handoffId}/corrections`);
  assert(correctionRoute);
  const base = {
    organizationId,
    expectedVersionId,
    expectedVersionNumber: 7,
    title: 'Corrected night handoff',
    details: 'Pressure reading corrected from the exact source message.',
    sourceLanguage: 'en',
    shiftStartedAt: '2030-08-10T00:00:00Z',
    shiftEndedAt: '2030-08-10T08:00:00Z',
    sourceMessageIds: ['101'],
    acknowledgementDueAt: '2030-08-10T08:30:00Z',
    reason: 'Transposed pressure reading',
  };

  for (
    const invalid of [
      { ...base, expectedVersionId: undefined },
      { ...base, expectedVersionNumber: undefined },
      { ...base, expectedVersionNumber: 0 },
      { ...base, unexpectedVersion: 7 },
    ]
  ) {
    await assertRejects(() => parseCommand(correctionRoute, invalid));
  }

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            handoff_id: handoffId,
            handoff_version_id: '00000000-0000-4000-8000-000000000040',
            version_number: 8,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;

  await executeCommand(
    correctionRoute,
    parseCommand(correctionRoute, base),
    rpcActor,
    'handoff-correction-cas-0001',
    '8'.repeat(64),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.name, 'bff_correct_handoff_v2');
  assertEquals(calls[0]?.args.p_handoff_id, handoffId);
  assertEquals(calls[0]?.args.p_expected_version_id, expectedVersionId);
  assertEquals(calls[0]?.args.p_expected_version_number, 7);
  assertEquals(calls[0]?.args.p_source_message_ids, ['101']);
});

Deno.test('self session revocation permits current and other sessions while admin revocation requires recent AAL2', async () => {
  const otherSessionId = '00000000-0000-4000-8000-000000000021';
  const selfRoute = matchRoute('POST', `/v2/auth/sessions/${otherSessionId}/revoke`);
  const adminRoute = matchRoute('POST', `/v2/admin/sessions/${otherSessionId}/revoke`);
  assert(selfRoute);
  assert(adminRoute);
  assertEquals(selfRoute.requireAal2, undefined);
  assertEquals(adminRoute.requireAal2, true);
  assertEquals(adminRoute.recentAuthSeconds, 300);
  const command = parseCommand(selfRoute, { organizationId, reason: 'Lost device' });
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return Promise.resolve({
          data: { session_id: args.p_target_session_id, revoked: true },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  await executeCommand(
    selfRoute,
    command,
    rpcActor,
    'session-revoke-0001',
    'a'.repeat(64),
  );
  assertEquals(rpcCalls[0]?.name, 'bff_revoke_session');
  assertEquals(rpcCalls[0]?.args.p_target_session_id, otherSessionId);

  const current = parseCommand(selfRoute, { organizationId, reason: 'Current session' });
  current.values.targetSessionId = actor.claims.sessionId;
  await executeCommand(
    selfRoute,
    current,
    rpcActor,
    'session-revoke-0002',
    'b'.repeat(64),
  );
  assertEquals(rpcCalls[1]?.name, 'bff_revoke_session');
  assertEquals(rpcCalls[1]?.args.p_target_session_id, actor.claims.sessionId);
});

Deno.test('conversation PATCH preserves omitted fields and attachment upload requires content hash', async () => {
  const update = matchRoute(
    'PATCH',
    '/v2/conversations/00000000-0000-4000-8000-000000000030',
  );
  assert(update);
  const command = parseCommand(update, {
    organizationId: '00000000-0000-4000-8000-000000000001',
    description: null,
    isArchived: true,
  });
  assertEquals(command.values.patch, { description: null, is_archived: true });

  const attachment = matchRoute('POST', '/v2/attachments/grants');
  assert(attachment);
  await assertRejects(() =>
    parseCommand(attachment, {
      organizationId: '00000000-0000-4000-8000-000000000001',
      action: 'upload',
      conversationId: '00000000-0000-4000-8000-000000000030',
      messageId: '101',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      byteSize: 100,
    })
  );
  for (
    const mimeType of [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'audio/mpeg',
      'audio/mp4',
      'audio/ogg',
      'video/mp4',
      'video/quicktime',
    ]
  ) {
    const parsed = parseCommand(attachment, {
      organizationId,
      action: 'upload',
      conversationId: '00000000-0000-4000-8000-000000000030',
      messageId: '101',
      fileName: 'pilot-file',
      mimeType,
      byteSize: 100,
      sha256Hex: 'a'.repeat(64),
    });
    assertEquals(parsed.values.mimeType, mimeType);
  }
  for (
    const mimeType of [
      'video/x-msvideo',
      'video/webm',
      'application/x-msdownload',
      'text/html',
      'application/zip',
    ]
  ) {
    await assertRejects(() =>
      parseCommand(attachment, {
        organizationId,
        action: 'upload',
        conversationId: '00000000-0000-4000-8000-000000000030',
        messageId: '101',
        fileName: 'unsafe-format.bin',
        mimeType,
        byteSize: 100,
        sha256Hex: 'a'.repeat(64),
      })
    );
  }
});

Deno.test('attachment upload grants enforce the per-type byte caps', async () => {
  const attachment = matchRoute('POST', '/v2/attachments/grants');
  assert(attachment);
  const grant = (mimeType: string, byteSize: number) =>
    parseCommand(attachment, {
      organizationId,
      action: 'upload',
      conversationId: '00000000-0000-4000-8000-000000000030',
      messageId: '101',
      fileName: 'capped-file',
      mimeType,
      byteSize,
      sha256Hex: 'a'.repeat(64),
    });
  // Videos get the full 100 MiB envelope.
  assertEquals(grant('video/mp4', 104857600).values.byteSize, 104857600);
  assertEquals(grant('video/quicktime', 104857600).values.byteSize, 104857600);
  await assertRejects(() => grant('video/mp4', 104857601));
  // Every other type keeps the 25 MiB cap.
  assertEquals(grant('image/jpeg', 26214400).values.byteSize, 26214400);
  await assertRejects(() => grant('image/jpeg', 26214401));
  await assertRejects(() => grant('application/pdf', 104857600));
});

Deno.test('attachment completion hashes the immutable stored object before queueing its scan', async () => {
  const attachmentId = '00000000-0000-4000-8000-000000000060';
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const bytes = new TextEncoder().encode('safe test attachment');
  const digest = await sha256Hex(bytes);
  const path = `${organizationId}/${conversationId}/${actor.user.id}/${attachmentId}/upload`;
  const route = matchRoute('POST', `/v2/attachments/${attachmentId}/complete`);
  assert(route);
  const command = parseCommand(route, {
    organizationId,
    bucket: 'message-attachments',
    path,
    byteSize: bytes.byteLength,
    sha256Hex: digest,
  });
  let finalized: Record<string, unknown> | undefined;
  const adminClient = {
    storage: {
      from(bucket: string) {
        assertEquals(bucket, 'message-attachments');
        return {
          info: async (requestedPath: string) => {
            assertEquals(requestedPath, path);
            return { data: { size: bytes.byteLength }, error: null };
          },
          download: async (requestedPath: string) => {
            assertEquals(requestedPath, path);
            return { data: new Blob([bytes]), error: null };
          },
        };
      },
    },
    rpc(name: string, args: Record<string, unknown>) {
      assertEquals(name, 'bff_finalize_attachment_upload');
      finalized = args;
      return Promise.resolve({
        data: {
          attachment_id: attachmentId,
          scan_status: 'pending',
          scan_queued: true,
          scan_job_id: 901,
        },
        error: null,
      });
    },
  };
  const result = await executeCommand(
    route,
    command,
    { ...actor, adminClient } as unknown as AuthenticatedActor,
    'attachment-complete-0001',
    'd'.repeat(64),
  );
  assertEquals(result.status, 202);
  assertEquals(result.body, {
    attachmentId,
    scanStatus: 'pending',
    scanQueued: true,
    scanJobId: 901,
  });
  assertEquals(finalized?.p_object_sha256_hex, digest);
  assertEquals(finalized?.p_object_byte_size, bytes.byteLength);
});

Deno.test('device registration binds Expo transport, EAS project, and environment', async () => {
  const route = matchRoute('POST', '/v2/devices');
  assert(route);
  const input = {
    organizationId,
    installationId: '00000000-0000-4000-8000-000000000060',
    platform: 'ios',
    pushToken: 'ExponentPushToken[valid_token-123]',
    pushTokenType: 'expo',
    pushProjectId: '00000000-0000-4000-8000-000000000061',
    pushEnvironment: 'production',
    appVersion: '1.0.0',
    locale: 'en-US',
  };
  const parsed = parseCommand(route, input);
  assertEquals(parsed.values.pushTokenType, 'expo');
  assertEquals(parsed.values.pushProjectId, input.pushProjectId);
  assertEquals(parsed.values.pushEnvironment, 'production');
  for (const pushToken of ['a'.repeat(64), 'fcm:raw-token', 'ExpoPushToken[bad token]']) {
    await assertRejects(() => parseCommand(route, { ...input, pushToken }));
  }
  await assertRejects(() => parseCommand(route, { ...input, pushTokenType: 'apns' }));
  await assertRejects(() => parseCommand(route, { ...input, platform: 'web' }));
});

Deno.test('admin invite issuance binds a newly preprovisioned exact Auth principal', async () => {
  const route = matchRoute('POST', '/v2/admin/invitations');
  assert(route);
  const command = parseCommand(route, {
    organizationId: '00000000-0000-4000-8000-000000000001',
    destinationType: 'email',
    destination: 'new.worker@example.com',
    activationMode: 'otp',
    role: 'member',
  });
  const invitedUserId = '00000000-0000-4000-8000-000000000070';
  const calls: Array<{ name: string; value?: unknown }> = [];
  const adminClient = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, value: args });
      if (name === 'bff_resolve_invite_principal') {
        return Promise.resolve({ data: { authorized: true, user_id: null }, error: null });
      }
      return Promise.resolve({
        data: {
          invite_id: '00000000-0000-4000-8000-000000000080',
          token: 'a'.repeat(64),
          token_available: true,
          expires_at: '2026-08-10T00:00:00Z',
          single_use: true,
          destination_type: 'email',
          activation_mode: 'otp',
          channel_configured: true,
          membership_type: 'employee',
          membership_access_expires_at: null,
          guest_sponsor_user_id: null,
        },
        error: null,
      });
    },
    auth: {
      admin: {
        createUser(options: unknown) {
          calls.push({ name: 'auth.createUser', value: options });
          return Promise.resolve({ data: { user: { id: invitedUserId } }, error: null });
        },
        updateUserById(_userId: string, options: unknown) {
          calls.push({ name: 'auth.updateUser', value: options });
          return Promise.resolve({ data: {}, error: null });
        },
      },
    },
  };
  const result = await executeCommand(
    route,
    command,
    { ...actor, adminClient } as unknown as AuthenticatedActor,
    'invite-command-0001',
    'a'.repeat(64),
    'https://app.newone.example',
  );
  assertEquals(result.status, 201);
  assertEquals(calls.map((call) => call.name), [
    'bff_resolve_invite_principal',
    'auth.createUser',
    'bff_issue_organization_invite_v2',
    'auth.updateUser',
  ]);
  const create = calls[1]?.value as Record<string, unknown>;
  assertEquals(create.email_confirm, true);
  assertEquals(create.app_metadata, { newone_invite_state: 'pending' });
  const issue = calls[2]?.value as Record<string, unknown>;
  assertEquals(issue.p_invited_user_id, invitedUserId);
  assertEquals(issue.p_membership_type, 'employee');
  assertEquals(issue.p_membership_access_expires_at, null);
  assertEquals(issue.p_guest_sponsor_user_id, null);
  assertEquals(calls[3]?.value, { app_metadata: { newone_invite_state: 'invited' } });
  assertEquals(result.body, {
    inviteId: '00000000-0000-4000-8000-000000000080',
    destinationType: 'email',
    destinationMasked: 'n***@example.com',
    role: 'member',
    activationMode: 'otp',
    expiresAt: '2026-08-10T00:00:00Z',
    singleUse: true,
    activationToken: 'a'.repeat(64),
    tokenAvailable: true,
    channelConfigured: true,
    membershipType: 'employee',
    membershipAccessExpiresAt: null,
    guestSponsorUserId: null,
    delivery: 'manual_secure',
  });
  assert(!JSON.stringify(result.body).includes('sign-in#invite='));
});

Deno.test('guest invitations bind a bounded access window and an active sponsor to the v2 RPC', async () => {
  const route = matchRoute('POST', '/v2/admin/invitations');
  assert(route);
  const invitedUserId = '00000000-0000-4000-8000-000000000073';
  const sponsorUserId = '00000000-0000-4000-8000-000000000075';
  const membershipAccessExpiresAt = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const base = {
    organizationId,
    destinationType: 'email',
    destination: 'vendor@example.com',
    activationMode: 'otp',
    role: 'member',
    expiresInSeconds: 604800,
    membershipType: 'guest',
    membershipAccessExpiresAt,
    guestSponsorUserId: sponsorUserId,
  } as const;
  for (
    const invalid of [
      { ...base, role: 'manager' },
      { ...base, guestSponsorUserId: null },
      {
        ...base,
        membershipAccessExpiresAt: new Date(Date.now() + 604800 * 1000).toISOString(),
      },
      {
        ...base,
        membershipAccessExpiresAt: new Date(
          Date.now() + 366 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
      {
        ...base,
        membershipType: 'employee',
      },
      {
        ...base,
        membershipType: 'contractor',
      },
    ]
  ) await assertRejects(() => parseCommand(route, invalid));

  const command = parseCommand(route, base);
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const returnedAccessExpiry = membershipAccessExpiresAt.replace('Z', '+00:00');
  const inviteExpiresAt = new Date(Date.now() + 604800 * 1000).toISOString();
  const adminClient = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === 'bff_resolve_invite_principal') {
        return Promise.resolve({
          data: { authorized: true, user_id: invitedUserId },
          error: null,
        });
      }
      assertEquals(name, 'bff_issue_organization_invite_v2');
      return Promise.resolve({
        data: {
          invite_id: '00000000-0000-4000-8000-000000000086',
          expires_at: inviteExpiresAt,
          single_use: true,
          destination_type: 'email',
          activation_mode: 'otp',
          channel_configured: true,
          token_available: false,
          membership_type: 'guest',
          membership_access_expires_at: returnedAccessExpiry,
          guest_sponsor_user_id: sponsorUserId,
        },
        error: null,
      });
    },
    auth: { admin: {} },
  };
  const result = await executeCommand(
    route,
    command,
    { ...actor, adminClient } as unknown as AuthenticatedActor,
    'guest-invite-0001',
    '7'.repeat(64),
  );
  assertEquals(rpcCalls.map((call) => call.name), [
    'bff_resolve_invite_principal',
    'bff_issue_organization_invite_v2',
  ]);
  const issueArgs = rpcCalls[1]?.args;
  assertEquals(issueArgs?.p_membership_type, 'guest');
  assertEquals(issueArgs?.p_membership_access_expires_at, membershipAccessExpiresAt);
  assertEquals(issueArgs?.p_guest_sponsor_user_id, sponsorUserId);
  assertEquals(result.body, {
    inviteId: '00000000-0000-4000-8000-000000000086',
    destinationType: 'email',
    destinationMasked: 'v***@example.com',
    role: 'member',
    activationMode: 'otp',
    expiresAt: inviteExpiresAt,
    singleUse: true,
    tokenAvailable: false,
    channelConfigured: true,
    membershipType: 'guest',
    membershipAccessExpiresAt,
    guestSponsorUserId: sponsorUserId,
    delivery: 'manual_secure',
  });
});

Deno.test('manual phone invite requires employee code and reports disabled channel without URL secrets', async () => {
  const route = matchRoute('POST', '/v2/admin/invitations');
  assert(route);
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      destinationType: 'phone',
      destination: '+12025550123',
      activationMode: 'manual',
      role: 'member',
    })
  );
  const command = parseCommand(route, {
    organizationId,
    destinationType: 'phone',
    destination: '+12025550123',
    employeeCode: 'EMP-2048',
    activationMode: 'manual',
    role: 'member',
  });
  const invitedUserId = '00000000-0000-4000-8000-000000000072';
  const adminClient = {
    rpc(name: string, args: Record<string, unknown>) {
      if (name === 'bff_resolve_invite_principal') {
        assertEquals(args.p_destination_type, 'phone');
        assertEquals(args.p_destination, '+12025550123');
        return Promise.resolve({ data: { authorized: true, user_id: null }, error: null });
      }
      assertEquals(args.p_employee_code, 'EMP-2048');
      assertEquals(args.p_activation_mode, 'manual');
      return Promise.resolve({
        data: {
          invite_id: '00000000-0000-4000-8000-000000000081',
          token: 'b'.repeat(64),
          token_available: true,
          expires_at: '2030-08-10T00:00:00Z',
          single_use: true,
          destination_type: 'phone',
          activation_mode: 'manual',
          channel_configured: false,
          membership_type: 'employee',
          membership_access_expires_at: null,
          guest_sponsor_user_id: null,
        },
        error: null,
      });
    },
    auth: {
      admin: {
        createUser(options: Record<string, unknown>) {
          assertEquals(options.phone, '+12025550123');
          assertEquals(options.phone_confirm, true);
          return Promise.resolve({ data: { user: { id: invitedUserId } }, error: null });
        },
        updateUserById() {
          return Promise.resolve({ data: {}, error: null });
        },
      },
    },
  };
  const result = await executeCommand(
    route,
    command,
    { ...actor, adminClient } as unknown as AuthenticatedActor,
    'phone-invite-0001',
    '8'.repeat(64),
  );
  assertEquals(result.body, {
    inviteId: '00000000-0000-4000-8000-000000000081',
    destinationType: 'phone',
    destinationMasked: '+1******0123',
    role: 'member',
    activationMode: 'manual',
    expiresAt: '2030-08-10T00:00:00Z',
    singleUse: true,
    activationToken: 'b'.repeat(64),
    tokenAvailable: true,
    channelConfigured: false,
    membershipType: 'employee',
    membershipAccessExpiresAt: null,
    guestSponsorUserId: null,
    delivery: 'manual_secure',
  });
  const serialized = JSON.stringify(result.body);
  assertEquals(serialized.includes('+12025550123'), false);
  assertEquals(serialized.includes('http'), false);
});

Deno.test('invite idempotency replay returns metadata without recovering the activation secret', async () => {
  const route = matchRoute('POST', '/v2/admin/invitations');
  assert(route);
  const command = parseCommand(route, {
    organizationId,
    destinationType: 'email',
    destination: 'replay@example.com',
    activationMode: 'otp',
    role: 'member',
  });
  const invitedUserId = '00000000-0000-4000-8000-000000000074';
  const adminClient = {
    rpc(name: string) {
      if (name === 'bff_resolve_invite_principal') {
        return Promise.resolve({
          data: { authorized: true, user_id: invitedUserId },
          error: null,
        });
      }
      assertEquals(name, 'bff_issue_organization_invite_v2');
      return Promise.resolve({
        data: {
          invite_id: '00000000-0000-4000-8000-000000000085',
          expires_at: '2030-08-10T00:00:00Z',
          single_use: true,
          destination_type: 'email',
          activation_mode: 'otp',
          channel_configured: true,
          token_available: false,
          membership_type: 'employee',
          membership_access_expires_at: null,
          guest_sponsor_user_id: null,
        },
        error: null,
      });
    },
    auth: { admin: {} },
  };
  const result = await executeCommand(
    route,
    command,
    { ...actor, adminClient } as unknown as AuthenticatedActor,
    'invite-replay-0001',
    '9'.repeat(64),
  );
  assertEquals(result.status, 201);
  assertEquals(result.body, {
    inviteId: '00000000-0000-4000-8000-000000000085',
    destinationType: 'email',
    destinationMasked: 'r***@example.com',
    role: 'member',
    activationMode: 'otp',
    expiresAt: '2030-08-10T00:00:00Z',
    singleUse: true,
    tokenAvailable: false,
    channelConfigured: true,
    membershipType: 'employee',
    membershipAccessExpiresAt: null,
    guestSponsorUserId: null,
    delivery: 'manual_secure',
  });
  assertEquals('activationToken' in (result.body as Record<string, unknown>), false);
});

Deno.test('session list exposes only bounded safe device and approximate signal metadata', async () => {
  const route = matchRoute('POST', '/v2/auth/sessions/list');
  assert(route);
  const command = parseCommand(route, { organizationId });
  const adminClient = {
    rpc(name: string) {
      assertEquals(name, 'bff_list_sessions');
      return Promise.resolve({
        data: {
          sessions: [{
            session_id: actor.claims.sessionId,
            current: true,
            device: {
              installation_id: '00000000-0000-4000-8000-000000000060',
              platform: 'ios',
              app_version: '1.0.0',
            },
            platform: 'ios',
            created_at: '2026-08-01T10:00:00Z',
            last_used_at: '2026-08-03T10:00:00Z',
            expires_at: '2026-09-01T10:00:00Z',
            revoked: false,
            aal: 'aal2',
            signal: { same_network_as_current: true, client_family: 'iphone' },
            ip: '203.0.113.9',
            user_agent: 'must never pass through',
          }],
        },
        error: null,
      });
    },
  };
  const result = await executeCommand(
    route,
    command,
    { ...actor, adminClient } as unknown as AuthenticatedActor,
    '',
    'f'.repeat(64),
  );
  const serialized = JSON.stringify(result.body);
  assert(!serialized.includes('203.0.113.9'));
  assert(!serialized.includes('user_agent'));
  assertEquals(result.body, {
    sessions: [{
      sessionId: actor.claims.sessionId,
      current: true,
      device: {
        installationId: '00000000-0000-4000-8000-000000000060',
        platform: 'ios',
        appVersion: '1.0.0',
      },
      platform: 'ios',
      createdAt: '2026-08-01T10:00:00Z',
      lastUsedAt: '2026-08-03T10:00:00Z',
      expiresAt: '2026-09-01T10:00:00Z',
      revoked: false,
      aal: 'aal2',
      signal: { sameNetworkAsCurrent: true, clientFamily: 'iphone' },
    }],
  });
});

Deno.test('admin invite issuance reuses an exact existing Auth principal without listing users', async () => {
  const route = matchRoute('POST', '/v2/admin/invitations');
  assert(route);
  const command = parseCommand(route, {
    organizationId: '00000000-0000-4000-8000-000000000001',
    destinationType: 'email',
    destination: 'existing.worker@example.com',
    activationMode: 'otp',
    role: 'manager',
  });
  const existingUserId = '00000000-0000-4000-8000-000000000071';
  const rpcNames: string[] = [];
  const adminClient = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcNames.push(name);
      if (name === 'bff_resolve_invite_principal') {
        return Promise.resolve({
          data: { authorized: true, user_id: existingUserId },
          error: null,
        });
      }
      assertEquals(args.p_invited_user_id, existingUserId);
      return Promise.resolve({
        data: {
          invite_id: crypto.randomUUID(),
          token: 'a'.repeat(64),
          token_available: true,
          expires_at: '2026-08-10T00:00:00Z',
          single_use: true,
          destination_type: 'email',
          activation_mode: 'otp',
          channel_configured: true,
          membership_type: 'employee',
          membership_access_expires_at: null,
          guest_sponsor_user_id: null,
        },
        error: null,
      });
    },
    auth: {
      admin: {
        createUser() {
          throw new Error('must not create or list a resolved principal');
        },
      },
    },
  };
  await executeCommand(
    route,
    command,
    { ...actor, adminClient } as unknown as AuthenticatedActor,
    'invite-command-0003',
    'c'.repeat(64),
    'https://app.newone.example',
  );
  assertEquals(rpcNames, ['bff_resolve_invite_principal', 'bff_issue_organization_invite_v2']);
});

Deno.test('failed bound invite marks a newly created Auth principal as a banned orphan', async () => {
  const route = matchRoute('POST', '/v2/admin/invitations');
  assert(route);
  const command = parseCommand(route, {
    organizationId: '00000000-0000-4000-8000-000000000001',
    destinationType: 'email',
    destination: 'new.worker@example.com',
    activationMode: 'otp',
    role: 'member',
  });
  const updates: unknown[] = [];
  const adminClient = {
    rpc(name: string) {
      if (name === 'bff_resolve_invite_principal') {
        return Promise.resolve({ data: { authorized: true, user_id: null }, error: null });
      }
      return Promise.resolve({ data: null, error: { code: '42501' } });
    },
    auth: {
      admin: {
        createUser() {
          return Promise.resolve({
            data: { user: { id: '00000000-0000-4000-8000-000000000070' } },
            error: null,
          });
        },
        updateUserById(_userId: string, options: unknown) {
          updates.push(options);
          return Promise.resolve({ data: {}, error: null });
        },
      },
    },
  };
  await assertRejects(() =>
    executeCommand(
      route,
      command,
      { ...actor, adminClient } as unknown as AuthenticatedActor,
      'invite-command-0002',
      'b'.repeat(64),
      'https://app.newone.example',
    )
  );
  assertEquals(updates, [{
    app_metadata: { newone_invite_state: 'orphaned' },
    ban_duration: '876000h',
  }]);
});

Deno.test('conversation departure requires explicit confirmation and maps only replacement ownership', async () => {
  const conversationId = '00000000-0000-4000-8000-000000000081';
  const replacementId = '00000000-0000-4000-8000-000000000082';
  const route = matchRoute('POST', `/v2/conversations/${conversationId}/leave`);
  assert(route);
  await assertRejects(() =>
    Promise.resolve(parseCommand(route, {
      organizationId,
      replacementOwnerMembershipId: replacementId,
      confirmHistoryAndAccessLoss: false,
    }))
  );
  const command = parseCommand(route, {
    organizationId,
    replacementOwnerMembershipId: replacementId,
    confirmHistoryAndAccessLoss: true,
  });
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            conversation_id: conversationId,
            left: true,
            role_at_departure: 'owner',
            ownership_transferred: true,
            history_preserved: true,
            future_access_revoked: true,
            left_at: '2026-08-04T12:00:00Z',
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  await executeCommand(
    route,
    command,
    rpcActor,
    'conversation-leave-0001',
    'd'.repeat(64),
  );
  assertEquals(calls[0]?.name, 'bff_leave_conversation');
  assertEquals(calls[0]?.args.p_conversation_id, conversationId);
  assertEquals(calls[0]?.args.p_replacement_owner_user_id, replacementId);
});

Deno.test('message preservation routes require recent AAL2 and map only hashed policy metadata', async () => {
  const messageId = '101';
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const holdId = '00000000-0000-4000-8000-000000000091';
  const placeRoute = matchRoute(
    'POST',
    `/v2/admin/messages/${messageId}/preservation-holds`,
  );
  assert(placeRoute);
  assertEquals(placeRoute.requireAal2, true);
  assertEquals(placeRoute.recentAuthSeconds, 900);
  await assertRejects(() =>
    Promise.resolve(parseCommand(placeRoute, {
      organizationId,
      conversationId,
      holdType: 'legal',
      reasonCode: 'litigation',
      policyReferenceSha256: 'raw-case-reference-is-forbidden',
    }))
  );
  const placeCommand = parseCommand(placeRoute, {
    organizationId,
    conversationId,
    holdType: 'incident_preservation',
    reasonCode: 'safety-review',
    policyReferenceSha256: 'a'.repeat(64),
  });
  const releaseRoute = matchRoute(
    'POST',
    `/v2/admin/message-preservation-holds/${holdId}/release`,
  );
  assert(releaseRoute);
  assertEquals(releaseRoute.requireAal2, true);
  assertEquals(releaseRoute.recentAuthSeconds, 900);
  const releaseCommand = parseCommand(releaseRoute, {
    organizationId,
    releaseReasonCode: 'review-complete',
  });

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: { ok: true }, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  await executeCommand(
    placeRoute,
    placeCommand,
    rpcActor,
    '00000000-0000-4000-8000-000000000092',
    'b'.repeat(64),
  );
  await executeCommand(
    releaseRoute,
    releaseCommand,
    rpcActor,
    '00000000-0000-4000-8000-000000000093',
    'c'.repeat(64),
  );
  assertEquals(calls, [
    {
      name: 'bff_place_message_preservation_hold',
      args: {
        p_actor_user_id: actor.user.id,
        p_organization_id: organizationId,
        p_session_id: actor.claims.sessionId,
        p_idempotency_key: '00000000-0000-4000-8000-000000000092',
        p_request_sha256: 'b'.repeat(64),
        p_conversation_id: conversationId,
        p_message_id: messageId,
        p_hold_type: 'incident_preservation',
        p_reason_code: 'safety-review',
        p_policy_reference_sha256: 'a'.repeat(64),
      },
    },
    {
      name: 'bff_release_message_preservation_hold',
      args: {
        p_actor_user_id: actor.user.id,
        p_organization_id: organizationId,
        p_session_id: actor.claims.sessionId,
        p_idempotency_key: '00000000-0000-4000-8000-000000000093',
        p_request_sha256: 'c'.repeat(64),
        p_hold_id: holdId,
        p_release_reason_code: 'review-complete',
      },
    },
  ]);
});

Deno.test('audit export is recent-AAL2, purpose-bound, bounded, and verifies the database digest', async () => {
  const route = matchRoute('POST', '/v2/admin/audit/export');
  assert(route);
  assertEquals(route.requireAal2, true);
  assertEquals(route.recentAuthSeconds, 900);
  assertEquals(route.idempotencyRequired, false);
  const now = Date.now();
  const dateFrom = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const dateTo = new Date(now).toISOString();
  const command = parseCommand(route, {
    organizationId,
    reasonCode: 'compliance_review',
    format: 'csv',
    dateFrom,
    dateTo,
    eventTypes: ['role.assignment.granted'],
    targetType: 'membership',
    targetId: '00000000-0000-4000-8000-000000000099',
  });
  assertEquals(command.values.reasonCode, 'compliance_review');
  assertEquals(command.values.eventTypes, ['role.assignment.granted']);

  await assertRejects(() =>
    Promise.resolve(parseCommand(route, {
      organizationId,
      reasonCode: 'curiosity',
      format: 'csv',
      dateFrom,
      dateTo,
    }))
  );
  await assertRejects(() =>
    Promise.resolve(parseCommand(route, {
      organizationId,
      reasonCode: 'security_review',
      format: 'csv',
      dateFrom: new Date(now - 32 * 24 * 60 * 60 * 1000).toISOString(),
      dateTo,
    }))
  );
  await assertRejects(() =>
    Promise.resolve(parseCommand(route, {
      organizationId,
      reasonCode: 'security_review',
      format: 'json',
      dateFrom,
      dateTo,
      eventTypes: ['message.updated', 'message.updated'],
    }))
  );

  const payload =
    'event_id,actor_user_id,event_type,target_type,target_id,request_id,occurred_at,outcome';
  const digest = await sha256Hex(payload);
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return Promise.resolve({
          data: {
            schema_version: 1,
            receipt_id: '00000000-0000-4000-8000-000000000098',
            format: 'csv',
            content_type: 'text/csv',
            file_name: 'newone-audit-20260804-120000.csv',
            row_count: 0,
            payload_bytes: new TextEncoder().encode(payload).byteLength,
            sha256: digest,
            created_at: dateTo,
            payload,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const result = await executeCommand(route, command, rpcActor, '', 'a'.repeat(64));
  assertEquals(result.status, 200);
  assertEquals((result.body as { sha256: string }).sha256, digest);
  const rpcCall = rpcCalls[0];
  assert(rpcCall);
  assertEquals(rpcCall.name, 'bff_export_audit_events');
  assertEquals(rpcCall.args.p_reason_code, 'compliance_review');

  const badDigestActor = {
    ...rpcActor,
    adminClient: {
      rpc() {
        return Promise.resolve({
          data: {
            schema_version: 1,
            receipt_id: '00000000-0000-4000-8000-000000000098',
            format: 'csv',
            content_type: 'text/csv',
            file_name: 'newone-audit-20260804-120000.csv',
            row_count: 0,
            payload_bytes: new TextEncoder().encode(payload).byteLength,
            sha256: '0'.repeat(64),
            created_at: dateTo,
            payload,
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  await assertRejects(() => executeCommand(route, command, badDigestActor, '', 'a'.repeat(64)));
});

Deno.test('audit export authorization denial records a content-free attempt and preserves the denial', async () => {
  const calls: string[] = [];
  const policies: unknown[] = [];
  let rateCalls = 0;
  const handler = createApiHandler(() => ({
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'pk',
      secretKey: 'sk',
    },
    authenticateActor: async () => actor,
    authorize: async (_actor, _organizationId, policy) => {
      calls.push(policy.requireAal2 ? 'authorize:privileged' : 'authorize:membership');
      policies.push(policy);
      if (policy.requireAal2) throw new ApiError(403, 'forbidden');
    },
    rateLimit: async () => {
      calls.push('rate');
      rateCalls += 1;
      if (rateCalls > 1) throw new ApiError(429, 'rate_limited', undefined, 60);
    },
    execute: async () => {
      calls.push('execute');
      return { status: 200, body: {} };
    },
    recordAuditDenial: async (_actor, requestedOrganizationId, operation) => {
      calls.push(`record:${requestedOrganizationId}:${operation}`);
      throw new Error('the audit writer must not replace the original denial');
    },
  }));
  const now = Date.now();
  const response = await handler(
    new Request(
      'https://api.newone.example/v2/admin/audit/export',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
          Origin: 'https://app.newone.example',
        },
        body: JSON.stringify({
          organizationId,
          reasonCode: 'incident_investigation',
          format: 'json',
          dateFrom: new Date(now - 60_000).toISOString(),
          dateTo: new Date(now).toISOString(),
        }),
      },
    ),
  );
  assertEquals(response.status, 403);
  assertEquals(calls, [
    'authorize:membership',
    'rate',
    'authorize:privileged',
    `record:${organizationId}:audit.export`,
  ]);
  assertEquals(policies, [{
    operation: 'audit.export',
  }, {
    operation: 'audit.export',
    requireAal2: true,
    recentAuthSeconds: 900,
  }]);

  calls.length = 0;
  policies.length = 0;
  const throttled = await handler(
    new Request(
      'https://api.newone.example/v2/admin/audit/export',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
          Origin: 'https://app.newone.example',
        },
        body: JSON.stringify({
          organizationId,
          reasonCode: 'incident_investigation',
          format: 'json',
          dateFrom: new Date(now - 60_000).toISOString(),
          dateTo: new Date(now).toISOString(),
        }),
      },
    ),
  );
  assertEquals(throttled.status, 429);
  assertEquals(throttled.headers.get('retry-after'), '60');
  assertEquals(calls, ['authorize:membership', 'rate']);
  assertEquals(policies, [{ operation: 'audit.export' }]);
});
