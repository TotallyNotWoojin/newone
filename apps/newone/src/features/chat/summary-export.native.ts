import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform, Share } from 'react-native';

import type { SummaryDocumentInput, SummaryShareInput, SummaryShareOutcome } from '@/features/chat/summary-export';

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
 * A downloadable copy of the summary (owner's father, Sep 14 2026): PDF by
 * default, Word when asked. The phone prints the HTML to a PDF file itself
 * (so Korean, Spanish and English all render with the system's fonts) and
 * hands it to the share sheet, where Files, Drive and Mail all save it. Word
 * is the same HTML saved as a .doc, which Word opens as a document.
 */
export async function exportSummaryDocument({ fileName, title, html, format }: SummaryDocumentInput): Promise<SummaryShareOutcome> {
  let uri: string;
  let mimeType: string;
  let UTI: string;
  if (format === 'pdf') {
    ({ uri } = await Print.printToFileAsync({ html }));
    mimeType = 'application/pdf';
    UTI = 'com.adobe.pdf';
  } else {
    const file = new File(Paths.cache, fileName);
    if (file.exists) file.delete();
    file.create();
    file.write(html);
    uri = file.uri;
    mimeType = 'application/msword';
    UTI = 'com.microsoft.word.doc';
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType, UTI, dialogTitle: title });
    return 'shared';
  }
  const result = await Share.share({ url: uri, title }, { subject: title });
  return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
}
