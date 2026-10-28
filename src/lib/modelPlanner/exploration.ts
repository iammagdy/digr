import { executeTregCall, type TregCallOptions, type TregCallResult } from "../../functions/shared/tregClient";
import { blockedEndpointReason } from "../treg/blockList";
import { loadTregCatalog, type CatalogEndpoint, type TregCatalog } from "../treg/catalog";
import { categoryOf, policyVerdict, type AccountAccess } from "../treg/dataPolicy";
import { createJobCallBudget } from "../server/callBudget";
import { createFirstPageCapture } from "../server/rawCapture";
import { checkParams, type StepSample } from "./validate";
import { resolvedParamValue } from "./paramRules";
import { buildShapeDigest, type ShapeDigest } from "./digest";
import { callEstimateUsd, unitCost } from "./pricing";
import { readField } from "./fieldMap";
import { mapParamsToSibling, rankSiblings } from "./siblings";
import { EXPLORATION_DAY_CAP_USD, EXPLORATION_JOB_PREFIX, EXPLORATION_REQUEST_CAP_USD, MAX_SAMPLE_ALTERNATIVES, MAX_SAMPLE_CALLS, PLANNER_MIN_TURN_MS, SAMPLE_BUDGET_SHARE_PER_RECORD, SAMPLE_CALL_TIMEOUT_MS, SAMPLE_PAGE_ROWS_PER_CALL, SAMPLE_ROWS_REQUESTED } from "./constants";
import type { PlanParam, ValidationIssue } from "./types";

/**
 * `sample_call`: ONE real call of an endpoint, made by the app BEFORE the customer approves, to see the real answer shape. It is an owner cost, never charged to the customer, and it
 * is capped in code: EXPLORATION_REQUEST_CAP_USD per customer request and EXPLORATION_DAY_CAP_USD per UTC day for all exploration together. A call whose price estimate would pass
 * either cap is NOT made. Only an endpoint the account may use, that is sellable and priceable, and that is not of the sensitive category (a sensitive endpoint is never sampled: it
 * would look up a real person), is sampled.
 *
 * Every attempt that reaches the stage of a call or a cap check is written to `exploration_calls` (the table the caps are counted from: the day's total and the request's total come
 * from the DATABASE, not from the memory of one server instance). When the endpoint fails, answers nothing, takes too long or does not fit the budget, the code tries the endpoint's
 * catalog siblings (see siblings.ts) before it gives up, inside the same budget, and tells the model exactly what happened to each attempt.
 */
const LIMIT_PARAM_NAMES = ["limit", "count", "page_size", "per_page", "size", "num", "max_results", "maxItems", "max_items", "n", "Count", "pageSize", "perPage"];
export const EXPLORATION_TABLE = "exploration_calls";
/** The endpoint name of the row that records a planner turn that ended WITHOUT a plan (why), so the admin health line can show the last planner error. It costs nothing and does not count in the caps. */
export const PLANNER_TURN_ROW_ENDPOINT = "(planner turn)";
/** The endpoint name of the rows that record what the planner is doing, as it happens (the customer's planning steps are built from them). They cost nothing and do not count in the caps. */
export const PLANNER_EVENT_ROW_ENDPOINT = "(planner event)";

export interface ExplorationDeps {
  client: any;
  requestId: string;
  userId: string;
  call?: (options: TregCallOptions) => Promise<TregCallResult>;
  now?: Date;
  /** Per-process fallback counters, used only when the database cannot be read (tests, scripts). */
  memory?: { day: Map<string, number>; request: Map<string, number> };
  /** A smaller per-request cap than EXPLORATION_REQUEST_CAP_USD (the admin self-test shares one run budget across its requests). */
  requestCapUsd?: number;
  /** The turn's own deadline (epoch ms): a call is cut so that the planner still has time to answer. */
  deadlineAtMs?: number;
}

const MEMORY = { day: new Map<string, number>(), request: new Map<string, number>() };
export function resetExplorationMemoryForTesting(): void { MEMORY.day.clear(); MEMORY.request.clear(); }

