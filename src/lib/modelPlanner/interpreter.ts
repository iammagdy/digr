import { executeTregCall, type TregCallOptions, type TregCallResult } from "../../functions/shared/tregClient";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "../server/tregAdapter";
import { JOB_BUDGET_STOP_AR } from "../server/callBudget";
import { runSensitiveCall, sensitiveRefusalAr } from "../server/sensitiveAccess";
import { categoryOf, type AccountAccess } from "../treg/dataPolicy";
import type { ShapeReading } from "../treg/shapeReader";
import { readStepRows } from "./reader";
import { applyPlanToRows, readField, type ApplyResult } from "./fieldMap";
import { countryRowGate } from "./countryGate";
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

const EMPTY_READING: ShapeReading = { rows: [], listPath: null, listStrategy: "none", nextCursor: null, cursorPath: null, cursorStrategy: "none", cursorKind: null, hasMore: null, coercions: {}, unreadable: {}, warnings: [] };
const EMPTY_APPLIED: ApplyResult = { records: [], rawKept: [], seen: 0, dropped: { author: 0, excluded: 0, window: 0, unreadable: 0, empty: 0, geo: 0 } };

interface StageRead { out: OneCall; reading: ShapeReading; applied: ApplyResult; costMicro: number; calls: number; lastCallId: string; viaAlternate?: string }

/** A sibling's rows are accepted only when the approved field map really reads them: at least one record, and at least half of the mapped cells filled. */
function readable(applied: ApplyResult, columns: number): boolean {
  if (applied.records.length === 0 || columns === 0) return false;
  let filled = 0;
  for (const r of applied.records) for (const v of Object.values(r)) if (v !== "" && v !== null && v !== undefined) filled += 1;
  return filled / (applied.records.length * columns) >= 0.5;
}

/**
 * One call of a stage, and its siblings when it fails. The approved step's call first; when it FAILS (a source error, a timeout) or answers NOTHING on the first page, the siblings the plan
 * carries (no dearer per call than the approved ceiling, mapped parameters, one page) are tried in order, and the first whose answer the approved field map can read wins. A refusal
 * (a budget stop, a blocked or sensitive endpoint) is never retried elsewhere. The price never changes: the charge is for the rows delivered, never above the approved reserve.
 */
