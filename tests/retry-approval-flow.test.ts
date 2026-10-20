import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";
import {
  APPROVAL_NEEDS_BUTTON_AR, hasPendingPlan, isChatControlMessage, isTypedApprovalMessage, RETRY_SAME_PLAN_MESSAGE, REVIEW_PLAN_MESSAGE,
} from "../src/lib/retryMessage";

const REQUEST = "عايز ٣٠ تعليق تيك توك عن كرة القدم في مصر";

async function session() {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  await db.createRow({ tableId: "conversations", rowId: "conv_retry", data: { userId: "user_retry", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  const send = (message: string) => handler.handleUserMessage({ userId: "user_retry", conversationId: "conv_retry", message, userBalance: 5000 });
  const quotesCount = () => (db.store.get("plans_quotes") || []).length;
  return { db, send, quotesCount };
}

describe("the retry button and the approval words are not part of the request", () => {
  it("recognizes the fixed messages and the typed approval, and nothing that asks for research", () => {
    expect(isChatControlMessage(RETRY_SAME_PLAN_MESSAGE)).toBe(true);
    expect(isChatControlMessage(REVIEW_PLAN_MESSAGE)).toBe(true);
    for (const text of ["أوافق وابدأ البحث", "أوافق وابدأ البحث.", "  موافق ", "ابدأ", "ابدا البحث", "نعم ابدأ", "Ok"]) expect(isTypedApprovalMessage(text), text).toBe(true);
    for (const text of ["عايز ٣٠ تعليق تيك توك عن كرة القدم", "أوافق على الخطة المخفضة حتى ٢٠ سجل", "ابدأ بالشركات في الرياض", "", "ماذا يعني الموافقة؟"]) expect(isChatControlMessage(text), text).toBe(false);
  });

  it("the retry request prices the SAME topic: the instruction text never leaks into it", async () => {
    const { send } = await session();
    const first = await send(REQUEST);
    expect(first.outputType).toBe("propose_plan");
    expect(first.planQuote.items[0].params.query).toBe("كرة القدم");
    const retry = await send(RETRY_SAME_PLAN_MESSAGE);
    expect(retry.outputType).toBe("propose_plan");
    expect(retry.planQuote.items[0].params.query).toBe("كرة القدم");
    expect(JSON.stringify(retry.planQuote)).not.toMatch(/أعد المحاولة|اعرض عرض|بنفس الخطة/);
    expect(retry.contentAr).not.toMatch(/أعد المحاولة|اعرض عرض|بنفس الخطة/);
    expect(retry.planQuote.items[0].unitPricePoints).toBe(first.planQuote.items[0].unitPricePoints);
  });

  it("the review button also leaves the topic alone", async () => {
    const { send } = await session();
    await send(REQUEST);
    const review = await send(REVIEW_PLAN_MESSAGE);
    expect(review.outputType).toBe("propose_plan");
    expect(review.planQuote.items[0].params.query).toBe("كرة القدم");
  });
});

describe("typed approval next to a waiting plan", () => {
  it("is answered with where to press, creates no second quote, and leaves the waiting quote usable", async () => {
    const { db, send, quotesCount } = await session();
    await send(REQUEST);
    const retry = await send(RETRY_SAME_PLAN_MESSAGE);
    const before = quotesCount();
    const statusBefore = (db.store.get("plans_quotes") || []).find((row: any) => (row.$id || row.id) === retry.planQuote.quoteId)?.status;
    const typed = await send("أوافق وابدأ البحث");
    expect(typed.outputType).toBe("answer_question");
    expect(typed.contentAr).toBe(APPROVAL_NEEDS_BUTTON_AR);
    expect(typed.contentAr).toContain("«أوافق وابدأ البحث»");
    expect(quotesCount()).toBe(before);
    const waiting = (db.store.get("plans_quotes") || []).find((row: any) => (row.$id || row.id) === retry.planQuote.quoteId);
    expect(waiting?.status).toBe(statusBefore);
    expect(waiting?.status).not.toBe("expired");
  });

  it("the plan can still be approved after the typed words: a new quote is not needed", async () => {
    const { send } = await session();
    const plan = await send(REQUEST);
    await send("موافق");
    const again = await send("أوافق وابدأ البحث");
    expect(again.outputType).toBe("answer_question");
    expect(plan.planQuote.quoteId).toBeTruthy();
  });

  it("a plan that was already accepted is not «waiting»: the word is not intercepted then", () => {
    expect(hasPendingPlan([{ role: "user", requestStatus: "quoted", requestQuoteId: "q1" }])).toBe(true);
    expect(hasPendingPlan([{ role: "user", requestStatus: "accepted", requestQuoteId: "q1" }, { role: "assistant" }, { role: "user", requestStatus: "planning", requestQuoteId: null }])).toBe(false);
    expect(hasPendingPlan([{ role: "user", requestStatus: "accepted", requestQuoteId: "q1" }, { role: "user", requestStatus: "quoted", requestQuoteId: "q2" }])).toBe(true);
    expect(hasPendingPlan([])).toBe(false);
  });
});
