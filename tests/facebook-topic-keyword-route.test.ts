import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/**
 * Production's enabled list has no verified, non-social Facebook service (the seed list does: facebook-post-search, facebook-post-comments). Mirror that
 * here: the handler's enabled list loses those two, while the catalog keeps them. The handler then treats a Facebook request exactly as production does.
 */
vi.mock("../src/functions/shared/capabilityRegistry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/functions/shared/capabilityRegistry")>();
  const NOT_ENABLED_IN_PRODUCTION = new Set(["facebook-post-search", "facebook-post-comments"]);
  return {
    ...real,
    getEnabledCapabilitiesWithCoreServices: async (tables?: any) => (await real.getEnabledCapabilitiesWithCoreServices(tables)).filter((capability) => !NOT_ENABLED_IN_PRODUCTION.has(capability.slug)),
  };
});

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { resolveTimeWindow } from "../src/lib/timeWindow";
import { createChatDb } from "./helpers/chatSession";

/**
 * A Facebook TOPIC request with no page goes to the keyword service, exactly as the explicit sentence does, and is never asked for a Page.
 * Evidence (the owner's tester, production, 24 Oct 2026): the free sentence went through five questions (platform, comments, posts, comments per post, then
 * «فيسبوك: ما اسم الصفحة العامة أو رابطها؟») while the explicit sentence went straight to a card. Cause: the Page question was suppressed on one path
 * and not on the other (see src/lib/socialDiscoveryCard.ts, socialDiscoveryTrigger). FAKE database and FAKE model; no provider, no SQL.
 */
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

