import { File, Paths } from 'expo-file-system';
import { Platform, Share } from 'react-native';

import type { SummaryShareInput, SummaryShareOutcome } from '@/features/chat/summary-export';

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
