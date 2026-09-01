export type LanguageCode = 'ko' | 'es' | 'en';

export type Presence = 'online' | 'away' | 'offline';

export type MemberRole = 'employee' | 'supervisor' | 'manager' | 'org_admin';

export type WorkspaceMembershipType = 'employee' | 'contractor' | 'guest';

export type WorkspaceCapability =
  | 'members.security'
  | 'sessions.revoke'
  | 'roles.manage'
  | 'roles.read'
  | 'audit.read'
  | 'message.preservation.manage'
  | 'ai.policy.manage'
  | 'directory.manage'
  | 'directory.read'
  | 'invites.manage'
  | 'communications.publish'
  | 'unit.manage'
  | 'conversation.manage'
  | 'language.review'
  | 'recovery.manage'
  | 'handoff.manage'
  | 'actions.confirm'
  | 'reports.investigate'
  | 'reports.assign';

export interface AuthorizationScope {
  assignmentId: string;
  roleName: AdminRoleName;
  scopeType: 'organization' | 'unit';
  unitId: string | null;
  permissions: WorkspaceCapability[];
  expiresAt: string | null;
}

export type ConversationKind =
  | 'direct'
  | 'group'
  | 'team'
  | 'announcement'
  | 'shift'
  | 'incident';

export type ConversationHistoryPolicy = 'all' | 'since_join';

export interface ConversationHistoryDisclosure {
  policy: ConversationHistoryPolicy;
  visibleFrom: string | null;
  labelKey: 'conversation.history.all' | 'conversation.history.since_join';
}

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

export type MessagePriority = 'normal' | 'important' | 'safety';

export type DeliveryState = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export type DetectedLanguage = LanguageCode | 'und' | 'mixed';

export type LanguageDetectionState =
  | 'pending'
  | 'completed'
  | 'ambiguous'
  | 'failed'
  | 'not_applicable';

export type MessageReceipt =
  | {
      scope: 'self';
      delivered: boolean;
      deliveredAt: string | null;
      read: boolean;
      readAt: string | null;
    }
  | {
      scope: 'aggregate';
      recipientCount: number;
      deliveredCount: number;
      visibleReadCount: number;
      visibleReadEligibleCount: number;
      delivered: boolean;
      deliveredAt: string | null;
      read: boolean;
      readAt: string | null;
    };

export type TranslationState =
  | 'not_requested'
  | 'queued'
  | 'translating'
  | 'translated'
  | 'corrected'
  | 'human_reviewed'
  | 'blocked'
  | 'needs_review'
  | 'failed';

export interface TranslationCorrection {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'changes_requested';
  correctedText: string;
  rationale: string | null;
  proposedByUserId: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageTranslation {
  id: string;
  sourceLanguage: DetectedLanguage;
  targetLanguage: LanguageCode;
  sourceBodySha256: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'blocked';
  translatedText: string | null;
  provider: string | null;
  model: string | null;
  confidence: number | null;
  policyVersion: number | null;
  policyState: 'current' | 'stale' | 'unknown';
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  correction: TranslationCorrection | null;
}

export interface MessageLanguageDetection {
  state: LanguageDetectionState;
  detectedLanguage: DetectedLanguage | null;
  confidence: number | null;
  method: string | null;
  detectedAt: string | null;
}

export type SearchResultType =
  | 'people'
  | 'conversations'
  | 'messages'
  | 'announcements'
  | 'handoffs';

export type SearchMessageMatchSource =
  | 'original'
  | 'translation'
  | 'sender'
  | 'attachment_filename';

export type SearchLanguageFilter = DetectedLanguage;

export type SearchMatchSource =
  | 'profile'
  | 'conversation'
  | SearchMessageMatchSource
  | 'announcement'
  | 'handoff';

export interface WorkspaceSearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  snippet: string;
  conversationId: string | null;
  occurredAt: string;
  matchedSource: SearchMatchSource;
  matchedLanguage: string | null;
}

export interface OrganizationPreferences {
  uiLanguage: LanguageCode;
  messageLanguage: LanguageCode | null;
  timeZone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietDays: number[];
  notificationPreview: 'generic' | 'hidden';
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  shiftAwareSuppression: boolean;
  readVisibility: 'everyone' | 'contacts' | 'nobody';
}

export interface AccountSession {
  sessionId: string;
  current: boolean;
  platform: 'ios' | 'android' | 'web' | null;
  device: { installationId: string; platform: 'ios' | 'android' | 'web'; appVersion: string | null } | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string | null;
  revoked: boolean;
  aal: 'aal1' | 'aal2';
  signal: { sameNetworkAsCurrent: boolean; clientFamily: 'iphone' | 'ipad' | 'android' | 'mobile' | 'desktop' | 'unknown' };
}

