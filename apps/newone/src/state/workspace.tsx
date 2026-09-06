import {
  AppState,
  Linking,
} from 'react-native';
import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { publicRuntimeConfig } from '@/config/runtime';
import {
  cleanupPreparedAttachment,
  prepareAttachment,
  optimizeImageAttachment,
  uploadAttachment,
  type PreparedAttachment,
  type SelectedAttachment,
} from '@/data/attachments';
// Metro selects the bounded encrypted native or web adapter.
// eslint-disable-next-line import/no-unresolved
import { clientStore } from '@/data/persistence/client-store';
import {
  offlineWorkspaceCacheKey,
  offlineWorkspaceExpiresAt,
  offlineWorkspaceSnapshotExpiresAt,
  parseOfflineWorkspace,
  serializeOfflineWorkspace,
} from '@/data/persistence/offline-workspace.mjs';
import { offlineWorkspaceEntitlement } from '@/data/persistence/offline-workspace-entitlement.mjs';
import {
  editUnattemptedMessageCommand,
  retryFailedMessageCommand,
  visibleMessageOutbox,
} from '@/data/persistence/outbox-controls.mjs';
import type { OutboxCommand, VisibleMessageOutboxItem } from '@/data/persistence/types';
import { BffCommandRepository } from '@/data/repositories/bff-command-repository';
import type {
  CommandRepository,
  AttachmentUploadGrant,
  AuditPage,
  AuditQueryInput,
  ConversationMemberCandidatePage,
  IssuedInvitation,
  MessageReceiptInput,
  OrganizationUnitOption,
  ReadRepository,
  SendMessageInput,
  UpdateAudiencePreview,
  UpdateAudienceSpec,
  UserSearchResult,
  WorkspaceSnapshot,
} from '@/data/repositories/contracts';
import { isOfflineError, RepositoryError } from '@/data/repositories/contracts';
import type {
  DeviceNotificationPreferencePatch,
  DeviceNotificationPreferences,
} from '@/data/repositories/device-notification-preferences-dto.mjs';
import type { GroupCreationCandidate } from '@/data/repositories/group-creation-dto.mjs';
import type {
  OrganizationPolicy,
  OrganizationPolicyUpdate,
} from '@/data/repositories/organization-policy-dto.mjs';
import type {
  OrganizationAiPolicy,
  OrganizationAiPolicyUpdate,
} from '@/data/repositories/ai-policy-dto.mjs';
import type {
  DynamicGroupPauseReceipt,
  DynamicGroupPolicy,
  DynamicGroupPolicySpec,
  DynamicGroupPreviewReceipt,
  DynamicGroupPublishReceipt,
  DynamicGroupSaveReceipt,
} from '@/data/repositories/dynamic-group-dto.mjs';
import { WebReadRepository } from '@/data/repositories/web-read-repository';
import { createCoalescedRunner } from '@/data/reconciliation/coalesced-runner.mjs';
import {
  compareMessageIds,
  firstUnreadMessageId,
  latestIncomingServerMessage,
  mergeTimelineMessages,
} from '@/data/reconciliation/message-timeline.mjs';
import {
  useUserRealtime,
  type RealtimeState,
} from '@/data/realtime/use-user-realtime';
import type {
  Attachment,
  CompanyUpdate,
  ConnectivityState,
  Conversation,
  InboxFilter,
  Message,
  Person,
  ResourceStatus,
  ShiftHandoff,
  OrganizationPreferences,
  AccountSession,
  AdminRoleAssignment,
  AdminRoleName,
  AuditEvent,
  AuditExportReceipt,
  AuthorizationScope,
  ConversationSummary,
  ModerationReport,
  OperationalAction,
  ConversationJoinRequest,
  DiscoverableConversation,
  WorkspaceCapability,
  AiOutputErrorReport,
  AiOutputErrorReportDetail,
  AiOutputErrorCategory,
} from '@/domain/types';
import { isPersonalRealm } from '@/constants/personal-realm';
import { createClientId } from '@/lib/client-id';
import { activeMutedUntil, isConversationMuted } from '@/data/notification-preferences.mjs';
import { getSupabaseClient } from '@/lib/supabase';
import type { MessageKey } from '@/i18n/catalog';
import { errorIdentifier, errorMessageKey } from '@/i18n/errors';
import { useI18n } from '@/i18n/provider';
import { isValidMentionSelection } from '@/features/chat/mention-controls.mjs';
import { mentionCopy } from '@/features/chat/mention-copy';
import {
  conversationOutboxCommandIds,
  redactDepartedConversation,
} from '@/features/chat/conversation-departure-state.mjs';
// Metro selects the native permission-aware adapter or the web no-op.
import {
  addPushTokenRefreshListener,
  getCurrentInstallationId,
  getExistingDeviceRegistration,
  noteRegisteredPushToken,
  requestDeviceRegistration,
} from '@/device/push-registration'; // eslint-disable-line import/no-unresolved
import { useAuth } from '@/state/auth';

