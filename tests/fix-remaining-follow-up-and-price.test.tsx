import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Task C of the remaining failures. Evidence: after «الترندات الصحية في مصر آخر ٣ شهور من فيسبوك، ٤٠٠ منشور بالتعليقات» the plan carried the topic
 * «الترندات الصحية بالتعليقات», no question was asked about what the request leaves open, the card had no price per record; the follow-up
 * «٥٠ منشور بالتعليقات» made the topic «بالتعليقات» and left the numbers at ٤٠٠. The model is never called; no provider is called.
 */
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { createChatDb } from "./helpers/chatSession";
import { understandMission } from "../src/lib/consultantCopy";
import { socialDiscoveryItems, socialDiscoveryTrigger } from "../src/lib/socialDiscoveryCard";
import { hasSocialSubject, socialSubjectText } from "../src/lib/socialTasks";
import { unitPriceLineAr } from "../src/lib/planExplanation";
import { customerFacingCapabilityLabel } from "../src/lib/customerFacingRequestLabels";

const OWNER = "الترندات الصحية في مصر آخر ٣ شهور من فيسبوك، ٤٠٠ منشور بالتعليقات";
const PAGE = "https://www.facebook.com/youm7";
const PROVIDER_WORDS = /treg|icypeas|firecrawl|tikhub|apify|openai|anthropic|supabase|usd|\$|endpoint|crawl4ai|anyapi|scrapecreators/i;

