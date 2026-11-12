import { normalizeDigits, toArabicDigits } from "../arabicDigits";
import { NUMBER_WORDS_SRC, numberOfWord } from "./arabicNumberWords";
import { contactAskVerdict, contactClarifyAr, privacyRefusalAr } from "./guardRules";
import { buildRequestContract, platformsNamedIn, type RequestContract } from "./requestContract";

/**
 * THE RESEARCH BRIEF (consolidated mission, docs/AGENT-UNDERSTANDING-V1.md). The chat model leads the discovery conversation and, in the SAME call that already names the type of every message (no extra call), proposes a structured,
 * revisable brief of what the customer wants: the whole request in one clear sentence (every turn merged, corrections applied) and the fields it understood.
 *
 * THE MODEL INTERPRETS; THE BACKEND DECIDES. This module is the backend's side, pure (no database, no network, no clock):
 *   - `parseBrief`: a strict, versioned schema. Only the fields below are kept; their types and values are checked; unknown fields are DROPPED (named in `unknown`, never executed).
 *   - `validateBrief`: what may become a mission. The consolidated request
 *       1. is refused or clarified by the SAME privacy rules as a typed message (guardRules.ts): a private component never enters a request, whatever the model wrote;
 *       2. carries no NUMBER the customer did not write (a quantity, a year, a day): the model cannot invent or change a count;
 *       3. names no PLATFORM the customer (or the question they answered) did not name;
 *       4. says, when read by the TRUSTED contract parser (the one the worker plans from), what the model says it understood: the platforms, the count, comments and replies. If the words the worker will read would silently drop or change
 *          something the model understood, the brief is rejected and the conversation falls back to today's path (nothing is guessed).
 * The model never sets a price, a balance, a hold, an approval, a provider or a stage: the request goes through the normal planner, the plan and its price are shown, and only the «اعتمد» button approves.
 * Nothing here stores or logs the customer's words; a rejection is a reason CODE.
 */
export const RESEARCH_BRIEF_VERSION = 1 as const;
export const BRIEF_PLATFORMS = ["tiktok", "x", "instagram", "facebook", "youtube"] as const;
/**
 * What is collected. `articles` (public news, articles and web pages) and `contacts` (the PUBLIC business e-mail or phone of companies) were added after the live evaluation of 2026-11-12 (docs/LIVE-INTELLIGENCE-EVAL.md finding 3): the real
 * model writes them for capabilities the system has (web.search, company.contacts), and without them a correct reading was discarded. Each is checked against the objective that serves it (`objectivesIssue`).
 */
export const BRIEF_CONTENT = ["posts", "videos", "comments", "replies", "tweets", "accounts", "companies", "people", "places", "reviews", "articles", "contacts"] as const;
export const BRIEF_STATUSES = ["ready", "needs_clarification"] as const;
export type BriefPlatform = (typeof BRIEF_PLATFORMS)[number];
export type BriefContent = (typeof BRIEF_CONTENT)[number];
export type BriefStatus = (typeof BRIEF_STATUSES)[number];

/**
 * THE RESEARCH OBJECTIVES (docs/LLM-FIRST-OBJECTIVES.md): the model's structured reading of WHAT the customer wants to research, written in the same one call as the brief. Each objective names the data OPERATION that would serve it (the
 * operations the capability registry knows, `capabilities/registry.ts` OPERATIONS), the platform when it is social data, and the objective it hangs on (comments hang on the posts they are read from). These operations are the system's
 * vocabulary of what can be EXECUTED, not a closed list of what a customer may ask: a goal no operation serves is written as `unsupported` (with the customer's goal in `what`), and the code then asks the customer instead of guessing.
 * The objectives never carry a provider, an endpoint, a price, a number or a field list: the backend finds the capabilities, ranks them and prices the plan.
 */
