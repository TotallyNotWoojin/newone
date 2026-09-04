import * as Crypto from 'expo-crypto';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import type { AttachmentUploadGrant } from '@/data/repositories/contracts';
import { RepositoryError } from '@/data/repositories/contracts';
// Metro selects a progress-aware native File task or the browser XHR adapter.
// eslint-disable-next-line import/no-unresolved
import { transferAttachment, type AttachmentTransferOptions } from '@/data/attachment-upload';
// Metro selects native file deletion or browser object-URL revocation.
// eslint-disable-next-line import/no-unresolved
import { removeTemporaryAttachment } from '@/data/attachment-cleanup';

export const attachmentMimeTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'video/mp4',
  'video/quicktime',
] as const;

const allowedMimeTypes = new Set<string>(attachmentMimeTypes);
export const attachmentByteLimit = 25 * 1024 * 1024;
export const videoAttachmentByteLimit = 100 * 1024 * 1024;

function attachmentByteLimitFor(mimeType: string) {
  return mimeType.startsWith('video/') ? videoAttachmentByteLimit : attachmentByteLimit;
}

export interface SelectedAttachment {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
  width?: number;
  height?: number;
  imageMode?: 'optimized' | 'original';
  temporary?: boolean;
}

export interface PreparedAttachment {
  uri: string;
  bytes: ArrayBuffer;
  byteSize: number;
  sha256Hex: string;
  name: string;
  mimeType: string;
  temporary: boolean;
}

export async function optimizeImageAttachment(selected: SelectedAttachment) {
  if (!selected.mimeType.startsWith('image/')) return selected;
  const png = selected.mimeType === 'image/png';
  const preserveDimensions = selected.imageMode === 'original';
  const maxWidth = selected.size && selected.size > 8 * 1024 * 1024 ? 1280 : 1600;
  const compression = preserveDimensions
    ? 1
    : selected.size && selected.size > 8 * 1024 * 1024
      ? 0.62
      : selected.size && selected.size > 3 * 1024 * 1024
        ? 0.72
        : 0.82;
  const actions = !preserveDimensions && selected.width && selected.width > maxWidth
    ? [{ resize: { width: maxWidth } }]
    : [];
  try {
    // Re-encode every supported image, including the full-detail option. That
    // preserves dimensions/quality while dropping EXIF/GPS/device metadata.
    // If a platform cannot decode (notably some HEIC environments), fail closed.
    const result = await manipulateAsync(selected.uri, actions, {
      compress: png ? 1 : compression,
      format: png ? SaveFormat.PNG : SaveFormat.JPEG,
    });
    const baseName = selected.name.replace(/\.[^.]+$/, '');
    return {
      ...selected,
      uri: result.uri,
      name: `${baseName}.${png ? 'png' : 'jpg'}`,
      mimeType: png ? 'image/png' : 'image/jpeg',
      size: undefined,
      width: result.width,
      height: result.height,
      temporary: true,
    };
  } catch {
    throw new RepositoryError('Newone could not prepare the optimized image.', 'image_optimization_failed', false);
  }
}

function cleanFileName(value: string) {
  const cleaned = value.replace(/[\\/]/g, '-').trim();
  return cleaned.slice(0, 255) || 'attachment';
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function prepareAttachment(selected: SelectedAttachment): Promise<PreparedAttachment> {
  if (!allowedMimeTypes.has(selected.mimeType)) {
    throw new RepositoryError('That file type is not allowed by company policy.', 'file_type_blocked', false);
  }
  const byteLimit = attachmentByteLimitFor(selected.mimeType);
  if (selected.size && selected.size > byteLimit) {
    throw new RepositoryError(
      byteLimit === videoAttachmentByteLimit
        ? 'Videos must be 100 MB or smaller.'
        : 'Attachments must be 25 MB or smaller.',
      'file_too_large',
      false,
    );
  }
  let response: Response;
  try {
    response = await fetch(selected.uri);
  } catch {
    throw new RepositoryError('Newone could not read the selected file.', 'file_read_failed', false);
  }
  if (!response.ok) {
    throw new RepositoryError('Newone could not read the selected file.', 'file_read_failed', false);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < 1 || bytes.byteLength > byteLimit) {
    throw new RepositoryError(
      byteLimit === videoAttachmentByteLimit
        ? 'Videos must be between 1 byte and 100 MB.'
        : 'Attachments must be between 1 byte and 25 MB.',
      'file_size_invalid',
      false,
    );
  }
  // Expo modules cast a typed array across the bridge, not a bare
  // ArrayBuffer; the latter answered ERR_ARGUMENT_CAST and every photo send
  // failed on device (run-2026-09-04T09-40-33, media-01).
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes));
  return {
    uri: selected.uri,
    bytes,
    byteSize: bytes.byteLength,
    sha256Hex: hex(digest),
    name: cleanFileName(selected.name),
    mimeType: selected.mimeType,
    temporary: selected.temporary === true,
  };
}

export async function cleanupPreparedAttachment(prepared: Pick<PreparedAttachment, 'uri' | 'temporary'>) {
  if (prepared.temporary) await removeTemporaryAttachment(prepared.uri);
}

export async function uploadAttachment(
  grant: AttachmentUploadGrant,
  source: { uri: string; bytes: ArrayBuffer },
  mimeType: string,
  options: AttachmentTransferOptions = {},
) {
  let status: number;
  try {
    status = await transferAttachment(grant.signedUrl, source, mimeType, options);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RepositoryError('The attachment upload was cancelled.', 'upload_cancelled', false);
    }
    throw new RepositoryError('The encrypted upload could not be reached.', 'upload_unavailable', true);
  }
  if (status < 200 || status >= 300) {
    throw new RepositoryError('The attachment upload was rejected.', `upload_http_${status}`, status >= 500);
  }
}
