import * as Clipboard from 'expo-clipboard';

import type { SummaryShareInput, SummaryShareOutcome } from '@/features/chat/summary-export';

/**
 * Browsers with the Web Share API get the system share sheet; everything else
 * gets the text on the clipboard, which the sheet reports as "Copied".
 */
export async function shareSummary({ title, text }: SummaryShareInput): Promise<SummaryShareOutcome> {
  const share = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
    ? navigator.share.bind(navigator)
    : null;
  if (share) {
    try {
      await share({ title, text });
      return 'shared';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return 'dismissed';
      // Fall through to the clipboard when the browser refuses to share text.
    }
  }
  await Clipboard.setStringAsync(text);
  return 'copied';
}
