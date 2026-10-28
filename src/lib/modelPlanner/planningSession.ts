import { PLANNING_MAX_TURNS, PLANNING_MAX_WALL_MS, PLANNING_MODEL_BUDGET_USD, PLANNING_SESSION_LEASE_MS, PLANNING_SESSION_STALE_MS, PLANNING_STEP_DEADLINE_MS, PLANNING_STEP_SOFT_MS } from "./constants";
import { completePlannerTurn, preparePlannerTurn, type ModelPlannerConfig, type ModelPlannerTurn, type ModelPlannerTurnArgs } from "./chatTurn";
import { createPlannerRun, type PlannerOutcome, type PlannerSnapshot } from "./planner";
import { persistPlannedAnswer, shapePlannedAnswer, type ShapedPlannedAnswer } from "./plannedAnswer";
import { addUsage, emptyUsage, plannerCostUsd, type PlannerUsage } from "./transport";

/**
 * A PLANNING SESSION: the planning loop of one chat request kept in the database between steps, so a mission that needs several samples and model turns is never held inside one HTTP request
 * (the Hobby function limit is 60 s). A request creates a session; each step is ONE model call or ONE source call (the loop's own step) and saves the loop's state; the session resumes on
 * the next call: the page's next step, or the background driver (/api/cron/drive) when the page has gone. The customer's panel reads the planner's events as they are written.
 *
 * The table is `planning_sessions` (docs/proposals/agent-loop/07_planning_sessions.sql, NOT APPLIED). Without it `startPlanningSession` answers `table_missing` and the chat plans in one request, as before.
 */
export const PLANNING_SESSIONS_TABLE = "planning_sessions";

export interface SessionRequest {
  message: string;
  /** The conversation so far, reduced to what planning reads: who spoke, what was said, and whether the message carried a plan card. */
  messagesContext: Array<{ role: string; content: string; quote?: true }>;
  guest: boolean;
  userBalance: number;
}

export interface SessionResult { response: Record<string, unknown>; outputType: string }

export interface PlanningSession {
  id: string;
  user_id: string;
  conversation_id: string;
  user_msg_id: string;
  assistant_msg_id: string;
  status: "running" | "done" | "failed";
  version: number;
  lease_until: string | null;
  request: SessionRequest;
  state: PlannerSnapshot | null;
  result: SessionResult | null;
  steps: number;
  errors: number;
  created_at: string;
  updated_at: string;
}

export const sessionRequestOf = (args: { message: string; messagesContext: ReadonlyArray<{ role: string; content?: string; quote?: unknown }>; guest?: boolean; userBalance: number }): SessionRequest => ({
  message: String(args.message ?? ""),
  messagesContext: args.messagesContext.slice(-24).map((m) => ({ role: String(m.role), content: String(m.content ?? "").slice(0, 1200), ...(m.quote ? { quote: true as const } : {}) })),
  guest: Boolean(args.guest),
  userBalance: Number(args.userBalance) || 0,
});

export function turnArgsOf(session: PlanningSession, config: ModelPlannerConfig, tables: any): ModelPlannerTurnArgs {
  return { config, tables, userId: session.user_id, conversationId: session.conversation_id, userBalance: session.request.userBalance, message: session.request.message, messagesContext: session.request.messagesContext, guest: session.request.guest, requestId: session.id };
}

export type StartResult = { ok: true; session: PlanningSession } | { ok: false; reason: "table_missing" };

export async function startPlanningSession(client: any, init: { id: string; userId: string; conversationId: string; userMsgId: string; assistantMsgId: string; request: SessionRequest; now?: Date }): Promise<StartResult> {
  if (typeof client?.from !== "function") return { ok: false, reason: "table_missing" };
  const at = (init.now ?? new Date()).toISOString();
  const row: PlanningSession = { id: init.id, user_id: init.userId, conversation_id: init.conversationId, user_msg_id: init.userMsgId, assistant_msg_id: init.assistantMsgId, status: "running", version: 0, lease_until: null, request: init.request, state: null, result: null, steps: 0, errors: 0, created_at: at, updated_at: at };
  try {
    const { error } = await client.from(PLANNING_SESSIONS_TABLE).insert(row);
    if (error) return { ok: false, reason: "table_missing" };
  } catch { return { ok: false, reason: "table_missing" }; }
  return { ok: true, session: row };
}

export async function loadPlanningSession(client: any, id: string): Promise<PlanningSession | null> {
  if (typeof client?.from !== "function") return null;
  try {
    const { data, error } = await client.from(PLANNING_SESSIONS_TABLE).select("*").eq("id", id).maybeSingle();
    return error || !data ? null : (data as PlanningSession);
  } catch { return null; }
}

