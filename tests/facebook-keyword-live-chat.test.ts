import { describe, expect, it, vi } from "vitest";

/**
 * The owner's first live run (2026-10-24) through the chat handler: «هات ٥ بوستات عن الترندات الصحية على فيسبوك في مصر وكل بوست معاه ٥ تعليقات».
 * The per-post count written inside the sentence is read, the topic stays clean, and a free-text answer to the comments-per-post question is read
 * like the card's answer and never asked twice. The model is a FAKE one (never asked for anything here); no provider, no SQL.
 */
const POSTS_EP: any = {
  slug: "facebook-post-search", id: "treg.facebook.search.posts", nameAr: "بحث منشورات فيسبوك العامة", nameEn: "Facebook Public Post Search", platform: "facebook",
  summaryAr: "البحث في المنشورات العامة على فيسبوك بالكلمات المفتاحية", billingUnit: "item", catalogPriceUsd: 0.0014, pointsPerUnit: 8,
  pagination: { type: "cursor", maxLimit: 50 }, observedSuccessRate: 0.9, observedSamples: 100, method: "GET", scope: "any_account",
  paramsSchema: { type: "object", properties: { query: { type: "string" }, dateFrom: { type: "string" }, dateTo: { type: "string" } }, required: ["query"] },
};
const COMMENTS_EP: any = {
  slug: "facebook-post-comments", id: "treg.facebook.post.comments", nameAr: "تعليقات منشورات فيسبوك العامة", nameEn: "Facebook Post Comments", platform: "facebook",
  summaryAr: "جمع التعليقات العامة", billingUnit: "item", catalogPriceUsd: 0.0019, pointsPerUnit: 11,
  pagination: { type: "cursor", maxLimit: 50 }, observedSuccessRate: 0.9, observedSamples: 100, method: "GET", scope: "any_account",
  paramsSchema: { type: "object", properties: { postUrl: { type: "string" } }, required: ["postUrl"] },
};
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  searchCatalog: vi.fn(async () => [POSTS_EP, COMMENTS_EP]),
  getCachedCatalogEndpoints: vi.fn(() => [POSTS_EP, COMMENTS_EP]),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { createChatDb } from "./helpers/chatSession";

async function session() {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  const executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
  (handler as any).llm.executeTurn = executeTurn;
  await db.createRow({ tableId: "conversations", rowId: "conv_live", data: { userId: "user_live", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  const send = (message: string): Promise<any> => handler.handleUserMessage({ userId: "user_live", conversationId: "conv_live", message, userBalance: 20000 }) as Promise<any>;
  const answer = (questionId: string, value: string) => send(JSON.stringify({ type: "clarification_answers", answers: [{ question: questionId, questionId, value }] }));
  return { send, answer, executeTurn };
}

const FULL = "هات ٥ بوستات عن الترندات الصحية على فيسبوك في مصر وكل بوست معاه ٥ تعليقات";
const POSTS_ONLY = "هات ٥ بوستات عن الترندات الصحية على فيسبوك في مصر";
const WITH_COMMENTS = "هات ٥ بوستات وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر";
const everything = (r: any) => [r.contentAr, JSON.stringify(r.planQuote?.summaryAr), JSON.stringify(r.planQuote?.methodologyNotes ?? ""), JSON.stringify(r.planQuote?.items ?? [])].filter(Boolean).join("\n");
const questionIds = (r: any) => ((r.clarificationItems as any[]) ?? []).map((q) => q.id);

describe("the first live run's request, end to end", () => {
  it("the count of comments per post written INSIDE the sentence is read: no question, ONE plan of 5 posts x 5 comments = 25, the topic clean", async () => {
    const s = await session();
    const r = await s.send(FULL);
    expect(r.outputType).toBe("propose_plan");
    expect(s.executeTurn).not.toHaveBeenCalled();
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-facebook-keyword-comments");
    expect(item.targetVolumeMax).toBe(25);
    expect(item.params.query).toBe("الترندات الصحية");
    expect(item.params.region).toBe("EG");
    expect(r.planQuote.items).toHaveLength(1);
    const text = everything(r);
    expect(text).toContain("«الترندات الصحية»");
    for (const stale of ["وكل معاه", "وكل بوست", "معاه", "الترندات الصحية وكل"]) expect(text, stale).not.toContain(stale);
  });

  it("a free-text answer to the question is read like the card's: asked ONCE, then ONE plan with the same clean topic", async () => {
    const s = await session();
    const first = await s.send(WITH_COMMENTS);
    expect(first.outputType).toBe("ask_clarification");
    expect(questionIds(first)).toEqual(["social_comments_per_post"]);
    const second = await s.send("٥ بوستات، وكل بوست معاه ٥ تعليقات");
    expect(second.outputType).toBe("propose_plan");
    expect(questionIds(second)).toEqual([]);
    const item = second.planQuote.items[0];
    expect(item.targetVolumeMax).toBe(25);
    expect(item.params.query).toBe("الترندات الصحية");
    expect(everything(second)).not.toContain("معاه");
    expect(s.executeTurn).not.toHaveBeenCalled();
  });

  it("the card's own option still gives the same plan", async () => {
    const s = await session();
    await s.send(WITH_COMMENTS);
    const r = await s.answer("social_comments_per_post", "٥");
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].targetVolumeMax).toBe(25);
    expect(r.planQuote.items[0].params.query).toBe("الترندات الصحية");
  });

  it("the word order is free: «كل منشور فيه ٥ تعليقات», «بخمس تعليقات لكل بوست», «٥ تعليقات لكل واحد»", async () => {
    for (const tail of ["وكل منشور فيه ٥ تعليقات", "بخمس تعليقات لكل بوست", "و٥ تعليقات لكل واحد"]) {
      const s = await session();
      const r = await s.send(`${POSTS_ONLY} ${tail}`);
      expect(r.outputType, tail).toBe("propose_plan");
      expect(r.planQuote.items[0].targetVolumeMax, tail).toBe(25);
      expect(r.planQuote.items[0].params.query, tail).toBe("الترندات الصحية");
    }
  });
});
