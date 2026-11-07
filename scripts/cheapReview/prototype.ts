/**
 * Prototype of the CHEAP REVIEW scheme (docs/CHEAP_REVIEW_DESIGN.md). Nothing here is used by the product: these are the pure pieces the design
 * rests on, written and tested so the simulation (scripts/cheap-review-simulation.ts) and the design numbers are not made up:
 *  - the cost model of one model call, from the calls measured on production;
 *  - near-duplicate clustering (normalisation and similarity);
 *  - the number-only reply (one digit per row) with its strict reading, its canary check and the salvage of a cut reply;
 *  - trusted publishers inside one job;
 *  - the audit window and the fall-back to strict review;
 *  - the strong-signal acceptance in code, with a starter vocabulary the owner must review.
 */
import { contentStems, hasRegionEvidence, hasTopicEvidence, normalizeText, stemToken, topicStems } from "../../src/lib/server/topicMatch";

/* ---------------------------------------------------------------------------------------------------------------------------------- */
/* Cost model                                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------------------------- */

/** USD per token, from the rows of llm_usage of 21 Oct 2026 (a call of 2,021 in and 1,381 out cost 0.007141; of 2,748 in and 2,025 out, 0.010298). */
export const PRICE_IN_USD = 0.8e-6;
export const PRICE_OUT_USD = 4e-6;

/** TODAY's review call (verdict-only JSON, 20 rows: 3,325 tokens in, 1,000 out, 0.00666 USD, measured). The 1,000 out is the old output limit: the real uncut reply is not known. */
export const TODAY_CALL = { overheadIn: 450, inPerRow: 144, outPerRow: 50 } as const;
/** The same call if the reply were 20 tokens a row (the lowest the JSON verdict can be): the sensitivity case for today's cost. */
export const TODAY_CALL_LEAN = { overheadIn: 450, inPerRow: 144, outPerRow: 20 } as const;
/** The cheap call (ASSUMED, to be measured in shadow mode): a shorter instruction, numbered text lines trimmed to 160 characters, a reply of one digit per row. */
export const CHEAP_CALL = { overheadIn: 350, inPerRow: 110, outOverhead: 10, outPerRow: 1.2 } as const;
export const CHEAP_BATCH_ROWS = 50;

export const callCostUsd = (tokensIn: number, tokensOut: number): number => tokensIn * PRICE_IN_USD + tokensOut * PRICE_OUT_USD;

export const todayCallCostUsd = (rows: number, model: { overheadIn: number; inPerRow: number; outPerRow: number } = TODAY_CALL): number =>
  callCostUsd(model.overheadIn + model.inPerRow * rows, model.outPerRow * rows);

/** `inPerRow` is the input tokens of one row (110 for text trimmed to 160 characters); the simulation tries shorter snippets. */
export const cheapCallCostUsd = (rows: number, inPerRow: number = CHEAP_CALL.inPerRow): number =>
  callCostUsd(CHEAP_CALL.overheadIn + inPerRow * rows, CHEAP_CALL.outOverhead + CHEAP_CALL.outPerRow * rows);

/* ---------------------------------------------------------------------------------------------------------------------------------- */
/* Near-duplicate clustering                                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------------------------- */

/**
 * The text a near-duplicate comparison is made on: no retweet prefix, no links, no mentions, no digits (Latin, Arabic-Indic, Persian), no tashkeel
 * and no tatweel, alef/ya/ta marbuta folded, no punctuation or emoji, a letter repeated three times or more reduced to one, one space between words.
 */
export function normalizeForCluster(text: string): string {
  const stripped = String(text ?? "")
    .replace(/^\s*rt\s+@\w+\s*:?\s*/i, " ")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/@[\w؀-ۿ]+/g, " ")
    .replace(/[0-9٠-٩۰-۹]+/g, " ");
  return normalizeText(stripped).replace(/(\p{L})\1{2,}/gu, "$1").replace(/\s+/g, " ").trim();
}

const tokenSetOf = (normalized: string): Set<string> => new Set(normalized.split(" ").filter(Boolean));