/** The running sessions nobody has stepped for PLANNING_SESSION_STALE_MS (the page was closed or the step died): the background driver continues them. Oldest first. */
export async function staleRunningSessions(client: any, nowMs: number, limit = 2): Promise<PlanningSession[]> {
  if (typeof client?.from !== "function") return [];
  try {
    const { data, error } = await client.from(PLANNING_SESSIONS_TABLE).select("*").eq("status", "running").lt("updated_at", new Date(nowMs - PLANNING_SESSION_STALE_MS).toISOString()).order("updated_at", { ascending: true }).limit(limit);
    if (error || !Array.isArray(data)) return [];
    return (data as PlanningSession[]).filter((s) => !s.lease_until || Date.parse(s.lease_until) < nowMs);
  } catch { return []; }
}

/** Takes the session for one step: an optimistic lock on `version`, so two callers (the page and the driver) never run the same step. Null when someone else holds it. */
async function lease(client: any, session: PlanningSession, nowMs: number): Promise<PlanningSession | null> {
  if (session.lease_until && Date.parse(session.lease_until) > nowMs) return null;
  const next = { version: session.version + 1, lease_until: new Date(nowMs + PLANNING_SESSION_LEASE_MS).toISOString() };
  try {
    const { data, error } = await client.from(PLANNING_SESSIONS_TABLE).update(next).eq("id", session.id).eq("version", session.version).select("id");
    if (error || !Array.isArray(data) || data.length === 0) return null;
  } catch { return null; }
  return { ...session, ...next };
}

const save = async (client: any, id: string, patch: Record<string, unknown>): Promise<void> => {
  try { await client.from(PLANNING_SESSIONS_TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id); } catch { /* the next step saves again */ }
};

export const subtractUsage = (a: PlannerUsage, b: PlannerUsage): PlannerUsage => ({ inputTokens: Math.max(0, a.inputTokens - b.inputTokens), outputTokens: Math.max(0, a.outputTokens - b.outputTokens), cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens), cacheWriteTokens: Math.max(0, a.cacheWriteTokens - b.cacheWriteTokens) });

export interface AdvanceOptions {
  /** The database client the session lives in. */
  client: any;
  /** The chat handler's own database (messages, quotes). */
  tables: any;
  config: ModelPlannerConfig;
  session: PlanningSession;
  now?: () => number;
  /** When this invocation began (the chat request's start, for the first step). */
  startedAtMs?: number;
  /** A step that calls the model or a source is not started this long after `startedAtMs` (default PLANNING_STEP_SOFT_MS). */
  softMs?: number;
  /** The invocation's own deadline (ms after `startedAtMs`, default PLANNING_STEP_DEADLINE_MS). */
  deadlineMs?: number;
}

export type AdvanceResult =
  | { status: "running"; session: PlanningSession; usageDelta: PlannerUsage; steps: number }
  | { status: "done"; session: PlanningSession; planned: ModelPlannerTurn; shaped: ShapedPlannedAnswer; usageDelta: PlannerUsage; usage: PlannerUsage; steps: number }
  | { status: "busy" | "finished"; session: PlanningSession; usageDelta: PlannerUsage; steps: number };

/**
 * Runs steps of the session until the invocation's time is spent (a step that calls the model or a source is not started after `softMs`) or the planning ends. The state is saved after every
 * heavy step and at the end. When the planning ends the plan becomes a quote (or the customer gets the one question or sentence), the answer is saved in the conversation, and the session is done.
 */
