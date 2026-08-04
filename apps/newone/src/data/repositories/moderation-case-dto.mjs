const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const MODERATION_CASE_STATUSES = Object.freeze([
  'open',
  'assigned',
  'in_review',
  'resolved',
  'dismissed',
]);

export const MODERATION_CASE_CATEGORIES = Object.freeze([
  'harassment',
  'threat',
  'spam',
  'privacy',
  'misinformation',
  'other',
]);

export const MODERATION_TARGET_TYPES = Object.freeze(['message', 'group', 'member']);

function invalid(label) {
  throw new Error(`invalid moderation ${label}`);
}

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value;
}

function exactKeys(value, keys, label) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(label);
}

function dataValue(value) {
  const root = objectValue(value, 'response');
  if (Object.prototype.hasOwnProperty.call(root, 'data')) {
    exactKeys(root, ['data'], 'response envelope');
    return objectValue(root.data, 'response data');
  }
  return root;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid(label);
  return value.toLowerCase();
}

function nullableUuid(value, label) {
  return value === null ? null : uuid(value, label);
}

function text(value, label, minimum, maximum, nullable = false) {
  if (nullable && value === null) return null;
  if (
    typeof value !== 'string' || value.length < minimum || value.length > maximum ||
    CONTROL_PATTERN.test(value)
  ) invalid(label);
  return value;
}

function dateTime(value, label) {
  const result = text(value, label, 20, 64);
  if (Number.isNaN(Date.parse(result))) invalid(label);
  return result;
}

function nullableDateTime(value, label) {
  return value === null ? null : dateTime(value, label);
}

function boolean(value, label) {
  if (typeof value !== 'boolean') invalid(label);
  return value;
}

function integer(value, label, minimum = 0, maximum = 2_147_483_647) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(label);
  return value;
}

function oneOf(value, values, label) {
  if (!values.includes(value)) invalid(label);
  return value;
}

function uuidArray(value, label, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) invalid(label);
  const result = value.map((entry) => uuid(entry, label));
  if (new Set(result).size !== result.length) invalid(label);
  return result;
}

function parseTarget(value) {
  const target = objectValue(value, 'case target');
  exactKeys(target, ['type', 'label'], 'case target field');
  return {
    type: oneOf(target.type, MODERATION_TARGET_TYPES, 'case target type'),
    label: text(target.label, 'case target label', 1, 160),
  };
}

function parseListCase(value) {
  const row = objectValue(value, 'case list item');
  exactKeys(row, [
    'caseId',
    'status',
    'category',
    'target',
    'unitId',
    'reportedAt',
    'updatedAt',
    'recordVersion',
    'assignedAt',
    'assignedToMe',
    'assignedInvestigatorUserId',
    'canClaim',
    'canAssign',
    'canViewEvidence',
    'readOnly',
    'reporterLabel',
    'eligibleInvestigatorUserIds',
  ], 'case list field');
  const status = oneOf(row.status, MODERATION_CASE_STATUSES, 'case status');
  const assignedToMe = boolean(row.assignedToMe, 'assigned-to-me state');
  const assignedInvestigatorUserId = nullableUuid(
    row.assignedInvestigatorUserId,
    'assigned investigator',
  );
  const assignedAt = nullableDateTime(row.assignedAt, 'assignment time');
  const canClaim = boolean(row.canClaim, 'claim capability');
  const canAssign = boolean(row.canAssign, 'assignment capability');
  const canViewEvidence = boolean(row.canViewEvidence, 'evidence capability');
  const readOnly = boolean(row.readOnly, 'read-only state');
  if (
    row.reporterLabel !== 'protected' ||
    (status === 'open') !== (assignedAt === null) ||
    (status === 'open' && (assignedToMe || canViewEvidence || assignedInvestigatorUserId !== null)) ||
    (assignedToMe && !canViewEvidence) ||
    canClaim && status !== 'open' ||
    canAssign && !['open', 'assigned', 'in_review'].includes(status) ||
    readOnly !== ['resolved', 'dismissed'].includes(status)
  ) invalid('case list consistency');
  return {
    caseId: uuid(row.caseId, 'case id'),
    status,
    category: oneOf(row.category, MODERATION_CASE_CATEGORIES, 'case category'),
    target: parseTarget(row.target),
    unitId: nullableUuid(row.unitId, 'unit id'),
    reportedAt: dateTime(row.reportedAt, 'report time'),
    updatedAt: dateTime(row.updatedAt, 'update time'),
    recordVersion: integer(row.recordVersion, 'record version', 1),
    assignedAt,
    assignedToMe,
    assignedInvestigatorUserId,
    canClaim,
    canAssign,
    canViewEvidence,
    readOnly,
    eligibleInvestigatorUserIds: uuidArray(
      row.eligibleInvestigatorUserIds,
      'eligible investigator',
    ),
  };
}

