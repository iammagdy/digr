/**
 * ONE Arabic normaliser. Pure: no server imports, so the client, the chat handler and the worker can all read the same folding.
 *
 * This file is the ONLY place in the product that may contain a regular expression with Arabic characters (design guard: tests/fixtures/design-guards-allow.json,
 * D-0228/D-0232). Every function below is ORTHOGRAPHY (spelling, digits, marks, punctuation, script detection): none of them reads a WORD or decides a meaning.
 * Other files import these functions; they never write their own Arabic-character regex. A new function may be appended here by a later phase (never an existing one changed).
 *
 * Folds what customers write differently but mean the same: hamza forms (أ إ آ ٱ → ا), the alef maqsura (ى → ي), the ta marbuta (ة → ه), the
 * tatweel (ـ), the diacritics, the Arabic-Indic and Persian digits (٠-٩ ۰-۹ → 0-9) and the case of Latin letters, and collapses blanks.
 */

/** Optional marks that never change which word is meant: harakat, dagger alef, and the Quranic marks that the semantic layer strips. */
const DIACRITICS_CORE = /[ً-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭ]/g;
/** Marks only the classic fold strips (small high letters/signs, end-of-ayah signs): `stripDiacritics` = CORE + EXTRA = the set `foldArabicLetters` always stripped. */
const DIACRITICS_EXTRA = /[ؐ-ؚ۝۞ۥۦ۩]/g;
const TATWEEL = /ـ/g;
const ARABIC_INDIC = /[٠-٩]/g;
const PERSIAN_INDIC = /[۰-۹]/g;
const ALEF_FORMS = /[أإآٱ]/g;
const ALEF_MAQSURA = /ى/g;
const TA_MARBUTA = /ة/g;
const SEPARATOR_MARKS = /[٫٬]/g;
const PERSIAN_LETTERS = /[ڤپکی]/g;
const HAMZA_CARRIERS = /[ؤئ]/g;
const ARABIC_SCRIPT = /[؀-ۿ]/;
const ARABIC_LETTER = /[ء-ي]/;
const ELONGATED_ARABIC_LETTER = /([ء-ي])\1{2,}/g;
const ARABIC_THEN_LATIN_OR_DIGIT = /([ء-ي])(?=[a-z0-9])/g;
const LATIN_OR_DIGIT_THEN_ARABIC = /([a-z0-9])(?=[ء-ي])/g;

/** Latin digits for Arabic-Indic and Persian digits. */
export function foldDigits(text: string): string {
  return String(text ?? "")
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** The Arabic decimal mark (٫) becomes "." and the Arabic thousands mark (٬) becomes ",". Digits are NOT touched (use `foldDigits` for them). */
export function foldSeparatorMarks(text: string): string {
  return String(text ?? "").replace(SEPARATOR_MARKS, (c) => (c === "٫" ? "." : ","));
}

/** Zero-width, bidirectional-control, word-joiner, BOM and soft-hyphen characters removed. Written with \u escapes ON PURPOSE: these characters are invisible, they are not Arabic letters, digits or marks. */
export function stripInvisible(text: string): string {
  return String(text ?? "").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD]/g, "");
}

/** The CORE marks removed (the semantic layer's set). */
export function stripCoreDiacritics(text: string): string {
  return String(text ?? "").replace(DIACRITICS_CORE, "");
}

/** All diacritics removed (CORE + EXTRA). */
export function stripDiacritics(text: string): string {
  return stripCoreDiacritics(text).replace(DIACRITICS_EXTRA, "");
}

/** The stretching character ـ removed. */
export function stripTatweel(text: string): string {
  return String(text ?? "").replace(TATWEEL, "");
}

/** Spelling variants of three letters folded to one: أ إ آ ٱ → ا, ى → ي, ة → ه. Nothing else changes (marks, digits and case stay). */
export function foldLetterVariants(text: string): string {
  return String(text ?? "")
    .replace(ALEF_FORMS, "ا")
    .replace(ALEF_MAQSURA, "ي")
    .replace(TA_MARBUTA, "ه");
}

