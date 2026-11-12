import { createHash } from "node:crypto";
import { isServedPlatform, numbersWritten, RESEARCH_BRIEF_VERSION, type BriefContent, type BriefObjective, type BriefPlatform, type ResearchBrief } from "./researchBrief";
import { buildRequestContract, type WantedField } from "./requestContract";
import { districtLabelsIn, placesInText } from "./places";
import { buildAsk } from "./foundation/ask";

/**
 * MULTI-OBJECTIVE RESEARCH (docs/MULTI-OBJECTIVE-RESEARCH.md). ONE customer research brief, several research objectives, executed by the EXISTING plans:
 *
 *   - Each FIRST objective of the brief (parent null) with the objectives that hang on it is one PART: the TikTok comments of a topic, the hotels of a city with their reviews, the news of a topic with their text, the companies of a sector with their
 *     official contacts and people. A part is exactly what one existing mission already plans, prices and executes (the social compiler for social data, the model planner for the rest); a plan never mixes the two engines, and nothing
 *     here composes plans, prices or holds.
 *   - Each part becomes its OWN mission, created in the same chat turn from the part's own validated sentence, shown on its OWN card with its own scope and price, approved by its OWN «اعتمد» button and executed and settled by the existing
 *     code. One approval never covers another part. The customer never restates the request: the parts come from the brief they already gave.
 *   - The group (which parts exist, their sentences, their missions, and what happened to the parts that could not be prepared) is stored with the cards of that turn, so a correction changes only the part it concerns.
 * Pure (no database, no network, no clock).
 */
export const RESEARCH_GROUP_VERSION = 1 as const;
/**
 * At most this many NEW missions are created for the parts of one request in ONE turn (the open-missions limit of the worker applies on top). Every part is judged and stored whatever their number (the brief carries at most
 * OBJECTIVES_MAX objectives, so at most that many parts): a part beyond it, or one a limit refuses, is stored «waiting» and prepared on a later turn («كمّل»), never dropped.
 */
export const RESEARCH_GROUP_MAX_PARTS = 6;

export interface ResearchPart {
  /** The id of the part's first objective. */
  key: string;
  /** The first objective and every objective hanging on it, in the brief's order. */
  objectives: BriefObjective[];
  /** The part's own request sentence, as the model wrote it (validated later), or null. */
  request: string | null;
  /** The part asks for something no operation or served platform does (said honestly, never executed). */
  unresolved: boolean;
}

/** The parts of a brief (one per first objective, in order). A brief with no objectives has none. */
export function partsOf(brief: Pick<ResearchBrief, "objectives"> & { request?: string }): ResearchPart[] {
  const objectives = brief.objectives ?? [];
  const roots = objectives.filter((o) => o.parent === null);
  return roots.map((root) => {
    const ids = new Set([root.id]);
    const members: BriefObjective[] = [root];
    for (const o of objectives) if (o.parent !== null && ids.has(o.parent)) { ids.add(o.id); members.push(o); }
    const unresolved = members.every((o) => o.operation === "unsupported") || (root.operation.startsWith("social.") && !isServedPlatform(root.platform));
    // the part's sentence: the one written on its DEEPEST objective that has one (what the part delivers: «٣٠٠ تعليق من تيك توك عن …», not the intermediate «فيديوهات تيك توك عن …»; live evaluation 2026-11-12, J1), else its first
    // objective's; a request with ONE part: the whole request when the model wrote none for it
    // (when the part has a number of its own, the deepest sentence that CARRIES that number)
    const withText = [...members].reverse().filter((o) => typeof o.request === "string" && o.request.trim() !== "");
    const counted = members.find((o) => o.count !== undefined && o.count !== null)?.count ?? null;
    const written = (counted !== null ? withText.find((o) => numbersWritten(o.request!).has(counted)) : undefined)?.request ?? withText[0]?.request ?? null;
    return { key: root.id, objectives: members, request: written ?? (roots.length === 1 && brief.request ? brief.request : null), unresolved };
  });
}

/**
 * A PART'S SENTENCE SAYS EVERYTHING ITS OBJECTIVES COLLECT (live evaluation 2026-11-12: the real model often writes the part's sentence for its FIRST step only, «منشورات تيك توك عن السياحة», while its objectives collect the comments;
 * the sentence was then rejected as dropping the comments, and a card would have read less than the part collects). The child steps the model's own objectives name (comments, replies, reviews, official e-mails and phones) are added
 * to the sentence in fixed words when the sentence does not say them already. Nothing the objectives do not carry is ever added; the sentence is then validated like any other (privacy, numbers, platforms, consistency).
 */
