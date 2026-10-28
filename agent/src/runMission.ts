import { createJobCallBudget } from "../../src/lib/server/callBudget";
import type { CallRecorder, FetchFn } from "../../src/lib/server/multiProvider/adapterTypes";
import type { TregCallOptions, TregCallResult } from "../../src/functions/shared/tregClient";
import type { commitTregSpend } from "../../src/lib/server/tregCallRecord";
import type { TregCatalog } from "../../src/lib/treg/catalog";
import type { AccountAccess } from "../../src/lib/treg/dataPolicy";
import {
  AGENT_ERROR_REQUEUES_MAX, AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD, AGENT_EXECUTION_LLM_BUDGET_SHARE, AGENT_MEMORY_REQUEUES_MAX, AGENT_PHASE_STARTS_MAX, AGENT_EXECUTION_MAX_TURNS, AGENT_EXECUTION_WALL_MS, AGENT_PLANNING_LLM_BUDGET_USD,
  AGENT_PLANNING_MAX_TURNS, AGENT_PLANNING_WALL_MS, AGENT_PRICING_BASIS,
} from "../../src/lib/agentMission/constants";
import { executionBudgetUsd, reviewBudgetUsdFor } from "../../src/lib/agentMission/price";
import { MISSION_PRICING_SETTING_KEY, normalizeMissionPricingSettings } from "../../src/lib/missionPricing";
import { planningBudgetUsd } from "../../src/lib/agentMission/budget";
import { settleMission } from "../../src/lib/agentMission/lifecycle";
import { customerPlanView, type PricedPlan } from "../../src/lib/agentMission/plan";
import { toArabicDigits } from "../../src/lib/arabicDigits";
import { holdValueUsd } from "../../src/lib/server/callBudget";
import type { ModelDriver } from "./driver";
import { createGateway } from "./gateway";
import { createWebGateway, type ProviderKeyFn } from "./webGateway";
import { loadSystemPrompt } from "./prompt";
import { readRunState, updateRunState } from "./runState";
import { buildTools, countDeliveredRows, newRunState, type ToolContext } from "./tools";
import { createReviewer, readReviewState, type ReviewCall } from "./review";
import type { TokenUsage } from "./llmCost";
import { buildMissionFiles } from "./workbook";
import type { AgentStore, CallRow, MissionRecord } from "./types";
import type { SandboxResult } from "./sandbox";
import type { MissionNoticeFacts, MissionNoticeKind } from "../../src/lib/agentMission/notices";

export interface RunnerDeps {
  store: AgentStore;
  /** Supabase client (money functions, spend recording, sensitive audit). */
  client: any;
  catalog: TregCatalog;
  driver: ModelDriver;
  recorder: CallRecorder;
  models: { planning: string; execution: string };
  resolveAccess: (userId: string) => Promise<AccountAccess>;
  token?: string;
  commit?: typeof commitTregSpend;
  call?: (options: TregCallOptions) => Promise<TregCallResult>;
  sandbox?: (code: string, inputs: Record<string, unknown>) => Promise<SandboxResult>;
  /** Tells the customer how the mission ended (an in-site notice and an e-mail). Must not throw; absent in tests that do not look at it. */
  notify?: (input: { userId: string; missionId: string; jobId: string | null; kind: MissionNoticeKind; facts: MissionNoticeFacts }) => Promise<unknown>;
  /** The provider's key from the encrypted key store (the site's own resolver); with it the agent gets the page parsers, the web search and scrape, and people search. Absent: those tools are not offered. */
  providerKey?: ProviderKeyFn;
  /** The HTTP transport of the web gateway (tests pass a fake: no real call). */
  fetchFn?: FetchFn;
  /** The model call that reviews uncertain rows (a small request to the model API, no SDK process). Absent (tests, no key): uncertain rows are not delivered. */
  reviewCall?: ReviewCall;
  systemPromptFile?: string;
  log?: (line: string) => void;
}

