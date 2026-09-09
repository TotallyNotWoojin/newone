import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { PERSONAL_REALM_ORGANIZATION_ID } from '@/constants/personal-realm';
import { RepositoryError } from '@/data/repositories/contracts';
import { WebReadRepository } from '@/data/repositories/web-read-repository';

const mockFetch = jest.fn<typeof fetch>();
let mockApiBase: string | null = 'https://api.newone.test';
let mockSession: { access_token: string } | null = { access_token: 'controlled-access-token' };

jest.mock('@/config/runtime', () => ({
  apiUrlFor: (path: string) => mockApiBase ? `${mockApiBase}${path}` : null,
  nativeEdgeRequestHeaders: (token?: string | null) => token
    ? { Authorization: `Bearer ${token}`, apikey: 'controlled-publishable-key' }
    : null,
}));

jest.mock('@/lib/web-auth', () => ({
  getWebCsrfToken: () => 'controlled-csrf-token',
}));

const organizationId = '10000000-0000-4000-8000-000000000001';
const currentUserId = '20000000-0000-4000-8000-000000000002';
const colleagueId = '30000000-0000-4000-8000-000000000003';
const conversationId = '40000000-0000-4000-8000-000000000004';
const directConversationId = '50000000-0000-4000-8000-000000000005';
const discoverableId = '60000000-0000-4000-8000-000000000006';
const now = '2026-08-04T18:00:00.000Z';

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function repository() {
  return new WebReadRepository({ getSession: async () => mockSession as any });
}

function aggregateReceipt() {
  return {
    scope: 'aggregate',
    recipientCount: 2,
    deliveredCount: 2,
    visibleReadCount: 1,
    visibleReadEligibleCount: 1,
    delivered: true,
    deliveredAt: now,
    read: true,
    readAt: now,
  };
}

function selfReceipt(read = false) {
  return {
    scope: 'self',
    delivered: true,
    deliveredAt: now,
    read,
    readAt: read ? now : null,
  };
}

function translatedMessage(messageId = '101') {
  return {
    messageId,
    conversationId,
    kind: 'text',
    sender: { userId: currentUserId, displayName: 'Jordan Lee' },
    senderUserId: currentUserId,
    clientNonce: `client-${messageId}`,
    body: 'Lock the north gate at 18:00.',
    clientLanguageHint: 'en',
    languageCode: 'en',
    languageDetectionState: 'completed',
    detectedLanguage: 'en',
    languageDetectionMethod: 'server-detector',
    languageDetectionConfidence: 0.97,
    languageDetectedAt: now,
    translations: [{
      translationId: '701',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      sourceBodySha256: 'a'.repeat(64),
      status: 'completed',
      translatedBody: 'Cierre la puerta norte a las 18:00.',
      provider: 'openrouter',
      model: 'qwen/tested-model',
      confidence: 0.95,
      policyVersion: 4,
      reviewedByUserId: colleagueId,
      reviewedAt: now,
      failureCode: null,
      createdAt: now,
      updatedAt: now,
      latestCorrection: {
        correctionId: '801',
        status: 'approved',
        correctedBody: 'Cierre la entrada norte a las 18:00.',
        rationale: 'Approved site terminology',
        proposedByUserId: currentUserId,
        reviewedByUserId: colleagueId,
        reviewedAt: now,
        reviewNote: 'Verified',
        createdAt: now,
        updatedAt: now,
      },
    }],
    systemEvent: null,
    forward: {
      forwarded: true,
      sourceConversationId: directConversationId,
      sourceMessageId: '88',
    },
    reply: { senderUserId: colleagueId, body: 'Please confirm.' },
    attachments: [{
      attachmentId: 'attachment-a',
      mimeType: 'image/jpeg',
      scanStatus: 'clean',
      byteSize: 2048,
      fileName: 'gate.jpg',
    }],
    receipt: aggregateReceipt(),
    mentions: [colleagueId],
    reactions: [
      { emoji: '✅', userId: currentUserId },
      { emoji: '✅', userId: colleagueId },
      { emoji: null, userId: colleagueId },
    ],
    createdAt: now,
    priority: 'important',
    editedAt: now,
    pinned: true,
  };
}

function incomingMessage(messageId = '102') {
  return {
    messageId,
    conversationId,
    kind: 'text',
    sender: { userId: colleagueId, displayName: 'Ana Torres' },
    senderUserId: colleagueId,
    body: 'La válvula necesita revisión.',
    clientLanguageHint: 'es',
    languageCode: 'es',
    languageDetectionState: 'ambiguous',
    detectedLanguage: 'mixed',
    languageDetectionMethod: 'server-detector',
    languageDetectionConfidence: 0.51,
    languageDetectedAt: now,
    translations: [],
    systemEvent: null,
    forward: {},
    reply: {},
    attachments: [{
      attachmentId: 'attachment-b',
      mimeType: 'application/pdf',
      scanStatus: 'pending',
      byteSize: 512,
      fileName: 'procedure.pdf',
    }],
    receipt: selfReceipt(false),
    mentions: [],
    reactions: [],
    createdAt: now,
    priority: 'safety',
    editedAt: null,
    pinned: false,
  };
}

function systemMessage(messageId = '103') {
  return {
    messageId,
    conversationId,
    kind: 'system',
    sender: { userId: colleagueId, displayName: 'Ana Torres' },
    senderUserId: colleagueId,
    body: null,
    clientLanguageHint: 'en',
    languageCode: 'en',
    languageDetectionState: 'not_applicable',
    detectedLanguage: null,
    languageDetectionMethod: null,
    languageDetectionConfidence: null,
    languageDetectedAt: now,
    translations: [],
    systemEvent: { eventType: 'conversation.member.added', targetUserId: currentUserId },
    forward: {},
    reply: {},
    attachments: [],
    receipt: selfReceipt(true),
    mentions: [],
    reactions: [],
    createdAt: now,
    priority: 'normal',
    editedAt: null,
    pinned: false,
  };
}

