import type { CatalogEndpoint, TregCatalog } from "../../../src/lib/treg/catalog";
import type { AccountAccess } from "../../../src/lib/treg/dataPolicy";
import { hintsOf, missionPageOf, pageInputValue, readShape } from "../../../src/lib/treg/shapeReader";
import { buildShapeDigest, digestValue } from "../../../src/lib/modelPlanner/digest";
import { fundingCallUsdMicro, priceMissionByCode, type ExecutionFundingRoute, type ListedMissionRate } from "../../../src/lib/agentMission/price";
import { normalizeMissionPricingSettings, type MissionPricingSettings } from "../../../src/lib/missionPricing";
import { AGENT_MAX_DELIVERED_ROWS } from "../../../src/lib/agentMission/constants";
import providerMetadata from "../../../data/capabilities/provider-metadata.json";
import { APPROVED_CAPABILITY_CATALOG } from "../../../src/functions/shared/capabilityRegistry";
import { DEFAULT_PRICING_SETTINGS, unitPricePointsForCapability } from "../../../src/functions/shared/quotes";
import { pointsAr } from "../../../src/lib/pointsFormat";
import { stagePriceInputs, type PricedPlan, type PricedStage, type PlanColumn } from "../../../src/lib/agentMission/plan";
import { cardMapCode } from "../../../src/lib/agentMission/foundation/toolCards/mapCode";
import type { ToolCard } from "../../../src/lib/agentMission/foundation/toolCards/types";
import { toArabicDigits } from "../../../src/lib/arabicDigits";
import { checkCustomerText } from "../../../src/lib/agentMission/text";
import { SOURCE_LABEL_FALLBACK_AR, foreignLatinIn, labelWrittenBy, withoutUnwrittenLabels, writtenLatinWords } from "../../../src/lib/agentMission/shownWords";
import { PLATFORM_AR } from "../../../src/lib/agentMission/platformLabels";
export { PLATFORM_AR };
import { COMPANIES_LABEL_AR, isPeopleNoun, isPeopleOfCompanyStep, peopleOfCompaniesAskOf, type PeopleOfCompaniesAsk } from "../../../src/lib/agentMission/childSources";
import { ownTitleWords, sameNounStem } from "../../../src/lib/agentMission/quantity";
import { countSupportedByMessage, countWrittenIn, isCountOfOtherNoun, isSingularPerParentCitation, tokensOf, wordNumbersIn, writtenElsewhere } from "../../../src/lib/agentMission/numberWords";
import { estimateCallUsd, tregCallBoundOf, type GatewayCallResult } from "../gateway";
import { SEARCH_ENGINE_PLATFORMS, callUsdOf, candidatesFor, capabilitiesOf, describeForModel, isProven, peopleOfCompanyHint, platformIndex, platformsOf } from "./catalogView";
import { DECIDE_IT_AR_EN, UNDERSTAND_SCHEMA_NO_ASK, FIELD_MAP_SCHEMA, FIELD_MAP_SYSTEM, FIELD_MAP_TOOL, SCOUT_SCHEMA, SCOUT_SYSTEM, SCOUT_TOOL, TOOL_CHOICE_SCHEMA, TOOL_CHOICE_SYSTEM, TOOL_CHOICE_TOOL, UNDERSTAND_SCHEMA, UNDERSTAND_SYSTEM, UNDERSTAND_TOOL } from "./prompts";

/**
 * THE LLM-FIRST PLANNER (owner direction, 15 Nov 2026: «the model must understand the request and call the catalog's tools the way the customer wants; no word rules, no filters»).
 *
 *   1. UNDERSTAND (one forced, structured model call): the customer's own messages → steps (platform, capability, parent, count, source, topic, search terms, period …).
 *   2. CHOOSE (one call per step): the catalog's candidates for the step's capability, described by the catalog itself → a tool and its exact inputs, plus further input sets that reach the count.
 *   3. PROBE (code): ONE real first page per step, through the mission's gateway (budget, policy, spend gate, recording all apply). A tool that fails or is empty → the next option.
 *   4. MAP (one call per step): the real items → the file's columns as paths; code checks every path on the real items and generates the mapping code (the same generator as the hand cards).
 *   5. PRICE (code): the customer's count × what one page really gave × the catalog's price per call, through the existing price function. Execution pages each stage until the count is reached or the
 *      source has nothing more, continuing with the further input sets; duplicates are removed. Nothing is dropped for its meaning.
 *
 * Code never re-reads the request. It checks only what the model wrote against the catalog (ids, input names, enums, parents, numbers).
 */

export interface PlannerModelAnswer { input: unknown; costUsd: number; /** the model declined to answer (stop_reason refusal): the request asks for something it will not do */ refused?: boolean }
/** One forced structured call of the planning model (the tool's input comes back parsed), or null when it gave none. */
export type PlannerModel = (call: { system: string; user: string; tool: { name: string; description: string; schema: Record<string, unknown> }; maxTokens: number }) => Promise<PlannerModelAnswer | null>;

export interface LlmPlannerDeps {
  model: PlannerModel;
  catalog: TregCatalog;
  access: AccountAccess | null;
  /** One real call of a tool (the mission's planning gateway). */
  probe: (endpointId: string, params: Record<string, unknown>) => Promise<GatewayCallResult>;
  /** The full raw page a successful probe saved. */
  readPage: (callId: string) => Promise<unknown | null>;
  pricingSettings?: unknown;
  /** Read immediately before offering a funded quote. Null means the wallet could not be checked. */
  availablePoints?: () => Promise<number | null>;
  /** Today, for the model's dates (Cairo calendar day, YYYY-MM-DD). */
  today: string;
  /** What the customer reads while the plan is prepared (one short Arabic line per phase). Absent: nothing is said. */
  onProgress?: (lineAr: string) => Promise<void>;
  /** The direct web tools the worker holds a key for (catalogView `directWebEndpoints`): offered beside the catalog's tools for a web or news search. Absent: none. */
  webTools?: CatalogEndpoint[];
  /** Whether this planner plans what the model understood (false: the caller's other path plans it, before any paid call). Absent: always. */
  accept?: (u: Understanding) => boolean;
  log?: (line: string) => void;
}

export interface LlmPlannerInput {
  /** The customer's own messages for this request, oldest first (authoritative). */
  words: string[];
  /** Earlier messages of the conversation, before this request (context only). */
  earlier?: string[];
  /** The request as the chat summarised it (context only). */
  request: string;
  /** A question this planner asked and the customer's answer to it. */
  question?: string | null;
  answer?: string | null;
  /** Every question this planner asked and the customer's answer, oldest first (the planner's own, and the scouting questions that tell what the real search found). */
  exchanges?: Array<{ question: string; answer: string }>;
  /** May this run stop and ask the customer what to do when the real search found far less than they asked for (false once the limit is reached). Absent: yes. */
  scoutAllowed?: boolean;
}

export interface UnderstoodStep {
  key: string; title_ar: string; platform: string; capability: string; parent: string | null; deliver: boolean;
  count: { total: number | null; per_parent: number | null; all: boolean };
  source: { kind: string; value: string } | null; topic: string | null; search_terms: string[]; period: { from: string; to: string } | null;
  language?: string | null; country?: string | null; order?: "newest" | "top" | null; fields_wanted?: string[];
}
export interface Understanding {
  decision: "plan" | "ask" | "cannot"; understanding_ar: string; /** the essential inputs an «ask» says are missing (DT-20261119-03); only the valid kinds */ missing?: string[]; question_ar?: string; options_ar?: string[]; cannot_ar?: string; assumptions_ar?: string[]; no_repeat?: boolean; /** the customer's answer to a question about what the search found accepted what exists */ accepts_available?: boolean; /** the required answer: the people of the companies were asked (DT-20261118-08); present only when asked */ people_of_companies?: PeopleOfCompaniesAsk; /** the companies' count the customer's own words support, set by code (withCheckedCompaniesCount); never the model's total */ companies_count?: number; steps: UnderstoodStep[];
}

export type LlmPlanResult =
  | { kind: "plan"; plan: PricedPlan; understanding: Understanding; costUsd: number }
  | { kind: "question"; question_ar: string; options_ar: string[]; understanding: Understanding; costUsd: number; /** the question reports what the real search found (the customer chooses: take it, or widen) */ scout?: true }
  | { kind: "cannot"; reason_ar: string; understanding: Understanding | null; costUsd: number; detail: string };

/** Asked when the model's own question cannot be shown as it wrote it. */
export const GENERIC_QUESTION_AR = "ممكن توضّح طلبك أكثر: من أي منصة، وما الذي نجمعه بالضبط، وعن أي موضوع أو من أي حساب، وكم عددًا تريد؟";
/** The button of the lookup question (planner.ts, live DT-20261118-02): the customer lets us pick any result about the topic. Compared word for word with the answer. */
export const ANY_RESULT_OPTION_AR = "أي نتيجة عن الموضوع تكفي، اختاروها أنتم";
/** Items a step collects when the customer gave no number (said on the card; the customer edits it before approving). */
export const DEFAULT_COUNT = 20;
/** Children read for each parent when the customer asked for «all» and the parent gives no counter (the card says it is a maximum). */
export const ALL_CHILDREN_CAP = 500;
/** Children read for each parent when the customer asked for children with no number. */
export const DEFAULT_PER_PARENT = 20;
/** The most items one step may promise. */
export const MAX_STEP_ITEMS = 50_000;
/** Real calls one step may make while planning (options and their further input sets). */
export const MAX_PROBES_PER_STEP = 6;
/** What one page is assumed to give beyond what the probe showed, for the price: further input sets repeat some items (removed as duplicates). */
export const VARIANT_OVERLAP_FACTOR = 1.3;
/** Further input sets read once, while planning, to measure how much a source really holds for a request (the scouting). */
export const MAX_SCOUT_SETS = 4;
/** A page with fewer rows than this is THIN: a next page after it does not show that the source holds more (live 16 Nov: a source offered a next page after 1 tweet). Thin searches are followed and counted. */
export const THIN_PAGE_ROWS = 15;
/** Pages followed after a thin first page, while planning. */
export const MAX_SCOUT_PAGES = 3;
/** The real search found less than this share of the customer's number: the customer is asked what to do before the plan (take it, or widen). */
/** Below this share of the customer's number, a source that ran dry is told to the customer BEFORE the plan (take what exists, or widen). Live, 16 Nov 2026: 10 of 20 Amazon reviews and 15 of 20 news were
 * planned silently at 20 behind a folded note, because the share was one half; a customer asking for 20 who will get 10 decides before approving. */
export const SCOUT_SHORT_SHARE = 0.9;

const COLUMN_TITLES: Record<string, string> = {
  text: "النص", title: "العنوان", author: "الاسم", username: "الحساب", posted_at: "تاريخ النشر", link: "الرابط", likes: "الإعجابات", comments_count: "عدد التعليقات", replies_count: "عدد الردود",
  shares: "المشاركات", views: "المشاهدات", language: "اللغة", country: "الدولة",
};
const COLUMN_ORDER = ["text", "title", "author", "username", "posted_at", "link", "likes", "comments_count", "replies_count", "shares", "views", "language", "country"];

import { impersonalAr } from "../../src/lib/agentMission/roles";
export { impersonalAr };

/** What the card says in place of the name of a source the customer did not write (DT-20261118-09 S2: «خرائط جوجل», «لينكدإن» reached the card of a customer who had named no source). */
export const PLATFORM_LABEL_FALLBACK_AR = SOURCE_LABEL_FALLBACK_AR;
/** The table's label for a platform, with the step's capability: Google is Maps only for places and their reviews (live, 16 Nov 2026: a news request's card read «خرائط جوجل»), news read from the web are «مواقع الأخبار». */
const tableLabelOf = (p: string, capability?: string): string | null => {
  const cap = String(capability ?? "");
  if (/(^|\.)news(\.|$)/.test(cap)) return p === "google" ? "أخبار جوجل" : "مواقع الأخبار";
  if (p === "google" && cap !== "") return /maps|place|reviews/.test(cap) ? "خرائط جوجل" : "بحث جوجل";
  return PLATFORM_AR[p] ?? null;
};
/** The label of a platform, only when the customer wrote it in their own words (`said`); else «المصدر». A platform the table does not know stays «المنصة». */
export const platformAr = (p: string, capability: string | undefined, said: ReadonlyArray<string>): string => {
  const label = tableLabelOf(p, capability);
  if (label === null) return "المنصة";
  return labelWrittenBy(label, said) ? label : PLATFORM_LABEL_FALLBACK_AR;
};

/**
 * A sentence of the model shown to the customer: Arabic digits, and only when it passes the customer-text rules (no Latin word, no id, no provider); else null. With `said` (the customer's words), a sentence that names a label of
 * the code's own platform table the customer did not write is refused as well (DT-20261118-09 S2), and a Latin word the customer wrote is not a reason to refuse it (S1: their own word).
 */
export function customerSafe(text: string | null | undefined, maxChars = 400, said?: ReadonlyArray<string>): string | null {
  let t = toArabicDigits(String(text ?? "").replace(/\s+/g, " ").trim());
  if (!t) return null;
  // a label of the code's own table the customer did not write becomes «المصدر» inside the model's sentence (the rest of the sentence is still the model's)
  if (said !== undefined) t = withoutUnwrittenLabels(t, said);
  if (said !== undefined && foreignLatinIn(t, writtenLatinWords(said)).length === 0 && /[A-Za-z]{2,}/.test(t)) {
    return checkCustomerText(t.replace(/[A-Za-z]{2,}/g, "ـ"), { maxChars }).issues.length === 0 ? t : null;
  }
  return checkCustomerText(t, { maxChars }).issues.length === 0 ? t : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown): number | null => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? Math.min(MAX_STEP_ITEMS, Math.floor(n)) : null; };
