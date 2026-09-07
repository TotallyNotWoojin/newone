import { describe, expect, test } from '@jest/globals';

import {
  AA_NORMAL,
  contrastRatio,
  findContrastFailures,
  relativeLuminance,
  TEXT_PAIRS,
} from '@/theme/contrast';
import { darkColors, lightColors, palettes, type ThemeColors } from '@/theme/palette';

const schemes = ['light', 'dark'] as const;

function describeFailures(failures: ReturnType<typeof findContrastFailures>): string {
  return failures
    .map((f) => `${f.text} on ${f.on} (${f.where}) is ${f.ratio.toFixed(2)}:1, needs ${f.minimum}:1`)
    .join('\n');
}

describe('contrast maths', () => {
  test('the reference ratios from WCAG', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.478, 2);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#FFF')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000')).toBeCloseTo(0, 5);
  });

  test('a colour that is not an opaque hex is a mistake, not a silent pass', () => {
    expect(() => contrastRatio('rgba(0,0,0,0.5)', '#FFFFFF')).toThrow();
  });
});

describe('the palettes', () => {
  test('both define exactly the same tokens', () => {
    expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
    for (const token of Object.keys(lightColors) as (keyof ThemeColors)[]) {
      expect(typeof darkColors[token]).toBe('string');
      expect(darkColors[token]).not.toBe('');
    }
  });

  test('dark is genuinely dark and light is genuinely light', () => {
    // A true dark ground, not black, and not a grey that reads as light.
    expect(relativeLuminance(darkColors.canvas)).toBeLessThan(0.02);
    expect(relativeLuminance(darkColors.canvas)).toBeGreaterThan(0);
    expect(relativeLuminance(darkColors.paper)).toBeGreaterThan(relativeLuminance(darkColors.canvas));
    expect(relativeLuminance(lightColors.paper)).toBeGreaterThan(relativeLuminance(lightColors.canvas));
  });

  test('own message bubbles keep a green tint in both palettes, never neutral grey', () => {
    for (const scheme of schemes) {
      const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(palettes[scheme].mintSoft.slice(at, at + 2), 16));
      // Green leads, and the bubble is clearly not the neutral incoming surface.
      expect(g).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(b);
      expect(palettes[scheme].mintSoft).not.toBe(palettes[scheme].paper);
      expect(contrastRatio(palettes[scheme].mintSoft, palettes[scheme].paper)).toBeGreaterThan(1.05);
    }
  });
});

describe('every text pairing the app draws', () => {
  test.each(schemes)('%s meets WCAG AA for body text', (scheme) => {
    const failures = findContrastFailures(palettes[scheme]);
    expect(describeFailures(failures)).toBe('');
    expect(failures).toEqual([]);
  });

  test('the check would catch a regression', () => {
    const broken: ThemeColors = { ...darkColors, inkSubtle: darkColors.paper };
    const failures = findContrastFailures(broken);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.text === 'inkSubtle' && f.on === 'paper')).toBe(true);
    expect(failures[0].minimum).toBe(AA_NORMAL);
  });

  test('an exemption has to say why, and there is only the one', () => {
    const exempt = TEXT_PAIRS.filter((pair) => pair.minimum === 0);
    expect(exempt.map((pair) => `${pair.text} on ${pair.on}`)).toEqual(['white on mint']);
    for (const pair of exempt) expect((pair.note ?? '').length).toBeGreaterThan(40);
    // Recorded, not forgotten: this is what it actually measures today.
    for (const scheme of schemes) {
      expect(contrastRatio(palettes[scheme].white, palettes[scheme].mint)).toBeLessThan(AA_NORMAL);
    }
  });

  test('every pair names real tokens and no pair is listed twice', () => {
    const seen = new Set<string>();
    for (const pair of TEXT_PAIRS) {
      expect(lightColors).toHaveProperty(pair.text);
      expect(lightColors).toHaveProperty(pair.on);
      expect(pair.where.trim()).not.toBe('');
      const key = `${pair.text}|${pair.on}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test('every text token in the palette is checked against at least one surface', () => {
    const checked = new Set(TEXT_PAIRS.map((pair) => pair.text));
    for (const token of ['ink', 'inkMuted', 'inkSubtle', 'amber', 'red', 'blue', 'plum', 'mintDark', 'white'] as const) {
      expect(checked.has(token)).toBe(true);
    }
  });
});
