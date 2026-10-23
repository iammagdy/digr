import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import PlanQuoteCard from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { acceptQuoteSupabase } from "../src/lib/supabase/quoteAccept";
import { planCountLineAr } from "../src/lib/planCounts";
import { chargeForUnits, recordUnitPricePoints, reserveForUnits, maxVolumeUnderCap } from "../src/lib/recordPricing";
import { getSocialCapability, canonicalSocialParams, socialCapabilityForIntent } from "../src/lib/socialSources";
import { detectSocialIntent } from "../src/lib/socialTasks";
import { createChatDb } from "./helpers/chatSession";

/**
 * The Facebook keyword mission as the customer meets it: the plan (ONE item), the plan card, the hold, the honest sentences when the request is cut or cannot be held, and the
 * acceptance of a one-item quote by the existing code (acceptQuoteSupabase is not changed). The model is never asked: a verified service is planned by code. FAKE database only.
 */
const SLUG = "social-facebook-keyword-comments";
const UNIT = 12.925;
const PROVIDER_WORDS = /treg|icypeas|firecrawl|context\.dev|tikhub|apify|justone|anyapi|scrapecreators|openai|anthropic|resend|supabase|usd|\$|endpoint/i;

beforeEach(() => {
  vi.stubEnv("JOB_MAX_POINTS_CAP", ""); // the cap in force is the 25,000 default (the older suites run with it lowered)
  resetProviderBalanceCacheForTesting();
  setProviderBalanceForTesting(50);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetProviderBalanceCacheForTesting();
});

