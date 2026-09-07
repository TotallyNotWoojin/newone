import assert from 'node:assert/strict';
import test from 'node:test';

import {
  offlineIdentityExpiresAt,
  parseOfflineIdentity,
  retainSessionForMembershipFailure,
  serializeOfflineIdentity,
} from '../apps/newone/src/data/persistence/offline-identity.mjs';
import {
  offlineWorkspaceCacheKey,
  offlineWorkspaceExpiresAt,
  offlineWorkspaceSnapshotExpiresAt,
  parseOfflineWorkspace,
  serializeOfflineWorkspace,
} from '../apps/newone/src/data/persistence/offline-workspace.mjs';
import {
  editUnattemptedMessageCommand,
  retryFailedMessageCommand,
  visibleMessageOutbox,
} from '../apps/newone/src/data/persistence/outbox-controls.mjs';
import { createCoalescedRunner } from '../apps/newone/src/data/reconciliation/coalesced-runner.mjs';
import {
  compareMessageIds,
  firstUnreadMessageId,
  latestIncomingServerMessage,
  mergeTimelineMessages,
} from '../apps/newone/src/data/reconciliation/message-timeline.mjs';
import { notificationDestination } from '../apps/newone/src/device/notification-route.mjs';
import {
  conversationOutboxCommandIds,
  redactDepartedConversation,
} from '../apps/newone/src/features/chat/conversation-departure-state.mjs';
import {
  isValidMentionSelection,
  mentionablePeople,
  normalizeMentionSelection,
  parseMentionDto,
} from '../apps/newone/src/features/chat/mention-controls.mjs';
import {
  normalizeOrganizationAiPolicyUpdate,
  parseOrganizationAiPolicy,
  parseOrganizationAiPolicyUpdateReceipt,
} from '../apps/newone/src/data/repositories/ai-policy-dto.mjs';
import {
  normalizeDeviceNotificationPreferencePatch,
  parseDeviceNotificationPreferences,
} from '../apps/newone/src/data/repositories/device-notification-preferences-dto.mjs';
import {
  parseConversationMemberRoleReceipt,
  parseGroupCreationCandidates,
  parseGroupCreationReceipt,
} from '../apps/newone/src/data/repositories/group-creation-dto.mjs';
import {
  parseDynamicGroupPauseReceipt,
  parseDynamicGroupPolicyList,
  parseDynamicGroupPolicySpec,
  parseDynamicGroupPreviewReceipt,
  parseDynamicGroupPublishReceipt,
  parseDynamicGroupSaveReceipt,
} from '../apps/newone/src/data/repositories/dynamic-group-dto.mjs';
import {
  normalizeHandoffCorrectionRequest,
  parseHandoffCorrectionReceipt,
} from '../apps/newone/src/data/repositories/handoff-correction-dto.mjs';
import {
  parseModerationAssignmentReceipt,
  parseModerationCaseDetail,
  parseModerationCaseList,
  parseModerationTransitionReceipt,
} from '../apps/newone/src/data/repositories/moderation-case-dto.mjs';
import {
  maskedRecoveryCaseReference,
  parseRecoveryApprovalReceipt,
  parseRecoveryCaseCreateReceipt,
  parseRecoveryCaseList,
  parseRecoveryExecutionReceipt,
  parseRecoveryRejectionReceipt,
  parseRecoveryVerificationReceipt,
  parseVerifiedTotpFactors,
} from '../apps/newone/src/data/repositories/recovery-case-dto.mjs';
import {
  normalizeOrganizationPolicyUpdate,
  parseOrganizationPolicy,
} from '../apps/newone/src/data/repositories/organization-policy-dto.mjs';
import {
  mergeSearchResults,
  normalizeSearchRequest,
  parseSearchPage,
  searchDateBoundary,
} from '../apps/newone/src/data/search-contract.mjs';

const ids = Object.freeze({
  user: '10000000-0000-4000-8000-000000000001',
  organization: '20000000-0000-4000-8000-000000000002',
  conversation: '30000000-0000-4000-8000-000000000003',
  case: '40000000-0000-4000-8000-000000000004',
  factor: '50000000-0000-4000-8000-000000000005',
  other: '60000000-0000-4000-8000-000000000006',
  third: '70000000-0000-4000-8000-000000000007',
  fourth: '80000000-0000-4000-8000-000000000008',
});

const now = Date.parse('2026-08-04T12:00:00.000Z');
const clone = (value) => structuredClone(value);

function assertThrowsEach(action, values, pattern) {
  for (const [label, value] of values) {
    assert.throws(() => action(value), pattern, label);
  }
}

function baseOfflineSnapshot() {
  return {
    organizationId: ids.organization,
    organizationName: 'Coverage workspace',
    conversationControlsVersion: 2,
    currentUser: {
      id: ids.user,
      preferredLanguage: 'ko',
      membershipType: 'employee',
      accessExpiresAt: null,
      guestSponsorUserId: null,
    },
    messageDisplayLanguage: 'es',
    conversations: [{ id: ids.conversation }],
    messages: { [ids.conversation]: [{ id: 'message-1', conversationId: ids.conversation }] },
    people: [],
    units: [],
    updates: [],
    handoffs: [],
    summaries: [],
    actions: [],
    cursors: { [ids.conversation]: 'cursor-1' },
  };
}

test('offline identity runtime rejects each malformed or expired cache boundary', () => {
  assert.equal(
    offlineIdentityExpiresAt(now),
    new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
  );
  const serialized = serializeOfflineIdentity(ids.user, now);
  assert.equal(parseOfflineIdentity(serialized, now), ids.user);
  assert.equal(parseOfflineIdentity(7, now), null);
  assert.equal(parseOfflineIdentity('x'.repeat(513), now), null);
  assert.equal(parseOfflineIdentity('{', now), null);
  for (const value of [
    { version: 2, userId: ids.user, savedAt: new Date(now).toISOString() },
    { version: 1, userId: 7, savedAt: new Date(now).toISOString() },
    { version: 1, userId: 'bad', savedAt: new Date(now).toISOString() },
    { version: 1, userId: ids.user, savedAt: 'bad' },
    { version: 1, userId: ids.user, savedAt: new Date(now + 6 * 60 * 1_000).toISOString() },
    { version: 1, userId: ids.user, savedAt: new Date(now - 24 * 60 * 60 * 1_000 - 1).toISOString() },
  ]) assert.equal(parseOfflineIdentity(JSON.stringify(value), now), null);
  assert.equal(serializeOfflineIdentity(null, now), null);
  assert.equal(retainSessionForMembershipFailure({ code: 'HTTP_599' }), true);
  assert.equal(retainSessionForMembershipFailure({ code: 503 }), false);
  assert.equal(retainSessionForMembershipFailure(null), false);
  assert.equal(retainSessionForMembershipFailure({ code: 'http_600' }), false);
});

test('offline workspace serialization filters malformed rows and observes byte and entitlement limits', () => {
  assert.equal(offlineWorkspaceCacheKey(ids.user), `workspace-snapshot.${ids.user}`);
  assert.equal(offlineWorkspaceCacheKey(null), null);
  assert.equal(offlineWorkspaceSnapshotExpiresAt(null), null);
  assert.equal(offlineWorkspaceSnapshotExpiresAt({}), null);
  assert.equal(serializeOfflineWorkspace(null, now), null);
  assert.equal(serializeOfflineWorkspace({ currentUser: {} }, now), null);

  const malformedOrganization = baseOfflineSnapshot();
  malformedOrganization.organizationId = 'bad';
  assert.equal(serializeOfflineWorkspace(malformedOrganization, now), null);
  const malformedUser = baseOfflineSnapshot();
  malformedUser.currentUser.id = 'bad';
  assert.equal(serializeOfflineWorkspace(malformedUser, now), null);

  const snapshot = baseOfflineSnapshot();
  snapshot.messageDisplayLanguage = 'fr';
  snapshot.currentUser.preferredLanguage = 'es';
  snapshot.organizationName = 7;
  snapshot.conversationControlsVersion = 1.5;
  snapshot.conversations.push(null, { id: ids.other, managementOnly: true }, { id: 9 });
  snapshot.messages[ids.conversation].push(
    null,
    { id: 'wrong-conversation', conversationId: ids.other },
    { id: 9, conversationId: ids.conversation },
  );
  snapshot.cursors[ids.conversation] = 7;
  snapshot.people = null;
  const serialized = serializeOfflineWorkspace(snapshot, now);
  assert.ok(serialized);
  const envelope = JSON.parse(serialized);
  assert.equal(envelope.snapshot.organizationName, 'Newone');
  assert.equal(envelope.snapshot.conversationControlsVersion, 1);
  assert.equal(envelope.snapshot.messageDisplayLanguage, 'es');
  assert.deepEqual(envelope.snapshot.conversations, [{ id: ids.conversation }]);
  assert.deepEqual(envelope.snapshot.messages[ids.conversation], [
    { id: 'message-1', conversationId: ids.conversation },
  ]);
  assert.equal(envelope.snapshot.cursors[ids.conversation], null);
  assert.deepEqual(envelope.snapshot.people, []);

  const nullCollections = baseOfflineSnapshot();
  nullCollections.messages = null;
  nullCollections.cursors = null;
  assert.ok(serializeOfflineWorkspace(nullCollections, now));

  const oversized = baseOfflineSnapshot();
  oversized.organizationName = 'x'.repeat(5 * 1024 * 1024 + 1);
  assert.equal(serializeOfflineWorkspace(oversized, now), null);

  const contractor = baseOfflineSnapshot();
  contractor.currentUser.membershipType = 'contractor';
  contractor.currentUser.accessExpiresAt = new Date(now + 60_000).toISOString();
  assert.equal(offlineWorkspaceExpiresAt(contractor, now), contractor.currentUser.accessExpiresAt);
});

