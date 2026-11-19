import { normalizeDigits } from "../arabicDigits";

/**
 * ROUND 58: NUMBERS WRITTEN IN WORDS («ثلاثة وثلاثون»، «ثلاثمائة وخمسة وعشرين»). The reply guard checked digits only, and the real chat model answered «يعني ٣٢ شركة؟» on merged main 99acb4f with «الرقم ثلاثة وثلاثون هو مجموع العناصر» (the plan's
 * number is 32): a wrong number in words passed. This reads Arabic cardinal numbers from 11 to 999,999 written in words, so the guard can hold them to the same allowed numbers as digits. Small numbers (≤ 10: «مرة واحدة»، «خطوتين»، «ثلاث خطوات»)
 * are left alone: they are words of ordinary speech far more often than facts of the plan. Pure.
 */
const norm = (w: string): string => w.replace(/[ً-ْٰـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");

const UNITS: Record<string, number> = {
  واحد: 1, واحده: 1, احد: 1, احدي: 1, اثنان: 2, اثنين: 2, اثنتان: 2, اثنتين: 2, اثنا: 2, اثنتا: 2, اثني: 2, اثنتي: 2, اتنين: 2,
  ثلاث: 3, ثلاثه: 3, تلات: 3, تلاته: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5, ست: 6, سته: 6, سبع: 7, سبعه: 7,
  ثمان: 8, ثماني: 8, ثمانيه: 8, تمن: 8, تمنيه: 8, تسع: 9, تسعه: 9,
};
const TENS: Record<string, number> = {
  عشرون: 20, عشرين: 20, ثلاثون: 30, ثلاثين: 30, تلاتين: 30, اربعون: 40, اربعين: 40, خمسون: 50, خمسين: 50, ستون: 60, ستين: 60,
  سبعون: 70, سبعين: 70, ثمانون: 80, ثمانين: 80, تمانين: 80, تسعون: 90, تسعين: 90,
};
const TEN_WORDS = new Set(["عشر", "عشره"]);
const HUNDRED = new Set(["مائه", "مئه", "ميه", "ميت"]);
const TWO_HUNDRED = new Set(["مائتان", "مائتين", "مئتان", "مئتين", "مائتا", "مئتا", "ميتين"]);
const THOUSAND = new Set(["الف"]);
const THOUSANDS = new Set(["الاف", "ألاف"]);

/** One word's value as a part of a number: {kind, value}; null when it is not a number word. «ثلاثمائة» (one word) is 300. */
function partOf(word: string): { kind: "unit" | "ten" | "teen10" | "hundred" | "thousand"; value: number } | null {
  const w = norm(word);
  if (w in UNITS) return { kind: "unit", value: UNITS[w] };
  if (w in TENS) return { kind: "ten", value: TENS[w] };
  if (TEN_WORDS.has(w)) return { kind: "teen10", value: 10 };
  if (HUNDRED.has(w)) return { kind: "hundred", value: 100 };
  if (TWO_HUNDRED.has(w)) return { kind: "hundred", value: 200 };
  for (const [u, v] of Object.entries(UNITS)) if (v >= 3 && (w === `${u}مائه` || w === `${u}مئه`)) return { kind: "hundred", value: v * 100 };
  if (THOUSAND.has(w)) return { kind: "thousand", value: 1000 };
  if (THOUSANDS.has(w)) return { kind: "thousand", value: 1000 };
  return null;
}

/** The numbers written in words in a text, as integers, in order: above ten by default (the reply guard); `min` 1 reads the small ones too (the chat checks the words a count was cited from, DT-20261118-05). */
export function wordNumbersIn(text: string, min = 11): number[] {
  // punctuation ends a number («اثنتي عشرة، وعشرون شركة» is 12 and 20, never 32)
  const tokens = String(text ?? "").replace(/[«»"،,.:؛؟?!()]/g, " | ").split(/\s+/).filter(Boolean);
  const out: number[] = [];
  let i = 0;
  while (i < tokens.length) {
    // a number may start with «و» («…، وعشرون شركة»)
    if (!partOf(tokens[i]) && tokens[i].startsWith("و") && tokens[i].length > 2 && partOf(tokens[i].slice(1))) tokens[i] = tokens[i].slice(1);
    const startPart = partOf(tokens[i]);
    if (!startPart) { i += 1; continue; }
    // one number: parts joined by «و» («ثلاثمائة وخمسة وعشرين»), a unit before «عشر» (11–19), a count before «مائة» or «آلاف»
    let total = 0;
    let current = 0;
    let j = i;
    let first = true;
    let teen = false;
    while (j < tokens.length) {
      let word = tokens[j];
      if (!first) {
        if (word.startsWith("و") && word.length > 2 && partOf(word.slice(1))) word = word.slice(1);
        else if (!partOf(word)) break;
      }
      const p = partOf(word);
      if (!p) break;
      // after a teen («اثنا عشر») only «ألف» may follow; a ten or a unit starts another number
      if (teen && p.kind !== "thousand") break;
      if (p.kind === "teen10") { current += 10; teen = current > 10; }
      else if (p.kind === "hundred") current = (current > 0 && current < 10 && p.value === 100 ? current * 100 : current + p.value);
      else if (p.kind === "thousand") { total += Math.max(1, current) * 1000; current = 0; teen = false; }
      else current += p.value;
      first = false;
      j += 1;
    }
    const value = total + current;
    if (value >= min) out.push(value);
    i = Math.max(j, i + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A COUNT THE CUSTOMER WROTE (DT-20261118-05, shared since DT-20261118-08 FIX1)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
/** A message's words, normalised for comparing (Arabic-Indic digits to ASCII, no diacritics, one alif, ة → ه, no punctuation, one space). */
export const normalizeWords = (raw: string): string => normalizeDigits(String(raw ?? "")).replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase().replace(/[،,.!؟?؛;:"'«»()[\]{}\-_/\\|*#@~`+=<>]/g, " ").replace(/\s+/g, " ").trim();

/** The numbers written in a message, as integers. */
export const writtenNumbers = (message: string): number[] => (normalizeWords(message).match(/\d+/g) ?? []).map(Number).filter((n) => Number.isSafeInteger(n));

/**
 * THE NUMBER THE CITED WORDS SAY (QA #575 FAIL 2: {count: 700, count_text: «شركتين»} passed because the words are in the message). A number in words is read by the reader the reply guard already uses (numberWords.ts: the grammar of
 * Arabic cardinals, no list of services or providers); words that hold no number word may only be the Arabic DUAL of a noun («شركتين»، «تعليقين»: one word ending in ين or ان), which means two. Anything else says no number.
 */
export function countOfWords(words: string): number | null {
  const said = wordNumbersIn(words, 1);
  if (said.length > 0) return said.length === 1 ? said[0] : null;
  const tokens = words.split(" ");
  return tokens.length === 1 && /^\p{L}{2,}(?:ين|ان)$/u.test(tokens[0]) ? 2 : null;
}

/**
 * A count a model returned is kept only when the customer WROTE that number (moved here from conversationModel.ts for the planner's per-company count, DT-20261118-08 FIX1; the chat's behaviour is unchanged).
 */
export function countSupportedByMessage(message: string, count: number | null, countText: string | null = null): number | null {
  if (count === null) return null;
  if (writtenNumbers(message).includes(count)) return count;
  // THE COUNT WRITTEN IN WORDS («شركتين», «اتنين», «عشر»): the model says which words of the message wrote it; code checks those words are really in the message AND say the same number (a count the words do not say is dropped)
  const words = normalizeWords(countText ?? "");
  if (words.length < 2 || /\d/.test(words) || !normalizeWords(message).includes(words)) return null;
  return countOfWords(words) === count ? count : null;
}

/**
 * Does the message write the number n OUTSIDE the words the model cited for it (DT-20261118-08 FIX1)? Used when a count per company equals the count of the companies: the customer wrote it twice
 * («٣ شركات ومن كل شركة ٣ مديرين»، «شركتين … ومن كل شركة مديرين اتنين»), or the model copied the companies' own number («شركتين»، «٥ شركات») into it. Digits and number words are read by the readers above;
 * for two, an indefinite Arabic dual word elsewhere («شركتين») also writes it (grammar: one word ending in ين or ان without «ال»; no word list).
 */
export function writtenElsewhere(message: string, cited: string, n: number): boolean {
  const m = ` ${normalizeWords(message)} `;
  const c = normalizeWords(cited);
  const said = (text: string): number => [...writtenNumbers(text), ...wordNumbersIn(text, 1)].filter((x) => x === n).length;
  if (c === "" || !m.includes(` ${c} `)) return said(m) >= 2;
  const rest = m.replace(` ${c} `, " ");
  return said(rest) >= 1 || (n === 2 && rest.split(" ").some((t) => t !== "" && !/^و?ال/.test(t) && countOfWords(t) === 2));
}
