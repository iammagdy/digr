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

/** The numbers above ten written in words in a text, as integers, in order. */
export function wordNumbersIn(text: string): number[] {
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
    if (value > 10) out.push(value);
    i = Math.max(j, i + 1);
  }
  return out;
}