test('offline workspace hydration rejects every envelope and collection integrity violation', () => {
  const serialized = serializeOfflineWorkspace(baseOfflineSnapshot(), now);
  assert.ok(serialized);
  const validEnvelope = JSON.parse(serialized);
  const parsed = parseOfflineWorkspace(serialized, ids.user, now + 1);
  assert.ok(parsed);
  assert.equal(offlineWorkspaceSnapshotExpiresAt(parsed), validEnvelope.expiresAt);

  for (const [serializedValue, expectedId, instant] of [
    [null, ids.user, now],
    ['', ids.user, now],
    ['x'.repeat(5 * 1024 * 1024 + 1), ids.user, now],
    [serialized, null, now],
    [serialized, 'bad', now],
    [serialized, ids.user, Number.NaN],
    ['{', ids.user, now],
  ]) assert.equal(parseOfflineWorkspace(serializedValue, expectedId, instant), null);

  const envelopeMutations = [
    ['version', (value) => { value.version = 1; }],
    ['user envelope', (value) => { value.userId = ids.other; }],
    ['current user', (value) => { value.snapshot.currentUser.id = ids.other; }],
    ['organization type', (value) => { value.organizationId = 7; }],
    ['organization syntax', (value) => { value.organizationId = 'bad'; }],
    ['snapshot organization', (value) => { value.snapshot.organizationId = ids.other; }],
    ['saved at', (value) => { value.savedAt = 'bad'; }],
    ['expiry', (value) => { value.expiresAt = 'bad'; }],
    ['entitlement', (value) => { value.snapshot.currentUser.membershipType = 'guest'; }],
    ['entitlement expiry', (value) => { value.expiresAt = new Date(now + 1_000).toISOString(); }],
    ['future save', (value) => { value.savedAt = new Date(now + 6 * 60 * 1_000).toISOString(); }],
    ['stale save', (value) => { value.savedAt = new Date(now - 25 * 60 * 60 * 1_000).toISOString(); }],
    ['expired', (value) => { value.expiresAt = new Date(now).toISOString(); }],
    ['organization name', (value) => { value.snapshot.organizationName = 7; }],
    ['conversations type', (value) => { value.snapshot.conversations = null; }],
    ['people type', (value) => { value.snapshot.people = null; }],
    ['units type', (value) => { value.snapshot.units = null; }],
    ['updates type', (value) => { value.snapshot.updates = null; }],
    ['handoffs type', (value) => { value.snapshot.handoffs = null; }],
    ['summaries type', (value) => { value.snapshot.summaries = null; }],
    ['actions type', (value) => { value.snapshot.actions = null; }],
    ['language', (value) => { value.snapshot.messageDisplayLanguage = 'fr'; }],
    ['messages type', (value) => { value.snapshot.messages = []; }],
    ['cursors type', (value) => { value.snapshot.cursors = []; }],
    ['conversation limit', (value) => { value.snapshot.conversations = Array(101).fill({ id: ids.conversation }); }],
    ['people limit', (value) => { value.snapshot.people = Array(501).fill({}); }],
    ['unit limit', (value) => { value.snapshot.units = Array(501).fill({}); }],
    ['update limit', (value) => { value.snapshot.updates = Array(101).fill({}); }],
    ['handoff limit', (value) => { value.snapshot.handoffs = Array(101).fill({}); }],
    ['summary limit', (value) => { value.snapshot.summaries = Array(51).fill({}); }],
    ['action limit', (value) => { value.snapshot.actions = Array(201).fill({}); }],
    ['capabilities', (value) => { value.snapshot.capabilities = ['admin']; }],
    ['scopes', (value) => { value.snapshot.scopes = [{}]; }],
    ['reports', (value) => { value.snapshot.moderationReports = [{}]; }],
    ['audit', (value) => { value.snapshot.auditEvents = [{}]; }],
    ['conversation object', (value) => { value.snapshot.conversations = [null]; }],
    ['management shell', (value) => { value.snapshot.conversations[0].managementOnly = true; }],
    ['conversation id', (value) => { value.snapshot.conversations[0].id = 7; }],
    ['duplicate conversation', (value) => { value.snapshot.conversations.push({ id: ids.conversation }); }],
    ['unknown message conversation', (value) => { value.snapshot.messages[ids.other] = []; }],
    ['message list type', (value) => { value.snapshot.messages[ids.conversation] = {}; }],
    ['message list limit', (value) => { value.snapshot.messages[ids.conversation] = Array(101).fill({ id: 'x', conversationId: ids.conversation }); }],
    ['message object', (value) => { value.snapshot.messages[ids.conversation] = [null]; }],
    ['message binding', (value) => { value.snapshot.messages[ids.conversation][0].conversationId = ids.other; }],
    ['message id', (value) => { value.snapshot.messages[ids.conversation][0].id = 7; }],
  ];
  for (const [label, mutate] of envelopeMutations) {
    const value = clone(validEnvelope);
    mutate(value);
    assert.equal(parseOfflineWorkspace(JSON.stringify(value), ids.user, now), null, label);
  }

  const many = clone(validEnvelope);
  many.snapshot.conversations = [];
  many.snapshot.messages = {};
  for (let index = 0; index < 11; index += 1) {
    const conversationId = `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    many.snapshot.conversations.push({ id: conversationId });
    many.snapshot.messages[conversationId] = Array.from({ length: 100 }, (_, item) => ({
      id: `${index}-${item}`,
      conversationId,
    }));
  }
  assert.equal(parseOfflineWorkspace(JSON.stringify(many), ids.user, now), null);
});

function outboxCommand(overrides = {}) {
  const clientMessageId = ids.other;
  return {
    id: ids.factor,
    organizationId: ids.organization,
    userId: ids.user,
    kind: 'send_message',
    payload: {
      organizationId: ids.organization,
      conversationId: ids.conversation,
      clientMessageId,
      idempotencyKey: clientMessageId,
      body: 'message',
    },
    createdAt: '2026-08-04T12:00:00.000Z',
    attempts: 0,
    state: 'queued',
    ...overrides,
  };
}

test('outbox runtime validates the complete persisted command before exposing controls', () => {
  assert.deepEqual(visibleMessageOutbox(null, ids.user, ids.organization), []);
  assert.deepEqual(visibleMessageOutbox([], null, ids.organization), []);
  assert.deepEqual(visibleMessageOutbox([], ids.user, null), []);

  const queued = outboxCommand({
    lastErrorCode: 7,
    payload: { ...outboxCommand().payload, body: null },
  });
  const sending = outboxCommand({
    id: ids.other,
    attempts: 1,
    state: 'sending',
    createdAt: '2026-08-04T12:01:00.000Z',
  });
  const failed = outboxCommand({
    id: ids.third,
    attempts: 2,
    state: 'failed',
    lastErrorCode: 'offline',
    createdAt: '2026-08-04T12:02:00.000Z',
  });
  const visible = visibleMessageOutbox([failed, sending, queued], ids.user, ids.organization);
  assert.deepEqual(visible.map((item) => item.id), [queued.id, sending.id, failed.id]);
  assert.equal(visible[0].body, '');
  assert.equal(visible[0].lastErrorCode, null);
  assert.equal(visible[1].deliveryAmbiguous, false);
  assert.equal(visible[2].canRetry, true);

  const invalid = [
    null,
    [],
    { ...outboxCommand(), payload: null },
    { ...outboxCommand(), payload: [] },
    { ...outboxCommand(), kind: 'receipt' },
    { ...outboxCommand(), userId: ids.other },
    { ...outboxCommand(), organizationId: ids.other },
    { ...outboxCommand(), id: 7 },
    { ...outboxCommand(), id: 'bad' },
    { ...outboxCommand(), createdAt: 7 },
    { ...outboxCommand(), createdAt: 'bad' },
    { ...outboxCommand(), attempts: 0.5 },
    { ...outboxCommand(), attempts: -1 },
    { ...outboxCommand(), state: 'done' },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, conversationId: 7 } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, conversationId: 'bad' } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, clientMessageId: 7 } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, clientMessageId: 'bad' } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, organizationId: ids.other } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, idempotencyKey: ids.third } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, body: 7 } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, body: 'x'.repeat(12_001) } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, mentionUserIds: Array(51).fill(ids.third) } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, mentionUserIds: [7] } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, mentionUserIds: ['bad'] } },
    { ...outboxCommand(), payload: { ...outboxCommand().payload, mentionUserIds: [ids.third, ids.third] } },
  ];
  assert.deepEqual(visibleMessageOutbox(invalid, ids.user, ids.organization), []);
  assert.deepEqual(
    visibleMessageOutbox([{ ...outboxCommand(), userId: 'bad' }], 'bad', ids.organization),
    [],
  );
  assert.deepEqual(
    visibleMessageOutbox([{ ...outboxCommand(), organizationId: 'bad' }], ids.user, 'bad'),
    [],
  );

  assert.equal(editUnattemptedMessageCommand(null, 'body'), null);
  assert.equal(editUnattemptedMessageCommand([], 'body'), null);
  assert.equal(editUnattemptedMessageCommand({ ...outboxCommand(), payload: null }, 'body'), null);
  assert.equal(editUnattemptedMessageCommand(outboxCommand(), null), null);
  assert.equal(editUnattemptedMessageCommand(outboxCommand(), '   '), null);
  assert.equal(editUnattemptedMessageCommand(outboxCommand(), 'x'.repeat(12_001)), null);
  assert.equal(editUnattemptedMessageCommand({ ...outboxCommand(), state: 'sending' }, 'body'), null);
  assert.equal(editUnattemptedMessageCommand({ ...outboxCommand(), attempts: 1 }, 'body'), null);
  assert.equal(editUnattemptedMessageCommand({ ...outboxCommand(), kind: 'receipt' }, 'body'), null);
  assert.equal(editUnattemptedMessageCommand(outboxCommand(), ' edited ')?.payload.body, 'edited');

  assert.equal(retryFailedMessageCommand(null), null);
  assert.equal(retryFailedMessageCommand([]), null);
  assert.equal(retryFailedMessageCommand(outboxCommand()), null);
  assert.equal(retryFailedMessageCommand({ ...outboxCommand(), state: 'failed' })?.state, 'queued');
});

test('coalesced runner handles disposal, activation, and disposal during an in-flight burst', async () => {
  let calls = 0;
  const runner = createCoalescedRunner(async () => { calls += 1; });
  runner.dispose();
  await runner.run();
  assert.equal(calls, 0);
  runner.activate();
  await runner.run();
  assert.equal(calls, 1);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const second = createCoalescedRunner(async () => { calls += 1; await gate; });
  const firstRun = second.run();
  await Promise.resolve();
  assert.equal(second.run(), firstRun);
  second.dispose();
  release();
  await firstRun;
  assert.equal(calls, 2);
});

test('timeline reconciliation covers invalid identifiers, fallback ordering, and empty anchors', () => {
  assert.equal(compareMessageIds('x', '10'), 'x'.localeCompare('10'));
  assert.equal(compareMessageIds('9', '10'), -1);
  assert.equal(compareMessageIds('100', '10'), 1);
  assert.equal(compareMessageIds('0010', '10'), 0);

  const rows = mergeTimelineMessages([
    { id: 'local-b', clientMessageId: 'client-b', createdAt: 'bad', isOwn: true },
    { id: 'local-a', clientMessageId: 'client-a', createdAt: 'bad', isOwn: true },
    { id: 'server-only', serverId: '2', createdAt: 'bad', isOwn: false },
    { id: 'server-later', serverId: '10', createdAt: 'bad', isOwn: false },
    { id: 'timed', serverId: '11', createdAt: '2026-08-04T12:00:00Z', isOwn: false },
  ], [
    { id: 'incoming-id-match', createdAt: 'bad', isOwn: true },
    { id: 'incoming-id-match', deliveryState: 'failed', failureReason: 'offline', createdAt: 'bad', isOwn: true },
    { id: 'server-replacement', serverId: '2', deliveryState: 'sent', createdAt: 'bad', isOwn: false },
    { id: 'client-replacement', clientMessageId: 'client-b', deliveryState: 'sent', createdAt: 'bad', isOwn: true },
  ]);
  assert.ok(rows.some((row) => row.id === 'incoming-id-match' && row.failureReason === 'offline'));
  assert.equal(rows.find((row) => row.id === 'server-only')?.failureReason, undefined);
  assert.equal(rows.find((row) => row.id === 'local-b')?.deliveryState, 'sent');

  assert.equal(firstUnreadMessageId([], null, 1), null);
  assert.equal(firstUnreadMessageId([{ id: 'own', isOwn: true, serverId: '1' }], null, 1), null);
  const incoming = [{ id: 'one', isOwn: false, serverId: '1' }];
  assert.equal(firstUnreadMessageId(incoming, '9', 1), 'one');
  assert.equal(latestIncomingServerMessage([]), null);
  assert.equal(latestIncomingServerMessage([{ id: 'local', isOwn: false }]), null);
});

test('departure state helpers tolerate sparse snapshots and reject malformed selectors', () => {
  assert.deepEqual(conversationOutboxCommandIds(null, ids.conversation), []);
  assert.deepEqual(conversationOutboxCommandIds([], null), []);
  assert.deepEqual(conversationOutboxCommandIds([], ''), []);
  assert.deepEqual(conversationOutboxCommandIds([
    null,
    { id: null, payload: null },
    { id: '', payload: [] },
    { id: 'valid', payload: { conversationId: ids.conversation } },
  ], ids.conversation), ['valid']);
  assert.equal(redactDepartedConversation(null, ids.conversation), null);
  assert.equal(redactDepartedConversation('snapshot', ids.conversation), 'snapshot');
  assert.deepEqual(redactDepartedConversation({}, ids.conversation), {
    conversations: [],
    messages: {},
    cursors: {},
    handoffs: [],
    summaries: [],
    actions: [],
    moderationReports: [],
    auditEvents: [],
  });
});

test('mention controls exercise malformed collections, ordering, suspension, and exact limits', () => {
  assert.deepEqual(normalizeMentionSelection(null, [], ids.user), []);
  assert.deepEqual(normalizeMentionSelection([], null, ids.user), []);
  assert.deepEqual(normalizeMentionSelection([], [], ids.user, 0), []);
  assert.deepEqual(normalizeMentionSelection([], [], ids.user, 1.5), []);
  assert.deepEqual(
    normalizeMentionSelection(
      ['bad', ids.user, ids.third, ids.other, ids.other],
      ['bad', ids.user, ids.other, ids.third],
      ids.user,
      1,
    ),
    [ids.third],
  );
  assert.equal(isValidMentionSelection(null, [], ids.user), false);
  assert.equal(isValidMentionSelection([ids.other, ids.third], [ids.other, ids.third], ids.user, 1), false);
  assert.equal(isValidMentionSelection([ids.other], [ids.other], ids.user), true);
  assert.equal(isValidMentionSelection([ids.third, ids.other], [ids.other, ids.third], ids.user), true);
  assert.deepEqual(mentionablePeople(null, [], ids.user), []);
  assert.deepEqual(mentionablePeople([], null, ids.user), []);
  assert.deepEqual(mentionablePeople([
    null,
    { id: 'bad' },
    { id: ids.user },
    { id: ids.other },
    { id: ids.third, suspended: true },
    { id: ids.fourth, suspended: false },
  ], [ids.user, ids.other, ids.third], ids.user), [{ id: ids.other }]);
  assert.equal(parseMentionDto(null), null);
  assert.equal(parseMentionDto([ids.other], 0), null);
  assert.deepEqual(parseMentionDto([]), []);
});

test('notification routes cover all trusted event shapes and positive identifier forms', () => {
  assert.equal(notificationDestination(null), null);
  assert.equal(notificationDestination([]), null);
  assert.equal(notificationDestination({ organization_id: ids.organization, event_type: 7 }), null);
  assert.equal(notificationDestination({ organization_id: 7, event_type: 'message.changed' }), null);
  assert.deepEqual(notificationDestination({
    organization_id: ids.organization.toUpperCase(),
    event_type: 'message.changed',
    conversation_id: ids.conversation.toUpperCase(),
    message_id: '9999999999999999999',
  }), {
    organizationId: ids.organization,
    href: `/conversation/${ids.conversation}`,
    key: `message:${ids.conversation}:9999999999999999999`,
  });
  assert.equal(notificationDestination({
    organization_id: ids.organization,
    event_type: 'message.changed',
    conversation_id: ids.conversation,
    message_id: Number.MAX_SAFE_INTEGER + 1,
  }), null);
  assert.equal(notificationDestination({
    organization_id: ids.organization,
    event_type: 'message.changed',
    conversation_id: ids.conversation,
    message_id: '01',
  }), null);
  assert.equal(notificationDestination({
    organization_id: ids.organization,
    event_type: 'message.changed',
    conversation_id: 'bad',
    message_id: 1,
  }), null);
  assert.deepEqual(notificationDestination({
    organization_id: ids.organization,
    event_type: 'conversation.changed',
    conversation_id: ids.conversation,
  })?.key, `conversation:${ids.conversation}`);
  assert.equal(notificationDestination({
    organization_id: ids.organization,
    event_type: 'conversation.changed',
    conversation_id: 'bad',
  }), null);
  assert.equal(notificationDestination({
    organization_id: ids.organization,
    event_type: 'announcement.changed',
    announcement_id: 'bad',
  }), null);
  assert.equal(notificationDestination({
    organization_id: ids.organization,
    event_type: 'handoff.changed',
    handoff_id: 'bad',
  }), null);
  assert.equal(notificationDestination({
    organization_id: ids.organization,
    event_type: 'unknown',
  }), null);
});

function aiPolicy(overrides = {}) {
  return {
    organizationId: ids.organization,
    enabled: true,
    policyVersion: 3,
    approvedUseCases: ['summary', 'translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    tenantApproved: true,
    globalKillSwitchStillRequired: true,
    ...overrides,
  };
}

function aiUpdate(overrides = {}) {
  return {
    enabled: true,
    approvedUseCases: ['summary', 'translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    expectedVersion: 2,
    reason: 'Approved after bounded review.',
    ...overrides,
  };
}

test('AI policy parsers execute every state, canonical-array, and receipt boundary', () => {
  assert.deepEqual(parseOrganizationAiPolicy(aiPolicy(), ids.organization), aiPolicy());
  const disabledPolicy = aiPolicy({
    enabled: false,
    policyVersion: 0,
    approvedUseCases: [],
    providerAllowlist: [],
    routePolicy: 'deny',
    tenantApproved: false,
  });
  assert.deepEqual(parseOrganizationAiPolicy(disabledPolicy), disabledPolicy);
  assert.deepEqual(parseOrganizationAiPolicyUpdateReceipt(aiPolicy(), ids.organization, aiUpdate()), aiPolicy());
  assert.deepEqual(normalizeOrganizationAiPolicyUpdate({
    enabled: false,
    approvedUseCases: [],
    providerAllowlist: [],
    routePolicy: 'deny',
    expectedVersion: 0,
    reason: '  Disable reviewed processing.  ',
  }), {
    enabled: false,
    approvedUseCases: [],
    providerAllowlist: [],
    routePolicy: 'deny',
    expectedVersion: 0,
    reason: 'Disable reviewed processing.',
  });

  assertThrowsEach(parseOrganizationAiPolicy, [
    ['null', null],
    ['array', []],
    ['extra key', { ...aiPolicy(), secret: true }],
    ['missing key', (() => { const value = aiPolicy(); delete value.enabled; return value; })()],
    ['organization type', aiPolicy({ organizationId: 7 })],
    ['organization syntax', aiPolicy({ organizationId: 'bad' })],
    ['enabled type', aiPolicy({ enabled: 'yes' })],
    ['approval type', aiPolicy({ tenantApproved: 'yes' })],
    ['version type', aiPolicy({ policyVersion: 1.5 })],
    ['version low', aiPolicy({ policyVersion: -1 })],
    ['version high', aiPolicy({ policyVersion: 2_147_483_648 })],
    ['global gate', aiPolicy({ globalKillSwitchStillRequired: false })],
    ['route', aiPolicy({ routePolicy: 'direct' })],
    ['tenant mismatch', aiPolicy({ tenantApproved: false })],
    ['enabled zero version', aiPolicy({ policyVersion: 0 })],
    ['enabled deny', aiPolicy({ routePolicy: 'deny' })],
    ['enabled no cases', aiPolicy({ approvedUseCases: [] })],
    ['enabled no providers', aiPolicy({ providerAllowlist: [] })],
    ['disabled approved route', { ...disabledPolicy, routePolicy: 'approved_zero_retention' }],
    ['disabled cases', { ...disabledPolicy, approvedUseCases: ['summary'] }],
    ['disabled providers', { ...disabledPolicy, providerAllowlist: ['provider/one'] }],
    ['cases type', aiPolicy({ approvedUseCases: null })],
    ['cases count', aiPolicy({ approvedUseCases: Array(4).fill('summary') })],
    ['case item type', aiPolicy({ approvedUseCases: [7] })],
    ['case canonical', aiPolicy({ approvedUseCases: [' Summary'] })],
    ['case enum', aiPolicy({ approvedUseCases: ['classification'] })],
    ['case duplicate', aiPolicy({ approvedUseCases: ['summary', 'summary'] })],
    ['provider type', aiPolicy({ providerAllowlist: null })],
    ['provider count', aiPolicy({ providerAllowlist: Array(21).fill('provider/a') })],
    ['provider item type', aiPolicy({ providerAllowlist: [7] })],
    ['provider canonical', aiPolicy({ providerAllowlist: ['Provider/a'] })],
    ['provider pattern', aiPolicy({ providerAllowlist: ['/provider'] })],
    ['provider duplicate', aiPolicy({ providerAllowlist: ['provider/a', 'provider/a'] })],
  ], /Invalid|Incoherent|Duplicate/);
  assert.throws(() => parseOrganizationAiPolicy(aiPolicy(), ids.other), /organization/i);

  assertThrowsEach(normalizeOrganizationAiPolicyUpdate, [
    ['null', null],
    ['extra key', { ...aiUpdate(), extra: true }],
    ['enabled type', aiUpdate({ enabled: 'yes' })],
    ['version type', aiUpdate({ expectedVersion: 1.5 })],
    ['version low', aiUpdate({ expectedVersion: -1 })],
    ['version high', aiUpdate({ expectedVersion: 2_147_483_647 })],
    ['reason type', aiUpdate({ reason: 7 })],
    ['reason short', aiUpdate({ reason: ' x ' })],
    ['reason long', aiUpdate({ reason: 'x'.repeat(501) })],
    ['enabled route', aiUpdate({ routePolicy: 'deny' })],
    ['enabled cases', aiUpdate({ approvedUseCases: [] })],
    ['enabled providers', aiUpdate({ providerAllowlist: [] })],
    ['disabled route', aiUpdate({ enabled: false, approvedUseCases: [], providerAllowlist: [] })],
    ['disabled cases', aiUpdate({ enabled: false, routePolicy: 'deny', providerAllowlist: [] })],
    ['disabled providers', aiUpdate({ enabled: false, routePolicy: 'deny', approvedUseCases: [] })],
  ], /Invalid|Incoherent/);

  assert.throws(() => parseOrganizationAiPolicyUpdateReceipt(aiPolicy(), null, aiUpdate()), /expected organization/i);
  assert.throws(() => parseOrganizationAiPolicyUpdateReceipt(aiPolicy(), 'bad', aiUpdate()), /expected organization/i);
  assert.throws(() => parseOrganizationAiPolicyUpdateReceipt(aiPolicy({ policyVersion: 4 }), ids.organization, aiUpdate()), /Mismatched/);
  assert.throws(() => parseOrganizationAiPolicyUpdateReceipt(aiPolicy({ approvedUseCases: ['language_detection'] }), ids.organization, aiUpdate()), /Mismatched/);
  assert.throws(() => parseOrganizationAiPolicyUpdateReceipt(aiPolicy({ providerAllowlist: ['provider/two'] }), ids.organization, aiUpdate()), /Mismatched/);
  assert.deepEqual(
    parseOrganizationAiPolicyUpdateReceipt(
      { ...disabledPolicy, policyVersion: 1 },
      ids.organization,
      {
        enabled: false,
        approvedUseCases: [],
        providerAllowlist: [],
        routePolicy: 'deny',
        expectedVersion: 0,
        reason: 'Disable reviewed processing.',
      },
    ).enabled,
    false,
  );
});

function notificationPreferences(overrides = {}) {
  return {
    registered: true,
    deviceId: ids.user,
    installationId: ids.other,
    platform: 'ios',
    preferenceVersion: 2,
    overrides: {
      notificationPreview: null,
      soundEnabled: null,
      vibrationEnabled: null,
    },
    effective: {
      notificationPreview: 'generic',
      soundEnabled: true,
      vibrationEnabled: false,
    },
    updatedAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

test('device notification preferences cover exact patch and inherited/effective value branches', () => {
  assert.deepEqual(normalizeDeviceNotificationPreferencePatch({ notificationPreview: 'generic' }), {
    notificationPreview: 'generic',
  });
  assert.deepEqual(normalizeDeviceNotificationPreferencePatch({
    notificationPreview: 'hidden',
    soundEnabled: false,
    vibrationEnabled: true,
  }), {
    notificationPreview: 'hidden',
    soundEnabled: false,
    vibrationEnabled: true,
  });
  assert.deepEqual(parseDeviceNotificationPreferences(notificationPreferences()), notificationPreferences());
  for (const platform of ['android', 'web']) {
    assert.equal(parseDeviceNotificationPreferences(notificationPreferences({ platform })).platform, platform);
  }
  const explicit = notificationPreferences({
    overrides: { notificationPreview: 'hidden', soundEnabled: false, vibrationEnabled: true },
    effective: { notificationPreview: 'hidden', soundEnabled: false, vibrationEnabled: true },
  });
  assert.deepEqual(parseDeviceNotificationPreferences(explicit), explicit);

  assertThrowsEach(normalizeDeviceNotificationPreferencePatch, [
    ['null', null],
    ['array', []],
    ['empty', {}],
    ['unknown', { unknown: true }],
    ['preview', { notificationPreview: 'full' }],
    ['sound', { soundEnabled: 'yes' }],
    ['vibration', { vibrationEnabled: 'yes' }],
  ], /Invalid/);

  assertThrowsEach(parseDeviceNotificationPreferences, [
    ['null', null],
    ['array', []],
    ['root key count', (() => { const value = notificationPreferences(); delete value.registered; return value; })()],
    ['root unknown', { ...notificationPreferences(), unknown: true }],
    ['overrides null', notificationPreferences({ overrides: null })],
    ['overrides array', notificationPreferences({ overrides: [] })],
    ['overrides key count', notificationPreferences({ overrides: { soundEnabled: null, vibrationEnabled: null } })],
    ['overrides unknown', notificationPreferences({ overrides: { notificationPreview: null, soundEnabled: null, vibrationEnabled: null, unknown: true } })],
    ['effective null', notificationPreferences({ effective: null })],
    ['effective key count', notificationPreferences({ effective: { soundEnabled: true, vibrationEnabled: false } })],
    ['effective unknown', notificationPreferences({ effective: { notificationPreview: 'generic', soundEnabled: true, vibrationEnabled: false, unknown: true } })],
    ['registered', notificationPreferences({ registered: false })],
    ['platform', notificationPreferences({ platform: 'windows' })],
    ['version type', notificationPreferences({ preferenceVersion: 1.5 })],
    ['version low', notificationPreferences({ preferenceVersion: 0 })],
    ['preview effective', notificationPreferences({ effective: { notificationPreview: 'full', soundEnabled: true, vibrationEnabled: false } })],
    ['sound effective', notificationPreferences({ effective: { notificationPreview: 'generic', soundEnabled: 'yes', vibrationEnabled: false } })],
    ['vibration effective', notificationPreferences({ effective: { notificationPreview: 'generic', soundEnabled: true, vibrationEnabled: 'yes' } })],
    ['preview mismatch', notificationPreferences({ overrides: { notificationPreview: 'hidden', soundEnabled: null, vibrationEnabled: null } })],
    ['sound mismatch', notificationPreferences({ overrides: { notificationPreview: null, soundEnabled: false, vibrationEnabled: null } })],
    ['vibration mismatch', notificationPreferences({ overrides: { notificationPreview: null, soundEnabled: null, vibrationEnabled: true } })],
    ['device type', notificationPreferences({ deviceId: 7 })],
    ['device syntax', notificationPreferences({ deviceId: 'bad' })],
    ['installation type', notificationPreferences({ installationId: 7 })],
    ['installation syntax', notificationPreferences({ installationId: 'bad' })],
    ['date type', notificationPreferences({ updatedAt: 7 })],
    ['date syntax', notificationPreferences({ updatedAt: 'bad' })],
  ], /Invalid/);
});

function organizationPolicy(overrides = {}) {
  return {
    messageRetentionDays: 365,
    allowMemberDirectMessages: true,
    dmPolicy: 'directory_open',
    requireMfaForAdmins: true,
    shiftScheduleAuthoritative: false,
    groupCreationPolicy: 'members',
    allowExternalGuests: false,
    externalGuestMaxAccessDays: 90,
    version: 1,
    ...overrides,
  };
}

test('organization policy parsing covers every scalar and audit-reason bound', () => {
  assert.deepEqual(parseOrganizationPolicy(organizationPolicy()), organizationPolicy());
  for (const groupCreationPolicy of ['managers', 'admins']) {
    assert.equal(parseOrganizationPolicy(organizationPolicy({ groupCreationPolicy })).groupCreationPolicy, groupCreationPolicy);
  }
  for (const dmPolicy of ['request_first', 'scoped_unit']) {
    assert.equal(parseOrganizationPolicy(organizationPolicy({ dmPolicy })).dmPolicy, dmPolicy);
  }
  assertThrowsEach(parseOrganizationPolicy, [
    ['null', null],
    ['array', []],
    ['extra', { ...organizationPolicy(), extra: true }],
    ['missing', (() => { const value = organizationPolicy(); delete value.version; return value; })()],
    ['group', organizationPolicy({ groupCreationPolicy: 'all' })],
    ['dm', organizationPolicy({ dmPolicy: 'all' })],
    ['retention type', organizationPolicy({ messageRetentionDays: '365' })],
    ['retention low', organizationPolicy({ messageRetentionDays: 0 })],
    ['retention high', organizationPolicy({ messageRetentionDays: 3651 })],
    ['dm boolean', organizationPolicy({ allowMemberDirectMessages: null })],
    ['mfa boolean', organizationPolicy({ requireMfaForAdmins: null })],
    ['shift boolean', organizationPolicy({ shiftScheduleAuthoritative: null })],
    ['guest boolean', organizationPolicy({ allowExternalGuests: null })],
    ['guest days', organizationPolicy({ externalGuestMaxAccessDays: 0 })],
    ['version', organizationPolicy({ version: 0 })],
  ], /Invalid/);
  assert.deepEqual(
    normalizeOrganizationPolicyUpdate({ ...organizationPolicy(), reason: '  Reviewed change.  ' }).reason,
    'Reviewed change.',
  );
  assert.throws(() => normalizeOrganizationPolicyUpdate({ ...organizationPolicy(), reason: 7 }), /audit reason/);
  assert.throws(() => normalizeOrganizationPolicyUpdate({ ...organizationPolicy(), reason: 'x' }), /audit reason/);
  assert.throws(() => normalizeOrganizationPolicyUpdate({ ...organizationPolicy(), reason: 'x'.repeat(501) }), /audit reason/);
});

function groupCandidate(overrides = {}) {
  return {
    userId: ids.user,
    displayName: 'Coverage Person',
    username: null,
    avatarPath: null,
    jobTitle: null,
    membershipRole: 'member',
    membershipType: 'employee',
    accessExpiresAt: null,
    ...overrides,
  };
}

function groupReceipt(overrides = {}) {
  return {
    conversationId: ids.conversation,
    kind: 'group',
    name: 'Coverage group',
    description: null,
    historyPolicy: 'all',
    historyDisclosure: {
      policy: 'all',
      visibleFrom: null,
      labelKey: 'conversation.history.all',
    },
    postingMode: 'all_members',
    joinPolicy: 'invite_only',
    configuredJoinPolicy: 'inherit',
    visibility: 'invite_only',
    memberCount: 2,
    memberLimit: 2,
    isReadOnly: false,
    ...overrides,
  };
}

test('group creation parsers cover candidate, disclosure, policy, and role boundaries', () => {
  assert.deepEqual(parseGroupCreationCandidates({ candidates: [groupCandidate()], limit: 1 }), {
    candidates: [groupCandidate()],
    limit: 1,
  });
  const contractor = groupCandidate({
    membershipRole: 'manager',
    membershipType: 'contractor',
    avatarPath: '/avatar.png',
    jobTitle: 'Operator',
    accessExpiresAt: '2026-09-04T12:00:00.000Z',
  });
  assert.deepEqual(parseGroupCreationCandidates({ candidates: [contractor], limit: 2 }).candidates[0], contractor);
  const guest = groupCandidate({
    userId: ids.other,
    membershipType: 'guest',
    accessExpiresAt: '2026-09-04T12:00:00.000Z',
  });
  assert.equal(parseGroupCreationCandidates({ candidates: [guest], limit: 2 }).candidates[0].membershipType, 'guest');

  assertThrowsEach(parseGroupCreationCandidates, [
    ['null', null],
    ['extra root', { candidates: [], limit: 1, extra: true }],
    ['limit type', { candidates: [], limit: 1.5 }],
    ['limit low', { candidates: [], limit: 0 }],
    ['limit high', { candidates: [], limit: 101 }],
    ['candidates type', { candidates: null, limit: 1 }],
    ['candidate count', { candidates: [groupCandidate(), guest], limit: 1 }],
    ['candidate object', { candidates: [null], limit: 1 }],
    ['candidate extra', { candidates: [{ ...groupCandidate(), extra: true }], limit: 1 }],
    ['role type', { candidates: [groupCandidate({ membershipRole: 7 })], limit: 1 }],
    ['role enum', { candidates: [groupCandidate({ membershipRole: 'viewer' })], limit: 1 }],
    ['membership type', { candidates: [groupCandidate({ membershipType: 7 })], limit: 1 }],
    ['membership enum', { candidates: [groupCandidate({ membershipType: 'alumni' })], limit: 1 }],
    ['guest role', { candidates: [groupCandidate({ membershipType: 'guest', membershipRole: 'admin', accessExpiresAt: '2026-09-04T12:00:00Z' })], limit: 1 }],
    ['guest expiry', { candidates: [groupCandidate({ membershipType: 'guest' })], limit: 1 }],
    ['id type', { candidates: [groupCandidate({ userId: 7 })], limit: 1 }],
    ['id syntax', { candidates: [groupCandidate({ userId: 'bad' })], limit: 1 }],
    ['name type', { candidates: [groupCandidate({ displayName: 7 })], limit: 1 }],
    ['name empty', { candidates: [groupCandidate({ displayName: '' })], limit: 1 }],
    ['name long', { candidates: [groupCandidate({ displayName: 'x'.repeat(161) })], limit: 1 }],
    ['username type', { candidates: [groupCandidate({ username: 7 })], limit: 1 }],
    ['username empty', { candidates: [groupCandidate({ username: '' })], limit: 1 }],
    ['username long', { candidates: [groupCandidate({ username: 'x'.repeat(65) })], limit: 1 }],
    ['username spaced', { candidates: [groupCandidate({ username: 'two words' })], limit: 1 }],
    ['avatar empty', { candidates: [groupCandidate({ avatarPath: '' })], limit: 1 }],
    ['avatar long', { candidates: [groupCandidate({ avatarPath: 'x'.repeat(1025) })], limit: 1 }],
    ['job empty', { candidates: [groupCandidate({ jobTitle: '' })], limit: 1 }],
    ['expiry type', { candidates: [groupCandidate({ accessExpiresAt: 7 })], limit: 1 }],
    ['expiry long', { candidates: [groupCandidate({ accessExpiresAt: 'x'.repeat(41) })], limit: 1 }],
    ['expiry syntax', { candidates: [groupCandidate({ accessExpiresAt: 'not-a-time' })], limit: 1 }],
    ['duplicate', { candidates: [groupCandidate(), groupCandidate()], limit: 2 }],
  ], /Invalid/);

  assert.deepEqual(parseGroupCreationReceipt(groupReceipt()), groupReceipt());
  const sinceJoin = groupReceipt({
    historyPolicy: 'since_join',
    historyDisclosure: {
      policy: 'since_join',
      visibleFrom: '2026-08-04T12:00:00.000Z',
      labelKey: 'conversation.history.since_join',
    },
    configuredJoinPolicy: 'approval_required',
    joinPolicy: 'approval_required',
    kind: 'incident',
    description: 'Bounded description',
    postingMode: 'admins_only',
    visibility: 'unit',
    memberCount: 3,
    memberLimit: 5000,
  });
  assert.deepEqual(parseGroupCreationReceipt(sinceJoin), sinceJoin);
  assertThrowsEach(parseGroupCreationReceipt, [
    ['null', null],
    ['extra', { ...groupReceipt(), extra: true }],
    ['history enum', groupReceipt({ historyPolicy: 'none' })],
    ['disclosure object', groupReceipt({ historyDisclosure: null })],
    ['disclosure extra', groupReceipt({ historyDisclosure: { ...groupReceipt().historyDisclosure, extra: true } })],
    ['disclosure policy', groupReceipt({ historyDisclosure: { ...groupReceipt().historyDisclosure, policy: 'since_join' } })],
    ['all visibility', groupReceipt({ historyDisclosure: { policy: 'all', visibleFrom: '2026-08-04T12:00:00Z', labelKey: 'conversation.history.all' } })],
    ['all label', groupReceipt({ historyDisclosure: { policy: 'all', visibleFrom: null, labelKey: 'conversation.history.since_join' } })],
    ['since missing time', { ...sinceJoin, historyDisclosure: { ...sinceJoin.historyDisclosure, visibleFrom: null } }],
    ['since label', { ...sinceJoin, historyDisclosure: { ...sinceJoin.historyDisclosure, labelKey: 'conversation.history.all' } }],
    ['configured join', groupReceipt({ configuredJoinPolicy: 'open' })],
    ['join', groupReceipt({ joinPolicy: 'open' })],
    ['effective join', groupReceipt({ configuredJoinPolicy: 'approval_required' })],
    ['member limit type', groupReceipt({ memberLimit: 2.5 })],
    ['member limit low', groupReceipt({ memberLimit: 1 })],
    ['member limit high', groupReceipt({ memberLimit: 5001 })],
    ['member count type', groupReceipt({ memberCount: 2.5 })],
    ['member count low', groupReceipt({ memberCount: 1 })],
    ['member count high', groupReceipt({ memberCount: 3, memberLimit: 2 })],
    ['read only', groupReceipt({ isReadOnly: true })],
    ['conversation', groupReceipt({ conversationId: 'bad' })],
    ['kind', groupReceipt({ kind: 'direct' })],
    ['name', groupReceipt({ name: '' })],
    ['description', groupReceipt({ description: '' })],
    ['posting', groupReceipt({ postingMode: 'owners' })],
    ['visibility', groupReceipt({ visibility: 'public' })],
  ], /Invalid/);

  const role = {
    conversationId: ids.conversation,
    userId: ids.user,
    previousRole: 'member',
    role: 'owner',
  };
  assert.deepEqual(parseConversationMemberRoleReceipt(role), role);
  assert.throws(() => parseConversationMemberRoleReceipt(null), /Invalid/);
  assert.throws(() => parseConversationMemberRoleReceipt({ ...role, previousRole: 'viewer' }), /Invalid/);
  assert.throws(() => parseConversationMemberRoleReceipt({ ...role, role: 'viewer' }), /Invalid/);
  assert.throws(() => parseConversationMemberRoleReceipt({ ...role, role: 'member' }), /unchanged/);
  assert.throws(() => parseConversationMemberRoleReceipt({ ...role, conversationId: 'bad' }), /Invalid/);
  assert.throws(() => parseConversationMemberRoleReceipt({ ...role, userId: 'bad' }), /Invalid/);
});

function dynamicSpec(overrides = {}) {
  return {
    siteIds: [ids.user],
    departmentIds: [ids.organization],
    teamIds: [ids.conversation],
    lineIds: [ids.case],
    unitIds: [ids.factor],
    includeDescendants: true,
    operationalRoles: ['operator', 'shift lead'],
    membershipRoles: ['manager', 'member'],
    shiftMode: 'current',
    scheduledShiftStartsAt: null,
    scheduledShiftEndsAt: null,
    ...overrides,
  };
}

function dynamicPolicy(overrides = {}) {
  return {
    policyId: ids.user,
    conversationId: ids.conversation,
    conversationName: 'Coverage shift',
    conversationKind: 'shift',
    conversationUnitId: ids.factor,
    status: 'active',
    version: 3,
    draftState: 'published',
    policySpec: dynamicSpec(),
    maximumMembers: 200,
    selectorFingerprint: 'a'.repeat(64),
    publishedVersionId: ids.other,
    lastPreviewFingerprint: 'b'.repeat(64),
    lastPreviewedAt: '2026-08-04T11:00:00.000Z',
    lastSyncedAt: '2026-08-04T11:01:00.000Z',
    nextEvaluationAt: null,
    sourceChangedAt: null,
    createdAt: '2026-08-03T11:00:00.000Z',
    updatedAt: '2026-08-04T11:01:00.000Z',
    ...overrides,
  };
}

const dynamicList = (policies, limit = Math.max(1, policies.length), nextAfterPolicyId = null) => ({
  policies,
  limit,
  nextAfterPolicyId,
});

test('dynamic-group selector and policy list parsers cover all helpers and lifecycle states', () => {
  assert.deepEqual(parseDynamicGroupPolicySpec(dynamicSpec()), dynamicSpec());
  const scheduled = dynamicSpec({
    shiftMode: 'scheduled',
    scheduledShiftStartsAt: '2026-08-05T08:00:00.000Z',
    scheduledShiftEndsAt: '2026-08-06T08:00:00.000Z',
  });
  assert.deepEqual(parseDynamicGroupPolicySpec(scheduled), scheduled);
  const noShift = dynamicSpec({
    shiftMode: 'none',
    scheduledShiftStartsAt: null,
    scheduledShiftEndsAt: null,
  });
  assert.equal(parseDynamicGroupPolicySpec(noShift).shiftMode, 'none');

  assertThrowsEach(parseDynamicGroupPolicySpec, [
    ['null', null],
    ['array', []],
    ['extra', { ...dynamicSpec(), extra: true }],
    ['missing', (() => { const value = dynamicSpec(); delete value.unitIds; return value; })()],
    ['site type', dynamicSpec({ siteIds: null })],
    ['site limit', dynamicSpec({ siteIds: Array(101).fill(ids.user) })],
    ['site id type', dynamicSpec({ siteIds: [7] })],
    ['site id syntax', dynamicSpec({ siteIds: ['bad'] })],
    ['site duplicate', dynamicSpec({ siteIds: [ids.user, ids.user] })],
    ['site order', dynamicSpec({ siteIds: [ids.organization, ids.user] })],
    ['department id', dynamicSpec({ departmentIds: ['bad'] })],
    ['team id', dynamicSpec({ teamIds: ['bad'] })],
    ['line id', dynamicSpec({ lineIds: ['bad'] })],
    ['unit id', dynamicSpec({ unitIds: ['bad'] })],
    ['role type', dynamicSpec({ operationalRoles: [7] })],
    ['role empty', dynamicSpec({ operationalRoles: [''] })],
    ['role long', dynamicSpec({ operationalRoles: ['x'.repeat(161)] })],
    ['role canonical', dynamicSpec({ operationalRoles: ['Operator'] })],
    ['role duplicate', dynamicSpec({ operationalRoles: ['operator', 'operator'] })],
    ['role order', dynamicSpec({ operationalRoles: ['shift lead', 'operator'] })],
    ['membership type', dynamicSpec({ membershipRoles: [7] })],
    ['membership enum', dynamicSpec({ membershipRoles: ['viewer'] })],
    ['membership empty', dynamicSpec({ membershipRoles: [] })],
    ['descendants', dynamicSpec({ includeDescendants: 'yes' })],
    ['shift enum', dynamicSpec({ shiftMode: 'future' })],
    ['current window', dynamicSpec({ scheduledShiftStartsAt: '2026-08-05T08:00:00Z' })],
    ['scheduled start missing', { ...scheduled, scheduledShiftStartsAt: null }],
    ['scheduled end missing', { ...scheduled, scheduledShiftEndsAt: null }],
    ['scheduled invalid time', { ...scheduled, scheduledShiftStartsAt: 7 }],
    ['scheduled long time', { ...scheduled, scheduledShiftStartsAt: 'x'.repeat(41) }],
    ['scheduled reverse', { ...scheduled, scheduledShiftEndsAt: scheduled.scheduledShiftStartsAt }],
    ['scheduled too long', { ...scheduled, scheduledShiftEndsAt: '2026-09-06T08:00:01Z' }],
  ], /Invalid/);

  const active = dynamicPolicy();
  assert.deepEqual(parseDynamicGroupPolicyList(dynamicList([active], 1, ids.user)), {
    policies: [active],
    limit: 1,
    nextAfterPolicyId: ids.user,
  });
  const draft = dynamicPolicy({
    policyId: ids.organization,
    conversationKind: 'group',
    conversationUnitId: null,
    status: 'draft',
    version: 1,
    draftState: 'draft',
    publishedVersionId: null,
    lastPreviewFingerprint: null,
    lastPreviewedAt: null,
    lastSyncedAt: null,
    nextEvaluationAt: '2026-08-05T11:00:00Z',
    sourceChangedAt: '2026-08-04T11:30:00Z',
  });
  assert.equal(parseDynamicGroupPolicyList(dynamicList([draft])).policies[0].status, 'draft');
  const previewed = dynamicPolicy({
    policyId: ids.organization,
    conversationKind: 'team',
    status: 'paused',
    draftState: 'previewed',
  });
  assert.equal(parseDynamicGroupPolicyList(dynamicList([previewed])).policies[0].draftState, 'previewed');

  const policyCases = [
    ['root null', null],
    ['root extra', { policies: [], limit: 1, nextAfterPolicyId: null, extra: true }],
    ['limit type', dynamicList([], 1.5)],
    ['limit low', dynamicList([], 0)],
    ['limit high', dynamicList([], 101)],
    ['policies type', { policies: null, limit: 1, nextAfterPolicyId: null }],
    ['policies count', dynamicList([active, draft], 1)],
    ['policy null', dynamicList([null])],
    ['policy extra', dynamicList([{ ...active, extra: true }])],
    ['status', dynamicList([{ ...active, status: 'retired' }])],
    ['draft state', dynamicList([{ ...active, draftState: 'saved' }])],
    ['draft publication', dynamicList([{ ...draft, publishedVersionId: ids.other }])],
    ['active publication', dynamicList([{ ...active, publishedVersionId: null }])],
    ['draft preview fingerprint', dynamicList([{ ...draft, lastPreviewFingerprint: 'b'.repeat(64) }])],
    ['draft preview time', dynamicList([{ ...draft, lastPreviewedAt: '2026-08-04T11:00:00Z' }])],
    ['previewed fingerprint', dynamicList([{ ...previewed, lastPreviewFingerprint: null }])],
    ['previewed time', dynamicList([{ ...previewed, lastPreviewedAt: null }])],
    ['policy id type', dynamicList([{ ...active, policyId: 7 }])],
    ['conversation id', dynamicList([{ ...active, conversationId: 'bad' }])],
    ['conversation name type', dynamicList([{ ...active, conversationName: 7 }])],
    ['conversation name empty', dynamicList([{ ...active, conversationName: '' }])],
    ['conversation name long', dynamicList([{ ...active, conversationName: 'x'.repeat(161) }])],
    ['conversation kind', dynamicList([{ ...active, conversationKind: 'incident' }])],
    ['conversation unit', dynamicList([{ ...active, conversationUnitId: 'bad' }])],
    ['version type', dynamicList([{ ...active, version: 1.5 }])],
    ['version low', dynamicList([{ ...active, version: 0 }])],
    ['version high', dynamicList([{ ...active, version: 2_147_483_648 }])],
    ['maximum low', dynamicList([{ ...active, maximumMembers: 0 }])],
    ['fingerprint type', dynamicList([{ ...active, selectorFingerprint: 7 }])],
    ['fingerprint syntax', dynamicList([{ ...active, selectorFingerprint: 'bad' }])],
    ['last sync', dynamicList([{ ...active, lastSyncedAt: 'bad' }])],
    ['created', dynamicList([{ ...active, createdAt: 'bad' }])],
    ['duplicate', dynamicList([active, { ...active }], 2)],
    ['order', dynamicList([{ ...active, policyId: ids.organization }, { ...draft, policyId: ids.user }], 2)],
    ['cursor type', dynamicList([active], 1, 7)],
    ['cursor syntax', dynamicList([active], 1, 'bad')],
    ['cursor short page', dynamicList([active], 2, ids.user)],
    ['cursor mismatch', dynamicList([active], 1, ids.other)],
  ];
  assertThrowsEach(parseDynamicGroupPolicyList, policyCases, /Invalid/);
});

function dynamicSave(overrides = {}) {
  return {
    policyId: ids.user,
    conversationId: ids.conversation,
    version: 3,
    draftState: 'draft',
    selectorFingerprint: 'a'.repeat(64),
    requiresPreview: true,
    publishedVersionId: null,
    ...overrides,
  };
}

function dynamicPreview(overrides = {}) {
  return {
    policyId: ids.user,
    policyVersion: 3,
    previewFingerprint: 'b'.repeat(64),
    selectorFingerprint: 'a'.repeat(64),
    membershipStateFingerprint: 'c'.repeat(64),
    evaluatedAt: '2026-08-04T12:00:00.000Z',
    validUntil: '2026-08-04T12:05:00.000Z',
    eligibleCount: 2,
    addedCount: 1,
    removedCount: 1,
    unchangedCount: 1,
    addedSampleUserIds: [ids.user],
    removedSampleUserIds: [ids.organization],
    unchangedSampleUserIds: [ids.conversation],
    nextBoundaryAt: null,
    ...overrides,
  };
}

function dynamicPublish(overrides = {}) {
  return {
    policyId: ids.user,
    policyVersion: 3,
    publishedVersionId: ids.other,
    status: 'active',
    draftState: 'published',
    eligibleCount: 2,
    addedCount: 1,
    removedCount: 1,
    unchangedCount: 1,
    selectorFingerprint: 'a'.repeat(64),
    nextEvaluationAt: null,
    ...overrides,
  };
}

test('dynamic-group mutation receipts execute count, sample, and state consistency checks', () => {
  assert.deepEqual(parseDynamicGroupSaveReceipt(dynamicSave()), dynamicSave());
  assert.equal(parseDynamicGroupSaveReceipt(dynamicSave({ publishedVersionId: ids.other })).publishedVersionId, ids.other);
  assertThrowsEach(parseDynamicGroupSaveReceipt, [
    ['null', null],
    ['extra', { ...dynamicSave(), extra: true }],
    ['state', dynamicSave({ draftState: 'previewed' })],
    ['preview', dynamicSave({ requiresPreview: false })],
    ['policy', dynamicSave({ policyId: 'bad' })],
    ['conversation', dynamicSave({ conversationId: 'bad' })],
    ['version', dynamicSave({ version: 0 })],
    ['fingerprint', dynamicSave({ selectorFingerprint: 'bad' })],
    ['published version', dynamicSave({ publishedVersionId: 'bad' })],
  ], /Invalid/);

  assert.deepEqual(parseDynamicGroupPreviewReceipt(dynamicPreview()), dynamicPreview());
  const emptyPreview = dynamicPreview({
    eligibleCount: 0,
    addedCount: 0,
    removedCount: 0,
    unchangedCount: 0,
    addedSampleUserIds: [],
    removedSampleUserIds: [],
    unchangedSampleUserIds: [],
    nextBoundaryAt: '2026-08-05T12:00:00Z',
  });
  assert.equal(parseDynamicGroupPreviewReceipt(emptyPreview).eligibleCount, 0);
  assertThrowsEach(parseDynamicGroupPreviewReceipt, [
    ['null', null],
    ['extra', { ...dynamicPreview(), extra: true }],
    ['eligible type', dynamicPreview({ eligibleCount: 1.5 })],
    ['eligible low', dynamicPreview({ eligibleCount: -1 })],
    ['eligible high', dynamicPreview({ eligibleCount: 5001 })],
    ['counts', dynamicPreview({ eligibleCount: 3 })],
    ['sample type', dynamicPreview({ addedSampleUserIds: null })],
    ['sample limit', dynamicPreview({ addedSampleUserIds: Array(201).fill(ids.user) })],
    ['sample id', dynamicPreview({ addedSampleUserIds: ['bad'] })],
    ['sample duplicate', dynamicPreview({ addedCount: 2, eligibleCount: 3, addedSampleUserIds: [ids.user, ids.user] })],
    ['sample order', dynamicPreview({ addedCount: 2, eligibleCount: 3, addedSampleUserIds: [ids.organization, ids.user] })],
    ['sample exceeds count', dynamicPreview({ addedSampleUserIds: [ids.user, ids.fourth] })],
    ['sample overlap', dynamicPreview({ removedSampleUserIds: [ids.user] })],
    ['policy id', dynamicPreview({ policyId: 'bad' })],
    ['version', dynamicPreview({ policyVersion: 0 })],
    ['preview fingerprint', dynamicPreview({ previewFingerprint: 'bad' })],
    ['selector fingerprint', dynamicPreview({ selectorFingerprint: 'bad' })],
    ['membership fingerprint', dynamicPreview({ membershipStateFingerprint: 'bad' })],
    ['evaluated time', dynamicPreview({ evaluatedAt: 'bad' })],
    ['valid time', dynamicPreview({ validUntil: 'bad' })],
    ['boundary', dynamicPreview({ nextBoundaryAt: 'bad' })],
  ], /Invalid/);

  assert.deepEqual(parseDynamicGroupPublishReceipt(dynamicPublish()), dynamicPublish());
  assertThrowsEach(parseDynamicGroupPublishReceipt, [
    ['null', null],
    ['extra', { ...dynamicPublish(), extra: true }],
    ['status', dynamicPublish({ status: 'paused' })],
    ['draft state', dynamicPublish({ draftState: 'previewed' })],
    ['counts', dynamicPublish({ eligibleCount: 3 })],
    ['policy', dynamicPublish({ policyId: 'bad' })],
    ['version', dynamicPublish({ policyVersion: 0 })],
    ['published', dynamicPublish({ publishedVersionId: 'bad' })],
    ['fingerprint', dynamicPublish({ selectorFingerprint: 'bad' })],
    ['evaluation', dynamicPublish({ nextEvaluationAt: 'bad' })],
  ], /Invalid/);

  const pause = {
    policyId: ids.user,
    policyVersion: 3,
    status: 'paused',
    pausedAt: '2026-08-04T12:10:00.000Z',
  };
  assert.deepEqual(parseDynamicGroupPauseReceipt(pause), pause);
  assert.throws(() => parseDynamicGroupPauseReceipt(null), /Invalid/);
  assert.throws(() => parseDynamicGroupPauseReceipt({ ...pause, extra: true }), /Invalid/);
  assert.throws(() => parseDynamicGroupPauseReceipt({ ...pause, status: 'active' }), /Invalid/);
  assert.throws(() => parseDynamicGroupPauseReceipt({ ...pause, policyId: 'bad' }), /Invalid/);
  assert.throws(() => parseDynamicGroupPauseReceipt({ ...pause, policyVersion: 0 }), /Invalid/);
  assert.throws(() => parseDynamicGroupPauseReceipt({ ...pause, pausedAt: 'bad' }), /Invalid/);
});

function handoffRequest(overrides = {}) {
  return {
    organizationId: ids.organization,
    handoffId: ids.case,
    expectedVersionId: ids.factor,
    expectedVersionNumber: 3,
    title: '  Corrected handoff  ',
    details: '  Corrected operational details.  ',
    sourceLanguage: 'en',
    shiftStartedAt: '2026-08-04T08:00:00-06:00',
    shiftEndedAt: '2026-08-04T16:00:00-06:00',
    sourceMessageIds: ['102', 99],
    acknowledgementDueAt: '2026-08-04T16:30:00-06:00',
    reason: '  Correct a transposed value.  ',
    idempotencyKey: 'coverage-key-001',
    ...overrides,
  };
}

function handoffReceipt(overrides = {}) {
  return {
    handoffId: ids.case,
    handoffVersionId: ids.other,
    versionNumber: 4,
    status: 'draft',
    requiresSignature: true,
    sourceMessageIds: ['99', '102'],
    sourceFingerprint: 'a'.repeat(64),
    sourceState: 'current',
    acknowledgementDueAt: '2026-08-04T22:30:00.000Z',
    reminderState: 'not_due',
    escalationState: 'not_due',
    smsFallbackAvailable: false,
    ...overrides,
  };
}

test('handoff correction request executes every scalar, message ordering, and deadline boundary', () => {
  const normalized = normalizeHandoffCorrectionRequest(handoffRequest());
  assert.deepEqual(normalized.sourceMessageIds, ['99', '102']);
  assert.equal(normalized.title, 'Corrected handoff');
  assert.equal(normalizeHandoffCorrectionRequest(handoffRequest({ acknowledgementDueAt: null })).acknowledgementDueAt, null);
  assert.equal(normalizeHandoffCorrectionRequest(handoffRequest({ acknowledgementDueAt: undefined })).acknowledgementDueAt, null);
  for (const sourceLanguage of ['ko', 'es']) {
    assert.equal(normalizeHandoffCorrectionRequest(handoffRequest({ sourceLanguage })).sourceLanguage, sourceLanguage);
  }

  assertThrowsEach(normalizeHandoffCorrectionRequest, [
    ['null', null],
    ['array', []],
    ['extra', { ...handoffRequest(), extra: true }],
    ['organization type', handoffRequest({ organizationId: 7 })],
    ['organization syntax', handoffRequest({ organizationId: 'bad' })],
    ['handoff', handoffRequest({ handoffId: 'bad' })],
    ['version id', handoffRequest({ expectedVersionId: 'bad' })],
    ['version type', handoffRequest({ expectedVersionNumber: 1.5 })],
    ['version low', handoffRequest({ expectedVersionNumber: 0 })],
    ['version high', handoffRequest({ expectedVersionNumber: 2_147_483_648 })],
    ['title type', handoffRequest({ title: 7 })],
    ['title empty', handoffRequest({ title: '   ' })],
    ['title long', handoffRequest({ title: 'x'.repeat(241) })],
    ['title control', handoffRequest({ title: 'bad\u0000title' })],
    ['details empty', handoffRequest({ details: '' })],
    ['details long', handoffRequest({ details: 'x'.repeat(30_001) })],
    ['language type', handoffRequest({ sourceLanguage: 7 })],
    ['language length', handoffRequest({ sourceLanguage: 'eng' })],
    ['language enum', handoffRequest({ sourceLanguage: 'fr' })],
    ['shift start type', handoffRequest({ shiftStartedAt: 7 })],
    ['shift start short', handoffRequest({ shiftStartedAt: 'bad' })],
    ['shift start long', handoffRequest({ shiftStartedAt: 'x'.repeat(65) })],
    ['shift start syntax', handoffRequest({ shiftStartedAt: '2026-08-04T99:00:00Z' })],
    ['shift window equal', handoffRequest({ shiftEndedAt: '2026-08-04T08:00:00-06:00' })],
    ['message ids type', handoffRequest({ sourceMessageIds: null })],
    ['message ids empty', handoffRequest({ sourceMessageIds: [] })],
    ['message ids limit', handoffRequest({ sourceMessageIds: Array(501).fill('1') })],
    ['message id unsafe', handoffRequest({ sourceMessageIds: [Number.MAX_SAFE_INTEGER + 1] })],
    ['message id string', handoffRequest({ sourceMessageIds: ['0'] })],
    ['message duplicate', handoffRequest({ sourceMessageIds: [1, '1'] })],
    ['deadline', handoffRequest({ acknowledgementDueAt: '2026-08-04T15:59:00-06:00' })],
    ['reason short', handoffRequest({ reason: 'no' })],
    ['reason long', handoffRequest({ reason: 'x'.repeat(2_001) })],
    ['key short', handoffRequest({ idempotencyKey: 'short' })],
    ['key long', handoffRequest({ idempotencyKey: 'x'.repeat(129) })],
    ['key pattern', handoffRequest({ idempotencyKey: 'invalid key' })],
  ], /Invalid/);
});

test('handoff correction receipt checks every authoritative field and envelope form', () => {
  const parsed = parseHandoffCorrectionReceipt({ data: handoffReceipt() }, handoffRequest());
  assert.equal(parsed.versionId, ids.other);
  assert.throws(() => parseHandoffCorrectionReceipt({ data: handoffReceipt(), extra: true }, handoffRequest()), /response envelope/);
  assert.throws(() => parseHandoffCorrectionReceipt({ data: null }, handoffRequest()), /response data/);
  assertThrowsEach(
    (value) => parseHandoffCorrectionReceipt(value, handoffRequest()),
    [
      ['null', null],
      ['extra', { ...handoffReceipt(), extra: true }],
      ['handoff', handoffReceipt({ handoffId: ids.other })],
      ['version unchanged', handoffReceipt({ handoffVersionId: ids.factor })],
      ['version number', handoffReceipt({ versionNumber: 5 })],
      ['status', handoffReceipt({ status: 'published' })],
      ['signature', handoffReceipt({ requiresSignature: false })],
      ['source state', handoffReceipt({ sourceState: 'stale' })],
      ['reminder', handoffReceipt({ reminderState: 'due' })],
      ['escalation', handoffReceipt({ escalationState: 'due' })],
      ['sms', handoffReceipt({ smsFallbackAvailable: true })],
      ['fingerprint type', handoffReceipt({ sourceFingerprint: 7 })],
      ['fingerprint', handoffReceipt({ sourceFingerprint: 'g'.repeat(64) })],
      ['source count', handoffReceipt({ sourceMessageIds: ['99'] })],
      ['source value', handoffReceipt({ sourceMessageIds: ['98', '102'] })],
      ['source order', handoffReceipt({ sourceMessageIds: ['102', '99'] })],
      ['deadline', handoffReceipt({ acknowledgementDueAt: null })],
      ['handoff id syntax', handoffReceipt({ handoffId: 'bad' })],
      ['version id syntax', handoffReceipt({ handoffVersionId: 'bad' })],
      ['version type', handoffReceipt({ versionNumber: 1.5 })],
    ],
    /Invalid/,
  );
  const requestWithoutDeadline = handoffRequest({ acknowledgementDueAt: null });
  assert.equal(
    parseHandoffCorrectionReceipt(handoffReceipt({ acknowledgementDueAt: null }), requestWithoutDeadline)
      .acknowledgementDueAt,
    null,
  );
});

function moderationListItem(overrides = {}) {
  return {
    caseId: ids.case,
    status: 'assigned',
    category: 'harassment',
    target: { type: 'message', label: 'Reported participant' },
    unitId: ids.organization,
    reportedAt: '2026-08-04T10:00:00.000Z',
    updatedAt: '2026-08-04T10:10:00.000Z',
    recordVersion: 2,
    assignedAt: '2026-08-04T10:05:00.000Z',
    assignedToMe: true,
    assignedInvestigatorUserId: ids.user,
    canClaim: false,
    canAssign: false,
    canViewEvidence: true,
    readOnly: false,
    reporterLabel: 'protected',
    eligibleInvestigatorUserIds: [ids.other],
    ...overrides,
  };
}

function moderationList(cases = [moderationListItem()], overrides = {}) {
  return {
    schemaVersion: 2,
    cases,
    nextCursor: null,
    contentIncluded: false,
    reporterIdentityIncluded: false,
    requiresExplicitAssignmentForEvidence: true,
    ...overrides,
  };
}

function moderationEvidence(overrides = {}) {
  return {
    evidenceId: 2,
    relationship: 'reported',
    relativePosition: 0,
    messageKind: 'text',
    messageBody: 'Scoped evidence',
    senderLabel: 'Reported participant',
    sentAt: '2026-08-04T09:59:00.000Z',
    bodySha256: 'a'.repeat(64),
    ...overrides,
  };
}

function moderationHistory(overrides = {}) {
  return {
    eventId: 1,
    eventType: 'review_started',
    fromStatus: 'assigned',
    toStatus: 'in_review',
    reason: 'Review accepted.',
    evidenceMetadata: {
      referenceIds: ['reference-1', 'reference-2'],
      policyCode: 'SAFETY.PRIVACY:1',
      severity: 'high',
    },
    actorLabel: 'assigned_investigator',
    occurredAt: '2026-08-04T10:10:00.000Z',
    ...overrides,
  };
}

function moderationDetail(caseOverrides = {}, scopeOverrides = {}) {
  return {
    schemaVersion: 2,
    case: {
      caseId: ids.case,
      status: 'in_review',
      category: 'privacy',
      target: { type: 'message', label: 'Reported participant' },
      details: 'Reporter supplied bounded operational detail.',
      reporterLabel: 'protected',
      reportedAt: '2026-08-04T10:00:00.000Z',
      updatedAt: '2026-08-04T10:10:00.000Z',
      assignedAt: '2026-08-04T10:05:00.000Z',
      recordVersion: 3,
      readOnly: false,
      evidence: [
        moderationEvidence({
          evidenceId: 1,
          relationship: 'context_before',
          relativePosition: -1,
          messageBody: null,
        }),
        moderationEvidence(),
        moderationEvidence({
          evidenceId: 3,
          relationship: 'context_after',
          relativePosition: 1,
          messageBody: '',
        }),
      ],
      history: [moderationHistory(), moderationHistory({
        eventId: 2,
        eventType: 'reported',
        fromStatus: null,
        toStatus: 'open',
        reason: null,
        evidenceMetadata: {},
        actorLabel: 'protected_reporter',
        occurredAt: '2026-08-04T10:00:00.000Z',
      })],
      ...caseOverrides,
    },
    scope: {
      reportedItemAndConsentedContextOnly: true,
      reporterIdentityIncluded: false,
      otherConversationsIncluded: false,
      targetOnly: true,
      messageEvidenceIncluded: true,
      ...scopeOverrides,
    },
  };
}

test('moderation list parsing covers redaction metadata, assignment states, cursor, and exact bounds', () => {
  const cursor = { beforeUpdatedAt: '2026-08-04T10:10:00.000Z', beforeCaseId: ids.case };
  assert.deepEqual(parseModerationCaseList({ data: moderationList(undefined, { nextCursor: cursor }) }).nextCursor, cursor);
  const open = moderationListItem({
    status: 'open',
    unitId: null,
    assignedAt: null,
    assignedToMe: false,
    assignedInvestigatorUserId: null,
    canClaim: true,
    canAssign: true,
    canViewEvidence: false,
    eligibleInvestigatorUserIds: [],
  });
  assert.equal(parseModerationCaseList(moderationList([open])).cases[0].canClaim, true);
  for (const status of ['resolved', 'dismissed']) {
    const closed = moderationListItem({ status, assignedToMe: false, readOnly: true });
    assert.equal(parseModerationCaseList(moderationList([closed])).cases[0].readOnly, true);
  }
  assert.equal(parseModerationCaseList(moderationList([
    moderationListItem({ status: 'in_review', canAssign: true }),
  ])).cases[0].status, 'in_review');

  assert.throws(() => parseModerationCaseList(null), /response/);
  assert.throws(() => parseModerationCaseList([]), /response/);
  assert.throws(() => parseModerationCaseList({ data: moderationList(), extra: true }), /response envelope/);
  assert.throws(() => parseModerationCaseList({ data: null }), /response data/);
  assertThrowsEach(parseModerationCaseList, [
    ['root extra', { ...moderationList(), extra: true }],
    ['schema', moderationList(undefined, { schemaVersion: 1 })],
    ['content', moderationList(undefined, { contentIncluded: true })],
    ['reporter', moderationList(undefined, { reporterIdentityIncluded: true })],
    ['assignment gate', moderationList(undefined, { requiresExplicitAssignmentForEvidence: false })],
    ['cases type', moderationList(null)],
    ['cases count', moderationList(Array(101).fill(moderationListItem()))],
    ['case object', moderationList([null])],
    ['case extra', moderationList([{ ...moderationListItem(), secret: true }])],
    ['status', moderationList([moderationListItem({ status: 'pending' })])],
    ['assigned to me type', moderationList([moderationListItem({ assignedToMe: 'yes' })])],
    ['assigned investigator', moderationList([moderationListItem({ assignedInvestigatorUserId: 'bad' })])],
    ['assigned time', moderationList([moderationListItem({ assignedAt: 'bad' })])],
    ['claim type', moderationList([moderationListItem({ canClaim: 'yes' })])],
    ['assign type', moderationList([moderationListItem({ canAssign: 'yes' })])],
    ['evidence type', moderationList([moderationListItem({ canViewEvidence: 'yes' })])],
    ['read only type', moderationList([moderationListItem({ readOnly: 'yes' })])],
    ['reporter label', moderationList([moderationListItem({ reporterLabel: 'identified' })])],
    ['open assigned time', moderationList([{ ...open, assignedAt: '2026-08-04T10:05:00Z' }])],
    ['assigned missing time', moderationList([moderationListItem({ assignedAt: null })])],
    ['open assigned to me', moderationList([{ ...open, assignedToMe: true }])],
    ['open evidence', moderationList([{ ...open, canViewEvidence: true }])],
    ['open investigator', moderationList([{ ...open, assignedInvestigatorUserId: ids.user }])],
    ['assigned to me without evidence', moderationList([moderationListItem({ canViewEvidence: false })])],
    ['claim assigned', moderationList([moderationListItem({ canClaim: true })])],
    ['assign closed', moderationList([moderationListItem({ status: 'resolved', canAssign: true, readOnly: true })])],
    ['read only open', moderationList([{ ...open, readOnly: true }])],
    ['read only assigned', moderationList([moderationListItem({ readOnly: true })])],
    ['case id', moderationList([moderationListItem({ caseId: 'bad' })])],
    ['category', moderationList([moderationListItem({ category: 'unknown' })])],
    ['target object', moderationList([moderationListItem({ target: null })])],
    ['target extra', moderationList([moderationListItem({ target: { type: 'message', label: 'Target', id: ids.user } })])],
    ['target type', moderationList([moderationListItem({ target: { type: 'unknown', label: 'Target' } })])],
    ['target label type', moderationList([moderationListItem({ target: { type: 'message', label: 7 } })])],
    ['target label empty', moderationList([moderationListItem({ target: { type: 'message', label: '' } })])],
    ['target label long', moderationList([moderationListItem({ target: { type: 'message', label: 'x'.repeat(161) } })])],
    ['unit', moderationList([moderationListItem({ unitId: 'bad' })])],
    ['report time', moderationList([moderationListItem({ reportedAt: 'bad' })])],
    ['update time', moderationList([moderationListItem({ updatedAt: 'bad' })])],
    ['record version type', moderationList([moderationListItem({ recordVersion: 1.5 })])],
    ['record version low', moderationList([moderationListItem({ recordVersion: 0 })])],
    ['eligible type', moderationList([moderationListItem({ eligibleInvestigatorUserIds: null })])],
    ['eligible limit', moderationList([moderationListItem({ eligibleInvestigatorUserIds: Array(101).fill(ids.user) })])],
    ['eligible id', moderationList([moderationListItem({ eligibleInvestigatorUserIds: ['bad'] })])],
    ['eligible duplicate', moderationList([moderationListItem({ eligibleInvestigatorUserIds: [ids.other, ids.other] })])],
    ['duplicate cases', moderationList([moderationListItem(), moderationListItem()])],
    ['cursor object', moderationList(undefined, { nextCursor: [] })],
    ['cursor extra', moderationList(undefined, { nextCursor: { ...cursor, extra: true } })],
    ['cursor time', moderationList(undefined, { nextCursor: { ...cursor, beforeUpdatedAt: 'bad' } })],
    ['cursor case', moderationList(undefined, { nextCursor: { ...cursor, beforeCaseId: 'bad' } })],
  ], /invalid moderation/);
});

test('moderation detail executes all evidence relationships, metadata variants, and closure checks', () => {
  const parsed = parseModerationCaseDetail({ data: moderationDetail() });
  assert.equal(parsed.case.evidence.length, 3);
  assert.deepEqual(parsed.case.history[0].evidenceMetadata, {
    referenceIds: ['reference-1', 'reference-2'],
    policyCode: 'SAFETY.PRIVACY:1',
    severity: 'high',
  });
  for (const type of ['group', 'member']) {
    const value = moderationDetail({
      target: { type, label: 'Content-free target' },
      details: null,
      evidence: [],
    }, { messageEvidenceIncluded: false });
    assert.equal(parseModerationCaseDetail(value).case.target.type, type);
  }
  for (const status of ['resolved', 'dismissed']) {
    const value = moderationDetail({ status, readOnly: true });
    assert.equal(parseModerationCaseDetail(value).case.readOnly, true);
  }

  const detailCases = [
    ['null', null],
    ['root extra', { ...moderationDetail(), extra: true }],
    ['schema', { ...moderationDetail(), schemaVersion: 1 }],
    ['scope object', { ...moderationDetail(), scope: null }],
    ['scope extra', { ...moderationDetail(), scope: { ...moderationDetail().scope, extra: true } }],
    ['scope reported', moderationDetail({}, { reportedItemAndConsentedContextOnly: false })],
    ['scope reporter', moderationDetail({}, { reporterIdentityIncluded: true })],
    ['scope other', moderationDetail({}, { otherConversationsIncluded: true })],
    ['scope target', moderationDetail({}, { targetOnly: false })],
    ['scope evidence type', moderationDetail({}, { messageEvidenceIncluded: 'yes' })],
    ['case object', { ...moderationDetail(), case: null }],
    ['case extra', moderationDetail({ extra: true })],
    ['status', moderationDetail({ status: 'pending' })],
    ['open detail', moderationDetail({ status: 'open' })],
    ['reporter', moderationDetail({ reporterLabel: 'identified' })],
    ['scope target mismatch', moderationDetail({}, { messageEvidenceIncluded: false })],
    ['evidence type', moderationDetail({ evidence: null })],
    ['evidence count', moderationDetail({ evidence: Array(6).fill(moderationEvidence()) })],
    ['message empty', moderationDetail({ evidence: [] })],
    ['nonmessage evidence', moderationDetail({ target: { type: 'group', label: 'Group' } }, { messageEvidenceIncluded: false })],
    ['evidence object', moderationDetail({ evidence: [null] })],
    ['evidence extra', moderationDetail({ evidence: [{ ...moderationEvidence(), extra: true }] })],
    ['relationship', moderationDetail({ evidence: [moderationEvidence({ relationship: 'nearby' })] })],
    ['position type', moderationDetail({ evidence: [moderationEvidence({ relativePosition: 0.5 })] })],
    ['position low', moderationDetail({ evidence: [moderationEvidence({ relativePosition: -3 })] })],
    ['position high', moderationDetail({ evidence: [moderationEvidence({ relativePosition: 3 })] })],
    ['reported position', moderationDetail({ evidence: [moderationEvidence({ relativePosition: 1 })] })],
    ['before position', moderationDetail({ evidence: [moderationEvidence({ relationship: 'context_before', relativePosition: 0 })] })],
    ['after position', moderationDetail({ evidence: [moderationEvidence({ relationship: 'context_after', relativePosition: 0 })] })],
    ['body type', moderationDetail({ evidence: [moderationEvidence({ messageBody: 7 })] })],
    ['body long', moderationDetail({ evidence: [moderationEvidence({ messageBody: 'x'.repeat(20_001) })] })],
    ['body control', moderationDetail({ evidence: [moderationEvidence({ messageBody: 'bad\u0000body' })] })],
    ['hash type', moderationDetail({ evidence: [moderationEvidence({ bodySha256: 7 })] })],
    ['hash syntax', moderationDetail({ evidence: [moderationEvidence({ bodySha256: 'g'.repeat(64) })] })],
    ['evidence id', moderationDetail({ evidence: [moderationEvidence({ evidenceId: 0 })] })],
    ['message kind', moderationDetail({ evidence: [moderationEvidence({ messageKind: '' })] })],
    ['sender label', moderationDetail({ evidence: [moderationEvidence({ senderLabel: '' })] })],
    ['sent time', moderationDetail({ evidence: [moderationEvidence({ sentAt: 'bad' })] })],
    ['two reported', moderationDetail({ evidence: [moderationEvidence(), moderationEvidence({ evidenceId: 3, relativePosition: 1 })] })],
    ['duplicate position', moderationDetail({ evidence: [moderationEvidence({ relationship: 'context_before', relativePosition: -1 }), moderationEvidence({ evidenceId: 3, relationship: 'context_before', relativePosition: -1 })] })],
    ['history type', moderationDetail({ history: null })],
    ['history empty', moderationDetail({ history: [] })],
    ['history limit', moderationDetail({ history: Array(201).fill(moderationHistory()) })],
    ['history object', moderationDetail({ history: [null] })],
    ['history extra', moderationDetail({ history: [{ ...moderationHistory(), extra: true }] })],
    ['history id', moderationDetail({ history: [moderationHistory({ eventId: 0 })] })],
    ['history event', moderationDetail({ history: [moderationHistory({ eventType: 'opened' })] })],
    ['history from', moderationDetail({ history: [moderationHistory({ fromStatus: 'pending' })] })],
    ['history to', moderationDetail({ history: [moderationHistory({ toStatus: 'pending' })] })],
    ['history reason', moderationDetail({ history: [moderationHistory({ reason: 'x' })] })],
    ['metadata object', moderationDetail({ history: [moderationHistory({ evidenceMetadata: null })] })],
    ['metadata extra', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { extra: true } })] })],
    ['references type', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { referenceIds: null } })] })],
    ['references limit', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { referenceIds: Array(21).fill('ref') } })] })],
    ['reference item type', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { referenceIds: [7] } })] })],
    ['reference empty', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { referenceIds: [''] } })] })],
    ['reference long', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { referenceIds: ['x'.repeat(121)] } })] })],
    ['reference duplicate', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { referenceIds: ['ref', 'ref'] } })] })],
    ['policy type', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { policyCode: 7 } })] })],
    ['policy short', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { policyCode: 'x' } })] })],
    ['policy pattern', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { policyCode: 'bad code' } })] })],
    ['severity', moderationDetail({ history: [moderationHistory({ evidenceMetadata: { severity: 'urgent' } })] })],
    ['actor', moderationDetail({ history: [moderationHistory({ actorLabel: ids.user })] })],
    ['occurred', moderationDetail({ history: [moderationHistory({ occurredAt: 'bad' })] })],
    ['read only active', moderationDetail({ readOnly: true })],
    ['read only closed', moderationDetail({ status: 'resolved', readOnly: false })],
    ['case id', moderationDetail({ caseId: 'bad' })],
    ['category', moderationDetail({ category: 'unknown' })],
    ['details type', moderationDetail({ details: 7 })],
    ['report time', moderationDetail({ reportedAt: 'bad' })],
    ['update time', moderationDetail({ updatedAt: 'bad' })],
    ['assignment time', moderationDetail({ assignedAt: 'bad' })],
    ['version', moderationDetail({ recordVersion: 0 })],
  ];
  assertThrowsEach(parseModerationCaseDetail, detailCases, /invalid moderation/);
});

test('moderation assignment and transition receipts execute all state and redaction branches', () => {
  const assignment = {
    caseId: ids.case,
    status: 'assigned',
    recordVersion: 2,
    assignedAt: '2026-08-04T10:05:00.000Z',
    assignedInvestigatorUserId: ids.user,
    reporterIdentityIncluded: false,
  };
  assert.equal(parseModerationAssignmentReceipt({ data: assignment }).assignedInvestigatorUserId, ids.user);
  assertThrowsEach(parseModerationAssignmentReceipt, [
    ['null', null],
    ['extra', { ...assignment, extra: true }],
    ['status', { ...assignment, status: 'open' }],
    ['reporter', { ...assignment, reporterIdentityIncluded: true }],
    ['case', { ...assignment, caseId: 'bad' }],
    ['version', { ...assignment, recordVersion: 0 }],
    ['time', { ...assignment, assignedAt: 'bad' }],
    ['investigator', { ...assignment, assignedInvestigatorUserId: 'bad' }],
  ], /invalid moderation/);

  const transition = {
    caseId: ids.case,
    status: 'in_review',
    recordVersion: 3,
    updatedAt: '2026-08-04T10:10:00.000Z',
    readOnly: false,
    reporterIdentityIncluded: false,
    notificationPayloadContentIncluded: false,
  };
  assert.equal(parseModerationTransitionReceipt(transition).status, 'in_review');
  for (const status of ['resolved', 'dismissed']) {
    assert.equal(parseModerationTransitionReceipt({ ...transition, status, readOnly: true }).status, status);
  }
  assertThrowsEach(parseModerationTransitionReceipt, [
    ['null', null],
    ['extra', { ...transition, extra: true }],
    ['status', { ...transition, status: 'assigned' }],
    ['read only type', { ...transition, readOnly: 'yes' }],
    ['reporter', { ...transition, reporterIdentityIncluded: true }],
    ['notification', { ...transition, notificationPayloadContentIncluded: true }],
    ['active read only', { ...transition, readOnly: true }],
    ['closed writable', { ...transition, status: 'resolved' }],
    ['case', { ...transition, caseId: 'bad' }],
    ['version', { ...transition, recordVersion: 0 }],
    ['time', { ...transition, updatedAt: 'bad' }],
  ], /invalid moderation/);
});

function recoveryCase(overrides = {}) {
  return {
    case_id: ids.case,
    organization_id: ids.organization,
    target_user_id: ids.user,
    target_factor_id: ids.factor,
    status: 'awaiting_external_verification',
    request_reason: 'Authenticator was lost during an approved replacement.',
    privileged_target: false,
    required_approvals: 1,
    approvals_recorded: 0,
    human_verification_recorded: false,
    verification_method: null,
    external_verification_performed_by_newone: false,
    expires_at: '2026-08-05T12:00:00.000Z',
    created_at: '2026-08-04T10:00:00.000Z',
    updated_at: '2026-08-04T10:00:00.000Z',
    completed_at: null,
    ...overrides,
  };
}

function recoveryList(cases = [recoveryCase()], overrides = {}) {
  return {
    schema_version: 1,
    scope: 'organization',
    cases,
    human_verification_policy: {
      performed_by_newone: false,
      external_policy_required: true,
    },
    ...overrides,
  };
}

function recoveryFactor(overrides = {}) {
  return {
    id: ids.factor,
    type: 'totp',
    status: 'verified',
    friendlyName: 'Work authenticator',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:01:00.000Z',
    ...overrides,
  };
}

test('recovery case lists execute all status, verification, approval, time, and envelope checks', () => {
  assert.equal(parseRecoveryCaseList({ data: recoveryList() }).cases[0].status, 'awaiting_external_verification');
  assert.equal(parseRecoveryCaseList(recoveryList(undefined, { scope: 'self' })).scope, 'self');
  const verified = {
    human_verification_recorded: true,
    verification_method: 'in_person',
  };
  const states = [
    recoveryCase({ status: 'awaiting_approval', ...verified }),
    recoveryCase({ status: 'approved', approvals_recorded: 1, ...verified }),
    recoveryCase({ status: 'executing', approvals_recorded: 1, ...verified }),
    recoveryCase({
      status: 'completed',
      approvals_recorded: 1,
      completed_at: '2026-08-04T11:00:00.000Z',
      ...verified,
    }),
    recoveryCase({ status: 'rejected' }),
    recoveryCase({ status: 'expired' }),
  ];
  for (const value of states) {
    assert.equal(parseRecoveryCaseList(recoveryList([value])).cases[0].status, value.status);
  }
  for (const verification_method of ['manager_callback', 'hr_record_match', 'approved_provider']) {
    const value = recoveryCase({ status: 'awaiting_approval', human_verification_recorded: true, verification_method });
    assert.equal(parseRecoveryCaseList(recoveryList([value])).cases[0].verificationMethod, verification_method);
  }
  const privileged = recoveryCase({ privileged_target: true, required_approvals: 2 });
  assert.equal(parseRecoveryCaseList(recoveryList([privileged])).cases[0].requiredApprovals, 2);

  assert.throws(() => parseRecoveryCaseList(null), /response/);
  assert.throws(() => parseRecoveryCaseList([]), /response/);
  assert.throws(() => parseRecoveryCaseList({ data: recoveryList(), extra: true }), /response envelope/);
  assert.throws(() => parseRecoveryCaseList({ data: null }), /response data/);
  assertThrowsEach(parseRecoveryCaseList, [
    ['root extra', { ...recoveryList(), extra: true }],
    ['schema', recoveryList(undefined, { schema_version: 2 })],
    ['scope', recoveryList(undefined, { scope: 'all' })],
    ['cases type', recoveryList(null)],
    ['cases limit', recoveryList(Array(101).fill(recoveryCase()))],
    ['policy object', recoveryList(undefined, { human_verification_policy: null })],
    ['policy extra', recoveryList(undefined, { human_verification_policy: { performed_by_newone: false, external_policy_required: true, extra: true } })],
    ['policy authority', recoveryList(undefined, { human_verification_policy: { performed_by_newone: true, external_policy_required: true } })],
    ['policy required', recoveryList(undefined, { human_verification_policy: { performed_by_newone: false, external_policy_required: false } })],
    ['case object', recoveryList([null])],
    ['case extra', recoveryList([{ ...recoveryCase(), secret: true }])],
    ['case id type', recoveryList([recoveryCase({ case_id: 7 })])],
    ['case id syntax', recoveryList([recoveryCase({ case_id: 'bad' })])],
    ['organization', recoveryList([recoveryCase({ organization_id: 'bad' })])],
    ['target', recoveryList([recoveryCase({ target_user_id: 'bad' })])],
    ['factor', recoveryList([recoveryCase({ target_factor_id: 'bad' })])],
    ['status', recoveryList([recoveryCase({ status: 'pending' })])],
    ['reason type', recoveryList([recoveryCase({ request_reason: 7 })])],
    ['reason short', recoveryList([recoveryCase({ request_reason: 'short' })])],
    ['reason long', recoveryList([recoveryCase({ request_reason: 'x'.repeat(1001) })])],
    ['reason control', recoveryList([recoveryCase({ request_reason: 'valid reason\u0000hidden' })])],
    ['privileged type', recoveryList([recoveryCase({ privileged_target: 'no' })])],
    ['approvals type', recoveryList([recoveryCase({ required_approvals: 1.5 })])],
    ['approvals low', recoveryList([recoveryCase({ required_approvals: -1 })])],
    ['approvals high', recoveryList([recoveryCase({ required_approvals: 3 })])],
    ['count type', recoveryList([recoveryCase({ approvals_recorded: 1.5 })])],
    ['verification boolean', recoveryList([recoveryCase({ human_verification_recorded: 'no' })])],
    ['verification method', recoveryList([recoveryCase({ verification_method: 'video' })])],
    ['verification authority type', recoveryList([recoveryCase({ external_verification_performed_by_newone: 'no' })])],
    ['verification authority', recoveryList([recoveryCase({ external_verification_performed_by_newone: true })])],
    ['ordinary approval policy', recoveryList([recoveryCase({ required_approvals: 2 })])],
    ['privileged approval policy', recoveryList([recoveryCase({ privileged_target: true, required_approvals: 1 })])],
    ['approval overflow', recoveryList([recoveryCase({ approvals_recorded: 2 })])],
    ['verification mismatch true', recoveryList([recoveryCase({ human_verification_recorded: true })])],
    ['verification mismatch false', recoveryList([recoveryCase({ verification_method: 'in_person' })])],
    ['awaiting external verified', recoveryList([recoveryCase({ human_verification_recorded: true, verification_method: 'in_person' })])],
    ['awaiting external approval', recoveryList([recoveryCase({ approvals_recorded: 1 })])],
    ['awaiting approval unverified', recoveryList([recoveryCase({ status: 'awaiting_approval' })])],
    ['awaiting approval complete', recoveryList([recoveryCase({ status: 'awaiting_approval', approvals_recorded: 1, ...verified })])],
    ['approved unverified', recoveryList([recoveryCase({ status: 'approved', approvals_recorded: 1 })])],
    ['approved incomplete', recoveryList([recoveryCase({ status: 'approved', ...verified })])],
    ['completed missing time', recoveryList([recoveryCase({ status: 'completed', approvals_recorded: 1, ...verified })])],
    ['noncompleted time', recoveryList([recoveryCase({ completed_at: '2026-08-04T11:00:00Z' })])],
    ['expiry type', recoveryList([recoveryCase({ expires_at: 7 })])],
    ['expiry short', recoveryList([recoveryCase({ expires_at: 'bad' })])],
    ['expiry long', recoveryList([recoveryCase({ expires_at: 'x'.repeat(65) })])],
    ['expiry syntax', recoveryList([recoveryCase({ expires_at: '2026-08-04T99:00:00Z' })])],
    ['expiry ordering', recoveryList([recoveryCase({ expires_at: '2026-08-04T09:59:59Z' })])],
    ['update ordering', recoveryList([recoveryCase({ updated_at: '2026-08-04T09:59:59Z' })])],
    ['duplicate cases', recoveryList([recoveryCase(), recoveryCase()])],
  ], /invalid recovery/);
});

test('recovery factor parsing covers verified filtering, nullable names, bounds, and duplicates', () => {
  const unverified = recoveryFactor({
    id: ids.other,
    status: 'unverified',
    friendlyName: null,
  });
  assert.deepEqual(parseVerifiedTotpFactors({ data: { factors: [recoveryFactor(), unverified] } }), [
    { id: ids.factor, status: 'verified', friendlyName: 'Work authenticator' },
  ]);
  assert.throws(() => parseVerifiedTotpFactors({ data: { factors: [] }, extra: true }), /response envelope/);
  assertThrowsEach(parseVerifiedTotpFactors, [
    ['null', null],
    ['root extra', { factors: [], extra: true }],
    ['factor type', { factors: null }],
    ['factor limit', { factors: Array(21).fill(recoveryFactor()) }],
    ['factor object', { factors: [null] }],
    ['factor extra', { factors: [{ ...recoveryFactor(), extra: true }] }],
    ['id', { factors: [recoveryFactor({ id: 'bad' })] }],
    ['type', { factors: [recoveryFactor({ type: 'sms' })] }],
    ['status', { factors: [recoveryFactor({ status: 'disabled' })] }],
    ['name type', { factors: [recoveryFactor({ friendlyName: 7 })] }],
    ['name empty', { factors: [recoveryFactor({ friendlyName: '' })] }],
    ['name long', { factors: [recoveryFactor({ friendlyName: 'x'.repeat(101) })] }],
    ['created', { factors: [recoveryFactor({ createdAt: 'bad' })] }],
    ['updated', { factors: [recoveryFactor({ updatedAt: 'bad' })] }],
    ['duplicate verified', { factors: [recoveryFactor(), recoveryFactor()] }],
  ], /invalid recovery/);
});

function recoveryCreate(overrides = {}) {
  return {
    case_id: ids.case,
    status: 'awaiting_external_verification',
    privileged_target: false,
    required_approvals: 1,
    approvals_recorded: 0,
    human_verification: {
      performed_by_newone: false,
      external_policy_required: true,
      evidence_reference_stored_as_hash: true,
    },
    expires_at: '2026-08-05T12:00:00.000Z',
    ...overrides,
  };
}

test('recovery creation, verification, approval, rejection, and masking execute every guard', () => {
  assert.equal(parseRecoveryCaseCreateReceipt({ data: recoveryCreate() }).requiredApprovals, 1);
  assert.equal(parseRecoveryCaseCreateReceipt(recoveryCreate({ privileged_target: true, required_approvals: 2 })).requiredApprovals, 2);
  assertThrowsEach(parseRecoveryCaseCreateReceipt, [
    ['null', null],
    ['extra', { ...recoveryCreate(), extra: true }],
    ['case', recoveryCreate({ case_id: 'bad' })],
    ['status', recoveryCreate({ status: 'pending' })],
    ['privileged', recoveryCreate({ privileged_target: 'no' })],
    ['required type', recoveryCreate({ required_approvals: 1.5 })],
    ['ordinary policy', recoveryCreate({ required_approvals: 2 })],
    ['privileged policy', recoveryCreate({ privileged_target: true })],
    ['approval count', recoveryCreate({ approvals_recorded: 1 })],
    ['policy object', recoveryCreate({ human_verification: null })],
    ['policy extra', recoveryCreate({ human_verification: { ...recoveryCreate().human_verification, extra: true } })],
    ['policy authority', recoveryCreate({ human_verification: { ...recoveryCreate().human_verification, performed_by_newone: true } })],
    ['policy required', recoveryCreate({ human_verification: { ...recoveryCreate().human_verification, external_policy_required: false } })],
    ['policy hash', recoveryCreate({ human_verification: { ...recoveryCreate().human_verification, evidence_reference_stored_as_hash: false } })],
    ['expiry', recoveryCreate({ expires_at: 'bad' })],
  ], /invalid recovery/);

  const verification = {
    case_id: ids.case,
    status: 'awaiting_approval',
    human_verification_recorded: true,
    required_approvals: 1,
    approvals_recorded: 0,
  };
  assert.equal(parseRecoveryVerificationReceipt(verification).requiredApprovals, 1);
  assert.equal(parseRecoveryVerificationReceipt({ ...verification, required_approvals: 2 }).requiredApprovals, 2);
  assertThrowsEach(parseRecoveryVerificationReceipt, [
    ['extra', { ...verification, extra: true }],
    ['required invalid', { ...verification, required_approvals: 0 }],
    ['status', { ...verification, status: 'approved' }],
    ['verified', { ...verification, human_verification_recorded: false }],
    ['count', { ...verification, approvals_recorded: 1 }],
    ['case', { ...verification, case_id: 'bad' }],
  ], /invalid recovery/);

  const ordinaryApproval = {
    case_id: ids.case,
    status: 'approved',
    approval_recorded: true,
    approvals_recorded: 1,
    required_approvals: 1,
    privileged_target: false,
  };
  assert.equal(parseRecoveryApprovalReceipt(ordinaryApproval).status, 'approved');
  const partialApproval = {
    ...ordinaryApproval,
    status: 'awaiting_approval',
    privileged_target: true,
    required_approvals: 2,
  };
  assert.equal(parseRecoveryApprovalReceipt(partialApproval).status, 'awaiting_approval');
  assertThrowsEach(parseRecoveryApprovalReceipt, [
    ['extra', { ...ordinaryApproval, extra: true }],
    ['status', { ...ordinaryApproval, status: 'pending' }],
    ['privileged', { ...ordinaryApproval, privileged_target: 'no' }],
    ['required', { ...ordinaryApproval, required_approvals: 2 }],
    ['overflow', { ...ordinaryApproval, approvals_recorded: 2 }],
    ['approved incomplete', { ...ordinaryApproval, approvals_recorded: 0 }],
    ['awaiting complete', { ...ordinaryApproval, status: 'awaiting_approval' }],
    ['result', { ...ordinaryApproval, approval_recorded: 'yes' }],
    ['case', { ...ordinaryApproval, case_id: 'bad' }],
  ], /invalid recovery/);

  assert.equal(parseRecoveryRejectionReceipt({ data: { case_id: ids.case, status: 'rejected' } }).status, 'rejected');
  assert.throws(() => parseRecoveryRejectionReceipt({ case_id: ids.case, status: 'rejected', extra: true }), /invalid recovery/);
  assert.throws(() => parseRecoveryRejectionReceipt({ case_id: ids.case, status: 'approved' }), /invalid recovery/);
  assert.throws(() => parseRecoveryRejectionReceipt({ case_id: 'bad', status: 'rejected' }), /invalid recovery/);
  assert.equal(maskedRecoveryCaseReference(ids.case.toUpperCase()), '••••000004');
  assert.throws(() => maskedRecoveryCaseReference('bad'), /invalid recovery/);
});

function recoveryExecution(overrides = {}) {
  return {
    case_id: ids.case,
    status: 'completed',
    completed: true,
    factor_deleted: true,
    all_sessions_revoked: true,
    captured_sessions: 3,
    auth_sessions_deleted_during_finalization: 2,
    session_bindings_revoked: 3,
    devices_revoked: 2,
    security_event_recorded: true,
    security_notice_id: 71,
    security_notice_state: 'pending_external_delivery',
    ...overrides,
  };
}

test('recovery execution receipts cover replay, numeric/string notice IDs, and every completion guarantee', () => {
  assert.equal(parseRecoveryExecutionReceipt(recoveryExecution()).alreadyCompleted, false);
  assert.equal(parseRecoveryExecutionReceipt(recoveryExecution({ security_notice_id: '9999999999999999999' })).securityNoticeState, 'pending_external_delivery');
  assert.deepEqual(parseRecoveryExecutionReceipt({
    data: { case_id: ids.case, status: 'completed', already_completed: true },
  }).alreadyCompleted, true);
  assert.throws(() => parseRecoveryExecutionReceipt({ case_id: ids.case, status: 'completed', already_completed: true, extra: true }), /invalid recovery/);
  assertThrowsEach(parseRecoveryExecutionReceipt, [
    ['null', null],
    ['extra', { ...recoveryExecution(), extra: true }],
    ['status', recoveryExecution({ status: 'executing' })],
    ['completed', recoveryExecution({ completed: false })],
    ['factor', recoveryExecution({ factor_deleted: false })],
    ['sessions', recoveryExecution({ all_sessions_revoked: false })],
    ['event', recoveryExecution({ security_event_recorded: false })],
    ['notice state', recoveryExecution({ security_notice_state: 'delivered' })],
    ['captured type', recoveryExecution({ captured_sessions: 1.5 })],
    ['captured low', recoveryExecution({ captured_sessions: -1 })],
    ['captured high', recoveryExecution({ captured_sessions: 1_000_001 })],
    ['deleted', recoveryExecution({ auth_sessions_deleted_during_finalization: -1 })],
    ['bindings', recoveryExecution({ session_bindings_revoked: -1 })],
    ['devices', recoveryExecution({ devices_revoked: -1 })],
    ['notice zero', recoveryExecution({ security_notice_id: 0 })],
    ['notice unsafe', recoveryExecution({ security_notice_id: Number.MAX_SAFE_INTEGER + 1 })],
    ['notice type', recoveryExecution({ security_notice_id: null })],
    ['notice string', recoveryExecution({ security_notice_id: '01' })],
    ['case', recoveryExecution({ case_id: 'bad' })],
  ], /invalid recovery/);
});

const searchCursor = `cursor.${'a'.repeat(64)}`;

function searchRequest(overrides = {}) {
  return {
    organizationId: ids.organization,
    query: '  pressure check  ',
    types: ['messages'],
    cursor: searchCursor,
    limit: 25,
    senderMembershipId: ids.user,
    dateFrom: '2026-08-01T00:00:00-06:00',
    dateTo: '2026-08-04T23:59:59-06:00',
    matchSources: ['original', 'translation'],
    conversationId: ids.conversation,
    language: 'ko',
    ...overrides,
  };
}

function searchResult(overrides = {}) {
  return {
    type: 'messages',
    id: '91',
    title: 'Coverage result',
    snippet: 'Scoped search result',
    conversationId: ids.conversation,
    occurredAt: '2026-08-04T12:00:00.000Z',
    matchedSource: 'translation',
    matchedLanguage: 'ko',
    ...overrides,
  };
}

test('search request normalization executes default, nullable, enum, date, and message-filter branches', () => {
  assert.equal(normalizeSearchRequest(searchRequest()).query, 'pressure check');
  assert.deepEqual(normalizeSearchRequest({
    organizationId: ids.organization,
    query: 'ok',
  }), {
    organizationId: ids.organization,
    query: 'ok',
    types: undefined,
    cursor: null,
    limit: 20,
    senderMembershipId: null,
    dateFrom: null,
    dateTo: null,
    matchSources: null,
    conversationId: null,
    language: null,
  });
  assert.equal(normalizeSearchRequest(searchRequest({
    cursor: null,
    senderMembershipId: null,
    dateFrom: null,
    dateTo: null,
    matchSources: null,
    conversationId: null,
    language: null,
  })).cursor, null);
  assert.deepEqual(normalizeSearchRequest(searchRequest({
    types: ['people', 'conversations', 'messages', 'announcements', 'handoffs'],
    senderMembershipId: null,
    matchSources: null,
  })).types, ['people', 'conversations', 'messages', 'announcements', 'handoffs']);
  for (const language of ['es', 'en', 'mixed', 'und']) {
    assert.equal(normalizeSearchRequest(searchRequest({ language })).language, language);
  }

  assertThrowsEach(normalizeSearchRequest, [
    ['null', null],
    ['array', []],
    ['extra', { ...searchRequest(), extra: true }],
    ['organization type', searchRequest({ organizationId: 7 })],
    ['organization syntax', searchRequest({ organizationId: 'bad' })],
    ['query type', searchRequest({ query: 7 })],
    ['query short', searchRequest({ query: ' x ' })],
    ['query long', searchRequest({ query: 'x'.repeat(201) })],
    ['query nul', searchRequest({ query: 'valid\u0000query' })],
    ['types type', searchRequest({ types: null })],
    ['types empty', searchRequest({ types: [] })],
    ['types count', searchRequest({ types: Array(6).fill('messages') })],
    ['type item type', searchRequest({ types: [7] })],
    ['type item enum', searchRequest({ types: ['unknown'] })],
    ['type duplicate', searchRequest({ types: ['messages', 'messages'] })],
    ['cursor type', searchRequest({ cursor: 7 })],
    ['cursor short', searchRequest({ cursor: 'x' })],
    ['cursor long', searchRequest({ cursor: `x.${'a'.repeat(2047)}` })],
    ['cursor pattern', searchRequest({ cursor: `${'bad cursor'}.${'a'.repeat(64)}` })],
    ['limit type', searchRequest({ limit: 1.5 })],
    ['limit low', searchRequest({ limit: 0 })],
    ['limit high', searchRequest({ limit: 51 })],
    ['sender', searchRequest({ senderMembershipId: 'bad' })],
    ['start type', searchRequest({ dateFrom: 7 })],
    ['start short', searchRequest({ dateFrom: 'bad' })],
    ['start syntax', searchRequest({ dateFrom: '2026-08-99T00:00:00Z' })],
    ['end syntax', searchRequest({ dateTo: 'bad' })],
    ['sources type', searchRequest({ matchSources: 'original' })],
    ['sources empty', searchRequest({ matchSources: [] })],
    ['source type', searchRequest({ matchSources: [7] })],
    ['source enum', searchRequest({ matchSources: ['profile'] })],
    ['source duplicate', searchRequest({ matchSources: ['original', 'original'] })],
    ['conversation', searchRequest({ conversationId: 'bad' })],
    ['language type', searchRequest({ language: 7 })],
    ['language enum', searchRequest({ language: 'fr' })],
    ['date reverse', searchRequest({ dateFrom: '2026-08-05T00:00:00Z', dateTo: '2026-08-04T00:00:00Z' })],
    ['date span', searchRequest({ dateFrom: '2010-01-01T00:00:00Z', dateTo: '2026-08-04T00:00:00Z' })],
    ['sender without messages', searchRequest({ types: ['people'], matchSources: null })],
    ['sources without messages', searchRequest({ types: ['people'], senderMembershipId: null })],
    ['message filters no types', searchRequest({ types: undefined })],
  ], /Invalid|require/);
});

test('search page parser covers every result type, source binding, ordering, and continuation guard', () => {
  const eachType = [
    searchResult({
      type: 'people',
      id: ids.user,
      conversationId: null,
      matchedSource: 'profile',
      matchedLanguage: null,
      occurredAt: '2026-08-04T12:04:00Z',
    }),
    searchResult({
      type: 'conversations',
      id: ids.organization,
      matchedSource: 'conversation',
      matchedLanguage: null,
      occurredAt: '2026-08-04T12:03:00Z',
    }),
    searchResult({
      matchedSource: 'original',
      matchedLanguage: null,
      occurredAt: '2026-08-04T12:02:00Z',
    }),
    searchResult({
      type: 'announcements',
      id: ids.case,
      matchedSource: 'announcement',
      matchedLanguage: '  en-US  ',
      occurredAt: '2026-08-04T12:01:00Z',
    }),
    searchResult({
      type: 'handoffs',
      id: ids.factor,
      matchedSource: 'handoff',
      matchedLanguage: null,
      occurredAt: '2026-08-04T12:00:00Z',
    }),
  ];
  const parsed = parseSearchPage({ results: eachType, nextCursor: null, hasMore: false }, 5);
  assert.equal(parsed.results.length, 5);
  assert.equal(parsed.results[3].matchedLanguage, 'en-US');
  assert.equal(parseSearchPage({ results: [], nextCursor: searchCursor, hasMore: true }).nextCursor, searchCursor);

  assertThrowsEach((value) => parseSearchPage(value, 20), [
    ['page null', null],
    ['page array', []],
    ['page extra', { results: [], nextCursor: null, hasMore: false, extra: true }],
    ['results type', { results: null, nextCursor: null, hasMore: false }],
    ['results count', { results: Array(21).fill(searchResult()), nextCursor: null, hasMore: false }],
    ['result object', { results: [null], nextCursor: null, hasMore: false }],
    ['result extra', { results: [{ ...searchResult(), extra: true }], nextCursor: null, hasMore: false }],
    ['type type', { results: [searchResult({ type: 7 })], nextCursor: null, hasMore: false }],
    ['type enum', { results: [searchResult({ type: 'files' })], nextCursor: null, hasMore: false }],
    ['source type', { results: [searchResult({ matchedSource: 7 })], nextCursor: null, hasMore: false }],
    ['source binding', { results: [searchResult({ matchedSource: 'profile' })], nextCursor: null, hasMore: false }],
    ['message id type', { results: [searchResult({ id: 7 })], nextCursor: null, hasMore: false }],
    ['message id zero', { results: [searchResult({ id: '0' })], nextCursor: null, hasMore: false }],
    ['message id long', { results: [searchResult({ id: '1'.repeat(20) })], nextCursor: null, hasMore: false }],
    ['uuid result', { results: [searchResult({ type: 'handoffs', id: 'bad', matchedSource: 'handoff', matchedLanguage: null })], nextCursor: null, hasMore: false }],
    ['conversation id', { results: [searchResult({ conversationId: 'bad' })], nextCursor: null, hasMore: false }],
    ['people conversation', { results: [searchResult({ type: 'people', id: ids.user, matchedSource: 'profile' })], nextCursor: null, hasMore: false }],
    ['message no conversation', { results: [searchResult({ conversationId: null })], nextCursor: null, hasMore: false }],
    ['language type', { results: [searchResult({ matchedLanguage: 7 })], nextCursor: null, hasMore: false }],
    ['language short', { results: [searchResult({ matchedLanguage: 'x' })], nextCursor: null, hasMore: false }],
    ['language long', { results: [searchResult({ matchedLanguage: 'x'.repeat(36) })], nextCursor: null, hasMore: false }],
    ['translation language', { results: [searchResult({ matchedLanguage: null })], nextCursor: null, hasMore: false }],
    ['title type', { results: [searchResult({ title: 7 })], nextCursor: null, hasMore: false }],
    ['title empty', { results: [searchResult({ title: '' })], nextCursor: null, hasMore: false }],
    ['title long', { results: [searchResult({ title: 'x'.repeat(501) })], nextCursor: null, hasMore: false }],
    ['snippet type', { results: [searchResult({ snippet: 7 })], nextCursor: null, hasMore: false }],
    ['snippet long', { results: [searchResult({ snippet: 'x'.repeat(241) })], nextCursor: null, hasMore: false }],
    ['result time', { results: [searchResult({ occurredAt: 'bad' })], nextCursor: null, hasMore: false }],
    ['duplicate', { results: [searchResult(), searchResult()], nextCursor: null, hasMore: false }],
    ['time order', { results: [searchResult({ id: '90', occurredAt: '2026-08-04T11:00:00Z' }), searchResult()], nextCursor: null, hasMore: false }],
    ['type order', { results: [searchResult({ type: 'announcements', id: ids.case, matchedSource: 'announcement', matchedLanguage: null }), searchResult({ id: '90', matchedSource: 'original', matchedLanguage: null })], nextCursor: null, hasMore: false }],
    ['id order', { results: [searchResult({ id: '90', matchedSource: 'original', matchedLanguage: null }), searchResult({ id: '91', matchedSource: 'original', matchedLanguage: null })], nextCursor: null, hasMore: false }],
    ['has more type', { results: [], nextCursor: null, hasMore: 'no' }],
    ['cursor syntax', { results: [], nextCursor: 'bad', hasMore: true }],
    ['continuation missing', { results: [], nextCursor: null, hasMore: true }],
    ['continuation extra', { results: [], nextCursor: searchCursor, hasMore: false }],
  ], /Invalid|Duplicate|Unstable|require/);
  assert.throws(() => parseSearchPage({ results: [], nextCursor: null, hasMore: false }, 1.5), /limit/);
  assert.throws(() => parseSearchPage({ results: [], nextCursor: null, hasMore: false }, 0), /limit/);
  assert.throws(() => parseSearchPage({ results: [], nextCursor: null, hasMore: false }, 51), /limit/);
});

test('search merge and calendar boundaries execute malformed, overlap, start, end, and rollover paths', () => {
  assert.throws(() => mergeSearchResults(null, []), /Invalid/);
  assert.throws(() => mergeSearchResults([], null), /Invalid/);
  const first = searchResult();
  const second = searchResult({ id: '90' });
  assert.deepEqual(mergeSearchResults([first], [{ ...first, snippet: 'duplicate' }, second]), [first, second]);

  assert.equal(searchDateBoundary('', 'start'), null);
  const start = searchDateBoundary('2026-08-04', 'start');
  const end = searchDateBoundary('2026-08-04', 'end');
  assert.ok(Date.parse(end) > Date.parse(start));
  assert.throws(() => searchDateBoundary(7, 'start'), /calendar/);
  assert.throws(() => searchDateBoundary('08/04/2026', 'start'), /calendar/);
  assert.throws(() => searchDateBoundary('2026-08-04', 'middle'), /boundary/);
  assert.throws(() => searchDateBoundary('2026-02-30', 'start'), /calendar/);
  assert.throws(() => searchDateBoundary('2026-13-01', 'end'), /calendar/);
});