export const OBJECTIVE_OPERATIONS = ["social.parents", "social.comments", "social.replies", "companies.discover", "company.contacts", "places.discover", "places.reviews", "web.search", "web.read", "people.discover", "unsupported"] as const;
export type ObjectiveOperation = (typeof OBJECTIVE_OPERATIONS)[number];
export const OBJECTIVES_MAX = 8;
export interface BriefObjective {
  /** A short id unique in the brief («o1», «o2» …), used by `parent`. */
  id: string;
  operation: ObjectiveOperation;
  /** Social data: the platform id (one of the five served ones, or the lower-case name of another platform the customer named, e.g. «snapchat»); null for any other operation. */
  platform: string | null;
  /** The objective this one is read from (comments ← posts, replies ← comments, reviews ← places, contacts and people ← companies, page text ← search results), or null for a first objective. */
  parent: string | null;
  /** company.contacts only: which PUBLIC business contacts («email», «phone»). */
  contacts: Array<"email" | "phone">;
  /** The goal in a few words of the customer's language (internal: never executed, never shown as such). */
  what: string | null;
  /**
   * MULTI-OBJECTIVE RESEARCH (docs/MULTI-OBJECTIVE-RESEARCH.md): on a FIRST objective of a request with several first objectives, that part's own request in one self-contained sentence (the same rules as the brief's `request`: the platform
   * by name, what is collected, «عن» before the topic, the customer's own conditions and numbers). Each part becomes its own plan, priced and approved on its own card; the sentence is validated like a brief (privacy, numbers, platforms).
   */
  request?: string | null;
  /**
   * EXACT REQUIREMENTS OF ONE PART (docs/MULTI-OBJECTIVE-RESEARCH.md section 12), on a FIRST objective only: the customer's OWN words for a condition that applies to THIS part only (a period «آخر شهر», a place «الغردقة», a content language
   * «بالعربي»), and the number they wrote for this part. A condition of the whole request is written once in the brief's own fields instead. Never a value the customer did not write: the code reads the values (the same reader the worker
   * executes with) and compares them with the part's sentence.
   */
  period?: string | null;
  country?: string | null;
  language?: string | null;
  count?: number | null;
}

export interface ResearchBrief {
  v: typeof RESEARCH_BRIEF_VERSION;
  status: BriefStatus;
  /** The whole research request, in the customer's language, every turn merged and every correction applied. */
  request: string;
  platforms: BriefPlatform[];
  content: BriefContent[];
  /** The number the customer wrote, or null. */
  count: number | null;
  topic: string | null;
  /** In the customer's own words («آخر شهر»): the values are computed by code (semantic/conditions.ts), never by the model. */
  period: string | null;
  country: string | null;
  language: string | null;
  /** The model's structured research objectives (absent: the brief carried none; the request is then read from its words, as before). */
  objectives?: BriefObjective[];
}

export const BRIEF_REQUEST_MIN = 3;
export const BRIEF_REQUEST_MAX = 1000;
const FIELD_MAX = 120;
const KNOWN_FIELDS = new Set(["status", "request", "platforms", "content", "count", "topic", "period", "country", "language", "objectives", "v"]);
const OBJECTIVE_FIELDS = new Set(["id", "operation", "platform", "parent", "contacts", "what", "request", "period", "country", "language", "count"]);
/**
 * DESCRIPTIVE keys a real model adds to an objective (live evaluation 2026-11-12: «topic»). They describe the goal and are never executed: their text joins `what` (internal, privacy-checked by `validateBrief`) instead of discarding the
 * whole reading. Every OTHER unknown key (an endpoint, a provider, a field list, a price...) still rejects the objectives.
 */
const DESCRIPTIVE_OBJECTIVE_FIELDS = new Set(["topic", "description"]);
type Conds = Pick<BriefObjective, "period" | "country" | "language" | "count">;
const sameCond = (a: unknown, b: unknown) => String(a).replace(/\s+/g, " ").trim() === String(b).replace(/\s+/g, " ").trim();

export type ParsedBrief = { ok: true; brief: ResearchBrief; unknown: string[] } | { ok: false; issue: string };

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t === "" ? null : t.slice(0, max);
};
const listOf = <T extends string>(v: unknown, allowed: readonly T[]): T[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const e of v) {
    const k = typeof e === "string" ? e.trim().toLowerCase() : "";
    if (!(allowed as readonly string[]).includes(k)) return null; // an unsupported value is never mapped to a supported one
    if (!out.includes(k as T)) out.push(k as T);
  }
  return out;
};

