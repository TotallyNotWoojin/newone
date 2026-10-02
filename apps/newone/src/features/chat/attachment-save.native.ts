import { File, Paths } from 'expo-file-system';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import type { AttachmentSaveInput, AttachmentSaveOutcome } from '@/features/chat/attachment-save';

function safeName(fileName: string, mimeType: string): string {
  const cleaned = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned) return cleaned.slice(0, 120);
  const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  return `gist-${Date.now()}.${extension}`;
}

/**
 * A photo or video goes into the phone's own photo library, where the camera
 * roll is (owner, Oct 1 2026: "downloaded photos should go into the camera
 * roll, not files"); only adding is asked for, never reading. Any other file
 * is handed to the share sheet, where Files, Drive and Mail save it. The file
 * passes through the cache and is removed once saved.
 */
export async function saveAttachment({ url, fileName, mimeType }: AttachmentSaveInput): Promise<AttachmentSaveOutcome> {
  const media = mimeType.startsWith('image/') || mimeType.startsWith('video/');
  if (media) {
    const permission = await requestPermissionsAsync(true);
    if (!permission.granted) return 'denied';
  }
  const target = new File(Paths.cache, `${Date.now()}-${safeName(fileName, mimeType)}`);
  if (target.exists) target.delete();
  const file = await File.downloadFileAsync(url, target);
  try {
    if (media) {
      // The library's own entry point: the older saveToLibraryAsync now only
      // throws there, and on iOS it re-encoded the picture.
      await Asset.create(file.uri);
      return 'photos';
    }
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: fileName });
    return 'shared';
  } finally {
    if (media) {
      try {
        file.delete();
      } catch {
        // The cache is cleared by the system anyway.
      }
    }
  }
}
