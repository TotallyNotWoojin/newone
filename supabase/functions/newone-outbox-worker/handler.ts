import {
  type ClientEnvironment,
  createAdminClient,
  loadClientEnvironment,
} from '../_shared/clients.ts';
import { safeEqual } from '../_shared/crypto.ts';
import { unprotectPushToken } from '../_shared/device-secrets.ts';
import { ApiError, asApiError, fromDatabaseError } from '../_shared/errors.ts';
import {
  ExpoPushClient,
  type ExpoPushMessage,
  expoPushToken,
  type ExpoSubmissionResult,
} from '../_shared/expo-push.ts';
import {
  buildRequestMeta,
  ensureSecureTransport,
  errorResponse,
  jsonResponse,
  loadRuntimeConfig,
  parseJson,
  requestId,
  type RequestMeta,
  type RuntimeConfig,
} from '../_shared/http.ts';
import { asRpcClient, invokeRpc, invokeVoidRpc } from '../_shared/rpc.ts';
import {
  asObject,
  bool,
  integer,
  normalizedString,
  oneOf,
  onlyKeys,
  uuid,
} from '../_shared/validation.ts';

export const OUTBOX_TOPICS = [
  'push',
  'realtime_control',
  'moderation',
  'storage_purge',
  'session_revoke',
  'dynamic_group_sync',
] as const;
export type OutboxTopic = typeof OUTBOX_TOPICS[number];

interface BaseJob {
  id: string;
  organizationId: string;
  attempts: number;
}

/**
 * Content-free inbox invalidations forwarded from private.outbox_jobs. The
 * (entity_type, reason) vocabulary mirrors
 * private.workspace_invalidation_reason_allowed in the database; both sides
 * fail closed on anything else. entity_id is the counterpart user for
 * contact and block hints, the row id otherwise, and never carries content.
 */
export const INVALIDATION_REASONS = Object.freeze({
  moderation_case: ['case_available', 'case_assigned', 'case_reassigned', 'case_status_changed'],
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
  // Delete-for-everyone and edits (bff_delete_message_impl / bff_edit_message_impl).
  message: ['message_deleted', 'message_edited', 'language_detected'],
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
} as const);
export type InvalidationEntityType = keyof typeof INVALIDATION_REASONS;
export type InvalidationReason = typeof INVALIDATION_REASONS[InvalidationEntityType][number];

// Entities whose entity_id names a user (a counterpart in a pair, or the
// profile owner). Their ids must be UUIDs and never the addressed user.
const USER_ENTITY_TYPES: ReadonlySet<InvalidationEntityType> = new Set([
  'contact_connection',
  'member_block',
  'profile',
]);
const UUID_ENTITY_TYPES: ReadonlySet<InvalidationEntityType> = new Set([
  'moderation_case',
  'attachment',
  'summary',
  'conversation',
  'conversation_preference',
]);
const ROW_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

export interface RealtimeControlJob extends BaseJob {
  topic: 'realtime_control';
  payload:
    | {
      event: 'membership.revoked';
      controlTopic: string;
      organizationId: string;
      userId: string;
      revocationGeneration: number;
    }
    | {
      event: 'workspace.invalidated';
      controlTopic: string;
      organizationId: string;
      userId: string;
      schemaVersion: 1;
      eventId: string;
      occurredAt: string;
      entityType: InvalidationEntityType;
      entityId: string;
      conversationId?: string;
      reason: InvalidationReason;
    };
}

export interface ModerationFanoutJob extends BaseJob {
  topic: 'moderation';
  payload: {
    schemaVersion: 1;
    caseId: string;
    state: 'open' | 'assigned' | 'in_review' | 'resolved' | 'dismissed';
    reason: 'case_available' | 'case_assigned' | 'case_reassigned' | 'case_status_changed';
    version: number;
  };
}

export interface StoragePurgeJob extends BaseJob {
  topic: 'storage_purge';
  payload: { attachmentId: string };
}

export interface SessionRevokeJob extends BaseJob {
  topic: 'session_revoke';
}

export interface DynamicGroupSyncJob extends BaseJob {
  topic: 'dynamic_group_sync';
  payload: {
    policyId: string;
    conversationId: string;
    policyVersion: number;
    addedCount: number;
    removedCount: number;
  };
}

export interface PushJob extends BaseJob {
  topic: 'push';
}

export type OutboxJob =
  | PushJob
  | RealtimeControlJob
  | ModerationFanoutJob
  | StoragePurgeJob
  | SessionRevokeJob
  | DynamicGroupSyncJob;

export interface PushEvent {
  eventType:
    | 'message.changed'
    | 'announcement.changed'
    | 'handoff.changed'
    | 'conversation.changed';
  organizationId: string;
  conversationId?: string;
  messageId?: string;
  announcementId?: string;
  announcementVersionId?: string;
  handoffId?: string;
  state?:
    | 'submitted'
    | 'published'
    | 'corrected'
    | 'acknowledgement_reminder'
    | 'acknowledgement_escalated'
    | 'closed';
}

export interface PushDelivery {
  attemptId: string;
  deviceId: string;
  userId: string;
  installationId: string;
  platform: 'ios' | 'android' | 'web';
  pushTokenType: 'expo';
  pushProjectId: string;
  pushEnvironment: 'development' | 'preview' | 'production';
  protectedToken: string;
  locale: string | null;
  currentlyOffShift: boolean | null;
  notificationClass: 'routine' | 'urgent' | 'critical';
  criticalCategory:
    | 'safety'
    | 'security'
    | 'operations'
    | 'weather'
    | 'business_continuity'
    | null;
  quietHoursOverride: boolean;
  overrideReason: string | null;
  /**
   * Message text for the recipient (translated to their message language when a
   * fresh translation exists, otherwise the original). Present only for message
   * events; null for announcements/handoffs.
   */
  contentTitle: string | null;
  contentBody: string | null;
  /** The recipient reads another language and its translation is still queued. */
  translationPending: boolean;
  /** The member muted this registration in Settings: settle as skipped, never submit. */
  notificationsMuted: boolean;
  preferences: {
    notificationPreview: 'generic' | 'hidden' | 'content';
    soundEnabled: boolean;
    vibrationEnabled: boolean;
    shiftAwareSuppression: boolean;
    timeZone: string;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    quietDays: number[];
  };
}

interface PushPage {
  event: PushEvent;
  deliveries: PushDelivery[];
  hasMore: boolean;
  nextDeviceId: string | null;
}

