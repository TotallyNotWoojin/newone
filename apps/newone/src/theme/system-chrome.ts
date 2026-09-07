import { useEffect } from 'react';
import { Platform } from 'react-native';
// Expo's system-ui module is native-only in practice; the web branch below
// never calls it.
import * as SystemUI from 'expo-system-ui';

import { useTheme } from '@/theme/provider';

/**
 * The parts of the window the React tree does not paint: the root view behind
 * the navigator (which shows through during a screen transition and behind the
 * Android navigation bar), and on the web the document itself plus the
 * `theme-color` the browser uses for its own chrome.
 *
 * `+html.tsx` paints the document before any JavaScript runs, from
 * `prefers-color-scheme`; this hook takes over once the stored override is
 * known, so choosing Light on a dark phone does not leave a dark gutter.
 */
export function useSystemChrome(): void {
  const { colors, scheme } = useTheme();
  const background = colors.canvas;

  useEffect(() => {
    if (Platform.OS === 'web') {
      const document = globalThis.document;
      if (!document) return;
      document.documentElement.style.backgroundColor = background;
      document.documentElement.style.colorScheme = scheme;
      if (document.body) document.body.style.backgroundColor = background;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', background);
      return;
    }
    void SystemUI.setBackgroundColorAsync(background).catch(() => {
      // A platform without a settable root background is not a failure.
    });
  }, [background, scheme]);
}
