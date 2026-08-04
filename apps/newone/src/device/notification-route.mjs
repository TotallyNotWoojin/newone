const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function uuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function positiveInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
}

/**
 * Convert the deliberately content-free server push envelope into an internal route.
 * No URL, path, title, or body supplied by the push provider is ever trusted.
 */
export function notificationDestination(value) {
  const data = record(value);
  if (!data) return null;
  const organizationId = uuid(data.organization_id);
  if (!organizationId || typeof data.event_type !== 'string') return null;

  if (data.event_type === 'message.changed') {
    const conversationId = uuid(data.conversation_id);
    if (!conversationId || !positiveInteger(data.message_id)) return null;
    return {
      organizationId,
      href: `/conversation/${conversationId}`,
      key: `message:${conversationId}:${String(data.message_id)}`,
    };
  }

  if (data.event_type === 'conversation.changed') {
    const conversationId = uuid(data.conversation_id);
    if (!conversationId) return null;
    return {
      organizationId,
      href: `/conversation/${conversationId}`,
      key: `conversation:${conversationId}`,
    };
  }

  if (data.event_type === 'announcement.changed') {
    const announcementId = uuid(data.announcement_id);
    if (!announcementId) return null;
    return {
      organizationId,
      href: '/updates',
      key: `announcement:${announcementId}`,
    };
  }

  if (data.event_type === 'handoff.changed') {
    const handoffId = uuid(data.handoff_id);
    if (!handoffId) return null;
    return {
      organizationId,
      href: '/handoffs',
      key: `handoff:${handoffId}`,
    };
  }

  return null;
}
