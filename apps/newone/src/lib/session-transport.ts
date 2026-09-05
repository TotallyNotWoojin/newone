import { Platform } from 'react-native';

import { edgeSessionTransport } from '@/config/runtime';

/**
 * Browser builds keep the same-origin HttpOnly cookie gateway unless the
 * build opted into direct bearer-token auth (EXPO_PUBLIC_WEB_AUTH_MODE=direct).
 * Native never uses cookies. Evaluated per call so the platform can be
 * switched in tests.
 */
export function usesCookieSession(): boolean {
  return Platform.OS === 'web' && edgeSessionTransport !== 'bearer';
}
