import { describe, expect, it } from "vitest";
import {
  collapseElongation,
  foldArabicComma,
  foldArabicLetters,
  foldDigits,
  foldHamzaCarriers,
  foldLetterVariants,
  foldPersianLetters,
  foldSeparatorMarks,
  hasArabicLetters,
  hasArabicScript,
  isArabicComma,
  normalizeArabic,
  removeListPunctuation,
  removeSpaceBeforeArabicComma,
  splitScriptBoundary,
  stripCoreDiacritics,
  stripDiacritics,
  stripInvisible,
  stripTatweel,
  trimEdges,
} from "../src/lib/arabicNormalize";
import { normalizeDigits } from "../src/lib/arabicDigits";
import { explainNormalization, matchKey, normalizeArabic as semanticNormalize, semanticText } from "../src/lib/agentMission/semantic/normalizeArabic";

// ---- FROZEN COPIES of the code on origin/main 59dd75c8 (test oracles only; deleted together with this file when the module is retired) ----
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ARABIC_INDIC = /[٠-٩]/g;
const PERSIAN_INDIC = /[۰-۹]/g;

/** Latin digits for Arabic-Indic and Persian digits. */
function foldDigitsOld(text: string): string {
  return String(text ?? "")
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** The letters of Arabic folded to one spelling (no digit or case change). */
function foldArabicLettersOld(text: string): string {
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
function normalizeArabicOld(text: string): string {
  return foldDigitsOld(foldArabicLettersOld(text)).toLowerCase().replace(/\s+/g, " ").trim();
}

const SEMANTIC_MAX_CHARS = 2000;
const DOT = "";
const COMMA = "";

interface NormalizationStep {
  id: string;
  /** What the step does and why it is safe, in one sentence. */
  why: string;
  apply: (text: string) => string;
}

const NORMALIZATION_STEPS: readonly NormalizationStep[] = [
  { id: "limit", why: "Reads at most the first 2,000 characters (a bound, like the existing classifier).", apply: (t) => t.slice(0, SEMANTIC_MAX_CHARS) },
  // NFKC maps the Arabic presentation forms (U+FB50–FDFF, U+FE70–FEFF: what a PDF, a screenshot copy or a voice tool may paste) and full-width Latin letters and digits to the ordinary characters
  { id: "unicode_nfkc", why: "Unicode NFKC: presentation forms and full-width characters become their ordinary letters.", apply: (t) => t.normalize("NFKC") },
  { id: "invisible", why: "Removes zero-width and bidirectional control characters that a voice or paste tool leaves inside words.", apply: (t) => t.replace(/[​-‏‪-‮⁠-⁩﻿­]/g, "") },
  { id: "diacritics", why: "Removes optional Arabic diacritics (tashkeel, dagger alef, Quranic marks): they never change which word is meant in a request.", apply: (t) => t.replace(/[ً-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭ]/g, "") },
  { id: "tatweel", why: "Removes the stretching character ـ (كــومنتات → كومنتات).", apply: (t) => t.replace(/ـ/g, "") },
  {
    id: "digits",
    why: "Arabic-Indic (٠-٩) and Persian (۰-۹) digits become Western digits; the Arabic decimal and thousands separators become . and , .",
    apply: (t) => t
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/٫/g, ".")
      .replace(/٬/g, ","),
  },
  { id: "case", why: "Latin letters are compared in lower case.", apply: (t) => t.toLowerCase() },
  // a real Arabic word never repeats one letter three times; a voice transcript or a stretched typing does («كومنتااات», «تعليقاااات»). Latin runs are cut to two (a legitimate double letter stays).
  { id: "elongation", why: "A letter repeated three times or more is cut (Arabic to one, Latin to two): stretched typing and voice artifacts.", apply: (t) => t.replace(/([ء-ي])\1{2,}/g, "$1").replace(/([a-z])\1{2,}/g, "$1$1") },
  { id: "links", why: "A link is one token (its words are not read as vocabulary).", apply: (t) => t.replace(/(?:https?:\/\/|www\.)\S+/gi, " url ") },
  // «بtiktok» / «٥٠شركة» (no space between a script or a digit and the next): the two sides become separate tokens
  { id: "script_boundary", why: "A space is put between an Arabic letter and a Latin letter or a digit stuck to it.", apply: (t) => t.replace(/([ء-ي])(?=[a-z0-9])/g, "$1 ").replace(/([a-z0-9])(?=[ء-ي])/g, "$1 ") },
  { id: "separators", why: "A . or , between two digits is kept (5.5, 1,000).", apply: (t) => t.replace(/(?<=\d)\.(?=\d)/g, DOT).replace(/(?<=\d),(?=\d)/g, COMMA) },
  { id: "punctuation", why: "Every character that is not a letter, a digit or a protected separator becomes a space (punctuation, quotes, brackets, emoji, symbols).", apply: (t) => t.replace(/[^\p{L}\p{N}]/gu, " ") },
  { id: "restore_separators", why: "The protected separators come back.", apply: (t) => t.replace(new RegExp(DOT, "g"), ".").replace(new RegExp(COMMA, "g"), ",") },
  { id: "whitespace", why: "One space between tokens; none at the ends.", apply: (t) => t.replace(/\s+/g, " ").trim() },
];

/**
 * The conservative text: no meaning removed, every Arabic letter as typed. Pure and idempotent. `keepCase` skips only the lower-casing of Latin letters (every other step is case-insensitive, so the tokens of both forms line up one to one): it
 * is how a TOPIC keeps the customer's own «ChatGPT» while the vocabulary is still matched in lower case.
 */
function semanticNormalizeOld(raw: unknown, options: { keepCase?: boolean } = {}): string {
  let text = String(raw ?? "");
  for (const step of NORMALIZATION_STEPS) if (!(options.keepCase && step.id === "case")) text = step.apply(text);
  return text;
}

/** The letters folded for COMPARISON only (never for display or storage): hamza forms of alef, alef maqsura, ta marbuta, and the Persian/Arabic variants of letters Egyptians type on a phone (ڤ for V, پ for P, ک for K, ی for Y). */
function matchKeyOld(token: string): string {
  return token
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ڤ/g, "ف")
    .replace(/پ/g, "ب")
    .replace(/ک/g, "ك")
    .replace(/ی/g, "ي");
}