/** Jaccard similarity of the word sets of two normalised texts; texts of fewer than three words are the same only when equal. */
export function similarity(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  const left = tokenSetOf(a);
  const right = tokenSetOf(b);
  if (left.size < 3 || right.size < 3) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Groups near-identical texts. `clusterOf[i]` is the cluster of text i; `representatives[c]` is the position of the first text of cluster c (the one a model reviews). */
export function clusterRows(texts: string[], threshold = 0.85): { clusterOf: number[]; representatives: number[] } {
  const normalized = texts.map(normalizeForCluster);
  const representatives: number[] = [];
  const clusterOf: number[] = [];
  normalized.forEach((text, index) => {
    let found = -1;
    for (let c = 0; c < representatives.length; c += 1) {
      if (similarity(text, normalized[representatives[c]]) >= threshold) { found = c; break; }
    }
    if (found < 0) { representatives.push(index); found = representatives.length - 1; }
    clusterOf.push(found);
  });
  return { clusterOf, representatives };
}

/* ---------------------------------------------------------------------------------------------------------------------------------- */
/* The number-only reply                                                                                                               */
/* ---------------------------------------------------------------------------------------------------------------------------------- */

export type DigitVerdict = "1" | "0" | "2";
export interface DigitReading {
  /** One entry per row of the call: «1» match, «0» no match, «2» uncertain, null when the reply did not reach the row. */
  verdicts: Array<DigitVerdict | null>;
  /** ok: every row answered; partial: a reply cut at the output limit, only its verified prefix is kept; rejected: nothing is kept (the rows are asked again in smaller calls). */
  status: "ok" | "partial" | "rejected";
  reason?: "not_digits" | "empty" | "too_short" | "too_long" | "canary_failed";
}

/**
 * Reads a reply that must be nothing but digits (spaces and line breaks allowed, for the groups of five that make it easy for the model to count).
 * STRICT: a reply with any other character, or with a different number of digits than rows, is rejected whole (a shifted digit would move every
 * later verdict to the wrong row). `canaries` are rows whose answer the code knows; one wrong makes the reply invalid. A reply cut at the output limit
 * (`truncated`) keeps its prefix only when every canary inside it is right.
 */
export function readDigitReply(reply: string, rows: number, options: { canaries?: Array<{ position: number; expected: "0" | "1" }>; truncated?: boolean } = {}): DigitReading {
  const none = Array.from({ length: rows }, () => null as DigitVerdict | null);
  const text = String(reply ?? "").trim();
  if (text.length === 0) return { verdicts: none, status: "rejected", reason: "empty" };
  if (!/^[012\s]+$/.test(text)) return { verdicts: none, status: "rejected", reason: "not_digits" };
  const digits = text.replace(/\s+/g, "");
  const canaries = options.canaries ?? [];
  if (digits.length > rows) return { verdicts: none, status: "rejected", reason: "too_long" };
  if (digits.length < rows && !options.truncated) return { verdicts: none, status: "rejected", reason: "too_short" };
  for (const canary of canaries) {
    if (canary.position < digits.length && digits[canary.position] !== canary.expected) return { verdicts: none, status: "rejected", reason: "canary_failed" };
  }
  const verdicts = none.map((_, index) => (index < digits.length ? (digits[index] as DigitVerdict) : null));
  return { verdicts, status: digits.length === rows ? "ok" : "partial" };
}

/* ---------------------------------------------------------------------------------------------------------------------------------- */
/* Trusted publishers (one job, no storage across customers)                                                                          */
/* ---------------------------------------------------------------------------------------------------------------------------------- */

export class TrustedPublishers {
  private readonly streak = new Map<string, number>();
  /** Consecutive model matches that make a publisher trusted for the rest of the job. */
  constructor(private readonly needed = 2) {}
  private static key(publisher: string | null | undefined): string | null {
    const key = String(publisher ?? "").trim().toLowerCase();
    return key ? key : null;
  }
  /** A model verdict on a row of this publisher: a match extends the streak, anything else ends it and withdraws the trust. */
  record(publisher: string | null | undefined, verdict: "match" | "other"): void {
    const key = TrustedPublishers.key(publisher);
    if (!key) return;
    this.streak.set(key, verdict === "match" ? (this.streak.get(key) ?? 0) + 1 : 0);
  }
  isTrusted(publisher: string | null | undefined): boolean {
    const key = TrustedPublishers.key(publisher);
    return key !== null && (this.streak.get(key) ?? 0) >= this.needed;
  }
  /** An audit found a wrong row accepted on this publisher's trust. */
  revoke(publisher: string | null | undefined): void {
    const key = TrustedPublishers.key(publisher);
    if (key) this.streak.set(key, 0);
  }
}

/* ---------------------------------------------------------------------------------------------------------------------------------- */
/* The audit window and the fall-back to strict review                                                                                */
/* ---------------------------------------------------------------------------------------------------------------------------------- */

export class AuditWindow {
  private readonly results: boolean[] = [];
  private strictMode = false;
  /** `size` recent audits are counted; below `minSamples` the estimate is unknown; strict review starts above `enterAbove` and ends at or below `exitAtOrBelow`. */
  constructor(private readonly size = 40, private readonly minSamples = 12, private readonly enterAbove = 0.15, private readonly exitAtOrBelow = 0.1) {}
  /** True when the audited row was accepted without the model although the model says it is not on topic. */
  add(falseAccept: boolean): void {
    this.results.push(falseAccept);
    if (this.results.length > this.size) this.results.shift();
    const rate = this.estimate();
    if (rate === null) return;
    if (!this.strictMode && rate > this.enterAbove) this.strictMode = true;
    else if (this.strictMode && rate <= this.exitAtOrBelow) this.strictMode = false;
  }
  estimate(): number | null {
    if (this.results.length < this.minSamples) return null;
    return this.results.filter(Boolean).length / this.results.length;
  }
  get strict(): boolean { return this.strictMode; }
  get samples(): number { return this.results.length; }
}

/* ---------------------------------------------------------------------------------------------------------------------------------- */
/* Strong-signal acceptance in code                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------------------------------- */

/** STARTER vocabulary for Egypt. Raw spellings, compared after the normalisation of the topic matcher. The owner must review these lists before any use. */
export const EGYPT_PLACES = [
  "القاهرة", "الجيزة", "الإسكندرية", "القليوبية", "الشرقية", "الدقهلية", "الغربية", "المنوفية", "البحيرة", "كفر الشيخ", "دمياط", "بورسعيد", "الإسماعيلية",
  "السويس", "شمال سيناء", "جنوب سيناء", "البحر الأحمر", "الفيوم", "بني سويف", "المنيا", "أسيوط", "سوهاج", "قنا", "الأقصر", "أسوان", "الوادي الجديد", "مطروح",
  "طنطا", "المنصورة", "الزقازيق", "شبين الكوم", "دمنهور", "الغردقة", "شرم الشيخ", "العاشر من رمضان", "مدينة نصر", "التجمع", "الشروق", "العبور", "حلوان",
  "المعادي", "الهرم", "شبرا", "الدقي", "المهندسين", "إمبابة", "أكتوبر",
];
export const EGYPT_CLUBS_AND_PEOPLE = [
  "الأهلي", "الزمالك", "بيراميدز", "سموحة", "المصري البورسعيدي", "الإسماعيلي", "إنبي", "الاتحاد السكندري", "طلائع الجيش", "محمد صلاح", "مرموش", "حسام حسن", "كهربا",
];
/** Words of the Egyptian dialect (tier C, switched off by default): one of them proves nothing, two together with the topic hint at Egypt. */
export const EGYPT_DIALECT_MARKERS = ["ازاي", "دلوقتي", "دلوقت", "كده", "اوي", "ايه", "فين", "امتى", "عايز", "عاوز", "مفيش", "بقى"];
/** Names of other countries: a text that has one is never accepted by code (it goes to the model). */
export const OTHER_COUNTRY_WORDS = [
  "السعودية", "سعودي", "الكويت", "الإمارات", "قطر", "البحرين", "عمان", "الأردن", "لبنان", "العراق", "سوريا", "المغرب", "الجزائر", "تونس", "ليبيا", "السودان", "فلسطين", "اليمن",
  "saudi", "kuwait", "emirates", "uae", "qatar", "jordan", "lebanon", "iraq", "morocco", "algeria", "tunisia", "libya", "sudan", "palestine", "yemen",
];

const containsPhrase = (normalizedText: string, phrase: string): boolean => {
  const needle = normalizeText(phrase);
  return needle.length > 0 && ` ${normalizedText} `.includes(` ${needle} `);
};
const containsStemWord = (text: string, words: string[]): string | null => {
  const present = contentStems(text);
  return words.find((word) => normalizeText(word).split(" ").filter(Boolean).every((token) => present.has(stemToken(token)))) ?? null;
};

export interface StrongSignal { accept: boolean; tier: "A" | "B" | "C" | null; signals: string[] }

/**
 * A text the code may accept WITHOUT a model call: it has a word of the topic AND a geographic proof of the requested country (tier A: the country's
 * name or demonym, a governorate or a city), or, for a sports topic, a club or player of that country (tier B); tier C (two dialect markers) exists but
 * is off unless `allowDialectTier`. A text that names another country is never accepted here, whatever else it has.
 */
export function strongSignal(text: string, options: { query: string; region: string; sports?: boolean; allowDialectTier?: boolean }): StrongSignal {
  const normalized = normalizeText(String(text ?? ""));
  const stems = topicStems(options.query);
  const none: StrongSignal = { accept: false, tier: null, signals: [] };
  if (stems.length === 0 || !hasTopicEvidence(stems, normalized)) return none;
  if (containsStemWord(normalized, OTHER_COUNTRY_WORDS)) return none;
  const signals: string[] = [];
  if (hasRegionEvidence(options.region, normalized)) signals.push("country");
  const place = EGYPT_PLACES.find((name) => containsPhrase(normalized, name));
  if (place) signals.push(`place:${normalizeText(place)}`);
  if (signals.length > 0) return { accept: true, tier: "A", signals };
  if (options.sports) {
    const named = EGYPT_CLUBS_AND_PEOPLE.find((name) => containsPhrase(normalized, name));
    if (named) return { accept: true, tier: "B", signals: [`named:${normalizeText(named)}`] };
  }
  if (options.allowDialectTier) {
    const markers = EGYPT_DIALECT_MARKERS.filter((word) => containsPhrase(normalized, word));
    if (markers.length >= 2) return { accept: true, tier: "C", signals: markers.map((word) => `dialect:${word}`) };
  }
  return none;
}