export function completedPartSentence(request: string, objectives: ReadonlyArray<BriefObjective>): string {
  const has = (re: RegExp) => re.test(request);
  const ops = new Set(objectives.map((o) => o.operation));
  const social = objectives.find((o) => o.platform !== null);
  const add: string[] = [];
  if (ops.has("social.comments") && social?.platform !== "x" && !has(/تعليق|كومنت|comment/i)) add.push("والتعليقات عليها");
  if (ops.has("social.replies") && !has(/(?:^|[^ء-ي])(?:و|ب|ال)*ردود|الرد على|replies/i)) add.push(social?.platform === "x" ? "والردود عليها" : "والردود على التعليقات");
  if (ops.has("places.reviews") && !has(/تقييم|مراجع|ريفيو|review/i)) add.push("وتقييماتها");
  const contacts = new Set(objectives.filter((o) => o.operation === "company.contacts").flatMap((o) => o.contacts));
  if (contacts.has("email") && !has(/[إا]يميل|بريد|email/i)) add.push("وإيميلاتها الرسمية");
  if (contacts.has("phone") && !has(/تليفون|هاتف|هواتف|phone/i)) add.push("وتليفوناتها الرسمية");
  // the part's own number (the customer's, attributed to this part by the model's objectives) when its sentence writes no number at all (live evaluation round 2, J1: «٣٠٠» only in the count field)
  const count = objectives.find((o) => o.count !== undefined && o.count !== null)?.count ?? null;
  const counted = count !== null && numbersWritten(request).size === 0 ? `، العدد ${String(count).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)])}` : "";
  return add.length === 0 && !counted ? request : `${request.replace(/[.،,\s]+$/u, "")}${add.length > 0 ? ` ${add.join(" ")}` : ""}${counted}`;
}

const CONTENT_OF: Partial<Record<BriefObjective["operation"], BriefContent>> = {
  "social.comments": "comments", "social.replies": "replies", "companies.discover": "companies", "people.discover": "people", "places.discover": "places", "places.reviews": "reviews", "web.search": "articles", "company.contacts": "contacts",
};

/** The brief of ONE part, validated exactly like a brief of its own (`validateBrief`): its sentence, its platforms, what it collects, its number when its sentence writes exactly one, its objectives. Null without a sentence. */
export function partBriefOf(part: ResearchPart, global: { period?: string | null; country?: string | null; language?: string | null } = {}): ResearchBrief | null {
  if (!part.request) return null;
  const sentence = completedPartSentence(part.request, part.objectives);
  // the part's own conditions (its first objective), else those of the whole request: kept as the customer's words, never a value of the model
  const root = part.objectives[0];
  const platforms = [...new Set(part.objectives.map((o) => o.platform).filter((p): p is BriefPlatform => isServedPlatform(p)))].sort();
  const content = [...new Set(part.objectives.map((o) => CONTENT_OF[o.operation]).filter((c): c is BriefContent => c !== undefined))];
  const numbers = [...numbersWritten(sentence)];
  return {
    v: RESEARCH_BRIEF_VERSION, status: "ready", request: sentence, platforms, content, count: root?.count ?? (numbers.length === 1 ? numbers[0] : null), topic: null,
    period: root?.period ?? global.period ?? null, country: root?.country ?? global.country ?? null, language: root?.language ?? global.language ?? null,
    objectives: part.objectives.map((o) => { const { request: _r, ...rest } = o; void _r; return rest; }),
  };
}

/** What became of each part in the turn that prepared it (stored with the cards; every part has one, none is ever dropped). */
export type PartOutcome =
  /** a mission prepares its plan and price (or a kept one of an earlier turn) */
  | "planned"
  /** no capability or served platform can do it: said with an alternative */
  | "unsupported"
  /** the provider that serves it is unavailable now (no key, allowance spent, not permitted to this account) */
  | "unavailable"
  /** its sentence could not be validated (a number or a platform the customer did not write, a dropped content) or the model wrote none: asked */
  | "needs_clarification"
  /** it asks for private personal data: refused */
  | "refused_private"
  /** the open-missions limit (or the hourly one) refused it now: it waits, said, and is prepared on the next turn */
  | "waiting";

