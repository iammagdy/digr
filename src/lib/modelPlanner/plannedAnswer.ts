import { resolveRequestAttemptStatus } from "../requestAttempt";
import type { ModelPlannerTurn } from "./chatTurn";

/**
 * What a finished planning turn becomes for the chat: the answer the page shows (the plan card, a question, or the one refusal sentence) and the two message rows it is saved in, so a
 * conversation that is opened later shows it. Shared by the one-request path of the chat handler and by the end of a planning session (a step of the page, or the background driver).
 */
export type PlannedOutputType = "propose_plan" | "refuse" | "answer_question";

export interface ShapedPlannedAnswer {
  outputType: PlannedOutputType;
  status: string | null;
  quote: any;
  response: {
    contentAr: string;
    outputType: PlannedOutputType;
    intent: "research";
    planQuote?: any;
    clarificationItems?: any[];
    clarificationQuestions?: string[];
    clarificationIntro?: string;
    refusalReason?: string;
  };
}

export function shapePlannedAnswer(planned: ModelPlannerTurn): ShapedPlannedAnswer {
  const isPlan = planned.kind === "plan";
  const refusal = !isPlan && (planned.reason === "refused" || planned.reason === "restricted" || planned.reason === "unavailable" || planned.reason === "no_model");
  const outputType: PlannedOutputType = isPlan ? "propose_plan" : refusal ? "refuse" : "answer_question";
  const clarificationItems = !isPlan ? (planned.clarificationItems as any[] | undefined) : undefined;
  const quote = isPlan ? (planned.planQuote as any) : null;
  const status = resolveRequestAttemptStatus({ intent: "research", outputType, hasQuote: isPlan });
  return {
    outputType, status, quote,
    response: {
      contentAr: planned.contentAr,
      outputType,
      intent: "research",
      ...(isPlan ? { planQuote: quote } : {}),
      ...(clarificationItems ? { clarificationItems, clarificationQuestions: clarificationItems.map((c: any) => c.text), clarificationIntro: planned.contentAr } : {}),
      ...(refusal ? { refusalReason: planned.contentAr } : {}),
    },
  };
}

/** Saves the answer in the assistant message and the request status in the customer's message. Never throws. */
export async function persistPlannedAnswer(ctx: { sb: any; tables: any; assistantMsgId: string; userMsgId: string }, planned: ModelPlannerTurn, shaped: ShapedPlannedAnswer): Promise<void> {
  const { sb, tables, assistantMsgId, userMsgId } = ctx;
  const quote = shaped.quote;
  const clarificationItems = shaped.response.clarificationItems;
  try {
    if (sb) {
      await Promise.all([
        sb.from("messages").update({ content_ar: planned.contentAr, clarification_items: clarificationItems ?? null, plan: quote ? { items: quote.items, summaryAr: quote.summaryAr } : null, quote }).eq("id", assistantMsgId),
        sb.from("messages").update({ request_status: shaped.status, request_quote_id: quote?.quoteId ?? null }).eq("id", userMsgId),
      ]);
    } else {
      await tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: planned.contentAr, status: "ready", ...(quote ? { planQuoteId: quote.quoteId } : {}) } });
      await tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: shaped.status, ...(quote ? { requestQuoteId: quote.quoteId } : {}) } });
    }
  } catch (persistError) {
    console.warn(`[chat:model_planner_persist_failed] ${String((persistError as Error)?.message ?? "").slice(0, 80)}`);
  }
}
