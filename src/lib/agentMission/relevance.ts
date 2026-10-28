import { checkCustomerText } from "./text";

/**
 * RELEVANCE BEFORE DELIVERY AND CHARGE, in code. A request about a person, an entity or a topic gets only the rows that are ABOUT it. The agent states, in its plan, what it understood (`subject_ar`) and how to
 * recognise it in a row (`terms`, `context_terms`, `exclude_terms`); this module applies that to every row BEFORE it is saved, so a row that does not match is neither delivered nor charged:
 *
 *   1. the text of the row (the columns named in `text_columns`; never the author's name) must contain one of the `terms`, as a whole word (an Arabic prefix like «ال» or «ل» is allowed): a row that matched only
 *      because its AUTHOR's name contains the name has no term in its text and is excluded («no_term»);
 *   2. what is left of the text after removing links, @mentions and the terms themselves must have at least `min_own_words` words: an empty reply or a bare mention is excluded («mention_only»);
 *   3. a row with one of the `exclude_terms` (the markers of another person who has the same name) is excluded («other_person»);
 *   4. when `context_terms` are given (the words that confirm the intended meaning, for a footballer: the club, the national team, goals...), a row that has a term but none of them is UNCERTAIN: it goes to a model
 *      review within the mission's review budget, and is not delivered if it is not reviewed.
 * Everything else is a match. Pure: no I/O.
 */
export interface RelevanceSpec {
  /** What the agent understood the customer wants, in plain Arabic («محمد صلاح لاعب كرة القدم»): shown on the plan card and used by the reviewer. */
  subject_ar: string;
  /** Names or phrases (Arabic or Latin) that identify the subject in the text of a row. */
  terms: string[];
  context_terms?: string[];
  exclude_terms?: string[];
  /** Keys of the row (the stage's columns) that hold the text to read. */
  text_columns: string[];
  /** Words (of at least two letters) that must remain after removing links, mentions and the terms. Default 2. */
  min_own_words?: number;
  /** Uncertain rows go to the model review (default true); false: uncertain rows are never delivered. */
  review?: boolean;
  /**
   * Default true: a row whose text has the subject's FULL NAME (a term of two words or more) is accepted by rule, with or without a context word: the full name is strong evidence, and the cost of sending every such row to
   * the model is what threw good rows away in the live run of 2026-10-28. Set false when the full name is itself common (a very common person's name, a generic company name): then a context word is required and the rest goes
   * to the review.
   */
  full_name_is_enough?: boolean;
}

export type RelevanceReason = "no_text" | "no_term" | "mention_only" | "other_person" | "uncertain" | "not_reviewed" | "review_no" | "review_failed";
export type RelevanceVerdict = { verdict: "match" } | { verdict: "exclude"; reason: RelevanceReason } | { verdict: "review"; reason: "uncertain" };
/** WHY a row was accepted by rule (the report of the check counts them): the full name and a context word, the full name alone, a term and a context word, or no context was asked for. */
export type RuleBasis = "full_name_context" | "full_name" | "terms_context" | "terms_only";
export type DetailedVerdict = RelevanceVerdict & { basis?: RuleBasis };

export const MAX_TERMS = 12;
export const MAX_CONTEXT_TERMS = 40;
export const MAX_EXCLUDE_TERMS = 40;
export const DEFAULT_MIN_OWN_WORDS = 2;

const ARABIC_DIGITS = /[٠-٩]/g;
const DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g;

