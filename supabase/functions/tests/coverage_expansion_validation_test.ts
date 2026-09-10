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

  const saved = matched('PATCH', `/v2/contacts/saved/${userId}`);
  await rejects(saved, { organizationId });
  parseCommand(saved, { organizationId, alias: null, isFavorite: true });
});

Deno.test('attachment and device validators fail closed', async () => {
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
  // The locale is informational: an unusable tag is dropped, never a reason
  // to refuse the registration (owner could not turn notifications on when
  // the phone reported "en-US-u-hc-h23", Sep 6 2026).
  const parsedDevice = await parseCommand(device, {
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
  assert(parsedDevice.values.locale === null);
  const parsedClock = await parseCommand(device, {
    organizationId,
    installationId: requestId,
    platform: 'ios',
    pushToken: 'ExpoPushToken[abcdefgh12345678]',
    pushTokenType: 'expo',
    pushProjectId: userId,
    pushEnvironment: 'production',
    appVersion: null,
    locale: 'en-US-u-hc-h23',
  });
  assert(parsedClock.values.locale === 'en-US');

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
    notificationsMuted: false,
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

});

Deno.test('acknowledgement, moderation, update, and summary parsers reject ambiguous contracts', async () => {
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

});

Deno.test('attachment, session, invite, audit, and remaining optional parsers cover both outcomes', async () => {
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

});
