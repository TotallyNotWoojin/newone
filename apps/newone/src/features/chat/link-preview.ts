/**
 * Finding the link in a message, and deciding which links are worth a card.
 *
 * The phone never fetches the page: it hands the address to our own gateway,
 * which fetches it once, keeps what it found, and hands back a title and a site
 * name. So this file only has to agree with the server about which addresses
 * are ones we are willing to look at at all — the same list lives in
 * supabase/functions/_shared/link-preview.ts.
 */

/** Longest address we will carry around. */
export const maxPreviewUrlLength = 2048;

const bareDomain = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Hosts nobody outside the machine should be able to make us fetch. The server
 * refuses these too — this copy only keeps the app from asking.
 */
function privateHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name.endsWith('.local') || name.endsWith('.internal') || name.endsWith('.home.arpa')) return true;
  if (name === 'metadata.google.internal') return true;
  // A bare IP address is never a site anyone shares on purpose.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)) return true;
  if (name.startsWith('[') || name.includes(':')) return true;
  return false;
}

/** The address as we will store and ask about it, or null if we will not. */
export function normalizePreviewUrl(candidate: string): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > maxPreviewUrlLength) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  // Only the web, only without credentials, and never a page fragment: the
  // fragment is the reader's business and never changes what the page says.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname || privateHost(url.hostname)) return null;
  if (!url.hostname.includes('.')) return null;
  url.hash = '';
  // http is upgraded rather than refused: most of these redirect anyway, and we
  // are the one making the request.
  if (url.protocol === 'http:') url.protocol = 'https:';
  const normalized = url.toString();
  return normalized.length > maxPreviewUrlLength ? null : normalized;
}

/** Everything that looks like the sentence around the address, not the address. */
function trimPunctuation(token: string): string {
  let start = 0;
  while (start < token.length && '("\'[{<¡¿«'.includes(token[start])) start += 1;
  token = token.slice(start);
  let end = token.length;
  const closers: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  while (end > 0) {
    const character = token[end - 1];
    if ('.,;:!?"\'…'.includes(character)) {
      end -= 1;
      continue;
    }
    const opener = closers[character];
    if (opener && !token.slice(0, end - 1).includes(opener)) {
      end -= 1;
      continue;
    }
    break;
  }
  return token.slice(0, end);
}

/**
 * The first address in a message, or null when there is none worth a card.
 * One card per message: a wall of them is worse than none.
 */
export function firstPreviewUrl(text: string): string | null {
  if (typeof text !== 'string' || !text) return null;
  for (const rawToken of text.split(/\s+/)) {
    const token = trimPunctuation(rawToken);
    if (!token) continue;
    const looksLikeLink = /^https?:\/\//i.test(token)
      || (token.startsWith('www.') && token.length > 4)
      || bareDomain.test(token.split('/')[0] ?? '');
    if (!looksLikeLink) continue;
    const normalized = normalizePreviewUrl(token);
    if (normalized) return normalized;
  }
  return null;
}

/** What the card puts under the title: the site's own name, or its host. */
export function previewSiteLabel(url: string, siteName?: string | null): string {
  const named = siteName?.trim();
  if (named) return named;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