export function parseModerationCaseList(value) {
  const data = dataValue(value);
  exactKeys(data, [
    'schemaVersion',
    'cases',
    'nextCursor',
    'contentIncluded',
    'reporterIdentityIncluded',
    'requiresExplicitAssignmentForEvidence',
  ], 'case list response field');
  if (
    data.schemaVersion !== 2 || data.contentIncluded !== false ||
    data.reporterIdentityIncluded !== false ||
    data.requiresExplicitAssignmentForEvidence !== true ||
    !Array.isArray(data.cases) || data.cases.length > 100
  ) invalid('case list response');
  const cases = data.cases.map(parseListCase);
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length) {
    invalid('duplicate case');
  }
  let nextCursor = null;
  if (data.nextCursor !== null) {
    const cursor = objectValue(data.nextCursor, 'case cursor');
    exactKeys(cursor, ['beforeUpdatedAt', 'beforeCaseId'], 'case cursor field');
    nextCursor = {
      beforeUpdatedAt: dateTime(cursor.beforeUpdatedAt, 'cursor time'),
      beforeCaseId: uuid(cursor.beforeCaseId, 'cursor case'),
    };
  }
  return { schemaVersion: 2, cases, nextCursor };
}

function parseEvidenceMetadata(value) {
  const metadata = objectValue(value, 'history evidence metadata');
  exactKeys(metadata, ['referenceIds', 'policyCode', 'severity'], 'history metadata field');
  const result = {};
  if ('referenceIds' in metadata) {
    if (!Array.isArray(metadata.referenceIds) || metadata.referenceIds.length > 20) {
      invalid('history references');
    }
    result.referenceIds = metadata.referenceIds.map((entry) =>
      text(entry, 'history reference', 1, 120)
    );
    if (new Set(result.referenceIds).size !== result.referenceIds.length) {
      invalid('duplicate history reference');
    }
  }
  if ('policyCode' in metadata) {
    const policyCode = text(metadata.policyCode, 'policy code', 2, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/.test(policyCode)) invalid('policy code');
    result.policyCode = policyCode;
  }
  if ('severity' in metadata) {
    result.severity = oneOf(
      metadata.severity,
      ['low', 'medium', 'high', 'critical'],
      'case severity',
    );
  }
  return result;
}

