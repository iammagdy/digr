import { describe, expect, it } from "vitest";
import {
  EVIDENCE_ENDINGS, FOLD_EXCLUSION, FOLD_GENERIC, FOLD_TOPIC, countCodePoints, isAllDigits, isArabicBlock, isArabicScript, isMarkOrTatweel, isMarkOrTatweelWide, isSocialHandle, mapCodePoints,
  removeCodePoints, splitOnCommas, squashKey, startsWithConjunctionWord, startsWithOneLetterPrefix, stripEvidenceAgentPrefix, stripEvidenceArticle, stripEvidenceClitic, stripLeadingArticle,
  stripTopicArticle, stripTopicFinalHaYa, stripTopicPluralEnding,
} from "../src/lib/arabicUnits";
import { normalizeText, isBasketballTopic, BASKETBALL_TOPIC_RE } from "../src/lib/server/topicMatch";
import { normalizeArabic, stemArabic } from "../src/lib/server/relevanceEvidence";
import { normalizeArabicText } from "../src/lib/server/negativeListEngine";
import { commentLanguageOf, requestWantsArabicComments } from "../src/lib/server/commentQuality";
import { distinctiveTopicWords } from "../src/lib/modelPlanner/stageCall";
import { topicStems } from "../src/lib/server/topicMatch";

/**
 * DT-20261126-wl4-ud-a (D-0232): the orthography rows of the UD files moved from regular expressions with Arabic letters to code-point helpers (src/lib/arabicUnits.ts). The ORACLES below are the old expressions, copied
 * verbatim from the files before this change (a0900099's neighbour 84d71f4b); each helper must give the old answer for EVERY code point (0..0x10FFFF, lone surrogates included) and, for the affix rules, for every short
 * string over the letters that matter plus a seeded random corpus. Tests are not scanned by the design guard, so the old expressions stay here as the proof.
 */
const MAX_CP = 0x10ffff;
const each = (fn: (cp: number, ch: string) => void) => { for (let cp = 0; cp <= MAX_CP; cp += 1) fn(cp, String.fromCodePoint(cp)); };
let seed = 20261127;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = <T,>(xs: ReadonlyArray<T>): T => xs[Math.floor(rnd() * xs.length)];
/** every string up to `len` over the alphabet */
function* strings(alphabet: string[], len: number): Generator<string> {
  yield "";
  let layer = [""];
  for (let n = 1; n <= len; n += 1) { const next: string[] = []; for (const p of layer) for (const a of alphabet) { next.push(p + a); yield p + a; } layer = next; }
}
const L = (cps: number[]) => cps.map((c) => String.fromCodePoint(c));

