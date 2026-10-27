import { executeTregCall, type TregCallOptions, type TregCallResult } from "../../functions/shared/tregClient";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "../server/tregAdapter";
import { JOB_BUDGET_STOP_AR } from "../server/callBudget";
import { runSensitiveCall, sensitiveRefusalAr } from "../server/sensitiveAccess";
import { categoryOf, type AccountAccess } from "../treg/dataPolicy";
import { readShape } from "../treg/shapeReader";
import { applyPlanToRows, readField } from "./fieldMap";
import { getRowAdvisor, type RowAdvisorFn } from "../server/rowReviewAdvisor";
import { MAX_CALLS_PER_CHUNK, MAX_FAN_OUT_PARENTS, MODEL_PLAN_PARAM, MODEL_PLAN_PURPOSE_PARAM, MODEL_PLAN_REQUEST_PARAM, TOPIC_REVIEW_CALL_ESTIMATE_USD, TOPIC_REVIEW_JOB_CAP_USD, TOPIC_REVIEW_ROWS_PER_CALL } from "./constants";
import type { PlanStep, StepFacts, StoredModelPlan } from "./types";

/**
 * The GENERIC INTERPRETER of an approved model plan, run by the worker one chunk at a time. It knows no platform: it reads the stored step spec (endpoint, parameters with their
 * provenance already checked, field map, filters), makes the calls under the job's budget (`executeTregCall`: block list, sensitive gate, per-call USD ceiling, raw first page),
 * reads each answer with the shape reader, and applies the field map and the filters. A row a filter cannot read is held back (not delivered, not charged), never guessed.
 *
 * One plan stage: pages of one endpoint. Two stages: a listing endpoint, then a second endpoint run ONCE for each listed item (the first page of each, up to `perItem` rows),
 * so «the comments of the videos of a topic» is a listing and a fan-out, with no platform code. The state between chunks travels in the cursor (a small JSON text).
 */
export interface InterpreterState {
  v: 1;
  /** 0 while the listing (or the only) stage is being read, 1 while the second stage runs for each listed item. */
  stage: 0 | 1;
  /** Single stage: the next-page value (a token, a page number or an offset) and whether more may exist. */
  next: string | number | null;
  page: number;
  offset: number;
  /** Two stages: listed items still to visit (the values their parameters take), and whether the listing has more pages. */
  queue: Array<Record<string, string | number>>;
  listDone: boolean;
  /** USD the topic review has cost this job so far (the cursor carries it from chunk to chunk). */
  reviewUsd?: number;
}

const fresh = (): InterpreterState => ({ v: 1, stage: 0, next: null, page: 1, offset: 0, queue: [], listDone: false, reviewUsd: 0 });

export function parseInterpreterState(cursor: string | null): InterpreterState {
  if (!cursor) return fresh();
  try {
    const parsed = JSON.parse(cursor);
    if (parsed && parsed.v === 1) return { ...fresh(), ...parsed };
  } catch { /* a cursor that is not ours starts over */ }
  return fresh();
}

export interface InterpreterDeps {
  call?: (options: TregCallOptions) => Promise<TregCallResult>;
  /** The relevance reviewer of the topic review (default: the worker's own row advisor). */
  advisor?: RowAdvisorFn;
  /** Sensitive steps only: the database client, the account's access and the purpose, set by the worker. */
  sensitive?: { client: any; access: AccountAccess; purpose: string };
  now?: () => number;
}

const failureAr = (result: TregCallResult): string => {
  if (result.budgetStopped) return JOB_BUDGET_STOP_AR;
  if (result.blocked) return "هذه الخدمة غير متاحة حاليًا؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
  if (result.httpStatus === 404) return "لم نجد المصدر المطلوب؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
  if (result.httpStatus === 422 || result.httpStatus === 400) return "رفض المصدر مدخلات الطلب؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
  if (result.httpStatus === 429) return "المصدر مشغول حاليًا؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
  return "تعذر الحصول على البيانات من المصدر؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
};

