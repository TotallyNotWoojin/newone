import { Platform } from 'react-native';

/**
 * Static hosts (GitHub Pages) cannot rewrite /conversation/<id> to the app
 * shell, so the site's 404.html stores the requested path under this key and
 * redirects to the app root; the app restores it once the session is ready.
 */
export const WEB_DEEP_LINK_STORAGE_KEY = 'newone.web.deeplink';

/**
 * Turns a stored absolute site path into an in-app route, or null when there
 * is nothing safe to restore. Only same-origin paths under the app's base URL
 * are accepted; the base itself and the sign-in screen carry no information.
 */
export function restoreDeepLinkPath(
  stored: string | null | undefined,
  baseUrl: string | null | undefined,
): string | null {
  if (typeof stored !== 'string' || stored.length === 0 || stored.length > 2048) return null;
  if (!stored.startsWith('/') || stored.startsWith('//') || /[\\\r\n\u0000]/.test(stored)) return null;
  const base = (baseUrl ?? '').replace(/\/+$/, '');
  let path = stored.split('#')[0] ?? '';
  if (base) {
    if (path !== base && !path.startsWith(`${base}/`)) return null;
    path = path.slice(base.length) || '/';
  }
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const pathname = path.split('?')[0] ?? '';
  if (pathname === '/' || pathname === '/sign-in') return null;
  return path;
}

/** Reads and clears the stored deep link (web only). */
export function consumeWebDeepLink(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(WEB_DEEP_LINK_STORAGE_KEY);
    if (stored !== null) window.sessionStorage.removeItem(WEB_DEEP_LINK_STORAGE_KEY);
  } catch {
    return null;
  }
  return restoreDeepLinkPath(stored, process.env.EXPO_BASE_URL);
}
