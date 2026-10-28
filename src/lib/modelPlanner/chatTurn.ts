import { PlanRefusalError } from "../capacityRefusal";
import { isChatControlMessage } from "../retryMessage";
import { resolveAccountAccess, PURPOSE_QUESTION_AR, PURPOSE_QUESTION_ID } from "../server/sensitiveAccess";
import type { TregCatalog } from "../treg/catalog";
import { EXPLORATION_TABLE, PLANNER_EVENT_ROW_ENDPOINT, PLANNER_TURN_ROW_ENDPOINT, type ExplorationDeps } from "./exploration";
import type { PlannerEvent } from "../missionView";
import { createModelPlanQuote } from "./planItem";
import { runPlanner, type PlannerOutcome } from "./planner";
import { loadRecipeForEndpoint } from "./recipes";
import { loadMeasuredAvgCallUsd } from "./measured";
import { createAnthropicTransport, type PlannerTransport } from "./transport";

/** What the chat handler needs to run the model planner for a turn. `transport` is the real provider transport in production and a recorded one in tests and replays. */
export interface ModelPlannerConfig {
  transport: PlannerTransport;
  catalog?: TregCatalog;
  today?: () => Date;
  /** Replaces the gateway call of `sample_call` (tests). */
  call?: ExplorationDeps["call"];
  /** The database client for the account's access, the exploration costs and the recipes (default: the handler's own; tests give an in-memory one). */
  client?: any;
}

export const defaultModelPlannerConfig = (): ModelPlannerConfig => ({ transport: createAnthropicTransport() });

export interface PriorMessage { role: string; content?: string; quote?: unknown }

/** The customer's own words for THIS request: their messages after the last plan card of the conversation (or all of them), the control buttons left out, the newest last. */
export function customerWordsOf(messages: ReadonlyArray<PriorMessage>, current: string): string[] {
  let from = 0;
  messages.forEach((m, i) => { if (m.role === "assistant" && m.quote) from = i + 1; });
  const words = messages.slice(from).filter((m) => m.role === "user").map((m) => String(m.content ?? "").trim()).filter((t) => t && !isChatControlMessage(t) && !t.startsWith("{"));
  const last = String(current ?? "").trim();
  if (last && !isChatControlMessage(last) && words[words.length - 1] !== last) words.push(last);
  return words.slice(-6);
}

/** The purpose of use: the customer's answer, when the question just before it was the purpose question. */
export function purposeFrom(messages: ReadonlyArray<PriorMessage>, current: string): string | null {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant || String(lastAssistant.content ?? "").trim() !== PURPOSE_QUESTION_AR) return null;
  const text = String(current ?? "").trim();
  return text && !text.startsWith("{") ? text.slice(0, 300) : null;
}

export interface ModelPlannerTurnArgs {
  config: ModelPlannerConfig;
  tables: any;
  userId: string;
  conversationId: string;
  userBalance: number;
  message: string;
  messagesContext: ReadonlyArray<PriorMessage>;
  /** A guest (no account yet): the plan is made and priced like anyone's, but no quote is saved and no card is shown: the guest is asked to sign up before approving, as on the old path. */
  guest?: boolean;
  /** The turn's own deadline (epoch ms). */
  deadlineAtMs?: number;
  requestId: string;
}

/** What a guest reads instead of the plan card (the same sentence as the old path). */
export const GUEST_SIGNUP_AR = "للاطلاع على خطة التنفيذ المكتملة وعرض السعر بالنقاط وبدء البحث، يرجى إنشاء حساب مجاني أو تسجيل الدخول.";

export type ModelPlannerTurn = (
  | { kind: "plan"; contentAr: string; planQuote: Record<string, unknown>; sensitive: boolean }
  | { kind: "message"; contentAr: string; reason: string; clarificationItems?: Array<Record<string, unknown>> }
) & { outcome: PlannerOutcome };

