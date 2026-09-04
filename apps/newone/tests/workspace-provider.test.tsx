import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';
import { AppState, Linking, Text, type AppStateStatus } from 'react-native';

import {
  RepositoryError,
  type UpdateAudienceSpec,
  type WorkspaceSnapshot,
} from '@/data/repositories/contracts';
import type { OutboxCommand } from '@/data/persistence/types';
import { serializeOfflineWorkspace } from '@/data/persistence/offline-workspace.mjs';
import type {
  AiOutputErrorReport,
  AiRegressionExample,
  ConversationJoinRequest,
  ConversationSummary,
  Message,
} from '@/domain/types';
import { WorkspaceProvider, useWorkspace } from '@/state/workspace';

const mockLoadWorkspace = jest.fn();
const mockLoadMessages = jest.fn();
const mockSearchUsers = jest.fn();
const mockCommand = jest.fn<(method: string, input: unknown) => Promise<unknown>>();
const mockEndAccess = jest.fn();
const mockListOutbox = jest.fn();
const mockEnqueue = jest.fn<(command: OutboxCommand) => Promise<void>>();
const mockUpdateOutbox = jest.fn<(command: OutboxCommand) => Promise<void>>();
const mockRemoveOutbox = jest.fn<(id: string) => Promise<void>>();
const mockPurgeUser = jest.fn();
const mockGetCache = jest.fn();
const mockPutCache = jest.fn();
const mockRemoveCache = jest.fn();
const mockPrepareAttachment = jest.fn();
const mockOptimizeImageAttachment = jest.fn();
const mockUploadAttachment = jest.fn();
const mockCleanupPreparedAttachment = jest.fn();
const mockGetCurrentInstallationId = jest.fn();
const mockRequestDeviceRegistration = jest.fn();
const mockQueryAudit = jest.fn();
const mockTranslate = (key: string) => key;
let mockOfflineCacheEnabled = false;

let mockAuth: Record<string, unknown>;
let controlledOutbox: OutboxCommand[];
let mockRealtimeOptions: Record<string, unknown> | null;

jest.mock('@/config/runtime', () => ({
  get publicRuntimeConfig() {
    return { offlineCacheEnabled: mockOfflineCacheEnabled };
  },
}));

jest.mock('@/data/attachments', () => ({
  cleanupPreparedAttachment: (...mockArgs: unknown[]) => mockCleanupPreparedAttachment(...mockArgs),
  optimizeImageAttachment: (...mockArgs: unknown[]) => mockOptimizeImageAttachment(...mockArgs),
  prepareAttachment: (...mockArgs: unknown[]) => mockPrepareAttachment(...mockArgs),
  uploadAttachment: (...mockArgs: unknown[]) => mockUploadAttachment(...mockArgs),
}));

jest.mock('@/data/persistence/client-store', () => ({
  clientStore: {
    cancelOutbox: async () => true,
    deleteOutbox: async () => undefined,
    enqueue: (command: OutboxCommand) => mockEnqueue(command),
    getCache: (...mockArgs: unknown[]) => mockGetCache(...mockArgs),
    initialize: async () => undefined,
    listOutbox: (...mockArgs: unknown[]) => mockListOutbox(...mockArgs),
    putCache: (...mockArgs: unknown[]) => mockPutCache(...mockArgs),
    putOutbox: async () => undefined,
    purgeUser: (...mockArgs: unknown[]) => mockPurgeUser(...mockArgs),
    removeCache: (...mockArgs: unknown[]) => mockRemoveCache(...mockArgs),
    removeOutbox: (id: string) => mockRemoveOutbox(id),
    updateOutbox: (command: OutboxCommand) => mockUpdateOutbox(command),
  },
}));

jest.mock('@/data/repositories/bff-command-repository', () => ({
  BffCommandRepository: class ControlledCommandRepository {
    constructor() {
      return new Proxy(this, {
        get: (mockTarget, mockProperty, mockReceiver) => {
          if (mockProperty in mockTarget) return Reflect.get(mockTarget, mockProperty, mockReceiver);
          return (input: unknown) => mockCommand(String(mockProperty), input);
        },
      });
    }
  },
}));

jest.mock('@/data/repositories/web-read-repository', () => ({
  WebReadRepository: class ControlledReadRepository {
    loadWorkspace(...mockArgs: unknown[]) {
      return mockLoadWorkspace(...mockArgs);
    }

    loadMessages(...mockArgs: unknown[]) {
      return mockLoadMessages(...mockArgs);
    }

    searchUsers(...mockArgs: unknown[]) {
      return mockSearchUsers(...mockArgs);
    }

    queryAudit(...mockArgs: unknown[]) {
      return mockQueryAudit(...mockArgs);
    }
  },
}));

jest.mock('@/data/realtime/use-user-realtime', () => ({
  useUserRealtime: (mockOptions: Record<string, unknown>) => {
    mockRealtimeOptions = mockOptions;
  },
}));

jest.mock('@/device/push-registration', () => ({
  addPushTokenRefreshListener: () => ({ remove: () => undefined }),
  getCurrentInstallationId: (...mockArgs: unknown[]) => mockGetCurrentInstallationId(...mockArgs),
  getExistingDeviceRegistration: async () => null,
  requestDeviceRegistration: (...mockArgs: unknown[]) => mockRequestDeviceRegistration(...mockArgs),
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: mockTranslate }),
}));

jest.mock('@/lib/client-id', () => ({
  createClientId: () => '50000000-0000-4000-8000-000000000005',
}));

jest.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => null,
}));

jest.mock('@/state/auth', () => ({
  useAuth: () => mockAuth,
}));

const userId = '60000000-0000-4000-8000-000000000006';
const otherUserId = '60000000-0000-4000-8000-000000000007';
const availableUserId = '60000000-0000-4000-8000-000000000008';
const incomingUserId = '60000000-0000-4000-8000-000000000009';
const conversationBId = '80000000-0000-4000-8000-000000000008';
const incidentConversationId = '80000000-0000-4000-8000-000000000009';
const discoverableConversationId = '80000000-0000-4000-8000-000000000010';

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    organizationId: '70000000-0000-4000-8000-000000000007',
    organizationName: 'Controlled Company',
    conversationControlsVersion: 1,
    currentMembershipRole: 'member',
    organizationPolicy: {} as WorkspaceSnapshot['organizationPolicy'],
    currentUser: {
      id: userId,
      membershipId: 'membership-self',
      organizationId: '70000000-0000-4000-8000-000000000007',
      displayName: 'Current Employee',
      initials: 'CE',
      roleLabel: 'Operator',
      role: 'employee',
      site: 'Denver',
      department: 'Operations',
      preferredLanguage: 'en',
      presence: 'online',
      connectionState: 'self',
      avatarColor: '#123456',
      membershipType: 'employee',
      accessExpiresAt: null,
      guestSponsorUserId: null,
    },
    conversations: [{
      id: 'conversation-a',
      organizationId: '70000000-0000-4000-8000-000000000007',
      title: 'Operations',
      initials: 'OP',
      avatarColor: '#334455',
      kind: 'group',
      subtitle: 'Operations team',
      lastMessage: 'Ready',
      lastActivity: 'now',
      unreadCount: 0,
      pinned: false,
      favorite: false,
      muted: false,
      myRole: 'member',
      canPost: true,
      memberIds: [userId, otherUserId],
    }],
    messages: { 'conversation-a': [] },
    people: [{
      id: otherUserId,
      membershipId: 'membership-other',
      organizationId: '70000000-0000-4000-8000-000000000007',
      displayName: 'Connected Employee',
      initials: 'CO',
      roleLabel: 'Supervisor',
      role: 'manager',
      site: 'Denver',
      department: 'Operations',
      preferredLanguage: 'es',
      presence: 'away',
      connectionState: 'connected',
      savedContact: true,
      contactAlias: 'Shift partner',
      favoriteContact: true,
      avatarColor: '#654321',
    }],
    units: [],
    updates: [],
    handoffs: [],
    summaries: [],
    actions: [],
    moderationReports: [],
    auditEvents: [],
    capabilities: ['communications.publish'],
    scopes: [],
    messageDisplayLanguage: 'en',
    cursors: { 'conversation-a': null },
    discoverableConversations: [],
  };
}

function controlledMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-incoming',
    serverId: '90000000-0000-4000-8000-000000000009',
    conversationId: 'conversation-a',
    senderId: otherUserId,
    senderName: 'Connected Employee',
    senderInitials: 'CO',
    senderColor: '#654321',
    originalText: 'La válvula está abierta',
    translatedText: 'The valve is open',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    translationState: 'translated',
    languageDetection: {
      state: 'completed',
      detectedLanguage: 'es',
      confidence: 0.99,
      method: 'provider',
      detectedAt: '2026-08-04T08:00:00.000Z',
    },
    translation: {
      id: 'translation-a',
      sourceLanguage: 'es',
      targetLanguage: 'en',
      sourceBodySha256: 'source-fingerprint',
      status: 'completed',
      translatedText: 'The valve is open',
      provider: 'openrouter',
      model: 'controlled-capable-model',
      confidence: 0.99,
      policyVersion: 1,
      policyState: 'current',
      reviewedByUserId: null,
      reviewedAt: null,
      failureCode: null,
      createdAt: '2026-08-04T08:00:00.000Z',
      updatedAt: '2026-08-04T08:00:00.000Z',
      correction: {
        id: 'correction-a',
        status: 'pending',
        correctedText: 'The valve remains open',
        rationale: 'Operational nuance',
        proposedByUserId: userId,
        reviewedByUserId: null,
        reviewedAt: null,
        reviewNote: null,
        createdAt: '2026-08-04T08:00:00.000Z',
        updatedAt: '2026-08-04T08:00:00.000Z',
      },
    },
    sentAt: '08:00',
    isOwn: false,
    deliveryState: 'sent',
    priority: 'normal',
    reactions: [{ emoji: '✅', count: 2, reactedByMe: false }],
    attachment: {
      id: 'attachment-clean',
      kind: 'document',
      name: 'procedure.pdf',
      status: 'clean',
    },
    ...overrides,
  };
}

function controlledSummary(): ConversationSummary {
  const sourceMessageId = '90000000-0000-4000-8000-000000000009';
  return {
    id: 'summary-a',
    conversationId: 'conversation-a',
    versionNumber: 1,
    language: 'en',
    status: 'ready_for_review',
    primaryTopic: 'Valve status',
    summary: 'The valve remains open.',
    keyTopics: [{ text: 'Valve status', sourceMessageIds: [sourceMessageId] }],
    decisions: [{ text: 'Inspect at shift change', sourceMessageIds: [sourceMessageId] }],
    actionItems: [{
      title: 'Inspect valve',
      owner: 'Connected Employee',
      dueAt: '2026-08-05T09:00:00.000Z',
      sourceMessageIds: [sourceMessageId],
    }],
    ambiguities: [{ text: 'Opening duration', sourceMessageIds: [sourceMessageId] }],
    sourceMessageIds: [sourceMessageId],
    sourceFirstMessageId: sourceMessageId,
    sourceLastMessageId: sourceMessageId,
    sourceFingerprint: 'summary-source-fingerprint',
    outputFingerprint: 'summary-output-fingerprint',
    sourceState: 'current',
    policyState: 'current',
    requestMode: 'manual',
    requestedByUserId: userId,
    correctionOfSummaryId: null,
    provenance: {
      processorType: 'ai',
      provider: 'openrouter',
      model: 'controlled-capable-model',
      organizationAiPolicyVersion: 1,
      routePolicyVersion: 'policy-v1',
      providerRoute: 'primary',
    },
    failureCode: null,
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: '2026-08-04T08:00:00.000Z',
    generatedAt: '2026-08-04T08:01:00.000Z',
  };
}

function controlledAiReport(overrides: Partial<AiOutputErrorReport> = {}): AiOutputErrorReport {
  return {
    reportId: 'report-a',
    outputKind: 'translation',
    translationId: 'translation-a',
    summaryId: null,
    conversationId: 'conversation-a',
    category: 'incorrect_meaning',
    details: 'Safety-relevant meaning changed.',
    highConsequence: true,
    qualityUseConsent: true,
    consentVersion: 'quality-use-consent-v1',
    targetSourceFingerprint: 'source-fingerprint',
    targetOutputFingerprint: 'output-fingerprint',
    targetLanguage: 'en',
    targetSnapshot: {},
    status: 'open',
    outcome: null,
    version: 1,
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: '2026-08-04T08:00:00.000Z',
    updatedAt: '2026-08-04T08:00:00.000Z',
    ...overrides,
  };
}

function controlledRegressionExample(): AiRegressionExample {
  return {
    exampleId: 'example-a',
    reportId: 'report-a',
    outputKind: 'translation',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    deidentifiedSourceText: 'Source text',
    deidentifiedObservedOutput: 'Observed output',
    deidentifiedExpectedOutput: 'Expected output',
    errorCategory: 'incorrect_meaning',
    consequenceLevel: 'high_consequence',
    attestationVersion: 'human-deidentification-v1',
    proposedByUserId: userId,
    proposedAt: '2026-08-04T08:00:00.000Z',
    status: 'pending',
    version: 1,
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    exportedAt: null,
  };
}

function controlledJoinRequest(overrides: Partial<ConversationJoinRequest> = {}): ConversationJoinRequest {
  return {
    requestId: 'join-request-a',
    conversationId: discoverableConversationId,
    requesterUserId: userId,
    status: 'pending',
    version: 1,
    requestedAt: '2026-08-04T08:00:00.000Z',
    expiresAt: '2026-08-05T08:00:00.000Z',
    ...overrides,
  };
}

function richWorkspaceSnapshot(): WorkspaceSnapshot {
  const snapshot = workspaceSnapshot();
  const incoming = controlledMessage();
  const own = controlledMessage({
    id: 'message-own',
    serverId: '90000000-0000-4000-8000-000000000010',
    senderId: userId,
    senderName: 'Current Employee',
    senderInitials: 'CE',
    senderColor: '#123456',
    originalText: 'Inspecting now',
    translatedText: undefined,
    targetLanguage: undefined,
    translationState: 'not_requested',
    translation: undefined,
    languageDetection: undefined,
    isOwn: true,
    deliveryState: 'delivered',
    attachment: undefined,
    reactions: [],
  });
  snapshot.currentMembershipRole = 'owner';
  snapshot.capabilities = [
    'members.security',
    'sessions.revoke',
    'roles.manage',
    'roles.read',
    'audit.read',
    'message.preservation.manage',
    'ai.policy.manage',
    'directory.manage',
    'directory.read',
    'invites.manage',
    'communications.publish',
    'unit.manage',
    'conversation.manage',
    'language.review',
    'recovery.manage',
    'handoff.manage',
    'actions.confirm',
    'reports.investigate',
    'reports.assign',
  ];
  snapshot.scopes = [{
    assignmentId: 'scope-a',
    roleName: 'security_admin',
    scopeType: 'organization',
    unitId: null,
    permissions: snapshot.capabilities,
    expiresAt: '2027-08-04T00:00:00.000Z',
  }];
  snapshot.conversations[0] = {
    ...snapshot.conversations[0],
    participantCount: 2,
    unreadCount: 1,
    canManage: true,
    canManageConversation: true,
    memberIds: [userId, otherUserId],
    memberRoles: { [userId]: 'owner', [otherUserId]: 'member' },
    historyPolicy: 'all',
    historyDisclosure: {
      policy: 'all',
      visibleFrom: null,
      labelKey: 'conversation.history.all',
    },
    postingMode: 'all_members',
    configuredJoinPolicy: 'approval_required',
    joinPolicy: 'approval_required',
    visibility: 'organization',
    avatarPath: `${snapshot.organizationId}/conversation-a/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/upload`,
  };
  snapshot.conversations.push({
    id: conversationBId,
    organizationId: snapshot.organizationId,
    title: 'Maintenance',
    initials: 'MA',
    avatarColor: '#29465B',
    kind: 'group',
    subtitle: 'Maintenance team',
    participantCount: 2,
    lastMessage: 'Ready',
    lastActivity: 'now',
    unreadCount: 0,
    pinned: false,
    favorite: false,
    muted: false,
    myRole: 'owner',
    canManage: true,
    canManageConversation: true,
    canPost: true,
    memberIds: [userId, otherUserId],
    memberRoles: { [userId]: 'owner', [otherUserId]: 'member' },
    departure: {
      eligible: true,
      restriction: null,
      requiresOwnershipTransfer: true,
      historyPreserved: true,
      futureAccessRevoked: true,
    },
  }, {
    id: incidentConversationId,
    organizationId: snapshot.organizationId,
    title: 'Safety Incident',
    initials: 'SI',
    avatarColor: '#8B2D2D',
    kind: 'incident',
    subtitle: 'High severity',
    lastMessage: 'Active response',
    lastActivity: 'now',
    unreadCount: 0,
    pinned: true,
    favorite: false,
    muted: false,
    myRole: 'owner',
    canManage: true,
    canManageConversation: true,
    canPost: true,
    memberIds: [userId, otherUserId],
    memberRoles: { [userId]: 'owner', [otherUserId]: 'member' },
    incidentSeverity: 'high',
    incidentClassification: 'equipment',
  });
  snapshot.messages = {
    'conversation-a': [incoming, own],
    [conversationBId]: [],
    [incidentConversationId]: [],
  };
  snapshot.cursors = {
    'conversation-a': null,
    [conversationBId]: null,
    [incidentConversationId]: null,
  };
  snapshot.people.push({
    id: availableUserId,
    membershipId: 'membership-available',
    organizationId: snapshot.organizationId,
    displayName: 'Available Employee',
    initials: 'AE',
    roleLabel: 'Technician',
    role: 'employee',
    site: 'Denver',
    department: 'Maintenance',
    preferredLanguage: 'en',
    presence: 'online',
    connectionState: 'available',
    avatarColor: '#225577',
  }, {
    id: incomingUserId,
    membershipId: 'membership-incoming',
    organizationId: snapshot.organizationId,
    displayName: 'Incoming Employee',
    initials: 'IE',
    roleLabel: 'Technician',
    role: 'employee',
    site: 'Denver',
    department: 'Maintenance',
    preferredLanguage: 'en',
    presence: 'away',
    connectionState: 'pending',
    connectionRequestDirection: 'incoming',
    avatarColor: '#557722',
  });
  snapshot.discoverableConversations = [{
    conversationId: discoverableConversationId,
    kind: 'group',
    name: 'Facilities',
    description: 'Facilities coordination',
    avatarPath: null,
    visibility: 'organization',
    postingMode: 'all_members',
    joinPolicy: 'approval_required',
    memberCount: 12,
    historyDisclosure: {
      policy: 'all',
      visibleFrom: null,
      labelKey: 'conversation.history.all',
    },
    myJoinRequest: null,
  }];
  snapshot.summaries = [controlledSummary()];
  snapshot.actions = [{
    id: 'action-existing',
    conversationId: 'conversation-a',
    sourceMessageId: incoming.serverId ?? null,
    title: 'Inspect valve',
    details: null,
    status: 'proposed',
    proposedByUserId: userId,
    assigneeUserId: null,
    assigneeName: null,
    dueAt: null,
    createdAt: '2026-08-04T08:00:00.000Z',
    updatedAt: '2026-08-04T08:00:00.000Z',
  }];
  snapshot.updates = [{
    id: 'update-scheduled',
    versionId: 'update-version-a',
    versionNumber: 1,
    title: 'Planned maintenance',
    body: 'Maintenance begins at 18:00.',
    author: 'Current Employee',
    audience: '12 active members',
    publishedAt: 'Scheduled',
    severity: 'important',
    acknowledgementRequired: true,
    acknowledged: false,
    acknowledgedCount: 0,
    recipientCount: 12,
    status: 'scheduled',
    scheduledAt: '2026-08-05T18:00:00.000Z',
    notificationClass: 'urgent',
  }];
  snapshot.handoffs = [{
    id: 'handoff-sign',
    conversationId: 'conversation-a',
    versionId: 'handoff-version-sign',
    versionNumber: 1,
    sourceLanguage: 'en',
    title: 'Day shift',
    site: 'Denver',
    outgoingShift: 'Day',
    incomingShift: 'Night',
    window: '08:00 - 16:00',
    status: 'awaiting_signoff',
    summary: 'Valve inspection remains open.',
    openItems: 1,
    sourceCount: 1,
    outgoingSupervisor: 'Current Employee',
    incomingSupervisor: 'Connected Employee',
    shiftStartedAt: '2026-08-04T08:00:00.000Z',
    shiftEndedAt: '2026-08-04T16:00:00.000Z',
    authorId: userId,
    canSign: true,
    canAcknowledge: false,
    acknowledgedByMe: false,
    sourceMessageIds: [incoming.serverId ?? incoming.id],
    sourceState: 'current',
  }, {
    id: 'handoff-ack',
    conversationId: 'conversation-a',
    versionId: 'handoff-version-ack',
    versionNumber: 2,
    sourceLanguage: 'en',
    title: 'Night shift',
    site: 'Denver',
    outgoingShift: 'Night',
    incomingShift: 'Day',
    window: '16:00 - 00:00',
    status: 'ready',
    summary: 'Monitor the valve.',
    openItems: 1,
    sourceCount: 1,
    outgoingSupervisor: 'Connected Employee',
    incomingSupervisor: 'Current Employee',
    shiftStartedAt: '2026-08-04T16:00:00.000Z',
    shiftEndedAt: '2026-08-05T00:00:00.000Z',
    authorId: otherUserId,
    canSign: false,
    canAcknowledge: true,
    acknowledgedByMe: false,
    sourceMessageIds: [incoming.serverId ?? incoming.id],
    sourceState: 'current',
  }];
  return snapshot;
}

