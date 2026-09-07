/**
 * "Is this one emoji?" for message reactions.
 *
 * The app offers six in a row and a "+" that hands the phone's own emoji
 * keyboard to the person, so the server has to accept anything Unicode calls an
 * emoji while refusing text. The client runs the same check before it sends
 * (apps/newone/src/features/chat/message-reactions.ts); keep the two in step.
 */

/** Longest sequence accepted, in code points: a subdivision flag is seven. */
export const MAX_REACTION_CODE_POINTS = 16;

const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_15 = 0xfe0e;
const VARIATION_SELECTOR_16 = 0xfe0f;
const COMBINING_KEYCAP = 0x20e3;
const TAG_START = 0xe0020;
const TAG_END = 0xe007e;
const TAG_TERMINATOR = 0xe007f;
const BLACK_FLAG = 0x1f3f4;

const regionalIndicator = (code: number) => code >= 0x1f1e6 && code <= 0x1f1ff;
const skinTone = (code: number) => code >= 0x1f3fb && code <= 0x1f3ff;
const tagLetter = (code: number) => code >= TAG_START && code <= TAG_END;

/**
 * The emoji code point blocks, spelled out rather than taken from
 * \p{Extended_Pictographic}: the same list ships in the app, where the property
 * escape is not dependable on every engine, and one shared list is one thing to
 * reason about.
 */
const PICTOGRAPHIC_RANGES: readonly (readonly [number, number])[] = [
  [0x00a9, 0x00a9],
  [0x00ae, 0x00ae],
  [0x203c, 0x203c],
  [0x2049, 0x2049],
  [0x2122, 0x2122],
  [0x2139, 0x2139],
  [0x2194, 0x21aa],
  [0x231a, 0x231b],
  [0x2328, 0x2328],
  [0x23cf, 0x23cf],
  [0x23e9, 0x23f3],
  [0x23f8, 0x23fa],
  [0x24c2, 0x24c2],
  [0x25aa, 0x25ab],
  [0x25b6, 0x25b6],
  [0x25c0, 0x25c0],
  [0x25fb, 0x25fe],
  [0x2600, 0x27bf],
  [0x2934, 0x2935],
  [0x2b05, 0x2b07],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x3030, 0x3030],
  [0x303d, 0x303d],
  [0x3297, 0x3297],
  [0x3299, 0x3299],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f170, 0x1f251],
  [0x1f300, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
];

const pictographic = (code: number) =>
  PICTOGRAPHIC_RANGES.some(([low, high]) => code >= low && code <= high);

/** `#`, `*` and the digits: only ever an emoji as part of a keycap. */
const keycapBase = (code: number) =>
  code === 0x23 || code === 0x2a || (code >= 0x30 && code <= 0x39);

const modifier = (code: number) =>
  code === VARIATION_SELECTOR_15 || code === VARIATION_SELECTOR_16 || skinTone(code);

/**
 * True when the string is exactly one emoji — one picture, however many code
 * points spell it. Words, punctuation, two emoji in a row and an emoji with
 * text stuck to it are all false.
 */
export function isSingleEmoji(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const codes = Array.from(value.normalize('NFC')).map((character) => character.codePointAt(0) ?? 0);
  if (codes.length === 0 || codes.length > MAX_REACTION_CODE_POINTS) return false;

  // A country flag: exactly two regional indicators, nothing else.
  if (codes.some(regionalIndicator)) {
    return codes.length === 2 && codes.every(regionalIndicator);
  }

  // A subdivision flag: the black flag, its tag letters, then the terminator.
  if (codes[0] === BLACK_FLAG && codes.length > 1) {
    return codes.length >= 3 &&
      codes.slice(1, -1).every(tagLetter) &&
      codes[codes.length - 1] === TAG_TERMINATOR;
  }

  let index = 0;
  let pictures = 0;
  while (index < codes.length) {
    const base = codes[index] ?? 0;
    if (keycapBase(base)) {
      // #️⃣ is the character, the variation selector, and the keycap mark.
      if (codes[index + 1] !== VARIATION_SELECTOR_16 || codes[index + 2] !== COMBINING_KEYCAP) {
        return false;
      }
      index += 3;
    } else if (pictographic(base)) {
      index += 1;
      while (index < codes.length && modifier(codes[index] ?? 0)) index += 1;
    } else {
      return false;
    }
    pictures += 1;
    if (index >= codes.length) break;
    // Anything more is only allowed through a joiner, and a joiner must join.
    if (codes[index] !== ZERO_WIDTH_JOINER) return false;
    index += 1;
    if (index >= codes.length) return false;
  }
  return pictures >= 1;
}
