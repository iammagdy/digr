import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PHASE 2: what a request without dates means («ترند», «أحدث», «الأكثر انتشارًا»), the window an event gives, the capacity of a plan, a Facebook page named
 * by its name, and the team-pages wording of the chain. The model is never called (a call fails the test); no provider is called.
 */
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { createChatDb } from "./helpers/chatSession";
import { knownEventWindow, parseRelativeWindow, requestRecencyIntent, resolveTimeWindow, windowIsStatedByCustomer, POPULAR_SCOPE_REASON_AR, RECENT_WINDOW_REASON_AR } from "../src/lib/timeWindow";
import { understandMission } from "../src/lib/consultantCopy";
import { detectSocialIntent, facebookPageNameIn } from "../src/lib/socialTasks";
import { canonicalSocialParams, facebookPageUrl, getSocialCapability, socialCapabilityForIntent } from "../src/lib/socialSources";
import { chainItemFor, detectContactIntent } from "../src/lib/server/multiProvider/planUpgrade";
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import { youtubeRecencyFor } from "../src/lib/youtubeRecency";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";

const TODAY = new Date("2026-10-22T12:00:00Z");

async function plan(message: string) {
  const chatDb: any = createChatDb();
  const handler = new ChatHandler(chatDb);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  await chatDb.createRow({ tableId: "conversations", rowId: "conv_p2", data: { userId: "user_p2", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  return (await handler.handleUserMessage({ userId: "user_p2", conversationId: "conv_p2", message, userBalance: 20000 })) as any;
}

describe("a request that says «ترند / أحدث / الأكثر انتشارًا» and gives no dates", () => {
  it("the words: recent beats popular, dates are not words, a plain topic has no intent", () => {
    for (const text of ["هات ٥٠ تغريدة عن ترند كأس العالم", "أحدث الفيديوهات عن كرة السلة", "الأحدث عن الأهلي", "trending posts about football", "latest news"]) expect(requestRecencyIntent(text), text).toBe("recent");
    for (const text of ["٥٠ تعليق من الفيديوهات الأكثر انتشارًا عن كرة السلة", "الفيديوهات الأعلى مشاهدة", "most viewed videos about cats", "فيديوهات فيرال"]) expect(requestRecencyIntent(text), text).toBe("popular");
    expect(requestRecencyIntent("ترند والأكثر مشاهدة")).toBe("recent");
    for (const text of ["تغريدات عن كأس العالم", "تعليقات فيديوهات كرة السلة", "آخر شهر عن الأهلي", ""]) expect(requestRecencyIntent(text), text).toBeNull();
  });

  it("«ترند كأس العالم» no longer takes the dates of the tournament (11 June to 19 July 2026, over): a rolling month ending today, with the reason said", () => {
    const window = resolveTimeWindow("هات ٥٠ تغريدة عن ترند كأس العالم", { needsWindow: true, today: TODAY });
    expect(window).toMatchObject({ status: "resolved", source: "default", dateFrom: "2026-09-22", dateTo: "2026-10-22", reasonAr: RECENT_WINDOW_REASON_AR });
    expect((window as any).dateTo >= "2026-10-22").toBe(true);
    expect(knownEventWindow("ترند كأس العالم", TODAY)).toBeNull();
    expect(knownEventWindow("أحدث تغريدات كأس العالم", TODAY)).toBeNull();
  });

  it("the event still gives its window when the request is about the event itself, and when the event is running now", () => {
    expect(knownEventWindow("تغريدات عن كأس العالم ٢٠٢٦", TODAY)).toMatchObject({ from: "2026-06-11", to: "2026-07-19" });
    expect(resolveTimeWindow("تغريدات عن كأس العالم", { needsWindow: true, today: TODAY })).toMatchObject({ source: "event", dateFrom: "2026-06-11" });
    // inside the tournament, a trend request keeps the event's window (it has not ended)
    expect(knownEventWindow("ترند كأس العالم", new Date("2026-07-01T12:00:00Z"))).toMatchObject({ from: "2026-06-11", to: "2026-07-19" });
  });

  it("«الأكثر انتشارًا» is an open scope on the plan (no window drops the most viral videos for being old), with the reason said", () => {
    const window = resolveTimeWindow("٥٠ تعليق من فيديوهات تيك توك الأكثر انتشارًا عن كرة السلة", { needsWindow: true, today: TODAY });
    expect(window).toMatchObject({ status: "resolved", source: "open_scope", reasonAr: POPULAR_SCOPE_REASON_AR });
    expect(window).not.toHaveProperty("dateFrom");
  });

  it("dates the customer wrote always win: stated dates, a relative period and a year", () => {
    expect(resolveTimeWindow("هات تغريدات عن ترند كأس العالم من ١ سبتمبر ٢٠٢٦ إلى ١٥ سبتمبر ٢٠٢٦", { needsWindow: true, today: TODAY })).toMatchObject({ source: "stated", dateFrom: "2026-09-01", dateTo: "2026-09-15" });
    expect(resolveTimeWindow("أحدث تغريدات عن كأس العالم آخر أسبوع", { needsWindow: true, today: TODAY })).toMatchObject({ source: "relative" });
    expect(resolveTimeWindow("ترند كرة السلة في سنة 2025", { needsWindow: true, today: TODAY })).toMatchObject({ source: "stated", dateFrom: "2025-01-01", dateTo: "2025-12-31" });
  });

  it("the plan of the X request: the rolling month, no question, no event dates; the count is the one asked", async () => {
    const r = await plan("هات ٥٠ تغريدة عن ترند كأس العالم");
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-x-posts");
    expect(item.targetVolumeMax).toBe(50);
    expect(item.params.dateTo >= "2026-10-01").toBe(true);
    expect(item.params.dateFrom).not.toBe("2026-06-11");
    expect(item.params.dateTo).not.toBe("2026-07-19");
    expect(String(r.contentAr)).not.toContain("جرت من");
  });

  it("the plan of the TikTok request: 50 comments of the most viral videos about the topic, no date filter, nothing collapses to 1", async () => {
    const r = await plan("٥٠ تعليق من فيديوهات تيك توك الأكثر انتشارًا عن كرة السلة في مصر");
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-tiktok-comments");
    expect(item.targetVolumeMax).toBe(50);
    expect(item.params).toMatchObject({ query: "كرة السلة", region: "EG" });
    expect(item.params).not.toHaveProperty("dateFrom");
    expect(item.params).not.toHaveProperty("dateTo");
    expect(r.planQuote.capacityConstrained).toBeFalsy();
  });

  it("an explicit window in the request reaches the plan untouched, whatever trend words it also carries", async () => {
    const r = await plan("هات ٥٠ تغريدة عن ترند كأس العالم من ١١ يونيو ٢٠٢٦ إلى ١٩ يوليو ٢٠٢٦");
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].params).toMatchObject({ dateFrom: "2026-06-11", dateTo: "2026-07-19" });
  });

  it("the mission reads the same: the window the plan card shows is the window the worker gets", () => {
    const x: any = understandMission("هات ٥٠ تغريدة عن ترند كأس العالم", { today: TODAY });
    expect(x.window).toMatchObject({ source: "default", dateTo: "2026-10-22" });
    const t: any = understandMission("٥٠ تعليق من فيديوهات تيك توك الأكثر انتشارًا عن كرة السلة في مصر", { today: TODAY });
    expect(t.window).toMatchObject({ source: "open_scope" });
    expect(t.volume).toBe(50);
  });
});

describe("the capacity of a plan does not depend on dates", () => {
  afterEach(() => resetProviderBalanceCacheForTesting());

  it("the same request with and without a window, a trend word or a popularity word has the same capacity", async () => {
    const volumes: number[] = [];
    for (const text of ["٥٠ تعليق من فيديوهات تيك توك عن كرة السلة في مصر", "٥٠ تعليق من فيديوهات تيك توك الأكثر انتشارًا عن كرة السلة في مصر", "٥٠ تعليق من فيديوهات تيك توك عن كرة السلة في مصر آخر أسبوع", "٥٠ تعليق من فيديوهات تيك توك عن ترند كرة السلة في مصر"]) {
      const r = await plan(text);
      expect(r.outputType, text).toBe("propose_plan");
      volumes.push(r.planQuote.items[0].targetVolumeMax);
    }
    expect(volumes).toEqual([50, 50, 50, 50]);
  });

  it("what DOES cut the count is the live provider budget at plan time (balance, daily limit, per-user limit): with almost none left a plan shrinks to 1 record and says the capacity is limited", async () => {
    setProviderBalanceForTesting(0.0001);
    const r = await plan("٥٠ تعليق من فيديوهات تيك توك الأكثر انتشارًا عن كرة السلة في مصر");
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].targetVolumeMax).toBe(1);
    expect(r.planQuote.capacityConstrained).toBe(true);
    expect(String(r.contentAr)).toContain("سعة المصدر المتاحة الآن محدودة");
  });
});

