/**
 * THE LANGUAGE OF A CELL IN A CUSTOMER FILE (S1 live findings fix 4, docs/S1-LIVE-FINDINGS.md section 6 item 7). A source gives the language of a comment as a code (`un`, `ar`, `fa`, `en-US`); a customer file holds Arabic words only. Three labels:
 *   «العربية»  : an Arabic code or name (ar, ara, arb, ar-EG, Arabic, عربي);
 *   «غير محددة» : the source could not tell (un, und, unknown, xx, zxx, mul, mis);
 *   «لغة أخرى»  : any other language, by code or by Latin name.
 * An empty value stays empty (a missing value is an empty cell, never a word) and an Arabic word already there is kept. Pure.
 */
const ARABIC_LETTERS = /[؀-ۿ]/;
const ARABIC = /^(?:ar|ara|arb)(?:[-_][a-z0-9]{2,8})?$|^arabic$/i;
const UNDETERMINED = /^(?:un|und|unk|unknown|xx|zxx|mul|mis|n\/a|na|none|null|-+)$/i;
const ARABIC_WORD_ARABIC = /^(?:عربي|عربية|العربية|عربى)$/;
const ARABIC_WORD_UNKNOWN = /^(?:غير\s+(?:معروف|محدد)[ةه]?|مجهول)$/;

export function languageLabelAr<T>(value: T): T | string {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (t === "") return value;
  if (ARABIC_WORD_ARABIC.test(t)) return "العربية";
  if (ARABIC_WORD_UNKNOWN.test(t)) return "غير محددة";
  if (ARABIC_LETTERS.test(t)) return value;
  if (UNDETERMINED.test(t)) return "غير محددة";
  if (ARABIC.test(t)) return "العربية";
  return "لغة أخرى";
}

const TITLE = /^(?:لغة|اللغة)(?:\s|$)/;
const KEY = /^(?:lang|language|comment_language|text_language|post_language|lang_code|language_code)$/i;
/** A column that holds a language: by its Arabic title («لغة التعليق», «اللغة») or by the key of its source field. The mark column «لغة النص» is already Arabic and is not touched. */
export const isLanguageColumn = (title: string, key: string | undefined): boolean => !(key ?? "").startsWith("__mark_") && (TITLE.test(title.trim()) || KEY.test(key ?? ""));
