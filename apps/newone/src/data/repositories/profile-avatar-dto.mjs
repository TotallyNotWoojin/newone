// Profile picture grants and receipts as the API returns them. Shared
// between platforms; the `.d.mts` sibling carries the types.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PROFILE_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}.`);
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
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) throw new TypeError(`Invalid ${label}.`);
  return value;
}

/** `<organizationId>/<userId>/<uploadId>/avatar`. */
export function profileAvatarPath(value, nullable, label) {
  if (nullable && value === null) return null;
  const path = text(value, 1024, label);
  const parts = path.split('/');
  if (
    path.startsWith('/') || path.includes('..') || parts.length !== 4 || parts[3] !== 'avatar' ||
    parts.slice(0, 3).some((part) => !UUID_PATTERN.test(part))
  ) throw new TypeError(`Invalid ${label}.`);
  return path;
}

export function parseProfileAvatarUploadGrant(value) {
  const grant = object(value, 'profile avatar upload grant');
  exactKeys(grant, ['action', 'uploadId', 'bucket', 'path', 'maximumByteSize', 'signedUrl', 'token', 'expiresInSeconds'], 'profile avatar upload grant');
  if (
    grant.action !== 'upload' || grant.bucket !== 'profile-avatars' ||
    grant.maximumByteSize !== PROFILE_AVATAR_MAX_BYTES || grant.expiresInSeconds !== 7200
  ) throw new TypeError('Invalid profile avatar upload grant.');
  return {
    action: 'upload',
    uploadId: uuid(grant.uploadId, 'profile avatar upload'),
    bucket: 'profile-avatars',
    path: profileAvatarPath(grant.path, false, 'profile avatar path'),
    maximumByteSize: PROFILE_AVATAR_MAX_BYTES,
    signedUrl: text(grant.signedUrl, 4096, 'profile avatar signed upload URL'),
    token: text(grant.token, 4096, 'profile avatar upload token'),
    expiresInSeconds: 7200,
  };
}

export function parseProfileAvatarReadGrant(value) {
  const grant = object(value, 'profile avatar read grant');
  exactKeys(grant, ['userId', 'avatarPath', 'signedUrl', 'expiresInSeconds'], 'profile avatar read grant');
  if (grant.expiresInSeconds !== 300) throw new TypeError('Invalid profile avatar read grant.');
  return {
    userId: uuid(grant.userId, 'profile avatar user'),
    avatarPath: profileAvatarPath(grant.avatarPath, false, 'profile avatar path'),
    signedUrl: text(grant.signedUrl, 4096, 'profile avatar signed read URL'),
    expiresInSeconds: 300,
  };
}

export function parseProfileAvatarActivationReceipt(value) {
  const receipt = object(value, 'profile avatar activation receipt');
  exactKeys(receipt, ['userId', 'uploadId', 'avatarPath', 'previousAvatarPath', 'activated'], 'profile avatar activation receipt');
  if (receipt.activated !== true) throw new TypeError('Invalid profile avatar activation receipt.');
  return {
    userId: uuid(receipt.userId, 'profile avatar user'),
    uploadId: uuid(receipt.uploadId, 'profile avatar upload'),
    avatarPath: profileAvatarPath(receipt.avatarPath, false, 'profile avatar path'),
    previousAvatarPath: profileAvatarPath(receipt.previousAvatarPath, true, 'previous profile avatar path'),
    activated: true,
  };
}

export function parseProfileAvatarRemovalReceipt(value) {
  const receipt = object(value, 'profile avatar removal receipt');
  exactKeys(receipt, ['userId', 'previousAvatarPath', 'avatarPath', 'removed'], 'profile avatar removal receipt');
  if (receipt.removed !== true || receipt.avatarPath !== null) throw new TypeError('Invalid profile avatar removal receipt.');
  return {
    userId: uuid(receipt.userId, 'profile avatar user'),
    previousAvatarPath: profileAvatarPath(receipt.previousAvatarPath, false, 'previous profile avatar path'),
    avatarPath: null,
    removed: true,
  };
}
