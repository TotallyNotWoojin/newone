const ROLES = new Set(['owner', 'admin', 'member']);

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function parseConversationDepartureReceipt(value, expectedConversationId) {
  const row = objectValue(value);
  const allowed = new Set([
    'conversationId',
    'left',
    'roleAtDeparture',
    'ownershipTransferred',
    'historyPreserved',
    'futureAccessRevoked',
    'leftAt',
  ]);
  const keysValid = Object.keys(row).every((key) => allowed.has(key));
  const leftAt = row.leftAt;
  if (
    !keysValid
    || row.conversationId !== expectedConversationId
    || row.left !== true
    || !ROLES.has(row.roleAtDeparture)
    || typeof row.ownershipTransferred !== 'boolean'
    || row.historyPreserved !== true
    || row.futureAccessRevoked !== true
    || typeof leftAt !== 'string'
    || !Number.isFinite(Date.parse(leftAt))
  ) {
    throw new TypeError('invalid conversation departure receipt');
  }
  return {
    conversationId: row.conversationId,
    left: true,
    roleAtDeparture: row.roleAtDeparture,
    ownershipTransferred: row.ownershipTransferred,
    historyPreserved: true,
    futureAccessRevoked: true,
    leftAt,
  };
}
