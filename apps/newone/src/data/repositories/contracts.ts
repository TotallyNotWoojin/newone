import type { Session } from '@supabase/supabase-js';

import type {
  CompanyUpdate,
  Conversation,
  ConversationHistoryPolicy,
  ConversationHistoryDisclosure,
  ConversationKind,
  IncidentSeverity,
  LanguageCode,
  Message,
  Person,
  CurrentWorkspaceUser,
  ShiftHandoff,
  SearchResultType,
  SearchLanguageFilter,
  SearchMessageMatchSource,
  WorkspaceSearchResult,
  OrganizationPreferences,
  AccountSession,
  AdminRoleAssignment,
  AdminRoleName,
  AuthorizationScope,
  WorkspaceCapability,
  ConversationSummary,
  OperationalAction,
  ModerationReport,
  AuditEvent,
  AuditAccessReason,
  AuditExportReceipt,
  PrivilegedAuditEvent,
  NotificationClass,
  UpdateAcknowledgementSchema,
  UpdateReminderPolicy,
  ConversationJoinRequest,
  DiscoverableConversation,
  AiOutputErrorCategory,
  AiOutputErrorReport,
  AiOutputErrorReportDetail,
  AiRegressionExample,
} from '@/domain/types';
import type {
  HandoffCorrectionInput,
  HandoffCorrectionReceipt,
} from '@/data/repositories/handoff-correction-dto.mjs';
import type { ConversationDepartureReceipt } from '@/data/repositories/conversation-departure-dto.mjs';
import type { PrivateReportReceipt } from '@/data/repositories/private-report-dto.mjs';
import type {
  DeviceNotificationPreferencePatch,
  DeviceNotificationPreferences,
} from '@/data/repositories/device-notification-preferences-dto.mjs';
import type {
  ConversationMemberRoleReceipt,
  GroupCreationCandidatesReceipt,
  GroupCreationReceipt,
  InitialConversationRole,
} from '@/data/repositories/group-creation-dto.mjs';
import type {
  ConversationAvatarActivationReceipt,
  ConversationAvatarReadGrant,
  ConversationAvatarRemovalReceipt,
  ConversationAvatarUploadGrant,
} from '@/data/repositories/conversation-avatar-dto.mjs';
import type {
  ProfileAvatarActivationReceipt,
  ProfileAvatarReadGrant,
  ProfileAvatarRemovalReceipt,
  ProfileAvatarUploadGrant,
} from './profile-avatar-dto.d.mts';
import type { MessageRequestReceipt } from '@/data/repositories/message-request-dto.mjs';
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
  DynamicGroupPolicyList,
  DynamicGroupPolicySpec,
  DynamicGroupPreviewReceipt,
  DynamicGroupPublishReceipt,
  DynamicGroupSaveReceipt,
} from '@/data/repositories/dynamic-group-dto.mjs';

export interface WorkspaceSnapshot {
  organizationId: string;
  organizationName: string;
  conversationControlsVersion: number;
  currentMembershipRole: 'owner' | 'admin' | 'manager' | 'member';
  organizationPolicy: OrganizationPolicy;
  currentUser: CurrentWorkspaceUser;
  conversations: Conversation[];
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
  scopes: AuthorizationScope[];
  messageDisplayLanguage: LanguageCode;
  cursors: Record<string, string | null>;
  discoverableConversations: DiscoverableConversation[];
}

export interface OrganizationUnitOption {
  unitId: string;
  parentUnitId: string | null;
  kind: 'site' | 'department' | 'team' | 'line' | 'shift';
  name: string;
}

export interface MessagePage {
  items: Message[];
  cursor: string | null;
}

export interface MessageReceiptInput {
  organizationId: string;
  conversationId: string;
  messageId: string;
  state: 'delivered' | 'read';
  idempotencyKey: string;
}

export interface MessageReceiptResult {
  conversationId: string;
  messageId: string;
  scope: 'self';
  deliveredAt: string;
  readAt: string | null;
}

/** The range the reader picked; the server resolves it to messages. */
export interface SummaryRangeInput {
  kind: NonNullable<ConversationSummary['scopeKind']>;
  subject: string | null;
  /** Server id of the first message the reader saw as unread (range 'unread'). */
  fromMessageId: string | null;
  utcOffsetMinutes: number;
}

export interface RequestSummaryInput {
  organizationId: string;
  conversationId: string;
  range: SummaryRangeInput;
  languageCode: LanguageCode;
  idempotencyKey: string;
}

