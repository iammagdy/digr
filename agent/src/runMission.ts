import { createJobCallBudget } from "../../src/lib/server/callBudget";
import type { CallRecorder, FetchFn } from "../../src/lib/server/multiProvider/adapterTypes";
import type { TregCallOptions, TregCallResult } from "../../src/functions/shared/tregClient";
import type { commitTregSpend } from "../../src/lib/server/tregCallRecord";
import type { TregCatalog } from "../../src/lib/treg/catalog";
import type { AccountAccess } from "../../src/lib/treg/dataPolicy";
import {
  AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD, AGENT_EXECUTION_LLM_BUDGET_SHARE, AGENT_MEMORY_REQUEUES_MAX, AGENT_EXECUTION_MAX_TURNS, AGENT_EXECUTION_WALL_MS, AGENT_PLANNING_LLM_BUDGET_USD,
  AGENT_PLANNING_MAX_TURNS, AGENT_PLANNING_WALL_MS, AGENT_PRICING_BASIS,
} from "../../src/lib/agentMission/constants";
import { executionBudgetUsd } from "../../src/lib/agentMission/price";
import { planningBudgetUsd } from "../../src/lib/agentMission/budget";
import { settleMission } from "../../src/lib/agentMission/lifecycle";
import { customerPlanView, type PricedPlan } from "../../src/lib/agentMission/plan";
import { toArabicDigits } from "../../src/lib/arabicDigits";
import { holdValueUsd } from "../../src/lib/server/callBudget";
import type { ModelDriver } from "./driver";
import { createGateway } from "./gateway";
import { createWebGateway, type ProviderKeyFn } from "./webGateway";
import { loadSystemPrompt } from "./prompt";
import { buildTools, countDeliveredRows, newRunState, type ToolContext } from "./tools";
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

const MEMORY_REQUEUES_FILE = "memory_requeues.txt";

/**
 * The worker stopped the model run because the dyno's memory reached its hard limit (worker.ts): the mission goes back to the queue (a mission that holds a reserve goes back to «approved» with everything it
 * saved; planning goes back to «queued») instead of the dyno being killed. At most AGENT_MEMORY_REQUEUES_MAX times: after that it ends with what it has, settled like any other end. True when it was requeued.
 */
async function requeueForMemory(deps: RunnerDeps, mission: MissionRecord, status: "queued" | "approved", patch: Record<string, unknown>): Promise<boolean> {
  const n = Number(await deps.store.getFile(mission.id, MEMORY_REQUEUES_FILE)) || 0;
  if (n >= AGENT_MEMORY_REQUEUES_MAX) return false;
  await deps.store.putFile(mission.id, MEMORY_REQUEUES_FILE, String(n + 1), "text/plain");
  await deps.store.updateMission(mission.id, { ...patch, status, worker_id: null, lease_until: null });
  await deps.store.addEvent(mission.id, { kind: "system", message_ar: "تأجّلت مهمتك قليلًا بسبب ضغط على الخدمة، وستُستأنف تلقائيًا من حيث وصلت.", counts: { requeued: n + 1 } });
  deps.log?.(`memory_requeue ${mission.id} -> ${status} (${n + 1} of ${AGENT_MEMORY_REQUEUES_MAX})`);
  return true;
}

