import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";
import { FACEBOOK_REPORT_SLUG } from "../src/lib/facebookReport/constants";
import { getSocialCapability } from "../src/lib/socialSources";
import { sampleOffer } from "../src/lib/sampleFirst";
import { detectSocialIntent } from "../src/lib/socialTasks";
import { resolveTimeWindow } from "../src/lib/timeWindow";
import { understandMission } from "../src/lib/consultantCopy";
import { isStandaloneResearchRequest } from "../src/functions/shared/requestScope";

/**
 * The Facebook topic report through the real chat handler (FAKE model: it is never asked, a verified service is planned by code; FAKE database; no provider, no SQL).
 * The vitest environment lowers the per-job cap to 600; real plan sizes need the 25,000 default, so the variable is cleared here as in cap-25000-default.test.ts.
 */
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

async function session(balance = 40_000) {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  const executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
  (handler as any).llm.executeTurn = executeTurn;
  await db.createRow({ tableId: "conversations", rowId: "conv_rep", data: { userId: "user_rep", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  const send = (message: string): Promise<any> => handler.handleUserMessage({ userId: "user_rep", conversationId: "conv_rep", message, userBalance: balance }) as Promise<any>;
  const answer = (questionId: string, value: string) => send(JSON.stringify({ type: "clarification_answers", answers: [{ question: questionId, questionId, value }] }));
  return { send, answer, executeTurn };
}
const oneLine = (r: any) => String(r.contentAr);
const noInternals = (text: string) => {
  expect(text).not.toMatch(/treg|endpoint|anyapi|scrapecreators|justoneapi|usd|\$|res_|rel_|chg_|top_|promo_|adm_|facebook-topic-report/i);
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  expect(text).not.toMatch(/[*#`]|\*\*/);
};

describe("the period is never replaced (root cause: the phrase «لكل منشور» made the whole request look like a bare per-item instruction, and number words were not periods)", () => {
  it("«آخر ٣ شهور» and «آخر ثلاثة شهور» are the same three-month window; a number word is read as a number", () => {
    const digits = resolveTimeWindow("آخر ٣ شهور", { needsWindow: true });
    const words = resolveTimeWindow("آخر ثلاثة شهور", { needsWindow: true });
    expect(digits.status).toBe("resolved");
    expect(words.status).toBe("resolved");
    expect(words).toEqual(digits);
    const month = resolveTimeWindow("آخر شهر", { needsWindow: true }) as any;
    expect((digits as any).dateFrom).not.toBe(month.dateFrom);
    const days = Math.round((Date.parse((digits as any).dateTo) - Date.parse((digits as any).dateFrom)) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(89);
    expect(days).toBeLessThanOrEqual(92);
    expect(resolveTimeWindow("آخر شهرين", { needsWindow: true }).status).toBe("resolved");
  });
  it("a long request that carries its own per-post phrase is a full request, not a bare answer to a question (G2a)", () => {
    expect(isStandaloneResearchRequest("عايز تقرير عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور ١٠٠ منشور بـ ٢٠ تعليق لكل منشور")).toBe(true);
    expect(isStandaloneResearchRequest("٢٠ تعليق لكل منشور")).toBe(false);
  });
  it("the full request keeps its period end to end: the plan says the three months and the window dates, never «آخر شهر»", async () => {
    setProviderBalanceForTesting(50);
    const { send } = await session();
    const r = await send("عايز تقرير عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور ١٠٠ منشور بـ ٢٠ تعليق لكل منشور");
    expect(r.outputType).toBe("propose_plan");
    const params = r.planQuote.items[0].params;
    const from = Date.parse(params.dateFrom);
    const to = Date.parse(params.dateTo);
    const days = Math.round((to - from) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(88);
    expect(days).toBeLessThanOrEqual(93);
    expect(oneLine(r)).toContain("آخر ٣ شهور");
    expect(oneLine(r)).not.toContain("آخر شهر");
  });
  it("the same with the number written as a word", async () => {
    setProviderBalanceForTesting(50);
    const { send } = await session();
    const r = await send("عايز تقرير عن الترندات الصحية على فيسبوك في مصر آخر ثلاثة شهور ١٠٠ منشور بـ ٥ تعليقات لكل منشور");
    expect(r.outputType).toBe("propose_plan");
    expect(oneLine(r)).toContain("آخر ٣ شهور");
  });
});

describe("a period's number is a length of time, never the number of records (found while testing the question-by-question flow: «آخر ٣ شهور» became a 3-comment plan)", () => {
  it("the stored answers of the card carry the period's number before the counts: the counts are still the customer's", async () => {
    setProviderBalanceForTesting(50);
    const { send } = await session();
    const base = "عايز تقرير عن الترندات الصحية على فيسبوك دولة التقرير المطلوبة: في مصر الفترة المطلوبة: آخر ٣ شهور عدد المنشورات المطلوب: ٢٠ منشور عدد التعليقات لكل منشور: ٥ تعليق من كل منشور";
    const r = await send(base);
    expect(r.planQuote.items[0].targetVolumeMax).toBe(100);
    expect(r.planQuote.items[0].params).toMatchObject({ videoCount: 20, perVideo: 5 });
  });
  it("a request that gives its period first and no count at all is not a 3-record request (the older keyword flows had the same defect)", () => {
    for (const text of ["آخر ٣ شهور تعليقات عن الترندات الصحية على فيسبوك", "آخر ثلاثة شهور تعليقات منشورات الترندات الصحية على فيسبوك", "خلال ٣٠ يوم تعليقات عن الدوري على تيك توك"]) {
      expect(understandMission(text).volume, text).toBeNull();
    }
    expect(understandMission("٣٠٠ تعليق عن الدوري آخر ٣ شهور على تيك توك").volume).toBe(300);
  });
});

describe("the Facebook wording: posts and Pages, never «videos or channel name»", () => {
  it("a Facebook request asks for the post topic or the Page, with no YouTube words", async () => {
    const { send } = await session();
    const r = await send("عايز تعليقات من فيسبوك");
    const text = JSON.stringify([r.contentAr, r.clarificationItems]);
    expect(text).not.toMatch(/الفيديوهات أو اسم القناة/);
    expect(text).toMatch(/المنشورات|الصفحة/);
  });
});

describe("routing: a topic report is its own service; a plain keyword request is untouched", () => {
  it("the word «تقرير» with Facebook, a topic and (a country) is a report; the same request without it is not", () => {
    expect(detectSocialIntent("عايز تقرير عن الترندات الصحية على فيسبوك").report).toBe(true);
    expect(detectSocialIntent("عايز ٥٠ بوست وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر").report).not.toBe(true);
  });
  it("it is ONE capability and ONE item per quote, priced per delivered comment", async () => {
    setProviderBalanceForTesting(50);
    const { send, executeTurn } = await session();
    const r = await send("عايز تقرير عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور ٣٠٠ منشور بـ ٥ تعليقات لكل منشور");
    expect(executeTurn).not.toHaveBeenCalled();
    expect(r.outputType).toBe("propose_plan");
    const q = r.planQuote;
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ capabilitySlug: FACEBOOK_REPORT_SLUG, targetVolumeMax: 1500, unitPricePoints: 3.025 });
    expect(q.items[0].params).toMatchObject({ region: "EG", query: "الترندات الصحية", perVideo: 5, videoCount: 300 });
    expect(q.expectedPoints).toBe(4538);
    expect(q.quotedPoints).toBe(5219);
    expect(q.expectedPoints).toBeLessThanOrEqual(q.quotedPoints);
    expect(q.quotedPoints).toBeLessThanOrEqual(25_000);
    expect(q.outputFormats ?? q.plan?.outputFormats).toEqual(["xlsx", "pdf"]);
    const text = oneLine(r);
    expect(text).toContain("٤٥٣٨ نقطة");
    expect(text).toContain("٥٢١٩ نقطة");
    expect(text).toContain("٣٠٢٫٥ نقطة لكل ١٠٠ تعليق");
    expect(text).toContain("ملف إكسل للبيانات");
    expect(text).toContain("ملف بي دي إف منفصل للمنهجية");
    noInternals(text);
    expect(text).not.toMatch(/[A-Za-z]/);
  });
  it("100 posts × 20 comments is cut to the 1,500-comment ceiling (75 posts), and the plan says so with the same 75 in both of its lines", async () => {
    setProviderBalanceForTesting(50);
    const { send } = await session();
    const r = await send("عايز تقرير عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور ١٠٠ منشور بـ ٢٠ تعليق لكل منشور");
    expect(r.planQuote.items[0].targetVolumeMax).toBe(1500);
    const text = oneLine(r);
    expect(text).toContain("حتى ٧٥ منشور");
    expect(text).toContain("- المنشورات: ٧٥ منشور");
    expect(text).not.toContain("- المنشورات: ١٠٠ منشور");
    expect(text).toContain("هذا حدّ الخدمة نفسها لكل طلب، وليس رصيدك");
  });
  it("no «sample first» offer is made for the report (one analysed set cannot be sampled and completed later)", async () => {
    setProviderBalanceForTesting(50);
    const { send } = await session();
    const r = await send("عايز تقرير عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور ٣٠٠ منشور بـ ٥ تعليقات لكل منشور");
    expect(oneLine(r)).not.toContain("عينة أولًا");
    expect(r.planQuote.explorationOffer).toBeUndefined();
    const keyword = { items: [{ capabilitySlug: "social-facebook-keyword-comments", params: {} }], targetVolumeMax: 1500, unitPricePoints: 12.925 };
    expect(sampleOffer(keyword)).not.toBeNull();
    expect(sampleOffer({ ...keyword, items: [{ capabilitySlug: FACEBOOK_REPORT_SLUG, params: {} }], unitPricePoints: 3.025 })).toBeNull();
  });
});

describe("the questions asked, in order, and nothing guessed", () => {
  it("a bare request asks the country first, then the period, then the posts and the comments per post, then plans with the answers", async () => {
    setProviderBalanceForTesting(50);
    const { send, answer } = await session();
    let r = await send("عايز تقرير عن الترندات الصحية على فيسبوك");
    expect(r.outputType).toBe("ask_clarification");
    expect(r.clarificationItems.map((q: any) => q.id)).toEqual(["social_report_country_required"]);
    expect(oneLine(r)).not.toMatch(/آخر شهر/); // no period is assumed before it is asked
    r = await answer("social_report_country_required", "مصر");
    expect(r.clarificationItems.map((q: any) => q.id)).toEqual(["social_time_required"]);
    r = await answer("social_time_required", "آخر ٣ شهور");
    expect(r.clarificationItems.map((q: any) => q.id)).toEqual(["social_posts_count_required", "social_comments_per_post"]);
    r = await answer("social_posts_count_required", "٢٠");
    r = await answer("social_comments_per_post", "٥");
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].params).toMatchObject({ region: "EG", videoCount: 20, perVideo: 5 });
    expect(r.planQuote.items[0].params.dateFrom).toBeTruthy();
    expect(r.planQuote.items[0].targetVolumeMax).toBe(100);
  });
  it("a country or a topic with no vetted Pages is told so in one Arabic message, with no plan and no price", async () => {
    const { send } = await session();
    for (const [message, what] of [["عايز تقرير عن سوق السيارات على فيسبوك في مصر آخر ٣ شهور", "سوق السيارات"], ["عايز تقرير عن الترندات الصحية على فيسبوك في السعودية آخر ٣ شهور", "السعودية"]] as const) {
      const r = await send(message);
      expect(r.planQuote).toBeUndefined();
      expect(oneLine(r)).toContain("تقرير فيسبوك الكامل متاح حاليًا لموضوعات الصحة في مصر فقط");
      expect(oneLine(r)).toContain(what);
      noInternals(oneLine(r));
      expect(oneLine(r)).not.toMatch(/[A-Za-z]/);
    }
  });
  it("the plain keyword flow is unchanged: no country, period or report question, and it never becomes a report", async () => {
    const { send } = await session();
    const r = await send("عايز ٥٠ بوست وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر");
    expect(r.clarificationItems?.map((q: any) => q.id) ?? []).not.toContain("social_report_country_required");
    expect(JSON.stringify(r.planQuote ?? {})).not.toContain(FACEBOOK_REPORT_SLUG);
  });
});

describe("the capacity gate and the hold, with the report's own cost basis (0.00055 USD a comment)", () => {
  const FULL = "عايز تقرير عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور ٣٠٠ منشور بـ ٥ تعليقات لكل منشور";
  it("1,500 comments estimate 0.825 USD; a provider balance that cannot hold it (safe budget 0.45 USD) REFUSES the plan in one Arabic sentence and nothing is quoted or held", async () => {
    setProviderBalanceForTesting(0.5);
    const { send } = await session();
    const r = await send(FULL);
    expect(r.planQuote).toBeUndefined();
    expect(r.outputType).not.toBe("propose_plan");
    expect(oneLine(r)).toMatch(/^هذا الطلب أكبر من طاقة الاستخراج المتاحة اليوم؛ تتسع الطاقة الحالية لنحو ٨١٨ سجلًا فقط\./);
    expect(oneLine(r)).toContain("ولم يُحجز أي رصيد");
    noInternals(oneLine(r));
    expect(oneLine(r)).not.toMatch(/[A-Za-z]/);
  });
  it("the same plan passes the gate when the balance holds 0.825 USD plus the 10% margin (a safe budget of 0.9 USD)", async () => {
    setProviderBalanceForTesting(1);
    const { send } = await session();
    const r = await send(FULL);
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.quotedPoints).toBe(5219);
  });
  it("the customer's own balance decides affordability: a balance under the hold is stated, never silently reduced", async () => {
    setProviderBalanceForTesting(50);
    const { send } = await session(1000);
    const r = await send(FULL);
    expect(r.planQuote?.isAffordable).toBe(false);
  });
});

describe("the capability definition", () => {
  it("is a topic report with the Facebook ceilings and the report formats; its comments are never reviewed by a model", () => {
    const cap = getSocialCapability(FACEBOOK_REPORT_SLUG) as any;
    expect(cap).toBeTruthy();
    expect(cap.topicReport).toBe(true);
    expect(cap.maxRows).toBe(1500);
    expect(cap.maxVideos ?? cap.maxPosts ?? 300).toBe(300);
  });
});
