/**
 * The two palettes.
 *
 * Every token exists in both, with the same meaning, so a stylesheet written
 * against `ThemeColors` renders in either. Read them through
 * `useTheme()` / `useThemedStyles()` (src/theme/provider.tsx), never by
 * importing one palette directly into a screen — the module-level `colors`
 * export in tokens.ts is the light palette and is frozen at import time.
 *
 * Naming rules, so the dark values stay derivable:
 * - `canvas` / `paper` / `paperMuted` are the three surface steps. Light goes
 *   down (white card on a grey page); dark goes up (a lighter card on a near
 *   black page), which is how phones show depth without shadows.
 * - `ink` / `inkMuted` / `inkSubtle` are text on those surfaces, strongest first.
 * - `<hue>` is a readable foreground on the current surface; `<hue>Soft` is the
 *   quiet tinted panel behind it; `<hue>Border` is the hairline around that
 *   panel. So `amber` flips from a dark ochre to a light one between palettes,
 *   while `amberSoft` flips the other way.
 * - `mint` stays a bright accent in both, so anything drawn on it (`onAccent`)
 *   stays dark in both. `accentInk` is the heading colour on `mintSoft`, which
 *   does flip.
 * - `redStrong` / `inkStrong` / `accentStrong` are solid fills that always
 *   carry `white` text (unread badges, the destructive button, the
 *   jump-to-latest pill). They stay dark in both palettes; `red`, `ink` and
 *   `mintDark` are foregrounds and flip.
 * - `tint*` are the translucent washes drawn *inside* a bubble, so they darken
 *   on light and lighten on dark.
 */

export type ColorScheme = 'light' | 'dark';

export const lightColors = {
  ink: '#13211D',
  inkMuted: '#53635D',
  inkSubtle: '#5F6F69',
  /** Solid dark fill that carries `white` text (the discovery pill). */
  inkStrong: '#13211D',
  canvas: '#F3F5F1',
  paper: '#FFFFFF',
  paperMuted: '#F7F8F5',
  line: '#E2E7E2',
  lineStrong: '#D4DCD5',
  forest: '#102E27',
  forestRaised: '#173D34',
  mint: '#35C48D',
  mintDark: '#167854',
  /** Solid accent fill that carries `white` text (the jump-to-latest pill). */
  accentStrong: '#167854',
  mintSoft: '#DDF7EC',
  mintBorder: '#BCE8D7',
  /** Text and icons drawn on `mint`; dark in both palettes. */
  onAccent: '#102E27',
  /** Headings on `mintSoft`; flips with the palette. */
  accentInk: '#102E27',
  /** Off-state switch track: visible against the card, still clearly "off". */
  switchOff: '#A7B4AE',
  blue: '#2A61C9',
  blueSoft: '#EAF1FF',
  amber: '#874A08',
  amberSoft: '#FFF0D8',
  amberBorder: '#E7C690',
  red: '#A6382F',
  redSoft: '#FDEAE7',
  redBorder: '#F4C5BC',
  /** Solid red fill that carries `white` text (badges, acknowledge). */
  redStrong: '#A6382F',
  plum: '#68439A',
  plumSoft: '#F0E9FA',
  plumBorder: '#DED0F0',
  plumStrong: '#493168',
  plumMuted: '#67527E',
  white: '#FFFFFF',
  black: '#08110E',
  /** Behind a modal card. */
  overlay: 'rgba(5, 22, 18, 0.62)',
  /** Washes drawn inside a bubble, over `paper` or `mintSoft`. */
  tintFaint: 'rgba(16,46,39,0.05)',
  tintSoft: 'rgba(16,46,39,0.07)',
  tintMedium: 'rgba(16,46,39,0.12)',
  tintLine: 'rgba(16,46,39,0.2)',
} as const;

export type ThemeColors = { [K in keyof typeof lightColors]: string };

export const darkColors: ThemeColors = {
  ink: '#EDF3EF',
  inkMuted: '#AFBDB6',
  inkSubtle: '#9CABA4',
  inkStrong: '#2C3733',
  canvas: '#0E1412',
  paper: '#171E1B',
  paperMuted: '#202825',
  line: '#28312E',
  lineStrong: '#3A4540',
  forest: '#12332C',
  forestRaised: '#1A4038',
  mint: '#3ED79B',
  mintDark: '#6FE0B4',
  accentStrong: '#1E7458',
  mintSoft: '#12362B',
  mintBorder: '#1F5C48',
  onAccent: '#062018',
  accentInk: '#8FE6C2',
  switchOff: '#4C5854',
  blue: '#9CBEFA',
  blueSoft: '#151F33',
  amber: '#EEBE7A',
  amberSoft: '#2E240F',
  amberBorder: '#57431B',
  red: '#F5A399',
  redSoft: '#33201D',
  redBorder: '#65332C',
  redStrong: '#A6382F',
  plum: '#CBB0F0',
  plumSoft: '#241B35',
  plumBorder: '#42305C',
  plumStrong: '#DCC7F6',
  plumMuted: '#B0A0C6',
  white: '#FFFFFF',
  black: '#08110E',
  overlay: 'rgba(0, 0, 0, 0.72)',
  tintFaint: 'rgba(255,255,255,0.06)',
  tintSoft: 'rgba(255,255,255,0.09)',
  tintMedium: 'rgba(255,255,255,0.14)',
  tintLine: 'rgba(255,255,255,0.22)',
};

export const palettes: Record<ColorScheme, ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};
