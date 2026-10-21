import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";
import { notSupportedReplyAr, assessCoverage, WHAT_WE_CAN_DO_AR } from "../src/lib/requestCoverage";

async function send(message: string) {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  const model = vi.fn(async () => { throw new Error("the model must not be called"); });
  (handler as any).llm.executeTurn = model;
  await db.createRow({ tableId: "conversations", rowId: "conv_cov", data: { userId: "user_cov", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  const response: any = await handler.handleUserMessage({ userId: "user_cov", conversationId: "conv_cov", message, userBalance: 5000 });
  return { response, db, model };
}

describe("a request we do not sell is answered by code, kept in the unserved list, and never priced", () => {
  const DOLLAR_NEWS = "اسحب كل أخبار الدولار وأسعاره في السوق المصري من الجرايد الرسمية خلال آخر ٣ شهور";

  it("the dollar-news request: the plain answer with three things we can do, no plan, no model call", async () => {
    const { response, db, model } = await send(DOLLAR_NEWS);
    expect(response.outputType).toBe("answer_question");
    expect(response.contentAr).toBe(notSupportedReplyAr(assessCoverage(DOLLAR_NEWS)));
    for (const line of WHAT_WE_CAN_DO_AR) expect(response.contentAr).toContain(line);
    expect(response.contentAr).not.toMatch(/[A-Za-z]/);
    expect(response.planQuote).toBeUndefined();
    expect(model).not.toHaveBeenCalled();
    expect((db.store.get("quotes") || []).length).toBe(0);
  });

  it("it is logged in the unserved-requests list with the family and the customer's words", async () => {
    const { db } = await send(DOLLAR_NEWS);
    const rows = db.store.get("capability_requests") || [];
    expect(rows).toHaveLength(1);
    expect(String(rows[0].platform || rows[0].query)).toContain("news_articles");
    expect(String(rows[0].queryAr || rows[0].query)).toContain("أخبار الدولار");
  });

  it("private data is refused plainly and logged", async () => {
    const { response, db } = await send("هات الرسائل الخاصة لحساب فلان على فيسبوك");
    expect(response.contentAr).toContain("لا أستطيع جمع بيانات خاصة");
    expect((db.store.get("capability_requests") || []).length).toBe(1);
  });

  it("a request we sell is not turned away", async () => {
    const { response, db } = await send("٣٠ تعليق يوتيوب عن أخبار الدولار");
    expect(response.outputType).toBe("propose_plan");
    expect((db.store.get("capability_requests") || []).length).toBe(0);
  });

  it("a part we sell plus a part we do not: the plan is for what we sell and says what it leaves out", async () => {
    const { response } = await send("٣٠ تعليق تيك توك عن كرة القدم وكمان أخبار من الجرايد");
    expect(response.outputType).toBe("propose_plan");
    expect(response.contentAr).toContain("غير متاح حاليًا ولم يُسعَّر");
  });
});

describe("the plan card lists the parts: what is priced and what is left out", () => {
  it("a partly served request carries the priced part and the part not sold, with the reason", async () => {
    const { response } = await send("٣٠ تعليق تيك توك عن كرة القدم وكمان أخبار من الجرايد");
    const parts = response.planQuote.partsAr as Array<{ labelAr: string; included: boolean; reasonAr?: string }>;
    expect(parts.filter((p) => p.included)).toEqual([{ labelAr: "تيك توك", included: true }]);
    expect(parts.filter((p) => !p.included)).toHaveLength(1);
    expect(parts.find((p) => !p.included)!.reasonAr).toContain("لا نبيع هذا النوع");
    expect(parts.map((p) => `${p.labelAr} ${p.reasonAr ?? ""}`).join(" ")).not.toMatch(/[A-Za-z]/);
  });
  it("a fully served request has no parts block", async () => {
    const { response } = await send("٣٠ تعليق تيك توك عن كرة القدم");
    expect(response.planQuote.partsAr).toBeUndefined();
  });
});
