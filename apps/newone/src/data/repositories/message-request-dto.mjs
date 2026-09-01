const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function member(value, values, label) {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(`Invalid ${label}.`);
  return value.toLowerCase();
}

function messageIdentifier(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

/**
 * Parses the `/v2/contacts/message-requests` receipt defensively: the pinned
 * contract names `conversation_id`, `message_id`, and the connection status,
 * so both snake_case and camelCase spellings are accepted while every value
 * is still validated before use.
 */
export function parseMessageRequestReceipt(value) {
  const row = object(value, 'message request receipt');
  const conversationId = identifier(
    row.conversation_id ?? row.conversationId,
    'message request conversation',
  );
  const messageId = messageIdentifier(row.message_id ?? row.messageId, 'message request message');
  const connection = row.connection === undefined || row.connection === null
    ? {}
    : object(row.connection, 'message request connection');
  const connectionStatus = member(
    row.connection_status ?? row.connectionStatus ?? connection.status,
    ['pending', 'accepted'],
    'message request connection status',
  );
  return { conversationId, messageId, connectionStatus };
}