export interface StoredGroupPart { key: string; request: string | null; missionId: string | null; outcome: PartOutcome }
export interface StoredResearchGroup { v: typeof RESEARCH_GROUP_VERSION; id: string; brief: ResearchBrief; parts: StoredGroupPart[] }

const OUTCOMES: ReadonlyArray<PartOutcome> = ["planned", "unsupported", "unavailable", "needs_clarification", "refused_private", "waiting"];

/** The group stored with a card (`messages.plan.researchGroup`), read back strictly (null when absent or not ours). The brief inside is NOT trusted by itself: callers re-parse it with the brief schema. */
export function storedGroupOf(plan: unknown, parseBriefStrict: (raw: unknown) => ResearchBrief | null): StoredResearchGroup | null {
  const g = (plan as { researchGroup?: unknown } | null | undefined)?.researchGroup as Record<string, unknown> | undefined;
  if (!g || typeof g !== "object" || g.v !== RESEARCH_GROUP_VERSION || typeof g.id !== "string" || !Array.isArray(g.parts)) return null;
  const brief = parseBriefStrict(g.brief);
  if (!brief) return null;
  const parts: StoredGroupPart[] = [];
  for (const raw of g.parts.slice(0, RESEARCH_GROUP_MAX_PARTS * 2)) {
    const p = raw as Record<string, unknown>;
    if (!p || typeof p.key !== "string" || !OUTCOMES.includes(p.outcome as PartOutcome)) return null;
    const missionId = typeof p.missionId === "string" && /^msn_[a-z0-9]{8,40}$/.test(p.missionId) ? p.missionId : null;
    parts.push({ key: p.key, request: typeof p.request === "string" ? p.request : null, missionId, outcome: p.outcome as PartOutcome });
  }
  return { v: RESEARCH_GROUP_VERSION, id: g.id, brief, parts };
}