describe("YouTube: «أحدث» reaches the search as the newest-first order", () => {
  const NOW = Date.parse("2026-10-22T12:00:00Z");
  const ok = (rows: Array<Record<string, any>>): SocialCallOutcome => ({ ok: true, httpStatus: 200, data: { ok: true, rows }, costMicro: 900, tregCallId: "c" });

  it("the plan of «أحدث تعليقات يوتيوب عن كرة القدم» carries the rolling window; the search asks for the newest videos with the sort and a bucket that reaches it", async () => {
    const r = await plan("هات ٣٠ تعليق من أحدث فيديوهات يوتيوب عن كرة القدم");
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-youtube-comments");
    expect(item.params.dateFrom).toBeTruthy();
    const seen: Array<{ endpoint: string; params: Record<string, any> }> = [];
    const call: SocialCall = async (source, params) => { seen.push({ endpoint: source.endpointId, params }); return ok([]); };
    await runSocialChunk({ jobId: "job_yt", userId: "u", step: 0, endpointId: "crawl4ai.youtube.video.comments", capabilitySlug: "social-youtube-comments", method: "POST", params: { query: "كرة القدم", dateFrom: "2026-09-22", dateTo: "2026-10-22" }, paginationStrategy: "cursor", cursor: null, pageSize: 30, remainingNeeded: 30, targetVolumeMax: 30, deliveredSoFar: 0 } as any, { call, now: () => NOW });
    expect(seen[0].endpoint).toBe("tikhub.youtube.search.videos");
    expect(seen[0].params).toMatchObject({ keyword: "كرة القدم", sort_by: "upload_date" });
  });

  it("the month-long window uses the year bucket on purpose: the order is newest first, so the bucket only has to reach the window's start (30-31 days)", () => {
    expect(youtubeRecencyFor("2026-09-22", "2026-10-22", NOW)).toEqual({ upload_date: "year", sort_by: "upload_date" });
    expect(youtubeRecencyFor("2026-10-10", "2026-10-22", NOW)).toEqual({ upload_date: "month", sort_by: "upload_date" });
  });
});

