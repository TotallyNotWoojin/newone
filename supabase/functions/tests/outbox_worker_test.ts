import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  createOutboxWorkerHandler,
  genericNotification,
  notificationSuppressed,
  type OutboxJob,
  type OutboxTopic,
  type OutboxWorkerDependencies,
  parseOutboxJobs,
  parsePushPage,
  parseRealtimeFanout,
  providerPushData,
  type PushDelivery,
  type PushEvent,
  realtimeBroadcast,
  parseClaimedJobs,
} from '../newone-outbox-worker/handler.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

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
const conversationId = '00000000-0000-4000-8000-000000000030';

function controlEnvelope() {
  return {
    topics: ['realtime_control'],
    jobs: [{
      id: 701,
      organization_id: organizationId,
      topic: 'realtime_control',
      attempts: 1,
      payload: {
        event: 'membership.revoked',
        control_topic: `org:${organizationId}:user:${userId}:control`,
        organization_id: organizationId,
        user_id: userId,
        revocation_generation: 2,
      },
    }],
  };
}

function moderationEnvelope() {
  return {
    topics: ['realtime_control'],
    jobs: [{
      id: 706,
      organization_id: organizationId,
      topic: 'realtime_control',
      attempts: 1,
      payload: {
        schema_version: 1,
        event_id: '00000000-0000-4000-8000-000000000090',
        event: 'workspace.invalidated',
        control_topic: `org:${organizationId}:user:${userId}:inbox`,
        organization_id: organizationId,
        occurred_at: '2026-08-04T12:00:00.000Z',
        user_id: userId,
        entity_type: 'moderation_case',
        entity_id: '00000000-0000-4000-8000-000000000091',
        reason: 'case_assigned',
      },
    }],
  };
}

function contactEnvelope() {
  return {
    topics: ['realtime_control'],
    jobs: [{
      id: 708,
      organization_id: organizationId,
      topic: 'realtime_control',
      attempts: 1,
      payload: {
        schema_version: 1,
        event_id: '00000000-0000-4000-8000-000000000092',
        event: 'workspace.invalidated',
        control_topic: `org:${organizationId}:user:${userId}:inbox`,
        organization_id: organizationId,
        occurred_at: '2026-09-03T12:00:00.000Z',
        user_id: userId,
        entity_type: 'contact_connection',
        entity_id: '00000000-0000-4000-8000-000000000011',
        conversation_id: conversationId,
        reason: 'contact_accepted',
      },
    }],
  };
}

function moderationFanoutEnvelope(attempts = 1) {
  return {
    topics: ['moderation'],
    jobs: [{
      id: 707,
      organization_id: organizationId,
      topic: 'moderation',
      attempts,
      payload: {
        schema_version: 1,
        case_id: '00000000-0000-4000-8000-000000000091',
        state: 'open',
        reason: 'case_available',
        version: 1,
      },
    }],
  };
}

function dependencies(
  topics: OutboxTopic[] = ['realtime_control'],
  overrides: Partial<OutboxWorkerDependencies> = {},
): OutboxWorkerDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: serverKey,
    },
    workerToken,
    topics,
    claim: async () => controlEnvelope(),
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

function request(secret = workerToken): Request {
  return new Request('https://project.supabase.co/functions/v1/newone-outbox-worker', {
    method: 'POST',
    headers: {
      apikey: serverKey,
      'X-Newone-Worker-Token': secret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 3 }),
  });
}

function legacyBearerRequest(): Request {
  return new Request('https://project.supabase.co/functions/v1/newone-outbox-worker', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serverKey}`,
      'X-Newone-Worker-Token': workerToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 3 }),
  });
}

Deno.test('realtime offboarding dispatches only the exact per-user control topic before completion', async () => {
  const events: string[] = [];
  const handler = createOutboxWorkerHandler(() =>
    dependencies(['realtime_control'], {
      dispatchRealtime: async (job) => {
        if (job.payload.event !== 'membership.revoked') {
          throw new Error('expected membership revocation fixture');
        }
        events.push(`broadcast:${job.payload.controlTopic}:${job.payload.event}`);
        assertEquals(job.payload.organizationId, organizationId);
        assertEquals(job.payload.userId, userId);
        assertEquals(job.payload.revocationGeneration, 2);
      },
      complete: async (_workerId, job) => {
        events.push(`complete:${job.id}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    claimed: 1,
    completed: 1,
    failed: 0,
    topics: ['realtime_control'],
  });
  assertEquals(events, [
    `broadcast:org:${organizationId}:user:${userId}:control:membership.revoked`,
    'complete:701',
  ]);
});