interface WorkspaceState {
  organizationId: string;
  organizationName: string;
  currentMembershipRole: WorkspaceSnapshot['currentMembershipRole'] | null;
  organizationPolicy: OrganizationPolicy | null;
  organizationAiPolicy: OrganizationAiPolicy | null;
  currentUser: Person | null;
  conversations: Conversation[];
  conversationAvatarUrls: Record<string, string>;
  discoverableConversations: DiscoverableConversation[];
  messages: Record<string, Message[]>;
  people: Person[];
  units: OrganizationUnitOption[];
  updates: CompanyUpdate[];
  handoffs: ShiftHandoff[];
  summaries: ConversationSummary[];
  actions: OperationalAction[];
  moderationReports: ModerationReport[];
  auditEvents: AuditEvent[];
  capabilities: WorkspaceCapability[];
  authorizationScopes: AuthorizationScope[];
  messageDisplayLanguage: Person['preferredLanguage'] | null;
  selectedConversationId: string;
  inboxFilter: InboxFilter;
  inboxSearch: string;
  status: ResourceStatus;
  connectivity: ConnectivityState;
  offlineQueueAvailable: boolean;
  realtimeState: RealtimeState;
  realtimeToken: string | null;
  error: string | null;
  actionError: string | null;
  actionBusy: string | null;
  outboxCount: number;
  failedOutboxCount: number;
  messageOutbox: VisibleMessageOutboxItem[];
  outboxDegradedReason: string | null;
  organizationPreferences: OrganizationPreferences | null;
  deviceNotificationPreferences: DeviceNotificationPreferences | null;
  accountSessions: AccountSession[];
  roleAssignments: AdminRoleAssignment[];
  roleAssignmentsPersonId: string | null;
  aiOutputErrorReports: AiOutputErrorReport[];
  aiOutputReviewQueue: AiOutputErrorReport[];
  selectedAiOutputReport: AiOutputErrorReportDetail | null;
  dynamicGroupPolicies: DynamicGroupPolicy[];
  dynamicGroupNextAfterPolicyId: string | null;
  messagePagination: Record<string, { hasMore: boolean; loading: boolean }>;
  unreadDividerIds: Record<string, string | null>;
  refresh: () => Promise<void>;
  loadOlderMessages: (conversationId: string) => Promise<boolean>;
  observeConversation: (conversationId: string) => Promise<void>;
  markConversationRead: (conversationId: string) => Promise<void>;
  ensureMessageLoaded: (conversationId: string, messageId: string) => Promise<boolean>;
  requestTranslation: (message: Message) => Promise<boolean>;
  proposeTranslationCorrection: (
    message: Message,
    correctedBody: string,
    rationale?: string,
  ) => Promise<boolean>;
  reviewTranslationCorrection: (
    message: Message,
    decision: 'approved' | 'rejected' | 'changes_requested',
    note?: string,
  ) => Promise<boolean>;
  requestConversationSummary: (
    conversationId: string,
    range: { kind: SummaryScopeKind; subject?: string | null },
  ) => Promise<boolean>;
  correctConversationSummary: (
    summary: ConversationSummary,
    primaryTopic: string,
    summaryBody: string,
  ) => Promise<boolean>;
  reviewConversationSummary: (
    summaryId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ) => Promise<boolean>;
  reportAiOutputError: (input: {
    outputKind: 'translation' | 'summary';
    translationId?: string | null;
    summaryId?: string | null;
    category: AiOutputErrorCategory;
    details: string;
    highConsequence: boolean;
    qualityUseConsent: boolean;
  }) => Promise<boolean>;
  loadMyAiOutputErrorReports: () => Promise<boolean>;
  loadAiOutputReviewQueue: () => Promise<boolean>;
  readAiOutputErrorReport: (reportId: string) => Promise<boolean>;
  reviewAiOutputErrorReport: (
    reportId: string,
    expectedVersion: number,
    outcome: 'confirmed_error' | 'not_an_error' | 'needs_context',
    reviewNote: string,
  ) => Promise<boolean>;
  proposeAiRegressionExample: (input: {
    reportId: string;
    expectedReportVersion: number;
    sourceLanguage: string;
    deidentifiedSourceText: string;
    deidentifiedObservedOutput: string;
    deidentifiedExpectedOutput: string;
  }) => Promise<boolean>;
  decideAiRegressionExample: (
    exampleId: string,
    expectedVersion: number,
    decision: 'approved' | 'rejected',
    decisionNote: string,
  ) => Promise<boolean>;
  setConversationSummaryPolicy: (
    conversationId: string,
    mode: 'manual' | 'message_count' | 'shift_close',
    messageCountThreshold?: number | null,
  ) => Promise<boolean>;
  selectConversation: (conversationId: string) => void;
  setInboxFilter: (filter: InboxFilter) => void;
  setInboxSearch: (query: string) => void;
  openOrCreateDirectConversation: (
    personId: string,
    hint?: { displayName: string; username?: string | null },
  ) => Promise<string | null>;
  queryGroupCreationCandidates: (query?: string) => Promise<GroupCreationCandidate[] | null>;
  queryConversationMemberCandidates: (
    conversationId: string,
    query?: string,
    cursor?: string | null,
  ) => Promise<ConversationMemberCandidatePage | null>;
  createGroupConversation: (input: {
    name: string;
    description?: string;
    kind: 'group' | 'team' | 'shift' | 'incident';
    unitId?: string | null;
    historyPolicy: 'all' | 'since_join';
    postingMode: 'all_members' | 'admins_only';
    joinPolicy: 'inherit' | 'invite_only' | 'approval_required';
    incidentSeverity?: 'low' | 'medium' | 'high' | 'critical';
    incidentClassification?: string;
    members: { membershipId: string; role: 'owner' | 'admin' | 'member' }[];
  }) => Promise<string | null>;
  uploadConversationAvatar: (
    conversationId: string,
    selected: SelectedAttachment,
  ) => Promise<boolean>;
  removeConversationAvatar: (conversationId: string) => Promise<boolean>;
  /** Signed profile-picture URLs by user id (empty when the user has none). */
  profileAvatarUrls: Record<string, string>;
  /** Ask for a user's profile picture; cached, safe to call on every render. */
  requestProfileAvatar: (userId: string) => void;
  uploadProfileAvatar: (selected: SelectedAttachment) => Promise<boolean>;
  removeProfileAvatar: () => Promise<boolean>;
  sendMessage: (
    conversationId: string,
    originalText: string,
    replyTo?: Message,
    mentionUserIds?: string[],
  ) => Promise<void>;
  editOutboxMessage: (outboxId: string, body: string) => Promise<boolean>;
  retryOutboxMessage: (outboxId: string) => Promise<boolean>;
  cancelOutboxMessage: (outboxId: string) => Promise<boolean>;
  sendAttachment: (
    conversationId: string,
    selected: SelectedAttachment,
    caption: string,
  ) => Promise<boolean>;
  cancelAttachmentUpload: (message: Message) => Promise<boolean>;
  retryAttachmentUpload: (message: Message) => Promise<boolean>;
  editMessage: (message: Message, body: string) => Promise<boolean>;
  deleteMessage: (message: Message) => Promise<boolean>;
  hideMessageForMe: (message: Message) => Promise<boolean>;
  forwardMessage: (message: Message, targetConversationId: string) => Promise<boolean>;
  placeMessagePreservationHold: (input: {
    conversationId: string;
    messageId: string;
    holdType: 'legal' | 'incident_preservation';
    reasonCode: string;
    policyReferenceSha256: string;
  }) => Promise<string | null>;
  releaseMessagePreservationHold: (
    holdId: string,
    releaseReasonCode: string,
  ) => Promise<boolean>;
  toggleReaction: (message: Message, emoji: string) => Promise<boolean>;
  setMessagePinned: (message: Message, pinned: boolean) => Promise<boolean>;
  reportMessage: (
    message: Message,
    category: Parameters<CommandRepository['reportMessage']>[0]['category'],
    details?: string,
    disclosure?: {
      consentToShare: true;
      contextBefore: 0 | 1 | 2;
      contextAfter: 0 | 1 | 2;
      noticeVersion: 'moderation-report-v2';
    },
  ) => Promise<boolean>;
  reportGroup: (
    conversation: Conversation,
    category: Parameters<CommandRepository['reportGroup']>[0]['category'],
    details?: string,
    disclosure?: {
      consentToShare: true;
      noticeVersion: 'moderation-report-v2';
    },
  ) => Promise<boolean>;
  reportMember: (
    membershipId: string,
    category: Parameters<CommandRepository['reportMember']>[0]['category'],
    details?: string,
    disclosure?: {
      consentToShare: true;
      noticeVersion: 'moderation-report-v2';
    },
  ) => Promise<boolean>;
  proposeAction: (message: Message, title: string, details?: string) => Promise<boolean>;
  confirmAction: (actionId: string, assigneePersonId: string, dueAt?: string) => Promise<boolean>;
  transitionAction: (
    actionId: string,
    status: 'in_progress' | 'completed' | 'cancelled',
    note?: string,
  ) => Promise<boolean>;
  downloadAttachment: (message: Message) => Promise<boolean>;
  attachmentPreviewUrls: Record<string, string>;
  loadAttachmentPreview: (message: Message) => Promise<void>;
  updateConversation: (
    conversationId: string,
    patch: { name?: string | null; description?: string | null; isArchived?: boolean },
  ) => Promise<boolean>;
  updateConversationPreferences: (
    conversationId: string,
    patch: { isFavorite?: boolean; isPinned?: boolean; isArchived?: boolean; notificationLevel?: 'all' | 'mentions' | 'none'; mutedUntil?: string | null; translationMode?: 'automatic' | 'off' },
  ) => Promise<boolean>;
  updateProfile: (
    input: { displayName: string; statusMessage?: string | null },
  ) => Promise<boolean>;
  updateConversationControls: (
    conversationId: string,
    patch: {
      postingMode?: 'all_members' | 'admins_only';
      joinPolicy?: 'inherit' | 'invite_only' | 'approval_required';
      visibility?: 'invite_only' | 'organization' | 'unit';
      reason: string;
    },
  ) => Promise<boolean>;
  requestConversationJoin: (conversationId: string) => Promise<boolean>;
  cancelConversationJoinRequest: (request: ConversationJoinRequest) => Promise<boolean>;
  loadConversationJoinRequests: (conversationId: string) => Promise<ConversationJoinRequest[]>;
  decideConversationJoinRequest: (
    request: ConversationJoinRequest,
    decision: 'approved' | 'rejected',
    reason: string,
  ) => Promise<boolean>;
  addConversationMember: (
    conversationId: string,
    personId: string,
    role: 'member' | 'admin',
  ) => Promise<boolean>;
  removeConversationMember: (conversationId: string, personId: string) => Promise<boolean>;
  updateConversationMemberRole: (
    conversationId: string,
    personId: string,
    expectedRole: 'owner' | 'admin' | 'member',
    newRole: 'owner' | 'admin' | 'member',
  ) => Promise<boolean>;
  leaveConversation: (conversationId: string, replacementOwnerPersonId?: string) => Promise<boolean>;
  closeIncident: (conversationId: string, reason: string) => Promise<boolean>;
  publishUpdate: (input: {
    conversationId: string;
    title: string;
    body: string;
    priority: 'normal' | 'important' | 'emergency';
    requiresAcknowledgement: boolean;
    expiresAt?: string | null;
    scheduledAt?: string | null;
    acknowledgementSchema?: CompanyUpdate['acknowledgementSchema'];
    notificationClass: NonNullable<CompanyUpdate['notificationClass']>;
    reminderPolicy?: CompanyUpdate['reminderPolicy'];
    audienceSpec: UpdateAudienceSpec;
  }) => Promise<boolean>;
  previewUpdateAudience: (
    conversationId: string,
    audienceSpec: UpdateAudienceSpec,
  ) => Promise<UpdateAudiencePreview | null>;
  cancelScheduledUpdate: (updateId: string, reason: string) => Promise<boolean>;
  acknowledgeUpdate: (updateId: string) => Promise<void>;
  createHandoff: (input: {
    conversationId: string;
    title: string;
    details: string;
    shiftStartedAt: string;
    shiftEndedAt: string;
    sourceMessageIds: string[];
    acknowledgementDueAt?: string | null;
  }) => Promise<boolean>;
  correctHandoff: (handoffId: string, input: {
    expectedVersionId: string;
    expectedVersionNumber: number;
    title: string;
    details: string;
    shiftStartedAt: string;
    shiftEndedAt: string;
    sourceMessageIds: string[];
    acknowledgementDueAt?: string | null;
    reason: string;
  }) => Promise<boolean>;
  signHandoff: (handoffId: string) => Promise<boolean>;
  acknowledgeHandoff: (handoffId: string, input: {
    expectedVersionId: string;
    expectedVersionNumber: number;
    note?: string;
  }) => Promise<boolean>;
  updateConnection: (personId: string) => Promise<boolean>;
  respondConnection: (personId: string, decision: 'accepted' | 'declined') => Promise<boolean>;
  searchUsers: (query: string) => Promise<UserSearchResult[] | null>;
  sendMessageRequest: (
    targetUserId: string,
    body: string,
    displayName?: string,
  ) => Promise<string | null>;
  removeConnection: (personId: string) => Promise<boolean>;
  saveContact: (personId: string, alias: string, isFavorite: boolean) => Promise<boolean>;
  removeSavedContact: (personId: string) => Promise<boolean>;
  setPersonBlocked: (personId: string, blocked: boolean) => Promise<boolean>;
  loadRoleAssignments: (personId: string) => Promise<boolean>;
  queryAudit: (input: Omit<AuditQueryInput, 'organizationId'>) => Promise<AuditPage | null>;
  exportAudit: (input: Omit<AuditQueryInput, 'organizationId' | 'cursor' | 'limit'> & {
    format: 'json' | 'csv';
  }) => Promise<AuditExportReceipt | null>;
  assignRole: (personId: string, input: {
    roleName: AdminRoleName;
    scopeType: 'organization' | 'unit';
    unitId: string | null;
    expiresAt: string | null;
    reason: string;
  }) => Promise<boolean>;
  revokeRole: (assignmentId: string, reason: string) => Promise<boolean>;
  issueInvitation: (input: {
    destinationType: 'email' | 'phone';
    destination: string;
    employeeCode?: string | null;
    activationMode: 'otp' | 'manual';
    role: 'admin' | 'manager' | 'member';
    expiresInSeconds: number;
    membershipType: 'employee' | 'contractor' | 'guest';
    membershipAccessExpiresAt: string | null;
    guestSponsorUserId: string | null;
  }) => Promise<IssuedInvitation | null>;
  suspendMember: (personId: string, reason: string) => Promise<boolean>;
  revokeSession: (sessionId: string, reason: string) => Promise<boolean>;
  loadAccountSettings: () => Promise<void>;
  saveOrganizationPreferences: (patch: Partial<OrganizationPreferences>) => Promise<boolean>;
  updateOrganizationPolicy: (policy: OrganizationPolicyUpdate) => Promise<boolean>;
  loadOrganizationAiPolicy: () => Promise<OrganizationAiPolicy | null>;
  updateOrganizationAiPolicy: (
    policy: Omit<OrganizationAiPolicyUpdate, 'expectedVersion'>,
  ) => Promise<OrganizationAiPolicy | null>;
  loadDynamicGroupPolicies: (append?: boolean) => Promise<boolean>;
  saveDynamicGroupPolicy: (input: {
    conversationId: string;
    policyId?: string | null;
    expectedVersion: number;
    policySpec: DynamicGroupPolicySpec;
    maximumMembers: number;
  }) => Promise<DynamicGroupSaveReceipt | null>;
  previewDynamicGroupPolicy: (
    policyId: string,
    expectedVersion: number,
    sampleLimit?: number,
  ) => Promise<DynamicGroupPreviewReceipt | null>;
  publishDynamicGroupPolicy: (
    policyId: string,
    expectedVersion: number,
    previewFingerprint: string,
  ) => Promise<DynamicGroupPublishReceipt | null>;
  pauseDynamicGroupPolicy: (
    policyId: string,
    expectedVersion: number,
    reason: string,
  ) => Promise<DynamicGroupPauseReceipt | null>;
  loadDeviceNotificationPreferences: () => Promise<boolean>;
  saveDeviceNotificationPreferences: (
    patch: DeviceNotificationPreferencePatch,
  ) => Promise<boolean>;
  enableNotifications: () => Promise<boolean>;
  clearActionError: () => void;
  hasCapability: (capability: WorkspaceCapability, unitId?: string | null) => boolean;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

function nowLabel() {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

function languagePair(first: Person['preferredLanguage'], second: Person['preferredLanguage']) {
  return first === second ? first.toUpperCase() : `${first.toUpperCase()} ↔ ${second.toUpperCase()}`;
}

function nameInitials(displayName: string) {
  return displayName.trim().split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toLocaleUpperCase() || 'N';
}

function messageFromCommand(
  command: OutboxCommand<SendMessageInput>,
  currentUser: Person,
  translate: (key: MessageKey) => string,
): Message {
  return {
    id: `local-${command.payload.clientMessageId}`,
    clientMessageId: command.payload.clientMessageId,
    conversationId: command.payload.conversationId,
    senderId: currentUser.id,
    senderName: currentUser.displayName,
    senderInitials: currentUser.initials,
    senderColor: currentUser.avatarColor,
    originalText: command.payload.body ?? '',
    sourceLanguage: currentUser.preferredLanguage,
    translationState: 'queued',
    createdAt: command.createdAt,
    sentAt: nowLabel(),
    isOwn: true,
    deliveryState: command.state === 'failed' ? 'failed' : 'pending',
    // Stored commands keep the stable error code; the bubble shows local copy
    // for it (a raw "forbidden" reached the device in run 2026-09-04T04-57-19).
    failureReason: command.state === 'failed'
      ? translate(errorMessageKey({ code: command.lastErrorCode ?? 'unknown_error' }))
      : undefined,
    priority: 'normal',
    ...(command.payload.mentionUserIds?.length ? { mentionUserIds: command.payload.mentionUserIds } : {}),
    ...(command.payload.replyPreview ? { replyTo: command.payload.replyPreview } : {}),
  };
}

type SummaryScopeKind = NonNullable<ConversationSummary['scopeKind']>;
const SUMMARY_SCOPE_KINDS: readonly SummaryScopeKind[] = ['unread', 'today', 'yesterday', 'last_7_days', 'everything'];

function mergeMessages(current: Message[], incoming: Message[]) {
  return mergeTimelineMessages(current, incoming) as Message[];
}

// A reconcile page is the server's complete view of the ids it spans, so rows
// deleted for everyone (or hidden for this member) drop out instead of
// lingering until the next cold start.
function reconcileMessages(current: Message[], incoming: Message[]) {
  return mergeTimelineMessages(current, incoming, { pruneMissingWithinPage: true }) as Message[];
}

function receiptProgressKey(input: Pick<MessageReceiptInput, 'organizationId' | 'conversationId' | 'messageId'>) {
  return `${input.organizationId}:${input.conversationId}:${input.messageId}`;
}

function previousMessagesLoaded(snapshot: WorkspaceSnapshot, conversationId: string) {
  return Object.prototype.hasOwnProperty.call(snapshot.cursors, conversationId)
    && (snapshot.messages[conversationId]?.length ?? 0) > 0;
}

function definitiveWorkspaceAccessFailure(error: unknown) {
  return error instanceof RepositoryError && [
    'authentication_required',
    'forbidden',
    'http_401',
    'http_403',
    'membership_required',
    'session_revoked',
  ].includes(error.code.toLocaleLowerCase());
}

/** A refused token (401) rather than a membership, permission, or revocation verdict. */
function staleTokenFailure(error: unknown) {
  return error instanceof RepositoryError
    && ['authentication_required', 'http_401'].includes(error.code.toLocaleLowerCase());
}

function attachmentErrorCode(error: unknown) {
  return error instanceof RepositoryError ? error.code : 'unknown_error';
}

function attachmentObjectNotReady(error: unknown) {
  const code = attachmentErrorCode(error).toLocaleLowerCase();
  return code === 'attachment_not_ready' || code === 'http_409';
}

const WORKSPACE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function conversationAvatarAttachmentId(
  organizationId: string,
  conversationId: string,
  avatarPath: string,
): string | null {
  const parts = avatarPath.split('/');
  return parts.length === 5 && parts[0] === organizationId && parts[1] === conversationId &&
      WORKSPACE_UUID_PATTERN.test(parts[2] ?? '') && WORKSPACE_UUID_PATTERN.test(parts[3] ?? '') &&
      parts[4] === 'upload'
    ? (parts[3] as string).toLowerCase()
    : null;
}

const CONVERSATION_AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const CONVERSATION_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

function waitFor(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

// Reconciliation safety net: while active and online, poll the inbox
// snapshot on a jittered cadence so both sides of a conversation converge
// even if a realtime invalidation was dropped. The window shrinks while
// Realtime is degraded, and the poll is skipped whenever a refresh is
// already in flight or a realtime event landed recently enough to make an
// extra fetch redundant.
const RECONCILE_POLL_BASE_MS = 30_000;
const RECONCILE_POLL_JITTER_MS = 5_000;
const RECONCILE_POLL_DEGRADED_MS = 10_000;
const REALTIME_EVENT_FRESH_MS = 15_000;

function jitteredReconcilePollDelay() {
  return RECONCILE_POLL_BASE_MS + (Math.random() * 2 - 1) * RECONCILE_POLL_JITTER_MS;
}

interface AttachmentUploadOperation {
  organizationId: string;
  conversationId: string;
  messageId: string;
  clientMessageId: string;
  prepared: PreparedAttachment;
  localAttachment: Attachment;
  grantIdempotencyKey: string;
  completionIdempotencyKey: string;
  grant: AttachmentUploadGrant | null;
  uploadMayHaveCommitted: boolean;
  controller: AbortController | null;
}

interface AttachmentCancellation {
  organizationId: string;
  conversationId: string;
  messageId: string;
  clientMessageId: string;
}

// Local persistence must not be able to stall a send: a seal or SQLite write
// that never settles is treated like a failure.
const OUTBOX_ENQUEUE_TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}

export function WorkspaceProvider({ children }: PropsWithChildren) {
  const auth = useAuth();
  const { locale, t } = useI18n();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [conversationAvatarUrls, setConversationAvatarUrls] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<ResourceStatus>('loading');
  const [connectivity, setConnectivity] = useState<ConnectivityState>('unknown');
  const [workspaceAccessDeadline, setWorkspaceAccessDeadline] = useState<string | null>(null);
  const [realtimeState, setRealtimeState] = useState<RealtimeState>('idle');
  const [appStateActive, setAppStateActive] = useState(() => AppState.currentState === 'active');
  const [realtimeResubscribeNonce, setRealtimeResubscribeNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [outboxCount, setOutboxCount] = useState(0);
  const [failedOutboxCount, setFailedOutboxCount] = useState(0);
  const [messageOutbox, setMessageOutbox] = useState<VisibleMessageOutboxItem[]>([]);
  // Why the local encrypted queue could not be used (null while it works).
  const [outboxDegradedReason, setOutboxDegradedReason] = useState<string | null>(null);
  const [organizationPreferences, setOrganizationPreferences] = useState<OrganizationPreferences | null>(null);
  const [organizationAiPolicy, setOrganizationAiPolicy] = useState<OrganizationAiPolicy | null>(null);
  const [deviceNotificationPreferences, setDeviceNotificationPreferences] =
    useState<DeviceNotificationPreferences | null>(null);
  const [accountSessions, setAccountSessions] = useState<AccountSession[]>([]);
  const [roleAssignments, setRoleAssignments] = useState<AdminRoleAssignment[]>([]);
  const [roleAssignmentsPersonId, setRoleAssignmentsPersonId] = useState<string | null>(null);
  const [aiOutputErrorReports, setAiOutputErrorReports] = useState<AiOutputErrorReport[]>([]);
  const [aiOutputReviewQueue, setAiOutputReviewQueue] = useState<AiOutputErrorReport[]>([]);
  const [selectedAiOutputReport, setSelectedAiOutputReport] =
    useState<AiOutputErrorReportDetail | null>(null);
  const [dynamicGroupPolicies, setDynamicGroupPolicies] = useState<DynamicGroupPolicy[]>([]);
  const [dynamicGroupNextAfterPolicyId, setDynamicGroupNextAfterPolicyId] =
    useState<string | null>(null);
  const [dynamicGroupOrganizationId, setDynamicGroupOrganizationId] = useState('');
  const [messagePagination, setMessagePagination] = useState<
    Record<string, { hasMore: boolean; loading: boolean }>
  >({});
  const [unreadDividerIds, setUnreadDividerIds] = useState<Record<string, string | null>>({});
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>('all');
  const [inboxSearch, setInboxSearch] = useState('');
  const flushingRef = useRef(false);
  const flushAgainRef = useRef(false);
  const snapshotRef = useRef<WorkspaceSnapshot | null>(null);
  const selectedConversationIdRef = useRef('');
  const mountedRef = useRef(true);
  const refreshIdentityRef = useRef('');
  const loadingOlderRef = useRef(new Set<string>());
  const receiptProgressRef = useRef(new Map<string, 'delivered' | 'read'>());
  const loadWorkspaceOnceRef = useRef<() => Promise<void>>(async () => {});
  const reconciliationRunnerRef = useRef<ReturnType<typeof createCoalescedRunner> | null>(null);
  const lastRealtimeEventAtRef = useRef(0);
  const endAccessRef = useRef(auth.endAccess);
  const refreshSessionRef = useRef(auth.refreshSession);
  // One forced refresh per failing load: a token can lapse in flight or run
  // ahead of the server clock, and that must not end access on its own.
  const retriedAfterRefreshRef = useRef(false);
  const attachmentUploadsRef = useRef(new Map<string, AttachmentUploadOperation>());
  const attachmentCancellationsRef = useRef(new Map<string, AttachmentCancellation>());
  const attachmentScanTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const conversationAvatarCacheRef = useRef(new Map<string, { url: string; expiresAt: number }>());
  const conversationAvatarTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [profileAvatarUrls, setProfileAvatarUrls] = useState<Record<string, string>>({});
  // Profile pictures are fetched on demand per user: a positive entry holds the
  // signed URL and its path (the sender's own path is the activation
  // precondition); a negative entry remembers "no picture" for ten minutes.
  const profileAvatarCacheRef = useRef(new Map<string, { url: string | null; avatarPath: string | null; expiresAt: number }>());
  const profileAvatarInflightRef = useRef(new Set<string>());
  const profileAvatarTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const conversationAvatarLoaderRef = useRef<(
    organizationId: string,
    conversationId: string,
    avatarPath: string,
    force?: boolean,
  ) => Promise<void>>(async () => {});

  useEffect(() => {
    endAccessRef.current = auth.endAccess;
    refreshSessionRef.current = auth.refreshSession;
  }, [auth.endAccess, auth.refreshSession]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    if (
      !publicRuntimeConfig.offlineCacheEnabled
      || connectivity !== 'online'
      || !snapshot
      || snapshot.currentUser.id !== auth.user?.id
    ) return;
    const key = offlineWorkspaceCacheKey(snapshot.currentUser.id);
    const cacheNow = Date.now();
    const serialized = serializeOfflineWorkspace(snapshot, cacheNow);
    const expiresAt = offlineWorkspaceExpiresAt(snapshot, cacheNow);
    if (!key || !serialized || !expiresAt) return;
    const cachePayload = serialized;
    const timeout = setTimeout(() => {
      void clientStore.putCache(key, cachePayload, expiresAt).catch(() => {
        // The durable server and encrypted outbox remain authoritative when a
        // device refuses, exhausts, or corrupts replaceable offline storage.
      });
    }, 250);
    return () => clearTimeout(timeout);
  }, [auth.user?.id, connectivity, snapshot]);

  const repositories = useMemo<{ reads: ReadRepository | null; commands: CommandRepository }>(() => {
    const repositoryContext = {
      getSession: async () => {
        const currentClient = getSupabaseClient();
        if (!currentClient) return null;
        // The persisted session is re-read from the keychain on every call
        // and rewritten on every token refresh; a momentary miss must not be
        // mistaken for a sign-out (that ended access mid-conversation on the
        // device suite). The storage now commits atomically; this retry is
        // the second line of defence.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const { data } = await currentClient.auth.getSession();
          if (data.session || attempt === 2) return data.session;
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        }
        return null;
      },
    };
    return {
      // Native uses the same bounded, revocation-aware Edge read contract as web.
      // The Supabase client remains direct only for Auth, Realtime, and signed Storage.
      reads: new WebReadRepository(repositoryContext),
      commands: new BffCommandRepository(repositoryContext),
    };
  }, []);

  const executeImmediate = useCallback(
    async <T,>(action: string, command: () => Promise<T>): Promise<T | null> => {
      setActionBusy(action);
      setActionError(null);
      try {
        const result = await command();
        setConnectivity('online');
        return result;
      } catch (commandError) {
        // Generic failures quote the stable code so a member can report them
        // and a device-suite screenshot names the failing step (a photo send
        // showed only the generic copy in run 2026-09-04T04-57-19).
        const localized = t(errorMessageKey(commandError));
        const identifier = errorIdentifier(commandError);
        setActionError(identifier ? `${localized} (${identifier})` : localized);
        if (isOfflineError(commandError)) setConnectivity('offline');
        return null;
      } finally {
        setActionBusy((current) => (current === action ? null : current));
      }
    },
    [t],
  );

  const loadConversationAvatarUrl = useCallback(async (
    organizationId: string,
    conversationId: string,
    avatarPath: string,
    force = false,
  ) => {
    const attachmentId = conversationAvatarAttachmentId(
      organizationId,
      conversationId,
      avatarPath,
    );
    if (!attachmentId) return;
    const cached = conversationAvatarCacheRef.current.get(avatarPath);
    if (!force && cached && cached.expiresAt > Date.now()) {
      setConversationAvatarUrls((current) => ({ ...current, [conversationId]: cached.url }));
      return;
    }
    try {
      const grant = await repositories.commands.getConversationAvatarReadGrant({
        organizationId,
        conversationId,
        attachmentId,
      });
      const currentConversation = snapshotRef.current?.conversations.find(
        (conversation) => conversation.id === conversationId,
      );
      if (
        !mountedRef.current || snapshotRef.current?.organizationId !== organizationId ||
        currentConversation?.avatarPath !== avatarPath
      ) return;
      const expiresAt = Date.now() + grant.expiresInSeconds * 1000;
      conversationAvatarCacheRef.current.set(avatarPath, { url: grant.signedUrl, expiresAt });
      setConversationAvatarUrls((current) => ({ ...current, [conversationId]: grant.signedUrl }));
      const previousTimer = conversationAvatarTimersRef.current.get(conversationId);
      if (previousTimer) clearTimeout(previousTimer);
      const timer = setTimeout(() => {
        conversationAvatarTimersRef.current.delete(conversationId);
        conversationAvatarCacheRef.current.delete(avatarPath);
        setConversationAvatarUrls((current) => {
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
        const latest = snapshotRef.current?.conversations.find(
          (conversation) => conversation.id === conversationId,
        );
        if (latest?.avatarPath === avatarPath) {
          void conversationAvatarLoaderRef.current(
            organizationId,
            conversationId,
            avatarPath,
            true,
          );
        }
      }, Math.max(1_000, grant.expiresInSeconds * 1000 - 10_000));
      conversationAvatarTimersRef.current.set(conversationId, timer);
    } catch {
      // The initials fallback is intentional when authorization expires or the
      // avatar changes while an inline grant is being issued.
    }
  }, [repositories.commands]);

  useEffect(() => {
    conversationAvatarLoaderRef.current = loadConversationAvatarUrl;
  }, [loadConversationAvatarUrl]);

  const loadProfileAvatarUrl = useCallback(async (userId: string, force = false) => {
    const organizationId = snapshotRef.current?.organizationId;
    if (!organizationId || profileAvatarInflightRef.current.has(userId)) return;
    const cached = profileAvatarCacheRef.current.get(userId);
    if (!force && cached && cached.expiresAt > Date.now()) return;
    profileAvatarInflightRef.current.add(userId);
    try {
      const grant = await repositories.commands.getProfileAvatarReadGrant({ organizationId, userId });
      if (!mountedRef.current || snapshotRef.current?.organizationId !== organizationId) return;
      const expiresAt = Date.now() + grant.expiresInSeconds * 1000;
      profileAvatarCacheRef.current.set(userId, { url: grant.signedUrl, avatarPath: grant.avatarPath, expiresAt });
      setProfileAvatarUrls((current) => ({ ...current, [userId]: grant.signedUrl }));
      const previousTimer = profileAvatarTimersRef.current.get(userId);
      if (previousTimer) clearTimeout(previousTimer);
      profileAvatarTimersRef.current.set(userId, setTimeout(() => {
        profileAvatarTimersRef.current.delete(userId);
        void loadProfileAvatarUrl(userId, true);
      }, Math.max(1_000, grant.expiresInSeconds * 1000 - 15_000)));
    } catch (error) {
      // 404 means the user has no picture; anything else is retried on the
      // next request after a short pause (initials stay meanwhile).
      const none = error instanceof RepositoryError && (error.status === 404 || error.code === 'not_found');
      profileAvatarCacheRef.current.set(userId, {
        url: null,
        avatarPath: null,
        expiresAt: Date.now() + (none ? 10 * 60_000 : 30_000),
      });
      setProfileAvatarUrls((current) => {
        if (!(userId in current)) return current;
        const next = { ...current };
        delete next[userId];
        return next;
      });
    } finally {
      profileAvatarInflightRef.current.delete(userId);
    }
  }, [repositories.commands]);

  const requestProfileAvatar = useCallback((userId: string) => {
    if (!userId) return;
    const cached = profileAvatarCacheRef.current.get(userId);
    if (cached && cached.expiresAt > Date.now()) return;
    void loadProfileAvatarUrl(userId);
  }, [loadProfileAvatarUrl]);

  const uploadProfileAvatar = useCallback(async (selected: SelectedAttachment) => {
    if (!snapshot || connectivity === 'offline') return false;
    const userId = snapshot.currentUser.id;
    const result = await executeImmediate('profile-avatar-upload', async () => {
      const optimized = await optimizeImageAttachment({ ...selected, imageMode: 'optimized' });
      const prepared = await prepareAttachment(optimized);
      try {
        if (
          !CONVERSATION_AVATAR_MIME_TYPES.has(prepared.mimeType) ||
          prepared.byteSize > CONVERSATION_AVATAR_MAX_BYTES
        ) {
          throw new RepositoryError(
            'Profile photos must be JPEG, PNG, or WebP and no larger than 5 MB.',
            'profile_avatar_invalid',
            false,
          );
        }
        // The activation precondition is the current path; fetch it when unknown.
        let expectedAvatarPath = profileAvatarCacheRef.current.get(userId)?.avatarPath ?? null;
        if (!profileAvatarCacheRef.current.has(userId)) {
          try {
            const current = await repositories.commands.getProfileAvatarReadGrant({ organizationId: snapshot.organizationId, userId });
            expectedAvatarPath = current.avatarPath;
          } catch (error) {
            if (!(error instanceof RepositoryError && (error.status === 404 || error.code === 'not_found'))) throw error;
            expectedAvatarPath = null;
          }
        }
        const grant = await repositories.commands.createProfileAvatarUploadGrant({
          organizationId: snapshot.organizationId,
          fileName: prepared.name,
          mimeType: prepared.mimeType as 'image/jpeg' | 'image/png' | 'image/webp',
          byteSize: prepared.byteSize,
          sha256Hex: prepared.sha256Hex,
          idempotencyKey: `profile-avatar-grant-${userId}-${prepared.sha256Hex.slice(0, 32)}`,
        });
        // The transfer needs only the signed URL; the profile grant has no attachment id.
        await uploadAttachment(
          grant as unknown as Parameters<typeof uploadAttachment>[0],
          { uri: prepared.uri, bytes: prepared.bytes },
          prepared.mimeType,
        );
        const activated = await repositories.commands.activateProfileAvatar({
          organizationId: snapshot.organizationId,
          uploadId: grant.uploadId,
          expectedAvatarPath,
          idempotencyKey: `profile-avatar-activate-${grant.uploadId}`,
        });
        profileAvatarCacheRef.current.set(userId, { url: selected.uri, avatarPath: activated.avatarPath, expiresAt: Date.now() + 60_000 });
        setProfileAvatarUrls((current) => ({ ...current, [userId]: selected.uri }));
        void loadProfileAvatarUrl(userId, true);
        return true;
      } finally {
        await cleanupPreparedAttachment(prepared);
      }
    });
    return result === true;
  }, [connectivity, executeImmediate, loadProfileAvatarUrl, repositories.commands, snapshot]);

  const removeProfileAvatar = useCallback(async () => {
    if (!snapshot || connectivity === 'offline') return false;
    const userId = snapshot.currentUser.id;
    const expectedAvatarPath = profileAvatarCacheRef.current.get(userId)?.avatarPath ?? null;
    if (!expectedAvatarPath) return false;
    const result = await executeImmediate('profile-avatar-remove', async () => {
      await repositories.commands.removeProfileAvatar({
        organizationId: snapshot.organizationId,
        expectedAvatarPath,
        idempotencyKey: `profile-avatar-remove-${userId}-${expectedAvatarPath.split('/')[2]}`,
      });
      profileAvatarCacheRef.current.set(userId, { url: null, avatarPath: null, expiresAt: Date.now() + 10 * 60_000 });
      setProfileAvatarUrls((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
      return true;
    });
    return result === true;
  }, [connectivity, executeImmediate, repositories.commands, snapshot]);

  const hydrateOutbox = useCallback(async (nextSnapshot: WorkspaceSnapshot) => {
    if (!offlineWorkspaceEntitlement(nextSnapshot.currentUser).eligible) {
      await clientStore.purgeUser(nextSnapshot.currentUser.id);
      setMessageOutbox([]);
      setOutboxCount(0);
      setFailedOutboxCount(0);
      return;
    }
    const queued = await clientStore.listOutbox(
      nextSnapshot.currentUser.id,
      nextSnapshot.organizationId,
    );
    const visible = visibleMessageOutbox(
      queued,
      nextSnapshot.currentUser.id,
      nextSnapshot.organizationId,
    );
    setMessageOutbox(visible);
    setOutboxCount(visible.filter((item) => item.state !== 'failed').length);
    setFailedOutboxCount(visible.filter((item) => item.state === 'failed').length);
    for (const command of queued) {
      if (command.kind !== 'message_receipt') continue;
      const receipt = command.payload as MessageReceiptInput;
      const key = receiptProgressKey(receipt);
      const previous = receiptProgressRef.current.get(key);
      if (receipt.state === 'read' || !previous) receiptProgressRef.current.set(key, receipt.state);
    }
    const pending = queued.filter(
      (item): item is OutboxCommand<SendMessageInput> => item.kind === 'send_message',
    );
    if (!pending.length) return;
    nextSnapshot.messages = { ...nextSnapshot.messages };
    for (const command of pending) {
      const conversationId = command.payload.conversationId;
      nextSnapshot.messages[conversationId] = mergeMessages(
        nextSnapshot.messages[conversationId] ?? [],
        [messageFromCommand(command, nextSnapshot.currentUser, t)],
      );
    }
  }, []);

  const refreshIdentity = `${auth.mode}:${auth.user?.id ?? ''}`;
  const loadWorkspaceOnce = useCallback(async () => {
    const reads = repositories.reads;
    const userId = auth.user?.id ?? null;
    const requestedIdentity = refreshIdentityRef.current;
    if (!reads || !userId) {
      snapshotRef.current = null;
      setSnapshot(null);
      setStatus('error');
      setError(
        auth.mode === 'web_locked'
          ? 'Secure web sessions require the Newone BFF and are not enabled in this build.'
          : 'Connect the Newone identity and data service to continue.',
      );
      return;
    }
    const cacheKey = offlineWorkspaceCacheKey(userId);
    let storeInitialized = false;
    // A background reconciliation must not tear down Realtime. Loading is only
    // a launch state before an authoritative snapshot exists.
    if (!snapshotRef.current) setStatus('loading');
    setError(null);
    try {
      await clientStore.initialize();
      storeInitialized = true;
      if (!publicRuntimeConfig.offlineCacheEnabled && cacheKey) {
        await clientStore.removeCache(cacheKey);
      }
      const next = await reads.loadWorkspace(
        userId,
        selectedConversationIdRef.current || null,
      );
      retriedAfterRefreshRef.current = false;
      const nextEntitlement = offlineWorkspaceEntitlement(next.currentUser);
      if (next.currentUser.membershipType !== 'guest' && !nextEntitlement.eligible) {
        await clientStore.purgeUser(userId);
        await endAccessRef.current();
        return;
      }
      await hydrateOutbox(next);
      if (!mountedRef.current || requestedIdentity !== refreshIdentityRef.current) return;
      setWorkspaceAccessDeadline(
        next.currentUser.membershipType === 'employee'
          ? null
          : next.currentUser.accessExpiresAt,
      );
      const previousSnapshot = snapshotRef.current;
      if (
        previousSnapshot
        && previousSnapshot.organizationId === next.organizationId
        && previousSnapshot.currentUser.id === next.currentUser.id
        && previousSnapshot.currentUser.membershipType === next.currentUser.membershipType
        && previousSnapshot.currentUser.accessExpiresAt === next.currentUser.accessExpiresAt
        && previousSnapshot.currentUser.guestSponsorUserId === next.currentUser.guestSponsorUserId
      ) {
        const selectedId = selectedConversationIdRef.current;
        next.messages = Object.fromEntries(next.conversations.map((conversation) => {
          if (conversation.managementOnly) return [conversation.id, []];
          const previousMessages = previousSnapshot.messages[conversation.id] ?? [];
          const incomingMessages = next.messages[conversation.id] ?? [];
          return [
            conversation.id,
            incomingMessages.length
              ? reconcileMessages(previousMessages, incomingMessages)
              : previousMessages,
          ];
        }));
        next.cursors = { ...previousSnapshot.cursors, ...next.cursors };
        for (const conversation of next.conversations) {
          if (conversation.managementOnly) next.cursors[conversation.id] = null;
        }
        if (selectedId && previousMessagesLoaded(previousSnapshot, selectedId)) {
          const selected = next.conversations.find((conversation) => conversation.id === selectedId);
          if (!selected?.managementOnly) {
            next.cursors[selectedId] = previousSnapshot.cursors[selectedId] ?? null;
          }
        }
      }
      snapshotRef.current = next;
      setSnapshot(next);
      const avatarConversationIds = new Set(
        next.conversations.filter((conversation) => conversation.avatarPath).map((conversation) => conversation.id),
      );
      setConversationAvatarUrls((current) => Object.fromEntries(
        Object.entries(current).filter(([conversationId]) => avatarConversationIds.has(conversationId)),
      ));
      for (const conversation of next.conversations) {
        if (conversation.avatarPath) {
          void loadConversationAvatarUrl(
            next.organizationId,
            conversation.id,
            conversation.avatarPath,
          );
        }
      }
      setMessagePagination((current) => Object.fromEntries(next.conversations.map((conversation) => [
        conversation.id,
        {
          hasMore: Boolean(next.cursors[conversation.id]),
          loading: current[conversation.id]?.loading ?? false,
        },
      ])));
      const currentSelection = selectedConversationIdRef.current;
      const nextSelection = currentSelection
        && next.conversations.some((item) => item.id === currentSelection)
        ? currentSelection
        : next.conversations.find((item) => !item.managementOnly)?.id ?? '';
      selectedConversationIdRef.current = nextSelection;
      setSelectedConversationId(nextSelection);
      setStatus(next.conversations.length || next.people.length ? 'ready' : 'empty');
      setConnectivity('online');
      for (const [conversationId, cursor] of Object.entries(next.cursors)) {
        if (next.currentUser.membershipType === 'guest') break;
        if (cursor) {
          await clientStore.putCache(
            `cursor.${next.currentUser.id}.${conversationId}`,
            cursor,
          );
        }
      }
    } catch (loadError) {
      if (!mountedRef.current || requestedIdentity !== refreshIdentityRef.current) return;
      if (definitiveWorkspaceAccessFailure(loadError)) {
        if (
          staleTokenFailure(loadError)
          && !retriedAfterRefreshRef.current
          && await refreshSessionRef.current()
        ) {
          retriedAfterRefreshRef.current = true;
          await loadWorkspaceOnceRef.current();
          return;
        }
        refreshIdentityRef.current = 'access-ended';
        snapshotRef.current = null;
        selectedConversationIdRef.current = '';
        setSnapshot(null);
        setSelectedConversationId('');
        setMessagePagination({});
        await endAccessRef.current();
        return;
      }
      if (
        !snapshotRef.current
        && storeInitialized
        && publicRuntimeConfig.offlineCacheEnabled
        && cacheKey
        && loadError instanceof RepositoryError
        && loadError.retryable
      ) {
        const serialized = await clientStore.getCache(cacheKey).catch(() => null);
        const cached = parseOfflineWorkspace(serialized, userId);
        if (cached) {
          const cachedExpiresAt = offlineWorkspaceSnapshotExpiresAt(cached);
          if (!cachedExpiresAt) {
            await clientStore.removeCache(cacheKey).catch(() => {});
          } else {
            await hydrateOutbox(cached);
            if (!mountedRef.current || requestedIdentity !== refreshIdentityRef.current) return;
            const currentSelection = selectedConversationIdRef.current;
            const nextSelection = currentSelection
              && cached.conversations.some((item: Conversation) => item.id === currentSelection)
              ? currentSelection
              : cached.conversations.find((item: Conversation) => !item.managementOnly)?.id ?? '';
            snapshotRef.current = cached;
            setWorkspaceAccessDeadline(
              cached.currentUser.membershipType === 'contractor' ? cachedExpiresAt : null,
            );
            selectedConversationIdRef.current = nextSelection;
            setSnapshot(cached);
            setSelectedConversationId(nextSelection);
            setMessagePagination(Object.fromEntries(cached.conversations.map((conversation: Conversation) => [
              conversation.id,
              { hasMore: Boolean(cached.cursors[conversation.id]), loading: false },
            ])));
            setStatus(cached.conversations.length || cached.people.length ? 'ready' : 'empty');
            setConnectivity('offline');
            setError(null);
            return;
          }
        }
        if (serialized) await clientStore.removeCache(cacheKey).catch(() => {});
      }
      if (!snapshotRef.current) setStatus('error');
      setError(t(errorMessageKey(loadError)));
      if (isOfflineError(loadError)) setConnectivity('offline');
    }
  }, [auth.mode, auth.user?.id, hydrateOutbox, loadConversationAvatarUrl, repositories.reads, t]);

  useEffect(() => {
    if (refreshIdentityRef.current !== refreshIdentity) {
      for (const operation of attachmentUploadsRef.current.values()) {
        operation.controller?.abort();
        void cleanupPreparedAttachment(operation.prepared);
      }
      attachmentUploadsRef.current.clear();
      attachmentCancellationsRef.current.clear();
      for (const timer of conversationAvatarTimersRef.current.values()) clearTimeout(timer);
      conversationAvatarTimersRef.current.clear();
      conversationAvatarCacheRef.current.clear();
      setConversationAvatarUrls({});
      for (const timer of attachmentScanTimersRef.current) clearTimeout(timer);
      attachmentScanTimersRef.current.clear();
      receiptProgressRef.current.clear();
      loadingOlderRef.current.clear();
      setMessagePagination({});
      setUnreadDividerIds({});
      setMessageOutbox([]);
      setOutboxCount(0);
      setFailedOutboxCount(0);
      setWorkspaceAccessDeadline(null);
    }
    refreshIdentityRef.current = refreshIdentity;
    selectedConversationIdRef.current = selectedConversationId;
    loadWorkspaceOnceRef.current = loadWorkspaceOnce;
  }, [loadWorkspaceOnce, refreshIdentity, selectedConversationId]);

  useEffect(() => {
    const deadline = workspaceAccessDeadline ? Date.parse(workspaceAccessDeadline) : Number.NaN;
    if (!Number.isFinite(deadline)) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const enforceDeadline = async () => {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        timeout = setTimeout(
          () => void enforceDeadline(),
          Math.min(remaining, 2_147_000_000),
        );
        return;
      }
      const current = snapshotRef.current;
      if (cancelled || !current) return;
      setWorkspaceAccessDeadline(null);
      for (const operation of attachmentUploadsRef.current.values()) {
        operation.controller?.abort();
        void cleanupPreparedAttachment(operation.prepared);
      }
      attachmentUploadsRef.current.clear();
      attachmentCancellationsRef.current.clear();
      await clientStore.purgeUser(current.currentUser.id).catch(() => undefined);
      if (cancelled || snapshotRef.current?.currentUser.id !== current.currentUser.id) return;
      snapshotRef.current = null;
      selectedConversationIdRef.current = '';
      setSnapshot(null);
      setSelectedConversationId('');
      setMessagePagination({});
      setMessageOutbox([]);
      setOutboxCount(0);
      setFailedOutboxCount(0);
      setStatus('loading');
      setError(null);
      await loadWorkspaceOnceRef.current();
    };
    void enforceDeadline();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [workspaceAccessDeadline]);

  useEffect(() => {
    mountedRef.current = true;
    const attachmentUploads = attachmentUploadsRef.current;
    const attachmentCancellations = attachmentCancellationsRef.current;
    const attachmentScanTimers = attachmentScanTimersRef.current;
    const conversationAvatarTimers = conversationAvatarTimersRef.current;
    const conversationAvatarCache = conversationAvatarCacheRef.current;
    const runner = createCoalescedRunner(() => loadWorkspaceOnceRef.current());
    reconciliationRunnerRef.current = runner;
    return () => {
      mountedRef.current = false;
      for (const operation of attachmentUploads.values()) {
        operation.controller?.abort();
        void cleanupPreparedAttachment(operation.prepared);
      }
      attachmentUploads.clear();
      attachmentCancellations.clear();
      for (const timer of conversationAvatarTimers.values()) clearTimeout(timer);
      conversationAvatarTimers.clear();
      conversationAvatarCache.clear();
      for (const timer of attachmentScanTimers) clearTimeout(timer);
      attachmentScanTimers.clear();
      runner.dispose();
      if (reconciliationRunnerRef.current === runner) {
        reconciliationRunnerRef.current = null;
      }
    };
  }, []);

  const refresh = useCallback(
    () => reconciliationRunnerRef.current?.run() ?? Promise.resolve(),
    [],
  );

  useEffect(() => {
    const timeout = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timeout);
  }, [refresh, refreshIdentity]);

  const reconcileConversation = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const reconcileWorkspace = useCallback(() => {
    void refresh();
  }, [refresh]);

  // A conversation stays fresh from its own successful sends even when
  // nothing else prompts a reconcile: the sender must see server-assigned
  // state (ids, ordering, receipts) without a duplicated optimistic row.
  // mergeMessages() already reconciles by clientMessageId/serverId, so a
  // plain refresh is safe here.
  const reconcileConversationAfterSend = useCallback((conversationId: string) => {
    if (conversationId && conversationId === selectedConversationIdRef.current) void refresh();
  }, [refresh]);

  const handleAccessEnded = useCallback(() => {
    void endAccessRef.current();
  }, []);

  // Any signal actually delivered over the socket makes an immediate extra
  // poll redundant; the periodic reconcile timer checks this before running.
  const markRealtimeEventFresh = useCallback(() => {
    lastRealtimeEventAtRef.current = Date.now();
  }, []);
  const handleRealtimeInvalidate = useCallback(() => {
    markRealtimeEventFresh();
    reconcileWorkspace();
  }, [markRealtimeEventFresh, reconcileWorkspace]);
  const handleRealtimeReconcile = useCallback(() => {
    markRealtimeEventFresh();
    reconcileWorkspace();
  }, [markRealtimeEventFresh, reconcileWorkspace]);

  useUserRealtime({
    enabled: Boolean(snapshot)
      && snapshot?.currentUser.id === auth.user?.id,
    organizationId: snapshot?.organizationId ?? '',
    userId: snapshot?.currentUser.id ?? '',
    accessToken: auth.realtimeToken ?? undefined,
    resubscribeNonce: realtimeResubscribeNonce,
    // Broadcast data is never merged into local state. A session-aware read is
    // the authority for edits, removals, translations, membership, and policy.
    onInvalidate: handleRealtimeInvalidate,
    onReconcile: handleRealtimeReconcile,
    onAccessEnded: handleAccessEnded,
    onStateChange: setRealtimeState,
  });

  const markMessage = useCallback(
    (clientMessageId: string, patch: Partial<Message>) => {
      setSnapshot((current) => {
        if (!current) return current;
        const nextMessages = Object.fromEntries(
          Object.entries(current.messages).map(([conversationId, messages]) => [
            conversationId,
            messages.map((message) =>
              message.clientMessageId === clientMessageId ? { ...message, ...patch } : message,
            ),
          ]),
        );
        return { ...current, messages: nextMessages };
      });
    },
    [],
  );

  const patchServerMessage = useCallback((messageId: string, patch: Partial<Message>) => {
    setSnapshot((current) => {
      if (!current) return current;
      return {
        ...current,
        messages: Object.fromEntries(
          Object.entries(current.messages).map(([conversationId, messages]) => [
            conversationId,
            messages.map((message) =>
              message.serverId === messageId ? { ...message, ...patch } : message,
            ),
          ]),
        ),
      };
    });
  }, []);

  const patchLocalAttachment = useCallback((
    clientMessageId: string,
    patch: Partial<Omit<Attachment, 'transfer'>> & {
      transfer?: Partial<NonNullable<Attachment['transfer']>>;
    },
  ) => {
    setSnapshot((current) => {
      if (!current) return current;
      const { transfer, ...attachmentPatch } = patch;
      return {
        ...current,
        messages: Object.fromEntries(
          Object.entries(current.messages).map(([conversationId, messages]) => [
            conversationId,
            messages.map((message) => {
              if (message.clientMessageId !== clientMessageId || !message.attachment) return message;
              const previousTransfer = message.attachment.transfer;
              return {
                ...message,
                attachment: {
                  ...message.attachment,
                  ...attachmentPatch,
                  ...(transfer
                    ? {
                        transfer: {
                          state: transfer.state ?? previousTransfer?.state ?? 'preparing',
                          progress: transfer.progress ?? previousTransfer?.progress ?? 0,
                          ...(transfer.errorCode
                            ? { errorCode: transfer.errorCode }
                            : {}),
                        },
                      }
                    : {}),
                },
              };
            }),
          ]),
        ),
      };
    });
  }, []);

  const removeLocalMessage = useCallback((clientMessageId: string, conversationId: string) => {
    setSnapshot((current) => {
      if (!current) return current;
      const messages = (current.messages[conversationId] ?? []).filter(
        (message) => message.clientMessageId !== clientMessageId,
      );
      const last = messages.at(-1);
      return {
        ...current,
        messages: { ...current.messages, [conversationId]: messages },
        conversations: current.conversations.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                lastMessage: last?.originalText
                  || (last?.attachment ? `Attachment: ${last.attachment.name}` : ''),
                lastActivity: last?.sentAt ?? conversation.lastActivity,
              }
            : conversation
        ),
      };
    });
  }, []);

  const flushOutbox = useCallback(async () => {
    if (flushingRef.current) {
      flushAgainRef.current = true;
      return;
    }
    const initialSnapshot = snapshotRef.current;
    if (!initialSnapshot) return;
    flushingRef.current = true;
    try {
      do {
        flushAgainRef.current = false;
        const currentSnapshot = snapshotRef.current;
        if (!currentSnapshot) break;
        if (!offlineWorkspaceEntitlement(currentSnapshot.currentUser).eligible) {
          await clientStore.purgeUser(currentSnapshot.currentUser.id);
          setMessageOutbox([]);
          setOutboxCount(0);
          setFailedOutboxCount(0);
          break;
        }
        const commands = await clientStore.listOutbox(
          currentSnapshot.currentUser.id,
          currentSnapshot.organizationId,
        );
        const visibleCommands = visibleMessageOutbox(
          commands,
          currentSnapshot.currentUser.id,
          currentSnapshot.organizationId,
        );
        setMessageOutbox(visibleCommands);
        setOutboxCount(visibleCommands.filter((item) => item.state !== 'failed').length);
        setFailedOutboxCount(visibleCommands.filter((item) => item.state === 'failed').length);
        for (const command of commands.filter((item) => item.state !== 'failed')) {
          const sending = { ...command, state: 'sending' as const, attempts: command.attempts + 1 };
          await clientStore.updateOutbox(sending);
          try {
            if (command.kind === 'send_message') {
              const input = command.payload as SendMessageInput;
              const receipt = await repositories.commands.sendMessage(input);
              markMessage(input.clientMessageId, {
                serverId: receipt.messageId,
                deliveryState: 'sent',
                failureReason: undefined,
              });
              reconcileConversationAfterSend(input.conversationId);
            } else if (command.kind === 'message_receipt') {
              const input = command.payload as MessageReceiptInput;
              const receipt = await repositories.commands.markMessageReceipt(input);
              patchServerMessage(input.messageId, {
                deliveryState: receipt.readAt ? 'read' : 'delivered',
                receipt: {
                  scope: 'self',
                  delivered: true,
                  deliveredAt: receipt.deliveredAt,
                  read: receipt.readAt !== null,
                  readAt: receipt.readAt,
                },
              });
            } else if (command.kind === 'acknowledge_update') {
              await repositories.commands.acknowledgeUpdate(command.payload as {
                organizationId: string;
                versionId: string;
                idempotencyKey: string;
              });
            } else {
              await repositories.commands.registerDevice(
                command.payload as Parameters<CommandRepository['registerDevice']>[0],
              );
            }
            await clientStore.removeOutbox(command.id);
            setConnectivity('online');
            setActionError(null);
          } catch (commandError) {
            const retryable = commandError instanceof RepositoryError && commandError.retryable;
            if (command.kind === 'message_receipt' && !retryable) {
              const receipt = command.payload as MessageReceiptInput;
              receiptProgressRef.current.delete(receiptProgressKey(receipt));
              await clientStore.removeOutbox(command.id);
              continue;
            }
            const failed = {
              ...sending,
              state: retryable ? ('queued' as const) : ('failed' as const),
              lastErrorCode:
                commandError instanceof RepositoryError ? commandError.code : 'unknown_error',
            };
            await clientStore.updateOutbox(failed);
            if (command.kind === 'send_message' && !retryable) {
              markMessage((command.payload as SendMessageInput).clientMessageId, {
                deliveryState: 'failed',
                failureReason: t(errorMessageKey(commandError)),
              });
            } else if (command.kind === 'acknowledge_update' && !retryable) {
              const versionId = (command.payload as { versionId: string }).versionId;
              setSnapshot((current) =>
                current
                  ? {
                      ...current,
                      updates: current.updates.map((update) =>
                        update.versionId === versionId && update.acknowledged
                          ? {
                              ...update,
                              acknowledged: false,
                              acknowledgedCount: Math.max(0, update.acknowledgedCount - 1),
                            }
                          : update,
                      ),
                    }
                  : current,
              );
            }
            if (command.kind !== 'message_receipt') {
              setActionError(t(errorMessageKey(commandError)));
            }
            if (isOfflineError(commandError)) setConnectivity('offline');
            if (retryable) break;
          }
        }
        const remaining = await clientStore.listOutbox(
          currentSnapshot.currentUser.id,
          currentSnapshot.organizationId,
        );
        const visibleRemaining = visibleMessageOutbox(
          remaining,
          currentSnapshot.currentUser.id,
          currentSnapshot.organizationId,
        );
        setMessageOutbox(visibleRemaining);
        setOutboxCount(visibleRemaining.filter((item) => item.state !== 'failed').length);
        setFailedOutboxCount(visibleRemaining.filter((item) => item.state === 'failed').length);
      } while (flushAgainRef.current);
    } finally {
      flushingRef.current = false;
    }
  }, [markMessage, patchServerMessage, reconcileConversationAfterSend, repositories.commands, t]);

  const enqueueMessageReceipt = useCallback(async (input: Omit<MessageReceiptInput, 'idempotencyKey'>) => {
    const key = receiptProgressKey(input);
    const previous = receiptProgressRef.current.get(key);
    if (previous === 'read' || (previous === 'delivered' && input.state === 'delivered')) return;
    receiptProgressRef.current.set(key, input.state);
    const idempotencyKey = createClientId();
    const payload: MessageReceiptInput = { ...input, idempotencyKey };
    const currentUser = snapshotRef.current?.currentUser;
    if (currentUser?.membershipType === 'guest') {
      try {
        const result = await repositories.commands.markMessageReceipt(payload);
        patchServerMessage(input.messageId, {
          deliveryState: result.readAt ? 'read' : 'delivered',
          receipt: {
            scope: 'self',
            delivered: true,
            deliveredAt: result.deliveredAt,
            read: result.readAt !== null,
            readAt: result.readAt,
          },
        });
        return;
      } catch (directError) {
        if (previous) receiptProgressRef.current.set(key, previous);
        else receiptProgressRef.current.delete(key);
        if (isOfflineError(directError)) setConnectivity('offline');
        throw directError;
      }
    }
    if (!currentUser || !offlineWorkspaceEntitlement(currentUser).eligible) {
      if (currentUser) await clientStore.purgeUser(currentUser.id);
      if (previous) receiptProgressRef.current.set(key, previous);
      else receiptProgressRef.current.delete(key);
      return;
    }
    const command: OutboxCommand<MessageReceiptInput> = {
      id: idempotencyKey,
      organizationId: input.organizationId,
      userId: snapshotRef.current?.currentUser.id ?? '',
      kind: 'message_receipt',
      payload,
      createdAt: new Date().toISOString(),
      attempts: 0,
      state: 'queued',
    };
    if (!command.userId) {
      receiptProgressRef.current.delete(key);
      return;
    }
    try {
      await clientStore.enqueue(command);
      void flushOutbox();
    } catch (queueError) {
      if (previous) receiptProgressRef.current.set(key, previous);
      else receiptProgressRef.current.delete(key);
      throw queueError;
    }
  }, [flushOutbox, patchServerMessage, repositories.commands]);

  const observeConversation = useCallback(async (conversationId: string) => {
    const current = snapshotRef.current;
    const conversation = current?.conversations.find((item) => item.id === conversationId);
    if (!current || !conversation) return;
    const messages = current.messages[conversationId] ?? [];
    if (conversation.unreadCount > 0) {
      const dividerId = firstUnreadMessageId(
        messages,
        conversation.lastReadMessageId ?? null,
        conversation.unreadCount,
      );
      if (dividerId) {
        setUnreadDividerIds((existing) => existing[conversationId] === dividerId
          ? existing
          : { ...existing, [conversationId]: dividerId });
      }
    }
    for (const message of messages) {
      if (message.isOwn || !message.serverId) continue;
      const key = receiptProgressKey({
        organizationId: current.organizationId,
        conversationId,
        messageId: message.serverId,
      });
      if (message.deliveryState === 'read') {
        receiptProgressRef.current.set(key, 'read');
      } else if (message.deliveryState === 'delivered') {
        if (!receiptProgressRef.current.has(key)) receiptProgressRef.current.set(key, 'delivered');
      } else if (message.deliveryState === 'sent') {
        try {
          await enqueueMessageReceipt({
            organizationId: current.organizationId,
            conversationId,
            messageId: message.serverId,
            state: 'delivered',
          });
        } catch {
          // A later authoritative reconciliation will retry this receipt
          // without blocking the member from reading the conversation.
          return;
        }
      }
    }
  }, [enqueueMessageReceipt]);

  const markConversationRead = useCallback(async (conversationId: string) => {
    if (AppState.currentState !== 'active') return;
    const current = snapshotRef.current;
    const conversation = current?.conversations.find((item) => item.id === conversationId);
    const messages = current?.messages[conversationId] ?? [];
    const latestIncoming = latestIncomingServerMessage(messages) as Message | null;
    if (!current || !conversation || !latestIncoming?.serverId) return;
    if (conversation.unreadCount > 0) {
      const dividerId = firstUnreadMessageId(
        messages,
        conversation.lastReadMessageId ?? null,
        conversation.unreadCount,
      );
      if (dividerId) {
        setUnreadDividerIds((existing) => ({ ...existing, [conversationId]: dividerId }));
      }
    }
    try {
      await enqueueMessageReceipt({
        organizationId: current.organizationId,
        conversationId,
        messageId: latestIncoming.serverId,
        state: 'read',
      });
    } catch {
      return;
    }
    const readAt = new Date().toISOString();
    const nextMessages = messages.map((message) =>
      !message.isOwn
        && message.serverId
        && compareMessageIds(message.serverId, latestIncoming.serverId as string) <= 0
        ? {
            ...message,
            deliveryState: 'read' as const,
            receipt: message.receipt?.scope === 'self'
              ? {
                  ...message.receipt,
                  delivered: true,
                  deliveredAt: message.receipt.deliveredAt ?? readAt,
                  read: true,
                  readAt,
                }
              : message.receipt,
          }
        : message
    );
    const nextSnapshot: WorkspaceSnapshot = {
      ...current,
      messages: { ...current.messages, [conversationId]: nextMessages },
      conversations: current.conversations.map((item) => item.id === conversationId
        ? { ...item, unreadCount: 0, lastReadMessageId: latestIncoming.serverId as string }
        : item),
    };
    snapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
  }, [enqueueMessageReceipt]);

  const loadOlderMessages = useCallback(async (conversationId: string) => {
    const initial = snapshotRef.current;
    const cursor = initial?.cursors[conversationId] ?? null;
    if (
      !initial
      || !cursor
      || !repositories.reads
      || loadingOlderRef.current.has(conversationId)
    ) return false;
    loadingOlderRef.current.add(conversationId);
    setMessagePagination((current) => ({
      ...current,
      [conversationId]: { hasMore: true, loading: true },
    }));
    try {
      const page = await repositories.reads.loadMessages({
        organizationId: initial.organizationId,
        conversationId,
        userId: initial.currentUser.id,
        after: cursor,
      });
      const latest = snapshotRef.current;
      if (
        !latest
        || latest.organizationId !== initial.organizationId
        || latest.currentUser.id !== initial.currentUser.id
        || latest.cursors[conversationId] !== cursor
      ) return false;
      const nextSnapshot: WorkspaceSnapshot = {
        ...latest,
        messages: {
          ...latest.messages,
          [conversationId]: mergeMessages(latest.messages[conversationId] ?? [], page.items),
        },
        cursors: { ...latest.cursors, [conversationId]: page.cursor },
      };
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setMessagePagination((current) => ({
        ...current,
        [conversationId]: { hasMore: Boolean(page.cursor), loading: false },
      }));
      if (latest.currentUser.membershipType !== 'guest') {
        await clientStore.putCache(
          `cursor.${latest.currentUser.id}.${conversationId}`,
          page.cursor ?? '',
        );
      }
      return page.items.length > 0;
    } catch (pageError) {
      setActionError(t(errorMessageKey(pageError)));
      if (isOfflineError(pageError)) setConnectivity('offline');
      return false;
    } finally {
      loadingOlderRef.current.delete(conversationId);
      setMessagePagination((current) => ({
        ...current,
        [conversationId]: {
          hasMore: current[conversationId]?.hasMore ?? false,
          loading: false,
        },
      }));
    }
  }, [repositories.reads, t]);

  const ensureMessageLoaded = useCallback(async (conversationId: string, messageId: string) => {
    for (let page = 0; page < 5; page += 1) {
      const current = snapshotRef.current;
      if (current?.messages[conversationId]?.some((message) => message.serverId === messageId)) {
        return true;
      }
      if (!current?.cursors[conversationId]) return false;
      const previousCursor = current.cursors[conversationId];
      await loadOlderMessages(conversationId);
      const next = snapshotRef.current;
      if (next?.messages[conversationId]?.some((message) => message.serverId === messageId)) {
        return true;
      }
      if (!next || next.cursors[conversationId] === previousCursor) return false;
    }
    return false;
  }, [loadOlderMessages]);

  const requestTranslation = useCallback(async (message: Message) => {
    const current = snapshotRef.current;
    const targetLanguage = current?.messageDisplayLanguage;
    const detectionState = message.languageDetection?.state;
    if (
      !current
      || !message.serverId
      || !targetLanguage
      || (detectionState !== 'completed' && detectionState !== 'failed')
      || (detectionState === 'completed'
        && message.languageDetection?.detectedLanguage === targetLanguage
        && !message.languageDetection?.method?.endsWith(':sender-language'))
    ) return false;
    const result = await executeImmediate(`translation-request:${message.serverId}`, () =>
      repositories.commands.requestTranslation({
        organizationId: current.organizationId,
        conversationId: message.conversationId,
        messageId: message.serverId as string,
        targetLanguage,
        idempotencyKey: createClientId(),
      })
    );
    if (!result) return false;
    patchServerMessage(message.serverId, { translationState: 'queued' });
    void refresh();
    return true;
  }, [executeImmediate, patchServerMessage, refresh, repositories.commands]);

  const proposeTranslationCorrection = useCallback(async (
    message: Message,
    correctedBody: string,
    rationale?: string,
  ) => {
    const current = snapshotRef.current;
    if (
      !current
      || !message.serverId
      || !message.translation
      || message.translation.status !== 'completed'
      || !correctedBody.trim()
    ) return false;
    const result = await executeImmediate(`translation-correction:${message.serverId}`, () =>
      repositories.commands.proposeTranslationCorrection({
        organizationId: current.organizationId,
        conversationId: message.conversationId,
        messageId: message.serverId as string,
        targetLanguage: message.translation!.targetLanguage,
        correctedBody,
        rationale: rationale?.trim() || null,
        idempotencyKey: createClientId(),
      })
    );
    if (!result) return false;
    await refresh();
    return true;
  }, [executeImmediate, refresh, repositories.commands]);

  const reviewTranslationCorrection = useCallback(async (
    message: Message,
    decision: 'approved' | 'rejected' | 'changes_requested',
    note?: string,
  ) => {
    const current = snapshotRef.current;
    const correction = message.translation?.correction;
    if (!current || correction?.status !== 'pending') return false;
    const result = await executeImmediate(`translation-review:${correction.id}`, () =>
      repositories.commands.reviewTranslationCorrection({
        organizationId: current.organizationId,
        correctionId: correction.id,
        decision,
        note: note?.trim() || null,
        idempotencyKey: createClientId(),
      })
    );
    if (!result) return false;
    await refresh();
    return true;
  }, [executeImmediate, refresh, repositories.commands]);

  const requestConversationSummary = useCallback(async (
    conversationId: string,
    range: { kind: SummaryScopeKind; subject?: string | null },
  ) => {
    const current = snapshotRef.current;
    const subject = (range.subject ?? '').replace(/\s+/g, ' ').trim();
    if (!current || !SUMMARY_SCOPE_KINDS.includes(range.kind) || subject.length > 200) return false;
    // "Unread" starts at the first message the pane showed as unread: the
    // chat was marked read the moment it opened, so the server needs the hint.
    const dividerId = unreadDividerIds[conversationId] ?? null;
    const divider = dividerId
      ? current.messages[conversationId]?.find((message) => message.id === dividerId)
      : undefined;
    const result = await executeImmediate(`summary-request:${conversationId}`, () =>
      repositories.commands.requestConversationSummary({
        organizationId: current.organizationId,
        conversationId,
        range: {
          kind: range.kind,
          subject: subject || null,
          fromMessageId: range.kind === 'unread' ? divider?.serverId ?? null : null,
          utcOffsetMinutes: -new Date().getTimezoneOffset(),
        },
        languageCode: current.messageDisplayLanguage,
        idempotencyKey: createClientId(),
      })
    );
    if (!result) return false;
    await refresh();
    return true;
  }, [executeImmediate, refresh, repositories.commands, unreadDividerIds]);

  const correctConversationSummary = useCallback(async (
    summary: ConversationSummary,
    primaryTopic: string,
    summaryBody: string,
  ) => {
    const current = snapshotRef.current;
    if (
      !current
      || summary.sourceState !== 'current'
      || !primaryTopic.trim()
      || !summaryBody.trim()
    ) return false;
    const result = await executeImmediate(`summary-correct:${summary.id}`, () =>
      repositories.commands.createManualSummary({
        organizationId: current.organizationId,
        conversationId: summary.conversationId,
        sourceMessageIds: summary.sourceMessageIds,
        languageCode: summary.language,
        primaryTopic,
        summary: summaryBody,
        keyTopics: summary.keyTopics.map((item) => item.text),
        decisions: summary.decisions.map((item) => ({
          text: item.text,
          sourceMessageIds: item.sourceMessageIds,
        })),
        actionItems: summary.actionItems.map((item) => ({
          text: item.title,
          sourceMessageIds: item.sourceMessageIds,
          owner: item.owner ?? null,
          due: item.dueAt ?? null,
        })),
        ambiguities: summary.ambiguities.map((item) => item.text),
        idempotencyKey: createClientId(),
      })
    );
    if (!result) return false;
    await refresh();
    return true;
  }, [executeImmediate, refresh, repositories.commands]);

  const reviewConversationSummary = useCallback(async (
    summaryId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ) => {
    const current = snapshotRef.current;
    if (!current) return false;
    const result = await executeImmediate(`summary-review:${summaryId}`, () =>
      repositories.commands.reviewConversationSummary({
        organizationId: current.organizationId,
        summaryId,
        decision,
        note: note?.trim() || null,
        idempotencyKey: createClientId(),
      })
    );
    if (!result) return false;
    await refresh();
    return true;
  }, [executeImmediate, refresh, repositories.commands]);

  const reportAiOutputError = useCallback(async (input: {
    outputKind: 'translation' | 'summary';
    translationId?: string | null;
    summaryId?: string | null;
    category: AiOutputErrorCategory;
    details: string;
    highConsequence: boolean;
    qualityUseConsent: boolean;
  }) => {
    const current = snapshotRef.current;
    if (!current || input.details.trim().length < 3) return false;
    const result = await executeImmediate(`ai-output-report:${input.outputKind}`, () =>
      repositories.commands.reportAiOutputError({
        organizationId: current.organizationId,
        ...input,
        details: input.details.trim(),
        consentVersion: 'quality-use-consent-v1',
        idempotencyKey: createClientId(),
      })
    );
    if (!result) return false;
    setAiOutputErrorReports((reports) => [
      result,
      ...reports.filter((report) => report.reportId !== result.reportId),
    ]);
    return true;
  }, [executeImmediate, repositories.commands]);

  const loadMyAiOutputErrorReports = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current) return false;
    const reports = await executeImmediate('ai-output-reports:self', () =>
      repositories.commands.listMyAiOutputErrorReports({
        organizationId: current.organizationId,
        limit: 50,
      })
    );
    if (!reports) return false;
    setAiOutputErrorReports(reports);
    return true;
  }, [executeImmediate, repositories.commands]);

  const loadAiOutputReviewQueue = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current) return false;
    const reports = await executeImmediate('ai-output-reports:review', () =>
      repositories.commands.listAiOutputErrorReportsForReview({
        organizationId: current.organizationId,
        limit: 100,
      })
    );
    if (!reports) return false;
    setAiOutputReviewQueue(reports);
    return true;
  }, [executeImmediate, repositories.commands]);

  const readAiOutputErrorReport = useCallback(async (reportId: string) => {
    const current = snapshotRef.current;
    if (!current) return false;
    const detail = await executeImmediate(`ai-output-report:read:${reportId}`, () =>
      repositories.commands.readAiOutputErrorReport({
        organizationId: current.organizationId,
        reportId,
      })
    );
    if (!detail) return false;
    setSelectedAiOutputReport(detail);
    return true;
  }, [executeImmediate, repositories.commands]);

  const reviewAiOutputErrorReport = useCallback(async (
    reportId: string,
    expectedVersion: number,
    outcome: 'confirmed_error' | 'not_an_error' | 'needs_context',
    reviewNote: string,
  ) => {
    const current = snapshotRef.current;
    if (!current || reviewNote.trim().length < 3) return false;
    const report = await executeImmediate(`ai-output-report:review:${reportId}`, () =>
      repositories.commands.reviewAiOutputErrorReport({
        organizationId: current.organizationId,
        reportId,
        expectedVersion,
        outcome,
        reviewNote: reviewNote.trim(),
        idempotencyKey: createClientId(),
      })
    );
    if (!report) return false;
    setSelectedAiOutputReport((detail) => detail?.report.reportId === reportId
      ? { ...detail, report }
      : detail);
    setAiOutputReviewQueue((reports) => outcome === 'needs_context'
      ? reports.map((item) => item.reportId === reportId ? report : item)
      : reports.filter((item) => item.reportId !== reportId));
    return true;
  }, [executeImmediate, repositories.commands]);

  const proposeAiRegressionExample = useCallback(async (input: {
    reportId: string;
    expectedReportVersion: number;
    sourceLanguage: string;
    deidentifiedSourceText: string;
    deidentifiedObservedOutput: string;
    deidentifiedExpectedOutput: string;
  }) => {
    const current = snapshotRef.current;
    if (!current || input.deidentifiedObservedOutput.trim() === input.deidentifiedExpectedOutput.trim()) {
      return false;
    }
    const example = await executeImmediate(`ai-regression:propose:${input.reportId}`, () =>
      repositories.commands.proposeAiRegressionExample({
        organizationId: current.organizationId,
        ...input,
        deidentificationAttested: true,
        attestationVersion: 'human-deidentification-v1',
        idempotencyKey: createClientId(),
      })
    );
    if (!example) return false;
    setSelectedAiOutputReport((detail) => detail?.report.reportId === input.reportId
      ? { ...detail, regressionExample: example }
      : detail);
    return true;
  }, [executeImmediate, repositories.commands]);

  const decideAiRegressionExample = useCallback(async (
    exampleId: string,
    expectedVersion: number,
    decision: 'approved' | 'rejected',
    decisionNote: string,
  ) => {
    const current = snapshotRef.current;
    if (!current || decisionNote.trim().length < 3) return false;
    const example = await executeImmediate(`ai-regression:decide:${exampleId}`, () =>
      repositories.commands.decideAiRegressionExample({
        organizationId: current.organizationId,
        exampleId,
        expectedVersion,
        decision,
        decisionNote: decisionNote.trim(),
        idempotencyKey: createClientId(),
      })
    );
    if (!example) return false;
    setSelectedAiOutputReport((detail) => detail?.regressionExample?.exampleId === exampleId
      ? { ...detail, regressionExample: example }
      : detail);
    return true;
  }, [executeImmediate, repositories.commands]);

  const setConversationSummaryPolicy = useCallback(async (
    conversationId: string,
    mode: 'manual' | 'message_count' | 'shift_close',
    messageCountThreshold?: number | null,
  ) => {
    const current = snapshotRef.current;
    if (!current) return false;
    const result = await executeImmediate(`summary-policy:${conversationId}`, async () => {
      await repositories.commands.setSummaryPolicy({
        organizationId: current.organizationId,
        conversationId,
        mode,
        messageCountThreshold,
        idempotencyKey: createClientId(),
      });
      return true;
    });
    return result === true;
  }, [executeImmediate, repositories.commands]);

  // Tracked independently of the workspace snapshot so the reconcile-poll
  // effect below can start and stop purely on foreground/background.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppStateActive(nextState === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!snapshot?.organizationId) return;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void reconcileConversation();
        void flushOutbox();
        // A socket suspended in the background can go stale without ever
        // emitting a close or error. Force a full unsubscribe/resubscribe of
        // every private channel with whatever access token is current now
        // that the app is foregrounded again (setAuth runs before the
        // channels are recreated).
        setRealtimeResubscribeNonce((current) => current + 1);
      }
    });
    void flushOutbox();
    return () => subscription.remove();
  }, [flushOutbox, reconcileConversation, snapshot?.organizationId]);

  useEffect(() => {
    if (!snapshot?.organizationId || !appStateActive || connectivity === 'offline') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const runPoll = () => {
      if (cancelled) return;
      const inFlight = reconciliationRunnerRef.current?.isRunning() ?? false;
      const sinceLastRealtimeEvent = Date.now() - lastRealtimeEventAtRef.current;
      if (!inFlight && sinceLastRealtimeEvent >= REALTIME_EVENT_FRESH_MS) void refresh();
      scheduleNext();
    };
    const scheduleNext = () => {
      if (cancelled) return;
      const delay = realtimeState === 'degraded'
        ? RECONCILE_POLL_DEGRADED_MS
        : jitteredReconcilePollDelay();
      timer = setTimeout(runPoll, delay);
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [appStateActive, connectivity, realtimeState, refresh, snapshot?.organizationId]);

  useEffect(() => {
    if (!snapshot?.organizationId) return;
    let active = true;
    void getExistingDeviceRegistration(snapshot.organizationId)
      .then(async (registration) => {
        if (!active || !registration) return;
        await repositories.commands.registerDevice(registration);
        noteRegisteredPushToken(registration.pushToken);
      })
      .catch(() => {
        // Permission was already granted, but registration can safely retry on
        // the next foreground without surfacing a disruptive launch error.
      });
    const tokenSubscription = addPushTokenRefreshListener(
      snapshot.organizationId,
      async (registration) => {
        if (active) await repositories.commands.registerDevice(registration);
      },
    );
    return () => {
      active = false;
      tokenSubscription.remove();
    };
  }, [repositories.commands, snapshot?.organizationId]);

  useEffect(() => {
    if (connectivity !== 'offline') return;
    const interval = setInterval(() => {
      void reconcileConversation();
      void flushOutbox();
    }, 15_000);
    return () => clearInterval(interval);
  }, [connectivity, flushOutbox, reconcileConversation]);

  const selectConversation = useCallback((conversationId: string) => {
    selectedConversationIdRef.current = conversationId;
    setSelectedConversationId(conversationId);
    void refresh();
  }, [refresh]);

  const openOrCreateDirectConversation = useCallback(
    async (
      personId: string,
      hint?: { displayName: string; username?: string | null },
    ) => {
      if (!snapshot || personId === snapshot.currentUser.id) return null;
      const person = snapshot.people.find((item) => item.id === personId);
      const personalRealm = isPersonalRealm(snapshot.organizationId);
      // Workspace organizations keep the accepted-connection gate. The
      // personal realm lets anyone chat with anyone (the service enforces
      // blocks in both directions), including a people-search result the
      // directory has not loaded yet, which the hint describes.
      if (
        person
          ? person.blockedByMe || (!personalRealm && person.connectionState !== 'connected')
          : !personalRealm
      ) {
        return null;
      }
      const existing = snapshot.conversations.find(
        (conversation) =>
          conversation.kind === 'direct' && conversation.directParticipantId === personId,
      );
      if (existing) {
        selectConversation(existing.id);
        return existing.id;
      }
      const hintName = hint?.displayName.trim() || hint?.username || 'Direct message';
      const counterpart: Person = person ?? {
        id: personId,
        membershipId: personId,
        organizationId: snapshot.organizationId,
        displayName: hintName,
        username: hint?.username ?? null,
        initials: nameInitials(hintName),
        roleLabel: hint?.username ? `@${hint.username}` : '',
        role: 'employee',
        site: '',
        department: '',
        preferredLanguage: snapshot.currentUser.preferredLanguage,
        presence: 'offline',
        connectionState: 'available',
        avatarColor: '#496D62',
      };
      setActionError(null);
      try {
        const idempotencyKey = createClientId();
        const result = await repositories.commands.createDirectConversation({
          organizationId: snapshot.organizationId,
          targetMembershipId: counterpart.membershipId ?? counterpart.id,
          idempotencyKey,
        });
        const conversation: Conversation = {
          id: result.conversationId,
          organizationId: snapshot.organizationId,
          directParticipantId: counterpart.id,
          title: counterpart.displayName,
          initials: counterpart.initials,
          avatarColor: counterpart.avatarColor,
          kind: 'direct',
          subtitle: counterpart.roleLabel,
          lastMessage: '',
          lastActivity: '',
          unreadCount: 0,
          pinned: false,
          favorite: false,
          muted: false,
          presence: counterpart.presence,
          translationPair: languagePair(
            snapshot.currentUser.preferredLanguage,
            counterpart.preferredLanguage,
          ),
        };
        setSnapshot((current) =>
          current
            ? {
                ...current,
                conversations: current.conversations.some((item) => item.id === conversation.id)
                  ? current.conversations
                  : [conversation, ...current.conversations],
                messages: { ...current.messages, [conversation.id]: current.messages[conversation.id] ?? [] },
                cursors: { ...current.cursors, [conversation.id]: null },
                // A search-discovered counterpart joins the local directory so
                // the new thread carries a name until the next bootstrap.
                people: current.people.some((item) => item.id === counterpart.id)
                  ? current.people
                  : [...current.people, counterpart],
              }
            : current,
        );
        selectConversation(conversation.id);
        return conversation.id;
      } catch (directError) {
        setActionError(t(errorMessageKey(directError)));
        if (isOfflineError(directError)) setConnectivity('offline');
        return null;
      }
    },
    [repositories.commands, selectConversation, snapshot, t],
  );

  const queryGroupCreationCandidates = useCallback(async (query = '') => {
    if (!snapshot) return null;
    setActionError(null);
    try {
      const result = await repositories.commands.listGroupCreationCandidates({
        organizationId: snapshot.organizationId,
        query: query.trim().slice(0, 120),
        limit: 50,
      });
      setConnectivity('online');
      return result.candidates;
    } catch (candidateError) {
      setActionError(t(errorMessageKey(candidateError)));
      if (isOfflineError(candidateError)) setConnectivity('offline');
      return null;
    }
  }, [repositories.commands, snapshot, t]);

  const queryConversationMemberCandidates = useCallback(async (
    conversationId: string,
    query = '',
    cursor: string | null = null,
  ) => {
    const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
    if (
      !snapshot
      || !conversation?.canManageConversation
      || !['group', 'team', 'shift', 'incident'].includes(conversation.kind)
      || conversation.policyManaged
      || conversation.archived
      || conversation.isReadOnly
    ) return null;
    setActionError(null);
    try {
      const result = await repositories.commands.listConversationMemberCandidates({
        organizationId: snapshot.organizationId,
        conversationId,
        query: query.trim().slice(0, 120),
        cursor,
        limit: 50,
      });
      setConnectivity('online');
      return result;
    } catch (candidateError) {
      setActionError(t(errorMessageKey(candidateError)));
      if (isOfflineError(candidateError)) setConnectivity('offline');
      return null;
    }
  }, [repositories.commands, snapshot, t]);

  const createGroupConversation = useCallback(
    async (input: {
      name: string;
      description?: string;
      kind: 'group' | 'team' | 'shift' | 'incident';
      unitId?: string | null;
      historyPolicy: 'all' | 'since_join';
      postingMode: 'all_members' | 'admins_only';
      joinPolicy: 'inherit' | 'invite_only' | 'approval_required';
      incidentSeverity?: 'low' | 'medium' | 'high' | 'critical';
      incidentClassification?: string;
      members: { membershipId: string; role: 'owner' | 'admin' | 'member' }[];
    }) => {
      const name = input.name.trim();
      const description = input.description?.trim() || null;
      const incidentClassification = input.incidentClassification?.trim() ?? '';
      const memberIds = input.members.map((member) => member.membershipId);
      if (
        !snapshot
        || name.length < 2
        || input.members.length < 1
        || new Set(memberIds).size !== memberIds.length
        || memberIds.includes(snapshot.currentUser.id)
        || ((input.kind === 'shift' || input.kind === 'incident') && input.joinPolicy !== 'invite_only')
        || (input.kind === 'incident' && (!input.incidentSeverity || !incidentClassification))
        || (input.kind !== 'incident' && (input.incidentSeverity !== undefined || incidentClassification))
      ) return null;

      setActionBusy('create-group');
      setActionError(null);
      try {
        const created = await repositories.commands.createGroupConversation({
          organizationId: snapshot.organizationId,
          name,
          description,
          memberAssignments: input.members,
          kind: input.kind,
          unitId: input.unitId ?? null,
          historyPolicy: input.historyPolicy,
          postingMode: input.postingMode,
          joinPolicy: input.joinPolicy,
          incidentSeverity: input.kind === 'incident' ? input.incidentSeverity : null,
          incidentClassification: input.kind === 'incident' ? incidentClassification : null,
          idempotencyKey: createClientId(),
        });
        const memberRoles = Object.fromEntries([
          [snapshot.currentUser.id, 'owner' as const],
          ...input.members.map((entry) => [entry.membershipId, entry.role] as const),
        ]);
        const conversation: Conversation = {
          id: created.conversationId,
          organizationId: snapshot.organizationId,
          title: created.name,
          initials: nameInitials(created.name),
          avatarColor: '#496D62',
          kind: created.kind,
          subtitle: created.description ?? '',
          participantCount: created.memberCount,
          lastMessage: '',
          lastActivity: '',
          unreadCount: 0,
          pinned: false,
          favorite: false,
          muted: false,
          description: created.description ?? undefined,
          myRole: 'owner',
          canManage: true,
          memberIds: [snapshot.currentUser.id, ...memberIds],
          memberRoles,
          departure: created.kind === 'group' ? {
            eligible: true,
            restriction: null,
            requiresOwnershipTransfer: true,
            historyPreserved: true,
            futureAccessRevoked: true,
          } : undefined,
          historyPolicy: created.historyPolicy,
          historyDisclosure: created.historyDisclosure,
          postingMode: created.postingMode,
          configuredJoinPolicy: created.configuredJoinPolicy,
          joinPolicy: created.joinPolicy,
          visibility: created.visibility,
          incidentSeverity: created.kind === 'incident' ? input.incidentSeverity : undefined,
          incidentClassification: created.kind === 'incident' ? incidentClassification : undefined,
          isReadOnly: created.isReadOnly,
          canPost: true,
          priority: created.kind === 'incident' && ['high', 'critical'].includes(String(input.incidentSeverity))
            ? 'safety'
            : undefined,
        };
        setSnapshot((current) =>
          current
            ? {
                ...current,
                conversations: current.conversations.some((item) => item.id === conversation.id)
                  ? current.conversations
                  : [conversation, ...current.conversations],
                messages: { ...current.messages, [conversation.id]: current.messages[conversation.id] ?? [] },
                cursors: { ...current.cursors, [conversation.id]: null },
              }
            : current,
        );
        setSelectedConversationId(conversation.id);
        setConnectivity('online');
        return conversation.id;
      } catch (createError) {
        setActionError(t(errorMessageKey(createError)));
        if (isOfflineError(createError)) setConnectivity('offline');
        return null;
      } finally {
        setActionBusy((current) => current === 'create-group' ? null : current);
      }
    },
    [repositories.commands, snapshot, t],
  );

  const uploadConversationAvatar = useCallback(async (
    conversationId: string,
    selected: SelectedAttachment,
  ) => {
    const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
    if (
      !snapshot || connectivity === 'offline' || !conversation?.canManage ||
      !['group', 'team', 'shift', 'incident'].includes(conversation.kind)
    ) return false;
    const result = await executeImmediate('conversation-avatar-upload', async () => {
      const optimized = await optimizeImageAttachment({ ...selected, imageMode: 'optimized' });
      const prepared = await prepareAttachment(optimized);
      try {
        if (
          !CONVERSATION_AVATAR_MIME_TYPES.has(prepared.mimeType) ||
          prepared.byteSize > CONVERSATION_AVATAR_MAX_BYTES
        ) {
          throw new RepositoryError(
            'Group images must be JPEG, PNG, or WebP and no larger than 5 MB.',
            'conversation_avatar_invalid',
            false,
          );
        }
        const grant = await repositories.commands.createConversationAvatarUploadGrant({
          organizationId: snapshot.organizationId,
          conversationId,
          fileName: prepared.name,
          mimeType: prepared.mimeType as 'image/jpeg' | 'image/png' | 'image/webp',
          byteSize: prepared.byteSize,
          sha256Hex: prepared.sha256Hex,
          idempotencyKey: `avatar-grant-${conversationId}-${prepared.sha256Hex.slice(0, 32)}`,
        });
        const completion = () => repositories.commands.completeAttachmentUpload({
          organizationId: snapshot.organizationId,
          attachmentId: grant.attachmentId,
          bucket: grant.bucket,
          path: grant.path,
          byteSize: prepared.byteSize,
          sha256Hex: prepared.sha256Hex,
          idempotencyKey: `avatar-complete-${grant.attachmentId}-${prepared.sha256Hex.slice(0, 24)}`,
        });
        try {
          await completion();
        } catch (completionError) {
          if (!attachmentObjectNotReady(completionError)) throw completionError;
          await uploadAttachment(
            grant,
            { uri: prepared.uri, bytes: prepared.bytes },
            prepared.mimeType,
          );
          await completion();
        }
        let clean = false;
        for (const delay of [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000]) {
          if (delay) await waitFor(delay);
          const state = await repositories.commands.getAttachmentState({
            organizationId: snapshot.organizationId,
            attachmentId: grant.attachmentId,
            idempotencyKey: createClientId(),
          });
          if (state.scanStatus === 'clean') {
            clean = true;
            break;
          }
          if (state.scanStatus === 'blocked' || state.scanStatus === 'failed') {
            throw new RepositoryError(
              'The selected group image did not pass the security scan.',
              'conversation_avatar_blocked',
              false,
            );
          }
        }
        if (!clean) {
          throw new RepositoryError(
            'The group image is still being scanned. Retry to continue from the same upload.',
            'conversation_avatar_scan_pending',
            true,
          );
        }
        const activated = await repositories.commands.activateConversationAvatar({
          organizationId: snapshot.organizationId,
          conversationId,
          attachmentId: grant.attachmentId,
          expectedAvatarPath: conversation.avatarPath ?? null,
          idempotencyKey: `avatar-activate-${conversationId}-${grant.attachmentId}`,
        });
        setConversationAvatarUrls((current) => ({ ...current, [conversationId]: selected.uri }));
        setSnapshot((current) => current ? {
          ...current,
          conversations: current.conversations.map((item) => item.id === conversationId
            ? { ...item, avatarPath: activated.avatarPath }
            : item),
        } : current);
        return true;
      } finally {
        await cleanupPreparedAttachment(prepared);
      }
    });
    return result === true;
  }, [connectivity, executeImmediate, repositories.commands, snapshot]);

  const removeConversationAvatar = useCallback(async (conversationId: string) => {
    const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
    if (!snapshot || !conversation?.canManage || !conversation.avatarPath) return false;
    const result = await executeImmediate('conversation-avatar-remove', async () => {
      await repositories.commands.removeConversationAvatar({
        organizationId: snapshot.organizationId,
        conversationId,
        expectedAvatarPath: conversation.avatarPath as string,
        idempotencyKey: createClientId(),
      });
      const timer = conversationAvatarTimersRef.current.get(conversationId);
      if (timer) clearTimeout(timer);
      conversationAvatarTimersRef.current.delete(conversationId);
      conversationAvatarCacheRef.current.delete(conversation.avatarPath as string);
      setConversationAvatarUrls((current) => {
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
      setSnapshot((current) => current ? {
        ...current,
        conversations: current.conversations.map((item) => item.id === conversationId
          ? { ...item, avatarPath: null }
          : item),
      } : current);
      return true;
    });
    return result === true;
  }, [executeImmediate, repositories.commands, snapshot]);

  const sendMessage = useCallback(
    async (
      conversationId: string,
      originalText: string,
      replyTo?: Message,
      mentionUserIds: string[] = [],
    ) => {
      const text = originalText.trim();
      if (!snapshot || !text) return;
      const persistenceEntitlement = offlineWorkspaceEntitlement(snapshot.currentUser);
      if (
        snapshot.currentUser.membershipType === 'contractor'
        && !persistenceEntitlement.eligible
      ) {
        setActionError(t('errors.accessEnded'));
        await clientStore.purgeUser(snapshot.currentUser.id).catch(() => undefined);
        await endAccessRef.current();
        return;
      }
      const conversation = snapshot.conversations.find((item) => item.id === conversationId);
      if (
        !conversation
        || conversation.managementOnly
        || conversation.canPost === false
        || conversation.isReadOnly
        || !isValidMentionSelection(
          mentionUserIds,
          conversation.kind === 'direct' ? [] : conversation.memberIds ?? [],
          snapshot.currentUser.id,
        )
      ) {
        setActionError(mentionCopy(locale).invalid);
        return;
      }
      const selectedMentionUserIds = [...mentionUserIds];
      const clientMessageId = createClientId();
      const input: SendMessageInput = {
        organizationId: snapshot.organizationId,
        conversationId,
        clientMessageId,
        body: text,
        languageCode: snapshot.currentUser.preferredLanguage,
        idempotencyKey: clientMessageId,
        ...(selectedMentionUserIds.length ? { mentionUserIds: selectedMentionUserIds } : {}),
        ...(replyTo?.serverId ? {
          replyToMessageId: replyTo.serverId,
          replyPreview: { senderName: replyTo.senderName, preview: replyTo.originalText.slice(0, 180) },
        } : {}),
      };
      const command: OutboxCommand<SendMessageInput> = {
        id: clientMessageId,
        organizationId: snapshot.organizationId,
        userId: snapshot.currentUser.id,
        kind: 'send_message',
        payload: input,
        createdAt: new Date().toISOString(),
        attempts: 0,
        state: 'queued',
      };
      const optimistic = messageFromCommand(command, snapshot.currentUser, t);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              messages: {
                ...current.messages,
                [conversationId]: [...(current.messages[conversationId] ?? []), optimistic],
              },
              conversations: current.conversations
                .map((conversation) =>
                  conversation.id === conversationId
                    ? { ...conversation, lastMessage: `You: ${text}`, lastActivity: 'Now' }
                    : conversation,
                )
                .sort((left) => (left.id === conversationId ? -1 : 0)),
            }
          : current,
      );
      setActionError(null);

      if (snapshot.currentUser.membershipType === 'guest') {
        setActionBusy('message-send-online');
        try {
          const receipt = await repositories.commands.sendMessage(input);
          markMessage(clientMessageId, {
            serverId: receipt.messageId,
            deliveryState: 'sent',
            failureReason: undefined,
          });
          setConnectivity('online');
          reconcileConversationAfterSend(conversationId);
        } catch (commandError) {
          const failure = snapshot.currentUser.membershipType === 'guest' && isOfflineError(commandError)
            ? t('errors.guestOnlineRequired')
            : t(errorMessageKey(commandError));
          markMessage(clientMessageId, {
            deliveryState: 'failed',
            failureReason: failure,
          });
          setActionError(failure);
          if (isOfflineError(commandError)) setConnectivity('offline');
        } finally {
          setActionBusy((current) => current === 'message-send-online' ? null : current);
        }
        return;
      }
      // Send straight to the service while online: the bubble goes to "sent"
      // as soon as the receipt lands, with no trip through the encrypted queue
      // (owner feedback on v2.3: "it should just send the message"). The queue
      // below is reached only when the device is offline or the send failed
      // on the network, so a message still survives a dropped connection.
      if (connectivity !== 'offline') {
        try {
          const receipt = await repositories.commands.sendMessage(input);
          markMessage(clientMessageId, {
            serverId: receipt.messageId,
            deliveryState: 'sent',
            failureReason: undefined,
          });
          setConnectivity('online');
          reconcileConversationAfterSend(conversationId);
          // Anything else waiting in the durable queue (receipts, device
          // registration) still drains on the next send.
          void flushOutbox();
          return;
        } catch (commandError) {
          if (!isOfflineError(commandError)) {
            const failure = t(errorMessageKey(commandError));
            markMessage(clientMessageId, { deliveryState: 'failed', failureReason: failure });
            setActionError(failure);
            // Keep the failed send in the outbox list so it can be retried or
            // cancelled from Settings, as a queued send that failed would be.
            try {
              await withTimeout(
                clientStore.enqueue({
                  ...command,
                  attempts: 1,
                  state: 'failed',
                  lastErrorCode: commandError instanceof RepositoryError ? commandError.code : 'unknown_error',
                }),
                OUTBOX_ENQUEUE_TIMEOUT_MS,
                'outbox_enqueue_timeout',
              );
              void flushOutbox();
            } catch {
              // The bubble already shows the failure; the list is a convenience.
            }
            return;
          }
          setConnectivity('offline');
        }
      }
      // The encrypted local queue exists so a message survives going offline;
      // delivery must never depend on it. If sealing or persisting the command
      // fails or stalls, send online directly and record why, instead of
      // leaving the bubble on "pending" forever with nothing on the wire
      // (device suite, run-2026-09-04T02-14-59, chat-01).
      let enqueued = false;
      try {
        await withTimeout(clientStore.enqueue(command), OUTBOX_ENQUEUE_TIMEOUT_MS, 'outbox_enqueue_timeout');
        enqueued = true;
      } catch (enqueueError) {
        setOutboxDegradedReason(describeError(enqueueError));
      }
      if (enqueued) {
        setOutboxCount((current) => current + 1);
        await flushOutbox();
        return;
      }
      try {
        const receipt = await repositories.commands.sendMessage(input);
        markMessage(clientMessageId, {
          serverId: receipt.messageId,
          deliveryState: 'sent',
          failureReason: undefined,
        });
        setConnectivity('online');
        reconcileConversationAfterSend(conversationId);
      } catch (commandError) {
        const failure = t(errorMessageKey(commandError));
        markMessage(clientMessageId, { deliveryState: 'failed', failureReason: failure });
        setActionError(failure);
        if (isOfflineError(commandError)) setConnectivity('offline');
      }
    },
    [connectivity, flushOutbox, locale, markMessage, reconcileConversationAfterSend, repositories.commands, snapshot, t],
  );

  const synchronizeMessageOutbox = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current) {
      setMessageOutbox([]);
      setOutboxCount(0);
      setFailedOutboxCount(0);
      return { commands: [] as OutboxCommand[], visible: [] as VisibleMessageOutboxItem[] };
    }
    if (!offlineWorkspaceEntitlement(current.currentUser).eligible) {
      await clientStore.purgeUser(current.currentUser.id);
      setMessageOutbox([]);
      setOutboxCount(0);
      setFailedOutboxCount(0);
      return { commands: [] as OutboxCommand[], visible: [] as VisibleMessageOutboxItem[] };
    }
    const commands = await clientStore.listOutbox(
      current.currentUser.id,
      current.organizationId,
    );
    const visible = visibleMessageOutbox(
      commands,
      current.currentUser.id,
      current.organizationId,
    );
    setMessageOutbox(visible);
    setOutboxCount(visible.filter((item) => item.state !== 'failed').length);
    setFailedOutboxCount(visible.filter((item) => item.state === 'failed').length);
    return { commands, visible };
  }, []);

  const editOutboxMessage = useCallback(async (outboxId: string, body: string) => {
    setActionBusy(`outbox-edit:${outboxId}`);
    setActionError(null);
    try {
      const { commands, visible } = await synchronizeMessageOutbox();
      const item = visible.find((candidate) => candidate.id === outboxId);
      const command = commands.find((candidate) => candidate.id === outboxId);
      const edited = editUnattemptedMessageCommand(command, body);
      if (!item?.canEdit || !edited) {
        setActionError(t('errors.invalidRequest'));
        return false;
      }
      await clientStore.updateOutbox(edited);
      setSnapshot((current) => {
        if (!current) return current;
        const messages = (current.messages[item.conversationId] ?? []).map((message) =>
          message.clientMessageId === item.clientMessageId
            ? {
                ...message,
                originalText: (edited.payload as SendMessageInput).body ?? '',
                deliveryState: 'pending' as const,
                failureReason: undefined,
              }
            : message
        );
        return {
          ...current,
          messages: { ...current.messages, [item.conversationId]: messages },
          conversations: current.conversations.map((conversation) =>
            conversation.id === item.conversationId
              && messages.at(-1)?.clientMessageId === item.clientMessageId
              ? { ...conversation, lastMessage: `You: ${(edited.payload as SendMessageInput).body ?? ''}` }
              : conversation
          ),
        };
      });
      await synchronizeMessageOutbox();
      if (connectivity !== 'offline') void flushOutbox();
      return true;
    } catch (outboxError) {
      setActionError(t(errorMessageKey(outboxError)));
      return false;
    } finally {
      setActionBusy((current) => current === `outbox-edit:${outboxId}` ? null : current);
    }
  }, [connectivity, flushOutbox, synchronizeMessageOutbox, t]);

  const retryOutboxMessage = useCallback(async (outboxId: string) => {
    setActionBusy(`outbox-retry:${outboxId}`);
    setActionError(null);
    try {
      const { commands, visible } = await synchronizeMessageOutbox();
      const item = visible.find((candidate) => candidate.id === outboxId);
      const command = commands.find((candidate) => candidate.id === outboxId);
      const retried = retryFailedMessageCommand(command);
      if (!item?.canRetry || !retried) {
        setActionError(t('errors.invalidRequest'));
        return false;
      }
      await clientStore.updateOutbox(retried);
      markMessage(item.clientMessageId, {
        deliveryState: 'pending',
        failureReason: undefined,
      });
      await synchronizeMessageOutbox();
      if (connectivity !== 'offline') void flushOutbox();
      return true;
    } catch (outboxError) {
      setActionError(t(errorMessageKey(outboxError)));
      return false;
    } finally {
      setActionBusy((current) => current === `outbox-retry:${outboxId}` ? null : current);
    }
  }, [connectivity, flushOutbox, markMessage, synchronizeMessageOutbox, t]);

  const cancelOutboxMessage = useCallback(async (outboxId: string) => {
    setActionBusy(`outbox-cancel:${outboxId}`);
    setActionError(null);
    try {
      const { commands, visible } = await synchronizeMessageOutbox();
      const item = visible.find((candidate) => candidate.id === outboxId);
      if (!item || !commands.some((candidate) => candidate.id === outboxId)) {
        setActionError(t('errors.invalidRequest'));
        return false;
      }
      await clientStore.removeOutbox(outboxId);
      setSnapshot((current) => {
        if (!current) return current;
        const messages = (current.messages[item.conversationId] ?? []).filter(
          (message) => message.clientMessageId !== item.clientMessageId,
        );
        const last = messages.at(-1);
        return {
          ...current,
          messages: { ...current.messages, [item.conversationId]: messages },
          conversations: current.conversations.map((conversation) =>
            conversation.id === item.conversationId
              ? {
                  ...conversation,
                  lastMessage: last?.originalText
                    || (last?.attachment ? `Attachment: ${last.attachment.name}` : ''),
                  lastActivity: last?.sentAt ?? conversation.lastActivity,
                }
              : conversation
          ),
        };
      });
      await synchronizeMessageOutbox();
      // An attempted send may already have committed despite a lost response.
      // Reconciliation is authoritative and can legitimately restore it.
      if (item.deliveryAmbiguous && connectivity !== 'offline') void refresh();
      return true;
    } catch (outboxError) {
      setActionError(t(errorMessageKey(outboxError)));
      return false;
    } finally {
      setActionBusy((current) => current === `outbox-cancel:${outboxId}` ? null : current);
    }
  }, [connectivity, refresh, synchronizeMessageOutbox, t]);

  const watchAttachmentScan = useCallback((operation: AttachmentUploadOperation, attachmentId: string) => {
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
    const poll = (index: number) => {
      if (index >= delays.length) return;
      const timer = setTimeout(() => {
        attachmentScanTimersRef.current.delete(timer);
        if (!mountedRef.current || refreshIdentityRef.current !== refreshIdentity) return;
        void repositories.commands.getAttachmentState({
          organizationId: operation.organizationId,
          attachmentId,
          idempotencyKey: createClientId(),
        }).then((state) => {
          if (state.scanStatus === 'pending') {
            poll(index + 1);
            return;
          }
          patchLocalAttachment(operation.clientMessageId, {
            status: state.scanStatus === 'clean' ? 'clean' : 'blocked',
          });
        }).catch((scanError) => {
          if (scanError instanceof RepositoryError && scanError.retryable) poll(index + 1);
        });
      }, delays[index]);
      attachmentScanTimersRef.current.add(timer);
    };
    poll(0);
  }, [patchLocalAttachment, refreshIdentity, repositories.commands]);

  const performAttachmentUpload = useCallback(async (operation: AttachmentUploadOperation) => {
    const complete = async (grant: AttachmentUploadGrant) => {
      await repositories.commands.completeAttachmentUpload({
        organizationId: operation.organizationId,
        attachmentId: grant.attachmentId,
        bucket: grant.bucket,
        path: grant.path,
        byteSize: operation.prepared.byteSize,
        sha256Hex: operation.prepared.sha256Hex,
        idempotencyKey: operation.completionIdempotencyKey,
      });
      patchLocalAttachment(operation.clientMessageId, {
        id: grant.attachmentId,
        status: 'scanning',
        transfer: { state: 'uploaded', progress: 1 },
      });
      markMessage(operation.clientMessageId, { failureReason: undefined });
      attachmentUploadsRef.current.delete(operation.clientMessageId);
      attachmentCancellationsRef.current.delete(operation.clientMessageId);
      await cleanupPreparedAttachment(operation.prepared);
      watchAttachmentScan(operation, grant.attachmentId);
    };

    const controller = new AbortController();
    operation.controller = controller;
    patchLocalAttachment(operation.clientMessageId, {
      transfer: { state: 'uploading', progress: 0 },
    });
    try {
      if (operation.grant && operation.uploadMayHaveCommitted) {
        try {
          await complete(operation.grant);
          return;
        } catch (completionError) {
          if (!attachmentObjectNotReady(completionError)) throw completionError;
          operation.uploadMayHaveCommitted = false;
        }
      }

      const grant = await repositories.commands.createAttachmentUploadGrant({
        organizationId: operation.organizationId,
        conversationId: operation.conversationId,
        messageId: operation.messageId,
        fileName: operation.prepared.name,
        mimeType: operation.prepared.mimeType,
        byteSize: operation.prepared.byteSize,
        sha256Hex: operation.prepared.sha256Hex,
        // Replaying this key returns the same private object metadata, while
        // the Edge route creates a fresh short-lived signed URL on every call.
        idempotencyKey: operation.grantIdempotencyKey,
      });
      operation.grant = grant;
      patchLocalAttachment(operation.clientMessageId, {
        id: grant.attachmentId,
        status: 'quarantined',
      });
      await uploadAttachment(
        grant,
        { uri: operation.prepared.uri, bytes: operation.prepared.bytes },
        operation.prepared.mimeType,
        {
          signal: controller.signal,
          onProgress: (progress) => {
            operation.localAttachment.transfer = { state: 'uploading', progress };
            patchLocalAttachment(operation.clientMessageId, {
              transfer: { state: 'uploading', progress },
            });
          },
        },
      );
      operation.uploadMayHaveCommitted = true;
      await complete(grant);
    } finally {
      if (operation.controller === controller) operation.controller = null;
    }
  }, [markMessage, patchLocalAttachment, repositories.commands, watchAttachmentScan]);

  const handleAttachmentUploadFailure = useCallback(async (
    operation: AttachmentUploadOperation,
    uploadError: unknown,
  ) => {
    const code = attachmentErrorCode(uploadError);
    if (code === 'upload_cancelled') {
      let deleted = false;
      let deletionError: unknown = null;
      try {
        await repositories.commands.deleteMessage({
          organizationId: operation.organizationId,
          conversationId: operation.conversationId,
          messageId: operation.messageId,
          idempotencyKey: createClientId(),
        });
        deleted = true;
      } catch (error) {
        deletionError = error;
      }
      attachmentUploadsRef.current.delete(operation.clientMessageId);
      await cleanupPreparedAttachment(operation.prepared);
      if (deleted) {
        attachmentCancellationsRef.current.delete(operation.clientMessageId);
        removeLocalMessage(operation.clientMessageId, operation.conversationId);
        return;
      }
      attachmentCancellationsRef.current.set(operation.clientMessageId, {
        organizationId: operation.organizationId,
        conversationId: operation.conversationId,
        messageId: operation.messageId,
        clientMessageId: operation.clientMessageId,
      });
      patchLocalAttachment(operation.clientMessageId, {
        transfer: { state: 'cancelled', progress: 0, errorCode: code },
      });
      markMessage(operation.clientMessageId, {
        failureReason: t(errorMessageKey(deletionError ?? uploadError)),
      });
      setActionError(t(errorMessageKey(deletionError ?? uploadError)));
      return;
    }
    patchLocalAttachment(operation.clientMessageId, {
      transfer: {
        state: 'failed',
        progress: operation.localAttachment.transfer?.progress ?? 0,
        errorCode: code,
      },
    });
    markMessage(operation.clientMessageId, { failureReason: t(errorMessageKey(uploadError)) });
    setActionError(t(errorMessageKey(uploadError)));
  }, [markMessage, patchLocalAttachment, removeLocalMessage, repositories.commands, t]);

  const sendAttachment = useCallback(
    async (conversationId: string, selected: SelectedAttachment, caption: string) => {
      if (!snapshot || connectivity === 'offline') {
        setActionError(t('errors.attachmentOnline'));
        return false;
      }
      const result = await executeImmediate('attachment-upload', async () => {
        const uploadSelection = await optimizeImageAttachment(selected);
        const prepared = await prepareAttachment(uploadSelection);
        const clientMessageId = createClientId();
        let receipt;
        try {
          receipt = await repositories.commands.sendMessage({
            organizationId: snapshot.organizationId,
            conversationId,
            clientMessageId,
            body: caption.trim() || null,
            kind: 'attachment',
            languageCode: snapshot.currentUser.preferredLanguage,
            idempotencyKey: clientMessageId,
          });
        } catch (messageError) {
          await cleanupPreparedAttachment(prepared);
          throw messageError;
        }
        const localAttachment: Attachment = {
          id: `pending-${clientMessageId}`,
          kind: prepared.mimeType.startsWith('image/')
            ? 'image'
            : prepared.mimeType.startsWith('audio/')
              ? 'voice'
              : 'document',
          name: prepared.name,
          mimeType: prepared.mimeType,
          byteSize: prepared.byteSize,
          localUri: prepared.uri,
          sizeLabel: prepared.byteSize < 1024 * 1024
            ? `${Math.ceil(prepared.byteSize / 1024)} KB`
            : `${(prepared.byteSize / (1024 * 1024)).toFixed(1)} MB`,
          status: 'quarantined',
          transfer: {
            state: 'preparing',
            progress: 0,
          },
        };
        const optimistic: Message = {
          id: `attachment-${clientMessageId}`,
          clientMessageId,
          serverId: receipt.messageId,
          conversationId,
          senderId: snapshot.currentUser.id,
          senderName: snapshot.currentUser.displayName,
          senderInitials: snapshot.currentUser.initials,
          senderColor: snapshot.currentUser.avatarColor,
          originalText: caption.trim(),
          sourceLanguage: snapshot.currentUser.preferredLanguage,
          translationState: 'not_requested',
          sentAt: nowLabel(),
          isOwn: true,
          deliveryState: 'sent',
          priority: 'normal',
          attachment: localAttachment,
        };
        setSnapshot((current) =>
          current
            ? {
                ...current,
                messages: {
                  ...current.messages,
                  [conversationId]: [
                    ...(current.messages[conversationId] ?? []).filter(
                      (message) => message.clientMessageId !== clientMessageId,
                    ),
                    optimistic,
                  ],
                },
                conversations: current.conversations.map((conversation) =>
                  conversation.id === conversationId
                    ? {
                        ...conversation,
                        lastMessage: caption.trim() || `Attachment: ${prepared.name}`,
                        lastActivity: 'Now',
                      }
                    : conversation,
                ),
              }
            : current,
        );

        const operation: AttachmentUploadOperation = {
          organizationId: snapshot.organizationId,
          conversationId,
          messageId: receipt.messageId,
          clientMessageId,
          prepared,
          localAttachment,
          grantIdempotencyKey: createClientId(),
          completionIdempotencyKey: createClientId(),
          grant: null,
          uploadMayHaveCommitted: false,
          controller: null,
        };
        attachmentUploadsRef.current.set(clientMessageId, operation);
        void performAttachmentUpload(operation).catch((uploadError) =>
          handleAttachmentUploadFailure(operation, uploadError)
        );
        return true;
      });
      return result === true;
    },
    [
      connectivity,
      executeImmediate,
      handleAttachmentUploadFailure,
      performAttachmentUpload,
      repositories.commands,
      snapshot,
      t,
    ],
  );

  const cancelAttachmentUpload = useCallback(async (message: Message) => {
    const clientMessageId = message.clientMessageId;
    if (!clientMessageId || !message.serverId || !message.isOwn) return false;
    const operation = attachmentUploadsRef.current.get(clientMessageId);
    const cancellation = attachmentCancellationsRef.current.get(clientMessageId);
    if (!operation && !cancellation) return false;
    if (operation?.controller) {
      operation.controller.abort();
      return true;
    }
    const target = operation ?? cancellation as AttachmentCancellation;
    const result = await executeImmediate(`attachment-cancel:${clientMessageId}`, () =>
      repositories.commands.deleteMessage({
        organizationId: target.organizationId,
        conversationId: target.conversationId,
        messageId: target.messageId,
        idempotencyKey: createClientId(),
      })
    );
    if (result === null) return false;
    attachmentUploadsRef.current.delete(clientMessageId);
    attachmentCancellationsRef.current.delete(clientMessageId);
    if (operation) await cleanupPreparedAttachment(operation.prepared);
    removeLocalMessage(clientMessageId, target.conversationId);
    return true;
  }, [executeImmediate, removeLocalMessage, repositories.commands]);

  const retryAttachmentUpload = useCallback(async (message: Message) => {
    const clientMessageId = message.clientMessageId;
    const operation = clientMessageId
      ? attachmentUploadsRef.current.get(clientMessageId)
      : null;
    if (
      !operation
      || operation.controller
      || connectivity === 'offline'
      || message.attachment?.transfer?.state !== 'failed'
    ) return false;
    setActionBusy(`attachment-retry:${clientMessageId}`);
    setActionError(null);
    try {
      await performAttachmentUpload(operation);
      setConnectivity('online');
      return true;
    } catch (uploadError) {
      await handleAttachmentUploadFailure(operation, uploadError);
      return false;
    } finally {
      setActionBusy((current) => current === `attachment-retry:${clientMessageId}` ? null : current);
    }
  }, [connectivity, handleAttachmentUploadFailure, performAttachmentUpload]);

  const editMessage = useCallback(
    async (message: Message, body: string) => {
      const nextBody = body.trim();
      if (!snapshot || !message.serverId || !message.isOwn || message.deleted || !nextBody) return false;
      const result = await executeImmediate('message-edit', () =>
        repositories.commands.editMessage({
          organizationId: snapshot.organizationId,
          conversationId: message.conversationId,
          messageId: message.serverId as string,
          body: nextBody,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      patchServerMessage(message.serverId, { originalText: nextBody, edited: true });
      return true;
    },
    [executeImmediate, patchServerMessage, repositories.commands, snapshot],
  );

  const deleteMessage = useCallback(
    async (message: Message) => {
      if (!snapshot || !message.serverId || !message.isOwn || message.deleted) return false;
      const result = await executeImmediate('message-delete', () =>
        repositories.commands.deleteMessage({
          organizationId: snapshot.organizationId,
          conversationId: message.conversationId,
          messageId: message.serverId as string,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      patchServerMessage(message.serverId, {
        originalText: 'Message removed',
        translatedText: undefined,
        attachment: undefined,
        deleted: true,
      });
      return true;
    },
    [executeImmediate, patchServerMessage, repositories.commands, snapshot],
  );

  const hideMessageForMe = useCallback(
    async (message: Message) => {
      if (!snapshot || !message.serverId || message.deleted) return false;
      const result = await executeImmediate('message-hide', () =>
        repositories.commands.hideMessageForMe({
          organizationId: snapshot.organizationId,
          conversationId: message.conversationId,
          messageId: message.serverId as string,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) => current ? {
        ...current,
        messages: {
          ...current.messages,
          [message.conversationId]: (current.messages[message.conversationId] ?? []).filter(
            (item) => item.serverId !== message.serverId,
          ),
        },
      } : current);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const forwardMessage = useCallback(
    async (message: Message, targetConversationId: string) => {
      if (
        !snapshot
        || !message.serverId
        || message.deleted
        || Boolean(message.attachment)
        || !snapshot.conversations.some((conversation) => conversation.id === targetConversationId)
      ) return false;
      const clientMessageId = createClientId();
      const result = await executeImmediate('message-forward', () =>
        repositories.commands.forwardMessage({
          organizationId: snapshot.organizationId,
          sourceConversationId: message.conversationId,
          sourceMessageId: message.serverId as string,
          targetConversationId,
          clientMessageId,
          idempotencyKey: clientMessageId,
        }),
      );
      if (!result) return false;
      const forwarded: Message = {
        ...message,
        id: `forward-${clientMessageId}`,
        clientMessageId: result.clientMessageId,
        serverId: result.messageId,
        conversationId: targetConversationId,
        senderId: snapshot.currentUser.id,
        senderName: snapshot.currentUser.displayName,
        senderInitials: snapshot.currentUser.initials,
        senderColor: snapshot.currentUser.avatarColor,
        isOwn: true,
        deliveryState: 'sent',
        sentAt: nowLabel(),
        attachment: undefined,
        forwarded: true,
        forwardSource: { conversationId: message.conversationId, messageId: message.serverId },
      };
      setSnapshot((current) => current ? {
        ...current,
        messages: {
          ...current.messages,
          [targetConversationId]: [...(current.messages[targetConversationId] ?? []), forwarded],
        },
        conversations: current.conversations.map((conversation) =>
          conversation.id === targetConversationId
            ? { ...conversation, lastMessage: forwarded.originalText, lastActivity: 'Now' }
            : conversation,
        ),
      } : current);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const placeMessagePreservationHold = useCallback(
    async (input: {
      conversationId: string;
      messageId: string;
      holdType: 'legal' | 'incident_preservation';
      reasonCode: string;
      policyReferenceSha256: string;
    }) => {
      if (!snapshot || !snapshot.capabilities.includes('message.preservation.manage')) return null;
      const result = await executeImmediate('message-preservation-place', () =>
        repositories.commands.placeMessagePreservationHold({
          organizationId: snapshot.organizationId,
          ...input,
          reasonCode: input.reasonCode.trim(),
          policyReferenceSha256: input.policyReferenceSha256.trim().toLowerCase(),
          idempotencyKey: createClientId(),
        }),
      );
      return result?.holdId ?? null;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const releaseMessagePreservationHold = useCallback(
    async (holdId: string, releaseReasonCode: string) => {
      if (!snapshot || !snapshot.capabilities.includes('message.preservation.manage')) return false;
      const result = await executeImmediate('message-preservation-release', () =>
        repositories.commands.releaseMessagePreservationHold({
          organizationId: snapshot.organizationId,
          holdId: holdId.trim().toLowerCase(),
          releaseReasonCode: releaseReasonCode.trim(),
          idempotencyKey: createClientId(),
        }),
      );
      return result !== null;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const toggleReaction = useCallback(
    async (message: Message, emoji: string) => {
      if (!snapshot || !message.serverId || message.deleted) return false;
      const currentReaction = message.reactions?.find((reaction) => reaction.emoji === emoji);
      const active = !currentReaction?.reactedByMe;
      const result = await executeImmediate('message-reaction', () =>
        repositories.commands.setMessageReaction({
          organizationId: snapshot.organizationId,
          conversationId: message.conversationId,
          messageId: message.serverId as string,
          emoji,
          active,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      const nextReactions = [...(message.reactions ?? [])];
      const index = nextReactions.findIndex((reaction) => reaction.emoji === emoji);
      if (index < 0 && active) {
        nextReactions.push({ emoji, count: 1, reactedByMe: true });
      } else if (index >= 0) {
        const nextCount = Math.max(0, nextReactions[index].count + (active ? 1 : -1));
        if (nextCount === 0) nextReactions.splice(index, 1);
        else nextReactions[index] = { emoji, count: nextCount, reactedByMe: active };
      }
      patchServerMessage(message.serverId, { reactions: nextReactions });
      return true;
    },
    [executeImmediate, patchServerMessage, repositories.commands, snapshot],
  );

  const setMessagePinned = useCallback(
    async (message: Message, pinned: boolean) => {
      if (!snapshot || !message.serverId || message.deleted) return false;
      const result = await executeImmediate('message-pin', () =>
        repositories.commands.setMessagePin({
          organizationId: snapshot.organizationId,
          conversationId: message.conversationId,
          messageId: message.serverId as string,
          pinned,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      patchServerMessage(message.serverId, { pinned });
      return true;
    },
    [executeImmediate, patchServerMessage, repositories.commands, snapshot],
  );

  const reportMessage = useCallback(
    async (
      message: Message,
      category: Parameters<CommandRepository['reportMessage']>[0]['category'],
      details?: string,
      disclosure?: {
        consentToShare: true;
        contextBefore: 0 | 1 | 2;
        contextAfter: 0 | 1 | 2;
        noticeVersion: 'moderation-report-v2';
      },
    ) => {
      if (!snapshot || !message.serverId || message.isOwn || message.deleted || !disclosure) {
        return false;
      }
      const result = await executeImmediate('message-report', () =>
        repositories.commands.reportMessage({
          organizationId: snapshot.organizationId,
          conversationId: message.conversationId,
          messageId: message.serverId as string,
          category,
          details: details?.trim() || null,
          consentToShare: disclosure.consentToShare,
          contextBefore: disclosure.contextBefore,
          contextAfter: disclosure.contextAfter,
          noticeVersion: disclosure.noticeVersion,
          idempotencyKey: createClientId(),
        }),
      );
      return result !== null;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const reportGroup = useCallback(
    async (
      conversation: Conversation,
      category: Parameters<CommandRepository['reportGroup']>[0]['category'],
      details?: string,
      disclosure?: {
        consentToShare: true;
        noticeVersion: 'moderation-report-v2';
      },
    ) => {
      if (!snapshot || conversation.kind === 'direct' || !disclosure) return false;
      const result = await executeImmediate('group-report', () =>
        repositories.commands.reportGroup({
          organizationId: snapshot.organizationId,
          conversationId: conversation.id,
          category,
          details: details?.trim() || null,
          consentToShare: disclosure.consentToShare,
          noticeVersion: disclosure.noticeVersion,
          idempotencyKey: createClientId(),
        }),
      );
      return result !== null;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const reportMember = useCallback(
    async (
      membershipId: string,
      category: Parameters<CommandRepository['reportMember']>[0]['category'],
      details?: string,
      disclosure?: {
        consentToShare: true;
        noticeVersion: 'moderation-report-v2';
      },
    ) => {
      if (!snapshot || !membershipId || membershipId === snapshot.currentUser.id || !disclosure) {
        return false;
      }
      const result = await executeImmediate('member-report', () =>
        repositories.commands.reportMember({
          organizationId: snapshot.organizationId,
          membershipId,
          category,
          details: details?.trim() || null,
          consentToShare: disclosure.consentToShare,
          noticeVersion: disclosure.noticeVersion,
          idempotencyKey: createClientId(),
        }),
      );
      return result !== null;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const proposeAction = useCallback(async (message: Message, title: string, details?: string) => {
    const cleanTitle = title.trim();
    if (!snapshot || !message.serverId || message.deleted || !cleanTitle) return false;
    const result = await executeImmediate('action-propose', () => repositories.commands.proposeAction({
      organizationId: snapshot.organizationId,
      conversationId: message.conversationId,
      sourceMessageId: message.serverId as string,
      title: cleanTitle,
      details: details?.trim() || null,
      idempotencyKey: createClientId(),
    }));
    if (!result) return false;
    const now = new Date().toISOString();
    const action: OperationalAction = {
      id: result.actionId,
      conversationId: message.conversationId,
      sourceMessageId: message.serverId,
      title: cleanTitle,
      details: details?.trim() || null,
      status: 'proposed',
      proposedByUserId: snapshot.currentUser.id,
      assigneeUserId: null,
      assigneeName: null,
      dueAt: null,
      createdAt: now,
      updatedAt: now,
    };
    setSnapshot((current) => current ? { ...current, actions: [action, ...current.actions] } : current);
    return true;
  }, [executeImmediate, repositories.commands, snapshot]);

  const confirmAction = useCallback(async (actionId: string, assigneePersonId: string, dueAt?: string) => {
    const person = snapshot?.people.find((item) => item.id === assigneePersonId);
    if (!snapshot || !person || !snapshot.capabilities.includes('actions.confirm')) return false;
    const result = await executeImmediate('action-confirm', () => repositories.commands.confirmAction({
      organizationId: snapshot.organizationId,
      actionId,
      assigneeMembershipId: person.membershipId ?? person.id,
      dueAt: dueAt?.trim() || null,
      idempotencyKey: createClientId(),
    }));
    if (result === null) return false;
    setSnapshot((current) => current ? {
      ...current,
      actions: current.actions.map((action) => action.id === actionId ? {
        ...action,
        status: 'confirmed',
        assigneeUserId: person.id,
        assigneeName: person.displayName,
        dueAt: dueAt?.trim() || null,
        updatedAt: new Date().toISOString(),
      } : action),
    } : current);
    return true;
  }, [executeImmediate, repositories.commands, snapshot]);

  const transitionAction = useCallback(async (
    actionId: string,
    status: 'in_progress' | 'completed' | 'cancelled',
    note?: string,
  ) => {
    if (!snapshot) return false;
    const result = await executeImmediate('action-transition', () => repositories.commands.transitionAction({
      organizationId: snapshot.organizationId,
      actionId,
      status,
      note: note?.trim() || null,
      idempotencyKey: createClientId(),
    }));
    if (result === null) return false;
    setSnapshot((current) => current ? {
      ...current,
      actions: current.actions.map((action) => action.id === actionId
        ? { ...action, status, updatedAt: new Date().toISOString() }
        : action),
    } : current);
    return true;
  }, [executeImmediate, repositories.commands, snapshot]);

  const [attachmentPreviewUrls, setAttachmentPreviewUrls] = useState<Record<string, string>>({});
  const previewRequestsRef = useRef<Set<string>>(new Set());
  const loadAttachmentPreview = useCallback(
    async (message: Message) => {
      const attachment = message.attachment;
      // Images get an inline preview; audio and video get a playable source.
      const previewable = attachment?.kind === 'image'
        || attachment?.mimeType?.startsWith('audio/') === true
        || attachment?.mimeType?.startsWith('video/') === true;
      if (!snapshot || !attachment || attachment.status !== 'clean' || !previewable) return;
      if (previewRequestsRef.current.has(attachment.id)) return;
      previewRequestsRef.current.add(attachment.id);
      try {
        const grant = await repositories.commands.createAttachmentDownloadGrant({
          organizationId: snapshot.organizationId,
          conversationId: message.conversationId,
          attachmentId: attachment.id,
          idempotencyKey: createClientId(),
        });
        setAttachmentPreviewUrls((current) => ({ ...current, [attachment.id]: grant.signedUrl }));
      } catch {
        // A preview is a convenience; the file stays reachable through the card.
        previewRequestsRef.current.delete(attachment.id);
      }
    },
    [repositories.commands, snapshot],
  );

  const downloadAttachment = useCallback(
    async (message: Message) => {
      if (!snapshot || !message.attachment || message.attachment.status !== 'clean') return false;
      const result = await executeImmediate('attachment-download', () =>
        repositories.commands.createAttachmentDownloadGrant({
          organizationId: snapshot.organizationId,
          conversationId: message.conversationId,
          attachmentId: message.attachment?.id as string,
          idempotencyKey: createClientId(),
        }),
      );
      if (!result) return false;
      try {
        await Linking.openURL(result.signedUrl);
        return true;
      } catch {
        setActionError(t('errors.downloadOpen'));
        return false;
      }
    },
    [executeImmediate, repositories.commands, snapshot, t],
  );

  const updateConversation = useCallback(
    async (
      conversationId: string,
      patch: { name?: string | null; description?: string | null; isArchived?: boolean },
    ) => {
      const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
      if (!snapshot || !conversation?.canManageConversation || conversation.kind === 'direct') return false;
      const result = await executeImmediate('conversation-update', () =>
        repositories.commands.updateConversation({
          organizationId: snapshot.organizationId,
          conversationId,
          ...patch,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              conversations: current.conversations
                .map((item) =>
                  item.id === conversationId
                    ? {
                        ...item,
                        ...(patch.name !== undefined && patch.name !== null
                          ? { title: patch.name, initials: nameInitials(patch.name) }
                          : {}),
                        ...(patch.description !== undefined
                          ? { description: patch.description ?? undefined, subtitle: patch.description || item.subtitle }
                          : {}),
                        ...(patch.isArchived !== undefined ? { archived: patch.isArchived } : {}),
                      }
                    : item,
                )
                .filter((item) => !item.archived),
            }
          : current,
      );
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const updateConversationPreferences = useCallback(
    async (
      conversationId: string,
      patch: { isFavorite?: boolean; isPinned?: boolean; isArchived?: boolean; notificationLevel?: 'all' | 'mentions' | 'none'; mutedUntil?: string | null; translationMode?: 'automatic' | 'off' },
    ) => {
      if (!snapshot) return false;
      const result = await executeImmediate('conversation-preferences', () =>
        repositories.commands.updateConversationPreferences({
          organizationId: snapshot.organizationId,
          conversationId,
          ...patch,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) => current ? {
        ...current,
        messages: patch.translationMode === 'off'
          ? {
              ...current.messages,
              [conversationId]: (current.messages[conversationId] ?? []).map((message) => {
                const { translatedText: _translatedText, targetLanguage: _targetLanguage, translation: _translation, ...original } = message;
                return { ...original, translationState: 'not_requested' as const };
              }),
            }
          : current.messages,
        conversations: current.conversations.map((conversation) => {
          if (conversation.id !== conversationId) return conversation;
          const notificationLevel = patch.notificationLevel ?? conversation.notificationLevel ?? 'all';
          const mutedUntil = activeMutedUntil(patch.mutedUntil !== undefined
            ? patch.mutedUntil
            : conversation.mutedUntil ?? null);
          return {
            ...conversation,
            ...(patch.isFavorite !== undefined ? { favorite: patch.isFavorite } : {}),
            ...(patch.isPinned !== undefined ? { pinned: patch.isPinned } : {}),
            ...(patch.isArchived !== undefined ? { archived: patch.isArchived } : {}),
            notificationLevel,
            mutedUntil,
            ...(patch.translationMode !== undefined ? { translationMode: patch.translationMode } : {}),
            muted: isConversationMuted(notificationLevel, mutedUntil),
          };
        }),
      } : current);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const updateProfile = useCallback(async (
    input: { displayName: string; statusMessage?: string | null },
  ) => {
    if (!snapshot) return false;
    const displayName = input.displayName.trim();
    const statusMessage = input.statusMessage?.trim() || null;
    if (
      displayName.length < 1
      || displayName.length > 120
      || (statusMessage !== null && statusMessage.length > 280)
    ) {
      return false;
    }
    const receipt = await executeImmediate('profile-update', () =>
      repositories.commands.updateProfile({
        organizationId: snapshot.organizationId,
        displayName,
        statusMessage,
        idempotencyKey: createClientId(),
      }),
    );
    if (!receipt || receipt.userId !== snapshot.currentUser.id) return false;
    // The receipt is authoritative: the local identity and its directory
    // entry take the server's values, not the draft the user typed.
    const renamed = <T extends Person>(person: T): T => ({
      ...person,
      displayName: receipt.displayName,
      initials: nameInitials(receipt.displayName),
      statusMessage: receipt.statusMessage,
    });
    setSnapshot((current) => current && current.currentUser.id === receipt.userId
      ? {
          ...current,
          currentUser: renamed(current.currentUser),
          people: current.people.map((person) =>
            person.id === receipt.userId ? renamed(person) : person),
        }
      : current);
    return true;
  }, [executeImmediate, repositories.commands, snapshot]);

  const updateConversationControls = useCallback(async (
    conversationId: string,
    patch: {
      postingMode?: 'all_members' | 'admins_only';
      joinPolicy?: 'inherit' | 'invite_only' | 'approval_required';
      visibility?: 'invite_only' | 'organization' | 'unit';
      reason: string;
    },
  ) => {
    const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
    if (
      !snapshot
      || !conversation?.canManageConversation
      || conversation.policyManaged
      || !['group', 'team'].includes(conversation.kind)
    ) {
      return false;
    }
    const controls = await executeImmediate('conversation-controls', () =>
      repositories.commands.updateConversationControls({
        organizationId: snapshot.organizationId,
        conversationId,
        ...patch,
        idempotencyKey: createClientId(),
      })
    );
    if (!controls) return false;
    setSnapshot((current) => current ? {
      ...current,
      conversations: current.conversations.map((item) => item.id === conversationId ? {
        ...item,
        postingMode: controls.postingMode,
        configuredJoinPolicy: controls.configuredJoinPolicy,
        joinPolicy: controls.joinPolicy,
        visibility: controls.visibility,
        canPost: item.managementOnly
          ? false
          : controls.postingMode === 'admins_only' ? item.canManage === true : true,
      } : item),
    } : current);
    return true;
  }, [executeImmediate, repositories.commands, snapshot]);

  const requestConversationJoin = useCallback(async (conversationId: string) => {
    if (!snapshot || !snapshot.discoverableConversations.some(
      (item) => item.conversationId === conversationId,
    )) return false;
    const request = await executeImmediate('conversation-join-request', () =>
      repositories.commands.requestConversationJoin({
        organizationId: snapshot.organizationId,
        conversationId,
        idempotencyKey: createClientId(),
      })
    );
    if (!request) return false;
    setSnapshot((current) => current ? {
      ...current,
      discoverableConversations: current.discoverableConversations.map((item) =>
        item.conversationId === conversationId ? { ...item, myJoinRequest: request } : item
      ),
    } : current);
    return true;
  }, [executeImmediate, repositories.commands, snapshot]);

  const cancelConversationJoinRequest = useCallback(async (request: ConversationJoinRequest) => {
    if (!snapshot || request.status !== 'pending') return false;
    const receipt = await executeImmediate('conversation-join-cancel', () =>
      repositories.commands.cancelConversationJoinRequest({
        organizationId: snapshot.organizationId,
        requestId: request.requestId,
        expectedVersion: request.version,
        idempotencyKey: createClientId(),
      })
    );
    if (!receipt) return false;
    setSnapshot((current) => current ? {
      ...current,
      discoverableConversations: current.discoverableConversations.map((item) =>
        item.conversationId === receipt.conversationId ? { ...item, myJoinRequest: receipt } : item
      ),
    } : current);
    return true;
  }, [executeImmediate, repositories.commands, snapshot]);

  const loadConversationJoinRequests = useCallback(async (conversationId: string) => {
    const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
    if (
      !snapshot
      || !conversation?.canManageConversation
      || conversation.policyManaged
      || !['group', 'team'].includes(conversation.kind)
    ) return [];
    return await repositories.commands.listConversationJoinRequests({
      organizationId: snapshot.organizationId,
      conversationId,
      limit: 100,
    });
  }, [repositories.commands, snapshot]);

  const decideConversationJoinRequest = useCallback(async (
    request: ConversationJoinRequest,
    decision: 'approved' | 'rejected',
    reason: string,
  ) => {
    const conversation = snapshot?.conversations.find(
      (item) => item.id === request.conversationId,
    );
    if (
      !snapshot
      || !conversation?.canManageConversation
      || conversation.policyManaged
      || !['group', 'team'].includes(conversation.kind)
      || reason.trim().length < 3
    ) return false;
    const receipt = await executeImmediate('conversation-join-decision', () =>
      repositories.commands.decideConversationJoinRequest({
        organizationId: snapshot.organizationId,
        requestId: request.requestId,
        expectedVersion: request.version,
        decision,
        reason,
        idempotencyKey: createClientId(),
      })
    );
    if (!receipt) return false;
    await refresh();
    return true;
  }, [executeImmediate, refresh, repositories.commands, snapshot]);

  const addConversationMember = useCallback(
    async (conversationId: string, personId: string, role: 'member' | 'admin') => {
      const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
      const person = snapshot?.people.find((item) => item.id === personId);
      if (
        !snapshot
        || !conversation?.canManageConversation
        || !['group', 'team', 'shift', 'incident'].includes(conversation.kind)
        || conversation.policyManaged
        || conversation.memberIds?.includes(personId)
      ) {
        return false;
      }
      const effectiveRole = conversation.canManage ? role : 'member';
      const result = await executeImmediate('conversation-add-member', () =>
        repositories.commands.addConversationMember({
          organizationId: snapshot.organizationId,
          conversationId,
          membershipId: person?.membershipId ?? personId,
          role: effectiveRole,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              conversations: current.conversations.map((item) =>
                item.id === conversationId
                  ? {
                      ...item,
                      memberIds: [...(item.memberIds ?? []), personId],
                      memberRoles: { ...(item.memberRoles ?? {}), [personId]: effectiveRole },
                      participantCount: (item.participantCount ?? 0) + 1,
                    }
                  : item,
              ),
            }
          : current,
      );
      if (conversation.managementOnly) await refresh();
      return true;
    },
    [executeImmediate, refresh, repositories.commands, snapshot],
  );

  const removeConversationMember = useCallback(
    async (conversationId: string, personId: string) => {
      const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
      const person = snapshot?.people.find((item) => item.id === personId);
      if (
        !snapshot ||
        !conversation?.canManageConversation ||
        (!conversation.canManage
          && !['group', 'team', 'shift', 'incident'].includes(conversation.kind)) ||
        conversation.policyManaged ||
        !conversation.memberIds?.includes(personId) ||
        personId === snapshot.currentUser.id ||
        conversation.memberRoles?.[personId] === 'owner' ||
        (!conversation.canManage && conversation.memberRoles?.[personId] !== 'member')
      ) {
        return false;
      }
      const result = await executeImmediate('conversation-remove-member', () =>
        repositories.commands.removeConversationMember({
          organizationId: snapshot.organizationId,
          conversationId,
          membershipId: person?.membershipId ?? personId,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              conversations: current.conversations.map((item) => {
                if (item.id !== conversationId) return item;
                const nextRoles = { ...(item.memberRoles ?? {}) };
                delete nextRoles[personId];
                return {
                  ...item,
                  memberIds: (item.memberIds ?? []).filter((id) => id !== personId),
                  memberRoles: nextRoles,
                  participantCount: Math.max(1, (item.participantCount ?? 1) - 1),
                };
              }),
            }
          : current,
      );
      if (conversation.managementOnly) await refresh();
      return true;
    },
    [executeImmediate, refresh, repositories.commands, snapshot],
  );

  const updateConversationMemberRole = useCallback(
    async (
      conversationId: string,
      personId: string,
      expectedRole: 'owner' | 'admin' | 'member',
      newRole: 'owner' | 'admin' | 'member',
    ) => {
      const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
      const person = snapshot?.people.find((item) => item.id === personId);
      if (
        !snapshot ||
        !conversation?.canManage ||
        conversation.policyManaged ||
        !person ||
        !conversation.memberIds?.includes(personId) ||
        conversation.memberRoles?.[personId] !== expectedRole ||
        expectedRole === newRole
      ) return false;
      const receipt = await executeImmediate('conversation-member-role', () =>
        repositories.commands.updateConversationMemberRole({
          organizationId: snapshot.organizationId,
          conversationId,
          membershipId: person.membershipId ?? person.id,
          expectedRole,
          newRole,
          idempotencyKey: createClientId(),
        })
      );
      if (!receipt) return false;
      setSnapshot((current) => current ? {
        ...current,
        conversations: current.conversations.map((item) => item.id === conversationId ? {
          ...item,
          memberRoles: { ...(item.memberRoles ?? {}), [personId]: receipt.role },
        } : item),
      } : current);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const leaveConversation = useCallback(async (
    conversationId: string,
    replacementOwnerPersonId?: string,
  ) => {
    const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
    const replacement = replacementOwnerPersonId
      ? snapshot?.people.find((person) => person.id === replacementOwnerPersonId)
      : undefined;
    if (
      !snapshot
      || !conversation?.departure?.eligible
      || (conversation.departure.requiresOwnershipTransfer && (
        !replacement
        || replacement.suspended
        || replacement.id === snapshot.currentUser.id
        || !conversation.memberIds?.includes(replacement.id)
      ))
      || (!conversation.departure.requiresOwnershipTransfer && replacementOwnerPersonId !== undefined)
    ) return false;

    const receipt = await executeImmediate('conversation-leave', () =>
      repositories.commands.leaveConversation({
        organizationId: snapshot.organizationId,
        conversationId,
        replacementOwnerMembershipId: replacement?.membershipId ?? replacement?.id ?? null,
        confirmHistoryAndAccessLoss: true,
        idempotencyKey: createClientId(),
      }),
    );
    if (!receipt?.left || !receipt.historyPreserved || !receipt.futureAccessRevoked) return false;

    for (const [key, operation] of attachmentUploadsRef.current) {
      if (operation.conversationId !== conversationId) continue;
      operation.controller?.abort();
      await cleanupPreparedAttachment(operation.prepared).catch(() => undefined);
      attachmentUploadsRef.current.delete(key);
    }
    for (const [key, cancellation] of attachmentCancellationsRef.current) {
      if (cancellation.conversationId === conversationId) attachmentCancellationsRef.current.delete(key);
    }
    for (const key of receiptProgressRef.current.keys()) {
      if (key.startsWith(`${snapshot.organizationId}:${conversationId}:`)) {
        receiptProgressRef.current.delete(key);
      }
    }
    const commands = await clientStore.listOutbox(snapshot.currentUser.id, snapshot.organizationId);
    await Promise.all(conversationOutboxCommandIds(commands, conversationId).map((id) =>
      clientStore.removeOutbox(id)
    ));
    const cacheKey = offlineWorkspaceCacheKey(snapshot.currentUser.id);
    if (cacheKey) await clientStore.removeCache(cacheKey).catch(() => undefined);
    await synchronizeMessageOutbox();

    const remaining = snapshot.conversations.filter((item) => (
      item.id !== conversationId && !item.managementOnly
    ));
    setSnapshot((current) => current ? redactDepartedConversation(current, conversationId) : current);
    setSelectedConversationId((current) => current === conversationId ? remaining[0]?.id ?? '' : current);
    setUnreadDividerIds((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    setMessagePagination((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    return true;
  }, [executeImmediate, repositories.commands, snapshot, synchronizeMessageOutbox]);

  const closeIncident = useCallback(
    async (conversationId: string, reason: string) => {
      const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
      const normalizedReason = reason.trim();
      if (
        !snapshot
        || conversation?.kind !== 'incident'
        || conversation.isReadOnly
        || !conversation.canManage
        || normalizedReason.length < 3
      ) return false;
      const result = await executeImmediate('incident-close', () =>
        repositories.commands.closeIncident({
          organizationId: snapshot.organizationId,
          conversationId,
          reason: normalizedReason,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) => current ? {
        ...current,
        conversations: current.conversations.map((item) => item.id === conversationId ? {
          ...item,
          closedAt: new Date().toISOString(),
          closedByUserId: current.currentUser.id,
          closureReason: normalizedReason,
          isReadOnly: true,
        } : item),
      } : current);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const publishUpdate = useCallback(
    async (input: {
      conversationId: string;
      title: string;
      body: string;
      priority: 'normal' | 'important' | 'emergency';
      requiresAcknowledgement: boolean;
      expiresAt?: string | null;
      scheduledAt?: string | null;
      acknowledgementSchema?: CompanyUpdate['acknowledgementSchema'];
      notificationClass: NonNullable<CompanyUpdate['notificationClass']>;
      reminderPolicy?: CompanyUpdate['reminderPolicy'];
      audienceSpec: UpdateAudienceSpec;
    }) => {
      if (!snapshot || !snapshot.capabilities.includes('communications.publish')) return false;
      const title = input.title.trim();
      const body = input.body.trim();
      if (!title || !body) return false;
      const clientMessageId = createClientId();
      const result = await executeImmediate('update-publish', () =>
        repositories.commands.publishUpdate({
          organizationId: snapshot.organizationId,
          conversationId: input.conversationId,
          clientMessageId,
          title,
          body,
          languageCode: snapshot.currentUser.preferredLanguage,
          priority: input.priority,
          requiresAcknowledgement: input.requiresAcknowledgement,
          expiresAt: input.expiresAt ?? null,
          scheduledAt: input.scheduledAt ?? null,
          acknowledgementSchema: input.acknowledgementSchema ?? null,
          notificationClass: input.notificationClass,
          reminderPolicy: input.reminderPolicy ?? null,
          audienceSpec: input.audienceSpec,
          idempotencyKey: clientMessageId,
        }),
      );
      if (!result) return false;
      const update: CompanyUpdate = {
        id: result.announcementId,
        versionId: result.versionId,
        versionNumber: 1,
        title,
        body,
        author: snapshot.currentUser.displayName,
        audience: result.audienceCount === undefined
          ? 'Audience snapshot pending'
          : `${result.audienceCount} active members`,
        publishedAt: result.status === 'scheduled' && result.scheduledAt
          ? `Scheduled · ${new Date(result.scheduledAt).toLocaleString()}`
          : 'Now',
        severity:
          input.priority === 'emergency'
            ? 'critical'
            : input.priority === 'important'
              ? 'important'
              : 'standard',
        acknowledgementRequired: input.requiresAcknowledgement,
        acknowledged: false,
        acknowledgedCount: 0,
        recipientCount: result.audienceCount ?? 0,
        recipientCountKnown: result.audienceCount !== undefined,
        deadline: input.expiresAt ?? undefined,
        status: result.status ?? (input.scheduledAt ? 'scheduled' : 'published'),
        scheduledAt: result.scheduledAt ?? input.scheduledAt ?? undefined,
        notificationClass: input.notificationClass,
        acknowledgementSchema: input.acknowledgementSchema ?? null,
        reminderPolicy: input.reminderPolicy ?? null,
      };
      setSnapshot((current) =>
        current ? { ...current, updates: [update, ...current.updates] } : current,
      );
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const previewUpdateAudience = useCallback(
    async (conversationId: string, audienceSpec: UpdateAudienceSpec) => {
      if (!snapshot || !snapshot.capabilities.includes('communications.publish')) return null;
      return executeImmediate('update-audience-preview', () =>
        repositories.commands.previewUpdateAudience({
          organizationId: snapshot.organizationId,
          conversationId,
          audienceSpec,
          idempotencyKey: createClientId(),
        }),
      );
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const cancelScheduledUpdate = useCallback(
    async (updateId: string, reason: string) => {
      const update = snapshot?.updates.find((item) => item.id === updateId);
      const normalizedReason = reason.trim();
      if (
        !snapshot
        || !snapshot.capabilities.includes('communications.publish')
        || update?.status !== 'scheduled'
        || normalizedReason.length < 3
      ) return false;
      const result = await executeImmediate('update-cancel', () =>
        repositories.commands.cancelScheduledUpdate({
          organizationId: snapshot.organizationId,
          announcementId: update.id,
          reason: normalizedReason,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) => current ? {
        ...current,
        updates: current.updates.map((item) => item.id === updateId
          ? { ...item, status: 'cancelled' }
          : item),
      } : current);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const acknowledgeUpdate = useCallback(
    async (updateId: string) => {
      if (!snapshot) return;
      const target = snapshot.updates.find((update) => update.id === updateId);
      if (!target || target.acknowledged) return;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              updates: current.updates.map((update) =>
                update.id === updateId && !update.acknowledged
                  ? {
                      ...update,
                      acknowledged: true,
                      acknowledgedCount: update.acknowledgedCount + 1,
                    }
                  : update,
              ),
            }
          : current,
      );
      const idempotencyKey = createClientId();
      const payload = {
        organizationId: snapshot.organizationId,
        versionId: target.versionId,
        idempotencyKey,
      };
      const rollbackAcknowledgement = () => setSnapshot((current) => current ? {
        ...current,
        updates: current.updates.map((update) => update.id === updateId && update.acknowledged
          ? {
              ...update,
              acknowledged: false,
              acknowledgedCount: Math.max(0, update.acknowledgedCount - 1),
            }
          : update),
      } : current);
      if (snapshot.currentUser.membershipType === 'guest') {
        try {
          await repositories.commands.acknowledgeUpdate(payload);
          setConnectivity('online');
        } catch (commandError) {
          rollbackAcknowledgement();
          const failure = snapshot.currentUser.membershipType === 'guest' && isOfflineError(commandError)
            ? t('errors.guestOnlineRequired')
            : t(errorMessageKey(commandError));
          setActionError(failure);
          if (isOfflineError(commandError)) setConnectivity('offline');
        }
        return;
      }
      if (!offlineWorkspaceEntitlement(snapshot.currentUser).eligible) {
        rollbackAcknowledgement();
        await clientStore.purgeUser(snapshot.currentUser.id);
        setActionError(t('errors.accessEnded'));
        return;
      }
      await clientStore.enqueue({
        id: idempotencyKey,
        organizationId: snapshot.organizationId,
        userId: snapshot.currentUser.id,
        kind: 'acknowledge_update',
        payload,
        createdAt: new Date().toISOString(),
        attempts: 0,
        state: 'queued',
      });
      await flushOutbox();
    },
    [flushOutbox, repositories.commands, snapshot, t],
  );

  const createHandoff = useCallback(
    async (input: {
      conversationId: string;
      title: string;
      details: string;
      shiftStartedAt: string;
      shiftEndedAt: string;
      sourceMessageIds: string[];
      acknowledgementDueAt?: string | null;
    }) => {
      if (!snapshot || !snapshot.capabilities.includes('handoff.manage')) return false;
      const title = input.title.trim();
      const details = input.details.trim();
      const started = new Date(input.shiftStartedAt);
      const ended = new Date(input.shiftEndedAt);
      const availableMessageIds = new Set((snapshot.messages[input.conversationId] ?? []).map(
        (message) => message.serverId ?? message.id,
      ));
      const sourceMessageIds = [...new Set(input.sourceMessageIds)].filter((id) => availableMessageIds.has(id));
      const acknowledgementDueAt = input.acknowledgementDueAt?.trim() || null;
      const acknowledgementDue = acknowledgementDueAt ? new Date(acknowledgementDueAt) : null;
      if (
        !title
        || !details
        || Number.isNaN(started.getTime())
        || Number.isNaN(ended.getTime())
        || ended <= started
        || sourceMessageIds.length < 1
        || (acknowledgementDue && (Number.isNaN(acknowledgementDue.getTime()) || acknowledgementDue <= ended))
      ) {
        setActionError(t('errors.handoffInvalid'));
        return false;
      }
      const result = await executeImmediate('handoff-create', () =>
        repositories.commands.createHandoff({
          organizationId: snapshot.organizationId,
          conversationId: input.conversationId,
          title,
          details,
          sourceLanguage: snapshot.currentUser.preferredLanguage,
          shiftStartedAt: started.toISOString(),
          shiftEndedAt: ended.toISOString(),
          sourceMessageIds,
          acknowledgementDueAt: acknowledgementDue?.toISOString() ?? null,
          idempotencyKey: createClientId(),
        }),
      );
      if (!result) return false;
      const handoff: ShiftHandoff = {
        id: result.handoffId,
        conversationId: input.conversationId,
        versionId: result.versionId,
        versionNumber: 1,
        sourceLanguage: snapshot.currentUser.preferredLanguage,
        title,
        site: snapshot.currentUser.site,
        outgoingShift: started.toLocaleString(),
        incomingShift: ended.toLocaleString(),
        window: `${started.toLocaleString()} – ${ended.toLocaleString()}`,
        status: 'draft',
        summary: details,
        openItems: 0,
        sourceCount: sourceMessageIds.length,
        outgoingSupervisor: snapshot.currentUser.displayName,
        incomingSupervisor: 'Assigned incoming supervisor',
        shiftStartedAt: started.toISOString(),
        shiftEndedAt: ended.toISOString(),
        authorId: snapshot.currentUser.id,
        canSign: true,
        canAcknowledge: false,
        acknowledgedByMe: false,
        sourceMessageIds,
        sourceState: 'current',
        acknowledgementDueAt: acknowledgementDue?.toISOString(),
      };
      setSnapshot((current) =>
        current ? { ...current, handoffs: [handoff, ...current.handoffs] } : current,
      );
      return true;
    },
    [executeImmediate, repositories.commands, snapshot, t],
  );

  const correctHandoff = useCallback(
    async (handoffId: string, input: {
      expectedVersionId: string;
      expectedVersionNumber: number;
      title: string;
      details: string;
      shiftStartedAt: string;
      shiftEndedAt: string;
      sourceMessageIds: string[];
      acknowledgementDueAt?: string | null;
      reason: string;
    }) => {
      const handoff = snapshot?.handoffs.find((item) => item.id === handoffId);
      const conversation = snapshot?.conversations.find(
        (item) => item.id === handoff?.conversationId,
      );
      if (
        !snapshot
        || !handoff
        || !snapshot.capabilities.includes('handoff.manage')
        || !conversation?.canManage
      ) return false;
      if (
        handoff.versionId !== input.expectedVersionId
        || handoff.versionNumber !== input.expectedVersionNumber
      ) {
        setActionError(t('errors.conflict'));
        return false;
      }
      const title = input.title.trim();
      const details = input.details.trim();
      const reason = input.reason.trim();
      const started = new Date(input.shiftStartedAt);
      const ended = new Date(input.shiftEndedAt);
      const acknowledgementDueAt = input.acknowledgementDueAt?.trim() || null;
      const acknowledgementDue = acknowledgementDueAt ? new Date(acknowledgementDueAt) : null;
      const knownSourceIds = new Set([
        ...handoff.sourceMessageIds,
        ...(snapshot.messages[handoff.conversationId] ?? [])
          .filter((message) => !message.deleted)
          .map((message) => message.serverId ?? message.id),
      ]);
      const sourceMessageIds = [...new Set(input.sourceMessageIds)].filter(
        (id) => knownSourceIds.has(id),
      );
      if (
        !title
        || title.length > 240
        || !details
        || details.length > 30_000
        || reason.length < 3
        || reason.length > 2_000
        || Number.isNaN(started.getTime())
        || Number.isNaN(ended.getTime())
        || ended <= started
        || sourceMessageIds.length < 1
        || sourceMessageIds.length > 500
        || (acknowledgementDue && (
          Number.isNaN(acknowledgementDue.getTime()) || acknowledgementDue <= ended
        ))
      ) {
        setActionError(t('errors.handoffInvalid'));
        return false;
      }
      const result = await executeImmediate(`handoff-correct:${handoffId}`, () =>
        repositories.commands.correctHandoff({
          organizationId: snapshot.organizationId,
          handoffId,
          expectedVersionId: input.expectedVersionId,
          expectedVersionNumber: input.expectedVersionNumber,
          title,
          details,
          sourceLanguage: handoff.sourceLanguage,
          shiftStartedAt: started.toISOString(),
          shiftEndedAt: ended.toISOString(),
          sourceMessageIds,
          acknowledgementDueAt: acknowledgementDue?.toISOString() ?? null,
          reason,
          idempotencyKey: createClientId(),
        }),
      );
      if (!result) return false;
      setSnapshot((current) => current ? {
        ...current,
        handoffs: current.handoffs.map((item) => {
          if (item.id !== handoffId || item.versionNumber > result.versionNumber) return item;
          if (
            item.versionNumber === result.versionNumber
            && item.versionId !== result.versionId
          ) return item;
          return {
            ...item,
            versionId: result.versionId,
            versionNumber: result.versionNumber,
            title,
            summary: details,
            outgoingShift: started.toLocaleString(),
            incomingShift: ended.toLocaleString(),
            window: `${started.toLocaleString()} – ${ended.toLocaleString()}`,
            shiftStartedAt: started.toISOString(),
            shiftEndedAt: ended.toISOString(),
            status: 'draft',
            canSign: handoff.authorId === snapshot.currentUser.id,
            canAcknowledge: false,
            acknowledgedByMe: false,
            sourceMessageIds: result.sourceMessageIds,
            sourceCount: result.sourceMessageIds.length,
            sourceFingerprint: result.sourceFingerprint,
            sourceState: 'current',
            sourceStaleAt: undefined,
            sourceStaleReason: undefined,
            acknowledgementDueAt: result.acknowledgementDueAt ?? undefined,
            overdue: false,
            reminderState: 'not_due',
            reminderCount: 0,
            lastRemindedAt: undefined,
            escalationState: 'not_due',
            escalatedAt: undefined,
            smsFallbackAvailable: false,
            correctionOfVersionId: handoff.versionId,
            correctionReason: reason,
          };
        }),
      } : current);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot, t],
  );

  const signHandoff = useCallback(
    async (handoffId: string) => {
      const handoff = snapshot?.handoffs.find((item) => item.id === handoffId);
      if (!snapshot || !handoff?.canSign) return false;
      const result = await executeImmediate('handoff-sign', () =>
        repositories.commands.signHandoff({
          organizationId: snapshot.organizationId,
          versionId: handoff.versionId,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              handoffs: current.handoffs.map((item) =>
                item.id === handoffId
                  ? { ...item, status: 'ready', canSign: false, canAcknowledge: false }
                  : item,
              ),
            }
          : current,
      );
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const acknowledgeHandoff = useCallback(
    async (handoffId: string, input: {
      expectedVersionId: string;
      expectedVersionNumber: number;
      note?: string;
    }) => {
      const handoff = snapshot?.handoffs.find((item) => item.id === handoffId);
      if (!snapshot || !handoff?.canAcknowledge) return false;
      if (
        handoff.versionId !== input.expectedVersionId
        || handoff.versionNumber !== input.expectedVersionNumber
      ) {
        setActionError(t('errors.conflict'));
        return false;
      }
      const note = input.note?.trim() || null;
      if (note && note.length > 2_000) return false;
      const result = await executeImmediate(`handoff-acknowledge:${handoffId}`, () =>
        repositories.commands.acknowledgeHandoff({
          organizationId: snapshot.organizationId,
          versionId: input.expectedVersionId,
          note,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              handoffs: current.handoffs.map((item) =>
                item.id === handoffId && item.versionId === input.expectedVersionId
                  ? {
                      ...item,
                      status: 'acknowledged',
                      canAcknowledge: false,
                      acknowledgedByMe: true,
                    }
                  : item,
              ),
            }
          : current,
      );
      return true;
    },
    [executeImmediate, repositories.commands, snapshot, t],
  );

  const updateConnection = useCallback(
    async (personId: string) => {
      if (!snapshot) return false;
      const person = snapshot.people.find((item) => item.id === personId);
      // Username-search results outside the loaded directory are valid targets
      // only in the personal realm, where the connection commands address the
      // target user's UUID directly.
      if (person ? person.connectionState !== 'available' : !isPersonalRealm(snapshot.organizationId)) {
        return false;
      }
      setActionError(null);
      try {
        await repositories.commands.requestConnection({
          organizationId: snapshot.organizationId,
          targetMembershipId: person?.membershipId ?? personId,
          idempotencyKey: createClientId(),
        });
        setSnapshot((current) =>
          current
            ? {
                ...current,
                people: current.people.map((item) =>
                  item.id === personId ? { ...item, connectionState: 'pending' } : item,
                ),
              }
            : current,
        );
        setConnectivity('online');
        return true;
      } catch (connectionError) {
        setActionError(t(errorMessageKey(connectionError)));
        if (isOfflineError(connectionError)) setConnectivity('offline');
        return false;
      }
    },
    [repositories.commands, snapshot, t],
  );

  const searchUsers = useCallback(
    async (query: string) => {
      if (!snapshot || !repositories.reads) return null;
      const normalized = query.trim().toLocaleLowerCase();
      if (normalized.length < 2) return [];
      setActionError(null);
      try {
        const users = await repositories.reads.searchUsers({
          organizationId: snapshot.organizationId,
          query: normalized.slice(0, 64),
          limit: 20,
        });
        setConnectivity('online');
        return users;
      } catch (searchError) {
        setActionError(t(errorMessageKey(searchError)));
        if (isOfflineError(searchError)) setConnectivity('offline');
        return null;
      }
    },
    [repositories.reads, snapshot, t],
  );

  const sendMessageRequest = useCallback(
    async (targetUserId: string, body: string, displayName?: string) => {
      const text = body.trim();
      // The route reuses the send-message bound of 20,000 characters.
      if (
        !snapshot
        || !text
        || text.length > 20_000
        || targetUserId === snapshot.currentUser.id
      ) {
        return null;
      }
      const receipt = await executeImmediate('message-request', () =>
        repositories.commands.sendMessageRequest({
          organizationId: snapshot.organizationId,
          targetUserId,
          body: text,
          idempotencyKey: createClientId(),
        }),
      );
      if (!receipt) return null;
      const accepted = receipt.connectionStatus === 'accepted';
      const known = snapshot.people.find((item) => item.id === targetUserId);
      const counterpartName = known?.displayName ?? displayName?.trim() ?? '';
      const counterpart: Person = known ?? {
        id: targetUserId,
        membershipId: targetUserId,
        organizationId: snapshot.organizationId,
        displayName: counterpartName || 'Direct message',
        initials: nameInitials(counterpartName || 'Direct message'),
        roleLabel: '',
        role: 'employee',
        site: '',
        department: '',
        preferredLanguage: snapshot.currentUser.preferredLanguage,
        presence: 'offline',
        connectionState: accepted ? 'connected' : 'pending',
        connectionRequestDirection: accepted ? undefined : 'outgoing',
        avatarColor: '#496D62',
      };
      const conversation: Conversation = {
        id: receipt.conversationId,
        organizationId: snapshot.organizationId,
        directParticipantId: targetUserId,
        title: counterpart.displayName,
        initials: counterpart.initials,
        avatarColor: counterpart.avatarColor,
        kind: 'direct',
        subtitle: counterpart.roleLabel,
        lastMessage: text,
        lastActivity: '',
        unreadCount: 0,
        pinned: false,
        favorite: false,
        muted: false,
        presence: counterpart.presence,
      };
      setSnapshot((current) =>
        current
          ? {
              ...current,
              conversations: current.conversations.some((item) => item.id === conversation.id)
                ? current.conversations
                : [conversation, ...current.conversations],
              messages: {
                ...current.messages,
                [conversation.id]: current.messages[conversation.id] ?? [],
              },
              cursors: { ...current.cursors, [conversation.id]: null },
              people: current.people.some((item) => item.id === targetUserId)
                ? current.people.map((item) =>
                    item.id === targetUserId
                      ? {
                          ...item,
                          connectionState: accepted ? 'connected' : 'pending',
                          connectionRequestDirection: accepted ? undefined : 'outgoing',
                        }
                      : item,
                  )
                : [...current.people, counterpart],
            }
          : current,
      );
      selectConversation(conversation.id);
      return receipt.conversationId;
    },
    [executeImmediate, repositories.commands, selectConversation, snapshot],
  );

  const respondConnection = useCallback(
    async (personId: string, decision: 'accepted' | 'declined') => {
      const person = snapshot?.people.find((item) => item.id === personId);
      if (!snapshot || !person || person.connectionRequestDirection !== 'incoming') return false;
      const result = await executeImmediate('connection-respond', () =>
        repositories.commands.respondConnection({
          organizationId: snapshot.organizationId,
          membershipId: person.membershipId ?? person.id,
          decision,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              people: current.people.map((item) =>
                item.id === personId
                  ? {
                      ...item,
                      connectionState: decision === 'accepted' ? 'connected' : 'available',
                      connectionRequestDirection: undefined,
                    }
                  : item,
              ),
            }
          : current,
      );
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const removeConnection = useCallback(
    async (personId: string) => {
      if (!snapshot) return false;
      const person = snapshot.people.find((item) => item.id === personId);
      // A username-search target is often absent from the loaded directory
      // (right after Connect, or before the next bootstrap lands). The personal
      // realm addresses connection routes by the target user's UUID, so an
      // unknown pending target is still cancellable there; workspace
      // organizations keep the directory gate.
      if (
        person
          ? !['connected', 'pending'].includes(person.connectionState)
          : !isPersonalRealm(snapshot.organizationId)
      ) {
        return false;
      }
      const result = await executeImmediate('connection-remove', () =>
        repositories.commands.removeConnection({
          organizationId: snapshot.organizationId,
          membershipId: person?.membershipId ?? personId,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      // Cancelling an outgoing request also drops its optimistic request
      // thread; removing an accepted connection keeps the shared history.
      const cancelledRequest = !person
        || (person.connectionState === 'pending' && person.connectionRequestDirection === 'outgoing');
      const removedConversationIds = new Set(
        cancelledRequest
          ? snapshot.conversations
              .filter((item) => item.kind === 'direct' && item.directParticipantId === personId)
              .map((item) => item.id)
          : [],
      );
      setSnapshot((current) => {
        if (!current) return current;
        const people = current.people.map((item) =>
          item.id === personId
            ? { ...item, connectionState: 'available' as const, connectionRequestDirection: undefined }
            : item,
        );
        if (!removedConversationIds.size) return { ...current, people };
        return {
          ...current,
          people,
          conversations: current.conversations.filter((item) => !removedConversationIds.has(item.id)),
          messages: Object.fromEntries(
            Object.entries(current.messages).filter(([id]) => !removedConversationIds.has(id)),
          ),
          cursors: Object.fromEntries(
            Object.entries(current.cursors).filter(([id]) => !removedConversationIds.has(id)),
          ),
        };
      });
      if (removedConversationIds.has(selectedConversationIdRef.current)) {
        const fallback = snapshot.conversations.find(
          (item) => !removedConversationIds.has(item.id) && !item.managementOnly,
        )?.id ?? '';
        selectedConversationIdRef.current = fallback;
        setSelectedConversationId(fallback);
      }
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const saveContact = useCallback(
    async (personId: string, alias: string, isFavorite: boolean) => {
      const person = snapshot?.people.find((item) => item.id === personId);
      if (!snapshot || !person || person.id === snapshot.currentUser.id) return false;
      const result = await executeImmediate('contact-save', () =>
        repositories.commands.saveContact({
          organizationId: snapshot.organizationId,
          membershipId: person.membershipId ?? person.id,
          alias: alias.trim() || null,
          isFavorite,
          idempotencyKey: createClientId(),
        }),
      );
      if (!result) return false;
      setSnapshot((current) => current ? {
        ...current,
        people: current.people.map((item) => item.id === personId ? {
          ...item,
          savedContact: true,
          contactAlias: result.alias,
          favoriteContact: result.isFavorite,
        } : item),
      } : current);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const removeSavedContact = useCallback(
    async (personId: string) => {
      const person = snapshot?.people.find((item) => item.id === personId);
      if (!snapshot || !person || !person.savedContact) return false;
      const result = await executeImmediate('contact-remove', () =>
        repositories.commands.removeSavedContact({
          organizationId: snapshot.organizationId,
          membershipId: person.membershipId ?? person.id,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) => current ? {
        ...current,
        people: current.people.map((item) => item.id === personId ? {
          ...item,
          savedContact: false,
          contactAlias: null,
          favoriteContact: false,
        } : item),
      } : current);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const setPersonBlocked = useCallback(
    async (personId: string, blocked: boolean) => {
      const person = snapshot?.people.find((item) => item.id === personId);
      if (!snapshot || !person || person.id === snapshot.currentUser.id) return false;
      const result = await executeImmediate(blocked ? 'person-block' : 'person-unblock', () =>
        repositories.commands.setPersonBlocked({
          organizationId: snapshot.organizationId,
          membershipId: person.membershipId ?? person.id,
          blocked,
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      await refresh();
      return true;
    },
    [executeImmediate, refresh, repositories.commands, snapshot],
  );

  const loadRoleAssignments = useCallback(
    async (personId: string) => {
      const person = snapshot?.people.find((item) => item.id === personId);
      if (!snapshot || !snapshot.capabilities.includes('roles.read') || !person) return false;
      setRoleAssignments([]);
      setRoleAssignmentsPersonId(personId);
      const result = await executeImmediate('roles-load', () =>
        repositories.commands.queryRoleAssignments({
          organizationId: snapshot.organizationId,
          targetMembershipId: person.membershipId ?? person.id,
          limit: 50,
          idempotencyKey: createClientId(),
        }),
      );
      if (!result) return false;
      setRoleAssignments(result);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const queryAudit = useCallback(
    async (input: Omit<AuditQueryInput, 'organizationId'>) => {
      if (!snapshot || !repositories.reads || !snapshot.capabilities.includes('audit.read')) {
        return null;
      }
      return executeImmediate('audit-query', () => repositories.reads!.queryAudit({
        ...input,
        organizationId: snapshot.organizationId,
      }));
    },
    [executeImmediate, repositories.reads, snapshot],
  );

  const exportAudit = useCallback(
    async (
      input: Omit<AuditQueryInput, 'organizationId' | 'cursor' | 'limit'> & {
        format: 'json' | 'csv';
      },
    ) => {
      if (!snapshot || !snapshot.capabilities.includes('audit.read')) return null;
      return executeImmediate('audit-export', () => repositories.commands.exportAudit({
        ...input,
        organizationId: snapshot.organizationId,
      }));
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const assignRole = useCallback(
    async (personId: string, input: {
      roleName: AdminRoleName;
      scopeType: 'organization' | 'unit';
      unitId: string | null;
      expiresAt: string | null;
      reason: string;
    }) => {
      const person = snapshot?.people.find((item) => item.id === personId);
      if (
        !snapshot
        || !snapshot.capabilities.includes('roles.manage')
        || !person
        || input.reason.trim().length < 3
        || (input.scopeType === 'unit' && !input.unitId)
      ) return false;
      const result = await executeImmediate('role-assign', () =>
        repositories.commands.assignAdminRole({
          organizationId: snapshot.organizationId,
          targetMembershipId: person.membershipId ?? person.id,
          roleName: input.roleName,
          scopeType: input.scopeType,
          unitId: input.scopeType === 'unit' ? input.unitId : null,
          expiresAt: input.expiresAt,
          reason: input.reason.trim(),
          idempotencyKey: createClientId(),
        }),
      );
      if (!result) return false;
      setRoleAssignments((current) => [result, ...current.filter((item) => item.assignmentId !== result.assignmentId)]);
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const revokeRole = useCallback(
    async (assignmentId: string, reason: string) => {
      if (!snapshot || !snapshot.capabilities.includes('roles.manage') || reason.trim().length < 3) return false;
      const result = await executeImmediate('role-revoke', () =>
        repositories.commands.revokeAdminRole({
          organizationId: snapshot.organizationId,
          assignmentId,
          reason: reason.trim(),
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setRoleAssignments((current) => current.map((item) => item.assignmentId === assignmentId
        ? { ...item, active: false, revokedAt: new Date().toISOString() }
        : item));
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const issueInvitation = useCallback(
    async (input: {
      destinationType: 'email' | 'phone';
      destination: string;
      employeeCode?: string | null;
      activationMode: 'otp' | 'manual';
      role: 'admin' | 'manager' | 'member';
      expiresInSeconds: number;
      membershipType: 'employee' | 'contractor' | 'guest';
      membershipAccessExpiresAt: string | null;
      guestSponsorUserId: string | null;
    }) => {
      const destination = input.destinationType === 'email'
        ? input.destination.trim().toLocaleLowerCase()
        : input.destination.replace(/[\s().-]/g, '');
      const employeeCode = input.employeeCode?.trim() || null;
      const destinationValid = input.destinationType === 'email'
        ? /^\S+@\S+\.\S+$/.test(destination)
        : /^\+[1-9][0-9]{7,14}$/.test(destination);
      const accessExpiry = input.membershipAccessExpiresAt === null
        ? null
        : Date.parse(input.membershipAccessExpiresAt);
      const accessExpiryValid = accessExpiry !== null && Number.isFinite(accessExpiry) &&
        accessExpiry > Date.now() + input.expiresInSeconds * 1000 &&
        accessExpiry <= Date.now() + 365 * 24 * 60 * 60 * 1000;
      if (
        !snapshot
        || !snapshot.capabilities.includes('invites.manage')
        || !destinationValid
        || (input.activationMode === 'manual' && (!employeeCode || employeeCode.length > 64))
        || input.expiresInSeconds < 900
        || input.expiresInSeconds > 2_592_000
        || (input.membershipType === 'employee' &&
          (input.membershipAccessExpiresAt !== null || input.guestSponsorUserId !== null))
        || (input.membershipType === 'contractor' &&
          (!accessExpiryValid || input.guestSponsorUserId !== null))
        || (input.membershipType === 'guest' &&
          (input.role !== 'member' || !accessExpiryValid || !input.guestSponsorUserId))
      ) return null;
      return executeImmediate('invite-issue', () =>
        repositories.commands.issueInvitation({
          organizationId: snapshot.organizationId,
          destinationType: input.destinationType,
          destination,
          employeeCode,
          activationMode: input.activationMode,
          role: input.role,
          expiresInSeconds: input.expiresInSeconds,
          membershipType: input.membershipType,
          membershipAccessExpiresAt: input.membershipAccessExpiresAt,
          guestSponsorUserId: input.guestSponsorUserId,
          idempotencyKey: createClientId(),
        }),
      );
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const suspendMember = useCallback(
    async (personId: string, reason: string) => {
      const person = snapshot?.people.find((item) => item.id === personId);
      if (
        !snapshot ||
        !snapshot.capabilities.includes('members.security') ||
        !person ||
        person.id === snapshot.currentUser.id ||
        reason.trim().length < 3
      ) {
        return false;
      }
      const result = await executeImmediate('member-suspend', () =>
        repositories.commands.suspendMember({
          organizationId: snapshot.organizationId,
          membershipId: person.membershipId ?? person.id,
          reason: reason.trim(),
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              people: current.people.map((item) =>
                item.id === personId ? { ...item, suspended: true, presence: 'offline' } : item,
              ),
            }
          : current,
      );
      return true;
    },
    [executeImmediate, repositories.commands, snapshot],
  );

  const revokeSession = useCallback(
    async (sessionId: string, reason: string) => {
      if (!snapshot || !sessionId || reason.trim().length < 3) return false;
      const revokingCurrentSession = sessionId === auth.sessionId
        || accountSessions.some((session) => session.sessionId === sessionId && session.current);
      const result = await executeImmediate('session-revoke', () =>
        repositories.commands.revokeSession({
          organizationId: snapshot.organizationId,
          sessionId,
          reason: reason.trim(),
          idempotencyKey: createClientId(),
        }),
      );
      if (result === null) return false;
      if (revokingCurrentSession) {
        // The authoritative RPC has committed its revocation row and outbox
        // job. Only now tear down channels, credentials, and cached user data.
        refreshIdentityRef.current = `revoked:${sessionId}`;
        await auth.signOut();
        snapshotRef.current = null;
        selectedConversationIdRef.current = '';
        setSnapshot(null);
        setSelectedConversationId('');
        setAccountSessions([]);
        setDeviceNotificationPreferences(null);
        return true;
      }
      setAccountSessions((current) => current.filter((item) => item.sessionId !== sessionId));
      return true;
    },
    [accountSessions, auth, executeImmediate, repositories.commands, snapshot],
  );

  const queryCurrentDeviceNotificationPreferences = useCallback(async () => {
    if (!snapshot) return null;
    const installationId = await getCurrentInstallationId();
    if (!installationId) return null;
    return repositories.commands.getDeviceNotificationPreferences({
      organizationId: snapshot.organizationId,
      installationId,
    });
  }, [repositories.commands, snapshot]);

  const loadAccountSettings = useCallback(async () => {
    if (!snapshot) return;
    setActionBusy('account-settings-load');
    setActionError(null);
    try {
      const [preferences, sessions, currentDevicePreferences] = await Promise.all([
        repositories.commands.loadOrganizationPreferences({
          organizationId: snapshot.organizationId,
          idempotencyKey: createClientId(),
        }),
        repositories.commands.listSessions({
          organizationId: snapshot.organizationId,
          idempotencyKey: createClientId(),
        }),
        queryCurrentDeviceNotificationPreferences().catch((deviceError) => {
          if (
            deviceError instanceof RepositoryError &&
            (deviceError.status === 403 || ['forbidden', 'permission_denied'].includes(deviceError.code))
          ) return null;
          throw deviceError;
        }),
      ]);
      setOrganizationPreferences(preferences);
      setAccountSessions(sessions);
      setDeviceNotificationPreferences(currentDevicePreferences);
    } catch (settingsError) {
      setActionError(t(errorMessageKey(settingsError)));
      if (isOfflineError(settingsError)) setConnectivity('offline');
    } finally {
      setActionBusy((current) => current === 'account-settings-load' ? null : current);
    }
  }, [queryCurrentDeviceNotificationPreferences, repositories.commands, snapshot, t]);

  const saveOrganizationPreferences = useCallback(async (patch: Partial<OrganizationPreferences>) => {
    if (!snapshot) return false;
    const result = await executeImmediate('organization-preferences-save', () =>
      repositories.commands.updateOrganizationPreferences({
        organizationId: snapshot.organizationId,
        patch,
        idempotencyKey: createClientId(),
      }),
    );
    if (!result) return false;
    setOrganizationPreferences(result);
    return true;
  }, [executeImmediate, repositories.commands, snapshot]);

  const updateOrganizationPolicy = useCallback(async (policy: OrganizationPolicyUpdate) => {
    if (!snapshot || snapshot.currentMembershipRole !== 'owner') return false;
    const result = await executeImmediate('organization-policy-update', () =>
      repositories.commands.updateOrganizationPolicy({
        organizationId: snapshot.organizationId,
        policy,
        idempotencyKey: createClientId(),
      })
    );
    if (!result) return false;
    setSnapshot((current) => current ? { ...current, organizationPolicy: result } : current);
    return true;
  }, [executeImmediate, repositories.commands, snapshot]);

  const loadOrganizationAiPolicy = useCallback(async () => {
    if (!snapshot || !snapshot.capabilities.includes('ai.policy.manage')) return null;
    const result = await executeImmediate('organization-ai-policy-load', () =>
      repositories.commands.getOrganizationAiPolicy({
        organizationId: snapshot.organizationId,
      })
    );
    if (!result || result.organizationId !== snapshot.organizationId) return null;
    setOrganizationAiPolicy(result);
    return result;
  }, [executeImmediate, repositories.commands, snapshot]);

  const updateOrganizationAiPolicy = useCallback(async (
    policy: Omit<OrganizationAiPolicyUpdate, 'expectedVersion'>,
  ) => {
    if (
      !snapshot ||
      !snapshot.capabilities.includes('ai.policy.manage') ||
      !organizationAiPolicy ||
      organizationAiPolicy.organizationId !== snapshot.organizationId
    ) return null;
    const result = await executeImmediate('organization-ai-policy-update', () =>
      repositories.commands.updateOrganizationAiPolicy({
        organizationId: snapshot.organizationId,
        policy: {
          ...policy,
          expectedVersion: organizationAiPolicy.policyVersion,
        },
        idempotencyKey: createClientId(),
      })
    );
    if (!result || result.organizationId !== snapshot.organizationId) return null;
    setOrganizationAiPolicy(result);
    return result;
  }, [executeImmediate, organizationAiPolicy, repositories.commands, snapshot]);

  const loadDynamicGroupPolicies = useCallback(async (append = false) => {
    if (!snapshot || !snapshot.capabilities.includes('unit.manage')) return false;
    if (append && !dynamicGroupNextAfterPolicyId) return true;
    const page = await executeImmediate('dynamic-group-list', () =>
      repositories.commands.listDynamicGroupPolicies({
        organizationId: snapshot.organizationId,
        afterPolicyId: append ? dynamicGroupNextAfterPolicyId : null,
        limit: 50,
      })
    );
    if (!page) return false;
    setDynamicGroupOrganizationId(snapshot.organizationId);
    setDynamicGroupPolicies((current) => {
      const rows = append ? [...current, ...page.policies] : page.policies;
      return [...new Map(rows.map((policy) => [policy.policyId, policy])).values()]
        .sort((left, right) => left.policyId.localeCompare(right.policyId));
    });
    setDynamicGroupNextAfterPolicyId(page.nextAfterPolicyId);
    return true;
  }, [
    dynamicGroupNextAfterPolicyId,
    executeImmediate,
    repositories.commands,
    snapshot,
  ]);

  const saveDynamicGroupPolicy = useCallback(async (input: {
    conversationId: string;
    policyId?: string | null;
    expectedVersion: number;
    policySpec: DynamicGroupPolicySpec;
    maximumMembers: number;
  }) => {
    if (!snapshot || !snapshot.capabilities.includes('unit.manage')) return null;
    return executeImmediate('dynamic-group-save', () =>
      repositories.commands.saveDynamicGroupPolicy({
        organizationId: snapshot.organizationId,
        ...input,
        idempotencyKey: createClientId(),
      })
    );
  }, [executeImmediate, repositories.commands, snapshot]);

  const previewDynamicGroupPolicy = useCallback(async (
    policyId: string,
    expectedVersion: number,
    sampleLimit = 50,
  ) => {
    if (!snapshot || !snapshot.capabilities.includes('unit.manage')) return null;
    return executeImmediate('dynamic-group-preview', () =>
      repositories.commands.previewDynamicGroupPolicy({
        organizationId: snapshot.organizationId,
        policyId,
        expectedVersion,
        sampleLimit,
      })
    );
  }, [executeImmediate, repositories.commands, snapshot]);

  const publishDynamicGroupPolicy = useCallback(async (
    policyId: string,
    expectedVersion: number,
    previewFingerprint: string,
  ) => {
    if (!snapshot || !snapshot.capabilities.includes('unit.manage')) return null;
    return executeImmediate('dynamic-group-publish', () =>
      repositories.commands.publishDynamicGroupPolicy({
        organizationId: snapshot.organizationId,
        policyId,
        expectedVersion,
        previewFingerprint,
        idempotencyKey: createClientId(),
      })
    );
  }, [executeImmediate, repositories.commands, snapshot]);

  const pauseDynamicGroupPolicy = useCallback(async (
    policyId: string,
    expectedVersion: number,
    reason: string,
  ) => {
    if (!snapshot || !snapshot.capabilities.includes('unit.manage')) return null;
    return executeImmediate('dynamic-group-pause', () =>
      repositories.commands.pauseDynamicGroupPolicy({
        organizationId: snapshot.organizationId,
        policyId,
        expectedVersion,
        reason: reason.trim(),
        idempotencyKey: createClientId(),
      })
    );
  }, [executeImmediate, repositories.commands, snapshot]);

  const loadDeviceNotificationPreferences = useCallback(async () => {
    if (!snapshot) return false;
    const result = await executeImmediate(
      'device-preferences-load',
      queryCurrentDeviceNotificationPreferences,
    );
    if (!result) {
      setDeviceNotificationPreferences(null);
      return false;
    }
    setDeviceNotificationPreferences(result);
    return true;
  }, [executeImmediate, queryCurrentDeviceNotificationPreferences, snapshot]);

  const saveDeviceNotificationPreferences = useCallback(async (
    patch: DeviceNotificationPreferencePatch,
  ) => {
    if (!snapshot || !deviceNotificationPreferences) return false;
    const result = await executeImmediate('device-preferences-save', () =>
      repositories.commands.updateDeviceNotificationPreferences({
        organizationId: snapshot.organizationId,
        installationId: deviceNotificationPreferences.installationId,
        expectedVersion: deviceNotificationPreferences.preferenceVersion,
        patch,
        idempotencyKey: createClientId(),
      }),
    );
    if (!result) return false;
    setDeviceNotificationPreferences(result);
    return true;
  }, [deviceNotificationPreferences, executeImmediate, repositories.commands, snapshot]);

  const enableNotifications = useCallback(async () => {
    if (!snapshot) return false;
    setActionBusy('device-register');
    setActionError(null);
    try {
      const registration = await requestDeviceRegistration(snapshot.organizationId);
      if (!registration) {
        throw new RepositoryError(
          'Notification permission was not granted on this device.',
          'notification_permission_denied',
          false,
        );
      }
      await repositories.commands.registerDevice(registration);
      const result = await repositories.commands.getDeviceNotificationPreferences({
        organizationId: snapshot.organizationId,
        installationId: registration.installationId,
      });
      // The device state only flips once the service confirmed the binding.
      setDeviceNotificationPreferences(result);
      setConnectivity('online');
      return true;
    } catch (registrationError) {
      // Generic failures quote the stable code and correlation id so a member
      // can report them; specific copy (simulator, permission) stays clean.
      const localized = t(errorMessageKey(registrationError));
      const identifier = errorIdentifier(registrationError);
      setActionError(identifier ? `${localized} (${identifier})` : localized);
      if (isOfflineError(registrationError)) setConnectivity('offline');
      return false;
    } finally {
      setActionBusy((current) => (current === 'device-register' ? null : current));
    }
  }, [repositories.commands, snapshot, t]);

  const hasCapability = useCallback((capability: WorkspaceCapability, unitId?: string | null) => {
    if (!snapshot?.capabilities.includes(capability)) return false;
    if (!unitId) return true;
    return snapshot.scopes.some((scope) =>
      scope.permissions.includes(capability)
      && (scope.scopeType === 'organization' || scope.unitId === unitId)
      && (!scope.expiresAt || new Date(scope.expiresAt).getTime() > Date.now())
    );
  }, [snapshot]);

  const value = useMemo<WorkspaceState>(
    () => ({
      organizationId: snapshot?.organizationId ?? '',
      organizationName: snapshot?.organizationName ?? '',
      currentMembershipRole: snapshot?.currentMembershipRole ?? null,
      organizationPolicy: snapshot?.organizationPolicy ?? null,
      organizationAiPolicy: organizationAiPolicy?.organizationId === snapshot?.organizationId
        ? organizationAiPolicy
        : null,
      currentUser: snapshot?.currentUser ?? null,
      conversations: snapshot?.conversations ?? [],
      conversationAvatarUrls,
      profileAvatarUrls,
      requestProfileAvatar,
      uploadProfileAvatar,
      removeProfileAvatar,
      discoverableConversations: snapshot?.discoverableConversations ?? [],
      messages: snapshot?.messages ?? {},
      people: snapshot?.people ?? [],
      units: snapshot?.units ?? [],
      updates: snapshot?.updates ?? [],
      handoffs: snapshot?.handoffs ?? [],
      summaries: snapshot?.summaries ?? [],
      actions: snapshot?.actions ?? [],
      moderationReports: snapshot?.moderationReports ?? [],
      auditEvents: snapshot?.auditEvents ?? [],
      capabilities: snapshot?.capabilities ?? [],
      authorizationScopes: snapshot?.scopes ?? [],
      messageDisplayLanguage: snapshot?.messageDisplayLanguage ?? null,
      selectedConversationId,
      inboxFilter,
      inboxSearch,
      status,
      connectivity,
      offlineQueueAvailable: Boolean(snapshot && snapshot.currentUser.membershipType !== 'guest'),
      realtimeState,
      realtimeToken: auth.realtimeToken ?? null,
      error,
      actionError,
      actionBusy,
      outboxCount,
      failedOutboxCount,
      outboxDegradedReason,
      messageOutbox,
      organizationPreferences,
      deviceNotificationPreferences,
      accountSessions,
      roleAssignments,
      roleAssignmentsPersonId,
      aiOutputErrorReports,
      aiOutputReviewQueue,
      selectedAiOutputReport,
      dynamicGroupPolicies: dynamicGroupOrganizationId === snapshot?.organizationId
        ? dynamicGroupPolicies
        : [],
      dynamicGroupNextAfterPolicyId: dynamicGroupOrganizationId === snapshot?.organizationId
        ? dynamicGroupNextAfterPolicyId
        : null,
      messagePagination,
      unreadDividerIds,
      refresh,
      loadOlderMessages,
      observeConversation,
      markConversationRead,
      ensureMessageLoaded,
      requestTranslation,
      proposeTranslationCorrection,
      reviewTranslationCorrection,
      requestConversationSummary,
      correctConversationSummary,
      reviewConversationSummary,
      reportAiOutputError,
      loadMyAiOutputErrorReports,
      loadAiOutputReviewQueue,
      readAiOutputErrorReport,
      reviewAiOutputErrorReport,
      proposeAiRegressionExample,
      decideAiRegressionExample,
      setConversationSummaryPolicy,
      selectConversation,
      setInboxFilter,
      setInboxSearch,
      openOrCreateDirectConversation,
      queryGroupCreationCandidates,
      queryConversationMemberCandidates,
      createGroupConversation,
      uploadConversationAvatar,
      removeConversationAvatar,
      sendMessage,
      editOutboxMessage,
      retryOutboxMessage,
      cancelOutboxMessage,
      sendAttachment,
      cancelAttachmentUpload,
      retryAttachmentUpload,
      editMessage,
      deleteMessage,
      hideMessageForMe,
      forwardMessage,
      placeMessagePreservationHold,
      releaseMessagePreservationHold,
      toggleReaction,
      setMessagePinned,
      reportMessage,
      reportGroup,
      reportMember,
      proposeAction,
      confirmAction,
      transitionAction,
      downloadAttachment,
      attachmentPreviewUrls,
      loadAttachmentPreview,
      updateConversation,
      updateConversationPreferences,
      updateConversationControls,
      updateProfile,
      requestConversationJoin,
      cancelConversationJoinRequest,
      loadConversationJoinRequests,
      decideConversationJoinRequest,
      addConversationMember,
      removeConversationMember,
      updateConversationMemberRole,
      leaveConversation,
      closeIncident,
      publishUpdate,
      previewUpdateAudience,
      cancelScheduledUpdate,
      acknowledgeUpdate,
      createHandoff,
      correctHandoff,
      signHandoff,
      acknowledgeHandoff,
      updateConnection,
      respondConnection,
      searchUsers,
      sendMessageRequest,
      removeConnection,
      saveContact,
      removeSavedContact,
      setPersonBlocked,
      loadRoleAssignments,
      queryAudit,
      exportAudit,
      assignRole,
      revokeRole,
      issueInvitation,
      suspendMember,
      revokeSession,
      loadAccountSettings,
      saveOrganizationPreferences,
      updateOrganizationPolicy,
      loadOrganizationAiPolicy,
      updateOrganizationAiPolicy,
      loadDynamicGroupPolicies,
      saveDynamicGroupPolicy,
      previewDynamicGroupPolicy,
      publishDynamicGroupPolicy,
      pauseDynamicGroupPolicy,
      loadDeviceNotificationPreferences,
      saveDeviceNotificationPreferences,
      enableNotifications,
      clearActionError: () => setActionError(null),
      hasCapability,
    }),
    [
      acknowledgeUpdate,
      actionError,
      actionBusy,
      addConversationMember,
      decideConversationJoinRequest,
      acknowledgeHandoff,
      connectivity,
      conversationAvatarUrls,
      profileAvatarUrls,
      requestProfileAvatar,
      uploadProfileAvatar,
      removeProfileAvatar,
      createGroupConversation,
      uploadConversationAvatar,
      removeConversationAvatar,
      createHandoff,
      correctHandoff,
      closeIncident,
      correctConversationSummary,
      cancelAttachmentUpload,
      cancelConversationJoinRequest,
      cancelOutboxMessage,
      cancelScheduledUpdate,
      deleteMessage,
      hideMessageForMe,
      forwardMessage,
      placeMessagePreservationHold,
      releaseMessagePreservationHold,
      downloadAttachment,
      attachmentPreviewUrls,
      loadAttachmentPreview,
      editMessage,
      editOutboxMessage,
      ensureMessageLoaded,
      enableNotifications,
      deviceNotificationPreferences,
      error,
      failedOutboxCount,
      outboxDegradedReason,
      hasCapability,
      organizationPreferences,
      organizationAiPolicy,
      loadDeviceNotificationPreferences,
      saveDeviceNotificationPreferences,
      accountSessions,
      roleAssignments,
      roleAssignmentsPersonId,
      aiOutputErrorReports,
      aiOutputReviewQueue,
      selectedAiOutputReport,
      dynamicGroupPolicies,
      dynamicGroupNextAfterPolicyId,
      dynamicGroupOrganizationId,
      inboxFilter,
      inboxSearch,
      openOrCreateDirectConversation,
      queryGroupCreationCandidates,
      queryConversationMemberCandidates,
      outboxCount,
      publishUpdate,
      previewUpdateAudience,
      proposeTranslationCorrection,
      removeConnection,
      saveContact,
      removeSavedContact,
      setPersonBlocked,
      loadRoleAssignments,
      queryAudit,
      exportAudit,
      assignRole,
      revokeRole,
      issueInvitation,
      loadOlderMessages,
      loadConversationJoinRequests,
      markConversationRead,
      messagePagination,
      messageOutbox,
      observeConversation,
      removeConversationMember,
      updateConversationMemberRole,
      leaveConversation,
      reportMessage,
      reportGroup,
      reportMember,
      requestConversationSummary,
      requestConversationJoin,
      requestTranslation,
      retryAttachmentUpload,
      retryOutboxMessage,
      proposeAction,
      confirmAction,
      transitionAction,
      respondConnection,
      searchUsers,
      sendMessageRequest,
      revokeSession,
      reviewConversationSummary,
      reportAiOutputError,
      loadMyAiOutputErrorReports,
      loadAiOutputReviewQueue,
      readAiOutputErrorReport,
      reviewAiOutputErrorReport,
      proposeAiRegressionExample,
      decideAiRegressionExample,
      reviewTranslationCorrection,
      loadAccountSettings,
      saveOrganizationPreferences,
      updateOrganizationPolicy,
      loadOrganizationAiPolicy,
      updateOrganizationAiPolicy,
      loadDynamicGroupPolicies,
      saveDynamicGroupPolicy,
      previewDynamicGroupPolicy,
      publishDynamicGroupPolicy,
      pauseDynamicGroupPolicy,
      realtimeState,
      auth.realtimeToken,
      refresh,
      selectConversation,
      selectedConversationId,
      sendMessage,
      sendAttachment,
      signHandoff,
      snapshot,
      status,
      suspendMember,
      toggleReaction,
      setMessagePinned,
      setConversationSummaryPolicy,
      updateConversation,
      updateConversationControls,
      updateConversationPreferences,
      updateConnection,
      updateProfile,
      unreadDividerIds,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return context;
}
