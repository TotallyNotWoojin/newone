/**
 * The conversation the reader is looking at right now, if any.
 *
 * A push for a chat that is already open on screen is noise: the message is
 * already there. The notification handler reads this to stay quiet for that
 * one conversation while still announcing every other. It is deliberately a
 * module-level value rather than context: the handler runs outside React.
 */
let visibleConversationId: string | null = null;

export function setVisibleConversation(conversationId: string | null): void {
  visibleConversationId = conversationId && conversationId.length > 0 ? conversationId : null;
}

export function getVisibleConversation(): string | null {
  return visibleConversationId;
}

/** True when a notification announces the conversation already on screen. */
export function announcesVisibleConversation(
  data: unknown,
  visible: string | null = visibleConversationId,
): boolean {
  if (!visible) return false;
  if (!data || typeof data !== 'object') return false;
  const conversationId = (data as { conversation_id?: unknown }).conversation_id;
  return typeof conversationId === 'string' && conversationId === visible;
}
