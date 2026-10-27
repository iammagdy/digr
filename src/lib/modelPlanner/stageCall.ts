import { executeTregCall, type TregCallOptions, type TregCallResult } from "../../functions/shared/tregClient";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "../server/tregAdapter";
import { JOB_BUDGET_STOP_AR } from "../server/callBudget";
import { runSensitiveCall, sensitiveRefusalAr } from "../server/sensitiveAccess";
import { categoryOf, type AccountAccess } from "../treg/dataPolicy";
import type { ShapeReading } from "../treg/shapeReader";
import { readStepRows } from "./reader";
import { applyPlanToRows, type ApplyResult } from "./fieldMap";
import { getRowAdvisor, type RowAdvisorFn } from "../server/rowReviewAdvisor";
import { MODEL_PLAN_REQUEST_PARAM, TOPIC_REVIEW_CALL_ESTIMATE_USD, TOPIC_REVIEW_JOB_CAP_USD, TOPIC_REVIEW_ROWS_PER_CALL } from "./constants";
import type { MissionManager } from "./manager";
import type { PlanStep, StepAlternate, StepFacts, StoredModelPlan } from "./types";

/** What a page of any stage keeps between chunks, as far as the shared call code is concerned. */
export interface PageCursor { next: string | number | null; page: number; offset: number; reviewUsd?: number }

export interface InterpreterDeps {
  call?: (options: TregCallOptions) => Promise<TregCallResult>;
  /** The relevance reviewer of the topic review (default: the worker's own row advisor). */
  advisor?: RowAdvisorFn;
  /** Sensitive steps only: the database client, the account's access and the purpose, set by the worker. */
  sensitive?: { client: any; access: AccountAccess; purpose: string };
  now?: () => number;
  /** The model that manages an approved mission at its decision points (first page, a bad page, a stage transition, the final review). Absent: the mission runs without it. */
  manager?: MissionManager;
}

export const failureAr = (result: TregCallResult): string => {
  if (result.budgetStopped) return JOB_BUDGET_STOP_AR;
  if (result.blocked) return "هذه الخدمة غير متاحة حاليًا؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
  if (result.httpStatus === 404) return "لم نجد المصدر المطلوب؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
  if (result.httpStatus === 422 || result.httpStatus === 400) return "رفض المصدر مدخلات الطلب؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
  if (result.httpStatus === 429) return "المصدر مشغول حاليًا؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
  return "تعذر الحصول على البيانات من المصدر؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
};

export function stepParams(step: PlanStep & { facts: StepFacts }, parent: Record<string, string | number> | null, state: PageCursor, pageRows: number): Record<string, unknown> {
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

export interface OneCall { ok: boolean; result: TregCallResult; costMicro: number; refusedAr?: string }

export async function oneCall(plan: StoredModelPlan, step: PlanStep & { facts: StepFacts }, params: Record<string, unknown>, input: ProviderAdapterCallInput, deps: InterpreterDeps, tag: string): Promise<OneCall> {
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

export const EMPTY_READING: ShapeReading = { rows: [], listPath: null, listStrategy: "none", nextCursor: null, cursorPath: null, cursorStrategy: "none", cursorKind: null, hasMore: null, coercions: {}, unreadable: {}, warnings: [] };
export const EMPTY_APPLIED: ApplyResult = { records: [], rawKept: [], seen: 0, dropped: { author: 0, excluded: 0, window: 0, unreadable: 0, empty: 0, geo: 0 } };

export interface StageRead { out: OneCall; reading: ShapeReading; applied: ApplyResult; costMicro: number; calls: number; lastCallId: string; viaAlternate?: string }

/** A sibling's rows are accepted only when the approved field map really reads them: at least one record, and at least half of the mapped cells filled. */
export function readable(applied: ApplyResult, columns: number): boolean {
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
export async function callStage(plan: StoredModelPlan, step: PlanStep & { facts: StepFacts }, parent: Record<string, string | number> | null, state: PageCursor, pageRows: number, input: ProviderAdapterCallInput, deps: InterpreterDeps, tag: string, rowGate: ((raw: Record<string, unknown>) => boolean) | undefined, firstPage: boolean): Promise<StageRead> {
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
    const altStep = alternateStep(step, alt);
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
export async function reviewTopicRows(records: Array<Record<string, unknown>>, plan: StoredModelPlan, input: ProviderAdapterCallInput, state: PageCursor, deps: InterpreterDeps): Promise<{ kept: Array<Record<string, unknown>>; usage: NonNullable<ProviderAdapterCallOutput["reviewModelUsage"]> }> {
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


/** The approved step as one of its alternatives would run it: the sibling's endpoint and parameter names, one page, read by the sibling's own list path. */
export function alternateStep(step: PlanStep & { facts: StepFacts }, alt: StepAlternate): PlanStep & { facts: StepFacts } {
  return {
    ...step, endpointId: alt.endpointId, params: alt.params, fieldMap: { ...step.fieldMap, rowsPath: undefined, pagination: { kind: "single" } },
    facts: { ...step.facts, method: alt.method, scope: alt.scope, listPath: alt.listPath, cursorPath: alt.cursorPath, itemFields: alt.itemFields, limitName: alt.limitName, limitMax: alt.limitMax, callEstimateUsd: alt.callEstimateUsd, rootObjectIsRow: undefined, alternates: undefined },
  };
}