export type AdminRoleName =
  | 'security_admin'
  | 'people_admin'
  | 'communications_publisher'
  | 'site_admin'
  | 'language_reviewer'
  | 'supervisor'
  | 'employee'
  | 'designated_investigator';

export interface AdminRoleAssignment {
  assignmentId: string;
  userId: string;
  roleName: AdminRoleName;
  scopeType: 'organization' | 'unit';
  unitId: string | null;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
}

export interface Person {
  id: string;
  membershipId?: string;
  organizationId?: string;
  displayName: string;
  /** Consumer discovery handle; present only for personal-realm identities. */
  username?: string | null;
  initials: string;
  roleLabel: string;
  role: MemberRole;
  site: string;
  department: string;
  preferredLanguage: LanguageCode;
  presence: Presence;
  connectionState: 'self' | 'connected' | 'pending' | 'available';
  connectionRequestDirection?: 'incoming' | 'outgoing';
  savedContact?: boolean;
  contactAlias?: string | null;
  favoriteContact?: boolean;
  blockedByMe?: boolean;
  avatarColor: string;
  suspended?: boolean;
}

export interface CurrentWorkspaceUser extends Person {
  membershipType: WorkspaceMembershipType;
  accessExpiresAt: string | null;
  guestSponsorUserId: string | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  reactedByMe?: boolean;
}

export interface Attachment {
  id: string;
  kind: 'image' | 'document' | 'voice';
  name: string;
  sizeLabel?: string;
  status: 'quarantined' | 'scanning' | 'clean' | 'blocked';
  mimeType?: string;
  byteSize?: number;
  downloadUrl?: string;
  transfer?: {
    state: 'preparing' | 'uploading' | 'failed' | 'cancelled' | 'uploaded';
    progress: number;
    errorCode?: string;
  };
}

export interface Message {
  id: string;
  clientMessageId?: string;
  serverId?: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderInitials: string;
  senderColor: string;
  originalText: string;
  translatedText?: string;
  sourceLanguage: DetectedLanguage;
  targetLanguage?: LanguageCode;
  translationState: TranslationState;
  translation?: MessageTranslation;
  languageDetection?: MessageLanguageDetection;
  createdAt?: string;
  sentAt: string;
  dayLabel?: string;
  isOwn: boolean;
  deliveryState: DeliveryState;
  receipt?: MessageReceipt;
  failureReason?: string;
  priority: MessagePriority;
  mentionUserIds?: string[];
  edited?: boolean;
  deleted?: boolean;
  pinned?: boolean;
  forwarded?: boolean;
  forwardSource?: {
    conversationId: string;
    messageId: string;
  };
  replyTo?: {
    senderName: string;
    preview: string;
  };
  reactions?: Reaction[];
  attachment?: Attachment;
  systemEvent?: {
    eventType:
      | 'conversation.posting.admins_only'
      | 'conversation.posting.all_members'
      | 'conversation.join.approved'
      | 'conversation.created'
      | 'conversation.member.added'
      | 'conversation.member.removed'
      | 'conversation.member.role_changed'
      | 'conversation.avatar.changed'
      | 'conversation.avatar.removed';
    targetUserId: string | null;
  };
}

export interface Conversation {
  id: string;
  organizationId?: string;
  directParticipantId?: string;
  title: string;
  initials: string;
  avatarColor: string;
  avatarPath?: string | null;
  kind: ConversationKind;
  subtitle: string;
  participantCount?: number;
  lastMessage: string;
  lastActivity: string;
  unreadCount: number;
  lastReadMessageId?: string | null;
  pinned: boolean;
  favorite: boolean;
  muted: boolean;
  notificationLevel?: 'all' | 'mentions' | 'none';
  mutedUntil?: string | null;
  translationMode?: 'automatic' | 'off';
  presence?: Presence;
  activeNowLabel?: string;
  translationPair?: string;
  priority?: MessagePriority;
  description?: string;
  archived?: boolean;
  myRole?: 'owner' | 'admin' | 'member';
  canManage?: boolean;
  canManageConversation?: boolean;
  canManageDynamicGroup?: boolean;
  /** Membership is reconciled by a published dynamic-group policy, not manually. */
  policyManaged?: boolean;
  managementOnly?: boolean;
  memberIds?: string[];
  memberRoles?: Record<string, 'owner' | 'admin' | 'member'>;
  /** Selected management-shell roster identities. Never merge into the global directory. */
  memberProfiles?: ConversationMemberProfile[];
  departure?: {
    eligible: boolean;
    restriction:
      | 'direct_mandatory'
      | 'announcement_mandatory'
      | 'team_mandatory'
      | 'shift_mandatory'
      | 'incident_mandatory'
      | 'policy_managed'
      | 'audience_mandatory'
      | 'mandatory_audience'
      | null;
    requiresOwnershipTransfer: boolean;
    historyPreserved: true;
    futureAccessRevoked: true;
  };
  historyPolicy?: ConversationHistoryPolicy;
  historyDisclosure?: ConversationHistoryDisclosure;
  incidentSeverity?: IncidentSeverity;
  incidentClassification?: string;
  closedAt?: string;
  closedByUserId?: string;
  closureReason?: string;
  isReadOnly?: boolean;
  postingMode?: 'all_members' | 'admins_only';
  configuredJoinPolicy?: 'inherit' | 'invite_only' | 'approval_required';
  joinPolicy?: 'invite_only' | 'approval_required';
  visibility?: 'invite_only' | 'organization' | 'unit';
  canPost?: boolean;
}

