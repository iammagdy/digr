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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// WORDS AS THE ARABIC WRITES THEM (DT-20261118-08 FIX4): a digit glued to its noun («٥شركات»), a noun with the one-letter words that join it to the word before («لشركتين»، «بشركتين»، «وشركتين»)
// or the article («الشركتين»، «للشركتين»). Grammar of the language; no word of any service, provider or company is named here.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
/** The words of a text as tokens: normalised, a digit run split from the letters glued to it. */
export const tokensOf = (text: string): string[] => normalizeWords(text).replace(/(\d)(?=\p{L})/gu, "$1 ").replace(/(\p{L})(?=\d)/gu, "$1 ").split(" ").filter((t) => t !== "");
/** The ways an Arabic word can start with what is joined to it: [و|ف] then [ل|ب|ك|ال|لل|بال|كال]. */
const PROCLITICS: string[] = (() => { const out: string[] = []; for (const a of ["", "و", "ف"]) for (const b of ["", "ل", "ب", "ك", "ال", "لل", "بال", "كال"]) out.push(a + b); return out.sort((x, y) => y.length - x.length); })();
/** The word without what is joined to its front (kept when too little would be left). */
const bareOf = (t: string): string => { for (const p of PROCLITICS) if (p !== "" && t.startsWith(p) && t.length - p.length >= 3) return t.slice(p.length); return t; };
/** The root of a noun for comparing it with another form of the same noun («مديرين»، «المديرين»، «لمديرين» → «مدير»): no clitic, no plural or dual or feminine ending. */
const stemOf = (t: string): string => { const b = bareOf(t); for (const e of ["ون", "ين", "ان", "ات", "ه", "ي", "و"]) if (b.endsWith(e) && b.length - e.length >= 3) return b.slice(0, -e.length); return b; };
const sameStem = (a: string, b: string): boolean => { const x = stemOf(a), y = stemOf(b); return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x)); };

/**
 * The number that words the model cited say, when they are really in the message (DT-20261118-08 FIX2: the count of the COMPANIES the customer wrote, cited by the model when it wrote no company step, e.g. «cannot»).
 * Digits in the words, one number word, or the Arabic dual (grammar, no word list); two numbers or none: null. The cited words must stand in the message as WHOLE words (FIX3: «5» is not inside «50», «خمس» is not
 * inside «خمسين»); the first of them may carry what is joined to the front of an Arabic word («وخمس شركات»، «لشركتين») and a digit may be glued to its noun («٥شركات») (FIX4).
 */
export function countWrittenIn(message: string, cited: string | null): number | null {
  const w = tokensOf(cited ?? "");
  const m = tokensOf(message);
  if (w.length === 0 || !m.some((_, i) => w.every((t, k) => (k === 0 ? PROCLITICS.some((p) => m[i] === p + t) : m[i + k] === t)))) return null;
  const words = w.join(" ");
  const digits = writtenNumbers(words);
  if (digits.length > 0) return digits.length === 1 ? digits[0] : null;
  return countOfWords(words);
}

/**
 * IS THIS NUMBER THE COUNT OF SOME OTHER NOUN, NOT OF THE PEOPLE? (DT-20261118-08 FIX4.) Asked only when the count of the companies could not be established: the number the model cites for each company may then be the
 * companies' own, copied. By the grammar of Arabic counting, a number is a count of a noun when the noun follows it («٥٠ شركة»، «٥شركات»), or when it is the dual form alone («شركتين»، «لشركتين»). Such a span counts
 * ANOTHER noun unless the noun is the people's own (same root as the people's title the planner wrote: «٣ مديرين» under «المديرين»). A bare number («اتنين»، «٣») or a span that is a phrase («٣ من كل شركة») is a per-company amount;
 * for a bare number the message is read: it is another noun's count when EVERY place the message writes that number is such a span (the word after it is a noun of 4 letters or more, which no preposition is, and not the people's).
 */
export function isCountOfOtherNoun(message: string, cited: string, n: number, peopleTitle: string): boolean {
  // DT-20261118-09 (BUG HUNTER FIX4 P1-1): the HEAD noun of the title is the people's own noun; a later word that names the companies («مسؤولو الشركات») must not make the companies' count read as the people's
  const people = tokensOf(peopleTitle).slice(0, 1);
  const isPeople = (t: string): boolean => people.some((p) => sameStem(t, p));
  const isNumber = (t: string): boolean => /^\d+$/.test(t) || wordNumbersIn(t, 1).length > 0;
  const numberOf = (t: string): number | null => (/^\d+$/.test(t) ? Number(t) : (wordNumbersIn(t, 1)[0] ?? null));
  const isDual = (t: string): boolean => !isNumber(t) && countOfWords(bareOf(t)) === 2;
  const nouns = tokensOf(cited).filter((t) => !isNumber(t));
  if (nouns.length === 1) return !isPeople(nouns[0]);
  if (nouns.length >= 2) return false;
  const m = tokensOf(message);
  let seen = 0;
  let counting = 0;
  m.forEach((t, i) => {
    const next = m[i + 1];
    if (isNumber(t) && numberOf(t) === n) { seen += 1; if (next !== undefined && !isNumber(next) && bareOf(next).length >= 4 && !isPeople(next)) counting += 1; }
    else if (n === 2 && isDual(t)) { seen += 1; if (!isPeople(t)) counting += 1; }
  });
  return seen > 0 && counting === seen;
}

