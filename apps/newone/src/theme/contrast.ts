import { type ThemeColors } from '@/theme/palette';

/**
 * Contrast maths for the palettes, plus the list of text/background pairings
 * the app actually draws. The unit test walks `TEXT_PAIRS` across both palettes
 * and fails if any drops below `AA_NORMAL`, so a palette edit cannot quietly
 * make a label unreadable.
 */

/** WCAG 2.1 AA for body text. Everything in the app is body-sized or smaller. */
export const AA_NORMAL = 4.5;
/** WCAG 2.1 AA for large (>=18.66px bold / 24px) text. */
export const AA_LARGE = 3;

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

export function parseHex(hex: string): [number, number, number] {
  const raw = hex.trim().replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Not an opaque hex colour: ${hex}`);
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

export interface TextPair {
  /** Token drawn as text or as an icon glyph. */
  text: keyof ThemeColors;
  /** Token filling the surface behind it. */
  on: keyof ThemeColors;
  /** Where this pairing appears, so a failure names a screen. */
  where: string;
  /** Only for text the app draws large; defaults to AA_NORMAL. */
  minimum?: number;
}

/**
 * Every opaque text-on-surface pairing the app draws. Translucent tokens
 * (`overlay`, `tint*`) are excluded: they sit over an already-checked surface.
 */
export const TEXT_PAIRS: TextPair[] = [
  { text: 'ink', on: 'canvas', where: 'screen body copy' },
  { text: 'ink', on: 'paper', where: 'card and incoming bubble text' },
  { text: 'ink', on: 'paperMuted', where: 'input text' },
  { text: 'ink', on: 'mintSoft', where: 'own bubble text' },
  { text: 'inkMuted', on: 'canvas', where: 'screen secondary copy' },
  { text: 'inkMuted', on: 'paper', where: 'card secondary copy' },
  { text: 'inkMuted', on: 'paperMuted', where: 'chip secondary copy' },
  { text: 'inkMuted', on: 'mintSoft', where: 'own bubble translation' },
  { text: 'inkMuted', on: 'amberSoft', where: 'warning panel body' },
  { text: 'inkMuted', on: 'redSoft', where: 'error panel body' },
  { text: 'inkMuted', on: 'blueSoft', where: 'info panel body' },
  { text: 'inkMuted', on: 'plumSoft', where: 'handoff panel body' },
  { text: 'inkSubtle', on: 'canvas', where: 'timestamps and section eyebrows' },
  { text: 'inkSubtle', on: 'paper', where: 'row hints and bubble timestamps' },
  { text: 'inkSubtle', on: 'paperMuted', where: 'placeholder text' },
  { text: 'inkSubtle', on: 'mintSoft', where: 'own bubble timestamp' },
  { text: 'mintDark', on: 'canvas', where: 'accent actions on a page' },
  { text: 'mintDark', on: 'paper', where: 'accent actions in a card' },
  { text: 'mintDark', on: 'paperMuted', where: 'accent actions on a chip' },
  { text: 'mintDark', on: 'mintSoft', where: 'accent metric on a soft panel' },
  { text: 'accentInk', on: 'mintSoft', where: 'soft accent panel heading' },
  { text: 'onAccent', on: 'mint', where: 'selected tab, checkmarks, accent button' },
  { text: 'amber', on: 'canvas', where: 'warning text on a page' },
  { text: 'amber', on: 'paper', where: 'warning text in a card' },
  { text: 'amber', on: 'amberSoft', where: 'warning panel heading' },
  { text: 'red', on: 'canvas', where: 'danger text on a page' },
  { text: 'red', on: 'paper', where: 'danger text in a card' },
  { text: 'red', on: 'paperMuted', where: 'danger text on a chip' },
  { text: 'red', on: 'redSoft', where: 'error panel heading' },
  { text: 'blue', on: 'canvas', where: 'informational text on a page' },
  { text: 'blue', on: 'paper', where: 'informational text in a card' },
  { text: 'blue', on: 'blueSoft', where: 'info panel heading' },
  { text: 'plum', on: 'canvas', where: 'handoff text on a page' },
  { text: 'plum', on: 'paper', where: 'handoff text in a card' },
  { text: 'plumStrong', on: 'plumSoft', where: 'handoff panel heading' },
  { text: 'plumMuted', on: 'plumSoft', where: 'handoff panel meta' },
  { text: 'white', on: 'forest', where: 'brand surface text (rail, splash, help)' },
  { text: 'white', on: 'forestRaised', where: 'raised brand surface text' },
  { text: 'white', on: 'redStrong', where: 'unread badge and acknowledge button' },
  { text: 'white', on: 'inkStrong', where: 'discovery pill' },
];

export interface ContrastFailure {
  text: string;
  on: string;
  where: string;
  ratio: number;
  minimum: number;
}

export function findContrastFailures(colors: ThemeColors, pairs: TextPair[] = TEXT_PAIRS): ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  for (const pair of pairs) {
    const minimum = pair.minimum ?? AA_NORMAL;
    if (minimum <= 0) continue;
    const ratio = contrastRatio(colors[pair.text], colors[pair.on]);
    if (ratio + 1e-9 < minimum) {
      failures.push({ text: pair.text, on: pair.on, where: pair.where, ratio, minimum });
    }
  }
  return failures;
}
