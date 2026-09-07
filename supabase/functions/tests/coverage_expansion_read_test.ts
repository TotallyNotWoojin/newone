import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  createReadHandler,
  parseAuditResponse,
  parseSearchResponse,
  type ReadDependencies,
} from '../newone-read/handler.ts';
import { assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const conversationId = '40000000-0000-4000-8000-000000000004';
const receiptId = '50000000-0000-4000-8000-000000000005';

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(['https://app.newone.example']),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65536,
  networkHashKey: 'network-key-that-is-long-enough-coverage',
  cursorSigningKey: 'cursor-key-that-is-long-enough-coverage',
  allowHttpLocal: false,
};

const actor = {
  user: { id: userId },
  token: 'coverage-access-token',
  claims: {
    sub: userId,
    sessionId,
    aal: 'aal2',
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: 9999999999,
  },
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

function auditItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '2',
    actor_user_id: null,
    event_type: 'security.reviewed',
    target_type: 'conversation',
    target_id: conversationId,
    request_id: null,
    occurred_at: '2026-08-03T00:00:00.000Z',
    outcome: 'succeeded',
    ...overrides,
  };
}

function auditResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    items: [auditItem()],
    next_cursor: null,
    has_more: false,
    snapshot_at: '2026-08-04T00:00:00.000Z',
    filter_sha256: 'a'.repeat(64),
    receipt_id: receiptId,
    ...overrides,
  };
}

function searchRow(
  type: 'people' | 'conversations' | 'messages' | 'announcements' | 'handoffs',
  id: string,
  matchedSource: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    id,
    title: `Coverage ${type}`,
    snippet: 'Coverage snippet',
    conversation_id: type === 'people' ? null : conversationId,
    occurred_at: '2026-08-04T00:00:00.000Z',
    matched_source: matchedSource,
    matched_language: matchedSource === 'translation' ? 'es' : null,
    ...overrides,
  };
}

