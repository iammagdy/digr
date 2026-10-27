/**
 * ONE Arabic normaliser. Pure: no server imports, so the client, the chat handler and the worker can all read the same folding.
 *
 * Folds what customers write differently but mean the same: hamza forms (أ إ آ ٱ → ا), the alef maqsura (ى → ي), the ta marbuta (ة → ه), the
 * tatweel (ـ), the diacritics, the Arabic-Indic and Persian digits (٠-٩ ۰-۹ → 0-9) and the case of Latin letters, and collapses blanks.
 *
 * Other private copies of this folding still exist (topicMatch.ts, researchRelevanceGate.ts, rowDedupe.ts, socialAdapter.ts, requestCoverage.ts,
 * timeWindow.ts, planParameters.ts foldArabicSpelling, negativeListEngine.ts, commentQuality.ts, relevanceEvidence.ts, servicesCatalogText.ts,
 * facebookReport/registry.ts, fileSpec.ts, methodologyOffer.ts, retryMessage.ts, arabicNumbers.ts normalizeNumberWord, understandingRequests.ts).
 * They keep working as they are; they move here one by one, each with its own proof.
 */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ARABIC_INDIC = /[٠-٩]/g;
const PERSIAN_INDIC = /[۰-۹]/g;

/** Latin digits for Arabic-Indic and Persian digits. */
export function foldDigits(text: string): string {
  return String(text ?? "")
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** The letters of Arabic folded to one spelling (no digit or case change). */
export function foldArabicLetters(text: string): string {
  return String(text ?? "")
    .replace(DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    // «ؤ» and «ئ» are NOT folded: they are letters of their own words in most dialect spellings; the callers that need that fold ask for it
    ;
}

/** The full fold: letters, digits, Latin case, blanks. The shape every request reader should compare against. */
export function normalizeArabic(text: string): string {
  return foldDigits(foldArabicLetters(text)).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Source text of an alternation of Arabic words, each written the way `normalizeArabic` writes it (so a pattern is matched against normalised text). */
export function foldedAlternation(words: readonly string[]): string {
  return words.map((w) => normalizeArabic(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}
