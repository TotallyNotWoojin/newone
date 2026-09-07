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

const actor = {
  user: { id: '00000000-0000-4000-8000-000000000010' },
  claims: {
    sub: '00000000-0000-4000-8000-000000000010',
    sessionId: '00000000-0000-4000-8000-000000000020',
    aal: 'aal1',
    issuedAt: 1,
    expiresAt: 9999999999,
  },
  token: 'access-token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(['https://app.newone.example']),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65536,
  networkHashKey: 'n'.repeat(32),
  cursorSigningKey: 'c'.repeat(32),
  allowHttpLocal: false,
};

const organizationId = '00000000-0000-4000-8000-000000000001';

function dependencies(overrides: Partial<ReadDependencies> = {}): ReadDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: 'secret',
    },
    authenticateActor: async () => actor,
    resolveOrganization: async () => ({ organizationId, principalContext: {} }),
    authorize: async () => {},
    rateLimit: async () => {},
    loadBootstrap: async () => ({ selectedOrganizationId: organizationId }),
    loadPreferences: async () => ({ organizationId }),
    loadMessages: async () => ({ messages: [], page: {} }),
    loadPins: async () => ({ schemaVersion: 1, pins: [] }),
    loadMedia: async () => ({ schemaVersion: 1, items: [], hasMore: false }),
    loadSearch: async () => ({ results: [], nextCursor: null, hasMore: false }),
    loadUserSearch: async () => ({ users: [] }),
    loadAudit: async () => ({
      schema_version: 1,
      items: [],
      next_cursor: null,
      has_more: false,
      snapshot_at: new Date().toISOString(),
      filter_sha256: 'a'.repeat(64),
      receipt_id: '00000000-0000-4000-8000-000000000071',
    }),
    recordAuditDenial: async () => {},
    ...overrides,
  };
}

