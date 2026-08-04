import { File, UploadType } from 'expo-file-system';

import type { AttachmentTransferOptions, AttachmentTransferSource } from '@/data/attachment-upload';

export async function transferAttachment(
  signedUrl: string,
  source: AttachmentTransferSource,
  mimeType: string,
  options: AttachmentTransferOptions = {},
) {
  const file = new File(source.uri);
  const task = file.createUploadTask(signedUrl, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    mimeType,
    sessionType: 'foreground',
    signal: options.signal,
    headers: {
      'cache-control': 'private, no-store, max-age=0',
      'content-type': mimeType,
      'x-upsert': 'false',
    },
    onProgress: ({ bytesSent, totalBytes }) => {
      if (totalBytes > 0) options.onProgress?.(Math.min(1, Math.max(0, bytesSent / totalBytes)));
    },
  });
  try {
    const result = await task.uploadAsync();
    options.onProgress?.(1);
    return result.status;
  } finally {
    task.release();
  }
}
