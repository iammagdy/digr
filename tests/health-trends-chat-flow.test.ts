import { describe, expect, it, vi } from "vitest";

/**
 * The owner's health-trends request end to end through the chat handler: the card asks the one question it needs, the model (a FAKE one: it is
 * only asked for the plan's shape) proposes 50 posts and 500 comments, and the plan the customer reads is ONE consistent size. No live model,
 * no provider call, no SQL.
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

const PROVIDER_WORDS = /treg|icypeas|firecrawl|context\.dev|tikhub|apify|openai|anthropic|resend|supabase|usd|\$|endpoint/i;

async function session(modelPosts: number, modelComments: number, modelQuery: string) {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  const plan = {
    type: "propose_plan",
    summaryAr: `جمع ${modelPosts} بوست و${modelComments} تعليق`,
    conversationTitle: "عايز بوستات وتعليقاتهم عن الترندات الصحية",
    capabilities: [
      { stepId: "s1", capabilitySlug: "facebook-post-search", endpointId: "treg.facebook.search.posts", params: { query: modelQuery }, targetVolumeMin: 1, targetVolumeMax: modelPosts, paginationStrategy: "cursor" },
      { stepId: "s2", capabilitySlug: "facebook-post-comments", endpointId: "treg.facebook.post.comments", params: { postUrl: "https://www.facebook.com/post/1" }, targetVolumeMin: 1, targetVolumeMax: modelComments, paginationStrategy: "cursor", dependsOn: ["s1"], inputFrom: { stepId: "s1", field: "postUrl", paramKey: "postUrl" }, fanOutCap: 50 },
    ],
    outputFormats: ["xlsx"],
  };
  const executeTurn = vi.fn(async () => ({ output: plan, inputTokens: 10, outputTokens: 10, costUsd: 0, model: "fake", promptVersion: "x" }));
  (handler as any).llm.executeTurn = executeTurn;
  await db.createRow({ tableId: "conversations", rowId: "conv_h", data: { userId: "user_h", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  const send = (message: string): Promise<any> => handler.handleUserMessage({ userId: "user_h", conversationId: "conv_h", message, userBalance: 20000 }) as Promise<any>;
  const answer = (questionId: string, value: string) => send(JSON.stringify({ type: "clarification_answers", answers: [{ question: questionId, questionId, value }] }));
  return { send, answer, executeTurn };
}

const visibleText = (r: any) => [r.contentAr, JSON.stringify(r.planQuote?.summaryAr), r.planQuote?.volumeLimitLineAr].filter(Boolean).join("\n");

describe("the owner's health-trends request, end to end", () => {
  const REQUEST = "عايز ٥٠ بوست وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر";

  it("asks the one question it needs (comments per post), nothing it was already told", async () => {
    const s = await session(50, 500, REQUEST);
    const first = await s.send(REQUEST);
    expect(first.outputType).toBe("ask_clarification");
    expect((first.clarificationItems as any[]).map((q) => q.id)).toEqual(["social_comments_per_post"]);
    expect(s.executeTurn).not.toHaveBeenCalled();
  });

  it("50 posts x 10 comments is bigger than one job: the plan is reduced to ONE size, 4 posts and 40 comments, with the sentence that says so", async () => {
    const s = await session(50, 500, REQUEST);
    await s.send(REQUEST);
    const r = await s.answer("social_comments_per_post", "١٠");
    expect(r.outputType).toBe("propose_plan");
    const q = r.planQuote;
    expect(q.items.map((i: any) => [i.capabilitySlug, i.targetVolumeMax])).toEqual([["facebook-post-search", 4], ["facebook-post-comments", 40]]);
    // the hold is under the per-job cap of 600, the charge of the whole plan is ceil(delivered x price) and never above the hold
    expect(q.quotedPoints).toBe(543);
    expect(q.quotedPoints).toBeLessThanOrEqual(600);
    expect(q.pointsCap).toBe(600);
    expect(q.expectedPoints).toBe(4 * 8 + 40 * 11);
    expect(q.expectedPoints).toBeLessThanOrEqual(q.quotedPoints);
    // one count, said once and the same in the summary line, the title of the plan and the sentence
    const count = "٤ منشورات و٤٠ تعليقًا";
    expect(q.summaryAr).toBe(`جمع ${count} عن «الترندات الصحية في مصر» على فيسبوك`);
    expect(r.contentAr).toContain(`- الحد الأقصى: حتى ${count}`);
    expect(q.volumeLimitLineAr).toBe("طلبت ٥٠ منشورًا و٥٠٠ تعليقًا، وتم تقليل الطلب إلى ٤ منشورات و٤٠ تعليقًا (حتى ١٠ تعليقات لكل منشور) ليناسب حدّ الطلب الواحد (حجز لا يتجاوز ٦٠٠ نقطة)، وليس رصيدك. يمكنك طلب الباقي في طلب منفصل.");
    expect(r.contentAr).toContain(q.volumeLimitLineAr);
    // never two different counts
    for (const stale of ["٤٨ سجل", "٤٤ سجل", "حتى ٤ سجل", "٥٠ بوست", "٥٠٠ تعليق،"]) expect(visibleText(r), stale).not.toContain(stale);
    // the price per record is on the plan, from the quote (the model never states it)
    expect(r.contentAr).toContain("٨ نقطة لكل منشور");
    expect(r.contentAr).toContain("١١ نقطة لكل تعليق");
  });

  it("the topic text stays clean: the request's verbs, count and platform words never reach the plan", async () => {
    const s = await session(50, 500, REQUEST);
    await s.send(REQUEST);
    const r = await s.answer("social_comments_per_post", "١٠");
    expect(r.planQuote.items[0].params.query).toBe("الترندات الصحية في مصر");
    expect(visibleText(r)).toContain("«الترندات الصحية في مصر»");
    expect(visibleText(r)).not.toMatch(/عايز|بوست وتعليقاتهم/);
  });

  it("a request that fits is not reduced and carries no reduction sentence", async () => {
    const s = await session(3, 15, "الترندات الصحية في مصر");
    await s.send("عايز ٣ بوست وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر");
    const r = await s.answer("social_comments_per_post", "٥");
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items.map((i: any) => i.targetVolumeMax)).toEqual([3, 15]);
    expect(r.planQuote.volumeLimitLineAr).toBeUndefined();
    expect(r.contentAr).toContain("- الحد الأقصى: حتى ٣ منشورات و١٥ تعليقًا");
    expect(r.contentAr).not.toContain("تم تقليل الطلب");
  });

  it("the customer-facing text is Arabic only: no provider name, no Latin letters, no emoji, no markdown heading", async () => {
    const s = await session(50, 500, REQUEST);
    await s.send(REQUEST);
    const r = await s.answer("social_comments_per_post", "١٠");
    const text = String(r.contentAr);
    expect(text).not.toMatch(PROVIDER_WORDS);
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/^#{1,6}\s/m);
  });
});