/** The objectives the model proposed, checked against the schema (an unknown operation, field or value rejects them: an unsupported value is never mapped to a supported one). Null: absent; false: invalid. */
function parseObjectives(v: unknown): BriefObjective[] | null | false {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > OBJECTIVES_MAX) return false;
  const out: BriefObjective[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const o = raw as Record<string, unknown>;
    if (Object.keys(o).some((k) => !OBJECTIVE_FIELDS.has(k) && !DESCRIPTIVE_OBJECTIVE_FIELDS.has(k))) return false;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,12}$/.test(id) || out.some((x) => x.id === id)) return false;
    const operation = typeof o.operation === "string" ? o.operation.trim().toLowerCase() : "";
    if (!(OBJECTIVE_OPERATIONS as readonly string[]).includes(operation)) return false;
    let platform: string | null = null;
    if (o.platform !== undefined && o.platform !== null && o.platform !== "") {
      const p = typeof o.platform === "string" ? o.platform.trim().toLowerCase() : "";
      if (!/^[a-z][a-z0-9_.-]{0,29}$/.test(p)) return false;
      platform = p;
    }
    const parent = o.parent === undefined || o.parent === null || o.parent === "" ? null : typeof o.parent === "string" ? o.parent.trim() : "\u0000";
    if (parent !== null && !/^[A-Za-z0-9_-]{1,12}$/.test(parent)) return false;
    const contacts = listOf(o.contacts, ["email", "phone"] as const);
    if (!contacts) return false;
    const partRequest = text(o.request, BRIEF_REQUEST_MAX);
    let count: number | null = null;
    if (o.count !== undefined && o.count !== null && o.count !== "") {
      const n = Number(normalizeDigits(String(o.count)));
      if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) return false;
      count = n;
    }
    const conds: Conds = {};
    for (const k of ["period", "country", "language"] as const) { const v = text(o[k], FIELD_MAX); if (v) conds[k] = v; }
    if (count !== null) conds.count = count;
    const described = [...DESCRIPTIVE_OBJECTIVE_FIELDS].map((k) => text(o[k], FIELD_MAX)).filter((v): v is string => v !== null);
    const what = [text(o.what, FIELD_MAX), ...described].filter((v): v is string => v !== null).join(" — ").slice(0, FIELD_MAX) || null;
    out.push({ id, operation: operation as ObjectiveOperation, platform, parent, contacts, what, ...(partRequest ? { request: partRequest } : {}), ...conds });
  }
  return hoistChildConditions(out);
}

/**
 * A condition of one part belongs on that part's FIRST objective (the brief's own fields hold the conditions of the whole request). A real model often writes it on the child it is about (the period of the reviews, the count of the
 * comments; live evaluation 2026-11-12, E1 and H1). It is the SAME part's condition, so it is moved to the part's first objective; when that objective states ANOTHER value of the same kind, the reading is ambiguous and rejected
 * (false). A parent written after its child, or unknown, is left to `objectivesIssue` (structure).
 */
function hoistChildConditions(list: BriefObjective[]): BriefObjective[] | false {
  const byId = new Map(list.map((o) => [o.id, o]));
  const rootOf = (o: BriefObjective): BriefObjective | null => {
    let cur: BriefObjective | undefined = o;
    for (let i = 0; i <= list.length && cur; i += 1) { if (cur.parent === null) return cur; cur = byId.get(cur.parent); }
    return null;
  };
  const out = list.map((o) => ({ ...o }));
  const outById = new Map(out.map((o) => [o.id, o]));
  for (const child of out) {
    if (child.parent === null) continue;
    const kinds = (["period", "country", "language", "count"] as const).filter((k) => child[k] !== undefined && child[k] !== null);
    if (kinds.length === 0) continue;
    const root0 = rootOf(child);
    // no reachable first objective: the conditions cannot be placed (structure is judged later; the objectives are rejected here as before)
    if (!root0) return false;
    const root = outById.get(root0.id)!;
    for (const k of kinds) {
      const v = child[k];
      if (root[k] !== undefined && root[k] !== null) { if (!sameCond(root[k], v)) return false; }
      else (root as Record<string, unknown>)[k] = v;
      delete (child as Record<string, unknown>)[k];
    }
  }
  return out;
}

