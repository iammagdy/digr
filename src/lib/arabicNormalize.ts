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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// UB1 (DT-20261126-wordlist-wave4, D-0238): EXACT-RANGE helpers. Each one is the SAME character set a caller used before it moved here, so no caller changes behaviour; tests/wl4-ub1-orthography.test.ts
// compares every code unit of the Basic Multilingual Plane against the frozen old expression. The sets differ from each other on purpose (the callers differ), so they keep their own names.
// They are written with code-unit comparisons, not with Arabic regular expressions (nothing here reads a word; the only regexes left are the two number-grouping ones below).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type CodeRange = readonly [from: number, to: number];
const inRanges = (code: number, ranges: readonly CodeRange[]): boolean => ranges.some(([from, to]) => code >= from && code <= to);
/** The text without the code units inside the ranges (a unit is one UTF-16 code unit, as a regular expression without the `u` flag reads it). */
function removeCodeUnits(text: string, ranges: readonly CodeRange[]): string {
  const s = String(text ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) if (!inRanges(s.charCodeAt(i), ranges)) out += s[i];
  return out;
}
/** Each code unit that has an entry in `to` is replaced by that code unit; every other one stays. */
function mapCodeUnits(text: string, to: ReadonlyMap<number, string>): string {
  const s = String(text ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) out += to.get(s.charCodeAt(i)) ?? s[i];
  return out;
}
/** U+064B–U+0670 (harakat, dagger alef, Arabic-Indic digits and the Arabic decimal and thousands marks) and the tatweel U+0640. Callers fold digits BEFORE this. */
const MARK_BLOCK: readonly CodeRange[] = [[0x064b, 0x0670], [0x0640, 0x0640]];
/** Harakat U+064B–U+0652, the dagger alef U+0670 and the tatweel U+0640. */
const HARAKAT_DAGGER_TATWEEL: readonly CodeRange[] = [[0x064b, 0x0652], [0x0670, 0x0670], [0x0640, 0x0640]];
/** Harakat U+064B–U+0652 and the tatweel U+0640. */
const HARAKAT_TATWEEL: readonly CodeRange[] = [[0x064b, 0x0652], [0x0640, 0x0640]];
/** Zero-width marks U+200B–U+200F, bidirectional marks U+202A–U+202E and the BOM U+FEFF. */
const BIDI_AND_BOM: readonly CodeRange[] = [[0x200b, 0x200f], [0x202a, 0x202e], [0xfeff, 0xfeff]];
const code = (...units: number[]): string => String.fromCharCode(...units);
const ALEF = code(0x0627);
const ALEF_WITH_HAMZA_FORMS = new Map<number, string>([[0x0623, ALEF], [0x0625, ALEF], [0x0622, ALEF]]);
const ALEF_FORMS_WITH_WASLA = new Map<number, string>([[0x0623, ALEF], [0x0625, ALEF], [0x0622, ALEF], [0x0671, ALEF]]);
const MAQSURA_TO_YEH = new Map<number, string>([[0x0649, code(0x064a)]]);
const TA_MARBUTA_TO_HEH = new Map<number, string>([[0x0629, code(0x0647)]]);
const COMMA_AND_SEMICOLON_TO_SPACE = new Map<number, string>([[0x060c, " "], [0x061b, " "]]);