const organizationPreferences = {
  uiLanguage: 'en' as const,
  messageLanguage: 'en' as const,
  timeZone: 'America/Denver',
  quietHoursStart: '22:00',
  quietHoursEnd: '06:00',
  quietDays: [0, 6],
  notificationPreview: 'generic' as const,
  soundEnabled: true,
  vibrationEnabled: true,
  shiftAwareSuppression: true,
  readVisibility: 'contacts' as const,
};

const devicePreferences = {
  registered: true as const,
  deviceId: '30000000-0000-4000-8000-000000000003',
  installationId: '40000000-0000-4000-8000-000000000004',
  platform: 'ios' as const,
  preferenceVersion: 1,
  overrides: {
    notificationPreview: null,
    soundEnabled: null,
    vibrationEnabled: null,
  },
  effective: {
    notificationPreview: 'generic' as const,
    soundEnabled: true,
    vibrationEnabled: true,
  },
  updatedAt: '2026-08-04T08:00:00.000Z',
};

const roleAssignment = {
  assignmentId: 'assignment-a',
  userId: otherUserId,
  roleName: 'security_admin' as const,
  scopeType: 'organization' as const,
  unitId: null,
  grantedAt: '2026-08-04T08:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  active: true,
};

const organizationAiPolicy = {
  organizationId: '70000000-0000-4000-8000-000000000007',
  enabled: true,
  policyVersion: 1,
  approvedUseCases: ['language_detection', 'summary', 'translation'] as (
    'language_detection' | 'translation' | 'summary'
  )[],
  providerAllowlist: ['openrouter'],
  routePolicy: 'approved_zero_retention' as const,
  tenantApproved: true,
  globalKillSwitchStillRequired: true as const,
};

function controlledCommandResponse(method: string, input?: unknown): unknown {
  const commandInput = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const report = controlledAiReport();
  const regressionExample = controlledRegressionExample();
  switch (method) {
    case 'createDirectConversation':
      return { conversationId: 'direct-created' };
    case 'listGroupCreationCandidates':
      return {
        candidates: [{
          userId: availableUserId,
          membershipId: 'membership-available',
          displayName: 'Available Employee',
          initials: 'AE',
          avatarColor: '#225577',
          roleLabel: 'Technician',
          site: 'Denver',
          department: 'Maintenance',
          preferredLanguage: 'en',
        }],
      };
    case 'listConversationMemberCandidates':
      return {
        candidates: [{ userId: availableUserId, displayName: 'Available Employee' }],
        nextCursor: null,
      };
    case 'createGroupConversation':
      return {
        conversationId: 'group-created',
        name: 'Response Team',
        description: 'Coordinated response',
        kind: 'group',
        memberCount: 2,
        historyPolicy: 'all',
        historyDisclosure: {
          policy: 'all',
          visibleFrom: null,
          labelKey: 'conversation.history.all',
        },
        postingMode: 'all_members',
        configuredJoinPolicy: 'approval_required',
        joinPolicy: 'approval_required',
        visibility: 'organization',
        isReadOnly: false,
      };
    case 'sendMessage':
      return { messageId: '90000000-0000-4000-8000-000000000011' };
    case 'markMessageReceipt':
      return {
        deliveredAt: '2026-08-04T08:02:00.000Z',
        readAt: commandInput.state === 'read' ? '2026-08-04T08:03:00.000Z' : null,
      };
    case 'forwardMessage':
      return {
        messageId: '90000000-0000-4000-8000-000000000012',
        clientMessageId: '50000000-0000-4000-8000-000000000005',
      };
    case 'placeMessagePreservationHold':
      return { holdId: 'hold-a' };
    case 'proposeAction':
      return { actionId: 'action-created' };
    case 'createAttachmentDownloadGrant':
      return { signedUrl: 'https://storage.invalid/controlled-download' };
    case 'createAttachmentUploadGrant':
    case 'createConversationAvatarUploadGrant':
      return {
        attachmentId: '22222222-2222-4222-8222-222222222222',
        bucket: 'message-attachments',
        path: 'controlled/private/path',
        signedUrl: 'https://storage.invalid/controlled-upload',
        token: 'controlled-token',
        expiresInSeconds: 60,
      };
    case 'getAttachmentState':
      return {
        attachmentId: '22222222-2222-4222-8222-222222222222',
        scanStatus: 'clean',
      };
    case 'activateConversationAvatar':
      return {
        avatarPath: '70000000-0000-4000-8000-000000000007/conversation-a/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/upload',
      };
    case 'getConversationAvatarReadGrant':
      return {
        signedUrl: 'https://storage.invalid/controlled-avatar',
        expiresInSeconds: 60,
      };
    case 'requestTranslation':
      return { translationId: 'translation-a' };
    case 'proposeTranslationCorrection':
      return { correctionId: 'correction-a' };
    case 'requestConversationSummary':
    case 'createManualSummary':
      return { summaryId: 'summary-a' };
    case 'reportAiOutputError':
      return report;
    case 'listMyAiOutputErrorReports':
    case 'listAiOutputErrorReportsForReview':
      return [report];
    case 'readAiOutputErrorReport':
      return { report, regressionExample: null };
    case 'reviewAiOutputErrorReport':
      return controlledAiReport({
        outcome: commandInput.outcome === 'needs_context' ? 'needs_context' : 'confirmed_error',
        status: 'reviewing',
        version: 2,
      });
    case 'proposeAiRegressionExample':
      return regressionExample;
    case 'decideAiRegressionExample':
      return { ...regressionExample, status: 'approved', version: 2 };
    case 'updateConversationControls':
      return {
        postingMode: 'admins_only',
        configuredJoinPolicy: 'approval_required',
        joinPolicy: 'approval_required',
        visibility: 'organization',
      };
    case 'requestConversationJoin':
      return controlledJoinRequest();
    case 'cancelConversationJoinRequest':
      return controlledJoinRequest({ status: 'cancelled', version: 2 });
    case 'listConversationJoinRequests':
      return [controlledJoinRequest({ conversationId: 'conversation-a' })];
    case 'updateConversationMemberRole':
      return { role: 'admin' };
    case 'leaveConversation':
      return { left: true, historyPreserved: true, futureAccessRevoked: true };
    case 'publishUpdate':
      return {
        announcementId: 'update-created',
        versionId: 'update-created-version',
        audienceCount: 12,
        status: 'published',
        scheduledAt: null,
      };
    case 'previewUpdateAudience':
      return {
        audienceCount: 12,
        excludedCount: 1,
        sampleUserIds: [otherUserId],
        sample: [],
        notificationLanguages: ['en', 'es'],
        exclusionCounts: { inactiveMembers: 1, selectorMismatch: 0 },
        normalizedSpec: commandInput.audienceSpec,
        snapshotBasis: 'active_members_at_publish',
        generatedAt: '2026-08-04T08:00:00.000Z',
      };
    case 'createHandoff':
      return { handoffId: 'handoff-created', versionId: 'handoff-created-version' };
    case 'correctHandoff':
      return {
        versionId: 'handoff-corrected-version',
        versionNumber: 2,
        sourceMessageIds: commandInput.sourceMessageIds,
        sourceFingerprint: 'handoff-source-fingerprint',
        acknowledgementDueAt: commandInput.acknowledgementDueAt,
      };
    case 'saveContact':
      return { alias: commandInput.alias, isFavorite: commandInput.isFavorite };
    case 'queryRoleAssignments':
      return [roleAssignment];
    case 'assignAdminRole':
      return roleAssignment;
    case 'exportAudit':
      return {
        receiptId: 'audit-export-a',
        format: commandInput.format,
        contentType: 'text/csv',
        fileName: 'audit.csv',
        rowCount: 1,
        payloadBytes: 20,
        sha256: 'a'.repeat(64),
        createdAt: '2026-08-04T08:00:00.000Z',
        payload: 'event_type\nmember.read',
      };
    case 'issueInvitation':
      return {
        inviteId: 'invite-a',
        destinationType: commandInput.destinationType,
        destinationMasked: 'm***@example.com',
        role: commandInput.role,
        activationMode: commandInput.activationMode,
        expiresAt: '2026-08-05T08:00:00.000Z',
        activationToken: null,
        employeeCode: null,
        membershipType: commandInput.membershipType,
        membershipAccessExpiresAt: null,
        guestSponsorUserId: null,
      };
    case 'loadOrganizationPreferences':
    case 'updateOrganizationPreferences':
      return organizationPreferences;
    case 'listSessions':
      return [{
        sessionId: 'session-other',
        current: false,
        platform: 'web',
        device: null,
        createdAt: '2026-08-01T08:00:00.000Z',
        lastUsedAt: '2026-08-04T08:00:00.000Z',
        expiresAt: null,
        revoked: false,
        aal: 'aal2',
        signal: { sameNetworkAsCurrent: true, clientFamily: 'desktop' },
      }];
    case 'updateOrganizationPolicy':
      return richWorkspaceSnapshot().organizationPolicy;
    case 'getOrganizationAiPolicy':
      return organizationAiPolicy;
    case 'updateOrganizationAiPolicy':
      return { ...organizationAiPolicy, policyVersion: 2 };
    case 'listDynamicGroupPolicies':
      return { policies: [], nextAfterPolicyId: null };
    case 'saveDynamicGroupPolicy':
      return {
        policyId: '10000000-0000-4000-8000-000000000001',
        conversationId: conversationBId,
        version: 1,
        draftState: 'draft',
        selectorFingerprint: 'a'.repeat(64),
        requiresPreview: true,
        publishedVersionId: null,
      };
    case 'previewDynamicGroupPolicy':
      return { policyId: commandInput.policyId, policyVersion: 1, previewFingerprint: 'b'.repeat(64) };
    case 'publishDynamicGroupPolicy':
      return { policyId: commandInput.policyId, policyVersion: 1, status: 'active' };
    case 'pauseDynamicGroupPolicy':
      return { policyId: commandInput.policyId, policyVersion: 2, status: 'paused' };
    case 'getDeviceNotificationPreferences':
    case 'updateDeviceNotificationPreferences':
      return devicePreferences;
    default:
      return { ok: true };
  }
}

function controlledSendOutbox(
  id: string,
  body: string,
  state: OutboxCommand['state'] = 'queued',
  attempts = 0,
): OutboxCommand {
  return {
    id,
    organizationId: '70000000-0000-4000-8000-000000000007',
    userId,
    kind: 'send_message',
    payload: {
      organizationId: '70000000-0000-4000-8000-000000000007',
      conversationId: conversationBId,
      clientMessageId: id,
      body,
      languageCode: 'en',
      idempotencyKey: id,
    },
    createdAt: '2026-08-04T08:00:00.000Z',
    attempts,
    state,
    ...(state === 'failed' ? { lastErrorCode: 'network_error' } : {}),
  };
}

let observedWorkspace: ReturnType<typeof useWorkspace> | null = null;

function WorkspaceProbe() {
  const workspace = useWorkspace();
  useEffect(() => {
    observedWorkspace = workspace;
  }, [workspace]);
  return (
    <Text>
      {workspace.status}:{workspace.organizationName}:{workspace.conversations.length}
    </Text>
  );
}

function currentWorkspace() {
  if (!observedWorkspace) throw new Error('WorkspaceProvider has not published state.');
  return observedWorkspace;
}

beforeEach(() => {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  observedWorkspace = null;
  controlledOutbox = [];
  mockRealtimeOptions = null;
  mockOfflineCacheEnabled = false;
  mockAuth = {
    assuranceLevel: 'aal2',
    endAccess: mockEndAccess,
    mode: 'native',
    realtimeToken: 'controlled-realtime-token',
    session: { access_token: 'controlled-access-token' },
    sessionId: 'session-a',
    signOut: jest.fn(async () => undefined),
    user: { id: userId },
  };
  mockLoadWorkspace.mockImplementation(async () => workspaceSnapshot());
  mockLoadMessages.mockImplementation(async () => ({ items: [], cursor: null }));
  mockListOutbox.mockImplementation(async () => controlledOutbox);
  mockEnqueue.mockImplementation(async (command: OutboxCommand) => {
    controlledOutbox = [...controlledOutbox.filter((item) => item.id !== command.id), command];
  });
  mockUpdateOutbox.mockImplementation(async (command: OutboxCommand) => {
    controlledOutbox = controlledOutbox.map((item) => item.id === command.id ? command : item);
  });
  mockRemoveOutbox.mockImplementation(async (id: string) => {
    controlledOutbox = controlledOutbox.filter((item) => item.id !== id);
  });
  mockPurgeUser.mockImplementation(async () => undefined);
  mockGetCache.mockImplementation(async () => null);
  mockPutCache.mockImplementation(async () => undefined);
  mockRemoveCache.mockImplementation(async () => undefined);
  mockEndAccess.mockImplementation(async () => undefined);
  mockPrepareAttachment.mockImplementation(async () => ({
    uri: 'file://controlled',
    bytes: new ArrayBuffer(1),
    byteSize: 1,
    sha256Hex: '00112233445566778899aabbccddeeff',
    name: 'controlled.jpg',
    mimeType: 'image/jpeg',
    temporary: false,
  }));
  mockOptimizeImageAttachment.mockImplementation(async (input: unknown) => input);
  mockUploadAttachment.mockImplementation(async () => undefined);
  mockCleanupPreparedAttachment.mockImplementation(async () => undefined);
  mockGetCurrentInstallationId.mockImplementation(async () => null);
  mockRequestDeviceRegistration.mockImplementation(async () => null);
  mockQueryAudit.mockImplementation(async () => ({ events: [], nextCursor: null }));
  mockSearchUsers.mockImplementation(async () => []);
  mockCommand.mockImplementation(async () => undefined);
});