export function parseModerationCaseDetail(value) {
  const data = dataValue(value);
  exactKeys(data, ['schemaVersion', 'case', 'scope'], 'case detail response field');
  if (data.schemaVersion !== 2) invalid('case detail version');
  const scope = objectValue(data.scope, 'case scope');
  exactKeys(scope, [
    'reportedItemAndConsentedContextOnly',
    'reporterIdentityIncluded',
    'otherConversationsIncluded',
    'targetOnly',
    'messageEvidenceIncluded',
  ], 'case scope field');
  if (
    scope.reportedItemAndConsentedContextOnly !== true ||
    scope.reporterIdentityIncluded !== false ||
    scope.otherConversationsIncluded !== false ||
    scope.targetOnly !== true ||
    typeof scope.messageEvidenceIncluded !== 'boolean'
  ) invalid('case scope');
  const row = objectValue(data.case, 'case detail');
  exactKeys(row, [
    'caseId', 'status', 'category', 'target', 'details', 'reporterLabel', 'reportedAt',
    'updatedAt', 'assignedAt', 'recordVersion', 'readOnly', 'evidence', 'history',
  ], 'case detail field');
  const status = oneOf(row.status, MODERATION_CASE_STATUSES, 'case status');
  const target = parseTarget(row.target);
  if (status === 'open' || row.reporterLabel !== 'protected') invalid('case detail assignment');
  if (
    scope.messageEvidenceIncluded !== (target.type === 'message') ||
    !Array.isArray(row.evidence) || row.evidence.length > 5 ||
    (target.type === 'message' ? row.evidence.length < 1 : row.evidence.length !== 0)
  ) {
    invalid('case evidence size');
  }
  const evidence = row.evidence.map((entry) => {
    const item = objectValue(entry, 'case evidence');
    exactKeys(item, [
      'evidenceId', 'relationship', 'relativePosition', 'messageKind', 'messageBody',
      'senderLabel', 'sentAt', 'bodySha256',
    ], 'case evidence field');
    const relationship = oneOf(
      item.relationship,
      ['reported', 'context_before', 'context_after'],
      'evidence relationship',
    );
    const relativePosition = integer(item.relativePosition, 'relative position', -2, 2);
    if (
      relationship === 'reported' ? relativePosition !== 0
        : relationship === 'context_before' ? relativePosition >= 0
        : relativePosition <= 0
    ) invalid('evidence relationship position');
    const body = item.messageBody === null
      ? null
      : text(item.messageBody, 'evidence body', 0, 20000);
    if (typeof item.bodySha256 !== 'string' || !SHA256_PATTERN.test(item.bodySha256)) {
      invalid('evidence hash');
    }
    return {
      evidenceId: integer(item.evidenceId, 'evidence id', 1, Number.MAX_SAFE_INTEGER),
      relationship,
      relativePosition,
      messageKind: text(item.messageKind, 'message kind', 1, 40),
      messageBody: body,
      senderLabel: text(item.senderLabel, 'sender label', 1, 120),
      sentAt: dateTime(item.sentAt, 'message time'),
      bodySha256: item.bodySha256,
    };
  });
  if (
    (target.type === 'message'
      ? evidence.filter((item) => item.relationship === 'reported').length !== 1
      : evidence.length !== 0) ||
    new Set(evidence.map((item) => item.relativePosition)).size !== evidence.length
  ) invalid('case evidence consistency');
  if (!Array.isArray(row.history) || row.history.length < 1 || row.history.length > 200) {
    invalid('case history size');
  }
  const history = row.history.map((entry) => {
    const item = objectValue(entry, 'case history');
    exactKeys(item, [
      'eventId', 'eventType', 'fromStatus', 'toStatus', 'reason',
      'evidenceMetadata', 'actorLabel', 'occurredAt',
    ], 'case history field');
    return {
      eventId: integer(item.eventId, 'history id', 1, Number.MAX_SAFE_INTEGER),
      eventType: oneOf(item.eventType, [
        'reported', 'assigned', 'reassigned', 'claimed', 'accessed',
        'review_started', 'resolved', 'dismissed',
      ], 'history event'),
      fromStatus: item.fromStatus === null
        ? null
        : oneOf(item.fromStatus, MODERATION_CASE_STATUSES, 'history from status'),
      toStatus: item.toStatus === null
        ? null
        : oneOf(item.toStatus, MODERATION_CASE_STATUSES, 'history to status'),
      reason: item.reason === null ? null : text(item.reason, 'history reason', 3, 2000),
      evidenceMetadata: parseEvidenceMetadata(item.evidenceMetadata),
      actorLabel: oneOf(item.actorLabel, [
        'protected_reporter', 'assigned_investigator', 'authorized_case_manager',
      ], 'history actor label'),
      occurredAt: dateTime(item.occurredAt, 'history time'),
    };
  });
  const readOnly = boolean(row.readOnly, 'read-only state');
  if (readOnly !== ['resolved', 'dismissed'].includes(status)) invalid('case close state');
  return {
    schemaVersion: 2,
    case: {
      caseId: uuid(row.caseId, 'case id'),
      status,
      category: oneOf(row.category, MODERATION_CASE_CATEGORIES, 'case category'),
      target,
      details: row.details === null ? null : text(row.details, 'report details', 0, 2000),
      reporterLabel: 'protected',
      reportedAt: dateTime(row.reportedAt, 'report time'),
      updatedAt: dateTime(row.updatedAt, 'update time'),
      assignedAt: dateTime(row.assignedAt, 'assignment time'),
      recordVersion: integer(row.recordVersion, 'record version', 1),
      readOnly,
      evidence,
      history,
    },
  };
}

export function parseModerationAssignmentReceipt(value) {
  const data = dataValue(value);
  exactKeys(data, [
    'caseId', 'status', 'recordVersion', 'assignedAt',
    'assignedInvestigatorUserId', 'reporterIdentityIncluded',
  ], 'assignment receipt field');
  if (data.status !== 'assigned' || data.reporterIdentityIncluded !== false) {
    invalid('assignment receipt');
  }
  return {
    caseId: uuid(data.caseId, 'case id'),
    status: 'assigned',
    recordVersion: integer(data.recordVersion, 'record version', 1),
    assignedAt: dateTime(data.assignedAt, 'assignment time'),
    assignedInvestigatorUserId: uuid(
      data.assignedInvestigatorUserId,
      'assigned investigator',
    ),
  };
}

export function parseModerationTransitionReceipt(value) {
  const data = dataValue(value);
  exactKeys(data, [
    'caseId', 'status', 'recordVersion', 'updatedAt', 'readOnly',
    'reporterIdentityIncluded', 'notificationPayloadContentIncluded',
  ], 'transition receipt field');
  const status = oneOf(data.status, ['in_review', 'resolved', 'dismissed'], 'transition status');
  const readOnly = boolean(data.readOnly, 'read-only state');
  if (
    data.reporterIdentityIncluded !== false ||
    data.notificationPayloadContentIncluded !== false ||
    readOnly !== ['resolved', 'dismissed'].includes(status)
  ) invalid('transition receipt');
  return {
    caseId: uuid(data.caseId, 'case id'),
    status,
    recordVersion: integer(data.recordVersion, 'record version', 1),
    updatedAt: dateTime(data.updatedAt, 'transition time'),
    readOnly,
  };
}
