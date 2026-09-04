import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  createOutboxWorkerHandler,
  INVALIDATION_REASONS,
  type InvalidationEntityType,
  type OutboxWorkerDependencies,
  parseOutboxJobs,
} from '../newone-outbox-worker/handler.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

// Generic private inbox invalidations forwarded by the outbox worker. The
// (entity_type, reason) vocabulary must match
// private.workspace_invalidation_reason_allowed in the database
// (20260903030000_desync_audit_and_consumer_rules.sql).

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65_536,
  networkHashKey: 'n'.repeat(32),
  allowHttpLocal: false,
};
const workerToken = 'worker-token-that-is-at-least-32-characters';
const serverKey = 'server-secret-key';
const organizationId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000010';
const counterpartId = '00000000-0000-4000-8000-000000000011';
const conversationId = '00000000-0000-4000-8000-000000000030';
const rowId = '00000000-0000-4000-8000-000000000040';

// The database vocabulary, copied verbatim so a drift on either side fails
// this file rather than a production job.
const DATABASE_VOCABULARY: Record<string, string[]> = {
  contact_connection: [
    'contact_request_created',
    'contact_accepted',
    'contact_declined',
    'contact_cancelled',
    'contact_removed',
  ],
  member_block: ['member_blocked', 'member_unblocked'],
  reaction: ['reaction_added', 'reaction_removed'],
  pin: ['message_pinned', 'message_unpinned'],
  message_visibility: ['message_hidden_for_user'],
  message: ['message_deleted', 'message_edited'],
  attachment: [
    'attachment_uploaded',
    'attachment_scan_clean',
    'attachment_scan_quarantined',
    'attachment_scan_failed',
  ],
  translation: ['translation_completed', 'translation_failed', 'translation_blocked'],
  summary: ['summary_queued', 'summary_draft', 'summary_failed', 'summary_stale', 'summary_approved'],
  conversation: ['conversation_updated'],
  conversation_preference: ['conversation_preferences_updated'],
  profile: ['profile_updated', 'account_deleted'],
};

function entityIdFor(entityType: InvalidationEntityType): string {
  switch (entityType) {
    case 'contact_connection':
    case 'member_block':
      return counterpartId;
    case 'profile':
      return userId;
    case 'moderation_case':
    case 'attachment':
    case 'summary':
    case 'conversation':
    case 'conversation_preference':
      return rowId;
    default:
      return '42';
  }
}

function invalidationEnvelope(
  entityType: InvalidationEntityType,
  reason: string,
  patch: Record<string, unknown> = {},
) {
  return {
    topics: ['realtime_control'],
    jobs: [{
      id: 900,
      organization_id: organizationId,
      topic: 'realtime_control',
      attempts: 1,
      payload: {
        schema_version: 1,
        event_id: '00000000-0000-4000-8000-000000000093',
        event: 'workspace.invalidated',
        control_topic: `org:${organizationId}:user:${userId}:inbox`,
        organization_id: organizationId,
        occurred_at: '2026-09-03T12:00:00.000Z',
        user_id: userId,
        entity_type: entityType,
        entity_id: entityIdFor(entityType),
        conversation_id: conversationId,
        reason,
        ...patch,
      },
    }],
  };
}

function dependencies(overrides: Partial<OutboxWorkerDependencies> = {}): OutboxWorkerDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: serverKey,
    },
    workerToken,
    topics: ['realtime_control'],
    claim: async () => invalidationEnvelope('reaction', 'reaction_added'),
    dispatchPush: async () => {},
    dispatchRealtime: async () => {},
    expandModeration: async () => {},
    purgeStorage: async () => {},
    executeSessionRevoke: async () => {},
    dispatchDynamicGroup: async () => {},
    complete: async () => {},
    fail: async () => {},
    ...overrides,
  };
}

function request(): Request {
  return new Request('https://project.supabase.co/functions/v1/newone-outbox-worker', {
    method: 'POST',
    headers: {
      apikey: serverKey,
      'X-Newone-Worker-Token': workerToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 3 }),
  });
}

