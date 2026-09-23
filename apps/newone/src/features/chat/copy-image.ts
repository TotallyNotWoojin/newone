import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

export type CopyImageOutcome = 'copied' | 'failed' | 'unsupported';

const COPY_TIMEOUT_MS = 15_000;

/** Chrome's clipboard takes only PNG, so any other picture is redrawn as one. */
async function pngBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image fetch ${response.status}`);
  const blob = await response.blob();
  if (blob.type === 'image/png' || typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('image could not be redrawn'))), 'image/png');
  });
}

/**
 * Puts the picture itself on the clipboard, ready to paste into another app.
 *
 * On the web the write has to begin inside the click that asked for it:
 * Safari refuses a clipboard write that starts after a network round trip,
 * and the app used to ask the server for the picture's link first and only
 * then write, with nothing said when the browser refused (owner, Sep 23
 * 2026: "copying an image doesn't work"). So the write starts at once with a
 * ClipboardItem whose picture is still on its way; call this before any
 * `await` in the handler. `source` supplies the picture's URL.
 */
export function copyImage(source: () => Promise<string | null | undefined>): Promise<CopyImageOutcome> {
  if (Platform.OS === 'web') {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') {
      return Promise.resolve('unsupported');
    }
    const picture = (async () => {
      const url = await source();
      if (!url) throw new Error('no image to copy');
      return await pngBlob(url);
    })();
    // The write reports the failure; this only keeps the browser from also
    // logging the same rejection as unhandled.
    picture.catch(() => undefined);
    try {
      const written = clipboard
        .write([new ClipboardItem({ 'image/png': picture })])
        .then((): CopyImageOutcome => 'copied', (error: unknown): CopyImageOutcome => {
          // Named in the console so a report can say which step refused.
          console.warn('copy image failed', error instanceof Error ? `${error.name}: ${error.message}` : error);
          return 'failed';
        });
      // A browser waiting on a permission it will never ask for would leave
      // the reader with no answer at all; after a while it is a failure.
      const gaveUp = new Promise<CopyImageOutcome>((resolve) => {
        setTimeout(() => resolve('failed'), COPY_TIMEOUT_MS);
      });
      return Promise.race([written, gaveUp]);
    } catch {
      return Promise.resolve('failed');
    }
  }
  return (async (): Promise<CopyImageOutcome> => {
    let downloaded: string | null = null;
    try {
      const url = await source();
      if (!url) return 'failed';
      const target = `${FileSystem.cacheDirectory ?? ''}copy-${Date.now()}`;
      downloaded = (await FileSystem.downloadAsync(url, target)).uri;
      const base64 = await FileSystem.readAsStringAsync(downloaded, { encoding: FileSystem.EncodingType.Base64 });
      await Clipboard.setImageAsync(base64);
      return 'copied';
    } catch {
      return 'failed';
    } finally {
      if (downloaded) await FileSystem.deleteAsync(downloaded, { idempotent: true }).catch(() => undefined);
    }
  })();
}
