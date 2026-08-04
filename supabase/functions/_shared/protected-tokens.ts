const PLACEHOLDER_PREFIX = '__NEWONE_PROTECTED_';
const PLACEHOLDER_PATTERN = /__NEWONE_PROTECTED_[0-9]{4}__/g;

interface Candidate {
  start: number;
  end: number;
  value: string;
  priority: number;
}

export interface ProtectedToken {
  placeholder: string;
  value: string;
}

export interface ProtectedText {
  text: string;
  tokens: ProtectedToken[];
}

export class ProtectedTokenError extends Error {
  constructor() {
    super('Protected token invariants failed');
    this.name = 'ProtectedTokenError';
  }
}

const PATTERNS: Array<{ pattern: RegExp; priority: number }> = [
  {
    // 24-hour and AM/PM times, including explicit time ranges.
    pattern:
      /\b(?:(?:[01]?[0-9]|2[0-3]):[0-5][0-9](?:\s?(?:a\.?m\.?|p\.?m\.?))?)(?:\s*[-–—]\s*(?:(?:[01]?[0-9]|2[0-3]):[0-5][0-9](?:\s?(?:a\.?m\.?|p\.?m\.?))?))?\b/gi,
    priority: 1,
  },
  {
    // Measurements, percentages, temperatures, voltage/current, pressure,
    // speed, mass, volume, and common production tolerances. Hangul case
    // particles are commonly attached directly to Latin unit symbols, so a
    // Hangul suffix is a valid boundary while a Latin-letter continuation is
    // not (for example, `2.5 bar로` is a measurement but `barometer` is not).
    pattern:
      /(?:(?:±|\+|-)\s?)?(?:[0-9]{1,12}(?:[.,][0-9]{1,8})?|[.,][0-9]{1,8})\s?(?:°\s?[CF]|℃|℉|%|mm|cm|km|µm|μm|in|ft|mg|kg|g|ml|mL|L|lb|oz|psi|kPa|MPa|bar|rpm|Hz|kHz|MHz|V|mV|A|mA|W|kW|MW|N|Nm|N·m|m\/s|km\/h)(?:(?![\p{L}\p{N}_])|(?=\p{Script=Hangul}))/giu,
    priority: 2,
  },
  {
    // Signed/tolerance decimals even when no unit follows.
    pattern: /(?:±|\+|-)\s?(?:[0-9]{1,12}(?:[.,][0-9]{1,8})?|[.,][0-9]{1,8})(?![\p{L}\p{N}_])/gu,
    priority: 3,
  },
  {
    // Equipment, ticket, lot, work-order, and other mixed alphanumeric IDs.
    // Dates are excluded because at least one ASCII letter is required.
    pattern:
      /\b(?=[A-Z0-9._/-]{3,48}\b)(?=[A-Z0-9._/-]*[A-Z])(?=[A-Z0-9._/-]*[0-9])[A-Z0-9]+(?:[-_/.][A-Z0-9]+)+\b/gi,
    priority: 4,
  },
];

function candidates(source: string): Candidate[] {
  const values: Candidate[] = [];
  for (const { pattern, priority } of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (match.index === undefined || !match[0]) continue;
      values.push({
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        priority,
      });
    }
  }
  values.sort((left, right) =>
    left.start - right.start || right.end - right.start - (left.end - left.start) ||
    left.priority - right.priority
  );
  return values;
}

export function protectTokens(source: string): ProtectedText {
  if (source.includes(PLACEHOLDER_PREFIX)) throw new ProtectedTokenError();
  const selected: Candidate[] = [];
  for (const candidate of candidates(source)) {
    if (
      selected.some((existing) => candidate.start < existing.end && candidate.end > existing.start)
    ) continue;
    selected.push(candidate);
  }
  selected.sort((left, right) => left.start - right.start);

  const tokens = selected.map((candidate, index) => ({
    placeholder: `${PLACEHOLDER_PREFIX}${String(index + 1).padStart(4, '0')}__`,
    value: candidate.value,
  }));
  let text = source;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const candidate = selected[index] as Candidate;
    const token = tokens[index] as ProtectedToken;
    text = `${text.slice(0, candidate.start)}${token.placeholder}${text.slice(candidate.end)}`;
  }
  return { text, tokens };
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

export function restoreTokens(translated: string, tokens: ProtectedToken[]): string {
  const allowed = new Set(tokens.map((token) => token.placeholder));
  for (const match of translated.matchAll(PLACEHOLDER_PATTERN)) {
    if (!allowed.has(match[0])) throw new ProtectedTokenError();
  }
  for (const token of tokens) {
    if (occurrences(translated, token.placeholder) !== 1) throw new ProtectedTokenError();
  }

  let restored = translated;
  for (const token of tokens) restored = restored.replace(token.placeholder, token.value);
  PLACEHOLDER_PATTERN.lastIndex = 0;
  if (PLACEHOLDER_PATTERN.test(restored)) throw new ProtectedTokenError();
  return restored;
}
