const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAX_MESSAGE_MENTIONS = 50;

function validId(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function normalizeMentionSelection(
  value,
  memberUserIds,
  currentUserId,
  limit = MAX_MESSAGE_MENTIONS,
) {
  if (!Array.isArray(value) || !Array.isArray(memberUserIds) || !Number.isInteger(limit) || limit < 1) {
    return [];
  }
  const allowed = new Set(memberUserIds.filter(validId));
  const seen = new Set();
  const result = [];
  for (const userId of value) {
    if (
      !validId(userId)
      || userId === currentUserId
      || !allowed.has(userId)
      || seen.has(userId)
    ) continue;
    seen.add(userId);
    result.push(userId);
    if (result.length === limit) break;
  }
  return result;
}

export function isValidMentionSelection(
  value,
  memberUserIds,
  currentUserId,
  limit = MAX_MESSAGE_MENTIONS,
) {
  if (!Array.isArray(value) || value.length > limit) return false;
  const normalized = normalizeMentionSelection(value, memberUserIds, currentUserId, limit);
  return normalized.length === value.length
    && normalized.every((userId, index) => userId === value[index]);
}

export function mentionablePeople(people, memberUserIds, currentUserId) {
  if (!Array.isArray(people) || !Array.isArray(memberUserIds)) return [];
  const allowed = new Set(memberUserIds.filter(validId));
  return people.filter((person) => person
    && validId(person.id)
    && person.id !== currentUserId
    && allowed.has(person.id)
    && person.suspended !== true);
}

export function parseMentionDto(value, limit = MAX_MESSAGE_MENTIONS) {
  if (!Array.isArray(value) || value.length > limit) return null;
  if (!value.every(validId) || new Set(value).size !== value.length) return null;
  return [...value];
}