interface RealtimeFanoutDelivery {
  topic: string;
  event: 'workspace.invalidated';
  payload: Record<string, unknown>;
}

export interface OutboxWorkerDependencies {
  runtimeConfig: RuntimeConfig;
  clientEnvironment: ClientEnvironment;
  workerToken: string;
  topics: OutboxTopic[];
  setCorrelationId?(correlationId: string): void;
  claim(workerId: string, topics: OutboxTopic[], limit: number): Promise<unknown>;
  dispatchPush(workerId: string, job: PushJob, correlationId: string): Promise<void>;
  dispatchRealtime(job: RealtimeControlJob, correlationId: string): Promise<void>;
  expandModeration(workerId: string, job: ModerationFanoutJob): Promise<void>;
  purgeStorage(job: StoragePurgeJob): Promise<void>;
  executeSessionRevoke(workerId: string, job: SessionRevokeJob): Promise<void>;
  dispatchDynamicGroup(job: DynamicGroupSyncJob, correlationId: string): Promise<void>;
  complete(workerId: string, job: OutboxJob): Promise<void>;
  fail(
    workerId: string,
    job: OutboxJob,
    errorCode: string,
    retrySeconds: number,
  ): Promise<void>;
}

function requiredSecret(name: string, minimum: number): string {
  const value = Deno.env.get(name)?.trim() ?? '';
  if (value.length < minimum) throw new Error(`${name} is not configured`);
  return value;
}

function configuredTopics(): OutboxTopic[] {
  const raw = requiredSecret('NEWONE_OUTBOX_TOPICS', 1);
  const topics = raw.split(',').map((value) => value.trim()).filter(Boolean).map((value) =>
    oneOf(value, OUTBOX_TOPICS)
  );
  if (topics.length === 0 || new Set(topics).size !== topics.length) {
    throw new Error('NEWONE_OUTBOX_TOPICS must contain unique supported topics');
  }
  return topics;
}

function positiveBigint(value: unknown): string {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^[1-9][0-9]{0,18}$/.test(text)) throw new ApiError(503, 'dependency_unavailable');
  return text;
}

function validateRealtimePayload(
  organizationId: string,
  raw: Record<string, unknown>,
): RealtimeControlJob['payload'] {
  const payloadOrganizationId = uuid(raw.organization_id);
  const userId = uuid(raw.user_id);
  const controlTopic = normalizedString(raw.control_topic, { min: 1, max: 160 }) as string;
  if (payloadOrganizationId !== organizationId) {
    throw new ApiError(503, 'dependency_unavailable');
  }
  if (raw.event === 'membership.revoked') {
    // The membership trigger also stamps event_id, occurred_at, and
    // schema_version; a job carrying them sat in 'processing' for three days
    // and failed every batch it was claimed with (hosted, Sep 4 2026).
    onlyKeys(raw, [
      'event',
      'control_topic',
      'organization_id',
      'user_id',
      'revocation_generation',
      'event_id',
      'occurred_at',
      'schema_version',
    ]);
    if (raw.event_id !== undefined) uuid(raw.event_id);
    if (raw.occurred_at !== undefined) {
      const occurredAt = normalizedString(raw.occurred_at, { min: 20, max: 64 }) as string;
      if (Number.isNaN(Date.parse(occurredAt))) throw new ApiError(503, 'dependency_unavailable');
    }
    if (raw.schema_version !== undefined && raw.schema_version !== 1) {
      throw new ApiError(503, 'dependency_unavailable');
    }
    if (controlTopic !== `org:${organizationId}:user:${userId}:control`) {
      throw new ApiError(503, 'dependency_unavailable');
    }
    return {
      event: 'membership.revoked',
      controlTopic,
      organizationId,
      userId,
      revocationGeneration: integer(raw.revocation_generation, 1, 2_147_483_647),
    };
  }
  // Every other realtime_control job is a content-free inbox invalidation
  // addressed to exactly one member. The optional conversation id lets the
  // client scope its refetch; nothing else may ride along.
  onlyKeys(raw, [
    'schema_version',
    'event_id',
    'event',
    'control_topic',
    'organization_id',
    'occurred_at',
    'user_id',
    'entity_type',
    'entity_id',
    'conversation_id',
    'reason',
  ]);
  const entityType = oneOf(
    raw.entity_type,
    Object.keys(INVALIDATION_REASONS) as InvalidationEntityType[],
  );
  const reason = oneOf(raw.reason, INVALIDATION_REASONS[entityType]);
  const occurredAt = normalizedString(raw.occurred_at, { min: 20, max: 64 }) as string;
  let entityId: string;
  if (USER_ENTITY_TYPES.has(entityType)) {
    entityId = uuid(raw.entity_id);
    // A contact or block hint names the counterpart; a profile hint names
    // its owner, which may be the addressed user's own other devices.
    if (entityType !== 'profile' && entityId === userId) {
      throw new ApiError(503, 'dependency_unavailable');
    }
  } else if (UUID_ENTITY_TYPES.has(entityType)) {
    entityId = uuid(raw.entity_id);
  } else {
    entityId = normalizedString(raw.entity_id, { min: 1, max: 40 }) as string;
    if (!ROW_ID_PATTERN.test(entityId)) throw new ApiError(503, 'dependency_unavailable');
  }
  if (
    raw.event !== 'workspace.invalidated' || raw.schema_version !== 1 ||
    Number.isNaN(Date.parse(occurredAt)) ||
    controlTopic !== `org:${organizationId}:user:${userId}:inbox`
  ) throw new ApiError(503, 'dependency_unavailable');
  return {
    event: 'workspace.invalidated',
    controlTopic,
    organizationId,
    userId,
    schemaVersion: 1,
    eventId: uuid(raw.event_id),
    occurredAt,
    entityType,
    entityId,
    ...(raw.conversation_id === undefined ? {} : { conversationId: uuid(raw.conversation_id) }),
    reason,
  };
}

function validateStoragePayload(raw: Record<string, unknown>): StoragePurgeJob['payload'] {
  onlyKeys(raw, ['attachment_id', 'bucket_id', 'storage_path', 'reason']);
  if (raw.bucket_id !== undefined && raw.bucket_id !== 'message-attachments') {
    throw new ApiError(503, 'dependency_unavailable');
  }
  if (raw.storage_path !== undefined) {
    const path = normalizedString(raw.storage_path, { min: 1, max: 1024, trim: false }) as string;
    if (path.includes('..') || path.startsWith('/')) {
      throw new ApiError(503, 'dependency_unavailable');
    }
  }
  if (raw.reason !== undefined) {
    normalizedString(raw.reason, { min: 1, max: 120 });
  }
  return { attachmentId: uuid(raw.attachment_id) };
}

