import { normalizeArabic, foldDigits } from "../arabicNormalize";
import { toArabicDigits } from "../arabicDigits";
import { toBool } from "../coerce";
import { comparableValue, isIdLikeParamName, looksLikePlaceholder, valueIsInText } from "../paramProvenance";
import { knownEventWindow, parseRelativeWindow, parseStatedDates } from "../timeWindow";
import { blockedEndpointReason } from "../treg/blockList";
import { isSellable, type CatalogEndpoint, type CatalogInput, type TregCatalog } from "../treg/catalog";
import { categoryOf, policyVerdict, type AccountAccess, type PolicyCategoryOrUnknown } from "../treg/dataPolicy";
import { MIN_PURPOSE_CHARS } from "../server/sensitiveAccess";
import { digestFromCatalogExample, type ShapeDigest } from "./digest";
import { applyPlanToRows, columnsOfMap, readField, readDateIso } from "./fieldMap";
import { maskText } from "../server/rawCapture";
import { MAX_PLAN_STAGES, SAMPLE_ROWS_ON_CARD } from "./constants";
import { callEstimateUsd, pricePlan, priceStep, unitCost, type CallCost, type PlanPrice, type StepMeasure, type StepPrice } from "./pricing";
import type { RecipeRecord } from "./recipes";
import type { PlanParam, PlanStep, ProposePlanInput, StepFacts, StoredModelPlan, ValidationIssue } from "./types";

type Obj = Record<string, unknown>;

/** What a sample call of this turn found out about an endpoint: the raw rows (as the shape reader read them) and their digest. */
export interface StepSample { endpointId: string; rows: Obj[]; digest: ShapeDigest; costUsd: number }

export interface ValidateContext {
  /** Everything the customer wrote for this request (their own words only). */
  customerText: string;
  access: AccountAccess;
  catalog: TregCatalog;
  samples: ReadonlyMap<string, StepSample>;
  /** The purpose a customer account gave for a sensitive step (the answer to the purpose question). */
  purpose?: string | null;
  measuredAvgCallUsd?: (endpointId: string) => number | null;
  /** Saved recipes (plans that already delivered), by first endpoint: fields known to exist and what was measured, so a plan may skip the sample call. */
  recipes?: ReadonlyMap<string, RecipeRecord>;
  today?: Date;
}

export interface ValidatedStep {
  step: PlanStep;
  endpoint: CatalogEndpoint;
  category: PolicyCategoryOrUnknown;
  callCost: CallCost;
  price: StepPrice;
  /** What one call of this step may cost, for the job's budget (a per-record endpoint: the page it asks for). */
  callEstimateUsd: number;
}

export interface ValidatedPlan {
  summaryAr: string;
  topic?: string;
  steps: ValidatedStep[];
  price: PlanPrice;
  /** True when any step is of the SENSITIVE category (only an allowed account gets this far). */
  sensitive: boolean;
  /** The plan as it is stored on the quote item and run by the interpreter. */
  stored: StoredModelPlan;
  /** Up to three real rows of the sample, written as the plan's columns and masked (for the plan card). */
  sampleRows: Array<Record<string, unknown>>;
  sampleColumns: Array<{ key: string; titleAr: string }>;
}

export type ValidationResult = { ok: true; plan: ValidatedPlan } | { ok: false; issues: ValidationIssue[] };

const issue = (code: ValidationIssue["code"], message: string, extra: Partial<ValidationIssue> = {}): ValidationIssue => ({ code, message, ...extra });

const WINDOW_TOKENS = new Set(["date", "dates", "from", "to", "since", "until", "start", "end", "period", "window", "time", "timeframe", "days", "recent", "published", "posted", "range", "year", "month", "week", "after", "before", "interval", "timespan", "daterange"]);
const tokensOfName = (name: string): string[] => String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => t.toLowerCase());
/** A parameter that sets a period (datePosted, publish_time, since, start_date…): never set without the customer's own words about the period. */
export function isWindowParamName(name: string): boolean {
  const tokens = tokensOfName(name);
  if (tokens.includes("sort") || tokens.includes("order")) return false;
  return tokens.some((t) => WINDOW_TOKENS.has(t));
}

