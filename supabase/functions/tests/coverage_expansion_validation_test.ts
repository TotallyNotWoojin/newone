import {
  type MatchedRoute,
  matchRoute,
  parseCommand,
  type RouteKind,
} from '../newone-api/routes.ts';
import {
  notificationSuppressed,
  type OutboxTopic,
  parseOutboxJobs,
  parsePushPage,
  parseRealtimeFanout,
  providerPushData,
  type PushDelivery,
  type PushEvent,
  type PushJob,
} from '../newone-outbox-worker/handler.ts';
import { assert, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const conversationId = '20000000-0000-4000-8000-000000000002';
const userId = '30000000-0000-4000-8000-000000000003';
const requestId = '40000000-0000-4000-8000-000000000004';

function matched(method: string, path: string): MatchedRoute {
  const route = matchRoute(method, path);
  assert(route);
  return route;
}

function direct(kind: RouteKind, params: Record<string, string> = {}): MatchedRoute {
  return { kind, params, status: 200, template: `/coverage/${kind}` };
}

async function rejects(route: MatchedRoute, body: Record<string, unknown>): Promise<void> {
  await assertRejects(() => parseCommand(route, body));
}

Deno.test('route validators exercise malformed scalar, collection, and temporal boundaries', async () => {
  const send = matched('POST', `/v2/conversations/${conversationId}/messages`);
  const sendBase = {
    organizationId,
    clientMessageId: requestId,
    kind: 'text',
    body: 'Coverage message',
  };
  await rejects(send, { ...sendBase, body: '   ' });
  await rejects(send, { ...sendBase, languageCode: 'invalid language!' });
  await rejects(send, { ...sendBase, replyToMessageId: false });
  await rejects(send, { ...sendBase, replyToMessageId: '0' });
  await rejects(send, { ...sendBase, mentionUserIds: [userId, userId] });

  const edit = matched('PATCH', '/v2/messages/42');
  await rejects(edit, { organizationId, conversationId });
  await rejects(edit, { organizationId, conversationId, body: 'Text', delete: true });
  parseCommand(edit, { organizationId, conversationId, delete: true });

  const react = matched('POST', '/v2/messages/42/reactions');
  parseCommand(react, { organizationId, conversationId, emoji: '👍' });

  const translate = matched('POST', '/v2/messages/not-a-number/translations');
  await rejects(translate, { organizationId, conversationId, targetLanguage: 'es' });

  const moderation = matched('POST', '/v2/moderation/cases/query');
  await rejects(moderation, { organizationId, statuses: [] });
  await rejects(moderation, { organizationId, statuses: 'open' });
  await rejects(moderation, { organizationId, statuses: ['open', 'open'] });

  const summaryRequest = matched('POST', `/v2/conversations/${conversationId}/summaries`);
  await rejects(summaryRequest, { organizationId, sourceMessageIds: [], languageCode: 'en' });
  await rejects(summaryRequest, {
    organizationId,
    sourceMessageIds: [1, 1],
    languageCode: 'en',
  });
  await rejects(summaryRequest, {
    organizationId,
    sourceMessageIds: [false],
    languageCode: 'en',
  });
  await rejects(summaryRequest, {
    organizationId,
    sourceMessageIds: Array.from({ length: 501 }, (_, index) => index + 1),
    languageCode: 'en',
  });

  const manual = matched('POST', `/v2/conversations/${conversationId}/summaries/manual`);
  const manualBase = {
    organizationId,
    sourceMessageIds: ['1'],
    languageCode: 'en',
    primaryTopic: 'Coverage',
    summary: 'Coverage summary',
    keyTopics: ['Topic'],
    decisions: [{ text: 'Decision', sourceMessageIds: ['1'] }],
    actionItems: [{ text: 'Action', sourceMessageIds: ['1'], owner: null, due: null }],
    ambiguities: [],
  };
  parseCommand(manual, manualBase);
  await rejects(manual, {
    ...manualBase,
    decisions: [{ text: 'Unsupported', sourceMessageIds: [] }],
  });
  await rejects(manual, {
    ...manualBase,
    decisions: [{ text: 'Unsupported', sourceMessageIds: ['2'] }],
  });
  await rejects(manual, { ...manualBase, keyTopics: 'not-an-array' });

  const handoff = matched('POST', '/v2/handoffs');
  await rejects(handoff, {
    organizationId,
    conversationId,
    title: 'Shift handoff',
    details: 'Details',
    sourceLanguage: 'en',
    shiftStartedAt: '2026-08-04T12:00:00.000Z',
    shiftEndedAt: '2026-08-04T11:00:00.000Z',
    sourceMessageIds: [],
    acknowledgementDueAt: null,
  });

  const glossary = matched('POST', '/v2/glossary/proposals');
  await rejects(glossary, {
    organizationId,
    termId: null,
    sourceLanguage: 'en',
    targetLanguage: 'en',
    sourceTerm: 'term',
    translatedTerm: 'term',
    definition: null,
    reason: null,
  });

  const saved = matched('PATCH', `/v2/contacts/saved/${userId}`);
  await rejects(saved, { organizationId });
  parseCommand(saved, { organizationId, alias: null, isFavorite: true });
});

Deno.test('dynamic-group, announcement, attachment, invite, and role validators fail closed', async () => {
  const dynamic = matched('POST', '/v2/dynamic-groups/policies');
  const policySpec = {
    siteIds: [],
    departmentIds: [],
    teamIds: [],
    lineIds: [],
    unitIds: [],
    includeDescendants: false,
    operationalRoles: ['operator'],
    membershipRoles: ['member'],
    shiftMode: 'none',
    scheduledShiftStartsAt: null,
    scheduledShiftEndsAt: null,
  };
  const dynamicBase = {
    organizationId,
    conversationId,
    policyId: null,
    expectedVersion: 0,
    policySpec,
    maximumMembers: 50,
  };
  parseCommand(dynamic, dynamicBase);
  const { unitIds: _unitIds, ...incompletePolicy } = policySpec;
  await rejects(dynamic, { ...dynamicBase, policySpec: incompletePolicy });
  await rejects(dynamic, {
    ...dynamicBase,
    policySpec: { ...policySpec, operationalRoles: ['Operator', 'operator'] },
  });
  await rejects(dynamic, {
    ...dynamicBase,
    policySpec: { ...policySpec, membershipRoles: ['member', 'member'] },
  });
  await rejects(dynamic, {
    ...dynamicBase,
    policySpec: {
      ...policySpec,
      shiftMode: 'scheduled',
      scheduledShiftStartsAt: null,
      scheduledShiftEndsAt: null,
    },
  });
  await rejects(dynamic, {
    ...dynamicBase,
    policySpec: {
      ...policySpec,
      shiftMode: 'scheduled',
      scheduledShiftStartsAt: '2026-08-04T12:00:00.000Z',
      scheduledShiftEndsAt: '2026-09-20T12:00:00.000Z',
    },
  });

  const publish = matched('POST', '/v2/updates');
  const publishBase = {
    organizationId,
    conversationId,
    clientMessageId: requestId,
    title: 'Coverage update',
    body: 'Coverage body',
    languageCode: 'en',
    requiresAcknowledgement: false,
  };
  parseCommand(publish, publishBase);
  await rejects(publish, {
    ...publishBase,
    acknowledgementSchema: {
      schemaVersion: 1,
      attestationRequired: false,
      attestationPrompt: 'Unexpected prompt',
      requiredKeys: [],
      carryForwardOnCorrection: false,
    },
  });
  await rejects(publish, {
    ...publishBase,
    acknowledgementSchema: {
      schemaVersion: 1,
      attestationRequired: true,
      attestationPrompt: null,
      requiredKeys: [],
      carryForwardOnCorrection: false,
    },
  });
  await rejects(publish, {
    ...publishBase,
    acknowledgementSchema: {
      schemaVersion: 1,
      attestationRequired: true,
      attestationPrompt: 'I attest',
      requiredKeys: ['Bad-Key'],
      carryForwardOnCorrection: false,
    },
  });
  await rejects(publish, {
    ...publishBase,
    reminderPolicy: {
      enabled: false,
      deadlineAt: '2030-08-04T12:00:00.000Z',
      intervalSeconds: null,
      maximumReminders: 0,
      escalateAfterSeconds: null,
      smsFallback: false,
    },
  });
  await rejects(publish, {
    ...publishBase,
    requiresAcknowledgement: false,
    reminderPolicy: {
      enabled: true,
      deadlineAt: '2030-08-04T12:00:00.000Z',
      intervalSeconds: 900,
      maximumReminders: 1,
      escalateAfterSeconds: 1800,
      smsFallback: false,
    },
  });

  const upload = matched('POST', '/v2/attachments/grants');
  const uploadBase = {
    organizationId,
    action: 'upload',
    conversationId,
    messageId: '42',
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    byteSize: 100,
    sha256Hex: 'a'.repeat(64),
  };
  parseCommand(upload, uploadBase);
  await rejects(upload, { ...uploadBase, attachmentId: requestId });
  await rejects(upload, { ...uploadBase, fileName: '../report.pdf' });
  await rejects(upload, { ...uploadBase, mimeType: 'application/x-msdownload' });
  await rejects(upload, { ...uploadBase, sha256Hex: 'g'.repeat(64) });
  await rejects(upload, { ...uploadBase, messageId: {} });
  await rejects(upload, {
    organizationId,
    action: 'download',
    conversationId,
    attachmentId: requestId,
    fileName: 'must-not-be-present.pdf',
  });

  const complete = matched('POST', `/v2/attachments/${requestId}/complete`);
  await rejects(complete, {
    organizationId,
    bucket: 'wrong-bucket',
    path: 'safe/path',
    byteSize: 100,
    sha256Hex: 'a'.repeat(64),
  });
  await rejects(complete, {
    organizationId,
    bucket: 'message-attachments',
    path: '../unsafe/path',
    byteSize: 100,
    sha256Hex: 'a'.repeat(64),
  });

  const device = matched('POST', '/v2/devices');
  await rejects(device, {
    organizationId,
    installationId: requestId,
    platform: 'ios',
    pushToken: 'ExpoPushToken[abcdefgh12345678]',
    pushTokenType: 'expo',
    pushProjectId: userId,
    pushEnvironment: 'production',
    appVersion: null,
    locale: 'not a locale',
  });

  const invite = matched('POST', '/v2/admin/invitations');
  const inviteBase = {
    organizationId,
    destinationType: 'email',
    destination: 'member@example.com',
    employeeCode: null,
    activationMode: 'otp',
    role: 'member',
    expiresInSeconds: 3600,
    membershipType: 'employee',
    membershipAccessExpiresAt: null,
    guestSponsorUserId: null,
  };
  parseCommand(invite, inviteBase);
  await rejects(invite, { ...inviteBase, destination: 'not-an-email' });
  await rejects(invite, {
    ...inviteBase,
    destinationType: 'phone',
    destination: '+15555550123',
    employeeCode: 'bad code!',
    activationMode: 'manual',
  });

  const role = matched('POST', '/v2/admin/role-assignments');
  const roleBase = {
    organizationId,
    targetMembershipId: userId,
    roleName: 'site_admin',
    scopeType: 'organization',
    unitId: null,
    expiresAt: null,
    reason: 'Coverage role',
  };
  parseCommand(role, roleBase);
  await rejects(role, { ...roleBase, scopeType: 'unit', unitId: null });
  await rejects(role, { ...roleBase, expiresAt: '2020-01-01T00:00:00.000Z' });
});

Deno.test('outbox claim parsing validates every durable topic and optional payload field', async () => {
  const row = (topic: string, payload: Record<string, unknown>, id = '1') => ({
    id,
    organization_id: organizationId,
    topic,
    payload,
    attempts: 1,
  });
  const envelope = (topic: string, payload: Record<string, unknown>) => ({
    jobs: [row(topic, payload)],
    topics: [topic],
  });
  const bad = async (value: unknown, topics: OutboxTopic[] = ['push']) => {
    await assertRejects(() => parseOutboxJobs(value, topics, 3));
  };

  await bad({ jobs: 'not-an-array', topics: ['push'] });
  await bad({
    jobs: [row('push', {}), row('push', {}), row('push', {}), row('push', {})],
    topics: ['push'],
  });
  await bad({ jobs: [], topics: 'push' });
  await bad({ jobs: [], topics: ['moderation'] });
  await bad({ jobs: [row('moderation', {})], topics: ['push'] });

  const controlTopic = `org:${organizationId}:user:${userId}:control`;
  const realtimePayload = {
    event: 'membership.revoked',
    control_topic: controlTopic,
    organization_id: organizationId,
    user_id: userId,
    revocation_generation: 2,
  };
  parseOutboxJobs(envelope('realtime_control', realtimePayload), ['realtime_control'], 3);
  await bad(
    envelope('realtime_control', { ...realtimePayload, organization_id: conversationId }),
    ['realtime_control'],
  );
  await bad(
    envelope('realtime_control', { ...realtimePayload, control_topic: 'shared-control-topic' }),
    ['realtime_control'],
  );
  parseOutboxJobs(
    envelope('realtime_control', {
      schema_version: 1,
      event_id: requestId,
      event: 'workspace.invalidated',
      control_topic: `org:${organizationId}:user:${userId}:inbox`,
      organization_id: organizationId,
      occurred_at: '2026-08-04T12:00:00.000Z',
      user_id: userId,
      entity_type: 'moderation_case',
      entity_id: conversationId,
      reason: 'case_available',
    }),
    ['realtime_control'],
    3,
  );

  const moderationPayload = {
    schema_version: 1,
    case_id: requestId,
    state: 'open',
    reason: 'case_available',
    version: 1,
  };
  parseOutboxJobs(envelope('moderation', moderationPayload), ['moderation'], 3);
  await bad(envelope('moderation', { ...moderationPayload, schema_version: 2 }), ['moderation']);

  const storagePayload = {
    attachment_id: requestId,
    bucket_id: 'message-attachments',
    storage_path: `${organizationId}/safe/upload`,
    reason: 'retention_expired',
  };
  parseOutboxJobs(envelope('storage_purge', storagePayload), ['storage_purge'], 3);
  await bad(envelope('storage_purge', { ...storagePayload, bucket_id: 'other' }), [
    'storage_purge',
  ]);
  await bad(envelope('storage_purge', { ...storagePayload, storage_path: '../escape' }), [
    'storage_purge',
  ]);

  parseOutboxJobs(envelope('session_revoke', { session_id: requestId }), ['session_revoke'], 3);
  parseOutboxJobs(
    envelope('session_revoke', {
      user_id: userId,
      organization_id: organizationId,
      revocation_generation: 2,
    }),
    ['session_revoke'],
    3,
  );
  await bad(envelope('session_revoke', {}), ['session_revoke']);
  // A targeted revoke is enqueued with the session and its owner (the shape
  // the revoke route writes); membership fields on that shape are rejected.
  parseOutboxJobs(
    envelope('session_revoke', { session_id: requestId, user_id: userId }),
    ['session_revoke'],
    3,
  );
  await bad(
    envelope('session_revoke', { session_id: requestId, organization_id: organizationId }),
    ['session_revoke'],
  );
  await bad(
    envelope('session_revoke', {
      user_id: userId,
      organization_id: conversationId,
      revocation_generation: 2,
    }),
    ['session_revoke'],
  );

  parseOutboxJobs(
    envelope('dynamic_group_sync', {
      policy_id: requestId,
      conversation_id: conversationId,
      policy_version: 2,
      added_count: 4,
      removed_count: 1,
    }),
    ['dynamic_group_sync'],
    3,
  );

  const pushPayload = {
    organization_id: organizationId,
    conversation_id: conversationId,
    message_id: '42',
    announcement_id: requestId,
    announcement_version_id: userId,
    handoff_id: requestId,
    handoff_version_id: userId,
    state: 'published',
    notification_class: 'critical',
    critical_category: 'safety',
    quiet_hours_override_reason: 'Safety event',
    target_user_id: userId,
    reminder_number: 2,
    scheduler_worker_id: requestId,
    source_state: 'current',
  };
  parseOutboxJobs(envelope('push', pushPayload), ['push'], 3);
  await bad(envelope('push', { organization_id: conversationId, conversation_id: conversationId }));
  await bad(envelope('push', { organization_id: organizationId }));
  await bad(envelope('push', { ...pushPayload, message_id: '0' }));
});

Deno.test('outbox push pages and realtime fanout cover cursor and event variants', async () => {
  const job: PushJob = { id: '50', organizationId, topic: 'push', attempts: 1 };
  const baseEvent = {
    event_type: 'message.changed',
    organization_id: organizationId,
    conversation_id: conversationId,
    message_id: '42',
    state: 'published',
  };
  const basePage = {
    job_id: '50',
    event: baseEvent,
    deliveries: [],
    has_more: false,
    next_device_id: null,
  };
  parsePushPage(basePage, job);
  for (
    const event of [
      {
        event_type: 'announcement.changed',
        organization_id: organizationId,
        announcement_id: requestId,
        announcement_version_id: userId,
      },
      { event_type: 'handoff.changed', organization_id: organizationId, handoff_id: requestId },
      {
        event_type: 'conversation.changed',
        organization_id: organizationId,
        conversation_id: conversationId,
      },
    ]
  ) parsePushPage({ ...basePage, event }, job);

  await assertRejects(() => parsePushPage({ ...basePage, job_id: '49' }, job));
  await assertRejects(() => parsePushPage({ ...basePage, deliveries: 'invalid' }, job));
  await assertRejects(() => parsePushPage({ ...basePage, has_more: true }, job));
  await assertRejects(() =>
    parsePushPage({
      ...basePage,
      event: { event_type: 'message.changed', organization_id: organizationId },
    }, job)
  );

  const fanoutPayload = {
    schema_version: 1,
    event_id: requestId,
    event: 'workspace.invalidated',
    organization_id: organizationId,
    occurred_at: '2026-08-04T12:00:00.000Z',
    conversation_id: conversationId,
    entity_type: 'conversation',
    entity_id: conversationId,
    version_id: '2',
    reason: 'membership_changed',
  };
  const fanout = {
    schema_version: 1,
    deliveries: [{
      topic: `org:${organizationId}:user:${userId}:inbox`,
      event: 'workspace.invalidated',
      payload: fanoutPayload,
    }],
  };
  parseRealtimeFanout(fanout, organizationId, conversationId);
  await assertRejects(() =>
    parseRealtimeFanout({ ...fanout, schema_version: 2 }, organizationId, conversationId)
  );
  await assertRejects(() =>
    parseRealtimeFanout({ ...fanout, deliveries: 'invalid' }, organizationId, conversationId)
  );
  await assertRejects(() =>
    parseRealtimeFanout(
      {
        ...fanout,
        deliveries: [{ ...fanout.deliveries[0], topic: 'shared-topic' }],
      },
      organizationId,
      conversationId,
    )
  );
  await assertRejects(() =>
    parseRealtimeFanout(
      {
        ...fanout,
        deliveries: [{ ...fanout.deliveries[0], event: 'wrong-event' }],
      },
      organizationId,
      conversationId,
    )
  );

  const delivery: PushDelivery = {
    attemptId: '1',
    deviceId: requestId,
    userId,
    installationId: requestId,
    platform: 'ios',
    pushTokenType: 'expo',
    pushProjectId: requestId,
    pushEnvironment: 'production',
    protectedToken: 'ciphertext:v1:0000000000000000.0000000000000000000000',
    locale: 'es-MX',
    currentlyOffShift: true,
    notificationClass: 'routine',
    criticalCategory: null,
    quietHoursOverride: false,
    overrideReason: null,
    contentTitle: null,
    contentBody: null,
    translationPending: false,
    preferences: {
      notificationPreview: 'hidden',
      soundEnabled: false,
      vibrationEnabled: false,
      shiftAwareSuppression: true,
      timeZone: 'America/Denver',
      quietHoursStart: null,
      quietHoursEnd: null,
      quietDays: [],
    },
  };
  const event: PushEvent = {
    eventType: 'message.changed',
    organizationId,
    conversationId,
    messageId: '42',
    announcementId: requestId,
    announcementVersionId: userId,
    handoffId: requestId,
    state: 'published',
  };
  assert(notificationSuppressed(delivery, event));
  assert(providerPushData(event, delivery).handoff_id === requestId);
});

Deno.test('conversation, preference, audience, and AI-policy parsers cover optional boundaries', async () => {
  const group = direct('conversation.group');
  const groupBase = {
    organizationId,
    name: 'Coverage group',
    memberAssignments: [{ membershipId: userId, role: 'member' }],
  };
  parseCommand(group, groupBase);
  parseCommand(group, {
    ...groupBase,
    description: null,
    kind: 'incident',
    unitId: null,
    historyPolicy: 'all',
    postingMode: 'admins_only',
    joinPolicy: 'invite_only',
    incidentSeverity: 'high',
    incidentClassification: 'safety',
  });
  await rejects(group, { ...groupBase, memberAssignments: 'invalid' });
  await rejects(group, { ...groupBase, memberAssignments: [] });
  await rejects(group, {
    ...groupBase,
    memberAssignments: [
      { membershipId: userId, role: 'member' },
      { membershipId: userId, role: 'admin' },
    ],
  });
  await rejects(group, { ...groupBase, kind: 'group', incidentSeverity: 'high' });
  await rejects(group, { ...groupBase, kind: 'incident', incidentSeverity: 'high' });
  await rejects(group, {
    ...groupBase,
    kind: 'incident',
    joinPolicy: 'approval_required',
    incidentSeverity: 'high',
    incidentClassification: 'safety',
  });

  const conversationPreferences = direct('conversation.preferences.update', { conversationId });
  await rejects(conversationPreferences, { organizationId });
  parseCommand(conversationPreferences, {
    organizationId,
    isFavorite: true,
    isPinned: false,
    isArchived: true,
    notificationLevel: 'mentions',
    mutedUntil: null,
    translationMode: 'off',
  });
  parseCommand(conversationPreferences, {
    organizationId,
    mutedUntil: '2030-01-01T00:00:00.000Z',
  });

  const organizationPreferences = direct('organization.preferences.update');
  await rejects(organizationPreferences, { organizationId });
  await rejects(organizationPreferences, { organizationId, quietHoursStart: '09:00' });
  await rejects(organizationPreferences, {
    organizationId,
    quietHoursStart: null,
    quietHoursEnd: '10:00',
  });
  await rejects(organizationPreferences, {
    organizationId,
    quietHoursStart: '25:00',
    quietHoursEnd: '10:00',
  });
  await rejects(organizationPreferences, { organizationId, quietDays: 'invalid' });
  await rejects(organizationPreferences, { organizationId, quietDays: [] });
  await rejects(organizationPreferences, { organizationId, quietDays: [1, 1] });
  parseCommand(organizationPreferences, {
    organizationId,
    uiLanguage: 'en-US',
    messageLanguage: null,
    timeZone: 'America/Denver',
    quietHoursStart: '09:00:00',
    quietHoursEnd: '17:00:00',
    quietDays: [6, 0],
    notificationPreview: 'hidden',
    soundEnabled: false,
    vibrationEnabled: false,
    shiftAwareSuppression: true,
    readVisibility: 'contacts',
  });

  const preview = direct('update.preview');
  parseCommand(preview, { organizationId, conversationId });
  parseCommand(preview, {
    organizationId,
    conversationId,
    limit: 1,
    audienceSpec: {
      company: true,
      conversationMembers: false,
      siteIds: [requestId],
      departmentIds: [],
      teamIds: [],
      unitIds: [],
      operationalRoles: ['operator'],
      membershipRoles: ['member'],
      languages: ['EN-us'],
      currentShiftOnly: true,
    },
  });
  for (
    const audienceSpec of [
      { operationalRoles: ['operator', 'OPERATOR'] },
      { membershipRoles: ['member', 'member'] },
      { languages: ['en', 'EN'] },
      { languages: Array(21).fill('en') },
      { languages: [false] },
    ]
  ) {
    await rejects(preview, { organizationId, conversationId, audienceSpec });
  }

  const aiPolicy = direct('organization.ai_policy.update');
  const aiBase = {
    organizationId,
    enabled: true,
    approvedUseCases: ['translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    expectedVersion: 0,
    reason: 'Coverage policy',
  };
  parseCommand(aiPolicy, aiBase);
  parseCommand(aiPolicy, {
    ...aiBase,
    enabled: false,
    approvedUseCases: [],
    providerAllowlist: [],
    routePolicy: 'deny',
  });
  for (
    const override of [
      { approvedUseCases: ['translation', 'translation'] },
      { providerAllowlist: ['google', 'google'] },
      { providerAllowlist: [false] },
      { approvedUseCases: [] },
      { providerAllowlist: [] },
      { routePolicy: 'deny' },
      { enabled: false },
      { enabled: false, routePolicy: 'deny', approvedUseCases: ['translation'] },
      { enabled: false, routePolicy: 'deny', providerAllowlist: ['google'] },
    ]
  ) {
    await rejects(aiPolicy, { ...aiBase, ...override });
  }
});

Deno.test('acknowledgement, moderation, update, and summary parsers reject ambiguous contracts', async () => {
  const publish = direct('update.publish');
  const publishBase = {
    organizationId,
    conversationId,
    clientMessageId: requestId,
    title: 'Coverage update',
    body: 'Coverage body',
    languageCode: 'en',
  };
  parseCommand(publish, publishBase);
  parseCommand(publish, { ...publishBase, expiresAt: '2030-01-01T00:00:00.000Z' });
  const disabledReminder = {
    enabled: false,
    deadlineAt: null,
    intervalSeconds: null,
    maximumReminders: 0,
    escalateAfterSeconds: null,
    smsFallback: false,
  };
  for (
    const reminderPolicy of [
      { ...disabledReminder, deadlineAt: '2030-01-02T00:00:00.000Z' },
      { ...disabledReminder, intervalSeconds: 300 },
      { ...disabledReminder, maximumReminders: 1 },
      { ...disabledReminder, escalateAfterSeconds: 900 },
      { ...disabledReminder, smsFallback: true },
    ]
  ) {
    await rejects(publish, { ...publishBase, reminderPolicy });
  }
  const enabledReminder = {
    enabled: true,
    deadlineAt: '2030-01-02T00:00:00.000Z',
    intervalSeconds: 900,
    maximumReminders: 2,
    escalateAfterSeconds: 1800,
    smsFallback: false,
  };
  parseCommand(publish, {
    ...publishBase,
    requiresAcknowledgement: true,
    scheduledAt: '2030-01-01T00:00:00.000Z',
    priority: 'important',
    notificationClass: 'urgent',
    criticalCategory: 'operations',
    quietHoursOverrideReason: 'Operational coverage',
    reminderPolicy: enabledReminder,
    acknowledgementSchema: {
      schemaVersion: 1,
      attestationRequired: true,
      attestationPrompt: 'Confirm coverage',
      requiredKeys: ['confirmed'],
      carryForwardOnCorrection: true,
    },
  });
  for (
    const reminderPolicy of [
      { ...enabledReminder, deadlineAt: null },
      { ...enabledReminder, deadlineAt: '2029-12-31T00:00:00.000Z' },
      { ...enabledReminder, intervalSeconds: null },
      { ...enabledReminder, maximumReminders: 0 },
      { ...enabledReminder, escalateAfterSeconds: 900, intervalSeconds: 1800 },
      { ...enabledReminder, smsFallback: true },
    ]
  ) {
    await rejects(publish, {
      ...publishBase,
      requiresAcknowledgement: true,
      scheduledAt: '2030-01-01T00:00:00.000Z',
      reminderPolicy,
    });
  }
  await rejects(publish, { ...publishBase, priority: 'important', notificationClass: 'routine' });
  await rejects(publish, { ...publishBase, criticalCategory: 'safety' });
  await rejects(publish, {
    ...publishBase,
    priority: 'important',
    criticalCategory: null,
    quietHoursOverrideReason: 'Coverage override',
  });

  const acknowledge = direct('update.acknowledge', { versionId: requestId });
  parseCommand(acknowledge, { organizationId });
  parseCommand(acknowledge, {
    organizationId,
    deviceId: null,
    attestation: { text: 'confirmed', accepted: true, count: 1 },
  });
  for (
    const attestation of [
      { ['x'.repeat(9000)]: 'x' },
      Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key${index}`, true])),
      { 'Bad-Key': true },
      { valid_key: null },
      { valid_key: {} },
      { valid_key: Number.NaN },
    ]
  ) {
    await rejects(acknowledge, { organizationId, attestation });
  }

  const transition = direct('moderation.case.transition', { caseId: requestId });
  const transitionBase = {
    organizationId,
    status: 'in_review',
    expectedVersion: 1,
    reason: 'Coverage review',
  };
  parseCommand(transition, transitionBase);
  parseCommand(transition, {
    ...transitionBase,
    status: 'resolved',
    evidenceMetadata: {
      referenceIds: ['evidence-1'],
      policyCode: 'policy:coverage',
      severity: 'high',
    },
  });
  await rejects(transition, { ...transitionBase, status: 'resolved' });
  await rejects(transition, {
    ...transitionBase,
    evidenceMetadata: { referenceIds: ['same', 'same'] },
  });
  await rejects(transition, {
    ...transitionBase,
    evidenceMetadata: { policyCode: '*invalid' },
  });

  const manual = direct('summary.manual.create', { conversationId });
  const manualBase = {
    organizationId,
    sourceMessageIds: ['1'],
    languageCode: 'en',
    primaryTopic: 'Coverage',
    summary: 'Summary',
    keyTopics: [],
    decisions: [],
    actionItems: [],
    ambiguities: [],
  };
  await rejects(manual, { ...manualBase, decisions: 'invalid' });
  await rejects(manual, {
    ...manualBase,
    actionItems: Array(101).fill({ text: 'Action', sourceMessageIds: ['1'] }),
  });

  const review = direct('summary.review', { summaryId: requestId });
  parseCommand(review, { organizationId, decision: 'approve' });
  parseCommand(review, { organizationId, decision: 'reject', note: 'Not supported' });
  await rejects(review, { organizationId, decision: 'reject', note: '  ' });
  const policyRoute = direct('summary.policy.update', { conversationId });
  parseCommand(policyRoute, { organizationId, mode: 'manual' });
  parseCommand(policyRoute, {
    organizationId,
    mode: 'message_count',
    messageCountThreshold: 20,
  });
  await rejects(policyRoute, { organizationId, mode: 'message_count' });
  await rejects(policyRoute, { organizationId, mode: 'manual', messageCountThreshold: 20 });
});

Deno.test('attachment, session, invite, audit, and remaining optional parsers cover both outcomes', async () => {
  const controls = direct('organization.conversation_controls.update');
  await rejects(controls, { organizationId, reason: 'Coverage reason' });

  const memberRole = direct('conversation.member.role.update', {
    conversationId,
    membershipId: userId,
  });
  await rejects(memberRole, { organizationId, expectedRole: 'member', newRole: 'member' });
  parseCommand(memberRole, { organizationId, expectedRole: 'member', newRole: 'admin' });

  // Profile pictures (owner backlog v2): same metadata discipline as group avatars.
  const profileGrant = direct('profile.avatar.grant');
  const profileBase = {
    organizationId,
    fileName: 'me.png',
    mimeType: 'image/png',
    byteSize: 1024,
    sha256Hex: 'a'.repeat(64),
  };
  parseCommand(profileGrant, profileBase);
  for (
    const override of [
      { fileName: 'bad/name.png' },
      { mimeType: 'image/gif' },
      { byteSize: 5 * 1024 * 1024 + 1 },
      { sha256Hex: 'zz' },
    ]
  ) await rejects(profileGrant, { ...profileBase, ...override });
  const profileUser = '11111111-1111-4111-8111-111111111111';
  const profileUpload = '22222222-2222-4222-8222-222222222222';
  parseCommand(direct('profile.avatar.query', { userId: profileUser }), { organizationId });
  await rejects(direct('profile.avatar.query', { userId: profileUser }), { organizationId, extra: true });
  const activate = direct('profile.avatar.activate', { uploadId: profileUpload });
  parseCommand(activate, { organizationId, expectedAvatarPath: null });
  parseCommand(activate, {
    organizationId,
    expectedAvatarPath: `${organizationId}/${profileUser}/${profileUpload}/avatar`,
  });
  await rejects(activate, { organizationId, expectedAvatarPath: `${organizationId}/${profileUser}/${profileUpload}/upload` });
  await rejects(activate, { organizationId, expectedAvatarPath: 'not/a/path' });
  const remove = direct('profile.avatar.remove');
  parseCommand(remove, { organizationId, expectedAvatarPath: `${organizationId}/${profileUser}/${profileUpload}/avatar` });
  await rejects(remove, { organizationId, expectedAvatarPath: null });
  const avatarGrant = direct('conversation.avatar.grant', { conversationId });
  const avatarBase = {
    organizationId,
    fileName: 'avatar.png',
    mimeType: 'image/png',
    byteSize: 100,
    sha256Hex: 'a'.repeat(64),
  };
  parseCommand(avatarGrant, avatarBase);
  for (
    const override of [
      { fileName: 'bad/name.png' },
      { fileName: 'bad\\name.png' },
      { mimeType: 'text/plain' },
      { sha256Hex: 'x'.repeat(64) },
    ]
  ) await rejects(avatarGrant, { ...avatarBase, ...override });

  const leave = direct('conversation.leave', { conversationId });
  parseCommand(leave, {
    organizationId,
    replacementOwnerMembershipId: userId,
    confirmHistoryAndAccessLoss: true,
  });
  await rejects(leave, { organizationId, confirmHistoryAndAccessLoss: false });

  const send = direct('message.send', { conversationId });
  parseCommand(send, {
    organizationId,
    clientMessageId: requestId,
    kind: 'attachment',
    body: null,
    languageCode: null,
    replyToMessageId: null,
    threadRootMessageId: '2',
  });
  const react = direct('message.react', { messageId: '1' });
  parseCommand(react, { organizationId, conversationId, emoji: '👍', active: false });

  const preservation = direct('message.preservation.place', { messageId: '1' });
  await rejects(preservation, {
    organizationId,
    conversationId,
    holdType: 'legal',
    reasonCode: 'coverage',
    policyReferenceSha256: 'x'.repeat(64),
  });

  const correction = direct('translation.correction.propose', {
    messageId: '1',
    targetLanguage: 'es',
  });
  parseCommand(correction, {
    organizationId,
    conversationId,
    correctedBody: 'Corregido',
    rationale: 'Coverage rationale',
  });

  const errorReport = direct('ai_output.error.report');
  parseCommand(errorReport, {
    organizationId,
    outputKind: 'summary',
    summaryId: requestId,
    category: 'unsupported_claim',
    details: 'Coverage details',
    highConsequence: false,
    qualityUseConsent: true,
    consentVersion: 'coverage-v1',
  });

  const attachment = direct('attachment.grant');
  const upload = {
    organizationId,
    action: 'upload',
    conversationId,
    messageId: '1',
    fileName: 'coverage.pdf',
    mimeType: 'application/pdf',
    byteSize: 100,
    sha256Hex: 'a'.repeat(64),
  };
  parseCommand(attachment, upload);
  await rejects(attachment, { ...upload, attachmentId: requestId });
  await rejects(attachment, { ...upload, fileName: 'bad/name.pdf' });
  await rejects(attachment, { ...upload, fileName: 'bad\\name.pdf' });
  await rejects(attachment, { ...upload, mimeType: 'application/octet-stream' });
  await rejects(attachment, { ...upload, sha256Hex: 'x'.repeat(64) });
  await rejects(attachment, {
    organizationId,
    action: 'download',
    conversationId,
    attachmentId: requestId,
    fileName: 'unexpected',
  });

  const complete = direct('attachment.complete', { attachmentId: requestId });
  const completeBase = {
    organizationId,
    bucket: 'message-attachments',
    path: `${organizationId}/${conversationId}/${userId}/${requestId}/upload`,
    byteSize: 100,
    sha256Hex: 'a'.repeat(64),
  };
  parseCommand(complete, completeBase);
  for (
    const override of [
      { bucket: 'other' },
      { path: 'bad/../path' },
      { path: '/absolute/path' },
      { sha256Hex: 'x'.repeat(64) },
    ]
  ) await rejects(complete, { ...completeBase, ...override });

  const devicePreferences = direct('device.preferences.update', { installationId: requestId });
  await rejects(devicePreferences, { organizationId, expectedVersion: 1, patch: {} });
  parseCommand(devicePreferences, {
    organizationId,
    expectedVersion: 1,
    patch: { notificationPreview: null, soundEnabled: null, vibrationEnabled: null },
  });
  parseCommand(devicePreferences, {
    organizationId,
    expectedVersion: 1,
    patch: { notificationPreview: 'generic', soundEnabled: true, vibrationEnabled: false },
  });

  const invite = direct('invite.issue');
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  parseCommand(invite, {
    organizationId,
    destinationType: 'phone',
    destination: '+15551234567',
    employeeCode: 'EMP-123',
    activationMode: 'manual',
    role: 'member',
    expiresInSeconds: 900,
    membershipType: 'guest',
    membershipAccessExpiresAt: future,
    guestSponsorUserId: userId,
  });
  await rejects(invite, {
    organizationId,
    destinationType: 'phone',
    destination: 'not-phone',
    activationMode: 'otp',
    role: 'member',
  });
  await rejects(invite, {
    organizationId,
    destinationType: 'email',
    destination: 'coverage@example.com',
    activationMode: 'manual',
    role: 'member',
  });

  const audit = direct('audit.export');
  const auditBase = {
    organizationId,
    reasonCode: 'security_review',
    format: 'json',
    dateFrom: '2026-07-01T00:00:00.000Z',
    dateTo: '2026-07-02T00:00:00.000Z',
  };
  parseCommand(audit, auditBase);
  await rejects(audit, { ...auditBase, eventTypes: Array(11).fill('event.type') });
  await rejects(audit, { ...auditBase, eventTypes: ['same.type', 'same.type'] });
  await rejects(audit, { ...auditBase, targetType: '*bad' });
  await rejects(audit, { ...auditBase, targetId: 'bad\u0000id' });
});
