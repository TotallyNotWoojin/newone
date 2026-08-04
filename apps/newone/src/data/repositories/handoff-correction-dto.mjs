const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SUPPORTED_LANGUAGES = Object.freeze(['en', 'ko', 'es']);

function invalid(label) {
  throw new TypeError(`Invalid handoff correction ${label}.`);
}

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value;
}

function exactKeys(value, keys, label) {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(label);
}

function dataValue(value) {
  const root = objectValue(value, 'response');
  if (!Object.prototype.hasOwnProperty.call(root, 'data')) return root;
  exactKeys(root, ['data'], 'response envelope');
  return objectValue(root.data, 'response data');
}

function text(value, label, minimum, maximum, trim = true) {
  if (typeof value !== 'string') invalid(label);
  const result = trim ? value.trim() : value;
  if (
    result.length < minimum || result.length > maximum || CONTROL_PATTERN.test(result)
  ) invalid(label);
  return result;
}

function uuid(value, label) {
  const result = text(value, label, 36, 36, false);
  if (!UUID_PATTERN.test(result)) invalid(label);
  return result.toLowerCase();
}

function positiveInteger(value, label, maximum = 2_147_483_647) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid(label);
  return value;
}

function dateTime(value, label) {
  const result = text(value, label, 20, 64, false);
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds)) invalid(label);
  return new Date(milliseconds).toISOString();
}

function nullableDateTime(value, label) {
  return value === null || value === undefined ? null : dateTime(value, label);
}

function messageId(value, label) {
  const result = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : value;
  if (typeof result !== 'string' || !MESSAGE_ID_PATTERN.test(result)) invalid(label);
  return result;
}

function compareMessageIds(left, right) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function messageIds(value, label, { minimum = 1, sorted = false } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 500) invalid(label);
  const result = value.map((entry) => messageId(entry, label));
  if (new Set(result).size !== result.length) invalid(label);
  if (sorted && result.some((entry, index) => index > 0 && compareMessageIds(result[index - 1], entry) >= 0)) {
    invalid(label);
  }
  return result;
}

function sameValues(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function normalizeHandoffCorrectionRequest(value) {
  const input = objectValue(value, 'request');
  exactKeys(input, [
    'organizationId',
    'handoffId',
    'expectedVersionId',
    'expectedVersionNumber',
    'title',
    'details',
    'sourceLanguage',
    'shiftStartedAt',
    'shiftEndedAt',
    'sourceMessageIds',
    'acknowledgementDueAt',
    'reason',
    'idempotencyKey',
  ], 'request field');
  const organizationId = uuid(input.organizationId, 'organization');
  const handoffId = uuid(input.handoffId, 'handoff');
  const expectedVersionId = uuid(input.expectedVersionId, 'expected version');
  const expectedVersionNumber = positiveInteger(
    input.expectedVersionNumber,
    'expected version number',
  );
  const title = text(input.title, 'title', 1, 240);
  const details = text(input.details, 'details', 1, 30_000);
  const sourceLanguage = text(input.sourceLanguage, 'source language', 2, 2, false);
  if (!SUPPORTED_LANGUAGES.includes(sourceLanguage)) invalid('source language');
  const shiftStartedAt = dateTime(input.shiftStartedAt, 'shift start');
  const shiftEndedAt = dateTime(input.shiftEndedAt, 'shift end');
  if (Date.parse(shiftEndedAt) <= Date.parse(shiftStartedAt)) invalid('shift window');
  const sourceMessageIds = messageIds(input.sourceMessageIds, 'source message')
    .sort(compareMessageIds);
  const acknowledgementDueAt = nullableDateTime(
    input.acknowledgementDueAt,
    'acknowledgement deadline',
  );
  if (
    acknowledgementDueAt !== null &&
    Date.parse(acknowledgementDueAt) <= Date.parse(shiftEndedAt)
  ) invalid('acknowledgement deadline');
  const reason = text(input.reason, 'reason', 3, 2_000);
  const idempotencyKey = text(input.idempotencyKey, 'idempotency key', 8, 128, true);
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) invalid('idempotency key');
  return {
    organizationId,
    handoffId,
    expectedVersionId,
    expectedVersionNumber,
    title,
    details,
    sourceLanguage,
    shiftStartedAt,
    shiftEndedAt,
    sourceMessageIds,
    acknowledgementDueAt,
    reason,
    idempotencyKey,
  };
}

export function parseHandoffCorrectionReceipt(value, expected) {
  const context = normalizeHandoffCorrectionRequest(expected);
  const data = dataValue(value);
  exactKeys(data, [
    'handoffId',
    'handoffVersionId',
    'versionNumber',
    'status',
    'requiresSignature',
    'sourceMessageIds',
    'sourceFingerprint',
    'sourceState',
    'acknowledgementDueAt',
    'reminderState',
    'escalationState',
    'smsFallbackAvailable',
  ], 'response field');
  const handoffId = uuid(data.handoffId, 'response handoff');
  const versionId = uuid(data.handoffVersionId, 'response version');
  const versionNumber = positiveInteger(data.versionNumber, 'response version number');
  const sourceMessageIds = messageIds(data.sourceMessageIds, 'response source message', {
    sorted: true,
  });
  const sourceFingerprint = text(data.sourceFingerprint, 'source fingerprint', 64, 64, false);
  const acknowledgementDueAt = nullableDateTime(
    data.acknowledgementDueAt,
    'response acknowledgement deadline',
  );
  if (
    handoffId !== context.handoffId ||
    versionId === context.expectedVersionId ||
    versionNumber !== context.expectedVersionNumber + 1 ||
    data.status !== 'draft' ||
    data.requiresSignature !== true ||
    data.sourceState !== 'current' ||
    data.reminderState !== 'not_due' ||
    data.escalationState !== 'not_due' ||
    data.smsFallbackAvailable !== false ||
    !SHA256_PATTERN.test(sourceFingerprint) ||
    !sameValues(sourceMessageIds, context.sourceMessageIds) ||
    acknowledgementDueAt !== context.acknowledgementDueAt
  ) invalid('response consistency');
  return {
    handoffId,
    versionId,
    versionNumber,
    status: 'draft',
    requiresSignature: true,
    sourceMessageIds,
    sourceFingerprint,
    sourceState: 'current',
    acknowledgementDueAt,
    reminderState: 'not_due',
    escalationState: 'not_due',
    smsFallbackAvailable: false,
  };
}
