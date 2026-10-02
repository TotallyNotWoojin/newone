import { Linking } from 'react-native';

import type { AttachmentSaveInput, AttachmentSaveOutcome } from '@/features/chat/attachment-save';

/** The browser opens the signed link and saves it the way it saves any download. */
export async function saveAttachment({ url }: AttachmentSaveInput): Promise<AttachmentSaveOutcome> {
  await Linking.openURL(url);
  return 'opened';
}