function normalizeDigitsOld(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}
// ---- end of frozen copies ----

/** Every code point of the blocks the folds touch, alone and between Latin letters, plus fixed realistic strings. */
function corpus(): string[] {
  const out: string[] = [];
  const blocks: Array<[number, number]> = [[0x0000, 0x007f], [0x00a0, 0x00bf], [0x0600, 0x06ff], [0x0750, 0x077f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2069], [0xfb50, 0xfdff], [0xfe70, 0xfeff]];
  for (const [a, b] of blocks) for (let c = a; c <= b; c++) {
    const ch = String.fromCodePoint(c);
    out.push(ch, `a${ch}b`, `${ch}${ch}${ch}`);
  }
  out.push(
    "", "  ", "كــومنتااات", "تعليقاااات", "بtiktok", "٥٠شركة", "ab12شركة", "١٬٢٠٠٫٥", "۱۲۳٫۴", "مُحَمَّد", "أحمد إبراهيم آمن ٱلله", "مستشفى", "المملكة", "ڤيديو پوست کتاب مصری",
    "رؤية وئام", "https://x.com/a،b", "Hello   World", "ÀB", "سعر ٣٠٠ جنيه و٤٥٫٥ دولار", "a\u200bb\u202ec\ufeffd\u00ade\u2063f", "x"
  );
  return out;
}

describe("PH0 byte-identical parity with the code of 59dd75c8 (C9)", () => {
  const inputs = corpus();
  it("foldDigits / foldArabicLetters / normalizeArabic of arabicNormalize give the same bytes", () => {
    for (const s of inputs) {
      expect(foldDigits(s), `foldDigits ${JSON.stringify(s)}`).toBe(foldDigitsOld(s));
      expect(foldArabicLetters(s), `foldArabicLetters ${JSON.stringify(s)}`).toBe(foldArabicLettersOld(s));
      expect(normalizeArabic(s), `normalizeArabic ${JSON.stringify(s)}`).toBe(normalizeArabicOld(s));
    }
  });
  it("normalizeDigits (arabicDigits.ts) gives the same bytes", () => {
    for (const s of inputs) expect(normalizeDigits(s), JSON.stringify(s)).toBe(normalizeDigitsOld(s));
  });
  it("semantic normalizeArabic, matchKey, steps and semanticText give the same bytes", () => {
    for (const s of inputs) {
      expect(semanticNormalize(s), `semantic ${JSON.stringify(s)}`).toBe(semanticNormalizeOld(s));
      expect(semanticNormalize(s, { keepCase: true }), `keepCase ${JSON.stringify(s)}`).toBe(semanticNormalizeOld(s, { keepCase: true }));
      expect(matchKey(s), `matchKey ${JSON.stringify(s)}`).toBe(matchKeyOld(s));
    }
    expect(semanticText("كــومنتااات ڤيديو").keys).toEqual(semanticText("كــومنتااات ڤيديو").tokens.map(matchKeyOld));
    expect(explainNormalization("بtiktok ٥٠شركة")).toEqual(["unicode_nfkc", "digits", "case", "script_boundary"].filter((id) => explainNormalization("بtiktok ٥٠شركة").includes(id)));
  });
});

