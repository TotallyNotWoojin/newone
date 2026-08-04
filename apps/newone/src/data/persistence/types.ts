export type OutboxCommandKind =
  | 'send_message'
  | 'message_receipt'
  | 'acknowledge_update'
  | 'register_device';
export type OutboxCommandState = 'queued' | 'sending' | 'failed';

export interface OutboxCommand<TPayload = unknown> {
  id: string;
  organizationId: string;
  userId: string;
  kind: OutboxCommandKind;
  payload: TPayload;
  createdAt: string;
  attempts: number;
  state: OutboxCommandState;
  lastErrorCode?: string;
}

export interface VisibleMessageOutboxItem {
  id: string;
  conversationId: string;
  clientMessageId: string;
  body: string;
  createdAt: string;
  attempts: number;
  state: OutboxCommand['state'];
  lastErrorCode: string | null;
  canEdit: boolean;
  canRetry: boolean;
  deliveryAmbiguous: boolean;
}

export interface ClientStore {
  initialize(): Promise<void>;
  putCache(key: string, value: string, expiresAt?: string): Promise<void>;
  getCache(key: string): Promise<string | null>;
  removeCache(key: string): Promise<void>;
  enqueue(command: OutboxCommand): Promise<void>;
  listOutbox(userId: string, organizationId: string): Promise<OutboxCommand[]>;
  updateOutbox(command: OutboxCommand): Promise<void>;
  removeOutbox(id: string): Promise<void>;
  purgeUser(userId: string): Promise<void>;
}