describe('authoritative workspace provider', () => {
  test('fails closed when there is no authenticated identity', async () => {
    mockAuth.user = null;
    await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText(
      'error::0',
    )).toBeTruthy());
    expect(currentWorkspace().currentUser).toBeNull();
    expect(currentWorkspace().error).toBe('Connect the Newone identity and data service to continue.');
    expect(mockLoadWorkspace).not.toHaveBeenCalled();
  });

  test('rejects every server-backed operation when authoritative workspace identity is absent', async () => {
    mockAuth.user = null;
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('error::0')).toBeTruthy());

    const message = controlledMessage();
    const ownMessage = controlledMessage({ isOwn: true });
    const summary = richWorkspaceSnapshot().summaries[0];
    const conversation = workspaceSnapshot().conversations[0];
    const joinRequest = controlledJoinRequest({ conversationId: conversation.id });
    const audienceSpec: UpdateAudienceSpec = {
      company: true,
      conversationMembers: false,
      siteIds: [],
      departmentIds: [],
      teamIds: [],
      unitIds: [],
      operationalRoles: [],
      membershipRoles: [],
      languages: [],
      currentShiftOnly: false,
    };
    const results: unknown[] = [];

    await act(async () => {
      results.push(await currentWorkspace().loadOlderMessages(conversation.id));
      await currentWorkspace().observeConversation(conversation.id);
      await currentWorkspace().markConversationRead(conversation.id);
      results.push(await currentWorkspace().ensureMessageLoaded(conversation.id, 'missing-message'));
      results.push(await currentWorkspace().requestTranslation(message));
      results.push(await currentWorkspace().proposeTranslationCorrection(message, 'Corrected text'));
      results.push(await currentWorkspace().reviewTranslationCorrection(message, 'rejected'));
      results.push(await currentWorkspace().requestConversationSummary(conversation.id, [message.serverId as string]));
      results.push(await currentWorkspace().correctConversationSummary(summary, 'Topic', 'Summary'));
      results.push(await currentWorkspace().reviewConversationSummary(summary.id, 'reject'));
      results.push(await currentWorkspace().reportAiOutputError({
        outputKind: 'translation',
        translationId: 'translation-a',
        category: 'other',
        details: 'Controlled details',
        highConsequence: false,
        qualityUseConsent: false,
      }));
      results.push(await currentWorkspace().loadMyAiOutputErrorReports());
      results.push(await currentWorkspace().loadAiOutputReviewQueue());
      results.push(await currentWorkspace().readAiOutputErrorReport('report-a'));
      results.push(await currentWorkspace().reviewAiOutputErrorReport(
        'report-a', 1, 'not_an_error', 'Controlled review',
      ));
      results.push(await currentWorkspace().proposeAiRegressionExample({
        reportId: 'report-a',
        expectedReportVersion: 1,
        sourceLanguage: 'es',
        deidentifiedSourceText: 'Source',
        deidentifiedObservedOutput: 'Observed',
        deidentifiedExpectedOutput: 'Expected',
      }));
      results.push(await currentWorkspace().decideAiRegressionExample(
        'example-a', 1, 'rejected', 'Controlled decision',
      ));
      results.push(await currentWorkspace().setConversationSummaryPolicy(conversation.id, 'manual'));
      results.push(await currentWorkspace().openOrCreateDirectConversation(otherUserId));
      results.push(await currentWorkspace().queryGroupCreationCandidates());
      results.push(await currentWorkspace().queryConversationMemberCandidates(conversation.id));
      results.push(await currentWorkspace().createGroupConversation({
        name: 'Controlled Group',
        kind: 'group',
        historyPolicy: 'all',
        postingMode: 'all_members',
        joinPolicy: 'approval_required',
        members: [{ membershipId: otherUserId, role: 'member' }],
      }));
      results.push(await currentWorkspace().uploadConversationAvatar(
        conversation.id,
        { uri: 'file://controlled.jpg', name: 'controlled.jpg', mimeType: 'image/jpeg' },
      ));
      results.push(await currentWorkspace().removeConversationAvatar(conversation.id));
      await currentWorkspace().sendMessage(conversation.id, 'Controlled message');
      results.push(await currentWorkspace().editOutboxMessage('missing-outbox', 'Edited'));
      results.push(await currentWorkspace().retryOutboxMessage('missing-outbox'));
      results.push(await currentWorkspace().cancelOutboxMessage('missing-outbox'));
      results.push(await currentWorkspace().sendAttachment(
        conversation.id,
        { uri: 'file://controlled.pdf', name: 'controlled.pdf', mimeType: 'application/pdf' },
        'Controlled caption',
      ));
      results.push(await currentWorkspace().cancelAttachmentUpload(message));
      results.push(await currentWorkspace().retryAttachmentUpload(message));
      results.push(await currentWorkspace().editMessage(ownMessage, 'Edited'));
      results.push(await currentWorkspace().deleteMessage(ownMessage));
      results.push(await currentWorkspace().hideMessageForMe(message));
      results.push(await currentWorkspace().forwardMessage(message, conversation.id));
      results.push(await currentWorkspace().placeMessagePreservationHold({
        conversationId: conversation.id,
        messageId: message.serverId as string,
        holdType: 'legal',
        reasonCode: 'LEGAL_REVIEW',
        policyReferenceSha256: 'a'.repeat(64),
      }));
      results.push(await currentWorkspace().releaseMessagePreservationHold('hold-a', 'RELEASED'));
      results.push(await currentWorkspace().toggleReaction(message, '✅'));
      results.push(await currentWorkspace().setMessagePinned(message, true));
      results.push(await currentWorkspace().reportMessage(message, 'other', undefined, {
        consentToShare: true,
        contextBefore: 0,
        contextAfter: 0,
        noticeVersion: 'moderation-report-v2',
      }));
      results.push(await currentWorkspace().reportGroup(conversation, 'other', undefined, {
        consentToShare: true,
        noticeVersion: 'moderation-report-v2',
      }));
      results.push(await currentWorkspace().reportMember(otherUserId, 'other', undefined, {
        consentToShare: true,
        noticeVersion: 'moderation-report-v2',
      }));
      results.push(await currentWorkspace().proposeAction(message, 'Controlled action'));
      results.push(await currentWorkspace().confirmAction('action-a', otherUserId));
      results.push(await currentWorkspace().transitionAction('action-a', 'cancelled'));
      results.push(await currentWorkspace().downloadAttachment(message));
      results.push(await currentWorkspace().updateConversation(conversation.id, { name: 'Updated' }));
      results.push(await currentWorkspace().updateConversationPreferences(conversation.id, { isPinned: true }));
      results.push(await currentWorkspace().updateProfile({ displayName: 'Renamed Employee' }));
      results.push(await currentWorkspace().updateConversationControls(conversation.id, {
        postingMode: 'admins_only', reason: 'Controlled reason',
      }));
      results.push(await currentWorkspace().requestConversationJoin(conversation.id));
      results.push(await currentWorkspace().cancelConversationJoinRequest(joinRequest));
      results.push(await currentWorkspace().loadConversationJoinRequests(conversation.id));
      results.push(await currentWorkspace().decideConversationJoinRequest(
        joinRequest, 'rejected', 'Controlled reason',
      ));
      results.push(await currentWorkspace().addConversationMember(conversation.id, otherUserId, 'member'));
      results.push(await currentWorkspace().removeConversationMember(conversation.id, otherUserId));
      results.push(await currentWorkspace().updateConversationMemberRole(
        conversation.id, otherUserId, 'member', 'admin',
      ));
      results.push(await currentWorkspace().leaveConversation(conversation.id, otherUserId));
      results.push(await currentWorkspace().closeIncident(conversation.id, 'Controlled reason'));
      results.push(await currentWorkspace().publishUpdate({
        conversationId: conversation.id,
        title: 'Controlled update',
        body: 'Controlled body',
        priority: 'normal',
        requiresAcknowledgement: false,
        notificationClass: 'routine',
        audienceSpec,
      }));
      results.push(await currentWorkspace().previewUpdateAudience(conversation.id, audienceSpec));
      results.push(await currentWorkspace().cancelScheduledUpdate('update-a', 'Controlled reason'));
      await currentWorkspace().acknowledgeUpdate('update-a');
      results.push(await currentWorkspace().createHandoff({
        conversationId: conversation.id,
        title: 'Controlled handoff',
        details: 'Controlled details',
        shiftStartedAt: '2026-08-04T08:00:00.000Z',
        shiftEndedAt: '2026-08-04T16:00:00.000Z',
        sourceMessageIds: [message.serverId as string],
      }));
      results.push(await currentWorkspace().correctHandoff('handoff-a', {
        expectedVersionId: 'version-a',
        expectedVersionNumber: 1,
        title: 'Controlled handoff',
        details: 'Controlled details',
        shiftStartedAt: '2026-08-04T08:00:00.000Z',
        shiftEndedAt: '2026-08-04T16:00:00.000Z',
        sourceMessageIds: [message.serverId as string],
        reason: 'Controlled reason',
      }));
      results.push(await currentWorkspace().signHandoff('handoff-a'));
      results.push(await currentWorkspace().acknowledgeHandoff('handoff-a', {
        expectedVersionId: 'version-a', expectedVersionNumber: 1,
      }));
      await currentWorkspace().updateConnection(otherUserId);
      results.push(await currentWorkspace().respondConnection(otherUserId, 'declined'));
      results.push(await currentWorkspace().removeConnection(otherUserId));
      results.push(await currentWorkspace().saveContact(otherUserId, 'Alias', false));
      results.push(await currentWorkspace().removeSavedContact(otherUserId));
      results.push(await currentWorkspace().setPersonBlocked(otherUserId, true));
      results.push(await currentWorkspace().loadRoleAssignments(otherUserId));
      results.push(await currentWorkspace().queryAudit({
        reasonCode: 'security_review',
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-05T00:00:00.000Z',
      }));
      results.push(await currentWorkspace().exportAudit({
        reasonCode: 'security_review',
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-05T00:00:00.000Z',
        format: 'json',
      }));
      results.push(await currentWorkspace().assignRole(otherUserId, {
        roleName: 'security_admin', scopeType: 'organization', unitId: null,
        expiresAt: null, reason: 'Controlled reason',
      }));
      results.push(await currentWorkspace().revokeRole('assignment-a', 'Controlled reason'));
      results.push(await currentWorkspace().issueInvitation({
        destinationType: 'email',
        destination: 'member@example.com',
        activationMode: 'otp',
        role: 'member',
        expiresInSeconds: 3_600,
        membershipType: 'employee',
        membershipAccessExpiresAt: null,
        guestSponsorUserId: null,
      }));
      results.push(await currentWorkspace().suspendMember(otherUserId, 'Controlled reason'));
      results.push(await currentWorkspace().revokeSession('session-a', 'Controlled reason'));
      await currentWorkspace().loadAccountSettings();
      results.push(await currentWorkspace().saveOrganizationPreferences({ soundEnabled: false }));
      results.push(await currentWorkspace().updateOrganizationPolicy({
        messageRetentionDays: 365,
        allowMemberDirectMessages: true,
        dmPolicy: 'directory_open',
        requireMfaForAdmins: true,
        shiftScheduleAuthoritative: true,
        groupCreationPolicy: 'managers',
        allowExternalGuests: false,
        externalGuestMaxAccessDays: 30,
        version: 1,
        reason: 'Controlled reason',
      }));
      results.push(await currentWorkspace().loadOrganizationAiPolicy());
      results.push(await currentWorkspace().updateOrganizationAiPolicy({
        enabled: true,
        approvedUseCases: ['translation'],
        providerAllowlist: ['openrouter'],
        routePolicy: 'approved_zero_retention',
        reason: 'Controlled reason',
      }));
      results.push(await currentWorkspace().loadDynamicGroupPolicies());
      results.push(await currentWorkspace().saveDynamicGroupPolicy({
        conversationId: conversation.id,
        expectedVersion: 0,
        policySpec: {
          siteIds: [], departmentIds: [], teamIds: [], lineIds: [], unitIds: [],
          includeDescendants: false, operationalRoles: [], membershipRoles: ['member'],
          shiftMode: 'none', scheduledShiftStartsAt: null, scheduledShiftEndsAt: null,
        },
        maximumMembers: 100,
      }));
      results.push(await currentWorkspace().previewDynamicGroupPolicy('policy-a', 1));
      results.push(await currentWorkspace().publishDynamicGroupPolicy('policy-a', 1, 'a'.repeat(64)));
      results.push(await currentWorkspace().pauseDynamicGroupPolicy('policy-a', 1, 'Controlled reason'));
      results.push(await currentWorkspace().loadDeviceNotificationPreferences());
      results.push(await currentWorkspace().saveDeviceNotificationPreferences({ soundEnabled: false }));
      results.push(await currentWorkspace().enableNotifications());
    });

    expect(results.filter((result) => result !== false && result !== null && result !== undefined))
      .toEqual([[]]);
    expect(mockCommand).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockPrepareAttachment).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('enforces restricted membership and capability boundaries before command execution', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.currentMembershipRole = 'member';
    snapshot.capabilities = ['communications.publish'];
    snapshot.scopes = [];
    snapshot.conversations = snapshot.conversations.map((item) => ({
      ...item,
      canManage: false,
      canManageConversation: false,
    }));
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());
    mockCommand.mockClear();
    mockQueryAudit.mockClear();

    const conversation = snapshot.conversations[0];
    const message = snapshot.messages['conversation-a'][0];
    const joinRequest = controlledJoinRequest({ conversationId: conversation.id });
    const results: unknown[] = [];
    await act(async () => {
      results.push(await currentWorkspace().queryConversationMemberCandidates(conversation.id));
      results.push(await currentWorkspace().uploadConversationAvatar(
        conversation.id,
        { uri: 'file://controlled.jpg', name: 'controlled.jpg', mimeType: 'image/jpeg' },
      ));
      results.push(await currentWorkspace().removeConversationAvatar(conversation.id));
      results.push(await currentWorkspace().placeMessagePreservationHold({
        conversationId: conversation.id,
        messageId: message.serverId as string,
        holdType: 'legal',
        reasonCode: 'LEGAL_REVIEW',
        policyReferenceSha256: 'a'.repeat(64),
      }));
      results.push(await currentWorkspace().releaseMessagePreservationHold('hold-a', 'RELEASED'));
      results.push(await currentWorkspace().confirmAction('action-existing', otherUserId));
      results.push(await currentWorkspace().updateConversation(conversation.id, { name: 'Restricted' }));
      results.push(await currentWorkspace().updateConversationControls(conversation.id, {
        postingMode: 'admins_only', reason: 'Controlled reason',
      }));
      results.push(await currentWorkspace().loadConversationJoinRequests(conversation.id));
      results.push(await currentWorkspace().decideConversationJoinRequest(
        joinRequest, 'rejected', 'Controlled reason',
      ));
      results.push(await currentWorkspace().addConversationMember(
        conversation.id, availableUserId, 'admin',
      ));
      results.push(await currentWorkspace().removeConversationMember(conversation.id, otherUserId));
      results.push(await currentWorkspace().updateConversationMemberRole(
        conversation.id, otherUserId, 'member', 'admin',
      ));
      results.push(await currentWorkspace().closeIncident(incidentConversationId, 'Controlled reason'));
      results.push(await currentWorkspace().loadRoleAssignments(otherUserId));
      results.push(await currentWorkspace().queryAudit({
        reasonCode: 'security_review',
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-05T00:00:00.000Z',
      }));
      results.push(await currentWorkspace().exportAudit({
        reasonCode: 'security_review',
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-05T00:00:00.000Z',
        format: 'json',
      }));
      results.push(await currentWorkspace().assignRole(otherUserId, {
        roleName: 'security_admin',
        scopeType: 'organization',
        unitId: null,
        expiresAt: null,
        reason: 'Controlled reason',
      }));
      results.push(await currentWorkspace().revokeRole('assignment-a', 'Controlled reason'));
      results.push(await currentWorkspace().issueInvitation({
        destinationType: 'email',
        destination: 'member@example.com',
        activationMode: 'otp',
        role: 'member',
        expiresInSeconds: 3_600,
        membershipType: 'employee',
        membershipAccessExpiresAt: null,
        guestSponsorUserId: null,
      }));
      results.push(await currentWorkspace().suspendMember(otherUserId, 'Controlled reason'));
      results.push(await currentWorkspace().updateOrganizationPolicy({
        messageRetentionDays: 365,
        allowMemberDirectMessages: true,
        dmPolicy: 'directory_open',
        requireMfaForAdmins: true,
        shiftScheduleAuthoritative: true,
        groupCreationPolicy: 'managers',
        allowExternalGuests: false,
        externalGuestMaxAccessDays: 30,
        version: 1,
        reason: 'Controlled reason',
      }));
      results.push(await currentWorkspace().loadOrganizationAiPolicy());
      results.push(await currentWorkspace().updateOrganizationAiPolicy({
        enabled: true,
        approvedUseCases: ['translation'],
        providerAllowlist: ['openrouter'],
        routePolicy: 'approved_zero_retention',
        reason: 'Controlled reason',
      }));
      results.push(await currentWorkspace().loadDynamicGroupPolicies());
      results.push(await currentWorkspace().saveDynamicGroupPolicy({
        conversationId: conversation.id,
        expectedVersion: 0,
        policySpec: {
          siteIds: [], departmentIds: [], teamIds: [], lineIds: [], unitIds: [],
          includeDescendants: false, operationalRoles: [], membershipRoles: ['member'],
          shiftMode: 'none', scheduledShiftStartsAt: null, scheduledShiftEndsAt: null,
        },
        maximumMembers: 100,
      }));
      results.push(await currentWorkspace().previewDynamicGroupPolicy('policy-a', 1));
      results.push(await currentWorkspace().publishDynamicGroupPolicy('policy-a', 1, 'a'.repeat(64)));
      results.push(await currentWorkspace().pauseDynamicGroupPolicy('policy-a', 1, 'Controlled reason'));
      results.push(await currentWorkspace().saveDeviceNotificationPreferences({ soundEnabled: false }));
      results.push(await currentWorkspace().enableNotifications());
    });

    expect(results.filter((result) => result !== false && result !== null && result !== undefined))
      .toEqual([[]]);
    expect(mockCommand).not.toHaveBeenCalled();
    expect(mockQueryAudit).not.toHaveBeenCalled();
    expect(mockPrepareAttachment).not.toHaveBeenCalled();
    expect(currentWorkspace().hasCapability('audit.read')).toBe(false);
    expect(currentWorkspace().hasCapability('communications.publish', 'unit-restricted')).toBe(false);
    await view.unmount();
  });

  test('validates scoped messaging, group, membership, handoff, and admin invariants locally', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.conversations = snapshot.conversations.map((item) => ({ ...item, avatarPath: null }));
    const template = snapshot.conversations[0];
    snapshot.conversations.push(
      { ...template, id: 'direct-invalid', kind: 'direct', directParticipantId: otherUserId },
      { ...template, id: 'policy-invalid', policyManaged: true },
      { ...template, id: 'readonly-invalid', isReadOnly: true },
      { ...template, id: 'no-manage-invalid', canManage: false, canManageConversation: false },
      { ...template, id: 'management-invalid', managementOnly: true },
      { ...template, id: 'posting-invalid', canPost: false },
      {
        ...template,
        id: 'no-transfer-invalid',
        departure: {
          eligible: true,
          restriction: null,
          requiresOwnershipTransfer: false,
          historyPreserved: true,
          futureAccessRevoked: true,
        },
      },
    );
    for (const conversation of snapshot.conversations) {
      snapshot.messages[conversation.id] ??= [];
      snapshot.cursors[conversation.id] ??= null;
    }
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText(
      `ready:Controlled Company:${snapshot.conversations.length}`,
    )).toBeTruthy());
    mockCommand.mockClear();

    const incoming = snapshot.messages['conversation-a'][0];
    const own = snapshot.messages['conversation-a'][1];
    const deletedIncoming = { ...incoming, deleted: true };
    const deletedOwn = { ...own, deleted: true };
    const noServer = { ...incoming, serverId: undefined };
    const disclosedMessage = {
      consentToShare: true as const,
      contextBefore: 0 as const,
      contextAfter: 0 as const,
      noticeVersion: 'moderation-report-v2' as const,
    };
    const disclosedEntity = {
      consentToShare: true as const,
      noticeVersion: 'moderation-report-v2' as const,
    };
    const invalidResults: unknown[] = [];

    await act(async () => {
      const groupBase = {
        name: 'Controlled Group',
        kind: 'group' as const,
        historyPolicy: 'all' as const,
        postingMode: 'all_members' as const,
        joinPolicy: 'approval_required' as const,
        members: [{ membershipId: availableUserId, role: 'member' as const }],
      };
      invalidResults.push(await currentWorkspace().createGroupConversation({
        ...groupBase, members: [],
      }));
      invalidResults.push(await currentWorkspace().createGroupConversation({
        ...groupBase,
        members: [
          { membershipId: availableUserId, role: 'member' },
          { membershipId: availableUserId, role: 'admin' },
        ],
      }));
      invalidResults.push(await currentWorkspace().createGroupConversation({
        ...groupBase, members: [{ membershipId: userId, role: 'member' }],
      }));
      invalidResults.push(await currentWorkspace().createGroupConversation({
        ...groupBase, kind: 'shift',
      }));
      invalidResults.push(await currentWorkspace().createGroupConversation({
        ...groupBase, kind: 'incident', joinPolicy: 'invite_only',
      }));
      invalidResults.push(await currentWorkspace().createGroupConversation({
        ...groupBase, incidentSeverity: 'high', incidentClassification: 'equipment',
      }));

      await currentWorkspace().sendMessage('conversation-a', '   ');
      await currentWorkspace().sendMessage('missing-conversation', 'Message');
      await currentWorkspace().sendMessage('management-invalid', 'Message');
      await currentWorkspace().sendMessage('posting-invalid', 'Message');
      await currentWorkspace().sendMessage('readonly-invalid', 'Message');
      await currentWorkspace().sendMessage('conversation-a', 'Message', undefined, ['unknown-member']);

      invalidResults.push(await currentWorkspace().editMessage(noServer, 'Edited'));
      invalidResults.push(await currentWorkspace().editMessage(incoming, 'Edited'));
      invalidResults.push(await currentWorkspace().editMessage(deletedOwn, 'Edited'));
      invalidResults.push(await currentWorkspace().editMessage(own, '   '));
      invalidResults.push(await currentWorkspace().deleteMessage(noServer));
      invalidResults.push(await currentWorkspace().deleteMessage(incoming));
      invalidResults.push(await currentWorkspace().deleteMessage(deletedOwn));
      invalidResults.push(await currentWorkspace().hideMessageForMe(noServer));
      invalidResults.push(await currentWorkspace().hideMessageForMe(deletedIncoming));
      invalidResults.push(await currentWorkspace().forwardMessage(noServer, conversationBId));
      invalidResults.push(await currentWorkspace().forwardMessage(deletedIncoming, conversationBId));
      invalidResults.push(await currentWorkspace().forwardMessage({
        ...incoming,
        attachment: {
          id: 'attachment-a', kind: 'document', name: 'file.pdf', mimeType: 'application/pdf', byteSize: 10,
          status: 'clean',
        },
      }, conversationBId));
      invalidResults.push(await currentWorkspace().forwardMessage(incoming, 'missing-conversation'));
      invalidResults.push(await currentWorkspace().toggleReaction(noServer, '✅'));
      invalidResults.push(await currentWorkspace().toggleReaction(deletedIncoming, '✅'));
      invalidResults.push(await currentWorkspace().setMessagePinned(noServer, true));
      invalidResults.push(await currentWorkspace().setMessagePinned(deletedIncoming, true));
      invalidResults.push(await currentWorkspace().reportMessage(noServer, 'other', undefined, disclosedMessage));
      invalidResults.push(await currentWorkspace().reportMessage(own, 'other', undefined, disclosedMessage));
      invalidResults.push(await currentWorkspace().reportMessage(deletedIncoming, 'other', undefined, disclosedMessage));
      invalidResults.push(await currentWorkspace().reportMessage(incoming, 'other'));
      invalidResults.push(await currentWorkspace().reportGroup(
        snapshot.conversations.find((item) => item.id === 'direct-invalid')!,
        'other', undefined, disclosedEntity,
      ));
      invalidResults.push(await currentWorkspace().reportGroup(template, 'other'));
      invalidResults.push(await currentWorkspace().reportMember('', 'other', undefined, disclosedEntity));
      invalidResults.push(await currentWorkspace().reportMember(userId, 'other', undefined, disclosedEntity));
      invalidResults.push(await currentWorkspace().reportMember(otherUserId, 'other'));
      invalidResults.push(await currentWorkspace().proposeAction(noServer, 'Action'));
      invalidResults.push(await currentWorkspace().proposeAction(deletedIncoming, 'Action'));
      invalidResults.push(await currentWorkspace().proposeAction(incoming, '   '));
      invalidResults.push(await currentWorkspace().confirmAction('action-existing', 'missing-person'));
      invalidResults.push(await currentWorkspace().downloadAttachment({ ...incoming, attachment: undefined }));
      invalidResults.push(await currentWorkspace().downloadAttachment({
        ...incoming,
        attachment: {
          id: 'attachment-a', kind: 'document', name: 'file.pdf', mimeType: 'application/pdf', byteSize: 10,
          status: 'blocked',
        },
      }));

      invalidResults.push(await currentWorkspace().updateConversation('missing-conversation', { name: 'X' }));
      invalidResults.push(await currentWorkspace().updateConversation('direct-invalid', { name: 'X' }));
      invalidResults.push(await currentWorkspace().updateConversation('no-manage-invalid', { name: 'X' }));
      invalidResults.push(await currentWorkspace().updateConversationControls('no-manage-invalid', {
        postingMode: 'admins_only', reason: 'Controlled reason',
      }));
      invalidResults.push(await currentWorkspace().updateConversationControls('policy-invalid', {
        postingMode: 'admins_only', reason: 'Controlled reason',
      }));
      invalidResults.push(await currentWorkspace().updateConversationControls(incidentConversationId, {
        postingMode: 'admins_only', reason: 'Controlled reason',
      }));
      invalidResults.push(await currentWorkspace().requestConversationJoin('missing-conversation'));
      invalidResults.push(await currentWorkspace().cancelConversationJoinRequest(
        controlledJoinRequest({ status: 'approved' }),
      ));
      invalidResults.push(await currentWorkspace().loadConversationJoinRequests('no-manage-invalid'));
      invalidResults.push(await currentWorkspace().loadConversationJoinRequests('policy-invalid'));
      invalidResults.push(await currentWorkspace().loadConversationJoinRequests(incidentConversationId));
      invalidResults.push(await currentWorkspace().decideConversationJoinRequest(
        controlledJoinRequest({ conversationId: 'no-manage-invalid' }), 'rejected', 'Controlled reason',
      ));
      invalidResults.push(await currentWorkspace().decideConversationJoinRequest(
        controlledJoinRequest({ conversationId: 'policy-invalid' }), 'rejected', 'Controlled reason',
      ));
      invalidResults.push(await currentWorkspace().decideConversationJoinRequest(
        controlledJoinRequest({ conversationId: 'conversation-a' }), 'rejected', 'x',
      ));
      invalidResults.push(await currentWorkspace().addConversationMember(
        'conversation-a', otherUserId, 'member',
      ));
      invalidResults.push(await currentWorkspace().addConversationMember(
        'policy-invalid', availableUserId, 'member',
      ));
      invalidResults.push(await currentWorkspace().removeConversationMember(
        'conversation-a', userId,
      ));
      invalidResults.push(await currentWorkspace().removeConversationMember(
        'conversation-a', availableUserId,
      ));
      invalidResults.push(await currentWorkspace().updateConversationMemberRole(
        'conversation-a', otherUserId, 'admin', 'member',
      ));
      invalidResults.push(await currentWorkspace().updateConversationMemberRole(
        'conversation-a', otherUserId, 'member', 'member',
      ));
      invalidResults.push(await currentWorkspace().leaveConversation('missing-conversation'));
      invalidResults.push(await currentWorkspace().leaveConversation(conversationBId));
      invalidResults.push(await currentWorkspace().leaveConversation(conversationBId, userId));
      invalidResults.push(await currentWorkspace().leaveConversation(conversationBId, availableUserId));
      invalidResults.push(await currentWorkspace().leaveConversation('no-transfer-invalid', otherUserId));
      invalidResults.push(await currentWorkspace().closeIncident('conversation-a', 'Controlled reason'));
      invalidResults.push(await currentWorkspace().closeIncident('readonly-invalid', 'Controlled reason'));
      invalidResults.push(await currentWorkspace().closeIncident('no-manage-invalid', 'Controlled reason'));
      invalidResults.push(await currentWorkspace().closeIncident(incidentConversationId, 'x'));
    });

    expect(invalidResults.filter((result) => result !== false && result !== null))
      .toEqual([[], [], []]);
    expect(mockCommand).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('tears down the local workspace only after authoritative current-session revocation', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.conversations = snapshot.conversations.map((item) => ({ ...item, avatarPath: null }));
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    let revoked = false;
    await act(async () => {
      revoked = await currentWorkspace().revokeSession('session-a', 'Secure this account');
    });
    expect(revoked).toBe(true);
    expect(mockCommand).toHaveBeenCalledWith('revokeSession', expect.objectContaining({
      sessionId: 'session-a',
    }));
    expect(mockAuth.signOut).toHaveBeenCalledTimes(1);
    expect(currentWorkspace().currentUser).toBeNull();
    expect(currentWorkspace().selectedConversationId).toBe('');
    await view.unmount();
  });

  test('rolls back guest messaging and acknowledgement state on a real transport outage', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.currentUser = {
      ...snapshot.currentUser,
      membershipType: 'guest',
      accessExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      guestSponsorUserId: otherUserId,
    };
    snapshot.conversations = snapshot.conversations.map((item) => ({ ...item, avatarPath: null }));
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      if (method === 'sendMessage' || method === 'acknowledgeUpdate') {
        throw new RepositoryError('Controlled network outage', 'network_unavailable', true);
      }
      return controlledCommandResponse(method, input);
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    await act(async () => {
      await currentWorkspace().sendMessage('conversation-a', 'Guest online delivery');
      await currentWorkspace().acknowledgeUpdate('update-scheduled');
    });
    expect(currentWorkspace().updates.find((item) => item.id === 'update-scheduled')?.acknowledged)
      .toBe(false);
    expect(currentWorkspace().messages['conversation-a'].some((item) => (
      item.isOwn && item.deliveryState === 'failed'
    ))).toBe(true);
    expect(currentWorkspace().connectivity).toBe('offline');
    expect(currentWorkspace().actionError).toBe('errors.guestOnlineRequired');
    expect(mockEnqueue).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('rolls back and deduplicates durable employee receipt progression', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.conversations = snapshot.conversations.map((item) => ({
      ...item,
      avatarPath: null,
      ...(item.id === 'conversation-a' ? { unreadCount: 3, lastReadMessageId: null } : {}),
    }));
    snapshot.messages['conversation-a'] = [
      controlledMessage({
        id: 'message-already-read',
        serverId: '90000000-0000-4000-8000-000000000007',
        deliveryState: 'read',
      }),
      controlledMessage({
        id: 'message-already-delivered',
        serverId: '90000000-0000-4000-8000-000000000008',
        deliveryState: 'delivered',
      }),
      controlledMessage({
        id: 'message-awaiting-delivery',
        serverId: '90000000-0000-4000-8000-000000000009',
        deliveryState: 'sent',
      }),
    ];
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    const queueFailure = new RepositoryError(
      'Controlled encrypted outbox write failure',
      'storage_unavailable',
      true,
    );
    mockEnqueue.mockRejectedValueOnce(queueFailure);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    await act(async () => currentWorkspace().observeConversation('conversation-a'));
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    await act(async () => currentWorkspace().observeConversation('conversation-a'));
    await waitFor(() => expect(mockCommand).toHaveBeenCalledWith(
      'markMessageReceipt',
      expect.objectContaining({ state: 'delivered' }),
    ));
    await act(async () => currentWorkspace().observeConversation('conversation-a'));
    expect(mockEnqueue).toHaveBeenCalledTimes(2);

    mockEnqueue.mockRejectedValueOnce(queueFailure);
    await act(async () => currentWorkspace().markConversationRead('conversation-a'));
    expect(currentWorkspace().conversations.find((item) => item.id === 'conversation-a')?.unreadCount)
      .toBe(3);
    await act(async () => currentWorkspace().markConversationRead('conversation-a'));
    await waitFor(() => expect(mockCommand).toHaveBeenCalledWith(
      'markMessageReceipt',
      expect.objectContaining({ state: 'read' }),
    ));
    await act(async () => currentWorkspace().markConversationRead('conversation-a'));
    expect(mockEnqueue).toHaveBeenCalledTimes(4);
    expect(currentWorkspace().conversations.find((item) => item.id === 'conversation-a')?.unreadCount)
      .toBe(0);
    await view.unmount();
  });

  test('rolls back and retries online-only guest receipt progression', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.currentUser = {
      ...snapshot.currentUser,
      membershipType: 'guest',
      accessExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      guestSponsorUserId: otherUserId,
    };
    snapshot.conversations = snapshot.conversations.map((item) => ({
      ...item,
      avatarPath: null,
      ...(item.id === 'conversation-a' ? { unreadCount: 1, lastReadMessageId: null } : {}),
    }));
    snapshot.messages['conversation-a'] = [controlledMessage({ deliveryState: 'sent' })];
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    let rejectNextReceipt = true;
    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      if (method === 'markMessageReceipt' && rejectNextReceipt) {
        rejectNextReceipt = false;
        throw new RepositoryError('Controlled network outage', 'network_unavailable', true);
      }
      return controlledCommandResponse(method, input);
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    await act(async () => currentWorkspace().observeConversation('conversation-a'));
    expect(currentWorkspace().connectivity).toBe('offline');
    await act(async () => currentWorkspace().observeConversation('conversation-a'));
    await act(async () => currentWorkspace().observeConversation('conversation-a'));
    expect(mockCommand.mock.calls.filter(([method]) => method === 'markMessageReceipt')).toHaveLength(2);
    expect(currentWorkspace().messages['conversation-a'][0]?.deliveryState).toBe('delivered');

    rejectNextReceipt = true;
    await act(async () => currentWorkspace().markConversationRead('conversation-a'));
    expect(currentWorkspace().conversations.find((item) => item.id === 'conversation-a')?.unreadCount)
      .toBe(1);
    await act(async () => currentWorkspace().markConversationRead('conversation-a'));
    await act(async () => currentWorkspace().markConversationRead('conversation-a'));
    expect(mockCommand.mock.calls.filter(([method]) => method === 'markMessageReceipt')).toHaveLength(4);
    expect(currentWorkspace().messages['conversation-a'][0]?.deliveryState).toBe('read');
    await view.unmount();
  });

  test('enforces a future contractor access deadline and revalidates against authority', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.currentUser = {
      ...snapshot.currentUser,
      membershipType: 'contractor',
      accessExpiresAt: new Date(Date.now() + 120).toISOString(),
      guestSponsorUserId: null,
    };
    snapshot.conversations = snapshot.conversations.map((item) => ({ ...item, avatarPath: null }));
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());
    await waitFor(() => expect(mockEndAccess).toHaveBeenCalled(), { timeout: 1_500 });
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    expect(mockLoadWorkspace.mock.calls.length).toBeGreaterThanOrEqual(2);
    await view.unmount();
  });

  test('distinguishes optional device authorization from account-settings transport failure', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.conversations = snapshot.conversations.map((item) => ({ ...item, avatarPath: null }));
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockGetCurrentInstallationId.mockImplementation(async () => devicePreferences.installationId);
    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      if (method === 'getDeviceNotificationPreferences') {
        throw new RepositoryError('Device preference denied', 'forbidden', false, undefined, 403);
      }
      return controlledCommandResponse(method, input);
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    await act(async () => currentWorkspace().loadAccountSettings());
    expect(currentWorkspace().organizationPreferences).toEqual(organizationPreferences);
    expect(currentWorkspace().deviceNotificationPreferences).toBeNull();
    expect(currentWorkspace().actionError).toBeNull();

    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      if (method === 'loadOrganizationPreferences') {
        throw new RepositoryError('Controlled network outage', 'network_unavailable', true);
      }
      return controlledCommandResponse(method, input);
    });
    await act(async () => currentWorkspace().loadAccountSettings());
    expect(currentWorkspace().actionError).toBe('errors.network');
    expect(currentWorkspace().connectivity).toBe('offline');
    await view.unmount();
  });

  test('rejects each invalid handoff timeline, correction, and acknowledgement conflict locally', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.conversations = snapshot.conversations.map((item) => ({ ...item, avatarPath: null }));
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());
    mockCommand.mockClear();

    const sourceMessageId = '90000000-0000-4000-8000-000000000009';
    const validCreate = {
      conversationId: 'conversation-a',
      title: 'Day shift handoff',
      details: 'Valve inspection remains open.',
      shiftStartedAt: '2026-08-04T08:00:00.000Z',
      shiftEndedAt: '2026-08-04T16:00:00.000Z',
      sourceMessageIds: [sourceMessageId],
      acknowledgementDueAt: '2026-08-04T17:00:00.000Z',
    };
    const invalidCreates = [
      { ...validCreate, title: '   ' },
      { ...validCreate, details: '   ' },
      { ...validCreate, shiftStartedAt: 'not-a-date' },
      { ...validCreate, shiftEndedAt: 'not-a-date' },
      { ...validCreate, shiftEndedAt: validCreate.shiftStartedAt },
      { ...validCreate, sourceMessageIds: ['unknown-message'] },
      { ...validCreate, acknowledgementDueAt: 'not-a-date' },
      { ...validCreate, acknowledgementDueAt: validCreate.shiftEndedAt },
    ];
    for (const input of invalidCreates) {
      await act(async () => expect(await currentWorkspace().createHandoff(input)).toBe(false));
    }

    const validCorrection = {
      expectedVersionId: 'handoff-version-sign',
      expectedVersionNumber: 1,
      title: 'Corrected day shift',
      details: 'Valve inspection remains open and assigned.',
      shiftStartedAt: '2026-08-04T08:00:00.000Z',
      shiftEndedAt: '2026-08-04T16:00:00.000Z',
      sourceMessageIds: [sourceMessageId],
      acknowledgementDueAt: '2026-08-04T17:00:00.000Z',
      reason: 'Clarify ownership',
    };
    await act(async () => {
      expect(await currentWorkspace().correctHandoff('handoff-sign', {
        ...validCorrection,
        expectedVersionId: 'stale-version',
      })).toBe(false);
      expect(await currentWorkspace().correctHandoff('handoff-sign', {
        ...validCorrection,
        expectedVersionNumber: 0,
      })).toBe(false);
    });
    const invalidCorrections = [
      { ...validCorrection, title: ' ' },
      { ...validCorrection, title: 'x'.repeat(241) },
      { ...validCorrection, details: ' ' },
      { ...validCorrection, details: 'x'.repeat(30_001) },
      { ...validCorrection, reason: 'x' },
      { ...validCorrection, reason: 'x'.repeat(2_001) },
      { ...validCorrection, shiftStartedAt: 'not-a-date' },
      { ...validCorrection, shiftEndedAt: 'not-a-date' },
      { ...validCorrection, shiftEndedAt: validCorrection.shiftStartedAt },
      { ...validCorrection, sourceMessageIds: ['unknown-message'] },
      { ...validCorrection, acknowledgementDueAt: 'not-a-date' },
      { ...validCorrection, acknowledgementDueAt: validCorrection.shiftEndedAt },
    ];
    for (const input of invalidCorrections) {
      await act(async () => expect(
        await currentWorkspace().correctHandoff('handoff-sign', input),
      ).toBe(false));
    }

    await act(async () => {
      expect(await currentWorkspace().acknowledgeHandoff('handoff-ack', {
        expectedVersionId: 'stale-version',
        expectedVersionNumber: 2,
      })).toBe(false);
      expect(await currentWorkspace().acknowledgeHandoff('handoff-ack', {
        expectedVersionId: 'handoff-version-ack',
        expectedVersionNumber: 1,
      })).toBe(false);
      expect(await currentWorkspace().acknowledgeHandoff('handoff-ack', {
        expectedVersionId: 'handoff-version-ack',
        expectedVersionNumber: 2,
        note: 'x'.repeat(2_001),
      })).toBe(false);
    });
    expect(mockCommand.mock.calls.filter(([method]) => (
      method === 'createHandoff' || method === 'correctHandoff' || method === 'acknowledgeHandoff'
    ))).toHaveLength(0);
    expect(currentWorkspace().actionError).toBe('errors.conflict');
    await view.unmount();
  });

  test('loads a real repository snapshot and publishes nullable-safe workspace state', async () => {
    await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:1')).toBeTruthy());

    expect(mockLoadWorkspace).toHaveBeenCalledWith(userId, null);
    expect(currentWorkspace().currentUser?.id).toBe(userId);
    expect(currentWorkspace().organizationId).toBe('70000000-0000-4000-8000-000000000007');
    expect(currentWorkspace().offlineQueueAvailable).toBe(true);
    expect(currentWorkspace().selectedConversationId).toBe('conversation-a');
    expect(currentWorkspace().hasCapability('communications.publish')).toBe(true);
    expect(currentWorkspace().hasCapability('audit.read')).toBe(false);
  });

  test('updates local navigation controls without inventing server data', async () => {
    await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:1')).toBeTruthy());

    await act(async () => {
      currentWorkspace().setInboxFilter('unread');
      currentWorkspace().setInboxSearch('operations');
      currentWorkspace().selectConversation('conversation-a');
    });
    expect(currentWorkspace().inboxFilter).toBe('unread');
    expect(currentWorkspace().inboxSearch).toBe('operations');
    expect(currentWorkspace().selectedConversationId).toBe('conversation-a');
  });

  test('opens an existing direct conversation but rejects unauthorized targets', async () => {
    const snapshot = workspaceSnapshot();
    snapshot.conversations.push({
      id: 'direct-a',
      directParticipantId: otherUserId,
      title: 'Connected Employee',
      initials: 'CO',
      avatarColor: '#654321',
      kind: 'direct',
      subtitle: 'Supervisor',
      lastMessage: 'Hello',
      lastActivity: 'now',
      unreadCount: 0,
      pinned: false,
      favorite: false,
      muted: false,
    });
    snapshot.messages['direct-a'] = [];
    snapshot.cursors['direct-a'] = null;
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:2')).toBeTruthy());

    let directConversationId: string | null = null;
    await act(async () => {
      directConversationId = await currentWorkspace().openOrCreateDirectConversation(otherUserId);
      await currentWorkspace().refresh();
    });
    expect(directConversationId).toBe('direct-a');
    await expect(currentWorkspace().openOrCreateDirectConversation('missing-person')).resolves.toBeNull();
    expect(mockCommand).not.toHaveBeenCalledWith('createDirectConversation', expect.anything());
  });

  test('loads older messages through the authorized read repository and merges them', async () => {
    const olderMessage = {
      id: 'message-older',
      conversationId: 'conversation-a',
      senderId: otherUserId,
      senderName: 'Connected Employee',
      senderInitials: 'CO',
      senderColor: '#654321',
      originalText: 'Earlier work item',
      sourceLanguage: 'en' as const,
      translationState: 'not_requested' as const,
      sentAt: '08:00',
      isOwn: false,
      deliveryState: 'delivered' as const,
      priority: 'normal' as const,
    };
    const snapshot = workspaceSnapshot();
    snapshot.cursors['conversation-a'] = 'cursor-a';
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockLoadMessages.mockImplementation(async () => ({ items: [olderMessage], cursor: null }));
    await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:1')).toBeTruthy());

    let loaded = false;
    await act(async () => {
      loaded = await currentWorkspace().loadOlderMessages('conversation-a');
    });
    expect(loaded).toBe(true);
    expect(mockLoadMessages).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-a',
      after: 'cursor-a',
    }));
    expect(currentWorkspace().messages['conversation-a']).toEqual([olderMessage]);
    expect(currentWorkspace().messagePagination['conversation-a']).toEqual({
      hasMore: false,
      loading: false,
    });
  });

  test('runs translation, summary, and consented AI quality-review workflows through commands', async () => {
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    const message = snapshot.messages['conversation-a'][0];
    const summary = snapshot.summaries[0];
    const results: boolean[] = [];
    await act(async () => {
      results.push(await currentWorkspace().requestTranslation(message));
      results.push(await currentWorkspace().proposeTranslationCorrection(
        message,
        'The valve remains open',
        'Preserve the operational nuance',
      ));
      results.push(await currentWorkspace().reviewTranslationCorrection(
        message,
        'approved',
        'Verified against the source',
      ));
      results.push(await currentWorkspace().requestConversationSummary(
        'conversation-a',
        [message.serverId as string],
      ));
      results.push(await currentWorkspace().correctConversationSummary(
        summary,
        'Valve status',
        'The valve remains open and requires inspection.',
      ));
      results.push(await currentWorkspace().reviewConversationSummary(
        summary.id,
        'approve',
        'Evidence links verified',
      ));
      results.push(await currentWorkspace().reportAiOutputError({
        outputKind: 'translation',
        translationId: 'translation-a',
        category: 'incorrect_meaning',
        details: ' Safety-relevant meaning changed. ',
        highConsequence: true,
        qualityUseConsent: true,
      }));
      results.push(await currentWorkspace().loadMyAiOutputErrorReports());
      results.push(await currentWorkspace().loadAiOutputReviewQueue());
      results.push(await currentWorkspace().readAiOutputErrorReport('report-a'));
      results.push(await currentWorkspace().reviewAiOutputErrorReport(
        'report-a',
        1,
        'needs_context',
        'Need the preceding instruction',
      ));
      results.push(await currentWorkspace().proposeAiRegressionExample({
        reportId: 'report-a',
        expectedReportVersion: 2,
        sourceLanguage: 'es',
        deidentifiedSourceText: 'Source text',
        deidentifiedObservedOutput: 'Observed output',
        deidentifiedExpectedOutput: 'Expected output',
      }));
      results.push(await currentWorkspace().decideAiRegressionExample(
        'example-a',
        1,
        'approved',
        'Safe and deidentified',
      ));
      results.push(await currentWorkspace().setConversationSummaryPolicy(
        'conversation-a',
        'message_count',
        20,
      ));
    });

    expect(results).toEqual(Array.from({ length: results.length }, () => true));
    expect(mockCommand).toHaveBeenCalledWith('requestTranslation', expect.objectContaining({
      messageId: message.serverId,
      targetLanguage: 'en',
    }));
    expect(mockCommand).toHaveBeenCalledWith('reportAiOutputError', expect.objectContaining({
      details: 'Safety-relevant meaning changed.',
      consentVersion: 'quality-use-consent-v1',
    }));
    expect(mockCommand).toHaveBeenCalledWith('setSummaryPolicy', expect.objectContaining({
      messageCountThreshold: 20,
    }));
    await view.unmount();
  });

  test('orchestrates secure messaging, membership, moderation, and incident operations', async () => {
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    const incoming = snapshot.messages['conversation-a'][0];
    const own = snapshot.messages['conversation-a'][1];
    const group = snapshot.conversations[0];
    const joinRequest = controlledJoinRequest({ conversationId: 'conversation-a' });
    const operationResults: (boolean | string | null)[] = [];
    let groupCandidates: unknown = null;
    let memberCandidates: unknown = null;
    let joinRequests: ConversationJoinRequest[] = [];

    await act(async () => {
      operationResults.push(await currentWorkspace().openOrCreateDirectConversation(otherUserId));
      groupCandidates = await currentWorkspace().queryGroupCreationCandidates('  response  ');
      memberCandidates = await currentWorkspace().queryConversationMemberCandidates(
        'conversation-a',
        '  available  ',
      );
      operationResults.push(await currentWorkspace().createGroupConversation({
        name: ' Response Team ',
        description: ' Coordinated response ',
        kind: 'group',
        historyPolicy: 'all',
        postingMode: 'all_members',
        joinPolicy: 'approval_required',
        members: [{ membershipId: 'membership-available', role: 'member' }],
      }));
      await currentWorkspace().observeConversation('conversation-a');
      await currentWorkspace().markConversationRead('conversation-a');
      await currentWorkspace().sendMessage(
        'conversation-a',
        '  Confirming the inspection  ',
        incoming,
        [otherUserId],
      );
      operationResults.push(await currentWorkspace().uploadConversationAvatar(
        'conversation-a',
        {
          uri: 'file://controlled-avatar.jpg',
          name: 'controlled-avatar.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
          width: 640,
          height: 640,
        },
      ));
      operationResults.push(await currentWorkspace().removeConversationAvatar('conversation-a'));
      operationResults.push(await currentWorkspace().sendAttachment(
        'conversation-a',
        {
          uri: 'file://controlled-photo.jpg',
          name: 'controlled-photo.jpg',
          mimeType: 'image/jpeg',
          size: 2048,
        },
        'Inspection photo',
      ));
      operationResults.push(await currentWorkspace().editMessage(own, 'Inspection in progress'));
      operationResults.push(await currentWorkspace().deleteMessage(own));
      operationResults.push(await currentWorkspace().hideMessageForMe(incoming));
      operationResults.push(await currentWorkspace().forwardMessage(own, conversationBId));
      operationResults.push(await currentWorkspace().placeMessagePreservationHold({
        conversationId: 'conversation-a',
        messageId: incoming.serverId as string,
        holdType: 'incident_preservation',
        reasonCode: 'SAFETY_REVIEW',
        policyReferenceSha256: 'A'.repeat(64),
      }));
      operationResults.push(await currentWorkspace().releaseMessagePreservationHold(
        'HOLD-A',
        'CASE_CLOSED',
      ));
      operationResults.push(await currentWorkspace().toggleReaction(incoming, '✅'));
      operationResults.push(await currentWorkspace().setMessagePinned(incoming, true));
      operationResults.push(await currentWorkspace().reportMessage(
        incoming,
        'privacy',
        ' Contains private information ',
        {
          consentToShare: true,
          contextBefore: 1,
          contextAfter: 1,
          noticeVersion: 'moderation-report-v2',
        },
      ));
      operationResults.push(await currentWorkspace().reportGroup(
        group,
        'spam',
        ' Unexpected bulk content ',
        { consentToShare: true, noticeVersion: 'moderation-report-v2' },
      ));
      operationResults.push(await currentWorkspace().reportMember(
        'membership-other',
        'harassment',
        ' Repeated unwanted contact ',
        { consentToShare: true, noticeVersion: 'moderation-report-v2' },
      ));
      operationResults.push(await currentWorkspace().proposeAction(
        incoming,
        ' Inspect valve ',
        ' Verify lockout state ',
      ));
      operationResults.push(await currentWorkspace().confirmAction(
        'action-existing',
        otherUserId,
        '2026-08-05T09:00:00.000Z',
      ));
      operationResults.push(await currentWorkspace().transitionAction(
        'action-existing',
        'in_progress',
        'Inspection started',
      ));
      operationResults.push(await currentWorkspace().downloadAttachment(incoming));
      operationResults.push(await currentWorkspace().updateConversation(
        'conversation-a',
        { name: 'Response Operations', description: 'Coordinated response' },
      ));
      operationResults.push(await currentWorkspace().updateConversationPreferences(
        'conversation-a',
        {
          isFavorite: true,
          isPinned: true,
          notificationLevel: 'mentions',
          mutedUntil: '2026-08-05T08:00:00.000Z',
          translationMode: 'off',
        },
      ));
      operationResults.push(await currentWorkspace().updateConversationControls(
        'conversation-a',
        {
          postingMode: 'admins_only',
          joinPolicy: 'approval_required',
          visibility: 'organization',
          reason: 'Restrict operational posting',
        },
      ));
      operationResults.push(await currentWorkspace().requestConversationJoin(discoverableConversationId));
      operationResults.push(await currentWorkspace().cancelConversationJoinRequest(
        controlledJoinRequest(),
      ));
      joinRequests = await currentWorkspace().loadConversationJoinRequests('conversation-a');
      operationResults.push(await currentWorkspace().decideConversationJoinRequest(
        joinRequest,
        'approved',
        'Verified team assignment',
      ));
      operationResults.push(await currentWorkspace().addConversationMember(
        'conversation-a',
        availableUserId,
        'admin',
      ));
      operationResults.push(await currentWorkspace().removeConversationMember(
        'conversation-a',
        otherUserId,
      ));
      operationResults.push(await currentWorkspace().updateConversationMemberRole(
        'conversation-a',
        otherUserId,
        'member',
        'admin',
      ));
      operationResults.push(await currentWorkspace().leaveConversation(conversationBId, otherUserId));
      operationResults.push(await currentWorkspace().closeIncident(
        incidentConversationId,
        'Incident stabilized',
      ));
    });

    expect(operationResults.every(Boolean)).toBe(true);
    expect(groupCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: availableUserId }),
    ]));
    expect(memberCandidates).toEqual(expect.objectContaining({ nextCursor: null }));
    expect(joinRequests).toHaveLength(1);
    expect(openUrl).toHaveBeenCalledWith('https://storage.invalid/controlled-download');
    expect(mockCommand).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      body: 'Confirming the inspection',
      mentionUserIds: [otherUserId],
      replyToMessageId: incoming.serverId,
    }));
    await waitFor(() => expect(mockCommand).toHaveBeenCalledWith(
      'completeAttachmentUpload',
      expect.objectContaining({ byteSize: 1 }),
    ));
    await view.unmount();
  });

  test('runs updates, handoffs, directory, authorization, and policy administration', async () => {
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockGetCurrentInstallationId.mockImplementation(async () => devicePreferences.installationId);
    mockRequestDeviceRegistration.mockImplementation(async () => ({
      organizationId: snapshot.organizationId,
      installationId: devicePreferences.installationId,
      platform: 'ios',
      pushToken: 'ExponentPushToken[controlled]',
      pushTokenType: 'expo',
      pushProjectId: 'controlled-project',
      pushEnvironment: 'development',
      idempotencyKey: 'device-register-controlled',
    }));
    mockQueryAudit.mockImplementation(async () => ({
      items: [],
      nextCursor: null,
      hasMore: false,
      snapshotAt: '2026-08-04T08:00:00.000Z',
      filterSha256: 'a'.repeat(64),
      receiptId: 'audit-receipt-a',
    }));
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    const audienceSpec = {
      company: true,
      conversationMembers: false,
      siteIds: [],
      departmentIds: [],
      teamIds: [],
      unitIds: [],
      operationalRoles: [],
      membershipRoles: ['member' as const],
      languages: ['en'],
      currentShiftOnly: false,
    };
    const results: (boolean | object | null)[] = [];
    let auditPage: unknown = null;
    let auditExport: unknown = null;
    let invitation: unknown = null;
    let aiPolicy: unknown = null;

    await act(async () => {
      results.push(await currentWorkspace().publishUpdate({
        conversationId: 'conversation-a',
        title: ' Planned maintenance ',
        body: ' Maintenance begins at 18:00. ',
        priority: 'important',
        requiresAcknowledgement: true,
        notificationClass: 'urgent',
        audienceSpec,
      }));
      results.push(await currentWorkspace().previewUpdateAudience('conversation-a', audienceSpec));
      results.push(await currentWorkspace().cancelScheduledUpdate(
        'update-scheduled',
        'Schedule changed',
      ));
      await currentWorkspace().acknowledgeUpdate('update-scheduled');
      results.push(await currentWorkspace().createHandoff({
        conversationId: 'conversation-a',
        title: 'Day shift handoff',
        details: 'Valve inspection remains open.',
        shiftStartedAt: '2026-08-04T08:00:00.000Z',
        shiftEndedAt: '2026-08-04T16:00:00.000Z',
        sourceMessageIds: ['90000000-0000-4000-8000-000000000009'],
        acknowledgementDueAt: '2026-08-04T17:00:00.000Z',
      }));
      results.push(await currentWorkspace().correctHandoff('handoff-sign', {
        expectedVersionId: 'handoff-version-sign',
        expectedVersionNumber: 1,
        title: 'Corrected day shift',
        details: 'Valve inspection remains open and assigned.',
        shiftStartedAt: '2026-08-04T08:00:00.000Z',
        shiftEndedAt: '2026-08-04T16:00:00.000Z',
        sourceMessageIds: ['90000000-0000-4000-8000-000000000009'],
        acknowledgementDueAt: '2026-08-04T17:00:00.000Z',
        reason: 'Clarify ownership',
      }));
      results.push(await currentWorkspace().signHandoff('handoff-sign'));
      results.push(await currentWorkspace().acknowledgeHandoff('handoff-ack', {
        expectedVersionId: 'handoff-version-ack',
        expectedVersionNumber: 2,
        note: 'Received and understood',
      }));
      await currentWorkspace().updateConnection(availableUserId);
      results.push(await currentWorkspace().respondConnection(incomingUserId, 'accepted'));
      results.push(await currentWorkspace().removeConnection(otherUserId));
      results.push(await currentWorkspace().saveContact(otherUserId, ' Shift partner ', true));
      results.push(await currentWorkspace().removeSavedContact(otherUserId));
      results.push(await currentWorkspace().setPersonBlocked(otherUserId, true));
      results.push(await currentWorkspace().loadRoleAssignments(otherUserId));
      auditPage = await currentWorkspace().queryAudit({
        reasonCode: 'security_review',
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-05T00:00:00.000Z',
        limit: 50,
      });
      auditExport = await currentWorkspace().exportAudit({
        reasonCode: 'compliance_review',
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-05T00:00:00.000Z',
        format: 'csv',
      });
      results.push(await currentWorkspace().assignRole(otherUserId, {
        roleName: 'security_admin',
        scopeType: 'organization',
        unitId: null,
        expiresAt: null,
        reason: 'Security response coverage',
      }));
      results.push(await currentWorkspace().revokeRole('assignment-a', 'Rotation completed'));
      invitation = await currentWorkspace().issueInvitation({
        destinationType: 'email',
        destination: ' MEMBER@EXAMPLE.COM ',
        activationMode: 'otp',
        role: 'member',
        expiresInSeconds: 3600,
        membershipType: 'employee',
        membershipAccessExpiresAt: null,
        guestSponsorUserId: null,
      });
      results.push(await currentWorkspace().suspendMember(otherUserId, 'Security investigation'));
      await currentWorkspace().loadAccountSettings();
      results.push(await currentWorkspace().saveOrganizationPreferences({ soundEnabled: false }));
      results.push(await currentWorkspace().updateOrganizationPolicy({
        messageRetentionDays: 365,
        allowMemberDirectMessages: true,
        dmPolicy: 'directory_open',
        requireMfaForAdmins: true,
        shiftScheduleAuthoritative: true,
        groupCreationPolicy: 'managers',
        allowExternalGuests: false,
        externalGuestMaxAccessDays: 30,
        version: 1,
        reason: 'Controlled organization policy update',
      }));
      aiPolicy = await currentWorkspace().loadOrganizationAiPolicy();
      results.push(await currentWorkspace().loadDynamicGroupPolicies());
      results.push(await currentWorkspace().saveDynamicGroupPolicy({
        conversationId: conversationBId,
        expectedVersion: 0,
        policySpec: {
          siteIds: [],
          departmentIds: [],
          teamIds: [],
          lineIds: [],
          unitIds: [],
          includeDescendants: false,
          operationalRoles: [],
          membershipRoles: ['member'],
          shiftMode: 'none',
          scheduledShiftStartsAt: null,
          scheduledShiftEndsAt: null,
        },
        maximumMembers: 100,
      }) as object);
      results.push(await currentWorkspace().previewDynamicGroupPolicy(
        '10000000-0000-4000-8000-000000000001',
        1,
      ) as object);
      results.push(await currentWorkspace().publishDynamicGroupPolicy(
        '10000000-0000-4000-8000-000000000001',
        1,
        'b'.repeat(64),
      ) as object);
      results.push(await currentWorkspace().pauseDynamicGroupPolicy(
        '10000000-0000-4000-8000-000000000001',
        1,
        'Scheduled maintenance',
      ) as object);
      results.push(await currentWorkspace().loadDeviceNotificationPreferences());
      results.push(await currentWorkspace().enableNotifications());
      results.push(await currentWorkspace().revokeSession('session-other', 'No longer authorized'));
    });

    await act(async () => {
      results.push(await currentWorkspace().updateOrganizationAiPolicy({
        enabled: true,
        approvedUseCases: ['language_detection', 'summary', 'translation'],
        providerAllowlist: ['openrouter'],
        routePolicy: 'approved_zero_retention',
        reason: 'Approved zero-retention route',
      }) as object);
      results.push(await currentWorkspace().saveDeviceNotificationPreferences({ soundEnabled: false }));
    });

    expect(results.every(Boolean)).toBe(true);
    expect(auditPage).toEqual(expect.objectContaining({ hasMore: false }));
    expect(auditExport).toEqual(expect.objectContaining({ fileName: 'audit.csv' }));
    expect(invitation).toEqual(expect.objectContaining({ destinationMasked: 'm***@example.com' }));
    expect(aiPolicy).toEqual(expect.objectContaining({ providerAllowlist: ['openrouter'] }));
    expect(currentWorkspace().organizationPreferences).toEqual(organizationPreferences);
    expect(currentWorkspace().deviceNotificationPreferences).toEqual(devicePreferences);
    expect(mockCommand).toHaveBeenCalledWith('issueInvitation', expect.objectContaining({
      destination: 'member@example.com',
    }));
    await view.unmount();
  });

  test('hydrates queued and failed messages plus receipt progress from durable storage', async () => {
    const snapshot = richWorkspaceSnapshot();
    const queuedId = '53000000-0000-4000-8000-000000000001';
    const failedId = '53000000-0000-4000-8000-000000000002';
    controlledOutbox = [controlledSendOutbox(queuedId, 'Queued after restart'), controlledSendOutbox(
      failedId,
      'Rejected after restart',
      'failed',
      1,
    ), {
      id: '53000000-0000-4000-8000-000000000003',
      organizationId: snapshot.organizationId,
      userId,
      kind: 'message_receipt',
      payload: {
        organizationId: snapshot.organizationId,
        conversationId: 'conversation-a',
        messageId: '90000000-0000-4000-8000-000000000009',
        state: 'read',
        idempotencyKey: '53000000-0000-4000-8000-000000000003',
      },
      createdAt: '2026-08-04T08:02:00.000Z',
      attempts: 0,
      state: 'queued',
    }];
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    expect(currentWorkspace().messages[conversationBId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientMessageId: queuedId, deliveryState: 'sent' }),
      expect.objectContaining({
        clientMessageId: failedId,
        deliveryState: 'failed',
        failureReason: 'errors.action',
      }),
    ]));
    expect(currentWorkspace().failedOutboxCount).toBe(1);
    await view.unmount();
  });

  test('writes an eligible authoritative snapshot back to encrypted offline storage', async () => {
    mockOfflineCacheEnabled = true;
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());
    await waitFor(() => expect(mockPutCache).toHaveBeenCalled(), { timeout: 1_000 });
    expect(mockPutCache).toHaveBeenCalledWith(
      expect.stringContaining(userId),
      expect.any(String),
      expect.any(String),
    );
    await view.unmount();
  });

  test('marks active conversations read and handles paginated read failures without data loss', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.cursors['conversation-a'] = 'cursor-read';
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    mockLoadMessages.mockImplementation(async () => {
      throw new RepositoryError('Network unavailable', 'network_error', true);
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    await act(async () => {
      await currentWorkspace().markConversationRead('conversation-a');
    });
    expect(currentWorkspace().conversations[0].unreadCount).toBe(0);
    expect(currentWorkspace().messages['conversation-a'][0].deliveryState).toBe('read');
    expect(currentWorkspace().unreadDividerIds['conversation-a']).toBeTruthy();

    let loaded = true;
    await act(async () => {
      loaded = await currentWorkspace().loadOlderMessages('conversation-a');
    });
    expect(loaded).toBe(false);
    expect(currentWorkspace().actionError).toBe('errors.action');
    expect(currentWorkspace().messagePagination['conversation-a'].loading).toBe(false);
    let existingFound = false;
    let missingFound = true;
    await act(async () => {
      existingFound = await currentWorkspace().ensureMessageLoaded(
        'conversation-a',
        '90000000-0000-4000-8000-000000000009',
      );
      missingFound = await currentWorkspace().ensureMessageLoaded('conversation-a', 'missing-message');
    });
    expect(existingFound).toBe(true);
    expect(missingFound).toBe(false);
    await view.unmount();
  });

  test('recovers failed attachment transfers and supports cancellation with server cleanup retry', async () => {
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    mockUploadAttachment.mockImplementationOnce(async () => {
      throw new RepositoryError('Upload unavailable', 'upload_unavailable', true);
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    await act(async () => {
      expect(await currentWorkspace().sendAttachment(
        'conversation-a',
        { uri: 'file://retry.jpg', name: 'retry.jpg', mimeType: 'image/jpeg', size: 2_048 },
        'Retry evidence',
      )).toBe(true);
    });
    await waitFor(() => expect(currentWorkspace().messages['conversation-a'].some(
      (message) => message.attachment?.transfer?.state === 'failed',
    )).toBe(true));
    const failed = currentWorkspace().messages['conversation-a'].find(
      (message) => message.attachment?.transfer?.state === 'failed',
    ) as Message;
    mockUploadAttachment.mockImplementation(async (...args: unknown[]) => {
      const options = args[3] as { onProgress?: (progress: number) => void } | undefined;
      options?.onProgress?.(0.5);
    });
    await act(async () => {
      expect(await currentWorkspace().retryAttachmentUpload(failed)).toBe(true);
    });
    expect(mockCleanupPreparedAttachment).toHaveBeenCalled();

    let rejectUpload: ((reason: unknown) => void) | null = null;
    mockUploadAttachment.mockImplementation(async (...args: unknown[]) => {
      const options = args[3] as { signal?: AbortSignal } | undefined;
      return new Promise<void>((_resolve, reject) => {
        rejectUpload = reject;
        options?.signal?.addEventListener('abort', () => {
          reject(new RepositoryError('Upload cancelled', 'upload_cancelled', false));
        }, { once: true });
      });
    });
    let failCleanupDelete = true;
    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      if (method === 'deleteMessage' && failCleanupDelete) {
        failCleanupDelete = false;
        throw new RepositoryError('Cleanup unavailable', 'network_error', true);
      }
      return controlledCommandResponse(method, input);
    });
    await act(async () => {
      expect(await currentWorkspace().sendAttachment(
        'conversation-a',
        { uri: 'file://cancel.jpg', name: 'cancel.jpg', mimeType: 'image/jpeg', size: 2_048 },
        'Cancellation evidence',
      )).toBe(true);
    });
    await waitFor(() => expect(rejectUpload).not.toBeNull());
    const uploading = currentWorkspace().messages['conversation-a'].find(
      (message) => message.clientMessageId === '50000000-0000-4000-8000-000000000005',
    ) as Message;
    await act(async () => {
      expect(await currentWorkspace().cancelAttachmentUpload(uploading)).toBe(true);
    });
    await waitFor(() => expect(currentWorkspace().messages['conversation-a'].some(
      (message) => message.attachment?.transfer?.state === 'cancelled',
    )).toBe(true));
    const cancelled = currentWorkspace().messages['conversation-a'].find(
      (message) => message.attachment?.transfer?.state === 'cancelled',
    ) as Message;
    await act(async () => {
      expect(await currentWorkspace().cancelAttachmentUpload(cancelled)).toBe(true);
    });
    expect(currentWorkspace().messages['conversation-a'].some(
      (message) => message.clientMessageId === cancelled.clientMessageId,
    )).toBe(false);
    await view.unmount();
  });

  test('replays ambiguous attachment completion without duplicate upload and follows scan backoff', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.conversations = snapshot.conversations.map((item) => ({ ...item, avatarPath: null }));
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    let completionCalls = 0;
    let scanCalls = 0;
    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      if (method === 'completeAttachmentUpload') {
        completionCalls += 1;
        if (completionCalls === 1) {
          throw new RepositoryError('Completion response was lost', 'network_unavailable', true);
        }
      }
      if (method === 'getAttachmentState') {
        scanCalls += 1;
        if (scanCalls === 1) {
          return { attachmentId: '22222222-2222-4222-8222-222222222222', scanStatus: 'pending' };
        }
        if (scanCalls === 2) {
          throw new RepositoryError('Scanner temporarily unavailable', 'network_unavailable', true);
        }
        return {
          attachmentId: '22222222-2222-4222-8222-222222222222',
          scanStatus: scanCalls === 3 ? 'clean' : 'blocked',
        };
      }
      return controlledCommandResponse(method, input);
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    await act(async () => {
      expect(await currentWorkspace().sendAttachment(
        'conversation-a',
        { uri: 'file://ambiguous.jpg', name: 'ambiguous.jpg', mimeType: 'image/jpeg', size: 2_048 },
        'Ambiguous completion evidence',
      )).toBe(true);
    });
    await waitFor(() => expect(currentWorkspace().messages['conversation-a'].some(
      (message) => message.attachment?.transfer?.state === 'failed',
    )).toBe(true));
    const failed = currentWorkspace().messages['conversation-a'].find(
      (message) => message.attachment?.transfer?.state === 'failed',
    ) as Message;
    expect(mockUploadAttachment).toHaveBeenCalledTimes(1);
    expect(mockCommand.mock.calls.filter(([method]) => method === 'createAttachmentUploadGrant'))
      .toHaveLength(1);

    jest.useFakeTimers();
    try {
      await act(async () => {
        expect(await currentWorkspace().retryAttachmentUpload(failed)).toBe(true);
      });
      expect(completionCalls).toBe(2);
      expect(mockUploadAttachment).toHaveBeenCalledTimes(1);
      expect(mockCommand.mock.calls.filter(([method]) => method === 'createAttachmentUploadGrant'))
        .toHaveLength(1);

      await act(async () => {
        jest.advanceTimersByTime(1_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(scanCalls).toBe(1);
      await act(async () => {
        jest.advanceTimersByTime(2_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(scanCalls).toBe(2);
      await act(async () => {
        jest.advanceTimersByTime(4_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(scanCalls).toBe(3);
      expect(currentWorkspace().messages['conversation-a'].find(
        (message) => message.clientMessageId === failed.clientMessageId,
      )?.attachment?.status).toBe('clean');

      mockPrepareAttachment.mockImplementationOnce(async () => ({
        uri: 'file://controlled.pdf',
        bytes: new ArrayBuffer(2),
        byteSize: 2 * 1024 * 1024,
        sha256Hex: 'ffeeddccbbaa99887766554433221100',
        name: 'controlled.pdf',
        mimeType: 'application/pdf',
        temporary: false,
      }));
      await act(async () => {
        expect(await currentWorkspace().sendAttachment(
          'conversation-a',
          { uri: 'file://controlled.pdf', name: 'controlled.pdf', mimeType: 'application/pdf', size: 2 * 1024 * 1024 },
          '   ',
        )).toBe(true);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      expect(completionCalls).toBe(3);
      await act(async () => {
        jest.advanceTimersByTime(1_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(scanCalls).toBe(4);
      expect(currentWorkspace().messages['conversation-a'].find(
        (message) => message.clientMessageId === '50000000-0000-4000-8000-000000000005',
      )?.attachment?.status).toBe('blocked');
      await view.unmount();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('validates avatar content and retries object-not-ready completion before activation', async () => {
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    mockPrepareAttachment.mockImplementationOnce(async () => ({
      uri: 'file://avatar.txt',
      bytes: new ArrayBuffer(1),
      byteSize: 1,
      sha256Hex: '00112233445566778899aabbccddeeff',
      name: 'avatar.txt',
      mimeType: 'text/plain',
      temporary: false,
    }));
    await act(async () => {
      expect(await currentWorkspace().uploadConversationAvatar(
        'conversation-a',
        { uri: 'file://avatar.txt', name: 'avatar.txt', mimeType: 'text/plain' },
      )).toBe(false);
    });

    let completionCalls = 0;
    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      if (method === 'completeAttachmentUpload') {
        completionCalls += 1;
        if (completionCalls === 1) {
          throw new RepositoryError('Object not ready', 'attachment_not_ready', true, undefined, 409);
        }
      }
      return controlledCommandResponse(method, input);
    });
    await act(async () => {
      expect(await currentWorkspace().uploadConversationAvatar(
        'conversation-a',
        { uri: 'file://avatar.jpg', name: 'avatar.jpg', mimeType: 'image/jpeg' },
      )).toBe(true);
    });
    expect(completionCalls).toBe(2);
    expect(mockUploadAttachment).toHaveBeenCalled();

    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      if (method === 'getAttachmentState') {
        return { attachmentId: '22222222-2222-4222-8222-222222222222', scanStatus: 'blocked' };
      }
      return controlledCommandResponse(method, input);
    });
    await act(async () => {
      expect(await currentWorkspace().uploadConversationAvatar(
        'conversation-a',
        { uri: 'file://blocked.jpg', name: 'blocked.jpg', mimeType: 'image/jpeg' },
      )).toBe(false);
    });
    expect(currentWorkspace().actionError).toBe('errors.action');
    await view.unmount();
  });

  test('restores an eligible encrypted offline snapshot after a retryable launch failure', async () => {
    const snapshot = richWorkspaceSnapshot();
    const serialized = serializeOfflineWorkspace(snapshot, Date.now());
    expect(typeof serialized).toBe('string');
    mockOfflineCacheEnabled = true;
    mockGetCache.mockImplementation(async () => serialized);
    mockLoadWorkspace.mockImplementation(async () => {
      throw new RepositoryError('Network unavailable', 'network_error', true);
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );

    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());
    expect(currentWorkspace().connectivity).toBe('offline');
    expect(currentWorkspace().currentUser?.id).toBe(userId);
    expect(mockGetCache).toHaveBeenCalled();
    expect(mockEndAccess).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('rejects corrupt encrypted offline state after a retryable launch failure', async () => {
    mockOfflineCacheEnabled = true;
    mockGetCache.mockImplementation(async () => '{"version":2,"snapshot":');
    mockLoadWorkspace.mockImplementation(async () => {
      throw new RepositoryError('Controlled network outage', 'network_unavailable', true);
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );

    await waitFor(() => expect(screen.getByText('error::0')).toBeTruthy());
    expect(currentWorkspace().currentUser).toBeNull();
    expect(currentWorkspace().connectivity).toBe('offline');
    expect(currentWorkspace().error).toBe('errors.network');
    expect(mockRemoveCache).toHaveBeenCalledWith(expect.stringContaining(userId));
    expect(mockEndAccess).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('fails closed on command-time contractor expiry and evaluates authorization scope expiry', async () => {
    const snapshot = richWorkspaceSnapshot();
    const accessExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
    snapshot.currentUser = {
      ...snapshot.currentUser,
      membershipType: 'contractor',
      accessExpiresAt,
      guestSponsorUserId: null,
    };
    snapshot.conversations = snapshot.conversations.map((item) => ({ ...item, avatarPath: null }));
    snapshot.scopes = [{
      assignmentId: 'scope-organization',
      roleName: 'security_admin',
      scopeType: 'organization',
      unitId: null,
      permissions: ['audit.read'],
      expiresAt: null,
    }, {
      assignmentId: 'scope-active-unit',
      roleName: 'security_admin',
      scopeType: 'unit',
      unitId: 'unit-active',
      permissions: ['communications.publish'],
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    }, {
      assignmentId: 'scope-expired-unit',
      roleName: 'security_admin',
      scopeType: 'unit',
      unitId: 'unit-expired',
      permissions: ['roles.read'],
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    }];
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    expect(currentWorkspace().hasCapability('audit.read', 'unit-unrelated')).toBe(true);
    expect(currentWorkspace().hasCapability('communications.publish', 'unit-active')).toBe(true);
    expect(currentWorkspace().hasCapability('communications.publish', 'unit-other')).toBe(false);
    expect(currentWorkspace().hasCapability('roles.read', 'unit-expired')).toBe(false);

    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(accessExpiresAt) + 1);
    await act(async () => currentWorkspace().sendMessage('conversation-a', 'Must not leave device'));
    expect(currentWorkspace().actionError).toBe('errors.accessEnded');
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    expect(mockEndAccess).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockCommand).not.toHaveBeenCalledWith('sendMessage', expect.anything());
    now.mockRestore();
    await view.unmount();
  });

  test('ends local access on definitive authorization loss and expired contractor entitlement', async () => {
    mockLoadWorkspace.mockImplementation(async () => {
      throw new RepositoryError('Forbidden', 'forbidden', false, undefined, 403);
    });
    const deniedView = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(mockEndAccess).toHaveBeenCalledTimes(1));
    expect(currentWorkspace().currentUser).toBeNull();
    await deniedView.unmount();

    mockEndAccess.mockClear();
    const expired = workspaceSnapshot();
    expired.currentUser.membershipType = 'contractor';
    expired.currentUser.accessExpiresAt = '2026-08-01T00:00:00.000Z';
    mockLoadWorkspace.mockImplementation(async () => expired);
    const expiredView = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(mockEndAccess).toHaveBeenCalledTimes(1));
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    await expiredView.unmount();
  });

  test('uses online-only delivery for guest messages, receipts, and acknowledgements', async () => {
    const snapshot = richWorkspaceSnapshot();
    snapshot.currentUser.membershipType = 'guest';
    snapshot.currentUser.accessExpiresAt = '2026-08-05T20:00:00.000Z';
    snapshot.currentUser.guestSponsorUserId = otherUserId;
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    await act(async () => {
      await currentWorkspace().observeConversation('conversation-a');
      await currentWorkspace().markConversationRead('conversation-a');
      await currentWorkspace().sendMessage('conversation-a', 'Guest online message');
      await currentWorkspace().acknowledgeUpdate('update-scheduled');
    });

    expect(mockCommand).toHaveBeenCalledWith('markMessageReceipt', expect.objectContaining({
      state: 'delivered',
    }));
    expect(mockCommand).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      body: 'Guest online message',
    }));
    expect(mockCommand).toHaveBeenCalledWith('acknowledgeUpdate', expect.objectContaining({
      versionId: 'update-version-a',
    }));
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockPurgeUser).toHaveBeenCalledWith(userId);
    await view.unmount();
  });

  test('reconciles realtime invalidations and publishes connection lifecycle state', async () => {
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    const realtime = mockRealtimeOptions;
    expect(realtime).not.toBeNull();
    await act(async () => {
      (realtime?.onStateChange as (state: 'connected') => void)('connected');
      (realtime?.onInvalidate as () => void)();
      (realtime?.onReconcile as () => void)();
      (realtime?.onAccessEnded as () => void)();
    });
    await waitFor(() => expect(mockLoadWorkspace.mock.calls.length).toBeGreaterThan(1));
    expect(currentWorkspace().realtimeState).toBe('connected');
    expect(mockEndAccess).toHaveBeenCalled();
    await view.unmount();
  });

  test('edits, retries, cancels, and flushes all durable outbox command kinds', async () => {
    const snapshot = richWorkspaceSnapshot();
    const editableId = '51000000-0000-4000-8000-000000000001';
    const retryId = '51000000-0000-4000-8000-000000000002';
    const cancelId = '51000000-0000-4000-8000-000000000003';
    snapshot.messages[conversationBId] = [controlledMessage({
      id: 'local-editable',
      clientMessageId: editableId,
      serverId: undefined,
      conversationId: conversationBId,
      senderId: userId,
      senderName: 'Current Employee',
      senderInitials: 'CE',
      senderColor: '#123456',
      originalText: 'Original queued body',
      translatedText: undefined,
      targetLanguage: undefined,
      translationState: 'queued',
      translation: undefined,
      languageDetection: undefined,
      isOwn: true,
      deliveryState: 'pending',
      attachment: undefined,
    })];
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    controlledOutbox = [controlledSendOutbox(editableId, 'Original queued body')];
    let edited = false;
    await act(async () => {
      edited = await currentWorkspace().editOutboxMessage(editableId, ' Edited queued body ');
    });
    expect(edited).toBe(true);
    await waitFor(() => expect(controlledOutbox).toHaveLength(0));

    controlledOutbox = [controlledSendOutbox(retryId, 'Retry body', 'failed', 2)];
    let retried = false;
    await act(async () => {
      retried = await currentWorkspace().retryOutboxMessage(retryId);
    });
    expect(retried).toBe(true);
    await waitFor(() => expect(controlledOutbox).toHaveLength(0));

    controlledOutbox = [controlledSendOutbox(cancelId, 'Ambiguous body', 'queued', 1)];
    let cancelled = false;
    await act(async () => {
      cancelled = await currentWorkspace().cancelOutboxMessage(cancelId);
    });
    expect(cancelled).toBe(true);
    expect(mockRemoveOutbox).toHaveBeenCalledWith(cancelId);

    controlledOutbox = [{
      id: '51000000-0000-4000-8000-000000000004',
      organizationId: snapshot.organizationId,
      userId,
      kind: 'message_receipt',
      payload: {
        organizationId: snapshot.organizationId,
        conversationId: 'conversation-a',
        messageId: '90000000-0000-4000-8000-000000000009',
        state: 'delivered',
        idempotencyKey: '51000000-0000-4000-8000-000000000004',
      },
      createdAt: '2026-08-04T08:01:00.000Z',
      attempts: 0,
      state: 'queued',
    }, {
      id: '51000000-0000-4000-8000-000000000005',
      organizationId: snapshot.organizationId,
      userId,
      kind: 'acknowledge_update',
      payload: {
        organizationId: snapshot.organizationId,
        versionId: 'update-version-a',
        idempotencyKey: '51000000-0000-4000-8000-000000000005',
      },
      createdAt: '2026-08-04T08:02:00.000Z',
      attempts: 0,
      state: 'queued',
    }, {
      id: '51000000-0000-4000-8000-000000000006',
      organizationId: snapshot.organizationId,
      userId,
      kind: 'register_device',
      payload: {
        organizationId: snapshot.organizationId,
        installationId: devicePreferences.installationId,
        platform: 'ios',
        pushToken: 'ExponentPushToken[controlled]',
        pushTokenType: 'expo',
        pushProjectId: 'controlled-project',
        pushEnvironment: 'development',
        idempotencyKey: '51000000-0000-4000-8000-000000000006',
      },
      createdAt: '2026-08-04T08:03:00.000Z',
      attempts: 0,
      state: 'queued',
    }];
    await act(async () => {
      await currentWorkspace().sendMessage('conversation-a', 'Flush every durable kind');
    });
    expect(controlledOutbox).toHaveLength(0);
    expect(mockCommand).toHaveBeenCalledWith('markMessageReceipt', expect.anything());
    expect(mockCommand).toHaveBeenCalledWith('acknowledgeUpdate', expect.anything());
    expect(mockCommand).toHaveBeenCalledWith('registerDevice', expect.anything());
    await view.unmount();
  });

  test('isolates permanent and retryable outbox failures while preserving authoritative state', async () => {
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      const commandInput = input as Record<string, unknown>;
      if (method === 'markMessageReceipt') {
        throw new RepositoryError('Receipt rejected', 'invalid_request', false, undefined, 400);
      }
      if (method === 'sendMessage' && commandInput.body === 'Permanent failure') {
        throw new RepositoryError('Message rejected', 'message_rejected', false, undefined, 422);
      }
      if (method === 'acknowledgeUpdate') {
        throw new RepositoryError('Acknowledgement rejected', 'invalid_request', false, undefined, 400);
      }
      if (method === 'registerDevice') {
        throw new RepositoryError('Network unavailable', 'network_error', true);
      }
      return controlledCommandResponse(method, input);
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    controlledOutbox = [{
      id: '52000000-0000-4000-8000-000000000001',
      organizationId: snapshot.organizationId,
      userId,
      kind: 'message_receipt',
      payload: {
        organizationId: snapshot.organizationId,
        conversationId: 'conversation-a',
        messageId: '90000000-0000-4000-8000-000000000009',
        state: 'read',
        idempotencyKey: '52000000-0000-4000-8000-000000000001',
      },
      createdAt: '2026-08-04T08:01:00.000Z',
      attempts: 0,
      state: 'queued',
    }, controlledSendOutbox(
      '52000000-0000-4000-8000-000000000002',
      'Permanent failure',
    ), {
      id: '52000000-0000-4000-8000-000000000003',
      organizationId: snapshot.organizationId,
      userId,
      kind: 'acknowledge_update',
      payload: {
        organizationId: snapshot.organizationId,
        versionId: 'update-version-a',
        idempotencyKey: '52000000-0000-4000-8000-000000000003',
      },
      createdAt: '2026-08-04T08:03:00.000Z',
      attempts: 0,
      state: 'queued',
    }, {
      id: '52000000-0000-4000-8000-000000000004',
      organizationId: snapshot.organizationId,
      userId,
      kind: 'register_device',
      payload: {
        organizationId: snapshot.organizationId,
        installationId: devicePreferences.installationId,
        platform: 'ios',
        pushToken: 'ExponentPushToken[controlled]',
        pushTokenType: 'expo',
        pushProjectId: 'controlled-project',
        pushEnvironment: 'development',
        idempotencyKey: '52000000-0000-4000-8000-000000000004',
      },
      createdAt: '2026-08-04T08:04:00.000Z',
      attempts: 0,
      state: 'queued',
    }];

    await act(async () => {
      await currentWorkspace().sendMessage('conversation-a', 'Trigger flush');
    });
    expect(controlledOutbox.some((item) => item.state === 'failed')).toBe(true);
    expect(controlledOutbox.some((item) => item.kind === 'register_device' && item.state === 'queued')).toBe(true);
    expect(currentWorkspace().actionError).toBe('errors.action');
    expect(currentWorkspace().updates.find((item) => item.id === 'update-scheduled')?.acknowledged).toBe(false);
    await view.unmount();
  });

  test('keeps local state fail-closed when authoritative command receipts are absent', async () => {
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async () => null);
    mockQueryAudit.mockImplementation(async () => null);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());
    const incoming = snapshot.messages['conversation-a'][0];
    const own = snapshot.messages['conversation-a'][1];
    const summary = snapshot.summaries[0];
    const joinRequest = controlledJoinRequest({ conversationId: 'conversation-a' });
    const failures: unknown[] = [];

    await act(async () => {
      failures.push(await currentWorkspace().requestTranslation(incoming));
      failures.push(await currentWorkspace().proposeTranslationCorrection(incoming, 'Corrected'));
      failures.push(await currentWorkspace().reviewTranslationCorrection(incoming, 'rejected'));
      failures.push(await currentWorkspace().requestConversationSummary(
        'conversation-a',
        [incoming.serverId as string],
      ));
      failures.push(await currentWorkspace().correctConversationSummary(summary, 'Topic', 'Summary'));
      failures.push(await currentWorkspace().reviewConversationSummary(summary.id, 'reject'));
      failures.push(await currentWorkspace().reportAiOutputError({
        outputKind: 'translation',
        translationId: 'translation-a',
        category: 'other',
        details: 'Valid details',
        highConsequence: false,
        qualityUseConsent: false,
      }));
      failures.push(await currentWorkspace().loadMyAiOutputErrorReports());
      failures.push(await currentWorkspace().loadAiOutputReviewQueue());
      failures.push(await currentWorkspace().readAiOutputErrorReport('report-a'));
      failures.push(await currentWorkspace().reviewAiOutputErrorReport(
        'report-a',
        1,
        'not_an_error',
        'Valid review note',
      ));
      failures.push(await currentWorkspace().proposeAiRegressionExample({
        reportId: 'report-a',
        expectedReportVersion: 1,
        sourceLanguage: 'es',
        deidentifiedSourceText: 'Source',
        deidentifiedObservedOutput: 'Observed',
        deidentifiedExpectedOutput: 'Expected',
      }));
      failures.push(await currentWorkspace().decideAiRegressionExample(
        'example-a',
        1,
        'rejected',
        'Valid decision note',
      ));
      failures.push(await currentWorkspace().openOrCreateDirectConversation(otherUserId));
      failures.push(await currentWorkspace().queryGroupCreationCandidates('response'));
      failures.push(await currentWorkspace().createGroupConversation({
        name: 'Response Team',
        kind: 'group',
        historyPolicy: 'all',
        postingMode: 'all_members',
        joinPolicy: 'approval_required',
        members: [{ membershipId: 'membership-available', role: 'member' }],
      }));
      failures.push(await currentWorkspace().uploadConversationAvatar(
        'conversation-a',
        { uri: 'file://avatar.jpg', name: 'avatar.jpg', mimeType: 'image/jpeg' },
      ));
      failures.push(await currentWorkspace().editMessage(own, 'Edited'));
      failures.push(await currentWorkspace().deleteMessage(own));
      failures.push(await currentWorkspace().hideMessageForMe(incoming));
      failures.push(await currentWorkspace().forwardMessage(own, conversationBId));
      failures.push(await currentWorkspace().placeMessagePreservationHold({
        conversationId: 'conversation-a',
        messageId: incoming.serverId as string,
        holdType: 'legal',
        reasonCode: 'LEGAL_REVIEW',
        policyReferenceSha256: 'a'.repeat(64),
      }));
      failures.push(await currentWorkspace().releaseMessagePreservationHold('hold-a', 'Released'));
      failures.push(await currentWorkspace().toggleReaction(incoming, '✅'));
      failures.push(await currentWorkspace().setMessagePinned(incoming, true));
      failures.push(await currentWorkspace().reportMessage(
        incoming,
        'other',
        undefined,
        { consentToShare: true, contextBefore: 0, contextAfter: 0, noticeVersion: 'moderation-report-v2' },
      ));
      failures.push(await currentWorkspace().reportGroup(
        snapshot.conversations[0],
        'other',
        undefined,
        { consentToShare: true, noticeVersion: 'moderation-report-v2' },
      ));
      failures.push(await currentWorkspace().reportMember(
        'membership-other',
        'other',
        undefined,
        { consentToShare: true, noticeVersion: 'moderation-report-v2' },
      ));
      failures.push(await currentWorkspace().proposeAction(incoming, 'Inspect'));
      failures.push(await currentWorkspace().confirmAction('action-existing', otherUserId));
      failures.push(await currentWorkspace().transitionAction('action-existing', 'cancelled'));
      failures.push(await currentWorkspace().downloadAttachment(incoming));
      failures.push(await currentWorkspace().updateConversation('conversation-a', { name: 'Updated' }));
      failures.push(await currentWorkspace().updateConversationPreferences('conversation-a', { isPinned: true }));
      failures.push(await currentWorkspace().updateConversationControls('conversation-a', {
        postingMode: 'admins_only',
        reason: 'Valid reason',
      }));
      failures.push(await currentWorkspace().requestConversationJoin(discoverableConversationId));
      failures.push(await currentWorkspace().cancelConversationJoinRequest(controlledJoinRequest()));
      failures.push(await currentWorkspace().decideConversationJoinRequest(
        joinRequest,
        'rejected',
        'Valid reason',
      ));
      failures.push(await currentWorkspace().addConversationMember(
        'conversation-a',
        availableUserId,
        'member',
      ));
      failures.push(await currentWorkspace().removeConversationMember(
        'conversation-a',
        otherUserId,
      ));
      failures.push(await currentWorkspace().updateConversationMemberRole(
        'conversation-a',
        otherUserId,
        'member',
        'admin',
      ));
      failures.push(await currentWorkspace().leaveConversation(conversationBId, otherUserId));
      failures.push(await currentWorkspace().closeIncident(incidentConversationId, 'Valid reason'));
      failures.push(await currentWorkspace().publishUpdate({
        conversationId: 'conversation-a',
        title: 'Update',
        body: 'Body',
        priority: 'normal',
        requiresAcknowledgement: false,
        notificationClass: 'routine',
        audienceSpec: {
          company: true,
          conversationMembers: false,
          siteIds: [],
          departmentIds: [],
          teamIds: [],
          unitIds: [],
          operationalRoles: [],
          membershipRoles: [],
          languages: [],
          currentShiftOnly: false,
        },
      }));
      failures.push(await currentWorkspace().previewUpdateAudience('conversation-a', {
        company: true,
        conversationMembers: false,
        siteIds: [],
        departmentIds: [],
        teamIds: [],
        unitIds: [],
        operationalRoles: [],
        membershipRoles: [],
        languages: [],
        currentShiftOnly: false,
      }));
      failures.push(await currentWorkspace().cancelScheduledUpdate('update-scheduled', 'Valid reason'));
      failures.push(await currentWorkspace().createHandoff({
        conversationId: 'conversation-a',
        title: 'Handoff',
        details: 'Details',
        shiftStartedAt: '2026-08-04T08:00:00.000Z',
        shiftEndedAt: '2026-08-04T16:00:00.000Z',
        sourceMessageIds: [incoming.serverId as string],
      }));
      failures.push(await currentWorkspace().correctHandoff('handoff-sign', {
        expectedVersionId: 'handoff-version-sign',
        expectedVersionNumber: 1,
        title: 'Handoff',
        details: 'Details',
        shiftStartedAt: '2026-08-04T08:00:00.000Z',
        shiftEndedAt: '2026-08-04T16:00:00.000Z',
        sourceMessageIds: [incoming.serverId as string],
        reason: 'Valid reason',
      }));
      failures.push(await currentWorkspace().signHandoff('handoff-sign'));
      failures.push(await currentWorkspace().acknowledgeHandoff('handoff-ack', {
        expectedVersionId: 'handoff-version-ack',
        expectedVersionNumber: 2,
      }));
      failures.push(await currentWorkspace().respondConnection(incomingUserId, 'declined'));
      failures.push(await currentWorkspace().removeConnection(otherUserId));
      failures.push(await currentWorkspace().saveContact(otherUserId, '', false));
      failures.push(await currentWorkspace().removeSavedContact(otherUserId));
      failures.push(await currentWorkspace().setPersonBlocked(otherUserId, false));
      failures.push(await currentWorkspace().loadRoleAssignments(otherUserId));
      failures.push(await currentWorkspace().queryAudit({
        reasonCode: 'security_review',
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-05T00:00:00.000Z',
      }));
      failures.push(await currentWorkspace().exportAudit({
        reasonCode: 'security_review',
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-05T00:00:00.000Z',
        format: 'json',
      }));
      failures.push(await currentWorkspace().assignRole(otherUserId, {
        roleName: 'security_admin',
        scopeType: 'organization',
        unitId: null,
        expiresAt: null,
        reason: 'Valid reason',
      }));
      failures.push(await currentWorkspace().revokeRole('assignment-a', 'Valid reason'));
      failures.push(await currentWorkspace().issueInvitation({
        destinationType: 'email',
        destination: 'member@example.com',
        activationMode: 'otp',
        role: 'member',
        expiresInSeconds: 3_600,
        membershipType: 'employee',
        membershipAccessExpiresAt: null,
        guestSponsorUserId: null,
      }));
      failures.push(await currentWorkspace().suspendMember(otherUserId, 'Valid reason'));
      failures.push(await currentWorkspace().revokeSession('session-other', 'Valid reason'));
      failures.push(await currentWorkspace().saveOrganizationPreferences({ soundEnabled: false }));
      failures.push(await currentWorkspace().updateOrganizationPolicy({
        messageRetentionDays: 365,
        allowMemberDirectMessages: true,
        dmPolicy: 'directory_open',
        requireMfaForAdmins: true,
        shiftScheduleAuthoritative: true,
        groupCreationPolicy: 'managers',
        allowExternalGuests: false,
        externalGuestMaxAccessDays: 30,
        version: 1,
        reason: 'Valid reason',
      }));
      failures.push(await currentWorkspace().loadOrganizationAiPolicy());
      failures.push(await currentWorkspace().loadDynamicGroupPolicies());
      failures.push(await currentWorkspace().saveDynamicGroupPolicy({
        conversationId: conversationBId,
        expectedVersion: 0,
        policySpec: {
          siteIds: [], departmentIds: [], teamIds: [], lineIds: [], unitIds: [],
          includeDescendants: false, operationalRoles: [], membershipRoles: ['member'],
          shiftMode: 'none', scheduledShiftStartsAt: null, scheduledShiftEndsAt: null,
        },
        maximumMembers: 100,
      }));
      failures.push(await currentWorkspace().previewDynamicGroupPolicy('policy-a', 1));
      failures.push(await currentWorkspace().publishDynamicGroupPolicy('policy-a', 1, 'a'.repeat(64)));
      failures.push(await currentWorkspace().pauseDynamicGroupPolicy('policy-a', 1, 'Valid reason'));
      failures.push(await currentWorkspace().loadDeviceNotificationPreferences());
      failures.push(await currentWorkspace().enableNotifications());
    });

    expect(failures.filter((result) => Boolean(result))).toEqual([]);
    await view.unmount();
  });

  test('fails closed on invalid operations and maps retryable repository failures', async () => {
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      if (method === 'listGroupCreationCandidates') {
        throw new RepositoryError('Network unavailable', 'network_error', true);
      }
      return controlledCommandResponse(method, input);
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());

    let candidates: unknown = [];
    await act(async () => {
      candidates = await currentWorkspace().queryGroupCreationCandidates('response');
    });
    expect(candidates).toBeNull();
    expect(currentWorkspace().actionError).toBe('errors.action');

    await expect(currentWorkspace().requestTranslation({
      ...snapshot.messages['conversation-a'][0],
      languageDetection: { ...snapshot.messages['conversation-a'][0].languageDetection!, detectedLanguage: 'en' },
    })).resolves.toBe(false);
    await expect(currentWorkspace().createGroupConversation({
      name: 'X',
      kind: 'incident',
      historyPolicy: 'all',
      postingMode: 'all_members',
      joinPolicy: 'approval_required',
      members: [],
    })).resolves.toBeNull();
    await expect(currentWorkspace().reportMessage(
      snapshot.messages['conversation-a'][1],
      'spam',
      undefined,
      { consentToShare: true, contextBefore: 0, contextAfter: 0, noticeVersion: 'moderation-report-v2' },
    )).resolves.toBe(false);
    await expect(currentWorkspace().closeIncident(incidentConversationId, 'x')).resolves.toBe(false);
    await act(async () => currentWorkspace().clearActionError());
    expect(currentWorkspace().actionError).toBeNull();
    await view.unmount();
  });

  test('renames the current user from the gateway receipt and rejects invalid or foreign receipts', async () => {
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:1')).toBeTruthy());
    // Freeze subsequent refreshes so the receipt-driven patch stays observable.
    mockLoadWorkspace.mockImplementation(() => new Promise(() => {}));

    const outcomes: boolean[] = [];
    await act(async () => {
      outcomes.push(await currentWorkspace().updateProfile({ displayName: '   ' }));
      outcomes.push(await currentWorkspace().updateProfile({ displayName: 'n'.repeat(121) }));
      outcomes.push(await currentWorkspace().updateProfile({
        displayName: 'Valid Name',
        statusMessage: 's'.repeat(281),
      }));
    });
    expect(outcomes).toEqual([false, false, false]);
    expect(mockCommand).not.toHaveBeenCalled();

    mockCommand.mockImplementation(async () => undefined);
    await act(async () => {
      outcomes.push(await currentWorkspace().updateProfile({ displayName: 'Renamed Employee' }));
    });
    expect(outcomes.at(-1)).toBe(false);
    expect(currentWorkspace().currentUser?.displayName).toBe('Current Employee');

    mockCommand.mockImplementation(async () => ({
      userId: otherUserId, displayName: 'Impostor', statusMessage: null,
    }));
    await act(async () => {
      outcomes.push(await currentWorkspace().updateProfile({ displayName: 'Renamed Employee' }));
    });
    expect(outcomes.at(-1)).toBe(false);
    expect(currentWorkspace().currentUser?.displayName).toBe('Current Employee');

    mockCommand.mockImplementation(async () => ({
      userId, displayName: 'Renamed Employee', statusMessage: 'On shift',
    }));
    await act(async () => {
      outcomes.push(await currentWorkspace().updateProfile({
        displayName: '  Renamed Employee ',
        statusMessage: ' On shift ',
      }));
    });
    expect(outcomes.at(-1)).toBe(true);
    expect(mockCommand).toHaveBeenLastCalledWith('updateProfile', {
      organizationId: '70000000-0000-4000-8000-000000000007',
      displayName: 'Renamed Employee',
      statusMessage: 'On shift',
      idempotencyKey: '50000000-0000-4000-8000-000000000005',
    });
    expect(currentWorkspace().currentUser).toMatchObject({
      id: userId,
      displayName: 'Renamed Employee',
      initials: 'RE',
      statusMessage: 'On shift',
    });
    expect(currentWorkspace().people.find((person) => person.id === otherUserId)?.displayName)
      .toBe('Connected Employee');
    expect(currentWorkspace().people.every(
      (person) => person.id !== userId || person.displayName === 'Renamed Employee',
    )).toBe(true);
    expect(currentWorkspace().actionError).toBeNull();

    mockCommand.mockImplementation(async () => ({
      userId, displayName: 'Renamed Employee', statusMessage: null,
    }));
    await act(async () => {
      outcomes.push(await currentWorkspace().updateProfile({
        displayName: 'Renamed Employee',
        statusMessage: '   ',
      }));
    });
    expect(outcomes.at(-1)).toBe(true);
    expect(mockCommand).toHaveBeenLastCalledWith('updateProfile', expect.objectContaining({
      statusMessage: null,
    }));
    expect(currentWorkspace().currentUser?.statusMessage).toBeNull();
    await view.unmount();
  });

  test('searches usernames and sends message requests inside the personal realm', async () => {
    const strangerId = '60000000-0000-4000-8000-000000000010';
    const requestConversationId = '80000000-0000-4000-8000-000000000011';
    const personalSnapshot = workspaceSnapshot();
    personalSnapshot.organizationId = '11111111-1111-4111-8111-111111111111';
    mockLoadWorkspace.mockImplementation(async () => personalSnapshot);
    mockSearchUsers.mockImplementation(async () => [{
      userId: strangerId,
      username: 'sam_stranger',
      displayName: 'Sam Stranger',
      avatarPath: null,
      connectionState: 'none',
    }]);
    mockCommand.mockImplementation(async (method: string) => method === 'sendMessageRequest'
      ? { conversationId: requestConversationId, messageId: '77', connectionStatus: 'pending' }
      : undefined);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:1')).toBeTruthy());
    // Freeze subsequent refreshes so the optimistic patches stay observable.
    mockLoadWorkspace.mockImplementation(() => new Promise(() => {}));

    let shortQuery: unknown = null;
    let results: unknown = null;
    let conversationId: unknown = null;
    await act(async () => {
      shortQuery = await currentWorkspace().searchUsers(' S ');
      results = await currentWorkspace().searchUsers('  SAM ');
      conversationId = await currentWorkspace().sendMessageRequest(
        strangerId,
        '  Hello Sam!  ',
        'Sam Stranger',
      );
    });
    expect(shortQuery).toEqual([]);
    expect(mockSearchUsers).toHaveBeenCalledTimes(1);
    expect(mockSearchUsers).toHaveBeenCalledWith({
      organizationId: '11111111-1111-4111-8111-111111111111',
      query: 'sam',
      limit: 20,
    });
    expect(results).toEqual([expect.objectContaining({ username: 'sam_stranger' })]);
    expect(conversationId).toBe(requestConversationId);
    expect(mockCommand).toHaveBeenCalledWith('sendMessageRequest', {
      organizationId: '11111111-1111-4111-8111-111111111111',
      targetUserId: strangerId,
      body: 'Hello Sam!',
      idempotencyKey: '50000000-0000-4000-8000-000000000005',
    });
    expect(currentWorkspace().selectedConversationId).toBe(requestConversationId);
    expect(currentWorkspace().conversations[0]).toMatchObject({
      id: requestConversationId,
      kind: 'direct',
      directParticipantId: strangerId,
      lastMessage: 'Hello Sam!',
    });
    expect(currentWorkspace().people.find((person) => person.id === strangerId)).toMatchObject({
      displayName: 'Sam Stranger',
      connectionState: 'pending',
      connectionRequestDirection: 'outgoing',
    });

    // Local bounds fail closed without reaching the command surface.
    const callsBefore = mockCommand.mock.calls.length;
    await act(async () => {
      await expect(currentWorkspace().sendMessageRequest(strangerId, '   ')).resolves.toBeNull();
      await expect(currentWorkspace().sendMessageRequest(strangerId, 'x'.repeat(20_001)))
        .resolves.toBeNull();
      await expect(currentWorkspace().sendMessageRequest(userId, 'to myself')).resolves.toBeNull();
    });
    expect(mockCommand.mock.calls.length).toBe(callsBefore);

    // An unknown search-discovered target connects by raw user UUID in the
    // realm, while a known non-available person stays gated locally.
    const secondStrangerId = '60000000-0000-4000-8000-000000000012';
    let connected: unknown = null;
    let gated: unknown = null;
    await act(async () => {
      connected = await currentWorkspace().updateConnection(secondStrangerId);
      gated = await currentWorkspace().updateConnection(strangerId);
    });
    expect(connected).toBe(true);
    expect(gated).toBe(false);
    expect(mockCommand).toHaveBeenCalledWith('requestConnection', expect.objectContaining({
      targetMembershipId: secondStrangerId,
    }));
    expect(mockCommand).not.toHaveBeenCalledWith('requestConnection', expect.objectContaining({
      targetMembershipId: strangerId,
    }));
    await view.unmount();
  });

  test('cancels an outgoing message request through the connection DELETE route and drops the optimistic thread', async () => {
    const strangerId = '60000000-0000-4000-8000-000000000021';
    const secondStrangerId = '60000000-0000-4000-8000-000000000022';
    const unknownId = '60000000-0000-4000-8000-000000000023';
    const requestConversationId = '80000000-0000-4000-8000-000000000024';
    const secondRequestConversationId = '80000000-0000-4000-8000-000000000025';
    const personalSnapshot = workspaceSnapshot();
    personalSnapshot.organizationId = '11111111-1111-4111-8111-111111111111';
    // An accepted friend with shared history must survive a connection removal.
    personalSnapshot.conversations.push({
      id: 'direct-friend',
      organizationId: personalSnapshot.organizationId,
      directParticipantId: otherUserId,
      title: 'Connected Employee',
      initials: 'CO',
      avatarColor: '#654321',
      kind: 'direct',
      subtitle: 'Supervisor',
      lastMessage: 'See you tomorrow',
      lastActivity: 'now',
      unreadCount: 0,
      pinned: false,
      favorite: false,
      muted: false,
      canPost: true,
    });
    personalSnapshot.messages['direct-friend'] = [];
    personalSnapshot.cursors['direct-friend'] = null;
    mockLoadWorkspace.mockImplementation(async () => personalSnapshot);
    let removeConnectionFailure: RepositoryError | null = null;
    mockCommand.mockImplementation(async (method: string, input: unknown) => {
      if (method === 'sendMessageRequest') {
        const target = (input as { targetUserId: string }).targetUserId;
        return {
          conversationId: target === strangerId ? requestConversationId : secondRequestConversationId,
          messageId: target === strangerId ? '81' : '82',
          connectionStatus: 'pending',
        };
      }
      if (method === 'removeConnection' && removeConnectionFailure) throw removeConnectionFailure;
      return undefined;
    });
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:2')).toBeTruthy());
    // Freeze subsequent refreshes so the local transitions stay observable.
    mockLoadWorkspace.mockImplementation(() => new Promise(() => {}));

    await act(async () => {
      await currentWorkspace().sendMessageRequest(strangerId, 'Hello Sam', 'Sam Stranger');
      await currentWorkspace().sendMessageRequest(secondStrangerId, 'Hello Pat', 'Pat Stranger');
    });
    expect(currentWorkspace().selectedConversationId).toBe(secondRequestConversationId);
    expect(currentWorkspace().conversations.map((item) => item.id))
      .toEqual([secondRequestConversationId, requestConversationId, 'conversation-a', 'direct-friend']);

    // A rejected cancel keeps the card pending, keeps the thread, and maps the failure.
    removeConnectionFailure = new RepositoryError('raw upstream', 'forbidden', false, undefined, 403);
    let failed: unknown = 'unset';
    await act(async () => {
      failed = await currentWorkspace().removeConnection(secondStrangerId);
    });
    expect(failed).toBe(false);
    expect(currentWorkspace().actionError).toBe('errors.permission');
    expect(currentWorkspace().people.find((person) => person.id === secondStrangerId)).toMatchObject({
      connectionState: 'pending',
      connectionRequestDirection: 'outgoing',
    });
    expect(currentWorkspace().conversations.some((item) => item.id === secondRequestConversationId)).toBe(true);

    // The selected pending request: DELETE addressed by the target user's UUID,
    // the card flips back to available, the optimistic thread disappears with
    // its timeline, and selection falls back to the next ordinary conversation.
    removeConnectionFailure = null;
    let cancelled: unknown = 'unset';
    await act(async () => {
      cancelled = await currentWorkspace().removeConnection(secondStrangerId);
    });
    expect(cancelled).toBe(true);
    expect(mockCommand).toHaveBeenLastCalledWith('removeConnection', {
      organizationId: '11111111-1111-4111-8111-111111111111',
      membershipId: secondStrangerId,
      idempotencyKey: '50000000-0000-4000-8000-000000000005',
    });
    const cancelledPerson = currentWorkspace().people.find((person) => person.id === secondStrangerId);
    expect(cancelledPerson).toMatchObject({ connectionState: 'available' });
    expect(cancelledPerson?.connectionRequestDirection).toBeUndefined();
    expect(currentWorkspace().conversations.map((item) => item.id))
      .toEqual([requestConversationId, 'conversation-a', 'direct-friend']);
    expect(currentWorkspace().messages[secondRequestConversationId]).toBeUndefined();
    expect(currentWorkspace().selectedConversationId).toBe(requestConversationId);
    expect(currentWorkspace().actionError).toBeNull();

    // A search result the directory has not loaded yet still reaches the route
    // in the realm, addressed by its raw user UUID.
    let unknownCancelled: unknown = 'unset';
    await act(async () => {
      unknownCancelled = await currentWorkspace().removeConnection(unknownId);
    });
    expect(unknownCancelled).toBe(true);
    expect(mockCommand).toHaveBeenLastCalledWith('removeConnection', expect.objectContaining({
      membershipId: unknownId,
    }));

    // Removing an accepted connection keeps the shared direct history.
    let removed: unknown = 'unset';
    await act(async () => {
      removed = await currentWorkspace().removeConnection(otherUserId);
    });
    expect(removed).toBe(true);
    expect(mockCommand).toHaveBeenLastCalledWith('removeConnection', expect.objectContaining({
      membershipId: 'membership-other',
    }));
    expect(currentWorkspace().people.find((person) => person.id === otherUserId)).toMatchObject({
      connectionState: 'available',
    });
    expect(currentWorkspace().conversations.some((item) => item.id === 'direct-friend')).toBe(true);
    await view.unmount();
  });

  test('keeps unknown cancel targets gated outside the personal realm', async () => {
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:1')).toBeTruthy());
    let cancelled: unknown = 'unset';
    await act(async () => {
      cancelled = await currentWorkspace().removeConnection('60000000-0000-4000-8000-000000000023');
    });
    expect(cancelled).toBe(false);
    expect(mockCommand).not.toHaveBeenCalledWith('removeConnection', expect.anything());
    await view.unmount();
  });

  test('lets a requester post into a pending request thread the bootstrap marks can_post=false', async () => {
    const requesterTargetId = '60000000-0000-4000-8000-000000000031';
    const incomingRequesterId = '60000000-0000-4000-8000-000000000032';
    const personalSnapshot = workspaceSnapshot();
    personalSnapshot.organizationId = '11111111-1111-4111-8111-111111111111';
    const template = personalSnapshot.conversations[0];
    personalSnapshot.conversations.push(
      { ...template, id: 'direct-outgoing', kind: 'direct', directParticipantId: requesterTargetId, memberIds: undefined, canPost: false },
      { ...template, id: 'direct-incoming', kind: 'direct', directParticipantId: incomingRequesterId, memberIds: undefined, canPost: false },
    );
    personalSnapshot.messages['direct-outgoing'] = [];
    personalSnapshot.messages['direct-incoming'] = [];
    personalSnapshot.cursors['direct-outgoing'] = null;
    personalSnapshot.cursors['direct-incoming'] = null;
    const stranger = {
      id: requesterTargetId,
      membershipId: requesterTargetId,
      organizationId: personalSnapshot.organizationId,
      displayName: 'Sam Stranger',
      initials: 'SS',
      roleLabel: '',
      role: 'employee' as const,
      site: '',
      department: '',
      preferredLanguage: 'en' as const,
      presence: 'offline' as const,
      connectionState: 'pending' as const,
      connectionRequestDirection: 'outgoing' as const,
      avatarColor: '#496D62',
    };
    personalSnapshot.people.push(
      stranger,
      {
        ...stranger,
        id: incomingRequesterId,
        membershipId: incomingRequesterId,
        displayName: 'Ian Incoming',
        initials: 'II',
        connectionRequestDirection: 'incoming',
      },
    );
    mockLoadWorkspace.mockImplementation(async () => personalSnapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input)
    );
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());
    mockLoadWorkspace.mockImplementation(() => new Promise(() => {}));

    await act(async () => {
      await currentWorkspace().sendMessage('direct-outgoing', 'Second request message');
    });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0]![0]).toMatchObject({
      kind: 'send_message',
      payload: expect.objectContaining({ conversationId: 'direct-outgoing', body: 'Second request message' }),
    });
    // The queued command reaches the send route unchanged; the service owns the cap.
    expect(mockCommand).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      conversationId: 'direct-outgoing',
      body: 'Second request message',
    }));
    expect(currentWorkspace().messages['direct-outgoing']).toHaveLength(1);
    expect(currentWorkspace().messages['direct-outgoing'][0]).toMatchObject({ deliveryState: 'sent' });
    expect(currentWorkspace().actionError).toBeNull();

    // The recipient of a pending request still cannot post until accepting.
    await act(async () => {
      await currentWorkspace().sendMessage('direct-incoming', 'Not yet');
    });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(currentWorkspace().messages['direct-incoming']).toHaveLength(0);
    expect(currentWorkspace().actionError).not.toBeNull();
    await view.unmount();
  });

  test('maps username search failures and keeps workspace-org connection gating closed', async () => {
    mockSearchUsers.mockImplementation(async () => {
      throw new RepositoryError('raw upstream', 'rate_limited', true, undefined, 429);
    });
    mockCommand.mockImplementation(async (method: string) => method === 'sendMessageRequest'
      ? { conversationId: conversationBId, messageId: '78', connectionStatus: 'accepted' }
      : undefined);
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:1')).toBeTruthy());
    mockLoadWorkspace.mockImplementation(() => new Promise(() => {}));

    let failed: unknown = 'unset';
    await act(async () => {
      failed = await currentWorkspace().searchUsers('sam');
    });
    expect(failed).toBeNull();
    expect(currentWorkspace().actionError).toBe('errors.rateLimit');

    // Outside the personal realm an unknown target must not reach the server.
    let connected: unknown = 'unset';
    await act(async () => {
      connected = await currentWorkspace().updateConnection('60000000-0000-4000-8000-000000000010');
    });
    expect(connected).toBe(false);
    expect(mockCommand).not.toHaveBeenCalledWith('requestConnection', expect.anything());

    // An accepted receipt (auto-accept pair) records the counterpart as connected.
    let conversationId: unknown = null;
    await act(async () => {
      conversationId = await currentWorkspace().sendMessageRequest(otherUserId, 'Hola', 'Ignored');
    });
    expect(conversationId).toBe(conversationBId);
    expect(currentWorkspace().people.find((person) => person.id === otherUserId)).toMatchObject({
      connectionState: 'connected',
    });

    // A rejected command surfaces the mapped error and returns null.
    mockCommand.mockImplementation(async () => {
      throw new RepositoryError('raw upstream', 'message_request_cap', false);
    });
    let capped: unknown = 'unset';
    await act(async () => {
      capped = await currentWorkspace().sendMessageRequest(otherUserId, 'One more');
    });
    expect(capped).toBeNull();
    expect(currentWorkspace().actionError).toBe('errors.messageRequestCap');
    await view.unmount();
  });

  test('rejects username search and message requests without workspace identity', async () => {
    mockAuth.user = null;
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('error::0')).toBeTruthy());
    await act(async () => {
      await expect(currentWorkspace().searchUsers('sam')).resolves.toBeNull();
      await expect(currentWorkspace().sendMessageRequest(
        '60000000-0000-4000-8000-000000000010',
        'Hello',
      )).resolves.toBeNull();
      await expect(currentWorkspace().updateConnection(
        '60000000-0000-4000-8000-000000000010',
      )).resolves.toBe(false);
    });
    expect(mockSearchUsers).not.toHaveBeenCalled();
    expect(mockCommand).not.toHaveBeenCalled();
    await view.unmount();
  });
});