class Chat {
  private db: any = createChatDb();
  private handler: ChatHandler;
  constructor() {
    this.handler = new ChatHandler(this.db);
    (this.handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  }
  async start() {
    await this.db.createRow({ tableId: "conversations", rowId: "conv_c", data: { userId: "user_c", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    return this;
  }
  send(message: string): Promise<any> { return this.handler.handleUserMessage({ userId: "user_c", conversationId: "conv_c", message, userBalance: 20000 }) as Promise<any>; }
  answer(answers: Array<{ questionId: string; value?: string }>) {
    return this.send(JSON.stringify({ type: "clarification_answers", answers: answers.map((a) => ({ question: a.questionId, ...a })) }));
  }
}
const chat = () => new Chat().start();
const visible = (r: any) => [r.contentAr, ...((r.clarificationItems || []).flatMap((q: any) => [q.text, ...(q.options || [])]))].filter(Boolean).join(" \n ");

describe("C1: a follow-up number replaces the number and never the topic", () => {
  it("«بالتعليقات» is the task, never a word of the topic", () => {
    expect(socialSubjectText(OWNER)).toBe("الترندات الصحية");
    for (const word of ["بالتعليقات", "بتعليقاتها", "وتعليقاتها", "بالكومنتات", "بالمنشورات"]) expect(socialSubjectText(`${word} الأهلي`), word).toBe("الأهلي");
    expect(socialSubjectText("٥٠ منشور بالتعليقات")).toBe("");
    expect(hasSocialSubject("٥٠ منشور بالتعليقات")).toBe(false);
  });

  it("the newest count wins: «٥٠ منشور» after «٤٠٠ منشور» is 50 posts, and a new per-post number replaces the old one", () => {
    expect(understandMission(OWNER)).toMatchObject({ videos: 400 });
    expect(understandMission(`${OWNER} ٥٠ منشور بالتعليقات`)).toMatchObject({ videos: 50 });
    expect(understandMission(`${OWNER} ٢٠ تعليق من كل منشور ٥ تعليقات من كل منشور`)).toMatchObject({ videos: 400, commentsPerVideo: 5 });
    // a request that states each number once is read exactly as before
    expect(understandMission(`${OWNER} ٢٠ تعليق من كل منشور`)).toMatchObject({ videos: 400, commentsPerVideo: 20 });
  });

  it("«الصفحة المطلوبة:» (the label of a card answer) is never a page called «المطلوبة»", () => {
    const text = `هات ٤٠٠ منشور بالتعليقات من فيسبوك الصفحة المطلوبة: ${PAGE} · ٢٠ تعليق من كل منشور`;
    expect(understandMission(text).channels.named).toEqual([PAGE]);
  });

  it("in the conversation: the plan, then «٥٠ منشور بالتعليقات»: the page and the topic stay, the asked number is 50 posts, nothing else changes", async () => {
    const c = await chat();
    await c.send(`${OWNER} من صفحة ${PAGE}`);
    const first = await c.answer([{ questionId: "social_comments_per_post", value: "٢٠" }]);
    expect(first.outputType).toBe("propose_plan");
    const before = first.planQuote;
    expect(before.items[0].params).toMatchObject({ channels: [PAGE], perVideo: 20, topic: "الصحة والرعاية الطبية" });
    expect(before.askedVolumeMax).toBe(8000);
    const after = (await c.send("٥٠ منشور بالتعليقات")).planQuote;
    expect(after).toBeTruthy();
    expect(after.items[0].params.channels).toEqual([PAGE]);
    expect(after.items[0].params.topic).toBe("الصحة والرعاية الطبية");
    expect(JSON.stringify(after.items[0].params)).not.toContain("بالتعليقات");
    expect(after.askedVolumeMax).toBe(1000); // 50 posts x 20 comments
    expect(after.targetVolumeMax).toBe(before.targetVolumeMax); // the service still holds 20 posts per page
  });
});

describe("C2: the price of one record is on every plan", () => {
  it("one service says it in its own word; several services say it for each; nothing is a provider, English or a digit that is not Arabic-Indic", () => {
    const one = unitPriceLineAr([{ capabilitySlug: "social-facebook-comments", unitPricePoints: 1.034 }], 1.034, customerFacingCapabilityLabel)!;
    expect(one).toContain("سعر السجل");
    expect(one).toContain("تعليق");
    expect(one).toContain("ويُحتسب ما يُسلَّم ويطابق طلبك فقط");
    const many = unitPriceLineAr([{ capabilitySlug: "social-facebook-posts", unitPricePoints: 3 }, { capabilitySlug: "social-facebook-comments", unitPricePoints: 1.034 }], 3, customerFacingCapabilityLabel)!;
    expect(many).toContain("منشور");
    expect(many).toContain("تعليق");
    for (const line of [one, many]) {
      expect(line).not.toMatch(/[A-Za-z0-9]/);
      expect(line).not.toMatch(PROVIDER_WORDS);
    }
    expect(unitPriceLineAr([], 0, customerFacingCapabilityLabel)).toBeNull();
  });

  it("the plan text of a priced plan has the line, from the quote's own unit price", async () => {
    const c = await chat();
    await c.send(`${OWNER} من صفحة ${PAGE}`);
    const r = await c.answer([{ questionId: "social_comments_per_post", value: "٢٠" }]);
    const line = (r.contentAr as string).split("\n").find((entry) => entry.includes("سعر السجل"));
    expect(line).toBeTruthy();
    expect(line).toContain("تعليق");
  });

  const card = (quote: Partial<PlanQuoteData>) => renderToStaticMarkup(createElement(PlanQuoteCard, {
    quote: {
      quoteId: "q_price", summaryAr: "خطة", targetVolumeMax: 100, unitPricePoints: 3, expectedPoints: 300, quotedPoints: 345, isAffordable: true, userBalance: 5000, outputFormats: ["xlsx"],
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), status: "quoted", ...quote,
    } as PlanQuoteData,
    locked: false, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {},
  } as any));

  it("the card shows the price for one service (as before) and now for several", () => {
    const params = { channels: [PAGE], topic: "الصحة" };
    const single = card({ items: [{ capabilitySlug: "social-facebook-comments", params, targetVolumeMin: 1, targetVolumeMax: 100, unitPricePoints: 3 }] });
    expect(single).toContain('data-testid="plan-unit-price"');
    const several = card({ items: [
      { capabilitySlug: "social-facebook-posts", params, targetVolumeMin: 1, targetVolumeMax: 20, unitPricePoints: 3 },
      { capabilitySlug: "social-facebook-comments", params, targetVolumeMin: 1, targetVolumeMax: 100, unitPricePoints: 1.034 },
    ] });
    expect(several).toContain('data-testid="plan-unit-price"');
    expect(several).toContain("سعر السجل");
  });
});

describe("C3: a Facebook trend request with no page asks what it leaves open, and only that", () => {
  it("the trigger and its questions: posts and comments or not (the period has its own older question); nothing already said is asked", () => {
    const ids = (text: string) => socialDiscoveryItems(text, { otherFacebookService: true }).map((q) => q.id);
    expect(socialDiscoveryTrigger("الترندات الصحية في مصر من فيسبوك", { otherFacebookService: true })).toBe("trend");
    expect(ids("الترندات الصحية في مصر من فيسبوك")).toEqual(["social_posts_count_required", "social_comments_wanted"]);
    expect(ids("الترندات الصحية في مصر من فيسبوك ٥٠ منشور")).toEqual(["social_comments_wanted"]);
    expect(ids("الترندات الصحية في مصر من فيسبوك ٥٠ منشور بالتعليقات")).toEqual(["social_comments_per_post"]);
    expect(ids(OWNER)).toEqual(["social_comments_per_post"]); // the owner's request: the period and the posts are said, only per post is open
    expect(socialDiscoveryTrigger("الترندات الصحية في مصر من فيسبوك المنشورات فقط", { otherFacebookService: true })).toBeNull();
    expect(socialDiscoveryTrigger("عايز بيانات من فيسبوك عن الدهب")).toBeNull(); // a plain topic request keeps its route
    expect(socialDiscoveryTrigger("الترندات الصحية في مصر من تيك توك")).toBeNull();
  });

  it("in the conversation: the first turn is ONE card in plain Arabic, no provider word, no English, no emoji", async () => {
    const c = await chat();
    const r = await c.send("الترندات الصحية في مصر من فيسبوك");
    // the period question (older) or the card of this request: either way a question, never a plan
    expect(r.outputType).toBe("ask_clarification");
    expect(r.planQuote).toBeUndefined();
    const text = visible(r);
    expect(text).not.toMatch(PROVIDER_WORDS);
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
