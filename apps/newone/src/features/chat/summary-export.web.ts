import * as Clipboard from 'expo-clipboard';

import type { SummaryFileInput, SummaryShareInput, SummaryShareOutcome } from '@/features/chat/summary-export';

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

/**
 * The finished file (rendered by the service) goes straight to the browser's
 * downloads: no print window, no "Save as PDF" (owner's father, Sep 14 2026:
 * "there's no place to download it").
 */
export async function saveSummaryFile({ fileName, bytes, mimeType }: SummaryFileInput): Promise<SummaryShareOutcome> {
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'saved';
}
