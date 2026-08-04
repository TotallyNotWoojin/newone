const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`Invalid ${label}.`);
  }
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(`Invalid ${label}.`);
  return value.toLowerCase();
}

function nullableUuid(value, label) {
  return value === null ? null : uuid(value, label);
}

function text(value, minimum, maximum, label) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

function fingerprint(value, label) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function nullableFingerprint(value, label) {
  return value === null ? null : fingerprint(value, label);
}

function member(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function uniqueSorted(values, limit, parser, label) {
  if (!Array.isArray(values) || values.length > limit) throw new TypeError(`Invalid ${label}.`);
  const parsed = values.map((value) => parser(value));
  if (
    new Set(parsed).size !== parsed.length ||
    parsed.some((value, index) => index > 0 && parsed[index - 1].localeCompare(value) >= 0)
  ) throw new TypeError(`Invalid ${label}.`);
  return parsed;
}

export function parseDynamicGroupPolicySpec(value) {
  const row = object(value, 'dynamic-group policy selector');
  exactKeys(row, [
    'siteIds',
    'departmentIds',
    'teamIds',
    'lineIds',
    'unitIds',
    'includeDescendants',
    'operationalRoles',
    'membershipRoles',
    'shiftMode',
    'scheduledShiftStartsAt',
    'scheduledShiftEndsAt',
  ], 'dynamic-group policy selector');
  const siteIds = uniqueSorted(row.siteIds, 100, (item) => uuid(item, 'site selector'), 'site selectors');
  const departmentIds = uniqueSorted(
    row.departmentIds,
    100,
    (item) => uuid(item, 'department selector'),
    'department selectors',
  );
  const teamIds = uniqueSorted(row.teamIds, 100, (item) => uuid(item, 'team selector'), 'team selectors');
  const lineIds = uniqueSorted(row.lineIds, 100, (item) => uuid(item, 'line selector'), 'line selectors');
  const unitIds = uniqueSorted(row.unitIds, 100, (item) => uuid(item, 'unit selector'), 'unit selectors');
  const operationalRoles = uniqueSorted(
    row.operationalRoles,
    50,
    (item) => {
      const role = text(item, 1, 160, 'operational role');
      if (role !== role.trim().toLowerCase()) throw new TypeError('Invalid operational role.');
      return role;
    },
    'operational roles',
  );
  const membershipRoles = uniqueSorted(
    row.membershipRoles,
    4,
    (item) => member(item, ['owner', 'admin', 'manager', 'member'], 'membership role'),
    'membership roles',
  );
  if (membershipRoles.length < 1 || typeof row.includeDescendants !== 'boolean') {
    throw new TypeError('Invalid dynamic-group policy selector.');
  }
  const shiftMode = member(row.shiftMode, ['none', 'current', 'scheduled'], 'shift mode');
  const scheduledShiftStartsAt = nullableTimestamp(
    row.scheduledShiftStartsAt,
    'scheduled shift start',
  );
  const scheduledShiftEndsAt = nullableTimestamp(row.scheduledShiftEndsAt, 'scheduled shift end');
  if (
    (shiftMode !== 'scheduled' &&
      (scheduledShiftStartsAt !== null || scheduledShiftEndsAt !== null)) ||
    (shiftMode === 'scheduled' &&
      (scheduledShiftStartsAt === null || scheduledShiftEndsAt === null ||
        Date.parse(scheduledShiftEndsAt) <= Date.parse(scheduledShiftStartsAt) ||
        Date.parse(scheduledShiftEndsAt) - Date.parse(scheduledShiftStartsAt) >
          31 * 24 * 60 * 60 * 1000))
  ) throw new TypeError('Invalid dynamic-group shift window.');
  return {
    siteIds,
    departmentIds,
    teamIds,
    lineIds,
    unitIds,
    includeDescendants: row.includeDescendants,
    operationalRoles,
    membershipRoles,
    shiftMode,
    scheduledShiftStartsAt,
    scheduledShiftEndsAt,
  };
}

function policy(value) {
  const row = object(value, 'dynamic-group policy');
  exactKeys(row, [
    'policyId',
    'conversationId',
    'conversationName',
    'conversationKind',
    'conversationUnitId',
    'status',
    'version',
    'draftState',
    'policySpec',
    'maximumMembers',
    'selectorFingerprint',
    'publishedVersionId',
    'lastPreviewFingerprint',
    'lastPreviewedAt',
    'lastSyncedAt',
    'nextEvaluationAt',
    'sourceChangedAt',
    'createdAt',
    'updatedAt',
  ], 'dynamic-group policy');
  const status = member(row.status, ['draft', 'active', 'paused'], 'dynamic-group policy status');
  const draftState = member(
    row.draftState,
    ['draft', 'previewed', 'published'],
    'dynamic-group draft state',
  );
  const publishedVersionId = nullableUuid(row.publishedVersionId, 'published dynamic-group version');
  const lastPreviewFingerprint = nullableFingerprint(
    row.lastPreviewFingerprint,
    'dynamic-group preview fingerprint',
  );
  const lastPreviewedAt = nullableTimestamp(row.lastPreviewedAt, 'dynamic-group preview time');
  if (
    (status === 'draft' && publishedVersionId !== null) ||
    (status !== 'draft' && publishedVersionId === null) ||
    (draftState === 'draft' &&
      (lastPreviewFingerprint !== null || lastPreviewedAt !== null)) ||
    (draftState !== 'draft' &&
      (lastPreviewFingerprint === null || lastPreviewedAt === null))
  ) throw new TypeError('Invalid dynamic-group policy state.');
  return {
    policyId: uuid(row.policyId, 'dynamic-group policy'),
    conversationId: uuid(row.conversationId, 'dynamic-group conversation'),
    conversationName: text(row.conversationName, 1, 160, 'dynamic-group conversation name'),
    conversationKind: member(
      row.conversationKind,
      ['group', 'team', 'shift'],
      'dynamic-group conversation kind',
    ),
    conversationUnitId: nullableUuid(row.conversationUnitId, 'dynamic-group conversation unit'),
    status,
    version: integer(row.version, 1, 2_147_483_647, 'dynamic-group policy version'),
    draftState,
    policySpec: parseDynamicGroupPolicySpec(row.policySpec),
    maximumMembers: integer(row.maximumMembers, 1, 5000, 'dynamic-group maximum members'),
    selectorFingerprint: fingerprint(row.selectorFingerprint, 'dynamic-group selector fingerprint'),
    publishedVersionId,
    lastPreviewFingerprint,
    lastPreviewedAt,
    lastSyncedAt: nullableTimestamp(row.lastSyncedAt, 'dynamic-group sync time'),
    nextEvaluationAt: nullableTimestamp(row.nextEvaluationAt, 'dynamic-group next evaluation'),
    sourceChangedAt: nullableTimestamp(row.sourceChangedAt, 'dynamic-group source change'),
    createdAt: timestamp(row.createdAt, 'dynamic-group creation time'),
    updatedAt: timestamp(row.updatedAt, 'dynamic-group update time'),
  };
}

export function parseDynamicGroupPolicyList(value) {
  const row = object(value, 'dynamic-group policy list');
  exactKeys(row, ['policies', 'limit', 'nextAfterPolicyId'], 'dynamic-group policy list');
  const limit = integer(row.limit, 1, 100, 'dynamic-group policy list limit');
  if (!Array.isArray(row.policies) || row.policies.length > limit) {
    throw new TypeError('Invalid dynamic-group policies.');
  }
  const policies = row.policies.map(policy);
  if (
    new Set(policies.map((item) => item.policyId)).size !== policies.length ||
    policies.some((item, index) => index > 0 && policies[index - 1].policyId >= item.policyId)
  ) throw new TypeError('Invalid dynamic-group policy order.');
  const nextAfterPolicyId = nullableUuid(row.nextAfterPolicyId, 'dynamic-group policy cursor');
  if (
    nextAfterPolicyId !== null &&
    (policies.length !== limit || policies.at(-1)?.policyId !== nextAfterPolicyId)
  ) throw new TypeError('Invalid dynamic-group policy cursor.');
  return { policies, limit, nextAfterPolicyId };
}

export function parseDynamicGroupSaveReceipt(value) {
  const row = object(value, 'dynamic-group save receipt');
  exactKeys(row, [
    'policyId',
    'conversationId',
    'version',
    'draftState',
    'selectorFingerprint',
    'requiresPreview',
    'publishedVersionId',
  ], 'dynamic-group save receipt');
  if (row.draftState !== 'draft' || row.requiresPreview !== true) {
    throw new TypeError('Invalid dynamic-group save receipt.');
  }
  return {
    policyId: uuid(row.policyId, 'dynamic-group policy'),
    conversationId: uuid(row.conversationId, 'dynamic-group conversation'),
    version: integer(row.version, 1, 2_147_483_647, 'dynamic-group policy version'),
    draftState: 'draft',
    selectorFingerprint: fingerprint(row.selectorFingerprint, 'dynamic-group selector fingerprint'),
    requiresPreview: true,
    publishedVersionId: nullableUuid(row.publishedVersionId, 'published dynamic-group version'),
  };
}

function sampleIds(value, count, label) {
  const samples = uniqueSorted(value, 200, (item) => uuid(item, `${label} member`), `${label} samples`);
  if (samples.length > count) throw new TypeError(`Invalid ${label} samples.`);
  return samples;
}

export function parseDynamicGroupPreviewReceipt(value) {
  const row = object(value, 'dynamic-group preview receipt');
  exactKeys(row, [
    'policyId',
    'policyVersion',
    'previewFingerprint',
    'selectorFingerprint',
    'membershipStateFingerprint',
    'evaluatedAt',
    'validUntil',
    'eligibleCount',
    'addedCount',
    'removedCount',
    'unchangedCount',
    'addedSampleUserIds',
    'removedSampleUserIds',
    'unchangedSampleUserIds',
    'nextBoundaryAt',
  ], 'dynamic-group preview receipt');
  const eligibleCount = integer(row.eligibleCount, 0, 5000, 'eligible member count');
  const addedCount = integer(row.addedCount, 0, 5000, 'added member count');
  const removedCount = integer(row.removedCount, 0, 5000, 'removed member count');
  const unchangedCount = integer(row.unchangedCount, 0, 5000, 'unchanged member count');
  if (addedCount + unchangedCount !== eligibleCount) {
    throw new TypeError('Invalid dynamic-group preview counts.');
  }
  const addedSampleUserIds = sampleIds(row.addedSampleUserIds, addedCount, 'added');
  const removedSampleUserIds = sampleIds(row.removedSampleUserIds, removedCount, 'removed');
  const unchangedSampleUserIds = sampleIds(row.unchangedSampleUserIds, unchangedCount, 'unchanged');
  const allSamples = [...addedSampleUserIds, ...removedSampleUserIds, ...unchangedSampleUserIds];
  if (new Set(allSamples).size !== allSamples.length) {
    throw new TypeError('Invalid overlapping dynamic-group preview samples.');
  }
  return {
    policyId: uuid(row.policyId, 'dynamic-group policy'),
    policyVersion: integer(row.policyVersion, 1, 2_147_483_647, 'dynamic-group policy version'),
    previewFingerprint: fingerprint(row.previewFingerprint, 'dynamic-group preview fingerprint'),
    selectorFingerprint: fingerprint(row.selectorFingerprint, 'dynamic-group selector fingerprint'),
    membershipStateFingerprint: fingerprint(
      row.membershipStateFingerprint,
      'dynamic-group membership fingerprint',
    ),
    evaluatedAt: timestamp(row.evaluatedAt, 'dynamic-group evaluation time'),
    validUntil: timestamp(row.validUntil, 'dynamic-group preview expiry'),
    eligibleCount,
    addedCount,
    removedCount,
    unchangedCount,
    addedSampleUserIds,
    removedSampleUserIds,
    unchangedSampleUserIds,
    nextBoundaryAt: nullableTimestamp(row.nextBoundaryAt, 'dynamic-group next boundary'),
  };
}

export function parseDynamicGroupPublishReceipt(value) {
  const row = object(value, 'dynamic-group publish receipt');
  exactKeys(row, [
    'policyId',
    'policyVersion',
    'publishedVersionId',
    'status',
    'draftState',
    'eligibleCount',
    'addedCount',
    'removedCount',
    'unchangedCount',
    'selectorFingerprint',
    'nextEvaluationAt',
  ], 'dynamic-group publish receipt');
  const eligibleCount = integer(row.eligibleCount, 0, 5000, 'eligible member count');
  const addedCount = integer(row.addedCount, 0, 5000, 'added member count');
  const removedCount = integer(row.removedCount, 0, 5000, 'removed member count');
  const unchangedCount = integer(row.unchangedCount, 0, 5000, 'unchanged member count');
  if (
    row.status !== 'active' || row.draftState !== 'published' ||
    addedCount + unchangedCount !== eligibleCount
  ) throw new TypeError('Invalid dynamic-group publish receipt.');
  return {
    policyId: uuid(row.policyId, 'dynamic-group policy'),
    policyVersion: integer(row.policyVersion, 1, 2_147_483_647, 'dynamic-group policy version'),
    publishedVersionId: uuid(row.publishedVersionId, 'published dynamic-group version'),
    status: 'active',
    draftState: 'published',
    eligibleCount,
    addedCount,
    removedCount,
    unchangedCount,
    selectorFingerprint: fingerprint(row.selectorFingerprint, 'dynamic-group selector fingerprint'),
    nextEvaluationAt: nullableTimestamp(row.nextEvaluationAt, 'dynamic-group next evaluation'),
  };
}

export function parseDynamicGroupPauseReceipt(value) {
  const row = object(value, 'dynamic-group pause receipt');
  exactKeys(row, ['policyId', 'policyVersion', 'status', 'pausedAt'], 'dynamic-group pause receipt');
  if (row.status !== 'paused') throw new TypeError('Invalid dynamic-group pause receipt.');
  return {
    policyId: uuid(row.policyId, 'dynamic-group policy'),
    policyVersion: integer(row.policyVersion, 1, 2_147_483_647, 'dynamic-group policy version'),
    status: 'paused',
    pausedAt: timestamp(row.pausedAt, 'dynamic-group pause time'),
  };
}
