import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { setLastLlmFallbackReason } from "../src/functions/shared/llmClient";
import { MIN_MODEL_CALL_BUDGET_MS, TURN_BUDGET_MS, isPlanAnnouncementOnly } from "../src/functions/shared/turnGuards";
import { createChatDb } from "./helpers/chatSession";

const TWEETS = "هات ١٠ تغريدات عن كرة السلة";
const ANNOUNCE = "تمام، هجهز لك خطة لجمع التغريدات دلوقتي...";

function handlerWith(executeTurn: (...args: any[]) => any) {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  const calls = vi.fn(executeTurn);
  (handler as any).llm.executeTurn = calls;
  return { handler, calls, db };
}
const turn = (output: any) => ({ output, inputTokens: 900, outputTokens: 30, costUsd: 0.0008, model: "claude-haiku-5-5", promptVersion: "test" });
const send = (handler: ChatHandler, message: string) =>
  handler.handleUserMessage({ userId: "u_stall", message, userBalance: 5000 });

afterEach(() => { vi.restoreAllMocks(); setLastLlmFallbackReason(null); });

describe("2. a turn never ends on «هجهز خطة» without a plan or one concrete question", () => {
  it("recognises a reply that only announces a plan", () => {
    for (const text of [ANNOUNCE, "هجهز لك الخطة", "سأجهز عرض السعر الآن", "جارٍ تجهيز الخطة"]) expect(isPlanAnnouncementOnly(text), text).toBe(true);
    for (const text of ["", "أعددت لك خطة بسعر ٥٠ نقطة", "ما الفترة الزمنية؟", "كرة السلة موضوع ممتاز للبحث، وتغريدات إكس تناسبه تمامًا ويمكنني جمعها بعدة طرق مختلفة حسب ما تحتاجه من حجم وفترة زمنية ولغة ونوع حسابات وغير ذلك ".repeat(3)]) {
      expect(isPlanAnnouncementOnly(text), text).toBe(false);
    }
    expect(TURN_BUDGET_MS).toBeLessThan(55_000);
    expect(MIN_MODEL_CALL_BUDGET_MS).toBeGreaterThan(0);
  });

  it("an announcement-only reply is retried once, and when it repeats the plan is built in code", async () => {
    const { handler, calls } = handlerWith(async () => turn({ type: "answer_question", answerAr: ANNOUNCE }));
    const res = await send(handler, TWEETS);
    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote.items[0].capabilitySlug).toBe("social-x-posts");
    expect(res.planQuote.items[0].targetVolumeMax).toBe(10);
    expect(res.planQuote.items[0].params.query).toBe("كرة السلة");
    expect(res.contentAr).not.toContain("هجهز");
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("when the retry produces a plan, that plan is used", async () => {
    let n = 0;
    const { handler, calls } = handlerWith(async (opts: any) => {
      n++;
      if (n === 1) return turn({ type: "answer_question", answerAr: ANNOUNCE });
      return (handler as any).__real(opts);
    });
    (handler as any).__real = async () => turn({ type: "propose_plan", summaryAr: "تغريدات عن كرة السلة", capabilities: [{ capabilitySlug: "social-x-posts", params: { query: "كرة السلة" }, targetVolumeMax: 10 }], outputFormats: ["xlsx"] });
    const res = await send(handler, TWEETS);
    expect(res.outputType).toBe("propose_plan");
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("when the turn is already slow no further model call is started: one call, then code finishes the turn", async () => {
    let clock = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { handler, calls } = handlerWith(async () => { clock += 36_000; return turn({ type: "answer_question", answerAr: ANNOUNCE }); });
    const res = await send(handler, TWEETS);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote.items[0].capabilitySlug).toBe("social-x-posts");
  });

  it("a provider timeout keeps the honest Arabic answer: no plan from code, nothing held, the composer is free again", async () => {
    const { handler, calls } = handlerWith(async () => {
      setLastLlmFallbackReason("timeout");
      return turn({ type: "refuse", reasonAr: "المساعد غير متاح الآن، حاول لاحقًا (استغرقت الاستجابة وقتاً أطول من المعتاد)." });
    });
    const res = await send(handler, TWEETS);
    expect(res.outputType).toBe("refuse");
    expect(res.contentAr).toContain("المساعد غير متاح الآن");
    expect(res.planQuote).toBeUndefined();
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("an incomplete request that stalls gets ONE concrete question, never the announcement", async () => {
    const { handler } = handlerWith(async () => turn({ type: "answer_question", answerAr: ANNOUNCE }));
    const res = await send(handler, "عايز بيانات تيك توك");
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationQuestions).toHaveLength(1);
    expect(res.contentAr).not.toContain("هجهز");
    expect((res.clarificationQuestions || [])[0]).toMatch(/[؀-ۿ]/);
  });

  it("when the budget is spent before the retry, the one question says the reply was slow", async () => {
    let clock = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { handler, calls } = handlerWith(async () => { clock += 36_000; return turn({ type: "answer_question", answerAr: ANNOUNCE }); });
    const res = await send(handler, "عايز بيانات تيك توك");
    expect(calls).toHaveBeenCalledTimes(1);
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationQuestions).toHaveLength(1);
    expect(res.contentAr).toContain("استغرق الرد وقتًا أطول من المعتاد");
  });

  it("greetings and identity questions are not touched by the guard", async () => {
    const { handler, calls } = handlerWith(async () => turn({ type: "answer_question", answerAr: ANNOUNCE }));
    const res = await send(handler, "مساء الخير");
    expect(res.outputType).toBe("answer_question");
    expect(calls).toHaveBeenCalledTimes(0);
  });

  it("the page never keeps the composer waiting and gives a clear Arabic timeout message", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toMatch(/setLoading\(false\)/);
    expect(page).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\)/);
    expect(page).not.toMatch(/أكثر من 35 ثانية/);
    expect(page).toContain("استغرق المساعد وقتًا أطول من المتوقع");
  });
});
