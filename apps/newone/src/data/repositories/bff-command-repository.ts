import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';

import { resolveStorageSignedUrl } from '@/config/api-routing.mjs';
import { apiUrlFor, nativeEdgeRequestHeaders, publicRuntimeConfig } from '@/config/runtime';
import type {
  AttachmentDownloadGrant,
  AttachmentScanState,
  AttachmentUploadGrant,
  CommandRepository,
  CreateDirectInput,
  CreateGroupInput,
  RegisterDeviceInput,
  IssuedInvitation,
  ManagedUpdate,
  ManagedUpdateVersion,
  RepositoryContext,
  SendMessageInput,
  UpdateAcknowledgementReceipt,
  UpdateAudienceSpec,
  UpdateNonAcknowledger,
  UpdateNonAcknowledgerPage,
} from '@/data/repositories/contracts';
import { RepositoryError } from '@/data/repositories/contracts';
import {
  normalizeHandoffCorrectionRequest,
  parseHandoffCorrectionReceipt,
} from '@/data/repositories/handoff-correction-dto.mjs';
import { parseConversationDepartureReceipt } from '@/data/repositories/conversation-departure-dto.mjs';
import { parsePrivateReportReceipt } from '@/data/repositories/private-report-dto.mjs';
import {
  normalizeDeviceNotificationPreferencePatch,
  parseDeviceNotificationPreferences,
} from '@/data/repositories/device-notification-preferences-dto.mjs';
import {
  parseConversationMemberRoleReceipt,
  parseGroupCreationCandidates,
  parseGroupCreationReceipt,
} from '@/data/repositories/group-creation-dto.mjs';
import {
  parseConversationAvatarActivationReceipt,
  parseConversationAvatarReadGrant,
  parseConversationAvatarRemovalReceipt,
  parseConversationAvatarUploadGrant,
} from '@/data/repositories/conversation-avatar-dto.mjs';
import {
  normalizeOrganizationPolicyUpdate,
  parseOrganizationPolicy,
} from '@/data/repositories/organization-policy-dto.mjs';
import {
  normalizeOrganizationAiPolicyUpdate,
  parseOrganizationAiPolicy,
  parseOrganizationAiPolicyUpdateReceipt,
} from '@/data/repositories/ai-policy-dto.mjs';
import {
  parseDynamicGroupPauseReceipt,
  parseDynamicGroupPolicyList,
  parseDynamicGroupPolicySpec,
  parseDynamicGroupPreviewReceipt,
  parseDynamicGroupPublishReceipt,
  parseDynamicGroupSaveReceipt,
} from '@/data/repositories/dynamic-group-dto.mjs';
import { getWebCsrfToken } from '@/lib/web-auth';
import type {
  AccountSession,
  AdminRoleAssignment,
  AuditExportReceipt,
  ConversationJoinRequest,
  DiscoverableConversation,
  OrganizationPreferences,
  AiOutputErrorCategory,
  AiOutputErrorReport,
  AiOutputErrorReportDetail,
  AiRegressionExample,
} from '@/domain/types';

interface ErrorPayload {
  code?: string;
  message?: string;
  correlationId?: string;
  retryAfterSeconds?: number;
  error?: ErrorPayload;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function dataValue(value: unknown) {
  const root = objectValue(value);
  return objectValue(root.data ?? root);
}

function parsePrivateReportResponse(
  value: unknown,
  targetType: 'message' | 'group' | 'member',
) {
  try {
    return parsePrivateReportReceipt(value, targetType);
  } catch {
    throw new RepositoryError(
      'The service returned an invalid private report receipt.',
      'invalid_response',
      true,
    );
  }
}

function requiredString(value: unknown, label: string) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

function requiredInteger(value: unknown, label: string, minimum = 0) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= minimum) return value;
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseConversationMemberCandidatePage(value: unknown, requestedLimit: number) {
  const data = objectValue(value);
  if (
    !hasOnlyKeys(data, ['candidates', 'nextCursor']) ||
    Object.keys(data).length !== 2 ||
    !Array.isArray(data.candidates) ||
    data.candidates.length > requestedLimit ||
    requestedLimit < 1 || requestedLimit > 100
  ) {
    throw new RepositoryError(
      'The service returned invalid conversation member candidates.',
      'invalid_response',
      true,
    );
  }
  const candidates = data.candidates.map((entry) => {
    const row = objectValue(entry);
    const userId = row.userId;
    const displayName = row.displayName;
    if (
      !hasOnlyKeys(row, ['userId', 'displayName', 'avatarPath', 'roleLabel', 'membershipType']) ||
      !UUID_PATTERN.test(String(userId)) ||
      typeof displayName !== 'string' || displayName.length < 1 || displayName.length > 160 ||
      displayName.trim() !== displayName || displayName.normalize('NFC') !== displayName ||
      ('avatarPath' in row && (
        typeof row.avatarPath !== 'string' || row.avatarPath.length < 1 || row.avatarPath.length > 1024
      )) ||
      ('roleLabel' in row && (
        typeof row.roleLabel !== 'string' || row.roleLabel.length < 1 || row.roleLabel.length > 160 ||
        row.roleLabel.trim() !== row.roleLabel || row.roleLabel.normalize('NFC') !== row.roleLabel
      )) ||
      ('membershipType' in row &&
        !['employee', 'contractor', 'guest'].includes(String(row.membershipType)))
    ) {
      throw new RepositoryError(
        'The service returned an invalid conversation member candidate.',
        'invalid_response',
        true,
      );
    }
    return {
      userId: String(userId).toLowerCase(),
      displayName,
      ...(typeof row.avatarPath === 'string' ? { avatarPath: row.avatarPath } : {}),
      ...(typeof row.roleLabel === 'string' ? { roleLabel: row.roleLabel } : {}),
      ...(typeof row.membershipType === 'string'
        ? { membershipType: row.membershipType as 'employee' | 'contractor' | 'guest' }
        : {}),
    };
  });
  if (new Set(candidates.map((candidate) => candidate.userId)).size !== candidates.length) {
    throw new RepositoryError(
      'The service returned duplicate conversation member candidates.',
      'invalid_response',
      true,
    );
  }
  const nextCursor = data.nextCursor;
  if (
    !(nextCursor === null || (
      typeof nextCursor === 'string' && nextCursor.length >= 1 && nextCursor.length <= 4096 &&
      /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(nextCursor) &&
      candidates.length === requestedLimit
    ))
  ) {
    throw new RepositoryError(
      'The service returned an invalid conversation member candidate cursor.',
      'invalid_response',
      true,
    );
  }
  return { candidates, nextCursor };
}

function parseJoinRequest(value: unknown): ConversationJoinRequest {
  const data = objectValue(value);
  const status = data.status;
  if (!['pending', 'approved', 'rejected', 'cancelled', 'expired'].includes(String(status))) {
    throw new RepositoryError('The service returned an invalid join request.', 'invalid_response', true);
  }
  return {
    requestId: requiredString(data.requestId, 'join request'),
    conversationId: requiredString(data.conversationId, 'join request conversation'),
    requesterUserId: requiredString(data.requesterUserId, 'join request member'),
    requesterDisplayName: typeof data.requesterDisplayName === 'string'
      ? data.requesterDisplayName
      : undefined,
    requesterAvatarPath: typeof data.requesterAvatarPath === 'string'
      ? data.requesterAvatarPath
      : null,
    status: status as ConversationJoinRequest['status'],
    version: requiredInteger(data.version, 'join request version', 1),
    requestedAt: requiredDate(data.requestedAt, 'join request creation time'),
    expiresAt: requiredDate(data.expiresAt, 'join request expiry'),
    decidedAt: nullableDate(data.decidedAt, 'join request decision time'),
  };
}

function parseDiscoverableConversation(value: unknown): DiscoverableConversation {
  const data = objectValue(value);
  const history = objectValue(data.historyDisclosure);
  if (
    !['group', 'team'].includes(String(data.kind)) ||
    !['organization', 'unit'].includes(String(data.visibility)) ||
    !['all_members', 'admins_only'].includes(String(data.postingMode)) ||
    data.joinPolicy !== 'approval_required' ||
    !['all', 'since_join'].includes(String(history.policy))
  ) {
    throw new RepositoryError('The service returned an invalid discoverable conversation.', 'invalid_response', true);
  }
  return {
    conversationId: requiredString(data.conversationId, 'discoverable conversation'),
    kind: data.kind as DiscoverableConversation['kind'],
    name: requiredString(data.name, 'discoverable conversation name'),
    description: typeof data.description === 'string' ? data.description : null,
    avatarPath: typeof data.avatarPath === 'string' ? data.avatarPath : null,
    visibility: data.visibility as DiscoverableConversation['visibility'],
    postingMode: data.postingMode as DiscoverableConversation['postingMode'],
    joinPolicy: 'approval_required',
    memberCount: requiredInteger(data.memberCount, 'discoverable conversation member count'),
    historyDisclosure: {
      policy: history.policy as 'all' | 'since_join',
      visibleFrom: typeof history.visibleFrom === 'string' ? history.visibleFrom : null,
      labelKey: history.labelKey === 'conversation.history.all'
        ? 'conversation.history.all'
        : 'conversation.history.since_join',
    },
    myJoinRequest: data.myJoinRequest == null ? null : parseJoinRequest({
      ...objectValue(data.myJoinRequest),
      conversationId: data.conversationId,
      requesterUserId: 'self',
    }),
  };
}

function parseUpdateAudienceSpec(
  value: unknown,
  fallback: UpdateAudienceSpec,
): UpdateAudienceSpec {
  const candidate = objectValue(value);
  const row = Object.keys(candidate).length ? candidate : fallback as unknown as Record<string, unknown>;
  const array = (entry: unknown, maximum: number, label: string) => {
    if (!Array.isArray(entry) || entry.length > maximum
      || entry.some((item) => typeof item !== 'string' || item.length === 0)
      || new Set(entry).size !== entry.length) {
      throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
    }
    return entry as string[];
  };
  if (typeof row.company !== 'boolean' || typeof row.conversationMembers !== 'boolean'
    || typeof row.currentShiftOnly !== 'boolean') {
    throw new RepositoryError('The service returned an invalid audience selector.', 'invalid_response', true);
  }
  const membershipRoles = array(row.membershipRoles, 4, 'audience access roles');
  if (membershipRoles.some((role) => !['owner', 'admin', 'manager', 'member'].includes(role))) {
    throw new RepositoryError('The service returned an invalid audience access role.', 'invalid_response', true);
  }
  return {
    company: row.company,
    conversationMembers: row.conversationMembers,
    siteIds: array(row.siteIds, 100, 'audience sites'),
    departmentIds: array(row.departmentIds, 100, 'audience departments'),
    teamIds: array(row.teamIds, 100, 'audience teams'),
    unitIds: array(row.unitIds, 100, 'audience units'),
    operationalRoles: array(row.roles ?? row.operationalRoles, 50, 'audience operational roles'),
    membershipRoles: membershipRoles as UpdateAudienceSpec['membershipRoles'],
    languages: array(row.languages, 20, 'audience languages'),
    currentShiftOnly: row.currentShiftOnly,
  };
}

function nullableDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

function requiredDate(value: unknown, label: string): string {
  const parsed = nullableDate(value, label);
  if (parsed) return parsed;
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

const TRANSLATION_ERROR_CATEGORIES = [
  'incorrect_meaning',
  'omitted_context',
  'terminology',
  'unsafe_wording',
  'wrong_language',
  'other',
] as const;
const SUMMARY_ERROR_CATEGORIES = [
  'unsupported_claim',
  'missing_source',
  'incorrect_action',
  'omitted_context',
  'unsafe_wording',
  'other',
] as const;

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, label);
}