const at = (o: unknown, path: ReadonlyArray<string>): unknown => { let v: unknown = o; for (const k of path) { if (v === null || v === undefined || typeof v !== "object") return undefined; v = (v as Record<string, unknown>)[k]; } return v; };
/** The conditions a tool may not carry, as the card names them. */
export const CONDITION_AR: Record<string, string> = { source: "الحساب أو الصفحة المحددة", topic: "الموضوع", period: "الفترة", language: "اللغة", country: "الدولة", order: "الترتيب" };

/** A JSON object the model wrote as a string (structured outputs close every object, so a tool's free inputs travel as text), or null. */
const jsonObject = (v: unknown): Record<string, unknown> | null => { if (isObj(v)) return v; if (typeof v !== "string") return null; try { const o = JSON.parse(v) as unknown; return isObj(o) ? o : null; } catch { return null; } };
const filled = (v: unknown): boolean => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 1. UNDERSTAND
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export function understandPrompt(input: LlmPlannerInput, today: string): string {
  const lines = [
    `Today (Cairo): ${today}`,
    "",
    "The customer's own messages for this request, oldest first (authoritative):",
    ...input.words.map((w, i) => `${i + 1}. ${w}`),
  ];
  if (input.request && !input.words.some((w) => w.includes(input.request))) lines.push("", `The chat's summary of the request (context only; the customer's words win): ${input.request}`);
  if (input.earlier && input.earlier.length > 0) lines.push("", "Earlier messages of the same conversation (context only, a previous request):", ...input.earlier.slice(-6).map((w) => `- ${w}`));
  if (input.exchanges && input.exchanges.length > 0) { lines.push("", "Questions you or the system asked the customer, and their answers (oldest first):"); input.exchanges.forEach((e, i) => lines.push(`${i + 1}. Asked: ${e.question}`, `   The customer answered: ${e.answer}`)); }
  else if (input.question) lines.push("", `You asked the customer: ${input.question}`, `The customer answered: ${input.answer ?? ""}`);
  else if (input.answer) lines.push("", `The customer added: ${input.answer}`);
  return lines.join("\n");
}

const KEY_RE = /^[a-z][a-z0-9_]{0,30}$/;

/** The essential inputs an «ask» may name (the schema's enum). */
export const MISSING_KINDS: ReadonlyArray<string> = ["items", "place", "source", "platform"];
/**
 * ASKING IS A PERMISSION THE ANSWER MUST EARN (DT-20261119-03). The question of an «ask» is shown only when it names an essential input that has no value anywhere in the customer's words (`missing`), after one cross-check against
 * the model's OWN answer: when the people of the companies were asked, the kind of things (the companies) and the platform are known, so only the place can still be missing. Nothing here reads the question's words.
 */
