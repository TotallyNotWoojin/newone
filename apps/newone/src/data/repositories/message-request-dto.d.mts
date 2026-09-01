export interface MessageRequestReceipt {
  conversationId: string;
  messageId: string;
  connectionStatus: 'pending' | 'accepted';
}

export function parseMessageRequestReceipt(value: unknown): MessageRequestReceipt;
