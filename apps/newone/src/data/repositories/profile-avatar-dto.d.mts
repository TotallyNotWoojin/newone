export const PROFILE_AVATAR_MAX_BYTES: 5242880;

export interface ProfileAvatarUploadGrant {
  action: 'upload';
  uploadId: string;
  bucket: 'profile-avatars';
  path: string;
  maximumByteSize: 5242880;
  signedUrl: string;
  token: string;
  expiresInSeconds: 7200;
}

export interface ProfileAvatarReadGrant {
  userId: string;
  avatarPath: string;
  signedUrl: string;
  expiresInSeconds: 300;
}

export interface ProfileAvatarActivationReceipt {
  userId: string;
  uploadId: string;
  avatarPath: string;
  previousAvatarPath: string | null;
  activated: true;
}

export interface ProfileAvatarRemovalReceipt {
  userId: string;
  previousAvatarPath: string;
  avatarPath: null;
  removed: true;
}

export function profileAvatarPath(value: unknown, nullable: boolean, label: string): string | null;
export function parseProfileAvatarUploadGrant(value: unknown): ProfileAvatarUploadGrant;
export function parseProfileAvatarReadGrant(value: unknown): ProfileAvatarReadGrant;
export function parseProfileAvatarActivationReceipt(value: unknown): ProfileAvatarActivationReceipt;
export function parseProfileAvatarRemovalReceipt(value: unknown): ProfileAvatarRemovalReceipt;