function bootstrapPayload() {
  return {
    schemaVersion: 1,
    organization: {
      organizationId,
      name: 'Controlled Company',
      conversationControlsVersion: 3,
      messageRetentionDays: 365,
      allowMemberDirectMessages: true,
      dmPolicy: 'request_first',
      requireMfaForAdmins: true,
      shiftScheduleAuthoritative: true,
      groupCreationPolicy: 'managers',
      allowExternalGuests: false,
      externalGuestMaxAccessDays: 30,
      organizationPolicyVersion: 7,
    },
    units: [
      { unitId: 'site-a', parentUnitId: null, kind: 'site', name: 'Denver Plant' },
      { unitId: 'department-a', parentUnitId: 'site-a', kind: 'department', name: 'Operations' },
    ],
    connections: [{ counterpartUserId: colleagueId, status: 'accepted', requestedByUserId: currentUserId }],
    savedContacts: [{ contactUserId: colleagueId, alias: 'Ana T', isFavorite: true }],
    memberBlocks: [],
    currentUser: {
      userId: currentUserId,
      displayName: 'Jordan Lee',
      jobTitle: 'Shift Supervisor',
      membershipRole: 'owner',
      preferredLanguage: 'en-US',
      membershipStatus: 'active',
      unitIds: ['site-a', 'department-a'],
      membershipType: 'employee',
      accessExpiresAt: null,
      guestSponsorUserId: null,
    },
    directory: [
      {
        userId: currentUserId,
        displayName: 'Jordan Lee',
        jobTitle: 'Shift Supervisor',
        membershipRole: 'owner',
        preferredLanguage: 'en-US',
        membershipStatus: 'active',
        unitIds: ['site-a', 'department-a'],
      },
      {
        userId: colleagueId,
        displayName: 'Ana Torres',
        jobTitle: 'Operator',
        membershipRole: 'member',
        preferredLanguage: 'es-MX',
        membershipStatus: 'active',
        unitIds: ['site-a', 'department-a'],
        isSavedContact: true,
      },
    ],
    preferences: { messageLanguage: 'es-MX' },
    conversations: [
      {
        conversationId,
        kind: 'group',
        name: 'Plant Operations',
        avatarPath: `${organizationId}/${conversationId}/avatars/avatar-a`,
        description: 'Live operations',
        members: [
          { userId: currentUserId, displayName: 'Jordan Lee', role: 'owner', avatarPath: null, canPost: true },
          { userId: colleagueId, displayName: 'Ana Torres', role: 'admin', avatarPath: null, canPost: true },
        ],
        memberCount: 2,
        memberRole: 'owner',
        preferences: {
          isPinned: true,
          isFavorite: true,
          notificationLevel: 'mentions',
          mutedUntil: null,
          translationMode: 'automatic',
        },
        preview: { body: 'Latest operations update', createdAt: now },
        updatedAt: now,
        unreadCount: 2,
        lastReadMessageId: '100',
        isArchived: false,
        canManage: true,
        canManageConversation: true,
        canManageDynamicGroup: false,
        policyManaged: false,
        managementOnly: false,
        departure: {
          eligible: true,
          restriction: null,
          requiresOwnershipTransfer: true,
          historyPreserved: true,
          futureAccessRevoked: true,
        },
        historyPolicy: 'all',
        historyDisclosure: { policy: 'all', visibleFrom: null, labelKey: 'conversation.history.all' },
        postingMode: 'all_members',
        configuredJoinPolicy: 'approval_required',
        joinPolicy: 'approval_required',
        visibility: 'organization',
        canPost: true,
      },
      {
        conversationId: directConversationId,
        kind: 'direct',
        directCounterpartUserId: colleagueId,
        members: [],
        memberCount: 2,
        preferences: { notificationLevel: 'all', translationMode: 'automatic' },
        preview: {},
        updatedAt: now,
        unreadCount: 0,
        departure: {},
        historyDisclosure: {},
        postingMode: 'all_members',
        configuredJoinPolicy: 'inherit',
        joinPolicy: 'invite_only',
        visibility: 'invite_only',
        canPost: true,
      },
    ],
    selectedConversationId: conversationId,
    timeline: {
      messages: [translatedMessage(), incomingMessage(), systemMessage()],
      nextBeforeMessageId: '101',
    },
    updates: [{
      announcementId: 'announcement-a',
      announcementVersionId: 'announcement-version-a',
      versionNumber: 2,
      title: 'Safety Update',
      body: 'Inspect all valves.',
      translatedBody: 'Inspeccione todas las válvulas.',
      createdByUserId: colleagueId,
      audienceLabel: 'Denver Plant',
      publishedAt: now,
      priority: 'important',
      requiresAcknowledgement: true,
      acknowledgedAt: now,
      acknowledgedCount: 1,
      recipientCount: 2,
      expiresAt: '2026-08-05T18:00:00.000Z',
      status: 'published',
      scheduledAt: null,
      notificationClass: 'urgent',
      acknowledgementSchema: {
        attestationRequired: true,
        attestationPrompt: 'I confirm I read this.',
        requiredKeys: ['confirmed'],
        carryForwardOnCorrection: false,
      },
      reminderPolicy: {
        enabled: true,
        deadlineAt: '2026-08-05T18:00:00.000Z',
        intervalSeconds: 3600,
        maximumReminders: 3,
        escalateAfterSeconds: 7200,
      },
      reminderState: 'pending',
      escalationState: 'pending',
      deliveredAt: now,
      readAt: now,
    }],
    handoffs: [{
      handoffId: 'handoff-a',
      conversationId,
      handoffVersionId: 'handoff-version-a',
      versionNumber: 1,
      sourceLanguage: 'en-US',
      title: 'Shift Handoff',
      authorUserId: currentUserId,
      shiftStartedAt: now,
      shiftEndedAt: '2026-08-04T20:00:00.000Z',
      status: 'draft',
      details: 'Valve inspection remains open.',
      openItems: 1,
      sourceMessageIds: ['101', '102'],
      sourceFingerprint: 'b'.repeat(64),
      sourceState: 'current',
      acknowledgementDueAt: '2026-08-04T21:00:00.000Z',
      overdue: false,
      reminderState: 'not_due',
      reminderCount: 0,
      lastRemindedAt: null,
      escalationState: 'not_due',
      escalatedAt: null,
      correctionOfVersionId: null,
      correctionReason: null,
      acknowledgedAt: null,
    }],
    summaries: [{
      summaryId: 'summary-a',
      conversationId,
      versionNumber: 1,
      languageCode: 'en-US',
      status: 'draft',
      primaryTopic: 'Gate safety (s0001)',
      summaryBody: 'Secure the gate [sources:s0001,s0002] and inspect the valve.',
      keyTopics: ['Gate [sources:s0001]', 'Valve', 's0002'],
      decisions: [{ text: 'Lock gate (s0001)', sourceMessageIds: ['101'] }],
      actionItems: [{ text: 'Inspect valve [sources:s0002]', owner: 'Ana', due: '18:30', sourceMessageIds: ['102'] }],
      ambiguities: ['Valve number [sources:s0001,s0002]'],
      sourceMessageIds: ['101', '102'],
      sourceFirstMessageId: '101',
      sourceLastMessageId: '102',
      sourceFingerprint: 'c'.repeat(64),
      outputFingerprint: 'd'.repeat(64),
      scopeKind: 'last_7_days',
      scopeSubject: 'the trip',
      sourceMessageCount: 143,
      sourceState: 'current',
      policyState: 'current',
      requestMode: 'manual',
      requestedByUserId: currentUserId,
      correctionOfSummaryId: null,
      processorProvenance: {
        organizationAiPolicyVersion: 4,
        routePolicyVersion: 'route-1',
        providerRoute: 'openrouter',
      },
      processorType: 'ai',
      provider: 'openrouter',
      model: 'qwen/tested-model',
      failureCode: null,
      reviewedByUserId: null,
      reviewedAt: null,
      reviewNote: null,
      createdAt: now,
      updatedAt: now,
    }],
    actions: [{
      actionId: 'action-a',
      conversationId,
      sourceMessageId: '102',
      title: 'Inspect valve',
      details: 'Use procedure 7.',
      status: 'confirmed',
      proposedByUserId: currentUserId,
      assigneeUserId: colleagueId,
      dueAt: '2026-08-04T19:00:00.000Z',
      createdAt: now,
      updatedAt: now,
    }],
    moderationReports: [{
      reportId: 'report-a',
      conversationId,
      messageId: '102',
      category: 'privacy',
      status: 'assigned',
      reportedAt: now,
      assignedToMe: true,
      reporterLabel: 'Protected reporter',
      safeExcerpt: 'Scoped excerpt',
    }],
    auditEvents: [{
      auditEventId: 'audit-a',
      operation: 'message.sent',
      entityType: 'message',
      entityId: '101',
      actorLabel: 'Jordan Lee',
      occurredAt: now,
      outcome: 'succeeded',
    }],
    capabilities: ['communications.publish', 'audit.read', 'invalid.capability'],
    scopes: [{
      assignmentId: 'assignment-a',
      roleName: 'communications_publisher',
      scopeType: 'organization',
      unitId: null,
      permissions: ['communications.publish'],
      expiresAt: null,
    }],
    discoverableConversations: [{
      conversationId: discoverableId,
      kind: 'group',
      name: 'Safety Committee',
      description: 'Open safety coordination',
      avatarPath: null,
      visibility: 'organization',
      postingMode: 'admins_only',
      joinPolicy: 'approval_required',
      memberCount: 8,
      historyDisclosure: {
        policy: 'since_join',
        visibleFrom: now,
        labelKey: 'conversation.history.since_join',
      },
      myJoinRequest: {
        requestId: 'join-a',
        status: 'pending',
        version: 1,
        requestedAt: now,
        expiresAt: '2026-08-05T18:00:00.000Z',
        decidedAt: null,
      },
    }],
  };
}