Deno.test('the worker vocabulary matches the database invalidation vocabulary exactly', () => {
  const worker = Object.fromEntries(
    Object.entries(INVALIDATION_REASONS)
      .filter(([entityType]) => entityType !== 'moderation_case')
      .map(([entityType, reasons]) => [entityType, [...reasons]]),
  );
  assertEquals(worker, DATABASE_VOCABULARY);
  assertEquals([...INVALIDATION_REASONS.moderation_case], [
    'case_available',
    'case_assigned',
    'case_reassigned',
    'case_status_changed',
  ]);
});

Deno.test('every (entity, reason) pair parses to one exact per-user inbox delivery', () => {
  for (const entityType of Object.keys(INVALIDATION_REASONS) as InvalidationEntityType[]) {
    for (const reason of INVALIDATION_REASONS[entityType]) {
      const parsed = parseOutboxJobs(
        invalidationEnvelope(entityType, reason),
        ['realtime_control'],
        3,
      );
      const payload = parsed[0]?.topic === 'realtime_control' ? parsed[0].payload : undefined;
      assert(payload?.event === 'workspace.invalidated', `${entityType}:${reason}`);
      assertEquals(payload.entityType, entityType);
      assertEquals(payload.reason, reason);
      assertEquals(payload.entityId, entityIdFor(entityType));
      assertEquals(payload.conversationId, conversationId);
      assertEquals(payload.controlTopic, `org:${organizationId}:user:${userId}:inbox`);
    }
  }
});

Deno.test('invalidations without a conversation id parse and dispatch without one', async () => {
  const envelope = invalidationEnvelope('profile', 'profile_updated');
  delete (envelope.jobs[0]?.payload as Record<string, unknown>).conversation_id;
  const parsed = parseOutboxJobs(envelope, ['realtime_control'], 3);
  const payload = parsed[0]?.topic === 'realtime_control' ? parsed[0].payload : undefined;
  assert(payload?.event === 'workspace.invalidated');
  assert(!('conversationId' in payload));

  const events: string[] = [];
  const handler = createOutboxWorkerHandler(() =>
    dependencies({
      claim: async () => invalidationEnvelope('summary', 'summary_draft'),
      dispatchRealtime: async (job) => {
        if (job.payload.event !== 'workspace.invalidated') throw new Error('unexpected job');
        assertEquals(job.payload.entityType, 'summary');
        assertEquals(job.payload.entityId, rowId);
        assertEquals(job.payload.conversationId, conversationId);
        assert(!('summaryBody' in job.payload));
        events.push(`${job.payload.reason}:${job.payload.userId}`);
      },
      complete: async (_workerId, job) => {
        events.push(`complete:${job.id}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(events, [`summary_draft:${userId}`, 'complete:900']);
});

Deno.test('invalidations reject unknown entities, foreign reasons, self-counterparts, content, and wrong topics', async () => {
  const cases: Array<[InvalidationEntityType, string, Record<string, unknown>]> = [
    // Unknown entity type and a reason from another entity's vocabulary.
    ['reaction', 'reaction_added', { entity_type: 'message' }],
    ['reaction', 'summary_draft', {}],
    ['summary', 'reaction_added', {}],
    ['contact_connection', 'case_available', {}],
    // Counterpart hints never name the addressed user.
    ['contact_connection', 'contact_removed', { entity_id: userId }],
    ['member_block', 'member_blocked', { entity_id: userId }],
    // Ids must have the entity's shape.
    ['reaction', 'reaction_added', { entity_id: rowId }],
    ['summary', 'summary_draft', { entity_id: '42' }],
    ['profile', 'profile_updated', { entity_id: 'not-a-uuid' }],
    // No content, no control topic, no other user's inbox.
    ['translation', 'translation_completed', { translated_body: 'must never travel' }],
    ['pin', 'message_pinned', { control_topic: `org:${organizationId}:user:${userId}:control` }],
    ['pin', 'message_pinned', { control_topic: `org:${organizationId}:user:${counterpartId}:inbox` }],
    ['conversation', 'conversation_updated', { conversation_id: 'not-a-uuid' }],
    ['attachment', 'attachment_scan_clean', { schema_version: 2 }],
  ];
  for (const [entityType, reason, patch] of cases) {
    await assertRejects(
      () =>
        Promise.resolve(parseOutboxJobs(
          invalidationEnvelope(entityType, reason, patch),
          ['realtime_control'],
          3,
        )),
      (error) => error instanceof ApiError && error.status === 503,
      `${entityType}:${reason}:${JSON.stringify(patch)}`,
    );
  }
});
