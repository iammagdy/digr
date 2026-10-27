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
import { DEFAULT_HOLD_CEILING_POINTS, MANAGER_BUDGET_FLOOR_USD, MANAGER_BUDGET_SHARE, MAX_PLAN_STAGES, RESERVE_MARGIN, SAMPLE_ROWS_ON_CARD } from "./constants";
import { reserveForUnits } from "../recordPricing";
import { safeStageTitleAr } from "./customerSafe";
import { countryOfRequest, countryRowGate, type RequestCountry } from "./countryGate";
import { callEstimateUsd, pricePlan, priceMission, priceStep, rowsPerParentOf, unitCost, type CallCost, type MissionPrice, type PlanPrice, type StepMeasure, type StepPrice } from "./pricing";
import { MAX_RUNTIME_ALTERNATES } from "./constants";
import { mapParamsToSibling, rankSiblings } from "./siblings";
import { readStepRows } from "./reader";
import { recipeMeasureFor, type RecipeRecord } from "./recipes";
import type { PlanParam, PlanStep, ProposePlanInput, StepFacts, StoredModelPlan, StoredStage, ValidationIssue } from "./types";
import { checkParamValue, isWindowParamName, resolvedParamValue } from "./paramRules";
export { checkParamValue, isWindowParamName, resolvedParamValue } from "./paramRules";

type Obj = Record<string, unknown>;

/** What a sample call of this turn found out about an endpoint: the raw rows (as the shape reader read them) and their digest. */
export interface StepSample { endpointId: string; rows: Obj[]; digest: ShapeDigest; costUsd: number; /** Rows each measured page returned (two pages when the answer had a next page and the budget allowed). */ pageRows?: number[]; /** The raw answer of the sample call (memory only, never stored): the validator reads it again the way the worker will. */ body?: unknown }