export interface ConversationMemberProfile {
  id: string;
  displayName: string;
  initials: string;
  avatarColor: string;
  avatarPath: string | null;
  role: 'owner' | 'admin' | 'member';
  canPost: boolean;
}

export type ConversationJoinRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface ConversationJoinRequest {
  requestId: string;
  conversationId: string;
  requesterUserId: string;
  requesterDisplayName?: string;
  requesterAvatarPath?: string | null;
  status: ConversationJoinRequestStatus;
  version: number;
  requestedAt: string;
  expiresAt: string;
  decidedAt?: string | null;
}

export interface DiscoverableConversation {
  conversationId: string;
  kind: 'group' | 'team';
  name: string;
  description: string | null;
  avatarPath: string | null;
  visibility: 'organization' | 'unit';
  postingMode: 'all_members' | 'admins_only';
  joinPolicy: 'approval_required';
  memberCount: number;
  historyDisclosure: ConversationHistoryDisclosure;
  myJoinRequest: ConversationJoinRequest | null;
}

export type UpdateStatus = 'draft' | 'scheduled' | 'published' | 'cancelled';

export type NotificationClass = 'routine' | 'urgent' | 'critical';

export interface UpdateAcknowledgementSchema {
  schemaVersion: 1;
  attestationRequired: boolean;
  attestationPrompt: string | null;
  requiredKeys: string[];
  carryForwardOnCorrection: boolean;
}

export interface UpdateReminderPolicy {
  enabled: boolean;
  deadlineAt: string | null;
  intervalSeconds: number | null;
  maximumReminders: number;
  escalateAfterSeconds: number | null;
  smsFallback: false;
}

export interface CompanyUpdate {
  id: string;
  versionId: string;
  versionNumber: number;
  title: string;
  body: string;
  translatedBody?: string;
  author: string;
  audience: string;
  publishedAt: string;
  severity: 'standard' | 'important' | 'critical';
  acknowledgementRequired: boolean;
  acknowledged: boolean;
  acknowledgedCount: number;
  recipientCount: number;
  recipientCountKnown?: boolean;
  deadline?: string;
  status?: UpdateStatus;
  scheduledAt?: string;
  notificationClass?: NotificationClass;
  acknowledgementSchema?: UpdateAcknowledgementSchema | null;
  reminderPolicy?: UpdateReminderPolicy | null;
  reminderState?: 'not_applicable' | 'pending' | 'sent' | 'exhausted';
  escalationState?: 'not_applicable' | 'pending' | 'escalated';
  deliveredAt?: string | null;
  readAt?: string | null;
}

export interface ShiftHandoff {
  id: string;
  conversationId: string;
  versionId: string;
  versionNumber: number;
  sourceLanguage: LanguageCode;
  title: string;
  site: string;
  outgoingShift: string;
  incomingShift: string;
  window: string;
  status: 'draft' | 'awaiting_signoff' | 'ready' | 'acknowledged';
  summary: string;
  openItems: number;
  sourceCount: number;
  outgoingSupervisor: string;
  incomingSupervisor: string;
  shiftStartedAt: string;
  shiftEndedAt: string;
  authorId?: string;
  acknowledgedByMe?: boolean;
  canSign?: boolean;
  canAcknowledge?: boolean;
  sourceMessageIds: string[];
  sourceFingerprint?: string;
  sourceState?: 'current' | 'stale';
  sourceStaleAt?: string;
  sourceStaleReason?: 'source_edited_or_deleted';
  acknowledgementDueAt?: string;
  overdue?: boolean;
  reminderState?: 'not_due' | 'due' | 'sent' | 'exhausted';
  reminderCount?: number;
  lastRemindedAt?: string;
  escalationState?: 'not_due' | 'due' | 'escalated';
  escalatedAt?: string;
  smsFallbackAvailable?: false;
  correctionOfVersionId?: string;
  correctionReason?: string;
}

export interface SummaryActionItem {
  title: string;
  owner?: string | null;
  dueAt?: string | null;
  sourceMessageIds: string[];
}

export interface SummaryEvidenceItem {
  text: string;
  sourceMessageIds: string[];
}