async function dependencyFailure(run: () => unknown | Promise<unknown>): Promise<void> {
  await assertRejects(
    async () => await run(),
    (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
  );
}

Deno.test('read audit parser validates ordering, filters, cursors, and nullable identities', async () => {
  const valid = parseAuditResponse(
    auditResponse({
      items: [
        auditItem({
          actor_user_id: userId,
          request_id: sessionId,
        }),
        auditItem({
          id: 1,
          occurred_at: '2026-08-02T00:00:00.000Z',
          outcome: 'denied',
        }),
      ],
      next_cursor: 'YWJjZA==',
      has_more: true,
    }),
    2,
  );
  assertEquals(valid.items.length, 2);
  assertEquals(valid.hasMore, true);

  for (
    const value of [
      auditResponse({ schema_version: 2 }),
      auditResponse({ items: 'invalid' }),
      auditResponse({ items: [auditItem(), auditItem()] }),
      auditResponse({ items: [auditItem({ id: false })] }),
      auditResponse({ items: [auditItem({ id: '0' })] }),
      auditResponse({
        items: [
          auditItem({ id: '2', occurred_at: '2026-08-03T00:00:00.000Z' }),
          auditItem({ id: '1', occurred_at: '2026-08-04T00:00:00.000Z' }),
        ],
      }),
      auditResponse({
        items: [auditItem({ id: '2' }), auditItem({ id: '3' })],
      }),
      auditResponse({ items: [auditItem({ event_type: '*bad' })] }),
      auditResponse({ items: [auditItem({ target_type: '*bad' })] }),
      auditResponse({ items: [auditItem({ target_id: 'bad\u0000id' })] }),
      auditResponse({ next_cursor: null, has_more: true }),
      auditResponse({ next_cursor: '*bad*', has_more: true }),
      auditResponse({ filter_sha256: 'x'.repeat(64) }),
    ]
  ) await dependencyFailure(() => parseAuditResponse(value, 1));
});

Deno.test('read search parser validates every result type, provenance, order, and cursor', async () => {
  const results = [
    searchRow('people', userId, 'profile', { occurred_at: '2026-08-05T00:00:00.000Z' }),
    searchRow('messages', '5', 'original', { occurred_at: '2026-08-04T00:00:00.000Z' }),
    searchRow('conversations', conversationId, 'conversation', {
      occurred_at: '2026-08-03T00:00:00.000Z',
    }),
    searchRow('announcements', receiptId, 'announcement', {
      occurred_at: '2026-08-02T00:00:00.000Z',
    }),
    searchRow('handoffs', sessionId, 'handoff', {
      occurred_at: '2026-08-01T00:00:00.000Z',
    }),
  ];
  const parsed = parseSearchResponse({ results, next_cursor: 'YWJjZA==', has_more: true }, 5) as {
    results: unknown[];
  };
  assertEquals(parsed.results.length, 5);

  const row = searchRow('messages', '5', 'translation');
  for (
    const value of [
      { results: 'invalid', next_cursor: null, has_more: false },
      { results: [row, row], next_cursor: null, has_more: false },
      { results: [searchRow('messages', '0', 'original')], next_cursor: null, has_more: false },
      { results: [searchRow('people', userId, 'message')], next_cursor: null, has_more: false },
      {
        results: [searchRow('people', userId, 'profile', { conversation_id: conversationId })],
        next_cursor: null,
        has_more: false,
      },
      {
        results: [searchRow('messages', '5', 'translation', { matched_language: null })],
        next_cursor: null,
        has_more: false,
      },
      {
        results: [
          searchRow('messages', '5', 'original', { occurred_at: '2026-08-03T00:00:00.000Z' }),
          searchRow('messages', '4', 'original', { occurred_at: '2026-08-04T00:00:00.000Z' }),
        ],
        next_cursor: null,
        has_more: false,
      },
      { results: [row], next_cursor: '*bad*', has_more: true },
      { results: [row], next_cursor: null, has_more: true },
    ]
  ) await dependencyFailure(() => parseSearchResponse(value, 1));
});

function dependencies(overrides: Partial<ReadDependencies> = {}): ReadDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'coverage-publishable',
      secretKey: 'coverage-secret',
    },
    authenticateActor: async () => actor,
    resolveOrganization: async (_actor, requested) => ({
      organizationId: requested ?? organizationId,
      principalContext: {},
    }),
    authorize: async () => ({}),
    rateLimit: async () => {},
    loadBootstrap: async () => ({ conversations: [] }),
    loadPreferences: async () => ({ uiLanguage: 'en' }),
    loadMessages: async () => ({ messages: [] }),
    loadPins: async () => ({ schemaVersion: 1, pins: [] }),
    loadMedia: async () => ({ schemaVersion: 1, items: [], hasMore: false }),
    loadSearch: async () => ({ results: [], nextCursor: null, hasMore: false }),
    loadUserSearch: async () => ({ users: [] }),
    loadAudit: async () => auditResponse({ items: [] }),
    recordAuditDenial: async () => {},
    ...overrides,
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://app.newone.example/api/newone${path}`, {
    method: 'POST',
    headers: {
      Origin: 'https://app.newone.example',
      Authorization: 'Bearer coverage-access-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function responseStatus(
  path: string,
  body: unknown,
  overrides: Partial<ReadDependencies> = {},
): Promise<number> {
  return (await createReadHandler(() => dependencies(overrides))(post(path, body))).status;
}