function validateModerationPayload(
  raw: Record<string, unknown>,
): ModerationFanoutJob['payload'] {
  onlyKeys(raw, ['schema_version', 'case_id', 'state', 'reason', 'version']);
  if (raw.schema_version !== 1) throw new ApiError(503, 'dependency_unavailable');
  return {
    schemaVersion: 1,
    caseId: uuid(raw.case_id),
    state: oneOf(
      raw.state,
      ['open', 'assigned', 'in_review', 'resolved', 'dismissed'] as const,
    ),
    reason: oneOf(
      raw.reason,
      ['case_available', 'case_assigned', 'case_reassigned', 'case_status_changed'] as const,
    ),
    version: integer(raw.version, 1, 2_147_483_647),
  };
}

function validateSessionPayload(organizationId: string, raw: Record<string, unknown>): void {
  onlyKeys(raw, ['session_id', 'user_id', 'organization_id', 'revocation_generation']);
  // Two shapes: a targeted revoke names the session (the revoke route also
  // records the session's owner), a membership revoke names the user with
  // the organization and generation. The old rule rejected the targeted
  // shape whenever user_id rode along, so no device revoke ever ran
  // (hosted, Sep 4 2026).
  if (raw.session_id !== undefined) {
    uuid(raw.session_id);
    if (raw.user_id !== undefined) uuid(raw.user_id);
    if (raw.organization_id !== undefined || raw.revocation_generation !== undefined) {
      throw new ApiError(503, 'dependency_unavailable');
    }
    return;
  }
  if (raw.user_id === undefined) throw new ApiError(503, 'dependency_unavailable');
  uuid(raw.user_id);
  if (uuid(raw.organization_id) !== organizationId) {
    throw new ApiError(503, 'dependency_unavailable');
  }
  integer(raw.revocation_generation, 1, 2_147_483_647);
}

function validateDynamicPayload(raw: Record<string, unknown>): DynamicGroupSyncJob['payload'] {
  onlyKeys(raw, [
    'policy_id',
    'conversation_id',
    'policy_version',
    'added_count',
    'removed_count',
  ]);
  return {
    policyId: uuid(raw.policy_id),
    conversationId: uuid(raw.conversation_id),
    policyVersion: integer(raw.policy_version, 1, 2_147_483_647),
    addedCount: integer(raw.added_count, 0, 1_000_000),
    removedCount: integer(raw.removed_count, 0, 1_000_000),
  };
}

function validatePushPayload(organizationId: string, raw: Record<string, unknown>): void {
  onlyKeys(raw, [
    'organization_id',
    'conversation_id',
    'message_id',
    'announcement_id',
    'announcement_version_id',
    'handoff_id',
    'handoff_version_id',
    'state',
    'notification_class',
    'critical_category',
    'quiet_hours_override_reason',
    'target_user_id',
    'reminder_number',
    'scheduler_worker_id',
    'source_state',
  ]);
  if (raw.organization_id !== undefined && uuid(raw.organization_id) !== organizationId) {
    throw new ApiError(503, 'dependency_unavailable');
  }
  if (raw.conversation_id !== undefined) uuid(raw.conversation_id);
  if (raw.message_id !== undefined) positiveBigint(raw.message_id);
  if (raw.announcement_id !== undefined) uuid(raw.announcement_id);
  if (raw.announcement_version_id !== undefined) uuid(raw.announcement_version_id);
  if (raw.handoff_id !== undefined) uuid(raw.handoff_id);
  if (raw.handoff_version_id !== undefined) uuid(raw.handoff_version_id);
  if (raw.state !== undefined) {
    oneOf(
      raw.state,
      [
        'submitted',
        'published',
        'corrected',
        'acknowledgement_reminder',
        'acknowledgement_escalated',
        'closed',
      ] as const,
    );
  }
  if (raw.notification_class !== undefined) {
    oneOf(raw.notification_class, ['routine', 'urgent', 'critical'] as const);
  }
  if (raw.critical_category !== undefined && raw.critical_category !== null) {
    oneOf(
      raw.critical_category,
      [
        'safety',
        'security',
        'operations',
        'weather',
        'business_continuity',
      ] as const,
    );
  }
  if (
    raw.quiet_hours_override_reason !== undefined &&
    raw.quiet_hours_override_reason !== null
  ) {
    normalizedString(raw.quiet_hours_override_reason, { min: 3, max: 500 });
  }
  if (raw.target_user_id !== undefined) uuid(raw.target_user_id);
  if (raw.reminder_number !== undefined) integer(raw.reminder_number, 1, 1000);
  if (raw.scheduler_worker_id !== undefined) uuid(raw.scheduler_worker_id);
  if (raw.source_state !== undefined) oneOf(raw.source_state, ['current', 'stale'] as const);
  if (
    raw.message_id === undefined && raw.announcement_id === undefined &&
    raw.handoff_id === undefined && raw.conversation_id === undefined
  ) throw new ApiError(503, 'dependency_unavailable');
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' || value.length < 10 || value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  ) throw new ApiError(503, 'dependency_unavailable');
  return value;
}

function optionalEventUuid(row: Record<string, unknown>, key: string): string | undefined {
  return row[key] === undefined ? undefined : uuid(row[key]);
}

function pushEvent(value: unknown, expectedOrganizationId: string): PushEvent {
  const row = asObject(value);
  onlyKeys(row, [
    'event_type',
    'organization_id',
    'conversation_id',
    'message_id',
    'announcement_id',
    'announcement_version_id',
    'handoff_id',
    'state',
  ]);
  const eventType = oneOf(
    row.event_type,
    [
      'message.changed',
      'announcement.changed',
      'handoff.changed',
      'conversation.changed',
    ] as const,
  );
  const organizationId = uuid(row.organization_id);
  if (organizationId !== expectedOrganizationId) {
    throw new ApiError(503, 'dependency_unavailable');
  }
  const result: PushEvent = {
    eventType,
    organizationId,
    ...(optionalEventUuid(row, 'conversation_id')
      ? { conversationId: optionalEventUuid(row, 'conversation_id') }
      : {}),
    ...(row.message_id === undefined ? {} : { messageId: positiveBigint(row.message_id) }),
    ...(optionalEventUuid(row, 'announcement_id')
      ? { announcementId: optionalEventUuid(row, 'announcement_id') }
      : {}),
    ...(optionalEventUuid(row, 'announcement_version_id')
      ? { announcementVersionId: optionalEventUuid(row, 'announcement_version_id') }
      : {}),
    ...(optionalEventUuid(row, 'handoff_id')
      ? { handoffId: optionalEventUuid(row, 'handoff_id') }
      : {}),
    ...(row.state === undefined ? {} : {
      state: oneOf(
        row.state,
        [
          'submitted',
          'published',
          'corrected',
          'acknowledgement_reminder',
          'acknowledgement_escalated',
          'closed',
        ] as const,
      ),
    }),
  };
  if (
    (eventType === 'message.changed' && !result.messageId) ||
    (eventType === 'announcement.changed' && !result.announcementId) ||
    (eventType === 'handoff.changed' && !result.handoffId) ||
    (eventType === 'conversation.changed' && !result.conversationId)
  ) throw new ApiError(503, 'dependency_unavailable');
  return result;
}

