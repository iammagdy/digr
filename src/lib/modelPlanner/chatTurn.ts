import { PlanRefusalError } from "../capacityRefusal";
import { isChatControlMessage } from "../retryMessage";
import { resolveAccountAccess, PURPOSE_QUESTION_AR, PURPOSE_QUESTION_ID } from "../server/sensitiveAccess";
import type { TregCatalog } from "../treg/catalog";
import type { ExplorationDeps } from "./exploration";
import { createModelPlanQuote } from "./planItem";
import { runPlanner, type PlannerOutcome } from "./planner";
import { loadRecipeForEndpoint } from "./recipes";
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
  /** The turn's own deadline (epoch ms). */
  deadlineAtMs?: number;
  requestId: string;
}

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
  const outcome = await runPlanner({
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
    deadlineAtMs: args.deadlineAtMs,
  });

  if (outcome.kind === "purpose_needed") {
    return { kind: "message", contentAr: outcome.messageAr, reason: "purpose_needed", outcome, clarificationItems: [{ id: PURPOSE_QUESTION_ID, text: PURPOSE_QUESTION_AR, question: PURPOSE_QUESTION_AR, type: "free", options: [], allowOther: false }] };
  }
  if (outcome.kind === "message") return { kind: "message", contentAr: outcome.messageAr, reason: outcome.reason, outcome };

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
