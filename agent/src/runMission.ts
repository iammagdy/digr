import { createJobCallBudget } from "../../src/lib/server/callBudget";
import type { CallRecorder, FetchFn } from "../../src/lib/server/multiProvider/adapterTypes";
import type { TregCallOptions, TregCallResult } from "../../src/functions/shared/tregClient";
import type { commitTregSpend } from "../../src/lib/server/tregCallRecord";
import type { TregCatalog } from "../../src/lib/treg/catalog";
import type { AccountAccess } from "../../src/lib/treg/dataPolicy";
import {
  AGENT_ERROR_REQUEUES_MAX, AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD, AGENT_EXECUTION_LLM_BUDGET_SHARE, AGENT_MEMORY_REQUEUES_MAX, AGENT_PHASE_STARTS_MAX, AGENT_RESTART_REQUEUES_MAX, AGENT_EXECUTION_MAX_TURNS, AGENT_EXECUTION_WALL_MS, AGENT_PLANNING_LLM_BUDGET_USD,
  AGENT_PLANNING_MAX_TURNS, AGENT_PLANNING_NUDGES_MAX, AGENT_PLANNING_WALL_MS, AGENT_PRICING_BASIS, AGENT_EXECUTION_CONTINUE_ROUNDS, AGENT_SOURCE_MEASURE_WINDOW_MS,
} from "../../src/lib/agentMission/constants";
import { executionBudgetUsd, reviewBudgetUsdFor, reviewCeilingUsdFor } from "../../src/lib/agentMission/price";
import { MISSION_PRICING_SETTING_KEY, normalizeMissionPricingSettings } from "../../src/lib/missionPricing";
import { planningBudgetFacts } from "../../src/lib/agentMission/planningBudget";
import { statsFromCalls } from "../../src/lib/agentMission/sourceRanking";
import { classifyNoCardEnd, refusalSentenceAr } from "../../src/lib/agentMission/refusal";
import { parentCountsOf, parentsBelowShare } from "../../src/lib/agentMission/parents";
import { settleMission } from "../../src/lib/agentMission/lifecycle";
import { cardTotalOf, customerPlanView, deliveryDenominatorOf, namesAreWritten, requestedRowsOf, type PricedPlan } from "../../src/lib/agentMission/plan";
import { topLevelFactsOf } from "../../src/lib/agentMission/repliesCard";
import { toArabicDigits } from "../../src/lib/arabicDigits";
import { RELEVANCE_REASON_LIST, type RelevanceReason } from "../../src/lib/agentMission/relevance";
import { FILTER_REASONS, isEnabled, type FilterReason } from "../../src/lib/agentMission/filters";
import { holdValueUsd } from "../../src/lib/server/callBudget";
import type { ModelDriver } from "./driver";
import { createGateway } from "./gateway";
import { createWebGateway, type ProviderKeyFn } from "./webGateway";
import { loadSystemPrompt } from "./prompt";
import { anyWebAvailable, NO_WEB, resolveWebAvailability } from "../../src/lib/agentMission/webAvailability";
import { PLANNING_NUDGE } from "./nudge";
import { readRunState, updateRunState, type RunState } from "./runState";
import { buildTools, newRunState, type ToolContext } from "./tools";
import { ItemStore, type ItemSnapshot, type StopReason } from "./items/itemStore";
import { mirrorLegacyFiles } from "./items/mirror";
import { runEngine } from "./engine/run";
import { runContactEnrichment } from "./engine/contacts";
import { runNamesStep } from "./namesAr";

import { runInSandbox } from "./sandbox";
import { trackRun, untrackRun } from "./sessions";
import { childShortfallClauseAr, countWorkbookSheets, shortfallClauseAr, shortfallFromStopAr, stageTruthBodyAr, zeroDeliveryReasonAr, type ZeroDeliveryFacts } from "./finalize";
import { createReviewer, readReviewState, type ReviewCall } from "./review";
import type { TokenUsage } from "./llmCost";
import { buildExcludedAdminCsv, buildMissionFiles, type CompanyMailboxes, type ExcludedRow } from "./workbook";
import { isPeopleStage, mailboxesOf } from "../../src/lib/agentMission/people";
import { availableContactAnswerNote } from "../../src/lib/agentMission/contactQuestion";
import { missionFactsOf } from "./methodology";
import { missionFileTitleAr } from "../../src/lib/agentMission/fileNames";
import { itemNounOf, itemNounOfPlan } from "../../src/lib/agentMission/itemNoun";
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
  /** Carry out a plan whose stages all have an execution recipe with the code engine, no model session (default true). false: the model carries every mission out (through the same item store). */
  engine?: boolean;
  /** The pause before the one delayed review retry (tests pass a fake that does not wait). */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** The least time the contact finder steps may take after the stages, even when the stages used the mission's whole wall time (a lookup is about a second per person). */
const CONTACT_STEP_MIN_WALL_MS = 5 * 60_000;
const sum = (calls: CallRow[], phase: CallRow["phase"]) => calls.filter((c) => c.phase === phase).reduce((n, c) => n + (Number(c.cost_usd) || 0), 0);
const lastSeq = (calls: CallRow[]) => calls.reduce((n, c) => Math.max(n, Number(/call_(\d+)$/.exec(c.id)?.[1] ?? 0)), 0);
const lastOut = async (store: AgentStore, missionId: string): Promise<number> => {
  // outputs continue their numbering after a restart: the highest number in the mission's own `out/` folder (the listing reads the database, so it is exact right after a write)
  const listed = await store.listFiles(missionId, "out").catch(() => []);
  return listed.reduce((n, f) => Math.max(n, Number(/^out\/out_(\d+)\.json$/.exec(f.name)?.[1] ?? 0)), 0);
};

function savedCallsNote(calls: CallRow[]): string {
  const rows = calls.filter((c) => c.status === "ok" || c.status === "empty").map((c) => `- ${c.id.split(":").pop()}: endpoint ${c.endpoint_id}, params ${JSON.stringify(c.params_digest)}, ${c.rows_returned ?? 0} rows, ${c.phase}`);
  return rows.length ? `Pages ALREADY saved for this mission (use them with run_code before paying for the same data again):\n${rows.join("\n")}` : "No page is saved yet.";
}

/** The planning run ended with a plain end (not a limit, a crash or a restart) and said nothing the system can use: no plan, no question, no ending. */
export const endedSilently = (output: { stop?: string; error?: string }, state: { proposedPlan: unknown; question: unknown; finish: unknown }): boolean => output.stop === "end" && !output.error && !state.proposedPlan && !state.question && !state.finish;