/** The period the customer's own words state (dates, a relative period, a known event), or null. */
export function statedWindowOf(text: string, today: Date = new Date()): { from: string; to: string } | null {
  const stated = parseStatedDates(text, today);
  if (stated && "from" in stated) return { from: stated.from, to: stated.to };
  const relative = parseRelativeWindow(text, today);
  if (relative) return { from: relative.from, to: relative.to };
  const event = knownEventWindow(text, today);
  if (event) return { from: event.from, to: event.to };
  return null;
}

const comparableText = (s: string): string => foldDigits(normalizeArabic(String(s ?? ""))).replace(/\s+/g, " ");
/** True when the quote is the customer's own words: it occurs in what they wrote (spelling, hamza and digits folded). */
export function quoteIsFromCustomer(quote: string | undefined, customerText: string): boolean {
  const q = comparableText(quote ?? "").trim();
  return q.length >= 2 && comparableText(customerText).includes(q);
}

const typeClass = (t: string | null): "string" | "int" | "number" | "bool" | "array" | "object" | "any" => {
  const s = String(t ?? "").toLowerCase();
  if (/^(integer|int)(,|$)/.test(s) || s === "integer" || s === "int") return "int";
  if (s === "number" || s === "float" || s === "double") return "number";
  if (s === "boolean" || s === "bool") return "bool";
  if (s.startsWith("array") || s === "list" || s === "string_or_array" || /list$/.test(s)) return "array";
  if (s === "object" || s === "dict") return "object";
  if (s === "string" || s === "str" || s === "url" || s === "text") return "string";
  return "any";
};

/** Checks a value against what the catalog says the parameter takes. Returns a problem or null. */
export function checkParamValue(input: CatalogInput, value: unknown): { code: ValidationIssue["code"]; message: string } | null {
  const cls = typeClass(input.type);
  const name = input.name;
  if (cls === "int" || cls === "number") {
    const n = typeof value === "number" ? value : Number(foldDigits(String(value)));
    if (!Number.isFinite(n)) return { code: "bad_param_type", message: `parameter «${name}» takes a number, got «${String(value).slice(0, 40)}»` };
    if (cls === "int" && !Number.isInteger(n)) return { code: "bad_param_type", message: `parameter «${name}» takes a whole number` };
    if (input.minimum !== null && n < input.minimum) return { code: "bad_param_range", message: `parameter «${name}» must be at least ${input.minimum}` };
    if (input.maximum !== null && n > input.maximum) return { code: "bad_param_range", message: `parameter «${name}» must be at most ${input.maximum}` };
  } else if (cls === "bool") {
    if (toBool(value) === undefined) return { code: "bad_param_type", message: `parameter «${name}» takes true or false` };
  } else if (cls === "array") {
    if (!Array.isArray(value) && typeof value !== "string") return { code: "bad_param_type", message: `parameter «${name}» takes a list` };
  } else if (cls === "string") {
    if (typeof value !== "string" && typeof value !== "number") return { code: "bad_param_type", message: `parameter «${name}» takes text` };
  }
  if (Array.isArray(input.enum) && input.enum.length > 0) {
    const allowed = input.enum.map((e) => String(e));
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    if (!values.every((v) => allowed.includes(v))) return { code: "bad_param_enum", message: `parameter «${name}» must be one of: ${allowed.slice(0, 20).join(", ")}` };
  }
  return null;
}

/** The value a param sends: its value, or the customer's quote when no value was given. */
export function resolvedParamValue(p: PlanParam): unknown {
  if (p.source === "prior_step") return undefined;
  return p.value !== undefined ? p.value : p.quote;
}

