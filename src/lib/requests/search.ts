import { normalizeDigits } from "../arabicDigits";
import { foldAlefForms, foldAlefMaqsura, foldHamzaCarriers, foldTaMarbuta, stripArabicMarkBlock } from "../arabicNormalize";

/**
 * The search over the words of a request: both sides are written the same way before they are compared, so «احمد» finds «أحمد», «٥» finds «5», «مدرسة» finds «مدرسه», and a diacritic or a stretched letter never hides a match.
 * Every word the customer typed must be found (in any order).
 */
export function normalizeSearchText(raw: unknown): string {
  return foldHamzaCarriers(foldTaMarbuta(foldAlefMaqsura(foldAlefForms(stripArabicMarkBlock(normalizeDigits(String(raw ?? "")).toLowerCase())))))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const MAX_SEARCH_CHARS = 80;

/** The words to look for (empty when there is nothing to search). */
export function searchTerms(raw: unknown): string[] {
  const text = normalizeSearchText(String(raw ?? "").slice(0, MAX_SEARCH_CHARS));
  return text ? text.split(" ").filter(Boolean) : [];
}

export function matchesSearch(haystack: unknown, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const text = normalizeSearchText(haystack);
  return terms.every((t) => text.includes(t));
}