const norm = (t: string | null | undefined): string => String(t ?? "").replace(/[\s،,.؟?!]+/g, " ").trim();

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// IDEMPOTENCY (docs/MULTI-OBJECTIVE-RESEARCH.md section 8): the id of a part's mission and of its card are derived from what they are, so a retried turn, a turn whose writes partly failed, or two turns of the same request at
// the same moment meet the SAME rows: the primary key refuses the second insert and the second turn adopts the first one's mission and card instead of creating its own. No schema change (both ids are the existing primary keys).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
/** How many ids one part may try: a part withdrawn or finished earlier moves to the next attempt; the first attempt that is free or still live is used. */
export const PART_ID_ATTEMPTS = 8;
/** The mission id of one part of this customer's request in this conversation, at attempt `n` (`msn_` and 20 hex: the form of a random mission id). */
export function partMissionIdOf(userId: string, conversationId: string, request: string, n: number): string {
  return `msn_${sha(`part-mission|v1|${userId}|${conversationId}|${norm(request)}|${n}`).slice(0, 20)}`;
}
/** The id of the assistant message that carries a part's card (one card per mission: a second write of the same card is refused by the primary key). */
export function partCardIdOf(missionId: string): string {
  const h = sha(`part-card|v1|${missionId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE CUSTOMER'S INTENT ACROSS THE SPLIT (docs/MULTI-OBJECTIVE-RESEARCH.md section 9). The model writes each part's sentence; the code checks, with the SAME trusted readers every request already goes through (the request
// contract with the semantic flag off, the places list, the numbers written), that the split neither invents a requirement the customer never wrote nor drops one of the whole request. No new vocabulary: a check can only
// ASK, never refuse, reduce or change a request.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type IntentRequirement =
  | { kind: "period" } | { kind: "language" } | { kind: "country" } | { kind: "place"; key: string; labelAr: string } | { kind: "field"; field: WantedField } | { kind: "number"; n: number } | { kind: "replies" };

const FIELD_AR: Record<WantedField, string> = { posted_at: "تاريخ النشر", author: "اسم الحساب", views: "عدد المشاهدات", likes: "عدد الإعجابات" };
const AR_D = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
/** The customer-facing name of a requirement (Arabic). */
export function requirementLabelAr(r: IntentRequirement): string {
  switch (r.kind) {
    case "period": return "الفترة الزمنية";
    case "language": return "لغة المحتوى";
    case "country": return "الدولة";
    case "place": return r.labelAr;
    case "field": return FIELD_AR[r.field];
    case "replies": return "الردود";
    case "number": return `العدد ${String(r.n).replace(/\d/g, (d) => AR_D[Number(d)])}`;
  }
}

interface Reading { period: boolean; language: boolean; country: boolean; replies: boolean; places: Set<string>; fields: Set<WantedField>; numbers: Set<number> }
function readingOf(texts: ReadonlyArray<string>): Reading {
  const out: Reading = { period: false, language: false, country: false, replies: false, places: new Set(), fields: new Set(), numbers: new Set() };
  for (const t of texts) {
    if (!t || !t.trim()) continue;
    const c = buildRequestContract(t);
    out.period ||= c.period; out.language ||= c.language; out.country ||= c.country; out.replies ||= c.replies !== "none";
    for (const f of c.wants ?? []) out.fields.add(f);
    for (const e of placesInText(t)) { out.places.add(e.key); out.places.add(e.country); }
    for (const n of numbersWritten(t)) out.numbers.add(n);
  }
  return out;
}

/**
 * What a part's sentence states that the customer never wrote (a period, a content language, a place, a field of the rows): read in the part, not read in anything the customer typed (each turn, and the request already
 * grounded on an earlier turn). Numbers are already checked by `validateBrief`. Null: nothing invented.
 */
export function inventedRequirementOf(partRequest: string, groundTexts: ReadonlyArray<string>): IntentRequirement | null {
  const part = readingOf([partRequest]);
  const ground = readingOf(groundTexts);
  if (part.period && !ground.period) return { kind: "period" };
  if (part.language && !ground.language) return { kind: "language" };
  for (const e of placesInText(partRequest)) if (!ground.places.has(e.key)) return { kind: "place", key: e.key, labelAr: e.labelAr };
  for (const f of part.fields) if (!ground.fields.has(f)) return { kind: "field", field: f };
  return null;
}

/**
 * What the WHOLE request states that no part's sentence carries (a period, a content language, a country, a city, a field of the rows, a number): the split would silently drop it. `partTexts`: every part's sentence or,
 * for a part with none, what the model understood of it. Empty: nothing dropped.
 */
export function droppedRequirementsOf(wholeRequest: string, partTexts: ReadonlyArray<string>): IntentRequirement[] {
  const whole = readingOf([wholeRequest]);
  const parts = readingOf(partTexts);
  const out: IntentRequirement[] = [];
  if (whole.period && !parts.period) out.push({ kind: "period" });
  if (whole.language && !parts.language) out.push({ kind: "language" });
  const wholePlaces = placesInText(wholeRequest);
  for (const e of wholePlaces) if (!parts.places.has(e.key)) out.push({ kind: "place", key: e.key, labelAr: e.labelAr });
  // a country word with no part naming a country (or a place of the country the whole request names): the list keeps only a city when the text names both, so a part that names that city carries its country
  if (whole.country && !parts.country && !wholePlaces.some((e) => parts.places.has(e.country))) out.push({ kind: "country" });
  for (const f of whole.fields) if (!parts.fields.has(f)) out.push({ kind: "field", field: f });
  for (const n of whole.numbers) if (!parts.numbers.has(n)) out.push({ kind: "number", n });
  if (whole.replies && !parts.replies) out.push({ kind: "replies" });
  return out;
}
/** Whether a part of the new brief is the same request as a part prepared before (its sentence, or, read by the trusted parser, the same request). */
export function samePartRequest(a: string | null, b: string | null, sameByParser: (x: string, y: string) => boolean): boolean {
  if (!a || !b) return false;
  return norm(a) === norm(b) || sameByParser(a, b);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// EXACT REQUIREMENTS ACROSS THE SPLIT (docs/MULTI-OBJECTIVE-RESEARCH.md section 12). The checks above see whether a period, a place or a language is STATED; these compare the VALUES, read by the very reader the worker executes with
// (`buildAsk`, foundation/ask.ts, with the semantic flag off as on the chat: the period as Cairo days from the same moment, the country code, the content language) and the places list for cities. The model says, in the same call, which
// of the customer's own words apply to which part (a first objective's `period` / `country` / `language` / `count`; the brief's own fields apply to every part). A part whose sentence would EXECUTE another value than the customer's words,
// lose a condition that applies to it, or carry one the customer gave to another part is asked, never created. Words no reader understands are never refused: they must only be carried as the customer wrote them.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type ConditionKind = "period" | "place" | "language" | "count" | "replies";
export interface ConditionPhrases { period?: string | null; country?: string | null; language?: string | null; count?: number | null }
export interface ConditionDrift { kind: ConditionKind; reason: "contradicts" | "missing" | "other_part"; phrase: string | null; /** the phrase is the MODEL's, not the customer's (never quoted to them as «what you wrote») */ invented?: boolean }

/** Letters and digits only, with the spellings of one letter made one (أ/إ/آ → ا, ى → ي, ة → ه, Arabic-Indic digits → 0-9): for «the customer's own words are carried», never a list of words. */
export function normWords(t: string | null | undefined): string {
  return ` ${String(t ?? "").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase()} `;
}
const carries = (text: string, phrase: string): boolean => normWords(phrase).trim() !== "" && normWords(text).includes(normWords(phrase));

/** «آخر الأخبار», «أحدث المقالات»: the recency of news, not a time window (live evaluation rounds 3 and 5, J1 and I1: asked as a missing «period»). Only these words: anything else stays a condition to carry. */
function recencyOfNews(phrase: string): boolean {
  const words = normWords(phrase).trim().split(" ").filter(Boolean);
  return words.length > 0 && words.every((w) => /^(?:و)?(?:ال)?(?:اخر|احدث|جديد|جديده|الجديده|اخبار|خبر|مقالات|مقال|تقارير|news|latest)$/.test(w));
}

/** The executed value of one condition of a text, as the worker reads it (null: the text states none the reader understands). */
function valueOf(kind: "period" | "language", text: string, nowMs: number): string | null {
  const a = buildAsk(text, null, nowMs, {}, { semantic: false });
  if (kind === "period") return a.period ? `${a.period.from}..${a.period.to}` : null;
  return a.language;
}
const countryCodeOf = (text: string, nowMs: number): string | null => buildAsk(text, null, nowMs, {}, { semantic: false }).country;
const placeKeys = (text: string): Set<string> => { const out = new Set<string>(); for (const e of placesInText(text)) { out.add(e.key); out.add(e.country); } return out; };
const citiesOf = (text: string): string[] => placesInText(text).filter((e) => e.kind === "city").map((e) => e.key);

/** The values the customer's own words give (each turn, and each sentence of a turn: one turn may give one part a month and another a year). */
function customerValues(kind: "period" | "language", texts: ReadonlyArray<string>, nowMs: number): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const piece of [t, ...t.split(/[،,.؛;\n]+/)]) { const v = piece.trim() ? valueOf(kind, piece, nowMs) : null; if (v) out.add(v); }
  return out;
}

/**
 * Whether ONE part's sentence keeps the customer's exact requirements. `own`: the conditions the model attributed to this part; `global`: those of the whole request; `elsewhere`: the kinds the model attributed to OTHER parts only;
 * `customerTexts`: everything the customer typed (and the request already grounded). Null: nothing drifts.
 */
export function conditionDriftOf(input: { partRequest: string; own: ConditionPhrases; global: ConditionPhrases; elsewhere: ReadonlySet<ConditionKind>; customerTexts: ReadonlyArray<string>; nowMs: number; repliesWithoutObjective?: boolean; /** the place words the model attributed to OTHER parts (round 7) */ elsewherePlaces?: ReadonlyArray<string> }): ConditionDrift | null {
  const { partRequest, own, global, elsewhere, customerTexts, nowMs } = input;
  const written = (phrase: string) => customerTexts.some((t) => carries(t, phrase));
  for (const kind of ["period", "language"] as const) {
    let phrase = own[kind] ?? global[kind] ?? null;
    const got = valueOf(kind, partRequest, nowMs);
    // a condition the MODEL wrote in a field (never the customer's words, no value their words give) that the sentence does not execute is not the customer's requirement: it is ignored, never asked as if they wrote it (live evaluation
    // 2026-11-12, I1: language «العربية» the customer never wrote); one the sentence DOES execute is checked below like any value the customer never gave
    if (phrase && !written(phrase)) {
      const want0 = valueOf(kind, phrase, nowMs);
      if (want0 === null || !customerValues(kind, customerTexts, nowMs).has(want0)) phrase = null;
    }
    if (phrase) {
      const want = valueOf(kind, phrase, nowMs);
      // words the reader does not understand: carried as the customer wrote them, never refused
      // words no reader executes («آخر أخبار» is «the latest news», not a window): the part's OWN words must be carried as written; the same words attributed to the whole request are not a condition imposed on every part (live evaluation
      // round 3, J1: the TikTok and hotels parts were asked whether «آخر أخبار» applied to them)
      if (want === null) { if (own[kind] && written(phrase) && !recencyOfNews(phrase) && !carries(partRequest, phrase)) return { kind, reason: "missing", phrase }; continue; }
      if (got === null) return { kind, reason: "missing", phrase };
      if (got !== want) return { kind, reason: "contradicts", phrase };
      continue;
    }
    if (got === null) continue;
    if (elsewhere.has(kind)) return { kind, reason: "other_part", phrase: null };
    if (!customerValues(kind, customerTexts, nowMs).has(got)) return { kind, reason: "contradicts", phrase: null, invented: true };
  }
  // the place: the cities and the country the customer's words for this part name must be the part's (never another, never wider or narrower)
  let where = own.country ?? global.country ?? null;
  if (where && !written(where)) {
    // a place the MODEL wrote in a field: the country of a city the customer named («الإسكندرية» → «مصر», live evaluation C2 and G1), or one the sentence does not carry, is not a requirement of the customer's (ignored); a place
    // the sentence DOES carry and the customer never named is asked as the model's, never quoted as theirs
    const customerPlaces = new Set(customerTexts.flatMap((t) => [...placeKeys(t)]));
    const wantKeys = placeKeys(where);
    const implied = wantKeys.size > 0 && [...wantKeys].every((k) => customerPlaces.has(k));
    const carried = [...wantKeys].some((k) => placeKeys(partRequest).has(k)) || carries(partRequest, where);
    if (implied || !carried) where = null;
    else return { kind: "place", reason: "contradicts", phrase: where, invented: true };
  }
  if (where) {
    const wantKeys = placeKeys(where);
    const gotKeys = placeKeys(partRequest);
    if (wantKeys.size === 0) { if (written(where) && !carries(partRequest, where)) return { kind: "place", reason: "missing", phrase: where }; }
    else {
      for (const k of wantKeys) if (!gotKeys.has(k)) return { kind: "place", reason: gotKeys.size > 0 ? "contradicts" : "missing", phrase: where };
      // a city the sentence names must be the attributed place's, unless the CUSTOMER named that very city and it lies in the attributed country (the country was attributed, the customer's own city kept)
      const customerPlaces = new Set(customerTexts.flatMap((t) => [...placeKeys(t)]));
      for (const c of citiesOf(partRequest)) if (!wantKeys.has(c) && !(customerPlaces.has(c) && wantKeys.has(c.split(":")[0]))) return { kind: "place", reason: "contradicts", phrase: where };
      const wantCode = countryCodeOf(where, nowMs) ?? countryCodeOf(`في ${where}`, nowMs);
      const gotCode = countryCodeOf(partRequest, nowMs);
      if (wantCode && gotCode && wantCode !== gotCode) return { kind: "place", reason: "contradicts", phrase: where };
    }
  } else if (elsewhere.has("place") && citiesOf(partRequest).length > 0) {
    // a city of this sentence is «another part's» only when it IS a place attributed to another part, or the customer never wrote it (live evaluation round 7, J1: the hotels' «الغردقة» was asked because the news part's place was «مصر»)
    const others = input.elsewherePlaces ? new Set(input.elsewherePlaces.flatMap((w) => [...placeKeys(w)].filter((k) => k.includes(":")))) : null;
    const customerPlaces = new Set(customerTexts.flatMap((t) => [...placeKeys(t)]));
    if (others === null || citiesOf(partRequest).some((c) => others.has(c) || !customerPlaces.has(c))) return { kind: "place", reason: "other_part", phrase: null };
  }
  // the number the customer wrote for this part (a number they never wrote is already refused by the brief's check)
  if (own.count !== null && own.count !== undefined) {
    const nums = numbersWritten(partRequest);
    if (!nums.has(own.count)) return { kind: "count", reason: nums.size > 0 ? "contradicts" : "missing", phrase: String(own.count) };
  }
  // the sentence asks the replies the part's objectives never collect: they would be silently lost
  if (input.repliesWithoutObjective) return { kind: "replies", reason: "missing", phrase: null };
  return null;
}

/** Whether two sentences EXECUTE the same conditions (period window, country, content language, places, numbers), read as the worker reads them: a corrected value («آخر شهر» → «آخر أسبوع») is never the same part. */
export function sameExecutedValues(a: string, b: string, nowMs: number): boolean {
  const key = (s: Set<string> | Set<number>) => JSON.stringify([...s].map(String).sort());
  return sameExecutedConditions(a, b, nowMs) && key(numbersWritten(a)) === key(numbersWritten(b));
}

/** The executed conditions of a sentence (period window, country code, content language, places), as the worker reads them. */
function conditionsOf(t: string, nowMs: number) {
  const x = buildAsk(t, null, nowMs, {}, { semantic: false });
  return { period: x.period ? `${x.period.from}..${x.period.to}` : null, country: x.country, language: x.language, places: [...placeKeys(t)].sort(), districts: districtLabelsIn(t) };
}
/** The same, without the numbers (a count is compared elsewhere, by the code that edits a plan's count). */
export function sameExecutedConditions(a: string, b: string, nowMs: number): boolean {
  return JSON.stringify(conditionsOf(a, nowMs)) === JSON.stringify(conditionsOf(b, nowMs));
}
/** Whether `b` CHANGES a condition `a` already states (a period, a country, a language or the places, present in both with another value): a correction, never an addition. */
export function conditionChanged(a: string, b: string, nowMs: number): boolean {
  const x = conditionsOf(a, nowMs);
  const y = conditionsOf(b, nowMs);
  return (x.period !== null && y.period !== null && x.period !== y.period) || (x.country !== null && y.country !== null && x.country !== y.country)
    || (x.language !== null && y.language !== null && x.language !== y.language) || (x.places.length > 0 && y.places.length > 0 && JSON.stringify(x.places) !== JSON.stringify(y.places))
    || (x.districts.length > 0 && y.districts.length > 0 && JSON.stringify(x.districts) !== JSON.stringify(y.districts));
}

/**
 * The brief's CONDITION FIELDS kept only when they are the customer's (their own words, a value their words give, or the country of a place they named): a period, a country or a language the model filled in by itself is cleared before
 * the brief is stored or shown to the model again (BRIEF_SO_FAR), so it never becomes «what the customer said». The sentences are untouched (what they execute is checked by `conditionDriftOf`).
 */
export function groundedConditions<T extends ConditionPhrases>(fields: T, customerTexts: ReadonlyArray<string>, nowMs: number): T {
  const written = (phrase: string) => customerTexts.some((t) => carries(t, phrase));
  const out = { ...fields };
  for (const kind of ["period", "language"] as const) {
    const phrase = out[kind];
    if (!phrase || written(phrase)) continue;
    const v = valueOf(kind, phrase, nowMs);
    if (v === null || !customerValues(kind, customerTexts, nowMs).has(v)) out[kind] = null;
  }
  const where = out.country;
  if (where && !written(where)) {
    const customerPlaces = new Set(customerTexts.flatMap((t) => [...placeKeys(t)]));
    const keys = placeKeys(where);
    if (!(keys.size > 0 && [...keys].every((k) => customerPlaces.has(k)))) out.country = null;
  }
  return out;
}

/**
 * The dropped requirements no part being ASKED accounts for: a part asked because it states the same kind of requirement differently (a number, a period, a place…) is where the customer's own value goes once answered, so the other parts
 * need not wait for it. What remains is asked for the whole request.
 */
export function unaccountedRequirements(lost: IntentRequirement[], askedTexts: ReadonlyArray<string>): IntentRequirement[] {
  if (askedTexts.length === 0) return lost;
  const asked = readingOf(askedTexts);
  return lost.filter((r) => {
    switch (r.kind) {
      case "number": return asked.numbers.size === 0;
      case "period": return !asked.period;
      case "language": return !asked.language;
      case "country": return !asked.country && asked.places.size === 0;
      case "place": return asked.places.size === 0;
      case "field": return asked.fields.size === 0;
      case "replies": return !asked.replies;
    }
  });
}