Deno.test('read handler covers route methods, bootstrap/message optionals, and response size gate', async () => {
  const handler = createReadHandler(() => dependencies());
  assertEquals(
    (await handler(
      new Request('https://app.newone.example/v2/bootstrap', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.newone.example',
          'Access-Control-Request-Method': 'POST',
        },
      }),
    )).status,
    204,
  );
  assertEquals(
    (await handler(
      new Request('https://app.newone.example/v2/bootstrap', {
        method: 'GET',
        headers: { Origin: 'https://app.newone.example' },
      }),
    )).status,
    404,
  );
  assertEquals(
    await responseStatus('/v2/bootstrap', {
      organizationId: null,
      selectedConversationId: conversationId,
      beforeMessageId: 5,
      conversationLimit: 1,
      timelineLimit: 2,
    }),
    200,
  );
  assertEquals(
    await responseStatus('/v2/bootstrap', {}, {
      loadBootstrap: async () => ({ oversized: 'x'.repeat(2_000_001) }),
    }),
    503,
  );
  assertEquals(
    await responseStatus(
      `/v2/conversations/${encodeURIComponent(conversationId)}/messages/query`,
      { organizationId, beforeMessageId: null, limit: 1 },
    ),
    200,
  );
  assertEquals(
    await responseStatus('/v2/conversations/%E0%A4%A/messages/query', {
      organizationId,
    }),
    400,
  );
  assertEquals(await responseStatus('/v2/preferences/organization/query', { organizationId }), 200);
  assertEquals(await responseStatus('/v2/not-found', {}), 404);
});

Deno.test('read handler search validation covers types, filters, date windows, and dependency receipts', async () => {
  const base = { organizationId, query: 'coverage' };
  assertEquals(await responseStatus('/v2/search', base), 200);
  assertEquals(
    await responseStatus('/v2/search', {
      ...base,
      types: ['messages'],
      senderMembershipId: userId,
      dateFrom: '2020-01-01T00:00:00.000Z',
      dateTo: '2021-01-01T00:00:00.000Z',
      matchSources: ['original'],
      conversationId,
      language: 'mixed',
      limit: 1,
    }),
    200,
  );
  for (
    const override of [
      { types: 'messages' },
      { types: [] },
      { types: ['messages', 'messages'] },
      { matchSources: 'original', types: ['messages'] },
      { matchSources: [], types: ['messages'] },
      { matchSources: ['original', 'original'], types: ['messages'] },
      { matchSources: ['original'], types: ['people'] },
      { senderMembershipId: userId, types: ['people'] },
      { dateFrom: '2026-08-04T00:00:00.000Z', dateTo: '2026-08-03T00:00:00.000Z' },
      { dateFrom: '2000-01-01T00:00:00.000Z', dateTo: '2026-01-01T00:00:00.000Z' },
    ]
  ) assertEquals(await responseStatus('/v2/search', { ...base, ...override }), 400);

  for (
    const loaded of [
      { results: 'invalid', nextCursor: null, hasMore: false },
      { results: [1, 2], nextCursor: null, hasMore: false },
      { results: [], nextCursor: null, hasMore: true },
      { results: [], nextCursor: '*bad*', hasMore: true },
    ]
  ) {
    assertEquals(
      await responseStatus('/v2/search', { ...base, limit: 1 }, {
        loadSearch: async () => loaded,
      }),
      503,
    );
  }
});

Deno.test('read handler audit validation and denial recording preserve the original authorization error', async () => {
  const base = {
    organizationId,
    reasonCode: 'security_review',
    dateFrom: '2026-07-01T00:00:00.000Z',
    dateTo: '2026-07-02T00:00:00.000Z',
  };
  assertEquals(
    await responseStatus('/v2/admin/audit/query', {
      ...base,
      eventTypes: ['security.reviewed'],
      actorMembershipId: userId,
      targetType: 'conversation',
      targetId: conversationId,
      limit: 1,
    }),
    200,
  );
  for (
    const override of [
      { dateFrom: '2026-07-03T00:00:00.000Z' },
      { dateFrom: '2020-01-01T00:00:00.000Z' },
      { eventTypes: 'invalid' },
      { eventTypes: Array(11).fill('security.reviewed') },
      { eventTypes: ['same.event', 'same.event'] },
      { eventTypes: ['*bad'] },
      { targetType: '*bad' },
      { targetId: 'bad\u0000id' },
    ]
  ) assertEquals(await responseStatus('/v2/admin/audit/query', { ...base, ...override }), 400);

  assertEquals(
    await responseStatus('/v2/admin/audit/query', base, {
      authorize: async () => {
        throw new ApiError(403, 'forbidden');
      },
      recordAuditDenial: async () => {
        throw new Error('audit sink unavailable');
      },
    }),
    403,
  );
});
