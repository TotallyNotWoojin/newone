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
 * An own upload this device has not finished knows more than the server row,
 * which until finalize has no attachment yet or a pending one. Taking the
 * row's version wiped the photo, its progress, the failure and Retry, and
 * every later progress patch then had nothing to land on: a refused upload
 * was left as a blank bubble (Sep 23 2026). The server wins again once it
 * holds the clean file.
 */
function mergedAttachment(previous, message) {
  const local = previous.attachment;
  const state = local?.transfer?.state;
  if (!state || state === 'uploaded') return message.attachment;
  if (!message.attachment) return local;
  if (message.attachment.status === 'clean') return message.attachment;
  return {
    ...message.attachment,
    ...(local.localUri ? { localUri: local.localUri } : {}),
    transfer: local.transfer,
  };
}

/**
 * Merge authoritative pages and optimistic rows with deterministic order and
 * identity. This is safe for prepended history and concurrent tail arrivals.
 *
 * With `pruneMissingWithinPage`, an authoritative tail page is also treated as
 * the complete truth from its oldest id onwards: a server-backed row at or
 * above that id which the page omits was deleted for everyone or hidden for
 * this member, and is dropped. Rows older than the page, optimistic rows
 * without a server id, and own sends still settling are untouched.
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
    const attachment = mergedAttachment(previous, message);
    const uploadInterrupted = ['failed', 'cancelled'].includes(attachment?.transfer?.state);
    merged[index] = {
      ...previous,
      ...message,
      id: previous.id,
      attachment,
      failureReason: message.deliveryState === 'failed'
        ? message.failureReason
        : uploadInterrupted ? previous.failureReason : undefined,
    };
  }
  const pruned = options.pruneMissingWithinPage ? pruneMissingWithinPage(merged, incoming, options.now) : merged;
  return pruned.sort(compareMessages);
}

const OWN_SEND_SETTLE_MS = 60_000;

function pruneMissingWithinPage(merged, incoming, now = Date.now()) {
  const pageIds = incoming.map((message) => message.serverId).filter(Boolean);
  if (!pageIds.length) return merged;
  const oldest = pageIds.reduce((low, id) => (compareMessageIds(id, low) < 0 ? id : low));
  const newest = pageIds.reduce((high, id) => (compareMessageIds(id, high) > 0 ? id : high));
  const present = new Set(pageIds);
  return merged.filter((message) => {
    if (!message.serverId || present.has(message.serverId)) return true;
    if (compareMessageIds(message.serverId, oldest) < 0) return true;
    if (compareMessageIds(message.serverId, newest) <= 0) return false;
    // The page is the conversation's tail, so a server row newer than it that
    // the page omits was deleted or hidden as well — except an own send that
    // may have been acknowledged while this page was already in flight.
    const sentAt = Date.parse(message.createdAt ?? '');
    const settling = message.isOwn && (Number.isNaN(sentAt) || now - sentAt < OWN_SEND_SETTLE_MS);
    return settling;
  });
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
