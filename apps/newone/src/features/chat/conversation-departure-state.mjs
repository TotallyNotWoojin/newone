export function conversationOutboxCommandIds(commands, conversationId) {
  if (!Array.isArray(commands) || typeof conversationId !== 'string' || !conversationId) return [];
  return commands
    .filter((command) => {
      const payload = command && typeof command.payload === 'object' && command.payload !== null
        ? command.payload
        : {};
      return payload.conversationId === conversationId;
    })
    .map((command) => command.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
}

export function redactDepartedConversation(snapshot, conversationId) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const messages = { ...(snapshot.messages ?? {}) };
  const cursors = { ...(snapshot.cursors ?? {}) };
  delete messages[conversationId];
  delete cursors[conversationId];
  return {
    ...snapshot,
    conversations: (snapshot.conversations ?? []).filter((item) => item.id !== conversationId),
    messages,
    cursors,
    handoffs: (snapshot.handoffs ?? []).filter((item) => item.conversationId !== conversationId),
    summaries: (snapshot.summaries ?? []).filter((item) => item.conversationId !== conversationId),
    actions: (snapshot.actions ?? []).filter((item) => item.conversationId !== conversationId),
    moderationReports: (snapshot.moderationReports ?? []).filter(
      (item) => item.conversationId !== conversationId,
    ),
    auditEvents: (snapshot.auditEvents ?? []).filter((item) => item.entityId !== conversationId),
  };
}