function stepParams(step: PlanStep & { facts: StepFacts }, parent: Record<string, string | number> | null, state: InterpreterState, pageRows: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of step.params) {
    if (p.source === "prior_step") { if (parent && parent[p.name] !== undefined) out[p.name] = parent[p.name]; continue; }
    if (p.value !== undefined && p.value !== null && p.value !== "") out[p.name] = p.value;
  }
  const pg = step.fieldMap.pagination;
  if (pg.kind === "token" && pg.param && state.next !== null && state.next !== undefined && !parent) out[pg.param] = state.next;
  if (pg.kind === "page" && pg.param && !parent) out[pg.param] = state.page;
  if (pg.kind === "offset" && pg.param && !parent) out[pg.param] = state.offset;
  const limitName = pg.limitParam ?? step.facts.limitName;
  if (limitName && out[limitName] === undefined) out[limitName] = Math.max(1, Math.min(pageRows, step.facts.limitMax ?? pageRows));
  return out;
}

interface OneCall { ok: boolean; result: TregCallResult; costMicro: number; refusedAr?: string }

async function oneCall(plan: StoredModelPlan, step: PlanStep & { facts: StepFacts }, params: Record<string, unknown>, input: ProviderAdapterCallInput, deps: InterpreterDeps, tag: string): Promise<OneCall> {
  const call = deps.call ?? executeTregCall;
  const options: TregCallOptions = {
    endpointId: step.endpointId, method: step.facts.method, params, userId: input.userId, jobId: input.jobId, stepId: `step_${input.step}${tag}`, page: input.step + 1,
    routeMaxCostUsd: Number(Math.max(step.facts.callEstimateUsd, 0.001).toFixed(6)), timeoutMs: 12_000, endpointScope: step.facts.scope,
    ...(input.callBudget ? { callBudget: input.callBudget, callEstimateUsd: step.facts.callEstimateUsd } : {}),
    ...(input.rawCapture ? { rawCapture: input.rawCapture } : {}),
  };
  if (categoryOf(step.endpointId) === "sensitive") {
    if (!deps.sensitive) return { ok: false, result: await call(options), costMicro: 0, refusedAr: sensitiveRefusalAr("sensitive_not_allowed") };
    const out = await runSensitiveCall<TregCallResult>({
      client: deps.sensitive.client, account: { userId: input.userId, access: deps.sensitive.access }, endpointId: step.endpointId, params, purpose: deps.sensitive.purpose, jobId: input.jobId,
      call: async () => { const r = await call({ ...options, sensitiveAccess: { allowed: true } }); return { result: r, costUsd: Math.max(0, r.costMicro || 0) / 1_000_000, ok: r.ok }; },
    });
    if (!out.ok) return { ok: false, result: { ok: false, httpStatus: 403, tregCallId: "", costMicro: 0, latencyMs: 0, data: null, error: "endpoint_blocked", isRouteMaxCost: false, isPlatformBalanceLow: false }, costMicro: 0, refusedAr: sensitiveRefusalAr(out.refused) };
    return { ok: out.result.ok, result: out.result, costMicro: Math.max(0, out.result.costMicro || 0) };
  }
  const result = await call(options);
  return { ok: result.ok, result, costMicro: Math.max(0, result.costMicro || 0) };
}

function hintsFor(step: PlanStep & { facts: StepFacts }) {
  return { listPath: step.facts.listPath, cursorPath: step.facts.cursorPath, itemFields: step.facts.itemFields, ...(step.facts.listPath === null ? { rootObjectIsRow: true } : {}) };
}

/**
 * The TOPIC REVIEW: only when the plan has a topic. The rows of this chunk are shown to the relevance reviewer WITH THE CUSTOMER'S REAL REQUEST TEXT (stored on the quote item, never
 * the model's paraphrase); a row is delivered only when the review says it matches the topic. A row it does not confirm, a reply it could not give and a job past its review budget all
 * HOLD the row: it is not delivered and so not charged (the same fail-closed rule as the old path's reviews).
 */