/** Arabic and Latin text in one comparable form: no diacritics or tatweel, one form of alef, ya and ta marbuta, ASCII digits, lower case, one space. */
export function normalizeText(input: unknown): string {
  return String(input ?? "")
    .normalize("NFKC")
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LETTER = "\\p{L}\\p{N}";

/** A regex for one term: whole word, any of ' ', '_' or '-' between its words (hashtags), an Arabic prefix allowed in front. */
export function termRegex(term: string, flags = "u", options: { suffixes?: boolean } = {}): RegExp | null {
  const t = normalizeText(term).replace(/[_-]+/g, " ");
  if (t.length < 2) return null;
  const body = t.split(" ").filter(Boolean).map(escapeRe).join("[\\s_\\-]+");
  // a CONTEXT word confirms a meaning, so it may carry up to three letters of Arabic ending («هدف» in «هدفًا» «هدفين» «هدفه»); a NAME may not (a word that merely starts with the name is another word)
  const tail = options.suffixes ? `[\\p{L}]{0,3}` : "";
  return new RegExp(`(?<![${LETTER}])(?:ال|لل|و|ف|ب|ل|ك|وال|بال|لل)?${body}${tail}(?![${LETTER}])`, flags);
}

const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const MENTION_RE = /(^|[\s(\[{"'«])@[\p{L}\p{N}_.]+/gu;

/** The text with links and @mentions removed (a handle is an account, not words). */
export function stripLinksAndMentions(text: string): string {
  return text.replace(URL_RE, " ").replace(MENTION_RE, "$1 ").replace(/\s+/g, " ").trim();
}

const matchers = new WeakMap<RelevanceSpec, { terms: RegExp[]; context: RegExp[]; exclude: RegExp[] }>();
function compiled(spec: RelevanceSpec) {
  let m = matchers.get(spec);
  if (!m) {
    const build = (list: string[] | undefined, suffixes = false) => (list ?? []).map((t) => termRegex(t, "u", { suffixes })).filter((r): r is RegExp => r !== null);
    m = { terms: build(spec.terms), context: build(spec.context_terms, true), exclude: build(spec.exclude_terms) };
    matchers.set(spec, m);
  }
  return m;
}

const textOf = (row: Record<string, unknown>, keys: string[]): string => keys.map((k) => (row[k] === null || row[k] === undefined ? "" : typeof row[k] === "object" ? JSON.stringify(row[k]) : String(row[k]))).join(" \n ");

/** The words of a normalized term: «محمد صلاح» has two. A term of two words or more is a FULL NAME (strong evidence); a single word is weak (it may be a surname, a common word, a brand that is also a thing). */
const wordsOfTerm = (term: string): number => normalizeText(term).replace(/[_-]+/g, " ").split(" ").filter(Boolean).length;

const strongRegexes = new WeakMap<RelevanceSpec, RegExp[]>();
function strongTerms(spec: RelevanceSpec): RegExp[] {
  let list = strongRegexes.get(spec);
  if (!list) {
    list = spec.terms.filter((t) => wordsOfTerm(t) >= 2).map((t) => termRegex(t, "u")).filter((r): r is RegExp => r !== null);
    strongRegexes.set(spec, list);
  }
  return list;
}

/** The deterministic verdict on one row, with the basis of an acceptance (why the rule accepted it). */
export function classifyRowDetailed(spec: RelevanceSpec, row: Record<string, unknown>): DetailedVerdict {
  const { terms, context, exclude } = compiled(spec);
  const raw = textOf(row, spec.text_columns).trim();
  if (!raw) return { verdict: "exclude", reason: "no_text" };
  // a @handle is an account: the name inside it is not the subject being written about
  const text = normalizeText(stripLinksAndMentions(raw));
  if (!text) return { verdict: "exclude", reason: "no_text" };
  if (!terms.some((r) => r.test(text))) return { verdict: "exclude", reason: "no_term" };
  // what the author says beyond the name itself
  let rest = text;
  for (const r of terms) rest = rest.replace(new RegExp(r.source, "gu"), " ");
  const words = rest.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => [...w].length >= 2);
  if (words.length < (spec.min_own_words ?? DEFAULT_MIN_OWN_WORDS)) return { verdict: "exclude", reason: "mention_only" };
  if (exclude.some((r) => r.test(text))) return { verdict: "exclude", reason: "other_person" };
  const fullName = strongTerms(spec).some((r) => r.test(text));
  if (context.length === 0) return { verdict: "match", basis: fullName ? "full_name" : "terms_only" };
  if (context.some((r) => r.test(text))) return { verdict: "match", basis: fullName ? "full_name_context" : "terms_context" };
  // the full name alone is strong evidence: accepted by rule unless the plan says the full name is itself common
  if (fullName && spec.full_name_is_enough !== false) return { verdict: "match", basis: "full_name" };
  return { verdict: "review", reason: "uncertain" };
}

/** The deterministic verdict on one row. */
export function classifyRow(spec: RelevanceSpec, row: Record<string, unknown>): RelevanceVerdict {
  const { basis: _basis, ...verdict } = classifyRowDetailed(spec, row);
  void _basis;
  return verdict as RelevanceVerdict;
}

export interface RelevanceCounts { examined: number; match: number; review: number; excluded: Record<string, number> }

/** The deterministic verdicts of a set of rows (the planning sample, or a page of final rows). */
export function classifyRows(spec: RelevanceSpec, rows: ReadonlyArray<Record<string, unknown>>): { verdicts: RelevanceVerdict[]; counts: RelevanceCounts } {
  const counts: RelevanceCounts = { examined: rows.length, match: 0, review: 0, excluded: {} };
  const verdicts = rows.map((row) => {
    const v = classifyRow(spec, row);
    if (v.verdict === "match") counts.match += 1;
    else if (v.verdict === "review") counts.review += 1;
    else counts.excluded[v.reason] = (counts.excluded[v.reason] ?? 0) + 1;
    return v;
  });
  return { verdicts, counts };
}

const cleanList = (raw: unknown, max: number, minLen: number): string[] | null => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const x of raw) { const t = String(x ?? "").replace(/\s+/g, " ").trim(); if (t.length >= minLen && t.length <= 60 && !out.includes(t)) out.push(t); }
  return out.length > max ? null : out;
};

/** The spec as the agent proposed it, checked and cleaned; `issues` are what it must fix. `columnKeys` are the keys of the stage's columns. */
export function validateRelevanceSpec(raw: unknown, columnKeys: readonly string[]): { ok: true; spec: RelevanceSpec } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, issues: ["relevance must be an object"] };
  const o = raw as Record<string, unknown>;
  const subject = checkCustomerText(o.subject_ar, { maxChars: 160 });
  if (subject.issues.length) issues.push(`relevance.subject_ar: ${subject.issues.join("; ")} (one short Arabic phrase: what the customer means, e.g. «محمد صلاح لاعب كرة القدم»)`);
  const terms = cleanList(o.terms, MAX_TERMS, 2);
  if (terms === null || terms.length < 1) issues.push(`relevance.terms: 1 to ${MAX_TERMS} names or phrases that identify the subject in a row's text (spellings in Arabic and Latin)`);
  const context = cleanList(o.context_terms, MAX_CONTEXT_TERMS, 2);
  if (context === null) issues.push(`relevance.context_terms: at most ${MAX_CONTEXT_TERMS} words`);
  const exclude = cleanList(o.exclude_terms, MAX_EXCLUDE_TERMS, 2);
  if (exclude === null) issues.push(`relevance.exclude_terms: at most ${MAX_EXCLUDE_TERMS} words`);
  const cols = Array.isArray(o.text_columns) ? o.text_columns.map(String).filter((k) => columnKeys.includes(k)) : [];
  if (cols.length < 1 || cols.length > 5) issues.push(`relevance.text_columns: 1 to 5 keys of this stage's columns that hold the text to read (the author's name is not one)`);
  const minWords = o.min_own_words === undefined ? DEFAULT_MIN_OWN_WORDS : Number(o.min_own_words);
  if (!Number.isInteger(minWords) || minWords < 0 || minWords > 6) issues.push("relevance.min_own_words: a whole number from 0 to 6");
  if (o.full_name_is_enough !== undefined && typeof o.full_name_is_enough !== "boolean") issues.push("relevance.full_name_is_enough: true or false");
  if (issues.length) return { ok: false, issues };
  return { ok: true, spec: { subject_ar: subject.text, terms: terms!, ...(context && context.length ? { context_terms: context } : {}), ...(exclude && exclude.length ? { exclude_terms: exclude } : {}), text_columns: cols, min_own_words: minWords, review: o.review === false ? false : true, ...(o.full_name_is_enough === false ? { full_name_is_enough: false } : {}) } };
}

/** The free-text search a call made, or null when it asked for a known account / page / link instead (rows of those are about their owner by construction). */
export function searchQueryOf(params: Record<string, unknown> | null | undefined): string | null {
  for (const [k, v] of Object.entries(params ?? {})) {
    if (k.startsWith("_") || typeof v !== "string") continue;
    if (!/^(query|q|keyword|keywords|search|search_query|searchquery|text|topic|term|hashtag|phrase)$/i.test(k)) continue;
    const t = v.trim();
    if (t.length < 2) continue;
    if (/^(from|to|user|url):/i.test(t)) continue;
    return t;
  }
  return null;
}

/** Customer words for a reason a row was left out (the review sheet). */
export const REASON_AR: Record<RelevanceReason, string> = {
  no_text: "لا نص في الصف",
  no_term: "لا يذكر الموضوع في نصه (ظهر لأن اسم صاحب الحساب يشبهه)",
  mention_only: "إشارة عابرة أو رد فارغ بلا كلام",
  other_person: "عن شخص آخر يحمل الاسم نفسه",
  uncertain: "لم يتأكد أنه عن المقصود",
  not_reviewed: "لم يُراجَع (حد المراجعة لهذه المهمة)",
  review_no: "رُفض عند المراجعة: ليس عن المقصود",
  review_failed: "تعذّرت مراجعته (لم يُراجَع)",
};
