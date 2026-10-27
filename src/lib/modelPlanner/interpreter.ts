import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "../server/tregAdapter";
import type { TregCallOptions, TregCallResult } from "../../functions/shared/tregClient";
import { readField } from "./fieldMap";
import { countryRowGate } from "./countryGate";
import { MAX_CALLS_PER_CHUNK, MAX_FAN_OUT_PARENTS, MODEL_PLAN_PARAM, MODEL_PLAN_PURPOSE_PARAM } from "./constants";
import { callStage, failureAr, reviewTopicRows, type InterpreterDeps } from "./stageCall";
import { runMissionChunk } from "./missionEngine";
import type { PlanStep, StepFacts, StoredModelPlan } from "./types";
export type { InterpreterDeps } from "./stageCall";

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

/** One worker chunk of a stored model plan. */
export async function runModelPlanChunk(input: ProviderAdapterCallInput, deps: InterpreterDeps = {}): Promise<ProviderAdapterCallOutput> {
  const plan = input.params?.[MODEL_PLAN_PARAM] as StoredModelPlan | undefined;
  const fail = (errorCode: string, errorMessageAr: string, costMicro = 0, calls = 0, tregCallId = "", httpStatus = 500): ProviderAdapterCallOutput =>
    ({ ok: false, httpStatus, rows: [], nextCursor: null, costUsd: Number((costMicro / 1_000_000).toFixed(6)), costMicro, providerCallCount: calls, tregCallId, errorCode, errorMessageAr });
  if (!plan || plan.v !== 1 || !Array.isArray(plan.steps) || plan.steps.length < 1) return fail("model_plan_missing", "تعذر تنفيذ الخطة المعتمدة؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");
  const now = deps.now ?? Date.now;
  if (Array.isArray(plan.stages) && plan.stages.length === plan.steps.length) return runMissionChunk(input, plan, deps);
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