function sampleRowsFor(step: PlanStep, ctx: ValidateContext, endpoint: CatalogEndpoint): { rows: Obj[]; source: StepMeasure["source"]; digest: ShapeDigest | null } {
  const sample = ctx.samples.get(step.endpointId);
  if (sample && sample.rows.length > 0) return { rows: sample.rows, source: "sample", digest: sample.digest };
  const fromExample = digestFromCatalogExample(endpoint);
  if (fromExample && fromExample.reading.rows.length > 0) return { rows: fromExample.reading.rows, source: "catalog_example", digest: fromExample.digest };
  return { rows: [], source: "assumed", digest: null };
}

/**
 * The parameters of one call against the endpoint's own inputs and the customer's words: every value has a source, a quote is the customer's own words, an account, link or id is
 * never a literal, a placeholder is never a value, a period is never set without the customer stating one, and the type, the allowed values and the range are the catalog's.
 * `priorStep` is how a value «from a prior step» is checked (only a step 2 may use one).
 */
export function checkParams(params: ReadonlyArray<PlanParam>, endpoint: CatalogEndpoint, ctx: Pick<ValidateContext, "customerText" | "today">, at: { stepIndex: number }, issues: ValidationIssue[], priorStep?: { columns: ReadonlyArray<{ field: string }> } | null): Map<string, PlanParam> {
  const inputsByName = new Map(endpoint.inputs.map((i) => [i.name, i]));
  const given = new Map<string, PlanParam>();
  for (const p of params) {
    const input = inputsByName.get(p.name);
    const pAt = { ...at, param: p.name };
    if (!input) { issues.push(issue("unknown_param", `endpoint «${endpoint.id}» has no parameter «${p.name}». Its parameters: ${[...inputsByName.keys()].slice(0, 25).join(", ")}`, pAt)); continue; }
    given.set(p.name, p);
    if (p.source === "prior_step") {
      if (!priorStep || !p.fromStep || p.fromStep.step !== 1) issues.push(issue("bad_step_reference", "a value from a prior step is allowed only in step 2 and must say which field of step 1's rows it comes from (fromStep: {step: 1, field})", pAt));
      else if (!priorStep.columns.some((c) => c.field === p.fromStep!.field)) issues.push(issue("bad_step_reference", `step 1 has no column with field «${p.fromStep.field}»: add it to step 1's field map`, pAt));
      continue;
    }
    const value = resolvedParamValue(p);
    if (value === undefined || value === null || value === "") { issues.push(issue("no_provenance", `parameter «${p.name}» has no value`, pAt)); continue; }
    const leaves = (v: unknown): string[] => (typeof v === "string" || typeof v === "number" ? [String(v)] : Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === "object" ? Object.values(v as Record<string, unknown>).flatMap(leaves) : []);
    const texts = leaves(value);
    if (texts.some((v) => looksLikePlaceholder(v))) { issues.push(issue("invented_value", `parameter «${p.name}» holds a placeholder, not a real value. If the customer did not give it, do not invent it: end with ONE short Arabic message asking for it.`, pAt)); continue; }
    if (p.source === "customer_text" || p.source === "derived") {
      if (!p.quote || !quoteIsFromCustomer(p.quote, ctx.customerText)) { issues.push(issue("quote_not_in_customer_text", `the quote for «${p.name}» is not in the customer's words. Quote exactly what the customer wrote, or do not set this parameter.`, pAt)); continue; }
      if (p.source === "derived" && isIdLikeParamName(p.name)) { issues.push(issue("id_like_literal", `«${p.name}» names an account, link or id: it must be what the customer wrote (source customer_text), never derived.`, pAt)); continue; }
      if (p.source === "customer_text" && typeof value === "string" && p.value !== undefined && !comparableText(p.quote).includes(comparableValue(value)) && !valueIsInText(value, p.quote)) {
        issues.push(issue("quote_not_in_customer_text", `the value of «${p.name}» is not contained in its quote. The value must be what the customer wrote (a handle, a link, a number, a word).`, pAt)); continue;
      }
    } else if (p.source === "literal") {
      if (isIdLikeParamName(p.name)) { issues.push(issue("id_like_literal", `«${p.name}» names an account, link or id: it must come from the customer's words (source customer_text with the exact quote), never a literal.`, pAt)); continue; }
    }
    if (isWindowParamName(p.name)) {
      const win = statedWindowOf(p.source === "customer_text" || p.source === "derived" ? p.quote ?? "" : "", ctx.today);
      if ((p.source !== "customer_text" && p.source !== "derived") || !win) { issues.push(issue("window_not_stated", `«${p.name}» sets a time period. Never set a period the customer did not state: remove it. A period counts only when the customer's own words give it (source customer_text and the exact words).`, pAt)); continue; }
      // a date written in the value must lie inside the period the customer's own words give
      const iso = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(value.trim())?.[1] : undefined;
      if (iso && (iso < win.from || iso > win.to)) { issues.push(issue("window_not_stated", `«${p.name}» is ${iso}, outside the period the customer's words give (${win.from} to ${win.to})`, pAt)); continue; }
    }
    const problem = checkParamValue(input, value);
    if (problem) issues.push(issue(problem.code, problem.message, pAt));
  }
  return given;
}

