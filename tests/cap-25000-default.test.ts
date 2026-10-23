import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The 25,000-point default, tested with the lowering variable cleared (the older suites run with the cap lowered to 600 by the environment, see vitest.config.mts).
 * The owner's 300-post Facebook request with 5 comments a post: the plan holds it whole, the counts and the hold are code's, a plan the provider capacity cannot
 * hold is REFUSED (never clipped), nothing is written for a refusal. FAKE model and FAKE database only: no provider, no model, no SQL.
 */
const POSTS_EP: any = {
  slug: "facebook-post-search", id: "treg.facebook.search.posts", nameAr: "بحث منشورات فيسبوك العامة", nameEn: "Facebook Public Post Search", platform: "facebook",
  summaryAr: "البحث في المنشورات العامة على فيسبوك بالكلمات المفتاحية", billingUnit: "item", catalogPriceUsd: 0.00135, pointsPerUnit: 8,
  pagination: { type: "cursor", maxLimit: 50 }, observedSuccessRate: 0.9, observedSamples: 100, method: "GET", scope: "any_account",
  paramsSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
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
import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting, getConfiguredJobPointsCap } from "../src/functions/shared/providerSpend";
import { DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";
import { JOB_MAX_POINTS_CAP, effectiveJobPointsCap } from "../src/lib/jobPointsCap";
import { PlanRefusalError } from "../src/lib/capacityRefusal";
import { planCountLineAr } from "../src/lib/planCounts";
import { FACEBOOK_JOB_CEILINGS } from "../src/lib/facebookCeilings";
import { getSocialCapability } from "../src/lib/socialSources";
import { createChatDb } from "./helpers/chatSession";

beforeEach(() => {
  vi.stubEnv("JOB_MAX_POINTS_CAP", "");
  resetProviderBalanceCacheForTesting();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetProviderBalanceCacheForTesting();
});

describe("the default cap and the Facebook ceilings: one place each", () => {
  it("the cap is 25,000 in the one constant; the environment can only lower it; the worker settles with the constant", () => {
    expect(JOB_MAX_POINTS_CAP).toBe(25_000);
    expect(effectiveJobPointsCap({})).toBe(25_000);
    expect(effectiveJobPointsCap({ JOB_MAX_POINTS_CAP: "100000" })).toBe(25_000);
    expect(effectiveJobPointsCap({ JOB_MAX_POINTS_CAP: "600" })).toBe(600);
    expect(getConfiguredJobPointsCap()).toBe(25_000);
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).toContain("let jobPointsCap = Math.max(getConfiguredJobPointsCap(), JOB_MAX_POINTS_CAP);");
    expect(worker).toContain("jobPointsCap = Math.max(val.jobMaxPointsCap, JOB_MAX_POINTS_CAP);");
  });

  it("the Facebook ceilings are 300 posts and 1,500 comments, defined once and read by the services", () => {
    expect(FACEBOOK_JOB_CEILINGS).toEqual({ posts: 300, comments: 1500 });
    expect(getSocialCapability("social-facebook-posts")!.maxRows).toBe(300);
    expect(getSocialCapability("social-facebook-comments")!.maxRows).toBe(1500);
    expect(readFileSync("src/lib/socialSources.ts", "utf8")).not.toMatch(/maxRows: (?:60|500),\s*\n\s*successRate: 0\.99/);
  });

  it("the record limit of one plan item is unchanged at 5,000 in code and in the proposal (the request needs 1,500 at most)", () => {
    expect(readFileSync("src/functions/shared/planManager.ts", "utf8")).toContain("targetVolumeMax: z.number().int().min(1).max(5000)");
    expect(readFileSync("tests/replica/prod-definitions/accept_quote_atomic.sql", "utf8")).toContain("v_target_max > 5000");
    expect(readFileSync("docs/proposals/job-cap-25000/README.md", "utf8")).toContain("record limit (`v_target_max > 5000`) is unchanged");
  });
});