async function callStage(plan: StoredModelPlan, step: PlanStep & { facts: StepFacts }, parent: Record<string, string | number> | null, state: InterpreterState, pageRows: number, input: ProviderAdapterCallInput, deps: InterpreterDeps, tag: string, rowGate: ((raw: Record<string, unknown>) => boolean) | undefined, firstPage: boolean): Promise<StageRead> {
  const out = await oneCall(plan, step, stepParams(step, parent, state, pageRows), input, deps, tag);
  let costMicro = out.costMicro;
  let calls = 1;
  let lastCallId = out.result.tregCallId || "";
  const reading = out.ok ? readStepRows(out.result.data, step.facts) : EMPTY_READING;
  const applied = out.ok ? applyPlanToRows(reading.rows, step.fieldMap, step.filters, rowGate) : EMPTY_APPLIED;
  const refused = Boolean(out.result.budgetStopped || out.refusedAr || out.result.blocked);
  const alternates = step.facts.alternates ?? [];
  if (refused || !firstPage || alternates.length === 0 || (out.ok && reading.rows.length > 0)) return { out, reading, applied, costMicro, calls, lastCallId };
  for (const alt of alternates) {
    if (alt.callEstimateUsd > step.facts.callEstimateUsd + 1e-12) continue; // never above the approved per-call ceiling
    const altStep: PlanStep & { facts: StepFacts } = {
      ...step, endpointId: alt.endpointId, params: alt.params, fieldMap: { ...step.fieldMap, rowsPath: undefined, pagination: { kind: "single" } },
      facts: { ...step.facts, method: alt.method, scope: alt.scope, listPath: alt.listPath, cursorPath: alt.cursorPath, itemFields: alt.itemFields, limitName: alt.limitName, limitMax: alt.limitMax, callEstimateUsd: alt.callEstimateUsd, rootObjectIsRow: undefined, alternates: undefined },
    };
    const aout = await oneCall(plan, altStep, stepParams(altStep, parent, { ...state, next: null, page: 1, offset: 0 }, pageRows), input, deps, `${tag}_alt`);
    costMicro += aout.costMicro; calls += 1; lastCallId = aout.result.tregCallId || lastCallId;
    if (aout.result.budgetStopped || aout.refusedAr || aout.result.blocked) break;
    if (!aout.ok) continue;
    const areading = readStepRows(aout.result.data, altStep.facts);
    const aapplied = applyPlanToRows(areading.rows, step.fieldMap, step.filters, rowGate);
    if (readable(aapplied, step.fieldMap.columns.length)) return { out: aout, reading: { ...areading, nextCursor: null }, applied: aapplied, costMicro, calls, lastCallId, viaAlternate: alt.endpointId };
  }
  return { out, reading, applied, costMicro, calls, lastCallId };
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

  // the country the customer named holds the company or person rows of the FIRST step (the only step, or the listing) to that country; deterministic, as on the old path
  const firstStepGate = countryRowGate(plan.country, first.facts.entity);
  const budgetLeft = () => !input.deadlineMs || now() + 15_000 < input.deadlineMs;

  // ---------------------------------------------------------------- one stage
  if (!second) {
    const firstPage = state.page === 1 && (state.next === null || state.next === undefined) && state.offset === 0;
    const r = await callStage(plan, first, null, state, pageRows, input, withPurpose, "", firstStepGate, firstPage);
    const { out, reading, applied } = r;
    calls += r.calls; costMicro += r.costMicro; lastCallId = r.lastCallId || lastCallId;
    if (!out.ok) return fail(out.result.error || `http_${out.result.httpStatus}`, out.refusedAr ?? failureAr(out.result), costMicro, calls, lastCallId, out.result.httpStatus);
    delivered.push(...applied.records);
    const pg = first.fieldMap.pagination;
    const reviewed = await reviewTopicRows(delivered, plan, input, state, withPurpose);
    let next: InterpreterState | null = null;
    if (reading.rows.length > 0 && !r.viaAlternate) {
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
      const r = await callStage(plan, first, null, state, Math.min(pageRows, MAX_FAN_OUT_PARENTS), input, withPurpose, "_list", firstStepGate, state.page === 1 && !state.next);
      const { out, reading } = r;
      calls += r.calls; costMicro += r.costMicro; lastCallId = r.lastCallId || lastCallId;
      if (!out.ok) return fail(out.result.error || `http_${out.result.httpStatus}`, out.refusedAr ?? failureAr(out.result), costMicro, calls, lastCallId, out.result.httpStatus);
      const listed = r.applied.rawKept;
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
      if (r.viaAlternate) state.listDone = true;
      else if (reading.rows.length > 0 && pg.kind === "token" && reading.nextCursor && reading.cursorKind !== "url" && String(reading.nextCursor) !== String(state.next ?? "")) { state.next = reading.nextCursor; state.page += 1; }
      else if (reading.rows.length > 0 && pg.kind === "page") state.page += 1;
      else state.listDone = true;
      if (state.queue.length === 0 && state.listDone) break;
      continue;
    }
    const parent = state.queue.shift()!;
    const r = await callStage(plan, second, parent, state, Math.min(perItem, second.facts.limitMax ?? perItem), input, withPurpose, `_c${state.offset}`, undefined, true);
    const { out, reading } = r;
    calls += r.calls; state.offset += 1; costMicro += r.costMicro; lastCallId = r.lastCallId || lastCallId;
    if (!out.ok) {
      // a failed item is skipped (the rest of the queue still runs); a budget stop or a refusal ends the chunk
      if (out.result.budgetStopped || out.refusedAr || out.result.blocked) {
        if (delivered.length === 0) return fail(out.result.error || "stopped", out.refusedAr ?? failureAr(out.result), costMicro, calls, lastCallId, out.result.httpStatus);
        const early = await reviewTopicRows(delivered, plan, input, state, withPurpose);
        return { ok: true, httpStatus: 200, rows: early.kept, nextCursor: null, costUsd: Number((costMicro / 1_000_000).toFixed(6)), costMicro, providerCallCount: calls, tregCallId: lastCallId, ...(early.usage.length ? { reviewModelUsage: early.usage } : {}) };
      }
      continue;
    }
    void reading;
    delivered.push(...r.applied.records.slice(0, Math.min(perItem, wanted - delivered.length)));
  }
  const reviewed = await reviewTopicRows(delivered, plan, input, state, withPurpose);
  const more = state.queue.length > 0 || !state.listDone;
  return { ok: true, httpStatus: 200, rows: reviewed.kept, nextCursor: more ? JSON.stringify({ ...state, stage: 1 }) : null, costUsd: Number((costMicro / 1_000_000).toFixed(6)), costMicro, providerCallCount: calls, tregCallId: lastCallId, ...(reviewed.usage.length ? { reviewModelUsage: reviewed.usage } : {}) };
}