function validateStep(step: PlanStep, index: number, plan: ProposePlanInput, ctx: ValidateContext, issues: ValidationIssue[]): ValidatedStep | null {
  const at = { stepIndex: index };
  const before = issues.length;
  const endpoint = ctx.catalog.byId.get(step.endpointId);
  if (!endpoint || !isSellable(step.endpointId, ctx.catalog)) {
    issues.push(issue("unknown_endpoint", `«${step.endpointId}» is not an endpoint of the catalog. Use catalog_search to find a real id.`, at));
    return null;
  }
  const verdict = policyVerdict(step.endpointId, ctx.access);
  const blocked = blockedEndpointReason(step.endpointId, endpoint.scope);
  if (!verdict.allowed || blocked) {
    issues.push(issue("not_allowed", "this endpoint cannot be used for this customer. Do not offer it; choose another endpoint or end with a short Arabic message.", at));
    return null;
  }
  const category = categoryOf(step.endpointId);
  const callCost = unitCost(endpoint, ctx.catalog, ctx.measuredAvgCallUsd?.(step.endpointId) ?? null);
  if (!callCost) {
    issues.push(issue("not_priceable", "this endpoint has no price per call or per record in the catalog, so it cannot be sold. Choose another endpoint.", at));
    return null;
  }

  // ---- parameters
  const inputsByName = new Map(endpoint.inputs.map((i) => [i.name, i]));
  const given = checkParams(step.params, endpoint, ctx, at, issues, index === 1 ? { columns: plan.steps[0].fieldMap.columns } : null);
  const managed = new Set([...(step.fieldMap.pagination.param ? [step.fieldMap.pagination.param] : []), ...(step.fieldMap.pagination.limitParam ? [step.fieldMap.pagination.limitParam] : [])]);
  for (const input of endpoint.inputs) {
    if (input.required && !given.has(input.name) && !managed.has(input.name)) issues.push(issue("missing_required", `endpoint «${step.endpointId}» needs the parameter «${input.name}»${input.type ? ` (${input.type})` : ""}. If the customer did not provide it, end with ONE short Arabic message asking for it; never invent it.`, { ...at, param: input.name }));
  }

  // ---- pagination declaration
  const pg = step.fieldMap.pagination;
  const known = new Set([...inputsByName.keys(), ...endpoint.pagination]);
  if (pg.kind !== "single" && pg.kind !== undefined) {
    if (!pg.param || !known.has(pg.param)) issues.push(issue("bad_pagination", `pagination parameter «${pg.param ?? ""}» is not a parameter of this endpoint (${[...known].slice(0, 20).join(", ")})`, at));
  }
  if (pg.limitParam && !known.has(pg.limitParam)) issues.push(issue("bad_pagination", `page-size parameter «${pg.limitParam}» is not a parameter of this endpoint`, at));

  // ---- field map and filters against REAL rows (the sample), or the catalog's example
  const evidence = sampleRowsFor(step, ctx, endpoint);
  const recipe = ctx.recipes?.get(step.endpointId) ?? null;
  const recipeCovers = Boolean(recipe) && evidence.source !== "sample" && step.fieldMap.columns.every((c) => recipe!.knownFields.includes(c.field)) && step.filters.every((f) => recipe!.knownFields.includes(f.field));
  if (recipeCovers) {
    // a saved recipe already proved these fields on real rows: no sample call is needed, and what it measured prices the step
    const idx = Math.min(index, Math.max(0, recipe!.measured.length - 1));
    const m = recipe!.measured[idx];
    const price = priceStep(callCost, { rowsPerCall: m?.rowsPerCall ?? 1, passRate: m?.passRate ?? 1, source: "recipe" });
    return { step, endpoint, category, callCost, price, callEstimateUsd: callEstimateUsd(callCost) };
  }
  if (evidence.rows.length === 0 && category !== "sensitive") {
    issues.push(issue("no_sample_rows", "there are no rows to check the field map against: call sample_call for this endpoint first.", at));
  } else if (evidence.rows.length > 0) {
    // on REAL sample rows a field must hold a value in at least one row; the catalog's example holds hand-trimmed rows where a field may be null: there, the field existing is enough
    const present = (path: string) => evidence.rows.some((r) => { const v = readField(r, path); return evidence.source === "catalog_example" ? v !== undefined : v !== undefined && v !== null && v !== ""; });
    const fields = evidence.digest?.fields.map((f) => f.path).slice(0, 30).join(", ") ?? "";
    for (const col of step.fieldMap.columns) {
      if (!present(col.field)) issues.push(issue("bad_field_path", `column «${col.headerAr}»: no row has a value at «${col.field}». Fields seen: ${fields}`, at));
      else if ((col.role === "date" || col.transform === "unix_s_to_iso" || col.transform === "unix_ms_to_iso") && evidence.rows.every((r) => { const v = readField(r, col.field); return v === undefined || v === null || v === "" || readDateIso(v, col.transform === "unix_ms_to_iso" ? "unix_ms" : col.transform === "unix_s_to_iso" ? "unix_s" : undefined) === undefined; })) issues.push(issue("bad_transform", `column «${col.headerAr}»: the value at «${col.field}» cannot be read as a date`, at));
    }
    if (step.fieldMap.rowsPath && evidence.digest?.listPath && step.fieldMap.rowsPath !== evidence.digest.listPath) issues.push(issue("bad_rows_path", `rowsPath «${step.fieldMap.rowsPath}» is not where the list of rows is (it is at «${evidence.digest.listPath}»)`, at));
    for (const f of step.filters) {
      if (!present(f.field)) { issues.push(issue("bad_filter", `filter field «${f.field}» is not in the rows. Fields seen: ${fields}`, at)); continue; }
      if (f.kind === "author_equals") {
        if (!quoteIsFromCustomer(f.quote, ctx.customerText) || !(valueIsInText(f.value, f.quote) || comparableText(f.quote).includes(comparableValue(f.value)))) issues.push(issue("bad_filter", "author_equals: the account must be the one the customer wrote (value contained in an exact quote of their words)", at));
      } else if (f.kind === "exclude_true") {
        if (!evidence.rows.some((r) => toBool(readField(r, f.field)) !== undefined)) issues.push(issue("bad_filter", `exclude_true: «${f.field}» is not a true/false field`, at));
      } else if (f.kind === "exclude_prefix") {
        if (!evidence.rows.some((r) => typeof readField(r, f.field) === "string")) issues.push(issue("bad_filter", `exclude_prefix: «${f.field}» is not a text field`, at));
      } else if (f.kind === "date_window") {
        const win = quoteIsFromCustomer(f.quote, ctx.customerText) ? statedWindowOf(f.quote, ctx.today) : null;
        if (!win) issues.push(issue("window_not_stated", "date_window: the customer did not state a period in these words. Never add a period of your own: remove this filter.", at));
        else if (f.from !== win.from || f.to !== win.to) issues.push(issue("bad_filter", `date_window: the customer's words give ${win.from} to ${win.to}`, at));
      }
    }
  }
  if (issues.length > before) return null;

  // ---- measured price of this step
  let measure: StepMeasure = { rowsPerCall: 1, passRate: 1, source: "assumed" };
  if (evidence.rows.length > 0) {
    const applied = applyPlanToRows(evidence.rows, step.fieldMap, step.filters);
    if (applied.records.length === 0 && evidence.source === "sample") {
      issues.push(issue("zero_pass_rate", `none of the ${evidence.rows.length} sample rows pass your filters and field map (${JSON.stringify(applied.dropped)}). Adjust them, or end with a short Arabic message saying the data was not found.`, at));
      return null;
    }
    // a catalog example holds 1-3 hand-trimmed rows: all of them are counted as passing (an example is not a measurement of a filter)
    measure = { rowsPerCall: evidence.rows.length, passRate: evidence.source === "sample" ? applied.records.length / evidence.rows.length : 1, source: evidence.source };
  }
  const price = priceStep(callCost, measure);
  return { step, endpoint, category, callCost, price, callEstimateUsd: callEstimateUsd(callCost) };
}