/** Everything the agent is told at the start of a PLANNING run. */
export function planningPrompt(mission: MissionRecord, calls: CallRow[]): string {
  const followAnswer = availableContactAnswerNote(mission.answer_text);
  const answer = mission.answer_text ? `\n\nYou asked the customer one question and they answered: «${mission.answer_text}». Do not ask again.${followAnswer ? ` ${followAnswer}` : ""}` : "";
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
type RequeueCause = "memory" | "error" | "restart";
const REQUEUE_LIMIT: Record<RequeueCause, number> = { memory: AGENT_MEMORY_REQUEUES_MAX, error: AGENT_ERROR_REQUEUES_MAX, restart: AGENT_RESTART_REQUEUES_MAX };
const REQUEUE_COUNTER: Record<RequeueCause, keyof Pick<RunState, "memoryRequeues" | "errorRequeues" | "restartRequeues">> = { memory: "memoryRequeues", error: "errorRequeues", restart: "restartRequeues" };
const REQUEUE_MESSAGE_AR: Record<RequeueCause, string> = {
  memory: "تأجّلت مهمتك قليلًا بسبب ضغط على الخدمة، وستُستأنف تلقائيًا من حيث وصلت.",
  error: "تعثّرت الخطوة الأخيرة مؤقتًا، وستُستأنف مهمتك تلقائيًا من حيث وصلت.",
  restart: "أُعيد تشغيل الخدمة أثناء العمل على مهمتك، وستُستأنف تلقائيًا من حيث وصلت.",
};

/**
 * A RUN THE PLATFORM CUT SHORT: the worker was told to stop (SIGTERM at a deploy: `output.stop === "restart"`), or the model's own process died with that signal (exit code 143, or 137 for SIGKILL) before the worker's handler could say so. It is
 * never the customer's request that failed: the mission goes back to the queue (planning) or to «approved» with everything it saved (execution), and the next worker takes it.
 */
export const endedByRestart = (output: { stop?: string; error?: string }): boolean =>
  output.stop === "restart" || (output.stop === "error" && /exited with code (?:143|137)\b|\bSIGTERM\b|\bSIGKILL\b|terminated by signal/i.test(String(output.error ?? "")));

/**
 * PUTS A MISSION BACK IN THE QUEUE: a mission that holds a reserve goes back to «approved» with everything it saved, planning goes back to «queued», with no worker and no lease so any worker takes it.
 * `cause` is why: "memory" (the worker stopped the run at the dyno's hard limit), "restart" (the platform restarted the worker) or "error" (the run ended with an exception); each has its own count (run_state.json) and its own limit, after which this returns false and
 * the caller ends the mission honestly. The count is a note: if it cannot be saved the in-process copy still stops a loop.
 */
async function requeue(deps: RunnerDeps, mission: MissionRecord, status: "queued" | "approved", patch: Record<string, unknown>, cause: RequeueCause): Promise<boolean> {
  const state = await readRunState(deps.store, mission.id);
  const counter = REQUEUE_COUNTER[cause];
  const max = REQUEUE_LIMIT[cause];
  if (state[counter] >= max) return false;
  const next = await updateRunState(deps.store, mission.id, (s) => ({ ...s, [counter]: s[counter] + 1 }), deps.log);
  await deps.store.updateMission(mission.id, { ...patch, status, worker_id: null, lease_until: null });
  const n = next[counter];
  await deps.store.addEvent(mission.id, { kind: "system", message_ar: REQUEUE_MESSAGE_AR[cause], counts: { requeued: n } });
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
/**
 * THE REPORT OF THE CHECK OF ITEMS: stored as an internal event per stage (found, new, duplicates, looked at, accepted by rule and on what basis, accepted by the model, left out per reason, still pending, never looked at, the review's
 * extension) and the excluded items as an admin-only CSV. Every number is read from the item store's snapshot. The customer's files never hold an excluded item. Never throws.
 */
async function recordChecks(deps: RunnerDeps, missionId: string, plan: PricedPlan, store: AgentStore, snap: ItemSnapshot): Promise<{ pending: number; stop: "budget" | "failed" | null; languageLeftOut: number; lastUnusable: string; failedCalls: number }> {
  let pendingTotal = 0;
  let languageLeftOut = 0;
  let stop: "budget" | "failed" | null = null;
  let lastUnusable = "";
  let failedCalls = 0;
  try {
    const review = await readReviewState(store, missionId);
    stop = review.stop;
    lastUnusable = review.lastUnusable;
    failedCalls = review.failedCalls;
    const excludedByStage: Record<string, ExcludedRow[]> = {};
    for (const [i, s] of plan.stages.entries()) {
      const c = snap.counts(s.key);
      const asRow = (it: { id: string; reason?: string; row: Record<string, unknown> | null }): ExcludedRow => ({ id: it.id, reason: it.reason as RelevanceReason | FilterReason, row: it.row ?? {} });
      const listed = [...snap.excludedItems(s.key), ...snap.pendingItems(s.key)].filter((it) => it.row && it.reason && (RELEVANCE_REASON_KEYS as readonly string[]).includes(it.reason)).map(asRow);
      if (listed.length > 0) excludedByStage[s.key] = listed;
      pendingTotal += c.pending;
      if (s.deliver) languageLeftOut += c.excludedByReason.filter_language ?? 0;
      if (!s.relevance && !(s.filters ?? []).some(isEnabled)) continue;
      const counts: Record<string, number> = { chk_stage: i + 1, chk_examined: c.checked, chk_by_rule: c.acceptedByRule, chk_by_model: c.acceptedByModel, chk_excluded: c.excludedRelevance, chk_pending: c.pending, chk_review_extended: review.extended ? 1 : 0, chk_found: c.found, chk_new: c.new, chk_dup: c.duplicates, chk_unchecked: c.unchecked, chk_saved: c.saved };
      for (const [b, n] of Object.entries(c.acceptedByRuleBasis)) counts[`chk_rule_${b}`] = n ?? 0;
      for (const [r, n] of Object.entries(c.excludedByReason)) if ((RELEVANCE_REASON_KEYS as readonly string[]).includes(r)) counts[`chk_ex_${r}`] = n ?? 0;
      await store.addEvent(missionId, { kind: "call", message_ar: "تقرير داخلي لفحص العناصر في هذه المرحلة.", counts });
    }
    const csv = buildExcludedAdminCsv(plan, excludedByStage);
    if (csv) await store.putFile(missionId, "admin/excluded.csv", csv, "text/csv");
  } catch (e) {
    deps.log?.(`checks_not_recorded ${missionId} ${shortMessage(e)}`);
  }
  return { pending: pendingTotal, stop, languageLeftOut, lastUnusable, failedCalls };
}
const RELEVANCE_REASON_KEYS = [...RELEVANCE_REASON_LIST, ...FILTER_REASONS] as const;

/**
 * THE COMPANIES' OWN E-MAILS: the rows of a people stage that were not people (a role or generic mailbox, a row with no person's name: people.ts) were kept with their reason and their address. They go to the sheet of the companies, one cell per company
 * (workbook.ts); here they are gathered by company, in the order the source gave them, each address once. Only what the log recorded: never an address that was not in a row.
 */
export function companyMailboxesOf(plan: PricedPlan, snap: ItemSnapshot): CompanyMailboxes {
  const out: CompanyMailboxes = {};
  for (const s of plan.stages) {
    if (s.parent_key === null || !isPeopleStage(s)) continue;
    // only the stage whose rows ARE the companies: a mailbox found for a PERSON (a step under a people stage) is not a company e-mail
    const parentStage = plan.stages.find((p) => p.key === s.parent_key);
    if (!parentStage || isPeopleStage(parentStage)) continue;
    const byParent = out[s.parent_key] ?? (out[s.parent_key] = new Map());
    for (const it of snap.excludedItems(s.key)) {
      if (it.reason !== "not_a_person" || !it.row) continue;
      const parentId = String(it.row.parent_id ?? "").trim();
      if (!parentId) continue;
      const have = byParent.get(parentId) ?? [];
      for (const email of mailboxesOf(it.row, s.columns)) if (!have.includes(email)) have.push(email);
      if (have.length > 0) byParent.set(parentId, have);
    }
  }
  return out;
}
/** True when a text carries a number (Latin or Arabic-Indic digits): a model note with one is dropped, so a count in a text always comes from the data. */
export const HAS_NUMBER = /[0-9٠-٩]/;

/** Why fewer items than requested were delivered, in plain Arabic and with no number: the review's limit or a failure when rows were waiting for it, else that the sources gave no more matching items. */
export function shortfallReasonAr(checked: { pending: number; stop: "budget" | "failed" | null }): string {
  if (checked.pending > 0 && checked.stop === "failed") return "لم يكتمل العدد المطلوب لأن المراجعة الآلية تعذّر الوصول إليها لبعض ما وُجد، فلم يُسلَّم ما لم يُراجَع، ولم يُخصم إلا مقابل ما سُلّم.";
  if (checked.pending > 0) return "لم يكتمل العدد المطلوب لأن المراجعة الآلية بلغت حدّها المسموح لهذه المهمة قبل فحص كل ما وُجد، فلم يُسلَّم ما لم يُراجَع، ولم يُخصم إلا مقابل ما سُلّم.";
  return "لم يكتمل العدد المطلوب لأن هذا كل ما وُجد مطابقًا لطلبك ضمن حدود المصادر والميزانية، ولم يُخصم إلا مقابل ما سُلّم.";
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
  const counter = { seq: lastSeq(calls) };
  const requestForBudget = `${mission.request_text} ${mission.answer_text ?? ""}`;
  // THE MEASUREMENT AND THE HEALTH OF THE SOURCES, read from the recorded calls of all missions (read only; planning never waits on it): the ranking the planner gets is computed from them
  const planningNow = Date.now();
  const sourceStats = statsFromCalls(await store.recentCalls(planningNow - AGENT_SOURCE_MEASURE_WINDOW_MS).catch(() => []));
  // THE PLANNING BUDGET is the base figure, or what one minimal sample per stage costs on the platform's sources, under a hard cap (planningBudget.ts): decided by code from the customer's words and the catalog, never by the model
  const budgetFacts = planningBudgetFacts(requestForBudget, { catalog: deps.catalog, access, stats: sourceStats, now: planningNow });
  const budget = createJobCallBudget({ ceilingUsd: budgetFacts.budgetUsd, spentUsd: sum(calls, "planning") });
  deps.log?.(`planning_budget ${mission.id} base=${budgetFacts.baseUsd} budget=${budgetFacts.budgetUsd} cap=${budgetFacts.capUsd} stages=${budgetFacts.stages.map((s) => `${s.role}:${s.sourceId ?? "none"}:${s.callUsd.toFixed(5)}:reserve=${s.reserveUsd}`).join("|")}`);
  const gateway = createGateway({ store, client: deps.client, missionId: mission.id, userId: mission.user_id, jobId: null, phase: "planning", access, catalog: deps.catalog, budget, recorder: deps.recorder, commit: deps.commit, call: deps.call, token: deps.token, defaultPurpose: mission.request_text, counter, priorCalls: calls, stats: sourceStats, stageBudget: { stages: budgetFacts.stages.length, budgetUsd: budgetFacts.budgetUsd, reservesUsd: budgetFacts.stages.filter((s) => s.role !== "parent" && s.role !== "only").map((s) => s.reserveUsd) } });
  // THE WEB TOOLS ONLY WHEN THE WORKER HAS A KEY FOR THEM (webAvailability.ts): a tool that would only be refused is not offered, not listed, not named in the prompt
  const webAvailable = deps.providerKey ? await resolveWebAvailability(deps.providerKey) : NO_WEB;
  deps.log?.(`web_tools ${mission.id} firecrawl=${webAvailable.firecrawl} contextdev=${webAvailable.contextdev}`);
  const web = deps.providerKey && anyWebAvailable(webAvailable) ? createWebGateway({ store, missionId: mission.id, jobId: null, phase: "planning", budget, recorder: deps.recorder, providerKey: deps.providerKey, fetchFn: deps.fetchFn, counter }) : undefined;
  const state = newRunState(await lastOut(store, mission.id));
  const pricingSettings = normalizeMissionPricingSettings(((await store.readSettings().catch(() => ({}))) as Record<string, unknown>)[MISSION_PRICING_SETTING_KEY]);
  const ctx: ToolContext = { phase: "planning", mission, plan: null, store, gateway, web, webAvailable, catalog: deps.catalog, access, state, sandbox: deps.sandbox, pricingSettings, stats: sourceStats, now: planningNow };
  // the model cost of earlier runs of this phase (a requeue, a takeover): this run adds to it, and every model message checkpoints the running total, so a run that is killed still leaves its cost on the mission
  const baseLlm = Number((await store.getMission(mission.id))?.planning_llm_usd ?? mission.planning_llm_usd ?? 0);
  let llmBase = baseLlm;
  const checkpoint = async ({ costUsd }: { costUsd: number }) => { try { await store.updateMission(mission.id, { planning_llm_usd: Number((llmBase + costUsd).toFixed(6)) }); } catch { /* a lost checkpoint never stops a run */ } };
  const runOnce = async (userPrompt: string): Promise<Awaited<ReturnType<ModelDriver["run"]>>> => {
    try {
      return await deps.driver.run({ phase: "planning", systemPrompt: loadSystemPrompt("planning", deps.systemPromptFile, { web: Boolean(web) }), userPrompt, tools: buildTools(ctx), state, model, maxTurns: AGENT_PLANNING_MAX_TURNS, maxBudgetUsd: AGENT_PLANNING_LLM_BUDGET_USD, wallMs: AGENT_PLANNING_WALL_MS, onUsage: checkpoint });
    } catch (e) {
      return { llmCostUsd: 0, turns: 0, stop: "error", error: String((e as Error)?.message ?? e).slice(0, 300) } as Awaited<ReturnType<ModelDriver["run"]>>;
    }
  };
  let output = await runOnce(planningPrompt(mission, calls));
  await recordTokens(deps, mission.id, 0, output.usage, { inputTokens: 0, outputTokens: 0, calls: 0 }, output.llmCostUsd);
  // A RUN THAT ENDED WITH NO PLAN, NO QUESTION AND NO ENDING while the sources gave it real rows (live 2026-10-29: Facebook videos, after the customer answered the question, the planner tried two unavailable web searches and stopped): it is asked once more, told to
  // build the plan from what it holds. Never a limit of ours: the run's stop was a plain end, with no budget, turn or time limit reached.
  for (let nudge = 0; nudge < AGENT_PLANNING_NUDGES_MAX && endedSilently(output, state); nudge += 1) {
    llmBase += output.llmCostUsd;
    const fresh = await store.listCalls(mission.id);
    if (!fresh.some((c) => (c.phase ?? "planning") === "planning" && c.status === "ok" && Number(c.rows_returned ?? 0) > 0)) break;
    output = await runOnce(`${planningPrompt(mission, fresh)}\n\n${PLANNING_NUDGE}`);
    await recordTokens(deps, mission.id, 0, output.usage, { inputTokens: 0, outputTokens: 0, calls: 0 }, output.llmCostUsd);
  }
  const llm = Number(llmBase + output.llmCostUsd);
  const base = { planning_llm_usd: Number(llm.toFixed(6)), ...clear };
  if (output.stop === "memory" && !state.proposedPlan && !state.question && !state.finish && await requeue(deps, mission, "queued", { planning_llm_usd: base.planning_llm_usd }, "memory")) return;
  // a deploy restarted the worker while the planning ran (its model process ended with SIGTERM, exit code 143): the planning starts again on the next worker, it is never answered as «a limit of ours»
  if (endedByRestart(output) && !state.proposedPlan && !state.question && !state.finish && await requeue(deps, mission, "queued", { planning_llm_usd: base.planning_llm_usd }, "restart")) return;

  if (state.proposedPlan) {
    const plan = state.proposedPlan;
    await store.updateMission(mission.id, { ...base, status: "plan_ready", plan: plan as any, plan_public: customerPlanView(plan) as any, unit_price_points: plan.price.unitPricePoints, reserved_points: plan.price.reservePoints });
    await store.addEvent(mission.id, { kind: "plan", message_ar: plan.summary_ar, counts: { stages: plan.stages.length, rows: plan.price.deliveredRows, unit_points_x1000: Math.round(plan.price.unitPricePoints * 1000), reserve_points: plan.price.reservePoints } });
    deps.log?.(`plan_ready ${mission.id} ${JSON.stringify(customerPlanView(plan).price)}`);
  } else if (state.question) {
    await store.updateMission(mission.id, { ...base, status: "needs_input", question_ar: state.question });
  } else {
    // NO CARD: exactly one of four honest classes, decided by code from what the planning really did (src/lib/agentMission/refusal.ts), never from the model's own words
    const planningCalls = await store.listCalls(mission.id);
    const verdict = classifyNoCardEnd({ claim: state.finish?.kind ?? (state.finish ? "unsupported" : null), endedWithoutAnswer: !state.finish, stop: output.error ? `${output.stop}: ${output.error}` : String(output.stop ?? ""), calls: planningCalls });
    deps.log?.(`no_card ${mission.id} class=${verdict.cls} reason=${verdict.reason}`);
    if (verdict.cls === "internal") {
      // OUR failure: nothing was held; the admin is flagged (the mission's error and an internal event), the customer is told it was ours
      await store.updateMission(mission.id, { ...base, status: "failed", summary_ar: refusalSentenceAr("internal"), error: `admin: planning_failed class=internal reason=${verdict.reason}${output.error ? ` detail=${output.error}` : ""}`.slice(0, 300) });
      await store.addEvent(mission.id, { kind: "call", message_ar: "علامة للمشرف: تعذّر التخطيط من جانبنا.", counts: { adm_flag: 1 } });
      await store.addEvent(mission.id, { kind: "result", message_ar: refusalSentenceAr("internal") });
      await tell(deps, mission, null, "failed", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false, cause: "internal" });
    } else {
      const sentence = refusalSentenceAr(verdict.cls as "unsupported" | "empty_source");
      await store.updateMission(mission.id, { ...base, status: "unserved", summary_ar: sentence });
      await store.addEvent(mission.id, { kind: "result", message_ar: sentence });
      await tell(deps, mission, null, "unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false, ...(verdict.cls === "empty_source" ? { cause: "empty" as const } : {}) });
    }
  }
}

/** What the model is told when a round ended while matching items were still needed and a source had more: carry on, the numbers are the store's. */
export function continuationPrompt(mission: MissionRecord, plan: PricedPlan, calls: CallRow[], saved: Record<string, number>): string {
  return `${executionPrompt(mission, plan, calls, saved)}\n\nYour last round ended before the approved volume was reached, and a source still has pages. Carry on from where you stopped (collect_pages with the same inputs resumes; never start a source again), save, and finish only when the volume is reached, the source ends, or a call is refused.`;
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
  const webAvailable = deps.providerKey ? await resolveWebAvailability(deps.providerKey) : NO_WEB;
  const web = deps.providerKey && anyWebAvailable(webAvailable) ? createWebGateway({ store, missionId: mission.id, jobId: mission.job_id, phase: "execution", budget, recorder: deps.recorder, providerKey: deps.providerKey, fetchFn: deps.fetchFn, counter }) : undefined;
  const state = newRunState(await lastOut(store, mission.id));
  // THE REVIEW of uncertain rows: a small model request per batch, within 20% of the mission's revenue (rows beyond it are not delivered and not charged); its tokens and cost are counted from the API's own answer
  const reviewBudgetUsd = plan.price.reviewBudgetUsd ?? reviewBudgetUsdFor(plan.price.maxChargePoints);
  const reviewer = deps.reviewCall ? createReviewer({ call: deps.reviewCall, store, missionId: mission.id, requestText: `${mission.request_text}${mission.answer_text ? ` — ${mission.answer_text}` : ""}`, budgetUsd: reviewBudgetUsd, ceilingUsd: reviewCeilingUsdFor(reserve), log: deps.log }) : undefined;
  const reviewBefore = await readReviewState(store, mission.id);
  // THE ONE ITEM STORE: every item the engine or the model saves goes through it; a resumed mission continues from its log
  const items = await ItemStore.open(store, mission.id, { legacyStages: plan.stages.map((s) => s.key) });
  const ctx: ToolContext = { phase: "execution", mission, plan, store, gateway, web, webAvailable, catalog: deps.catalog, access, state, sandbox: deps.sandbox, review: reviewer, items };
  const savedBefore = Object.fromEntries(plan.stages.map((s) => [s.key, items.counts(s.key).accepted]));
  const llmBudget = Math.max(AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD, holdValueUsd(reserve, AGENT_PRICING_BASIS) * AGENT_EXECUTION_LLM_BUDGET_SHARE);
  const baseLlm = Number((await store.getMission(mission.id))?.execution_llm_usd ?? mission.execution_llm_usd ?? 0);
  const checkpoint = async ({ costUsd }: { costUsd: number }) => {
    try {
      const reviewNow = reviewer ? Math.max(0, (await reviewer.state()).spentUsd - reviewBefore.spentUsd) : 0;
      await store.updateMission(mission.id, { execution_llm_usd: Number((baseLlm + costUsd + reviewNow).toFixed(6)) });
    } catch { /* a lost checkpoint never stops a run */ }
  };
  const deadlineMs = Date.now() + AGENT_EXECUTION_WALL_MS;
  let output: Awaited<ReturnType<ModelDriver["run"]>>;
  const engineOn = deps.engine !== false && plan.stages.every((s) => s.engine !== undefined);
  if (engineOn) {
    // THE MODEL PLANNED, CODE EXECUTES: every stage has a recipe the plan check proved, so no model session is started at all (the only model call left is the small review of items the rule cannot decide)
    const tracked = trackRun();
    try {
      const outcome = await runEngine({ items, store, plan, missionId: mission.id, gateway, sandbox: deps.sandbox ?? ((code, inputs) => runInSandbox(code, inputs)), reviewer, addEvent: (e) => store.addEvent(mission.id, e), deadlineMs, shouldStop: () => tracked.reason.value, ...(deps.sleep ? { sleep: deps.sleep } : {}), log: deps.log });
      output = { llmCostUsd: 0, turns: 0, stop: outcome.aborted ?? "end" };
    } finally {
      untrackRun(tracked);
    }
  } else {
    // the model carries the mission out (a plan whose stages have no proven recipe), still through the one item store. A round that ends while matching items are still needed and a source has more is followed by another round.
    output = { llmCostUsd: 0, turns: 0, stop: "end", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    for (let round = 0; round <= AGENT_EXECUTION_CONTINUE_ROUNDS; round += 1) {
      state.terminal = false;
      const saved = Object.fromEntries(plan.stages.map((s) => [s.key, items.counts(s.key).accepted]));
      let r: Awaited<ReturnType<ModelDriver["run"]>>;
      try {
        r = await deps.driver.run({ phase: "execution", systemPrompt: loadSystemPrompt("execution", deps.systemPromptFile, { web: Boolean(web) }), userPrompt: round === 0 ? executionPrompt(mission, plan, calls, savedBefore) : continuationPrompt(mission, plan, await store.listCalls(mission.id), saved), tools: buildTools(ctx), state, model, maxTurns: AGENT_EXECUTION_MAX_TURNS, maxBudgetUsd: llmBudget, wallMs: AGENT_EXECUTION_WALL_MS, onUsage: checkpoint });
      } catch (e) {
        r = { llmCostUsd: 0, turns: 0, stop: "error", error: String((e as Error)?.message ?? e).slice(0, 300) } as Awaited<ReturnType<ModelDriver["run"]>>;
      }
      output = { ...r, llmCostUsd: output.llmCostUsd + r.llmCostUsd, turns: output.turns + r.turns, usage: sumUsage(output.usage, r.usage) };
      const short = plan.stages.some((s) => s.deliver && items.counts(s.key).accepted < s.planned_rows) && [...state.moreAvailable.values()].some(Boolean);
      if (r.stop !== "end" || r.error || state.finish || !short || Date.now() >= deadlineMs) break;
    }
  }
  // the model cost of this run = the agent's own run + the review calls it made (a requeued or killed run's cost is already on the mission through the checkpoints and the review state)
  const reviewAfter = await readReviewState(store, mission.id);
  const reviewSpent = Math.max(0, reviewAfter.spentUsd - reviewBefore.spentUsd);
  const llm = Number(baseLlm + output.llmCostUsd + reviewSpent);
  await recordTokens(deps, mission.id, 1, output.usage, { inputTokens: reviewAfter.inputTokens - reviewBefore.inputTokens, outputTokens: reviewAfter.outputTokens - reviewBefore.outputTokens, calls: reviewAfter.calls - reviewBefore.calls }, output.llmCostUsd + reviewSpent);
  if (output.stop === "memory" && !state.finish && await requeue(deps, mission, "approved", { execution_llm_usd: Number(llm.toFixed(6)), execution_treg_usd: Number(budget.spentUsd().toFixed(6)) }, "memory")) return;
  if (endedByRestart(output) && !state.finish && await requeue(deps, mission, "approved", { execution_llm_usd: Number(llm.toFixed(6)), execution_treg_usd: Number(budget.spentUsd().toFixed(6)) }, "restart")) return;

  // THE CONTACT FINDER STEPS (plan.contact_steps, contactFinders.ts): every delivered person is looked up for the e-mail and phone cells, within the job's call budget and the step's priced amount. It fills CELLS of persons already stored: no row is added, so the settlement below counts what it always counted.
  if (plan.contact_steps && plan.contact_steps.length > 0 && output.stop === "end" && !output.error) {
    try {
      const enrichment = await runContactEnrichment({ items, store, plan, missionId: mission.id, requestText: mission.request_text, gateway, addEvent: (e) => store.addEvent(mission.id, e), budget, deadlineMs: Math.max(deadlineMs, Date.now() + CONTACT_STEP_MIN_WALL_MS), log: deps.log });
      deps.log?.(`contact_steps ${mission.id} email=${enrichment.filled.email} phone=${enrichment.filled.phone} unverified=${enrichment.filled.unverified} looked=${enrichment.looked} skipped=${enrichment.skipped} spent=${enrichment.spentUsd.toFixed(6)} stopped=${enrichment.stopped ?? "no"}`);
    } catch (e) { deps.log?.(`contact_steps_failed ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 120)}`); /* a lookup that breaks never stops the settlement: the people are delivered with the cells as they are */ }
  }

  // THE ARABIC SPELLING OF THE DECISION MAKERS' NAMES (namesAr.ts, owner decision 3 of audit 2026-11): ONE small batched request for the whole mission, after the people are final. It fills a cell of each person's row (`name_ar`), decides no row, no count and no money; a failed or unusable answer leaves the English names.
  // Its cost comes from the API's own usage and is part of the mission's model cost (the plan's price carries its estimate, plan.ts NAMES_STEP_USD_PER_PERSON); it is NOT a charge: the settlement below is untouched.
  let namesCostUsd = 0;
  if (deps.reviewCall && output.stop === "end" && !output.error && plan.stages.some((s) => namesAreWritten(s))) {
    try {
      const names = await runNamesStep({ items, plan, call: deps.reviewCall, log: deps.log });
      namesCostUsd = names.costUsd;
      deps.log?.(`names ${mission.id} calls=${names.calls} named=${names.named} cost=${names.costUsd.toFixed(6)}`);
    } catch (e) { deps.log?.(`names_failed ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 120)}`); /* a name that cannot be spelled stays as the source gave it */ }
  }

  await settleExecution(deps, mission, plan, reserve, unit, { llm: Number(llm + namesCostUsd), executionTregUsd: budget.spentUsd(), summary: state.finish?.summary_ar ?? null, outputError: output.error ?? null, memory: items });
}

const sumUsage = (a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage => ({
  input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0), output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
  cache_read_input_tokens: (a?.cache_read_input_tokens ?? 0) + (b?.cache_read_input_tokens ?? 0), cache_creation_input_tokens: (a?.cache_creation_input_tokens ?? 0) + (b?.cache_creation_input_tokens ?? 0),
});

/**
 * ENDS AN EXECUTION FROM THE FILE. The settlement is built backwards from what the customer receives: the item store's log is read FRESH from storage (never from a copy in memory), the files are built from it, PUBLISHED, and READ BACK;
 * the number of items in the file the customer will download is the ONE number: it is the delivered count, the charge basis (ceil(file count x unit price), never above the reserve, the rest released, through the existing money
 * functions), the count in the result event, the notice, the e-mail and the summary sheet. If any other number (the writer's memory, the rows built) disagrees with the file, the mission is charged by the file and flagged for the admin;
 * the customer is never shown a number that is not in the file. Used by the normal end of a run and by every recovery that ends a mission (a run that failed too many times, a worker that restarted too many times).
 */
async function settleExecution(deps: RunnerDeps, mission: MissionRecord, plan: PricedPlan, reserve: number, unit: number, a: { llm: number; executionTregUsd: number; summary: string | null; outputError: string | null; /** The writer's memory of the run: compared with the log, never used to settle. */ memory?: ItemStore }): Promise<void> {
  const { store } = deps;
  const fresh = (await store.getMission(mission.id)) ?? mission;
  const llm = a.llm;
  const jobId = mission.job_id;
  if (!jobId) throw new Error("the mission has no job");
  const spent = Number((fresh.planning_treg_usd ?? 0) + a.executionTregUsd);
  // the log, read fresh: the listing then every segment (an unreadable segment throws, so the run is put back and retried instead of settling on a gap)
  const log = await ItemStore.open(store, mission.id, { legacyStages: plan.stages.map((s) => s.key) });
  const snap = log.snapshotOfMemory();
  const flags: string[] = [];
  const rowsByStage: Record<string, Array<Record<string, unknown>>> = {};
  for (const s of plan.stages) rowsByStage[s.key] = snap.acceptedRows(s.key, s.planned_rows);
  const builtCount = plan.stages.filter((s) => s.deliver).reduce((n, s) => n + rowsByStage[s.key].length, 0);
  if (a.memory) for (const s of plan.stages) if (a.memory.counts(s.key).accepted !== snap.counts(s.key).accepted) flags.push("memory_differs_from_store");

  // WHAT WAS LEFT OUT goes to the admin only (a CSV in the mission's own folder, never in the customer's files), with the report of the check
  const checked = await recordChecks(deps, mission.id, plan, store, snap);
  await mirrorLegacyFiles(log, store, plan);
  const noun = itemNounOfPlan(plan);

  let resultPath: string | null = null;
  let files: Array<{ name: string; path: string; kind: string }> = [];
  let fileCount = 0;
  /** The items of each delivered stage IN THE FILE (by sheet), for the tracker's final numbers. */
  let fileByStage: Record<string, number> | null = null;
  /** Rows whose parent-describing value was replaced by their own parent's before the file was written (admin only). */
  let parentFixedRows = 0;
  if (builtCount > 0) {
    try {
      const built = await buildMissionFiles(plan, rowsByStage, missionFactsOf({ requestText: mission.request_text, plan, snap, reviewStop: checked.stop }), companyMailboxesOf(plan, snap));
      if (built.parentFixes.length > 0) { parentFixedRows = built.parentFixes.reduce((n, f) => n + f.rows, 0); flags.push("parent_column_fixed"); deps.log?.(`parent_column_fixed ${mission.id} ${built.parentFixes.map((f) => `${f.stage_key}.${f.column}<-${f.parent_field}x${f.rows}`).join(",")}`); }
      const published = await store.publishResult({ missionId: mission.id, userId: mission.user_id, jobId, xlsx: built.xlsx, csv: built.csv });
      resultPath = published.resultPath;
      // READ BACK what the customer will download, and count it from the file itself
      const stored = await store.getFileBytes(mission.id, "result/result.xlsx").catch(() => null);
      let sheets = stored ? await countWorkbookSheets(stored) : null;
      if (sheets === null) { sheets = await countWorkbookSheets(built.xlsx); flags.push("file_readback_unavailable"); }
      if (sheets === null) throw new Error("the built file could not be read");
      fileCount = sheets.reduce((n, x) => n + x, 0);
      // the sheets are the delivered stages that have items, in plan order: each stage's own count in the file
      // (the replies are rows of their comments' sheet, so a replies stage has no sheet: its count is the rows it delivered, and its comments' sheet count is the sheet less those)
      const withSheet = plan.stages.filter((s) => s.deliver && s.replies_of === undefined && rowsByStage[s.key].length > 0);
      if (withSheet.length === sheets.length) {
        const repliesOf = (key: string): number => plan.stages.filter((x) => x.replies_of === key && x.deliver).reduce((n, x) => n + rowsByStage[x.key].length, 0);
        fileByStage = { ...Object.fromEntries(withSheet.map((s, i) => [s.key, Math.max(0, sheets![i] - repliesOf(s.key))])), ...Object.fromEntries(plan.stages.filter((x) => x.replies_of !== undefined && x.deliver).map((x) => [x.key, rowsByStage[x.key].length])) };
      }
      // the name the customer's download carries, built from the mission: what + count + date in Arabic («تغريدات عن محمد صلاح - ٣٠٠ - ٢٨ أكتوبر ٢٠٢٦»)
      const title = missionFileTitleAr({ plan, requestText: mission.request_text, delivered: Math.min(fileCount, plan.price.deliveredRows), date: new Date() });
      files = published.files.map((f) => ({ ...f, download_name: `${title}.${f.kind}` }));
    } catch (e) {
      await settleMission(deps.client, { jobId, deliveredUnits: 0, unitPricePoints: unit, reservedPoints: reserve, costUsd: spent, resultPath: null, releaseReason: "تعذّر حفظ ملفات النتيجة، فعاد الحجز المؤقت كاملًا." });
      await store.updateMission(mission.id, { status: "failed", error: `files: ${String((e as Error)?.message ?? e).slice(0, 200)}`, execution_llm_usd: Number(llm.toFixed(6)), charged_points: 0, delivered_units: 0, ...clear });
      await store.addEvent(mission.id, { kind: "result", message_ar: "تعذّر حفظ ملفات النتائج؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد." });
      await tell(deps, mission, jobId, "failed", { delivered: 0, planned: plan.price.deliveredRows, chargedPoints: 0, releasedPoints: reserve, reservedPoints: reserve, noun: noun.singular, hasJob: true });
      return;
    }
    if (fileCount !== builtCount) flags.push("file_differs_from_store");
  }
  // THE ONE NUMBER: the items in the file
  const delivered = Math.min(fileCount, plan.price.deliveredRows);
  if (fileCount > plan.price.deliveredRows) flags.push("file_over_the_volume_sold");
  const settled = await settleMission(deps.client, { jobId, deliveredUnits: delivered, unitPricePoints: unit, reservedPoints: reserve, costUsd: spent, resultPath, releaseReason: "لم يُسلَّم شيء من هذه المهمة، فعاد الحجز المؤقت كاملًا." });
  if (!settled.ok) {
    await store.updateMission(mission.id, { status: "failed", error: `settlement ${settled.code}: ${settled.detail}`, execution_llm_usd: Number(llm.toFixed(6)), ...clear });
    await store.addEvent(mission.id, { kind: "result", message_ar: "تعذّرت التسوية الآلية للمهمة؛ راجع المشرف ولم يُخصم رصيد إضافي." });
    return;
  }
  if (flags.length > 0) {
    await store.addEvent(mission.id, { kind: "call", message_ar: "علامة داخلية للمشرف: أرقام المهمة لا تتطابق تمامًا.", counts: { adm_flag: 1, adm_store: builtCount, adm_file: fileCount, adm_memory: a.memory ? plan.stages.filter((s) => s.deliver).reduce((n, s) => n + a.memory!.counts(s.key).accepted, 0) : -1, ...(parentFixedRows > 0 ? { adm_parent_fixed: parentFixedRows } : {}) } });
    deps.log?.(`settle_flags ${mission.id} ${flags.join(",")}`);
  }
  // ONE SOURCE OF TRUTH for the numbers: the counts and the money are stated by code, from the count of the file and the real settlement; the stored summary is the model's note (kept only when it has no number in it, so it can
  // never disagree with the count) or, when no model carried the mission out, a sentence built here; for a shortfall, the honest reason from the stop reason the run RECORDED (never a number, never «صف» or «سجل»)
  // THE TARGET is what the customer approved and what the charge is settled against; THE REQUEST is what they asked for (the same number unless the model proposed fewer, with a reason the card showed): a delivery below the request is never «complete»
  // THE REPLIES COME IN ADDITION (replies.ts): the customer's number counts the videos and the top-level comments; the replies are an estimate bought on top, so a delivery is complete or partial by the top-level rows alone (fewer replies than estimated is never a shortfall)
  const tl = topLevelFactsOf(plan, Object.fromEntries(plan.stages.map((s) => [s.key, rowsByStage[s.key].length])));
  const deliveredTop = Math.max(0, delivered - tl.repliesDelivered);
  const target = plan.price.deliveredRows - tl.repliesPlanned;
  const requested = requestedRowsOf(plan) - tl.repliesPlanned;
  const internalStage = delivered <= 0 ? plan.stages.find((s) => snap.stage(s.key).stop === "internal_error") : undefined;
  if (internalStage) flags.push("engine_zero_ingest");
  // THE MODEL REVIEW COULD NOT ANSWER AND NOTHING WAS DELIVERED: items were found and are still waiting for a verdict that never came. That is OUR failure (live, 2026-10-31: 50 companies pending, all six review answers unusable, and the customer was told no
  // source serves the request). Failed, flagged for the admin with the first words of the unusable answer, told to the customer as ours; the hold is released whole as for any zero delivery.
  const reviewFailedOurs = !internalStage && delivered <= 0 && checked.stop === "failed" && checked.pending > 0;
  if (reviewFailedOurs) flags.push("review_failed");
  const ourFailure = Boolean(internalStage) || reviewFailedOurs;
  const note = a.summary && !HAS_NUMBER.test(a.summary) ? a.summary.trim() : "";
  const shortStage = plan.stages.find((s) => s.deliver && s.replies_of === undefined && snap.counts(s.key).accepted < s.planned_rows);
  // the reason is about the stage that fell short: the language rule only ever applies to a stage of top-level items (a child stage is delivered raw), and a child stage that fell short while its parents were read says so
  const parentOfShort = shortStage && shortStage.parent_key !== null ? plan.stages.find((p) => p.key === shortStage.parent_key) : undefined;
  const checkedForShort = {
    ...checked,
    // THE SHORT STAGE'S OWN waiting items (live A1/A2: ten surplus companies a review never needed made the PEOPLE stage's shortfall «the review ran out»)
    pending: shortStage ? snap.counts(shortStage.key).pending : checked.pending,
    languageLeftOut: shortStage && shortStage.parent_key === null ? snap.counts(shortStage.key).excludedByReason.filter_language ?? 0 : 0,
    childShare: shortStage && parentOfShort && parentsBelowShare(plan, shortStage.key, rowsByStage) > 0 ? childShortfallClauseAr(itemNounOf(parentOfShort.title_ar).singular, itemNounOf(parentOfShort.title_ar).plural, itemNounOf(shortStage.title_ar).plural) : null,
  };
  // NOTHING DELIVERED: the reason is stated from what the run recorded for the delivered stages (found, left out per reason, waiting for a review, why it stopped), never from the model's note and never a guess
  const deliveredStages = plan.stages.filter((s) => s.deliver);
  const zeroFacts: ZeroDeliveryFacts = {
    found: deliveredStages.reduce((n, s) => n + snap.counts(s.key).new, 0),
    excludedByReason: deliveredStages.reduce<Record<string, number>>((acc, s) => { for (const [k, n] of Object.entries(snap.counts(s.key).excludedByReason)) acc[k] = (acc[k] ?? 0) + (n ?? 0); return acc; }, {}),
    pending: deliveredStages.reduce((n, s) => n + snap.counts(s.key).pending, 0), reviewStop: checked.stop, stop: deliveredStages.length > 0 ? snap.stage(deliveredStages[0].key).stop : null,
  };
  // WHAT THE SHORT STAGE FOUND AND LEFT OUT, from its recorded counts, when our own row rules left out what the source gave (never «the source gave no more» for rows it did give)
  const shortCounts = shortStage ? snap.counts(shortStage.key) : null;
  const shortTruth = shortStage && shortCounts ? stageTruthBodyAr({ found: shortCounts.found, duplicates: shortCounts.duplicates, delivered: shortCounts.accepted, excludedByReason: shortCounts.excludedByReason as Record<string, number>, pending: shortCounts.pending, reviewStop: checked.stop, stop: snap.stage(shortStage.key).stop, people: isPeopleStage(shortStage), noun: itemNounOf(shortStage.title_ar) }) : null;
  const shortClause = shortTruth ? `إذ ${shortTruth}` : shortfallClauseAr(shortStage ? snap.stage(shortStage.key).stop : null, checkedForShort);
  const reason = ourFailure ? INTERNAL_FAILURE_AR
    : delivered > 0 && deliveredTop < target ? (shortTruth ? `لم يكتمل العدد المطلوب ${shortClause}، ولم يُخصم إلا مقابل ما سُلّم.` : shortfallFromStopAr(shortStage ? snap.stage(shortStage.key).stop : null, checkedForShort))
    : delivered > 0 && deliveredTop < requested ? loweredTargetAr(plan)
    : delivered <= 0 ? zeroDeliveryReasonAr(zeroFacts) : "";
  const summary = (ourFailure ? reason : [note, reason].filter(Boolean).join(" ")).slice(0, 1100);
  const mismatch = settled.kind === "settled" && !settled.matchesExpectation ? `charge ${settled.chargedPoints} differs from the expected ${settled.expectedChargedPoints}` : null;
  const unusableWords = checked.lastUnusable ? checked.lastUnusable.replace(/\s+/g, " ").slice(0, 120) : "";
  const adminFlag = flags.length > 0 ? `admin: ${[...new Set(flags)].join(", ")}${internalStage ? ` stage=${internalStage.key} source_rows=${snap.stage(internalStage.key).sourceRows}` : ""}${reviewFailedOurs ? ` pending=${checked.pending} review_failed_calls=${checked.failedCalls} unusable="${unusableWords}"` : ""}` : null;
  await store.updateMission(mission.id, {
    status: ourFailure ? "failed" : delivered > 0 ? "completed" : "unserved", delivered_units: delivered, charged_points: settled.chargedPoints, summary_ar: summary || null, files: files.length ? files : null,
    execution_llm_usd: Number(llm.toFixed(6)), execution_treg_usd: Number(a.executionTregUsd.toFixed(6)), error: ourFailure ? adminFlag : mismatch ?? a.outputError ?? adminFlag, ...clear,
  });
  if (internalStage) await store.addEvent(mission.id, { kind: "call", message_ar: "علامة داخلية للمشرف: أعطى المصدر عناصر ولم يُحفظ أي منها.", counts: { adm_flag: 1, adm_store: 0, adm_file: 0, adm_source_rows: snap.stage(internalStage.key).sourceRows } });
  if (reviewFailedOurs) await store.addEvent(mission.id, { kind: "call", message_ar: "علامة داخلية للمشرف: تعذّرت مراجعة العناصر آليًا فلم يُسلَّم شيء.", counts: { adm_flag: 1, adm_pending: checked.pending, adm_review_failed_calls: checked.failedCalls } });
  // the rows of a stage as the customer receives them: a delivered stage's count in the FILE (its own sheet); a stage that is not delivered (an intermediate one) keeps the items saved
  const stageRowsOf = (s: PricedPlan["stages"][number]): number => (s.deliver ? (fileByStage ? fileByStage[s.key] ?? 0 : plan.stages.filter((x) => x.deliver).length === 1 ? delivered : rowsByStage[s.key].length) : rowsByStage[s.key].length);
  await store.addEvent(mission.id, { kind: "result", message_ar: summary || (delivered > 0 ? "اكتملت المهمة." : "لم يُسلَّم أي شيء."), counts: { delivered, charged_points: settled.chargedPoints, ...Object.fromEntries(plan.stages.map((s, i) => [`stage_${i + 1}_rows`, stageRowsOf(s)])), ...parentCountsOf(plan, rowsByStage) } });
  const noticeKind: MissionNoticeKind = ourFailure ? "failed" : delivered <= 0 ? "unserved" : deliveredTop < requested ? "partial" : "completed";
  await tell(deps, mission, jobId, noticeKind, { delivered, planned: deliveryDenominatorOf(deliveredTop, cardTotalOf(plan) - tl.repliesPlanned, requested) + tl.repliesDelivered, chargedPoints: settled.chargedPoints, releasedPoints: reserve, reservedPoints: reserve, noun: noun.singular, hasJob: true, ...(ourFailure ? { cause: "internal" as const } : delivered <= 0 ? { cause: "empty" as const } : {}), ...(delivered > 0 && deliveredTop < target ? { shortfallClauseAr: shortClause } : delivered > 0 && deliveredTop < requested ? { shortfallClauseAr: loweredTargetClauseAr(plan) } : {}) });
}

/** What the customer is told when the source gave items and our own mapping stored none: it was OUR failure, never «nothing was found». No number: the money line says the rest. */
export const INTERNAL_FAILURE_AR = "تعذّر تنفيذ طلبك بسبب خلل من جانبنا، وليس لأن المصدر خالٍ من النتائج. لم يُخصم منك شيء، وأُبلغ فريقنا بالأمر ليراجعه.";
const loweredTargetClauseAr = (plan: PricedPlan): string => (plan.quantity?.reason_ar ? `لأن ${plan.quantity.reason_ar.replace(/[.،\s]+$/, "")}` : "لأن الخطة التي اعتمدتها كانت بعدد أقل من المطلوب");
/** The sentence of a delivery that met the approved target when the target was lower than the request. */
export const loweredTargetAr = (plan: PricedPlan): string => `سُلّم العدد الذي اعتمدته في الخطة، وهو أقل مما طلبت ${loweredTargetClauseAr(plan)}.`;

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
      await settleMission(deps.client, { jobId: fresh.job_id, deliveredUnits: 0, unitPricePoints: unit, reservedPoints: reserve, costUsd: Number(fresh.planning_treg_usd ?? 0) + Number(fresh.execution_treg_usd ?? 0), resultPath: null, releaseReason: "تعذّر إكمال المهمة، فعاد الحجز المؤقت كاملًا." });
      await store.updateMission(mission.id, { status: "failed", error: message, charged_points: 0, delivered_units: 0, ...clear });
      await store.addEvent(mission.id, { kind: "result", message_ar: "تعذّر إكمال المهمة؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد." });
      await tell(deps, fresh, fresh.job_id, "failed", { delivered: 0, planned: plan.price.deliveredRows, chargedPoints: 0, releasedPoints: reserve, reservedPoints: reserve, noun: itemNounOfPlan(plan).singular, hasJob: true });
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