const PER_EACH_DISTRIBUTIVE = new Set(["كل", "لكل", "بكل", "وكل", "فكل"]);
const AFTER_DISTRIBUTIVE_PREP = new Set(["في", "من", "علي", "عن"]);
const NON_PARENT_TIME = new Set(["يوم", "ايام", "اسبوع", "اسابيع", "شهر", "شهور", "اشهر", "سنه", "سنين", "سنوات", "ساعه", "ساعات", "دقيقه", "دقائق"]);

const stripLeadingConj = (t: string): string => (t.length >= 4 && (t[0] === "و" || t[0] === "ف") ? t.slice(1) : t);
const tokenMatchesWithConj = (a: string, b: string): boolean =>
  a === b || (a.length >= 4 && (a[0] === "و" || a[0] === "ف") && a.slice(1) === b) || (b.length >= 4 && (b[0] === "و" || b[0] === "ف") && b.slice(1) === a);
const isValidSingularIndefiniteNoun = (noun: string): boolean =>
  /^\p{L}{3,}$/u.test(noun) && !/^(?:[وفبكل]*)?ال|^لل/.test(noun) && !/(?:ون|ين|ان|ات|اء)$/.test(noun);
const isValidParentNounToken = (t: string | undefined): boolean =>
  Boolean(t && /^\p{L}{2,}$/u.test(t) && wordNumbersIn(t, 1).length === 0 && !/\d/.test(t) && !NON_PARENT_TIME.has(t));

/**
 * Pure Arabic morphology check (no keyword or service list): returns true when `cited` names an indefinite singular noun
 * that stands in a distributive per-parent clause inside `message` either AFTER (`من كل شركة مدير`) or BEFORE
 * (`ومدير كل شركة`, `مدير لكل شركة`) with optional leading conjunction `و`/`ف`. Plural/dual/definite forms return false.
 */
export function isSingularPerParentCitation(message: string, cited: string | null | undefined): boolean {
  const raw = normalizeWords(cited ?? "");
  if (raw.length < 2 || /\d/.test(raw) || wordNumbersIn(raw, 1).length > 0) return false;
  const cTokens = tokensOf(raw);
  if (cTokens.length === 0) return false;
  // If `cited` itself contains `<role> كل <parent>` (e.g. «ومدير كل شركة»), the singular noun precedes the distributive token.
  const distInCited = cTokens.findIndex((t, idx) => idx > 0 && idx < cTokens.length - 1 && PER_EACH_DISTRIBUTIVE.has(t));
  const nounOffset = distInCited > 0 ? distInCited - 1 : cTokens.length - 1;
  const noun = stripLeadingConj(cTokens[nounOffset]);
  if (!isValidSingularIndefiniteNoun(noun)) return false;
  if (cTokens.some((t) => wordNumbersIn(t, 1).length > 0 || /\d/.test(t))) return false;
  const mTokens = tokensOf(message);
  for (let i = 0; i <= mTokens.length - cTokens.length; i += 1) {
    if (!cTokens.every((t, k) => tokenMatchesWithConj(mTokens[i + k], t))) continue;
    const nounIdx = i + nounOffset;
    if (!isValidSingularIndefiniteNoun(stripLeadingConj(mTokens[nounIdx]))) continue;
    // Pattern A: distributive token before the singular noun («من كل شركة مدير»)
    if (
      (nounIdx >= 2 && PER_EACH_DISTRIBUTIVE.has(mTokens[nounIdx - 2]) && isValidParentNounToken(mTokens[nounIdx - 1])) ||
      (nounIdx >= 3 && PER_EACH_DISTRIBUTIVE.has(mTokens[nounIdx - 3]) && isValidParentNounToken(mTokens[nounIdx - 2]))
    ) {
      return true;
    }
    // Pattern B: distributive token after the singular noun («ومدير كل شركة», «مدير لكل شركة», «مدير من كل شركة»)
    if (
      (nounIdx + 2 < mTokens.length && PER_EACH_DISTRIBUTIVE.has(mTokens[nounIdx + 1]) && isValidParentNounToken(mTokens[nounIdx + 2])) ||
      (nounIdx + 3 < mTokens.length && AFTER_DISTRIBUTIVE_PREP.has(mTokens[nounIdx + 1]) && PER_EACH_DISTRIBUTIVE.has(mTokens[nounIdx + 2]) && isValidParentNounToken(mTokens[nounIdx + 3]))
    ) {
      return true;
    }
  }
  return false;
}