/** The letters of Arabic folded to one spelling (no digit or case change): diacritics and tatweel removed, then `foldLetterVariants`. */
export function foldArabicLetters(text: string): string {
  // «ؤ» and «ئ» are NOT folded here: they are letters of their own words in most dialect spellings; the callers that need that fold ask for `foldHamzaCarriers`
  return foldLetterVariants(stripTatweel(stripDiacritics(text)));
}

/** ؤ → و and ئ → ي (a COMPARISON fold, never for display). */
export function foldHamzaCarriers(text: string): string {
  return String(text ?? "").replace(HAMZA_CARRIERS, (c) => (c === "ؤ" ? "و" : "ي"));
}

/** Keyboard variants of four letters: ڤ → ف, پ → ب, ک → ك, ی → ي (a COMPARISON fold, never for display). */
export function foldPersianLetters(text: string): string {
  const MAP: Record<string, string> = { "ڤ": "ف", "پ": "ب", "ک": "ك", "ی": "ي" };
  return String(text ?? "").replace(PERSIAN_LETTERS, (c) => MAP[c] ?? c);
}

/** True when the text holds a character of the Arabic block (U+0600–U+06FF: letters, marks, Arabic-Indic digits, Arabic punctuation). */
export function hasArabicScript(text: string): boolean {
  return ARABIC_SCRIPT.test(String(text ?? ""));
}

/** True when the text holds a basic Arabic LETTER (ء to ي). Marks, digits and punctuation do not count. */
export function hasArabicLetters(text: string): boolean {
  return ARABIC_LETTER.test(String(text ?? ""));
}

/** A letter repeated three times or more is cut (Arabic to one, Latin to two): stretched typing and voice artifacts («كومنتااات»). */
export function collapseElongation(text: string): string {
  return String(text ?? "")
    .replace(ELONGATED_ARABIC_LETTER, "$1")
    .replace(/([a-z])\1{2,}/g, "$1$1");
}

/** A space is put between an Arabic letter and a Latin letter or a digit stuck to it («بtiktok» → «ب tiktok»; «٥٠شركة» only after `foldDigits`). Latin is expected in lower case. */
export function splitScriptBoundary(text: string): string {
  return String(text ?? "")
    .replace(ARABIC_THEN_LATIN_OR_DIGIT, "$1 ")
    .replace(LATIN_OR_DIGIT_THEN_ARABIC, "$1 ");
}

const ARABIC_SCRIPT_WORD = /^[؀-ۿ]+$/;
const ARABIC_LETTERS_MARKS_BLANKS = /^[ء-يً-ْ\s]+$/;
const ARABIC_NUMBER_RUN = /[٠-٩]+(?:[٬٫:/.\-][٠-٩]+)*٪?/gu;
const ARABIC_NUMERIC_LINE = /^[٠-٩٬٫٪ .:-]+$/u;

/** True for a NON-EMPTY run of characters of the Arabic block (U+0600–U+06FF) and nothing else. */
export function isArabicScriptWord(token: string): boolean {
  return ARABIC_SCRIPT_WORD.test(String(token ?? ""));
}

/** True when the whole text is Arabic letters (ء–ي), their marks (U+064B–U+0652) and blanks. */
export function isArabicLettersMarksAndBlanks(text: string): boolean {
  return ARABIC_LETTERS_MARKS_BLANKS.test(String(text ?? ""));
}

/** Every run of Arabic-Indic digits with their separators (١٬٢٠٠، ١٢٫٥، ٣:٣٠، ٥٠٪) goes through `replacement`. */
export function replaceArabicNumberRuns(text: string, replacement: (run: string) => string): string {
  return String(text ?? "").replace(ARABIC_NUMBER_RUN, replacement);
}

/** True when the whole line is Arabic-Indic digits, their separators, percent signs and blanks. */
export function isArabicNumericLine(text: string): boolean {
  return ARABIC_NUMERIC_LINE.test(String(text ?? ""));
}