/** The customer's notice (in-site and e-mail); never lets a failed notice change the mission. */
async function tell(deps: RunnerDeps, mission: MissionRecord, jobId: string | null, kind: MissionNoticeKind, facts: MissionNoticeFacts): Promise<void> {
  try { await deps.notify?.({ userId: mission.user_id, missionId: mission.id, jobId, kind, facts }); } catch (e) { deps.log?.(`notice_failed ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
}

export async function runPlanning(deps: RunnerDeps, mission: MissionRecord): Promise<void> {
  const { store } = deps;
  const model = deps.models.planning;
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
  const ctx: ToolContext = { phase: "planning", mission, plan: null, store, gateway, web, catalog: deps.catalog, access, state, sandbox: deps.sandbox };
  let output;
  try {
    output = await deps.driver.run({ phase: "planning", systemPrompt: loadSystemPrompt("planning", deps.systemPromptFile), userPrompt: planningPrompt(mission, calls), tools: buildTools(ctx), state, model, maxTurns: AGENT_PLANNING_MAX_TURNS, maxBudgetUsd: AGENT_PLANNING_LLM_BUDGET_USD, wallMs: AGENT_PLANNING_WALL_MS });
  } catch (e) {
    output = { llmCostUsd: 0, turns: 0, stop: "error", error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  const llm = Number(((await store.getMission(mission.id))?.planning_llm_usd ?? 0) + output.llmCostUsd);
  const base = { planning_llm_usd: Number(llm.toFixed(6)), ...clear };
  if (output.stop === "memory" && !state.proposedPlan && !state.question && !state.finish && await requeueForMemory(deps, mission, "queued", { planning_llm_usd: base.planning_llm_usd })) return;

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
  await store.updateMission(mission.id, { execution_model: model, error: null });
  await store.addEvent(mission.id, { kind: "system", message_ar: "اعتُمدت الخطة وبدأ الوكيل التنفيذ." });
  const calls = await store.listCalls(mission.id);
  const access = await deps.resolveAccess(mission.user_id);
  const budget = createJobCallBudget({ ceilingUsd: executionBudgetUsd(reserve), spentUsd: sum(calls, "execution") });
  const counter = { seq: lastSeq(calls) };
  const gateway = createGateway({ store, client: deps.client, missionId: mission.id, userId: mission.user_id, jobId: mission.job_id, phase: "execution", access, catalog: deps.catalog, budget, recorder: deps.recorder, commit: deps.commit, call: deps.call, token: deps.token, defaultPurpose: mission.request_text, counter });
  const web = deps.providerKey ? createWebGateway({ store, missionId: mission.id, jobId: mission.job_id, phase: "execution", budget, recorder: deps.recorder, providerKey: deps.providerKey, fetchFn: deps.fetchFn, counter }) : undefined;
  const state = newRunState(await lastOut(store, mission.id));
  const ctx: ToolContext = { phase: "execution", mission, plan, store, gateway, web, catalog: deps.catalog, access, state, sandbox: deps.sandbox };
  const savedBefore = (await countDeliveredRows(store, mission.id, plan)).perStage;
  const llmBudget = Math.max(AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD, holdValueUsd(reserve, AGENT_PRICING_BASIS) * AGENT_EXECUTION_LLM_BUDGET_SHARE);
  let output;
  try {
    output = await deps.driver.run({ phase: "execution", systemPrompt: loadSystemPrompt("execution", deps.systemPromptFile), userPrompt: executionPrompt(mission, plan, calls, savedBefore), tools: buildTools(ctx), state, model, maxTurns: AGENT_EXECUTION_MAX_TURNS, maxBudgetUsd: llmBudget, wallMs: AGENT_EXECUTION_WALL_MS });
  } catch (e) {
    output = { llmCostUsd: 0, turns: 0, stop: "error", error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  const fresh = (await store.getMission(mission.id)) ?? mission;
  const llm = Number((fresh.execution_llm_usd ?? 0) + output.llmCostUsd);
  if (output.stop === "memory" && !state.finish && await requeueForMemory(deps, mission, "approved", { execution_llm_usd: Number(llm.toFixed(6)), execution_treg_usd: Number(budget.spentUsd().toFixed(6)) })) return;

  // deliver what is saved: the unique final rows of the delivered stages, each linked to a saved parent row
  const { delivered, perStage } = await countDeliveredRows(store, mission.id, plan);
  const spent = Number((fresh.planning_treg_usd ?? 0) + budget.spentUsd());
  const rowsByStage: Record<string, Array<Record<string, unknown>>> = {};
  for (const s of plan.stages) { const raw = await store.getFile(mission.id, `rows/${s.key}.json`); rowsByStage[s.key] = raw ? JSON.parse(raw) : []; }

  let resultPath: string | null = null;
  let files: Array<{ name: string; path: string; kind: string }> = [];
  if (delivered > 0) {
    try {
      const built = await buildMissionFiles(plan, rowsByStage);
      const published = await store.publishResult({ missionId: mission.id, userId: mission.user_id, jobId: mission.job_id, xlsx: built.xlsx, csv: built.csv });
      resultPath = published.resultPath;
      files = published.files;
    } catch (e) {
      await settleMission(deps.client, { jobId: mission.job_id, deliveredUnits: 0, unitPricePoints: unit, reservedPoints: reserve, costUsd: spent, resultPath: null, releaseReason: "agent mission: the result files could not be saved" });
      await store.updateMission(mission.id, { status: "failed", error: `files: ${String((e as Error)?.message ?? e).slice(0, 200)}`, execution_llm_usd: Number(llm.toFixed(6)), charged_points: 0, delivered_units: 0, ...clear });
      await store.addEvent(mission.id, { kind: "result", message_ar: "تعذّر حفظ ملفات النتائج؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد." });
      await tell(deps, mission, mission.job_id, "failed", { delivered: 0, planned: plan.price.deliveredRows, chargedPoints: 0, releasedPoints: reserve, hasJob: true });
      return;
    }
  }
  const settled = await settleMission(deps.client, { jobId: mission.job_id, deliveredUnits: delivered, unitPricePoints: unit, reservedPoints: reserve, costUsd: spent, resultPath, releaseReason: "agent mission delivered nothing" });
  if (!settled.ok) {
    await store.updateMission(mission.id, { status: "failed", error: `settlement ${settled.code}: ${settled.detail}`, execution_llm_usd: Number(llm.toFixed(6)), ...clear });
    await store.addEvent(mission.id, { kind: "result", message_ar: "تعذّرت التسوية الآلية للمهمة؛ راجع المشرف ولم يُخصم رصيد إضافي." });
    return;
  }
  const summary = state.finish?.summary_ar ?? (delivered > 0 ? `توقف الوكيل بعد حفظ ${toArabicDigits(delivered)} صفًا؛ سُلّم ما حُفظ فقط.` : "لم يتمكّن الوكيل من تسليم أي صف؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");
  await store.updateMission(mission.id, {
    status: delivered > 0 ? "completed" : "unserved", delivered_units: delivered, charged_points: settled.chargedPoints, summary_ar: summary, files: files.length ? files : null,
    execution_llm_usd: Number(llm.toFixed(6)), execution_treg_usd: Number(budget.spentUsd().toFixed(6)), error: settled.kind === "settled" && !settled.matchesExpectation ? `charge ${settled.chargedPoints} differs from the expected ${settled.expectedChargedPoints}` : (output.error ?? null), ...clear,
  });
  await store.addEvent(mission.id, { kind: "result", message_ar: summary, counts: { delivered, charged_points: settled.chargedPoints, ...Object.fromEntries(plan.stages.map((s, i) => [`stage_${i + 1}_rows`, perStage[s.key] ?? 0])) } });
  await tell(deps, mission, mission.job_id, delivered <= 0 ? "unserved" : delivered < plan.price.deliveredRows ? "partial" : "completed", { delivered, planned: plan.price.deliveredRows, chargedPoints: settled.chargedPoints, releasedPoints: Math.max(0, reserve - settled.chargedPoints), hasJob: true });
}