const sum = (calls: CallRow[], phase: CallRow["phase"]) => calls.filter((c) => c.phase === phase).reduce((n, c) => n + (Number(c.cost_usd) || 0), 0);
const lastSeq = (calls: CallRow[]) => calls.reduce((n, c) => Math.max(n, Number(/call_(\d+)$/.exec(c.id)?.[1] ?? 0)), 0);
const lastOut = async (store: AgentStore, missionId: string): Promise<number> => {
  // outputs continue their numbering after a restart: probe upward
  let n = 0;
  while (await store.getFile(missionId, `out/out_${String(n + 1).padStart(4, "0")}.json`) !== null) n += 1;
  return n;
};

function savedCallsNote(calls: CallRow[]): string {
  const rows = calls.filter((c) => c.status === "ok" || c.status === "empty").map((c) => `- ${c.id.split(":").pop()}: endpoint ${c.endpoint_id}, params ${JSON.stringify(c.params_digest)}, ${c.rows_returned ?? 0} rows, ${c.phase}`);
  return rows.length ? `Pages ALREADY saved for this mission (use them with run_code before paying for the same data again):\n${rows.join("\n")}` : "No page is saved yet.";
}

/** Everything the agent is told at the start of a PLANNING run. */
export function planningPrompt(mission: MissionRecord, calls: CallRow[]): string {
  const answer = mission.answer_text ? `\n\nYou asked the customer one question and they answered: «${mission.answer_text}». Do not ask again.` : "";
  return `The customer's mission (Arabic):\n«${mission.request_text}»${answer}\n\n${savedCallsNote(calls)}\n\nPlan it now.`;
}

/** Everything the agent is told at the start of an EXECUTION run: the approved plan (internal view) and what is already saved. */
export function executionPrompt(mission: MissionRecord, plan: PricedPlan, calls: CallRow[], saved: Record<string, number>): string {
  const stages = plan.stages.map((s) => ({ key: s.key, title: s.title_ar, endpoint_id: s.endpoint_id, parent_key: s.parent_key, per_parent_rows: s.per_parent_rows ?? null, deliver: s.deliver, rows_approved: s.planned_rows, rows_saved_so_far: saved[s.key] ?? 0, columns: s.columns, measured_by: s.measured_by, how: s.how_ar ?? null }));
  return `The customer's mission (Arabic):\n«${mission.request_text}»\n\nThe APPROVED plan (carry it out):\n${JSON.stringify({ summary: plan.summary_ar, stages }, null, 1)}\n\n${savedCallsNote(calls)}\n\nCollect, save the final rows stage by stage with save_rows, then finish.`;
}

const clear = { worker_id: null, lease_until: null } as const;

/**
 * PUTS A MISSION BACK IN THE QUEUE: a mission that holds a reserve goes back to «approved» with everything it saved, planning goes back to «queued», with no worker and no lease so any worker takes it.
 * `cause` is why: "memory" (the worker stopped the run at the dyno's hard limit) or "error" (the run ended with an exception); each has its own count (run_state.json) and its own limit, after which this returns false and
 * the caller ends the mission honestly. The count is a note: if it cannot be saved the in-process copy still stops a loop.
 */
async function requeue(deps: RunnerDeps, mission: MissionRecord, status: "queued" | "approved", patch: Record<string, unknown>, cause: "memory" | "error"): Promise<boolean> {
  const state = await readRunState(deps.store, mission.id);
  const used = cause === "memory" ? state.memoryRequeues : state.errorRequeues;
  const max = cause === "memory" ? AGENT_MEMORY_REQUEUES_MAX : AGENT_ERROR_REQUEUES_MAX;
  if (used >= max) return false;
  const next = await updateRunState(deps.store, mission.id, (s) => (cause === "memory" ? { ...s, memoryRequeues: s.memoryRequeues + 1 } : { ...s, errorRequeues: s.errorRequeues + 1 }), deps.log);
  await deps.store.updateMission(mission.id, { ...patch, status, worker_id: null, lease_until: null });
  const n = cause === "memory" ? next.memoryRequeues : next.errorRequeues;
  await deps.store.addEvent(mission.id, { kind: "system", message_ar: cause === "memory" ? "تأجّلت مهمتك قليلًا بسبب ضغط على الخدمة، وستُستأنف تلقائيًا من حيث وصلت." : "تعثّرت الخطوة الأخيرة مؤقتًا، وستُستأنف مهمتك تلقائيًا من حيث وصلت.", counts: { requeued: n } });
  deps.log?.(`requeue_${cause} ${mission.id} -> ${status} (${n} of ${max})`);
  return true;
}