const LIMIT_NAMES = ["limit", "count", "page_size", "per_page", "size", "num", "max_results", "maxItems", "max_items", "n", "Count", "pageSize", "perPage"];

function factsOf(v: ValidatedStep, ctx: ValidateContext): StepFacts {
  const sample = ctx.samples.get(v.step.endpointId);
  const limitParam = v.step.fieldMap.pagination.limitParam;
  const limitInput = v.endpoint.inputs.find((i) => i.name === limitParam) ?? v.endpoint.inputs.find((i) => LIMIT_NAMES.includes(i.name));
  return {
    method: v.endpoint.method === "GET" ? "GET" : "POST",
    scope: v.endpoint.scope,
    limitName: limitInput?.name ?? null,
    limitMax: limitInput?.maximum ?? null,
    listPath: v.step.fieldMap.rowsPath ?? sample?.digest.listPath ?? (v.endpoint.list_path && v.endpoint.list_path !== "NOT FOUND" ? v.endpoint.list_path : null),
    cursorPath: v.step.fieldMap.pagination.cursorPath ?? sample?.digest.nextCursorPath ?? v.endpoint.cursor_path ?? null,
    // a field the example held as null has no type worth storing (and a stored «null» word would read as a missing value to the scope guard)
    itemFields: v.endpoint.item_fields ? Object.fromEntries(Object.entries(v.endpoint.item_fields).filter(([, f]) => f.type && f.type !== "null").slice(0, 60).map(([k, f]) => [k, { type: f.type }])) : null,
    callEstimateUsd: v.callEstimateUsd,
  };
}