describe("a public Facebook page named by its name", () => {
  it("the name is read after «صفحة» and never as a topic", () => {
    expect(facebookPageNameIn("٢٠ بوست من صفحة اليوم السابع على فيسبوك")).toBe("اليوم السابع");
    expect(facebookPageNameIn("هات بوستات صفحة نيك على الفيس")).toBe("نيك");
    expect(facebookPageNameIn("٢٠ بوست من فيسبوك")).toBeNull();
    expect(facebookPageNameIn("بوستات صفحات فيسبوك عن الطاقة")).toBeNull();
    const intent = detectSocialIntent("٢٠ بوست من صفحة اليوم السابع على فيسبوك");
    expect(intent).toMatchObject({ platform: "facebook", task: "page_posts", pageName: "اليوم السابع" });
    expect(socialCapabilityForIntent(intent)?.slug).toBe("social-facebook-posts");
    const cap = getSocialCapability("social-facebook-posts")!;
    expect(canonicalSocialParams(cap, intent, "٢٠ بوست من صفحة اليوم السابع على فيسبوك", {})).toEqual({ channel: "اليوم السابع" });
  });

  it("the plan is the page-posts service for that page, with no period question and no model call", async () => {
    const r = await plan("٢٠ بوست من صفحة اليوم السابع على فيسبوك");
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0]).toMatchObject({ capabilitySlug: "social-facebook-posts", params: { channel: "اليوم السابع" }, targetVolumeMax: 20 });
    expect((r.clarificationItems ?? []).length).toBe(0);
    expect(String(r.contentAr)).not.toMatch(/tikhub|crawl4ai|anyapi|scrapecreators|treg|post\/123/i);
  });

  it("with a link or a username the plan is the same service for that address", async () => {
    for (const [text, channel] of [["٢٠ بوست من صفحة https://www.facebook.com/youm7", "https://www.facebook.com/youm7"], ["هات ٢٠ بوست من صفحة @youm7 على فيسبوك", "@youm7"]] as const) {
      const r = await plan(text);
      expect(r.planQuote.items[0]).toMatchObject({ capabilitySlug: "social-facebook-posts", params: { channel } });
    }
  });

  it("the sources that take an ADDRESS get one only when the channel is one; a display name goes to the source that takes a page name", async () => {
    expect(facebookPageUrl("https://www.facebook.com/youm7")).toBe("https://www.facebook.com/youm7");
    expect(facebookPageUrl("@youm7")).toBe("https://www.facebook.com/youm7");
    expect(facebookPageUrl("youm7")).toBe("https://www.facebook.com/youm7");
    expect(facebookPageUrl("اليوم السابع")).toBeNull();
    const posts = (n: number) => Array.from({ length: n }, (_, i) => ({ post_id: `f${i}`, text: `منشور ${i}`, created_time: "2026-10-10T08:00:00Z", url: `https://www.facebook.com/x/posts/${i}` }));
    const run = async (channel: string) => {
      const seen: Array<{ endpoint: string; params: Record<string, any> }> = [];
      const call: SocialCall = async (source, params) => { seen.push({ endpoint: source.endpointId, params }); return { ok: true, httpStatus: 200, data: { ok: true, rows: posts(5) }, costMicro: 600, tregCallId: "c" }; };
      const out = await runSocialChunk({ jobId: "job_fb", userId: "u", step: 0, endpointId: "anyapi.facebook.user.posts", capabilitySlug: "social-facebook-posts", method: "POST", params: { channel }, paginationStrategy: "cursor", cursor: null, pageSize: 20, remainingNeeded: 20, targetVolumeMax: 20, deliveredSoFar: 0 } as any, { call, now: () => Date.now() });
      return { seen, out };
    };
    const byName = await run("اليوم السابع");
    expect(byName.seen.map((s) => s.endpoint)).toEqual(["crawl4ai.facebook.user.posts"]);
    expect(byName.seen[0].params).toMatchObject({ page: "اليوم السابع" });
    expect(byName.out.ok).toBe(true);
    expect(byName.out.rows.length).toBe(5);
    const byHandle = await run("youm7");
    expect(byHandle.seen[0].endpoint).toBe("anyapi.facebook.user.posts");
    expect(byHandle.seen[0].params).toMatchObject({ url: "https://www.facebook.com/youm7" });
  });
});