const RESPONSE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function requiredUuidValue(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (RESPONSE_UUID_PATTERN.test(result)) return result;
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

function nullableUuidValue(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredUuidValue(value, label);
}

function parseAiOutputErrorReport(value: unknown): AiOutputErrorReport {
  const row = objectValue(value);
  const outputKind = row.outputKind;
  const categories = outputKind === 'translation'
    ? TRANSLATION_ERROR_CATEGORIES
    : SUMMARY_ERROR_CATEGORIES;
  const snapshot = objectValue(row.targetSnapshot);
  const translationId = nullableString(row.translationId, 'translation report target');
  const summaryId = nullableUuidValue(row.summaryId, 'summary report target');
  if (
    !hasOnlyKeys(row, [
      'reportId', 'outputKind', 'translationId', 'summaryId', 'conversationId', 'category',
      'details', 'highConsequence', 'qualityUseConsent', 'consentVersion',
      'targetSourceFingerprint', 'targetOutputFingerprint', 'targetLanguage', 'targetSnapshot',
      'status', 'outcome', 'version', 'reviewedByUserId', 'reviewedAt', 'reviewNote',
      'createdAt', 'updatedAt', 'deduplicated', 'originalsUnchanged',
    ])
    || !['translation', 'summary'].includes(String(outputKind))
    || !(categories as readonly unknown[]).includes(row.category)
    || (outputKind === 'translation' ? translationId === null || summaryId !== null : summaryId === null || translationId !== null)
    || (translationId !== null && !/^[1-9][0-9]{0,18}$/.test(translationId))
    || typeof row.highConsequence !== 'boolean'
    || typeof row.qualityUseConsent !== 'boolean'
    || !/^[0-9a-f]{64}$/.test(String(row.targetSourceFingerprint))
    || !/^[0-9a-f]{64}$/.test(String(row.targetOutputFingerprint))
    || !RESPONSE_LANGUAGE_PATTERN.test(String(row.targetLanguage))
    || !['open', 'reviewing', 'resolved', 'dismissed'].includes(String(row.status))
    || !([null, undefined, 'confirmed_error', 'not_an_error', 'needs_context'] as unknown[]).includes(row.outcome)
    || snapshot.schemaVersion !== 1
    || (outputKind === 'translation' && (
      String(snapshot.translationId) !== translationId
      || typeof snapshot.translatedBody !== 'string'
      || !/^[1-9][0-9]{0,18}$/.test(String(snapshot.messageId))
    ))
    || (outputKind === 'summary' && (
      snapshot.summaryId !== summaryId
      || typeof snapshot.summaryBody !== 'string'
      || !Array.isArray(snapshot.sourceMessageIds)
    ))
  ) throw new RepositoryError('The service returned an invalid AI output report.', 'invalid_response', true);
  return {
    reportId: requiredUuidValue(row.reportId, 'AI output report'),
    outputKind: outputKind as AiOutputErrorReport['outputKind'],
    translationId,
    summaryId,
    conversationId: requiredUuidValue(row.conversationId, 'AI output report conversation'),
    category: row.category as AiOutputErrorCategory,
    details: requiredString(row.details, 'AI output report details'),
    highConsequence: row.highConsequence,
    qualityUseConsent: row.qualityUseConsent,
    consentVersion: requiredString(row.consentVersion, 'AI quality consent version'),
    targetSourceFingerprint: requiredString(row.targetSourceFingerprint, 'AI source fingerprint'),
    targetOutputFingerprint: requiredString(row.targetOutputFingerprint, 'AI output fingerprint'),
    targetLanguage: requiredString(row.targetLanguage, 'AI output language'),
    targetSnapshot: snapshot,
    status: row.status as AiOutputErrorReport['status'],
    outcome: (row.outcome ?? null) as AiOutputErrorReport['outcome'],
    version: requiredInteger(row.version, 'AI output report version', 1),
    reviewedByUserId: nullableUuidValue(row.reviewedByUserId, 'AI output reviewer'),
    reviewedAt: nullableDate(row.reviewedAt, 'AI output review time'),
    reviewNote: nullableString(row.reviewNote, 'AI output review note'),
    createdAt: requiredDate(row.createdAt, 'AI output report creation time'),
    updatedAt: requiredDate(row.updatedAt, 'AI output report update time'),
  };
}

function parseAiRegressionExample(value: unknown): AiRegressionExample {
  const row = objectValue(value);
  if (
    !hasOnlyKeys(row, [
      'exampleId', 'reportId', 'outputKind', 'sourceLanguage', 'targetLanguage',
      'deidentifiedSourceText', 'deidentifiedObservedOutput', 'deidentifiedExpectedOutput',
      'errorCategory', 'consequenceLevel', 'attestationVersion', 'proposedByUserId',
      'proposedAt', 'status', 'version', 'decidedByUserId', 'decidedAt', 'decisionNote',
      'exportedAt', 'deduplicated',
    ])
    || !['translation', 'summary'].includes(String(row.outputKind))
    || ![...TRANSLATION_ERROR_CATEGORIES, ...SUMMARY_ERROR_CATEGORIES].includes(row.errorCategory as never)
    || !['standard', 'high_consequence'].includes(String(row.consequenceLevel))
    || !['pending', 'approved', 'rejected', 'exported'].includes(String(row.status))
    || !RESPONSE_LANGUAGE_PATTERN.test(String(row.sourceLanguage))
    || !RESPONSE_LANGUAGE_PATTERN.test(String(row.targetLanguage))
    || String(row.deidentifiedObservedOutput).trim() === String(row.deidentifiedExpectedOutput).trim()
    || (row.status === 'pending' && (
      row.decidedByUserId != null || row.decidedAt != null || row.decisionNote != null || row.exportedAt != null
    ))
    || (['approved', 'rejected', 'exported'].includes(String(row.status)) && (
      row.decidedByUserId == null || row.decidedAt == null || row.decisionNote == null
    ))
    || (row.status === 'exported' ? row.exportedAt == null : row.exportedAt != null)
  ) throw new RepositoryError('The service returned an invalid AI regression example.', 'invalid_response', true);
  return {
    exampleId: requiredUuidValue(row.exampleId, 'AI regression example'),
    reportId: requiredUuidValue(row.reportId, 'AI regression report'),
    outputKind: row.outputKind as AiRegressionExample['outputKind'],
    sourceLanguage: requiredString(row.sourceLanguage, 'AI regression source language'),
    targetLanguage: requiredString(row.targetLanguage, 'AI regression target language'),
    deidentifiedSourceText: requiredString(row.deidentifiedSourceText, 'deidentified source text'),
    deidentifiedObservedOutput: requiredString(row.deidentifiedObservedOutput, 'deidentified observed output'),
    deidentifiedExpectedOutput: requiredString(row.deidentifiedExpectedOutput, 'deidentified expected output'),
    errorCategory: row.errorCategory as AiOutputErrorCategory,
    consequenceLevel: row.consequenceLevel as AiRegressionExample['consequenceLevel'],
    attestationVersion: requiredString(row.attestationVersion, 'deidentification attestation'),
    proposedByUserId: requiredUuidValue(row.proposedByUserId, 'AI regression proposer'),
    proposedAt: requiredDate(row.proposedAt, 'AI regression proposal time'),
    status: row.status as AiRegressionExample['status'],
    version: requiredInteger(row.version, 'AI regression example version', 1),
    decidedByUserId: nullableUuidValue(row.decidedByUserId, 'AI regression decision reviewer'),
    decidedAt: nullableDate(row.decidedAt, 'AI regression decision time'),
    decisionNote: nullableString(row.decisionNote, 'AI regression decision note'),
    exportedAt: nullableDate(row.exportedAt, 'AI regression export time'),
  };
}

function parseAiOutputErrorReportDetail(value: unknown): AiOutputErrorReportDetail {
  const row = dataValue(value);
  if (!hasOnlyKeys(row, ['report', 'regressionExample'])) {
    throw new RepositoryError('The service returned an invalid AI output report detail.', 'invalid_response', true);
  }
  return {
    report: parseAiOutputErrorReport(row.report),
    regressionExample: row.regressionExample == null ? null : parseAiRegressionExample(row.regressionExample),
  };
}

function parseAcknowledgementSchema(value: unknown) {
  const schema = objectValue(value);
  const prompt = schema.attestationPrompt;
  const requiredKeys = schema.requiredKeys;
  if (
    !hasOnlyKeys(schema, [
      'schemaVersion',
      'attestationRequired',
      'attestationPrompt',
      'requiredKeys',
      'carryForwardOnCorrection',
    ])
    || schema.schemaVersion !== 1
    || typeof schema.attestationRequired !== 'boolean'
    || !(prompt === null || typeof prompt === 'string')
    || !Array.isArray(requiredKeys)
    || requiredKeys.length > 20
    || requiredKeys.some((key) => typeof key !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(key))
    || new Set(requiredKeys).size !== requiredKeys.length
    || schema.carryForwardOnCorrection !== false
    || (schema.attestationRequired
      ? typeof prompt !== 'string' || prompt.length < 3 || prompt.length > 500 || requiredKeys.length < 1
      : prompt !== null || requiredKeys.length !== 0)
  ) {
    throw new RepositoryError('The service returned an invalid acknowledgement policy.', 'invalid_response', true);
  }
  return {
    schemaVersion: 1 as const,
    attestationRequired: schema.attestationRequired,
    attestationPrompt: prompt as string | null,
    requiredKeys: requiredKeys as string[],
    carryForwardOnCorrection: false as const,
  };
}

function parseReminderPolicy(value: unknown) {
  const policy = objectValue(value);
  const deadlineAt = policy.deadlineAt;
  const intervalSeconds = policy.intervalSeconds;
  const maximumReminders = policy.maximumReminders;
  const escalateAfterSeconds = policy.escalateAfterSeconds;
  if (
    !hasOnlyKeys(policy, [
      'enabled',
      'deadlineAt',
      'intervalSeconds',
      'maximumReminders',
      'escalateAfterSeconds',
      'smsFallback',
    ])
    || typeof policy.enabled !== 'boolean'
    || !(deadlineAt === null || typeof deadlineAt === 'string')
    || !(intervalSeconds === null || Number.isInteger(intervalSeconds))
    || !Number.isInteger(maximumReminders)
    || !(escalateAfterSeconds === null || Number.isInteger(escalateAfterSeconds))
    || policy.smsFallback !== false
    || (policy.enabled
      ? typeof deadlineAt !== 'string'
        || !Number.isFinite(Date.parse(deadlineAt))
        || typeof intervalSeconds !== 'number'
        || intervalSeconds < 300
        || intervalSeconds > 604800
        || typeof maximumReminders !== 'number'
        || maximumReminders < 1
        || maximumReminders > 20
        || !(escalateAfterSeconds === null
          || (typeof escalateAfterSeconds === 'number'
            && escalateAfterSeconds >= 900
            && escalateAfterSeconds <= 2592000
            && escalateAfterSeconds >= intervalSeconds))
      : deadlineAt !== null
        || intervalSeconds !== null
        || maximumReminders !== 0
        || escalateAfterSeconds !== null)
  ) {
    throw new RepositoryError('The service returned an invalid reminder policy.', 'invalid_response', true);
  }
  return {
    enabled: policy.enabled,
    deadlineAt: deadlineAt as string | null,
    intervalSeconds: intervalSeconds as number | null,
    maximumReminders: maximumReminders as number,
    escalateAfterSeconds: escalateAfterSeconds as number | null,
    smsFallback: false as const,
  };
}

function parseManagedUpdateVersion(value: unknown): ManagedUpdateVersion {
  const version = objectValue(value);
  if (!hasOnlyKeys(version, [
    'announcementVersionId',
    'versionNumber',
    'title',
    'body',
    'publishedAt',
    'correctionOfVersionId',
    'correctionReason',
    'createdByUserId',
    'createdByDisplayName',
  ])) {
    throw new RepositoryError('The service returned an invalid announcement version.', 'invalid_response', true);
  }
  return {
    versionId: requiredString(version.announcementVersionId, 'announcement version'),
    versionNumber: requiredInteger(version.versionNumber, 'announcement version number', 1),
    title: requiredString(version.title, 'announcement version title'),
    body: requiredString(version.body, 'announcement version body'),
    publishedAt: nullableDate(version.publishedAt, 'announcement version publication time'),
    correctionOfVersionId: version.correctionOfVersionId === null || version.correctionOfVersionId === undefined
      ? null
      : requiredString(version.correctionOfVersionId, 'corrected announcement version'),
    correctionReason: version.correctionReason === null || version.correctionReason === undefined
      ? null
      : requiredString(version.correctionReason, 'announcement correction reason'),
    createdByUserId: requiredString(version.createdByUserId, 'announcement version author'),
    createdByDisplayName: requiredString(version.createdByDisplayName, 'announcement version author name'),
  };
}

function parseManagedUpdate(value: unknown): ManagedUpdate {
  const update = objectValue(value);
  const priority = update.priority;
  const notificationClass = update.notificationClass;
  const status = update.status;
  const criticalCategory = update.criticalCategory;
  const requiresAcknowledgement = update.requiresAcknowledgement;
  const audienceSnapshotted = update.audienceSnapshotted;
  if (
    !hasOnlyKeys(update, [
      'announcementId',
      'conversationId',
      'conversationTitle',
      'announcementVersionId',
      'versionNumber',
      'versionCount',
      'title',
      'body',
      'languageCode',
      'priority',
      'notificationClass',
      'criticalCategory',
      'quietHoursOverrideReason',
      'requiresAcknowledgement',
      'acknowledgementSchema',
      'reminderPolicy',
      'status',
      'scheduledAt',
      'publishedAt',
      'expiresAt',
      'cancelledAt',
      'cancellationReason',
      'correctionOfVersionId',
      'correctionReason',
      'audienceSnapshotted',
      'recipientCount',
      'deliveredCount',
      'readCount',
      'acknowledgedCount',
      'nonAcknowledgedCount',
      'overdueCount',
      'unreachableCount',
      'versions',
    ])
    || !['normal', 'important', 'emergency'].includes(String(priority))
    || !['routine', 'urgent', 'critical'].includes(String(notificationClass))
    || !['scheduled', 'published', 'cancelled', 'archived'].includes(String(status))
    || !(criticalCategory === null || criticalCategory === undefined
      || ['safety', 'security', 'operations', 'weather', 'business_continuity'].includes(String(criticalCategory)))
    || !['en', 'ko', 'es'].includes(String(update.languageCode))
    || !Array.isArray(update.versions)
    || typeof requiresAcknowledgement !== 'boolean'
    || typeof audienceSnapshotted !== 'boolean'
  ) {
    throw new RepositoryError('The service returned an invalid managed update.', 'invalid_response', true);
  }
  const parsed = {
    announcementId: requiredString(update.announcementId, 'announcement'),
    conversationId: requiredString(update.conversationId, 'announcement conversation'),
    conversationTitle: requiredString(update.conversationTitle, 'announcement conversation title'),
    versionId: requiredString(update.announcementVersionId, 'announcement version'),
    versionNumber: requiredInteger(update.versionNumber, 'announcement version number', 1),
    versionCount: requiredInteger(update.versionCount, 'announcement version count', 1),
    title: requiredString(update.title, 'announcement title'),
    body: requiredString(update.body, 'announcement body'),
    languageCode: update.languageCode as ManagedUpdate['languageCode'],
    priority: priority as ManagedUpdate['priority'],
    notificationClass: notificationClass as ManagedUpdate['notificationClass'],
    criticalCategory: (criticalCategory ?? null) as ManagedUpdate['criticalCategory'],
    quietHoursOverrideReason: update.quietHoursOverrideReason === null || update.quietHoursOverrideReason === undefined
      ? null
      : requiredString(update.quietHoursOverrideReason, 'quiet-hours override reason'),
    requiresAcknowledgement,
    acknowledgementSchema: parseAcknowledgementSchema(update.acknowledgementSchema),
    reminderPolicy: parseReminderPolicy(update.reminderPolicy),
    status: status as ManagedUpdate['status'],
    scheduledAt: nullableDate(update.scheduledAt, 'announcement schedule'),
    publishedAt: nullableDate(update.publishedAt, 'announcement publication time'),
    expiresAt: nullableDate(update.expiresAt, 'announcement expiry'),
    cancelledAt: nullableDate(update.cancelledAt, 'announcement cancellation time'),
    cancellationReason: update.cancellationReason === null || update.cancellationReason === undefined
      ? null
      : requiredString(update.cancellationReason, 'announcement cancellation reason'),
    correctionOfVersionId: update.correctionOfVersionId === null || update.correctionOfVersionId === undefined
      ? null
      : requiredString(update.correctionOfVersionId, 'corrected announcement version'),
    correctionReason: update.correctionReason === null || update.correctionReason === undefined
      ? null
      : requiredString(update.correctionReason, 'announcement correction reason'),
    audienceSnapshotted,
    recipientCount: requiredInteger(update.recipientCount, 'announcement recipient count'),
    deliveredCount: requiredInteger(update.deliveredCount, 'announcement delivered count'),
    readCount: requiredInteger(update.readCount, 'announcement read count'),
    acknowledgedCount: requiredInteger(update.acknowledgedCount, 'announcement acknowledgement count'),
    nonAcknowledgedCount: requiredInteger(update.nonAcknowledgedCount, 'announcement non-acknowledgement count'),
    overdueCount: requiredInteger(update.overdueCount, 'announcement overdue count'),
    unreachableCount: requiredInteger(update.unreachableCount, 'announcement unreachable count'),
    versions: update.versions.map(parseManagedUpdateVersion),
  };
  const expectedNotificationClass = parsed.priority === 'emergency'
    ? 'critical'
    : parsed.priority === 'important'
      ? 'urgent'
      : 'routine';
  const routineMetadataValid = parsed.notificationClass === 'routine'
    ? parsed.criticalCategory === null && parsed.quietHoursOverrideReason === null
    : parsed.criticalCategory !== null && parsed.quietHoursOverrideReason !== null;
  const statusDatesValid = parsed.status === 'scheduled'
    ? parsed.scheduledAt !== null && parsed.publishedAt === null && parsed.cancelledAt === null
    : parsed.status === 'cancelled'
      ? parsed.scheduledAt !== null && parsed.publishedAt === null
        && parsed.cancelledAt !== null && parsed.cancellationReason !== null
      : parsed.publishedAt !== null && parsed.cancelledAt === null;
  const countsValid = parsed.deliveredCount <= parsed.recipientCount
    && parsed.readCount <= parsed.deliveredCount
    && parsed.acknowledgedCount <= parsed.recipientCount
    && parsed.nonAcknowledgedCount <= parsed.recipientCount
    && parsed.overdueCount <= parsed.nonAcknowledgedCount
    && parsed.unreachableCount <= parsed.recipientCount
    && (!parsed.requiresAcknowledgement
      ? parsed.acknowledgedCount === 0 && parsed.nonAcknowledgedCount === 0 && parsed.overdueCount === 0
      : parsed.acknowledgedCount + parsed.nonAcknowledgedCount === parsed.recipientCount);
  const versionHistoryValid = parsed.versions.length >= 1
    && parsed.versions.length <= 20
    && parsed.versionCount >= parsed.versions.length
    && parsed.versions[0]?.versionId === parsed.versionId
    && parsed.versions[0]?.versionNumber === parsed.versionNumber
    && parsed.versions.every((version, index) =>
      index === 0 || version.versionNumber < parsed.versions[index - 1]!.versionNumber
    );
  if (
    parsed.notificationClass !== expectedNotificationClass
    || !routineMetadataValid
    || !statusDatesValid
    || !countsValid
    || !versionHistoryValid
    || (!parsed.requiresAcknowledgement
      && (parsed.acknowledgementSchema.attestationRequired || parsed.reminderPolicy.enabled))
  ) {
    throw new RepositoryError('The service returned an inconsistent managed update.', 'invalid_response', true);
  }
  return parsed;
}

function requiredStorageSignedUrl(value: unknown, action: 'upload' | 'download') {
  const signedUrl = resolveStorageSignedUrl({
    signedUrl: value,
    supabaseUrl: publicRuntimeConfig.supabase?.url ?? null,
    action,
  });
  if (signedUrl) return signedUrl;
  throw new RepositoryError(
    `The service returned an invalid ${action} destination.`,
    'invalid_response',
    false,
  );
}

function parseOrganizationPreferences(value: unknown): OrganizationPreferences {
  const data = objectValue(value);
  const uiLanguage = data.uiLanguage;
  const messageLanguage = data.messageLanguage;
  const preview = data.notificationPreview;
  const readVisibility = data.readVisibility;
  if (
    !['en', 'ko', 'es'].includes(String(uiLanguage)) ||
    !(messageLanguage === null || ['en', 'ko', 'es'].includes(String(messageLanguage))) ||
    !['generic', 'hidden'].includes(String(preview)) ||
    !['everyone', 'contacts', 'nobody'].includes(String(readVisibility)) ||
    !Array.isArray(data.quietDays)
  ) throw new RepositoryError('The service returned invalid organization preferences.', 'invalid_response', true);
  return {
    uiLanguage: uiLanguage as OrganizationPreferences['uiLanguage'],
    messageLanguage: messageLanguage as OrganizationPreferences['messageLanguage'],
    timeZone: requiredString(data.timeZone, 'time zone'),
    quietHoursStart: typeof data.quietHoursStart === 'string' ? data.quietHoursStart : null,
    quietHoursEnd: typeof data.quietHoursEnd === 'string' ? data.quietHoursEnd : null,
    quietDays: data.quietDays.filter((day): day is number => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6),
    notificationPreview: preview as OrganizationPreferences['notificationPreview'],
    soundEnabled: data.soundEnabled === true,
    vibrationEnabled: data.vibrationEnabled === true,
    shiftAwareSuppression: data.shiftAwareSuppression === true,
    readVisibility: readVisibility as OrganizationPreferences['readVisibility'],
  };
}

function parseSession(value: unknown): AccountSession {
  const data = objectValue(value);
  const rawDevice = data.device === null ? null : objectValue(data.device);
  const rawSignal = objectValue(data.signal);
  const platform = data.platform;
  const clientFamily = rawSignal.clientFamily;
  if (
    !(platform === null || ['ios', 'android', 'web'].includes(String(platform))) ||
    !['aal1', 'aal2'].includes(String(data.aal)) ||
    !['iphone', 'ipad', 'android', 'mobile', 'desktop', 'unknown'].includes(String(clientFamily))
  ) throw new RepositoryError('The service returned an invalid session.', 'invalid_response', true);
  return {
    sessionId: requiredString(data.sessionId, 'session'),
    current: data.current === true,
    platform: platform as AccountSession['platform'],
    device: rawDevice ? {
      installationId: requiredString(rawDevice.installationId, 'installation'),
      platform: requiredString(rawDevice.platform, 'device platform') as 'ios' | 'android' | 'web',
      appVersion: typeof rawDevice.appVersion === 'string' ? rawDevice.appVersion : null,
    } : null,
    createdAt: requiredString(data.createdAt, 'session creation time'),
    lastUsedAt: requiredString(data.lastUsedAt, 'session activity time'),
    expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : null,
    revoked: data.revoked === true,
    aal: data.aal as AccountSession['aal'],
    signal: {
      sameNetworkAsCurrent: rawSignal.sameNetworkAsCurrent === true,
      clientFamily: clientFamily as AccountSession['signal']['clientFamily'],
    },
  };
}

function parseRoleAssignment(value: unknown): AdminRoleAssignment {
  const data = objectValue(value);
  const roleName = data.roleName;
  const scopeType = data.scopeType;
  if (
    ![
      'security_admin',
      'people_admin',
      'communications_publisher',
      'site_admin',
      'language_reviewer',
      'supervisor',
      'employee',
      'designated_investigator',
    ].includes(String(roleName))
    || !['organization', 'unit'].includes(String(scopeType))
  ) throw new RepositoryError('The service returned an invalid role assignment.', 'invalid_response', true);
  return {
    assignmentId: requiredString(data.assignmentId, 'role assignment'),
    userId: requiredString(data.userId, 'role assignee'),
    roleName: roleName as AdminRoleAssignment['roleName'],
    scopeType: scopeType as AdminRoleAssignment['scopeType'],
    unitId: typeof data.unitId === 'string' ? data.unitId : null,
    grantedAt: requiredString(data.grantedAt, 'role grant time'),
    expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : null,
    revokedAt: typeof data.revokedAt === 'string' ? data.revokedAt : null,
    active: data.active === true,
  };
}

function parseIssuedInvitation(value: unknown): IssuedInvitation {
  const data = objectValue(value);
  const membershipType = data.membershipType;
  const expiresAt = requiredDate(data.expiresAt, 'invitation expiry');
  const membershipAccessExpiresAt = nullableDate(
    data.membershipAccessExpiresAt,
    'membership access expiry',
  );
  const guestSponsorUserId = nullableUuidValue(data.guestSponsorUserId, 'guest sponsor');
  if (
    !['admin', 'manager', 'member'].includes(String(data.role))
    || !['email', 'phone'].includes(String(data.destinationType))
    || !['otp', 'manual'].includes(String(data.activationMode))
    || !['employee', 'contractor', 'guest'].includes(String(membershipType))
    || !(data.activationToken === null || typeof data.activationToken === 'string')
    || (membershipType === 'employee' &&
      (membershipAccessExpiresAt !== null || guestSponsorUserId !== null))
    || (membershipType === 'contractor' &&
      (membershipAccessExpiresAt === null || guestSponsorUserId !== null ||
        Date.parse(membershipAccessExpiresAt) <= Date.parse(expiresAt)))
    || (membershipType === 'guest' &&
      (data.role !== 'member' || membershipAccessExpiresAt === null || guestSponsorUserId === null ||
        Date.parse(membershipAccessExpiresAt) <= Date.parse(expiresAt)))
  ) {
    throw new RepositoryError('The service returned an invalid invitation receipt.', 'invalid_response', false);
  }
  return {
    inviteId: requiredString(data.inviteId, 'invitation'),
    destinationType: data.destinationType as IssuedInvitation['destinationType'],
    destinationMasked: requiredString(data.destinationMasked, 'masked invitation destination'),
    role: data.role as IssuedInvitation['role'],
    activationMode: data.activationMode as IssuedInvitation['activationMode'],
    expiresAt,
    activationToken: typeof data.activationToken === 'string' ? data.activationToken : null,
    employeeCode: typeof data.employeeCode === 'string' ? data.employeeCode : null,
    membershipType: membershipType as IssuedInvitation['membershipType'],
    membershipAccessExpiresAt,
    guestSponsorUserId,
  };
}

async function parseAuditExport(value: unknown): Promise<AuditExportReceipt> {
  const data = objectValue(value);
  const format = data.format;
  const contentType = data.contentType;
  const payload = data.payload;
  const fileName = data.fileName;
  const sha256 = data.sha256;
  const rowCount = data.rowCount;
  const payloadBytes = data.payloadBytes;
  if (
    !['json', 'csv'].includes(String(format))
    || (format === 'json' ? contentType !== 'application/json' : contentType !== 'text/csv')
    || typeof payload !== 'string'
    || typeof fileName !== 'string'
    || !/^newone-audit-[0-9]{8}-[0-9]{6}\.(?:json|csv)$/.test(fileName)
    || typeof sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(sha256)
    || !Number.isInteger(rowCount) || Number(rowCount) < 0 || Number(rowCount) > 5000
    || !Number.isInteger(payloadBytes) || Number(payloadBytes) < 1 || Number(payloadBytes) > 2_000_000
    || new TextEncoder().encode(payload).byteLength !== payloadBytes
  ) throw new RepositoryError('The service returned an invalid audit export.', 'invalid_response', true);
  const observedSha256 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    payload,
  );
  if (observedSha256.toLowerCase() !== sha256) {
    throw new RepositoryError('The audit export failed integrity verification.', 'invalid_response', false);
  }
  return {
    receiptId: requiredString(data.receiptId, 'audit export receipt'),
    format: format as AuditExportReceipt['format'],
    contentType: contentType as AuditExportReceipt['contentType'],
    fileName,
    rowCount: Number(rowCount),
    payloadBytes: Number(payloadBytes),
    sha256,
    createdAt: requiredDate(data.createdAt, 'audit export time'),
    payload,
  };
}

