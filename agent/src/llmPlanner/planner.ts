import type { CatalogEndpoint, TregCatalog } from "../../../src/lib/treg/catalog";
import type { AccountAccess } from "../../../src/lib/treg/dataPolicy";
import { buildShapeDigest, digestValue } from "../../../src/lib/modelPlanner/digest";
import { priceMissionByCode } from "../../../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan, type PricedStage, type PlanColumn } from "../../../src/lib/agentMission/plan";
import { cardMapCode } from "../../../src/lib/agentMission/foundation/toolCards/mapCode";
import type { ToolCard } from "../../../src/lib/agentMission/foundation/toolCards/types";
import { toArabicDigits } from "../../../src/lib/arabicDigits";
import { checkCustomerText } from "../../../src/lib/agentMission/text";
import type { GatewayCallResult } from "../gateway";
import { callUsdOf, candidatesFor, capabilitiesOf, describeForModel, isProven, platformIndex, platformsOf } from "./catalogView";
import { FIELD_MAP_SCHEMA, FIELD_MAP_SYSTEM, FIELD_MAP_TOOL, TOOL_CHOICE_SCHEMA, TOOL_CHOICE_SYSTEM, TOOL_CHOICE_TOOL, UNDERSTAND_SCHEMA, UNDERSTAND_SYSTEM, UNDERSTAND_TOOL } from "./prompts";

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

export interface PlannerModelAnswer { input: unknown; costUsd: number }
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
  /** Today, for the model's dates (Cairo calendar day, YYYY-MM-DD). */
  today: string;
  /** What the customer reads while the plan is prepared (one short Arabic line per phase). Absent: nothing is said. */
  onProgress?: (lineAr: string) => Promise<void>;
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
}

export interface UnderstoodStep {
  key: string; title_ar: string; platform: string; capability: string; parent: string | null; deliver: boolean;
  count: { total: number | null; per_parent: number | null; all: boolean };
  source: { kind: string; value: string } | null; topic: string | null; search_terms: string[]; period: { from: string; to: string } | null;
  language?: string | null; country?: string | null; order?: "newest" | "top" | null; fields_wanted?: string[];
}
export interface Understanding {
  decision: "plan" | "ask" | "cannot"; understanding_ar: string; question_ar?: string; options_ar?: string[]; cannot_ar?: string; assumptions_ar?: string[]; no_repeat?: boolean; steps: UnderstoodStep[];
}

export type LlmPlanResult =
  | { kind: "plan"; plan: PricedPlan; understanding: Understanding; costUsd: number }
  | { kind: "question"; question_ar: string; options_ar: string[]; understanding: Understanding; costUsd: number }
  | { kind: "cannot"; reason_ar: string; understanding: Understanding | null; costUsd: number; detail: string };

/** Asked when the model's own question cannot be shown as it wrote it. */
export const GENERIC_QUESTION_AR = "ممكن توضّح طلبك أكثر: من أي منصة، وما الذي نجمعه بالضبط، وعن أي موضوع أو من أي حساب، وكم عددًا تريد؟";
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

const COLUMN_TITLES: Record<string, string> = {
  text: "النص", title: "العنوان", author: "الاسم", username: "الحساب", posted_at: "تاريخ النشر", link: "الرابط", likes: "الإعجابات", comments_count: "عدد التعليقات", replies_count: "عدد الردود",
  shares: "المشاركات", views: "المشاهدات", language: "اللغة", country: "الدولة",
};
const COLUMN_ORDER = ["text", "title", "author", "username", "posted_at", "link", "likes", "comments_count", "replies_count", "shares", "views", "language", "country"];

/** The platforms' Arabic names for the code-written sentences (a platform not listed is «المنصة»). */
export const PLATFORM_AR: Record<string, string> = {
  x: "إكس", tiktok: "تيك توك", instagram: "إنستجرام", facebook: "فيسبوك", youtube: "يوتيوب", reddit: "ريديت", linkedin: "لينكدإن", threads: "ثريدز", telegram: "تليجرام", google: "خرائط جوجل", pinterest: "بنترست",
  tripadvisor: "تريب أدفايزر", trustpilot: "ترست بايلوت", yelp: "يلب", "app-store": "متجر آبل", "google-play": "متجر جوجل بلاي", amazon: "أمازون", web: "الويب", bing: "الويب", rumble: "رمبل", spotify: "سبوتيفاي", github: "جيت هب", imdb: "آي إم دي بي",
};
export const platformAr = (p: string): string => PLATFORM_AR[p] ?? "المنصة";