/** The brief the model proposed, checked against the schema. Never throws. */
export function parseBrief(raw: unknown): ParsedBrief {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issue: "not_an_object" };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KNOWN_FIELDS.has(k)).sort();
  if (o.v !== undefined && o.v !== RESEARCH_BRIEF_VERSION) return { ok: false, issue: "version" };
  const status = typeof o.status === "string" && (BRIEF_STATUSES as readonly string[]).includes(o.status) ? (o.status as BriefStatus) : null;
  if (!status) return { ok: false, issue: "status" };
  const request = text(o.request, BRIEF_REQUEST_MAX + 1);
  if (!request) return { ok: false, issue: "request_missing" };
  const platforms = listOf(o.platforms, BRIEF_PLATFORMS);
  if (!platforms) return { ok: false, issue: "platforms" };
  const content = listOf(o.content, BRIEF_CONTENT);
  if (!content) return { ok: false, issue: "content" };
  let count: number | null = null;
  if (o.count !== undefined && o.count !== null && o.count !== "") {
    const n = Number(normalizeDigits(String(o.count)));
    if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) return { ok: false, issue: "count" };
    count = n;
  }
  const objectives = parseObjectives(o.objectives);
  if (objectives === false) return { ok: false, issue: "objectives" };
  return {
    ok: true,
    unknown,
    brief: { v: RESEARCH_BRIEF_VERSION, status, request, platforms, content, count, topic: text(o.topic, FIELD_MAX), period: text(o.period, FIELD_MAX), country: text(o.country, FIELD_MAX), language: text(o.language, FIELD_MAX), ...(objectives && objectives.length > 0 ? { objectives } : {}) },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// GROUNDING
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const NUMBER_WORD_RE = new RegExp(`(?<![ء-ي])(?:[وب]?)(${NUMBER_WORDS_SRC})(?![ء-ي])`, "g");

/** Every whole number a text writes: in digits (Arabic-Indic or Latin, with or without a thousands mark) and in words («مية», «عشرين»). */
export function numbersWritten(raw: string): Set<number> {
  const t = normalizeDigits(String(raw ?? "")).replace(/(\d)[,٬](?=\d{3}\b)/g, "$1");
  const out = new Set<number>();
  for (const m of t.match(/\d+/g) ?? []) { const n = Number(m); if (Number.isSafeInteger(n)) out.add(n); }
  for (const m of t.matchAll(NUMBER_WORD_RE)) { const n = numberOfWord(m[1]); if (n !== null) out.add(n); }
  return out;
}

export interface BriefContext {
  /** Everything the customer typed in this conversation that the brief may draw on (oldest first), the current message last. */
  customerTurns: string[];
  /** The assistant's last message (the question the customer is answering), or null. A platform it named counts as named. */
  assistantQuestion?: string | null;
  /** The brief already validated on an earlier turn, or null: its request is already grounded. */
  prior?: ResearchBrief | null;
  /** The semantic flag for this account (the same reader the worker uses), so the consistency check reads the request as the worker will. */
  semantic?: boolean;
}

export type BriefRejection =
  | "privacy_refusal"
  | "privacy_clarify"
  | "request_length"
  | "number_not_written"
  | "platform_not_named"
  | "platform_mismatch"
  | "count_mismatch"
  | "comments_dropped"
  | "replies_dropped"
  | "objectives_structure"
  | "objective_platform_not_named"
  | "objective_dropped";

export type ValidatedBrief =
  | { ok: true; brief: ResearchBrief; contract: RequestContract }
  | { ok: false; reason: BriefRejection; /** a privacy answer for the customer (privacy_refusal / privacy_clarify only) */ contentAr?: string };

/**
 * What may become a mission (see the header). The privacy check comes first: a consolidated request that the guard would refuse is refused, and one it would clarify is clarified, exactly as if the customer had typed it.
 */
export function validateBrief(brief: ResearchBrief, ctx: BriefContext): ValidatedBrief {
  const request = brief.request.replace(/\s+/g, " ").trim();
  const refusal = privacyRefusalAr(request);
  if (refusal) return { ok: false, reason: "privacy_refusal", contentAr: refusal };
  if (contactAskVerdict(request) === "clarify") return { ok: false, reason: "privacy_clarify", contentAr: contactClarifyAr(request) };
  if (request.length < BRIEF_REQUEST_MIN || request.length > BRIEF_REQUEST_MAX) return { ok: false, reason: "request_length" };

  const groundText = [...ctx.customerTurns, ctx.prior?.request ?? ""].join("\n");
  const written = numbersWritten(groundText);
  for (const n of numbersWritten(request)) if (!written.has(n)) return { ok: false, reason: "number_not_written" };
  if (brief.count !== null && !written.has(brief.count)) return { ok: false, reason: "number_not_written" };

  const named = new Set<string>([...platformsNamedIn(groundText), ...platformsNamedIn(String(ctx.assistantQuestion ?? ""))]);
  const inRequest = platformsNamedIn(request);
  for (const p of [...inRequest, ...brief.platforms]) if (!named.has(p)) return { ok: false, reason: "platform_not_named" };

  // consistency: the words the worker will read say what the model understood (nothing silently dropped or changed)
  const contract = buildRequestContract(request, undefined, { semantic: ctx.semantic === true });
  const fieldsPlatforms = [...brief.platforms].sort();
  if (fieldsPlatforms.length > 0 || inRequest.length > 0) {
    if (JSON.stringify(fieldsPlatforms) !== JSON.stringify(inRequest)) return { ok: false, reason: "platform_mismatch" };
    if (fieldsPlatforms.length === 1 && contract.platform !== fieldsPlatforms[0]) return { ok: false, reason: "platform_mismatch" };
  }
  if (brief.count !== null && !numbersWritten(request).has(brief.count)) return { ok: false, reason: "count_mismatch" };
  // X has no comments stage in the contract: «تعليقات إكس» is stated by the plan as replies, not dropped here
  if (brief.content.includes("comments") && contract.comments === "none" && contract.platform !== "x") return { ok: false, reason: "comments_dropped" };
  if (brief.content.includes("replies") && contract.replies === "none") return { ok: false, reason: "replies_dropped" };
  if (brief.objectives) {
    const issue = objectivesIssue(brief, named);
    if (issue) return { ok: false, reason: issue };
    for (const o of brief.objectives) if (o.what && privacyRefusalAr(o.what)) return { ok: false, reason: "privacy_refusal", contentAr: privacyRefusalAr(o.what)! };
  }
  return { ok: true, brief: { ...brief, request }, contract };
}

/**
 * THE COUNT OF A MULTI-PART BRIEF. A request of several parts has no one number: each part's number is its own (its first objective's `count`, its sentence). A brief-level `count` that IS one of the parts' numbers is that part's, so it is
 * cleared from the whole request before validation (live evaluation 2026-11-12, J1: the whole request «… تيك توك، وتقييمات فنادق …» was rejected for not writing the TikTok part's 300). Any other brief-level count stays and is checked.
 */
export function withPartCounts(brief: ResearchBrief): ResearchBrief {
  const objectives = brief.objectives ?? [];
  if (brief.count === null || objectives.filter((o) => o.parent === null).length < 2) return brief;
  const n = brief.count;
  const ofParts = objectives.some((o) => o.count === n || (typeof o.request === "string" && numbersWritten(o.request).has(n)));
  return ofParts ? { ...brief, count: null } : brief;
}

/** The SERVED social platforms (the five the brief schema knows); any other platform an objective names is said honestly as unavailable, never executed. */
export const isServedPlatform = (p: string | null): p is BriefPlatform => p !== null && (BRIEF_PLATFORMS as readonly string[]).includes(p);
/** Which operation an objective of each operation may hang on (null: written alone; for a child operation code then adds the step its chain needs, need.ts). The chain the capabilities can actually execute; the people of a company or a first «people» search are both valid. */
export const OBJECTIVE_PARENTS: Record<Exclude<ObjectiveOperation, "unsupported">, ReadonlyArray<ObjectiveOperation | null>> = {
  "social.parents": [null],
  "social.comments": ["social.parents", null],
  "social.replies": ["social.comments", "social.parents", null],
  "companies.discover": [null],
  "company.contacts": ["companies.discover", null],
  "places.discover": [null],
  "places.reviews": ["places.discover", null],
  "web.search": [null],
  "web.read": ["web.search", null],
  "people.discover": [null, "companies.discover"],
};

/**
 * THE OBJECTIVES AGAINST THE CONVERSATION (the model interprets; the code checks it executes nothing the customer did not ask for and drops nothing the model itself understood):
 *   - structure: every parent exists and is written before its child; a child hangs only on an operation that can feed it; a social objective names its platform and a non-social one names none; contacts only on company.contacts;
 *   - grounding: a served platform an objective names was named by the customer (the same rule as the brief's platforms);
 *   - nothing dropped: every platform and content of the brief has its objective (a brief that says «comments» with no comments objective is rejected; the conversation then falls back to today's reading of the words).
 */
export function objectivesIssue(brief: ResearchBrief, named: ReadonlySet<string>): BriefRejection | null {
  const objectives = brief.objectives ?? [];
  const seen = new Map<string, BriefObjective>();
  for (const o of objectives) {
    if (o.operation === "unsupported") { if (o.parent !== null || o.contacts.length > 0) return "objectives_structure"; seen.set(o.id, o); continue; }
    const social = o.operation.startsWith("social.");
    if (social ? o.platform === null : o.platform !== null) return "objectives_structure";
    if (o.contacts.length > 0 && o.operation !== "company.contacts") return "objectives_structure";
    if (o.operation === "company.contacts" && o.contacts.length === 0) return "objectives_structure";
    const parent = o.parent === null ? null : seen.get(o.parent) ?? null;
    if (o.parent !== null && (!parent || parent.operation === "unsupported")) return "objectives_structure";
    if (!OBJECTIVE_PARENTS[o.operation].includes(parent ? parent.operation : null)) return "objectives_structure";
    if (social && parent && parent.platform !== o.platform) return "objectives_structure";
    if (social && isServedPlatform(o.platform) && !named.has(o.platform)) return "objective_platform_not_named";
    seen.set(o.id, o);
  }
  const executable = objectives.filter((o) => o.operation !== "unsupported");
  const ops = new Set(executable.map((o) => o.operation));
  for (const p of brief.platforms) if (!executable.some((o) => o.platform === p)) return "objective_dropped";
  for (const p of executable.map((o) => o.platform).filter(isServedPlatform)) if (!brief.platforms.includes(p)) return "objective_dropped";
  const needs: Array<[BriefContent, ObjectiveOperation[]]> = [["comments", ["social.comments", "social.replies"]], ["replies", ["social.replies", "social.comments"]], ["companies", ["companies.discover"]], ["places", ["places.discover"]], ["reviews", ["places.reviews"]], ["people", ["people.discover"]], ["articles", ["web.search", "web.read"]], ["contacts", ["company.contacts"]]];
  for (const [c, wanted] of needs) if (brief.content.includes(c) && !wanted.some((w) => ops.has(w))) return "objective_dropped";
  return null;
}

/**
 * Whether the trusted parser already reads a COMPLETE social request from the words (a platform, a topic, and what to collect): the plan can be prepared, so a further question would be redundant (the planner itself asks the count or a
 * condition when one is genuinely needed, and the card shows the scope and the price before anything is held).
 */
export function contractIsComplete(contract: RequestContract): boolean {
  return contract.platform !== null && contract.topic !== null && contract.topic.trim() !== "" && (contract.parentKind !== null || contract.comments !== "none" || contract.replies !== "none" || contract.source.named);
}

/**
 * Whether two requests ask for the same thing apart from the number of items (a plan edit of the count only is applied to the plan already priced, by the code that already does it). Compared on the trusted contract.
 */
export function differsOnlyByCount(a: RequestContract, b: RequestContract): boolean {
  const strip = (c: RequestContract) => JSON.stringify({ ...c, count: null });
  return strip(a) === strip(b) && a.count !== b.count;
}

/** Whether two requests ask for the same thing (the trusted contract of each). */
export function sameContract(a: RequestContract, b: RequestContract): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The numbers a reply may repeat in brief mode: the ones the customer wrote in this conversation (in Arabic-Indic digits, as replies are written). */
export function briefNumbersAr(ctx: Pick<BriefContext, "customerTurns" | "prior">): string[] {
  return [...numbersWritten([...ctx.customerTurns, ctx.prior?.request ?? ""].join("\n"))].map((n) => toArabicDigits(n));
}

/** A brief stored on an assistant message (`messages.plan.researchBrief`), read back with the same schema (a broken or old value is null). */
export function storedBriefOf(plan: unknown): ResearchBrief | null {
  const raw = (plan as { researchBrief?: unknown } | null | undefined)?.researchBrief;
  const parsed = parseBrief(raw);
  return parsed.ok && parsed.unknown.length === 0 ? parsed.brief : null;
}
