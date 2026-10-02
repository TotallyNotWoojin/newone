import type { PreviewLinks } from '@/data/preview-link-store';

// One copy per browser, shared by every tab: three tabs on the same chat used
// to ask for, and download, every photo three times (office, Oct 1 2026).
// v2: links handed out before Oct 2 2026 05:36Z were for a preview squashed to
// 720 px wide at the photo's full height; they are left behind, not reused.
const key = (userId: string) => `gist.preview-links.v2:${userId}`;
const retired = (userId: string) => `gist.preview-links.v1:${userId}`;

export async function loadPreviewLinks(userId: string): Promise<PreviewLinks> {
  try {
    globalThis.localStorage?.removeItem(retired(userId));
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
