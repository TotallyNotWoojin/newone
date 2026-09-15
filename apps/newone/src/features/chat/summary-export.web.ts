import * as Clipboard from 'expo-clipboard';
import * as Print from 'expo-print';

import type { SummaryDocumentInput, SummaryShareInput, SummaryShareOutcome } from '@/features/chat/summary-export';

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
 * A downloadable copy of the summary (owner's father, Sep 14 2026). Word is a
 * real download: the HTML saved as a .doc, which Word opens as a document.
 * PDF goes through the browser's print dialog, whose "Save as PDF" is the one
 * PDF path that renders Korean without shipping a font; the sheet says so.
 */
export async function exportSummaryDocument({ fileName, html, format }: SummaryDocumentInput): Promise<SummaryShareOutcome> {
  if (format === 'pdf') {
    await Print.printAsync({ html });
    return 'shared';
  }
  const blob = new Blob(['﻿', html], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'shared';
}
