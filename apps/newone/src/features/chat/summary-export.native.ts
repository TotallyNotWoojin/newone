import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform, Share } from 'react-native';

import type { SummaryFileInput, SummaryShareInput, SummaryShareOutcome } from '@/features/chat/summary-export';

/**
 * Writes the summary to a text file in the cache directory and opens the
 * system share sheet: iOS shares the file itself, Android shares the text
 * (its share targets handle plain text far better than a file URL).
 */
export async function shareSummary({ fileName, title, text }: SummaryShareInput): Promise<SummaryShareOutcome> {
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  const result = Platform.OS === 'ios'
    ? await Share.share({ url: file.uri, title }, { subject: title })
    : await Share.share({ message: text, title }, { dialogTitle: title });
  return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
}

/**
 * The finished file (rendered by the service) is written to the cache and
 * handed to the share sheet, where Files, Drive, Mail and the like save it:
 * a phone has no downloads folder to drop it into unasked.
 */
export async function saveSummaryFile({ fileName, title, bytes, mimeType }: SummaryFileInput): Promise<SummaryShareOutcome> {
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  const UTI = mimeType === 'application/pdf' ? 'com.adobe.pdf' : 'org.openxmlformats.wordprocessingml.document';
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType, UTI, dialogTitle: title });
    return 'shared';
  }
  const result = await Share.share({ url: file.uri, title }, { subject: title });
  return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
}
