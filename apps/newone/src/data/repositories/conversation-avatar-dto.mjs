const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`Invalid ${label}.`);
  }
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(`Invalid ${label}.`);
  return value.toLowerCase();
}

function text(value, maximum, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function avatarPath(value, nullable, label) {
  if (nullable && value === null) return null;
  const path = text(value, 1024, label);
  const parts = path.split('/');
  if (
    path.startsWith('/') || path.includes('..') || parts.length !== 5 || parts[4] !== 'upload' ||
    parts.slice(0, 4).some((part) => !UUID_PATTERN.test(part))
  ) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return path;
}

export function parseConversationAvatarUploadGrant(value) {
  const grant = object(value, 'conversation avatar upload grant');
  exactKeys(grant, [
    'action',
    'attachmentId',
    'messageId',
    'bucket',
    'path',
    'scanStatus',
    'maximumByteSize',
    'signedUrl',
    'token',
    'expiresInSeconds',
  ], 'conversation avatar upload grant');
  if (
    grant.action !== 'upload' || grant.bucket !== 'message-attachments' ||
    grant.scanStatus !== 'pending' || grant.maximumByteSize !== 5 * 1024 * 1024 ||
    grant.expiresInSeconds !== 7200 ||
    typeof grant.messageId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(grant.messageId)
  ) throw new TypeError('Invalid conversation avatar upload grant.');
  return {
    action: 'upload',
    attachmentId: uuid(grant.attachmentId, 'conversation avatar attachment'),
    messageId: grant.messageId,
    bucket: 'message-attachments',
    path: avatarPath(grant.path, false, 'conversation avatar path'),
    scanStatus: 'pending',
    maximumByteSize: 5 * 1024 * 1024,
    signedUrl: text(grant.signedUrl, 4096, 'conversation avatar signed upload URL'),
    token: text(grant.token, 4096, 'conversation avatar upload token'),
    expiresInSeconds: 7200,
  };
}

export function parseConversationAvatarReadGrant(value) {
  const grant = object(value, 'conversation avatar read grant');
  exactKeys(grant, ['attachmentId', 'signedUrl', 'expiresInSeconds'], 'conversation avatar read grant');
  if (grant.expiresInSeconds !== 120) throw new TypeError('Invalid conversation avatar read grant.');
  return {
    attachmentId: uuid(grant.attachmentId, 'conversation avatar attachment'),
    signedUrl: text(grant.signedUrl, 4096, 'conversation avatar signed read URL'),
    expiresInSeconds: 120,
  };
}

export function parseConversationAvatarActivationReceipt(value) {
  const receipt = object(value, 'conversation avatar activation receipt');
  exactKeys(receipt, [
    'conversationId',
    'attachmentId',
    'avatarPath',
    'previousAvatarPath',
    'activated',
  ], 'conversation avatar activation receipt');
  if (receipt.activated !== true) throw new TypeError('Invalid conversation avatar activation receipt.');
  return {
    conversationId: uuid(receipt.conversationId, 'avatar conversation'),
    attachmentId: uuid(receipt.attachmentId, 'conversation avatar attachment'),
    avatarPath: avatarPath(receipt.avatarPath, false, 'conversation avatar path'),
    previousAvatarPath: avatarPath(receipt.previousAvatarPath, true, 'previous conversation avatar path'),
    activated: true,
  };
}

export function parseConversationAvatarRemovalReceipt(value) {
  const receipt = object(value, 'conversation avatar removal receipt');
  exactKeys(receipt, [
    'conversationId',
    'previousAvatarPath',
    'avatarPath',
    'removed',
  ], 'conversation avatar removal receipt');
  if (receipt.avatarPath !== null || receipt.removed !== true) {
    throw new TypeError('Invalid conversation avatar removal receipt.');
  }
  return {
    conversationId: uuid(receipt.conversationId, 'avatar conversation'),
    previousAvatarPath: avatarPath(receipt.previousAvatarPath, false, 'previous conversation avatar path'),
    avatarPath: null,
    removed: true,
  };
}