function request(path: string, body: unknown): Request {
  return new Request(`https://app.newone.example/api/newone${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer access-token-that-is-long-enough',
      'Content-Type': 'application/json',
      Origin: 'https://app.newone.example',
    },
    body: JSON.stringify(body),
  });
}

Deno.test('bootstrap reauthorizes an active membership before every bounded read', async () => {
  const calls: string[] = [];
  let bootstrapInput: unknown;
  const handler = createReadHandler(() =>
    dependencies({
      resolveOrganization: async () => {
        calls.push('resolve');
        return { organizationId, principalContext: {} };
      },
      authorize: async (_actor, _organizationId, policy) => {
        calls.push(`authorize:${policy.operation}`);
      },
      rateLimit: async (_request, _config, _actor, _organizationId, operation) => {
        calls.push(`rate:${operation}`);
      },
      loadBootstrap: async (_actor, _resolved, input) => {
        calls.push('load');
        bootstrapInput = input;
        return { selectedOrganizationId: organizationId };
      },
    })
  );
  const response = await handler(request('/v2/bootstrap', { organizationId }));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('cache-control'), 'private, no-store');
  assertEquals(calls, [
    'resolve',
    'authorize:read.bootstrap',
    'rate:read.bootstrap',
    'load',
  ]);
  assertEquals(bootstrapInput, {
    selectedConversationId: null,
    beforeMessageId: null,
    conversationLimit: 100,
    timelineLimit: 50,
  });
});

Deno.test('bootstrap accepts a bounded selected timeline without global message fan-out', async () => {
  let bootstrapInput: unknown;
  const selectedConversationId = '00000000-0000-4000-8000-000000000030';
  const handler = createReadHandler(() =>
    dependencies({
      loadBootstrap: async (_actor, _resolved, input) => {
        bootstrapInput = input;
        return { conversations: [], timeline: { messages: [] } };
      },
    })
  );
  const response = await handler(request('/v2/bootstrap', {
    organizationId,
    selectedConversationId,
    beforeMessageId: '9007199254740993',
    conversationLimit: 25,
    timelineLimit: 40,
  }));
  assertEquals(response.status, 200);
  assertEquals(bootstrapInput, {
    selectedConversationId,
    beforeMessageId: '9007199254740993',
    conversationLimit: 25,
    timelineLimit: 40,
  });
});

Deno.test('cross-tenant and suspended membership reads fail before data loading', async () => {
  let loaded = false;
  const crossTenant = createReadHandler(() =>
    dependencies({
      resolveOrganization: async () => {
        throw new ApiError(403, 'forbidden');
      },
      loadBootstrap: async () => {
        loaded = true;
        return {};
      },
    })
  );
  const crossTenantResponse = await crossTenant(
    request('/v2/bootstrap', {
      organizationId: '00000000-0000-4000-8000-000000000099',
    }),
  );
  assertEquals(crossTenantResponse.status, 403);
  assertEquals(loaded, false);

  const suspended = createReadHandler(() =>
    dependencies({
      authorize: async () => {
        throw new ApiError(403, 'forbidden');
      },
      loadBootstrap: async () => {
        loaded = true;
        return {};
      },
    })
  );
  const suspendedResponse = await suspended(request('/v2/bootstrap', { organizationId }));
  assertEquals(suspendedResponse.status, 403);
  assertEquals(loaded, false);
});

Deno.test('message history uses a bounded before-message body parameter and rejects oversized responses', async () => {
  let input: unknown;
  const handler = createReadHandler(() =>
    dependencies({
      loadMessages: async (_actor, value) => {
        input = value;
        return { messages: [], page: {} };
      },
    })
  );
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const response = await handler(request(`/v2/conversations/${conversationId}/messages/query`, {
    organizationId,
    beforeMessageId: '9007199254740993',
    limit: 25,
  }));
  assertEquals(response.status, 200);
  assertEquals(input, {
    organizationId,
    conversationId,
    beforeMessageId: '9007199254740993',
    limit: 25,
  });

  const oversized = createReadHandler(() =>
    dependencies({ loadBootstrap: async () => ({ value: 'x'.repeat(2_000_001) }) })
  );
  const oversizedResponse = await oversized(request('/v2/bootstrap', { organizationId }));
  assertEquals(oversizedResponse.status, 503);
});

Deno.test('search keeps employee queries in a bounded authenticated request body', async () => {
  let input: unknown;
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const handler = createReadHandler(() =>
    dependencies({
      loadSearch: async (_actor, value) => {
        input = value;
        return { results: [], nextCursor: null, hasMore: false };
      },
    })
  );
  const response = await handler(request('/v2/search', {
    organizationId,
    query: 'handoff pump pressure',
    types: ['messages'],
    senderMembershipId: actor.user.id,
    matchSources: ['original', 'attachment_filename'],
    dateFrom: '2026-08-01T00:00:00-06:00',
    dateTo: '2026-08-04T23:59:59-06:00',
    conversationId,
    language: 'ko',
    limit: 15,
  }));
  assertEquals(response.status, 200);
  assertEquals(input, {
    organizationId,
    query: 'handoff pump pressure',
    types: ['messages'],
    cursor: null,
    limit: 15,
    senderUserId: actor.user.id,
    dateFrom: '2026-08-01T06:00:00.000Z',
    dateTo: '2026-08-05T05:59:59.000Z',
    matchSources: ['original', 'attachment_filename'],
    conversationId,
    language: 'ko',
  });
});

Deno.test('search rejects an unsupported language before database access', async () => {
  let loaded = false;
  const handler = createReadHandler(() =>
    dependencies({
      loadSearch: async () => {
        loaded = true;
        return { results: [], nextCursor: null, hasMore: false };
      },
    })
  );
  const response = await handler(request('/v2/search', {
    organizationId,
    query: 'pump',
    language: 'fr',
  }));
  assertEquals(response.status, 400);
  assertEquals(loaded, false);
});

Deno.test('search rejects message-only filters on mixed result types before database access', async () => {
  let loaded = false;
  const handler = createReadHandler(() =>
    dependencies({
      loadSearch: async () => {
        loaded = true;
        return { results: [], nextCursor: null, hasMore: false };
      },
    })
  );
  const response = await handler(request('/v2/search', {
    organizationId,
    query: 'pump',
    types: ['messages', 'people'],
    matchSources: ['translation'],
  }));
  assertEquals(response.status, 400);
  assertEquals(loaded, false);
});

Deno.test('search continuation cursors are signed, expiring, actor-bound envelopes', async () => {
  const databaseCursor = btoa(JSON.stringify({ version: 1, id: '91' }));
  const inputs: unknown[] = [];
  const handler = createReadHandler(() =>
    dependencies({
      loadSearch: async (_actor, value) => {
        inputs.push(value);
        return inputs.length === 1
          ? { results: [], nextCursor: databaseCursor, hasMore: true }
          : { results: [], nextCursor: null, hasMore: false };
      },
    })
  );
  const firstResponse = await handler(request('/v2/search', {
    organizationId,
    query: 'pump',
    types: ['messages'],
  }));
  assertEquals(firstResponse.status, 200);
  const firstPage = await firstResponse.json();
  assertEquals(typeof firstPage.nextCursor, 'string');
  assertEquals(firstPage.nextCursor === databaseCursor, false);

  const secondResponse = await handler(request('/v2/search', {
    organizationId,
    query: 'pump',
    types: ['messages'],
    cursor: firstPage.nextCursor,
  }));
  assertEquals(secondResponse.status, 200);
  assertEquals((inputs[1] as { cursor: string }).cursor, databaseCursor);

  const tampered = `${firstPage.nextCursor.slice(0, -1)}${
    firstPage.nextCursor.endsWith('0') ? '1' : '0'
  }`;
  const tamperedResponse = await handler(request('/v2/search', {
    organizationId,
    query: 'pump',
    types: ['messages'],
    cursor: tampered,
  }));
  assertEquals(tamperedResponse.status, 400);
});

Deno.test('search response labels authorized source text and rejects impossible source metadata', async () => {
  const conversationId = '00000000-0000-4000-8000-000000000030';
  const response = parseSearchResponse({
    results: [{
      type: 'messages',
      id: 91,
      title: 'Jordan Lee',
      snippet: '압력 점검 완료',
      conversation_id: conversationId,
      occurred_at: '2026-08-04T12:00:00Z',
      matched_source: 'translation',
      matched_language: 'ko',
    }, {
      type: 'messages',
      id: 92,
      title: 'Jordan Lee',
      snippet: 'pump-inspection.pdf',
      conversation_id: conversationId,
      occurred_at: '2026-08-04T11:00:00Z',
      matched_source: 'attachment_filename',
      matched_language: null,
    }],
    next_cursor: null,
    has_more: false,
  }, 20);
  assertEquals(response, {
    results: [{
      type: 'messages',
      id: '91',
      title: 'Jordan Lee',
      snippet: '압력 점검 완료',
      conversationId,
      occurredAt: '2026-08-04T12:00:00.000Z',
      matchedSource: 'translation',
      matchedLanguage: 'ko',
    }, {
      type: 'messages',
      id: '92',
      title: 'Jordan Lee',
      snippet: 'pump-inspection.pdf',
      conversationId,
      occurredAt: '2026-08-04T11:00:00.000Z',
      matchedSource: 'attachment_filename',
      matchedLanguage: null,
    }],
    nextCursor: null,
    hasMore: false,
  });
  await assertRejects(() =>
    parseSearchResponse({
      results: [{
        type: 'people',
        id: actor.user.id,
        title: 'Jordan Lee',
        snippet: 'must not be attachment metadata',
        conversation_id: null,
        occurred_at: '2026-08-04T12:00:00Z',
        matched_source: 'attachment_filename',
        matched_language: null,
      }],
      next_cursor: null,
      has_more: false,
    }, 20)
  );
  await assertRejects(() =>
    parseSearchResponse({
      results: [{
        type: 'messages',
        id: 92,
        title: 'Jordan Lee',
        snippet: 'older row placed first',
        conversation_id: conversationId,
        occurred_at: '2026-08-04T11:00:00Z',
        matched_source: 'original',
        matched_language: 'en',
      }, {
        type: 'messages',
        id: 91,
        title: 'Jordan Lee',
        snippet: 'newer row placed second',
        conversation_id: conversationId,
        occurred_at: '2026-08-04T12:00:00Z',
        matched_source: 'original',
        matched_language: 'en',
      }],
      next_cursor: null,
      has_more: false,
    }, 20)
  );
});

Deno.test('organization preferences read is reauthorized and rate limited', async () => {
  const calls: string[] = [];
  const handler = createReadHandler(() =>
    dependencies({
      authorize: async (_actor, _organizationId, policy) => {
        calls.push(`authorize:${policy.operation}`);
      },
      rateLimit: async (_request, _config, _actor, _organizationId, operation) => {
        calls.push(`rate:${operation}`);
      },
      loadPreferences: async (_actor, requestedOrganizationId) => {
        calls.push(`load:${requestedOrganizationId}`);
        return { organizationId: requestedOrganizationId, uiLanguage: 'en' };
      },
    })
  );
  const response = await handler(request('/v2/preferences/organization/query', {
    organizationId,
  }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { organizationId, uiLanguage: 'en' });
  assertEquals(calls, [
    'authorize:organization.preferences.read',
    'rate:organization.preferences.read',
    `load:${organizationId}`,
  ]);
});

Deno.test('audit reads require recent AAL2, bind signed cursors, and expose content-free rows', async () => {
  const now = Date.now();
  const dateFrom = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const dateTo = new Date(now).toISOString();
  const databaseCursor = btoa(JSON.stringify({ version: 1, before_id: '41' }));
  const inputs: unknown[] = [];
  const policies: unknown[] = [];
  const handler = createReadHandler(() =>
    dependencies({
      authorize: async (_actor, _organizationId, policy) => {
        policies.push(policy);
      },
      loadAudit: async (_actor, input) => {
        inputs.push(input);
        return {
          schema_version: 1,
          items: inputs.length === 1
            ? [{
              id: '42',
              actor_user_id: actor.user.id,
              event_type: 'member.suspended',
              target_type: 'membership',
              target_id: '00000000-0000-4000-8000-000000000099',
              request_id: null,
              occurred_at: dateTo,
              outcome: 'succeeded',
            }]
            : [],
          next_cursor: inputs.length === 1 ? databaseCursor : null,
          has_more: inputs.length === 1,
          snapshot_at: dateTo,
          filter_sha256: 'a'.repeat(64),
          receipt_id: '00000000-0000-4000-8000-000000000071',
        };
      },
    })
  );
  const body = {
    organizationId,
    reasonCode: 'security_review',
    dateFrom,
    dateTo,
    eventTypes: ['member.suspended'],
    targetType: 'membership',
    targetId: null,
    limit: 25,
  };
  const first = await handler(request('/v2/admin/audit/query', body));
  assertEquals(first.status, 200);
  const firstBody = await first.json();
  assertEquals(firstBody.items[0].eventType, 'member.suspended');
  assertEquals(typeof firstBody.nextCursor, 'string');
  assertEquals(firstBody.nextCursor === databaseCursor, false);
  assertEquals(policies, [{ operation: 'audit.query', requireAal2: true, recentAuthSeconds: 900 }]);
  assertEquals((inputs[0] as { reasonCode: string }).reasonCode, 'security_review');

  const second = await handler(request('/v2/admin/audit/query', {
    ...body,
    cursor: firstBody.nextCursor,
  }));
  assertEquals(second.status, 200);
  assertEquals((inputs[1] as { cursor: string }).cursor, databaseCursor);

  const tampered = `${firstBody.nextCursor.slice(0, -1)}${
    firstBody.nextCursor.endsWith('0') ? '1' : '0'
  }`;
  assertEquals(
    (await handler(request('/v2/admin/audit/query', {
      ...body,
      cursor: tampered,
    }))).status,
    400,
  );
});

Deno.test('audit read authorization denials are recorded only after tenant membership resolves', async () => {
  const now = Date.now();
  const body = {
    organizationId,
    reasonCode: 'security_review',
    dateFrom: new Date(now - 60_000).toISOString(),
    dateTo: new Date(now).toISOString(),
  };
  const calls: string[] = [];
  const denied = createReadHandler(() =>
    dependencies({
      resolveOrganization: async () => {
        calls.push('resolve');
        return { organizationId, principalContext: {} };
      },
      rateLimit: async (_request, _config, _actor, _organizationId, operation) => {
        calls.push(`rate:${operation}`);
      },
      authorize: async (_actor, _organizationId, policy) => {
        calls.push(`authorize:${policy.operation}`);
        throw new ApiError(403, 'forbidden');
      },
      recordAuditDenial: async (_actor, requestedOrganizationId, operation) => {
        calls.push(`record:${requestedOrganizationId}:${operation}`);
        throw new Error('the audit writer must not replace the original denial');
      },
      loadAudit: async () => {
        calls.push('load');
        return {};
      },
    })
  );
  assertEquals((await denied(request('/v2/admin/audit/query', body))).status, 403);
  assertEquals(calls, [
    'resolve',
    'rate:audit.query',
    'authorize:audit.query',
    `record:${organizationId}:audit.query`,
  ]);

  calls.length = 0;
  const unresolved = createReadHandler(() =>
    dependencies({
      resolveOrganization: async () => {
        calls.push('resolve');
        throw new ApiError(403, 'forbidden');
      },
      authorize: async () => {
        calls.push('authorize');
      },
      recordAuditDenial: async () => {
        calls.push('record');
      },
      loadAudit: async () => {
        calls.push('load');
        return {};
      },
    })
  );
  assertEquals((await unresolved(request('/v2/admin/audit/query', body))).status, 403);
  assertEquals(calls, ['resolve']);

  calls.length = 0;
  const throttled = createReadHandler(() =>
    dependencies({
      resolveOrganization: async () => {
        calls.push('resolve');
        return { organizationId, principalContext: {} };
      },
      rateLimit: async () => {
        calls.push('rate');
        throw new ApiError(429, 'rate_limited', undefined, 60);
      },
      authorize: async () => {
        calls.push('authorize');
        throw new ApiError(403, 'forbidden');
      },
      recordAuditDenial: async () => {
        calls.push('record');
      },
    })
  );
  const throttledResponse = await throttled(request('/v2/admin/audit/query', body));
  assertEquals(throttledResponse.status, 429);
  assertEquals(throttledResponse.headers.get('retry-after'), '60');
  assertEquals(calls, ['resolve', 'rate']);
});

Deno.test('audit read validation rejects missing purpose, future windows, and content-bearing rows', async () => {
  const now = Date.now();
  let loaded = false;
  const handler = createReadHandler(() =>
    dependencies({
      loadAudit: async () => {
        loaded = true;
        return {};
      },
    })
  );
  assertEquals(
    (await handler(request('/v2/admin/audit/query', {
      organizationId,
      dateFrom: new Date(now - 60_000).toISOString(),
      dateTo: new Date(now).toISOString(),
    }))).status,
    400,
  );
  assertEquals(
    (await handler(request('/v2/admin/audit/query', {
      organizationId,
      reasonCode: 'access_review',
      dateFrom: new Date(now + 10 * 60_000).toISOString(),
      dateTo: new Date(now + 11 * 60_000).toISOString(),
    }))).status,
    400,
  );
  assertEquals(loaded, false);

  await assertRejects(() =>
    Promise.resolve(parseAuditResponse({
      schema_version: 1,
      items: [{
        id: '1',
        actor_user_id: actor.user.id,
        event_type: 'message.updated',
        target_type: 'message',
        target_id: '41',
        request_id: null,
        occurred_at: new Date(now).toISOString(),
        outcome: 'succeeded',
        metadata: { body: 'must never cross the audit boundary' },
      }],
      next_cursor: null,
      has_more: false,
      snapshot_at: new Date(now).toISOString(),
      filter_sha256: 'a'.repeat(64),
      receipt_id: '00000000-0000-4000-8000-000000000071',
    }, 50))
  );
});
