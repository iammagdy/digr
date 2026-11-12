import { createHash } from "node:crypto";
import { isServedPlatform, numbersWritten, RESEARCH_BRIEF_VERSION, type BriefContent, type BriefObjective, type BriefPlatform, type ResearchBrief } from "./researchBrief";
import { buildRequestContract, type WantedField } from "./requestContract";
import { placesInText } from "./places";

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
    // a request with ONE part: that part's sentence is the whole request when the model wrote none for it
    return { key: root.id, objectives: members, request: root.request ?? (roots.length === 1 && brief.request ? brief.request : null), unresolved };
  });
}

const CONTENT_OF: Partial<Record<BriefObjective["operation"], BriefContent>> = {
  "social.comments": "comments", "social.replies": "replies", "companies.discover": "companies", "people.discover": "people", "places.discover": "places", "places.reviews": "reviews",
};

/** The brief of ONE part, validated exactly like a brief of its own (`validateBrief`): its sentence, its platforms, what it collects, its number when its sentence writes exactly one, its objectives. Null without a sentence. */
export function partBriefOf(part: ResearchPart): ResearchBrief | null {
  if (!part.request) return null;
  const platforms = [...new Set(part.objectives.map((o) => o.platform).filter((p): p is BriefPlatform => isServedPlatform(p)))].sort();
  const content = [...new Set(part.objectives.map((o) => CONTENT_OF[o.operation]).filter((c): c is BriefContent => c !== undefined))];
  const numbers = [...numbersWritten(part.request)];
  return {
    v: RESEARCH_BRIEF_VERSION, status: "ready", request: part.request, platforms, content, count: numbers.length === 1 ? numbers[0] : null, topic: null, period: null, country: null, language: null,
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
  | { kind: "period" } | { kind: "language" } | { kind: "country" } | { kind: "place"; key: string; labelAr: string } | { kind: "field"; field: WantedField } | { kind: "number"; n: number };

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
    case "number": return `العدد ${String(r.n).replace(/\d/g, (d) => AR_D[Number(d)])}`;
  }
}

interface Reading { period: boolean; language: boolean; country: boolean; places: Set<string>; fields: Set<WantedField>; numbers: Set<number> }
function readingOf(texts: ReadonlyArray<string>): Reading {
  const out: Reading = { period: false, language: false, country: false, places: new Set(), fields: new Set(), numbers: new Set() };
  for (const t of texts) {
    if (!t || !t.trim()) continue;
    const c = buildRequestContract(t);
    out.period ||= c.period; out.language ||= c.language; out.country ||= c.country;
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
  return out;
}
/** Whether a part of the new brief is the same request as a part prepared before (its sentence, or, read by the trusted parser, the same request). */
export function samePartRequest(a: string | null, b: string | null, sameByParser: (x: string, y: string) => boolean): boolean {
  if (!a || !b) return false;
  return norm(a) === norm(b) || sameByParser(a, b);
}
