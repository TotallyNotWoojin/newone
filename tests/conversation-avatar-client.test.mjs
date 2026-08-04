import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseConversationAvatarActivationReceipt,
  parseConversationAvatarReadGrant,
  parseConversationAvatarRemovalReceipt,
  parseConversationAvatarUploadGrant,
} from '../apps/newone/src/data/repositories/conversation-avatar-dto.mjs';

const organizationId = '10000000-0000-4000-8000-000000000001';
const conversationId = '20000000-0000-4000-8000-000000000002';
const actorId = '30000000-0000-4000-8000-000000000003';
const attachmentId = '40000000-0000-4000-8000-000000000004';
const avatarPath = `${organizationId}/${conversationId}/${actorId}/${attachmentId}/upload`;

test('avatar upload grants are exact, bounded, and scoped to a structured storage path', () => {
  const grant = {
    action: 'upload',
    attachmentId,
    messageId: '101',
    bucket: 'message-attachments',
    path: avatarPath,
    scanStatus: 'pending',
    maximumByteSize: 5 * 1024 * 1024,
    signedUrl: 'https://project.supabase.co/storage/v1/object/upload/sign/message-attachments/path?token=x',
    token: 'upload-token',
    expiresInSeconds: 7200,
  };
  assert.deepEqual(parseConversationAvatarUploadGrant(grant), grant);
  assert.throws(
    () => parseConversationAvatarUploadGrant({ ...grant, maximumByteSize: 6 * 1024 * 1024 }),
    /Invalid conversation avatar upload grant/,
  );
  assert.throws(
    () => parseConversationAvatarUploadGrant({ ...grant, path: `${organizationId}/unsafe/upload` }),
    /Invalid conversation avatar path/,
  );
  assert.throws(
    () => parseConversationAvatarUploadGrant({ ...grant, privateMetadata: true }),
    /Invalid conversation avatar upload grant/,
  );
});

test('avatar read grants expose only a short-lived signed URL for the exact attachment', () => {
  const grant = {
    attachmentId,
    signedUrl: 'https://project.supabase.co/storage/v1/object/sign/message-attachments/path?token=x',
    expiresInSeconds: 120,
  };
  assert.deepEqual(parseConversationAvatarReadGrant(grant), grant);
  assert.throws(
    () => parseConversationAvatarReadGrant({ ...grant, expiresInSeconds: 3600 }),
    /Invalid conversation avatar read grant/,
  );
  assert.throws(
    () => parseConversationAvatarReadGrant({ ...grant, storagePath: avatarPath }),
    /Invalid conversation avatar read grant/,
  );
});

test('avatar activation and removal receipts preserve compare-and-set state exactly', () => {
  const activation = {
    conversationId,
    attachmentId,
    avatarPath,
    previousAvatarPath: null,
    activated: true,
  };
  assert.deepEqual(parseConversationAvatarActivationReceipt(activation), activation);
  assert.throws(
    () => parseConversationAvatarActivationReceipt({ ...activation, activated: false }),
    /Invalid conversation avatar activation receipt/,
  );
  const removal = {
    conversationId,
    previousAvatarPath: avatarPath,
    avatarPath: null,
    removed: true,
  };
  assert.deepEqual(parseConversationAvatarRemovalReceipt(removal), removal);
  assert.throws(
    () => parseConversationAvatarRemovalReceipt({ ...removal, avatarPath }),
    /Invalid conversation avatar removal receipt/,
  );
});