const MONEY_WORDS = /نقطة|نقاط|نقطه|جنيه|ج\.م|دولار|مجان|رخيص|غالي|سعر|تكلف|ثمن|رصيد|\$|USD|EGP|credit|points?\b|price|cost/i;

/**
 * The goal line of the plan card is written by the model, so code makes it safe: no markdown, no emoji, no money word (the model never states a price or a cost), no Latin word that is not
 * in the customer's own text (no provider, no endpoint id), Arabic-Indic digits. When it cannot be made safe it is replaced by a plain line built from the volume.
 */
export function safeSummaryAr(summary: string, volume: number, customerText: string): string {
  const fallback = `جمع ${toArabicDigits(volume)} سجل حسب طلبك`;
  const cleaned = String(summary ?? "").replace(/```[\s\S]*?```/g, " ").replace(/[*_#`>|]+/g, " ").replace(/\p{Extended_Pictographic}/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 200 || !/[\u0600-\u06FF]/.test(cleaned) || MONEY_WORDS.test(cleaned)) return fallback;
  if (/\b[a-z0-9-]+\.[a-z0-9_.-]{2,}\b/i.test(cleaned.replace(/https?:\/\/\S+/g, ""))) return fallback;
  const own = comparableText(customerText);
  for (const word of cleaned.split(/[^A-Za-z0-9_]+/).filter((w) => /[A-Za-z]{3,}/.test(w))) if (!own.includes(word.toLowerCase())) return fallback;
  return toArabicDigits(cleaned);
}

/** Validates a whole proposed plan against the catalog, the policy, the customer's words and the real sample rows, and prices it. Pure: no network. */
export function validatePlan(input: ProposePlanInput, ctx: ValidateContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (input.steps.length > MAX_PLAN_STAGES) return { ok: false, issues: [issue("too_many_stages", `a plan has at most ${MAX_PLAN_STAGES} steps`)] };
  if (input.steps.length === 2) {
    if (!input.steps[1].params.some((p) => p.source === "prior_step")) issues.push(issue("bad_step_reference", "step 2 must take a parameter from step 1's rows (source prior_step), otherwise it is not a second step", { stepIndex: 1 }));
    if (input.steps[0].params.some((p) => p.source === "prior_step")) issues.push(issue("bad_step_reference", "step 1 cannot depend on a prior step", { stepIndex: 0 }));
  }
  const validated: ValidatedStep[] = [];
  input.steps.forEach((step, i) => {
    if (step.volume < 1) issues.push(issue("volume", "volume must be at least 1", { stepIndex: i }));
    const v = validateStep(step, i, input, ctx, issues);
    if (v) validated.push(v);
  });
  if (issues.length > 0 || validated.length !== input.steps.length) return { ok: false, issues };

  const sensitive = validated.some((v) => v.category === "sensitive");
  if (sensitive && !ctx.access.isAdmin && String(ctx.purpose ?? "").trim().length < MIN_PURPOSE_CHARS) {
    return { ok: false, issues: [issue("sensitive_purpose", "a purpose of use is required for this service before the plan can be approved")] };
  }
  const second = validated[1];
  const price = pricePlan(validated.map((v) => v.price), second ? (input.steps[1].perItem ?? Math.max(1, second.price.rowsPerCall * second.price.passRate)) : undefined);
  const last = validated[validated.length - 1];
  const sampleSource = ctx.samples.get(last.step.endpointId);
  // the card shows rows of a REAL sample call only: never the catalog's documentation example (not this customer's data), never a sensitive endpoint's rows
  const sampleRaw = !sensitive && sampleSource && sampleSource.rows.length > 0 ? sampleSource.rows : [];
  const applied = applyPlanToRows(sampleRaw, last.step.fieldMap, last.step.filters);
  const maskRecord = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? maskText(v).slice(0, 160) : v]));
  const sampleRows = sensitive ? [] : applied.records.slice(0, SAMPLE_ROWS_ON_CARD).map(maskRecord);
  const sampleColumns = columnsOfMap(last.step.fieldMap).map((c) => ({ key: c.key, titleAr: c.titleAr }));
  return {
    ok: true,
    plan: {
      summaryAr: safeSummaryAr(input.summaryAr, last.step.volume, ctx.customerText),
      ...(input.topic ? { topic: input.topic } : {}),
      steps: validated,
      price,
      sensitive,
      stored: { v: 1, steps: validated.map((v) => ({ ...v.step, params: v.step.params.map((p) => (p.source === "prior_step" ? p : { ...p, value: resolvedParamValue(p) as PlanParam["value"] })), facts: factsOf(v, ctx) })), ...(input.topic ? { topic: input.topic } : {}), measured: validated.map((v) => ({ rowsPerCall: v.price.rowsPerCall, passRate: v.price.passRate, costPerCallUsd: v.price.costPerCallUsd })) },
      sampleRows,
      sampleColumns,
    },
  };
}