export interface ManualSummaryInput {
  organizationId: string;
  conversationId: string;
  sourceMessageIds: string[];
  languageCode: LanguageCode;
  idempotencyKey: string;
  primaryTopic: string;
  summary: string;
  keyTopics: string[];
  decisions: { text: string; sourceMessageIds: string[] }[];
  actionItems: {
    text: string;
    sourceMessageIds: string[];
    owner: string | null;
    due: string | null;
  }[];
  ambiguities: string[];
}

export interface SearchPage {
  results: WorkspaceSearchResult[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AuditQueryInput {
  organizationId: string;
  reasonCode: AuditAccessReason;
  dateFrom: string;
  dateTo: string;
  eventTypes?: string[];
  actorMembershipId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface AuditPage {
  items: PrivilegedAuditEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  snapshotAt: string;
  filterSha256: string;
  receiptId: string;
}

export interface SearchRepository {
  search(input: {
    organizationId: string;
    query: string;
    types?: SearchResultType[];
    cursor?: string | null;
    limit?: number;
    senderMembershipId?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    matchSources?: SearchMessageMatchSource[] | null;
    conversationId?: string | null;
    language?: SearchLanguageFilter | null;
  }): Promise<SearchPage>;
}

export interface UserSearchResult {
  userId: string;
  username: string;
  displayName: string | null;
  avatarPath: string | null;
  connectionState: 'none' | 'pending_outgoing' | 'pending_incoming' | 'accepted';
}

export interface ReadRepository {
  loadWorkspace(userId: string, selectedConversationId?: string | null): Promise<WorkspaceSnapshot>;
  loadMessages(input: {
    organizationId: string;
    conversationId: string;
    userId: string;
    after?: string | null;
  }): Promise<MessagePage>;
  searchUsers(input: {
    organizationId: string;
    query: string;
    limit?: number;
  }): Promise<UserSearchResult[]>;
  queryAudit(input: AuditQueryInput): Promise<AuditPage>;
}

export interface CreateDirectInput {
  organizationId: string;
  targetMembershipId: string;
  idempotencyKey: string;
}

export interface SendMessageInput {
  organizationId: string;
  conversationId: string;
  clientMessageId: string;
  body: string | null;
  kind?: 'text' | 'attachment';
  languageCode: string;
  replyToMessageId?: string;
  replyPreview?: { senderName: string; preview: string };
  mentionUserIds?: string[];
  idempotencyKey: string;
}

export interface CreateGroupInput {
  organizationId: string;
  name: string;
  description?: string | null;
  memberAssignments: { membershipId: string; role: InitialConversationRole }[];
  kind: Exclude<ConversationKind, 'direct' | 'announcement'>;
  unitId?: string | null;
  historyPolicy: ConversationHistoryPolicy;
  postingMode: 'all_members' | 'admins_only';
  joinPolicy: 'inherit' | 'invite_only' | 'approval_required';
  incidentSeverity?: IncidentSeverity | null;
  incidentClassification?: string | null;
  idempotencyKey: string;
}

export interface ConversationMemberReceipt {
  historyVisibleFrom: string | null;
  historyPolicy: ConversationHistoryPolicy;
  historyDisclosure: ConversationHistoryDisclosure;
}

/** Authoritative receipt for a self-service profile edit. */
export interface ProfileUpdateReceipt {
  userId: string;
  displayName: string;
  statusMessage: string | null;
}

export interface UpdateAudiencePreview {
  audienceCount: number;
  excludedCount: number;
  sampleUserIds: string[];
  sample: {
    userId: string;
    displayName: string;
    preferredLanguage: string;
    membershipRole: 'owner' | 'admin' | 'manager' | 'member';
    unitIds: string[];
    currentShift: boolean;
  }[];
  notificationLanguages: string[];
  exclusionCounts: {
    inactiveMembers: number;
    selectorMismatch: number;
  };
  normalizedSpec: UpdateAudienceSpec;
  snapshotBasis:
    | 'active_members_at_publish'
    | 'active_members_and_current_shift_at_publish';
  generatedAt: string;
}

export interface UpdateAudienceSpec {
  company: boolean;
  conversationMembers: boolean;
  siteIds: string[];
  departmentIds: string[];
  teamIds: string[];
  unitIds: string[];
  operationalRoles: string[];
  membershipRoles: ('owner' | 'admin' | 'manager' | 'member')[];
  languages: string[];
  currentShiftOnly: boolean;
}

export interface ManagedUpdateVersion {
  versionId: string;
  versionNumber: number;
  title: string;
  body: string;
  publishedAt: string | null;
  correctionOfVersionId: string | null;
  correctionReason: string | null;
  createdByUserId: string;
  createdByDisplayName: string;
}

export interface ManagedUpdate {
  announcementId: string;
  conversationId: string;
  conversationTitle: string;
  versionId: string;
  versionNumber: number;
  versionCount: number;
  title: string;
  body: string;
  languageCode: LanguageCode;
  priority: 'normal' | 'important' | 'emergency';
  notificationClass: NotificationClass;
  criticalCategory: 'safety' | 'security' | 'operations' | 'weather' | 'business_continuity' | null;
  quietHoursOverrideReason: string | null;
  requiresAcknowledgement: boolean;
  acknowledgementSchema: UpdateAcknowledgementSchema;
  reminderPolicy: UpdateReminderPolicy;
  status: 'scheduled' | 'published' | 'cancelled' | 'archived';
  scheduledAt: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  correctionOfVersionId: string | null;
  correctionReason: string | null;
  audienceSnapshotted: boolean;
  recipientCount: number;
  deliveredCount: number;
  readCount: number;
  acknowledgedCount: number;
  nonAcknowledgedCount: number;
  overdueCount: number;
  unreachableCount: number;
  versions: ManagedUpdateVersion[];
}

export interface UpdateNonAcknowledger {
  userId: string;
  displayName: string;
  preferredLanguage: string;
  membershipStatus: 'active' | 'suspended' | 'deactivated';
  deliveredAt: string | null;
  readAt: string | null;
  reminderCount: number;
  lastRemindedAt: string | null;
  escalatedAt: string | null;
  reachability: 'delivered' | 'pending' | 'unreachable';
  overdue: boolean;
}

export interface UpdateNonAcknowledgerPage {
  announcementId: string;
  versionId: string;
  versionNumber: number;
  deadlineAt: string | null;
  people: UpdateNonAcknowledger[];
  hasMore: boolean;
  nextAfterUserId: string | null;
  privacyScope: 'notice_response_state_only';
}

export interface UpdateAcknowledgementReceipt {
  announcementId: string;
  versionId: string;
  acknowledgedAt: string;
  sessionId: string;
  deviceId: string | null;
  installationId: string;
  platform: 'ios' | 'android' | 'web';
  clientFamily: 'iphone' | 'ipad' | 'android' | 'mobile' | 'desktop' | 'unknown';
  sessionEvidenceCaptured: true;
}

export interface AttachmentUploadGrant {
  action: 'upload';
  attachmentId: string;
  bucket: 'message-attachments';
  path: string;
  signedUrl: string;
  token: string;
  expiresInSeconds: number;
}

export interface AttachmentDownloadGrant {
  action: 'download';
  attachmentId: string;
  signedUrl: string;
  expiresInSeconds: number;
}

export interface AttachmentScanState {
  attachmentId: string;
  scanStatus: 'pending' | 'clean' | 'blocked' | 'failed';
  reasonCode?: string | null;
}

export type ReportCategory = 'harassment' | 'threat' | 'spam' | 'privacy' | 'misinformation' | 'other';

export interface RegisterDeviceInput {
  organizationId: string;
  installationId: string;
  platform: 'ios' | 'android';
  pushToken: string;
  pushTokenType: 'expo';
  pushProjectId: string;
  pushEnvironment: 'development' | 'preview' | 'production';
  appVersion?: string;
  locale?: string;
  idempotencyKey: string;
}

export interface IssuedInvitation {
  inviteId: string;
  destinationType: 'email' | 'phone';
  destinationMasked: string;
  role: 'admin' | 'manager' | 'member';
  activationMode: 'otp' | 'manual';
  expiresAt: string;
  activationToken: string | null;
  employeeCode: string | null;
  membershipType: 'employee' | 'contractor' | 'guest';
  membershipAccessExpiresAt: string | null;
  guestSponsorUserId: string | null;
}

export interface ConversationMemberCandidate {
  userId: string;
  displayName: string;
  avatarPath?: string;
  roleLabel?: string;
  membershipType?: 'employee' | 'contractor' | 'guest';
}

export interface ConversationMemberCandidatePage {
  candidates: ConversationMemberCandidate[];
  nextCursor: string | null;
}

export interface CommandRepository {
  createDirectConversation(input: CreateDirectInput): Promise<{ conversationId: string }>;
  exportAudit(input: Omit<AuditQueryInput, 'cursor' | 'limit'> & {
    format: 'json' | 'csv';
  }): Promise<AuditExportReceipt>;
  listGroupCreationCandidates(input: {
    organizationId: string;
    query?: string;
    limit?: number;
  }): Promise<GroupCreationCandidatesReceipt>;
  listConversationMemberCandidates(input: {
    organizationId: string;
    conversationId: string;
    query?: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<ConversationMemberCandidatePage>;
  createGroupConversation(input: CreateGroupInput): Promise<GroupCreationReceipt>;
  updateConversation(input: {
    organizationId: string;
    conversationId: string;
    name?: string | null;
    description?: string | null;
    isArchived?: boolean;
    idempotencyKey: string;
  }): Promise<void>;
  updateOrganizationConversationControls(input: {
    organizationId: string;
    defaultJoinPolicy?: 'invite_only' | 'approval_required';
    defaultGroupMemberLimit?: number;
    joinRequestExpiryDays?: number;
    maxPendingJoinRequestsPerUser?: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<void>;
  updateOrganizationPolicy(input: {
    organizationId: string;
    policy: OrganizationPolicyUpdate;
    idempotencyKey: string;
  }): Promise<OrganizationPolicy>;
  getOrganizationAiPolicy(input: {
    organizationId: string;
  }): Promise<OrganizationAiPolicy>;
  updateOrganizationAiPolicy(input: {
    organizationId: string;
    policy: OrganizationAiPolicyUpdate;
    idempotencyKey: string;
  }): Promise<OrganizationAiPolicy>;
  listDynamicGroupPolicies(input: {
    organizationId: string;
    afterPolicyId?: string | null;
    limit?: number;
  }): Promise<DynamicGroupPolicyList>;
  saveDynamicGroupPolicy(input: {
    organizationId: string;
    conversationId: string;
    policyId?: string | null;
    expectedVersion: number;
    policySpec: DynamicGroupPolicySpec;
    maximumMembers: number;
    idempotencyKey: string;
  }): Promise<DynamicGroupSaveReceipt>;
  previewDynamicGroupPolicy(input: {
    organizationId: string;
    policyId: string;
    expectedVersion: number;
    sampleLimit?: number;
  }): Promise<DynamicGroupPreviewReceipt>;
  publishDynamicGroupPolicy(input: {
    organizationId: string;
    policyId: string;
    expectedVersion: number;
    previewFingerprint: string;
    idempotencyKey: string;
  }): Promise<DynamicGroupPublishReceipt>;
  pauseDynamicGroupPolicy(input: {
    organizationId: string;
    policyId: string;
    expectedVersion: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<DynamicGroupPauseReceipt>;
  updateConversationControls(input: {
    organizationId: string;
    conversationId: string;
    postingMode?: 'all_members' | 'admins_only';
    joinPolicy?: 'inherit' | 'invite_only' | 'approval_required';
    visibility?: 'invite_only' | 'organization' | 'unit';
    reason: string;
    idempotencyKey: string;
  }): Promise<{
    conversationId: string;
    postingMode: 'all_members' | 'admins_only';
    configuredJoinPolicy: 'inherit' | 'invite_only' | 'approval_required';
    joinPolicy: 'invite_only' | 'approval_required';
    visibility: 'invite_only' | 'organization' | 'unit';
  }>;
  requestConversationJoin(input: {
    organizationId: string;
    conversationId: string;
    idempotencyKey: string;
  }): Promise<ConversationJoinRequest>;
  cancelConversationJoinRequest(input: {
    organizationId: string;
    requestId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<ConversationJoinRequest>;
  decideConversationJoinRequest(input: {
    organizationId: string;
    requestId: string;
    expectedVersion: number;
    decision: 'approved' | 'rejected';
    reason: string;
    idempotencyKey: string;
  }): Promise<ConversationJoinRequest>;
  listDiscoverableConversations(input: {
    organizationId: string;
    limit?: number;
  }): Promise<DiscoverableConversation[]>;
  listConversationJoinRequests(input: {
    organizationId: string;
    conversationId: string;
    limit?: number;
  }): Promise<ConversationJoinRequest[]>;
  updateProfile(input: {
    organizationId: string;
    displayName: string;
    statusMessage?: string | null;
    idempotencyKey: string;
  }): Promise<ProfileUpdateReceipt>;
  updateConversationPreferences(input: {
    organizationId: string;
    conversationId: string;
    isFavorite?: boolean;
    isPinned?: boolean;
    isArchived?: boolean;
    notificationLevel?: 'all' | 'mentions' | 'none';
    mutedUntil?: string | null;
    translationMode?: 'automatic' | 'off';
    idempotencyKey: string;
  }): Promise<void>;
  addConversationMember(input: {
    organizationId: string;
    conversationId: string;
    membershipId: string;
    role?: 'member' | 'admin';
    idempotencyKey: string;
  }): Promise<ConversationMemberReceipt>;
  removeConversationMember(input: {
    organizationId: string;
    conversationId: string;
    membershipId: string;
    idempotencyKey: string;
  }): Promise<void>;
  updateConversationMemberRole(input: {
    organizationId: string;
    conversationId: string;
    membershipId: string;
    expectedRole: InitialConversationRole;
    newRole: InitialConversationRole;
    idempotencyKey: string;
  }): Promise<ConversationMemberRoleReceipt>;
  createConversationAvatarUploadGrant(input: {
    organizationId: string;
    conversationId: string;
    fileName: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    byteSize: number;
    sha256Hex: string;
    idempotencyKey: string;
  }): Promise<ConversationAvatarUploadGrant>;
  getConversationAvatarReadGrant(input: {
    organizationId: string;
    conversationId: string;
    attachmentId: string;
  }): Promise<ConversationAvatarReadGrant>;
  activateConversationAvatar(input: {
    organizationId: string;
    conversationId: string;
    attachmentId: string;
    expectedAvatarPath: string | null;
    idempotencyKey: string;
  }): Promise<ConversationAvatarActivationReceipt>;
  removeConversationAvatar(input: {
    organizationId: string;
    conversationId: string;
    expectedAvatarPath: string;
    idempotencyKey: string;
  }): Promise<ConversationAvatarRemovalReceipt>;
  createProfileAvatarUploadGrant(input: {
    organizationId: string;
    fileName: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    byteSize: number;
    sha256Hex: string;
    idempotencyKey: string;
  }): Promise<ProfileAvatarUploadGrant>;
  getProfileAvatarReadGrant(input: { organizationId: string; userId: string }): Promise<ProfileAvatarReadGrant>;
  activateProfileAvatar(input: {
    organizationId: string;
    uploadId: string;
    expectedAvatarPath: string | null;
    idempotencyKey: string;
  }): Promise<ProfileAvatarActivationReceipt>;
  removeProfileAvatar(input: {
    organizationId: string;
    expectedAvatarPath: string;
    idempotencyKey: string;
  }): Promise<ProfileAvatarRemovalReceipt>;
  leaveConversation(input: {
    organizationId: string;
    conversationId: string;
    replacementOwnerMembershipId?: string | null;
    confirmHistoryAndAccessLoss: true;
    idempotencyKey: string;
  }): Promise<ConversationDepartureReceipt>;
  closeIncident(input: {
    organizationId: string;
    conversationId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<{
    messageId: string;
    clientMessageId: string;
    cursor: string | null;
    translationTargets: string[];
  }>;
  markMessageReceipt(input: MessageReceiptInput): Promise<MessageReceiptResult>;
  requestTranslation(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    targetLanguage: LanguageCode;
    idempotencyKey: string;
  }): Promise<{ translationId: string; status: 'queued'; retried: boolean }>;
  proposeTranslationCorrection(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    targetLanguage: LanguageCode;
    correctedBody: string;
    rationale?: string | null;
    idempotencyKey: string;
  }): Promise<{ correctionId: string; status: 'pending' }>;
  reviewTranslationCorrection(input: {
    organizationId: string;
    correctionId: string;
    decision: 'approved' | 'rejected' | 'changes_requested';
    note?: string | null;
    idempotencyKey: string;
  }): Promise<{ correctionId: string; decision: 'approved' | 'rejected' | 'changes_requested'; reviewedAt: string }>;
  requestConversationSummary(input: RequestSummaryInput): Promise<{
    summaryId: string;
    versionNumber: number;
    status: 'queued' | 'processing' | 'draft' | 'approved' | 'failed' | 'stale';
    sourceFingerprint: string;
    deduplicated: boolean;
  }>;
  createManualSummary(input: ManualSummaryInput): Promise<{
    summaryId: string;
    versionNumber: number;
    status: 'draft';
    outputFingerprint: string;
  }>;
  reviewConversationSummary(input: {
    organizationId: string;
    summaryId: string;
    decision: 'approve' | 'reject';
    note?: string | null;
    idempotencyKey: string;
  }): Promise<{ summaryId: string; status: 'approved' | 'failed'; humanReviewed: true }>;
  reportAiOutputError(input: {
    organizationId: string;
    outputKind: 'translation' | 'summary';
    translationId?: string | null;
    summaryId?: string | null;
    category: AiOutputErrorCategory;
    details: string;
    highConsequence: boolean;
    qualityUseConsent: boolean;
    consentVersion: string;
    idempotencyKey: string;
  }): Promise<AiOutputErrorReport & { deduplicated: boolean; originalsUnchanged: true }>;
  listMyAiOutputErrorReports(input: {
    organizationId: string;
    limit?: number;
  }): Promise<AiOutputErrorReport[]>;
  listAiOutputErrorReportsForReview(input: {
    organizationId: string;
    limit?: number;
  }): Promise<AiOutputErrorReport[]>;
  readAiOutputErrorReport(input: {
    organizationId: string;
    reportId: string;
  }): Promise<AiOutputErrorReportDetail>;
  reviewAiOutputErrorReport(input: {
    organizationId: string;
    reportId: string;
    expectedVersion: number;
    outcome: 'confirmed_error' | 'not_an_error' | 'needs_context';
    reviewNote: string;
    idempotencyKey: string;
  }): Promise<AiOutputErrorReport & { originalsUnchanged: true }>;
  proposeAiRegressionExample(input: {
    organizationId: string;
    reportId: string;
    expectedReportVersion: number;
    sourceLanguage: string;
    deidentifiedSourceText: string;
    deidentifiedObservedOutput: string;
    deidentifiedExpectedOutput: string;
    deidentificationAttested: true;
    attestationVersion: string;
    idempotencyKey: string;
  }): Promise<AiRegressionExample & { deduplicated: boolean }>;
  decideAiRegressionExample(input: {
    organizationId: string;
    exampleId: string;
    expectedVersion: number;
    decision: 'approved' | 'rejected';
    decisionNote: string;
    idempotencyKey: string;
  }): Promise<AiRegressionExample>;
  setSummaryPolicy(input: {
    organizationId: string;
    conversationId: string;
    mode: 'manual' | 'message_count' | 'shift_close';
    messageCountThreshold?: number | null;
    idempotencyKey: string;
  }): Promise<void>;
  editMessage(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    body: string;
    idempotencyKey: string;
  }): Promise<void>;
  deleteMessage(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    idempotencyKey: string;
  }): Promise<void>;
  hideMessageForMe(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    idempotencyKey: string;
  }): Promise<void>;
  forwardMessage(input: {
    organizationId: string;
    sourceConversationId: string;
    sourceMessageId: string;
    targetConversationId: string;
    clientMessageId: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string; clientMessageId: string }>;
  placeMessagePreservationHold(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    holdType: 'legal' | 'incident_preservation';
    reasonCode: string;
    policyReferenceSha256: string;
    idempotencyKey: string;
  }): Promise<{ holdId: string; messageId: string; holdType: 'legal' | 'incident_preservation'; active: true }>;
  releaseMessagePreservationHold(input: {
    organizationId: string;
    holdId: string;
    releaseReasonCode: string;
    idempotencyKey: string;
  }): Promise<{ holdId: string; messageId: string; active: false; releasedAt: string }>;
  setMessageReaction(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    emoji: string;
    active: boolean;
    idempotencyKey: string;
  }): Promise<void>;
  setMessagePin(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    pinned: boolean;
    idempotencyKey: string;
  }): Promise<void>;
  reportMessage(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    category: ReportCategory;
    details?: string | null;
    consentToShare: true;
    contextBefore: 0 | 1 | 2;
    contextAfter: 0 | 1 | 2;
    noticeVersion: 'moderation-report-v2';
    idempotencyKey: string;
  }): Promise<PrivateReportReceipt>;
  reportGroup(input: {
    organizationId: string;
    conversationId: string;
    category: ReportCategory;
    details?: string | null;
    consentToShare: true;
    noticeVersion: 'moderation-report-v2';
    idempotencyKey: string;
  }): Promise<PrivateReportReceipt>;
  reportMember(input: {
    organizationId: string;
    membershipId: string;
    category: ReportCategory;
    details?: string | null;
    consentToShare: true;
    noticeVersion: 'moderation-report-v2';
    idempotencyKey: string;
  }): Promise<PrivateReportReceipt>;
  createAttachmentUploadGrant(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    sha256Hex: string;
    idempotencyKey: string;
  }): Promise<AttachmentUploadGrant>;
  completeAttachmentUpload(input: {
    organizationId: string;
    attachmentId: string;
    bucket: 'message-attachments';
    path: string;
    byteSize: number;
    sha256Hex: string;
    idempotencyKey: string;
  }): Promise<{ attachmentId: string; scanStatus: 'pending'; scanJobId: string }>;
  getAttachmentState(input: {
    organizationId: string;
    attachmentId: string;
    idempotencyKey: string;
  }): Promise<AttachmentScanState>;
  createAttachmentDownloadGrant(input: {
    organizationId: string;
    conversationId: string;
    attachmentId: string;
    idempotencyKey: string;
  }): Promise<AttachmentDownloadGrant>;
  publishUpdate(input: {
    organizationId: string;
    conversationId: string;
    clientMessageId: string;
    title: string;
    body: string;
    languageCode: LanguageCode;
    priority: 'normal' | 'important' | 'emergency';
    requiresAcknowledgement: boolean;
    expiresAt?: string | null;
    scheduledAt?: string | null;
    acknowledgementSchema?: UpdateAcknowledgementSchema | null;
    notificationClass: NotificationClass;
    criticalCategory?: 'safety' | 'security' | 'operations' | 'weather' | 'business_continuity' | null;
    quietHoursOverrideReason?: string | null;
    reminderPolicy?: UpdateReminderPolicy | null;
    audienceSpec: UpdateAudienceSpec;
    idempotencyKey: string;
  }): Promise<{
    announcementId: string;
    versionId: string;
    messageId?: string;
    status?: 'scheduled' | 'published';
    scheduledAt?: string | null;
    audienceCount?: number;
  }>;
  previewUpdateAudience(input: {
    organizationId: string;
    conversationId: string;
    audienceSpec: UpdateAudienceSpec;
    idempotencyKey: string;
  }): Promise<UpdateAudiencePreview>;
  cancelScheduledUpdate(input: {
    organizationId: string;
    announcementId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<void>;
  acknowledgeUpdate(input: {
    organizationId: string;
    versionId: string;
    deviceId?: string | null;
    attestation?: Record<string, string | number | boolean>;
    idempotencyKey: string;
  }): Promise<UpdateAcknowledgementReceipt | void>;
  markUpdateRead(input: {
    organizationId: string;
    announcementId: string;
    idempotencyKey: string;
  }): Promise<{ announcementId: string; readAt: string; deliveredAt: string }>;
  correctUpdate(input: {
    organizationId: string;
    announcementId: string;
    clientMessageId: string;
    title: string;
    body: string;
    priority: 'normal' | 'important' | 'emergency';
    requiresAcknowledgement: boolean;
    expiresAt?: string | null;
    reason: string;
    idempotencyKey: string;
  }): Promise<{
    announcementId: string;
    versionId: string;
    versionNumber: number;
    messageId: string;
  }>;
  listManagedUpdates(input: {
    organizationId: string;
    limit?: number;
  }): Promise<{ updates: ManagedUpdate[]; generatedAt: string; smsFallbackAvailable: false }>;
  listUpdateNonAcknowledgers(input: {
    organizationId: string;
    announcementId: string;
    afterUserId?: string | null;
    limit?: number;
  }): Promise<UpdateNonAcknowledgerPage>;
  createHandoff(input: {
    organizationId: string;
    conversationId: string;
    title: string;
    details: string;
    sourceLanguage: LanguageCode;
    shiftStartedAt: string;
    shiftEndedAt: string;
    sourceMessageIds: string[];
    acknowledgementDueAt?: string | null;
    idempotencyKey: string;
  }): Promise<{ handoffId: string; versionId: string }>;
  correctHandoff(input: HandoffCorrectionInput): Promise<HandoffCorrectionReceipt>;
  signHandoff(input: {
    organizationId: string;
    versionId: string;
    idempotencyKey: string;
  }): Promise<void>;
  acknowledgeHandoff(input: {
    organizationId: string;
    versionId: string;
    note?: string | null;
    idempotencyKey: string;
  }): Promise<void>;
  proposeAction(input: {
    organizationId: string;
    conversationId: string;
    sourceMessageId: string;
    title: string;
    details?: string | null;
    idempotencyKey: string;
  }): Promise<{ actionId: string }>;
  confirmAction(input: {
    organizationId: string;
    actionId: string;
    assigneeMembershipId: string;
    dueAt?: string | null;
    idempotencyKey: string;
  }): Promise<void>;
  transitionAction(input: {
    organizationId: string;
    actionId: string;
    status: 'in_progress' | 'completed' | 'cancelled';
    note?: string | null;
    idempotencyKey: string;
  }): Promise<void>;
  requestConnection(input: {
    organizationId: string;
    targetMembershipId: string;
    idempotencyKey: string;
  }): Promise<void>;
  sendMessageRequest(input: {
    organizationId: string;
    targetUserId: string;
    body: string;
    idempotencyKey: string;
  }): Promise<MessageRequestReceipt>;
  respondConnection(input: {
    organizationId: string;
    membershipId: string;
    decision: 'accepted' | 'declined';
    idempotencyKey: string;
  }): Promise<void>;
  removeConnection(input: {
    organizationId: string;
    membershipId: string;
    idempotencyKey: string;
  }): Promise<void>;
  saveContact(input: {
    organizationId: string;
    membershipId: string;
    alias?: string | null;
    isFavorite?: boolean;
    idempotencyKey: string;
  }): Promise<{ alias: string | null; isFavorite: boolean }>;
  removeSavedContact(input: {
    organizationId: string;
    membershipId: string;
    idempotencyKey: string;
  }): Promise<void>;
  setPersonBlocked(input: {
    organizationId: string;
    membershipId: string;
    blocked: boolean;
    idempotencyKey: string;
  }): Promise<void>;
  queryRoleAssignments(input: {
    organizationId: string;
    targetMembershipId: string;
    limit?: number;
    idempotencyKey: string;
  }): Promise<AdminRoleAssignment[]>;
  assignAdminRole(input: {
    organizationId: string;
    targetMembershipId: string;
    roleName: AdminRoleName;
    scopeType: 'organization' | 'unit';
    unitId: string | null;
    expiresAt: string | null;
    reason: string;
    idempotencyKey: string;
  }): Promise<AdminRoleAssignment>;
  revokeAdminRole(input: {
    organizationId: string;
    assignmentId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<void>;
  issueInvitation(input: {
    organizationId: string;
    destinationType: 'email' | 'phone';
    destination: string;
    employeeCode?: string | null;
    activationMode: 'otp' | 'manual';
    role: 'admin' | 'manager' | 'member';
    expiresInSeconds: number;
    membershipType: 'employee' | 'contractor' | 'guest';
    membershipAccessExpiresAt: string | null;
    guestSponsorUserId: string | null;
    idempotencyKey: string;
  }): Promise<IssuedInvitation>;
  revokeSession(input: {
    organizationId: string;
    sessionId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<void>;
  loadOrganizationPreferences(input: {
    organizationId: string;
    idempotencyKey: string;
  }): Promise<OrganizationPreferences>;
  updateOrganizationPreferences(input: {
    organizationId: string;
    patch: Partial<OrganizationPreferences>;
    idempotencyKey: string;
  }): Promise<OrganizationPreferences>;
  listSessions(input: {
    organizationId: string;
    idempotencyKey: string;
  }): Promise<AccountSession[]>;
  suspendMember(input: {
    organizationId: string;
    membershipId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<void>;
  getDeviceNotificationPreferences(input: {
    organizationId: string;
    installationId: string;
  }): Promise<DeviceNotificationPreferences>;
  updateDeviceNotificationPreferences(input: {
    organizationId: string;
    installationId: string;
    expectedVersion: number;
    patch: DeviceNotificationPreferencePatch;
    idempotencyKey: string;
  }): Promise<DeviceNotificationPreferences>;
  registerDevice(input: RegisterDeviceInput): Promise<void>;
}

export interface RepositoryContext {
  getSession: () => Promise<Session | null>;
}

export class RepositoryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly correlationId?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

export function isOfflineError(error: unknown) {
  return error instanceof RepositoryError && error.code === 'network_unavailable';
}