describe("«من صفحات فريق الشركات» reaches the chain for every way of naming who is wanted", () => {
  const item = (slug: string) => [{ capabilitySlug: slug, params: {}, targetVolumeMin: 1, targetVolumeMax: 20 }];
  const WANTED = [
    "عايز ٢٠ من صناع القرار في شركات الأدوية في مصر من صفحات فريق الشركات",
    "عايز ٢٠ صانع قرار في شركات الأدوية في مصر من صفحات فريق الشركات",
    "عايز مسؤولي المشتريات في شركات الأدوية في مصر من صفحات فريق الشركات",
    "٢٠ مدير مشتريات شركات أدوية مصر من صفحات فريق الشركات",
    "هات المديرين التنفيذيين لشركات الأدوية في مصر من صفحات فريق الشركات",
    "رئيس مجلس الإدارة في شركات الأدوية في مصر من صفحات فريق الشركات",
    "مؤسسي شركات الأدوية في مصر من صفحات الفريق على مواقع الشركات",
    "CEO of pharmaceutical companies in Egypt from the companies team pages",
  ];
  it("each phrase is a chain request for the people service and for the company service", () => {
    for (const text of WANTED) {
      expect(detectContactIntent(text), text).toMatchObject({ decisionMaker: true, teamPagesNamed: true });
      for (const slug of ["professional-people-search", "icypeas-companies-search"]) expect(chainItemFor(item(slug) as any, text), `${slug} | ${text}`).not.toBeNull();
    }
  });
  it("without the team pages, or with a company item and no person asked for, nothing changes: the plain service keeps the request", () => {
    expect(chainItemFor(item("professional-people-search") as any, "عايز ٢٠ من صناع القرار في شركات الأدوية في مصر")).toBeNull();
    expect(chainItemFor(item("professional-people-search") as any, "عايز مسؤولي المشتريات في شركات الأدوية في مصر")).toBeNull();
    expect(chainItemFor(item("icypeas-companies-search") as any, "شركات الأدوية في مصر من صفحات فريق الشركات")).toBeNull();
  });
});

describe("a window the plan proposes is not a period the customer stated", () => {
  it("only dates, a relative period and a known event are the customer's own; the rolling month and the open scope are proposals (the model may not add a period on top of them)", () => {
    const of = (text: string) => windowIsStatedByCustomer(resolveTimeWindow(text, { needsWindow: true, today: TODAY }));
    expect(of("تغريدات من ١ سبتمبر ٢٠٢٦ إلى ١٥ سبتمبر ٢٠٢٦")).toBe(true);
    expect(of("تغريدات آخر أسبوع")).toBe(true);
    expect(of("تغريدات عن كأس العالم")).toBe(true);
    expect(of("هات ٥٠ تغريدة عن ترند كأس العالم")).toBe(false);
    expect(of("الفيديوهات الأكثر انتشارًا عن كرة السلة")).toBe(false);
    expect(of("تغريدات عن كرة السلة")).toBe(false);
  });
});

describe("the window helpers keep their old meaning", () => {
  it("«آخر شهر» is still a month back from today", () => {
    expect(parseRelativeWindow("آخر شهر", TODAY)).toMatchObject({ from: "2026-09-22", to: "2026-10-22" });
  });
});
