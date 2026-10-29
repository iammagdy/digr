import { normalizeText } from "./relevance";

/**
 * THE QUANTITY THE CUSTOMER ASKED FOR, read by CODE from their own words (never from the model): «٣٠٠ تغريدة»، «300 post»، «تلتمية تعليق»، «ألفين شركة»، «٣ آلاف منشور»، «٢٫٥ ألف». The plan's target is this number; the model may
 * propose a lower one only with a reason the customer reads on the card (see validateAndPricePlan). Pure: no I/O.
 *
 * A number that counts TIME («آخر ٣٠ يومًا»، «خلال ٦ أشهر»)، a percentage, money or a year is not a quantity of items and is skipped.
 */
export interface RequestedQuantity {
  value: number;
  /** The word after the number, as written («تغريدة»), or null. */
  noun: string | null;
  /** The number was written in digits (a number word counts only with the noun of an item after it: «واحد من اللاعبين» is not a quantity). */
  digits: boolean;
  /** «١٠ تعليقات لكل فيديو»: a number PER parent item, not the total the customer asked for. */
  perEach: boolean;
}

const ARABIC_INDIC = /[٠-٩]/g;
const PERSIAN = /[۰-۹]/g;
const asciiDigits = (s: string): string => s.replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660)).replace(PERSIAN, (d) => String(d.charCodeAt(0) - 0x06f0));

/** One word in a comparable form: normalized, no leading conjunction «و»/«ب», hamza on a seat folded (مائة → مايه), ة → ه. */
const norm = (w: string): string => normalizeText(w).replace(/ئ/g, "ي").replace(/ؤ/g, "و").replace(/[^\p{L}\p{N}.]/gu, "");

const UNITS: Record<string, number> = {
  واحد: 1, واحده: 1, احد: 1, اثنين: 2, اثنان: 2, اتنين: 2, اثنتين: 2, ثلاث: 3, ثلاثه: 3, تلات: 3, تلاته: 3, تلت: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5, ست: 6, سته: 6, سبع: 7, سبعه: 7,
  ثمان: 8, ثمانيه: 8, ثماني: 8, تمن: 8, تمانيه: 8, تمان: 8, تسع: 9, تسعه: 9,
};
const TEN_WORDS = new Set(["عشر", "عشره"]);
const TENS: Record<string, number> = {
  عشرين: 20, عشرون: 20, ثلاثين: 30, ثلاثون: 30, تلاتين: 30, تلتين: 30, اربعين: 40, اربعون: 40, خمسين: 50, خمسون: 50, ستين: 60, ستون: 60, سبعين: 70, سبعون: 70, ثمانين: 80, ثمانون: 80, تمانين: 80, تسعين: 90, تسعون: 90,
};
const HUNDRED_WORDS = new Set(["مايه", "ميه", "ميت", "مات", "مايات"]);
const TWO_HUNDRED = new Set(["ميتين", "مايتين", "مايتان", "ميتان"]);
const HUNDRED_COMPOUND = /^(ثلاث|تلات|تلت|ثلث|اربع|ربع|خمس|ست|سبع|ثمان|ثمن|تمن|تسع)(مايه|ميه|ميت|مات)$/;
const THOUSAND = new Set(["الف"]);
const TWO_THOUSAND = new Set(["الفين", "الفان"]);
const THOUSANDS_PLURAL = new Set(["الاف"]);
const MILLION = new Set(["مليون"]);
const HALF = new Set(["نص", "نصف"]);

const hundredCompoundValue = (w: string): number | null => {
  const m = HUNDRED_COMPOUND.exec(w);
  if (!m) return null;
  const base = m[1];
  const unit = base.startsWith("ثلاث") || base.startsWith("تلات") || base.startsWith("تلت") || base.startsWith("ثلث") ? 3 : base.startsWith("اربع") || base.startsWith("ربع") ? 4 : base.startsWith("خمس") ? 5 : base.startsWith("ست") ? 6 : base.startsWith("سبع") ? 7 : base.startsWith("ثمان") || base.startsWith("ثمن") || base.startsWith("تمن") ? 8 : 9;
  return unit * 100;
};

/** Words that make a number NOT a quantity of items (time, money, percent...). Compared after `norm`, with the definite article removed. */
const NOT_A_COUNT = new Set([
  "يوم", "ايام", "يوما", "اسبوع", "اسابيع", "شهر", "اشهر", "شهور", "سنه", "سنين", "سنوات", "عام", "اعوام", "ساعه", "ساعات", "دقيقه", "دقايق", "دقائق", "ثانيه", "ثواني", "جنيه", "جنيها", "ريال", "دولار", "درهم", "دينار", "نقطه", "نقاط", "بالمئه",
]);
const bareWord = (w: string): string => norm(w).replace(/^(?:لل|ال)(?=.{2,})/, "");

