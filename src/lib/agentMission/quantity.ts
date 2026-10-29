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
  /** «اتنين من المديرين»: the noun after «من» (the noun field holds «من» itself then), else null. */
  of: string | null;
  /** «١٠ تعليقات لكل فيديو»: the word after «كل» (the parent item), else null. */
  parent?: string | null;
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

/** `brk`: a comma, a semicolon or a full stop stood before the word (a new clause). */
interface Token { raw: string; n: string; brk: boolean }
const tokenize = (text: string): Token[] => {
  const out: Token[] = [];
  let brk = false;
  let prevDot = false;
  for (const part of text.split(/([\s،,؛;:()«»"'؟?!]+)/)) {
    if (part === "") continue;
    if (/^[\s،,؛;:()«»"'؟?!]+$/.test(part)) { if (/[،,؛;؟?!]/.test(part)) brk = true; continue; }
    const raw = part.replace(/\.+$/, "");
    const n = norm(raw);
    if (n.length > 0) { out.push({ raw, n, brk: brk || prevDot }); brk = false; }
    prevDot = raw !== part;
  }
  return out;
};

/** Strips a leading conjunction/preposition letter from a word that is a number word without it («وخمسين» → «خمسين»). */
function numberWordCore(n: string): string {
  if (isNumberWord(n)) return n;
  if (n.length > 3 && (n.startsWith("و") || n.startsWith("ب")) && isNumberWord(n.slice(1))) return n.slice(1);
  return n;
}
export function isNumberWord(n: string): boolean {
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

/** «كل» / «لكل» / «وكل» / «ولكل». */
const isEvery = (t: Token | undefined): boolean => t !== undefined && /^(?:و)?(?:ل)?كل$/.test(t.n);
/** The prepositions that put a number on every parent: «من كل», «مع كل», «على كل», «في كل», «تحت كل», «وجوه كل». */
const EVERY_PREPOSITIONS = new Set(["من", "مع", "في", "على", "علي", "تحت", "عند", "جوه", "جوا", "داخل", "وسط", "عن"]);
const isEveryPreposition = (t: Token | undefined): boolean => t !== undefined && EVERY_PREPOSITIONS.has(t.n.replace(/^و(?=.{2,})/, ""));
const isNumberToken = (t: Token): boolean => DIGITS_THEN_SUFFIX.test(t.raw.replace(/^و(?=\d)/, "")) || isNumberWord(numberWordCore(t.n));
/** The word after «كل» names ONE parent («كل فيديو», «كل شركة», «كل واحد»), not all of them («كل الفيديوهات»). */
const isOneParent = (t: Token | undefined): boolean => t !== undefined && !/^(?:ال|لل)/.test(t.n) && t.n.length >= 2 && (t.n === "واحد" || !isNumberToken(t)) && !["ما", "اللي", "الي", "شي", "شيء", "حاجه", "حاجة", "مين", "ايه"].includes(t.n);

/**
 * IS THE NUMBER AT TOKEN `i` A NUMBER PER PARENT ITEM, and which noun does it count? Every phrasing: the marker after the noun («١٠ تعليقات لكل فيديو», «١٠ تعليقات على كل بوست», «١٠ تعليقات كل بوست»),
 * or before the number («ومن كل فيديو ١٠ تعليقات», «ومع كل بوست ١٠ تعليقات», «وجوه كل شركة موظفين اتنين», «ولكل واحد ١٠ تعليقات», «كل بوست فيه ١٠ تعليقات», «تعليقات كل فيديو ١٠»). The marker must touch the number or
 * its noun: «٥ فيديوهات ... ومن كل فيديو ...» does not make the 5 a per-parent number. Pure.
 */
function perEachOf(tokens: Token[], i: number, used: number, counted: boolean, hasOf: boolean): { perEach: boolean; noun: string | null; parent: string | null } {
  // after: [number] [noun]? [من المديرين]? [preposition]? كل <one parent>
  let a = i + used + (counted ? 1 + (hasOf ? 1 : 0) : 0);
  if (counted && hasOf) a = i + used + 2;
  const sameClause = (t: Token | undefined): boolean => t !== undefined && !t.brk && !t.n.startsWith("و");
  if (sameClause(tokens[a]) && isEveryPreposition(tokens[a]) && isEvery(tokens[a + 1]) && isOneParent(tokens[a + 2])) return { perEach: true, noun: null, parent: tokens[a + 2].raw };
  if (sameClause(tokens[a]) && isEvery(tokens[a]) && isOneParent(tokens[a + 1])) return { perEach: true, noun: null, parent: tokens[a + 1].raw };
  // before: كل <one parent> [filler or the child noun]* [number]
  for (let k = i - 1; k >= 0 && k >= i - 7; k -= 1) {
    if (isNumberToken(tokens[k]) && !(tokens[k].n === "واحد" && isEvery(tokens[k - 1]))) return { perEach: false, noun: null, parent: null };
    if (!isEvery(tokens[k])) continue;
    if (k + 1 > i - 1 || !isOneParent(tokens[k + 1])) return { perEach: false, noun: null, parent: null };
    const between = tokens.slice(k + 2, i);
    const own = between.find((t) => isCountedNoun(t.raw));
    const before = tokens[k - 1] && !isEveryPreposition(tokens[k - 1]) && isCountedNoun(tokens[k - 1].raw) ? tokens[k - 1] : tokens[k - 2] && isEveryPreposition(tokens[k - 1]) && isCountedNoun(tokens[k - 2].raw) ? tokens[k - 2] : undefined;
    const noun = own ? own.raw : before ? before.raw : null;
    return { perEach: true, noun: noun !== null && /^و/.test(noun) && isCountedNoun(noun.slice(1)) ? noun.slice(1) : noun, parent: tokens[k + 1].raw };
  }
  return { perEach: false, noun: null, parent: null };
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
    const raw = tokens[i].raw.replace(/^و(?=\d)/, "");
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
    const each = perEachOf(tokens, i, used, counted, nounAfterOf !== null);
    // a number word with no item noun after it is ordinary speech, unless it is the per-parent number of a noun that stood before it («كل شركة موظفين اتنين»)
    if (!dm && !counted && !(each.perEach && each.noun)) { i += used - 1; continue; }
    const childNoun = counted ? nounToken!.raw : each.perEach && each.noun ? each.noun : nounToken ? nounToken.raw : null;
    out.push({ value, noun: childNoun, digits: Boolean(dm), perEach: each.perEach, of: nounAfterOf !== null && tokens[i + used + 1] ? tokens[i + used + 1].raw : null, parent: each.perEach ? each.parent : null });
    i += used - 1;
  }
  return out;
}

const COUNTED_NOUN_STEMS = ["تغريد", "منشور", "تعليق", "فيديو", "مقطع", "شرك", "موظف", "تقييم", "مراجع", "مكان", "مطعم", "حساب", "صور", "وظيف", "منتج", "اعلان", "صفح", "قنا", "خبر", "مقال", "رساله", "رسائل", "شخص", "رد", "نتيج", "سجل", "صف", "عنصر", "بوست", "كومنت", "ريل", "تويت", "مدير", "مسؤول", "مسئول", "اماكن", "قنو", "اشخاص", "صانع", "صناع", "ناشر", "مالك", "عضو", "اعضاء", "مشارك"];
/** True for a word that names a kind of item (stem match: «تغريدات»، «التعليقات»، «شركة»). */
export function isCountedNoun(wordIn: string): boolean {
  const w = bareWord(wordIn);
  return COUNTED_NOUN_STEMS.some((s) => w.startsWith(norm(s)) || (w.length > 4 && w.startsWith("و") && w.slice(1).startsWith(norm(s))));
}

/** True when a word is a form of one of the given words (a stage's title words: «تعليقات كل منشور»). */
const nounInTitles = (noun: string, titles: ReadonlyArray<string>): boolean => titles.some((t) => ownTitleWords(t).some((w) => sameNounStem(w, noun)));

/**
 * The quantities of a text that COUNT ITEMS: the number is followed by the noun of an item (a known noun, or a word of a stage title). A number beside any other word is not the customer's quantity («أكثر من ٢٠٠ ألف متابع»: a
 * threshold on followers, not a number of items); with no noun the plan keeps the model's own estimate.
 */
export function countedQuantities(text: unknown, stageTitles: ReadonlyArray<string> = []): RequestedQuantity[] {
  return parseQuantities(text).filter((q) => !q.perEach && q.noun !== null && (isCountedNoun(q.noun) || nounInTitles(q.noun, stageTitles)));
}

/**
 * THE NUMBERS A REQUEST GIVES PER PARENT ITEM, in reading order: «ومع كل بوست ١٠ تعليقات», «ومن كل شركة اتنين من المديرين», «١٠ ردود لكل تغريدة». Each one is a STEP of the request (the children of the items of the step before it) with the count asked for each parent.
 */
export function perParentQuantities(text: unknown): RequestedQuantity[] {
  return parseQuantities(text)
    .filter((q) => q.perEach && q.noun !== null && (isCountedNoun(q.noun) || (q.of !== null && isCountedNoun(q.of))))
    .map((q) => (q.of !== null && !isCountedNoun(q.noun!) ? { ...q, noun: q.of } : q));
}

/** The words that name a SOURCE the customer lists («٥ فيديوهات من كل قناة»: the channel is a source, not a step of the plan): channel, account, page, source. */
const SOURCE_KIND_STEMS = ["قنا", "حساب", "صفح", "مصدر"];
export const isSourceKindWord = (wordIn: string): boolean => { const w = bareWord(wordIn); return SOURCE_KIND_STEMS.some((s) => w.startsWith(norm(s))); };

/**
 * THE NUMBER THE CUSTOMER ASKED FOR FROM EACH NAMED SOURCE («٥ فيديوهات من كل قناة» for three channels, «١٠ تغريدات من كل حساب»): not a step of the plan (the channels are not items the plan reads), a count per source. The caller decides whether the request really names sources.
 */
export function perSourceQuantities(text: unknown): RequestedQuantity[] {
  return perParentQuantities(text).filter((q) => q.parent !== undefined && q.parent !== null && isSourceKindWord(q.parent));
}

/** The per-parent numbers of the request that no child stage of the plan serves: the customer asked for a step the plan does not have. */
export function unservedPerParentAsks(asks: ReadonlyArray<RequestedQuantity>, childTitles: ReadonlyArray<string>): RequestedQuantity[] {
  return asks.filter((q) => !(childTitles.some((t) => ownTitleWords(t).some((w) => sameNounStem(w, q.noun!))) || (childTitles.length === 1 && asks.length === 1)));
}

/**
 * The per-parent number that belongs to ONE child stage of a plan: the one whose noun is a word of the stage's title; when the title names none of them (the customer said «ردود», the plan's title says «تعليقات»), the only per-parent number
 * of the request when the plan has exactly one child stage. Null when the request gives no per-parent number for this stage.
 */
export function perParentAskOf(asks: ReadonlyArray<RequestedQuantity>, childTitle: string, childStageCount: number): RequestedQuantity | null {
  const own = ownTitleWords(childTitle);
  const hit = asks.find((q) => own.some((w) => sameNounStem(w, q.noun!)));
  if (hit) return hit;
  return childStageCount === 1 && asks.length === 1 ? asks[0] : null;
}

export function perParentAskFor(asks: ReadonlyArray<RequestedQuantity>, childTitle: string, childStageCount: number): number | null {
  return perParentAskOf(asks, childTitle, childStageCount)?.value ?? null;
}

/** The first quantity whose noun names a kind of item; null when the text has none. */
export function parseRequestedQuantity(text: unknown): RequestedQuantity | null {
  return countedQuantities(text)[0] ?? null;
}

/** True when two Arabic words are forms of one noun («التغريدات» ~ «تغريدة»): compared by a four-letter stem. */
export function sameNounStem(a: string, b: string): boolean {
  const x = canonicalStem(bareWord(a).replace(/(ات|ون|ين|ان|ه)$/, ""));
  const y = canonicalStem(bareWord(b).replace(/(ات|ون|ين|ان|ه)$/, ""));
  if (!x || !y) return false;
  const n = Math.min(4, x.length, y.length);
  return x.slice(0, n) === y.slice(0, n);
}

/** Two names of one kind of item: a «بوست» is a «منشور», a «مراجعة» a «تقييم», a «مقطع» a «فيديو» (the customer says one, the stage's title the other). */
const SAME_NOUN: ReadonlyArray<readonly [string, string]> = [["بوست", "منشور"], ["مراجع", "تقييم"], ["مقطع", "فيديو"], ["ريلز", "فيديو"], ["كومنت", "تعليق"], ["تويت", "تغريد"]];
const canonicalStem = (w: string): string => { for (const [from, to] of SAME_NOUN) if (w.startsWith(from)) return to; return w; };

/** The words of a stage's title that name ITS OWN items: the words before the first «كل» / «على» / «عن» («تعليقات كل بوست» counts comments; «بوست» there is the parent). */
export const ownTitleWords = (title: string): string[] => {
  const words = String(title ?? "").split(/\s+/).filter(Boolean);
  const cut = words.findIndex((w, i) => i > 0 && /^(?:كل|لكل|على|علي|عن|في|من|لدى)$/.test(bareWord(w)));
  return cut === -1 ? words : words.slice(0, cut);
};

export interface QuantityStageRef { index: number; title_ar: string; deliver: boolean }

/**
 * WHICH STAGE THE QUANTITY COUNTS. The stage whose title names the noun the customer counted takes it, WHETHER OR NOT the model marked that stage as delivered: «هات ٥ فيديوهات ... ومن كل فيديو ١٠ تعليقات» counts the videos (live run of
 * 2026-10-29: the model kept the videos as an intermediate stage, the only delivered stage was the comments, and the 5 became the comments' target: 5 comments in all). `named` is true when a title named the noun: the customer asked for
 * those items, so the plan delivers them. When no title names it, a single delivered stage takes it; with several, the first delivered stage (the root of what the customer receives). Returns null when the request has no quantity of items.
 */
export function bindQuantityDetailed(text: unknown, stages: ReadonlyArray<QuantityStageRef>): { index: number; value: number; named: boolean } | null {
  const delivered = stages.filter((s) => s.deliver);
  if (stages.length === 0) return null;
  const candidates = countedQuantities(text, stages.map((s) => s.title_ar));
  if (candidates.length === 0) return null;
  for (const q of candidates) {
    const hit = stages.find((s) => ownTitleWords(String(s.title_ar)).some((w) => sameNounStem(w, q.noun!)));
    if (hit) return { index: hit.index, value: q.value, named: true };
  }
  if (delivered.length === 0) return null;
  return { index: delivered[0].index, value: candidates[0].value, named: false };
}

export interface RequestedStageRef { index: number; title_ar: string; parent_key: string | null }

/**
 * THE STAGES WHOSE ITEMS THE CUSTOMER ASKED FOR, by their nouns, whatever the model marked: the counted noun («٥ فيديوهات», «٣ شركات») and every per-parent noun («من كل فيديو ١٠ تعليقات», «ومن كل شركة اتنين من المديرين», «ومع كل بوست ...», «لكل ...»;
 * `perParentQuantities`). A stage may be an intermediate one (read, never delivered) only when the customer did not ask for its items. Live run of 2026-10-29 after #294: the videos were forced to be delivered but the comments were kept as an
 * intermediate stage («لم تُسلَّم (مرحلة وسيطة)»), and the same for the managers of the companies: the customer paid for a file without what they asked for. Pure.
 */
export function requestedStageIndexes(text: unknown, stages: ReadonlyArray<RequestedStageRef>): Set<number> {
  const out = new Set<number>();
  if (stages.length === 0) return out;
  const bound = bindQuantityDetailed(text, stages.map((s) => ({ index: s.index, title_ar: s.title_ar, deliver: false })));
  if (bound?.named) out.add(bound.index);
  const asks = perParentQuantities(text);
  const childCount = stages.filter((s) => s.parent_key !== null).length;
  for (const s of stages) {
    const own = ownTitleWords(s.title_ar);
    if (asks.some((q) => own.some((w) => sameNounStem(w, q.noun!)))) out.add(s.index);
    else if (s.parent_key !== null && perParentAskFor(asks, s.title_ar, childCount) !== null) out.add(s.index);
  }
  return out;
}

/** The same, without `named` (the stage and the value). */
export function bindQuantity(text: unknown, stages: ReadonlyArray<QuantityStageRef>): { index: number; value: number } | null {
  const bound = bindQuantityDetailed(text, stages);
  return bound ? { index: bound.index, value: bound.value } : null;
}
