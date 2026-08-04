const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function member(value, values, label) {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}

function text(value, minimum, maximum, label) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function nullableText(value, maximum, label) {
  return value === null ? null : text(value, 1, maximum, label);
}

function identifier(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(`Invalid ${label}.`);
  return value.toLowerCase();
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function candidate(value) {
  const row = object(value, 'group creation candidate');
  exactKeys(row, [
    'userId',
    'displayName',
    'avatarPath',
    'jobTitle',
    'membershipRole',
    'membershipType',
    'accessExpiresAt',
  ], 'group creation candidate');
  const membershipRole = member(
    row.membershipRole,
    ['owner', 'admin', 'manager', 'member'],
    'candidate membership role',
  );
  const membershipType = member(
    row.membershipType,
    ['employee', 'contractor', 'guest'],
    'candidate membership type',
  );
  const accessExpiresAt = row.accessExpiresAt === null
    ? null
    : timestamp(row.accessExpiresAt, 'candidate access expiry');
  if (membershipType === 'guest' && (membershipRole !== 'member' || accessExpiresAt === null)) {
    throw new TypeError('Invalid guest group creation candidate.');
  }
  return {
    userId: identifier(row.userId, 'candidate identity'),
    displayName: text(row.displayName, 1, 160, 'candidate display name'),
    avatarPath: nullableText(row.avatarPath, 1024, 'candidate avatar path'),
    jobTitle: nullableText(row.jobTitle, 160, 'candidate job title'),
    membershipRole,
    membershipType,
    accessExpiresAt,
  };
}

export function parseGroupCreationCandidates(value) {
  const root = object(value, 'group creation candidate receipt');
  exactKeys(root, ['candidates', 'limit'], 'group creation candidate receipt');
  if (!Number.isSafeInteger(root.limit) || root.limit < 1 || root.limit > 100) {
    throw new TypeError('Invalid group creation candidate limit.');
  }
  if (!Array.isArray(root.candidates) || root.candidates.length > root.limit) {
    throw new TypeError('Invalid group creation candidates.');
  }
  const candidates = root.candidates.map(candidate);
  if (new Set(candidates.map((entry) => entry.userId)).size !== candidates.length) {
    throw new TypeError('Invalid duplicate group creation candidate.');
  }
  return { candidates, limit: root.limit };
}

export function parseGroupCreationReceipt(value) {
  const row = object(value, 'group creation receipt');
  exactKeys(row, [
    'conversationId',
    'kind',
    'name',
    'description',
    'historyPolicy',
    'historyDisclosure',
    'postingMode',
    'joinPolicy',
    'configuredJoinPolicy',
    'visibility',
    'memberCount',
    'memberLimit',
    'isReadOnly',
  ], 'group creation receipt');
  const historyPolicy = member(row.historyPolicy, ['all', 'since_join'], 'group history policy');
  const disclosure = object(row.historyDisclosure, 'group history disclosure');
  exactKeys(disclosure, ['policy', 'visibleFrom', 'labelKey'], 'group history disclosure');
  const visibleFrom = disclosure.visibleFrom === null
    ? null
    : timestamp(disclosure.visibleFrom, 'group history boundary');
  const labelKey = member(
    disclosure.labelKey,
    ['conversation.history.all', 'conversation.history.since_join'],
    'group history label',
  );
  if (
    disclosure.policy !== historyPolicy ||
    (historyPolicy === 'all' && (visibleFrom !== null || labelKey !== 'conversation.history.all')) ||
    (historyPolicy === 'since_join' &&
      (visibleFrom === null || labelKey !== 'conversation.history.since_join'))
  ) throw new TypeError('Invalid group history disclosure.');
  const configuredJoinPolicy = member(
    row.configuredJoinPolicy,
    ['inherit', 'invite_only', 'approval_required'],
    'configured group join policy',
  );
  const joinPolicy = member(row.joinPolicy, ['invite_only', 'approval_required'], 'group join policy');
  if (configuredJoinPolicy !== 'inherit' && configuredJoinPolicy !== joinPolicy) {
    throw new TypeError('Invalid effective group join policy.');
  }
  if (
    !Number.isSafeInteger(row.memberLimit) || row.memberLimit < 2 || row.memberLimit > 5000 ||
    !Number.isSafeInteger(row.memberCount) || row.memberCount < 2 || row.memberCount > row.memberLimit ||
    row.isReadOnly !== false
  ) throw new TypeError('Invalid group member receipt.');
  return {
    conversationId: identifier(row.conversationId, 'group conversation identity'),
    kind: member(row.kind, ['group', 'team', 'shift', 'incident'], 'group kind'),
    name: text(row.name, 1, 160, 'group name'),
    description: nullableText(row.description, 2000, 'group description'),
    historyPolicy,
    historyDisclosure: { policy: historyPolicy, visibleFrom, labelKey },
    postingMode: member(row.postingMode, ['all_members', 'admins_only'], 'group posting mode'),
    joinPolicy,
    configuredJoinPolicy,
    visibility: member(row.visibility, ['invite_only', 'organization', 'unit'], 'group visibility'),
    memberCount: row.memberCount,
    memberLimit: row.memberLimit,
    isReadOnly: false,
  };
}

export function parseConversationMemberRoleReceipt(value) {
  const row = object(value, 'conversation member role receipt');
  exactKeys(
    row,
    ['conversationId', 'userId', 'previousRole', 'role'],
    'conversation member role receipt',
  );
  const previousRole = member(
    row.previousRole,
    ['owner', 'admin', 'member'],
    'previous conversation member role',
  );
  const role = member(row.role, ['owner', 'admin', 'member'], 'conversation member role');
  if (previousRole === role) throw new TypeError('Invalid unchanged conversation member role.');
  return {
    conversationId: identifier(row.conversationId, 'role conversation identity'),
    userId: identifier(row.userId, 'role member identity'),
    previousRole,
    role,
  };
}
