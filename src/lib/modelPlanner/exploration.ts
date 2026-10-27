import { randomUUID } from "node:crypto";
import { executeTregCall, type TregCallOptions, type TregCallResult } from "../../functions/shared/tregClient";
import { blockedEndpointReason } from "../treg/blockList";
import { loadTregCatalog, type TregCatalog } from "../treg/catalog";
import { categoryOf, policyVerdict, type AccountAccess } from "../treg/dataPolicy";
import { createJobCallBudget } from "../server/callBudget";
import { createFirstPageCapture } from "../server/rawCapture";
import { checkParams, resolvedParamValue, type StepSample } from "./validate";
import { buildShapeDigest, type ShapeDigest } from "./digest";
import { callEstimateUsd, unitCost } from "./pricing";
import { readField } from "./fieldMap";
import { EXPLORATION_COST_MARKER, EXPLORATION_DAY_CAP_USD, EXPLORATION_JOB_PREFIX, EXPLORATION_REQUEST_CAP_USD, SAMPLE_PAGE_ROWS_PER_CALL, SAMPLE_ROWS_REQUESTED } from "./constants";
import type { PlanParam, ValidationIssue } from "./types";

/**
 * `sample_call`: ONE real call of an endpoint, made by the app BEFORE the customer approves, to see the real answer shape. It is an owner cost, never charged to the customer,
 * and it is capped in code: EXPLORATION_REQUEST_CAP_USD per customer request and EXPLORATION_DAY_CAP_USD per UTC day for all exploration together. A call whose price estimate
 * would pass either cap is NOT made. Only an endpoint the account may use, that is sellable and priceable, and that is not of the sensitive category (a sensitive endpoint is
 * never sampled: it would look up a real person), is sampled. The cost is recorded in provider_costs with capability «exploration» (that table has no reason column).
 */
const LIMIT_PARAM_NAMES = ["limit", "count", "page_size", "per_page", "size", "num", "max_results", "maxItems", "max_items", "n", "Count", "pageSize", "perPage"];

export interface ExplorationDeps {
  client: any;
  requestId: string;
  userId: string;
  call?: (options: TregCallOptions) => Promise<TregCallResult>;
  now?: Date;
  /** Per-process fallback counters, used when no database client can be read (tests, scripts). */
  memory?: { day: Map<string, number>; request: Map<string, number> };
}

const MEMORY = { day: new Map<string, number>(), request: new Map<string, number>() };
export function resetExplorationMemoryForTesting(): void { MEMORY.day.clear(); MEMORY.request.clear(); }

const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/** What exploration already spent: for this request and today (UTC), from provider_costs; or from process memory when the table cannot be read. */
export async function readExplorationSpend(deps: ExplorationDeps): Promise<{ request: number; day: number }> {
  const now = deps.now ?? new Date();
  const mem = deps.memory ?? MEMORY;
  const client = deps.client;
  if (client && typeof client.from === "function") {
    try {
      const dayStart = `${utcDay(now)}T00:00:00.000Z`;
      const nextDay = new Date(new Date(dayStart).getTime() + 86_400_000).toISOString();
      const { data, error } = await client.from("provider_costs").select("job_id,cost_usd,capability,created_at").eq("capability", EXPLORATION_COST_MARKER).gte("created_at", dayStart).lt("created_at", nextDay);
      if (!error && Array.isArray(data)) {
        const day = data.reduce((s: number, r: any) => s + Math.max(0, Number(r.cost_usd) || 0), 0);
        const request = data.filter((r: any) => r.job_id === `${EXPLORATION_JOB_PREFIX}${deps.requestId}`).reduce((s: number, r: any) => s + Math.max(0, Number(r.cost_usd) || 0), 0);
        return { request, day };
      }
    } catch { /* fall through to memory */ }
  }
  return { request: mem.request.get(deps.requestId) ?? 0, day: mem.day.get(utcDay(now)) ?? 0 };
}

async function recordExplorationCost(deps: ExplorationDeps, row: { endpointId: string; costUsd: number; ok: boolean; durationMs: number; httpStatus: number }): Promise<void> {
  const now = deps.now ?? new Date();
  const mem = deps.memory ?? MEMORY;
  mem.request.set(deps.requestId, (mem.request.get(deps.requestId) ?? 0) + row.costUsd);
  mem.day.set(utcDay(now), (mem.day.get(utcDay(now)) ?? 0) + row.costUsd);
  const client = deps.client;
  if (!client || typeof client.from !== "function") return;
  try {
    await client.from("provider_costs").insert({
      job_id: `${EXPLORATION_JOB_PREFIX}${deps.requestId}`, provider: "treg", units: 1, cost_usd: Number(row.costUsd.toFixed(6)), is_estimate: false,
      capability: EXPLORATION_COST_MARKER, status: row.ok ? "ok" : "failed", duration_ms: Math.max(0, Math.round(row.durationMs)), created_at: now.toISOString(),
    });
  } catch { /* the cost row is best effort here: the in-memory counter above still holds the caps for this process */ }
  // the OPTIONAL table of exploration calls (docs/proposals/agent-loop/02_exploration_calls.sql): why the call was made; absent until the owner applies it
  try {
    await client.from("exploration_calls").insert({ id: `exp_${randomUUID().replace(/-/g, "")}`, request_id: deps.requestId, user_id: deps.userId, endpoint_id: row.endpointId, cost_usd: Number(row.costUsd.toFixed(6)), http_status: row.httpStatus, budget_usd: EXPLORATION_REQUEST_CAP_USD, created_at: now.toISOString() });
  } catch { /* table not applied */ }
}