describe("the owner's plan, 300 posts and 1,500 comments, in the quote writer", () => {
  const caps: any[] = [
    {
      id: "facebook-post-search", slug: "facebook-post-search", platform: "facebook", category: "facebook", nameAr: "بحث منشورات", nameEn: "Facebook Post Search", descriptionAr: "x",
      unitCostUsd: 0.00135, maxRows: 5000, enabled: true, paramsSchema: "{}", tregEndpointId: "internal-facebook-post-search", tregMethod: "GET", pricingUnit: "item",
    },
    {
      id: "facebook-post-comments", slug: "facebook-post-comments", platform: "facebook", category: "facebook", nameAr: "تعليقات منشورات", nameEn: "Facebook Post Comments", descriptionAr: "x",
      unitCostUsd: 0.00188, customerPriceUsdPerItem: 0.0019, maxRows: 1500, enabled: true, paramsSchema: "{}", tregEndpointId: "internal-facebook-post-comments", tregMethod: "GET", pricingUnit: "item",
    },
  ];
  const makeDb = () => {
    const inserted: any[] = [];
    const db = { from: vi.fn(() => ({ update: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ data: [], error: null })) })) })), insert: vi.fn(async (doc: any) => { inserted.push(doc); return { data: doc, error: null }; }) })) };
    return { db, inserted };
  };
  const plan = (posts: number, comments: number) => ({
    summaryAr: "خطة",
    items: [
      { capabilitySlug: "facebook-post-search", params: { query: "الترندات الصحية في مصر" }, targetVolumeMin: 1, targetVolumeMax: posts },
      { capabilitySlug: "facebook-post-comments", params: { postUrl: "https://www.facebook.com/post/1" }, targetVolumeMin: 1, targetVolumeMax: comments },
    ],
    outputFormats: ["xlsx"],
  } as any);
  const quote = (db: any, posts: number, comments: number, balance = 30_000) =>
    createAndSaveManagedQuote(db, { conversationId: "conv-300", userId: "user-300", plan: plan(posts, comments), userBalance: balance, capabilities: caps, pricingSettings: DEFAULT_PRICING_SETTINGS });

  it("300 posts + 1,500 comments: held whole (no reduction), reserve 21,735 under the 25,000 cap, charge 18,900, one count line", async () => {
    setProviderBalanceForTesting(50);
    const { db } = makeDb();
    const q = await quote(db, 300, 1500);
    expect(q.items.map((i: any) => i.targetVolumeMax)).toEqual([300, 1500]);
    expect(q.quotedPoints).toBe(21_735);
    expect(q.expectedPoints).toBe(18_900);
    expect(q.quotedPoints).toBeLessThanOrEqual(q.pointsCap!);
    expect(q.pointsCap).toBe(25_000);
    expect(q.pointsCapConstrained).toBe(false);
    expect(q.fit).toBeUndefined();
    expect(q.isAffordable).toBe(true);
    expect(planCountLineAr(q.items)).toBe("حتى ٣٠٠ منشورًا و١٥٠٠ تعليقًا");
  });

  it("400 posts x 5 comments: the service ceiling cuts it to 300 posts and 1,500 comments, and the sentence says it is the service's limit (not the balance)", async () => {
    setProviderBalanceForTesting(50);
    const { db } = makeDb();
    const q = await quote(db, 400, 2000);
    expect(q.items.map((i: any) => i.targetVolumeMax)).toEqual([300, 1500]);
    expect(q.fit).toMatchObject({ reason: "ceiling", asked: [400, 2000], perPost: 5 });
    expect(q.fit!.noticeAr).toContain("طلبت ٤٠٠ منشورًا و٢٠٠٠ تعليق");
    expect(q.fit!.noticeAr).toContain("ليناسب حدّ الخدمة في الطلب الواحد");
    expect(q.fit!.noticeAr).toContain("وليس رصيدك");
  });

  it("a plan above the cap is still cut to the cap, with ONE size (the cap binds at 25,000)", async () => {
    setProviderBalanceForTesting(500);
    const { db } = makeDb();
    const q = await quote(db, 300, 3000); // 10 comments a post: 300 x 8 + 3,000 x 11 = 35,400 charge; the comments ceiling (1,500) binds first
    expect(q.quotedPoints).toBeLessThanOrEqual(25_000);
    expect(q.items[1].targetVolumeMax).toBeLessThanOrEqual(1500);
    expect(q.items[1].targetVolumeMax).toBe(q.items[0].targetVolumeMax * 10);
  });

  it("the provider capacity cannot hold it: REFUSED in one Arabic sentence with what it does hold; nothing is written, nothing is held", async () => {
    setProviderBalanceForTesting(1); // a safe budget of 0.9 USD against an estimate of 3.2 USD (300 x 0.00135 + 1,500 x 0.00188 = 3.225)
    const { db, inserted } = makeDb();
    const refused = await quote(db, 300, 1500).then(() => null, (error) => error);
    expect(refused).toBeInstanceOf(PlanRefusalError);
    const text = (refused as PlanRefusalError).messageAr;
    expect(text).toMatch(/^هذا الطلب أكبر من طاقة الاستخراج المتاحة اليوم؛ تتسع الطاقة الحالية لنحو ٨٣ منشورًا و٤١٨ تعليقًا فقط\./);
    expect(text).toContain("ولم يُحجز أي رصيد");
    expect(text).not.toMatch(/[A-Za-z0-9]|usd|\$|treg|endpoint/i);
    expect(inserted).toEqual([]);
    // the gate only READS (the provider spend of the day); no money table is touched
    const touched = (db.from as any).mock.calls.map((call: any[]) => String(call[0]));
    for (const table of ["plans_quotes", "credit_ledger", "jobs", "topups", "profiles"]) expect(touched, table).not.toContain(table);
  });

  it("a plan at or under the old 600-point cap keeps the older behaviour (cut with the reason, never refused)", async () => {
    setProviderBalanceForTesting(0.001);
    const { db } = makeDb();
    const q = await quote(db, 4, 40);
    expect(q.quotedPoints).toBeLessThanOrEqual(600);
    expect(q.capacityConstrained).toBe(true);
  });
});

