import { apiUrlFor, nativeEdgeRequestHeaders } from '@/config/runtime';
import type {
  AdminRoleName,
  AuditEvent,
  AuthorizationScope,
  CompanyUpdate,
  Conversation,
  ConversationKind,
  ConversationSummary,
  CurrentWorkspaceUser,
  DiscoverableConversation,
  LanguageCode,
  MemberRole,
  Message,
  ModerationReport,
  OperationalAction,
  Person,
  PrivilegedAuditEvent,
  ShiftHandoff,
} from '@/domain/types';
import { parseOfflineWorkspaceMembership } from '@/data/persistence/offline-workspace-entitlement.mjs';
import {
  activeMutedUntil,
  isConversationMuted,
  normalizeNotificationLevel,
} from '@/data/notification-preferences.mjs';
import type {
  AuditPage,
  MessagePage,
  OrganizationUnitOption,
  PinnedMessage,
  ReadRepository,
  RepositoryContext,
  SharedMediaItem,
  SharedMediaPage,
  UserSearchResult,
  WorkspaceSnapshot,
} from '@/data/repositories/contracts';
import { RepositoryError } from '@/data/repositories/contracts';
import { parseOrganizationPolicy } from '@/data/repositories/organization-policy-dto.mjs';
import { compareMessageIds } from '@/data/reconciliation/message-timeline.mjs';
import { parseMentionDto } from '@/features/chat/mention-controls.mjs';
import { usesCookieSession } from '@/lib/session-transport';
import { getWebCsrfToken } from '@/lib/web-auth';
import { parseWorkspaceCapabilities } from '@/data/repositories/capability-dto.mjs';
import { stripSummarySourceTokens } from '@/data/summary-text';
import { personDisplayName } from '@/domain/person-name';
import { isPersonalRealm } from '@/constants/personal-realm';
import { catalogs } from '@/i18n/catalog';

type JsonRecord = Record<string, unknown>;

const ADMIN_ROLES = new Set<AdminRoleName>([
  'security_admin',
  'people_admin',
  'communications_publisher',
  'site_admin',
  'language_reviewer',
  'supervisor',
  'employee',
  'designated_investigator',
]);

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function values(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalIdentifier(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function language(value: unknown): LanguageCode {
  const base = typeof value === 'string' ? value.toLocaleLowerCase().split('-')[0] : '';
  return base === 'ko' || base === 'es' ? base : 'en';
}

function supportedLanguage(value: unknown, label: string): LanguageCode {
  const base = typeof value === 'string' ? value.toLocaleLowerCase().split('-')[0] : '';
  if (base === 'en' || base === 'ko' || base === 'es') return base;
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

function detectedLanguage(value: unknown, label: string): NonNullable<Message['languageDetection']>['detectedLanguage'] {
  if (value === null) return null;
  const base = typeof value === 'string' ? value.toLocaleLowerCase().split('-')[0] : '';
  if (base === 'en' || base === 'ko' || base === 'es' || base === 'und' || base === 'mixed') {
    return base;
  }
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

function nullableDate(value: unknown, label: string): string | null {
  const text = nullableText(value, label);
  if (text !== null && Number.isNaN(Date.parse(text))) {
    throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
  }
  return text;
}

function requiredDate(value: unknown, label: string): string {
  const text = nullableDate(value, label);
  if (text === null) {
    throw new RepositoryError(`The service returned a missing ${label}.`, 'invalid_response', true);
  }
  return text;
}

function confidence(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

function membershipRole(value: unknown): MemberRole {
  if (value === 'owner' || value === 'admin') return 'org_admin';
  if (value === 'manager') return 'manager';
  return value === 'supervisor' ? 'supervisor' : 'employee';
}

function conversationKind(value: unknown): ConversationKind {
  return ['direct', 'group', 'team', 'announcement', 'shift', 'incident'].includes(String(value))
    ? value as ConversationKind
    : 'group';
}

function initials(displayName: string) {
  return displayName.trim().split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toLocaleUpperCase() || 'N';
}

function stableColor(id: string) {
  const palette = ['#496D62', '#6D5C8B', '#8B624F', '#3E698C', '#7C6A35', '#50677D'];
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length] as string;
}

function dateTimeLabel(value: unknown) {
  if (typeof value !== 'string') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  return new Intl.DateTimeFormat('en-US', date.toDateString() === now.toDateString()
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }).format(date);
}

function receiptDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new RepositoryError('The service returned an invalid message receipt date.', 'invalid_response', true);
  }
  return value;
}

function receiptCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RepositoryError('The service returned an invalid receipt aggregate.', 'invalid_response', true);
  }
  return value;
}

function messageReceipt(value: unknown, isOwn: boolean): NonNullable<Message['receipt']> {
  const receipt = objectValue(value);
  const scope = receipt.scope;
  if (scope !== 'self' && scope !== 'aggregate') {
    throw new RepositoryError('The service returned an unknown message receipt scope.', 'invalid_response', true);
  }
  if (isOwn && scope !== 'aggregate') {
    throw new RepositoryError('The service returned an invalid sender receipt scope.', 'invalid_response', true);
  }
  if (!isOwn && scope !== 'self') {
    throw new RepositoryError('The service returned an invalid recipient receipt scope.', 'invalid_response', true);
  }
  const deliveredAt = receiptDate(receipt.deliveredAt);
  const readAt = receiptDate(receipt.readAt);
  if (typeof receipt.delivered !== 'boolean' || typeof receipt.read !== 'boolean') {
    throw new RepositoryError('The service returned an incomplete message receipt.', 'invalid_response', true);
  }
  const delivered = receipt.delivered;
  const read = receipt.read;
  if (
    delivered !== (deliveredAt !== null)
    || read !== (readAt !== null)
    || (read && !delivered)
  ) {
    throw new RepositoryError('The service returned a non-monotonic message receipt.', 'invalid_response', true);
  }
  if (scope === 'self') return { scope, delivered, deliveredAt, read, readAt };
  if ('userId' in receipt || 'recipientId' in receipt || 'recipients' in receipt || 'details' in receipt) {
    throw new RepositoryError('The service exposed forbidden recipient receipt detail.', 'invalid_response', false);
  }
  const recipientCount = receiptCount(receipt.recipientCount);
  const deliveredCount = receiptCount(receipt.deliveredCount);
  const visibleReadCount = receiptCount(receipt.visibleReadCount);
  const visibleReadEligibleCount = receiptCount(receipt.visibleReadEligibleCount);
  if (
    delivered !== (deliveredCount > 0)
    || read !== (visibleReadCount > 0)
    || deliveredCount > recipientCount
    || visibleReadCount > visibleReadEligibleCount
    || visibleReadEligibleCount > recipientCount
  ) {
    throw new RepositoryError('The service returned invalid receipt aggregates.', 'invalid_response', true);
  }
  return {
    scope,
    recipientCount,
    deliveredCount,
    visibleReadCount,
    visibleReadEligibleCount,
    delivered,
    deliveredAt,
    read,
    readAt,
  };
}

function stringArray(value: unknown, limit = 500): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, limit)
    : [];
}

function parseScopes(value: unknown): AuthorizationScope[] {
  return values(value).flatMap((row) => {
    const roleName = row.roleName;
    const scopeType = row.scopeType;
    if (
      !ADMIN_ROLES.has(roleName as AdminRoleName)
      || (scopeType !== 'organization' && scopeType !== 'unit')
    ) return [];
    return [{
      assignmentId: requiredString(row.assignmentId, 'authorization scope'),
      roleName: roleName as AdminRoleName,
      scopeType,
      unitId: optionalString(row.unitId),
      permissions: parseWorkspaceCapabilities(row.permissions),
      expiresAt: optionalString(row.expiresAt),
    }];
  });
}