async function ask(message: string, balance = 40_000) {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  const executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
  (handler as any).llm.executeTurn = executeTurn;
  await db.createRow({ tableId: "conversations", rowId: "conv_fb", data: { userId: "user_fb", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  const r: any = await handler.handleUserMessage({ userId: "user_fb", conversationId: "conv_fb", message, userBalance: balance });
  return { r, executeTurn };
}
const cardText = (quote: any, available: number) =>
  renderToStaticMarkup(createElement(PlanQuoteCard, { quote, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const OWNER = "عايز ٣٠٠ منشور على فيسبوك عن الترندات الصحية مع ٥ تعليقات لكل منشور في مصر";

describe("the service: one item, priced by the one shared function", () => {
  it("a Facebook request for the comments of posts found by a keyword is served by the keyword service; a link or a page keeps the older one", () => {
    expect(socialCapabilityForIntent(detectSocialIntent(OWNER))?.slug).toBe(SLUG);
    expect(socialCapabilityForIntent(detectSocialIntent("هات تعليقات هذا المنشور https://www.facebook.com/youm7/posts/123456789"))?.slug).toBe("social-facebook-comments");
    expect(socialCapabilityForIntent(detectSocialIntent("هات تعليقات منشورات صفحة اليوم السابع على فيسبوك"))?.slug).toBe("social-facebook-comments");
    expect(socialCapabilityForIntent(detectSocialIntent("عايز ٥٠ بوست من صفحة اليوم السابع على فيسبوك"))?.slug).toBe("social-facebook-posts");
  });

  it("the unit price is built by the shared per-record rule from the stated cost basis (0.00235 USD a delivered comment x 5,500) and fits the job cap", () => {
    expect(recordUnitPricePoints(SLUG)).toBe(UNIT);
    expect(chargeForUnits(1500, UNIT)).toBe(19_388);
    expect(reserveForUnits(1500, UNIT)).toBe(22_296);
    expect(maxVolumeUnderCap(25_000, UNIT)).toBeGreaterThanOrEqual(getSocialCapability(SLUG)!.maxRows);
    expect(getSocialCapability(SLUG)!.maxRows).toBe(1500);
    expect(getSocialCapability(SLUG)!.maxVideos).toBe(300);
    // the existing Facebook comments service keeps its price: nothing existing was repriced
    expect(recordUnitPricePoints("social-facebook-comments")).toBe(1.034);
    expect(recordUnitPricePoints("social-facebook-posts")).toBe(3.4485);
  });

  it("the posts and the comments per post are the customer's, within the service's ceilings (300 posts) and never below the minimum the price assumes (5)", () => {
    const cap = getSocialCapability(SLUG)!;
    const intent = detectSocialIntent(OWNER);
    expect(canonicalSocialParams(cap, intent, OWNER, {}, { perVideo: 5, videoCount: 300 })).toMatchObject({ query: "الترندات الصحية", region: "EG", perVideo: 5, videoCount: 300 });
    expect(canonicalSocialParams(cap, intent, OWNER, {}, { perVideo: 5, videoCount: 800 }).videoCount).toBe(300);
    expect(canonicalSocialParams(cap, intent, OWNER, {}, { perVideo: 2, videoCount: 100 }).perVideo).toBe(5);
    expect(canonicalSocialParams(cap, intent, OWNER, {}, {}).perVideo).toBe(5);
    // the other topic services keep their own limit of 20 videos a job
    expect(canonicalSocialParams(getSocialCapability("social-tiktok-comments")!, detectSocialIntent("تعليقات تيك توك عن كرة السلة"), "تعليقات تيك توك عن كرة السلة", {}, { videoCount: 300 }).videoCount).toBe(20);
  });
});

describe("the plan of the owner's request (300 posts, 5 comments each)", () => {
  it("ONE item, 1,500 comments, the hold 22,296 under the 25,000 cap, the charge of a full delivery 19,388, one count everywhere, a clean topic, the country in the search", async () => {
    const { r, executeTurn } = await ask(OWNER);
    expect(executeTurn).not.toHaveBeenCalled();
    expect(r.outputType).toBe("propose_plan");
    const q = r.planQuote;
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ capabilitySlug: SLUG, targetVolumeMax: 1500, unitPricePoints: UNIT, unitCostUsd: 0.00235, reservedPoints: 22_296 });
    expect(q.items[0].params).toMatchObject({ query: "الترندات الصحية", region: "EG", perVideo: 5, videoCount: 300 });
    expect(q.expectedPoints).toBe(19_388);
    expect(q.quotedPoints).toBe(22_296);
    expect(q.quotedPoints).toBeLessThanOrEqual(q.pointsCap);
    expect(q.pointsCap).toBe(25_000);
    // one size, said once
    expect(planCountLineAr(q.items)).toBe("حتى ١٥٠٠ سجل");
    expect(q.summaryAr).toBe("سحب التعليقات من ٣٠٠ منشور على فيسبوك عن «الترندات الصحية»، ويُضاف اسم الدولة (مصر) إلى كلمات البحث ليقتصر على المنشورات التي تخصها، حتى ١٥٠٠ تعليقاً إجمالاً، ولا تُقرأ إلا تعليقات المنشورات المتعلقة بموضوعك");
    expect(r.contentAr).toContain("- المنشورات: ٣٠٠ منشور، والتعليقات: حتى ١٥٠٠ تعليق من كل ما فيها.");
    expect(r.contentAr).toContain("- الحد الأقصى: حتى ١٥٠٠ تعليق");
    // the price line and the hold line: the price per hundred, the range from one comment to the full delivery, the hold with its buffer
    expect(r.contentAr).toContain("سعر السجل: حوالي ١٬٢٩٢٫٥ نقطة لكل ١٠٠ تعليق");
    expect(r.contentAr).toContain("من ١٢٫٩٣ نقطة (تعليق واحد مطابق) إلى ١٩٣٨٨ نقطة إن سُلّم العدد كاملًا، ويُحجز ٢٢٢٩٦ نقطة مؤقتًا كحد أقصى");
    expect(r.contentAr).not.toContain("طلبت");
    expect(q.volumeLimitLineAr).toBeUndefined();
    // nothing about providers, dollars, English or markdown reaches the customer
    expect(r.contentAr).not.toMatch(PROVIDER_WORDS);
    expect(r.contentAr).not.toMatch(/[A-Za-z]/);
    expect(r.contentAr).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(r.contentAr).not.toMatch(/^#{1,6}\s/m);
  });

  it("the plan card: the count, the price per hundred, the hold and what is charged, the long-job guidance (the page stays open), all in Arabic", async () => {
    const { r } = await ask(OWNER);
    const text = cardText(r.planQuote, 40_000);
    expect(text).toContain("حتى ١٥٠٠ سجل");
    expect(text).toContain("السعر التقديري ١٩٣٨٨ نقطة (١٥٠٠ × ١٢٫٩٣ نقطة، ويُقرَّب لأعلى)");
    expect(text).toContain("الحجز المؤقت ٢٢٢٩٦ نقطة هو هذا السعر مع احتياطي ١٥٪ على الحجز وحده");
    expect(text).toContain("سعر السجل الواحد حوالي ١٢٫٩٣ نقطة، أي ١٬٢٩٢٫٥ نقطة لكل ١٠٠ سجل");
    expect(text).toContain("أبقِ الصفحة مفتوحة حتى تكتمل المهمة.");
    expect(text).toContain("يكفي رصيدك");
    expect(text).not.toMatch(PROVIDER_WORDS);
    expect(text).not.toMatch(/[A-Za-z]/);
  });

  it("the duration counts the pages of the search as well as the comments (about 400 calls), and says it is an estimate", async () => {
    const { r } = await ask(OWNER);
    expect(r.planQuote.duration.labelAr).toBe("تقديري");
    expect(r.planQuote.duration.driversAr).toContain("حوالي ٤٠٠");
  });

  it("the customer asks for more than the service holds (400 posts, 2,000 comments): the plan holds 300 posts and 1,500 comments and the sentence names the SERVICE as the limit, not the balance or the cap", async () => {
    const { r } = await ask("عايز ٤٠٠ منشور على فيسبوك عن الترندات الصحية مع ٥ تعليقات لكل منشور في مصر");
    const q = r.planQuote;
    expect(q.items[0].targetVolumeMax).toBe(1500);
    expect(q.items[0].params.videoCount).toBe(300);
    expect(q.volumeLimitLineAr).toBe("طلبت ٢٠٠٠ تعليق، والذي تتسع له هذه الخدمة في الطلب الواحد ١٥٠٠ تعليق. هذا حدّ الخدمة نفسها لكل طلب، وليس رصيدك. ويمكنك طلب الباقي في طلب منفصل.");
    expect(r.contentAr).toContain(q.volumeLimitLineAr);
    expect(q.quotedPoints).toBe(22_296);
  });

  it("fewer comments per post than the service reads (3 asked, 5 read): the plan says so and keeps the comments the customer asked for, over fewer posts", async () => {
    const { r } = await ask("عايز ١٠٠ منشور على فيسبوك عن الترندات الصحية مع ٣ تعليقات لكل منشور");
    expect(r.outputType).toBe("propose_plan");
    const q = r.planQuote;
    expect(q.items[0].params.perVideo).toBe(5);
    expect(q.items[0].targetVolumeMax).toBe(300); // 100 posts x 3 comments asked
    expect(r.contentAr).toContain("- المنشورات: ٦٠ منشور، والتعليقات: حتى ٣٠٠ تعليق من كل ما فيها.");
    expect(q.coverageLinesAr).toContain("تُقرأ ٥ تعليقات على الأقل من كل منشور؛ لذلك تشمل الخطة ٦٠ منشور بدل ١٠٠ منشور، مع الإبقاء على عدد التعليقات الذي طلبته.");
    expect(r.contentAr).toContain(q.coverageLinesAr[0]);
  });

  it("a balance that cannot hold it: the honest balance sentence with the most the balance holds, never a silent cut", async () => {
    const { r } = await ask(OWNER, 2_000);
    const q = r.planQuote;
    expect(q.isAffordable).toBe(false);
    expect(q.items[0].targetVolumeMax).toBe(1500); // the plan is not shrunk behind the customer's back
    expect(q.balanceVerdictAr).toBe("رصيدك لا يكفي، أقصى عدد يتسع ١٣٤ سجل بحجز ١٩٩٢ نقطة.");
    expect(q.downscaledOffer).toMatchObject({ maxAffordableUnits: 134, affordableQuotedPoints: 1992 });
    expect(reserveForUnits(134, UNIT)).toBe(1992);
  });

  it("the provider capacity of the day cannot hold it: ONE Arabic sentence, no plan, no hold (the admin's daily limit is the number to raise)", async () => {
    setProviderBalanceForTesting(1);
    const { r } = await ask(OWNER);
    expect(r.planQuote).toBeUndefined();
    expect(r.outputType).not.toBe("propose_plan");
    expect(r.contentAr).toMatch(/^هذا الطلب أكبر من طاقة الاستخراج المتاحة اليوم؛ تتسع الطاقة الحالية لنحو [٠-٩]+ تعليقًا فقط\./);
    expect(r.contentAr).toContain("ولم يُحجز أي رصيد");
    expect(r.contentAr).not.toMatch(PROVIDER_WORDS);
  });

  it("no count and no comments per post: the two questions it needs, nothing guessed", async () => {
    const { r } = await ask("عايز تعليقات فيسبوك عن الترندات الصحية");
    expect(r.outputType).toBe("ask_clarification");
    expect(r.contentAr).toContain("كم منشورًا تريد أن آخذ تعليقاته؟");
    expect(r.contentAr).toContain("كم تعليقًا تريد من كل منشور؟");
    expect(r.planQuote).toBeUndefined();
  });
});

describe("acceptance: ONE item, so the existing acceptance code needs no change", () => {
  const quoteClient = (items: any[], rpcResult: any = { success: true, job_id: "job_fb", quote_id: "q_fb", reserved_credits: 22_296 }) => {
    const rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
    const client: any = {
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { quote_hash: "h".repeat(64), items }, error: null }) }) }) }),
      rpc,
    };
    return { client, rpc };
  };

  it("the quote the plan writes passes the app's gating (a verified, priced service) and reaches the approved acceptance function with the 22,296 hold", async () => {
    const { r } = await ask(OWNER);
    const { client, rpc } = quoteClient(r.planQuote.items);
    const accepted = await acceptQuoteSupabase(client, { userId: "user_fb", quoteId: "q_fb" });
    expect(accepted).toMatchObject({ success: true, jobId: "job_fb", reservedCredits: 22_296 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls as any[][])[0][0]).toBe("accept_quote_atomic");
  });

  it("a plan of TWO items (posts, then their comments) is still refused with the one-capability sentence and reserves nothing", async () => {
    const { r } = await ask(OWNER);
    const { client, rpc } = quoteClient([r.planQuote.items[0], r.planQuote.items[0]]);
    const refused = await acceptQuoteSupabase(client, { userId: "user_fb", quoteId: "q_fb" });
    expect(refused.success).toBe(false);
    expect(refused.errorAr).toContain("قدرة بحثية واحدة لكل طلب");
    expect(rpc).not.toHaveBeenCalled();
  });
});