export interface ValidateContext {
  /** Everything the customer wrote for this request (their own words only). */
  customerText: string;
  access: AccountAccess;
  catalog: TregCatalog;
  samples: ReadonlyMap<string, StepSample>;
  /** The purpose a customer account gave for a sensitive step (the answer to the purpose question). */
  purpose?: string | null;
  measuredAvgCallUsd?: (endpointId: string) => number | null;
  /** An EDIT of a plan the customer was already shown: the approved plan, whose measured values (taken from a real sample) price the unchanged steps again without a new sample. */
  approved?: StoredModelPlan;
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

/** What the rows of an endpoint are about, from the catalog's platform. */
export function entityOfEndpoint(endpoint: CatalogEndpoint): "company" | "person" | null {
  const platform = String(endpoint.platform ?? "").toLowerCase();
  return platform === "companies" ? "company" : platform === "people" ? "person" : null;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Where the rows a field map is checked against come from. Only «sample» (a real call) may set a price; «catalog_example» only shows that a field exists. */
function sampleRowsFor(step: PlanStep, ctx: ValidateContext, endpoint: CatalogEndpoint): { rows: Obj[]; source: "sample" | "catalog_example" | "assumed"; digest: ShapeDigest | null } {
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
export type PriorStepLookup = (stepNumber: number) => { columns: ReadonlyArray<{ field: string }> } | null;
export function checkParams(params: ReadonlyArray<PlanParam>, endpoint: CatalogEndpoint, ctx: Pick<ValidateContext, "customerText" | "today">, at: { stepIndex: number }, issues: ValidationIssue[], priorStep?: { columns: ReadonlyArray<{ field: string }> } | PriorStepLookup | null): Map<string, PlanParam> {
  const inputsByName = new Map(endpoint.inputs.map((i) => [i.name, i]));
  const given = new Map<string, PlanParam>();
  for (const p of params) {
    const input = inputsByName.get(p.name);
    const pAt = { ...at, param: p.name };
    if (!input) { issues.push(issue("unknown_param", `endpoint «${endpoint.id}» has no parameter «${p.name}». Its parameters: ${[...inputsByName.keys()].slice(0, 25).join(", ")}`, pAt)); continue; }
    given.set(p.name, p);
    if (p.source === "prior_step") {
      const lookup: PriorStepLookup | null = !priorStep ? null : typeof priorStep === "function" ? priorStep : (n) => (n === 1 ? priorStep : null);
      if (!lookup || !p.fromStep) issues.push(issue("bad_step_reference", "a value from a prior step is allowed only in a later step and must say which field of which earlier step's rows it comes from (fromStep: {step, field})", pAt));
      else {
        const earlier = lookup(p.fromStep.step);
        if (!earlier) issues.push(issue("bad_step_reference", `step ${p.fromStep.step} is not an earlier step of this plan: a step takes values only from a step before it`, pAt));
        else if (!earlier.columns.some((c) => c.field === p.fromStep!.field)) issues.push(issue("bad_step_reference", `step ${p.fromStep.step} has no column with field «${p.fromStep.field}». Its columns' fields: ${earlier.columns.map((c) => c.field).join(", ")}. Add the field to that step's field map (the real fields are in its sample), or use one of these`, pAt));
      }
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
  const given = checkParams(step.params, endpoint, ctx, at, issues, index >= 1 ? (n) => (n >= 1 && n <= index ? { columns: plan.steps[n - 1].fieldMap.columns } : null) : null);
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

  // ---- an edit of an approved plan: the unchanged step keeps what the real sample measured, and is priced again from today's catalog cost
  const approvedStep = ctx.approved?.steps[index];
  if (approvedStep && approvedStep.endpointId === step.endpointId && sameJson(approvedStep.fieldMap, step.fieldMap) && sameJson(approvedStep.filters, step.filters)) {
    if (issues.length > before) return null;
    const m = ctx.approved!.measured[index];
    if (m) return { step, endpoint, category, callCost, price: priceStep(callCost, { rowsPerCall: m.rowsPerCall, passRate: m.passRate, source: "approved_plan" }), callEstimateUsd: callEstimateUsd(callCost) };
  }

  // ---- field map and filters against REAL rows (the sample), or the catalog's example
  const evidence = sampleRowsFor(step, ctx, endpoint);
  const country = index === 0 ? countryOfRequest(ctx.customerText) : null;
  const rowGate = countryRowGate(country, entityOfEndpoint(endpoint));
  const recipe = ctx.recipes?.get(step.endpointId) ?? null;
  const recipeCovers = Boolean(recipe) && evidence.source !== "sample" && step.fieldMap.columns.every((c) => recipe!.knownFields.includes(c.field)) && step.filters.every((f) => recipe!.knownFields.includes(f.field));
  if (recipeCovers) {
    // a saved recipe already proved these fields on real rows: no sample call is needed, and what it measured prices the step
    const m = recipeMeasureFor(recipe!, step.endpointId, index);
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

  // ---- measured price of this step: from a REAL sample, a saved recipe (above), the catalog's per-record unit, or a lookup of the sensitive category. NEVER from the catalog's example.
  let measure: StepMeasure | null = null;
  if (evidence.source === "sample" && evidence.rows.length > 0) {
    const applied = applyPlanToRows(evidence.rows, step.fieldMap, step.filters, rowGate);
    if (applied.records.length === 0) {
      const why = applied.dropped.geo > 0 ? ` ${applied.dropped.geo} of them are outside the country the customer named (${country?.canonicalEnglish}): never deliver them.` : "";
      issues.push(issue("zero_pass_rate", `none of the ${evidence.rows.length} sample rows pass your filters and field map (${JSON.stringify(applied.dropped)}).${why} Adjust them, or end with a short Arabic message saying the data was not found.`, at));
      return null;
    }
    // rows RETURNED per call, measured on every page the sample took: with two pages the SMALLER one, rounded down to a step of five from ten rows, so the same request gets the same price
    const pages = (ctx.samples.get(step.endpointId)?.pageRows ?? []).filter((n) => n > 0);
    const rowsPerCall = pages.length >= 2 ? stableRows(Math.min(...pages)) : evidence.rows.length;
    measure = { rowsPerCall, passRate: applied.records.length / evidence.rows.length, source: "sample" };
  } else if (callCost.unit === "record") {
    measure = { rowsPerCall: 1, passRate: 1, source: "catalog_unit" };
  } else if (category === "sensitive") {
    measure = { rowsPerCall: 1, passRate: 1, source: "lookup" };
  } else if (index > 0 && step.params.some((p) => p.source === "prior_step")) {
    // A LATER stage is sampled by code from the real rows of the stage before it (planner.autoSampleLaterStages). When that could not be done (no budget, the earlier stage returned
    // nothing to read), the stage is priced as ONE row per call: the dearest honest reading, never a guess in the customer's favour. It is never a reason to stop the plan.
    measure = { rowsPerCall: 1, passRate: 1, source: "assumed_one_per_call" };
  } else {
    issues.push(issue("needs_real_sample", `«${step.endpointId}» is priced per call, and the catalog's example answer is trimmed to one list item, so it cannot say how many rows a call returns: it cannot set a price. Call sample_call for this endpoint once (a tiny real check, within the exploration budget), then propose the plan again. If sample_call is refused for budget, end with ONE short Arabic message that this cannot be offered right now.`, at));
    return null;
  }
  const price = priceStep(callCost, measure);
  return { step, endpoint, category, callCost, price, callEstimateUsd: callEstimateUsd(callCost) };
}

const NUMBER_WORDS = /(?:^|[^\u0600-\u06FF])(?:واحد|واحدة|اتنين|اثنين|اثنان|تلات|ثلاث|ثلاثة|تلاتة|اربع|أربع|اربعة|أربعة|خمس|خمسة|ست|ستة|سبع|سبعة|تمان|ثمان|ثمانية|تمانية|تسع|تسعة|عشر|عشرة|عشرين|ثلاثين|تلاتين|اربعين|أربعين|خمسين|ستين|سبعين|ثمانين|تمانين|تسعين|مية|مائة|ميتين|مئتين|مائتين|ألف|الف|ألفين|الفين)(?![\u0600-\u06FF])/u;
/** True when the customer's own words give a count: a digit (Arabic-Indic included) or a number written in words. «كل» (all) is not a count. */
export function countStated(customerText: string): boolean {
  const text = foldDigits(String(customerText ?? ""));
  return /\d/.test(text) || NUMBER_WORDS.test(String(customerText ?? ""));
}

/** A measured rows-per-call that does not wobble with one page more or less: from ten rows, rounded down to a multiple of five. */
export const stableRows = (n: number): number => (n >= 10 ? Math.floor(n / 5) * 5 : Math.max(1, Math.floor(n)));

const LIMIT_NAMES = ["limit", "count", "page_size", "per_page", "size", "num", "max_results", "maxItems", "max_items", "n", "Count", "pageSize", "perPage"];

function factsOf(v: ValidatedStep, ctx: ValidateContext, index: number): StepFacts {
  const sample = ctx.samples.get(v.step.endpointId);
  const limitParam = v.step.fieldMap.pagination.limitParam;
  const limitInput = v.endpoint.inputs.find((i) => i.name === limitParam) ?? v.endpoint.inputs.find((i) => LIMIT_NAMES.includes(i.name));
  // The worker reads a real answer the way THE SAMPLE read it: where the sample found the list, or that the answer is one record read as the answer itself.
  const strategy = sample?.digest.listStrategy;
  const oneRecord = strategy === "root_object" || strategy === "single_object";
  const catalogList = v.endpoint.list_path && v.endpoint.list_path !== "NOT FOUND" ? v.endpoint.list_path : null;
  const listPath = v.step.fieldMap.rowsPath ?? (sample ? (oneRecord ? null : sample.digest.listPath) : catalogList) ?? (sample ? null : catalogList);
  const facts: StepFacts = {
    method: v.endpoint.method === "GET" ? "GET" : "POST",
    scope: v.endpoint.scope,
    limitName: limitInput?.name ?? null,
    limitMax: limitInput?.maximum ?? null,
    listPath,
    cursorPath: v.step.fieldMap.pagination.cursorPath ?? sample?.digest.nextCursorPath ?? v.endpoint.cursor_path ?? null,
    // a field the example held as null has no type worth storing (and a stored «null» word would read as a missing value to the scope guard)
    itemFields: v.endpoint.item_fields ? Object.fromEntries(Object.entries(v.endpoint.item_fields).filter(([, f]) => f.type && f.type !== "null").slice(0, 60).map(([k, f]) => [k, { type: f.type }])) : null,
    callEstimateUsd: v.callEstimateUsd,
    entity: entityOfEndpoint(v.endpoint),
    ...(oneRecord || (sample === undefined && listPath === null) ? { rootObjectIsRow: true } : {}),
  };
  // an EDIT of an approved plan has no new sample: the step keeps the way the approved step was read (where its list sits, that it is one record, its cursor and types)
  const approved = ctx.approved?.steps[index];
  const kept: StepFacts = approved && approved.endpointId === v.step.endpointId
    ? { ...facts, listPath: approved.facts.listPath, cursorPath: approved.facts.cursorPath, itemFields: approved.facts.itemFields, rootObjectIsRow: approved.facts.rootObjectIsRow, limitName: approved.facts.limitName, limitMax: approved.facts.limitMax }
    : facts;
  if (kept.rootObjectIsRow === undefined) delete kept.rootObjectIsRow;
  const alternates = alternatesOf(v, ctx);
  return alternates.length > 0 ? { ...kept, alternates } : kept;
}

/** The siblings the worker may call when this step's call fails: no dearer per call than the approved ceiling, params mapped from the step's own values, cheapest and most reliable first. */
function alternatesOf(v: ValidatedStep, ctx: ValidateContext): NonNullable<StepFacts["alternates"]> {
  const out: NonNullable<StepFacts["alternates"]> = [];
  if (categoryOf(v.step.endpointId) === "sensitive") return out;
  for (const choice of rankSiblings(v.endpoint, ctx.catalog, ctx.access, { maxEstimateUsd: v.callEstimateUsd, pageRows: 1 })) {
    if (out.length >= MAX_RUNTIME_ALTERNATES) break;
    const mapped = mapParamsToSibling(v.step.params.map((p) => (p.source === "prior_step" ? p : { ...p, value: resolvedParamValue(p) as PlanParam["value"] })), choice.endpoint);
    if (!mapped.ok) continue;
    const e = choice.endpoint;
    const limitInput = e.inputs.find((i) => LIMIT_NAMES.includes(i.name));
    out.push({
      endpointId: e.id, method: e.method === "GET" ? "GET" : "POST", scope: e.scope, params: mapped.params,
      listPath: e.list_path && e.list_path !== "NOT FOUND" ? e.list_path : null, cursorPath: e.cursor_path ?? null,
      itemFields: e.item_fields ? Object.fromEntries(Object.entries(e.item_fields).filter(([, f]) => f.type && f.type !== "null").slice(0, 60).map(([k, f]) => [k, { type: f.type }])) : null,
      limitName: limitInput?.name ?? null, limitMax: limitInput?.maximum ?? null, callEstimateUsd: choice.estimateUsd,
    });
  }
  return out;
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
  // The shape of the mission: a step with no prior_step value is a ROOT; a step with prior_step values runs once for each row of ONE earlier step (its parent).
  const parents: Array<number | null> = input.steps.map(() => null);
  input.steps.forEach((s, i) => {
    const refs = [...new Set(s.params.filter((p) => p.source === "prior_step" && p.fromStep).map((p) => p.fromStep!.step))];
    if (i === 0 && s.params.some((p) => p.source === "prior_step")) issues.push(issue("bad_step_reference", "step 1 cannot depend on a prior step", { stepIndex: 0 }));
    else if (refs.some((r) => r > i || r < 1)) issues.push(issue("bad_step_reference", `a step takes values only from a step before it (step ${i + 1} cannot read step ${refs.filter((r) => r > i || r < 1).join(", ")})`, { stepIndex: i }));
    else if (refs.length > 0) {
      // the step runs once per row of its PARENT (the latest step it reads); every other step it reads must be an ancestor of that parent (a contact is looked up from the person AND the person's company)
      const parent = Math.max(...refs) - 1;
      const chain = new Set<number>();
      for (let a: number | null = parents[parent]; a !== null; a = parents[a]) chain.add(a);
      const stray = refs.filter((r) => r - 1 !== parent && !chain.has(r - 1));
      if (stray.length > 0) issues.push(issue("branch_reference", `step ${i + 1} reads step ${stray.join(", ")}, which is not on the same chain as step ${parent + 1} (its parent). A step may read its parent's rows and the rows of the steps its parent came from.`, { stepIndex: i }));
      else parents[i] = parent;
    }
  });
  const validated: ValidatedStep[] = [];
  input.steps.forEach((step, i) => {
    if (step.volume < 1) issues.push(issue("volume", "volume must be at least 1", { stepIndex: i }));
    const v = validateStep(step, i, input, ctx, issues);
    if (v) validated.push(v);
  });
  if (issues.length > 0 || validated.length !== input.steps.length) return { ok: false, issues };

  // ONE reader: the facts the worker will read with must give, on the real answer of the sample, the same rows the sample gave
  const facts = validated.map((v, i) => factsOf(v, ctx, i));
  validated.forEach((v, i) => {
    const sample = ctx.samples.get(v.step.endpointId);
    if (sample?.body === undefined) return;
    const again = readStepRows(sample.body, facts[i]).rows.length;
    if (again !== sample.digest.rowsInSample) issues.push(issue("reader_mismatch", `the worker would read ${again} rows from the sample answer, the sample read ${sample.digest.rowsInSample}. Set rowsPath to «${sample.digest.listPath ?? ""}».`, { stepIndex: i }));
  });
  if (issues.length > 0) return { ok: false, issues };

  const sensitive = validated.some((v) => v.category === "sensitive");
  if (sensitive && !ctx.access.isAdmin && String(ctx.purpose ?? "").trim().length < MIN_PURPOSE_CHARS) {
    return { ok: false, issues: [issue("sensitive_purpose", "a purpose of use is required for this service before the plan can be approved")] };
  }
  // which steps' rows reach the customer: set by the model; not set = the last step of a plan of one or two steps, every step of a longer one
  const delivers = input.steps.map((s, i) => (s.deliver !== undefined ? s.deliver : input.steps.length > 2 ? true : i === input.steps.length - 1));
  if (!delivers.some(Boolean)) return { ok: false, issues: [issue("volume", "at least one step must deliver its rows to the customer (deliver: true)")] };
  const legacy = input.steps.length <= 2 && input.steps.every((s) => s.deliver === undefined);
  let price: PlanPrice | MissionPrice;
  if (legacy) {
    const second = validated[1];
    price = pricePlan(validated.map((v) => v.price), second ? (input.steps[1].perItem ?? Math.max(1, second.price.rowsPerCall * second.price.passRate)) : undefined);
  } else {
    price = priceMission(validated.map((v, i) => ({ price: v.price, volume: input.steps[i].volume, parent: parents[i], perItem: input.steps[i].perItem, deliver: delivers[i] })));
  }
  const missionPrice = "effectiveVolumes" in price ? price : null;
  const last = validated[validated.length - 1];

  // THE COUNT is the customer's: a branch's first step takes the count from the customer's own words (a number, or a number written in words). With none, the plan is not made: ONE question.
  // Without a typed number no hold may pass DEFAULT_HOLD_CEILING_POINTS.
  const counted = countStated(ctx.customerText);
  const lookupOfOneAll = validated.every((v) => v.price.rowsPerCall <= 1) && input.steps.every((s) => s.fieldMap.pagination.kind === "single");
  const rootBigger = input.steps.some((s, i) => parents[i] === null && s.volume > 1);
  if (rootBigger && !counted && !lookupOfOneAll) {
    return { ok: false, issues: [issue("volume_not_stated", "the customer gave no count (no number, or «كل»). Do not choose one: end with ONE short Arabic question asking how many they want.")] };
  }
  const deliveredVolume = missionPrice ? missionPrice.deliveredVolume : input.steps.reduce((n, s, i) => n + (delivers[i] ? s.volume : 0), 0);
  const reservePoints = reserveForUnits(deliveredVolume, price.unitPricePoints);
  if (!counted && reservePoints > DEFAULT_HOLD_CEILING_POINTS && !lookupOfOneAll) {
    return { ok: false, issues: [issue("volume_hold_too_high", `with no number typed by the customer a hold may not pass ${DEFAULT_HOLD_CEILING_POINTS} points (this plan holds ${reservePoints}). Ask the customer for the count in ONE short Arabic question.`)] };
  }
  const storedStages: StoredStage[] = validated.map((v, i) => {
    const perParent = parents[i] === null ? 0 : rowsPerParentOf({ price: v.price, parent: parents[i], perItem: input.steps[i].perItem });
    return { parent: parents[i], deliver: delivers[i], effVolume: missionPrice ? missionPrice.effectiveVolumes[i] : input.steps[i].volume, perParent: Math.floor(perParent), titleAr: safeStageTitleAr(input.steps[i].titleAr, i, entityOfEndpoint(v.endpoint)) };
  });
  const managerBudgetUsd = Number(Math.max(MANAGER_BUDGET_FLOOR_USD, MANAGER_BUDGET_SHARE * (missionPrice ? missionPrice.totalCostUsd : price.costPerRecordUsd * deliveredVolume) * RESERVE_MARGIN).toFixed(6));
  const sampleSource = ctx.samples.get(last.step.endpointId);
  // the card shows rows of a REAL sample call only: never the catalog's documentation example (not this customer's data), never a sensitive endpoint's rows
  const sampleRaw = !sensitive && sampleSource && sampleSource.rows.length > 0 ? sampleSource.rows : [];
  // A topic review judges rows against a subject («rows about basketball»). A lookup of ONE named thing (an account, a link, an id: one record back, no paging) has no subject to
  // judge: the customer named the thing itself, so there is no topic review (it would hold the very record that was asked for).
  const lookupOfOne = validated.length === 1 && validated[0].price.rowsPerCall <= 1 && input.steps[0].fieldMap.pagination.kind === "single"
    && input.steps[0].params.some((p) => (p.source === "customer_text" || p.source === "derived") && isIdLikeParamName(p.name));
  const topic = input.topic && !lookupOfOne ? input.topic : undefined;
  const cardCountry = countryOfRequest(ctx.customerText);
  const applied = applyPlanToRows(sampleRaw, last.step.fieldMap, last.step.filters, validated.length === 1 ? countryRowGate(cardCountry, entityOfEndpoint(last.endpoint)) : undefined);
  const maskRecord = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? maskText(v).slice(0, 160) : v]));
  const sampleRows = sensitive ? [] : applied.records.slice(0, SAMPLE_ROWS_ON_CARD).map(maskRecord);
  const sampleColumns = columnsOfMap(last.step.fieldMap).map((c) => ({ key: c.key, titleAr: c.titleAr }));
  return {
    ok: true,
    plan: {
      summaryAr: safeSummaryAr(input.summaryAr, last.step.volume, ctx.customerText),
      ...(topic ? { topic } : {}),
      steps: validated,
      price,
      sensitive,
      stored: { v: 1, steps: validated.map((v, i) => ({ ...v.step, params: v.step.params.map((p) => (p.source === "prior_step" ? p : { ...p, value: resolvedParamValue(p) as PlanParam["value"] })), facts: facts[i] })), ...(topic ? { topic } : {}), ...(cardCountry && entityOfEndpoint(validated[0].endpoint) ? { country: cardCountry } : {}), measured: validated.map((v) => ({ rowsPerCall: v.price.rowsPerCall, passRate: v.price.passRate, costPerCallUsd: v.price.costPerCallUsd })), managerBudgetUsd, delivers, stages: storedStages },
      sampleRows,
      sampleColumns,
    },
  };
}

