import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * A Facebook page the customer names only by its DISPLAY name («صفحة اليوم السابع»). Evidence: the plan was approved, the source returned no rows in
 * six seconds and the job failed. No verified service finds a page by that name (they take a link, a username or an id), so the question comes
 * BEFORE the plan, once, in plain Arabic; the answer (a link or a username) makes the plan; nothing is held for a source that cannot answer.
 * The model is never called and no provider is called.
 */
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { createChatDb } from "./helpers/chatSession";
import { facebookPageDisplayName, facebookPageNameNeedsLink, socialDiscoveryItems, socialDiscoveryTrigger, withLinkScheme, FACEBOOK_PAGE_LINK_RETRY_AR } from "../src/lib/socialDiscoveryCard";
import { facebookPageNameIn } from "../src/lib/socialTasks";

const REQUEST = "١٠ بوست من صفحة اليوم السابع على فيسبوك";
const PROVIDER_WORDS = /treg|icypeas|firecrawl|tikhub|apify|openai|anthropic|supabase|usd|\$|endpoint|crawl4ai|anyapi|scrapecreators/i;

class Chat {
  private db: any = createChatDb();
  private handler: ChatHandler;
  constructor() {
    this.handler = new ChatHandler(this.db);
    (this.handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  }
  async start() {
    await this.db.createRow({ tableId: "conversations", rowId: "conv_fb", data: { userId: "user_fb", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    return this;
  }
  send(message: string): Promise<any> { return this.handler.handleUserMessage({ userId: "user_fb", conversationId: "conv_fb", message, userBalance: 20000 }) as Promise<any>; }
  answer(answers: Array<{ questionId: string; value?: string; skipped?: boolean }>) {
    return this.send(JSON.stringify({ type: "clarification_answers", answers: answers.map((a) => ({ question: a.questionId, ...a })) }));
  }
}
const chat = () => new Chat().start();
const visible = (r: any) => [r.contentAr, r.clarificationIntro, ...(r.clarificationQuestions || []), ...((r.clarificationItems || []).flatMap((q: any) => [q.text, ...(q.options || [])]))].filter(Boolean).join(" \n ");

describe("B: a Facebook page named only by its display name is asked for its link before any plan", () => {
  it("reads the case: a name with Arabic letters or spaces needs a link; a link, a username, an «@» handle and a request with no page do not", () => {
    expect(facebookPageDisplayName(REQUEST)).toBe("اليوم السابع");
    expect(facebookPageNameNeedsLink(REQUEST)).toBe(true);
    for (const text of [
      "١٠ بوست من صفحة https://www.facebook.com/youm7 على فيسبوك",
      "١٠ بوست من صفحة youm7 على فيسبوك",
      "هات ١٠ بوست من صفحة @youm7 على فيسبوك",
      "١٠ بوست من فيسبوك",
      "الترندات الصحية في مصر من فيسبوك",
    ]) expect(facebookPageNameNeedsLink(text), text).toBe(false);
    expect(socialDiscoveryTrigger(REQUEST)).toBe("page_link");
  });

  it("the card is ONE free-text question that names the page and says what is needed, in Arabic only", () => {
    const items = socialDiscoveryItems(REQUEST);
    expect(items.map((q) => q.id)).toEqual(["social_page_required"]);
    expect(items[0]).toMatchObject({ type: "free", options: [], allowOther: true });
    expect(items[0].text).toContain("اليوم السابع");
    expect(items[0].text).toContain("رابط");
  });

  it("the customer's turn: a question, not a plan, nothing priced, no provider word, no English, no emoji", async () => {
    const c = await chat();
    const r = await c.send(REQUEST);
    expect(r.outputType).toBe("ask_clarification");
    expect(r.planQuote).toBeUndefined();
    expect((r.clarificationItems as any[]).map((q) => q.id)).toEqual(["social_page_required"]);
    const text = visible(r);
    expect(text).toContain("اليوم السابع");
    expect(text).not.toMatch(PROVIDER_WORDS);
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("a link answers it: the plan is the page-posts service for that link (typed with or without «https://»)", async () => {
    for (const [value, channel] of [["https://www.facebook.com/youm7", "https://www.facebook.com/youm7"], ["facebook.com/youm7", "https://facebook.com/youm7"]]) {
      const c = await chat();
      await c.send(REQUEST);
      const r = await c.answer([{ questionId: "social_page_required", value }]);
      expect(r.outputType, value).toBe("propose_plan");
      expect(r.planQuote.items[0], value).toMatchObject({ capabilitySlug: "social-facebook-posts", params: { channel } });
    }
  });

  it("a username answers it too; the plan reads that username, never the display name typed first", async () => {
    const c = await chat();
    await c.send(REQUEST);
    const r = await c.answer([{ questionId: "social_page_required", value: "youm7" }]);
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0]).toMatchObject({ capabilitySlug: "social-facebook-posts", params: { channel: "youm7" } });
    expect(facebookPageNameIn("١٠ بوست من صفحة اليوم السابع على فيسبوك الصفحة المطلوبة: صفحة youm7 ·")).toBe("youm7");
  });

  it("an answer that is again only a name is not asked a second time as a card: one plain sentence says what is needed", async () => {
    const c = await chat();
    await c.send(REQUEST);
    const r = await c.answer([{ questionId: "social_page_required", value: "صفحة اليوم السابع الرسمية" }]);
    expect(r.outputType).not.toBe("propose_plan");
    expect(r.clarificationItems ?? []).toEqual([]);
    expect(r.contentAr).toContain(FACEBOOK_PAGE_LINK_RETRY_AR);
  });

  it("skipping the question gets the same plain sentence, never a plan on a name no service can read", async () => {
    const c = await chat();
    await c.send(REQUEST);
    const r = await c.answer([{ questionId: "social_page_required", skipped: true }]);
    expect(r.outputType).not.toBe("propose_plan");
    expect(r.contentAr).toContain(FACEBOOK_PAGE_LINK_RETRY_AR);
  });

  it("a link typed without its scheme is made a link", () => {
    expect(withLinkScheme("facebook.com/youm7")).toBe("https://facebook.com/youm7");
    expect(withLinkScheme("www.facebook.com/youm7")).toBe("https://www.facebook.com/youm7");
    expect(withLinkScheme("youm7")).toBe("youm7");
    expect(withLinkScheme("https://www.facebook.com/youm7")).toBe("https://www.facebook.com/youm7");
  });

  it("«صفحة https://…» is the link and never also a page called «https»", () => {
    expect(facebookPageNameIn("١٠ بوست من صفحة https://www.facebook.com/youm7")).toBeNull();
  });
});

describe("B: a source that returns no rows is never charged (read from the worker)", () => {
  const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
  it("the first page with nothing delivered releases the whole hold and answers with chargedCredits 0", () => {
    const at = worker.indexOf("const rel = await executeReleaseConfirmation(adminClient, jobId, emptyErrorAr);");
    expect(at).toBeGreaterThan(0);
    const branch = worker.slice(at, at + 700);
    expect(branch).toContain("chargedCredits: 0");
    expect(branch).toContain("deliveredUnits: 0");
    expect(branch).toContain("released: true");
  });
});