describe('reconciliation safety net', () => {
  let appStateListeners: ((state: AppStateStatus) => void)[];
  let addEventListenerSpy: ReturnType<typeof jest.spyOn>;

  function emitAppState(nextState: AppStateStatus) {
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: nextState });
    for (const listener of [...appStateListeners]) listener(nextState);
  }

  beforeEach(() => {
    appStateListeners = [];
    addEventListenerSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation((
      (_mockType: string, mockCallback: (state: AppStateStatus) => void) => {
        appStateListeners.push(mockCallback);
        return {
          remove: () => {
            appStateListeners = appStateListeners.filter((item) => item !== mockCallback);
          },
        };
      }
    ) as typeof AppState.addEventListener);
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    jest.useRealTimers();
  });

  test('foregrounding refreshes the snapshot immediately and forces a realtime resubscribe with the current token; backgrounding does neither', async () => {
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:1')).toBeTruthy());
    const loadsBefore = mockLoadWorkspace.mock.calls.length;
    const nonceBefore = mockRealtimeOptions?.resubscribeNonce as number;
    // A session refresh while backgrounded must be picked up on resume.
    mockAuth.realtimeToken = 'refreshed-realtime-token';

    await act(async () => { emitAppState('background'); });
    expect(mockLoadWorkspace.mock.calls.length).toBe(loadsBefore);
    expect(mockRealtimeOptions?.resubscribeNonce).toBe(nonceBefore);

    await act(async () => { emitAppState('active'); });
    await waitFor(() => expect(mockLoadWorkspace.mock.calls.length).toBeGreaterThan(loadsBefore));
    expect(mockRealtimeOptions?.resubscribeNonce as number).toBeGreaterThan(nonceBefore);
    expect(mockRealtimeOptions?.accessToken).toBe('refreshed-realtime-token');
    await view.unmount();
  });

  test('reconciles only the currently open conversation once after each successful send', async () => {
    const snapshot = richWorkspaceSnapshot();
    mockLoadWorkspace.mockImplementation(async () => snapshot);
    mockCommand.mockImplementation(async (method: string, input: unknown) =>
      controlledCommandResponse(method, input));
    const view = await render(
      <WorkspaceProvider>
        <WorkspaceProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('ready:Controlled Company:3')).toBeTruthy());
    expect(currentWorkspace().selectedConversationId).toBe('conversation-a');
    mockLoadWorkspace.mockClear();

    await act(async () => {
      await currentWorkspace().sendMessage('conversation-a', 'Reconcile the open thread');
    });
    await waitFor(() => expect(mockLoadWorkspace).toHaveBeenCalledTimes(1));

    mockLoadWorkspace.mockClear();
    await act(async () => {
      await currentWorkspace().sendMessage(conversationBId, 'Do not reconcile a background thread');
    });
    // The conversation that was actually sent to is not the open one, so no
    // extra reconcile fires — nothing to wait for, the skip is synchronous.
    expect(mockLoadWorkspace).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('polls the inbox snapshot on a jittered ~30s cadence, skipping a fetch already in flight or made moot by a recent realtime event', async () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    jest.useFakeTimers();
    try {
      const view = await render(
        <WorkspaceProvider>
          <WorkspaceProbe />
        </WorkspaceProvider>,
      );
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('ready:Controlled Company:1')).toBeTruthy();
      mockLoadWorkspace.mockClear();

      // Base cadence: 30s jittered ±5s — deterministic here since Math.random is pinned.
      await act(async () => { await jest.advanceTimersByTimeAsync(29_999); });
      expect(mockLoadWorkspace).not.toHaveBeenCalled();
      await act(async () => { await jest.advanceTimersByTimeAsync(1); });
      expect(mockLoadWorkspace).toHaveBeenCalledTimes(1);

      // A realtime event landing inside the 15s freshness window skips the next tick.
      await act(async () => { await jest.advanceTimersByTimeAsync(25_000); });
      await act(async () => {
        (mockRealtimeOptions?.onInvalidate as () => void)();
      });
      expect(mockLoadWorkspace).toHaveBeenCalledTimes(2); // the invalidation's own reconcile
      await act(async () => { await jest.advanceTimersByTimeAsync(5_000); }); // tick 30s after the last one
      expect(mockLoadWorkspace).toHaveBeenCalledTimes(2); // skipped: the event was under 15s old
      await act(async () => { await jest.advanceTimersByTimeAsync(30_000); }); // next tick, now stale
      expect(mockLoadWorkspace).toHaveBeenCalledTimes(3);

      // A refresh already in flight is never joined by a second concurrent fetch.
      mockLoadWorkspace.mockImplementation(() => new Promise(() => {}));
      await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
      expect(mockLoadWorkspace).toHaveBeenCalledTimes(4);
      await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
      expect(mockLoadWorkspace).toHaveBeenCalledTimes(4);

      await view.unmount();
    } finally {
      randomSpy.mockRestore();
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('shortens the poll to 10s while realtime is degraded and stops it entirely once backgrounded', async () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    jest.useFakeTimers();
    try {
      const view = await render(
        <WorkspaceProvider>
          <WorkspaceProbe />
        </WorkspaceProvider>,
      );
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('ready:Controlled Company:1')).toBeTruthy();
      mockLoadWorkspace.mockClear();

      await act(async () => {
        (mockRealtimeOptions?.onStateChange as (state: string) => void)('degraded');
      });
      await act(async () => { await jest.advanceTimersByTimeAsync(9_999); });
      expect(mockLoadWorkspace).not.toHaveBeenCalled();
      await act(async () => { await jest.advanceTimersByTimeAsync(1); });
      expect(mockLoadWorkspace).toHaveBeenCalledTimes(1);
      await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
      expect(mockLoadWorkspace).toHaveBeenCalledTimes(2);

      mockLoadWorkspace.mockClear();
      await act(async () => { emitAppState('background'); });
      await act(async () => { await jest.advanceTimersByTimeAsync(120_000); });
      expect(mockLoadWorkspace).not.toHaveBeenCalled();

      await view.unmount();
    } finally {
      randomSpy.mockRestore();
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});