export type SampleCallOutcome =
  | { ok: true; digest: ShapeDigest; sample: StepSample; costUsd: number }
  | { ok: false; kind: "refused" | "invalid" | "failed"; message: string; issues?: ValidationIssue[] };

let sampleCounter = 0;

/** One sample call, behind every check. Never throws for a refusal. */
export async function runSampleCall(
  input: { id: string; params: PlanParam[]; limit?: number },
  ctx: { customerText: string; access: AccountAccess; catalog?: TregCatalog; samples: Map<string, StepSample>; today?: Date },
  deps: ExplorationDeps,
): Promise<SampleCallOutcome> {
  const catalog = ctx.catalog ?? loadTregCatalog();
  const id = String(input.id ?? "").trim();
  const endpoint = catalog.byId.get(id);
  if (!endpoint) return { ok: false, kind: "refused", message: `«${id}» is not an endpoint of the catalog` };
  const verdict = policyVerdict(id, ctx.access);
  const category = categoryOf(id);
  if (!verdict.allowed || blockedEndpointReason(id, endpoint.scope) || category === "sensitive" || category === "blocked") {
    return { ok: false, kind: "refused", message: "this endpoint is not sampled. Describe it and plan it from its example, or choose another endpoint." };
  }
  const cost = unitCost(endpoint, catalog);
  if (!cost) return { ok: false, kind: "refused", message: "this endpoint has no price per call or per record, so it cannot be sold or sampled" };

  // parameters: the same provenance rules as the plan (a sample uses the customer's real values, never invented ones)
  const issues: ValidationIssue[] = [];
  const prior = [...ctx.samples.values()].filter((s) => s.endpointId !== id).pop();
  const resolved: PlanParam[] = input.params.map((p) => {
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
  for (const p of resolved.filter((q) => priorMarked.has(q.name))) if (resolvedParamValue(p) === undefined) issues.push({ code: "bad_step_reference", message: `no sample row of the previous step has a value at «${input.params.find((q) => q.name === p.name)?.fromStep?.field}»`, param: p.name });
  if (issues.length > 0) return { ok: false, kind: "invalid", message: issues.map((i) => i.message).join("; "), issues };

  // the call's params; the page size is set by code
  const callParams: Record<string, unknown> = {};
  for (const p of resolved) { const v = resolvedParamValue(p); if (v !== undefined && v !== null && v !== "") callParams[p.name] = v; }
  const limitInput = endpoint.inputs.find((i) => LIMIT_PARAM_NAMES.includes(i.name));
  // A PER-CALL price does not depend on the page size, so the sample asks for the page the job will ask for (up to SAMPLE_PAGE_ROWS_PER_CALL): the rows it returns are the rows one
  // call returns, which is what the price is divided by. A PER-RECORD price is paid for every row asked, so the sample asks for few (SAMPLE_ROWS_REQUESTED).
  const limit = Math.max(1, Math.min(cost.unit === "call" ? SAMPLE_PAGE_ROWS_PER_CALL : SAMPLE_ROWS_REQUESTED, Math.floor(input.limit ?? (cost.unit === "call" ? SAMPLE_PAGE_ROWS_PER_CALL : SAMPLE_ROWS_REQUESTED))));
  if (limitInput && callParams[limitInput.name] === undefined) callParams[limitInput.name] = limitInput.maximum !== null ? Math.min(limit, limitInput.maximum) : limit;

  // the caps
  const estimate = callEstimateUsd(cost, limit);
  const spent = await readExplorationSpend(deps);
  const dayLeft = EXPLORATION_DAY_CAP_USD - spent.day;
  const budget = createJobCallBudget({ ceilingUsd: Math.min(EXPLORATION_REQUEST_CAP_USD, spent.request + Math.max(0, dayLeft)), spentUsd: spent.request });
  const now = deps.now ?? new Date();
  const n = (sampleCounter += 1);
  const store = deps.client?.storage?.from?.("partials");
  const capture = store ? createFirstPageCapture(store, `${EXPLORATION_JOB_PREFIX}${deps.requestId}_${n}`) : undefined;
  const call = deps.call ?? executeTregCall;
  const started = Date.now();
  const result = await call({
    endpointId: id, method: endpoint.method === "GET" ? "GET" : "POST", params: callParams, userId: deps.userId, jobId: `${EXPLORATION_JOB_PREFIX}${deps.requestId}`,
    stepId: `explore_${n}`, page: 1, routeMaxCostUsd: Number(Math.max(estimate, 0.001).toFixed(6)), timeoutMs: 12_000, callBudget: budget, callEstimateUsd: estimate, endpointScope: endpoint.scope,
    ...(capture ? { rawCapture: capture } : {}),
  });
  if (result.budgetStopped) return { ok: false, kind: "refused", message: "the exploration budget for this request is used up (or today's is): do not sample more; plan from what you know, or end with a short Arabic message" };
  const costUsd = Math.max(0, result.costMicro || 0) / 1_000_000;
  if (costUsd > 0 || result.ok) await recordExplorationCost({ ...deps, now }, { endpointId: id, costUsd, ok: result.ok, durationMs: Date.now() - started, httpStatus: result.httpStatus });
  if (!result.ok) return { ok: false, kind: "failed", message: `the source answered with an error (HTTP ${result.httpStatus}). You may try once with different parameters, or choose another endpoint.` };
  const { digest, reading } = buildShapeDigest(result.data, endpoint);
  if (reading.rows.length === 0) return { ok: false, kind: "failed", message: "the call worked but returned no rows. Check the parameters, or choose another endpoint." };
  const sample: StepSample = { endpointId: id, rows: reading.rows.slice(0, SAMPLE_PAGE_ROWS_PER_CALL), digest, costUsd };
  ctx.samples.set(id, sample);
  return { ok: true, digest, sample, costUsd };
}