describe("the owner's request through the chat: 300 posts, 5 comments each", () => {
  const REQUEST = "عايز ٣٠٠ بوست وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر";
  async function session() {
    const db: any = createChatDb();
    const handler = new ChatHandler(db);
    const plan = {
      type: "propose_plan", summaryAr: "جمع ٣٠٠ بوست و١٥٠٠ تعليق", conversationTitle: "عايز بوستات وتعليقاتهم عن الترندات الصحية",
      capabilities: [
        { stepId: "s1", capabilitySlug: "facebook-post-search", endpointId: "treg.facebook.search.posts", params: { query: REQUEST }, targetVolumeMin: 1, targetVolumeMax: 300, paginationStrategy: "cursor" },
        { stepId: "s2", capabilitySlug: "facebook-post-comments", endpointId: "treg.facebook.post.comments", params: { postUrl: "https://www.facebook.com/post/1" }, targetVolumeMin: 1, targetVolumeMax: 1500, paginationStrategy: "cursor", dependsOn: ["s1"], inputFrom: { stepId: "s1", field: "postUrl", paramKey: "postUrl" }, fanOutCap: 300 },
      ],
      outputFormats: ["xlsx"],
    };
    (handler as any).llm.executeTurn = vi.fn(async () => ({ output: plan, inputTokens: 10, outputTokens: 10, costUsd: 0, model: "fake", promptVersion: "x" }));
    await db.createRow({ tableId: "conversations", rowId: "conv_300", data: { userId: "user_300", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    const send = (message: string): Promise<any> => handler.handleUserMessage({ userId: "user_300", conversationId: "conv_300", message, userBalance: 40_000 }) as Promise<any>;
    const answer = (value: string) => send(JSON.stringify({ type: "clarification_answers", answers: [{ question: "social_comments_per_post", questionId: "social_comments_per_post", value }] }));
    return { send, answer };
  }

  it("with capacity: ONE plan of 300 posts and 1,500 comments, the hold 21,735, no reduction sentence, one count line, a clean topic", async () => {
    setProviderBalanceForTesting(50);
    const s = await session();
    const first = await s.send(REQUEST);
    expect(first.outputType).toBe("ask_clarification");
    expect((first.clarificationItems as any[]).map((q) => q.id)).toEqual(["social_comments_per_post"]);
    const r = await s.answer("٥");
    expect(r.outputType).toBe("propose_plan");
    const q = r.planQuote;
    expect(q.items.map((i: any) => [i.capabilitySlug, i.targetVolumeMax])).toEqual([["facebook-post-search", 300], ["facebook-post-comments", 1500]]);
    expect(q.quotedPoints).toBe(21_735);
    expect(q.expectedPoints).toBe(18_900);
    expect(q.summaryAr).toBe("جمع ٣٠٠ منشورًا و١٥٠٠ تعليقًا عن «الترندات الصحية في مصر» على فيسبوك");
    expect(r.contentAr).toContain("- الحد الأقصى: حتى ٣٠٠ منشورًا و١٥٠٠ تعليقًا");
    expect(r.contentAr).not.toContain("تم تقليل الطلب");
    expect(q.volumeLimitLineAr).toBeUndefined();
    expect(q.items[0].params.query).toBe("الترندات الصحية في مصر");
    expect(q.pointsCap).toBe(25_000);
  });

  it("without capacity today: the customer gets ONE honest sentence as the reply, no plan card, nothing quoted", async () => {
    setProviderBalanceForTesting(1);
    const s = await session();
    await s.send(REQUEST);
    const r = await s.answer("٥");
    expect(r.planQuote).toBeUndefined();
    expect(r.outputType).not.toBe("propose_plan");
    expect(r.contentAr).toMatch(/^هذا الطلب أكبر من طاقة الاستخراج المتاحة اليوم؛ تتسع الطاقة الحالية لنحو [٠-٩]+ منشورًا و[٠-٩]+ تعليقًا فقط\./);
    expect(r.contentAr).toContain("ولم يُحجز أي رصيد");
    expect(r.contentAr).not.toMatch(/[A-Za-z]|usd|\$|treg|endpoint/i);
    expect(r.contentAr).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