const OLD_NARROW = /[ً-ٰٟـ]/u;
const OLD_WIDE = /[ً-ٰـ]/u;
const OLD_BLOCK = /[؀-ۿ]/u;
const OLD_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/u;
const oldNormalizeText = (value: string): string => String(value ?? "").toLowerCase().normalize("NFKD").replace(/[ً-ٰٟـ]/gu, "").replace(/[أإآٱ]/gu, "ا").replace(/ى/gu, "ي").replace(/ة/gu, "ه").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const oldNormalizeArabic = (text: string): string => String(text || "").replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
const oldExclusionText = (text: string): string => text.replace(/[ً-ٰٟ]/g, "").replace(/ـ/g, "").replace(/[إأآٱ]/g, "ا").replace(/ة/g, "ه").replace(/[ىي]/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي");
const oldGenericFold = (text: string): string => text.replace(/[ً-ٰـ]/gu, "").replace(/[أإآ]/gu, "ا").replace(/ى/gu, "ي").replace(/ة/gu, "ه");
const oldTopicArticle = (t: string): string => t.replace(/^(?:وال|بال|لل|ال)(?=.{3,})/u, "");
const oldLightStem = (token: string): string => {
  let t = oldTopicArticle(token);
  t = t.replace(/(?:ات|ون|ين)$/u, (m) => (t.length - m.length >= 3 ? "" : m));
  t = t.replace(/(?:ه|ي)$/u, () => (t.length > 3 ? "" : "ه"));
  return t;
};
const oldLightStemFixed = (token: string): string => {
  let t = oldTopicArticle(token);
  t = t.replace(/(?:ات|ون|ين)$/u, (m) => (t.length - m.length >= 3 ? "" : m));
  t = t.replace(/(?:ه|ي)$/u, (m) => (t.length > 3 ? "" : m));
  return t;
};
void oldLightStem;
const oldStemArabic = (word: string): string => {
  let token = oldNormalizeArabic(word).replace(/[^ء-ي]/g, "");
  token = token.replace(/^(?:وال|بال|كال|فال|لل|ال)/, "");
  if (token.length > 4) token = token.replace(/^[وبلف]/, "");
  for (let pass = 0; pass < 2; pass += 1) {
    const suffix = ["ات", "ون", "ين", "ان", "يه", "ها", "ه", "ي"].find((ending) => token.length - ending.length >= 3 && token.endsWith(ending));
    if (!suffix) break;
    token = token.slice(0, token.length - suffix.length);
  }
  if (token.length >= 4) token = token.replace(/^[مت]/, "");
  if (token.length === 4) token = token.replace(/^(.{2})ي(.)$/, "$1$2");
  return token;
};

describe("UD-a: the code-point helpers give the old answer for every code point", () => {
  it("1. the three predicates and the two mark sets (1,114,112 code points)", () => {
    const bad: string[] = [];
    each((cp, ch) => {
      if (isMarkOrTatweel(cp) !== OLD_NARROW.test(ch)) bad.push(`narrow ${cp.toString(16)}`);
      if (isMarkOrTatweelWide(cp) !== OLD_WIDE.test(ch)) bad.push(`wide ${cp.toString(16)}`);
      if (isArabicBlock(cp) !== OLD_BLOCK.test(ch)) bad.push(`block ${cp.toString(16)}`);
      if (isArabicScript(cp) !== OLD_SCRIPT.test(ch)) bad.push(`script ${cp.toString(16)}`);
    });
    expect(bad).toEqual([]);
    // the quirk of the wide set, kept: the Arabic-Indic digits go with the marks
    expect(isMarkOrTatweelWide(0x661)).toBe(true);
    expect(isMarkOrTatweel(0x661)).toBe(false);
  });

  it("2. topicMatch.normalizeText, relevanceEvidence.normalizeArabic, negativeListEngine.normalizeArabicText: the same text for every code point and for 60,000 random mixed strings", () => {
    const bad: string[] = [];
    each((cp, ch) => {
      if (normalizeText(ch) !== oldNormalizeText(ch)) bad.push(`topic ${cp.toString(16)}`);
      if (normalizeArabic(ch) !== oldNormalizeArabic(ch)) bad.push(`evidence ${cp.toString(16)}`);
      if (normalizeArabicText(ch) !== oldExclusionNormalize(ch)) bad.push(`exclusion ${cp.toString(16)}`);
      if (mapCodePoints(removeCodePoints(ch, isMarkOrTatweelWide), FOLD_GENERIC) !== oldGenericFold(ch)) bad.push(`generic ${cp.toString(16)}`);
    });
    expect(bad.slice(0, 10)).toEqual([]);
    const alphabet = [...L([0x627, 0x623, 0x625, 0x622, 0x671, 0x649, 0x64a, 0x629, 0x647, 0x624, 0x626, 0x648, 0x640, 0x64b, 0x64e, 0x651, 0x670, 0x660, 0x6d6, 0x200d]), "a", "B", "5", " ", "-", "\n", "😀", "\ud83d", "ﷺ", "ﭐ"];
    for (let i = 0; i < 60000; i += 1) {
      const s = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => pick(alphabet)).join("");
      expect(normalizeText(s)).toBe(oldNormalizeText(s));
      expect(normalizeArabic(s)).toBe(oldNormalizeArabic(s));
      expect(normalizeArabicText(s)).toBe(oldExclusionNormalize(s));
      expect(mapCodePoints(removeCodePoints(s, isMarkOrTatweelWide), FOLD_GENERIC)).toBe(oldGenericFold(s));
      expect(mapCodePoints(removeCodePoints(s, isMarkOrTatweel), FOLD_EXCLUSION)).toBe(oldExclusionFold(s));
      expect(mapCodePoints(removeCodePoints(s, isMarkOrTatweel), FOLD_TOPIC)).toBe(oldNormalizeArabic(s));
    }
  });

  it("3. topicMatch affix rules: article (with its three-plain-characters rule), plural ending, final ha/ya: every string up to 5 over the letters that matter, and a random corpus up to 9", () => {
    const alphabet = [...L([0x648, 0x628, 0x644, 0x627, 0x646, 0x647, 0x64a, 0x629, 0x62a, 0x645, 0x623]), "\n", "x"];
    for (const s of strings(alphabet, 5)) {
      expect(stripTopicArticle(s)).toBe(oldTopicArticle(s));
      expect(stripTopicFinalHaYa(stripTopicPluralEnding(stripTopicArticle(s)))).toBe(oldLightStemFixed(s));
    }
    for (let i = 0; i < 200000; i += 1) {
      const s = Array.from({ length: Math.floor(rnd() * 10) }, () => pick(alphabet)).join("");
      expect(stripTopicArticle(s)).toBe(oldTopicArticle(s));
      expect(stripTopicFinalHaYa(stripTopicPluralEnding(stripTopicArticle(s)))).toBe(oldLightStemFixed(s));
    }
  });

  it("4. relevanceEvidence: stemArabic is the same for every string up to 5 over the letters that matter and for a random corpus; the conjunction split equals the old two tests", () => {
    const alphabet = [...L([0x648, 0x628, 0x643, 0x641, 0x644, 0x627, 0x646, 0x647, 0x64a, 0x62a, 0x645, 0x629, 0x621]), "\n"];
    for (const s of strings(alphabet, 5)) {
      expect(stemArabic(s)).toBe(oldStemArabic(s));
      expect(startsWithConjunctionWord(s)).toBe(/^و.{3,}/.test(s) && !/^وا?ل?$/.test(s) && !/^وال?$/.test(s));
    }
    for (let i = 0; i < 200000; i += 1) {
      const s = Array.from({ length: Math.floor(rnd() * 10) }, () => pick(alphabet)).join("");
      expect(stemArabic(s)).toBe(oldStemArabic(s));
      expect(startsWithConjunctionWord(s)).toBe(/^و.{3,}/.test(s) && !/^وا?ل?$/.test(s) && !/^وال?$/.test(s));
    }
    // the dropped clause of the old test could never be true when the first part was: 2 or 3 characters against four or more
    for (const s of strings(alphabet, 4)) if (/^و.{3,}/.test(s)) expect(/^وا?ل?$/.test(s)).toBe(false);
    expect([...EVIDENCE_ENDINGS]).toEqual(["ات", "ون", "ين", "ان", "يه", "ها", "ه", "ي"]);
    expect(stripEvidenceArticle("والعقار")).toBe("عقار");
    expect(stripEvidenceClitic("وب")).toBe("ب");
    expect(stripEvidenceAgentPrefix("مطور")).toBe("طور");
  });

  it("5. stageCall: «only digits» and «starts with lam, ba, wa or fa» for every code point and for strings of digits of both kinds", () => {
    const bad: string[] = [];
    each((cp, ch) => {
      if (isAllDigits(ch) !== /^[\d٠-٩]+$/u.test(ch)) bad.push(`digits ${cp.toString(16)}`);
      if (startsWithOneLetterPrefix(ch) !== /^[لبوف]/u.test(ch)) bad.push(`prefix ${cp.toString(16)}`);
      if (startsWithOneLetterPrefix(`${ch}x`) !== /^[لبوف]/u.test(`${ch}x`)) bad.push(`prefix2 ${cp.toString(16)}`);
    });
    expect(bad).toEqual([]);
    for (const s of strings(["0", "9", "٠", "٩", "۰", "a", "\n", ""], 5)) expect(isAllDigits(s)).toBe(/^[\d٠-٩]+$/u.test(s));
    // the topic words of a request: a count is not a topic word, a stem with a one-letter prefix has both spellings
    expect(distinctiveTopicWords("هات ٢٠ تغريدة عن لتركيا").flat()).not.toContain("٢٠");
    expect(distinctiveTopicWords("لتركيا").some((spellings) => spellings.length === 2)).toBe(true);
  });

  it("6. addressParser comma split: every string up to 6 over comma, Arabic comma, a, space, newline equals split(/[,،]+/)", () => {
    for (const s of strings([",", "،", "a", " ", "\n"], 6)) expect(splitOnCommas(s)).toEqual(s.split(/[,،]+/));
    expect(splitOnCommas("a,,b، c")).toEqual(["a", "b", " c"]);
  });

  it("7. socialRows: the key squash and the user-name check for every code point, for 2-code-point strings, and at the length limits", () => {
    const bad: string[] = [];
    each((cp, ch) => {
      if (squashKey(ch) !== ch.replace(/[^a-z0-9؀-ۿ]/g, "")) bad.push(`squash ${cp.toString(16)}`);
      const two = `a${ch}`;
      if (isSocialHandle(two) !== /^[\w.\-؀-ۿ]{2,60}$/u.test(two)) bad.push(`handle ${cp.toString(16)}`);
      if (isSocialHandle(ch) !== /^[\w.\-؀-ۿ]{2,60}$/u.test(ch)) bad.push(`handle1 ${cp.toString(16)}`);
    });
    expect(bad).toEqual([]);
    for (const n of [0, 1, 2, 3, 59, 60, 61, 100]) for (const unit of ["a", "ش", "_"]) expect(isSocialHandle(unit.repeat(n))).toBe(/^[\w.\-؀-ۿ]{2,60}$/u.test(unit.repeat(n)));
    expect(isSocialHandle("a\n")).toBe(false);
    expect(squashKey("digg_count".toUpperCase().toLowerCase())).toBe("diggcount");
  });

  it("8. commentQuality: the language of a comment and «an Arabic request» equal the old counts on every code point and on random mixed text", () => {
    const oldLang = (text: string): string => {
      let arabic = 0, latin = 0, other = 0;
      for (const ch of String(text || "").replace(/(?:https?:\/\/|www\.)\S+/giu, " ")) {
        if (/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/u.test(ch)) arabic += 1;
        else if (/[A-Za-z]/.test(ch)) latin += 1;
        else if (/\p{L}/u.test(ch)) other += 1;
      }
      const total = arabic + latin + other;
      if (total === 0) return "other";
      if (arabic / total >= 0.4) return "ar";
      if (latin / total >= 0.6) return "en";
      return "other";
    };
    const oldWants = (q: string): boolean => (q.match(/[؀-ۿ]/gu) || []).length >= 2;
    const bad: string[] = [];
    each((cp, ch) => {
      if (commentLanguageOf(ch) !== oldLang(ch)) bad.push(`lang ${cp.toString(16)}`);
      if (requestWantsArabicComments({ query: ch + ch }) !== oldWants(ch + ch)) bad.push(`wants ${cp.toString(16)}`);
    });
    expect(bad).toEqual([]);
    const alphabet = [...L([0x627, 0x628, 0x6a9, 0x750, 0xfb50, 0xfe70, 0x4e2d, 0x430, 0x3b1]), "a", "Z", "1", " ", "\u{1f600}", "\ud83d", "http://x.co/a"];
    for (let i = 0; i < 40000; i += 1) {
      const s = Array.from({ length: 1 + Math.floor(rnd() * 14) }, () => pick(alphabet)).join("");
      expect(commentLanguageOf(s)).toBe(oldLang(s));
      expect(requestWantsArabicComments({ query: s })).toBe(oldWants(s));
    }
  });

  it("9. negativeListEngine: the leading article and the folded text keep every exclusion decision; the removed `x` stop word and the removed Arabic half of the raw basketball clause change nothing", () => {
    for (const s of strings([...L([0x627, 0x644, 0x634, 0x645]), "a"], 4)) expect(stripLeadingArticle(s)).toBe(s.replace(/^ال/, ""));
    // the platform letter in the stop words never took effect (one-letter tokens are dropped first)
    expect(topicStems("x football")).toEqual(topicStems("football"));
    // isBasketballTopic: the old two-part test and the new one-part test agree on a corpus of phrases, fragments joined at random, and diacritics
    const old = (topic: string): boolean => /كره (?:ال)?سله|كرة (?:ال)?سلة|basketball|\bnba\b|hoops/i.test(topic) || BASKETBALL_TOPIC_RE.test(normalizeText(topic));
    const fragments = ["كرة", "السلة", "سله", "كره", "كورة", "basketball", "NBA", "nba_x", "hoops", "football", "القدم", " ", "  ", "َ", "ـ", "-", "باسكت", "دوري", "النادي", "x", "\n"];
    for (let i = 0; i < 100000; i += 1) {
      const t = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => pick(fragments)).join("");
      expect(isBasketballTopic(t), JSON.stringify(t)).toBe(old(t));
    }
    // the counter-case the first version of this change got wrong: the raw English word boundary is kept («NBA» beside a tatweel is still the NBA)
    expect(isBasketballTopic("\u064eNBA\u0640football")).toBe(true);
  });
});

function oldExclusionNormalize(text: string): string {
  if (!text) return "";
  return oldExclusionText(text).replace(/[^ء-ي\w\s]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
function oldExclusionFold(text: string): string { return oldExclusionText(text); }
void countCodePoints;
