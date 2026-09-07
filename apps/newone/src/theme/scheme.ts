import { type ColorScheme } from '@/theme/palette';

/**
 * The stored appearance choice and the rule that turns it into a palette.
 *
 * Kept apart from the provider so the device-preference store can validate the
 * stored value without importing React.
 */

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/**
 * "System" follows the phone. An explicit choice wins, and keeps winning when
 * the phone flips appearance underneath it.
 */
export function resolveColorScheme(
  systemScheme: ColorScheme | null | undefined,
  preference: ThemePreference,
): ColorScheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemScheme === 'dark' ? 'dark' : 'light';
}
