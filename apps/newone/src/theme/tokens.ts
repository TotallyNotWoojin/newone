import { Platform } from 'react-native';

import { lightColors, type ThemeColors } from '@/theme/palette';

export type { ColorScheme, ThemeColors } from '@/theme/palette';

/**
 * The light palette, frozen at import.
 *
 * Anything that responds to the theme must read colours at render time through
 * `useTheme()` / `useThemedStyles()` (src/theme/provider.tsx) instead. This
 * export stays for the places that legitimately do not change: glyphs drawn on
 * a fixed-colour surface, the sign-in screen's own dark treatment, and the
 * default value of the theme context.
 */
export const colors: ThemeColors = lightColors;

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const;

export const radii = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

export const type = {
  display: Platform.select({ ios: 'Avenir Next', default: 'sans-serif' }),
  body: Platform.select({ ios: 'System', default: 'sans-serif' }),
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
} as const;

export const shadow = Platform.select({
  web: {
    boxShadow: '0 12px 36px rgba(25, 52, 43, 0.08)',
  },
  default: {
    shadowColor: lightColors.black,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 5,
  },
});