async function readRequest(
  context: RepositoryContext,
  path: `/${string}`,
  body: JsonRecord,
) {
  const url = apiUrlFor(path);
  const cookieSession = usesCookieSession();
  const csrfToken = cookieSession ? getWebCsrfToken() : null;
  const session = cookieSession ? null : await context.getSession();
  const edgeHeaders = nativeEdgeRequestHeaders(session?.access_token);
  if (
    !url
    || (cookieSession && !csrfToken)
    || (!cookieSession && (!session?.access_token || !edgeHeaders))
  ) {
    throw new RepositoryError('Your secure session needs to be restored.', 'authentication_required', false);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      credentials: cookieSession ? 'include' : 'omit',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        ...(edgeHeaders ?? {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RepositoryError('Newone cannot reach the workspace service.', 'network_unavailable', true);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Invalid upstream bodies are classified below without exposing them.
  }
  if (!response.ok) {
    const root = objectValue(payload);
    const problem = objectValue(root.error ?? root);
    throw new RepositoryError(
      'The workspace request was rejected.',
      typeof problem.code === 'string' ? problem.code : `http_${response.status}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
      typeof problem.correlationId === 'string' ? problem.correlationId : undefined,
      response.status,
    );
  }
  return objectValue(objectValue(payload).data ?? payload);
}

const USER_SEARCH_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_]{2,28}[a-z0-9]$/;
const USER_SEARCH_CONNECTION_STATES = new Set<UserSearchResult['connectionState']>([
  'none',
  'pending_outgoing',
  'pending_incoming',
  'accepted',
]);

function userSearchResultFromDto(row: JsonRecord): UserSearchResult {
  const userId = requiredString(row.userId, 'user search identity');
  const username = requiredString(row.username, 'user search username');
  const displayName = row.displayName == null
    ? null
    : requiredString(row.displayName, 'user search display name');
  const avatarPath = row.avatarPath == null
    ? null
    : requiredString(row.avatarPath, 'user search avatar');
  const connectionState = row.connectionState;
  if (
    !USER_SEARCH_UUID_PATTERN.test(userId)
    || !USERNAME_PATTERN.test(username)
    || (displayName !== null && displayName.length > 160)
    || (avatarPath !== null && avatarPath.length > 1024)
    || !USER_SEARCH_CONNECTION_STATES.has(connectionState as UserSearchResult['connectionState'])
  ) {
    throw new RepositoryError('The service returned an invalid user search result.', 'invalid_response', true);
  }
  return {
    userId: userId.toLowerCase(),
    username,
    displayName,
    avatarPath,
    connectionState: connectionState as UserSearchResult['connectionState'],
  };
}

/**
 * Stand-in for a person the client cannot name. The personal realm says
 * "Someone"; workspace organizations keep their member wording.
 */
function unknownPersonLabel(current: Person): string {
  return catalogs[current.preferredLanguage][
    isPersonalRealm(current.organizationId) ? 'chat.companyMemberConsumer' : 'chat.companyMember'
  ];
}

function personFromDirectory(
  row: JsonRecord,
  currentUserId: string,
  units: OrganizationUnitOption[],
  connections: JsonRecord[],
  savedContacts: JsonRecord[],
  blockedIds: Set<string>,
  personalRealm: boolean,
): Person {
  const userId = requiredString(row.userId, 'directory member');
  const displayName = requiredString(row.displayName, 'directory name');
  const memberUnitIds = new Set(stringArray(row.unitIds));
  const memberUnits = units.filter((unit) => memberUnitIds.has(unit.unitId));
  const connection = objectValue(row.connection ?? connections.find((item) => item.counterpartUserId === userId));
  const connectionStatus = connection.status;
  const saved = savedContacts.find((item) => item.contactUserId === userId);
  const state: Person['connectionState'] = userId === currentUserId
    ? 'self'
    : connectionStatus === 'accepted'
      ? 'connected'
      : connectionStatus === 'pending'
        ? 'pending'
        : 'available';
  return {
    id: userId,
    membershipId: userId,
    displayName,
    // The @handle is how people find and identify each other; the bootstrap
    // now carries it for the directory and the viewer.
    username: optionalString(row.username),
    initials: initials(displayName),
    // Consumers carry no job title, site, or department; the personal realm
    // leaves these blank instead of showing workplace placeholders.
    roleLabel: personalRealm ? '' : optionalString(row.jobTitle) ?? String(row.membershipRole ?? 'member'),
    role: membershipRole(row.membershipRole),
    site: personalRealm ? '' : memberUnits.find((unit) => unit.kind === 'site')?.name ?? 'Company-wide',
    department: personalRealm
      ? ''
      : memberUnits.find((unit) => unit.kind === 'department')?.name
        ?? memberUnits.find((unit) => unit.kind === 'team')?.name
        ?? 'General',
    preferredLanguage: language(row.preferredLanguage),
    presence: userId === currentUserId ? 'online' : 'offline',
    connectionState: state,
    connectionRequestDirection: state === 'pending'
      ? connection.requestedByUserId === currentUserId ? 'outgoing' : 'incoming'
      : undefined,
    savedContact: row.isSavedContact === true || Boolean(saved),
    contactAlias: optionalString(saved?.alias),
    favoriteContact: saved?.isFavorite === true,
    blockedByMe: row.isBlocked === true || blockedIds.has(userId),
    mutedByMe: row.isMuted === true,
    avatarColor: stableColor(userId),
    suspended: row.membershipStatus === 'suspended',
  };
}

function currentPerson(row: JsonRecord, units: OrganizationUnitOption[], personalRealm: boolean): Person {
  const person = personFromDirectory(
    { ...row, unitIds: row.unitIds ?? [], isSavedContact: false, isBlocked: false },
    requiredString(row.userId, 'current user'),
    units,
    [],
    [],
    new Set(),
    personalRealm,
  );
  // The bootstrap strips a null status, so only a present string is carried.
  const statusMessage = optionalString(row.statusMessage);
  return statusMessage === null ? person : { ...person, statusMessage };
}

function languageDetectionFromDto(message: JsonRecord): NonNullable<Message['languageDetection']> {
  const state = message.languageDetectionState;
  if (!['pending', 'completed', 'ambiguous', 'failed', 'not_applicable'].includes(String(state))) {
    throw new RepositoryError('The service returned an invalid language detection state.', 'invalid_response', true);
  }
  const detected = detectedLanguage(message.detectedLanguage ?? null, 'detected language');
  const method = nullableText(message.languageDetectionMethod ?? null, 'language detector provenance');
  const score = confidence(message.languageDetectionConfidence ?? null, 'language detector confidence');
  const detectedAt = nullableDate(message.languageDetectedAt ?? null, 'language detection time');
  const valid = state === 'pending'
    ? detected === null && method === null && score === null && detectedAt === null
    : state === 'completed'
      ? detected !== null && detected !== 'und' && detected !== 'mixed' && method !== null && detectedAt !== null
      : state === 'ambiguous'
        ? (detected === 'und' || detected === 'mixed') && method !== null && detectedAt !== null
        : state === 'failed'
          ? detected === null && method !== null && detectedAt !== null
          : detected === null && detectedAt !== null;
  if (!valid) {
    throw new RepositoryError('The service returned inconsistent language detection provenance.', 'invalid_response', true);
  }
  return {
    state: state as NonNullable<Message['languageDetection']>['state'],
    detectedLanguage: detected,
    confidence: score,
    method,
    detectedAt,
  };
}

function translationCorrectionFromDto(value: unknown): NonNullable<Message['translation']>['correction'] {
  if (value === null || value === undefined) return null;
  const row = objectValue(value);
  const status = row.status;
  if (!['pending', 'approved', 'rejected', 'changes_requested'].includes(String(status))) {
    throw new RepositoryError('The service returned an invalid translation correction.', 'invalid_response', true);
  }
  const proposedByUserId = row.proposedByUserId == null
    ? null
    : requiredString(row.proposedByUserId, 'translation correction proposer');
  const reviewedByUserId = row.reviewedByUserId == null
    ? null
    : requiredString(row.reviewedByUserId, 'translation correction reviewer');
  const reviewedAt = nullableDate(row.reviewedAt, 'translation correction review time');
  if (
    (reviewedByUserId === null) !== (reviewedAt === null)
    || (status === 'pending' && (proposedByUserId === null || reviewedByUserId !== null))
    || (status !== 'pending' && proposedByUserId !== null && reviewedByUserId === null)
  ) {
    throw new RepositoryError('The service returned inconsistent translation correction review state.', 'invalid_response', true);
  }
  return {
    id: requiredString(row.correctionId, 'translation correction'),
    status: status as 'pending' | 'approved' | 'rejected' | 'changes_requested',
    correctedText: requiredString(row.correctedBody, 'corrected translation'),
    rationale: nullableText(row.rationale, 'translation correction rationale'),
    proposedByUserId,
    reviewedByUserId,
    reviewedAt,
    reviewNote: nullableText(row.reviewNote, 'translation correction review note'),
    createdAt: requiredDate(row.createdAt, 'translation correction creation time'),
    updatedAt: requiredDate(row.updatedAt, 'translation correction update time'),
  };
}

function translationFromDto(value: unknown): NonNullable<Message['translation']> {
  const row = objectValue(value);
  const status = row.status;
  if (!['queued', 'processing', 'completed', 'failed', 'blocked'].includes(String(status))) {
    throw new RepositoryError('The service returned an invalid translation status.', 'invalid_response', true);
  }
  const sourceBodySha256 = requiredString(row.sourceBodySha256, 'translation source fingerprint');
  if (!/^[0-9a-f]{64}$/.test(sourceBodySha256)) {
    throw new RepositoryError('The service returned an invalid translation source fingerprint.', 'invalid_response', true);
  }
  const translatedText = nullableText(row.translatedBody, 'translated message');
  const provider = nullableText(row.provider, 'translation provider');
  const model = nullableText(row.model, 'translation model');
  const failureCode = nullableText(row.failureCode, 'translation failure code');
  const reviewedByUserId = row.reviewedByUserId == null
    ? null
    : requiredString(row.reviewedByUserId, 'translation reviewer');
  const reviewedAt = nullableDate(row.reviewedAt, 'translation review time');
  const policyVersion = row.policyVersion == null
    ? null
    : Number.isSafeInteger(row.policyVersion) && Number(row.policyVersion) > 0
      ? Number(row.policyVersion)
      : NaN;
  if (
    Number.isNaN(policyVersion)
    || ((reviewedByUserId === null) !== (reviewedAt === null))
    || (status === 'completed'
      ? translatedText === null || provider === null || model === null || failureCode !== null
      : translatedText !== null)
    || ((status === 'failed' || status === 'blocked') !== (failureCode !== null))
  ) {
    throw new RepositoryError('The service returned inconsistent translation provenance.', 'invalid_response', true);
  }
  return {
    id: requiredString(row.translationId, 'translation'),
    sourceLanguage: detectedLanguage(row.sourceLanguage, 'translation source language') ?? 'und',
    targetLanguage: supportedLanguage(row.targetLanguage, 'translation target language'),
    sourceBodySha256,
    status: status as NonNullable<Message['translation']>['status'],
    translatedText,
    provider,
    model,
    confidence: confidence(row.confidence, 'translation confidence'),
    policyVersion,
    // The read DTO intentionally exposes the processing policy version but not
    // the tenant's current policy. Do not infer freshness client-side.
    policyState: 'unknown',
    reviewedByUserId,
    reviewedAt,
    failureCode,
    createdAt: requiredDate(row.createdAt, 'translation creation time'),
    updatedAt: requiredDate(row.updatedAt, 'translation update time'),
    correction: translationCorrectionFromDto(row.latestCorrection),
  };
}

function parseTranslation(message: JsonRecord, targetLanguage: LanguageCode) {
  const translations = values(message.translations).map(translationFromDto);
  return translations.find((item) => item.targetLanguage === targetLanguage);
}

/**
 * On your own message, every language somebody else reads it in.
 *
 * This used to skip the row aimed at this phone's own reading language, on the
 * assumption that row was for the reader. It is not: a person whose "Translate
 * to" is Korean, writing English to somebody who reads Korean, was shown
 * nothing at all, because the only translation that existed was the one being
 * discarded (owner, Sep 9 2026). What has nothing to say is a row in the
 * language the message was already written in.
 *
 * The server sends every translation of a message you can see, so this is a
 * different pick from the same list, not an extra fetch.
 */
function parseOutgoingTranslations(message: JsonRecord, sourceLanguage: string | null) {
  return values(message.translations)
    .map(translationFromDto)
    .filter((item) => item.status === 'completed' && item.targetLanguage !== sourceLanguage)
    .sort((left, right) => left.targetLanguage.localeCompare(right.targetLanguage));
}

function attachmentFrom(value: unknown): Message['attachment'] {
  const attachment = objectValue(value);
  if (!Object.keys(attachment).length) return undefined;
  const mimeType = optionalString(attachment.mimeType) ?? 'application/octet-stream';
  const scan = String(attachment.scanStatus ?? 'pending');
  const status: NonNullable<Message['attachment']>['status'] = scan === 'clean'
    ? 'clean'
    : scan === 'failed' || scan === 'blocked' || scan === 'quarantined'
      ? 'blocked'
      : 'scanning';
  const byteSize = integer(attachment.byteSize, 0);
  return {
    id: requiredString(attachment.attachmentId ?? attachment.id, 'attachment'),
    kind: mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'voice' : 'document',
    name: optionalString(attachment.fileName) ?? 'Attachment',
    mimeType,
    byteSize,
    sizeLabel: byteSize < 1024
      ? `${byteSize} B`
      : byteSize < 1024 * 1024
        ? `${Math.ceil(byteSize / 1024)} KB`
        : `${(byteSize / (1024 * 1024)).toFixed(1)} MB`,
    status,
  };
}

const ATTACHMENT_KINDS = ['image', 'video', 'voice', 'file'] as const;

function attachmentKind(value: unknown): SharedMediaItem['kind'] | null {
  const kind = ATTACHMENT_KINDS.find((entry) => entry === value);
  return kind ?? null;
}

function pinnedMessageFromDto(row: JsonRecord): PinnedMessage {
  return {
    conversationId: requiredString(row.conversationId, 'pinned conversation'),
    messageId: requiredString(row.messageId, 'pinned message'),
    senderId: requiredString(row.senderUserId, 'pinned message sender'),
    senderName: optionalString(row.senderDisplayName) ?? '',
    text: optionalString(row.body) ?? '',
    attachmentKind: attachmentKind(row.attachmentKind),
    sentAt: requiredDate(row.sentAt, 'pinned message time'),
    pinnedAt: requiredDate(row.pinnedAt, 'pin time'),
    canUnpin: row.canUnpin === true,
  };
}

function sharedMediaItemFromDto(row: JsonRecord): SharedMediaItem {
  const mimeType = optionalString(row.mimeType) ?? 'application/octet-stream';
  return {
    attachmentId: requiredString(row.attachmentId, 'attachment'),
    messageId: requiredString(row.messageId, 'attachment message'),
    name: optionalString(row.fileName) ?? '',
    mimeType,
    byteSize: integer(row.byteSize, 0),
    kind: attachmentKind(row.kind) ?? 'file',
    createdAt: requiredDate(row.createdAt, 'attachment time'),
    senderId: requiredString(row.senderUserId, 'attachment sender'),
    senderName: optionalString(row.senderDisplayName) ?? '',
    // Only a signed https preview is ever shown; anything else is dropped so a
    // rogue payload cannot point the viewer somewhere unexpected.
    previewUrl: optionalString(row.previewUrl)?.startsWith('https://')
      ? optionalString(row.previewUrl)
      : null,
  };
}

/** The newest message's attachment, for the Chats row's preview line. */
function attachmentPreview(value: unknown): Conversation['lastMessageAttachment'] {
  const attachment = objectValue(value);
  const fileName = optionalString(attachment.fileName);
  const mimeType = optionalString(attachment.mimeType);
  if (!fileName && !mimeType) return undefined;
  const kind = mimeType?.startsWith('image/')
    ? 'image'
    : mimeType?.startsWith('video/')
      ? 'video'
      : mimeType?.startsWith('audio/')
        ? 'audio'
        : 'file';
  return { kind, fileName: fileName ?? null };
}

function messageFromDto(
  row: JsonRecord,
  current: Person,
  peopleById: Map<string, Person>,
  messageLanguage: LanguageCode,
): Message {
  const messageId = requiredString(row.messageId ?? row.id, 'message');
  const systemEventRow = objectValue(row.systemEvent);
  const systemEventType = systemEventRow.eventType;
  const allowedSystemEvents = [
    'conversation.posting.admins_only',
    'conversation.posting.all_members',
    'conversation.join.approved',
    'conversation.created',
    'conversation.member.added',
    'conversation.member.removed',
    'conversation.member.role_changed',
    'conversation.avatar.changed',
    'conversation.avatar.removed',
  ] as const;
  const targetUserId = optionalString(systemEventRow.targetUserId);
  const targetRequiredSystemEvents = [
    'conversation.join.approved',
    'conversation.member.added',
    'conversation.member.removed',
    'conversation.member.role_changed',
  ] as const;
  const targetRequired = targetRequiredSystemEvents.includes(
    systemEventType as typeof targetRequiredSystemEvents[number],
  );
  // Events without a target (avatar changed/removed, posting policy, created)
  // may arrive without the targetUserId key at all (defect P, Sep 4 2026: the
  // avatar-changed event sank the whole bootstrap and the app never loaded).
  if (row.kind === 'system' && !('targetUserId' in systemEventRow)) {
    (systemEventRow as Record<string, unknown>).targetUserId = null;
  }
  if (row.kind === 'system' && (
    !hasExactKeys(systemEventRow, ['eventType', 'targetUserId']) ||
    !allowedSystemEvents.includes(systemEventType as typeof allowedSystemEvents[number]) ||
    targetRequired !== (targetUserId !== null) ||
    (targetUserId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId))
  )) throw new RepositoryError('The service returned an invalid conversation system event.', 'invalid_response', true);
  if (row.kind !== 'system' && row.systemEvent !== null && row.systemEvent !== undefined) {
    throw new RepositoryError('The service returned an unexpected conversation system event.', 'invalid_response', true);
  }
  const conversationId = requiredString(row.conversationId, 'message conversation');
  const sender = objectValue(row.sender);
  const senderId = requiredString(sender.userId ?? row.senderUserId, 'message sender');
  const knownSender = peopleById.get(senderId);
  const displayName = optionalString(sender.displayName) ?? knownSender?.displayName ?? unknownPersonLabel(current);
  const detection = languageDetectionFromDto(row);
  const selectedTranslation = parseTranslation(row, messageLanguage);
  const approvedCorrection = selectedTranslation?.correction?.status === 'approved'
    ? selectedTranslation.correction
    : null;
  const translationState: Message['translationState'] = approvedCorrection
    ? 'corrected'
    : selectedTranslation?.reviewedAt
      ? 'human_reviewed'
      : selectedTranslation?.correction?.status === 'pending'
        ? 'needs_review'
        : selectedTranslation?.status === 'completed'
          ? 'translated'
          : selectedTranslation?.status === 'processing'
            ? 'translating'
            : selectedTranslation?.status === 'queued'
              ? 'queued'
              : selectedTranslation?.status === 'blocked'
                ? 'blocked'
                : selectedTranslation?.status === 'failed'
                  ? 'failed'
                  : detection.state === 'ambiguous'
                    ? 'needs_review'
                    : 'not_requested';
  const forward = objectValue(row.forward);
  const reply = objectValue(row.reply);
  const attachments = values(row.attachments);
  const sourceLanguage = detection.detectedLanguage
    ?? language(row.clientLanguageHint ?? row.languageCode);
  const isOwn = senderId === current.id;
  const receipt = messageReceipt(row.receipt, isOwn);
  const mentionUserIds = parseMentionDto(row.mentions);
  if (mentionUserIds === null) {
    throw new RepositoryError('The service returned invalid message mentions.', 'invalid_response', true);
  }
  const createdAt = requiredString(row.createdAt, 'message creation date');
  return {
    id: `server-${messageId}`,
    serverId: messageId,
    clientMessageId: optionalString(row.clientNonce) ?? undefined,
    conversationId,
    senderId,
    senderName: displayName,
    senderInitials: knownSender?.initials ?? initials(displayName),
    senderColor: knownSender?.avatarColor ?? stableColor(senderId),
    originalText: optionalString(row.body) ?? '',
    translatedText: approvedCorrection?.correctedText
      ?? selectedTranslation?.translatedText
      ?? undefined,
    sourceLanguage,
    targetLanguage: selectedTranslation?.targetLanguage,
    translationState,
    translation: selectedTranslation,
    outgoingTranslations: isOwn ? parseOutgoingTranslations(row, sourceLanguage) : undefined,
    languageDetection: detection,
    createdAt,
    sentAt: dateTimeLabel(createdAt),
    isOwn,
    deliveryState: receipt.read ? 'read' : receipt.delivered ? 'delivered' : 'sent',
    receipt,
    priority: ['important', 'safety'].includes(String(row.priority)) ? row.priority as Message['priority'] : 'normal',
    mentionUserIds,
    edited: Boolean(row.editedAt),
    pinned: row.pinned === true,
    replyTo: Object.keys(reply).length ? {
      messageId: optionalString(reply.messageId) ?? undefined,
      senderName: peopleById.get(String(reply.senderUserId))?.displayName ?? unknownPersonLabel(current),
      preview: optionalString(reply.body) ?? '',
    } : undefined,
    reactions: reactionSummary(values(row.reactions), current.id),
    attachment: attachmentFrom(attachments[0]),
    forwarded: forward.forwarded === true,
    forwardSource: forward.sourceConversationId && forward.sourceMessageId ? {
      conversationId: String(forward.sourceConversationId),
      messageId: String(forward.sourceMessageId),
    } : undefined,
    systemEvent: row.kind === 'system' ? {
      eventType: systemEventType as NonNullable<Message['systemEvent']>['eventType'],
      targetUserId,
    } : undefined,
  };
}

function reactionSummary(reactions: JsonRecord[], currentUserId: string): Message['reactions'] {
  const grouped = new Map<string, { emoji: string; count: number; reactedByMe: boolean }>();
  for (const row of reactions) {
    const emoji = optionalString(row.emoji);
    if (!emoji) continue;
    const current = grouped.get(emoji) ?? { emoji, count: 0, reactedByMe: false };
    current.count += 1;
    current.reactedByMe ||= row.userId === currentUserId;
    grouped.set(emoji, current);
  }
  return [...grouped.values()];
}

function conversationFromDto(
  row: JsonRecord,
  current: Person,
  peopleById: Map<string, Person>,
  /** What this phone reads in — the "Translate to" setting, which is not
   * always the profile's own language. The pair chip claimed EN ↔ KO to a
   * reader whose messages arrive in Korean (defect, Sep 8 2026). */
  readingLanguage: LanguageCode = current.preferredLanguage,
): Conversation {
  const id = requiredString(row.conversationId ?? row.id, 'conversation');
  const kind = conversationKind(row.kind);
  const directId = optionalString(row.directCounterpartUserId);
  const direct = directId ? peopleById.get(directId) : undefined;
  const personalRealm = isPersonalRealm(current.organizationId);
  const members = values(row.members).slice(0, 500);
  const memberCount = Math.max(0, integer(row.memberCount, members.length));
  const memberProfiles = members.map((member) => {
    const userId = requiredString(member.userId, 'conversation member');
    const displayName = requiredString(member.displayName, 'conversation member name');
    const role: 'owner' | 'admin' | 'member' = member.role === 'owner' || member.role === 'admin'
      ? member.role
      : 'member';
    return {
      id: userId,
      displayName,
      initials: initials(displayName),
      avatarColor: stableColor(userId),
      avatarPath: optionalString(member.avatarPath),
      role,
      canPost: member.canPost !== false,
    };
  });
  const preferences = objectValue(row.preferences);
  const preview = objectValue(row.preview);
  const historyDisclosure = objectValue(row.historyDisclosure);
  const departure = objectValue(row.departure);
  const departureRestriction = [
    'direct_mandatory',
    'announcement_mandatory',
    'team_mandatory',
    'shift_mandatory',
    'incident_mandatory',
    'policy_managed',
    'audience_mandatory',
    'mandatory_audience',
  ].includes(String(departure.restriction))
    ? departure.restriction as NonNullable<Conversation['departure']>['restriction']
    : null;
  const notificationLevel = normalizeNotificationLevel(preferences.notificationLevel);
  const mutedUntil = activeMutedUntil(preferences.mutedUntil);
  const translationMode = preferences.translationMode === 'off' ? 'off' : 'automatic';
  const memberRole = String(row.memberRole ?? members.find((member) => member.userId === current.id)?.role ?? 'member');
  // A nickname is what this reader calls them, so it names the thread too.
  const title = kind === 'direct'
    ? (direct ? personDisplayName(direct) : undefined) ?? 'Direct message'
    : optionalString(row.name) ?? 'Company conversation';
  return {
    id,
    directParticipantId: directId ?? undefined,
    title,
    initials: kind === 'direct' ? (direct?.contactAlias?.trim() ? initials(title) : direct?.initials ?? 'DM') : initials(title),
    avatarColor: direct?.avatarColor ?? stableColor(id),
    avatarPath: kind === 'direct' ? null : optionalString(row.avatarPath),
    kind,
    // A direct thread shows the peer's @handle, so the person you are talking
    // to is identifiable and searchable, not just a display name.
    subtitle: kind === 'direct'
      ? (direct?.username
        ? `@${direct.username}`
        : personalRealm ? '' : direct?.roleLabel ?? unknownPersonLabel(current))
      : optionalString(row.description) ?? '',
    participantCount: memberCount,
    // Empty until something is sent; the list renders the localized fallback.
    lastMessage: optionalString(preview.body) ?? '',
    // A photo or a file with no caption has no body: the row names the kind
    // instead of claiming the chat is empty (v3.4).
    lastMessageAttachment: attachmentPreview(preview.attachment),
    // The server preview layer swaps in the viewer's translation once it
    // exists and says so; own texts never need one.
    lastMessageSenderId: optionalString(preview.senderUserId) ?? undefined,
    lastMessageTranslated: typeof preview.translatedTo === 'string',
    lastActivity: dateTimeLabel(preview.createdAt ?? row.updatedAt),
    unreadCount: Math.max(0, integer(row.unreadCount)),
    lastReadMessageId: optionalIdentifier(row.lastReadMessageId),
    pinned: preferences.isPinned === true,
    favorite: preferences.isFavorite === true,
    muted: isConversationMuted(notificationLevel, mutedUntil),
    notificationLevel,
    mutedUntil,
    translationMode,
    presence: direct?.presence,
    translationPair: direct && direct.preferredLanguage !== readingLanguage
      ? `${readingLanguage.toUpperCase()} ↔ ${direct.preferredLanguage.toUpperCase()}`
      : undefined,
    description: optionalString(row.description) ?? undefined,
    archived: row.isArchived === true,
    // Archiving is this reader's own choice about their own list; the
    // conversation-level flag above belongs to a workplace administrator.
    archivedByMe: preferences.isArchived === true,
    myRole: memberRole === 'owner' || memberRole === 'admin' ? memberRole : 'member',
    canManage: row.canManage === true,
    canManageConversation: row.canManageConversation === true,
    canManageDynamicGroup: row.canManageDynamicGroup === true,
    policyManaged: row.policyManaged === true,
    managementOnly: row.managementOnly === true,
    // The full member objects come for the selected conversation and directs;
    // member_ids come for every conversation, and are what tells the Chats
    // search that a group holds the two people someone named.
    memberIds: members.length
      ? members.map((member) => String(member.userId)).filter(Boolean)
      : stringArray(row.memberIds),
    memberRoles: Object.fromEntries(members.map((member) => [String(member.userId),
      member.role === 'owner' || member.role === 'admin' ? member.role : 'member'])),
    memberProfiles: row.managementOnly === true ? memberProfiles : undefined,
    departure: typeof departure.eligible === 'boolean'
      && typeof departure.requiresOwnershipTransfer === 'boolean'
      && departure.historyPreserved === true
      && departure.futureAccessRevoked === true
      && (departure.restriction === null || departureRestriction !== null)
      ? {
          eligible: departure.eligible,
          restriction: departureRestriction,
          requiresOwnershipTransfer: departure.requiresOwnershipTransfer,
          historyPreserved: true,
          futureAccessRevoked: true,
        }
      : undefined,
    historyPolicy: row.historyPolicy === 'all' ? 'all' : row.historyPolicy === 'since_join' ? 'since_join' : undefined,
    historyDisclosure: Object.keys(historyDisclosure).length && ['all', 'since_join'].includes(String(historyDisclosure.policy))
      ? {
          policy: historyDisclosure.policy as 'all' | 'since_join',
          visibleFrom: optionalString(historyDisclosure.visibleFrom),
          labelKey: historyDisclosure.labelKey === 'conversation.history.all'
            ? 'conversation.history.all'
            : 'conversation.history.since_join',
        }
      : undefined,
    incidentSeverity: ['low', 'medium', 'high', 'critical'].includes(String(row.incidentSeverity))
      ? row.incidentSeverity as Conversation['incidentSeverity']
      : undefined,
    incidentClassification: optionalString(row.incidentClassification) ?? undefined,
    closedAt: optionalString(row.closedAt) ?? undefined,
    closedByUserId: optionalString(row.closedByUserId) ?? undefined,
    closureReason: optionalString(row.closureReason) ?? undefined,
    isReadOnly: row.isReadOnly === true,
    postingMode: row.postingMode === 'admins_only' ? 'admins_only' : 'all_members',
    configuredJoinPolicy: ['inherit', 'invite_only', 'approval_required'].includes(String(row.configuredJoinPolicy))
      ? row.configuredJoinPolicy as Conversation['configuredJoinPolicy']
      : 'inherit',
    joinPolicy: row.joinPolicy === 'approval_required' ? 'approval_required' : 'invite_only',
    visibility: ['organization', 'unit'].includes(String(row.visibility))
      ? row.visibility as 'organization' | 'unit'
      : 'invite_only',
    canPost: row.canPost === true,
  };
}

function discoverableConversationFromDto(row: JsonRecord): DiscoverableConversation {
  const history = objectValue(row.historyDisclosure);
  const request = objectValue(row.myJoinRequest);
  const kind = row.kind;
  const visibility = row.visibility;
  if (
    !['group', 'team'].includes(String(kind)) ||
    !['organization', 'unit'].includes(String(visibility)) ||
    row.joinPolicy !== 'approval_required' ||
    !['all', 'since_join'].includes(String(history.policy))
  ) throw new RepositoryError('The service returned an invalid conversation directory.', 'invalid_response', true);
  const conversationId = requiredString(row.conversationId, 'discoverable conversation');
  return {
    conversationId,
    kind: kind as 'group' | 'team',
    name: requiredString(row.name, 'discoverable conversation name'),
    description: optionalString(row.description),
    avatarPath: optionalString(row.avatarPath),
    visibility: visibility as 'organization' | 'unit',
    postingMode: row.postingMode === 'admins_only' ? 'admins_only' : 'all_members',
    joinPolicy: 'approval_required',
    memberCount: Math.max(0, integer(row.memberCount)),
    historyDisclosure: {
      policy: history.policy as 'all' | 'since_join',
      visibleFrom: optionalString(history.visibleFrom),
      labelKey: history.labelKey === 'conversation.history.all'
        ? 'conversation.history.all'
        : 'conversation.history.since_join',
    },
    myJoinRequest: Object.keys(request).length ? {
      requestId: requiredString(request.requestId, 'join request'),
      conversationId,
      requesterUserId: 'self',
      status: ['pending', 'approved', 'rejected', 'cancelled', 'expired'].includes(String(request.status))
        ? request.status as NonNullable<DiscoverableConversation['myJoinRequest']>['status']
        : 'expired',
      version: Math.max(1, integer(request.version, 1)),
      requestedAt: requiredString(request.requestedAt, 'join request time'),
      expiresAt: requiredString(request.expiresAt, 'join request expiry'),
      decidedAt: optionalString(request.decidedAt),
    } : null,
  };
}

function updateFromDto(row: JsonRecord, current: Person, peopleById: Map<string, Person>): CompanyUpdate {
  const acknowledgedAt = optionalString(row.acknowledgedAt);
  const authorId = optionalString(row.createdByUserId ?? row.authorUserId);
  const acknowledgementSchema = objectValue(row.acknowledgementSchema);
  const reminderPolicy = objectValue(row.reminderPolicy);
  const updateStatus = ['draft', 'scheduled', 'published', 'cancelled'].includes(String(row.status))
    ? row.status as CompanyUpdate['status']
    : undefined;
  return {
    id: requiredString(row.announcementId, 'announcement'),
    versionId: requiredString(row.announcementVersionId, 'announcement version'),
    versionNumber: Math.max(1, integer(row.versionNumber, 1)),
    title: requiredString(row.title, 'announcement title'),
    body: optionalString(row.body) ?? '',
    translatedBody: optionalString(row.translatedBody) ?? undefined,
    author: authorId ? peopleById.get(authorId)?.displayName ?? 'Company communications' : 'Company communications',
    audience: optionalString(row.audienceLabel) ?? 'Published audience',
    publishedAt: dateTimeLabel(row.publishedAt),
    severity: row.priority === 'emergency' ? 'critical' : row.priority === 'important' ? 'important' : 'standard',
    acknowledgementRequired: row.requiresAcknowledgement === true,
    acknowledged: Boolean(acknowledgedAt),
    acknowledgedCount: integer(row.acknowledgedCount, acknowledgedAt ? 1 : 0),
    recipientCount: integer(row.recipientCount, 0),
    recipientCountKnown: typeof row.recipientCount === 'number',
    deadline: row.expiresAt ? dateTimeLabel(row.expiresAt) : undefined,
    status: updateStatus,
    scheduledAt: optionalString(row.scheduledAt) ?? undefined,
    notificationClass: ['routine', 'urgent', 'critical'].includes(String(row.notificationClass))
      ? row.notificationClass as CompanyUpdate['notificationClass']
      : undefined,
    acknowledgementSchema: Object.keys(acknowledgementSchema).length
      ? {
          schemaVersion: 1,
          attestationRequired: acknowledgementSchema.attestationRequired === true,
          attestationPrompt: optionalString(acknowledgementSchema.attestationPrompt),
          requiredKeys: stringArray(acknowledgementSchema.requiredKeys, 20),
          carryForwardOnCorrection: acknowledgementSchema.carryForwardOnCorrection === true,
        }
      : null,
    reminderPolicy: Object.keys(reminderPolicy).length
      ? {
          enabled: reminderPolicy.enabled === true,
          deadlineAt: optionalString(reminderPolicy.deadlineAt),
          intervalSeconds: reminderPolicy.intervalSeconds === null
            ? null
            : integer(reminderPolicy.intervalSeconds),
          maximumReminders: Math.max(0, integer(reminderPolicy.maximumReminders)),
          escalateAfterSeconds: reminderPolicy.escalateAfterSeconds === null
            ? null
            : integer(reminderPolicy.escalateAfterSeconds),
          smsFallback: false,
        }
      : null,
    reminderState: ['not_applicable', 'pending', 'sent', 'exhausted'].includes(String(row.reminderState))
      ? row.reminderState as CompanyUpdate['reminderState']
      : undefined,
    escalationState: ['not_applicable', 'pending', 'escalated'].includes(String(row.escalationState))
      ? row.escalationState as CompanyUpdate['escalationState']
      : undefined,
    deliveredAt: optionalString(row.deliveredAt),
    readAt: optionalString(row.readAt),
  };
}

function handoffFromDto(
  row: JsonRecord, current: Person, peopleById: Map<string, Person>, personalRealm: boolean,
): ShiftHandoff {
  const authorId = requiredString(row.authorUserId, 'handoff author');
  const acknowledgedAt = optionalString(row.acknowledgedAt);
  const status = String(row.status);
  return {
    id: requiredString(row.handoffId, 'handoff'),
    conversationId: requiredString(row.conversationId, 'handoff conversation'),
    versionId: requiredString(row.handoffVersionId, 'handoff version'),
    versionNumber: Math.max(1, integer(row.versionNumber, 1)),
    sourceLanguage: supportedLanguage(row.sourceLanguage, 'handoff source language'),
    title: requiredString(row.title, 'handoff title'),
    // Consumers carry no site; the workplace placeholder stays only for an
    // author who has left the directory.
    site: peopleById.get(authorId)?.site ?? (personalRealm ? '' : 'Company site'),
    outgoingShift: dateTimeLabel(row.shiftStartedAt),
    incomingShift: dateTimeLabel(row.shiftEndedAt),
    window: `${dateTimeLabel(row.shiftStartedAt)} – ${dateTimeLabel(row.shiftEndedAt)}`,
    status: status === 'draft' ? 'draft' : acknowledgedAt || status === 'closed' ? 'acknowledged' : status === 'submitted' ? 'ready' : 'awaiting_signoff',
    summary: optionalString(row.details) ?? '',
    openItems: integer(row.openItems),
    sourceCount: stringArray(row.sourceMessageIds).length || integer(row.sourceCount),
    outgoingSupervisor: peopleById.get(authorId)?.displayName ?? 'Assigned supervisor',
    incomingSupervisor: optionalString(row.incomingSupervisorName) ?? 'Assigned incoming supervisor',
    shiftStartedAt: requiredDate(row.shiftStartedAt, 'handoff shift start'),
    shiftEndedAt: requiredDate(row.shiftEndedAt, 'handoff shift end'),
    authorId,
    acknowledgedByMe: Boolean(acknowledgedAt),
    canSign: status === 'draft' && authorId === current.id,
    canAcknowledge: status === 'submitted' && authorId !== current.id && !acknowledgedAt,
    sourceMessageIds: stringArray(row.sourceMessageIds),
    sourceFingerprint: optionalString(row.sourceFingerprint) ?? undefined,
    sourceState: row.sourceState === 'stale' ? 'stale' : 'current',
    sourceStaleAt: optionalString(row.sourceStaleAt) ?? undefined,
    sourceStaleReason: row.staleReason === 'source_edited_or_deleted'
      ? 'source_edited_or_deleted'
      : undefined,
    acknowledgementDueAt: optionalString(row.acknowledgementDueAt) ?? undefined,
    overdue: row.overdue === true,
    reminderState: ['not_due', 'due', 'sent', 'exhausted'].includes(String(row.reminderState))
      ? row.reminderState as ShiftHandoff['reminderState']
      : undefined,
    reminderCount: Math.max(0, integer(row.reminderCount)),
    lastRemindedAt: optionalString(row.lastRemindedAt) ?? undefined,
    escalationState: ['not_due', 'due', 'escalated'].includes(String(row.escalationState))
      ? row.escalationState as ShiftHandoff['escalationState']
      : undefined,
    escalatedAt: optionalString(row.escalatedAt) ?? undefined,
    smsFallbackAvailable: false,
    correctionOfVersionId: optionalString(row.correctionOfVersionId) ?? undefined,
    correctionReason: optionalString(row.correctionReason) ?? undefined,
  };
}

function strictSummaryTextArray(value: unknown, label: string, maximum = 50) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RepositoryError(`The service returned invalid ${label}.`, 'invalid_response', true);
  }
  // Older rows carry "[sources:s0002]" suffixes; the text people read never does.
  return value
    .map((entry) => ({ text: stripSummarySourceTokens(requiredString(entry, label)), sourceMessageIds: [] }))
    .filter((item) => item.text.length > 0);
}

function strictSummarySourceIds(value: unknown, label: string, maximum = 2000) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new RepositoryError(`The service returned invalid ${label}.`, 'invalid_response', true);
  }
  const ids = value.map((entry) => requiredString(entry, label));
  if (new Set(ids).size !== ids.length) {
    throw new RepositoryError(`The service returned duplicate ${label}.`, 'invalid_response', true);
  }
  return ids;
}

function summaryEvidenceFromDto(
  value: unknown,
  sourceIds: ReadonlySet<string>,
  label: string,
) {
  const row = objectValue(value);
  const evidenceIds = strictSummarySourceIds(row.sourceMessageIds, `${label} sources`, 50);
  if (evidenceIds.some((id) => !sourceIds.has(id))) {
    throw new RepositoryError(`The service returned unauthorized ${label} evidence.`, 'invalid_response', false);
  }
  return { text: stripSummarySourceTokens(requiredString(row.text, label)), sourceMessageIds: evidenceIds };
}

function parseSummaryAction(
  value: unknown,
  sourceIds: ReadonlySet<string>,
) {
  const evidence = summaryEvidenceFromDto(value, sourceIds, 'summary action');
  const row = objectValue(value);
  return {
    title: evidence.text,
    owner: nullableText(row.owner, 'summary action owner'),
    dueAt: nullableText(row.due ?? row.dueAt, 'summary action due date'),
    sourceMessageIds: evidence.sourceMessageIds,
  };
}

const SUMMARY_SCOPE_KIND_VALUES = ['unread', 'today', 'yesterday', 'last_7_days', 'everything'];

function summaryFromDto(row: JsonRecord): ConversationSummary {
  const rawStatus = String(row.status);
  if (!['queued', 'processing', 'draft', 'approved', 'failed', 'stale'].includes(rawStatus)) {
    throw new RepositoryError('The service returned an invalid summary state.', 'invalid_response', true);
  }
  const correctionOfSummaryId = row.correctionOfSummaryId == null
    ? null
    : requiredString(row.correctionOfSummaryId, 'corrected summary');
  const status: ConversationSummary['status'] = rawStatus === 'processing'
    ? 'generating'
    : rawStatus === 'draft'
      ? correctionOfSummaryId ? 'corrected' : 'ready_for_review'
      : rawStatus === 'approved'
        ? 'approved'
        : rawStatus === 'stale'
          ? 'superseded'
          : rawStatus as 'queued' | 'failed';
  const sourceMessageIds = strictSummarySourceIds(row.sourceMessageIds, 'summary source messages');
  const sourceIds = new Set(sourceMessageIds);
  const sourceFirstMessageId = requiredString(row.sourceFirstMessageId, 'summary first source');
  const sourceLastMessageId = requiredString(row.sourceLastMessageId, 'summary last source');
  const sourceFingerprint = requiredString(
    row.sourceFingerprint ?? row.sourceFingerprintHex,
    'summary source fingerprint',
  );
  const outputFingerprint = nullableText(row.outputFingerprint, 'summary output fingerprint');
  if (
    sourceMessageIds[0] !== sourceFirstMessageId
    || sourceMessageIds.at(-1) !== sourceLastMessageId
    || !/^[0-9a-f]{64}$/.test(sourceFingerprint)
    || (outputFingerprint !== null && !/^[0-9a-f]{64}$/.test(outputFingerprint))
  ) {
    throw new RepositoryError('The service returned inconsistent summary fingerprints.', 'invalid_response', true);
  }
  const requestMode = row.requestMode;
  const sourceState = row.sourceState;
  const policyState = row.policyState;
  if (
    !['manual', 'automatic_message_count', 'automatic_shift_close', 'manual_fallback', 'correction'].includes(String(requestMode))
    || !['current', 'stale'].includes(String(sourceState))
    || !['current', 'stale', 'not_applicable', 'unknown'].includes(String(policyState))
    || (rawStatus === 'stale') !== (sourceState === 'stale')
  ) {
    throw new RepositoryError('The service returned inconsistent summary provenance state.', 'invalid_response', true);
  }
  const provenanceRow = objectValue(row.processorProvenance);
  const processorType = row.processorType == null ? null : row.processorType;
  if (processorType !== null && processorType !== 'ai' && processorType !== 'manual') {
    throw new RepositoryError('The service returned an invalid summary processor.', 'invalid_response', true);
  }
  const reviewedByUserId = row.reviewedByUserId == null
    ? null
    : requiredString(row.reviewedByUserId, 'summary reviewer');
  const reviewedAt = nullableDate(row.reviewedAt, 'summary review time');
  if ((rawStatus === 'approved') !== (reviewedByUserId !== null && reviewedAt !== null)) {
    throw new RepositoryError('The service returned inconsistent summary review state.', 'invalid_response', true);
  }
  const ready = rawStatus === 'draft' || rawStatus === 'approved';
  const primaryTopic = nullableText(row.primaryTopic, 'summary primary topic');
  const summary = nullableText(row.summaryBody, 'summary body');
  const failureCode = nullableText(row.failureCode, 'summary failure code');
  if (
    ready !== (primaryTopic !== null && summary !== null && outputFingerprint !== null)
    || ((rawStatus === 'failed' || rawStatus === 'stale') !== (failureCode !== null))
  ) {
    throw new RepositoryError('The service returned inconsistent summary content state.', 'invalid_response', true);
  }
  const keyTopics = ready ? strictSummaryTextArray(row.keyTopics, 'summary key topics') : [];
  const decisions = ready
    ? values(row.decisions).map((entry) => summaryEvidenceFromDto(entry, sourceIds, 'summary decision'))
    : [];
  const actionItems = ready
    ? values(row.actionItems).map((entry) => parseSummaryAction(entry, sourceIds))
    : [];
  const ambiguities = ready ? strictSummaryTextArray(row.ambiguities, 'summary ambiguities') : [];
  const policyVersion = provenanceRow.organizationAiPolicyVersion == null
    ? null
    : Number.isSafeInteger(provenanceRow.organizationAiPolicyVersion)
        && Number(provenanceRow.organizationAiPolicyVersion) > 0
      ? Number(provenanceRow.organizationAiPolicyVersion)
      : NaN;
  if (Number.isNaN(policyVersion)) {
    throw new RepositoryError('The service returned an invalid summary policy version.', 'invalid_response', true);
  }
  const versionNumber = integer(row.versionNumber);
  if (versionNumber < 1) {
    throw new RepositoryError('The service returned an invalid summary version.', 'invalid_response', true);
  }
  const scopeKind = row.scopeKind == null ? null : String(row.scopeKind);
  if (scopeKind !== null && !SUMMARY_SCOPE_KIND_VALUES.includes(scopeKind)) {
    throw new RepositoryError('The service returned an invalid summary scope.', 'invalid_response', true);
  }
  const sourceMessageCount = row.sourceMessageCount == null ? sourceMessageIds.length : Number(row.sourceMessageCount);
  if (!Number.isSafeInteger(sourceMessageCount) || sourceMessageCount < 1) {
    throw new RepositoryError('The service returned an invalid summary message count.', 'invalid_response', true);
  }
  return {
    id: requiredString(row.summaryId, 'summary'),
    conversationId: requiredString(row.conversationId, 'summary conversation'),
    versionNumber,
    language: supportedLanguage(row.languageCode, 'summary language'),
    status,
    primaryTopic: stripSummarySourceTokens(primaryTopic ?? ''),
    summary: stripSummarySourceTokens(summary ?? ''),
    keyTopics,
    decisions,
    actionItems,
    ambiguities,
    sourceMessageIds,
    sourceFirstMessageId,
    sourceLastMessageId,
    sourceFingerprint,
    outputFingerprint,
    scopeKind: scopeKind as ConversationSummary['scopeKind'],
    scopeSubject: nullableText(row.scopeSubject, 'summary subject'),
    sourceMessageCount,
    sourceState: sourceState as ConversationSummary['sourceState'],
    policyState: policyState as ConversationSummary['policyState'],
    requestMode: requestMode as ConversationSummary['requestMode'],
    requestedByUserId: requiredString(row.requestedByUserId, 'summary requester'),
    correctionOfSummaryId,
    provenance: {
      processorType: processorType as ConversationSummary['provenance']['processorType'],
      provider: nullableText(row.provider, 'summary provider'),
      model: nullableText(row.model, 'summary model'),
      organizationAiPolicyVersion: policyVersion,
      routePolicyVersion: nullableText(provenanceRow.routePolicyVersion, 'summary route policy version'),
      providerRoute: nullableText(provenanceRow.providerRoute, 'summary provider route'),
    },
    failureCode,
    reviewedByUserId,
    reviewedAt,
    reviewNote: nullableText(row.reviewNote, 'summary review note'),
    createdAt: requiredDate(row.createdAt, 'summary creation time'),
    generatedAt: requiredDate(row.updatedAt, 'summary update time'),
  };
}

function actionFromDto(row: JsonRecord, peopleById: Map<string, Person>): OperationalAction {
  const assigneeId = optionalString(row.assigneeUserId);
  const status = String(row.status);
  return {
    id: requiredString(row.actionId, 'operational action'),
    conversationId: requiredString(row.conversationId, 'action conversation'),
    sourceMessageId: optionalString(row.sourceMessageId),
    title: requiredString(row.title, 'action title'),
    details: optionalString(row.details),
    status: ['proposed', 'confirmed', 'in_progress', 'completed', 'cancelled'].includes(status)
      ? status as OperationalAction['status'] : 'proposed',
    proposedByUserId: requiredString(row.proposedByUserId, 'action proposer'),
    assigneeUserId: assigneeId,
    assigneeName: assigneeId ? peopleById.get(assigneeId)?.displayName ?? 'Company member' : null,
    dueAt: optionalString(row.dueAt),
    createdAt: requiredString(row.createdAt, 'action creation time'),
    updatedAt: requiredString(row.updatedAt ?? row.createdAt, 'action update time'),
  };
}

function moderationFromDto(row: JsonRecord): ModerationReport {
  const status = String(row.status);
  const category = String(row.category);
  return {
    id: requiredString(row.reportId ?? row.id, 'moderation report'),
    conversationId: requiredString(row.conversationId, 'reported conversation'),
    messageId: requiredString(row.messageId, 'reported message'),
    category: ['harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other'].includes(category)
      ? category as ModerationReport['category'] : 'other',
    status: ['open', 'assigned', 'in_review', 'resolved', 'dismissed'].includes(status)
      ? status as ModerationReport['status'] : 'open',
    reportedAt: requiredString(row.reportedAt ?? row.createdAt, 'report time'),
    assignedToMe: row.assignedToMe === true,
    reporterLabel: optionalString(row.reporterLabel) ?? 'Protected reporter',
    safeExcerpt: optionalString(row.safeExcerpt),
  };
}

function auditFromDto(row: JsonRecord): AuditEvent {
  const outcome = String(row.outcome);
  return {
    id: requiredString(row.auditEventId ?? row.id, 'audit event'),
    operation: requiredString(row.operation, 'audit operation'),
    entityType: requiredString(row.entityType, 'audit entity type'),
    entityId: optionalString(row.entityId),
    actorLabel: optionalString(row.actorLabel) ?? 'Authorized member',
    occurredAt: requiredString(row.occurredAt ?? row.createdAt, 'audit time'),
    outcome: outcome === 'denied' || outcome === 'failed' ? outcome : 'succeeded',
  };
}

function privilegedAuditFromDto(row: JsonRecord): PrivilegedAuditEvent {
  const id = requiredString(row.id, 'audit event');
  const eventType = requiredString(row.eventType, 'audit operation');
  const targetType = requiredString(row.targetType, 'audit target type');
  const targetId = requiredString(row.targetId, 'audit target');
  const actorUserId = optionalString(row.actorUserId);
  const requestId = optionalString(row.requestId);
  const outcome = String(row.outcome);
  if (
    !/^[1-9][0-9]{0,18}$/.test(id)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$/.test(eventType)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/.test(targetType)
    || targetId.length > 240
    || /\p{Cc}/u.test(targetId)
    || !['succeeded', 'denied', 'failed'].includes(outcome)
  ) throw new RepositoryError('The service returned an invalid audit event.', 'invalid_response', true);
  return {
    id,
    actorUserId,
    eventType,
    targetType,
    targetId,
    requestId,
    occurredAt: requiredDate(row.occurredAt, 'audit time'),
    outcome: outcome as PrivilegedAuditEvent['outcome'],
  };
}

export class WebReadRepository implements ReadRepository {
  private identity: {
    current: Person;
    peopleById: Map<string, Person>;
    messageLanguage: LanguageCode;
  } | null = null;

  constructor(private readonly context: RepositoryContext) {}

  async loadWorkspace(_userId: string, selectedConversationId?: string | null): Promise<WorkspaceSnapshot> {
    const payload = await readRequest(this.context, '/v2/bootstrap', {
      organizationId: null,
      selectedConversationId: selectedConversationId ?? null,
      beforeMessageId: null,
      conversationLimit: 100,
      timelineLimit: 100,
    });
    if (payload.schemaVersion !== 1) {
      throw new RepositoryError('The workspace schema is not supported by this app version.', 'client_update_required', false);
    }
    const organization = objectValue(payload.organization);
    const organizationId = requiredString(organization.organizationId, 'organization');
    const personalRealm = isPersonalRealm(organizationId);
    const units: OrganizationUnitOption[] = values(payload.units).map((unit) => {
      const kind = requiredString(unit.kind, 'organization unit kind');
      if (!['site', 'department', 'team', 'line', 'shift'].includes(kind)) {
        throw new RepositoryError('The service returned an invalid organization unit.', 'invalid_response', true);
      }
      return {
        unitId: requiredString(unit.unitId, 'organization unit'),
        parentUnitId: optionalString(unit.parentUnitId),
        kind: kind as OrganizationUnitOption['kind'],
        name: requiredString(unit.name, 'organization unit name'),
      };
    });
    const connections = values(payload.connections);
    const savedContacts = values(payload.savedContacts);
    const blockedIds = new Set(values(payload.memberBlocks).map((item) => String(item.blockedUserId)));
    const currentRow = objectValue(payload.currentUser);
    const currentMembershipRole = requiredString(
      currentRow.membershipRole,
      'current membership role',
    );
    if (!['owner', 'admin', 'manager', 'member'].includes(currentMembershipRole)) {
      throw new RepositoryError('The service returned an invalid current membership role.', 'invalid_response', true);
    }
    const currentMembership = parseOfflineWorkspaceMembership(currentRow);
    if (!currentMembership) {
      throw new RepositoryError(
        'The service returned an invalid current membership lifecycle.',
        'invalid_response',
        true,
      );
    }
    const currentUser: CurrentWorkspaceUser = {
      ...currentPerson(currentRow, units, personalRealm),
      ...currentMembership,
      organizationId,
    };
    const people = values(payload.directory).map((row) => {
      const person = personFromDirectory(row, currentUser.id, units, connections, savedContacts, blockedIds, personalRealm);
      person.organizationId = organizationId;
      return person;
    });
    if (!people.some((person) => person.id === currentUser.id)) people.unshift(currentUser);
    const peopleById = new Map(people.map((person) => [person.id, person]));
    const preferences = objectValue(payload.preferences);
    const messageLanguage = preferences.messageLanguage == null
      ? currentUser.preferredLanguage
      : supportedLanguage(preferences.messageLanguage, 'message display language');
    this.identity = { current: currentUser, peopleById, messageLanguage };
    const conversations = values(payload.conversations).map((row) => {
      const conversation = conversationFromDto(row, currentUser, peopleById, messageLanguage);
      conversation.organizationId = organizationId;
      return conversation;
    });
    const selectedId = optionalString(payload.selectedConversationId);
    const timeline = objectValue(payload.timeline);
    const timelineMessages = values(timeline.messages).map((row) =>
      messageFromDto(row, currentUser, peopleById, messageLanguage)
    );
    const messages: Record<string, Message[]> = Object.fromEntries(conversations.map((conversation) => [conversation.id, []]));
    if (selectedId) messages[selectedId] = timelineMessages;
    return {
      organizationId,
      organizationName: requiredString(organization.name, 'organization name'),
      conversationControlsVersion: Math.max(1, integer(organization.conversationControlsVersion, 1)),
      currentMembershipRole: currentMembershipRole as WorkspaceSnapshot['currentMembershipRole'],
      organizationPolicy: parseOrganizationPolicy({
        messageRetentionDays: organization.messageRetentionDays,
        allowMemberDirectMessages: organization.allowMemberDirectMessages,
        dmPolicy: organization.dmPolicy,
        requireMfaForAdmins: organization.requireMfaForAdmins,
        shiftScheduleAuthoritative: organization.shiftScheduleAuthoritative,
        groupCreationPolicy: organization.groupCreationPolicy,
        allowExternalGuests: organization.allowExternalGuests,
        externalGuestMaxAccessDays: organization.externalGuestMaxAccessDays,
        version: organization.organizationPolicyVersion,
      }),
      currentUser,
      conversations,
      messages,
      people,
      units,
      updates: values(payload.updates).map((row) => updateFromDto(row, currentUser, peopleById)),
      handoffs: values(payload.handoffs).map((row) => handoffFromDto(row, currentUser, peopleById, personalRealm)),
      summaries: values(payload.summaries).map(summaryFromDto),
      actions: values(payload.actions).map((row) => actionFromDto(row, peopleById)),
      moderationReports: values(payload.moderationReports).map(moderationFromDto),
      auditEvents: values(payload.auditEvents).map(auditFromDto),
      capabilities: parseWorkspaceCapabilities(payload.capabilities),
      scopes: parseScopes(payload.scopes),
      messageDisplayLanguage: messageLanguage,
      cursors: selectedId ? {
        [selectedId]: optionalIdentifier(timeline.nextBeforeMessageId),
      } : {},
      discoverableConversations: values(payload.discoverableConversations).map(
        discoverableConversationFromDto,
      ),
    };
  }

  async loadMessages(input: {
    organizationId: string;
    conversationId: string;
    userId: string;
    after?: string | null;
  }): Promise<MessagePage> {
    if (!this.identity) {
      const workspace = await this.loadWorkspace(input.userId, input.conversationId);
      return {
        items: workspace.messages[input.conversationId] ?? [],
        cursor: workspace.cursors[input.conversationId] ?? null,
      };
    }
    const payload = await readRequest(
      this.context,
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/messages/query`,
      {
        organizationId: input.organizationId,
        beforeMessageId: input.after ?? null,
        limit: 100,
      },
    );
    if (
      payload.schemaVersion !== 1
      || payload.conversationId !== input.conversationId
      || !Array.isArray(payload.messages)
      || payload.messages.length > 100
      || typeof payload.hasMore !== 'boolean'
    ) {
      throw new RepositoryError('The service returned an invalid message page.', 'invalid_response', true);
    }
    const cursor = optionalIdentifier(payload.nextBeforeMessageId);
    if (
      payload.hasMore !== Boolean(cursor)
      || (cursor && input.after && compareMessageIds(cursor, input.after) >= 0)
    ) {
      throw new RepositoryError('The service returned a non-advancing message cursor.', 'invalid_response', true);
    }
    const items = values(payload.messages).map((row) =>
      messageFromDto(
        row,
        this.identity!.current,
        this.identity!.peopleById,
        this.identity!.messageLanguage,
      )
    );
    if (
      input.after
      && items.some((message) =>
        !message.serverId || compareMessageIds(message.serverId, input.after as string) >= 0
      )
    ) {
      throw new RepositoryError('The service returned messages outside the requested page.', 'invalid_response', true);
    }
    if (cursor) {
      const firstMessageId = items.reduce<string | null>((lowest, message) =>
        !lowest || compareMessageIds(message.serverId as string, lowest) < 0
          ? message.serverId as string
          : lowest
      , null);
      if (!firstMessageId || compareMessageIds(cursor, firstMessageId) !== 0) {
        throw new RepositoryError('The service returned an unstable message cursor.', 'invalid_response', true);
      }
    }
    return { items, cursor };
  }

  async loadPinnedMessages(
    input: Parameters<ReadRepository['loadPinnedMessages']>[0],
  ): Promise<PinnedMessage[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const payload = await readRequest(this.context, '/v2/pins/query', {
      organizationId: input.organizationId,
      conversationId: input.conversationId ?? null,
      limit,
    });
    if (payload.schemaVersion !== 1 || !Array.isArray(payload.pins) || payload.pins.length > limit) {
      throw new RepositoryError('The service returned an invalid pinned list.', 'invalid_response', true);
    }
    return values(payload.pins).map(pinnedMessageFromDto);
  }

  async loadSharedMedia(
    input: Parameters<ReadRepository['loadSharedMedia']>[0],
  ): Promise<SharedMediaPage> {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 60);
    const payload = await readRequest(
      this.context,
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/media/query`,
      {
        organizationId: input.organizationId,
        beforeCreatedAt: input.cursor?.beforeCreatedAt ?? null,
        beforeAttachmentId: input.cursor?.beforeAttachmentId ?? null,
        limit,
      },
    );
    if (
      payload.schemaVersion !== 1
      || payload.conversationId !== input.conversationId
      || !Array.isArray(payload.items)
      || payload.items.length > limit
      || typeof payload.hasMore !== 'boolean'
    ) {
      throw new RepositoryError('The service returned an invalid media page.', 'invalid_response', true);
    }
    const items = values(payload.items).map(sharedMediaItemFromDto);
    const beforeCreatedAt = optionalString(payload.nextBeforeCreatedAt);
    const beforeAttachmentId = optionalString(payload.nextBeforeAttachmentId);
    const cursor = payload.hasMore && beforeCreatedAt && beforeAttachmentId
      ? { beforeCreatedAt, beforeAttachmentId }
      : null;
    // A page that claims more without a whole keyset would loop forever.
    if (payload.hasMore !== Boolean(cursor)) {
      throw new RepositoryError('The service returned a non-advancing media cursor.', 'invalid_response', true);
    }
    if (input.cursor && items.some((item) => item.createdAt > input.cursor!.beforeCreatedAt)) {
      throw new RepositoryError('The service returned media outside the requested page.', 'invalid_response', true);
    }
    return { items, cursor };
  }

  async searchUsers(
    input: Parameters<ReadRepository['searchUsers']>[0],
  ): Promise<UserSearchResult[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const payload = await readRequest(this.context, '/v2/users/search', {
      organizationId: input.organizationId,
      query: input.query,
      limit,
    });
    if (!Array.isArray(payload.users) || payload.users.length > limit) {
      throw new RepositoryError('The service returned invalid user search results.', 'invalid_response', true);
    }
    const users = values(payload.users).map(userSearchResultFromDto);
    if (new Set(users.map((user) => user.userId)).size !== users.length) {
      throw new RepositoryError('The service returned duplicate user search results.', 'invalid_response', true);
    }
    return users;
  }

  async queryAudit(input: Parameters<ReadRepository['queryAudit']>[0]): Promise<AuditPage> {
    const limit = input.limit ?? 50;
    const payload = await readRequest(this.context, '/v2/admin/audit/query', {
      organizationId: input.organizationId,
      reasonCode: input.reasonCode,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      eventTypes: input.eventTypes ?? [],
      actorMembershipId: input.actorMembershipId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      cursor: input.cursor ?? null,
      limit,
    });
    if (!Array.isArray(payload.items) || payload.items.length > limit) {
      throw new RepositoryError('The service returned an invalid audit page.', 'invalid_response', true);
    }
    const items = values(payload.items).map(privilegedAuditFromDto);
    const nextCursor = optionalString(payload.nextCursor);
    const hasMore = payload.hasMore === true;
    const filterSha256 = requiredString(payload.filterSha256, 'audit filter receipt');
    if (
      hasMore !== Boolean(nextCursor)
      || (nextCursor !== null && !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(nextCursor))
      || !/^[0-9a-f]{64}$/.test(filterSha256)
    ) throw new RepositoryError('The service returned an invalid audit cursor.', 'invalid_response', true);
    return {
      items,
      nextCursor,
      hasMore,
      snapshotAt: requiredDate(payload.snapshotAt, 'audit snapshot time'),
      filterSha256,
      receiptId: requiredString(payload.receiptId, 'audit query receipt'),
    };
  }
}
