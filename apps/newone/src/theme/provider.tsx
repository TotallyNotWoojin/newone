import { createContext, type PropsWithChildren, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';

import { type ColorScheme, lightColors, palettes, type ThemeColors } from '@/theme/palette';
import { resolveColorScheme, type ThemePreference } from '@/theme/scheme';
import { useDevicePreferences } from '@/state/device-preferences';

/**
 * The effective theme, resolved once near the root and read at render time by
 * every screen.
 *
 * Stylesheets cannot hold colours any more: `StyleSheet.create` runs at import,
 * so a module-level sheet is frozen to whichever palette was current when the
 * bundle loaded. Instead each file keeps its sheet as a factory
 * (`buildStyles(colors)`) and each component calls `useThemedStyles(buildStyles)`,
 * which returns the sheet for the current palette. The result is cached per
 * (factory, palette), so a screen with twenty rows builds one sheet, not twenty,
 * and a theme change swaps to a sheet that was already built.
 */

export { THEME_PREFERENCES, isThemePreference, resolveColorScheme } from '@/theme/scheme';
export type { ThemePreference } from '@/theme/scheme';
export type { ColorScheme, ThemeColors } from '@/theme/palette';

export interface ThemeValue {
  /** What is actually being drawn right now. */
  scheme: ColorScheme;
  /** The palette for `scheme`. */
  colors: ThemeColors;
  /** What the person chose in Settings. */
  preference: ThemePreference;
}

const DEFAULT_THEME: ThemeValue = { scheme: 'light', colors: lightColors, preference: 'system' };

const ThemeContext = createContext<ThemeValue>(DEFAULT_THEME);

export function ThemeProvider({ children }: PropsWithChildren) {
  const systemScheme = useColorScheme();
  const { preferences } = useDevicePreferences();
  const preference = preferences.theme;
  const value = useMemo<ThemeValue>(() => {
    const scheme = resolveColorScheme(systemScheme === 'dark' ? 'dark' : 'light', preference);
    return { scheme, colors: palettes[scheme], preference };
  }, [preference, systemScheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Colours at render time. Outside a provider this is the light palette, which
 * is what the app looked like before dark mode existed.
 */
export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

export type ThemedStyleFactory<T> = (colors: ThemeColors) => T;

const sheetCache = new WeakMap<ThemedStyleFactory<never>, Partial<Record<ColorScheme, unknown>>>();

/**
 * Builds (and remembers) a stylesheet for one palette. Exported so a test can
 * assert both palettes without mounting a tree.
 */
export function buildThemedStyles<T>(factory: ThemedStyleFactory<T>, scheme: ColorScheme): T {
  const key = factory as unknown as ThemedStyleFactory<never>;
  let perScheme = sheetCache.get(key);
  if (!perScheme) {
    perScheme = {};
    sheetCache.set(key, perScheme);
  }
  if (!(scheme in perScheme)) perScheme[scheme] = factory(palettes[scheme]);
  return perScheme[scheme] as T;
}

/** The themed replacement for a module-level `StyleSheet.create`. */
export function useThemedStyles<T>(factory: ThemedStyleFactory<T>): T {
  const { scheme } = useTheme();
  return useMemo(() => buildThemedStyles(factory, scheme), [factory, scheme]);
}

/** iOS draws its keyboard to match the app, not the system, so it must be told. */
export function useKeyboardAppearance(): 'light' | 'dark' {
  return useTheme().scheme;
}
