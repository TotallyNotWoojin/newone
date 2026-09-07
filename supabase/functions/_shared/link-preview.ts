/**
 * Fetching what a shared link says about itself, once, on our side.
 *
 * A phone that fetched the page itself would hand its address and its browser
 * to whoever the link points at, for every person in the chat, every time the
 * message scrolled past. So the gateway fetches it — once per address, kept for
 * a fortnight — and the phones only ever talk to us.
 *
 * The address arrives from a member, so everything here is written against the
 * assumption that it is hostile: only https, only public hosts, one redirect
 * hop at most, a few seconds, and a bounded read.
 */
import { ApiError } from './errors.ts';

export const MAX_PREVIEW_URL_LENGTH = 2048;
/** Enough for any sane <head>; the rest of the page is never read. */
export const MAX_PREVIEW_BYTES = 256 * 1024;
export const PREVIEW_TIMEOUT_MS = 6000;
export const MAX_PREVIEW_REDIRECTS = 2;
export const MAX_PREVIEW_TITLE_LENGTH = 200;
export const MAX_PREVIEW_SITE_LENGTH = 80;

export interface LinkPreview {
  url: string;
  title: string | null;
  siteName: string | null;
  imageUrl: string | null;
  status: 'ready' | 'unavailable';
}

/**
 * Hosts that must never be reachable through us: the loopback, the private
 * ranges, the link-local range every cloud hangs its credentials off, and the
 * names that resolve inside a network rather than on the internet.
 */
export function privatePreviewHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (!name) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name.endsWith('.local') || name.endsWith('.internal') || name.endsWith('.home.arpa')) return true;
  if (name.endsWith('.localdomain')) return true;
  if (name === 'metadata.google.internal') return true;
  // Any literal address, v4 or v6. A site worth previewing has a name.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)) return true;
  if (name.startsWith('[') || name.includes(':')) return true;
  // A name with no dot cannot be a public domain, so it is something local.
  if (!name.includes('.')) return true;
  return false;
}

/** The address as we will fetch and cache it. Throws when we will not. */
export function normalizePreviewUrl(candidate: unknown): string {
  if (typeof candidate !== 'string') throw new ApiError(400, 'bad_request');
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > MAX_PREVIEW_URL_LENGTH) throw new ApiError(400, 'bad_request');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiError(400, 'bad_request');
  }
  if (url.protocol !== 'https:') throw new ApiError(400, 'bad_request');
  if (url.username || url.password) throw new ApiError(400, 'bad_request');
  if (privatePreviewHost(url.hostname)) throw new ApiError(400, 'bad_request');
  url.hash = '';
  const normalized = url.toString();
  if (normalized.length > MAX_PREVIEW_URL_LENGTH) throw new ApiError(400, 'bad_request');
  return normalized;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&(?:#x([0-9a-f]+)|#(\d+));/gi, (_match, hex, decimal) => {
      const code = hex ? Number.parseInt(hex, 16) : Number.parseInt(decimal, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function tidy(value: string | null, limit: number): string | null {
  if (!value) return null;
  const cleaned = decodeEntities(value).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

function metaContent(html: string, property: string): string | null {
  // Both spellings, either attribute order, single or double quotes.
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${escaped}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Title, site name and thumbnail address, read out of a page's own head. */
export function parseLinkPreview(html: string, url: string): LinkPreview {
  const head = html.slice(0, MAX_PREVIEW_BYTES);
  const title = tidy(
    metaContent(head, 'og:title')
      ?? metaContent(head, 'twitter:title')
      ?? (/<title[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(head)?.[1] ?? null),
    MAX_PREVIEW_TITLE_LENGTH,
  );
  const siteName = tidy(
    metaContent(head, 'og:site_name') ?? metaContent(head, 'application-name'),
    MAX_PREVIEW_SITE_LENGTH,
  );
  const rawImage = tidy(
    metaContent(head, 'og:image') ?? metaContent(head, 'twitter:image'),
    MAX_PREVIEW_URL_LENGTH,
  );
  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      const resolved = new URL(rawImage, url);
      imageUrl = resolved.protocol === 'https:' && !privatePreviewHost(resolved.hostname)
        ? resolved.toString()
        : null;
    } catch {
      imageUrl = null;
    }
  }
  return {
    url,
    title,
    siteName,
    imageUrl,
    status: title ? 'ready' : 'unavailable',
  };
}

export interface PreviewFetcher {
  (url: string, init: RequestInit): Promise<Response>;
}

/**
 * Fetch a page and read its head. Never throws for a page's own sake — a site
 * that is slow, gone, enormous or hostile simply has no preview — so one bad
 * link in a chat can never turn into a failing request for the reader.
 */
export async function fetchLinkPreview(
  url: string,
  fetcher: PreviewFetcher = fetch,
): Promise<LinkPreview> {
  const unavailable: LinkPreview = { url, title: null, siteName: null, imageUrl: null, status: 'unavailable' };
  let current = url;
  for (let hop = 0; hop <= MAX_PREVIEW_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
    try {
      const response = await fetcher(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // Named plainly: a site that would rather not be unfurled can say so.
          'User-Agent': 'NewoneLinkPreview/1.0',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en',
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return unavailable;
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return unavailable;
        }
        // Every hop is checked again: a redirect into the private ranges is the
        // oldest trick there is.
        try {
          current = normalizePreviewUrl(next);
        } catch {
          return unavailable;
        }
        continue;
      }
      if (!response.ok) return unavailable;
      const type = response.headers.get('content-type') ?? '';
      if (!/^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(type)) return unavailable;
      const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES * 4) return unavailable;
      const html = await readBounded(response);
      if (html === null) return unavailable;
      return parseLinkPreview(html, current);
    } catch {
      return unavailable;
    } finally {
      clearTimeout(timeout);
    }
  }
  return unavailable;
}

/** Read at most MAX_PREVIEW_BYTES, then stop, whatever the page claims. */
async function readBounded(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_PREVIEW_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(Math.min(total, MAX_PREVIEW_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= joined.length) break;
    joined.set(chunk.subarray(0, joined.length - offset), offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(joined);
}