/** The customer's notice (in-site and e-mail); never lets a failed notice change the mission. */
async function tell(deps: RunnerDeps, mission: MissionRecord, jobId: string | null, kind: MissionNoticeKind, facts: MissionNoticeFacts): Promise<void> {
  try { await deps.notify?.({ userId: mission.user_id, missionId: mission.id, jobId, kind, facts }); } catch (e) { deps.log?.(`notice_failed ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
}

/**
 * THE TOKENS OF A RUN, stored as an INTERNAL event of the mission (the admin page reads it; the customer never does): the agent's input, output, cache-read and cache-write tokens of this phase, the model review's
 * own tokens, and the model cost in millionths of a dollar. This is the account the cost audit checks the recorded cost against. Never throws.
 */
async function recordTokens(deps: RunnerDeps, missionId: string, phase: 0 | 1, usage: TokenUsage | undefined, review: { inputTokens: number; outputTokens: number; calls: number }, llmUsd: number): Promise<void> {
  try {
    const u = usage ?? {};
    await deps.store.addEvent(missionId, { kind: "call", message_ar: "قياس داخلي لاستهلاك النموذج في هذه الخطوة.", counts: {
      tok_phase: phase, tok_in: u.input_tokens ?? 0, tok_out: u.output_tokens ?? 0, tok_cache_read: u.cache_read_input_tokens ?? 0, tok_cache_write: u.cache_creation_input_tokens ?? 0,
      tok_review_in: review.inputTokens, tok_review_out: review.outputTokens, tok_review_calls: review.calls, llm_micro_usd: Math.round(llmUsd * 1_000_000),
    } });
  } catch (e) {
    deps.log?.(`tokens_not_recorded ${missionId} ${shortMessage(e)}`);
  }
}
const shortMessage = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 120);

/** A planning that cannot be completed ends here, honestly: nothing was held, the customer is told once. */
async function endPlanningUnserved(deps: RunnerDeps, mission: MissionRecord, error: string): Promise<void> {
  await deps.store.updateMission(mission.id, { status: "failed", error: error.slice(0, 300), ...clear });
  await deps.store.addEvent(mission.id, { kind: "result", message_ar: "تعذّر على الوكيل إعداد خطة لهذا الطلب؛ لم يُحجز أي رصيد." });
  await tell(deps, mission, null, "failed", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false });
}

export async function runPlanning(deps: RunnerDeps, mission: MissionRecord): Promise<void> {
  const { store } = deps;
  const model = deps.models.planning;
  // a mission whose planning has started too many times (it keeps failing or keeps killing its worker) ends honestly instead of looping
  const started = await updateRunState(store, mission.id, (r) => ({ ...r, planningStarts: r.planningStarts + 1 }), deps.log);
  if (started.planningStarts > AGENT_PHASE_STARTS_MAX) { await endPlanningUnserved(deps, mission, `planning started ${started.planningStarts} times`); return; }
  await store.updateMission(mission.id, { planning_model: model, error: null });
  await store.addEvent(mission.id, { kind: "system", message_ar: "بدأ الوكيل دراسة طلبك." });
  const calls = await store.listCalls(mission.id);
  const access = await deps.resolveAccess(mission.user_id);
  // a multi-stage request (a parent and its children) gets the larger exploration budget (named constants in agentMission/constants.ts), decided by code from the customer's words
  const budget = createJobCallBudget({ ceilingUsd: planningBudgetUsd(`${mission.request_text} ${mission.answer_text ?? ""}`), spentUsd: sum(calls, "planning") });
  const counter = { seq: lastSeq(calls) };
  const gateway = createGateway({ store, client: deps.client, missionId: mission.id, userId: mission.user_id, jobId: null, phase: "planning", access, catalog: deps.catalog, budget, recorder: deps.recorder, commit: deps.commit, call: deps.call, token: deps.token, defaultPurpose: mission.request_text, counter });
  const web = deps.providerKey ? createWebGateway({ store, missionId: mission.id, jobId: null, phase: "planning", budget, recorder: deps.recorder, providerKey: deps.providerKey, fetchFn: deps.fetchFn, counter }) : undefined;
  const state = newRunState(await lastOut(store, mission.id));
  const pricingSettings = normalizeMissionPricingSettings(((await store.readSettings().catch(() => ({}))) as Record<string, unknown>)[MISSION_PRICING_SETTING_KEY]);
  const ctx: ToolContext = { phase: "planning", mission, plan: null, store, gateway, web, catalog: deps.catalog, access, state, sandbox: deps.sandbox, pricingSettings };
  // the model cost of earlier runs of this phase (a requeue, a takeover): this run adds to it, and every model message checkpoints the running total, so a run that is killed still leaves its cost on the mission
  const baseLlm = Number((await store.getMission(mission.id))?.planning_llm_usd ?? mission.planning_llm_usd ?? 0);
  const checkpoint = async ({ costUsd }: { costUsd: number }) => { try { await store.updateMission(mission.id, { planning_llm_usd: Number((baseLlm + costUsd).toFixed(6)) }); } catch { /* a lost checkpoint never stops a run */ } };
  let output;
  try {
    output = await deps.driver.run({ phase: "planning", systemPrompt: loadSystemPrompt("planning", deps.systemPromptFile), userPrompt: planningPrompt(mission, calls), tools: buildTools(ctx), state, model, maxTurns: AGENT_PLANNING_MAX_TURNS, maxBudgetUsd: AGENT_PLANNING_LLM_BUDGET_USD, wallMs: AGENT_PLANNING_WALL_MS, onUsage: checkpoint });
  } catch (e) {
    output = { llmCostUsd: 0, turns: 0, stop: "error", error: String((e as Error)?.message ?? e).slice(0, 300) } as Awaited<ReturnType<ModelDriver["run"]>>;
  }
  const llm = Number(baseLlm + output.llmCostUsd);
  const base = { planning_llm_usd: Number(llm.toFixed(6)), ...clear };
  await recordTokens(deps, mission.id, 0, output.usage, { inputTokens: 0, outputTokens: 0, calls: 0 }, output.llmCostUsd);
  if (output.stop === "memory" && !state.proposedPlan && !state.question && !state.finish && await requeue(deps, mission, "queued", { planning_llm_usd: base.planning_llm_usd }, "memory")) return;

  if (state.proposedPlan) {
    const plan = state.proposedPlan;
    await store.updateMission(mission.id, { ...base, status: "plan_ready", plan: plan as any, plan_public: customerPlanView(plan) as any, unit_price_points: plan.price.unitPricePoints, reserved_points: plan.price.reservePoints });
    await store.addEvent(mission.id, { kind: "plan", message_ar: plan.summary_ar, counts: { stages: plan.stages.length, rows: plan.price.deliveredRows, unit_points_x1000: Math.round(plan.price.unitPricePoints * 1000), reserve_points: plan.price.reservePoints } });
    deps.log?.(`plan_ready ${mission.id} ${JSON.stringify(customerPlanView(plan).price)}`);
  } else if (state.question) {
    await store.updateMission(mission.id, { ...base, status: "needs_input", question_ar: state.question });
  } else if (state.finish) {
    await store.updateMission(mission.id, { ...base, status: "unserved", summary_ar: state.finish.summary_ar });
    await store.addEvent(mission.id, { kind: "result", message_ar: state.finish.summary_ar });
    await tell(deps, mission, null, "unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false });
  } else {
    await store.updateMission(mission.id, { ...base, status: "failed", error: output.error ?? `the agent ended without a plan (${output.stop})` });
    await store.addEvent(mission.id, { kind: "result", message_ar: "تعذّر على الوكيل إعداد خطة لهذا الطلب؛ لم يُحجز أي رصيد." });
    await tell(deps, mission, null, "failed", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false });
  }
}

export async function runExecution(deps: RunnerDeps, mission: MissionRecord): Promise<void> {
  const { store } = deps;
  const model = deps.models.execution;
  const plan = mission.plan;
  const reserve = Number(mission.reserved_points);
  const unit = Number(mission.unit_price_points);
  if (!plan || !mission.job_id || !(reserve > 0) || !(unit > 0)) {
    await store.updateMission(mission.id, { status: "failed", error: "the mission has no approved plan or reserve", ...clear });
    return;
  }
  const started = await updateRunState(store, mission.id, (r) => ({ ...r, executionStarts: r.executionStarts + 1 }), deps.log);
  if (started.executionStarts > AGENT_PHASE_STARTS_MAX) {
    const stuck = (await store.getMission(mission.id)) ?? mission;
    await settleExecution(deps, mission, plan, reserve, unit, { llm: Number(stuck.execution_llm_usd ?? 0), executionTregUsd: Number(stuck.execution_treg_usd ?? 0), summary: null, outputError: `execution started ${started.executionStarts} times` });
    return;
  }
  await store.updateMission(mission.id, { execution_model: model, error: null });
  await store.addEvent(mission.id, { kind: "system", message_ar: "اعتُمدت الخطة وبدأ الوكيل التنفيذ." });
  const calls = await store.listCalls(mission.id);
  const access = await deps.resolveAccess(mission.user_id);
  const budget = createJobCallBudget({ ceilingUsd: executionBudgetUsd(reserve), spentUsd: sum(calls, "execution") });
  const counter = { seq: lastSeq(calls) };
  const gateway = createGateway({ store, client: deps.client, missionId: mission.id, userId: mission.user_id, jobId: mission.job_id, phase: "execution", access, catalog: deps.catalog, budget, recorder: deps.recorder, commit: deps.commit, call: deps.call, token: deps.token, defaultPurpose: mission.request_text, counter });
  const web = deps.providerKey ? createWebGateway({ store, missionId: mission.id, jobId: mission.job_id, phase: "execution", budget, recorder: deps.recorder, providerKey: deps.providerKey, fetchFn: deps.fetchFn, counter }) : undefined;
  const state = newRunState(await lastOut(store, mission.id));
  // THE REVIEW of uncertain rows: a small model request per batch, within 20% of the mission's revenue (rows beyond it are not delivered and not charged); its tokens and cost are counted from the API's own answer
  const reviewBudgetUsd = plan.price.reviewBudgetUsd ?? reviewBudgetUsdFor(plan.price.maxChargePoints);
  const reviewer = deps.reviewCall ? createReviewer({ call: deps.reviewCall, store, missionId: mission.id, requestText: `${mission.request_text}${mission.answer_text ? ` — ${mission.answer_text}` : ""}`, budgetUsd: reviewBudgetUsd, log: deps.log }) : undefined;
  const reviewBefore = await readReviewState(store, mission.id);
  const ctx: ToolContext = { phase: "execution", mission, plan, store, gateway, web, catalog: deps.catalog, access, state, sandbox: deps.sandbox, review: reviewer };
  const savedBefore = (await countDeliveredRows(store, mission.id, plan)).perStage;
  const llmBudget = Math.max(AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD, holdValueUsd(reserve, AGENT_PRICING_BASIS) * AGENT_EXECUTION_LLM_BUDGET_SHARE);
  const baseLlm = Number((await store.getMission(mission.id))?.execution_llm_usd ?? mission.execution_llm_usd ?? 0);
  const checkpoint = async ({ costUsd }: { costUsd: number }) => {
    try {
      const reviewNow = reviewer ? Math.max(0, (await reviewer.state()).spentUsd - reviewBefore.spentUsd) : 0;
      await store.updateMission(mission.id, { execution_llm_usd: Number((baseLlm + costUsd + reviewNow).toFixed(6)) });
    } catch { /* a lost checkpoint never stops a run */ }
  };
  let output;
  try {
    output = await deps.driver.run({ phase: "execution", systemPrompt: loadSystemPrompt("execution", deps.systemPromptFile), userPrompt: executionPrompt(mission, plan, calls, savedBefore), tools: buildTools(ctx), state, model, maxTurns: AGENT_EXECUTION_MAX_TURNS, maxBudgetUsd: llmBudget, wallMs: AGENT_EXECUTION_WALL_MS, onUsage: checkpoint });
  } catch (e) {
    output = { llmCostUsd: 0, turns: 0, stop: "error", error: String((e as Error)?.message ?? e).slice(0, 300) } as Awaited<ReturnType<ModelDriver["run"]>>;
  }
  // the model cost of this run = the agent's own run + the review calls it made (a requeued or killed run's cost is already on the mission through the checkpoints and the review state)
  const reviewAfter = await readReviewState(store, mission.id);
  const reviewSpent = Math.max(0, reviewAfter.spentUsd - reviewBefore.spentUsd);
  const llm = Number(baseLlm + output.llmCostUsd + reviewSpent);
  await recordTokens(deps, mission.id, 1, output.usage, { inputTokens: reviewAfter.inputTokens - reviewBefore.inputTokens, outputTokens: reviewAfter.outputTokens - reviewBefore.outputTokens, calls: reviewAfter.calls - reviewBefore.calls }, output.llmCostUsd + reviewSpent);
  if (output.stop === "memory" && !state.finish && await requeue(deps, mission, "approved", { execution_llm_usd: Number(llm.toFixed(6)), execution_treg_usd: Number(budget.spentUsd().toFixed(6)) }, "memory")) return;

  await settleExecution(deps, mission, plan, reserve, unit, { llm, executionTregUsd: budget.spentUsd(), summary: state.finish?.summary_ar ?? null, outputError: output.error ?? null });
}

/**
 * ENDS AN EXECUTION WITH WHAT IS SAVED: the unique final rows of the delivered stages (each linked to a saved parent row) become the files, and the existing settlement functions charge ceil(delivered x unit price), never
 * above the reserve, and release the rest of the hold. Used by the normal end of a run and by every recovery that ends a mission (a run that failed too many times, a worker that restarted too many times).
 */
async function settleExecution(deps: RunnerDeps, mission: MissionRecord, plan: PricedPlan, reserve: number, unit: number, a: { llm: number; executionTregUsd: number; summary: string | null; outputError: string | null }): Promise<void> {
  const { store } = deps;
  const fresh = (await store.getMission(mission.id)) ?? mission;
  const llm = a.llm;
  const jobId = mission.job_id;
  if (!jobId) throw new Error("the mission has no job");
  // deliver what is saved: the unique final rows of the delivered stages, each linked to a saved parent row
  const { delivered, perStage } = await countDeliveredRows(store, mission.id, plan);
  const spent = Number((fresh.planning_treg_usd ?? 0) + a.executionTregUsd);
  const rowsByStage: Record<string, Array<Record<string, unknown>>> = {};
  for (const s of plan.stages) { const raw = await store.getFile(mission.id, `rows/${s.key}.json`); rowsByStage[s.key] = raw ? JSON.parse(raw) : []; }

  let resultPath: string | null = null;
  let files: Array<{ name: string; path: string; kind: string }> = [];
  if (delivered > 0) {
    try {
      const built = await buildMissionFiles(plan, rowsByStage);
      const published = await store.publishResult({ missionId: mission.id, userId: mission.user_id, jobId, xlsx: built.xlsx, csv: built.csv });
      resultPath = published.resultPath;
      files = published.files;
    } catch (e) {
      await settleMission(deps.client, { jobId, deliveredUnits: 0, unitPricePoints: unit, reservedPoints: reserve, costUsd: spent, resultPath: null, releaseReason: "agent mission: the result files could not be saved" });
      await store.updateMission(mission.id, { status: "failed", error: `files: ${String((e as Error)?.message ?? e).slice(0, 200)}`, execution_llm_usd: Number(llm.toFixed(6)), charged_points: 0, delivered_units: 0, ...clear });
      await store.addEvent(mission.id, { kind: "result", message_ar: "تعذّر حفظ ملفات النتائج؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد." });
      await tell(deps, mission, jobId, "failed", { delivered: 0, planned: plan.price.deliveredRows, chargedPoints: 0, releasedPoints: reserve, hasJob: true });
      return;
    }
  }
  const settled = await settleMission(deps.client, { jobId, deliveredUnits: delivered, unitPricePoints: unit, reservedPoints: reserve, costUsd: spent, resultPath, releaseReason: "agent mission delivered nothing" });
  if (!settled.ok) {
    await store.updateMission(mission.id, { status: "failed", error: `settlement ${settled.code}: ${settled.detail}`, execution_llm_usd: Number(llm.toFixed(6)), ...clear });
    await store.addEvent(mission.id, { kind: "result", message_ar: "تعذّرت التسوية الآلية للمهمة؛ راجع المشرف ولم يُخصم رصيد إضافي." });
    return;
  }
  const base = a.summary ?? (delivered > 0 ? `توقف الوكيل بعد حفظ ${toArabicDigits(delivered)} صفًا؛ سُلّم ما حُفظ فقط.` : "لم يتمكّن الوكيل من تسليم أي صف؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");
  // a shortfall is always said in plain words by code, whatever the model wrote: only rows that match the request are delivered and charged
  const shortfall = delivered > 0 && delivered < plan.price.deliveredRows ? ` سُلّم ${toArabicDigits(delivered)} من ${toArabicDigits(plan.price.deliveredRows)} صفًا فقط، وهذا كل ما وُجد مطابقًا لطلبك ضمن حدود المصادر والميزانية، ولم يُخصم إلا مقابله.` : "";
  const summary = `${base}${shortfall}`.slice(0, 1100);
  await store.updateMission(mission.id, {
    status: delivered > 0 ? "completed" : "unserved", delivered_units: delivered, charged_points: settled.chargedPoints, summary_ar: summary, files: files.length ? files : null,
    execution_llm_usd: Number(llm.toFixed(6)), execution_treg_usd: Number(a.executionTregUsd.toFixed(6)), error: settled.kind === "settled" && !settled.matchesExpectation ? `charge ${settled.chargedPoints} differs from the expected ${settled.expectedChargedPoints}` : (a.outputError ?? null), ...clear,
  });
  await store.addEvent(mission.id, { kind: "result", message_ar: summary, counts: { delivered, charged_points: settled.chargedPoints, ...Object.fromEntries(plan.stages.map((s, i) => [`stage_${i + 1}_rows`, perStage[s.key] ?? 0])) } });
  await tell(deps, mission, jobId, delivered <= 0 ? "unserved" : delivered < plan.price.deliveredRows ? "partial" : "completed", { delivered, planned: plan.price.deliveredRows, chargedPoints: settled.chargedPoints, releasedPoints: Math.max(0, reserve - settled.chargedPoints), hasJob: true });
}

const shortError = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * WHAT HAPPENS WHEN A RUN ENDS WITH AN EXCEPTION (or ends without leaving the mission in any state): the mission must never stay «planning» / «executing» under a worker that is no longer running it.
 *  - planning (nothing was held): back to «queued» (counted, at most AGENT_ERROR_REQUEUES_MAX times), then one honest Arabic message;
 *  - execution (a reserve is held): back to «approved» with everything it saved (counted), then settled with what is saved through the existing settlement functions, the rest of the hold released.
 * Every step here is guarded: if even this fails, the mission is simply not renewed (the worker only renews missions it runs), its lease ends and another run takes it over.
 */
export async function recoverFromError(deps: RunnerDeps, mission: MissionRecord, error: unknown): Promise<void> {
  const { store } = deps;
  const message = shortError(error);
  deps.log?.(`mission_error ${mission.id} ${message.slice(0, 200)}`);
  try {
    const fresh = (await store.getMission(mission.id)) ?? mission;
    if (fresh.status !== "planning" && fresh.status !== "executing") return; // the run had already moved it on: nothing is left leased
    if (fresh.status === "planning") {
      if (await requeue(deps, fresh, "queued", { error: message }, "error")) return;
      await endPlanningUnserved(deps, fresh, message);
      return;
    }
    if (await requeue(deps, fresh, "approved", { error: message }, "error")) return;
    const plan = fresh.plan;
    const reserve = Number(fresh.reserved_points);
    const unit = Number(fresh.unit_price_points);
    if (!plan || !fresh.job_id || !(reserve > 0) || !(unit > 0)) { await store.updateMission(mission.id, { status: "failed", error: message, ...clear }); return; }
    try {
      await settleExecution(deps, fresh, plan, reserve, unit, { llm: Number(fresh.execution_llm_usd ?? 0), executionTregUsd: Number(fresh.execution_treg_usd ?? 0), summary: null, outputError: message });
    } catch (e) {
      // last resort: nothing delivered, the whole hold released through the existing function
      deps.log?.(`settle_failed ${mission.id} ${shortError(e).slice(0, 120)}`);
      await settleMission(deps.client, { jobId: fresh.job_id, deliveredUnits: 0, unitPricePoints: unit, reservedPoints: reserve, costUsd: Number(fresh.planning_treg_usd ?? 0) + Number(fresh.execution_treg_usd ?? 0), resultPath: null, releaseReason: "agent mission could not be completed" });
      await store.updateMission(mission.id, { status: "failed", error: message, charged_points: 0, delivered_units: 0, ...clear });
      await store.addEvent(mission.id, { kind: "result", message_ar: "تعذّر إكمال المهمة؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد." });
      await tell(deps, fresh, fresh.job_id, "failed", { delivered: 0, planned: plan.price.deliveredRows, chargedPoints: 0, releasedPoints: reserve, hasJob: true });
    }
  } catch (e) {
    deps.log?.(`recovery_failed ${mission.id} ${shortError(e).slice(0, 120)}`);
  }
}

/**
 * THE ONE ENTRY POINT OF THE WORKER FOR A CLAIMED MISSION: runs the phase its status names, and whatever happens (an exception, or a run that returns without leaving the mission in any state) the mission ends in a clean
 * state (recoverFromError). Never throws.
 */
export async function runMissionSafely(deps: RunnerDeps, mission: MissionRecord): Promise<void> {
  try {
    if (mission.status === "planning") await runPlanning(deps, mission);
    else if (mission.status === "executing") await runExecution(deps, mission);
    else return;
  } catch (e) {
    await recoverFromError(deps, mission, e);
    return;
  }
  try {
    const after = await deps.store.getMission(mission.id);
    // the run returned but left the mission «planning» / «executing» under this worker: that is a lease nobody works on
    if (after && (after.status === "planning" || after.status === "executing") && after.worker_id === mission.worker_id) await recoverFromError(deps, after, "the run ended without a result");
  } catch (e) {
    deps.log?.(`post_run_check_failed ${mission.id} ${shortError(e).slice(0, 120)}`);
  }
}