describe("PH0 building blocks (idempotence, counter-cases)", () => {
  it("stripDiacritics = the old classic set; stripCoreDiacritics keeps the extra marks", () => {
    for (let c = 0x0000; c <= 0x06ff; c++) {
      const ch = String.fromCodePoint(c);
      expect(stripDiacritics(ch), `U+${c.toString(16)}`).toBe(ch.replace(DIACRITICS, ""));
    }
    // marks that only the classic set strips (examples): U+06DD end of ayah, U+06E9 place of sajdah, U+0610 sallallahou sign
    for (const ch of ["\u06dd", "\u06e9", "\u0610"]) {
      expect(stripCoreDiacritics("a" + ch + "b")).toBe("a" + ch + "b");
      expect(stripDiacritics("a" + ch + "b")).toBe("ab");
    }
    expect(stripCoreDiacritics("مُحَمَّد")).toBe("محمد");
  });
  it("letters of a word are never changed beyond the documented folds", () => {
    expect(foldLetterVariants("مدرسة")).toBe("مدرسه");
    expect(foldLetterVariants("رؤية وئام")).toBe("رؤيه وئام");
    expect(foldHamzaCarriers("رؤية وئام")).toBe("روية ويام");
    expect(foldLetterVariants("مُحَمَّد")).toBe("مُحَمَّد");
  });
  it("collapseElongation / splitScriptBoundary / stripInvisible / separators", () => {
    expect(collapseElongation("كومنتااات")).toBe("كومنتات");
    expect(collapseElongation("كتاب")).toBe("كتاب");
    expect(collapseElongation("goood")).toBe("good");
    expect(splitScriptBoundary("بtiktok")).toBe("ب tiktok");
    expect(splitScriptBoundary("ab12")).toBe("ab12");
    expect(stripInvisible("a\u200bb\ufeffc")).toBe("abc");
    expect(stripInvisible("شركة")).toBe("شركة");
    expect(foldSeparatorMarks("١٬٢٠٠٫٥")).toBe("١,٢٠٠.٥");
    expect(foldDigits(foldSeparatorMarks("١٬٢٠٠٫٥"))).toBe("1,200.5");
    expect(stripTatweel("اكـــس")).toBe("اكس");
    expect(foldPersianLetters("ڤيديو پوست")).toBe("فيديو بوست");
  });
  it("script detection: letters vs script block", () => {
    expect(hasArabicLetters("abc ١٢٣")).toBe(false);
    expect(hasArabicScript("abc ١٢٣")).toBe(true);
    expect(hasArabicLetters("a ب")).toBe(true);
    expect(hasArabicScript("hello")).toBe(false);
  });
  it("comma helpers and trimEdges keep every other character", () => {
    expect(foldArabicComma("أ، ب, ج")).toBe("أ, ب, ج");
    expect(isArabicComma("،")).toBe(true);
    expect(isArabicComma(",")).toBe(false);
    expect(removeSpaceBeforeArabicComma("أ  ، ب ,ج\n،")).toBe("أ، ب ,ج،");
    expect(removeListPunctuation("«أ»، \"ب\": ج. د؛ ه")).toBe("أ ب ج د ه");
    expect(trimEdges("، .  شركة .،", (c) => c === " " || c === "." || isArabicComma(c))).toBe("شركة");
    expect(trimEdges(".. x ..", (c) => c === ".", "end")).toBe(".. x ");
    expect(trimEdges(".. x ..", (c) => c === ".", "start")).toBe(" x ..");
  });
});
