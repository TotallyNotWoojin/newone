import type { Language, SupportedLanguage } from "./types";

const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g;
const LATIN = /[a-záéíóúüñ¿¡]/gi;

export function detectLanguage(text: string): Language {
  const hangulCount = text.match(HANGUL)?.length ?? 0;
  const latinCount = text.match(LATIN)?.length ?? 0;

  if (hangulCount > 0 && latinCount > 0) return "mixed";
  if (hangulCount > 0) return "ko";
  return "es";
}

export function targetLanguage(source: Language): SupportedLanguage {
  return source === "ko" ? "es" : "ko";
}

export function languageLabel(language: Language): string {
  if (language === "ko") return "한국어";
  if (language === "es") return "Español";
  return "혼합 · Mixto";
}

export function needsLanguageReview(text: string): boolean {
  const letters = text.match(/[\p{L}]/gu)?.length ?? 0;
  return letters < 4 || detectLanguage(text) === "mixed";
}