const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/** What exploration already spent: for this request and today (UTC), from `exploration_calls`; or from process memory when the table cannot be read. */
export async function readExplorationSpend(deps: ExplorationDeps): Promise<{ request: number; day: number; source: "database" | "memory" }> {
  const now = deps.now ?? new Date();
  const mem = deps.memory ?? MEMORY;
  const client = deps.client;
  if (client && typeof client.from === "function") {
    try {
      const dayStart = `${utcDay(now)}T00:00:00.000Z`;
      const nextDay = new Date(new Date(dayStart).getTime() + 86_400_000).toISOString();
      const { data, error } = await client.from(EXPLORATION_TABLE).select("request_id,cost_usd,created_at").gte("created_at", dayStart).lt("created_at", nextDay);
      if (!error && Array.isArray(data)) {
        const day = data.reduce((s: number, r: any) => s + Math.max(0, Number(r.cost_usd) || 0), 0);
        const request = data.filter((r: any) => r.request_id === deps.requestId).reduce((s: number, r: any) => s + Math.max(0, Number(r.cost_usd) || 0), 0);
        return { request, day, source: "database" };
      }
    } catch { /* fall through to memory */ }
  }
  return { request: mem.request.get(deps.requestId) ?? 0, day: mem.day.get(utcDay(now)) ?? 0, source: "memory" };
}

export interface ExplorationAttempt {
  endpointId: string;
  outcome: "ok" | "empty" | "http_error" | "timeout" | "over_budget" | "no_time" | "unmappable";
  httpStatus: number;
  rows: number;
  costUsd: number;
  durationMs: number;
  /** For the model and the admin screen only (never a customer): what happened, in English, with no price in it (the model never learns a price). */
  detail: string;
  /** The same with the amounts, for the exploration_calls row and the admin screen only. */
  internal?: string;
}

async function recordAttempt(deps: ExplorationDeps, row: { endpointId: string; params: PlanParam[]; limit: number | null; attempt: ExplorationAttempt; budgetUsd: number }): Promise<void> {
  const now = deps.now ?? new Date();
  const mem = deps.memory ?? MEMORY;
  mem.request.set(deps.requestId, (mem.request.get(deps.requestId) ?? 0) + row.attempt.costUsd);
  mem.day.set(utcDay(now), (mem.day.get(utcDay(now)) ?? 0) + row.attempt.costUsd);
  const client = deps.client;
  if (!client || typeof client.from !== "function") return;
  try {
    const { error } = await client.from(EXPLORATION_TABLE).insert({
      request_id: deps.requestId, user_id: deps.userId, endpoint_id: row.endpointId,
      params_digest: { names: row.params.map((p) => p.name), limit: row.limit },
      cost_usd: Number(row.attempt.costUsd.toFixed(6)), http_status: row.attempt.httpStatus || null, rows_returned: row.attempt.rows, duration_ms: Math.max(0, Math.round(row.attempt.durationMs)),
      budget_usd: row.budgetUsd, refused_reason: row.attempt.outcome === "ok" ? null : `${row.attempt.outcome}: ${row.attempt.internal ?? row.attempt.detail}`.slice(0, 300), created_at: now.toISOString(),
    });
    if (error) console.warn(JSON.stringify({ tag: "exploration_record_failed", message: String(error.message ?? error.code ?? "").slice(0, 160) }));
  } catch (err) {
    console.warn(JSON.stringify({ tag: "exploration_record_failed", message: String((err as Error)?.message ?? "").slice(0, 160) }));
  }
}

export interface SampleCallNote {
  /** The endpoint whose real answer this is (the one the model asked for, or the sibling that answered instead). */
  endpointUsed: string;
  paramsUsed: Array<{ name: string; value: unknown }>;
  attempts: ExplorationAttempt[];
}

export type SampleCallOutcome =
  | { ok: true; digest: ShapeDigest; sample: StepSample; costUsd: number; note: SampleCallNote }
  | { ok: false; kind: "refused" | "invalid" | "failed"; message: string; issues?: ValidationIssue[]; attempts: ExplorationAttempt[]; costUsd: number };

let sampleCounter = 0;

