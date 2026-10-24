import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { formatStructuredClarificationAnswers, validateStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { understandMission } from "../src/lib/consultantCopy";
import { FACEBOOK_POSTS_ONLY_UNAVAILABLE_AR } from "../src/lib/socialDiscoveryCard";
import { createChatDb } from "./helpers/chatSession";
import { resolveTimeWindow } from "../src/lib/timeWindow";

/**
 * «المنشورات فقط» (posts only) on the comments question. Evidence (the owner's live check): the answer was recorded and the plan still came out as a COMMENTS
 * plan with an invented count of 500 comments, and the topic read «ترندات الصحة فقط». The answers below are sent in the UI's own shape: one structured message
 * with one entry per open question, {questionId, question (the question's text), value (the option or the typed text)}, passed through the route's own
 * validation and formatting. FAKE model and FAKE database; no provider.
 */
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

class Chat {
  private db: any = createChatDb();
  private handler = new ChatHandler(this.db);
  constructor() { (this.handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); }); }
  async start() {
    await this.db.createRow({ tableId: "conversations", rowId: "conv_po", data: { userId: "user_po", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    return this;
  }
  send(message: string): Promise<any> { return this.handler.handleUserMessage({ userId: "user_po", conversationId: "conv_po", message, userBalance: 40_000 }) as Promise<any>; }
  /** The UI's submit: every open question of the card answered in one structured message. */
  async submitCard(card: any, values: Record<string, string>): Promise<any> {
    const answers = card.clarificationItems.map((q: any) => ({ questionId: q.id, question: q.text, value: values[q.id] ?? q.options?.[0] ?? "x" }));
    const message = formatStructuredClarificationAnswers(validateStructuredClarificationAnswers({ type: "clarification_answers", answers })!);
    return this.send(message);
  }
  /** Runs a card to its end with the answers given (a question with no answer given takes its first option). */
  async runWith(first: string, values: Record<string, string>): Promise<any> {
    let r = await this.send(first);
    for (let step = 0; step < 6 && r.outputType === "ask_clarification"; step++) r = await this.submitCard(r, values);
    return r;
  }
}
const TOPIC_TEXT = (r: any) => String(r.planQuote?.items?.[0]?.params?.query ?? "");
const ANSWER_WORDS = /فقط|بدون|المنشورات فقط|نعم، مع/;

describe("«posts only» on a Facebook topic: no comments plan, no invented count, nothing held", () => {
  it("the owner's live answers (platform, period, posts only, 20 posts) end in one honest sentence: no card, no quote, no hold", async () => {
    const c = await new Chat().start();
    const r = await c.runWith("عايز داتا عن ترندات الصحة في مصر", { social_platform_required: "فيسبوك", social_time_required: "آخر ٣ شهور", social_comments_wanted: "المنشورات فقط", social_posts_count_required: "٢٠" });
    expect(r.outputType).toBe("answer_question");
    expect(r.planQuote).toBeUndefined();
    expect(r.clarificationItems ?? []).toEqual([]);
    expect(r.contentAr).toBe(FACEBOOK_POSTS_ONLY_UNAVAILABLE_AR);
    expect(r.contentAr).not.toContain("٥٠٠");
    expect(r.contentAr).not.toMatch(/[A-Za-z]/);
  });

  it("the same words typed as a request: refused the same way, never a comments plan", async () => {
    const c = await new Chat().start();
    const r = await c.send("عايز المنشورات فقط عن ترندات الصحة على فيسبوك في مصر آخر ٣ شهور ٢٠ منشور");
    expect(r.planQuote).toBeUndefined();
    expect(r.contentAr).toBe(FACEBOOK_POSTS_ONLY_UNAVAILABLE_AR);
  });

  it("the label of the answer carries the comment word, but «المنشورات فقط» after it means no comments in the mission reading", () => {
    const text = "عايز داتا عن ترندات الصحة في مصر التعليقات المطلوبة: المنشورات فقط";
    expect(understandMission(text).commentsFlow).toBe(false);
  });
});

describe("«with comments» still plans comments, and the topic never carries an answer word", () => {
  it("posts with comments (20 x 5) plans the keyword service: 100 comments, the period, and the topic without «فقط» or «داتا»", async () => {
    const c = await new Chat().start();
    const r = await c.runWith("عايز داتا عن ترندات الصحة في مصر", { social_platform_required: "فيسبوك", social_time_required: "آخر ٣ شهور", social_comments_wanted: "نعم، مع التعليقات", social_posts_count_required: "٢٠", social_comments_per_post: "٥" });
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-facebook-keyword-comments");
    expect(item.targetVolumeMax).toBe(100);
    expect(TOPIC_TEXT(r)).toBe("ترندات الصحة");
    expect(TOPIC_TEXT(r)).not.toMatch(ANSWER_WORDS);
    const window = resolveTimeWindow("آخر ٣ شهور", { needsWindow: true }) as any;
    expect([item.params.dateFrom, item.params.dateTo]).toEqual([window.dateFrom, window.dateTo]);
  });

  it("a free sentence with «فقط» in the topic keeps the topic clean (no answer word leaks into it)", async () => {
    const c = await new Chat().start();
    const r = await c.send("عايز تعليقات عن ترندات الصحة فقط على فيسبوك في مصر آخر ٣ شهور ٢٠ منشور بـ ٥ تعليقات لكل منشور");
    expect(r.outputType).toBe("propose_plan");
    expect(TOPIC_TEXT(r)).toBe("ترندات الصحة");
  });
});

describe("a page link with posts only: the posts of the page, no comments", () => {
  it("the page's posts (10) are planned on the page service at 40 points, and no comments plan appears", async () => {
    const c = await new Chat().start();
    const r = await c.runWith("هات ١٠ بوست من صفحة https://www.facebook.com/youm7", { social_comments_wanted: "المنشورات فقط" });
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items.map((i: any) => i.capabilitySlug)).toEqual(["social-facebook-posts"]);
    expect(r.planQuote.items[0].targetVolumeMax).toBe(10);
    expect(r.planQuote.quotedPoints).toBe(40);
    expect(r.planQuote.expectedPoints).toBe(35);
  });
});
