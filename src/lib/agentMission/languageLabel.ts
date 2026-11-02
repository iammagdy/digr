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

/**
 * THE LANGUAGE OF A TEXT, BY ITS SCRIPT (S4): when the source gives no language for a comment (an empty cell; a source that says it cannot tell keeps «غير محددة»), the file still says which language the text is in, by code and never by a model: «العربية» when most of its letters are Arabic-script letters, «لغة أخرى»
 * when most are not, «غير محددة» when it has no letters (an emoji, a number). A mark on the row; nothing is ever removed for it. Pure.
 */
const LETTER = /\p{L}/gu;
export function languageOfTextAr(text: unknown): "العربية" | "لغة أخرى" | "غير محددة" {
  const letters = String(text ?? "").match(LETTER) ?? [];
  if (letters.length === 0) return "غير محددة";
  const arabic = letters.filter((l) => ARABIC_LETTERS.test(l)).length;
  return arabic * 2 >= letters.length ? "العربية" : "لغة أخرى";
}
