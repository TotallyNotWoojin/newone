import { File, Paths } from 'expo-file-system';

import type { PreviewLinks } from '@/data/preview-link-store';

// Kept in the cache directory: the system may clear it, and the app then just
// asks again. A link past its time still finds its photo in the image cache.
// v2: see preview-link-store.web.ts; the first file's links were for squashed previews.
const fileFor = (userId: string) => new File(Paths.cache, `preview-links-v2-${userId}.json`);
const retiredFor = (userId: string) => new File(Paths.cache, `preview-links-${userId}.json`);

export async function loadPreviewLinks(userId: string): Promise<PreviewLinks> {
  try {
    const retired = retiredFor(userId);
    if (retired.exists) retired.delete();
    const file = fileFor(userId);
    if (!file.exists) return {};
    return JSON.parse(await file.text()) as PreviewLinks;
  } catch {
    return {};
  }
}

export async function savePreviewLinks(userId: string, links: PreviewLinks): Promise<void> {
  try {
    const file = fileFor(userId);
    if (!file.exists) file.create();
    file.write(JSON.stringify(links));
  } catch {
    // A full disk costs a few extra link requests, nothing more.
  }
}