const clip = (s: unknown, n: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Shared by the planner for the whole request: how many calls reached a source. */
export interface SampleStats { madeCalls: number }

interface SampleContext { customerText: string; access: AccountAccess; catalog?: TregCatalog; samples: Map<string, StepSample>; today?: Date; stats?: SampleStats }

/** One sample call, behind every check. Never throws for a refusal. */
export async function runSampleCall(input: { id: string; params: PlanParam[]; limit?: number }, ctx: SampleContext, deps: ExplorationDeps): Promise<SampleCallOutcome> {
  const catalog = ctx.catalog ?? loadTregCatalog();
  const id = String(input.id ?? "").trim();
  const endpoint = catalog.byId.get(id);
  const none = { attempts: [] as ExplorationAttempt[], costUsd: 0 };
  if (!endpoint) return { ok: false, kind: "refused", message: `«${id}» is not an endpoint of the catalog`, ...none };
  const verdict = policyVerdict(id, ctx.access);
  const category = categoryOf(id);
  if (!verdict.allowed || blockedEndpointReason(id, endpoint.scope) || category === "sensitive" || category === "blocked") {
    return { ok: false, kind: "refused", message: "this endpoint is not sampled. Describe it and plan it from its example, or choose another endpoint.", ...none };
  }
  if (!unitCost(endpoint, catalog)) return { ok: false, kind: "refused", message: "this endpoint has no price per call or per record, so it cannot be sold or sampled", ...none };

  // parameters: the same provenance rules as the plan (a sample uses the customer's real values, never invented ones)
  const issues: ValidationIssue[] = [];
  const lastOther = [...ctx.samples.values()].filter((s) => s.endpointId !== id).pop();
  // a value «from a prior step» is read from the REAL sample rows of that earlier step: the one the param names (fromStep.endpointId), else the latest other sample
  const priorFor = (p: PlanParam) => (p.fromStep?.endpointId ? ctx.samples.get(p.fromStep.endpointId) : undefined) ?? lastOther;
  const resolved: PlanParam[] = input.params.map((p) => {
    const prior = priorFor(p);
    if (p.source === "prior_step" && p.fromStep && prior) {
      const row = prior.rows.find((r) => { const v = readField(r, p.fromStep!.field); return v !== undefined && v !== null && v !== ""; });
      const value = row ? readField(row, p.fromStep.field) : undefined;
      return { ...p, source: "literal" as const, value: value as PlanParam["value"] };
    }
    return p;
  });
  // a value taken from the previous sample's own rows is a real value (not a literal chosen by the model): checked as such
  const priorMarked = new Set(input.params.filter((p) => p.source === "prior_step").map((p) => p.name));
  checkParams(resolved.filter((p) => !priorMarked.has(p.name)), endpoint, { customerText: ctx.customerText, today: ctx.today }, { stepIndex: 0 }, issues, null);
  for (const p of resolved.filter((q) => priorMarked.has(q.name))) if (resolvedParamValue(p) === undefined) issues.push({ code: "bad_step_reference", message: `no sample row of the previous step has a value at «${input.params.find((q) => q.name === p.name)?.fromStep?.field}». Fields of the earlier step's sample: ${(() => { const q = priorFor(input.params.find((x) => x.name === p.name)!); return q ? [...new Set(q.digest.fields.map((f) => f.path))].slice(0, 30).join(", ") : "(no earlier sample: sample the earlier step first)"; })()}`, param: p.name });
  if (issues.length > 0) return { ok: false, kind: "invalid", message: issues.map((i) => i.message).join("; "), issues, ...none };

  const attempts: ExplorationAttempt[] = [];
  let spentHere = 0;
  const stats = ctx.stats ?? { madeCalls: 0 };
  const queue: Array<{ endpoint: CatalogEndpoint; params: PlanParam[] }> = [{ endpoint, params: resolved }];
  const tried = new Set<string>([id]);
  let alternativesLoaded = false;
  let altCount = 0;

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (stats.madeCalls >= MAX_SAMPLE_CALLS) { attempts.push({ endpointId: next.endpoint.id, outcome: "over_budget", httpStatus: 0, rows: 0, costUsd: 0, durationMs: 0, detail: `at most ${MAX_SAMPLE_CALLS} real calls per request` }); break; }
    const result = await tryOne(next.endpoint, next.params, input.limit, ctx, deps, catalog, stats);
    attempts.push(result.attempt);
    spentHere += result.attempt.costUsd;
    if (result.ok) {
      const sample: StepSample = { endpointId: next.endpoint.id, rows: result.rows, digest: result.digest, costUsd: result.attempt.costUsd, body: result.body, pageRows: result.pageRows };
      ctx.samples.set(next.endpoint.id, sample);
      return { ok: true, digest: result.digest, sample, costUsd: spentHere, note: { endpointUsed: next.endpoint.id, paramsUsed: next.params.filter((p) => p.source !== "prior_step").map((p) => ({ name: p.name, value: resolvedParamValue(p) })), attempts } };
    }
    if (result.attempt.outcome === "no_time") break;
    // the first endpoint failed, returned nothing, took too long or did not fit: line up its siblings (once), cheapest and most reliable first
    if (!alternativesLoaded) {
      alternativesLoaded = true;
      const spentNow = await readExplorationSpend(deps);
      const remaining = Math.max(0, Math.min((deps.requestCapUsd ?? EXPLORATION_REQUEST_CAP_USD) - spentNow.request, EXPLORATION_DAY_CAP_USD - spentNow.day));
      for (const choice of rankSiblings(endpoint, catalog, ctx.access, { maxEstimateUsd: remaining, exclude: tried, pageRows: 1 })) {
        if (queue.length >= MAX_SAMPLE_ALTERNATIVES) break;
        const mapped = mapParamsToSibling(resolved, choice.endpoint);
        if (!mapped.ok) { continue; }
        queue.push({ endpoint: choice.endpoint, params: mapped.params });
        tried.add(choice.endpoint.id);
      }
    }
    altCount += 1;
    if (altCount > MAX_SAMPLE_ALTERNATIVES) break;
  }
  return { ok: false, kind: "failed", message: failureMessage(attempts), attempts, costUsd: spentHere };
}

