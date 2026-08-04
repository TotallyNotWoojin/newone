export interface ConversationDepartureReceipt {
  conversationId: string;
  left: true;
  roleAtDeparture: 'owner' | 'admin' | 'member';
  ownershipTransferred: boolean;
  historyPreserved: true;
  futureAccessRevoked: true;
  leftAt: string;
}

export function parseConversationDepartureReceipt(
  value: unknown,
  expectedConversationId: string,
): ConversationDepartureReceipt;
