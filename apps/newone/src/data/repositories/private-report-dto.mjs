const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_TYPES = Object.freeze(['message', 'group', 'member']);
const ACTIVE_STATUSES = Object.freeze(['open', 'assigned', 'in_review']);

function invalid() {
  throw new TypeError('invalid private report receipt');
}

function objectValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}

function exactKeys(value, keys) {
  const expected = new Set(keys);
  if (Object.keys(value).length !== expected.size) invalid();
  for (const key of Object.keys(value)) if (!expected.has(key)) invalid();
}

function dataValue(value) {
  const root = objectValue(value);
  if (Object.prototype.hasOwnProperty.call(root, 'data')) {
    exactKeys(root, ['data']);
    return objectValue(root.data);
  }
  return root;
}

export function parsePrivateReportReceipt(value, expectedTargetType) {
  if (!TARGET_TYPES.includes(expectedTargetType)) invalid();
  const row = dataValue(value);
  exactKeys(row, [
    'reportId',
    'status',
    'targetType',
    'created',
    'reporterIdentityProtected',
    'targetNotNotified',
    'noticeVersion',
    'contextBefore',
    'contextAfter',
  ]);
  const messageNotice = row.noticeVersion === 'moderation-report-v2' ||
    row.noticeVersion === 'moderation-share-v1';
  if (
    typeof row.reportId !== 'string' || !UUID_PATTERN.test(row.reportId) ||
    !ACTIVE_STATUSES.includes(row.status) ||
    row.targetType !== expectedTargetType ||
    typeof row.created !== 'boolean' ||
    row.reporterIdentityProtected !== true ||
    row.targetNotNotified !== true ||
    (expectedTargetType === 'message'
      ? !messageNotice
      : row.noticeVersion !== 'moderation-report-v2') ||
    !Number.isInteger(row.contextBefore) ||
    !Number.isInteger(row.contextAfter) ||
    row.contextBefore < 0 || row.contextBefore > 2 ||
    row.contextAfter < 0 || row.contextAfter > 2 ||
    (expectedTargetType !== 'message' && (row.contextBefore !== 0 || row.contextAfter !== 0)) ||
    (row.created === true && row.status !== 'open')
  ) invalid();
  return {
    reportId: row.reportId.toLowerCase(),
    status: row.status,
    targetType: row.targetType,
    created: row.created,
    reporterIdentityProtected: true,
    targetNotNotified: true,
    noticeVersion: row.noticeVersion,
    contextBefore: row.contextBefore,
    contextAfter: row.contextAfter,
  };
}