export class BffCommandRepository implements CommandRepository {
  constructor(private readonly context: RepositoryContext) {}

  async exportAudit(input: Parameters<CommandRepository['exportAudit']>[0]) {
    const payload = await this.request('/v2/admin/audit/export', {
      organizationId: input.organizationId,
      maxResponseBytes: 4_500_000,
      body: {
        reasonCode: input.reasonCode,
        format: input.format,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        eventTypes: input.eventTypes ?? [],
        actorMembershipId: input.actorMembershipId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
      },
    });
    return await parseAuditExport(dataValue(payload));
  }

  private async request(
    path: string,
    input: {
      organizationId: string;
      idempotencyKey?: string;
      body?: Record<string, unknown>;
      method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      maxResponseBytes?: number;
    },
  ) {
    if (!publicRuntimeConfig.apiUrl) {
      throw new RepositoryError(
        'The Newone command service is not configured in this build.',
        'service_unconfigured',
        false,
      );
    }

    const session = await this.context.getSession();
    if (Platform.OS !== 'web' && !session?.access_token) {
      throw new RepositoryError('Sign in again to continue.', 'authentication_required', false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      const csrfToken = Platform.OS === 'web' ? getWebCsrfToken() : null;
      if (Platform.OS === 'web' && !csrfToken) {
        throw new RepositoryError('Your secure web session needs to be refreshed.', 'csrf_required', false);
      }
      const url = apiUrlFor(path as `/${string}`);
      if (!url) {
        throw new RepositoryError('The Newone command service is not configured.', 'service_unconfigured', false);
      }
      const edgeHeaders = nativeEdgeRequestHeaders(session?.access_token);
      if (!edgeHeaders) {
        throw new RepositoryError('The native command service is not configured.', 'service_unconfigured', false);
      }
      response = await fetch(url, {
        method: input.method ?? 'POST',
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          ...edgeHeaders,
        },
        body: JSON.stringify({ organizationId: input.organizationId, ...input.body }),
        signal: controller.signal,
      });
    } catch (requestError) {
      if (requestError instanceof RepositoryError) throw requestError;
      throw new RepositoryError(
        'Newone cannot reach the command service. Your action remains queued.',
        'network_unavailable',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }

    let payload: unknown = null;
    try {
      const maximum = input.maxResponseBytes ?? 2_000_000;
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maximum) {
        throw new RepositoryError('The service response exceeded its safe size.', 'response_too_large', false);
      }
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > maximum) {
        throw new RepositoryError('The service response exceeded its safe size.', 'response_too_large', false);
      }
      payload = JSON.parse(raw);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      // A malformed upstream response is classified below without echoing it.
    }
    if (!response.ok) {
      const root = objectValue(payload) as ErrorPayload;
      const problem = root.error ?? root;
      throw new RepositoryError(
        'The action was rejected by the Newone service.',
        problem.code || `http_${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        problem.correlationId,
        response.status,
      );
    }
    return payload;
  }

  async createDirectConversation(input: CreateDirectInput) {
    const payload = await this.request('/v2/conversations/direct', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        targetMembershipId: input.targetMembershipId,
      },
    });
    const data = dataValue(payload);
    const conversation = objectValue(data.conversation);
    const conversationId =
      data.conversationId ??
      data.conversation_id ??
      data.id ??
      conversation.conversationId ??
      conversation.conversation_id ??
      conversation.id;
    if (typeof conversationId !== 'string') {
      throw new RepositoryError('The service returned an invalid conversation.', 'invalid_response', true);
    }
    return { conversationId };
  }

  async listGroupCreationCandidates(
    input: Parameters<CommandRepository['listGroupCreationCandidates']>[0],
  ) {
    const payload = await this.request('/v2/conversations/group/candidates/query', {
      organizationId: input.organizationId,
      idempotencyKey: '',
      body: {
        query: input.query?.trim().slice(0, 120) ?? '',
        limit: input.limit ?? 50,
      },
    });
    try {
      return parseGroupCreationCandidates(dataValue(payload));
    } catch {
      throw new RepositoryError(
        'The service returned invalid group creation candidates.',
        'invalid_response',
        true,
      );
    }
  }

  async listConversationMemberCandidates(
    input: Parameters<CommandRepository['listConversationMemberCandidates']>[0],
  ) {
    const limit = input.limit ?? 50;
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/member-candidates/query`,
      {
        organizationId: input.organizationId,
        idempotencyKey: '',
        body: {
          query: input.query?.trim().slice(0, 120) ?? '',
          cursor: input.cursor ?? null,
          limit,
        },
      },
    );
    return parseConversationMemberCandidatePage(dataValue(payload), limit);
  }