Deno.test('mismatched or shared offboarding topics fail closed before dispatch', async () => {
  const envelope = controlEnvelope();
  const job = envelope.jobs[0];
  if (!job) throw new Error('fixture missing job');
  job.payload.control_topic = `org:${organizationId}:conversation:${conversationId}`;
  let dispatched = false;
  const failed: string[] = [];
  const handler = createOutboxWorkerHandler(() =>
    dependencies(['realtime_control'], {
      claim: async () => envelope,
      dispatchRealtime: async () => {
        dispatched = true;
      },
      fail: async (_workerId, failedJob, code) => {
        failed.push(`${failedJob.id}:${code}`);
      },
    })
  );
  // The unreadable job is failed on its own row and never dispatched; the
  // request itself succeeds so the rest of the batch is not held hostage.
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(dispatched, false);
  assertEquals(failed, [`${job.id}:invalid_payload`]);
  assertEquals(await response.json(), {
    claimed: 1,
    completed: 0,
    failed: 1,
    topics: ['realtime_control'],
  });
});

Deno.test('moderation invalidations are exact, per-user, and content-free', async () => {
  const events: string[] = [];
  const handler = createOutboxWorkerHandler(() =>
    dependencies(['realtime_control'], {
      claim: async () => moderationEnvelope(),
      dispatchRealtime: async (job) => {
        if (job.payload.event !== 'workspace.invalidated') {
          throw new Error('expected moderation invalidation fixture');
        }
        assertEquals(job.payload.controlTopic, `org:${organizationId}:user:${userId}:inbox`);
        assertEquals(job.payload.entityType, 'moderation_case');
        assertEquals(job.payload.reason, 'case_assigned');
        assert(!('reporterUserId' in job.payload));
        assert(!('messageBody' in job.payload));
        events.push(`${job.payload.event}:${job.payload.entityId}`);
      },
      complete: async (_workerId, job) => {
        events.push(`complete:${job.id}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(events, [
    'workspace.invalidated:00000000-0000-4000-8000-000000000091',
    'complete:706',
  ]);
});

Deno.test('moderation invalidations reject wrong topics and reporter or content fields', async () => {
  for (
    const patch of [{
      control_topic: `org:${organizationId}:user:${userId}:control`,
    }, {
      reporter_user_id: userId,
    }, {
      message_body: 'must never enter an invalidation',
    }, {
      entity_type: 'message',
    }]
  ) {
    const envelope = moderationEnvelope();
    Object.assign(envelope.jobs[0]?.payload ?? {}, patch);
    await assertRejects(
      () => parseOutboxJobs(envelope, ['realtime_control'], 3),
      (error) => error instanceof ApiError && error.status === 503,
    );
  }
});

Deno.test('contact invalidations name the counterpart and conversation for one participant', async () => {
  const events: string[] = [];
  const handler = createOutboxWorkerHandler(() =>
    dependencies(['realtime_control'], {
      claim: async () => contactEnvelope(),
      dispatchRealtime: async (job) => {
        if (
          job.payload.event !== 'workspace.invalidated' ||
          job.payload.entityType !== 'contact_connection'
        ) throw new Error('expected contact invalidation fixture');
        assertEquals(job.payload.controlTopic, `org:${organizationId}:user:${userId}:inbox`);
        assertEquals(job.payload.userId, userId);
        assertEquals(job.payload.entityId, '00000000-0000-4000-8000-000000000011');
        assertEquals(job.payload.conversationId, conversationId);
        assertEquals(job.payload.reason, 'contact_accepted');
        assert(!('messageBody' in job.payload));
        events.push(`${job.payload.event}:${job.payload.entityId}`);
      },
      complete: async (_workerId, job) => {
        events.push(`complete:${job.id}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(events, [
    'workspace.invalidated:00000000-0000-4000-8000-000000000011',
    'complete:708',
  ]);

  const withoutConversation = contactEnvelope();
  delete (withoutConversation.jobs[0]?.payload as Record<string, unknown>).conversation_id;
  const parsed = parseOutboxJobs(withoutConversation, ['realtime_control'], 3);
  const payload = parsed[0]?.topic === 'realtime_control' ? parsed[0].payload : undefined;
  assert(payload?.event === 'workspace.invalidated');
  assert(!('conversationId' in payload));
});

Deno.test('contact invalidations reject moderation reasons, self-targets, and content fields', async () => {
  for (
    const patch of [{
      reason: 'case_available',
    }, {
      entity_id: userId,
    }, {
      conversation_id: 'not-a-uuid',
    }, {
      control_topic: `org:${organizationId}:user:${userId}:control`,
    }, {
      message_body: 'must never enter an invalidation',
    }]
  ) {
    const envelope = contactEnvelope();
    Object.assign(envelope.jobs[0]?.payload ?? {}, patch);
    await assertRejects(
      () => parseOutboxJobs(envelope, ['realtime_control'], 3),
      (error) => error instanceof ApiError && error.status === 503,
    );
  }
});

Deno.test('moderation fanout validates a content-free intent and expands before completion', async () => {
  const events: string[] = [];
  const handler = createOutboxWorkerHandler(() =>
    dependencies(['moderation'], {
      claim: async () => moderationFanoutEnvelope(),
      expandModeration: async (_workerId, job) => {
        assertEquals(job.organizationId, organizationId);
        assertEquals(job.payload, {
          schemaVersion: 1,
          caseId: '00000000-0000-4000-8000-000000000091',
          state: 'open',
          reason: 'case_available',
          version: 1,
        });
        assert(!('reporterUserId' in job.payload));
        assert(!('subjectUserId' in job.payload));
        assert(!('messageBody' in job.payload));
        events.push(`expand:${job.id}`);
      },
      complete: async (_workerId, job) => {
        events.push(`complete:${job.id}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    claimed: 1,
    completed: 1,
    failed: 0,
    topics: ['moderation'],
  });
  assertEquals(events, ['expand:707', 'complete:707']);
});

Deno.test('moderation fanout rejects target, reporter, content, and malformed lifecycle fields', async () => {
  for (
    const patch of [{
      reporter_user_id: userId,
    }, {
      subject_user_id: userId,
    }, {
      message_body: 'must never enter the fanout queue',
    }, {
      conversation_id: conversationId,
    }, {
      schema_version: 2,
    }, {
      state: 'deleted',
    }, {
      reason: 'message_body_changed',
    }, {
      version: 0,
    }]
  ) {
    const envelope = moderationFanoutEnvelope();
    Object.assign(envelope.jobs[0]?.payload ?? {}, patch);
    await assertRejects(
      () => parseOutboxJobs(envelope, ['moderation'], 3),
      (error) => error instanceof ApiError && error.status === 503,
    );
  }
});

Deno.test('moderation fanout failure is failed without completion and retries expansion safely', async () => {
  const events: string[] = [];
  let claimNumber = 0;
  let expansionNumber = 0;
  const handler = createOutboxWorkerHandler(() =>
    dependencies(['moderation'], {
      claim: async () => moderationFanoutEnvelope(++claimNumber),
      expandModeration: async (_workerId, job) => {
        events.push(`expand:${job.attempts}`);
        expansionNumber += 1;
        if (expansionNumber === 1) {
          throw new ApiError(503, 'dependency_unavailable', undefined, 45);
        }
      },
      complete: async (_workerId, job) => {
        events.push(`complete:${job.attempts}`);
      },
      fail: async (_workerId, job, _code, retrySeconds) => {
        events.push(`fail:${job.attempts}:${retrySeconds}`);
      },
    })
  );

  const failed = await handler(request());
  assertEquals(failed.status, 200);
  assertEquals((await failed.json()).failed, 1);
  assertEquals(events, ['expand:1', 'fail:1:45']);

  const retried = await handler(request());
  assertEquals(retried.status, 200);
  assertEquals((await retried.json()).completed, 1);
  assertEquals(events, ['expand:1', 'fail:1:45', 'expand:2', 'complete:2']);
});

Deno.test('session revocation completes atomically and other durable topics complete only after dispatch', async () => {
  const envelope = {
    topics: ['dynamic_group_sync', 'session_revoke', 'storage_purge'],
    jobs: [{
      id: 702,
      organization_id: organizationId,
      topic: 'session_revoke',
      attempts: 1,
      payload: {
        organization_id: organizationId,
        user_id: userId,
        revocation_generation: 3,
      },
    }, {
      id: 703,
      organization_id: organizationId,
      topic: 'storage_purge',
      attempts: 1,
      payload: { attachment_id: '00000000-0000-4000-8000-000000000060' },
    }, {
      id: 704,
      organization_id: organizationId,
      topic: 'dynamic_group_sync',
      attempts: 1,
      payload: {
        policy_id: '00000000-0000-4000-8000-000000000080',
        conversation_id: conversationId,
        policy_version: 4,
        added_count: 12,
        removed_count: 2,
      },
    }],
  };
  const topics: OutboxTopic[] = ['storage_purge', 'session_revoke', 'dynamic_group_sync'];
  const events: string[] = [];
  const handler = createOutboxWorkerHandler(() =>
    dependencies(topics, {
      claim: async () => envelope,
      executeSessionRevoke: async (_workerId, job) => {
        events.push(`session:${job.id}`);
      },
      purgeStorage: async (job) => {
        events.push(`purge:${job.id}`);
      },
      dispatchDynamicGroup: async (job) => {
        events.push(`dynamic:${job.id}`);
      },
      complete: async (_workerId, job) => {
        events.push(`complete:${job.id}`);
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals((await response.json()).completed, 3);
  assertEquals(events, [
    'session:702',
    'purge:703',
    'complete:703',
    'dynamic:704',
    'complete:704',
  ]);
});

Deno.test('dispatch failures retry with bounded backoff and are never completed', async () => {
  const events: Array<{ kind: string; job?: OutboxJob; retry?: number }> = [];
  const handler = createOutboxWorkerHandler(() =>
    dependencies(['realtime_control'], {
      dispatchRealtime: async () => {
        throw new ApiError(503, 'dependency_unavailable', undefined, 75);
      },
      complete: async (_workerId, job) => {
        events.push({ kind: 'complete', job });
      },
      fail: async (_workerId, job, _code, retry) => {
        events.push({ kind: 'fail', job, retry });
      },
    })
  );
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals((await response.json()).failed, 1);
  assertEquals(events.length, 1);
  assertEquals(events[0]?.kind, 'fail');
  assertEquals(events[0]?.retry, 75);
});

Deno.test('topic-filtered claims and dual service authentication cannot be widened by request input', async () => {
  let claimed = false;
  const handler = createOutboxWorkerHandler(() =>
    dependencies(['realtime_control'], {
      claim: async () => {
        claimed = true;
        return controlEnvelope();
      },
    })
  );
  assertEquals((await handler(request('wrong-token'))).status, 401);
  assertEquals(claimed, false);

  const parsed = parseOutboxJobs(controlEnvelope(), ['realtime_control'], 3);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0]?.topic, 'realtime_control');
});

Deno.test('worker accepts opaque secret only in apikey and rejects legacy bearer misuse', async () => {
  let claimed = false;
  const handler = createOutboxWorkerHandler(() =>
    dependencies(['realtime_control'], {
      claim: async () => {
        claimed = true;
        return controlEnvelope();
      },
    })
  );
  assertEquals((await handler(legacyBearerRequest())).status, 401);
  assertEquals(claimed, false);
});

Deno.test('push claims accept only the current DB-owned entity and notification metadata', () => {
  const announcementId = '00000000-0000-4000-8000-000000000050';
  const announcementVersionId = '00000000-0000-4000-8000-000000000051';
  const workerId = '00000000-0000-4000-8000-000000000052';
  const envelope = {
    topics: ['push'],
    jobs: [{
      id: 801,
      organization_id: organizationId,
      topic: 'push',
      attempts: 1,
      payload: {
        organization_id: organizationId,
        conversation_id: conversationId,
        announcement_id: announcementId,
        announcement_version_id: announcementVersionId,
        target_user_id: userId,
        state: 'acknowledgement_reminder',
        notification_class: 'critical',
        critical_category: 'safety',
        quiet_hours_override_reason: 'Safety update acknowledgement remains overdue',
        reminder_number: 2,
        scheduler_worker_id: workerId,
      },
    }, {
      id: 802,
      organization_id: organizationId,
      topic: 'push',
      attempts: 1,
      payload: {
        organization_id: organizationId,
        conversation_id: conversationId,
        state: 'closed',
      },
    }, {
      id: 803,
      organization_id: organizationId,
      topic: 'push',
      attempts: 1,
      payload: {
        organization_id: organizationId,
        conversation_id: conversationId,
        handoff_id: '00000000-0000-4000-8000-000000000053',
        handoff_version_id: '00000000-0000-4000-8000-000000000054',
        state: 'acknowledgement_escalated',
        source_state: 'stale',
        notification_class: 'urgent',
        critical_category: 'operations',
        quiet_hours_override_reason: 'Handoff source messages changed before acknowledgement',
        scheduler_worker_id: workerId,
      },
    }],
  };
  assertEquals(parseOutboxJobs(envelope, ['push'], 3).length, 3);

  const invalid = structuredClone(envelope);
  (invalid.jobs[0]?.payload as Record<string, unknown>).quiet_hours_override = true;
  let rejected = false;
  try {
    parseOutboxJobs(invalid, ['push'], 3);
  } catch {
    rejected = true;
  }
  assertEquals(rejected, true);
});

Deno.test('private Realtime broadcast uses opaque apikey without fake bearer credentials', async () => {
  let url = '';
  let headers = new Headers();
  let body: unknown;
  await realtimeBroadcast(
    {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: serverKey,
    },
    `org:${organizationId}:user:${userId}:control`,
    'membership.revoked',
    { organizationId, userId, membershipGeneration: 2 },
    '00000000-0000-4000-8000-000000000099',
    async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 202 });
    },
  );
  assertEquals(
    url,
    `https://project.supabase.co/realtime/v1/api/broadcast/org%3A${organizationId}%3Auser%3A${userId}%3Acontrol/events/membership.revoked?private=true`,
  );
  assertEquals(headers.get('apikey'), serverKey);
  assertEquals(headers.get('authorization'), null);
  assertEquals(headers.get('x-request-id'), '00000000-0000-4000-8000-000000000099');
  assertEquals(body, {
    payload: { organizationId, userId, membershipGeneration: 2 },
  });
});

Deno.test('dynamic-group invalidation fanout accepts only current per-user inbox deliveries', () => {
  const eventId = '00000000-0000-4000-8000-000000000099';
  const delivery = {
    topic: `org:${organizationId}:user:${userId}:inbox`,
    event: 'workspace.invalidated',
    payload: {
      schema_version: 1,
      event_id: eventId,
      event: 'workspace.invalidated',
      organization_id: organizationId,
      occurred_at: '2026-08-04T12:00:00.000Z',
      conversation_id: conversationId,
      entity_type: 'conversation',
      entity_id: conversationId,
      version_id: '4',
      reason: 'dynamic_group_membership_changed',
    },
  };
  assertEquals(
    parseRealtimeFanout(
      { schema_version: 1, deliveries: [delivery] },
      organizationId,
      conversationId,
    ),
    [delivery],
  );

  let rejected = false;
  try {
    parseRealtimeFanout(
      {
        schema_version: 1,
        deliveries: [{
          ...delivery,
          topic: `org:${organizationId}:conversation:${conversationId}`,
        }],
      },
      organizationId,
      conversationId,
    );
  } catch {
    rejected = true;
  }
  assertEquals(rejected, true);
});

Deno.test('shift-aware suppression uses authoritative state and only server critical policy bypasses quiet', () => {
  const delivery: PushDelivery = {
    attemptId: '1',
    deviceId: '00000000-0000-4000-8000-000000000041',
    userId,
    installationId: '00000000-0000-4000-8000-000000000042',
    platform: 'ios',
    pushTokenType: 'expo',
    pushProjectId: '00000000-0000-4000-8000-000000000043',
    pushEnvironment: 'production',
    protectedToken: 'ciphertext'.repeat(10),
    locale: 'en-US',
    currentlyOffShift: null,
    notificationClass: 'routine',
    criticalCategory: null,
    quietHoursOverride: false,
    overrideReason: null,
    contentTitle: null,
    contentBody: null,
    translationPending: false,
    notificationsMuted: false,
    preferences: {
      notificationPreview: 'generic',
      soundEnabled: true,
      vibrationEnabled: true,
      shiftAwareSuppression: true,
      timeZone: 'UTC',
      quietHoursStart: null,
      quietHoursEnd: null,
      quietDays: [],
    },
  };
  const routine: PushEvent = {
    eventType: 'message.changed',
    organizationId,
    conversationId,
    messageId: '1',
  };
  // Unknown schedule data does not silence every notification forever.
  assertEquals(notificationSuppressed(delivery, routine), false);
  assertEquals(notificationSuppressed({ ...delivery, currentlyOffShift: true }, routine), true);

  const criticalDelivery: PushDelivery = {
    ...delivery,
    notificationClass: 'critical',
    criticalCategory: 'safety',
    quietHoursOverride: true,
    overrideReason: 'authorized critical notice',
  };
  assertEquals(
    notificationSuppressed({ ...criticalDelivery, currentlyOffShift: true }, routine),
    false,
  );
  assertEquals(
    notificationSuppressed(
      {
        ...criticalDelivery,
        currentlyOffShift: true,
        notificationClass: 'routine',
        criticalCategory: null,
        quietHoursOverride: false,
        overrideReason: null,
      },
      routine,
    ),
    true,
  );
  const providerData = providerPushData(routine, criticalDelivery);
  assertEquals(providerData.notification_preview, 'generic');
  assertEquals('override_reason' in providerData, false);
  assertEquals(JSON.stringify(providerData).includes('authorized critical notice'), false);
});

Deno.test('generic push copy serves every supported language explicitly and falls back to English', () => {
  const english = { title: 'Newone', body: 'Open Newone to view new activity.' };
  const spanish = { title: 'Newone', body: 'Abre Newone para ver la actividad.' };
  const korean = { title: 'Newone', body: '새 활동을 확인하려면 Newone을 여세요.' };
  // English is a first-class case, matched for the bare tag and any region.
  assertEquals(genericNotification('en'), english);
  assertEquals(genericNotification('en-US'), english);
  assertEquals(genericNotification('EN-GB'), english);
  assertEquals(genericNotification('es'), spanish);
  assertEquals(genericNotification('es-MX'), spanish);
  assertEquals(genericNotification('ko'), korean);
  assertEquals(genericNotification('ko-KR'), korean);
  // Unknown, unsupported, or missing locales keep the English fallback.
  for (const locale of [null, '', 'fr', 'de-DE', 'pt-BR', 'zz', 'zh-Hans-CN', 'e']) {
    assertEquals(genericNotification(locale), english);
  }
});

Deno.test('push resolver requires Expo project and environment binding', () => {
  const job = {
    id: '801',
    organizationId,
    attempts: 1,
    topic: 'push' as const,
  };
  const page = {
    job_id: 801,
    event: {
      event_type: 'message.changed',
      organization_id: organizationId,
      conversation_id: conversationId,
      message_id: 101,
    },
    deliveries: [{
      attempt_id: 901,
      device_id: '00000000-0000-4000-8000-000000000041',
      dispatch_status: 'pending',
      dispatchable: true,
      next_attempt_at: null,
      user_id: userId,
      installation_id: '00000000-0000-4000-8000-000000000042',
      platform: 'ios',
      push_token_type: 'expo',
      push_project_id: '00000000-0000-4000-8000-000000000043',
      push_environment: 'production',
      push_token_ciphertext: 'x'.repeat(80),
      locale: 'en-US',
      app_version: '1.0.0',
      currently_off_shift: null,
      notification_class: 'routine',
      critical_category: null,
      quiet_hours_override: false,
      quiet_hours_override_reason: null,
      preferences: {
        notification_preview: 'generic',
        sound_enabled: true,
        vibration_enabled: true,
        shift_aware_suppression: true,
        time_zone: 'UTC',
        quiet_hours_start: null,
        quiet_hours_end: null,
        quiet_days: [],
      },
    }],
    has_more: false,
    next_device_id: null,
  };
  const parsed = parsePushPage(page, job);
  assertEquals(parsed.deliveries[0]?.pushTokenType, 'expo');
  assertEquals(parsed.deliveries[0]?.pushEnvironment, 'production');
  // Deliveries without message content parse as content-free (legacy rows).
  assertEquals(parsed.deliveries[0]?.contentTitle, null);
  assertEquals(parsed.deliveries[0]?.contentBody, null);
  assertEquals(parsed.deliveries[0]?.translationPending, false);
  // Consumer rows carry the message text (translated when ready) and a hold flag.
  const withContent = structuredClone(page);
  Object.assign(withContent.deliveries[0] as Record<string, unknown>, {
    content_title: 'Kyle LEE',
    content_body: '¿Nos vemos a las 10?',
    translation_pending: true,
  });
  (withContent.deliveries[0] as { preferences: Record<string, unknown> }).preferences
    .notification_preview = 'content';
  const parsedContent = parsePushPage(withContent, job);
  assertEquals(parsedContent.deliveries[0]?.contentTitle, 'Kyle LEE');
  assertEquals(parsedContent.deliveries[0]?.contentBody, '¿Nos vemos a las 10?');
  assertEquals(parsedContent.deliveries[0]?.translationPending, true);
  assertEquals(parsedContent.deliveries[0]?.preferences.notificationPreview, 'content');
  let rejected = false;
  try {
    const withoutProject = structuredClone(page);
    delete (withoutProject.deliveries[0] as Record<string, unknown>).push_project_id;
    parsePushPage(withoutProject, job);
  } catch {
    rejected = true;
  }
  assertEquals(rejected, true);

  const closedIncident = structuredClone(page) as unknown as {
    job_id: number;
    event: Record<string, unknown>;
    deliveries: Array<Record<string, unknown>>;
    has_more: boolean;
    next_device_id: string | null;
  };
  closedIncident.event = {
    event_type: 'conversation.changed',
    organization_id: organizationId,
    conversation_id: conversationId,
    state: 'closed',
  };
  closedIncident.deliveries[0]!.notification_class = 'critical';
  closedIncident.deliveries[0]!.critical_category = 'operations';
  closedIncident.deliveries[0]!.quiet_hours_override = true;
  closedIncident.deliveries[0]!.quiet_hours_override_reason =
    'Incident closure requires immediate review';
  const parsedIncident = parsePushPage(closedIncident, job);
  assertEquals(parsedIncident.event.eventType, 'conversation.changed');
  assertEquals(parsedIncident.event.state, 'closed');
  assertEquals(parsedIncident.deliveries[0]?.criticalCategory, 'operations');
});

Deno.test('claimed payload shapes: targeted session revoke with owner, membership revoke with event stamps, invalid rows isolated', () => {
  const organization = '11111111-1111-4111-8111-111111111111';
  const user = '6c4cdc29-b1e3-4b99-ae0b-a95dbbe3a697';
  const envelope = {
    topics: ['session_revoke', 'realtime_control'],
    jobs: [
      {
        id: 615, organization_id: organization, topic: 'session_revoke', attempts: 18,
        payload: { session_id: 'd0fd192d-d672-4ddd-b7d3-4a07402c4559', user_id: user },
      },
      {
        id: 12, organization_id: organization, topic: 'session_revoke', attempts: 537,
        payload: { user_id: user, organization_id: organization, revocation_generation: 1 },
      },
      {
        id: 13, organization_id: organization, topic: 'realtime_control', attempts: 537,
        payload: {
          event: 'membership.revoked', user_id: user, event_id: '388510d6-3322-4c5b-a9b0-049bc29e7d6b',
          occurred_at: '2026-09-01T22:59:08.537885+00:00', schema_version: 1, organization_id: organization,
          control_topic: `org:${organization}:user:${user}:control`, revocation_generation: 1,
        },
      },
      {
        id: 99, organization_id: organization, topic: 'session_revoke', attempts: 3,
        payload: { session_id: 'not-a-uuid' },
      },
    ],
  };
  const claimed = parseClaimedJobs(envelope, ['session_revoke', 'realtime_control'], 10);
  assertEquals(claimed.jobs.map((job) => job.id), ['615', '12', '13']);
  assertEquals(claimed.invalid, [{ id: '99', topic: 'session_revoke', attempts: 3 }]);
  const revoked = claimed.jobs[2];
  if (revoked?.topic !== 'realtime_control' || revoked.payload.event !== 'membership.revoked') {
    throw new Error('expected the membership revoke job');
  }
  assertEquals(revoked.payload.revocationGeneration, 1);
});