function quietClock(value: unknown): string | null {
  if (value === null) return null;
  const time = normalizedString(value, { min: 5, max: 15 }) as string;
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]{1,6})?)?$/.test(time)) {
    throw new ApiError(503, 'dependency_unavailable');
  }
  return time;
}

function pushDelivery(value: unknown): PushDelivery {
  const row = asObject(value);
  onlyKeys(row, [
    'device_id',
    'attempt_id',
    'dispatch_status',
    'dispatchable',
    'next_attempt_at',
    'user_id',
    'installation_id',
    'platform',
    'push_token_type',
    'push_project_id',
    'push_environment',
    'push_token_ciphertext',
    'locale',
    'app_version',
    'currently_off_shift',
    'notification_class',
    'critical_category',
    'quiet_hours_override',
    'quiet_hours_override_reason',
    'preferences',
    'content_title',
    'content_body',
    'translation_pending',
    'notifications_muted',
  ]);
  oneOf(row.dispatch_status, ['pending', 'retry_wait'] as const);
  if (row.dispatchable !== true) throw new ApiError(503, 'dependency_unavailable');
  optionalTimestamp(row.next_attempt_at);
  if (row.app_version !== null) normalizedString(row.app_version, { max: 80 });
  const preferences = asObject(row.preferences);
  onlyKeys(preferences, [
    'notification_preview',
    'sound_enabled',
    'vibration_enabled',
    'shift_aware_suppression',
    'time_zone',
    'quiet_hours_start',
    'quiet_hours_end',
    'quiet_days',
  ]);
  if (!Array.isArray(preferences.quiet_days) || preferences.quiet_days.length > 7) {
    throw new ApiError(503, 'dependency_unavailable');
  }
  const quietDays = preferences.quiet_days.map((day) => integer(day, 0, 6));
  if (new Set(quietDays).size !== quietDays.length) {
    throw new ApiError(503, 'dependency_unavailable');
  }
  const quietHoursStart = quietClock(preferences.quiet_hours_start);
  const quietHoursEnd = quietClock(preferences.quiet_hours_end);
  if ((quietHoursStart === null) !== (quietHoursEnd === null)) {
    throw new ApiError(503, 'dependency_unavailable');
  }
  const notificationClass = oneOf(
    row.notification_class,
    ['routine', 'urgent', 'critical'] as const,
  );
  const criticalCategory = row.critical_category === null ? null : oneOf(
    row.critical_category,
    [
      'safety',
      'security',
      'operations',
      'weather',
      'business_continuity',
    ] as const,
  );
  const quietHoursOverride = bool(row.quiet_hours_override);
  const overrideReason = row.quiet_hours_override_reason === null
    ? null
    : normalizedString(row.quiet_hours_override_reason, { min: 3, max: 500 }) as string;
  if (
    (notificationClass === 'routine' && (
      criticalCategory !== null || quietHoursOverride || overrideReason !== null
    )) ||
    (quietHoursOverride && (criticalCategory === null || overrideReason === null))
  ) throw new ApiError(503, 'dependency_unavailable');
  return {
    attemptId: positiveBigint(row.attempt_id),
    deviceId: uuid(row.device_id),
    userId: uuid(row.user_id),
    installationId: uuid(row.installation_id),
    platform: oneOf(row.platform, ['ios', 'android', 'web'] as const),
    pushTokenType: oneOf(row.push_token_type, ['expo'] as const),
    pushProjectId: uuid(row.push_project_id),
    pushEnvironment: oneOf(
      row.push_environment,
      ['development', 'preview', 'production'] as const,
    ),
    protectedToken: normalizedString(row.push_token_ciphertext, {
      min: 40,
      max: 4096,
      trim: false,
    }) as string,
    locale: row.locale === null
      ? null
      : normalizedString(row.locale, { min: 2, max: 35 }) as string,
    currentlyOffShift: row.currently_off_shift === null || row.currently_off_shift === undefined
      ? null
      : bool(row.currently_off_shift),
    notificationClass,
    criticalCategory,
    quietHoursOverride,
    overrideReason,
    contentTitle: row.content_title === null || row.content_title === undefined
      ? null
      : normalizedString(row.content_title, { min: 1, max: 200 }) as string,
    contentBody: row.content_body === null || row.content_body === undefined
      ? null
      : normalizedString(row.content_body, { min: 1, max: 4000, trim: false }) as string,
    translationPending: row.translation_pending === true,
    notificationsMuted: row.notifications_muted === true,
    preferences: {
      notificationPreview: oneOf(
        preferences.notification_preview,
        ['generic', 'hidden', 'content'] as const,
      ),
      soundEnabled: bool(preferences.sound_enabled),
      vibrationEnabled: bool(preferences.vibration_enabled),
      shiftAwareSuppression: bool(preferences.shift_aware_suppression),
      timeZone: normalizedString(preferences.time_zone, { min: 1, max: 100 }) as string,
      quietHoursStart,
      quietHoursEnd,
      quietDays,
    },
  };
}