export interface SummaryProvenance {
  processorType: 'ai' | 'manual' | null;
  provider: string | null;
  model: string | null;
  organizationAiPolicyVersion: number | null;
  routePolicyVersion: string | null;
  providerRoute: string | null;
}

export interface ConversationSummary {
  id: string;
  conversationId: string;
  versionNumber: number;
  language: LanguageCode;
  status: 'queued' | 'generating' | 'ready_for_review' | 'approved' | 'corrected' | 'failed' | 'superseded';
  primaryTopic: string;
  summary: string;
  keyTopics: SummaryEvidenceItem[];
  decisions: SummaryEvidenceItem[];
  actionItems: SummaryActionItem[];
  ambiguities: SummaryEvidenceItem[];
  sourceMessageIds: string[];
  sourceFirstMessageId: string;
  sourceLastMessageId: string;
  sourceFingerprint: string;
  outputFingerprint: string | null;
  sourceState: 'current' | 'stale';
  policyState: 'current' | 'stale' | 'not_applicable' | 'unknown';
  requestMode: 'manual' | 'automatic_message_count' | 'automatic_shift_close' | 'manual_fallback' | 'correction';
  requestedByUserId: string;
  correctionOfSummaryId: string | null;
  provenance: SummaryProvenance;
  failureCode: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  generatedAt: string;
}

export type AiOutputKind = 'translation' | 'summary';
export type TranslationErrorCategory =
  | 'incorrect_meaning'
  | 'omitted_context'
  | 'terminology'
  | 'unsafe_wording'
  | 'wrong_language'
  | 'other';
export type SummaryErrorCategory =
  | 'unsupported_claim'
  | 'missing_source'
  | 'incorrect_action'
  | 'omitted_context'
  | 'unsafe_wording'
  | 'other';
export type AiOutputErrorCategory = TranslationErrorCategory | SummaryErrorCategory;

export interface AiOutputErrorReport {
  reportId: string;
  outputKind: AiOutputKind;
  translationId: string | null;
  summaryId: string | null;
  conversationId: string;
  category: AiOutputErrorCategory;
  details: string;
  highConsequence: boolean;
  qualityUseConsent: boolean;
  consentVersion: string;
  targetSourceFingerprint: string;
  targetOutputFingerprint: string;
  targetLanguage: string;
  targetSnapshot: Record<string, unknown>;
  status: 'open' | 'reviewing' | 'resolved' | 'dismissed';
  outcome: 'confirmed_error' | 'not_an_error' | 'needs_context' | null;
  version: number;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiRegressionExample {
  exampleId: string;
  reportId: string;
  outputKind: AiOutputKind;
  sourceLanguage: string;
  targetLanguage: string;
  deidentifiedSourceText: string;
  deidentifiedObservedOutput: string;
  deidentifiedExpectedOutput: string;
  errorCategory: AiOutputErrorCategory;
  consequenceLevel: 'standard' | 'high_consequence';
  attestationVersion: string;
  proposedByUserId: string;
  proposedAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'exported';
  version: number;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  exportedAt: string | null;
}

export interface AiOutputErrorReportDetail {
  report: AiOutputErrorReport;
  regressionExample: AiRegressionExample | null;
}

export interface OperationalAction {
  id: string;
  conversationId: string;
  sourceMessageId: string | null;
  title: string;
  details: string | null;
  status: 'proposed' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
  proposedByUserId: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModerationReport {
  id: string;
  conversationId: string;
  messageId: string;
  category: 'harassment' | 'threat' | 'spam' | 'privacy' | 'misinformation' | 'other';
  status: 'open' | 'assigned' | 'in_review' | 'resolved' | 'dismissed';
  reportedAt: string;
  assignedToMe: boolean;
  reporterLabel: string;
  safeExcerpt: string | null;
}

export interface AuditEvent {
  id: string;
  operation: string;
  entityType: string;
  entityId: string | null;
  actorLabel: string;
  occurredAt: string;
  outcome: 'succeeded' | 'denied' | 'failed';
}

export type AuditAccessReason =
  | 'security_review'
  | 'compliance_review'
  | 'incident_investigation'
  | 'access_review';

export interface PrivilegedAuditEvent {
  id: string;
  actorUserId: string | null;
  eventType: string;
  targetType: string;
  targetId: string;
  requestId: string | null;
  occurredAt: string;
  outcome: 'succeeded' | 'denied' | 'failed';
}

export interface AuditExportReceipt {
  receiptId: string;
  format: 'json' | 'csv';
  contentType: 'application/json' | 'text/csv';
  fileName: string;
  rowCount: number;
  payloadBytes: number;
  sha256: string;
  createdAt: string;
  payload: string;
}

export type InboxFilter = 'all' | 'unread' | 'direct' | 'groups' | 'announcements' | 'favorites';

export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
export type ConnectivityState = 'online' | 'offline' | 'unknown';