/** A sentence of the model shown to the customer: Arabic digits, and only when it passes the customer-text rules (no Latin word, no id, no provider); else null. */
export function customerSafe(text: string | null | undefined, maxChars = 400): string | null {
  const t = toArabicDigits(String(text ?? "").replace(/\s+/g, " ").trim());
  if (!t) return null;
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
  if (input.question) lines.push("", `You asked the customer: ${input.question}`, `The customer answered: ${input.answer ?? ""}`);
  else if (input.answer) lines.push("", `The customer added: ${input.answer}`);
  return lines.join("\n");
}

const KEY_RE = /^[a-z][a-z0-9_]{0,30}$/;

/** What code checks in the model's understanding: catalog names, keys, parents, numbers. The error text goes back to the model once. */
export function checkUnderstanding(u: unknown, catalog: TregCatalog, access: AccountAccess | null): { ok: true; value: Understanding } | { ok: false; error: string } {
  if (!isObj(u)) return { ok: false, error: "the answer is not an object" };
  const decision = u.decision === "ask" || u.decision === "cannot" ? u.decision : "plan";
  const understanding_ar = str(u.understanding_ar);
  const base = { decision, understanding_ar, assumptions_ar: Array.isArray(u.assumptions_ar) ? u.assumptions_ar.map(str).filter(Boolean).slice(0, 8) : [], no_repeat: u.no_repeat === true } as Understanding;
  if (decision === "ask") {
    const q = str(u.question_ar);
    if (!q) return { ok: false, error: "decision ask needs question_ar" };
    return { ok: true, value: { ...base, question_ar: q, options_ar: Array.isArray(u.options_ar) ? u.options_ar.map(str).filter(Boolean).slice(0, 4) : [], steps: [] } };
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
    const names = new Set([...endpoint.inputs.map((i) => i.name), ...(endpoint.pagination ?? [])]);
    const cursor = str(o.cursor_input) && names.has(str(o.cursor_input)) ? str(o.cursor_input) : null;
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
    const params = clean(o.params ?? jsonObject(o.params_json));
    if (parent) delete params[parent.param];
    const missing = endpoint.inputs.filter((i) => i.required && !filled(params[i.name]) && i.name !== parent?.param && i.name !== cursor);
    if (missing.length > 0) continue;
    const more = (Array.isArray(o.more_params) ? o.more_params : Array.isArray(o.more_params_json) ? o.more_params_json.map(jsonObject) : []).map(clean).filter((p) => Object.keys(p).length > 0 && JSON.stringify(p) !== JSON.stringify(params)).slice(0, 6);
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
  return { fields, linkTemplate, extra };
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

interface BuiltStep {
  step: UnderstoodStep; option: ToolOption; mapCode: string; columns: PlanColumn[]; carryKeys: string[]; sampleRows: Array<Record<string, unknown>>; rowsPerPage: number; callIds: string[]; hasMore: boolean;
}

const asJson = (text: unknown): unknown => text;

/** Asks the model through the deps and counts what it cost. */
function asker(deps: Pick<LlmPlannerDeps, "model">, cost: { usd: number }) {
  return async (system: string, user: string, tool: { name: string; description: string; schema: Record<string, unknown> }, maxTokens: number): Promise<unknown | null> => {
    const got = await deps.model({ system, user, tool, maxTokens });
    if (!got) return null;
    cost.usd += Math.max(0, Number(got.costUsd) || 0);
    return asJson(got.input);
  };
}

/** 1. UNDERSTAND, with one retry carrying code's objection. */
export async function understandRequest(input: LlmPlannerInput, deps: Pick<LlmPlannerDeps, "model" | "catalog" | "access" | "today" | "log">, cost: { usd: number } = { usd: 0 }): Promise<{ ok: true; value: Understanding } | { ok: false; error: string }> {
  const ask = asker(deps, cost);
  const system = `${UNDERSTAND_SYSTEM}\n\nCATALOG INDEX (platform: capability(number of tools), …):\n${platformIndex(deps.catalog, deps.access)}`;
  const tool = { name: UNDERSTAND_TOOL, description: "The collection plan for the customer's request.", schema: UNDERSTAND_SCHEMA };
  const userPrompt = understandPrompt(input, deps.today);
  let checked: ReturnType<typeof checkUnderstanding> | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await ask(system, attempt === 0 ? userPrompt : `${userPrompt}\n\nYour previous answer could not be used: ${checked && !checked.ok ? checked.error : "no answer"}. Answer again using only names from the catalog index.`, tool, 4000);
    checked = answer === null ? { ok: false, error: "no answer" } : checkUnderstanding(answer, deps.catalog, deps.access);
    if (checked.ok) break;
    deps.log?.(`llm_planner_understand_retry ${checked.error.slice(0, 200)}`);
  }
  return checked ?? { ok: false, error: "no answer" };
}

/** 2. CHOOSE: the model's options for one step, checked against its candidates. */
export async function chooseTools(step: UnderstoodStep, parentSample: ReadonlyArray<Record<string, unknown>> | null, deps: Pick<LlmPlannerDeps, "model" | "catalog" | "access" | "today">, cost: { usd: number } = { usd: 0 }): Promise<{ candidates: CatalogEndpoint[]; options: ToolOption[] }> {
  const candidates = candidatesFor(deps.catalog, deps.access, step.platform, step.capability, 8, { alsoSearch: Boolean(step.source && step.topic && !step.parent) });
  if (candidates.length === 0) return { candidates, options: [] };
  const choice = await asker(deps, cost)(TOOL_CHOICE_SYSTEM, toolChoicePrompt(step, candidates, deps.today, parentSample), { name: TOOL_CHOICE_TOOL, description: "The tool and its inputs for this step.", schema: TOOL_CHOICE_SCHEMA }, 3000);
  return { candidates, options: checkOptions(choice, candidates, parentSample !== null) };
}

export async function planWithLlm(input: LlmPlannerInput, deps: LlmPlannerDeps): Promise<LlmPlanResult> {
  const cost = { usd: 0 };
  const ask = asker(deps, cost);
  const checked = await understandRequest(input, deps, cost);
  let costUsd = cost.usd;
  if (!checked.ok) return { kind: "cannot", reason_ar: "", understanding: null, costUsd, detail: `understand_failed: ${checked.error}` };
  const u = checked.value;
  if (u.decision === "ask") return { kind: "question", question_ar: customerSafe(u.question_ar) ?? GENERIC_QUESTION_AR, options_ar: (u.options_ar ?? []).map((o) => customerSafe(o, 80)).filter((o): o is string => o !== null), understanding: u, costUsd };
  if (u.decision === "cannot") return { kind: "cannot", reason_ar: customerSafe(u.cannot_ar ?? u.understanding_ar) ?? "", understanding: u, costUsd, detail: "model_cannot" };
  if (deps.accept && !deps.accept(u)) return { kind: "cannot", reason_ar: "", understanding: u, costUsd, detail: "handed_over" };
  const say = async (line: string | null): Promise<void> => { if (line && deps.onProgress) await deps.onProgress(line).catch(() => undefined); };
  await say(customerSafe(`فهمنا طلبك: ${u.understanding_ar.replace(/[.،\s]+$/u, "")}.`, 400) ?? "فهمنا طلبك، ونختار الآن المصادر المناسبة له.");

  // 2-4. EVERY STEP, parents first (the model's order already is: a parent must be an earlier step)
  const built = new Map<string, BuiltStep>();
  const unserved: Array<{ what_ar: string; reason_ar: string }> = [];
  for (const step of u.steps) {
    const parent = step.parent ? built.get(step.parent) ?? null : null;
    if (step.parent && !parent) { unserved.push({ what_ar: step.title_ar, reason_ar: "لم نتمكن من قراءة الخطوة التي تسبقها، فلن تُضاف هذه الخطوة ولن تُحسب في السعر." }); continue; }
    await say(customerSafe(`نختار المصدر المناسب لجمع ${step.title_ar} من ${platformAr(step.platform)} ونجرب عينة حقيقية منه.`, 200));
    const { candidates, options } = await chooseTools(step, parent ? parent.sampleRows : null, deps, cost);
    if (candidates.length === 0) { unserved.push({ what_ar: step.title_ar, reason_ar: "لا توجد لدينا أداة متاحة لهذه الخطوة الآن، فلن تُضاف ولن تُحسب في السعر." }); continue; }
    deps.log?.(`llm_planner_options ${step.key} ${options.map((o) => o.endpoint.id).join(",") || "none"}`);
    const got = await probeStep(step, options, parent, deps);
    if (!got) { unserved.push({ what_ar: step.title_ar, reason_ar: "جرّبنا الأدوات المتاحة لهذه الخطوة فلم تُعطِ نتائج الآن، فلن تُضاف ولن تُحسب في السعر." }); continue; }
    const mapAnswer = await ask(FIELD_MAP_SYSTEM, fieldMapPrompt(step, got.option.endpoint, got.items), { name: FIELD_MAP_TOOL, description: "Where each column is in an item.", schema: FIELD_MAP_SCHEMA }, 1500);
    const map = enrichedMap(checkFieldMap(mapAnswer, got.items), got.items);
    if (!map) { unserved.push({ what_ar: step.title_ar, reason_ar: "لم نتمكن من قراءة نتائج هذه الخطوة بشكل موثوق، فلن تُضاف ولن تُحسب في السعر." }); continue; }
    const carry = carryFieldsOf(got.items, map);
    const card = pseudoCard(got.option.endpoint, got.listPath, map, got.items.length, carry, got.items);
    const mapCode = cardMapCode(card);
    const sampleRows = runMap(mapCode, got.page);
    if (sampleRows.length === 0) { unserved.push({ what_ar: step.title_ar, reason_ar: "لم نتمكن من قراءة نتائج هذه الخطوة بشكل موثوق، فلن تُضاف ولن تُحسب في السعر." }); continue; }
    const columns: PlanColumn[] = [...COLUMN_ORDER.filter((k) => map.fields[k] || (k === "link" && map.linkTemplate)).map((k) => ({ key: k, title_ar: COLUMN_TITLES[k] })), ...map.extra.map((e) => ({ key: e.key, title_ar: e.title_ar }))];
    step.title_ar = customerSafe(step.title_ar, 60) ?? "العناصر";
    built.set(step.key, { step, option: got.option, mapCode, columns, carryKeys: Object.keys(carry), sampleRows, rowsPerPage: got.items.length, callIds: got.callIds, hasMore: got.hasMore });
  }
  costUsd = cost.usd;
  if (built.size === 0) return { kind: "cannot", reason_ar: unserved[0]?.reason_ar ?? "", understanding: u, costUsd, detail: "no_step_served" };

  // 5. PRICE
  await say("بنجهز العدد والسعر من العينة الحقيقية.");
  const plan = assemblePlan(u, [...built.values()], unserved, deps.pricingSettings);
  return { kind: "plan", plan, understanding: u, costUsd };
}

/** The model's map with the standard columns it left out filled from the common names (a thin map, id and link only, made a file a researcher cannot use: live TikTok, 15 Nov 2026). */
export function enrichedMap(map: FieldMap | null, items: ReadonlyArray<Record<string, unknown>>): FieldMap | null {
  const guess = fallbackMap(items);
  if (!map) return guess;
  if (!guess) return map;
  const fields = { ...map.fields };
  for (const [k, p] of Object.entries(guess.fields)) if (!fields[k] && !(k === "link" && map.linkTemplate)) fields[k] = p;
  return { ...map, fields };
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

interface Probed { option: ToolOption; page: unknown; items: Array<Record<string, unknown>>; listPath: string | null; callIds: string[]; hasMore: boolean }

/** ONE real first page per option, in the model's order; an option whose first input set is empty tries its further sets (a precise query may be empty where a broader one is not). At most MAX_PROBES_PER_STEP calls. */
async function probeStep(step: UnderstoodStep, options: ToolOption[], parent: BuiltStep | null, deps: LlmPlannerDeps): Promise<Probed | null> {
  let calls = 0;
  const callIds: string[] = [];
  for (const option of options) {
    const sets = [option.params, ...option.more];
    // a child is tried on up to PARENTS_TRIED parents, the most commented first (the newest post may have no comment yet): the first input set only
    const parentValues = option.parent && parent ? parentValuesOf(parent.sampleRows, option.parent.from) : [null];
    if (option.parent && parent && parentValues.length === 0) continue;
    const attempts: Array<{ set: number; parentValue: unknown }> = option.parent && parent ? parentValues.map((v) => ({ set: 0, parentValue: v })) : sets.map((_, i) => ({ set: i, parentValue: null }));
    for (const a of attempts) {
      if (calls >= MAX_PROBES_PER_STEP) break;
      const i = a.set;
      let params = { ...sets[i] };
      if (option.parent && parent) params = { ...params, [option.parent.param]: a.parentValue };
      calls += 1;
      const r = await deps.probe(option.endpoint.id, params);
      callIds.push(r.call_id);
      if (!r.ok) { deps.log?.(`llm_planner_probe ${step.key} ${option.endpoint.id} not ok`); if ("refused" in r) break; continue; }
      if (r.rows_in_page <= 0) { deps.log?.(`llm_planner_probe ${step.key} ${option.endpoint.id} empty`); continue; }
      const page = await deps.readPage(r.call_id);
      if (page === null) continue;
      const { reading } = buildShapeDigest(page, option.endpoint);
      if (reading.rows.length === 0) continue;
      // the input set that answered becomes the first one, the others follow it
      const reordered: ToolOption = i === 0 ? option : { ...option, params: sets[i], more: sets.filter((_, j) => j !== i) };
      return { option: reordered, page, items: reading.rows, listPath: reading.listPath, callIds, hasMore: Boolean(r.next_cursor) || r.has_more === true };
    }
    if (calls >= MAX_PROBES_PER_STEP) break;
  }
  return null;
}

/** Parents a child step is tried on: those that carry the binding's value, the most commented (or replied, or liked) first, at most PARENTS_TRIED. */
export const PARENTS_TRIED = 3;
export function parentValuesOf(rows: ReadonlyArray<Record<string, unknown>>, from: string): unknown[] {
  const n = (v: unknown): number => { const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN; return Number.isFinite(x) ? x : -1; };
  const score = (r: Record<string, unknown>): number => Math.max(n(r.comments_count), n(r.replies_count)) * 1000 + Math.max(0, n(r.likes)) / 1e6;
  return [...rows].filter((r) => filled(r[from])).sort((a, b) => score(b) - score(a)).slice(0, PARENTS_TRIED).map((r) => r[from]);
}

/** The plan in the shape every later part already reads (the card, the price, approval, the engine, the file, settlement). */
export function assemblePlan(u: Understanding, steps: ReadonlyArray<BuiltStep>, unserved: ReadonlyArray<{ what_ar: string; reason_ar: string }>, pricingSettings?: unknown): PricedPlan {
  const stages: PricedStage[] = [];
  const notes: string[] = [];
  const assumptions = (u.assumptions_ar ?? []).map((a) => customerSafe(a, 300)).filter((a): a is string => a !== null);
  const plannedOf = new Map<string, number>();
  for (const b of steps) {
    const s = b.step;
    const parentRows = s.parent ? plannedOf.get(s.parent) ?? 0 : 0;
    let planned: number;
    let perParent: number | undefined;
    if (s.parent) {
      perParent = s.count.per_parent ?? (s.count.all ? ALL_CHILDREN_CAP : s.count.total ? Math.max(1, Math.ceil(s.count.total / Math.max(1, parentRows))) : DEFAULT_PER_PARENT);
      planned = s.count.total ?? perParent * Math.max(1, parentRows);
      if (s.count.all) notes.push(`${s.title_ar}: نقرأ كل ما يعرضه المصدر لكل عنصر، بحد أقصى ${toArabicDigits(perParent)} لكل عنصر، ولا ندفع إلا مقابل ما يُسلَّم.`);
      else if (!s.count.per_parent && !s.count.total) assumptions.push(`لم تحدد عدد ${s.title_ar} لكل عنصر، فاخترنا ${toArabicDigits(perParent)}؛ يمكنك تعديله قبل الموافقة.`);
    } else {
      planned = s.count.total ?? DEFAULT_COUNT;
      if (s.count.total === null) assumptions.push(`لم تحدد عدد ${s.title_ar}، فاخترنا ${toArabicDigits(DEFAULT_COUNT)}؛ يمكنك تعديله قبل الموافقة.`);
    }
    planned = Math.max(1, Math.min(MAX_STEP_ITEMS, Math.floor(planned)));
    plannedOf.set(s.key, planned);
    if (b.option.notCarried.length > 0) notes.push(`${s.title_ar}: الأداة المتاحة لهذه الخطوة لا تحدد ${b.option.notCarried.map((c) => CONDITION_AR[c]).join(" ولا ")}، فستصلك كما يعرضها المصدر دون تصفية بها.`);
    const rowsPerPage = Math.max(1, b.rowsPerPage);
    const costPerRow = (callUsdOf(b.option.endpoint) / rowsPerPage) * VARIANT_OVERLAP_FACTOR;
    const alternatives = b.option.more.map((params) => ({ endpoint_id: b.option.endpoint.id, params, cursor_param: b.option.cursor, map_code: b.mapCode, map_file_id: "page", ...(b.option.parent ? { parent_binding: { param: b.option.parent.param, from: b.option.parent.from } } : {}) }));
    stages.push({
      key: s.key, title_ar: s.title_ar, endpoint_id: b.option.endpoint.id, capability: s.capability,
      expected_rows: planned, planned_rows: planned, parent_key: s.parent, ...(perParent !== undefined ? { per_parent_rows: perParent } : {}),
      ...(s.parent && s.count.all ? { children_cap_per_parent: perParent } : {}),
      deliver: s.deliver, columns: b.columns, sample_rows: b.sampleRows.slice(0, 3), measured_by: b.callIds, measured_from_calls: b.callIds, measured_cost_per_row_usd: costPerRow,
      yield_share: 1, review_share: 0,
      ...(b.carryKeys.length > 0 ? { carry_keys: [...b.carryKeys] } : {}),
      engine: {
        endpoint_id: b.option.endpoint.id, params: b.option.params, cursor_param: b.option.cursor, map_code: b.mapCode, map_file_id: "page",
        parent_binding: b.option.parent ? { param: b.option.parent.param, from: b.option.parent.from } : null, built_by: "code",
        ...(alternatives.length > 0 ? { alternatives } : {}),
      },
    } as unknown as PricedStage);
  }
  // a child binds to a field of its parent's row: that field is kept on the stored parent row even when it is not a column
  for (const st of stages) {
    const bind = st.engine?.parent_binding;
    if (!bind || !st.parent_key) continue;
    const p = stages.find((x) => x.key === st.parent_key);
    if (p && !p.columns.some((c) => c.key === bind.from) && bind.from !== "id") p.carry_keys = [...new Set([...(p.carry_keys ?? []), bind.from])];
  }
  for (const st of stages) if (st.carry_keys && st.carry_keys.length === 0) delete st.carry_keys;
  const price = priceMissionByCode(stagePriceInputs(stages), { settings: pricingSettings as never });
  const counts = stages.filter((s) => s.deliver).map((s) => `${s.title_ar}: ${toArabicDigits(s.planned_rows)}`).join("، ");
  const platforms = [...new Set(steps.map((b) => platformAr(b.step.platform)))].join(" و");
  const understood = customerSafe(u.understanding_ar.replace(/[.،\s]+$/u, ""), 300) ?? `نجمع ${stages.filter((s) => s.deliver).map((s) => s.title_ar).join(" و")} من ${platforms} كما طلبت`;
  const summary = `${understood}. ${counts ? `العدد المخطط: ${counts}.` : ""}`.trim();
  const widened = steps.some((b) => b.option.more.length > 0);
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
      llm: { understanding_ar: u.understanding_ar, steps: u.steps.map((s) => ({ key: s.key, platform: s.platform, capability: s.capability, source: s.source, topic: s.topic, period: s.period, terms: s.search_terms })) },
    } as PricedPlan["compiled"],
  } as PricedPlan;
}

/** Whether a probe's step had a proven tool (for the admin's trace). */
export const optionTrace = (o: ToolOption): string => `${o.endpoint.id}${isProven(o.endpoint.id) ? "*" : ""}`;