export function parsePushPage(value: unknown, job: PushJob): PushPage {
  try {
    const row = asObject(value);
    onlyKeys(row, ['job_id', 'event', 'deliveries', 'has_more', 'next_device_id']);
    if (positiveBigint(row.job_id) !== job.id || !Array.isArray(row.deliveries)) {
      throw new Error('invalid');
    }
    if (row.deliveries.length > 500) throw new Error('invalid');
    const hasMore = bool(row.has_more);
    const nextDeviceId = row.next_device_id === null ? null : uuid(row.next_device_id);
    if (hasMore !== (nextDeviceId !== null)) throw new Error('invalid');
    return {
      event: pushEvent(row.event, job.organizationId),
      deliveries: row.deliveries.map(pushDelivery),
      hasMore,
      nextDeviceId,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) throw error;
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
}

export interface InvalidOutboxJob {
  id: string;
  topic: OutboxTopic;
  attempts: number;
}

export interface ClaimedOutboxJobs {
  jobs: OutboxJob[];
  invalid: InvalidOutboxJob[];
}

/**
 * Splits a claim envelope into dispatchable jobs and jobs whose payload does
 * not validate. A row that cannot even be identified (no id, unknown topic)
 * still fails the whole claim, because nothing can be done with it.
 *
 * Until Sep 4 2026 one invalid payload threw for the entire batch: every job
 * claimed alongside it stayed 'processing' until its lease expired, and the
 * oldest invalid rows were claimed first every time, so real invalidations
 * and pushes waited five minutes per attempt behind them (hosted: 20 rows,
 * up to 537 attempts, 26 worker 503s per hour).
 */
export function parseClaimedJobs(
  value: unknown,
  allowedTopics: OutboxTopic[],
  limit: number,
): ClaimedOutboxJobs {
  const invalid: InvalidOutboxJob[] = [];
  const jobs: OutboxJob[] = [];
  try {
    const envelope = asObject(value);
    if (!Array.isArray(envelope.jobs) || envelope.jobs.length > limit) throw new Error('invalid');
    if (!Array.isArray(envelope.topics)) throw new Error('invalid');
    const returnedTopics = envelope.topics.map((topic) => oneOf(topic, OUTBOX_TOPICS)).sort();
    const expectedTopics = [...allowedTopics].sort();
    if (JSON.stringify(returnedTopics) !== JSON.stringify(expectedTopics)) {
      throw new Error('invalid');
    }
    for (const entry of envelope.jobs) {
      const row = asObject(entry);
      onlyKeys(row, ['id', 'organization_id', 'topic', 'payload', 'attempts']);
      const topic = oneOf(row.topic, OUTBOX_TOPICS);
      if (!allowedTopics.includes(topic)) throw new Error('invalid');
      const base = {
        id: positiveBigint(row.id),
        organizationId: uuid(row.organization_id),
        attempts: integer(row.attempts, 1, 1000),
      };
      try {
        jobs.push(parseJobPayload(topic, base, asObject(row.payload)));
      } catch {
        invalid.push({ id: base.id, topic, attempts: base.attempts });
      }
    }
    return { jobs, invalid };
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) throw error;
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

export function parseOutboxJobs(
  value: unknown,
  allowedTopics: OutboxTopic[],
  limit: number,
): OutboxJob[] {
  const claimed = parseClaimedJobs(value, allowedTopics, limit);
  if (claimed.invalid.length > 0) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  return claimed.jobs;
}

function parseJobPayload(
  topic: OutboxTopic,
  base: { id: string; organizationId: string; attempts: number },
  payload: Record<string, unknown>,
): OutboxJob {
  {
    {
      switch (topic) {
        case 'realtime_control':
          return {
            ...base,
            topic,
            payload: validateRealtimePayload(base.organizationId, payload),
          };
        case 'moderation':
          return { ...base, topic, payload: validateModerationPayload(payload) };
        case 'storage_purge':
          return { ...base, topic, payload: validateStoragePayload(payload) };
        case 'session_revoke':
          validateSessionPayload(base.organizationId, payload);
          return { ...base, topic };
        case 'dynamic_group_sync':
          return { ...base, topic, payload: validateDynamicPayload(payload) };
        case 'push':
          validatePushPayload(base.organizationId, payload);
          return { ...base, topic };
      }
    }
  }
}

export async function realtimeBroadcast(
  environment: ClientEnvironment,
  topic: string,
  event: string,
  payload: unknown,
  correlationId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const endpoint = new URL(
    `/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/${encodeURIComponent(event)}`,
    environment.url,
  );
  endpoint.searchParams.set('private', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'apikey': environment.secretKey,
        'Content-Type': 'application/json',
        'X-Request-Id': correlationId,
      },
      body: JSON.stringify({ payload }),
    });
    if (!response.ok) throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseRealtimeFanout(
  value: unknown,
  organizationId: string,
  conversationId: string,
): RealtimeFanoutDelivery[] {
  try {
    const envelope = asObject(value);
    onlyKeys(envelope, ['schema_version', 'deliveries']);
    if (
      envelope.schema_version !== 1 || !Array.isArray(envelope.deliveries) ||
      envelope.deliveries.length > 10_000
    ) throw new Error('invalid');
    return envelope.deliveries.map((entry) => {
      const delivery = asObject(entry);
      onlyKeys(delivery, ['topic', 'event', 'payload']);
      const topic = normalizedString(delivery.topic, { min: 1, max: 160 }) as string;
      const match = /^org:([0-9a-f-]{36}):user:([0-9a-f-]{36}):inbox$/i.exec(topic);
      if (!match?.[1] || !match[2] || uuid(match[1]) !== organizationId) {
        throw new Error('invalid');
      }
      uuid(match[2]);
      if (delivery.event !== 'workspace.invalidated') throw new Error('invalid');
      const payload = asObject(delivery.payload);
      onlyKeys(payload, [
        'schema_version',
        'event_id',
        'event',
        'organization_id',
        'occurred_at',
        'conversation_id',
        'entity_type',
        'entity_id',
        'version_id',
        'reason',
      ]);
      if (
        payload.schema_version !== 1 || payload.event !== 'workspace.invalidated' ||
        uuid(payload.event_id) === '' || uuid(payload.organization_id) !== organizationId ||
        uuid(payload.conversation_id) !== conversationId ||
        payload.entity_type !== 'conversation' || uuid(payload.entity_id) !== conversationId
      ) throw new Error('invalid');
      const occurredAt = normalizedString(payload.occurred_at, { min: 20, max: 40 }) as string;
      if (!Number.isFinite(Date.parse(occurredAt))) throw new Error('invalid');
      if (payload.version_id !== undefined) {
        normalizedString(payload.version_id, { min: 1, max: 160 });
      }
      if (payload.reason !== undefined) {
        normalizedString(payload.reason, { min: 1, max: 120 });
      }
      return { topic, event: 'workspace.invalidated', payload };
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) throw error;
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
}

function timeMinutes(value: string): number {
  const [hour, minute] = value.split(':');
  return Number(hour) * 60 + Number(minute);
}

function inQuietHours(delivery: PushDelivery, now = new Date()): boolean {
  const preferences = delivery.preferences;
  if (!preferences.quietHoursStart || !preferences.quietHoursEnd) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: preferences.timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
    const day = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const)[
      part('weekday') as keyof typeof weekdayMap
    ];
    const hour = Number(part('hour'));
    const minute = Number(part('minute'));
    if (day === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) return true;
    const current = hour * 60 + minute;
    const start = timeMinutes(preferences.quietHoursStart);
    const end = timeMinutes(preferences.quietHoursEnd);
    if (start === end) return preferences.quietDays.includes(day);
    if (start < end) {
      return preferences.quietDays.includes(day) && current >= start && current < end;
    }
    if (current >= start) return preferences.quietDays.includes(day);
    const previousDay = (day + 6) % 7;
    return current < end && preferences.quietDays.includes(previousDay);
  } catch {
    // Unknown time zones fail silent rather than bypassing notification policy.
    return true;
  }
}

export function notificationSuppressed(
  delivery: PushDelivery,
  _event: PushEvent,
  now = new Date(),
): boolean {
  // Only a server-resolved urgent/critical class with a bounded reason may
  // override quiet policy. No client-provided message priority reaches this
  // contract. Unknown shift state is never interpreted as off-shift.
  if (
    delivery.quietHoursOverride && delivery.notificationClass !== 'routine' &&
    delivery.overrideReason !== null
  ) return false;
  if (delivery.preferences.shiftAwareSuppression && delivery.currentlyOffShift === true) {
    return true;
  }
  return inQuietHours(delivery, now);
}

const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;

// Content-free push copy for every supported product language. English is a
// first-class entry, not an implicit fallthrough; it also remains the
// deliberate fallback for unknown, unsupported, or missing locales.
const GENERIC_NOTIFICATION_COPY = {
  en: { title: 'Newone', body: 'Open Newone to view new activity.' },
  es: { title: 'Newone', body: 'Abre Newone para ver la actividad.' },
  ko: { title: 'Newone', body: '새 활동을 확인하려면 Newone을 여세요.' },
} as const;

export function genericNotification(locale: string | null): { title: string; body: string } {
  const language = locale?.toLowerCase().split('-')[0];
  if (language === 'en' || language === 'es' || language === 'ko') {
    return GENERIC_NOTIFICATION_COPY[language];
  }
  return GENERIC_NOTIFICATION_COPY.en;
}

export function providerPushData(
  event: PushEvent,
  delivery: PushDelivery,
): Record<string, unknown> {
  return {
    event_type: event.eventType,
    organization_id: event.organizationId,
    ...(event.conversationId ? { conversation_id: event.conversationId } : {}),
    ...(event.messageId ? { message_id: event.messageId } : {}),
    ...(event.announcementId ? { announcement_id: event.announcementId } : {}),
    ...(event.announcementVersionId
      ? { announcement_version_id: event.announcementVersionId }
      : {}),
    ...(event.handoffId ? { handoff_id: event.handoffId } : {}),
    ...(event.state ? { state: event.state } : {}),
    notification_preview: delivery.preferences.notificationPreview,
    notification_class: delivery.notificationClass,
  };
}

export const MUTED_DELIVERY_ERROR_CODE = 'notifications_muted';

/**
 * The settled result for a delivery whose registration is muted. It is
 * recorded as a permanent outcome so the attempt is never retried and the job
 * completes like any other.
 */
export function mutedSubmissionResult(delivery: PushDelivery): ExpoSubmissionResult {
  return {
    attemptId: delivery.attemptId,
    result: 'permanent_failure',
    providerTicketId: null,
    errorCode: MUTED_DELIVERY_ERROR_CODE,
  };
}

async function expoMessage(
  job: PushJob,
  event: PushEvent,
  delivery: PushDelivery,
  expectedProjectId: string,
  expectedEnvironment: 'development' | 'preview' | 'production',
): Promise<ExpoPushMessage | ExpoSubmissionResult> {
  if (delivery.platform === 'web') {
    return {
      attemptId: delivery.attemptId,
      result: 'permanent_failure',
      providerTicketId: null,
      errorCode: 'unsupported_web_push',
    };
  }
  if (
    delivery.pushTokenType !== 'expo' || delivery.pushProjectId !== expectedProjectId ||
    delivery.pushEnvironment !== expectedEnvironment
  ) {
    return {
      attemptId: delivery.attemptId,
      result: 'permanent_failure',
      providerTicketId: null,
      errorCode: 'push_configuration_mismatch',
    };
  }
  let token: string;
  try {
    token = expoPushToken(
      await unprotectPushToken(delivery.protectedToken, {
        organizationId: job.organizationId,
        userId: delivery.userId,
        installationId: delivery.installationId,
      }),
    );
  } catch {
    return {
      attemptId: delivery.attemptId,
      result: 'permanent_failure',
      providerTicketId: null,
      errorCode: 'invalid_expo_push_token',
    };
  }
  const silent = notificationSuppressed(delivery, event) ||
    delivery.preferences.notificationPreview === 'hidden';
  // Consumer recipients see the message itself (in their language when the
  // translation is ready); other modes keep the content-free copy.
  const visible = delivery.preferences.notificationPreview === 'content' && delivery.contentBody
    ? { title: delivery.contentTitle ?? 'Newone', body: delivery.contentBody.slice(0, 240) }
    : genericNotification(delivery.locale);
  return {
    attemptId: delivery.attemptId,
    to: token,
    data: providerPushData(event, delivery),
    ...(silent ? {} : visible),
    ...(!silent && delivery.preferences.soundEnabled ? { sound: 'default' as const } : {}),
    channelId: !silent && delivery.preferences.soundEnabled &&
        delivery.preferences.vibrationEnabled
      ? 'newone-default'
      : 'newone-silent',
    priority: silent ? 'normal' : 'high',
    contentAvailable: true,
  };
}

async function recordSubmission(
  admin: ReturnType<typeof createAdminClient>,
  workerId: string,
  job: PushJob,
  result: ExpoSubmissionResult,
): Promise<void> {
  const recorded = asObject(
    await invokeRpc(asRpcClient(admin), 'bff_record_push_submission', {
      p_worker_id: workerId,
      p_job_id: job.id,
      p_attempt_id: result.attemptId,
      p_result: result.result,
      p_provider_ticket_id: result.providerTicketId,
      p_error_code: result.errorCode,
    }),
  );
  if (positiveBigint(recorded.attempt_id) !== result.attemptId) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  normalizedString(recorded.status, { min: 1, max: 40 });
}

export function defaultOutboxWorkerDependencies(): OutboxWorkerDependencies {
  const runtimeConfig = loadRuntimeConfig();
  const clientEnvironment = loadClientEnvironment();
  const workerToken = requiredSecret('NEWONE_WORKER_TOKEN', 32);
  const topics = configuredTopics();
  let admin = createAdminClient(clientEnvironment);
  const expo = topics.includes('push')
    ? new ExpoPushClient(requiredSecret('NEWONE_EXPO_ACCESS_TOKEN', 20))
    : null;
  const pushProjectId = topics.includes('push')
    ? uuid(requiredSecret('NEWONE_EXPO_PROJECT_ID', 36))
    : null;
  const pushEnvironment = topics.includes('push')
    ? oneOf(
      requiredSecret('NEWONE_PUSH_ENVIRONMENT', 1),
      ['development', 'preview', 'production'] as const,
    )
    : null;
  return {
    runtimeConfig,
    clientEnvironment,
    workerToken,
    topics,
    setCorrelationId(correlationId) {
      admin = createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId });
    },
    claim(workerId, requestedTopics, limit) {
      return invokeRpc(asRpcClient(admin), 'bff_claim_outbox_topics', {
        p_worker_id: workerId,
        p_topics: requestedTopics,
        p_limit: limit,
        p_lease_seconds: 300,
      });
    },
    async dispatchPush(workerId, job) {
      if (!expo || !pushProjectId || !pushEnvironment) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 60);
      }
      let afterDeviceId: string | null = null;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = parsePushPage(
          await invokeRpc(asRpcClient(admin), 'bff_resolve_push_job', {
            p_worker_id: workerId,
            p_job_id: job.id,
            p_after_device_id: afterDeviceId,
            p_limit: 500,
          }),
          job,
        );
        const messages: ExpoPushMessage[] = [];
        const localResults: ExpoSubmissionResult[] = [];
        // A recipient whose translation is still queued keeps their attempt
        // unrecorded; everyone else is sent now, and the job retries shortly so
        // the held deliveries are re-resolved with the translation (the SQL
        // stops holding after 25 seconds and falls back to the original text).
        let heldForTranslation = 0;
        for (const delivery of page.deliveries) {
          // A registration muted in Settings is settled as skipped: no
          // provider submission, no retry, and no translation hold.
          if (delivery.notificationsMuted) {
            localResults.push(mutedSubmissionResult(delivery));
            continue;
          }
          if (
            delivery.translationPending &&
            delivery.preferences.notificationPreview === 'content'
          ) {
            heldForTranslation += 1;
            continue;
          }
          const message = await expoMessage(
            job,
            page.event,
            delivery,
            pushProjectId,
            pushEnvironment,
          );
          if ('result' in message) localResults.push(message);
          else messages.push(message);
        }
        for (let offset = 0; offset < messages.length; offset += 100) {
          const results = await expo.submit(messages.slice(offset, offset + 100));
          for (const result of results) await recordSubmission(admin, workerId, job, result);
        }
        for (const result of localResults) {
          await recordSubmission(admin, workerId, job, result);
        }
        if (heldForTranslation > 0) {
          throw new ApiError(503, 'translation_pending', undefined, 5);
        }
        if (!page.hasMore) {
          const completed = asObject(
            await invokeRpc(asRpcClient(admin), 'bff_complete_push_dispatch_job', {
              p_worker_id: workerId,
              p_job_id: job.id,
            }),
          );
          if (
            positiveBigint(completed.job_id) !== job.id ||
            completed.dispatch_completed !== true
          ) throw new ApiError(503, 'dependency_unavailable', undefined, 30);
          integer(completed.provider_delivery_pending, 0, 1_000_000);
          return;
        }
        afterDeviceId = page.nextDeviceId;
      }
      throw new ApiError(503, 'dependency_unavailable', undefined, 60);
    },
    async dispatchRealtime(job, correlationId) {
      const payload = job.payload.event === 'membership.revoked'
        ? {
          event: job.payload.event,
          control_topic: job.payload.controlTopic,
          organization_id: job.payload.organizationId,
          user_id: job.payload.userId,
          revocation_generation: job.payload.revocationGeneration,
        }
        : {
          schemaVersion: job.payload.schemaVersion,
          eventId: job.payload.eventId,
          event: job.payload.event,
          organizationId: job.payload.organizationId,
          occurredAt: job.payload.occurredAt,
          entityType: job.payload.entityType,
          entityId: job.payload.entityId,
          reason: job.payload.reason,
          ...(job.payload.conversationId ? { conversationId: job.payload.conversationId } : {}),
        };
      await realtimeBroadcast(
        clientEnvironment,
        job.payload.controlTopic,
        job.payload.event,
        payload,
        correlationId,
      );
    },
    async expandModeration(workerId, job) {
      const expanded = asObject(
        await invokeRpc(asRpcClient(admin), 'bff_expand_moderation_fanout', {
          p_worker_id: workerId,
          p_job_id: job.id,
        }),
      );
      onlyKeys(expanded, [
        'job_id',
        'eligible_count',
        'enqueued_count',
        'current_authorization_applied',
        'replay_safe',
      ]);
      const eligibleCount = integer(expanded.eligible_count, 0, 2_147_483_647);
      const enqueuedCount = integer(expanded.enqueued_count, 0, 2_147_483_647);
      if (
        positiveBigint(expanded.job_id) !== job.id || enqueuedCount > eligibleCount ||
        expanded.current_authorization_applied !== true || expanded.replay_safe !== true
      ) throw new ApiError(503, 'dependency_unavailable', undefined, 30);
    },
    async purgeStorage(job) {
      const { data, error } = await admin.from('message_attachments')
        .select('bucket_id,storage_path,scan_status,purge_requested_at')
        .eq('organization_id', job.organizationId)
        .eq('id', job.payload.attachmentId)
        .maybeSingle();
      if (error) throw fromDatabaseError(error);
      if (
        !data || data.bucket_id !== 'message-attachments' ||
        data.scan_status !== 'quarantined' || typeof data.purge_requested_at !== 'string' ||
        typeof data.storage_path !== 'string' || data.storage_path.includes('..')
      ) throw new ApiError(409, 'conflict', undefined, 60);
      const { error: removeError } = await admin.storage.from('message-attachments')
        .remove([data.storage_path]);
      if (removeError) throw new ApiError(503, 'dependency_unavailable', undefined, 60);
    },
    async executeSessionRevoke(workerId, job) {
      const result = asObject(
        await invokeRpc(asRpcClient(admin), 'bff_execute_session_revoke_job', {
          p_worker_id: workerId,
          p_job_id: job.id,
        }),
      );
      if (result.completed !== true || positiveBigint(result.job_id) !== job.id) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 30);
      }
      integer(result.revoked_session_count, 0, 10_000);
    },
    async dispatchDynamicGroup(job, correlationId) {
      const fanout = parseRealtimeFanout(
        await invokeRpc(asRpcClient(admin), 'bff_resolve_realtime_fanout', {
          p_organization_id: job.organizationId,
          p_conversation_id: job.payload.conversationId,
          p_event: 'workspace.invalidated',
          p_entity_type: 'conversation',
          p_entity_id: job.payload.conversationId,
          p_version_id: String(job.payload.policyVersion),
          p_reason: 'dynamic_group_membership_changed',
        }),
        job.organizationId,
        job.payload.conversationId,
      );
      for (const delivery of fanout) {
        await realtimeBroadcast(
          clientEnvironment,
          delivery.topic,
          delivery.event,
          delivery.payload,
          correlationId,
        );
      }
    },
    async complete(workerId, job) {
      await invokeVoidRpc(asRpcClient(admin), 'bff_complete_outbox_job', {
        p_worker_id: workerId,
        p_job_id: job.id,
      });
    },
    async fail(workerId, job, errorCode, retrySeconds) {
      await invokeVoidRpc(asRpcClient(admin), 'bff_fail_outbox_job', {
        p_worker_id: workerId,
        p_job_id: job.id,
        p_error_code: errorCode,
        p_retry_seconds: retrySeconds,
      });
    },
  };
}