/** One chat turn of the model planner: runs the planning loop, then (for a plan) creates the quote with the shared pricing, and shapes the plan card data. */
export async function runModelPlannerTurn(args: ModelPlannerTurnArgs): Promise<ModelPlannerTurn> {
  const { config, tables } = args;
  const customerMessages = customerWordsOf(args.messagesContext, args.message);
  const purpose = purposeFrom(args.messagesContext, args.message);
  const customerRequest = customerMessages.filter((m) => m !== purpose).join(" ");
  const client = config.client ?? tables;
  const access = await resolveAccountAccess(client, args.userId);
  // what the planner is doing is written as it happens (one row per event, cost 0): the panel's planning steps are built from these rows, never from a separate text
  const pendingEvents: Array<Promise<unknown>> = [];
  const onEvent = (event: PlannerEvent) => {
    if (typeof client?.from !== "function") return;
    try {
      pendingEvents.push(Promise.resolve(client.from(EXPLORATION_TABLE).insert({
        request_id: args.requestId, user_id: args.userId, endpoint_id: PLANNER_EVENT_ROW_ENDPOINT, params_digest: event.kind === "understood" ? { ...event, request: customerRequest.slice(0, 300) } : event,
        cost_usd: 0, budget_usd: 0, rows_returned: event.rows ?? event.n ?? 0, duration_ms: null, refused_reason: null, created_at: new Date(event.at).toISOString(),
      })).then(() => undefined, () => undefined));
    } catch { /* the table is not there */ }
  };
  const outcome = await runPlanner({
    onEvent,
    transport: config.transport,
    customerMessages: purpose ? customerMessages.filter((m) => m !== purpose) : customerMessages,
    // the purpose question and its answer are part of the conversation the model sees
    history: purpose ? [{ role: "assistant", text: PURPOSE_QUESTION_AR }, { role: "user", text: purpose }] : undefined,
    access,
    purpose,
    today: config.today?.(),
    catalog: config.catalog,
    exploration: { client, requestId: args.requestId, userId: args.userId, ...(config.call ? { call: config.call } : {}) },
    loadRecipe: (id) => loadRecipeForEndpoint(client, id),
    loadMeasuredAvg: (id) => loadMeasuredAvgCallUsd(client, id),
    deadlineAtMs: args.deadlineAtMs,
  });

  await Promise.allSettled(pendingEvents);
  await recordPlannerTurnEnd(client, args, outcome, customerRequest);

  if (outcome.kind === "purpose_needed") {
    return { kind: "message", contentAr: outcome.messageAr, reason: "purpose_needed", outcome, clarificationItems: [{ id: PURPOSE_QUESTION_ID, text: PURPOSE_QUESTION_AR, question: PURPOSE_QUESTION_AR, type: "free", options: [], allowOther: false }] };
  }
  if (outcome.kind === "message") return { kind: "message", contentAr: outcome.messageAr, reason: outcome.reason, outcome };

  // a guest is shown what was understood and asked to sign up: no quote is saved for a guest, so nothing can be approved before sign-up
  if (args.guest) return { kind: "message", contentAr: `${outcome.plan.summaryAr}\n\n${GUEST_SIGNUP_AR}`, reason: "signup", outcome };

  try {
    const { quote, sampleRows } = await createModelPlanQuote({ tables, conversationId: args.conversationId, userId: args.userId, userBalance: args.userBalance, plan: outcome.plan, customerRequest, purpose });
    const planQuote: Record<string, unknown> = {
      quoteId: quote.quoteId,
      planHash: quote.planHash,
      summaryAr: quote.summaryAr,
      items: quote.items,
      targetVolumeMax: quote.targetVolumeMax,
      unitPricePoints: quote.unitPricePoints,
      expectedPoints: quote.expectedPoints,
      quotedPoints: quote.quotedPoints,
      isAffordable: quote.isAffordable,
      pointsCapConstrained: quote.pointsCapConstrained,
      requestedVolumeMax: quote.requestedVolumeMax,
      pointsCap: quote.pointsCap,
      userBalance: args.userBalance,
      downscaledOffer: quote.downscaledOffer,
      capacityConstrained: quote.capacityConstrained,
      outputFormats: quote.outputFormats,
      expiresAt: quote.expiresAt,
      understoodAr: quote.summaryAr,
      modelPlanned: true,
      ...(sampleRows ? { sampleRows } : {}),
    };
    return { kind: "plan", contentAr: quote.summaryAr, planQuote, sensitive: outcome.plan.sensitive, outcome };
  } catch (err) {
    if (err instanceof PlanRefusalError) return { kind: "message", contentAr: err.messageAr, reason: "refused", outcome };
    throw err;
  }
}

/** A turn that ends WITHOUT a plan is written as one row of exploration_calls (cost 0: it is not a call): the admin health line reads the last planner error from it. Best effort, never throws. */
async function recordPlannerTurnEnd(client: any, args: ModelPlannerTurnArgs, outcome: PlannerOutcome, requestText = ""): Promise<void> {
  if (outcome.kind === "plan" || (outcome.kind === "message" && (outcome.reason === "clarification" || outcome.reason === "restricted"))) return;
  if (typeof client?.from !== "function") return;
  try {
    const reason = outcome.kind === "message" ? outcome.reason : outcome.kind;
    const codes = outcome.failures.flat().map((i) => i.code).slice(0, 6).join(",");
    await client.from(EXPLORATION_TABLE).insert({
      request_id: args.requestId, user_id: args.userId, endpoint_id: PLANNER_TURN_ROW_ENDPOINT, params_digest: { turns: outcome.turns, stopReasons: outcome.stopReasons, request: requestText.slice(0, 300), modelUsd: Number(outcome.modelCostUsd.toFixed(6)), providerUsd: Number(outcome.explorationCostUsd.toFixed(6)), tried: outcome.attempts.slice(0, 8).map((a) => `${a.endpointId}=${a.outcome}`) },
      cost_usd: 0, budget_usd: 0, rows_returned: 0, duration_ms: null, refused_reason: `${reason}: ${outcome.endReason ?? ""}${codes ? ` [${codes}]` : ""}`.slice(0, 300),
    });
  } catch { /* the table is not there */ }
}