async function reviewTopicRows(records: Array<Record<string, unknown>>, plan: StoredModelPlan, input: ProviderAdapterCallInput, state: InterpreterState, deps: InterpreterDeps): Promise<{ kept: Array<Record<string, unknown>>; usage: NonNullable<ProviderAdapterCallOutput["reviewModelUsage"]> }> {
  if (!plan.topic || records.length === 0) return { kept: records, usage: [] };
  if ((state.reviewUsd ?? 0) + TOPIC_REVIEW_CALL_ESTIMATE_USD > TOPIC_REVIEW_JOB_CAP_USD) return { kept: [], usage: [] };
  const request = String(input.params?.[MODEL_PLAN_REQUEST_PARAM] ?? "").trim() || plan.topic;
  const advisor = deps.advisor ?? getRowAdvisor();
  const batch = records.slice(0, TOPIC_REVIEW_ROWS_PER_CALL);
  let result;
  try {
    result = await advisor({ customerRequest: request, kind: "records", rows: batch.map((row, index) => ({ index, row })), timeoutMs: 15_000 });
  } catch {
    return { kept: [], usage: [] };
  }
  const usage = result.usage ? [{ inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: result.usage.costUsd, model: result.usage.model, latencyMs: result.usage.latencyMs, ...(result.failure ? { failure: String(result.failure) } : {}) }] : [];
  state.reviewUsd = (state.reviewUsd ?? 0) + (result.usage?.costUsd ?? 0);
  const kept = batch.filter((_, index) => result.verdicts.get(index)?.verdict === "match");
  return { kept, usage };
}