function fallbackMeta(request: Request): RequestMeta {
  return { requestId: requestId(request), origin: null, corsHeaders: new Headers() };
}

function authenticateWorker(
  request: Request,
  expectedWorkerToken: string,
  expectedServerKey: string,
): void {
  const apiKey = request.headers.get('apikey') ?? '';
  const workerToken = request.headers.get('x-newone-worker-token') ?? '';
  if (
    request.headers.has('authorization') || !safeEqual(apiKey, expectedServerKey) ||
    !safeEqual(workerToken, expectedWorkerToken)
  ) throw new ApiError(401, 'unauthorized');
  if (request.headers.has('cookie') || request.headers.has('origin')) {
    throw new ApiError(403, 'forbidden');
  }
}

async function processJob(
  dependencies: OutboxWorkerDependencies,
  workerId: string,
  correlationId: string,
  job: OutboxJob,
): Promise<'completed' | 'failed'> {
  try {
    let completedAtomically = false;
    switch (job.topic) {
      case 'push':
        await dependencies.dispatchPush(workerId, job, correlationId);
        completedAtomically = true;
        break;
      case 'realtime_control':
        await dependencies.dispatchRealtime(job, correlationId);
        break;
      case 'moderation':
        await dependencies.expandModeration(workerId, job);
        break;
      case 'storage_purge':
        await dependencies.purgeStorage(job);
        break;
      case 'session_revoke':
        await dependencies.executeSessionRevoke(workerId, job);
        completedAtomically = true;
        break;
      case 'dynamic_group_sync':
        await dependencies.dispatchDynamicGroup(job, correlationId);
        break;
    }
    if (!completedAtomically) await dependencies.complete(workerId, job);
    return 'completed';
  } catch (error) {
    const safe = asApiError(error);
    const retrySeconds = Math.max(
      5,
      Math.min(3600, safe.retryAfterSeconds ?? Math.min(3600, 15 * 2 ** job.attempts)),
    );
    try {
      await dependencies.fail(workerId, job, safe.code.slice(0, 80), retrySeconds);
    } catch {
      // The lease will expire and make the job retryable; never report success.
    }
    console.error(JSON.stringify({
      event: 'newone_outbox_dispatch_failed',
      correlation_id: correlationId,
      job_id: job.id,
      topic: job.topic,
      code: safe.code,
    }));
    return 'failed';
  }
}

