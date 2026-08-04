const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function validMentionUserIds(value) {
  return value === undefined
    || (Array.isArray(value)
      && value.length <= 50
      && value.every((userId) => typeof userId === 'string' && UUID.test(userId))
      && new Set(value).size === value.length);
}

function validSendCommand(value, userId, organizationId) {
  const command = objectValue(value);
  const payload = objectValue(command?.payload);
  return command
    && payload
    && command.kind === 'send_message'
    && command.userId === userId
    && command.organizationId === organizationId
    && UUID.test(userId)
    && UUID.test(organizationId)
    && typeof command.id === 'string'
    && UUID.test(command.id)
    && typeof command.createdAt === 'string'
    && Number.isFinite(Date.parse(command.createdAt))
    && Number.isInteger(command.attempts)
    && command.attempts >= 0
    && ['queued', 'sending', 'failed'].includes(command.state)
    && typeof payload.conversationId === 'string'
    && UUID.test(payload.conversationId)
    && typeof payload.clientMessageId === 'string'
    && UUID.test(payload.clientMessageId)
    && payload.organizationId === organizationId
    && payload.idempotencyKey === payload.clientMessageId
    && (payload.body === null || (typeof payload.body === 'string' && payload.body.length <= 12_000))
    && validMentionUserIds(payload.mentionUserIds);
}

export function visibleMessageOutbox(commands, userId, organizationId) {
  if (!Array.isArray(commands) || typeof userId !== 'string' || typeof organizationId !== 'string') {
    return [];
  }
  return commands
    .filter((command) => validSendCommand(command, userId, organizationId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((command) => ({
      id: command.id,
      conversationId: command.payload.conversationId,
      clientMessageId: command.payload.clientMessageId,
      body: command.payload.body ?? '',
      createdAt: command.createdAt,
      attempts: command.attempts,
      state: command.state,
      lastErrorCode: typeof command.lastErrorCode === 'string' ? command.lastErrorCode : null,
      canEdit: command.state === 'queued' && command.attempts === 0,
      canRetry: command.state === 'failed',
      deliveryAmbiguous: command.state === 'queued' && command.attempts > 0,
    }));
}

export function editUnattemptedMessageCommand(command, body) {
  const root = objectValue(command);
  const payload = objectValue(root?.payload);
  const nextBody = typeof body === 'string' ? body.trim() : '';
  if (
    !root
    || !payload
    || !validSendCommand(root, root.userId, root.organizationId)
    || root.kind !== 'send_message'
    || root.state !== 'queued'
    || root.attempts !== 0
    || nextBody.length < 1
    || nextBody.length > 12_000
  ) return null;
  return {
    ...root,
    payload: { ...payload, body: nextBody },
    lastErrorCode: undefined,
  };
}

export function retryFailedMessageCommand(command) {
  const root = objectValue(command);
  if (
    !root
    || !validSendCommand(root, root.userId, root.organizationId)
    || root.state !== 'failed'
  ) return null;
  return { ...root, state: 'queued', lastErrorCode: undefined };
}
