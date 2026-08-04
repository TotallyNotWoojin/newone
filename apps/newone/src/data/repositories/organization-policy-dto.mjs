const GROUP_CREATION_POLICIES = new Set(['members', 'managers', 'admins']);
const DM_POLICIES = new Set(['directory_open', 'request_first', 'scoped_unit']);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function integer(value, minimum, maximum, label) {
  if (Number.isInteger(value) && value >= minimum && value <= maximum) return value;
  throw new TypeError(`Invalid ${label}`);
}

function boolean(value, label) {
  if (typeof value === 'boolean') return value;
  throw new TypeError(`Invalid ${label}`);
}

export function parseOrganizationPolicy(value) {
  const row = object(value);
  const allowed = new Set([
    'messageRetentionDays', 'allowMemberDirectMessages', 'dmPolicy',
    'requireMfaForAdmins', 'shiftScheduleAuthoritative', 'groupCreationPolicy',
    'allowExternalGuests', 'externalGuestMaxAccessDays', 'version',
  ]);
  if (Object.keys(row).length !== allowed.size || Object.keys(row).some((key) => !allowed.has(key))) {
    throw new TypeError('Invalid organization policy shape');
  }
  if (!GROUP_CREATION_POLICIES.has(row.groupCreationPolicy)) {
    throw new TypeError('Invalid group creation policy');
  }
  if (!DM_POLICIES.has(row.dmPolicy)) throw new TypeError('Invalid direct message policy');
  return {
    messageRetentionDays: integer(row.messageRetentionDays, 1, 3650, 'message retention'),
    allowMemberDirectMessages: boolean(
      row.allowMemberDirectMessages,
      'member direct message setting',
    ),
    dmPolicy: row.dmPolicy,
    requireMfaForAdmins: boolean(row.requireMfaForAdmins, 'administrator MFA setting'),
    shiftScheduleAuthoritative: boolean(
      row.shiftScheduleAuthoritative,
      'shift schedule authority setting',
    ),
    groupCreationPolicy: row.groupCreationPolicy,
    allowExternalGuests: boolean(row.allowExternalGuests, 'external guest setting'),
    externalGuestMaxAccessDays: integer(
      row.externalGuestMaxAccessDays,
      1,
      365,
      'external guest access duration',
    ),
    version: integer(row.version, 1, Number.MAX_SAFE_INTEGER, 'policy version'),
  };
}

export function normalizeOrganizationPolicyUpdate(value) {
  const row = object(value);
  const { reason, ...policyValue } = row;
  const policy = parseOrganizationPolicy(policyValue);
  if (Object.keys(row).length !== 10 || typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
    throw new TypeError('Invalid policy audit reason');
  }
  return { ...policy, reason: reason.trim() };
}