export function createOutboxWorkerHandler(
  dependencyFactory: () => OutboxWorkerDependencies = defaultOutboxWorkerDependencies,
): (request: Request) => Promise<Response> {
  let dependencies: OutboxWorkerDependencies | undefined;
  return async (request: Request): Promise<Response> => {
    let meta = fallbackMeta(request);
    try {
      dependencies ??= dependencyFactory();
      ensureSecureTransport(request, dependencies.runtimeConfig);
      meta = buildRequestMeta(request, dependencies.runtimeConfig);
      dependencies.setCorrelationId?.(meta.requestId);
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
      authenticateWorker(
        request,
        dependencies.workerToken,
        dependencies.clientEnvironment.secretKey,
      );
      const body = asObject((await parseJson(request, dependencies.runtimeConfig)).value);
      onlyKeys(body, ['limit']);
      const limit = body.limit === undefined ? 3 : integer(body.limit, 1, 10);
      const workerId = crypto.randomUUID();
      const claimed = parseClaimedJobs(
        await dependencies.claim(workerId, dependencies.topics, limit),
        dependencies.topics,
        limit,
      );
      const results: Array<'completed' | 'failed'> = [];
      for (const job of claimed.jobs) {
        results.push(await processJob(dependencies, workerId, meta.requestId, job));
      }
      for (const job of claimed.invalid) {
        // An unreadable payload is failed on its own row (dead-lettered by the
        // database after ten attempts) so it never holds a batch hostage.
        try {
          await dependencies.fail(workerId, job as unknown as OutboxJob, 'invalid_payload', 3600);
        } catch {
          // The lease expires on its own; never report success for it.
        }
        console.error(JSON.stringify({
          event: 'newone_outbox_job_invalid',
          correlation_id: meta.requestId,
          job_id: job.id,
          topic: job.topic,
          attempts: job.attempts,
        }));
        results.push('failed');
      }
      const completed = results.filter((result) => result === 'completed').length;
      return jsonResponse(meta, 200, {
        claimed: results.length,
        completed,
        failed: results.length - completed,
        topics: dependencies.topics,
      });
    } catch (error) {
      const safe = asApiError(error);
      if (safe.status >= 500) {
        console.error(JSON.stringify({
          event: 'newone_outbox_worker_failure',
          correlation_id: meta.requestId,
          code: safe.code,
        }));
      }
      return errorResponse(meta, error);
    }
  };
}