class Chat {
  private db: any = createChatDb();
  private handler = new ChatHandler(this.db);
  constructor() { (this.handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); }); }
  async start() {
    await this.db.createRow({ tableId: "conversations", rowId: "conv_kw", data: { userId: "user_kw", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    return this;
  }
  send(message: string): Promise<any> { return this.handler.handleUserMessage({ userId: "user_kw", conversationId: "conv_kw", message, userBalance: 40_000 }) as Promise<any>; }
  answer(questionId: string, value: string): Promise<any> {
    return this.send(JSON.stringify({ type: "clarification_answers", answers: [{ question: questionId, questionId, value }] }));
  }
}
const chat = () => new Chat().start();
const visible = (r: any) => [r.contentAr, r.clarificationIntro, ...(r.clarificationQuestions || []), ...((r.clarificationItems || []).flatMap((q: any) => [q.text, ...(q.options || [])]))].filter(Boolean).join(" \n ");
const PROVIDER_WORDS = /treg|icypeas|firecrawl|tikhub|apify|openai|anthropic|supabase|usd|\$|endpoint|crawl4ai|anyapi|scrapecreators|justoneapi|keyword|سلسلة/i;
const KEYWORD = "social-facebook-keyword-comments";
/** English words in customer text: a word of two or more Latin letters. The platform's own mark «X» (منصة X) is a name, not prose. */
const LATIN_WORD = /[A-Za-z]{2,}/;

/** The plan's own figures, without the sentences around them: what must be the same for two requests that ask for the same counts. */
const planFacts = (r: any) => {
  const item = r.planQuote.items[0];
  return { outputType: r.outputType, count: r.planQuote.items.length, slug: item.capabilitySlug, volume: item.targetVolumeMax, unit: item.unitPricePoints, dateFrom: item.params.dateFrom, dateTo: item.params.dateTo, perVideo: item.params.perVideo, videoCount: item.params.videoCount, quoted: r.planQuote.quotedPoints, expected: r.planQuote.expectedPoints };
};

describe("the five-question conversation of the tester ends in the keyword plan card", () => {
  it("platform (Facebook is offered), comments, posts, comments per post, then the card: never a question about a page", async () => {
    const c = await chat();
    let r = await c.send("عايز داتا عن ترندات الصحة في مصر آخر ٣ شهور");
    const asked: string[] = [];
    // the platform question offers Facebook as a ready option, next to the others
    expect(r.outputType).toBe("ask_clarification");
    expect(r.clarificationItems[0].id).toBe("social_platform_required");
    expect(r.clarificationItems[0].options).toContain("فيسبوك");
    for (let step = 0; step < 6 && r.outputType === "ask_clarification"; step++) {
      const q = r.clarificationItems[0];
      asked.push(q.id);
      expect(visible(r), q.id).not.toMatch(PROVIDER_WORDS);
      expect(visible(r), q.id).not.toMatch(LATIN_WORD);
      expect(visible(r), q.id).not.toContain("لا يتيح البحث بالموضوع");
      expect(visible(r), q.id).not.toMatch(/اسم الصفحة العامة أو رابطها/);
      const value = q.id === "social_platform_required" ? "أخرى: فيسبوك"
        : q.id === "social_comments_wanted" ? "نعم، مع التعليقات"
        : q.id === "social_posts_count_required" ? "١٠٠"
        : q.id === "social_comments_per_post" ? "٥"
        : (q.options?.[0] ?? "x");
      r = await c.answer(q.id, value);
    }
    expect(asked).not.toContain("social_page_required");
    expect(asked).not.toContain("social_time_required"); // the period was stated in the first sentence
    expect(r.outputType).toBe("propose_plan");
    const plan = planFacts(r);
    expect(plan).toMatchObject({ count: 1, slug: KEYWORD, volume: 500, unit: 12.925, perVideo: 5, videoCount: 100 });
    const window = resolveTimeWindow("آخر ٣ شهور", { needsWindow: true }) as any;
    expect([plan.dateFrom, plan.dateTo]).toEqual([window.dateFrom, window.dateTo]);
    // the hold is the reserve of 500 comments at 12.925 with the 15% buffer, the charge is the expected value without it
    expect(plan.expected).toBe(Math.ceil(500 * 12.925));
    expect(plan.quoted).toBe(Math.ceil(500 * 12.925 * 1.15));
    expect(visible(r)).not.toMatch(PROVIDER_WORDS);
    expect(visible(r)).not.toMatch(LATIN_WORD);
    expect(visible(r)).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("the explicit sentence goes to the same card as the conversation, with the same counts", () => {
  it("«هات ١٠٠ بوست ... وكل بوست معاه ٥ تعليقات» and the same topic in the conversation: the same service, period dates, unit price and hold", async () => {
    const explicit = await chat();
    const r1 = await explicit.send("هات ١٠٠ بوست عن ترندات الصحة على فيسبوك في مصر آخر ٣ شهور وكل بوست معاه ٥ تعليقات");
    expect(r1.outputType).toBe("propose_plan");
    expect(visible(r1)).not.toContain("اسم الصفحة");

    const conversation = await chat();
    let r2 = await conversation.send("عايز داتا عن ترندات الصحة في مصر آخر ٣ شهور");
    for (let step = 0; step < 6 && r2.outputType === "ask_clarification"; step++) {
      const q = r2.clarificationItems[0];
      const value = q.id === "social_platform_required" ? "أخرى: فيسبوك"
        : q.id === "social_comments_wanted" ? "نعم، مع التعليقات"
        : q.id === "social_posts_count_required" ? "١٠٠"
        : q.id === "social_comments_per_post" ? "٥"
        : (q.options?.[0] ?? "x");
      r2 = await conversation.answer(q.id, value);
    }
    expect(r2.outputType).toBe("propose_plan");
    expect(planFacts(r2)).toEqual(planFacts(r1));
  });

  it("the owner's literal sentence («هات ٥ بوستات ... كل بوست معاه ٥ تعليقات») gets the keyword card with 25 comments and a hold of 372", async () => {
    const c = await chat();
    const r = await c.send("هات ٥ بوستات عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور وكل بوست معاه ٥ تعليقات");
    expect(r.outputType).toBe("propose_plan");
    // 25 comments x 12.925 = 323.125, charged as 324 (rounded up); the hold 25 x 12.925 x 1.15 = 371.6, rounded up to 372
    expect(planFacts(r)).toMatchObject({ slug: KEYWORD, volume: 25, unit: 12.925, expected: 324, quoted: 372 });
    expect(visible(r)).not.toMatch(PROVIDER_WORDS);
  });
});

describe("a request that names a Page stays on the Page service", () => {
  it("a Page link (with comments per post) is planned on the page service, never the keyword service and never a page question", async () => {
    const c = await chat();
    const r = await c.send("هات ١٠ بوستات من صفحة https://www.facebook.com/youm7 على فيسبوك ٥ تعليقات لكل منشور");
    expect(r.outputType).toBe("propose_plan");
    const slugs = r.planQuote.items.map((item: any) => item.capabilitySlug);
    expect(slugs).not.toContain(KEYWORD);
    // the page service for comments of a page's posts (the same service a Page link got before this change)
    expect(slugs).toEqual(["social-facebook-comments"]);
    expect(visible(r)).not.toContain("اسم الصفحة العامة أو رابطها");
  });
});

describe("a Facebook request with NO topic: the topic or the page, in one plain question", () => {
  it("«بوستات فيسبوك بالتعليقات ٥٠ منشور» asks for the topic or the page; the old sentence about searching is gone", async () => {
    const c = await chat();
    const r = await c.send("بوستات فيسبوك بالتعليقات ٥٠ منشور");
    expect(r.outputType).toBe("ask_clarification");
    expect(r.planQuote).toBeUndefined();
    const ids = (r.clarificationItems ?? []).map((q: any) => q.id);
    expect(ids.length).toBeGreaterThan(0);
    const text = visible(r);
    expect(text).not.toContain("لا يتيح البحث بالموضوع");
    expect(text).not.toMatch(PROVIDER_WORDS);
    expect(text).not.toMatch(/[A-Za-z]/);
  });
});