export function askIsEarned(u: Pick<Understanding, "decision" | "missing" | "people_of_companies">): boolean {
  if (u.decision !== "ask") return true;
  const kinds = u.missing ?? []; // already reduced to the closed set by checkUnderstanding
  const standing = u.people_of_companies?.asked === true ? kinds.filter((k) => k === "place") : kinds;
  return standing.length > 0;
}
/** What code checks in the model's understanding: catalog names, keys, parents, numbers. The error text goes back to the model once. */
export function checkUnderstanding(u: unknown, catalog: TregCatalog, access: AccountAccess | null): { ok: true; value: Understanding } | { ok: false; error: string } {
  if (!isObj(u)) return { ok: false, error: "the answer is not an object" };
  const decision = u.decision === "ask" || u.decision === "cannot" ? u.decision : "plan";
  const understanding_ar = str(u.understanding_ar);
  const base = { decision, understanding_ar, assumptions_ar: Array.isArray(u.assumptions_ar) ? u.assumptions_ar.map(str).filter(Boolean).slice(0, 8) : [], no_repeat: u.no_repeat === true, ...(u.accepts_available === true ? { accepts_available: true } : {}), ...(peopleOfCompaniesAskOf(u.people_of_companies).asked ? { people_of_companies: peopleOfCompaniesAskOf(u.people_of_companies) } : {}) } as Understanding;
  if (decision === "ask") {
    const q = str(u.question_ar);
    if (!q) return { ok: false, error: "decision ask needs question_ar" };
    return { ok: true, value: { ...base, missing: Array.isArray(u.missing) ? [...new Set(u.missing.map(str).filter((k) => MISSING_KINDS.includes(k)))] : [], question_ar: q, options_ar: Array.isArray(u.options_ar) ? u.options_ar.map(str).filter(Boolean).slice(0, 4) : [], steps: [] } };
  }
  if (decision === "cannot") return { ok: true, value: { ...base, cannot_ar: str(u.cannot_ar) || understanding_ar, steps: [] } };
  const raw = Array.isArray(u.steps) ? u.steps : [];
  if (raw.length === 0) return { ok: false, error: "a plan needs at least one step" };
  const platforms = platformsOf(catalog, access);
  const steps: UnderstoodStep[] = [];
  const errors: string[] = [];
  raw.slice(0, 8).forEach((s, i) => {
    if (!isObj(s)) { errors.push(`step ${i + 1} is not an object`); return; }
    let key = str(s.key).toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!KEY_RE.test(key) || steps.some((x) => x.key === key)) key = `step${i + 1}`;
    const platform = str(s.platform).toLowerCase();
    if (!platforms.has(platform)) { errors.push(`step ${key}: platform "${platform}" is not in the catalog index`); return; }
    let capability = str(s.capability);
    if (capability && !capability.startsWith(`${platform}.`)) capability = `${platform}.${capability}`;
    if (!capabilitiesOf(catalog, access, platform).has(capability)) { errors.push(`step ${key}: capability "${capability}" is not listed for ${platform}`); return; }
    const parent = str(s.parent) || null;
    if (parent && !steps.some((x) => x.key === parent)) { errors.push(`step ${key}: parent "${parent}" must be an EARLIER step's key`); return; }
    const c = isObj(s.count) ? s.count : {};
    const src = isObj(s.source) && str(s.source.value) ? { kind: str(s.source.kind) || "account", value: str(s.source.value) } : null;
    const per = isObj(s.period) && /^\d{4}-\d{2}-\d{2}$/.test(str(s.period.from)) && /^\d{4}-\d{2}-\d{2}$/.test(str(s.period.to)) ? { from: str(s.period.from), to: str(s.period.to) } : null;
    steps.push({
      key, title_ar: str(s.title_ar) || "العناصر", platform, capability, parent, deliver: s.deliver !== false,
      count: { total: int(c.total), per_parent: int(c.per_parent), all: c.all === true },
      source: src, topic: str(s.topic) || null,
      search_terms: Array.isArray(s.search_terms) ? [...new Set(s.search_terms.map(str).filter(Boolean))].slice(0, 12) : [],
      period: per, language: str(s.language) || null, country: str(s.country) || null, order: s.order === "newest" || s.order === "top" ? s.order : null,
      fields_wanted: Array.isArray(s.fields_wanted) ? s.fields_wanted.map(str).filter(Boolean).slice(0, 12) : [],
    });
  });
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  if (!steps.some((s) => s.deliver)) steps.forEach((s) => { s.deliver = true; });
  return { ok: true, value: { ...base, steps } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 2. CHOOSE
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ToolOption { endpoint: CatalogEndpoint; params: Record<string, unknown>; cursor: string | null; parent: { param: string; from: string } | null; more: Array<Record<string, unknown>>; notCarried: string[] }

/** The model's options checked against the catalog: the id is a candidate, every input is the tool's own (others are dropped), an enum value is one of its values, nothing paging is in the first page. */
export function checkOptions(answer: unknown, candidates: ReadonlyArray<CatalogEndpoint>, isChild: boolean): ToolOption[] {
  const raw = isObj(answer) && Array.isArray(answer.options) ? answer.options : [];
  const out: ToolOption[] = [];
  for (const o of raw.slice(0, 3)) {
    if (!isObj(o)) continue;
    const endpoint = candidates.find((e) => e.id === str(o.endpoint_id));
    if (!endpoint || out.some((x) => x.endpoint.id === endpoint.id)) continue;
    const cfg = missionPageOf(endpoint.id);
    const names = new Set([...endpoint.inputs.map((i) => i.name), ...(endpoint.pagination ?? [])]);
    let cursor = str(o.cursor_input) && names.has(str(o.cursor_input)) ? str(o.cursor_input) : null;
    if (cfg) {
      if (!endpoint.pagination?.includes(cfg.cursorParam) || !endpoint.inputs.some((input) => input.name === cfg.cursorParam && input.type === cfg.cursorType)) continue;
      cursor = cfg.cursorParam;
    }
    const clean = (p: unknown): Record<string, unknown> => {
      const res: Record<string, unknown> = {};
      if (!isObj(p)) return res;
      for (const [k, v] of Object.entries(p)) {
        if (!names.has(k) || k === cursor || !filled(v)) continue;
        const input = endpoint.inputs.find((i) => i.name === k);
        if (input && Array.isArray(input.enum) && input.enum.length > 0 && !input.enum.map(String).includes(String(v))) continue;
        let value = v;
        if (input && (input.type === "integer" || input.type === "number") && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) value = Number(v);
        if (input && typeof value === "number") { const n: number = value; if (typeof input.maximum === "number" && n > input.maximum) value = input.maximum; else if (typeof input.minimum === "number" && n < input.minimum) value = input.minimum; }
        res[k] = value;
      }
      return res;
    };
    const parent = isChild && isObj(o.parent_input) && names.has(str(o.parent_input.param)) && str(o.parent_input.from_field) ? { param: str(o.parent_input.param), from: str(o.parent_input.from_field) } : null;
    if (isChild && !parent) continue;
    if (parent && cursor && parent.param === cursor) continue;
    const params = clean(o.params ?? jsonObject(o.params_json));
    if (parent) delete params[parent.param];
    if (cursor) delete params[cursor];
    const missing = endpoint.inputs.filter((i) => i.required && !filled(params[i.name]) && i.name !== parent?.param && i.name !== cursor);
    if (missing.length > 0) continue;
    const more = (Array.isArray(o.more_params) ? o.more_params : Array.isArray(o.more_params_json) ? o.more_params_json.map(jsonObject) : []).map(clean).filter((p) => Object.keys(p).length > 0 && JSON.stringify(p) !== JSON.stringify(params)).slice(0, 6);
    if (cfg && parent) for (const m of more) delete m[parent.param];
    const notCarried = (Array.isArray(o.conditions_not_carried) ? o.conditions_not_carried : []).map(str).filter((c) => CONDITION_AR[c] !== undefined);
    out.push({ endpoint, params, cursor, parent, more, notCarried: [...new Set(notCarried)] });
  }
  return out;
}

export function toolChoicePrompt(step: UnderstoodStep, candidates: ReadonlyArray<CatalogEndpoint>, today: string, parentSample: ReadonlyArray<Record<string, unknown>> | null): string {
  const view = { ...step };
  return [
    `Today (Cairo): ${today}`,
    "",
    "The step:",
    JSON.stringify(view),
    ...(parentSample ? ["", "Sample items of the parent step (the fields their mapped rows carry):", JSON.stringify(parentSample.slice(0, 2).map((r) => digestValue(r)))] : []),
    "",
    "Candidate tools:",
    JSON.stringify(candidates.map(describeForModel)),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 4. MAP
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface FieldMap { fields: Record<string, string[]>; linkTemplate: { template: string; field: string[] } | null; extra: Array<{ key: string; title_ar: string; path: string[] }> }

const pathOf = (v: unknown): string[] | null => (Array.isArray(v) && v.length > 0 && v.length <= 8 && v.every((k) => typeof k === "string" || typeof k === "number") ? v.map(String) : null);

/** The model's paths, each kept only when it reads a value from at least one real item; the id falls back to the link, then to a field named id. */
export function checkFieldMap(answer: unknown, items: ReadonlyArray<Record<string, unknown>>): FieldMap | null {
  if (!isObj(answer)) return null;
  const f = isObj(answer.fields) ? answer.fields : {};
  const fields: Record<string, string[]> = {};
  const reads = (p: string[]): boolean => items.some((it) => filled(at(it, p)));
  for (const k of ["id", ...COLUMN_ORDER]) { const p = pathOf(f[k]); if (p && reads(p)) fields[k] = p; }
  if (!fields.id) {
    for (const p of [fields.link, ["id"], ["id_str"], ["uuid"], ["url"], ["permalink"]]) if (p && reads(p)) { fields.id = p; break; }
  }
  if (!fields.id) return null;
  const lt = isObj(answer.link_template) && str(answer.link_template.template).includes("{}") ? { template: str(answer.link_template.template), field: pathOf(answer.link_template.field) } : null;
  const linkTemplate = lt && lt.field && reads(lt.field) && /^https?:\/\//.test(lt.template) ? { template: lt.template, field: lt.field } : null;
  const extra: FieldMap["extra"] = [];
  for (const e of Array.isArray(answer.extra) ? answer.extra.slice(0, 8) : []) {
    if (!isObj(e)) continue;
    const key = str(e.key).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 30);
    const p = pathOf(e.path);
    if (!key || !p || !reads(p) || fields[key] || key === "id" || key === "parent_id" || extra.some((x) => x.key === key)) continue;
    extra.push({ key: `x_${key}`, title_ar: str(e.title_ar) || key, path: p });
  }
  return withoutTwinPaths({ fields, linkTemplate, extra });
}

const COUNTER_FIELDS: ReadonlySet<string> = new Set(["likes", "comments_count", "replies_count", "shares", "views"]);
const samePath = (a: string[], b: string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);
/**
 * ONE SOURCE FIELD, ONE COLUMN (live, 16 Nov 2026: a Google Maps place's rating was mapped as «الإعجابات» AND as an extra «التقييم», its number of reviews as «عدد التعليقات» AND «عدد المراجعات», and its name as both
 * «النص» and «العنوان»). A standard counter that reads the same path as an extra column is dropped (the extra's title names what it is); an extra or a later standard column that repeats an earlier one is dropped.
 */
export function withoutTwinPaths(map: FieldMap): FieldMap {
  const fields: Record<string, string[]> = {};
  const isExtra = (p: string[]): boolean => map.extra.some((e) => samePath(e.path, p));
  for (const k of ["id", ...COLUMN_ORDER]) {
    const p = map.fields[k];
    if (!p) continue;
    if (k !== "id" && COUNTER_FIELDS.has(k) && isExtra(p)) continue;
    if (k !== "id" && k !== "link" && Object.entries(fields).some(([o, q]) => o !== "id" && samePath(q, p))) continue;
    fields[k] = p;
  }
  for (const [k, p] of Object.entries(map.fields)) if (!(k in fields) && !COLUMN_ORDER.includes(k) && k !== "id") fields[k] = p;
  const extra: FieldMap["extra"] = [];
  for (const e of map.extra) {
    if (Object.entries(fields).some(([k, q]) => k !== "id" && samePath(q, e.path)) || extra.some((x) => samePath(x.path, e.path))) continue;
    extra.push(e);
  }
  return { fields, linkTemplate: map.linkTemplate, extra };
}

/**
 * Every leaf of the sample items as «path = example» lines (array positions as «0»), deepest first where items are big: a provider's item can hold hundreds of fields under nested objects (TikTok's
 * `aweme_info`), and a cut JSON copy hid the caption, the author and the counters from the model (live, 15 Nov 2026: a TikTok file with links only).
 */
export function flatPathsOf(items: ReadonlyArray<Record<string, unknown>>, maxPaths = 220, maxDepth = 5): string[] {
  const seen = new Map<string, string>();
  const clipV = (v: unknown): string => { const t = typeof v === "string" ? v.replace(/\s+/g, " ") : JSON.stringify(v); return t.length > 90 ? `${t.slice(0, 90)}…` : t; };
  const walk = (v: unknown, path: string[], depth: number) => {
    if (seen.size >= maxPaths * 2) return;
    if (Array.isArray(v)) { if (v.length > 0 && depth < maxDepth) walk(v[0], [...path, "0"], depth + 1); else if (path.length > 0 && !seen.has(path.join("."))) seen.set(path.join("."), "[]"); return; }
    if (isObj(v)) { if (depth >= maxDepth) return; for (const [k, x] of Object.entries(v)) walk(x, [...path, k], depth + 1); return; }
    if (v === null || v === undefined || v === "") return;
    const key = path.map((k) => JSON.stringify(k)).join(",");
    if (!seen.has(key)) seen.set(key, clipV(v));
  };
  for (const it of items.slice(0, 3)) walk(it, [], 0);
  return [...seen.entries()].slice(0, maxPaths).map(([k, v]) => `[${k}] = ${v}`);
}

export function fieldMapPrompt(step: UnderstoodStep, endpoint: CatalogEndpoint, items: ReadonlyArray<Record<string, unknown>>): string {
  const small = items.slice(0, 2).map((it) => JSON.stringify(it)).every((s) => s.length <= 3000);
  return [
    `Tool: ${endpoint.id} — ${str(endpoint.summary ?? endpoint.name).slice(0, 300)}`, `Items of this step: ${step.title_ar} (${step.capability})`,
    ...(step.fields_wanted && step.fields_wanted.length > 0 ? [`Fields the customer asked for: ${step.fields_wanted.join(", ")}`] : []),
    "",
    ...(small ? ["Sample items:", ...items.slice(0, 2).map((it) => JSON.stringify(it))] : ["The items are large: every field of the sample items as [path] = example value (use these exact paths):", ...flatPathsOf(items)]),
  ].join("\n");
}

/** The hand-card shape the existing mapping generator reads, made from the checked paths (the list path is the one the shape reader found on the real page). */
/** An item's own identifiers (an id, a handle, a short code, a place id, a link), kept on the stored row for a later step to read the item by, never shown as columns. */
const ID_LIKE = /(^|_)(id|ids|uid|pk|code|shortcode|short_code|handle|username|user_?name|screen_?name|slug|url|link|permalink|uri)$|(Id|ID|Url|URL|Code|Handle|Name)$/;
export function carryFieldsOf(items: ReadonlyArray<Record<string, unknown>>, map: FieldMap): Record<string, string[]> {
  const taken = new Set([...Object.keys(map.fields), ...map.extra.map((e) => e.key)].map((k) => k.toLowerCase()));
  const out: Record<string, string[]> = {};
  const scalar = (v: unknown): boolean => (typeof v === "string" && v !== "" && v.length <= 300) || (typeof v === "number" && Number.isFinite(v));
  const visit = (o: Record<string, unknown>, prefix: string[], depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (depth < 1 && isObj(v)) { visit(v, [...prefix, k], depth + 1); continue; }
      if (!scalar(v) || !ID_LIKE.test(k)) continue;
      const key = `c_${[...prefix, k].join("_").replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 40);
      if (taken.has(key.toLowerCase()) || out[key]) continue;
      out[key] = [...prefix, k];
    }
  };
  for (const it of items.slice(0, 3)) visit(it, [], 0);
  return Object.fromEntries(Object.entries(out).slice(0, 12));
}

export function pseudoCard(endpoint: CatalogEndpoint, listPath: string | null, map: FieldMap, rowsPerPage: number, carry: Record<string, string[]> = {}, items: ReadonlyArray<Record<string, unknown>> = []): ToolCard {
  // a link's query string is kept only when it NAMES the item (YouTube's watch?v=, Facebook's story_fbid / id): tracking parameters are dropped
  const keepQuery = map.fields.link ? items.some((it) => /[?&](v|id|story_fbid|fbid|p|q)=/.test(String(at(it, map.fields.link!) ?? ""))) : false;
  const list = !listPath || listPath === "root" ? [] : listPath.split(".");
  const fields: Record<string, string[]> = { ...map.fields, ...carry };
  for (const e of map.extra) fields[e.key] = e.path;
  return {
    endpointId: endpoint.id, platform: endpoint.platform as never, role: "posts.search", status: "verified",
    inputs: { cursor: null }, page: { list, cursor: null, observedRowsPerPage: Math.max(1, rowsPerPage) },
    mapping: { kind: "fields", fields, ...(map.linkTemplate ? { linkTemplate: map.linkTemplate } : {}), ...(keepQuery ? { keepLinkQuery: true as const } : {}), numeric: ["likes", "comments_count", "replies_count", "shares", "views"].filter((k) => fields[k]) },
    counter: null, costUsdPerPage: callUsdOf(endpoint), verifiedOn: [],
  };
}

/** Runs generated mapping code on one page, as the engine's sandbox would (pure: the code reads only its input). */
export function runMap(code: string, page: unknown): Array<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("inputs", code) as (inputs: Record<string, unknown>) => unknown;
  try { const out = fn({ page }); return Array.isArray(out) ? (out.filter(isObj) as Array<Record<string, unknown>>) : []; } catch { return []; }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE PLANNER
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

interface PageSample {
  rowsPerPage: number;
  chargedUsd: number;
  checkedParams: Record<string, unknown>;
}

interface BuiltStep {
  step: UnderstoodStep; option: ToolOption; mapCode: string; columns: PlanColumn[]; carryKeys: string[]; sampleRows: Array<Record<string, unknown>>; rowsPerPage: number; callIds: string[]; hasMore: boolean; nextCursor?: string | null;
  /** A SECOND tool that also answered on a real page, with its own proven mapping: execution continues with it when the first tool's input sets run out (another index gives other items). */
  second?: { option: ToolOption; mapCode: string; sample?: PageSample };
  sample?: PageSample;
  variantSamples?: Map<Record<string, unknown>, PageSample>;
  /** OUR OWN WEB SEARCH (Firecrawl / Context.dev) as the last fallback of a web or news search, proven on a real page: execution reads it after the catalog's tools run out. */
  webFallbacks?: Array<{ option: ToolOption; mapCode: string }>;
  /** A lookup step resolved to the one named thing: its children are bound to that thing's own value, and it is not a stage of the plan. */
  lookup?: true;
}

const asJson = (text: unknown): unknown => text;

/** Asks the model through the deps and counts what it cost. */
function asker(deps: Pick<LlmPlannerDeps, "model">, cost: { usd: number; refused?: boolean }) {
  return async (system: string, user: string, tool: { name: string; description: string; schema: Record<string, unknown> }, maxTokens: number): Promise<unknown | null> => {
    const got = await deps.model({ system, user, tool, maxTokens });
    if (!got) return null;
    cost.usd += Math.max(0, Number(got.costUsd) || 0);
    if (got.refused === true) cost.refused = true;
    return asJson(got.input);
  };
}

/**
 * THE RETRY NEVER LOSES WHAT THE MODEL ALREADY SAID ABOUT THE CUSTOMER'S REQUEST (DT-20261119-04, live after #580: «شركتين مقاولات … ومسؤولي الإدارة فيهم بأرقامهم الشخصية» became a card of companies and company phones with no people step and no unserved block).
 * A refused «ask» is followed by a retry whose answer REPLACES the first one; the people of the companies live only in that answer. When the first answer said the people were asked and the retry says no people at all (no `people_of_companies`, no people step),
 * the first answer's `people_of_companies` is restored, so the plan check demands a people stage or an honest unserved step; when the retry asks them too but gives no contact kind, the first answer's kinds complete it. A retry that asks the people with its
 * own contact kinds stands as it is (nothing changes); a retry that wrote a people step but no people ask gets the first answer's ask (its contact kinds) back (FIX1, QA: the phone was lost). Reads the model's two ANSWERS only: no word of the customer's request is read.
 */
export function withKeptPeopleAsk(retry: Understanding, refused: Understanding | null): Understanding {
  // (checkUnderstanding keeps `people_of_companies` only when the people were asked, so its presence is the first answer's «asked»)
  const first = refused?.people_of_companies;
  if (!first) return retry;
  const now = retry.people_of_companies;
  if (now?.asked === true) return now.contact_kinds.length > 0 || first.contact_kinds.length === 0 ? retry : { ...retry, people_of_companies: { ...now, contact_kinds: first.contact_kinds } };
  // a retry that wrote the people step but no people ask has lost the contact kinds (they live only in the ask): they come back with the first answer's ask; with no kind to keep the retry stands as it is
  if (retry.steps.some((s) => s.parent !== null && isPeopleOfCompanyStep(s))) return first.contact_kinds.length > 0 ? { ...retry, people_of_companies: first } : retry;
  return { ...retry, people_of_companies: first };
}

/** 1. UNDERSTAND, with one retry carrying code's objection. */
export async function understandRequest(input: LlmPlannerInput, deps: Pick<LlmPlannerDeps, "model" | "catalog" | "access" | "today" | "log">, cost: { usd: number; refused?: boolean } = { usd: 0 }): Promise<{ ok: true; value: Understanding } | { ok: false; error: string; understanding?: Understanding }> {
  const ask = asker(deps, cost);
  const system = `${UNDERSTAND_SYSTEM}\n\nCATALOG INDEX (platform: capability(number of tools), …):\n${platformIndex(deps.catalog, deps.access)}${peopleOfCompanyHint(deps.catalog, deps.access) ? `\n\n${peopleOfCompanyHint(deps.catalog, deps.access)}` : ""}`;
  const tool = { name: UNDERSTAND_TOOL, description: "The collection plan for the customer's request.", schema: UNDERSTAND_SCHEMA };
  const userPrompt = understandPrompt(input, deps.today);
  let checked: ReturnType<typeof checkUnderstanding> | null = null;
  // an «ask» that names nothing missing is never shown: the second attempt has a schema with no «ask» (DT-20261119-03)
  let refusedAsk: Understanding | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const noAsk = attempt === 1 && refusedAsk !== null;
    const retryText = noAsk ? `${userPrompt}\n\n${DECIDE_IT_AR_EN}` : `${userPrompt}\n\nYour previous answer could not be used: ${checked && !checked.ok ? checked.error : "no answer"}. Answer again using only names from the catalog index.`;
    const answer = await ask(system, attempt === 0 ? userPrompt : retryText, noAsk ? { ...tool, schema: UNDERSTAND_SCHEMA_NO_ASK } : tool, 4000);
    checked = answer === null ? { ok: false, error: "no answer" } : checkUnderstanding(answer, deps.catalog, deps.access);
    if (checked.ok && !askIsEarned(checked.value)) {
      refusedAsk = checked.value;
      deps.log?.(`llm_planner_ask_refused missing=${(checked.value.missing ?? []).join(",") || "none"}`);
      checked = { ok: false, error: "ask_refused" };
      continue;
    }
    if (checked.ok) break;
    deps.log?.(`llm_planner_understand_retry ${checked.error.slice(0, 200)}`);
  }
  // the model asked again although it had no «ask» to give: the customer is NOT asked; the earlier path runs with this understanding (and may not ask either)
  const said = customerSaidOf(input);
  if (checked && !checked.ok && refusedAsk !== null && checked.error === "ask_refused") return { ok: false, error: "ask_refused", understanding: withCheckedCompaniesCount(refusedAsk, said) };
  if (checked && !checked.ok && refusedAsk !== null && cost.refused !== true) return { ok: false, error: "ask_refused", understanding: withCheckedCompaniesCount(refusedAsk, said) };
  if (checked && !checked.ok && cost.refused === true) return { ok: false, error: "refused" };
  if (checked?.ok) return { ok: true, value: withCheckedCompaniesCount(withCheckedPerCompany(withKeptPeopleAsk(checked.value, refusedAsk), said), said) };
  return checked ?? { ok: false, error: "no answer" };
}

/** The model declined the request twice (live eval 16 Nov 2026: «the private messages of an Instagram account»): the customer is told what the platform collects, never a vague «no source». */
export const REFUSED_REQUEST_AR = "لا نستطيع تنفيذ هذا الطلب: نجمع البيانات العامة المنشورة على المنصات فقط، وليس الرسائل الخاصة ولا الحسابات المغلقة. إن كان لديك طلب على بيانات عامة فاكتبه وسنجهّزه لك.";

/**
 * WHAT THE CUSTOMER SAID, for the checks of a count (DT-20261118-08 FIX2, Gate 2 r2 P1-C): their own messages AND their answers to the questions of this planning (`answer`, `exchanges`): a count given only
 * in an answer is theirs. Never the questions, the chat's summary or the earlier conversation (the model wrote or read those, they are not what the customer wrote for this request).
 */
export function customerSaidOf(input: Pick<LlmPlannerInput, "words" | "answer" | "exchanges">): string[] {
  return [...input.words, ...(input.exchanges ?? []).map((e) => e.answer), ...(input.answer ? [input.answer] : [])].filter((w) => typeof w === "string" && w.trim() !== "");
}

/**
 * THE COUNT OF PEOPLE PER COMPANY IS ONE THE CUSTOMER WROTE (DT-20261118-08 FIX1 P1-3, FIX2): a count the model returned for the people of each company, in `people_of_companies.per_company` AND in the `per_parent` of every
 * people-of-company step it wrote, is kept only when the customer's own words hold it (#575's check: the number is written, or the words the model cites are in what the customer said and say that number) and it is not the count
 * of the companies themselves (the model copying «شركتين» or «٥ شركات» into it; the same number written twice is the customer's). The companies' count is the parent step's total, or, when the model wrote no company step
 * («cannot»), the words it cites for it (`companies_text`) checked the same way. FIX3 (QA, Gate 2 r3 P1-1) and FIX4: when NO company count can be established (no parent total, and `companies_text` empty or not in what the customer said) a per-company
 * count that is itself the count of another noun than the people («شركتين»، «٥٠ شركة»، «لشركتين»، «٥شركات»: see isCountOfOtherNoun) may be the companies' own copied, so it is not trusted: the fail-safe is «not given»;
 * a bare per-company amount the customer wrote is kept. A count that fails is «not given»: code's default count is used and the card says so («لم تحدد عدد … فاعتمدنا …»), where the customer can change it before approving.
 */
export function withCheckedPerCompany(u: Understanding, said: ReadonlyArray<string>): Understanding {
  const ask = u.people_of_companies;
  const message = said.join("\n");
  const companies = u.steps.find((s) => s.parent === null)?.count.total ?? countWrittenIn(message, ask?.companies_text || null);
  const keep = (n: number, cited: string): number | null => {
    const rawWritten = countSupportedByMessage(message, n, cited || null);
    const singularOne = n === 1 && rawWritten === null && isSingularPerParentCitation(message, cited || (ask?.per_company_text ?? ""));
    const written = singularOne ? 1 : rawWritten;
    // FIX3/FIX4: no company count to compare with → a number that counts ANOTHER noun than the people (the dual «شركتين», «٥٠ شركة», «لشركتين», «٥شركات») may be the companies' own, copied: «not given» (the default count and the «فاعتمدنا» line; the
    // customer can edit it on the card). A bare amount («اتنين»، «٣ مديرين», «٣ من كل شركة») or distributive singular («من كل شركة مدير» / «ومدير كل شركة») is the customer's per-company count and is kept.
    if (written !== null && !singularOne && companies === null && isCountOfOtherNoun(message, cited, written, ask?.title_ar ?? "")) return null;
    // the number of the companies copied into per_company is dropped, unless the customer also wrote that number outside the cited words («٣ شركات ومن كل شركة ٣ مديرين»، «شركتين … مديرين اتنين»), or singular distributive («١ شركة ومدير كل شركة»)
    return written !== null && (singularOne || written !== companies || writtenElsewhere(message, cited, written)) ? written : null;
  };
  const per = ask ? (ask.per_company !== null ? keep(ask.per_company, ask.per_company_text) : (isSingularPerParentCitation(message, ask.per_company_text) ? 1 : null)) : null;
  let changed = ask !== undefined && ask.per_company !== null && per !== ask.per_company;
  const steps = u.steps.map((s) => {
    if (s.parent === null || s.count.per_parent === null || !isPeopleOfCompanyStep(s)) return s;
    // a people step's own count has no cited words: the words of the answer field are used when it is the same number
    const kept = keep(s.count.per_parent, ask && ask.per_company === s.count.per_parent ? ask.per_company_text : "");
    if (kept === s.count.per_parent) return s;
    changed = true;
    return { ...s, count: { ...s.count, per_parent: kept } };
  });
  return changed ? { ...u, steps, ...(ask ? { people_of_companies: { ...ask, per_company: per } } : {}) } : u;
}

/**
 * THE COUNT OF COMPANIES THE CUSTOMER'S OWN WORDS SUPPORT (DT-20261119-05, F1):
 * The planner's companies count is kept only when the words the model cites for it (companies_text)
 * are in what the customer said, say that number, contain a noun word (>=4 letters, not a number word),
 * and count a noun that is NOT the people's. The model's total is never used directly as it can copy
 * a year, '3M', a phone number, or a per-company count.
 */
export function withCheckedCompaniesCount(u: Understanding, said: ReadonlyArray<string>): Understanding {
  const ask = u.people_of_companies;
  const peopleStep = u.steps.find((s) => s.parent !== null && isPeopleOfCompanyStep(s));
  if (ask?.asked !== true && !peopleStep) return u;
  const cited = ask?.companies_text ?? "";
  const title = ask?.title_ar || peopleStep?.title_ar || "";
  if (cited === "" || title === "") return u;
  const message = said.join("\n");
  const n = countWrittenIn(message, cited);
  if (n === null || n < 1) return u;
  const citedNouns = tokensOf(cited).filter((t) => /^\p{L}{4,}$/u.test(t) && wordNumbersIn(t, 1).length === 0);
  // the cited noun names the ROOT ENTITY (FIX2/FIX3: this, not the model's per-company field, decides: the same cite copied into both fields binds when it is the companies' noun and never when it is a people noun): never a people noun (isPeopleNoun, the structural helper the plan check already uses)
  if (citedNouns.length === 0 || citedNouns.some((c) => isPeopleNoun(c))) return u;
  // the cited noun must be the COMPANIES' own noun: it matches a word of the companies step's title (or of the fixed label of the parent), never only «not the people's title» (a generic people title let «مديرين» or «مهندسين» through)
  // ...and matches the HEAD noun of the root step's title (the first word of its own words: «شركات الكهروميكانيكا وبيانات المديرين» has the head «شركات», not «المديرين»), or the fixed label of the parent
  const rootHead = ownTitleWords(u.steps.find((s) => s.parent === null)?.title_ar ?? "")[0] ?? "";
  const heads = [rootHead, COMPANIES_LABEL_AR];
  if (!citedNouns.some((c) => heads.some((h) => h !== "" && sameNounStem(h, c)))) return u;
  if (!isCountOfOtherNoun(message, cited, n, title)) return u;
  return { ...u, companies_count: n };
}

/** 2. CHOOSE: the model's options for one step, checked against its candidates. */
export async function chooseTools(step: UnderstoodStep, parentSample: ReadonlyArray<Record<string, unknown>> | null, deps: Pick<LlmPlannerDeps, "model" | "catalog" | "access" | "today" | "webTools">, cost: { usd: number } = { usd: 0 }): Promise<{ candidates: CatalogEndpoint[]; options: ToolOption[] }> {
  const candidates = candidatesFor(deps.catalog, deps.access, step.platform, step.capability, 8, { alsoSearch: Boolean(step.source && step.topic && !step.parent), ...(deps.webTools && deps.webTools.length > 0 ? { web: deps.webTools } : {}) });
  if (candidates.length === 0) return { candidates, options: [] };
  const choice = await asker(deps, cost)(TOOL_CHOICE_SYSTEM, toolChoicePrompt(step, candidates, deps.today, parentSample), { name: TOOL_CHOICE_TOOL, description: "The tool and its inputs for this step.", schema: TOOL_CHOICE_SCHEMA }, 3000);
  const options = checkOptions(choice, candidates, parentSample !== null);
  if (step.parent && (step.count.total !== null || step.count.per_parent !== null) && options.length > 1) {
    const prefIdx = options.findIndex((o) => {
      const cfg = missionPageOf(o.endpoint.id);
      return cfg?.preferForCount === true && o.cursor !== null;
    });
    if (prefIdx > 0) {
      const [pref] = options.splice(prefIdx, 1);
      options.unshift(pref);
    }
  }
  return { candidates, options };
}

const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
/** «١٦ أكتوبر» from a day «2026-10-16» (and its year); null when it is not a day. */
function dayAr(day: string | null | undefined): { text: string; year: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? ""));
  if (!m) return null;
  return { text: `${toArabicDigits(Number(m[3]))} ${MONTHS_AR[Number(m[2]) - 1] ?? ""}`, year: Number(m[1]) };
}
/**
 * THE REQUEST LINE OF THE CARD (card redesign, 16 Nov 2026): the parts of what the customer asked for, read from the understanding (the platform, the topic, the period), so the card can say
 * «٣٠ تغريدة · إكس · لقاح الإنفلونزا · ١٦ أكتوبر – ١٦ نوفمبر ٢٠٢٦» in every state. Display only; the count is the card's own.
 */
export function requestPartsAr(steps: ReadonlyArray<UnderstoodStep>, said: ReadonlyArray<string>): string[] {
  const top = steps.filter((s) => !s.parent);
  const first = top[0] ?? steps[0];
  if (!first) return [];
  const parts: string[] = [[...new Set((top.length > 0 ? top : steps).map((s) => platformAr(s.platform, s.capability, said)))].join(" و")];
  const topic = String(first.topic ?? "").trim();
  // the topic is shown as the customer-text check returns it: no Latin word the customer did not write, and a source they did not name replaced by «المصدر» (DT-20261118-09 S1, S2; FIX1: never the model's own text);
  // a topic that is only that neutral word says nothing the first part has not said
  const shown = topic && topic.length <= 60 ? customerSafe(topic, 60, said) : null;
  if (shown !== null && shown !== PLATFORM_LABEL_FALLBACK_AR) parts.push(shown);
  const from = dayAr(first.period?.from), to = dayAr(first.period?.to);
  if (from && to) parts.push(`${from.text} – ${to.text} ${toArabicDigits(to.year)}`);
  return parts.filter(Boolean);
}

export async function planWithLlm(input: LlmPlannerInput, deps: LlmPlannerDeps): Promise<LlmPlanResult> {
  const cost = { usd: 0 };
  const ask = asker(deps, cost);
  const checked = await understandRequest(input, deps, cost);
  let costUsd = cost.usd;
  if (!checked.ok && checked.error === "ask_refused") return { kind: "cannot", reason_ar: "", understanding: checked.understanding ?? null, costUsd, detail: "ask_refused" };
  if (!checked.ok) return { kind: "cannot", reason_ar: checked.error === "refused" ? REFUSED_REQUEST_AR : "", understanding: null, costUsd, detail: `understand_failed: ${checked.error}` };
  const u = checked.value;
  const said = customerSaidOf(input);
  if (u.decision === "ask") return { kind: "question", question_ar: customerSafe(u.question_ar, 400, said) ?? GENERIC_QUESTION_AR, options_ar: (u.options_ar ?? []).map((o) => customerSafe(o, 80, said)).filter((o): o is string => o !== null), understanding: u, costUsd };
  // a «cannot» (live: «لم يثبت أي مصدر متاح…») is not the answer when the caller's other path serves what was understood: the people of the companies the catalog can give (DT-20261118-08)
  if (u.decision === "cannot") return deps.accept && !deps.accept(u) ? { kind: "cannot", reason_ar: "", understanding: u, costUsd, detail: "handed_over" } : { kind: "cannot", reason_ar: customerSafe(u.cannot_ar ?? u.understanding_ar, 400, said) ?? "", understanding: u, costUsd, detail: "model_cannot" };
  if (deps.accept && !deps.accept(u)) return { kind: "cannot", reason_ar: "", understanding: u, costUsd, detail: "handed_over" };
  const say = async (line: string | null): Promise<void> => { if (line && deps.onProgress) await deps.onProgress(line).catch(() => undefined); };
  await say(customerSafe(`فهمنا طلبك: ${u.understanding_ar.replace(/[.،\s]+$/u, "")}.`, 400, said) ?? "فهمنا طلبك، ونختار الآن المصادر المناسبة له.");

  // 2-4. EVERY STEP, parents first (the model's order already is: a parent must be an earlier step)
  const built = new Map<string, BuiltStep>();
  const findings: ScoutFinding[] = [];
  const unserved: Array<{ what_ar: string; reason_ar: string }> = [];
  for (const step of u.steps) {
    const parent = step.parent ? built.get(step.parent) ?? null : null;
    if (step.parent && !parent) { unserved.push({ what_ar: step.title_ar, reason_ar: "لم نتمكن من قراءة الخطوة التي تسبقها، فلن تُضاف هذه الخطوة ولن تُحسب في السعر." }); continue; }
    await say(customerSafe(`نختار المصدر المناسب لجمع ${step.title_ar} من ${platformAr(step.platform, step.capability, said)} ونجرب عينة حقيقية منه.`, 200, said));
    const { candidates, options } = await chooseTools(step, parent ? parent.sampleRows : null, deps, cost);
    if (candidates.length === 0) { unserved.push({ what_ar: step.title_ar, reason_ar: "لا توجد لدينا أداة متاحة لهذه الخطوة الآن، فلن تُضاف ولن تُحسب في السعر." }); continue; }
    deps.log?.(`llm_planner_options ${step.key} ${options.map((o) => o.endpoint.id).join(",") || "none"}`);
    const trace = { empties: 0, failures: 0, uncertain: false };
    const got = await probeStep(step, options, parent, deps, { left: MAX_PROBES_PER_STEP }, trace);
    // a source that answered with nothing, for every input set tried, is a finding too (the customer is asked; a tool that failed is not "nothing found")
    // (a tool that answered empty on its searches is evidence even when another option of the step failed to answer at all: live 16 Nov, the second option was refused)
    if (!got && !step.parent && trace.empties > 0 && !trace.uncertain) findings.push({ step, requested: step.count.total ?? DEFAULT_COUNT, found: 0, exhausted: true, sets: trace.empties });
    if (!got) { unserved.push({ what_ar: step.title_ar, reason_ar: "جرّبنا الأدوات المتاحة لهذه الخطوة فلم تُعطِ نتائج الآن، فلن تُضاف ولن تُحسب في السعر." }); continue; }
    const mapAnswer = await ask(FIELD_MAP_SYSTEM, fieldMapPrompt(step, got.option.endpoint, got.items), { name: FIELD_MAP_TOOL, description: "Where each column is in an item.", schema: FIELD_MAP_SCHEMA }, 1500);
    const map = enrichedMap(checkFieldMap(mapAnswer, got.items), got.items);
    // the source answered, but nothing usable came back for a top-level step (a named account that does not exist answers with a stray item): for the customer that is «nothing found», so they are asked, not told «unreadable»
    const noUsable = (): void => { if (!step.parent) findings.push({ step, requested: step.count.total ?? DEFAULT_COUNT, found: 0, exhausted: true, sets: Math.max(1, trace.empties + 1) }); };
    if (!map) { noUsable(); unserved.push({ what_ar: step.title_ar, reason_ar: "لم نتمكن من قراءة نتائج هذه الخطوة بشكل موثوق، فلن تُضاف ولن تُحسب في السعر." }); continue; }
    const carry = carryFieldsOf(got.items, map);
    const card = pseudoCard(got.option.endpoint, got.listPath, map, got.items.length, carry, got.items);
    const mapCode = cardMapCode(card);
    const sampleRows = runMap(mapCode, got.page);
    if (sampleRows.length === 0) { noUsable(); unserved.push({ what_ar: step.title_ar, reason_ar: "لم نتمكن من قراءة نتائج هذه الخطوة بشكل موثوق، فلن تُضاف ولن تُحسب في السعر." }); continue; }
    const sample = pageSample(sampleRows, got.checkedParams, got.chargedUsd);
    const variantSamples = new Map<Record<string, unknown>, PageSample>();
    const columns: PlanColumn[] = [...COLUMN_ORDER.filter((k) => map.fields[k] || (k === "link" && map.linkTemplate)).map((k) => ({ key: k, title_ar: COLUMN_TITLES[k] })), ...map.extra.map((e) => ({ key: e.key, title_ar: e.title_ar }))];
    step.title_ar = customerSafe(step.title_ar, 60, said) ?? "العناصر";
    // ASKED FOR 400, GET 400: a topic search also proves the model's next tool (another provider's index gives other items); execution reads it after the first tool's input sets run out
    let second: BuiltStep["second"];
    const secondRows: Array<Record<string, unknown>> = [];
    let secondMore = false;
    const configuredChild = Boolean(parent && missionPageOf(got.option.endpoint.id));
    const canTryChildAlternate = configuredChild && (parent?.lookup || step.count.per_parent !== null);
    const next = canTryChildAlternate || (!step.parent && step.topic)
      ? options.find((o) => o.endpoint.id !== got.option.endpoint.id && Boolean(o.parent) === Boolean(parent)
        && (!configuredChild || (o.endpoint.capability === step.capability && parent?.sampleRows.some((row) => filled(row[o.parent!.from])))))
      : undefined;
    if (next) {
      const got2 = configuredChild
        ? await probeStep(step, [next], parent, deps, { left: MAX_PROBES_PER_STEP - got.callIds.length })
        : await probeStep(step, [next], null, deps, { left: MAX_PROBES_PER_STEP });
      if (got2) {
        const map2 = enrichedMap(checkFieldMap(await ask(FIELD_MAP_SYSTEM, fieldMapPrompt(step, got2.option.endpoint, got2.items), { name: FIELD_MAP_TOOL, description: "Where each column is in an item.", schema: FIELD_MAP_SCHEMA }, 1500), got2.items), got2.items);
        if (map2) {
          const code2 = cardMapCode(pseudoCard(got2.option.endpoint, got2.listPath, map2, got2.items.length, carryFieldsOf(got2.items, map2), got2.items));
          const rows2 = runMap(code2, got2.page);
          if (rows2.length > 0) { second = { option: got2.option, mapCode: code2, sample: pageSample(rows2, got2.checkedParams, got2.chargedUsd) }; secondRows.push(...rows2); secondMore = got2.hasMore && rows2.length >= Math.min(THIN_PAGE_ROWS, step.count.total ?? THIN_PAGE_ROWS); }
        }
      }
    }
    // OUR OWN WEB SEARCH AS THE LAST FALLBACK (owner direction, 16 Nov 2026: «use providers other than TREG so the customer gets the whole order»): a web or news search whose real sample is short of the number
    // also proves a direct web tool on the step's own search phrases; execution reads it after every catalog tool has run out.
    const webFallbacks: NonNullable<BuiltStep["webFallbacks"]> = [];
    const webRows: Array<Record<string, unknown>> = [];
    const phrases = [...new Set([step.topic, ...(Array.isArray(step.search_terms) ? step.search_terms : [])].map((t) => String(t ?? "").trim()).filter((t) => t.length >= 2))].slice(0, 5);
    let triedFirstWeb = false;
    const webEligible = !step.parent && Boolean(step.topic) && SEARCH_ENGINE_PLATFORMS.has(step.platform) && !got.hasMore && sampleRows.length + secondRows.length < (step.count.total ?? DEFAULT_COUNT) && phrases.length > 0;
    const searchOrNews = /(^|\.)(search|news)(\.|$)/.test(String(step.capability ?? ""));
    const webTool = deps.webTools?.[0];
    const usedWeb = [got.option.endpoint.id, second?.option.endpoint.id].some((id) => (deps.webTools ?? []).some((w) => w.id === id));
    if (webTool && !usedWeb && webEligible) {
      const webOption: ToolOption = { endpoint: webTool, params: { query: phrases[0], limit: 30 }, cursor: null, parent: null, more: phrases.slice(1).map((q) => ({ query: q, limit: 30 })), notCarried: [] };
      triedFirstWeb = true;
      const got3 = await probeStep(step, [webOption], null, deps, { left: MAX_PROBES_PER_STEP });
      if (got3) {
        const map3 = enrichedMap(checkFieldMap(await ask(FIELD_MAP_SYSTEM, fieldMapPrompt(step, got3.option.endpoint, got3.items), { name: FIELD_MAP_TOOL, description: "Where each column is in an item.", schema: FIELD_MAP_SCHEMA }, 1500), got3.items), got3.items);
        if (map3) {
          const code3 = cardMapCode(pseudoCard(got3.option.endpoint, got3.listPath, map3, got3.items.length, carryFieldsOf(got3.items, map3), got3.items));
          const rows3 = runMap(code3, got3.page);
          if (rows3.length > 0) { webFallbacks.push({ option: got3.option, mapCode: code3 }); webRows.push(...rows3); }
        }
      }
      deps.log?.(`llm_planner_web_fallback ${step.key} ${webTool.id} rows=${webRows.length}`);
    }
    const webIds = new Set((deps.webTools ?? []).map((w) => w.id));
    const taken = new Set<string>([got.option.endpoint.id, ...(second ? [second.option.endpoint.id] : []), ...(webTool && triedFirstWeb ? [webTool.id] : []), ...webFallbacks.map((w) => w.option.endpoint.id)]);
    const otherWeb = (deps.webTools ?? []).find((w) => !taken.has(w.id));
    const proven = webFallbacks[0] ?? (webIds.has(got.option.endpoint.id) ? { option: got.option, mapCode } : second && webIds.has(second.option.endpoint.id) ? second : undefined);
    if (otherWeb && webEligible && searchOrNews) {
      if (proven && !proven.option.parent) {
        // R3-A: the different provider reuses the PROVEN option's inputs and map: 0 billed calls, 0 model calls.
        // The input sets are de-duplicated among THEMSELVES only (this is the only de-duplication in the change).
        const sets: Array<Record<string, unknown>> = [];
        for (const p of [proven.option.params, ...proven.option.more]) if (!sets.some((q) => JSON.stringify(q) === JSON.stringify(p))) sets.push(p);
        webFallbacks.push({ option: { endpoint: otherWeb, params: sets[0], cursor: null, parent: null, more: sets.slice(1), notCarried: [] }, mapCode: proven.mapCode });
      } else if (!proven && triedFirstWeb) {
        // R3-B: the first web tool gave nothing usable: ONE probe, ONE phrase, no retry
        const fcOption: ToolOption = { endpoint: otherWeb, params: { query: phrases[0], limit: 30 }, cursor: null, parent: null, more: [], notCarried: [] };
        const gotFc = await probeStep(step, [fcOption], null, deps, { left: MAX_PROBES_PER_STEP });
        if (gotFc) {
          const mapFc = enrichedMap(checkFieldMap(await ask(FIELD_MAP_SYSTEM, fieldMapPrompt(step, gotFc.option.endpoint, gotFc.items), { name: FIELD_MAP_TOOL, description: "Where each column is in an item.", schema: FIELD_MAP_SCHEMA }, 1500), gotFc.items), gotFc.items);
          if (mapFc) {
            const codeFc = cardMapCode(pseudoCard(gotFc.option.endpoint, gotFc.listPath, mapFc, gotFc.items.length, carryFieldsOf(gotFc.items, mapFc), gotFc.items));
            const rowsFc = runMap(codeFc, gotFc.page);
            if (rowsFc.length > 0) { webFallbacks.push({ option: gotFc.option, mapCode: codeFc }); webRows.push(...rowsFc); }   // the sample rows feed the scout (extraRows, planner.ts:571)
          }
        }
        deps.log?.(`llm_planner_web_fallback ${step.key} ${otherWeb.id} rows=${webRows.length}`);
      }
    }
    // A LOOKUP STEP (the one named app, place or product the customer's items belong to): the search's FIRST result is not the thing (live, 16 Nov 2026: Google Play's search for «InstaPay» answered Fawry first, and 100 Fawry
    // reviews were delivered as InstaPay's). The model picks the result that IS the named thing; none of them: the customer is asked for its link, nothing is planned on a guess.
    if (isLookupStep(step, u.steps)) {
      const at = await pickNamedItem(step, sampleRows, ask, (input.exchanges ?? []).map((e) => e.answer));
      deps.log?.(`llm_planner_lookup ${step.key} picked=${at}`);
      if (at < 0) return { kind: "question", question_ar: `بحثنا في ${platformAr(step.platform, step.capability, said)} عن الذي ذكرته بالاسم ولم نجده بين النتائج بشكل مؤكد. ممكن ترسل رابطه أو اسمه كما يظهر هناك بالضبط؟`, options_ar: [ANY_RESULT_OPTION_AR], understanding: u, costUsd: cost.usd };
      sampleRows.splice(0, sampleRows.length, sampleRows[at]!);
    }
    built.set(step.key, { step, option: got.option, mapCode, columns, carryKeys: Object.keys(carry), sampleRows, sample, variantSamples, rowsPerPage: got.items.length, callIds: got.callIds, hasMore: got.hasMore, nextCursor: got.nextCursor, ...(second ? { second } : {}), ...(webFallbacks.length > 0 ? { webFallbacks } : {}), ...(isLookupStep(step, u.steps) ? { lookup: true as const } : {}) });
    // SCOUTING: how much does the source really hold for this request? (a source that shows one page for a query and no next page is read once for each of the model's other input sets, and the sets' items are counted once)
    // THE ITEMS OF ONE FOUND THING (the reviews of the one product the lookup found) are a top-level request in all but name: a source that answered them all on one page, with no next page, is what exists
    // (live, 16 Nov 2026: 10 Amazon reviews with no next page were planned silently as 20, and 10 were delivered)
    if (step.parent && built.get(step.parent)?.lookup && step.count.total !== null && input.scoutAllowed !== false && !got.hasMore && webFallbacks.length === 0) {
      const found = new Set(sampleRows.map(rowKeyOf)).size;
      deps.log?.(`llm_planner_scout ${step.key} found=${found} requested=${step.count.total} exhausted=${found < step.count.total} sets=1 (one found item)`);
      findings.push({ step, requested: step.count.total, found, exhausted: found < step.count.total, sets: 1 });
    }
    if (!step.parent && step.count.total !== null && input.scoutAllowed !== false) {
      const y = await scoutYield({ option: got.option, mapCode, firstRows: sampleRows, hasMore: got.hasMore, nextCursor: got.nextCursor, otherHasMore: secondMore, extraRows: [...secondRows, ...webRows], requested: step.count.total,
        onSample: (params, rows, chargedUsd) => {
          const observed = pageSample(rows, params, chargedUsd);
          if (!observed.rowsPerPage) return;
          if (params === got.option.params) {
            sample.rowsPerPage = Math.min(sample.rowsPerPage, observed.rowsPerPage);
            sample.chargedUsd = Math.max(sample.chargedUsd, observed.chargedUsd);
          } else {
            variantSamples.set(params, observed);
          }
        },
      }, deps);
      deps.log?.(`llm_planner_scout ${step.key} found=${y.found} requested=${step.count.total} exhausted=${y.exhausted} sets=${y.sets}`);
      findings.push({ step, requested: step.count.total, found: y.found, exhausted: y.exhausted, sets: y.sets });
    }
  }
  // THE CONVERSATION: the real search found far less than the customer asked for → the customer is told what was found and chooses (take it, or widen); the model re-plans from the answer. Asked at most twice per mission,
  // and never after the customer accepted what exists. Nothing is dropped and nothing is hidden: the customer decides with the facts in front of them.
  const weak = findings.filter((f) => f.exhausted && f.found < Math.max(1, Math.ceil(f.requested * SCOUT_SHORT_SHARE)));
  if (weak.length > 0 && input.scoutAllowed !== false && !u.accepts_available) {
    await say("جرّبنا عينة حقيقية ووجدنا أقل مما طلبت، فنعرض عليك الموقف لتختار كيف نكمل.");
    const q = await scoutQuestion(u, weak, input, deps, cost);
    return { kind: "question", question_ar: q.question_ar, options_ar: q.options_ar, understanding: u, costUsd: cost.usd, scout: true };
  }
  costUsd = cost.usd;
  // a plan delivers something: when only an intermediate step was read (live, 16 Nov 2026: the Amazon product was found, its reviews tool timed out three times), the customer is told honestly, never priced at zero rows nor sent to another path
  if (![...built.values()].some((b) => b.step.deliver)) return { kind: "cannot", reason_ar: unserved.find((x) => x.reason_ar)?.reason_ar ?? "", understanding: u, costUsd, detail: "no_step_served" };

  // THE CUSTOMER ACCEPTED WHAT EXISTS (their answer to the question about what the real search found): the plan targets what was found, and says so (live, 16 Nov 2026: after «سلّمني الموجود» the plan still read
  // «هتستلم ٢٠ تقييمًا» and the end «١٠ من ٢٠»)
  if (u.accepts_available) {
    for (const f of findings) {
      if (!f.exhausted || f.found <= 0 || f.found >= f.requested) continue;
      f.step.count = { ...f.step.count, total: f.found };
      u.assumptions_ar = [...(u.assumptions_ar ?? []), `طلبتَ ${toArabicDigits(f.requested)}، ووافقت على تسليم الموجود فعلًا من ${f.step.title_ar}: نحو ${toArabicDigits(f.found)}.`];
    }
  }
  // 5. PRICE
  await say("بنجهز العدد والسعر من العينة الحقيقية.");
  const original = [...built.values()];
  const bound = bindLookups(original);
  const delivered = bound.filter((b) => b.step.deliver);
  if (delivered.length === 0) return { kind: "cannot", reason_ar: "لم نجد مصدرًا متاحًا الآن يعطي ما طلبته.", understanding: u, costUsd, detail: "no_step_served" };
  const listed = unserved.length === 0 ? listedQuoteOf(original, deps.pricingSettings) : undefined;
  const quoted = listed ? checkedFundingSteps(bound) : bound;
  const plan = assemblePlan(u, quoted, unserved, deps.pricingSettings, said, listed && { ...listed, catalog: deps.catalog });
  if (!listed) return { kind: "plan", plan, understanding: u, costUsd };
  const balance = deps.availablePoints ? await deps.availablePoints() : undefined;
  const available = balance === undefined ? Infinity : balance ?? 0;
  if (fundedPlanFits(plan.stages, plan.price) && plan.price.reservePoints <= available) return { kind: "plan", plan, understanding: u, costUsd };

  // Try an independently measured route on its own before offering a smaller total.
  for (const step of quoted) {
    if (!step.second) continue;
    const alternate = { ...step, ...step.second, rowsPerPage: step.second.sample!.rowsPerPage, second: undefined, variantSamples: undefined };
    const candidate = assemblePlan(u, quoted.map((b) => b === step ? alternate : b), unserved, deps.pricingSettings, said, { ...listed, catalog: deps.catalog });
    if (fundedPlanFits(candidate.stages, candidate.price) && candidate.price.reservePoints <= available) return { kind: "plan", plan: candidate, understanding: u, costUsd };
  }
  return { ...fundedCountQuestion(plan, u, balance === undefined ? undefined : available), understanding: u, costUsd };
}

/** The model's map with the standard columns it left out filled from the common names (a thin map, id and link only, made a file a researcher cannot use: live TikTok, 15 Nov 2026). */
export function enrichedMap(map: FieldMap | null, items: ReadonlyArray<Record<string, unknown>>): FieldMap | null {
  const guess = fallbackMap(items);
  if (!map) return guess;
  if (!guess) return map;
  const fields = { ...map.fields };
  for (const [k, p] of Object.entries(guess.fields)) if (!fields[k] && !(k === "link" && map.linkTemplate)) fields[k] = p;
  return withoutTwinPaths({ ...map, fields });
}

/** A map made by code when the model gave none usable: the common names, at the item's top or inside its one wrapping object (TikTok's `aweme_info`). */
export function fallbackMap(items: ReadonlyArray<Record<string, unknown>>): FieldMap | null {
  const guess: Record<string, string[][]> = {
    id: [["id"], ["id_str"], ["aweme_id"], ["post_id"], ["video_id"], ["comment_id"], ["cid"], ["pk"], ["url"]],
    text: [["text"], ["full_text"], ["desc"], ["caption"], ["body"], ["selftext"], ["content"], ["message"], ["title"]],
    author: [["author", "name"], ["authorName"], ["user", "name"], ["author"]],
    username: [["authorUsername"], ["username"], ["user", "screen_name"], ["author", "username"]],
    posted_at: [["createdUtc"], ["created_at"], ["create_time"], ["created_utc"], ["timestamp"], ["date"], ["publishedAt"]],
    link: [["url"], ["link"], ["permalink"], ["share_url"]],
  };
  guess.author.push(["author", "nickname"], ["user", "full_name"], ["owner", "full_name"], ["author", "displayName"]);
  guess.username.push(["author", "unique_id"], ["owner", "username"], ["user", "username"], ["author", "handle"]);
  guess.text.push(["description"], ["snippet", "title"]);
  guess.posted_at.push(["createTime"], ["taken_at"], ["published_at"], ["create_time_utc"]);
  guess.link.push(["share_url"], ["video_url"], ["post_url"]);
  const counters: Record<string, string[][]> = { likes: [["likeCount"], ["like_count"], ["digg_count"], ["statistics", "digg_count"], ["likes"], ["score"]], comments_count: [["commentCount"], ["comment_count"], ["statistics", "comment_count"], ["num_comments"]], shares: [["shareCount"], ["share_count"], ["statistics", "share_count"], ["retweetCount"]], views: [["viewCount"], ["view_count"], ["play_count"], ["statistics", "play_count"]] };
  const all: Record<string, string[][]> = { ...guess, ...counters };
  const wrappers = new Set<string>([""]);
  for (const it of items.slice(0, 3)) for (const [k, v] of Object.entries(it)) if (isObj(v) && Object.keys(v).length >= 5) wrappers.add(k);
  const fields: Record<string, string[]> = {};
  for (const [k, paths] of Object.entries(all)) {
    for (const w of wrappers) {
      const p = paths.map((q) => (w ? [w, ...q] : q)).find((q) => items.some((it) => { const v = at(it, q); return filled(v) && (typeof v === "string" || typeof v === "number"); }));
      if (p) { fields[k] = p; break; }
    }
  }
  return fields.id ? { fields, linkTemplate: null, extra: [] } : null;
}

interface Probed { option: ToolOption; page: unknown; items: Array<Record<string, unknown>>; listPath: string | null; callIds: string[]; hasMore: boolean; nextCursor: string | null; checkedParams: Record<string, unknown>; chargedUsd: number }

/** ONE real first page per option, in the model's order; an option whose first input set is empty tries its further sets (a precise query may be empty where a broader one is not). At most MAX_PROBES_PER_STEP calls. */
async function probeStep(step: UnderstoodStep, options: ToolOption[], parent: BuiltStep | null, deps: LlmPlannerDeps, budget: { left: number }, trace?: { empties: number; failures: number; uncertain: boolean }): Promise<Probed | null> {
  const callIds: string[] = [];
  for (let optIdx = 0; optIdx < options.length; optIdx += 1) {
    const option = options[optIdx];
    const reviewed = missionPageOf(option.endpoint.id);
    const sets = [option.params, ...option.more];
    // a child is tried on up to PARENTS_TRIED parents, the most commented first (the newest post may have no comment yet): the first input set only
    const parentValues = option.parent && parent ? parentValuesOf(parent.sampleRows, option.parent.from) : [null];
    if (option.parent && parent && parentValues.length === 0) continue;
    const allAttempts: Array<{ set: number; parentValue: unknown }> = option.parent && parent ? parentValues.map((v) => ({ set: 0, parentValue: v })) : sets.map((_, i) => ({ set: i, parentValue: null }));
    const childCap = option.parent && parent && options.length > 2 ? Math.max(1, Math.floor(budget.left / (options.length - optIdx))) : allAttempts.length;
    const attempts = allAttempts.slice(0, childCap);
    for (const a of attempts) {
      if (budget.left <= 0) break;
      const i = a.set;
      let params = { ...sets[i] };
      if (option.parent && parent) params = { ...params, [option.parent.param]: a.parentValue };
      budget.left -= 1;
      const r = await deps.probe(option.endpoint.id, params);
      callIds.push(r.call_id);
      if (!r.ok) {
        deps.log?.(`llm_planner_probe ${step.key} ${option.endpoint.id} not ok${"http_status" in r ? ` ${r.http_status}` : ""}`);
        if (trace) { trace.failures += 1; if (reviewed) trace.uncertain = true; }
        // a refusal, or a provider that is not paid or not allowed (401/402/403: live, 16 Nov 2026, one news tool answered 402 to eight calls in a row): its other input sets are not tried, the next tool is
        if ("refused" in r || ("http_status" in r && [401, 402, 403].includes(Number(r.http_status)))) break;
        continue;
      }
      if (!reviewed && r.rows_in_page <= 0) { deps.log?.(`llm_planner_probe ${step.key} ${option.endpoint.id} empty`); if (trace) trace.empties += 1; continue; }
      const page = await deps.readPage(r.call_id);
      if (page === null) { if (trace) trace.failures += 1; continue; }
      const reading = reviewed
        ? readShape(page, { ...hintsOf(option.endpoint), missionPage: reviewed })
        : buildShapeDigest(page, option.endpoint).reading;
      if (reviewed && (reading.listStrategy === "declared_missing" || (reading.warnings.length > 0 && reading.rows.length === 0))) {
        if (trace) { trace.failures += 1; trace.uncertain = true; }
        continue;
      }
      if (reading.rows.length === 0) {
        if (reviewed && (reading.nextCursor || reading.hasMore === true)) {
          if (trace) trace.uncertain = true;
          deps.log?.(`llm_planner_probe ${step.key} ${option.endpoint.id} open_empty`);
          continue;
        }
        deps.log?.(`llm_planner_probe ${step.key} ${option.endpoint.id} empty`);
        if (trace) trace.empties += 1;
        continue;
      }
      // the input set that answered becomes the first one, the others follow it
      const reordered: ToolOption = i === 0 ? option : { ...option, params: sets[i], more: sets.filter((_, j) => j !== i) };
      return {
        option: reordered, page, items: reading.rows, listPath: reading.listPath, callIds,
        hasMore: reviewed ? Boolean(reading.nextCursor) && reading.hasMore !== false : Boolean(r.next_cursor) || r.has_more === true,
        nextCursor: reviewed ? reading.nextCursor : typeof r.next_cursor === "string" && r.next_cursor !== "" ? r.next_cursor : null,
        checkedParams: params, chargedUsd: r.charge_usd ?? 0,
      };
    }
    if (budget.left <= 0) break;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// SCOUTING: what does the source really hold, and what does the customer want to do about it?
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What one top-level step's real searches showed: how many different items the source gave (up to the customer's number), and whether every search ended (no further page). */
export interface ScoutFinding { step: UnderstoodStep; requested: number; found: number; exhausted: boolean; sets: number }

const rowKeyOf = (row: Record<string, unknown>): string => String(row.id ?? row.link ?? JSON.stringify(row));

function pageSample(rows: ReadonlyArray<Record<string, unknown>>, checkedParams: Record<string, unknown>, chargedUsd: number): PageSample {
  return {
    rowsPerPage: new Set(rows.filter((row) => filled(row.id ?? row.link)).map(rowKeyOf)).size,
    chargedUsd: Number.isFinite(chargedUsd) && chargedUsd > 0 ? chargedUsd : 0,
    checkedParams,
  };
}

type ListedSelector = { slug: string; nounAr: string; knownParentCapability?: string };
type ListedQuote = { stageKey: string; rate: ListedMissionRate; settings: MissionPricingSettings };

function listedQuoteOf(steps: ReadonlyArray<BuiltStep>, rawSettings: unknown): ListedQuote | undefined {
  const delivered = steps.filter((b) => b.step.deliver);
  if (delivered.length !== 1) return undefined;
  const { step, option } = delivered[0];
  const selectors = (providerMetadata.treg as { missionListedServices?: Record<string, ListedSelector> }).missionListedServices ?? {};
  const selector = Object.hasOwn(selectors, step.capability) ? selectors[step.capability] : undefined;
  if (!selector || option.endpoint.capability !== step.capability) return undefined;
  const parent = step.parent ? steps.find((b) => b.step.key === step.parent) : undefined;
  const knownPage = (b: BuiltStep, capability: string): boolean => b.step.capability === capability
    && b.option.endpoint.capability === capability && Boolean(b.step.source?.value.trim());
  if (selector.knownParentCapability) {
    if (parent) {
      if (!knownPage(parent, selector.knownParentCapability) && (!parent.lookup || !parent.step.source?.value.trim())) return undefined;
    } else {
      const value = step.source?.value.trim();
      if (!value || !/^https?:\/\//i.test(value) || !Object.values(option.params).includes(value)) return undefined;
    }
  }
  if (Object.values(selectors).some((value) => value.knownParentCapability === step.capability) && !knownPage(delivered[0], step.capability)) return undefined;
  const capability = APPROVED_CAPABILITY_CATALOG.find((cap) => cap.slug === selector.slug && cap.enabled);
  if (!capability) return undefined;
  const settings = normalizeMissionPricingSettings(rawSettings);
  const unitPoints = unitPricePointsForCapability(capability, { ...DEFAULT_PRICING_SETTINGS, markup: settings.markup });
  if (!Number.isFinite(unitPoints) || unitPoints <= 0) return undefined;
  return { stageKey: step.key, rate: { unitPoints, nounAr: selector.nounAr }, settings };
}

function checkedFundingSteps(steps: ReadonlyArray<BuiltStep>): BuiltStep[] {
  return steps.map((step) => ({
    ...step,
    option: { ...step.option, more: step.option.more.filter((params) => step.variantSamples?.has(params)) },
    second: step.second?.sample?.rowsPerPage && step.second.option.endpoint.capability === step.option.endpoint.capability
      ? { ...step.second, option: { ...step.second.option, more: [] } }
      : undefined,
    webFallbacks: undefined,
  }));
}

function sealedFunding(
  step: BuiltStep,
  alternatives: NonNullable<NonNullable<PricedStage["engine"]>["alternatives"]>,
  catalog: TregCatalog,
): ExecutionFundingRoute[] | undefined {
  const fundingFor = (endpointId: string, cursor: string | null, sample?: PageSample): ExecutionFundingRoute | null => {
    const endpoint = catalog.byId.get(endpointId);
    if (!endpoint || !sample?.rowsPerPage) return null;
    const bound = tregCallBoundOf(endpointId, sample.checkedParams, catalog);
    if (bound === null) return null;
    const usd = Math.max(bound, estimateCallUsd(endpoint, sample.checkedParams, catalog), sample.chargedUsd);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    return { rowsPerPage: sample.rowsPerPage, callUsdMicro: fundingCallUsdMicro(usd), mode: cursor ? "paged" : "one_shot" };
  };
  const primary = fundingFor(step.option.endpoint.id, step.option.cursor, step.sample);
  if (!primary) return undefined;
  const routes = [primary];
  for (const alt of alternatives) {
    const sample = alt.endpoint_id === step.option.endpoint.id ? step.variantSamples?.get(alt.params) : step.second?.sample;
    const funded = fundingFor(alt.endpoint_id, alt.cursor_param, sample);
    if (!funded) return undefined;
    routes.push(funded);
  }
  return routes;
}

function fundedPlanFits(stages: ReadonlyArray<PricedStage>, price: PricedPlan["price"]): boolean {
  return Boolean(price.listedRate && !price.overCap && price.deliveredRows <= AGENT_MAX_DELIVERED_ROWS &&
    stages.every((stage) => stage.parent_key === null || Boolean(stage.engine?.parent_binding)));
}

function fundedCountQuestion(plan: PricedPlan, understanding: Understanding, capPoints?: number): {
  kind: "question"; question_ar: string; options_ar: string[];
} {
  const stage = plan.stages.find((s) => s.deliver);
  const requested = understanding.steps.find((s) => s.key === stage?.key)?.count;
  const smaller = stage && requested && !requested.all && requested.per_parent === null ? smallerFundedTarget(plan, stage, capPoints) : null;
  if (!smaller) return { kind: "question", question_ar: "اكتب عددًا أقل لنحسب لك الحجز المؤقت.", options_ar: [] };
  const countAr = toArabicDigits(smaller.rows);
  return { kind: "question", question_ar: `الحجز المطلوب لهذا العدد يتجاوز الحد المتاح. نقدر نجهّز حتى ${countAr} بحجز مؤقت ${pointsAr(smaller.hold)}. تحب نجهّز العدد ده؟`, options_ar: [`جهّز ${countAr}`] };
}

function smallerFundedTarget(plan: PricedPlan, stage: PricedStage, capPoints?: number): { rows: number; hold: number } | null {
  let low = 1;
  let high = Math.min(stage.planned_rows - 1, AGENT_MAX_DELIVERED_ROWS);
  let best = null;
  while (low <= high) {
    const rows = Math.floor((low + high) / 2);
    const stages = plan.stages.map((s) => s === stage ? { ...s, planned_rows: rows, expected_rows: rows } : s);
    const price = priceMissionByCode(stagePriceInputs(stages), { settings: plan.price.settings, capPoints });
    if (fundedPlanFits(stages, price)) {
      best = { rows, hold: price.reservePoints };
      low = rows + 1;
    } else {
      high = rows - 1;
    }
  }
  return best;
}

/**
 * The yield of one step, measured with real calls: when the first page has no next page, the model's other input sets are read once each (page one only), and the different items are counted. Any further page
 * (a next cursor) means the source holds more than a page: nothing to report, execution pages through it. A failed call makes the answer uncertain (not exhausted): the customer is never asked on a guess.
 */
export async function scoutYield(
  a: { option: ToolOption; mapCode: string; firstRows: ReadonlyArray<Record<string, unknown>>; hasMore: boolean; nextCursor?: string | null; otherHasMore?: boolean; extraRows?: ReadonlyArray<Record<string, unknown>>; requested: number;
       onSample?: (firstParams: Record<string, unknown>, rows: ReadonlyArray<Record<string, unknown>>, chargedUsd: number) => void },
  deps: Pick<LlmPlannerDeps, "probe" | "readPage" | "log">,
): Promise<{ found: number; exhausted: boolean; sets: number }> {
  const ids = new Set<string>([...a.firstRows, ...(a.extraRows ?? [])].map(rowKeyOf));
  const reviewed = missionPageOf(a.option.endpoint.id);
  const healthy = Math.min(THIN_PAGE_ROWS, a.requested);
  let sets = 1;
  let measured = 0;
  // a FULL first page with a next page, or another tool's: the source holds more than a page: nothing to report, execution pages through it
  if (a.otherHasMore || (a.hasMore && a.firstRows.length >= healthy)) return { found: ids.size, exhausted: false, sets };
  // a refused or failed measurement (the gateway lets planning sample a source twice) ends the measuring: what was gathered before it decides, provided at least one more search was read than the first
  const stopped = (): { found: number; exhausted: boolean; sets: number } => ({ found: ids.size, exhausted: !reviewed && measured >= 1 && ids.size < Math.max(1, Math.ceil(a.requested * SCOUT_SHORT_SHARE)), sets });
  const read = async (params: Record<string, unknown>, firstParams: Record<string, unknown>): Promise<{ ok: true; rows: Array<Record<string, unknown>>; next: string | null } | { ok: false }> => {
    const r = await deps.probe(a.option.endpoint.id, params);
    sets += 1;
    if (!r.ok) return { ok: false };
    const legacyNext = typeof r.next_cursor === "string" && r.next_cursor !== "" ? r.next_cursor : null;
    if (!reviewed && r.rows_in_page <= 0) { measured += 1; return { ok: true, rows: [], next: null }; }
    const page = await deps.readPage(r.call_id);
    if (page === null) return { ok: false };
    const reading = reviewed ? readShape(page, { ...hintsOf(a.option.endpoint), missionPage: reviewed }) : null;
    if (reading && (reading.listStrategy === "declared_missing" || (reading.hasMore === true && !reading.nextCursor))) return { ok: false };
    const next = reading ? reading.nextCursor : legacyNext;
    measured += 1;
    if (reading && reading.rows.length === 0) return { ok: true, rows: [], next };
    const rows = runMap(a.mapCode, page);
    a.onSample?.(firstParams, rows, r.charge_usd ?? 0);
    return { ok: true, rows, next };
  };
  // a THIN first page with a next page: follow the cursor for a few pages and count (the provider may page through a filtered, almost empty list)
  if (a.hasMore && a.nextCursor && a.option.cursor) {
    let cursor: string | null = a.nextCursor;
    const visited = new Set<string>();
    if (cursor) visited.add(cursor);
    for (let i = 0; i < MAX_SCOUT_PAGES && cursor && ids.size < a.requested; i += 1) {
      const inputCursor = reviewed ? pageInputValue(cursor, reviewed) : cursor;
      if (inputCursor === null) return stopped();
      const got = await read({ ...a.option.params, [a.option.cursor]: inputCursor }, a.option.params);
      if (!got.ok) return stopped();
      if (reviewed && got.rows.length === 0 && got.next) {
        return { found: ids.size, exhausted: false, sets };
      }
      const before = ids.size;
      for (const row of got.rows) ids.add(rowKeyOf(row));
      if (reviewed && got.next && visited.has(got.next)) return stopped();
      cursor = got.next;
      if (cursor) visited.add(cursor);
      // a followed page that is full again: the source holds more
      if (got.rows.length >= healthy && ids.size > before) return { found: ids.size, exhausted: false, sets };
    }
    if (reviewed && cursor) return { found: ids.size, exhausted: false, sets };
  }
  for (const params of a.option.more.slice(0, MAX_SCOUT_SETS)) {
    if (ids.size >= a.requested) break;
    const got = await read(params, params);
    if (!got.ok) return stopped();
    for (const row of got.rows) ids.add(rowKeyOf(row));
    if (got.rows.length >= healthy || (reviewed && got.next)) return { found: ids.size, exhausted: false, sets };
  }
  return { found: ids.size, exhausted: ids.size < a.requested, sets };
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
/** The numbers written in a text, with Arabic-Indic digits and separators read as plain integers. */
export function numbersWritten(text: string): Set<string> {
  const plain = String(text ?? "").replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d))).replace(/(\d)[٬,](?=\d{3})/g, "$1");
  return new Set((plain.match(/\d+/g) ?? []).map((n) => String(Number(n))));
}

/** The sentence the customer reads when the model's own cannot be used: what was found, and the two things we can do. */
export function scoutFallbackAr(weak: ReadonlyArray<ScoutFinding>, said: ReadonlyArray<string>): { question_ar: string; options_ar: string[] } {
  const lines = weak.map((f) => (f.found === 0
    ? `جرّبنا البحث عن ${f.step.title_ar} في ${platformAr(f.step.platform, f.step.capability, said)} بالشروط التي كتبتها ولم نجد نتائج.`
    : `جرّبنا البحث عن ${f.step.title_ar} في ${platformAr(f.step.platform, f.step.capability, said)} بالشروط التي كتبتها فوجدنا نحو ${toArabicDigits(f.found)} فقط من ${toArabicDigits(f.requested)} طلبتها، ولا يعرض المصدر أكثر من ذلك لهذه الشروط.`));
  return { question_ar: `${lines.join(" ")} تحب نسلّمك الموجود، ولا نوسّع البحث؟`, options_ar: ["سلّمني الموجود فقط", "وسّع البحث (اكتب كيف تحب نوسّعه)"] };
}

/** The question the customer reads when the search found less than they asked for: the model writes it from the facts (code allows only the numbers it was given); code's own sentence when the model's cannot be shown. */
export async function scoutQuestion(u: Understanding, weak: ReadonlyArray<ScoutFinding>, input: LlmPlannerInput, deps: Pick<LlmPlannerDeps, "model" | "log">, cost: { usd: number }): Promise<{ question_ar: string; options_ar: string[] }> {
  const facts = {
    customer_words: input.words.slice(-4),
    understanding: u.understanding_ar,
    searches: weak.map((f) => ({ items: f.step.title_ar, platform: platformAr(f.step.platform, f.step.capability, customerSaidOf(input)), source: f.step.source, topic: f.step.topic, period: f.step.period, language: f.step.language ?? null, country: f.step.country ?? null, requested: f.requested, found: f.found, different_searches_tried: f.sets })),
  };
  const fallback = scoutFallbackAr(weak, customerSaidOf(input));
  const answer = await asker(deps, cost)(SCOUT_SYSTEM, JSON.stringify(facts), { name: SCOUT_TOOL, description: "What the real search found, and the customer's choices.", schema: SCOUT_SCHEMA }, 900);
  if (!isObj(answer)) return fallback;
  const message = customerSafe(str(answer.message_ar), 700, customerSaidOf(input));
  if (!message) return fallback;
  const allowed = new Set<string>([...weak.flatMap((f) => [String(f.requested), String(f.found), String(f.sets)]), ...numbersWritten(`${input.words.join(" ")} ${JSON.stringify(weak.map((f) => f.step.period))}`)]);
  const foreign = [...numbersWritten(message)].filter((n) => !allowed.has(n));
  if (foreign.length > 0) { deps.log?.(`llm_planner_scout_numbers ${foreign.join(",")}`); return fallback; }
  const options = (Array.isArray(answer.options_ar) ? answer.options_ar : []).map((o) => customerSafe(str(o), 80, customerSaidOf(input))).filter((o): o is string => o !== null && [...numbersWritten(o)].every((n) => allowed.has(n))).slice(0, 4);
  return { question_ar: message, options_ar: options.length >= 2 ? options : fallback.options_ar };
}

/** Parents a child step is tried on: those that carry the binding's value, the most commented (or replied, or liked) first, at most PARENTS_TRIED. */
export const PARENTS_TRIED = 3;
export function parentValuesOf(rows: ReadonlyArray<Record<string, unknown>>, from: string): unknown[] {
  const n = (v: unknown): number => { const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN; return Number.isFinite(x) ? x : -1; };
  const score = (r: Record<string, unknown>): number => Math.max(n(r.comments_count), n(r.replies_count)) * 1000 + Math.max(0, n(r.likes)) / 1e6;
  return [...rows].filter((r) => filled(r[from])).sort((a, b) => score(b) - score(a)).slice(0, PARENTS_TRIED).map((r) => r[from]);
}

/** A step that only FINDS the one thing the customer named (count 1, not delivered, with a name, and a later step reads from it). */
export function isLookupStep(step: UnderstoodStep, steps: ReadonlyArray<UnderstoodStep>): boolean {
  return !step.parent && !step.deliver && step.count.total === 1 && Boolean(step.topic || step.source?.value) && steps.some((x) => x.parent === step.key);
}

const PICK_TOOL = { name: "pick_item", description: "Which result is the named thing.", schema: { type: "object", properties: { index: { type: "integer", description: "the position (0-based) of the result that IS the named thing, -1 when none is" }, why: { type: "string" } }, required: ["index"] } as Record<string, unknown> };
/** The position of the result that IS the thing the customer named (not a similar or competing one), or -1. One small model call; with one result that the model cannot confirm, -1 too. */
export async function pickNamedItem(step: UnderstoodStep, rows: ReadonlyArray<Record<string, unknown>>, ask: (system: string, user: string, tool: typeof PICK_TOOL, maxTokens: number) => Promise<unknown | null>, answers: ReadonlyArray<string> = []): Promise<number> {
  if (rows.length === 0) return -1;
  // THE CUSTOMER PRESSED «any result is fine»: the first result of the search on the topic, with no model call
  if (answers.some((a) => a.trim() === ANY_RESULT_OPTION_AR)) return 0;
  const name = [step.source?.value, step.topic].filter(Boolean).join(" — ");
  const view = rows.slice(0, 10).map((r, i) => ({ index: i, ...Object.fromEntries(Object.entries(r).filter(([k, v]) => !k.startsWith("__") && (typeof v === "string" || typeof v === "number")).map(([k, v]) => [k, String(v).slice(0, 160)]).slice(0, 12)) }));
  const answer = await ask(
    "You check search results for a data service. The customer named ONE specific thing (an app, a place, a product, a business). Return the index of the result that IS that exact thing: the same brand/app/place, not a similar, competing or related one (a different company's app is never it). Names may differ in language or spelling (Arabic vs Latin). If no result is clearly it, return -1.",
    `The customer named: «${name}» (${step.platform}, ${step.capability}).${answers.length > 0 ? `\nThe customer's answers to our questions: ${answers.map((a) => `«${a}»`).join(" | ")}. If they say any result about the topic is fine, return the index of the first result that is about the topic.` : ""}\nResults:\n${JSON.stringify(view)}`,
    PICK_TOOL,
    300,
  );
  const i = isObj(answer) && typeof answer.index === "number" ? Math.trunc(answer.index) : -1;
  return i >= 0 && i < Math.min(10, rows.length) ? i : -1;
}

/** Children of a resolved lookup become top-level steps that read the found thing directly (its value fixed in their inputs); the lookup itself is not a stage (execution would search again and take the first result). */
export function bindLookups(steps: ReadonlyArray<BuiltStep>): BuiltStep[] {
  const out: BuiltStep[] = [];
  for (const b of steps) {
    const parent = b.step.parent ? steps.find((x) => x.step.key === b.step.parent) : undefined;
    if (b.lookup) continue;
    if (!parent?.lookup || !b.option.parent) { out.push(b); continue; }
    const parentRow = parent.sampleRows[0];
    if (!parentRow) { if (!missionPageOf(b.option.endpoint.id)) out.push(b); continue; }
    const primaryVal = parentRow[b.option.parent.from];
    if (!filled(primaryVal) || b.option.parent.param === b.option.cursor) { if (!missionPageOf(b.option.endpoint.id)) out.push(b); continue; }
    const fixPrimary = (params: Record<string, unknown>): Record<string, unknown> => ({ ...params, [b.option.parent!.param]: primaryVal });

    let second: BuiltStep["second"] = undefined;
    if (b.second) {
      const altParent = b.second.option.parent;
      if (altParent) {
        const altVal = parentRow[altParent.from];
        if (filled(altVal) && altParent.param !== b.second.option.cursor) {
          const fixAlt = (params: Record<string, unknown>): Record<string, unknown> => ({ ...params, [altParent.param]: altVal });
          second = {
            ...b.second,
            option: {
              ...b.second.option,
              params: fixAlt(b.second.option.params),
              more: b.second.option.more.map(fixAlt),
              parent: null,
            },
          };
        }
      } else if (!missionPageOf(b.option.endpoint.id)) {
        second = b.second;
      }
    }

    out.push({
      ...b,
      step: { ...b.step, parent: null },
      option: {
        ...b.option,
        params: fixPrimary(b.option.params),
        more: b.option.more.map(fixPrimary),
        parent: null,
      },
      second,
    });
  }
  return out;
}

/** The plan in the shape every later part already reads (the card, the price, approval, the engine, the file, settlement). */
export function assemblePlan(u: Understanding, steps: ReadonlyArray<BuiltStep>, unserved: ReadonlyArray<{ what_ar: string; reason_ar: string }>, pricingSettings?: unknown, said: ReadonlyArray<string> = [], listed?: ListedQuote & { catalog: TregCatalog }): PricedPlan {
  const stages: PricedStage[] = [];
  const notes: string[] = [];
  const assumptions = (u.assumptions_ar ?? []).map((a) => customerSafe(a, 300, said)).filter((a): a is string => a !== null);
  const plannedOf = new Map<string, number>();
  for (const b of steps) {
    const s = b.step;
    const parentRows = s.parent ? plannedOf.get(s.parent) ?? 0 : 0;
    const isConfiguredPaging = Boolean(missionPageOf(b.option.endpoint.id));
    const isTotalOnlyChild = Boolean(s.parent && s.count.total !== null && !s.count.per_parent && !s.count.all && isConfiguredPaging);

    let planned: number;
    let perParent: number | undefined;
    if (s.parent) {
      if (isTotalOnlyChild) {
        perParent = undefined;
      } else {
        perParent = s.count.per_parent ?? (s.count.all ? ALL_CHILDREN_CAP : s.count.total ? Math.max(1, Math.ceil(s.count.total / Math.max(1, parentRows))) : DEFAULT_PER_PARENT);
      }
      planned = s.count.total ?? (perParent ?? DEFAULT_PER_PARENT) * Math.max(1, parentRows);
      if (s.count.all) notes.push(`${s.title_ar}: نقرأ كل ما يعرضه المصدر لكل عنصر، بحد أقصى ${toArabicDigits(perParent ?? ALL_CHILDREN_CAP)} لكل عنصر، ولا ندفع إلا مقابل ما يُسلَّم.`);
      else if (!s.count.per_parent && !s.count.total && perParent !== undefined) assumptions.push(`لم تحدد عدد ${s.title_ar} لكل عنصر، فاخترنا ${toArabicDigits(perParent)}؛ يمكنك تعديله قبل الموافقة.`);
    } else {
      planned = s.count.total ?? DEFAULT_COUNT;
      if (s.count.total === null) assumptions.push(`لم تحدد عدد ${s.title_ar}، فاخترنا ${toArabicDigits(DEFAULT_COUNT)}؛ يمكنك تعديله قبل الموافقة.`);
    }
    planned = Math.max(1, Math.min(MAX_STEP_ITEMS, Math.floor(planned)));
    plannedOf.set(s.key, planned);
    // THE REAL SAMPLE IS SMALL (live X, 15 Nov 2026: the account's precise searches gave 0 and 2 for a request of 400): said before approval, with the honest consequence; the customer pays only for what is delivered
    if (!s.parent && !b.hasMore && b.rowsPerPage < Math.min(planned, 20)) notes.push(`${s.title_ar}: الصفحة الأولى من المصدر أعطتنا ${toArabicDigits(b.rowsPerPage)} فقط، فالمتاح غالبًا أقل بكثير من ${toArabicDigits(planned)}.${b.option.more.length > 0 || b.second || (b.webFallbacks?.length ?? 0) > 0 ? " نكمل البحث بصيغ أخرى ومن مصادر أخرى" : " والمصدر لا يعرض أكثر من ذلك"}، ولن تدفع إلا مقابل ما يُسلَّم.`);
    if (b.option.notCarried.length > 0) notes.push(`${s.title_ar}: المصدر لا يتيح التصفية حسب ${b.option.notCarried.map((c) => CONDITION_AR[c]).join(" ولا ")}، فقد تصلك نتائج من خارجها. لو ده مهم لك، اضغط «عدّل الطلب».`);
    const rowsPerPage = Math.max(1, b.rowsPerPage);
    const costPerRow = (callUsdOf(b.option.endpoint) / rowsPerPage) * VARIANT_OVERLAP_FACTOR;
    const alternatives = isTotalOnlyChild
      ? []
      : [
          ...b.option.more.map((params) => ({ endpoint_id: b.option.endpoint.id, params, cursor_param: b.option.cursor, map_code: b.mapCode, map_file_id: "page", ...(b.option.parent ? { parent_binding: { param: b.option.parent.param, from: b.option.parent.from } } : {}) })),
          ...(b.second ? [b.second.option.params, ...b.second.option.more].map((params) => ({ endpoint_id: b.second!.option.endpoint.id, params, cursor_param: b.second!.option.cursor, map_code: b.second!.mapCode, map_file_id: "page", ...(b.second!.option.parent ? { parent_binding: { param: b.second!.option.parent.param, from: b.second!.option.parent.from } } : {}) })) : []),
          ...(b.webFallbacks ?? []).flatMap((w) => [w.option.params, ...w.option.more].map((params) => ({ endpoint_id: w.option.endpoint.id, params, cursor_param: null, map_code: w.mapCode, map_file_id: "page" }))),
        ];
    const funding = listed ? sealedFunding(b, alternatives, listed.catalog) : undefined;
    stages.push({
      key: s.key, title_ar: s.title_ar, endpoint_id: b.option.endpoint.id, capability: s.capability,
      expected_rows: planned, planned_rows: planned, parent_key: s.parent, ...(perParent !== undefined ? { per_parent_rows: perParent } : {}),
      ...(s.parent && s.count.all ? { children_cap_per_parent: perParent } : {}),
      deliver: s.deliver, columns: b.columns, sample_rows: b.sampleRows.slice(0, 3), measured_by: b.callIds, measured_from_calls: b.callIds, measured_cost_per_row_usd: costPerRow,
      yield_share: 1, review_share: 0,
      ...(listed?.stageKey === s.key ? { listed_rate: listed.rate } : {}),
      ...(funding ? { execution_funding: funding } : {}),
      ...(b.carryKeys.length > 0 ? { carry_keys: [...b.carryKeys] } : {}),
      engine: {
        endpoint_id: b.option.endpoint.id, params: b.option.params, cursor_param: b.option.cursor, map_code: b.mapCode, map_file_id: "page",
        parent_binding: b.option.parent ? { param: b.option.parent.param, from: b.option.parent.from } : null, built_by: "code",
        ...(isConfiguredPaging || alternatives.some((alt) => missionPageOf(alt.endpoint_id)) ? { catalog_paging: true as const } : {}),
        ...(isTotalOnlyChild ? { fill_total_across_parents: true as const } : {}),
        ...(alternatives.length > 0 ? { alternatives } : {}),
      },
    } as unknown as PricedStage);
  }
  // a child binds to a field of its parent's row: that field is kept on the stored parent row even when it is not a column
  for (const st of stages) {
    if (!st.parent_key) continue;
    const p = stages.find((x) => x.key === st.parent_key);
    if (!p) continue;
    const bindings = [
      st.engine?.parent_binding,
      ...((st.engine as any)?.alternatives ?? []).map((a: any) => a.parent_binding),
    ].filter(Boolean);
    for (const bind of bindings) {
      if (bind && !p.columns.some((c) => c.key === bind.from) && bind.from !== "id") {
        p.carry_keys = [...new Set([...(p.carry_keys ?? []), bind.from])];
      }
    }
  }
  for (const st of stages) if (st.carry_keys && st.carry_keys.length === 0) delete st.carry_keys;
  const price = priceMissionByCode(stagePriceInputs(stages), { settings: listed?.settings ?? pricingSettings as MissionPricingSettings | undefined });
  const counts = stages.filter((s) => s.deliver).map((s) => `${s.title_ar}: ${toArabicDigits(s.planned_rows)}`).join("، ");
  const platforms = [...new Set(steps.map((b) => platformAr(b.step.platform, b.step.capability, said)))].join(" و");
  const understood = customerSafe(impersonalAr(u.understanding_ar).replace(/[.،\s]+$/u, ""), 300, said) ?? `نجمع ${stages.filter((s) => s.deliver).map((s) => s.title_ar).join(" و")} من ${platforms} كما طلبت`;
  const summary = `${understood}. ${counts ? `العدد المخطط: ${counts}.` : ""}`.trim();
  const widened = listed ? stages.some((s) => s.engine?.alternatives?.length) : steps.some((b) => b.option.more.length > 0 || b.second !== undefined || (b.webFallbacks?.length ?? 0) > 0);
  notes.push(widened
    ? "نجمع بالعدد الذي طلبته من المصدر صفحةً بعد صفحة، ونوسّع البحث بصيغ أخرى للموضوع نفسه حتى نصل إلى العدد أو ينتهي ما يعرضه المصدر، ونحذف المكرر فقط. لا تدفع إلا مقابل ما يُسلَّم."
    : "نجمع بالعدد الذي طلبته من المصدر صفحةً بعد صفحة حتى نصل إليه أو ينتهي ما يعرضه المصدر، ونحذف المكرر فقط. لا تدفع إلا مقابل ما يُسلَّم.");
  return {
    summary_ar: summary,
    notes_ar: notes,
    ...(assumptions.length > 0 ? { assumptions_ar: assumptions } : {}),
    stages,
    price,
    ...(unserved.length > 0 ? { unserved_steps: unserved.map((x) => ({ ...x })) } : {}),
    compiled: {
      by: "compiler",
      platform: steps[0]?.step.platform ?? "",
      promises: Object.fromEntries(stages.map((s) => [s.key, { type: s.parent_key && u.steps.find((x) => x.key === s.key)?.count.all ? "open" : "exact", n: s.planned_rows }])),
      conditions: { named: false, period: false, language: false, country: false, topic: false },
      llm: { understanding_ar: u.understanding_ar, request_parts_ar: requestPartsAr(u.steps, said), steps: u.steps.map((s) => ({ key: s.key, platform: s.platform, capability: s.capability, source: s.source, topic: s.topic, period: s.period, terms: s.search_terms })) },
    } as PricedPlan["compiled"],
  } as PricedPlan;
}

/** Whether a probe's step had a proven tool (for the admin's trace). */
export const optionTrace = (o: ToolOption): string => `${o.endpoint.id}${isProven(o.endpoint.id) ? "*" : ""}`;