const CURSOR_PARAM_NAMES = ["cursor", "next_cursor", "page_token", "pageToken", "continuation", "continuation_token", "max_cursor", "next", "after", "offset", "page"];
/** The input that carries the next-page token of an endpoint, from the names it declares (null when none is recognisable). */
function cursorParamOf(endpoint: CatalogEndpoint): string | null {
  const names = new Set([...endpoint.inputs.map((i) => i.name), ...(endpoint.pagination ?? [])]);
  return CURSOR_PARAM_NAMES.find((n) => names.has(n) && !["offset", "page"].includes(n)) ?? null;
}

function failureMessage(attempts: ExplorationAttempt[]): string {
  const lines = attempts.map((a) => `«${a.endpointId}»: ${a.outcome}${a.httpStatus ? ` (HTTP ${a.httpStatus})` : ""}${a.detail ? ` - ${a.detail}` : ""}`);
  return `no real answer was obtained. Attempts: ${lines.join("; ")}. ${attempts.some((a) => a.outcome === "over_budget") ? "A call that does not fit the exploration budget was not made. " : ""}You may describe and sample ONE different endpoint of the same capability from catalog_search (cheaper, or with other parameters) if one is left. An endpoint priced PER RECORD needs no sample to be priced: you may propose it without one (its fields are then checked against the catalog's example). Otherwise end with ONE short Arabic message that this is not available.`;
}

type TryResult =
  | { ok: true; attempt: ExplorationAttempt; rows: Array<Record<string, unknown>>; digest: ShapeDigest; body: unknown; pageRows: number[] }
  | { ok: false; attempt: ExplorationAttempt };

