export interface ConversationAvatarUploadGrant {
  action: 'upload';
  attachmentId: string;
  bucket: 'message-attachments';
  path: string;
  signedUrl: string;
  token: string;
  expiresInSeconds: 7200;
  messageId: string;
  scanStatus: 'pending';
  maximumByteSize: 5242880;
}

export interface ConversationAvatarReadGrant {
  attachmentId: string;
  signedUrl: string;
  expiresInSeconds: 120;
}

export interface ConversationAvatarActivationReceipt {
  conversationId: string;
  attachmentId: string;
  avatarPath: string;
  previousAvatarPath: string | null;
  activated: true;
}

export interface ConversationAvatarRemovalReceipt {
  conversationId: string;
  previousAvatarPath: string;
  avatarPath: null;
  removed: true;
}

export function parseConversationAvatarUploadGrant(value: unknown): ConversationAvatarUploadGrant;
export function parseConversationAvatarReadGrant(value: unknown): ConversationAvatarReadGrant;
export function parseConversationAvatarActivationReceipt(value: unknown): ConversationAvatarActivationReceipt;
export function parseConversationAvatarRemovalReceipt(value: unknown): ConversationAvatarRemovalReceipt;
