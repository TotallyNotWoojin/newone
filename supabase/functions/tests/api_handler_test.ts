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
  for (const call of calls) {
    assertEquals(call.args.p_actor_user_id, actor.user.id);
    assertEquals(call.args.p_session_id, actor.claims.sessionId);
    assertEquals(call.args.p_organization_id, organizationId);
  }
});

Deno.test('summary and translation routes reject client policy expansion and unsupported evidence', async () => {
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const translationRoute = matchRoute('POST', '/v2/messages/101/translations');
  const requestRoute = matchRoute('POST', `/v2/conversations/${conversationId}/summaries`);
  const manualRoute = matchRoute('POST', `/v2/conversations/${conversationId}/summaries/manual`);
  assert(translationRoute && requestRoute && manualRoute);
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

Deno.test('group history is a server-authorized command contract', async () => {
  const memberId = '00000000-0000-4000-8000-000000000031';
  const createdGroupId = '00000000-0000-4000-8000-000000000033';
  const createRoute = matchRoute('POST', '/v2/conversations/group');
  assert(createRoute);
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
  assertEquals(calls[0]?.name, 'bff_create_group_conversation_v2');
  assertEquals(calls[0]?.args.p_member_assignments, [{ user_id: memberId, role: 'admin' }]);
  assertEquals(calls[0]?.args.p_description, 'Coordinate the active safety response.');
  assertEquals(calls[0]?.args.p_history_policy, 'since_join');
  assertEquals(calls[0]?.args.p_posting_mode, 'admins_only');
  assertEquals(calls[0]?.args.p_join_policy, 'invite_only');
  assertEquals(calls[0]?.args.p_incident_severity, 'critical');
  assertEquals(calls[0]?.args.p_incident_classification, 'safety');
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

Deno.test('self session revocation permits current and other sessions', async () => {
  const otherSessionId = '00000000-0000-4000-8000-000000000021';
  const selfRoute = matchRoute('POST', `/v2/auth/sessions/${otherSessionId}/revoke`);
  assert(selfRoute);
  assertEquals(selfRoute.requireAal2, undefined);
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