async function tryOne(endpoint: CatalogEndpoint, params: PlanParam[], limitIn: number | undefined, ctx: SampleContext, deps: ExplorationDeps, catalog: TregCatalog, stats: SampleStats): Promise<TryResult> {
  const id = endpoint.id;
  const cost = unitCost(endpoint, catalog)!;
  const attempt = (a: Partial<ExplorationAttempt> & Pick<ExplorationAttempt, "outcome" | "detail">): ExplorationAttempt => ({ endpointId: id, httpStatus: 0, rows: 0, costUsd: 0, durationMs: 0, ...a });
  const capUsd = deps.requestCapUsd ?? EXPLORATION_REQUEST_CAP_USD;
  const now = deps.now ?? new Date();

  // the call's params; the page size is set by code
  const callParams: Record<string, unknown> = {};
  for (const p of params) { const v = resolvedParamValue(p); if (v !== undefined && v !== null && v !== "") callParams[p.name] = v; }
  const limitInput = endpoint.inputs.find((i) => LIMIT_PARAM_NAMES.includes(i.name));

  // the caps (the database's totals): how much may this call cost?
  const spent = await readExplorationSpend(deps);
  const requestLeft = Math.max(0, capUsd - spent.request);
  const dayLeft = Math.max(0, EXPLORATION_DAY_CAP_USD - spent.day);
  const allowed = Math.min(requestLeft, dayLeft);

  // A PER-CALL price does not depend on the page size, so the sample asks for the page the job will ask for (up to SAMPLE_PAGE_ROWS_PER_CALL): the rows it returns are the rows one call
  // returns, which is what the price is divided by. A PER-RECORD price is paid for every row asked, so the sample asks for as few as it needs and at most SAMPLE_BUDGET_SHARE_PER_RECORD of what is left of the budget (the first version asked for ALL that was left: two calls of a 0.0098 USD per-row endpoint took 3 + 2 rows and the rest of the request cap, and every later source was refused as «over budget»).
  let limit: number;
  if (cost.unit === "call") limit = Math.max(1, Math.min(SAMPLE_PAGE_ROWS_PER_CALL, Math.floor(limitIn ?? SAMPLE_PAGE_ROWS_PER_CALL)));
  else limit = Math.max(1, Math.min(SAMPLE_ROWS_REQUESTED, Math.floor(limitIn ?? SAMPLE_ROWS_REQUESTED), Math.floor((allowed * SAMPLE_BUDGET_SHARE_PER_RECORD + 1e-12) / Math.max(cost.usd, 1e-9))));
  const setLimit = limitInput && callParams[limitInput.name] === undefined;
  if (setLimit) callParams[limitInput!.name] = limitInput!.maximum !== null ? Math.min(limit, limitInput!.maximum) : limit;
  const estimate = callEstimateUsd(cost, limit);
  if (estimate > allowed + 1e-12) {
    const a = attempt({ outcome: "over_budget", detail: "this call does not fit the exploration budget left for this request", internal: `a call is estimated at ${estimate.toFixed(4)} USD, more than the ${allowed.toFixed(4)} USD left for exploration (request cap ${capUsd}, day cap ${EXPLORATION_DAY_CAP_USD}, spent today ${spent.day.toFixed(4)})` });
    await recordAttempt(deps, { endpointId: id, params, limit, attempt: a, budgetUsd: capUsd });
    return { ok: false, attempt: a };
  }
  const timeoutMs = deps.deadlineAtMs !== undefined ? Math.min(SAMPLE_CALL_TIMEOUT_MS, deps.deadlineAtMs - Date.now() - PLANNER_MIN_TURN_MS) : SAMPLE_CALL_TIMEOUT_MS;
  if (timeoutMs < 3_000) {
    const a = attempt({ outcome: "no_time", detail: "the turn has no time left for a further real call" });
    await recordAttempt(deps, { endpointId: id, params, limit, attempt: a, budgetUsd: capUsd });
    return { ok: false, attempt: a };
  }

  const budget = createJobCallBudget({ ceilingUsd: Math.min(capUsd, spent.request + allowed), spentUsd: spent.request });
  const n = (sampleCounter += 1);
  const store = deps.client?.storage?.from?.("partials");
  const capture = store ? createFirstPageCapture(store, `${EXPLORATION_JOB_PREFIX}${deps.requestId}_${n}`) : undefined;
  const call = deps.call ?? executeTregCall;
  const started = Date.now();
  stats.madeCalls += 1;
  let result: TregCallResult;
  try {
    result = await call({
      endpointId: id, method: endpoint.method === "GET" ? "GET" : "POST", params: callParams, userId: deps.userId, jobId: `${EXPLORATION_JOB_PREFIX}${deps.requestId}`,
      stepId: `explore_${n}`, page: 1, routeMaxCostUsd: Number(Math.max(estimate, 0.001).toFixed(6)), timeoutMs, callBudget: budget, callEstimateUsd: estimate, endpointScope: endpoint.scope,
      ...(capture ? { rawCapture: capture } : {}),
    });
  } catch (err) {
    const a = attempt({ outcome: "http_error", durationMs: Date.now() - started, detail: `the call threw: ${clip((err as Error)?.message, 120)}` });
    await recordAttempt(deps, { endpointId: id, params, limit, attempt: a, budgetUsd: capUsd });
    return { ok: false, attempt: a };
  }
  const durationMs = Date.now() - started;
  const costUsd = Math.max(0, result.costMicro || 0) / 1_000_000;
  console.info(JSON.stringify({ tag: "planner_sample", endpointId: id, ok: result.ok, httpStatus: result.httpStatus, durationMs, costUsd, timedOut: Boolean(result.timedOut), budgetStopped: Boolean(result.budgetStopped), error: result.error ? clip(result.error, 60) : undefined }));
  if (result.budgetStopped) {
    const a = attempt({ outcome: "over_budget", durationMs, detail: "the call would pass the exploration budget" });
    stats.madeCalls -= 1;
    await recordAttempt(deps, { endpointId: id, params, limit, attempt: a, budgetUsd: capUsd });
    return { ok: false, attempt: a };
  }
  if (!result.ok) {
    const timedOut = Boolean(result.timedOut);
    const a = attempt({ outcome: timedOut ? "timeout" : "http_error", httpStatus: result.httpStatus, costUsd, durationMs, detail: timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : clip(result.errorDetails || result.detail || result.error, 140) });
    await recordAttempt(deps, { endpointId: id, params, limit, attempt: a, budgetUsd: capUsd });
    return { ok: false, attempt: a };
  }
  const { digest, reading } = buildShapeDigest(result.data, endpoint);
  if (reading.rows.length === 0) {
    const a = attempt({ outcome: "empty", httpStatus: result.httpStatus, costUsd, durationMs, detail: `the call worked but no rows were found in the answer${reading.warnings.length ? ` (${clip(reading.warnings.join("; "), 120)})` : ""}` });
    await recordAttempt(deps, { endpointId: id, params, limit, attempt: a, budgetUsd: capUsd });
    return { ok: false, attempt: a };
  }
  const rows = reading.rows.slice(0, SAMPLE_PAGE_ROWS_PER_CALL);
  const a = attempt({ outcome: "ok", httpStatus: result.httpStatus, rows: rows.length, costUsd, durationMs, detail: "" });
  void now;
  await recordAttempt(deps, { endpointId: id, params, limit, attempt: a, budgetUsd: capUsd });

  // A SECOND PAGE for a per-call endpoint (when the first answered a next-page token, the budget and the time allow): the price divides by the rows one call RETURNS, which one page can mis-state.
  const pageRows = [rows.length];
  const cursorParam = cost.unit === "call" ? cursorParamOf(endpoint) : null;
  if (cursorParam && reading.nextCursor && reading.cursorKind !== "url" && callParams[cursorParam] === undefined && stats.madeCalls < MAX_SAMPLE_CALLS) {
    const after = await readExplorationSpend(deps);
    const left = Math.min(capUsd - after.request, EXPLORATION_DAY_CAP_USD - after.day);
    const time = deps.deadlineAtMs !== undefined ? Math.min(SAMPLE_CALL_TIMEOUT_MS, deps.deadlineAtMs - Date.now() - PLANNER_MIN_TURN_MS) : SAMPLE_CALL_TIMEOUT_MS;
    if (estimate <= left + 1e-12 && time >= 3_000) {
      const second = await call({
        endpointId: id, method: endpoint.method === "GET" ? "GET" : "POST", params: { ...callParams, [cursorParam]: reading.nextCursor }, userId: deps.userId, jobId: `${EXPLORATION_JOB_PREFIX}${deps.requestId}`,
        stepId: `explore_${n}_p2`, page: 2, routeMaxCostUsd: Number(Math.max(estimate, 0.001).toFixed(6)), timeoutMs: time, callBudget: createJobCallBudget({ ceilingUsd: Math.min(capUsd, after.request + left), spentUsd: after.request }), callEstimateUsd: estimate, endpointScope: endpoint.scope,
      }).catch(() => null);
      stats.madeCalls += 1;
      if (second) {
        const secondCost = Math.max(0, second.costMicro || 0) / 1_000_000;
        const r2 = second.ok ? buildShapeDigest(second.data, endpoint).reading.rows.length : 0;
        const a2 = attempt({ outcome: second.ok && r2 > 0 ? "ok" : second.ok ? "empty" : "http_error", httpStatus: second.httpStatus, rows: r2, costUsd: secondCost, durationMs: 0, detail: "second page, to measure the rows one call returns" });
        await recordAttempt(deps, { endpointId: id, params, limit, attempt: a2, budgetUsd: capUsd });
        a.costUsd += secondCost;
        if (second.ok && r2 > 0) pageRows.push(Math.min(r2, SAMPLE_PAGE_ROWS_PER_CALL));
      }
    }
  }
  return { ok: true, attempt: a, rows, digest, body: result.data, pageRows };
}