function translationVariant(
  translationId: string,
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'blocked',
  overrides: Record<string, unknown> = {},
) {
  const completed = status === 'completed';
  const failed = status === 'failed' || status === 'blocked';
  return {
    translationId,
    sourceLanguage: 'en',
    targetLanguage: 'es',
    sourceBodySha256: 'f'.repeat(64),
    status,
    translatedBody: completed ? `Completed translation ${translationId}` : null,
    provider: completed ? 'controlled-provider' : null,
    model: completed ? 'controlled-model' : null,
    confidence: completed ? 0.8 : null,
    policyVersion: null,
    reviewedByUserId: null,
    reviewedAt: null,
    failureCode: failed ? 'controlled_failure' : null,
    createdAt: now,
    updatedAt: now,
    latestCorrection: null,
    ...overrides,
  };
}

function summaryVariant(
  summaryId: string,
  status: 'queued' | 'processing' | 'draft' | 'approved' | 'failed' | 'stale',
  overrides: Record<string, unknown> = {},
) {
  const ready = status === 'draft' || status === 'approved';
  const failed = status === 'failed' || status === 'stale';
  return {
    summaryId,
    conversationId,
    versionNumber: 1,
    languageCode: 'es-MX',
    status,
    primaryTopic: ready ? `Topic ${summaryId}` : null,
    summaryBody: ready ? `Summary ${summaryId}` : null,
    keyTopics: ready ? ['Controlled topic'] : null,
    decisions: ready ? [{ text: 'Controlled decision', sourceMessageIds: ['101'] }] : null,
    actionItems: ready ? [{ text: 'Controlled action', owner: null, dueAt: null, sourceMessageIds: ['101'] }] : null,
    ambiguities: ready ? [] : null,
    sourceMessageIds: ['101'],
    sourceFirstMessageId: '101',
    sourceLastMessageId: '101',
    sourceFingerprint: '1'.repeat(64),
    outputFingerprint: ready ? '2'.repeat(64) : null,
    sourceState: status === 'stale' ? 'stale' : 'current',
    policyState: 'unknown',
    requestMode: 'manual_fallback',
    requestedByUserId: currentUserId,
    correctionOfSummaryId: null,
    processorProvenance: {},
    processorType: null,
    provider: null,
    model: null,
    failureCode: failed ? 'controlled_failure' : null,
    reviewedByUserId: status === 'approved' ? colleagueId : null,
    reviewedAt: status === 'approved' ? now : null,
    reviewNote: status === 'approved' ? 'Controlled approval' : null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function alternateBootstrapPayload() {
  const payload: any = bootstrapPayload();
  payload.organization.name = 123;
  payload.organization.conversationControlsVersion = '4';
  payload.connections = [];
  payload.savedContacts = [];
  payload.memberBlocks = [{ blockedUserId: 'user-blocked' }];
  payload.preferences = {};
  payload.currentUser.unitIds = undefined;
  payload.currentUser.preferredLanguage = 'es-MX';
  payload.directory = [
    {
      userId: 'user-manager', displayName: 'Manager Person', jobTitle: null,
      membershipRole: 'manager', preferredLanguage: null, membershipStatus: 'suspended',
      unitIds: [], connection: { status: 'pending', requestedByUserId: currentUserId },
      isBlocked: true,
    },
    {
      userId: 'user-supervisor', displayName: 'Supervisor Person', jobTitle: 'Supervisor',
      membershipRole: 'supervisor', preferredLanguage: 'ko-KR', membershipStatus: 'active',
      unitIds: ['site-a'], connection: { status: 'pending', requestedByUserId: colleagueId },
    },
    {
      userId: 'user-available', displayName: '  ', membershipRole: 'member',
      preferredLanguage: 'en', membershipStatus: 'active', unitIds: ['missing-unit'],
    },
  ];

  const pendingMessage = incomingMessage('201') as any;
  Object.assign(pendingMessage, {
    clientNonce: null,
    body: null,
    languageDetectionState: 'pending',
    detectedLanguage: null,
    languageDetectionMethod: null,
    languageDetectionConfidence: null,
    languageDetectedAt: null,
    translations: [translationVariant('901', 'queued')],
    receipt: { scope: 'self', delivered: false, deliveredAt: null, read: false, readAt: null },
    priority: 'normal',
  });
  const failedDetectionMessage = incomingMessage('202') as any;
  Object.assign(failedDetectionMessage, {
    languageDetectionState: 'failed', detectedLanguage: null,
    languageDetectionMethod: 'controlled-detector', languageDetectionConfidence: null,
    translations: [translationVariant('902', 'processing')],
    reply: { senderUserId: 'unknown-person', body: null },
  });
  const pendingCorrectionMessage = incomingMessage('203') as any;
  pendingCorrectionMessage.translations = [translationVariant('903', 'completed', {
    latestCorrection: {
      correctionId: 'correction-pending', status: 'pending',
      correctedBody: 'Pending controlled correction.', rationale: null,
      proposedByUserId: currentUserId, reviewedByUserId: null, reviewedAt: null,
      reviewNote: null, createdAt: now, updatedAt: now,
    },
  })];
  const reviewedMessage = incomingMessage('204') as any;
  reviewedMessage.translations = [translationVariant('904', 'completed', {
    reviewedByUserId: colleagueId, reviewedAt: now,
    latestCorrection: {
      correctionId: 'correction-rejected', status: 'rejected',
      correctedBody: 'Rejected controlled correction.', rationale: 'Controlled rationale',
      proposedByUserId: currentUserId, reviewedByUserId: colleagueId, reviewedAt: now,
      reviewNote: 'Controlled rejection', createdAt: now, updatedAt: now,
    },
  })];
  const failedTranslationMessage = incomingMessage('205') as any;
  failedTranslationMessage.translations = [translationVariant('905', 'failed')];
  const blockedTranslationMessage = incomingMessage('206') as any;
  blockedTranslationMessage.translations = [translationVariant('906', 'blocked')];
  blockedTranslationMessage.attachments = [{
    attachmentId: 'attachment-voice', mimeType: 'audio/m4a', scanStatus: 'quarantined',
    byteSize: 2 * 1024 * 1024, fileName: null,
  }];
  const createdSystemMessage = systemMessage('207') as any;
  createdSystemMessage.systemEvent = { eventType: 'conversation.created', targetUserId: null };
  // Defect P: the service strips null fields, so a target-less event arrives
  // without the targetUserId key; it must parse as null, not sink the bootstrap.
  const avatarSystemMessage = systemMessage('208') as any;
  avatarSystemMessage.systemEvent = { eventType: 'conversation.avatar.changed' };
  payload.timeline = {
    messages: [
      pendingMessage,
      failedDetectionMessage,
      pendingCorrectionMessage,
      reviewedMessage,
      failedTranslationMessage,
      blockedTranslationMessage,
      createdSystemMessage,
      avatarSystemMessage,
    ],
    nextBeforeMessageId: 201,
  };

  payload.conversations = [{
    conversationId: 'conversation-managed',
    kind: 'incident',
    name: null,
    description: null,
    avatarPath: null,
    members: [{
      userId: 'user-manager', displayName: 'Manager Person', role: 'member',
      avatarPath: 'avatar/manager', canPost: false,
    }],
    memberCount: 'bad-count',
    memberRole: 'member',
    preferences: {
      isPinned: false, isFavorite: false, notificationLevel: 'none',
      mutedUntil: '2999-01-01T00:00:00.000Z', translationMode: 'off',
    },
    preview: {},
    updatedAt: 'not-a-date',
    unreadCount: 'bad-count',
    lastReadMessageId: 77,
    isArchived: true,
    canManage: false,
    canManageConversation: false,
    canManageDynamicGroup: true,
    policyManaged: true,
    managementOnly: true,
    departure: {
      eligible: false,
      restriction: 'policy_managed',
      requiresOwnershipTransfer: false,
      historyPreserved: true,
      futureAccessRevoked: true,
    },
    historyPolicy: 'since_join',
    historyDisclosure: {
      policy: 'since_join', visibleFrom: now, labelKey: 'conversation.history.since_join',
    },
    incidentSeverity: 'critical',
    incidentClassification: 'controlled-incident',
    closedAt: now,
    closedByUserId: currentUserId,
    closureReason: 'Controlled close',
    isReadOnly: true,
    postingMode: 'admins_only',
    configuredJoinPolicy: 'invite_only',
    joinPolicy: 'approval_required',
    visibility: 'unit',
    canPost: false,
  }, {
    conversationId: 'conversation-fallback',
    kind: 'unsupported-kind',
    members: [],
    preferences: {},
    preview: {},
    isArchived: true,
    departure: {},
    historyDisclosure: {},
  }];
  payload.selectedConversationId = 'conversation-managed';

  payload.updates = [{
    announcementId: 'announcement-emergency', announcementVersionId: 'version-emergency',
    versionNumber: 'bad', title: 'Emergency notice', body: null, createdByUserId: null,
    audienceLabel: null, publishedAt: 'not-a-date', priority: 'emergency',
    requiresAcknowledgement: false, acknowledgedAt: null, acknowledgedCount: 'bad',
    recipientCount: null, expiresAt: null, status: 'unsupported', notificationClass: 'unsupported',
    acknowledgementSchema: {}, reminderPolicy: {}, reminderState: 'unsupported',
    escalationState: 'unsupported', deliveredAt: null, readAt: null,
  }, {
    announcementId: 'announcement-standard', announcementVersionId: 'version-standard',
    versionNumber: 1, title: 'Standard notice', body: 'Controlled notice', priority: 'normal',
    requiresAcknowledgement: false, acknowledgementSchema: {},
    reminderPolicy: {
      enabled: false, deadlineAt: null, intervalSeconds: null, maximumReminders: 0,
      escalateAfterSeconds: null,
    },
  }];

  const handoffBase = {
    conversationId: 'conversation-managed', versionNumber: 1, sourceLanguage: 'ko-KR',
    title: 'Controlled handoff', shiftStartedAt: now,
    shiftEndedAt: '2026-08-04T20:00:00.000Z', details: null, openItems: 'bad',
    sourceMessageIds: [], sourceCount: 3, sourceFingerprint: null,
    acknowledgementDueAt: null, overdue: true, reminderCount: -2,
    lastRemindedAt: null, escalatedAt: null, correctionOfVersionId: null,
    correctionReason: null,
  };
  payload.handoffs = [{
    ...handoffBase, handoffId: 'handoff-submitted', handoffVersionId: 'hv-submitted',
    authorUserId: colleagueId, status: 'submitted', acknowledgedAt: null,
    sourceState: 'stale', staleReason: 'source_edited_or_deleted',
    reminderState: 'due', escalationState: 'due',
  }, {
    ...handoffBase, handoffId: 'handoff-closed', handoffVersionId: 'hv-closed',
    authorUserId: 'unknown-author', status: 'closed', acknowledgedAt: now,
    sourceState: 'current', reminderState: 'sent', escalationState: 'escalated',
  }, {
    ...handoffBase, handoffId: 'handoff-awaiting', handoffVersionId: 'hv-awaiting',
    authorUserId: 'unknown-author', status: 'other', acknowledgedAt: null,
    sourceState: 'current', reminderState: 'unsupported', escalationState: 'unsupported',
  }];

  payload.summaries = [
    summaryVariant('summary-queued', 'queued'),
    summaryVariant('summary-processing', 'processing'),
    summaryVariant('summary-corrected', 'draft', {
      correctionOfSummaryId: 'summary-original', requestMode: 'correction',
    }),
    summaryVariant('summary-approved', 'approved', { policyState: 'current' }),
    summaryVariant('summary-failed', 'failed'),
    summaryVariant('summary-stale', 'stale'),
  ];
  payload.actions = [{
    actionId: 'action-fallback', conversationId: 'conversation-managed', sourceMessageId: null,
    title: 'Unassigned action', details: null, status: 'unsupported',
    proposedByUserId: currentUserId, assigneeUserId: null, dueAt: null, createdAt: now,
  }];
  payload.moderationReports = [{
    id: 'report-fallback', conversationId: 'conversation-managed', messageId: '201',
    category: 'unsupported', status: 'unsupported', createdAt: now,
    assignedToMe: false, reporterLabel: null, safeExcerpt: null,
  }];
  payload.auditEvents = [{
    id: 'audit-denied', operation: 'controlled.denied', entityType: 'message', entityId: null,
    actorLabel: null, createdAt: now, outcome: 'denied',
  }, {
    id: 'audit-failed', operation: 'controlled.failed', entityType: 'message', entityId: null,
    actorLabel: null, createdAt: now, outcome: 'failed',
  }];
  payload.scopes = [
    { roleName: 'unsupported', scopeType: 'organization' },
    { roleName: 'employee', scopeType: 'unsupported' },
    {
      assignmentId: 'assignment-unit', roleName: 'site_admin', scopeType: 'unit',
      unitId: 'site-a', permissions: [], expiresAt: now,
    },
  ];
  payload.discoverableConversations = [{
    conversationId: 'discoverable-team', kind: 'team', name: 'Controlled team',
    description: null, avatarPath: 'avatar/team', visibility: 'unit',
    postingMode: 'all_members', joinPolicy: 'approval_required', memberCount: 'bad',
    historyDisclosure: {
      policy: 'all', visibleFrom: null, labelKey: 'conversation.history.all',
    },
    myJoinRequest: {},
  }, {
    conversationId: 'discoverable-expired', kind: 'group', name: 'Expired request group',
    visibility: 'organization', postingMode: 'all_members', joinPolicy: 'approval_required',
    memberCount: 1,
    historyDisclosure: { policy: 'all', visibleFrom: null, labelKey: 'other' },
    myJoinRequest: {
      requestId: 'join-expired', status: 'unsupported', version: 'bad',
      requestedAt: now, expiresAt: now, decidedAt: now,
    },
  }];
  return payload;
}

beforeEach(() => {
  mockApiBase = 'https://api.newone.test';
  mockSession = { access_token: 'controlled-access-token' };
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('authoritative web read repository', () => {
  test('parses a rich bootstrap into isolated workspace domain state', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: bootstrapPayload() }));
    const repo = repository();
    const workspace = await repo.loadWorkspace(currentUserId, conversationId);

    expect(workspace.organizationId).toBe(organizationId);
    expect(workspace.organizationName).toBe('Controlled Company');
    expect(workspace.currentMembershipRole).toBe('owner');
    expect(workspace.currentUser).toMatchObject({
      id: currentUserId,
      membershipType: 'employee',
      site: 'Denver Plant',
      department: 'Operations',
    });
    expect(workspace.people.find((person) => person.id === colleagueId)).toMatchObject({
      connectionState: 'connected',
      savedContact: true,
      contactAlias: 'Ana T',
      favoriteContact: true,
      preferredLanguage: 'es',
    });
    expect(workspace.conversations).toHaveLength(2);
    expect(workspace.conversations[0]).toMatchObject({
      id: conversationId,
      title: 'Plant Operations',
      myRole: 'owner',
      canManageConversation: true,
      historyPolicy: 'all',
    });
    // v3.4: a nickname is what this reader calls them, so it names the thread;
    // and the pair follows the reading language ("Translate to", es-MX here),
    // which matches the counterpart's Spanish, so there is no pair to show.
    expect(workspace.conversations[1]).toMatchObject({
      id: directConversationId,
      title: 'Ana T',
      translationPair: undefined,
    });
    expect(workspace.messages[conversationId]).toHaveLength(3);
    expect(workspace.messages[conversationId]![0]).toMatchObject({
      serverId: '101',
      translatedText: 'Cierre la entrada norte a las 18:00.',
      translationState: 'corrected',
      deliveryState: 'read',
      forwarded: true,
      attachment: { kind: 'image', status: 'clean', sizeLabel: '2 KB' },
    });
    expect(workspace.messages[conversationId]![1]).toMatchObject({
      serverId: '102',
      translationState: 'needs_review',
      deliveryState: 'delivered',
      attachment: { kind: 'document', status: 'scanning', sizeLabel: '512 B' },
    });
    expect(workspace.messages[conversationId]![2].systemEvent).toEqual({
      eventType: 'conversation.member.added', targetUserId: currentUserId,
    });
    expect(workspace.updates[0]).toMatchObject({ severity: 'important', acknowledged: true });
    expect(workspace.handoffs[0]).toMatchObject({ status: 'draft', canSign: true, sourceCount: 2 });
    expect(workspace.summaries[0]).toMatchObject({
      status: 'ready_for_review',
      primaryTopic: 'Gate safety',
      summary: 'Secure the gate and inspect the valve.',
      ambiguities: [{ text: 'Valve number', sourceMessageIds: [] }],
      scopeKind: 'last_7_days',
      scopeSubject: 'the trip',
      sourceMessageCount: 143,
    });
    // Older rows carry evidence suffixes in their text; none of it reaches a screen.
    expect(workspace.summaries[0].keyTopics.map((item) => item.text)).toEqual(['Gate', 'Valve']);
    expect(workspace.summaries[0].decisions[0]).toEqual({ text: 'Lock gate', sourceMessageIds: ['101'] });
    expect(workspace.summaries[0].actionItems[0]).toMatchObject({ title: 'Inspect valve', owner: 'Ana' });
    expect(JSON.stringify(workspace.summaries[0])).not.toMatch(/\bs0\d{3}\b|\[sources/);
    expect(workspace.actions[0]).toMatchObject({ assigneeName: 'Ana Torres', status: 'confirmed' });
    expect(workspace.capabilities).toEqual(['audit.read', 'communications.publish']);
    expect(workspace.discoverableConversations[0].myJoinRequest).toMatchObject({ status: 'pending' });

    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.newone.test/v2/bootstrap');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' });
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer controlled-access-token',
      apikey: 'controlled-publishable-key',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      organizationId: null,
      selectedConversationId: conversationId,
      beforeMessageId: null,
      conversationLimit: 100,
      timelineLimit: 100,
    });
  });

  test('carries the translation your own message becomes for everyone else', async () => {
    const payload = bootstrapPayload();
    // This phone reads Spanish, so the row aimed at a Korean reader is the one
    // the sender never sees through the normal pick. It rides the same
    // response: nothing extra is fetched for it.
    (payload.timeline as any).messages[0].translations.push(translationVariant('702', 'completed', {
      targetLanguage: 'ko', translatedBody: '18시에 북문을 잠그세요.',
    }));
    mockFetch.mockImplementationOnce(async () => response({ data: payload }));
    const repo = repository();
    const workspace = await repo.loadWorkspace(currentUserId, conversationId);

    const own = workspace.messages[conversationId]![0]!;
    expect(own.isOwn).toBe(true);
    expect(own.translation?.targetLanguage).toBe('es');
    // v3.5: every language somebody else reads it in, one entry each, sorted
    // by language. Spanish used to be dropped here because it is also this
    // reader's own reading language — which is precisely how a Korean reader
    // writing to a Korean speaker was shown nothing at all.
    expect(own.outgoingTranslations).toMatchObject([
      { targetLanguage: 'es', status: 'completed' },
      { targetLanguage: 'ko', status: 'completed', translatedText: '18시에 북문을 잠그세요.' },
    ]);
    // A message you received carries no such thing: it is already yours to read.
    expect(workspace.messages[conversationId]![1]!.outgoingTranslations).toBeUndefined();
  });

  test('leaves your own message without an outgoing translation when nobody needed one', async () => {
    const payload = bootstrapPayload();
    (payload.timeline as any).messages[0].translations = [];
    mockFetch.mockImplementationOnce(async () => response({ data: payload }));
    const repo = repository();
    const workspace = await repo.loadWorkspace(currentUserId, conversationId);
    expect(workspace.messages[conversationId]![0]!.outgoingTranslations).toEqual([]);
  });

  test('an outgoing translation still queued keeps its state so the bubble can stay quiet', async () => {
    const payload = bootstrapPayload();
    (payload.timeline as any).messages[0].translations = [
      translationVariant('703', 'queued', { targetLanguage: 'ko' }),
    ];
    mockFetch.mockImplementationOnce(async () => response({ data: payload }));
    const repo = repository();
    const workspace = await repo.loadWorkspace(currentUserId, conversationId);
    const own = workspace.messages[conversationId]![0]!;
    expect(own.translation).toBeUndefined();
    // Only a finished translation is worth showing, so a queued one is not
    // carried at all now: the bubble has nothing to say until it lands.
    expect(own.outgoingTranslations).toEqual([]);
  });

  test('parses alternate authoritative lifecycle states without inventing client data', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: alternateBootstrapPayload() }));
    const workspace = await repository().loadWorkspace(currentUserId, 'conversation-managed');

    expect(workspace.organizationName).toBe('123');
    expect(workspace.people[0]).toMatchObject({ id: currentUserId, connectionState: 'self' });
    expect(workspace.people.find((person) => person.id === 'user-manager')).toMatchObject({
      role: 'manager', connectionState: 'pending', connectionRequestDirection: 'outgoing',
      blockedByMe: true, suspended: true,
    });
    expect(workspace.people.find((person) => person.id === 'user-supervisor')).toMatchObject({
      role: 'supervisor', connectionRequestDirection: 'incoming', preferredLanguage: 'ko',
    });
    expect(workspace.conversations[0]).toMatchObject({
      kind: 'incident', managementOnly: true, translationMode: 'off',
      historyPolicy: 'since_join', incidentSeverity: 'critical', isReadOnly: true,
    });
    expect(workspace.conversations[1]).toMatchObject({
      kind: 'group', archived: true, title: 'Company conversation',
    });
    expect(workspace.messages['conversation-managed']).toHaveLength(8);
    expect(workspace.messages['conversation-managed']!.map((message) => message.translationState))
      .toEqual(['queued', 'translating', 'needs_review', 'human_reviewed', 'failed', 'blocked', 'not_requested', 'not_requested']);
    expect(workspace.messages['conversation-managed']![7].systemEvent)
      .toEqual({ eventType: 'conversation.avatar.changed', targetUserId: null });
    expect(workspace.messages['conversation-managed']![5]).toMatchObject({
      attachment: { kind: 'voice', status: 'blocked', sizeLabel: '2.0 MB' },
    });
    expect(workspace.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'critical', status: undefined }),
      expect.objectContaining({ severity: 'standard', reminderPolicy: expect.objectContaining({ intervalSeconds: null }) }),
    ]));
    expect(workspace.handoffs.map((handoff) => handoff.status))
      .toEqual(['ready', 'acknowledged', 'awaiting_signoff']);
    expect(workspace.summaries.map((summary) => summary.status))
      .toEqual(['queued', 'generating', 'corrected', 'approved', 'failed', 'superseded']);
    expect(workspace.actions[0]).toMatchObject({ assigneeUserId: null, status: 'proposed' });
    expect(workspace.moderationReports[0]).toMatchObject({ category: 'other', status: 'open' });
    expect(workspace.auditEvents.map((event) => event.outcome)).toEqual(['denied', 'failed']);
    expect(workspace.scopes).toEqual([
      expect.objectContaining({ roleName: 'site_admin', scopeType: 'unit', unitId: 'site-a' }),
    ]);
    expect(workspace.discoverableConversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'team', myJoinRequest: null }),
      expect.objectContaining({ myJoinRequest: expect.objectContaining({ status: 'expired', version: 1 }) }),
    ]));
    expect(workspace.cursors['conversation-managed']).toBe('201');
  });

  test('leaves a handoff site blank in the personal realm and keeps the workplace placeholder', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: alternateBootstrapPayload() }));
    const workplace = await repository().loadWorkspace(currentUserId, 'conversation-managed');
    // Two handoffs come from an author who is no longer in the directory.
    expect(workplace.handoffs.slice(1).map((handoff) => handoff.site)).toEqual(['Company site', 'Company site']);

    const personal = alternateBootstrapPayload();
    personal.organization.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    mockFetch.mockImplementationOnce(async () => response({ data: personal }));
    const consumer = await repository().loadWorkspace(currentUserId, 'conversation-managed');
    expect(consumer.handoffs.map((handoff) => handoff.site)).toEqual(['', '', '']);
    expect(JSON.stringify(consumer.handoffs)).not.toContain('Company site');
  });

  test('rejects malformed bootstrap DTO boundaries without reflecting upstream data', async () => {
    const mutations: ((payload: any) => void)[] = [
      (payload) => { payload.organization.name = null; },
      (payload) => { payload.handoffs[0].sourceLanguage = 'fr'; },
      (payload) => { payload.timeline.messages[0].detectedLanguage = 'fr'; },
      (payload) => { payload.timeline.messages[0].languageDetectionMethod = 4; },
      (payload) => { payload.timeline.messages[0].languageDetectedAt = 'not-a-date'; },
      (payload) => { payload.handoffs[0].shiftStartedAt = null; },
      (payload) => { payload.timeline.messages[0].languageDetectionConfidence = 2; },
      (payload) => { payload.timeline.messages[0].receipt.deliveredAt = 'not-a-date'; },
      (payload) => { payload.timeline.messages[0].receipt.recipientCount = -1; },
      (payload) => { payload.timeline.messages[1].receipt.scope = 'unknown'; },
      (payload) => { payload.timeline.messages[0].receipt = selfReceipt(true); },
      (payload) => { payload.timeline.messages[1].receipt = aggregateReceipt(); },
      (payload) => { payload.timeline.messages[1].receipt.delivered = 'true'; },
      (payload) => { payload.timeline.messages[1].receipt.delivered = false; },
      (payload) => { payload.timeline.messages[0].receipt.deliveredCount = 3; },
      (payload) => { payload.timeline.messages[1].languageDetectionState = 'unknown'; },
      (payload) => {
        Object.assign(payload.timeline.messages[1], {
          languageDetectionState: 'pending', detectedLanguage: 'en',
          languageDetectionMethod: null, languageDetectionConfidence: null, languageDetectedAt: null,
        });
      },
      (payload) => { payload.timeline.messages[0].translations[0].latestCorrection.status = 'unknown'; },
      (payload) => { payload.timeline.messages[0].translations[0].latestCorrection.reviewedAt = null; },
      (payload) => { payload.timeline.messages[0].translations[0].status = 'unknown'; },
      (payload) => { payload.timeline.messages[0].translations[0].sourceBodySha256 = 'bad'; },
      (payload) => { payload.timeline.messages[0].translations[0].translatedBody = null; },
      (payload) => { payload.timeline.messages[2].systemEvent.unexpected = true; },
      (payload) => { payload.timeline.messages[1].systemEvent = {}; },
      (payload) => { payload.timeline.messages[1].mentions = 'not-an-array'; },
      (payload) => { payload.discoverableConversations[0].kind = 'direct'; },
      (payload) => { payload.summaries[0].keyTopics = 'not-an-array'; },
      (payload) => { payload.summaries[0].sourceMessageIds = []; },
      (payload) => {
        payload.summaries[0].sourceMessageIds = ['101', '101'];
        payload.summaries[0].sourceLastMessageId = '101';
      },
      (payload) => { payload.summaries[0].decisions[0].sourceMessageIds = ['unauthorized']; },
      (payload) => { payload.summaries[0].status = 'unknown'; },
      (payload) => { payload.summaries[0].scopeKind = 'someday'; },
      (payload) => { payload.summaries[0].sourceMessageCount = 0; },
      (payload) => { payload.summaries[0].sourceFirstMessageId = '999'; },
      (payload) => { payload.summaries[0].requestMode = 'unknown'; },
      (payload) => { payload.summaries[0].processorType = 'unknown'; },
      (payload) => { payload.summaries[0].status = 'approved'; },
      (payload) => {
        Object.assign(payload.summaries[0], {
          status: 'queued', primaryTopic: 'Unexpected topic', summaryBody: 'Unexpected summary',
          outputFingerprint: 'd'.repeat(64), keyTopics: null, decisions: null,
          actionItems: null, ambiguities: null,
        });
      },
      (payload) => { payload.summaries[0].processorProvenance.organizationAiPolicyVersion = 0; },
      (payload) => { payload.summaries[0].versionNumber = 0; },
      (payload) => { payload.units[0].kind = 'unknown'; },
      (payload) => { payload.currentUser.membershipRole = 'unknown'; },
      (payload) => { payload.currentUser.membershipType = 'unknown'; },
    ];

    const unexpectedErrors: string[] = [];
    for (const [index, mutate] of mutations.entries()) {
      const payload: any = bootstrapPayload();
      mutate(payload);
      mockFetch.mockImplementationOnce(async () => response({ data: payload }));
      try {
        await repository().loadWorkspace(currentUserId, conversationId);
        unexpectedErrors.push(`${index}:resolved`);
      } catch (error) {
        if (!(error instanceof RepositoryError) || error.code !== 'invalid_response') {
          unexpectedErrors.push(`${index}:${error instanceof Error ? error.constructor.name : typeof error}`);
        }
      }
    }
    expect(unexpectedErrors).toEqual([]);
  });

  test('loads a bounded older message page after bootstrap identity is established', async () => {
    mockFetch
      .mockImplementationOnce(async () => response({ data: bootstrapPayload() }))
      .mockImplementationOnce(async () => response({ data: {
        schemaVersion: 1,
        conversationId,
        messages: [incomingMessage('90')],
        hasMore: false,
        nextBeforeMessageId: null,
      } }));
    const repo = repository();
    await repo.loadWorkspace(currentUserId, conversationId);
    await expect(repo.loadMessages({
      organizationId,
      conversationId,
      userId: currentUserId,
      after: '101',
    })).resolves.toMatchObject({ items: [{ serverId: '90' }], cursor: null });
    expect(JSON.parse(String((mockFetch.mock.calls[1]![1] as RequestInit).body))).toEqual({
      organizationId,
      beforeMessageId: '101',
      limit: 100,
    });
  });

  test('bootstraps implicitly when messages are requested before workspace identity', async () => {
    const payload = bootstrapPayload();
    payload.timeline.messages = [incomingMessage('90')];
    (payload.timeline as unknown as { nextBeforeMessageId: string | null })
      .nextBeforeMessageId = null;
    mockFetch.mockImplementationOnce(async () => response({ data: payload }));
    await expect(repository().loadMessages({
      organizationId,
      conversationId,
      userId: currentUserId,
      after: null,
    })).resolves.toMatchObject({ items: [{ serverId: '90' }], cursor: null });
  });

  test('searches consumer usernames through the bounded read surface', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: { users: [
      {
        userId: 'AB000000-0000-4000-8000-00000000000A',
        username: 'ana_torres',
        displayName: 'Ana Torres',
        avatarPath: 'avatars/ana.jpg',
        connectionState: 'none',
      },
      {
        userId: currentUserId,
        username: 'jordan',
        displayName: null,
        avatarPath: null,
        connectionState: 'accepted',
      },
    ] } }));
    await expect(repository().searchUsers({
      organizationId,
      query: 'ana',
      limit: 20,
    })).resolves.toEqual([
      {
        userId: 'ab000000-0000-4000-8000-00000000000a',
        username: 'ana_torres',
        displayName: 'Ana Torres',
        avatarPath: 'avatars/ana.jpg',
        connectionState: 'none',
      },
      {
        userId: currentUserId,
        username: 'jordan',
        displayName: null,
        avatarPath: null,
        connectionState: 'accepted',
      },
    ]);
    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://api.newone.test/v2/users/search');
    expect(JSON.parse(String((mockFetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
      organizationId,
      query: 'ana',
      limit: 20,
    });

    mockFetch.mockImplementationOnce(async () => response({ data: { users: [] } }));
    await expect(repository().searchUsers({ organizationId, query: 'zz', limit: 500 }))
      .resolves.toEqual([]);
    expect(JSON.parse(String((mockFetch.mock.calls[1]![1] as RequestInit).body))).toEqual({
      organizationId,
      query: 'zz',
      limit: 50,
    });
  });

  test('rejects malformed, duplicated, oversized, and rate-limited user search responses', async () => {
    const validRow = {
      userId: colleagueId,
      username: 'ana_torres',
      displayName: 'Ana Torres',
      avatarPath: null,
      connectionState: 'none',
    };
    const malformed: unknown[] = [
      { users: null },
      { users: [{ ...validRow, userId: 'not-a-uuid' }] },
      { users: [{ ...validRow, username: 'Ana Torres' }] },
      { users: [{ ...validRow, username: 'ab' }] },
      { users: [{ ...validRow, displayName: 'x'.repeat(161) }] },
      { users: [{ ...validRow, avatarPath: 'x'.repeat(1025) }] },
      { users: [{ ...validRow, connectionState: 'blocked' }] },
      { users: [validRow, { ...validRow, username: 'ana_dupe' }] },
    ];
    for (const payload of malformed) {
      mockFetch.mockImplementationOnce(async () => response({ data: payload }));
      await expect(repository().searchUsers({ organizationId, query: 'ana' }))
        .rejects.toMatchObject({ code: 'invalid_response', retryable: true });
    }

    mockFetch.mockImplementationOnce(async () => response({
      data: { users: [validRow, { ...validRow, userId: currentUserId, username: 'ana_other' }] },
    }));
    await expect(repository().searchUsers({ organizationId, query: 'ana', limit: 1 }))
      .rejects.toMatchObject({ code: 'invalid_response', retryable: true });

    mockFetch.mockImplementationOnce(async () => response({
      error: { code: 'rate_limited', correlationId: 'correlation-search' },
    }, 429));
    await expect(repository().searchUsers({ organizationId, query: 'ana' }))
      .rejects.toMatchObject({
        code: 'rate_limited', status: 429, retryable: true, correlationId: 'correlation-search',
      });
  });

  test('parses audit pages while preserving the signed filter receipt', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: {
      items: [{
        id: '200',
        actorUserId: currentUserId,
        eventType: 'security.session.revoked',
        targetType: 'session',
        targetId: 'session-a',
        requestId: 'request-a',
        occurredAt: now,
        outcome: 'succeeded',
      }],
      nextCursor: null,
      hasMore: false,
      snapshotAt: now,
      filterSha256: 'e'.repeat(64),
      receiptId: 'audit-receipt-a',
    } }));
    await expect(repository().queryAudit({
      organizationId,
      reasonCode: 'security_review',
      dateFrom: '2026-08-01T00:00:00.000Z',
      dateTo: '2026-08-05T00:00:00.000Z',
      eventTypes: ['security.session.revoked'],
      actorMembershipId: currentUserId,
      targetType: 'session',
      targetId: 'session-a',
      cursor: null,
      limit: 10,
    })).resolves.toMatchObject({
      items: [{ id: '200', actorUserId: currentUserId, outcome: 'succeeded' }],
      hasMore: false,
      filterSha256: 'e'.repeat(64),
      receiptId: 'audit-receipt-a',
    });
  });

  test('rejects unauthenticated, network, HTTP, unsupported schema, and unstable cursor responses', async () => {
    mockSession = null;
    await expect(repository().loadWorkspace(currentUserId)).rejects.toMatchObject({
      code: 'authentication_required', retryable: false,
    });

    mockSession = { access_token: 'controlled-access-token' };
    mockFetch.mockRejectedValueOnce(new TypeError('controlled network loss'));
    await expect(repository().loadWorkspace(currentUserId)).rejects.toMatchObject({
      code: 'network_unavailable', retryable: true,
    });

    mockFetch.mockImplementationOnce(async () => response({
      error: { code: 'rate_limited', correlationId: 'correlation-a' },
    }, 429));
    await expect(repository().loadWorkspace(currentUserId)).rejects.toMatchObject({
      code: 'rate_limited', status: 429, retryable: true, correlationId: 'correlation-a',
    });

    const unsupported = bootstrapPayload();
    unsupported.schemaVersion = 2;
    mockFetch.mockImplementationOnce(async () => response({ data: unsupported }));
    await expect(repository().loadWorkspace(currentUserId)).rejects.toMatchObject({
      code: 'client_update_required', retryable: false,
    });

    mockFetch
      .mockImplementationOnce(async () => response({ data: bootstrapPayload() }))
      .mockImplementationOnce(async () => response({ data: {
        schemaVersion: 1,
        conversationId,
        messages: [incomingMessage('110')],
        hasMore: false,
        nextBeforeMessageId: null,
      } }));
    const repo = repository();
    await repo.loadWorkspace(currentUserId, conversationId);
    await expect(repo.loadMessages({
      organizationId,
      conversationId,
      userId: currentUserId,
      after: '101',
    })).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
  });

  test('rejects aggregate receipt detail that would expose recipient identities', async () => {
    const payload = bootstrapPayload();
    Object.assign(payload.timeline.messages[0]!.receipt, { recipients: [{ userId: colleagueId }] });
    mockFetch.mockImplementationOnce(async () => response({ data: payload }));

    await expect(repository().loadWorkspace(currentUserId, conversationId)).rejects.toMatchObject({
      code: 'invalid_response', retryable: false,
    });
  });
});

describe('real hosted bootstrap payload', () => {
  // Captured verbatim from the production /v2/bootstrap response for a
  // freshly signed-up consumer. The parser must accept what the server
  // actually sends — hand-built fixtures can drift from reality.
  test('parses a captured production bootstrap response', async () => {
    const captured = require('./fixtures/real-bootstrap.json') as { data?: Record<string, unknown> };
    const data = (captured.data ?? captured) as Record<string, unknown>;
    mockFetch.mockImplementationOnce(async () => response({ data }));
    const repo = repository();
    const snapshot = await repo.loadWorkspace(String(data.userId), null);
    expect(snapshot.organizationId).toBe(String(data.organizationId));
    expect(snapshot.currentUser.id).toBe(String(data.userId));
  });
});