  async createGroupConversation(input: CreateGroupInput) {
    const payload = await this.request('/v2/conversations/group', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        name: input.name,
        description: input.description ?? null,
        memberAssignments: input.memberAssignments,
        kind: input.kind,
        unitId: input.unitId ?? null,
        historyPolicy: input.historyPolicy,
        postingMode: input.postingMode,
        joinPolicy: input.joinPolicy,
        incidentSeverity: input.incidentSeverity ?? null,
        incidentClassification: input.incidentClassification ?? null,
      },
    });
    try {
      return parseGroupCreationReceipt(dataValue(payload));
    } catch {
      throw new RepositoryError(
        'The service returned an invalid group creation receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async updateConversation(input: Parameters<CommandRepository['updateConversation']>[0]) {
    await this.request(`/v2/conversations/${encodeURIComponent(input.conversationId)}`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'PATCH',
      body: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}),
      },
    });
  }

  async updateOrganizationConversationControls(
    input: Parameters<CommandRepository['updateOrganizationConversationControls']>[0],
  ) {
    await this.request('/v2/admin/conversation-controls', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'PATCH',
      body: {
        ...(input.defaultJoinPolicy !== undefined
          ? { defaultJoinPolicy: input.defaultJoinPolicy }
          : {}),
        ...(input.defaultGroupMemberLimit !== undefined
          ? { defaultGroupMemberLimit: input.defaultGroupMemberLimit }
          : {}),
        ...(input.joinRequestExpiryDays !== undefined
          ? { joinRequestExpiryDays: input.joinRequestExpiryDays }
          : {}),
        ...(input.maxPendingJoinRequestsPerUser !== undefined
          ? { maxPendingJoinRequestsPerUser: input.maxPendingJoinRequestsPerUser }
          : {}),
        reason: input.reason,
      },
    });
  }

  async updateOrganizationPolicy(
    input: Parameters<CommandRepository['updateOrganizationPolicy']>[0],
  ) {
    let policy;
    try {
      policy = normalizeOrganizationPolicyUpdate(input.policy);
    } catch {
      throw new RepositoryError('Enter a valid complete organization policy and audit reason.', 'invalid_request', false);
    }
    const payload = await this.request('/v2/admin/organization-policy', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'PATCH',
      body: {
        messageRetentionDays: policy.messageRetentionDays,
        allowMemberDirectMessages: policy.allowMemberDirectMessages,
        dmPolicy: policy.dmPolicy,
        requireMfaForAdmins: policy.requireMfaForAdmins,
        shiftScheduleAuthoritative: policy.shiftScheduleAuthoritative,
        groupCreationPolicy: policy.groupCreationPolicy,
        allowExternalGuests: policy.allowExternalGuests,
        externalGuestMaxAccessDays: policy.externalGuestMaxAccessDays,
        expectedVersion: policy.version,
        reason: policy.reason,
      },
    });
    try {
      return parseOrganizationPolicy(dataValue(payload));
    } catch {
      throw new RepositoryError(
        'The service returned an invalid organization policy receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async getOrganizationAiPolicy(
    input: Parameters<CommandRepository['getOrganizationAiPolicy']>[0],
  ) {
    const payload = await this.request('/v2/admin/ai-policy/query', {
      organizationId: input.organizationId,
    });
    try {
      return parseOrganizationAiPolicy(dataValue(payload), input.organizationId);
    } catch {
      throw new RepositoryError(
        'The service returned an invalid organization AI policy.',
        'invalid_response',
        true,
      );
    }
  }

  async updateOrganizationAiPolicy(
    input: Parameters<CommandRepository['updateOrganizationAiPolicy']>[0],
  ) {
    let policy;
    try {
      policy = normalizeOrganizationAiPolicyUpdate(input.policy);
    } catch {
      throw new RepositoryError(
        'Enter a valid organization AI policy and audit reason.',
        'invalid_request',
        false,
      );
    }
    const payload = await this.request('/v2/admin/ai-policy', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'PATCH',
      body: { ...policy },
    });
    try {
      return parseOrganizationAiPolicyUpdateReceipt(
        dataValue(payload),
        input.organizationId,
        policy,
      );
    } catch {
      throw new RepositoryError(
        'The service returned an invalid organization AI policy receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async listDynamicGroupPolicies(
    input: Parameters<CommandRepository['listDynamicGroupPolicies']>[0],
  ) {
    const limit = input.limit ?? 50;
    const payload = await this.request('/v2/dynamic-groups/policies/query', {
      organizationId: input.organizationId,
      body: { afterPolicyId: input.afterPolicyId ?? null, limit },
    });
    try {
      const page = parseDynamicGroupPolicyList(dataValue(payload));
      if (page.limit !== limit) throw new TypeError('Mismatched policy page limit.');
      return page;
    } catch {
      throw new RepositoryError(
        'The service returned an invalid dynamic-group policy page.',
        'invalid_response',
        true,
      );
    }
  }

  async saveDynamicGroupPolicy(
    input: Parameters<CommandRepository['saveDynamicGroupPolicy']>[0],
  ) {
    let policySpec;
    try {
      policySpec = parseDynamicGroupPolicySpec(input.policySpec);
    } catch {
      throw new RepositoryError('Enter a valid dynamic-group selector.', 'invalid_request', false);
    }
    const payload = await this.request('/v2/dynamic-groups/policies', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        conversationId: input.conversationId,
        policyId: input.policyId ?? null,
        expectedVersion: input.expectedVersion,
        policySpec,
        maximumMembers: input.maximumMembers,
      },
    });
    try {
      const receipt = parseDynamicGroupSaveReceipt(dataValue(payload));
      const expectedReceiptVersion = input.policyId ? input.expectedVersion + 1 : 1;
      if (
        receipt.conversationId !== input.conversationId ||
        receipt.version !== expectedReceiptVersion ||
        (input.policyId && receipt.policyId !== input.policyId)
      ) throw new TypeError('Mismatched dynamic-group save receipt.');
      return receipt;
    } catch {
      throw new RepositoryError(
        'The service returned an invalid dynamic-group save receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async previewDynamicGroupPolicy(
    input: Parameters<CommandRepository['previewDynamicGroupPolicy']>[0],
  ) {
    const payload = await this.request(
      `/v2/dynamic-groups/${encodeURIComponent(input.policyId)}/preview`,
      {
        organizationId: input.organizationId,
        body: {
          expectedVersion: input.expectedVersion,
          sampleLimit: input.sampleLimit ?? 50,
        },
      },
    );
    try {
      const receipt = parseDynamicGroupPreviewReceipt(dataValue(payload));
      if (receipt.policyId !== input.policyId || receipt.policyVersion !== input.expectedVersion) {
        throw new TypeError('Mismatched dynamic-group preview receipt.');
      }
      return receipt;
    } catch {
      throw new RepositoryError(
        'The service returned an invalid dynamic-group preview receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async publishDynamicGroupPolicy(
    input: Parameters<CommandRepository['publishDynamicGroupPolicy']>[0],
  ) {
    const payload = await this.request(
      `/v2/dynamic-groups/${encodeURIComponent(input.policyId)}/publish`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          expectedVersion: input.expectedVersion,
          previewFingerprint: input.previewFingerprint,
        },
      },
    );
    try {
      const receipt = parseDynamicGroupPublishReceipt(dataValue(payload));
      if (receipt.policyId !== input.policyId || receipt.policyVersion !== input.expectedVersion) {
        throw new TypeError('Mismatched dynamic-group publish receipt.');
      }
      return receipt;
    } catch {
      throw new RepositoryError(
        'The service returned an invalid dynamic-group publish receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async pauseDynamicGroupPolicy(
    input: Parameters<CommandRepository['pauseDynamicGroupPolicy']>[0],
  ) {
    const payload = await this.request(
      `/v2/dynamic-groups/${encodeURIComponent(input.policyId)}/pause`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: { expectedVersion: input.expectedVersion, reason: input.reason },
      },
    );
    try {
      const receipt = parseDynamicGroupPauseReceipt(dataValue(payload));
      if (receipt.policyId !== input.policyId || receipt.policyVersion !== input.expectedVersion) {
        throw new TypeError('Mismatched dynamic-group pause receipt.');
      }
      return receipt;
    } catch {
      throw new RepositoryError(
        'The service returned an invalid dynamic-group pause receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async updateConversationControls(
    input: Parameters<CommandRepository['updateConversationControls']>[0],
  ) {
    const payload = await this.request(`/v2/conversations/${encodeURIComponent(input.conversationId)}/controls`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'PATCH',
      body: {
        ...(input.postingMode !== undefined ? { postingMode: input.postingMode } : {}),
        ...(input.joinPolicy !== undefined ? { joinPolicy: input.joinPolicy } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        reason: input.reason,
      },
    });
    const data = dataValue(payload);
    if (
      !['all_members', 'admins_only'].includes(String(data.postingMode)) ||
      !['inherit', 'invite_only', 'approval_required'].includes(String(data.configuredJoinPolicy)) ||
      !['invite_only', 'approval_required'].includes(String(data.joinPolicy)) ||
      !['invite_only', 'organization', 'unit'].includes(String(data.visibility))
    ) throw new RepositoryError('The service returned invalid conversation controls.', 'invalid_response', true);
    return {
      conversationId: requiredString(data.conversationId, 'conversation'),
      postingMode: data.postingMode as 'all_members' | 'admins_only',
      configuredJoinPolicy: data.configuredJoinPolicy as 'inherit' | 'invite_only' | 'approval_required',
      joinPolicy: data.joinPolicy as 'invite_only' | 'approval_required',
      visibility: data.visibility as 'invite_only' | 'organization' | 'unit',
    };
  }

  async requestConversationJoin(
    input: Parameters<CommandRepository['requestConversationJoin']>[0],
  ) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/join-requests`,
      { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey },
    );
    return parseJoinRequest(dataValue(payload));
  }

  async cancelConversationJoinRequest(
    input: Parameters<CommandRepository['cancelConversationJoinRequest']>[0],
  ) {
    const payload = await this.request(
      `/v2/conversation-join-requests/${encodeURIComponent(input.requestId)}/cancel`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: { expectedVersion: input.expectedVersion },
      },
    );
    return parseJoinRequest(dataValue(payload));
  }

  async decideConversationJoinRequest(
    input: Parameters<CommandRepository['decideConversationJoinRequest']>[0],
  ) {
    const payload = await this.request(
      `/v2/conversation-join-requests/${encodeURIComponent(input.requestId)}/decision`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          expectedVersion: input.expectedVersion,
          decision: input.decision,
          reason: input.reason,
        },
      },
    );
    return parseJoinRequest(dataValue(payload));
  }

  async listDiscoverableConversations(
    input: Parameters<CommandRepository['listDiscoverableConversations']>[0],
  ) {
    const payload = await this.request('/v2/conversations/discover/query', {
      organizationId: input.organizationId,
      idempotencyKey: '',
      body: { limit: input.limit ?? 50 },
    });
    const data = dataValue(payload);
    if (!Array.isArray(data.conversations)) {
      throw new RepositoryError('The service returned an invalid conversation directory.', 'invalid_response', true);
    }
    return data.conversations.map(parseDiscoverableConversation);
  }

  async listConversationJoinRequests(
    input: Parameters<CommandRepository['listConversationJoinRequests']>[0],
  ) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/join-requests/query`,
      {
        organizationId: input.organizationId,
        idempotencyKey: '',
        body: { limit: input.limit ?? 100 },
      },
    );
    const data = dataValue(payload);
    if (!Array.isArray(data.joinRequests)) {
      throw new RepositoryError('The service returned an invalid join request queue.', 'invalid_response', true);
    }
    return data.joinRequests.map(parseJoinRequest);
  }

  async updateConversationPreferences(
    input: Parameters<CommandRepository['updateConversationPreferences']>[0],
  ) {
    await this.request(`/v2/conversations/${encodeURIComponent(input.conversationId)}/preferences`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'PATCH',
      body: {
        ...(input.isFavorite !== undefined ? { isFavorite: input.isFavorite } : {}),
        ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
        ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}),
        ...(input.notificationLevel !== undefined ? { notificationLevel: input.notificationLevel } : {}),
        ...(input.mutedUntil !== undefined ? { mutedUntil: input.mutedUntil } : {}),
        ...(input.translationMode !== undefined ? { translationMode: input.translationMode } : {}),
      },
    });
  }

  async addConversationMember(input: Parameters<CommandRepository['addConversationMember']>[0]) {
    const payload = await this.request(`/v2/conversations/${encodeURIComponent(input.conversationId)}/members`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: { membershipId: input.membershipId, role: input.role ?? 'member' },
    });
    const data = dataValue(payload);
    const historyPolicy = data.historyPolicy;
    const disclosure = objectValue(data.historyDisclosure);
    if (!['all', 'since_join'].includes(String(historyPolicy))) {
      throw new RepositoryError('The service returned an invalid conversation history receipt.', 'invalid_response', true);
    }
    return {
      historyVisibleFrom: typeof data.historyVisibleFrom === 'string' ? data.historyVisibleFrom : null,
      historyPolicy: historyPolicy as 'all' | 'since_join',
      historyDisclosure: {
        policy: disclosure.policy === 'all' ? 'all' as const : 'since_join' as const,
        visibleFrom: typeof disclosure.visibleFrom === 'string' ? disclosure.visibleFrom : null,
        labelKey: disclosure.labelKey === 'conversation.history.all'
          ? 'conversation.history.all' as const
          : 'conversation.history.since_join' as const,
      },
    };
  }

  async removeConversationMember(input: Parameters<CommandRepository['removeConversationMember']>[0]) {
    await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/members/${encodeURIComponent(input.membershipId)}`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        method: 'DELETE',
      },
    );
  }

  async updateConversationMemberRole(
    input: Parameters<CommandRepository['updateConversationMemberRole']>[0],
  ) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/members/${encodeURIComponent(input.membershipId)}/role`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        method: 'PATCH',
        body: { expectedRole: input.expectedRole, newRole: input.newRole },
      },
    );
    try {
      const receipt = parseConversationMemberRoleReceipt(dataValue(payload));
      if (
        receipt.conversationId !== input.conversationId ||
        receipt.userId !== input.membershipId ||
        receipt.previousRole !== input.expectedRole ||
        receipt.role !== input.newRole
      ) throw new TypeError('Mismatched conversation member role receipt.');
      return receipt;
    } catch {
      throw new RepositoryError(
        'The service returned an invalid conversation member role receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async createConversationAvatarUploadGrant(
    input: Parameters<CommandRepository['createConversationAvatarUploadGrant']>[0],
  ) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/avatar/grants`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          fileName: input.fileName,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          sha256Hex: input.sha256Hex,
        },
      },
    );
    try {
      const grant = parseConversationAvatarUploadGrant(dataValue(payload).grant);
      const path = grant.path.split('/');
      if (
        path[0] !== input.organizationId || path[1] !== input.conversationId ||
        path[3] !== grant.attachmentId
      ) throw new TypeError('Mismatched conversation avatar upload path.');
      return {
        ...grant,
        signedUrl: requiredStorageSignedUrl(grant.signedUrl, 'upload'),
      };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        'The service returned an invalid conversation avatar upload grant.',
        'invalid_response',
        true,
      );
    }
  }

  async getConversationAvatarReadGrant(
    input: Parameters<CommandRepository['getConversationAvatarReadGrant']>[0],
  ) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/avatar/query`,
      {
        organizationId: input.organizationId,
        body: { attachmentId: input.attachmentId },
      },
    );
    try {
      const grant = parseConversationAvatarReadGrant(dataValue(payload));
      if (grant.attachmentId !== input.attachmentId) {
        throw new TypeError('Mismatched conversation avatar read grant.');
      }
      return {
        ...grant,
        signedUrl: requiredStorageSignedUrl(grant.signedUrl, 'download'),
      };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        'The service returned an invalid conversation avatar read grant.',
        'invalid_response',
        true,
      );
    }
  }

  async activateConversationAvatar(
    input: Parameters<CommandRepository['activateConversationAvatar']>[0],
  ) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/avatar/${encodeURIComponent(input.attachmentId)}/activate`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: { expectedAvatarPath: input.expectedAvatarPath },
      },
    );
    try {
      const receipt = parseConversationAvatarActivationReceipt(dataValue(payload));
      if (
        receipt.conversationId !== input.conversationId ||
        receipt.attachmentId !== input.attachmentId ||
        receipt.previousAvatarPath !== input.expectedAvatarPath ||
        receipt.avatarPath.split('/')[0] !== input.organizationId ||
        receipt.avatarPath.split('/')[1] !== input.conversationId ||
        receipt.avatarPath.split('/')[3] !== input.attachmentId
      ) throw new TypeError('Mismatched conversation avatar activation receipt.');
      return receipt;
    } catch {
      throw new RepositoryError(
        'The service returned an invalid conversation avatar activation receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async removeConversationAvatar(
    input: Parameters<CommandRepository['removeConversationAvatar']>[0],
  ) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/avatar`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        method: 'DELETE',
        body: { expectedAvatarPath: input.expectedAvatarPath },
      },
    );
    try {
      const receipt = parseConversationAvatarRemovalReceipt(dataValue(payload));
      if (
        receipt.conversationId !== input.conversationId ||
        receipt.previousAvatarPath !== input.expectedAvatarPath
      ) throw new TypeError('Mismatched conversation avatar removal receipt.');
      return receipt;
    } catch {
      throw new RepositoryError(
        'The service returned an invalid conversation avatar removal receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async leaveConversation(input: Parameters<CommandRepository['leaveConversation']>[0]) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/leave`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          replacementOwnerMembershipId: input.replacementOwnerMembershipId ?? null,
          confirmHistoryAndAccessLoss: input.confirmHistoryAndAccessLoss,
        },
      },
    );
    try {
      return parseConversationDepartureReceipt(dataValue(payload), input.conversationId);
    } catch {
      throw new RepositoryError(
        'The service returned an invalid conversation departure receipt.',
        'invalid_response',
        true,
      );
    }
  }

  async closeIncident(input: Parameters<CommandRepository['closeIncident']>[0]) {
    await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/incident/close`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: { reason: input.reason },
      },
    );
  }

  async sendMessage(input: SendMessageInput) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/messages`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          clientMessageId: input.clientMessageId,
          body: input.body,
          kind: input.kind ?? 'text',
          languageCode: input.languageCode,
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
          ...(input.mentionUserIds?.length ? { mentionUserIds: input.mentionUserIds } : {}),
        },
      },
    );
    const data = dataValue(payload);
    const result = objectValue(data.result);
    const directMessage = objectValue(data.message);
    const resultMessage = objectValue(result.message);
    const message = Object.keys(directMessage).length
      ? directMessage
      : Object.keys(resultMessage).length
        ? resultMessage
        : result;
    const messageId =
      data.messageId ?? data.message_id ?? data.id ?? message.messageId ?? message.message_id ?? message.id;
    const clientMessageId =
      data.clientMessageId ??
      data.client_message_id ??
      message.clientMessageId ??
      message.client_message_id ??
      message.client_nonce ??
      input.clientMessageId;
    const cursor = data.cursor ?? data.next_cursor ?? message.cursor ?? message.next_cursor ?? null;
    const rawTranslationTargets = data.translationTargets
      ?? data.translation_targets
      ?? message.translationTargets
      ?? message.translation_targets;
    if (
      (typeof messageId !== 'string' && typeof messageId !== 'number')
      || typeof clientMessageId !== 'string'
      || !Array.isArray(rawTranslationTargets)
      || rawTranslationTargets.length > 50
      || rawTranslationTargets.some((language) => typeof language !== 'string')
    ) {
      throw new RepositoryError('The service returned an invalid message receipt.', 'invalid_response', true);
    }
    return {
      messageId: String(messageId),
      clientMessageId,
      cursor: typeof cursor === 'string' || cursor === null ? cursor : String(cursor),
      translationTargets: rawTranslationTargets as string[],
    };
  }

  async markMessageReceipt(input: Parameters<CommandRepository['markMessageReceipt']>[0]) {
    const payload = await this.request(
      `/v2/messages/${encodeURIComponent(input.messageId)}/receipt`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          conversationId: input.conversationId,
          state: input.state,
        },
      },
    );
    const data = dataValue(payload);
    const deliveredAt = data.deliveredAt;
    const readAt = data.readAt ?? null;
    if (
      String(data.conversationId) !== input.conversationId
      || String(data.messageId) !== input.messageId
      || data.scope !== 'self'
      || typeof deliveredAt !== 'string'
      || Number.isNaN(Date.parse(deliveredAt))
      || (readAt !== null && (typeof readAt !== 'string' || Number.isNaN(Date.parse(readAt))))
      || (input.state === 'read' && readAt === null)
    ) {
      throw new RepositoryError('The service returned an invalid receipt transition.', 'invalid_response', true);
    }
    return {
      conversationId: input.conversationId,
      messageId: input.messageId,
      scope: 'self' as const,
      deliveredAt,
      readAt: readAt as string | null,
    };
  }

  async requestTranslation(input: Parameters<CommandRepository['requestTranslation']>[0]) {
    const payload = await this.request(
      `/v2/messages/${encodeURIComponent(input.messageId)}/translations`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          conversationId: input.conversationId,
          targetLanguage: input.targetLanguage,
        },
      },
    );
    const data = dataValue(payload);
    if (data.status !== 'queued' || typeof data.retried !== 'boolean') {
      throw new RepositoryError('The service returned an invalid translation request.', 'invalid_response', true);
    }
    return {
      translationId: requiredString(data.translationId, 'translation'),
      status: 'queued' as const,
      retried: data.retried,
    };
  }

  async proposeTranslationCorrection(
    input: Parameters<CommandRepository['proposeTranslationCorrection']>[0],
  ) {
    const payload = await this.request(
      `/v2/messages/${encodeURIComponent(input.messageId)}/translations/${encodeURIComponent(input.targetLanguage)}/corrections`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          conversationId: input.conversationId,
          correctedBody: input.correctedBody,
          rationale: input.rationale ?? null,
        },
      },
    );
    const data = dataValue(payload);
    if (data.status !== 'pending') {
      throw new RepositoryError('The service returned an invalid correction request.', 'invalid_response', true);
    }
    return {
      correctionId: requiredString(data.correctionId, 'translation correction'),
      status: 'pending' as const,
    };
  }

  async reviewTranslationCorrection(
    input: Parameters<CommandRepository['reviewTranslationCorrection']>[0],
  ) {
    const payload = await this.request(
      `/v2/translation-corrections/${encodeURIComponent(input.correctionId)}/review`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: { decision: input.decision, note: input.note ?? null },
      },
    );
    const data = dataValue(payload);
    const reviewedAt = requiredString(data.reviewedAt, 'translation correction review time');
    if (
      String(data.correctionId) !== input.correctionId
      || data.decision !== input.decision
      || Number.isNaN(Date.parse(reviewedAt))
    ) {
      throw new RepositoryError('The service returned an invalid correction review.', 'invalid_response', true);
    }
    return {
      correctionId: input.correctionId,
      decision: input.decision,
      reviewedAt,
    };
  }

  async requestConversationSummary(
    input: Parameters<CommandRepository['requestConversationSummary']>[0],
  ) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/summaries`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          sourceMessageIds: input.sourceMessageIds,
          languageCode: input.languageCode,
        },
      },
    );
    const data = dataValue(payload);
    const status = data.status;
    const versionNumber = Number(data.versionNumber);
    const sourceFingerprint = requiredString(data.sourceFingerprint, 'summary source fingerprint');
    if (
      !['queued', 'processing', 'draft', 'approved', 'failed', 'stale'].includes(String(status))
      || !Number.isSafeInteger(versionNumber)
      || versionNumber < 1
      || !/^[0-9a-f]{64}$/.test(sourceFingerprint)
      || typeof data.deduplicated !== 'boolean'
    ) {
      throw new RepositoryError('The service returned an invalid summary request.', 'invalid_response', true);
    }
    return {
      summaryId: requiredString(data.summaryId, 'summary'),
      versionNumber,
      status: status as Awaited<ReturnType<CommandRepository['requestConversationSummary']>>['status'],
      sourceFingerprint,
      deduplicated: data.deduplicated,
    };
  }

  async createManualSummary(input: Parameters<CommandRepository['createManualSummary']>[0]) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/summaries/manual`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          sourceMessageIds: input.sourceMessageIds,
          languageCode: input.languageCode,
          primaryTopic: input.primaryTopic,
          summary: input.summary,
          keyTopics: input.keyTopics,
          decisions: input.decisions,
          actionItems: input.actionItems,
          ambiguities: input.ambiguities,
        },
      },
    );
    const data = dataValue(payload);
    const versionNumber = Number(data.versionNumber);
    const outputFingerprint = requiredString(data.outputFingerprint, 'summary output fingerprint');
    if (
      data.status !== 'draft'
      || !Number.isSafeInteger(versionNumber)
      || versionNumber < 1
      || !/^[0-9a-f]{64}$/.test(outputFingerprint)
    ) {
      throw new RepositoryError('The service returned an invalid manual summary.', 'invalid_response', true);
    }
    return {
      summaryId: requiredString(data.summaryId, 'summary'),
      versionNumber,
      status: 'draft' as const,
      outputFingerprint,
    };
  }

  async reviewConversationSummary(
    input: Parameters<CommandRepository['reviewConversationSummary']>[0],
  ) {
    const payload = await this.request(
      `/v2/summaries/${encodeURIComponent(input.summaryId)}/review`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: { decision: input.decision, note: input.note ?? null },
      },
    );
    const data = dataValue(payload);
    const expectedStatus: 'approved' | 'failed' = input.decision === 'approve'
      ? 'approved'
      : 'failed';
    if (
      String(data.summaryId) !== input.summaryId
      || data.status !== expectedStatus
      || data.humanReviewed !== true
    ) {
      throw new RepositoryError('The service returned an invalid summary review.', 'invalid_response', true);
    }
    return {
      summaryId: input.summaryId,
      status: expectedStatus,
      humanReviewed: true as const,
    };
  }

  async reportAiOutputError(
    input: Parameters<CommandRepository['reportAiOutputError']>[0],
  ) {
    const payload = await this.request('/v2/ai-output-error-reports', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        outputKind: input.outputKind,
        translationId: input.translationId ?? null,
        summaryId: input.summaryId ?? null,
        category: input.category,
        details: input.details,
        highConsequence: input.highConsequence,
        qualityUseConsent: input.qualityUseConsent,
        consentVersion: input.consentVersion,
      },
    });
    const data = dataValue(payload);
    if (typeof data.deduplicated !== 'boolean' || data.originalsUnchanged !== true) {
      throw new RepositoryError('The service returned an invalid AI output report receipt.', 'invalid_response', true);
    }
    return {
      ...parseAiOutputErrorReport(data),
      deduplicated: data.deduplicated,
      originalsUnchanged: true as const,
    };
  }

  async listMyAiOutputErrorReports(
    input: Parameters<CommandRepository['listMyAiOutputErrorReports']>[0],
  ) {
    return this.listAiOutputErrorReports('/v2/ai-output-error-reports/self/query', input);
  }

  async listAiOutputErrorReportsForReview(
    input: Parameters<CommandRepository['listAiOutputErrorReportsForReview']>[0],
  ) {
    return this.listAiOutputErrorReports('/v2/ai-output-error-reports/review/query', input);
  }

  private async listAiOutputErrorReports(
    path: string,
    input: { organizationId: string; limit?: number },
  ) {
    const payload = await this.request(path, {
      organizationId: input.organizationId,
      body: { limit: input.limit ?? 50 },
    });
    const data = dataValue(payload);
    if (!hasOnlyKeys(data, ['reports']) || !Array.isArray(data.reports)) {
      throw new RepositoryError('The service returned an invalid AI output report list.', 'invalid_response', true);
    }
    return data.reports.map(parseAiOutputErrorReport);
  }

  async readAiOutputErrorReport(
    input: Parameters<CommandRepository['readAiOutputErrorReport']>[0],
  ) {
    const payload = await this.request(
      `/v2/ai-output-error-reports/${encodeURIComponent(input.reportId)}/query`,
      { organizationId: input.organizationId },
    );
    return parseAiOutputErrorReportDetail(payload);
  }

  async reviewAiOutputErrorReport(
    input: Parameters<CommandRepository['reviewAiOutputErrorReport']>[0],
  ) {
    const payload = await this.request(
      `/v2/ai-output-error-reports/${encodeURIComponent(input.reportId)}/review`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          expectedVersion: input.expectedVersion,
          outcome: input.outcome,
          reviewNote: input.reviewNote,
        },
      },
    );
    const data = dataValue(payload);
    if (data.originalsUnchanged !== true) {
      throw new RepositoryError('The service returned an invalid AI output review receipt.', 'invalid_response', true);
    }
    return { ...parseAiOutputErrorReport(data), originalsUnchanged: true as const };
  }

  async proposeAiRegressionExample(
    input: Parameters<CommandRepository['proposeAiRegressionExample']>[0],
  ) {
    const payload = await this.request(
      `/v2/ai-output-error-reports/${encodeURIComponent(input.reportId)}/regression-examples`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          expectedReportVersion: input.expectedReportVersion,
          sourceLanguage: input.sourceLanguage,
          deidentifiedSourceText: input.deidentifiedSourceText,
          deidentifiedObservedOutput: input.deidentifiedObservedOutput,
          deidentifiedExpectedOutput: input.deidentifiedExpectedOutput,
          deidentificationAttested: input.deidentificationAttested,
          attestationVersion: input.attestationVersion,
        },
      },
    );
    const data = dataValue(payload);
    if (typeof data.deduplicated !== 'boolean') {
      throw new RepositoryError('The service returned an invalid AI regression proposal.', 'invalid_response', true);
    }
    return { ...parseAiRegressionExample(data), deduplicated: data.deduplicated };
  }

  async decideAiRegressionExample(
    input: Parameters<CommandRepository['decideAiRegressionExample']>[0],
  ) {
    const payload = await this.request(
      `/v2/ai-regression-examples/${encodeURIComponent(input.exampleId)}/decision`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          expectedVersion: input.expectedVersion,
          decision: input.decision,
          decisionNote: input.decisionNote,
        },
      },
    );
    return parseAiRegressionExample(dataValue(payload));
  }

  async setSummaryPolicy(input: Parameters<CommandRepository['setSummaryPolicy']>[0]) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/summary-policy`,
      {
        method: 'PUT',
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          mode: input.mode,
          ...(input.messageCountThreshold == null
            ? {}
            : { messageCountThreshold: input.messageCountThreshold }),
        },
      },
    );
    const data = dataValue(payload);
    if (
      String(data.conversationId) !== input.conversationId
      || data.mode !== input.mode
      || data.humanReviewRequired !== true
      || data.automaticPublish !== false
    ) {
      throw new RepositoryError('The service returned an invalid summary policy.', 'invalid_response', true);
    }
  }

  async editMessage(input: Parameters<CommandRepository['editMessage']>[0]) {
    await this.request(`/v2/messages/${encodeURIComponent(input.messageId)}`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'PATCH',
      body: { conversationId: input.conversationId, body: input.body },
    });
  }

  async deleteMessage(input: Parameters<CommandRepository['deleteMessage']>[0]) {
    await this.request(`/v2/messages/${encodeURIComponent(input.messageId)}`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'PATCH',
      body: { conversationId: input.conversationId, delete: true },
    });
  }

  async hideMessageForMe(input: Parameters<CommandRepository['hideMessageForMe']>[0]) {
    await this.request(`/v2/messages/${encodeURIComponent(input.messageId)}/hide`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: { conversationId: input.conversationId },
    });
  }

  async forwardMessage(input: Parameters<CommandRepository['forwardMessage']>[0]) {
    const payload = await this.request(`/v2/messages/${encodeURIComponent(input.sourceMessageId)}/forward`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        sourceConversationId: input.sourceConversationId,
        targetConversationId: input.targetConversationId,
        clientMessageId: input.clientMessageId,
      },
    });
    const data = dataValue(payload);
    return {
      messageId: requiredString(data.messageId ?? data.id, 'forwarded message'),
      clientMessageId: requiredString(data.clientMessageId ?? input.clientMessageId, 'forward client message'),
    };
  }

  async placeMessagePreservationHold(
    input: Parameters<CommandRepository['placeMessagePreservationHold']>[0],
  ) {
    const payload = await this.request(
      `/v2/admin/messages/${encodeURIComponent(input.messageId)}/preservation-holds`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          conversationId: input.conversationId,
          holdType: input.holdType,
          reasonCode: input.reasonCode,
          policyReferenceSha256: input.policyReferenceSha256,
        },
      },
    );
    const data = dataValue(payload);
    const holdType = requiredString(data.holdType, 'preservation hold type');
    if (!['legal', 'incident_preservation'].includes(holdType) || data.active !== true) {
      throw new RepositoryError('The service returned an invalid preservation hold.', 'invalid_response', true);
    }
    return {
      holdId: requiredString(data.holdId, 'preservation hold'),
      messageId: requiredString(data.messageId, 'preserved message'),
      holdType: holdType as 'legal' | 'incident_preservation',
      active: true as const,
    };
  }

  async releaseMessagePreservationHold(
    input: Parameters<CommandRepository['releaseMessagePreservationHold']>[0],
  ) {
    const payload = await this.request(
      `/v2/admin/message-preservation-holds/${encodeURIComponent(input.holdId)}/release`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: { releaseReasonCode: input.releaseReasonCode },
      },
    );
    const data = dataValue(payload);
    if (data.active !== false) {
      throw new RepositoryError('The service returned an invalid preservation release.', 'invalid_response', true);
    }
    return {
      holdId: requiredString(data.holdId, 'preservation hold'),
      messageId: requiredString(data.messageId, 'preserved message'),
      active: false as const,
      releasedAt: requiredString(data.releasedAt, 'preservation release timestamp'),
    };
  }

  async setMessageReaction(input: Parameters<CommandRepository['setMessageReaction']>[0]) {
    await this.request(`/v2/messages/${encodeURIComponent(input.messageId)}/reactions`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        conversationId: input.conversationId,
        emoji: input.emoji,
        active: input.active,
      },
    });
  }

  async setMessagePin(input: Parameters<CommandRepository['setMessagePin']>[0]) {
    await this.request(`/v2/messages/${encodeURIComponent(input.messageId)}/pin`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: { conversationId: input.conversationId, pinned: input.pinned },
    });
  }

  async reportMessage(input: Parameters<CommandRepository['reportMessage']>[0]) {
    const payload = await this.request(`/v2/messages/${encodeURIComponent(input.messageId)}/report`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        conversationId: input.conversationId,
        category: input.category,
        ...(input.details !== undefined ? { details: input.details } : {}),
        consentToShare: input.consentToShare,
        contextBefore: input.contextBefore,
        contextAfter: input.contextAfter,
        noticeVersion: input.noticeVersion,
      },
    });
    return parsePrivateReportResponse(payload, 'message');
  }

  async reportGroup(input: Parameters<CommandRepository['reportGroup']>[0]) {
    const payload = await this.request(
      `/v2/conversations/${encodeURIComponent(input.conversationId)}/report`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          category: input.category,
          ...(input.details !== undefined ? { details: input.details } : {}),
          consentToShare: input.consentToShare,
          noticeVersion: input.noticeVersion,
        },
      },
    );
    return parsePrivateReportResponse(payload, 'group');
  }

  async reportMember(input: Parameters<CommandRepository['reportMember']>[0]) {
    const payload = await this.request(`/v2/people/${encodeURIComponent(input.membershipId)}/report`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        category: input.category,
        ...(input.details !== undefined ? { details: input.details } : {}),
        consentToShare: input.consentToShare,
        noticeVersion: input.noticeVersion,
      },
    });
    return parsePrivateReportResponse(payload, 'member');
  }

  async createAttachmentUploadGrant(
    input: Parameters<CommandRepository['createAttachmentUploadGrant']>[0],
  ): Promise<AttachmentUploadGrant> {
    const payload = await this.request('/v2/attachments/grants', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        action: 'upload',
        conversationId: input.conversationId,
        messageId: input.messageId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        sha256Hex: input.sha256Hex,
      },
    });
    const grant = objectValue(dataValue(payload).grant);
    if (grant.action !== 'upload') {
      throw new RepositoryError('The service returned an invalid upload grant.', 'invalid_response', true);
    }
    const bucket = requiredString(grant.bucket, 'attachment bucket');
    if (bucket !== 'message-attachments') {
      throw new RepositoryError('The service returned an invalid attachment bucket.', 'invalid_response', true);
    }
    return {
      action: 'upload',
      attachmentId: requiredString(grant.attachmentId, 'attachment grant'),
      bucket,
      path: requiredString(grant.path, 'attachment path'),
      signedUrl: requiredStorageSignedUrl(grant.signedUrl, 'upload'),
      token: requiredString(grant.token, 'upload token'),
      expiresInSeconds: Number(grant.expiresInSeconds) || 7200,
    };
  }

  async createAttachmentDownloadGrant(
    input: Parameters<CommandRepository['createAttachmentDownloadGrant']>[0],
  ): Promise<AttachmentDownloadGrant> {
    const payload = await this.request('/v2/attachments/grants', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        action: 'download',
        conversationId: input.conversationId,
        attachmentId: input.attachmentId,
      },
    });
    const grant = objectValue(dataValue(payload).grant);
    if (grant.action !== 'download') {
      throw new RepositoryError('The service returned an invalid download grant.', 'invalid_response', true);
    }
    return {
      action: 'download',
      attachmentId: requiredString(grant.attachmentId, 'attachment grant'),
      signedUrl: requiredStorageSignedUrl(grant.signedUrl, 'download'),
      expiresInSeconds: Number(grant.expiresInSeconds) || 120,
    };
  }

  async completeAttachmentUpload(
    input: Parameters<CommandRepository['completeAttachmentUpload']>[0],
  ) {
    const payload = await this.request(
      `/v2/attachments/${encodeURIComponent(input.attachmentId)}/complete`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          bucket: input.bucket,
          path: input.path,
          byteSize: input.byteSize,
          sha256Hex: input.sha256Hex,
        },
      },
    );
    const data = dataValue(payload);
    if (data.scanStatus !== 'pending') {
      throw new RepositoryError('The service returned an invalid scan state.', 'invalid_response', true);
    }
    return {
      attachmentId: requiredString(data.attachmentId, 'attachment'),
      scanStatus: 'pending' as const,
      scanJobId: requiredString(data.scanJobId, 'scan job'),
    };
  }

  async getAttachmentState(
    input: Parameters<CommandRepository['getAttachmentState']>[0],
  ): Promise<AttachmentScanState> {
    const payload = await this.request(
      `/v2/attachments/${encodeURIComponent(input.attachmentId)}/state`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
      },
    );
    const data = dataValue(payload);
    const scanStatus = data.scanStatus;
    if (!['pending', 'clean', 'blocked', 'failed'].includes(String(scanStatus))) {
      throw new RepositoryError('The service returned an invalid scan state.', 'invalid_response', true);
    }
    return {
      attachmentId: requiredString(data.attachmentId, 'attachment'),
      scanStatus: scanStatus as AttachmentScanState['scanStatus'],
      reasonCode: typeof data.reasonCode === 'string' ? data.reasonCode : null,
    };
  }

  async publishUpdate(input: Parameters<CommandRepository['publishUpdate']>[0]) {
    const payload = await this.request('/v2/updates', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        title: input.title,
        body: input.body,
        languageCode: input.languageCode,
        priority: input.priority,
        requiresAcknowledgement: input.requiresAcknowledgement,
        expiresAt: input.expiresAt ?? null,
        scheduledAt: input.scheduledAt ?? null,
        acknowledgementSchema: input.acknowledgementSchema ?? null,
        notificationClass: input.notificationClass,
        criticalCategory: input.criticalCategory ?? null,
        quietHoursOverrideReason: input.quietHoursOverrideReason ?? null,
        reminderPolicy: input.reminderPolicy ?? null,
        audienceSpec: input.audienceSpec,
      },
    });
    const data = dataValue(payload);
    const status: 'scheduled' | 'published' | undefined = data.status === 'scheduled'
      ? 'scheduled'
      : data.status === 'published'
        ? 'published'
        : undefined;
    return {
      announcementId: requiredString(data.announcementId ?? data.id, 'announcement'),
      versionId: requiredString(data.announcementVersionId ?? data.versionId, 'announcement version'),
      messageId:
        data.messageId === undefined ? undefined : requiredString(data.messageId, 'announcement message'),
      status,
      scheduledAt: typeof data.scheduledAt === 'string' ? data.scheduledAt : null,
      audienceCount: Number.isInteger(data.audienceCount) ? Number(data.audienceCount) : undefined,
    };
  }

  async previewUpdateAudience(input: Parameters<CommandRepository['previewUpdateAudience']>[0]) {
    const payload = await this.request('/v2/updates/audience/preview', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: { conversationId: input.conversationId, audienceSpec: input.audienceSpec, limit: 25 },
    });
    const data = dataValue(payload);
    const preview = Array.isArray(data.preview) ? data.preview.map(objectValue) : [];
    const sample = preview.map((row) => ({
      userId: requiredString(row.userId, 'audience member'),
      displayName: requiredString(row.displayName, 'audience member name'),
      preferredLanguage: requiredString(row.preferredLanguage, 'audience member language'),
      membershipRole: (['owner', 'admin', 'manager', 'member'].includes(String(row.membershipRole))
        ? row.membershipRole
        : 'member') as 'owner' | 'admin' | 'manager' | 'member',
      unitIds: Array.isArray(row.unitIds)
        ? row.unitIds.filter((value): value is string => typeof value === 'string')
        : [],
      currentShift: row.currentShift === true,
    }));
    const sampleUserIds = Array.isArray(data.sampleUserIds)
      ? data.sampleUserIds.filter((value): value is string => typeof value === 'string')
      : sample.map((row) => row.userId);
    const audienceCount = Number(data.audienceCount ?? data.totalCount);
    const generatedAt = data.generatedAt ?? data.reconcileAfter;
    const excludedCount = Number(data.excludedCount ?? 0);
    const notificationLanguages = Array.isArray(data.notificationLanguages)
      ? data.notificationLanguages.filter((value): value is string => typeof value === 'string')
      : [];
    const exclusionRow = objectValue(data.exclusionCounts);
    const inactiveMembers = Number(exclusionRow.inactiveMembers ?? 0);
    const selectorMismatch = Number(exclusionRow.selectorMismatch ?? excludedCount);
    const normalizedSpec = parseUpdateAudienceSpec(data.audienceSpec, input.audienceSpec);
    if (
      !Number.isInteger(audienceCount) || audienceCount < 0
      || !Number.isInteger(excludedCount) || excludedCount < 0
      || !Number.isInteger(inactiveMembers) || inactiveMembers < 0
      || !Number.isInteger(selectorMismatch) || selectorMismatch < 0
      || typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt))
    ) {
      throw new RepositoryError('The service returned an invalid update audience preview.', 'invalid_response', true);
    }
    return {
      audienceCount,
      excludedCount,
      sampleUserIds: sampleUserIds.slice(0, 200),
      sample: sample.slice(0, 200),
      notificationLanguages: notificationLanguages.slice(0, 50),
      exclusionCounts: { inactiveMembers, selectorMismatch },
      normalizedSpec,
      snapshotBasis: data.snapshotBasis === 'active_members_and_current_shift_at_publish'
        ? 'active_members_and_current_shift_at_publish' as const
        : 'active_members_at_publish' as const,
      generatedAt,
    };
  }

  async cancelScheduledUpdate(input: Parameters<CommandRepository['cancelScheduledUpdate']>[0]) {
    await this.request(`/v2/updates/${encodeURIComponent(input.announcementId)}/cancel`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: { reason: input.reason },
    });
  }

  async acknowledgeUpdate(input: {
    organizationId: string;
    versionId: string;
    deviceId?: string | null;
    attestation?: Record<string, string | number | boolean>;
    idempotencyKey: string;
  }): Promise<UpdateAcknowledgementReceipt> {
    const payload = await this.request(
      `/v2/updates/${encodeURIComponent(input.versionId)}/acknowledgements`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          deviceId: input.deviceId ?? null,
          attestation: input.attestation ?? {},
        },
      },
    );
    const data = dataValue(payload);
    const platform = data.platform;
    const clientFamily = data.clientFamily;
    if (
      !hasOnlyKeys(data, [
        'announcementId',
        'announcementVersionId',
        'acknowledgedAt',
        'sessionId',
        'deviceId',
        'installationId',
        'platform',
        'clientFamily',
        'sessionEvidenceCaptured',
      ])
      || !('deviceId' in data)
      || !['ios', 'android', 'web'].includes(String(platform))
      || !['iphone', 'ipad', 'android', 'mobile', 'desktop', 'unknown'].includes(String(clientFamily))
      || data.sessionEvidenceCaptured !== true
    ) {
      throw new RepositoryError('The service returned invalid acknowledgement evidence.', 'invalid_response', true);
    }
    return {
      announcementId: requiredString(data.announcementId, 'announcement'),
      versionId: requiredString(data.announcementVersionId, 'announcement version'),
      acknowledgedAt: requiredDate(data.acknowledgedAt, 'acknowledgement time'),
      sessionId: requiredString(data.sessionId, 'acknowledgement session'),
      deviceId: data.deviceId === null || data.deviceId === undefined
        ? null
        : requiredString(data.deviceId, 'acknowledgement device'),
      installationId: requiredString(data.installationId, 'acknowledgement installation'),
      platform: platform as UpdateAcknowledgementReceipt['platform'],
      clientFamily: clientFamily as UpdateAcknowledgementReceipt['clientFamily'],
      sessionEvidenceCaptured: true,
    };
  }

  async markUpdateRead(input: Parameters<CommandRepository['markUpdateRead']>[0]) {
    const payload = await this.request(
      `/v2/updates/${encodeURIComponent(input.announcementId)}/read`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
      },
    );
    const data = dataValue(payload);
    return {
      announcementId: requiredString(data.announcementId, 'announcement'),
      readAt: requiredDate(data.readAt, 'announcement read time'),
      deliveredAt: requiredDate(data.deliveredAt, 'announcement delivery time'),
    };
  }

  async correctUpdate(input: Parameters<CommandRepository['correctUpdate']>[0]) {
    const payload = await this.request(
      `/v2/updates/${encodeURIComponent(input.announcementId)}/corrections`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: {
          clientMessageId: input.clientMessageId,
          title: input.title,
          body: input.body,
          priority: input.priority,
          requiresAcknowledgement: input.requiresAcknowledgement,
          expiresAt: input.expiresAt ?? null,
          reason: input.reason,
        },
      },
    );
    const data = dataValue(payload);
    return {
      announcementId: requiredString(data.announcementId, 'announcement'),
      versionId: requiredString(data.announcementVersionId, 'announcement version'),
      versionNumber: requiredInteger(data.versionNumber, 'announcement version number', 2),
      messageId: requiredString(data.messageId, 'announcement message'),
    };
  }

  async listManagedUpdates(input: Parameters<CommandRepository['listManagedUpdates']>[0]) {
    const payload = await this.request('/v2/updates/manage/list', {
      organizationId: input.organizationId,
      body: { limit: Math.min(Math.max(input.limit ?? 50, 1), 100) },
    });
    const data = dataValue(payload);
    if (
      !hasOnlyKeys(data, ['updates', 'generatedAt', 'smsFallbackAvailable'])
      || !Array.isArray(data.updates)
      || data.smsFallbackAvailable !== false
    ) {
      throw new RepositoryError('The service returned an invalid managed update list.', 'invalid_response', true);
    }
    return {
      updates: data.updates.map(parseManagedUpdate),
      generatedAt: requiredDate(data.generatedAt, 'managed update generation time'),
      smsFallbackAvailable: false as const,
    };
  }

  async listUpdateNonAcknowledgers(
    input: Parameters<CommandRepository['listUpdateNonAcknowledgers']>[0],
  ): Promise<UpdateNonAcknowledgerPage> {
    const payload = await this.request(
      `/v2/updates/${encodeURIComponent(input.announcementId)}/non-acknowledgers`,
      {
        organizationId: input.organizationId,
        body: {
          afterUserId: input.afterUserId ?? null,
          limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
        },
      },
    );
    const data = dataValue(payload);
    if (
      !hasOnlyKeys(data, [
        'announcementId',
        'announcementVersionId',
        'versionNumber',
        'deadlineAt',
        'people',
        'hasMore',
        'nextAfterUserId',
        'privacyScope',
      ])
      || !Array.isArray(data.people)
      || data.privacyScope !== 'notice_response_state_only'
      || typeof data.hasMore !== 'boolean'
    ) {
      throw new RepositoryError('The service returned invalid notice response details.', 'invalid_response', true);
    }
    const people = data.people.map((value): UpdateNonAcknowledger => {
      const person = objectValue(value);
      const membershipStatus = person.membershipStatus;
      const reachability = person.reachability;
      if (
        !hasOnlyKeys(person, [
          'userId',
          'displayName',
          'preferredLanguage',
          'membershipStatus',
          'deliveredAt',
          'readAt',
          'reminderCount',
          'lastRemindedAt',
          'escalatedAt',
          'reachability',
          'overdue',
        ])
        || !['active', 'suspended', 'deactivated'].includes(String(membershipStatus))
        || !['delivered', 'pending', 'unreachable'].includes(String(reachability))
        || !['en', 'ko', 'es'].includes(String(person.preferredLanguage))
        || typeof person.overdue !== 'boolean'
      ) {
        throw new RepositoryError('The service returned an invalid non-acknowledger.', 'invalid_response', true);
      }
      return {
        userId: requiredString(person.userId, 'non-acknowledger'),
        displayName: requiredString(person.displayName, 'non-acknowledger name'),
        preferredLanguage: requiredString(person.preferredLanguage, 'non-acknowledger language'),
        membershipStatus: membershipStatus as UpdateNonAcknowledger['membershipStatus'],
        deliveredAt: nullableDate(person.deliveredAt, 'notice delivery time'),
        readAt: nullableDate(person.readAt, 'notice read time'),
        reminderCount: requiredInteger(person.reminderCount, 'notice reminder count'),
        lastRemindedAt: nullableDate(person.lastRemindedAt, 'notice reminder time'),
        escalatedAt: nullableDate(person.escalatedAt, 'notice escalation time'),
        reachability: reachability as UpdateNonAcknowledger['reachability'],
        overdue: person.overdue,
      };
    });
    const nextAfterUserId = data.nextAfterUserId === null || data.nextAfterUserId === undefined
      ? null
      : requiredString(data.nextAfterUserId, 'non-acknowledger cursor');
    if (
      data.hasMore !== (nextAfterUserId !== null)
      || people.length > Math.min(Math.max(input.limit ?? 50, 1), 100)
      || new Set(people.map((person) => person.userId)).size !== people.length
      || people.some((person, index) =>
        index > 0 && person.userId <= people[index - 1]!.userId
      )
      || people.some((person) =>
        person.reminderCount > 20
        || (person.readAt !== null && person.deliveredAt === null)
        || (person.reachability === 'delivered') !== (person.deliveredAt !== null)
      )
    ) {
      throw new RepositoryError('The service returned inconsistent notice response details.', 'invalid_response', true);
    }
    return {
      announcementId: requiredString(data.announcementId, 'announcement'),
      versionId: requiredString(data.announcementVersionId, 'announcement version'),
      versionNumber: requiredInteger(data.versionNumber, 'announcement version number', 1),
      deadlineAt: nullableDate(data.deadlineAt, 'acknowledgement deadline'),
      people,
      hasMore: data.hasMore,
      nextAfterUserId,
      privacyScope: 'notice_response_state_only',
    };
  }

  async createHandoff(input: Parameters<CommandRepository['createHandoff']>[0]) {
    const payload = await this.request('/v2/handoffs', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        conversationId: input.conversationId,
        title: input.title,
        details: input.details,
        sourceLanguage: input.sourceLanguage,
        shiftStartedAt: input.shiftStartedAt,
        shiftEndedAt: input.shiftEndedAt,
        sourceMessageIds: input.sourceMessageIds,
        acknowledgementDueAt: input.acknowledgementDueAt ?? null,
      },
    });
    const data = dataValue(payload);
    return {
      handoffId: requiredString(data.handoffId ?? data.id, 'handoff'),
      versionId: requiredString(data.handoffVersionId ?? data.versionId, 'handoff version'),
    };
  }

  async correctHandoff(input: Parameters<CommandRepository['correctHandoff']>[0]) {
    let normalized: ReturnType<typeof normalizeHandoffCorrectionRequest>;
    try {
      normalized = normalizeHandoffCorrectionRequest(input);
    } catch {
      throw new RepositoryError(
        'The handoff correction is invalid.',
        'invalid_handoff_correction',
        false,
      );
    }
    const payload = await this.request(
      `/v2/handoffs/${encodeURIComponent(normalized.handoffId)}/corrections`,
      {
        organizationId: normalized.organizationId,
        idempotencyKey: normalized.idempotencyKey,
        body: {
          expectedVersionId: normalized.expectedVersionId,
          expectedVersionNumber: normalized.expectedVersionNumber,
          title: normalized.title,
          details: normalized.details,
          sourceLanguage: normalized.sourceLanguage,
          shiftStartedAt: normalized.shiftStartedAt,
          shiftEndedAt: normalized.shiftEndedAt,
          sourceMessageIds: normalized.sourceMessageIds,
          acknowledgementDueAt: normalized.acknowledgementDueAt,
          reason: normalized.reason,
        },
      },
    );
    try {
      return parseHandoffCorrectionReceipt(payload, normalized);
    } catch {
      throw new RepositoryError(
        'The service returned an invalid handoff correction.',
        'invalid_response',
        true,
      );
    }
  }

  async signHandoff(input: Parameters<CommandRepository['signHandoff']>[0]) {
    await this.request(`/v2/handoffs/${encodeURIComponent(input.versionId)}/sign`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async acknowledgeHandoff(input: Parameters<CommandRepository['acknowledgeHandoff']>[0]) {
    await this.request(`/v2/handoffs/${encodeURIComponent(input.versionId)}/acknowledge`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: input.note !== undefined ? { note: input.note } : undefined,
    });
  }

  async proposeAction(input: Parameters<CommandRepository['proposeAction']>[0]) {
    const payload = await this.request('/v2/actions/proposals', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        conversationId: input.conversationId,
        sourceMessageId: input.sourceMessageId,
        title: input.title,
        details: input.details ?? null,
      },
    });
    const data = dataValue(payload);
    return { actionId: requiredString(data.actionId ?? data.id, 'operational action') };
  }

  async confirmAction(input: Parameters<CommandRepository['confirmAction']>[0]) {
    await this.request(`/v2/actions/${encodeURIComponent(input.actionId)}/confirm`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        assigneeMembershipId: input.assigneeMembershipId,
        dueAt: input.dueAt ?? null,
      },
    });
  }

  async transitionAction(input: Parameters<CommandRepository['transitionAction']>[0]) {
    await this.request(`/v2/actions/${encodeURIComponent(input.actionId)}/status`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: { status: input.status, note: input.note ?? null },
    });
  }

  async requestConnection(input: {
    organizationId: string;
    targetMembershipId: string;
    idempotencyKey: string;
  }) {
    await this.request('/v2/contacts/connections', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: { targetMembershipId: input.targetMembershipId },
    });
  }

  async respondConnection(input: Parameters<CommandRepository['respondConnection']>[0]) {
    await this.request(
      `/v2/contacts/connections/${encodeURIComponent(input.membershipId)}/respond`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: { decision: input.decision },
      },
    );
  }

  async removeConnection(input: Parameters<CommandRepository['removeConnection']>[0]) {
    await this.request(`/v2/contacts/connections/${encodeURIComponent(input.membershipId)}`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'DELETE',
    });
  }

  async saveContact(input: Parameters<CommandRepository['saveContact']>[0]) {
    const payload = await this.request(
      `/v2/contacts/saved/${encodeURIComponent(input.membershipId)}`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        method: 'PATCH',
        body: {
          ...(input.alias !== undefined ? { alias: input.alias } : {}),
          ...(input.isFavorite !== undefined ? { isFavorite: input.isFavorite } : {}),
        },
      },
    );
    const data = dataValue(payload);
    return {
      alias: typeof data.alias === 'string' ? data.alias : null,
      isFavorite: data.isFavorite === true,
    };
  }

  async removeSavedContact(input: Parameters<CommandRepository['removeSavedContact']>[0]) {
    await this.request(`/v2/contacts/saved/${encodeURIComponent(input.membershipId)}`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'DELETE',
    });
  }

  async setPersonBlocked(input: Parameters<CommandRepository['setPersonBlocked']>[0]) {
    await this.request(`/v2/people/${encodeURIComponent(input.membershipId)}/block`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: input.blocked ? 'PUT' : 'DELETE',
    });
  }

  async queryRoleAssignments(input: Parameters<CommandRepository['queryRoleAssignments']>[0]) {
    const payload = await this.request('/v2/admin/role-assignments/query', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        targetMembershipId: input.targetMembershipId,
        limit: input.limit ?? 50,
      },
    });
    const data = dataValue(payload);
    if (!Array.isArray(data.assignments)) {
      throw new RepositoryError('The service returned an invalid role list.', 'invalid_response', true);
    }
    return data.assignments.map(parseRoleAssignment);
  }

  async assignAdminRole(input: Parameters<CommandRepository['assignAdminRole']>[0]) {
    const payload = await this.request('/v2/admin/role-assignments', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        targetMembershipId: input.targetMembershipId,
        roleName: input.roleName,
        scopeType: input.scopeType,
        unitId: input.unitId,
        expiresAt: input.expiresAt,
        reason: input.reason,
      },
    });
    return parseRoleAssignment(dataValue(payload));
  }

  async revokeAdminRole(input: Parameters<CommandRepository['revokeAdminRole']>[0]) {
    await this.request(
      `/v2/admin/role-assignments/${encodeURIComponent(input.assignmentId)}/revoke`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        body: { reason: input.reason },
      },
    );
  }

  async issueInvitation(input: Parameters<CommandRepository['issueInvitation']>[0]) {
    const payload = await this.request('/v2/admin/invitations', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        destinationType: input.destinationType,
        destination: input.destination,
        employeeCode: input.employeeCode ?? null,
        activationMode: input.activationMode,
        role: input.role,
        expiresInSeconds: input.expiresInSeconds,
        membershipType: input.membershipType,
        membershipAccessExpiresAt: input.membershipAccessExpiresAt,
        guestSponsorUserId: input.guestSponsorUserId,
      },
    });
    return parseIssuedInvitation(dataValue(payload));
  }

  async revokeSession(input: Parameters<CommandRepository['revokeSession']>[0]) {
    await this.request(`/v2/auth/sessions/${encodeURIComponent(input.sessionId)}/revoke`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: { reason: input.reason },
    });
  }

  async loadOrganizationPreferences(
    input: Parameters<CommandRepository['loadOrganizationPreferences']>[0],
  ) {
    const payload = await this.request('/v2/preferences/organization/query', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
    });
    return parseOrganizationPreferences(dataValue(payload));
  }

  async updateOrganizationPreferences(
    input: Parameters<CommandRepository['updateOrganizationPreferences']>[0],
  ) {
    const payload = await this.request('/v2/preferences/organization', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      method: 'PATCH',
      body: input.patch,
    });
    return parseOrganizationPreferences(dataValue(payload));
  }

  async listSessions(input: Parameters<CommandRepository['listSessions']>[0]) {
    const payload = await this.request('/v2/auth/sessions/list', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
    });
    const data = dataValue(payload);
    if (!Array.isArray(data.sessions)) {
      throw new RepositoryError('The service returned an invalid session list.', 'invalid_response', true);
    }
    return data.sessions.map(parseSession);
  }

  async suspendMember(input: Parameters<CommandRepository['suspendMember']>[0]) {
    await this.request(`/v2/admin/members/${encodeURIComponent(input.membershipId)}/suspend`, {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: { reason: input.reason },
    });
  }

  async getDeviceNotificationPreferences(
    input: Parameters<CommandRepository['getDeviceNotificationPreferences']>[0],
  ) {
    const payload = await this.request(
      `/v2/devices/${encodeURIComponent(input.installationId)}/preferences/query`,
      {
        organizationId: input.organizationId,
        body: {},
      },
    );
    try {
      return parseDeviceNotificationPreferences(dataValue(payload));
    } catch {
      throw new RepositoryError(
        'The service returned invalid current-device notification preferences.',
        'invalid_response',
        true,
      );
    }
  }

  async updateDeviceNotificationPreferences(
    input: Parameters<CommandRepository['updateDeviceNotificationPreferences']>[0],
  ) {
    let patch;
    try {
      patch = normalizeDeviceNotificationPreferencePatch(input.patch);
    } catch {
      throw new RepositoryError(
        'Choose at least one valid current-device notification preference.',
        'invalid_device_notification_preferences',
        false,
      );
    }
    const payload = await this.request(
      `/v2/devices/${encodeURIComponent(input.installationId)}/preferences`,
      {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        method: 'PATCH',
        body: {
          expectedVersion: input.expectedVersion,
          patch,
        },
      },
    );
    try {
      return parseDeviceNotificationPreferences(dataValue(payload));
    } catch {
      throw new RepositoryError(
        'The service returned invalid current-device notification preferences.',
        'invalid_response',
        true,
      );
    }
  }

  async registerDevice(input: RegisterDeviceInput) {
    await this.request('/v2/devices', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      body: {
        installationId: input.installationId,
        platform: input.platform,
        pushToken: input.pushToken,
        pushTokenType: input.pushTokenType,
        pushProjectId: input.pushProjectId,
        pushEnvironment: input.pushEnvironment,
        appVersion: input.appVersion ?? null,
        locale: input.locale ?? null,
      },
    });
  }
}
