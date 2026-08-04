const USE_CASES = new Set(['language_detection', 'translation', 'summary']);
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._/-]{1,159}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function exactKeys(row, allowed) {
  const keys = Object.keys(row);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw new TypeError('Invalid organization AI policy shape');
  }
}

function canonicalArray(value, allowed, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`Invalid ${label}`);
  const result = value.map((item) => {
    if (typeof item !== 'string' || item !== item.trim().toLowerCase()) {
      throw new TypeError(`Invalid ${label}`);
    }
    if (allowed ? !allowed.has(item) : !PROVIDER_PATTERN.test(item)) {
      throw new TypeError(`Invalid ${label}`);
    }
    return item;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`Duplicate ${label}`);
  return [...result].sort();
}

export function parseOrganizationAiPolicy(value, expectedOrganizationId) {
  const row = object(value);
  exactKeys(row, new Set([
    'organizationId', 'enabled', 'policyVersion', 'approvedUseCases',
    'providerAllowlist', 'routePolicy', 'tenantApproved',
    'globalKillSwitchStillRequired',
  ]));
  if (
    typeof row.organizationId !== 'string' || !UUID_PATTERN.test(row.organizationId) ||
    (expectedOrganizationId !== undefined && row.organizationId !== expectedOrganizationId)
  ) {
    throw new TypeError('Invalid organization AI policy organization');
  }
  if (typeof row.enabled !== 'boolean' || typeof row.tenantApproved !== 'boolean') {
    throw new TypeError('Invalid organization AI policy state');
  }
  if (!Number.isInteger(row.policyVersion) || row.policyVersion < 0 || row.policyVersion > 2_147_483_647) {
    throw new TypeError('Invalid organization AI policy version');
  }
  if (row.globalKillSwitchStillRequired !== true) {
    throw new TypeError('Invalid organization AI policy global gate');
  }
  if (row.routePolicy !== 'deny' && row.routePolicy !== 'approved_zero_retention') {
    throw new TypeError('Invalid organization AI route policy');
  }
  const approvedUseCases = canonicalArray(row.approvedUseCases, USE_CASES, 3, 'AI use cases');
  const providerAllowlist = canonicalArray(row.providerAllowlist, null, 20, 'AI providers');
  if (
    row.tenantApproved !== row.enabled ||
    (row.enabled && (
      row.policyVersion < 1 || row.routePolicy !== 'approved_zero_retention' ||
      approvedUseCases.length === 0 || providerAllowlist.length === 0
    )) ||
    (!row.enabled && (
      row.routePolicy !== 'deny' || approvedUseCases.length !== 0 || providerAllowlist.length !== 0
    ))
  ) throw new TypeError('Incoherent organization AI policy');
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    policyVersion: row.policyVersion,
    approvedUseCases,
    providerAllowlist,
    routePolicy: row.routePolicy,
    tenantApproved: row.tenantApproved,
    globalKillSwitchStillRequired: true,
  };
}

export function parseOrganizationAiPolicyUpdateReceipt(
  value,
  expectedOrganizationId,
  expectedUpdate,
) {
  if (typeof expectedOrganizationId !== 'string' || !UUID_PATTERN.test(expectedOrganizationId)) {
    throw new TypeError('Invalid expected organization AI policy organization');
  }
  const update = normalizeOrganizationAiPolicyUpdate(expectedUpdate);
  const policy = parseOrganizationAiPolicy(value, expectedOrganizationId);
  if (
    policy.policyVersion !== update.expectedVersion + 1 ||
    policy.enabled !== update.enabled ||
    policy.routePolicy !== update.routePolicy ||
    JSON.stringify(policy.approvedUseCases) !== JSON.stringify(update.approvedUseCases) ||
    JSON.stringify(policy.providerAllowlist) !== JSON.stringify(update.providerAllowlist)
  ) throw new TypeError('Mismatched organization AI policy receipt');
  return policy;
}

export function normalizeOrganizationAiPolicyUpdate(value) {
  const row = object(value);
  exactKeys(row, new Set([
    'enabled', 'approvedUseCases', 'providerAllowlist', 'routePolicy',
    'expectedVersion', 'reason',
  ]));
  if (
    typeof row.enabled !== 'boolean' || !Number.isInteger(row.expectedVersion) ||
    row.expectedVersion < 0 || row.expectedVersion > 2_147_483_646
  ) {
    throw new TypeError('Invalid organization AI policy update state');
  }
  if (typeof row.reason !== 'string' || row.reason.trim().length < 3 || row.reason.trim().length > 500) {
    throw new TypeError('Invalid organization AI policy reason');
  }
  const approvedUseCases = canonicalArray(row.approvedUseCases, USE_CASES, 3, 'AI use cases');
  const providerAllowlist = canonicalArray(row.providerAllowlist, null, 20, 'AI providers');
  const routePolicy = row.routePolicy;
  if (
    (row.enabled && (
      routePolicy !== 'approved_zero_retention' || approvedUseCases.length === 0 ||
      providerAllowlist.length === 0
    )) ||
    (!row.enabled && (
      routePolicy !== 'deny' || approvedUseCases.length !== 0 || providerAllowlist.length !== 0
    ))
  ) throw new TypeError('Incoherent organization AI policy update');
  return {
    enabled: row.enabled,
    approvedUseCases,
    providerAllowlist,
    routePolicy,
    expectedVersion: row.expectedVersion,
    reason: row.reason.trim(),
  };
}