/** One worker chunk of a stored model plan. */
export async function runModelPlanChunk(input: ProviderAdapterCallInput, deps: InterpreterDeps = {}): Promise<ProviderAdapterCallOutput> {
  const plan = input.params?.[MODEL_PLAN_PARAM] as StoredModelPlan | undefined;
  const fail = (errorCode: string, errorMessageAr: string, costMicro = 0, calls = 0, tregCallId = "", httpStatus = 500): ProviderAdapterCallOutput =>
    ({ ok: false, httpStatus, rows: [], nextCursor: null, costUsd: Number((costMicro / 1_000_000).toFixed(6)), costMicro, providerCallCount: calls, tregCallId, errorCode, errorMessageAr });
  if (!plan || plan.v !== 1 || !Array.isArray(plan.steps) || plan.steps.length < 1) return fail("model_plan_missing", "تعذر تنفيذ الخطة المعتمدة؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");
  const now = deps.now ?? Date.now;
  const state = parseInterpreterState(input.cursor);
  const first = plan.steps[0];
  const second = plan.steps[1] ?? null;
  const wanted = Math.max(1, Math.floor(input.remainingNeeded || input.targetVolumeMax || 1));
  const passRate = Math.max(0.2, plan.measured?.[plan.steps.length - 1]?.passRate ?? 1);
  const pageRows = Math.min(100, Math.max(1, Math.ceil(wanted / passRate)));
  const sensitive = deps.sensitive ?? undefined;
  const withPurpose: InterpreterDeps = sensitive ? { ...deps, sensitive: { ...sensitive, purpose: sensitive.purpose || String(input.params?.[MODEL_PLAN_PURPOSE_PARAM] ?? "") } } : deps;

  let costMicro = 0;
  let calls = 0;
  let lastCallId = "";
  const delivered: Array<Record<string, unknown>> = [];

  const budgetLeft = () => !input.deadlineMs || now() + 15_000 < input.deadlineMs;

  // ---------------------------------------------------------------- one stage
  if (!second) {
    const params = stepParams(first, null, state, pageRows);
    const out = await oneCall(plan, first, params, input, withPurpose, "");
    calls += 1; costMicro += out.costMicro; lastCallId = out.result.tregCallId || lastCallId;
    if (!out.ok) return fail(out.result.error || `http_${out.result.httpStatus}`, out.refusedAr ?? failureAr(out.result), costMicro, calls, lastCallId, out.result.httpStatus);
    const reading = readShape(out.result.data, hintsFor(first));
    const applied = applyPlanToRows(reading.rows, first.fieldMap, first.filters);
    delivered.push(...applied.records);
    const pg = first.fieldMap.pagination;
    const reviewed = await reviewTopicRows(delivered, plan, input, state, withPurpose);
    let next: InterpreterState | null = null;
    if (reading.rows.length > 0) {
      if (pg.kind === "token" && reading.nextCursor && reading.cursorKind !== "url" && String(reading.nextCursor) !== String(state.next ?? "")) next = { ...state, next: reading.nextCursor, page: state.page + 1 };
      else if (pg.kind === "page") next = { ...state, page: state.page + 1 };
      else if (pg.kind === "offset") next = { ...state, offset: state.offset + reading.rows.length, page: state.page + 1 };
    }
    return { ok: true, httpStatus: out.result.httpStatus, rows: reviewed.kept, nextCursor: next ? JSON.stringify(next) : null, costUsd: Number((costMicro / 1_000_000).toFixed(6)), costMicro, providerCallCount: calls, tregCallId: lastCallId, ...(reviewed.usage.length ? { reviewModelUsage: reviewed.usage } : {}) };
  }

  // ---------------------------------------------------------------- two stages: list, then one call per listed item
  const perItem = second.perItem ?? Math.max(1, Math.ceil((plan.steps[1].volume || wanted) / Math.min(MAX_FAN_OUT_PARENTS, 10)));
  const parentParams = second.params.filter((p) => p.source === "prior_step");
  while (calls < MAX_CALLS_PER_CHUNK && delivered.length < wanted && budgetLeft()) {
    if (state.queue.length === 0) {
      if (state.listDone) break;
      const params = stepParams(first, null, state, Math.min(pageRows, MAX_FAN_OUT_PARENTS));
      const out = await oneCall(plan, first, params, input, withPurpose, "_list");
      calls += 1; costMicro += out.costMicro; lastCallId = out.result.tregCallId || lastCallId;
      if (!out.ok) return fail(out.result.error || `http_${out.result.httpStatus}`, out.refusedAr ?? failureAr(out.result), costMicro, calls, lastCallId, out.result.httpStatus);
      const reading = readShape(out.result.data, hintsFor(first));
      const listed = applyPlanToRows(reading.rows, first.fieldMap, first.filters).rawKept;
      for (const raw of listed.slice(0, MAX_FAN_OUT_PARENTS)) {
        const values: Record<string, string | number> = {};
        let complete = true;
        for (const p of parentParams) {
          const v = readField(raw, p.fromStep!.field);
          if (typeof v === "string" || typeof v === "number") values[p.name] = v; else complete = false;
        }
        if (complete) state.queue.push(values);
      }
      const pg = first.fieldMap.pagination;
      if (reading.rows.length > 0 && pg.kind === "token" && reading.nextCursor && reading.cursorKind !== "url" && String(reading.nextCursor) !== String(state.next ?? "")) { state.next = reading.nextCursor; state.page += 1; }
      else if (reading.rows.length > 0 && pg.kind === "page") state.page += 1;
      else state.listDone = true;
      if (state.queue.length === 0 && state.listDone) break;
      continue;
    }
    const parent = state.queue.shift()!;
    const params = stepParams(second, parent, state, Math.min(perItem, second.facts.limitMax ?? perItem));
    const out = await oneCall(plan, second, params, input, withPurpose, `_c${state.offset}`);
    calls += 1; state.offset += 1; costMicro += out.costMicro; lastCallId = out.result.tregCallId || lastCallId;
    if (!out.ok) {
      // a failed item is skipped (the rest of the queue still runs); a budget stop or a refusal ends the chunk
      if (out.result.budgetStopped || out.refusedAr || out.result.blocked) {
        if (delivered.length === 0) return fail(out.result.error || "stopped", out.refusedAr ?? failureAr(out.result), costMicro, calls, lastCallId, out.result.httpStatus);
        const early = await reviewTopicRows(delivered, plan, input, state, withPurpose);
        return { ok: true, httpStatus: 200, rows: early.kept, nextCursor: null, costUsd: Number((costMicro / 1_000_000).toFixed(6)), costMicro, providerCallCount: calls, tregCallId: lastCallId, ...(early.usage.length ? { reviewModelUsage: early.usage } : {}) };
      }
      continue;
    }
    const reading = readShape(out.result.data, hintsFor(second));
    const applied = applyPlanToRows(reading.rows, second.fieldMap, second.filters);
    delivered.push(...applied.records.slice(0, Math.min(perItem, wanted - delivered.length)));
  }
  const reviewed = await reviewTopicRows(delivered, plan, input, state, withPurpose);
  const more = state.queue.length > 0 || !state.listDone;
  return { ok: true, httpStatus: 200, rows: reviewed.kept, nextCursor: more ? JSON.stringify({ ...state, stage: 1 }) : null, costUsd: Number((costMicro / 1_000_000).toFixed(6)), costMicro, providerCallCount: calls, tregCallId: lastCallId, ...(reviewed.usage.length ? { reviewModelUsage: reviewed.usage } : {}) };
}
