import type { PreviewLinks } from '@/data/preview-link-store';

// One copy per browser, shared by every tab: three tabs on the same chat used
// to ask for, and download, every photo three times (office, Oct 1 2026).
const key = (userId: string) => `gist.preview-links.v1:${userId}`;

export async function loadPreviewLinks(userId: string): Promise<PreviewLinks> {
  try {
    const raw = globalThis.localStorage?.getItem(key(userId));
    return raw ? (JSON.parse(raw) as PreviewLinks) : {};
  } catch {
    return {};
  }
}

export async function savePreviewLinks(userId: string, links: PreviewLinks): Promise<void> {
  try {
    globalThis.localStorage?.setItem(key(userId), JSON.stringify(links));
  } catch {
    // Storage full or blocked: the links are only a saving, never required.
  }
}