interface Token { raw: string; n: string }
const tokenize = (text: string): Token[] => text.split(/[\s،,؛;:()«»"'؟?!]+/).filter(Boolean).map((raw) => raw.replace(/\.+$/, "")).map((raw) => ({ raw, n: norm(raw) })).filter((t) => t.n.length > 0);

/** Strips a leading conjunction/preposition letter from a word that is a number word without it («وخمسين» → «خمسين»). */
function numberWordCore(n: string): string {
  if (isNumberWord(n)) return n;
  if (n.length > 3 && (n.startsWith("و") || n.startsWith("ب")) && isNumberWord(n.slice(1))) return n.slice(1);
  return n;
}
function isNumberWord(n: string): boolean {
  return n in UNITS || TEN_WORDS.has(n) || n in TENS || HUNDRED_WORDS.has(n) || TWO_HUNDRED.has(n) || hundredCompoundValue(n) !== null || THOUSAND.has(n) || TWO_THOUSAND.has(n) || THOUSANDS_PLURAL.has(n) || MILLION.has(n) || HALF.has(n);
}

/** Reads a run of number words starting at `i`: returns the value and how many tokens it used, or null. */
function readWordNumber(tokens: Token[], start: number): { value: number; used: number } | null {
  let total = 0;
  let current = 0;
  let used = 0;
  let any = false;
  let half = false;
  for (let i = start; i < tokens.length; i += 1) {
    const w = numberWordCore(tokens[i].n);
    const isConj = w === "و";
    if (isConj && any) { used += 1; continue; }
    if (!isNumberWord(w)) break;
    // «أحد الحسابات» is «one of the accounts»: «أحد» is a number only as the first word of «أحد عشر»
    if (w === "احد" && !(tokens[i + 1] && TEN_WORDS.has(numberWordCore(tokens[i + 1].n)))) break;
    any = true;
    used = i - start + 1;
    if (HALF.has(w)) { half = true; continue; }
    if (w in UNITS) { current += UNITS[w]; continue; }
    if (TEN_WORDS.has(w)) { current += 10; continue; }
    if (w in TENS) { current += TENS[w]; continue; }
    if (HUNDRED_WORDS.has(w)) { current = (current >= 1 && current <= 9 ? current : 1) * 100; continue; }
    if (TWO_HUNDRED.has(w)) { current += 200; continue; }
    const compound = hundredCompoundValue(w);
    if (compound !== null) { current += compound; continue; }
    if (THOUSAND.has(w)) { total += (half ? 0.5 : current || 1) * 1000; current = 0; half = false; continue; }
    if (TWO_THOUSAND.has(w)) { total += 2000; current = 0; continue; }
    if (THOUSANDS_PLURAL.has(w)) { total += (current || 3) * 1000; current = 0; continue; }
    if (MILLION.has(w)) { total += (current || 1) * 1_000_000; current = 0; continue; }
  }
  if (!any) return null;
  const value = total + current;
  // a trailing conjunction that was counted as used but followed by nothing numeric is not part of the number
  let u = used;
  while (u > 0 && tokens[start + u - 1] && numberWordCore(tokens[start + u - 1].n) === "و") u -= 1;
  return value > 0 ? { value: Math.round(value), used: u } : null;
}

const DIGITS_THEN_SUFFIX = /^(\d+(?:[.٫]\d+)?)(k|K|ك)?$/;

/**
 * Every plausible quantity in the text, in reading order. A number is a quantity unless the word after it counts time, money or a percentage, or it is a year with no noun after it.
 */
export function parseQuantities(textIn: unknown): RequestedQuantity[] {
  const text = asciiDigits(String(textIn ?? "")).replace(/(\d)[,٬](?=\d{3}\b)/g, "$1").replace(/(\d)٫(\d)/g, "$1.$2");
  const tokens = tokenize(text);
  const out: RequestedQuantity[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let value: number | null = null;
    let used = 1;
    const raw = tokens[i].raw;
    const dm = DIGITS_THEN_SUFFIX.exec(raw);
    if (dm) {
      value = Number(dm[1]);
      if (dm[2]) value *= 1000;
      // «٣ آلاف»، «٢.٥ ألف»، «٥ مليون»
      const next = tokens[i + 1] ? numberWordCore(tokens[i + 1].n) : "";
      if (THOUSAND.has(next) || THOUSANDS_PLURAL.has(next)) { value *= 1000; used = 2; } else if (MILLION.has(next)) { value *= 1_000_000; used = 2; }
    } else {
      const w = readWordNumber(tokens, i);
      if (w) { value = w.value; used = w.used; }
    }
    if (value === null || !Number.isFinite(value) || value < 1) { continue; }
    value = Math.round(value);
    const nounToken = tokens[i + used];
    const nounBare = nounToken ? bareWord(nounToken.raw) : null;
    const nounAfterOf = nounToken && bareWord(nounToken.raw) === "من" && tokens[i + used + 1] ? bareWord(tokens[i + used + 1].raw) : null;
    const noun = nounAfterOf ?? nounBare;
    // time, money and percentages are not items; a bare year («2024») is not a quantity either
    if (nounBare && NOT_A_COUNT.has(nounBare)) { i += used - 1; continue; }
    const prev = tokens[i - 1] ? bareWord(tokens[i - 1].raw) : "";
    if ((prev === "اخر" || prev === "منذ" || prev === "خلال") && nounBare && NOT_A_COUNT.has(nounBare)) { i += used - 1; continue; }
    if (value >= 1900 && value <= 2100 && !dm?.[2] && (!nounBare || !isCountedNoun(nounBare))) { i += used - 1; continue; }
    const counted = nounToken !== undefined && (isCountedNoun(nounToken.raw) || (nounAfterOf !== null && isCountedNoun(nounAfterOf)));
    // a number WORD with no item noun after it is ordinary speech («واحد من اللاعبين», «أحد الحسابات»), not a quantity
    if (!dm && !counted) { i += used - 1; continue; }
    const next = tokens.slice(i + used + 1, i + used + 4).map((t) => bareWord(t.raw));
    const perEach = next.includes("لكل") || next.some((w, k) => (w === "من" || w === "في" || w === "على") && next[k + 1] === "كل");
    out.push({ value, noun: nounToken ? nounToken.raw : null, digits: Boolean(dm), perEach });
    i += used - 1;
  }
  return out;
}

const COUNTED_NOUN_STEMS = ["تغريد", "منشور", "تعليق", "فيديو", "مقطع", "شرك", "موظف", "تقييم", "مراجع", "مكان", "مطعم", "حساب", "صور", "وظيف", "منتج", "اعلان", "صفح", "قنا", "خبر", "مقال", "رساله", "رسائل", "شخص", "رد", "نتيج", "سجل", "صف", "عنصر", "بوست", "كومنت", "ريل", "تويت"];
/** True for a word that names a kind of item (stem match: «تغريدات»، «التعليقات»، «شركة»). */
export function isCountedNoun(wordIn: string): boolean {
  const w = bareWord(wordIn);
  return COUNTED_NOUN_STEMS.some((s) => w.startsWith(norm(s)));
}

/** True when a word is a form of one of the given words (a stage's title words: «تعليقات كل منشور»). */
const nounInTitles = (noun: string, titles: ReadonlyArray<string>): boolean => titles.some((t) => String(t).split(/\s+/).some((w) => sameNounStem(w, noun)));

/**
 * The quantities of a text that COUNT ITEMS: the number is followed by the noun of an item (a known noun, or a word of a stage title). A number beside any other word is not the customer's quantity («أكثر من ٢٠٠ ألف متابع»: a
 * threshold on followers, not a number of items); with no noun the plan keeps the model's own estimate.
 */
export function countedQuantities(text: unknown, stageTitles: ReadonlyArray<string> = []): RequestedQuantity[] {
  return parseQuantities(text).filter((q) => !q.perEach && q.noun !== null && (isCountedNoun(q.noun) || nounInTitles(q.noun, stageTitles)));
}

/** The first quantity whose noun names a kind of item; null when the text has none. */
export function parseRequestedQuantity(text: unknown): RequestedQuantity | null {
  return countedQuantities(text)[0] ?? null;
}

/** True when two Arabic words are forms of one noun («التغريدات» ~ «تغريدة»): compared by a four-letter stem. */
export function sameNounStem(a: string, b: string): boolean {
  const x = bareWord(a).replace(/(ات|ون|ين|ان|ه)$/, "");
  const y = bareWord(b).replace(/(ات|ون|ين|ان|ه)$/, "");
  if (!x || !y) return false;
  const n = Math.min(4, x.length, y.length);
  return x.slice(0, n) === y.slice(0, n);
}

export interface QuantityStageRef { index: number; title_ar: string; deliver: boolean }

/**
 * WHICH STAGE THE QUANTITY COUNTS. A single delivered stage takes it. With several (posts and their comments, companies and their employees) the stage whose title names the noun the customer counted takes it; when no
 * title does, the first delivered stage (the root of what the customer receives). Returns the stage index and the value, or null when the request has no quantity of items.
 */
export function bindQuantity(text: unknown, stages: ReadonlyArray<QuantityStageRef>): { index: number; value: number } | null {
  const delivered = stages.filter((s) => s.deliver);
  if (delivered.length === 0) return null;
  const candidates = countedQuantities(text, delivered.map((s) => s.title_ar));
  if (candidates.length === 0) return null;
  if (delivered.length === 1) return { index: delivered[0].index, value: candidates[0].value };
  for (const q of candidates) {
    const hit = delivered.find((s) => String(s.title_ar).split(/\s+/).some((w) => sameNounStem(w, q.noun!)));
    if (hit) return { index: hit.index, value: q.value };
  }
  return { index: delivered[0].index, value: candidates[0].value };
}