/** The block U+064B–U+0670 and the tatweel removed. */
export function stripArabicMarkBlock(text: string): string { return removeCodeUnits(text, MARK_BLOCK); }
/** Harakat U+064B–U+0652, the dagger alef and the tatweel removed. */
export function stripHarakatDaggerTatweel(text: string): string { return removeCodeUnits(text, HARAKAT_DAGGER_TATWEEL); }
/** Harakat U+064B–U+0652 and the tatweel removed. */
export function stripHarakatTatweel(text: string): string { return removeCodeUnits(text, HARAKAT_TATWEEL); }
/** Zero-width marks, bidirectional marks and the BOM (11 code units) removed. */
export function stripBidiAndBom(text: string): string { return removeCodeUnits(text, BIDI_AND_BOM); }
/** The four alef forms with a hamza, a madda or a wasla become the plain alef (nothing else changes). */
export function foldAlefForms(text: string): string { return mapCodeUnits(text, ALEF_FORMS_WITH_WASLA); }
/** The three alef forms with a hamza or a madda become the plain alef (the alef wasla is left alone). */
export function foldAlefHamzaForms(text: string): string { return mapCodeUnits(text, ALEF_WITH_HAMZA_FORMS); }
/** The alef maqsura becomes the yeh (nothing else changes). */
export function foldAlefMaqsura(text: string): string { return mapCodeUnits(text, MAQSURA_TO_YEH); }
/** The ta marbuta becomes the heh wherever it is. */
export function foldTaMarbuta(text: string): string { return mapCodeUnits(text, TA_MARBUTA_TO_HEH); }
/** The ta marbuta becomes the heh only at the very end of the text. */
export function foldFinalTaMarbuta(text: string): string {
  const s = String(text ?? "");
  return s.length > 0 && s.charCodeAt(s.length - 1) === 0x0629 ? `${s.slice(0, -1)}${code(0x0647)}` : s;
}
/** The Arabic comma and the Arabic semicolon each become one blank. */
export function arabicCommaSemicolonToSpace(text: string): string { return mapCodeUnits(text, COMMA_AND_SEMICOLON_TO_SPACE); }
/** The Arabic thousands mark and the comma removed (a number written with grouping). */
export function removeGroupingMarks(text: string): string { return removeCodeUnits(text, [[0x066c, 0x066c], [0x002c, 0x002c]]); }
/** «1,500» and «1٬500» become «1500» (only a comma or the Arabic thousands mark before exactly three digits), then «2٫5» becomes «2.5». Digits must already be Latin. */
export function foldGroupedNumberMarks(text: string): string {
  const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
  const isWord = (c: number): boolean => isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
  const s = String(text ?? "");
  // pass 1: a digit, then a comma or the Arabic thousands mark, then exactly three digits and no further word character: the mark goes (the digit before it is consumed, as a regular expression would)
  let grouped = "";
  for (let i = 0; i < s.length; i++) {
    const mark = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
    if (isDigit(s.charCodeAt(i)) && (mark === 0x2c || mark === 0x066c) && i + 4 < s.length && isDigit(s.charCodeAt(i + 2)) && isDigit(s.charCodeAt(i + 3)) && isDigit(s.charCodeAt(i + 4)) && (i + 5 >= s.length || !isWord(s.charCodeAt(i + 5)))) {
      grouped += s[i];
      i += 1;
    } else grouped += s[i];
  }
  // pass 2: a digit, the Arabic decimal mark, a digit: the mark becomes a point (both digits are consumed)
  let out = "";
  for (let i = 0; i < grouped.length; i++) {
    if (isDigit(grouped.charCodeAt(i)) && i + 2 < grouped.length && grouped.charCodeAt(i + 1) === 0x066b && isDigit(grouped.charCodeAt(i + 2))) {
      out += `${grouped[i]}.${grouped[i + 2]}`;
      i += 2;
    } else out += grouped[i];
  }
  return out;
}
/** A word as a regular-expression SOURCE that matches its common spellings: alef → [alef, hamza forms], heh and ta marbuta → [either], yeh → [yeh, maqsura]. For raw (not yet folded) customer text. */
export function looseSpellingPattern(word: string): string {
  const s = String(word ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c === 0x0627 ? `[${code(0x0627, 0x0623, 0x0625)}]` : c === 0x0647 || c === 0x0629 ? `[${code(0x0647, 0x0629)}]` : c === 0x064a ? `[${code(0x064a, 0x0649)}]` : s[i];
  }
  return out;
}
