function normalizedNumericId(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return value.replace(/^0+(?=\d)/, '');
}

/** Compare decimal database identifiers without losing bigint precision. */
export function compareMessageIds(left, right) {
  const normalizedLeft = normalizedNumericId(left);
  const normalizedRight = normalizedNumericId(right);
  if (!normalizedLeft || !normalizedRight) return String(left).localeCompare(String(right));
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  return normalizedLeft.localeCompare(normalizedRight);
}

function messageTime(message) {
  const timestamp = Date.parse(message.createdAt ?? '');
  return Number.isNaN(timestamp) ? null : timestamp;
}

function compareMessages(left, right) {
  const leftTime = messageTime(left);
  const rightTime = messageTime(right);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (left.serverId && right.serverId) return compareMessageIds(left.serverId, right.serverId);
  if (left.serverId) return -1;
  if (right.serverId) return 1;
  return String(left.clientMessageId ?? left.id).localeCompare(
    String(right.clientMessageId ?? right.id),
  );
}

function matchingIndex(messages, candidate) {
  return messages.findIndex((message) =>
    (candidate.serverId && message.serverId === candidate.serverId)
    || (candidate.clientMessageId && message.clientMessageId === candidate.clientMessageId)
    || message.id === candidate.id
  );
}

/**
 * Merge authoritative pages and optimistic rows with deterministic order and
 * identity. This is safe for prepended history and concurrent tail arrivals.
 *
 * With `pruneMissingWithinPage`, an authoritative page is also treated as the
 * complete truth for the id range it spans: a server-backed row that sits
 * between the page's oldest and newest ids but is absent from the page was
 * deleted for everyone or hidden for this member, and is dropped. Rows older
 * than the page and optimistic rows without a server id are untouched.
 */
export function mergeTimelineMessages(existing, incoming, options = {}) {
  const merged = [...existing];
  for (const message of incoming) {
    const index = matchingIndex(merged, message);
    if (index === -1) {
      merged.push(message);
      continue;
    }
    const previous = merged[index];
    merged[index] = {
      ...previous,
      ...message,
      id: previous.id,
      failureReason: message.deliveryState === 'failed' ? message.failureReason : undefined,
    };
  }
  const pruned = options.pruneMissingWithinPage ? pruneMissingWithinPage(merged, incoming) : merged;
  return pruned.sort(compareMessages);
}

function pruneMissingWithinPage(merged, incoming) {
  const pageIds = incoming.map((message) => message.serverId).filter(Boolean);
  if (!pageIds.length) return merged;
  const oldest = pageIds.reduce((low, id) => (compareMessageIds(id, low) < 0 ? id : low));
  const newest = pageIds.reduce((high, id) => (compareMessageIds(id, high) > 0 ? id : high));
  const present = new Set(pageIds);
  return merged.filter((message) =>
    !message.serverId
    || present.has(message.serverId)
    || compareMessageIds(message.serverId, oldest) < 0
    || compareMessageIds(message.serverId, newest) > 0
  );
}

export function firstUnreadMessageId(messages, lastReadMessageId, unreadCount) {
  if (!unreadCount) return null;
  const incoming = messages.filter((message) => !message.isOwn && message.serverId);
  if (!incoming.length) return null;
  if (!lastReadMessageId) return incoming[0].id;
  return incoming.find((message) => compareMessageIds(message.serverId, lastReadMessageId) > 0)?.id
    ?? incoming[0].id;
}

export function latestIncomingServerMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message.isOwn && message.serverId) return message;
  }
  return null;
}