export async function advancePlanningSession(opts: AdvanceOptions): Promise<AdvanceResult> {
  const { client, tables, config } = opts;
  const now = opts.now ?? (() => Date.now());
  const none = emptyUsage();
  if (opts.session.status !== "running") return { status: "finished", session: opts.session, usageDelta: none, steps: 0 };
  const leased = await lease(client, opts.session, now());
  if (!leased) return { status: "busy", session: opts.session, usageDelta: none, steps: 0 };
  let session = leased;
  const startedAt = opts.startedAtMs ?? now();
  const softMs = opts.softMs ?? PLANNING_STEP_SOFT_MS;
  const deadlineAt = startedAt + (opts.deadlineMs ?? PLANNING_STEP_DEADLINE_MS);
  const args = turnArgsOf(session, config, tables);
  const prepared = await preparePlannerTurn(args);
  const run = createPlannerRun({ ...prepared.input, deadlineAtMs: deadlineAt, maxTurns: PLANNING_MAX_TURNS, budget: { maxModelUsd: PLANNING_MODEL_BUDGET_USD }, retryModelErrors: true }, session.state ?? undefined);
  const usageBefore = session.state?.usage ?? none;
  let outcome: PlannerOutcome | null = null;
  let steps = 0;
  let errors = session.errors;
  try {
    while (!outcome) {
      if (now() - Date.parse(session.created_at) > PLANNING_MAX_WALL_MS) { outcome = run.exhaust("the planning time budget was used"); break; }
      const heavy = run.nextIsHeavy();
      if (heavy && now() - startedAt > softMs) break;
      if (now() >= deadlineAt - 2_000) break;
      outcome = await run.step();
      steps += 1;
      if (!outcome && heavy) await save(client, session.id, { state: run.snapshot(), steps: session.steps + steps });
    }
    errors = 0;
  } catch (err) {
    errors += 1;
    console.warn(JSON.stringify({ tag: "planning_session_step_failed", id: session.id, errors, message: String((err as Error)?.message ?? "").slice(0, 120) }));
    if (errors >= 3) { outcome = run.exhaust("the planning step failed three times"); errors = 0; }
  }
  const usage = run.usage();
  const usageDelta = subtractUsage(usage, usageBefore);
  if (!outcome) {
    await prepared.flushEvents();
    await save(client, session.id, { state: run.snapshot(), steps: session.steps + steps, errors, lease_until: null });
    session = { ...session, steps: session.steps + steps, errors, lease_until: null, state: run.snapshot() };
    return { status: "running", session, usageDelta, steps };
  }
  const planned = await completePlannerTurn(args, prepared, outcome);
  const shaped = shapePlannedAnswer(planned);
  const sb = tables && typeof tables.from === "function" ? tables : null;
  await persistPlannedAnswer({ sb, tables, assistantMsgId: session.assistant_msg_id, userMsgId: session.user_msg_id }, planned, shaped);
  const total = addUsage(emptyUsage(), usage);
  const tokensIn = total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens;
  const result: SessionResult = { outputType: shaped.outputType, response: { ...shaped.response, conversationId: session.conversation_id, messageId: session.assistant_msg_id, role: "assistant", tokensUsed: { input: tokensIn, output: total.outputTokens } } };
  await save(client, session.id, { status: "done", result, state: null, steps: session.steps + steps, errors: 0, lease_until: null });
  session = { ...session, status: "done", result, state: null, steps: session.steps + steps, lease_until: null };
  return { status: "done", session, planned, shaped, usageDelta, usage: total, steps };
}

/** What the page needs after a step: still running (call again), or done with the same answer the chat route gives. */
export function stepAnswer(session: PlanningSession): { status: "running" | "done" | "failed"; response?: Record<string, unknown> } {
  if (session.status === "done" && session.result) return { status: "done", response: session.result.response };
  return { status: session.status === "failed" ? "failed" : "running" };
}

/** The planning model's own usage of one invocation, in the table every other model call is written to (bookkeeping: never throws). */
export async function logPlanningUsage(client: any, userId: string, model: string, delta: PlannerUsage, latencyMs: number, reason: string): Promise<void> {
  if (delta.inputTokens + delta.outputTokens + delta.cacheReadTokens + delta.cacheWriteTokens <= 0 || typeof client?.from !== "function") return;
  try {
    await client.from("llm_usage").insert({ user_id: userId, tokens_in: delta.inputTokens + delta.cacheReadTokens + delta.cacheWriteTokens, tokens_out: delta.outputTokens, model, latency_ms: Math.max(0, latencyMs), reason, cost_usd: Number(plannerCostUsd(delta).toFixed(6)), created_at: new Date().toISOString() });
  } catch { /* bookkeeping */ }
}

/**
 * The background driver's share: continues the running sessions nobody has stepped for a while (the page was closed, or its step died), so the customer finds the plan card in the conversation
 * when they come back. At most `limit` sessions per call, inside the time the caller still has.
 */
export async function resumeStalePlanningSessions(opts: { client: any; tables: any; config: ModelPlannerConfig; nowMs?: number; limit?: number; budgetMs?: number }): Promise<{ considered: number; stepped: number; finished: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  const stale = await staleRunningSessions(opts.client, nowMs, opts.limit ?? 1);
  let stepped = 0;
  let finished = 0;
  for (const session of stale) {
    const started = Date.now();
    const adv = await advancePlanningSession({ client: opts.client, tables: opts.tables, config: opts.config, session, startedAtMs: started, deadlineMs: opts.budgetMs ?? PLANNING_STEP_DEADLINE_MS });
    if (adv.status === "busy" || adv.status === "finished") continue;
    stepped += 1;
    if (adv.status === "done") finished += 1;
    await logPlanningUsage(opts.client, session.user_id, opts.config.transport.model, adv.usageDelta, Date.now() - started, adv.status === "done" ? `planning_step_${adv.shaped.outputType}` : "planning_step");
  }
  return { considered: stale.length, stepped, finished };
}