/** Each of « » " ، , . : ؛ becomes ONE blank (the characters are not removed). No regular expression. */
export function blankListPunctuation(text: string): string {
  const MARKS = new Set(["\u00AB", "\u00BB", '"', "\u060C", ",", ".", ":", "\u061B"]);
  return Array.from(String(text ?? "")).map((c) => (MARKS.has(c) ? " " : c)).join("");
}

/** Zero-width and bidirectional-mark characters (U+200B–U+200F, U+202A–U+202E, U+FEFF) removed. \u escapes on purpose (invisible characters). */
export function removeZeroWidthAndBidi(text: string): string {
  return String(text ?? "").replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "");
}

/** The Arabic comma ، becomes "," (nothing else changes). No regular expression. */
export function foldArabicComma(text: string): string {
  return String(text ?? "").split("،").join(",");
}

/** True for the single character ، . */
export function isArabicComma(ch: string): boolean {
  return ch === "،";
}

/** Whitespace is removed directly before each ، (other punctuation is not touched). No regular expression with Arabic. */
export function removeSpaceBeforeArabicComma(text: string): string {
  const parts = String(text ?? "").split("،");
  return parts.map((p, i) => (i < parts.length - 1 ? p.replace(/\s+$/, "") : p)).join("،");
}

/** The characters « » " ، , . : ؛ removed wherever they are (the list-item punctuation of an item written in prose). */
export function removeListPunctuation(text: string): string {
  const DROP = new Set(["«", "»", '"', "،", ",", ".", ":", "؛"]);
  return Array.from(String(text ?? "")).filter((c) => !DROP.has(c)).join("");
}

/** Zero-width, bidirectional-control and BOM characters (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF) each turned into ONE blank. \u escapes on purpose: these characters are invisible, not Arabic letters. */
export function invisibleToSpace(text: string): string {
  return String(text ?? "").replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, " ");
}

/** A leading byte-order mark (U+FEFF) removed. */
export function stripBom(text: string): string {
  return String(text ?? "").replace(/^\uFEFF/, "");
}

/** C0 control characters (except tab, line feed and carriage return), DEL, and the zero-width / bidi / BOM characters removed. \u escapes on purpose (invisible characters). */
export function removeControlAndInvisible(text: string): string {
  return String(text ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
}

/** Arabic-Indic digits (٠-٩) → 0-9 and NOTHING else (Persian digits stay; use `foldDigits` for both). */
export function foldArabicIndicDigits(text: string): string {
  return String(text ?? "").replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Edge trimming with the caller's own predicate (so each caller keeps its exact set of characters): removes the characters at the start, the end, or both, while `isTrim(ch)` is true. */
export function trimEdges(text: string, isTrim: (ch: string) => boolean, edge: "start" | "end" | "both" = "both"): string {
  const chars = Array.from(String(text ?? ""));
  let a = 0;
  let b = chars.length;
  if (edge !== "end") while (a < b && isTrim(chars[a])) a++;
  if (edge !== "start") while (b > a && isTrim(chars[b - 1])) b--;
  return chars.slice(a, b).join("");
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]،]+/gi;
const BARE_HOST_IN_TEXT = /(?<![\w@./-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>)\]،]*)?/gi;

/** Every http(s) address in the text goes through `replacement` (an address ends at a blank, a quote, a bracket or the Arabic comma ،). */
export function replaceUrlsInText(text: string, replacement: (match: string) => string): string {
  return String(text ?? "").replace(URL_IN_TEXT, replacement);
}

/** Every bare host or host/path in the text (example.com, example.com/page) goes through `replacement` (it ends at a blank, a quote, a bracket or the Arabic comma ،). */
export function replaceBareHostsInText(text: string, replacement: (match: string) => string): string {
  return String(text ?? "").replace(BARE_HOST_IN_TEXT, replacement);
}

/** The full fold: letters, digits, Latin case, blanks. The shape every request reader should compare against. */
export function normalizeArabic(text: string): string {
  return foldDigits(foldArabicLetters(text)).toLowerCase().replace(/\s+/g, " ").trim();
}
