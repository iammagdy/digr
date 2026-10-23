import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * PHASE 5 (Stage A, code only, no cap changed): smart discovery questions, an honest estimate against the balance before approval, and honest reasons
 * when a limit shrinks a request. The model is never called (a call fails the test); no provider is called. The numbers in every sentence come from the quote.
 */
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler, getDeterministicDiscoveryQuestion } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { createChatDb } from "./helpers/chatSession";
import {
  COMMENTS_NO_AR,
  COMMENTS_YES_AR,
  discoveryAnswerAsRequestText,
  otherFacebookServiceExists,
  readSocialFacts,
  socialDiscoveryIntroAr,
  socialDiscoveryItems,
  socialDiscoveryTrigger,
} from "../src/lib/socialDiscoveryCard";
import { balanceVerdictAr } from "../src/lib/balanceVerdict";
import { VOLUME_LIMIT_REASON_AR, SERVICE_CEILING_REASON_AR, volumeLimitStatementAr } from "../src/lib/jobCaps";
import { detectSocialIntent, facebookPageNameIn } from "../src/lib/socialTasks";
import { understandMission } from "../src/lib/consultantCopy";
import { getSocialCapability } from "../src/lib/socialSources";
import { JOB_MAX_POINTS_CAP } from "../src/lib/jobPointsCap";

const OWNER_REQUEST = "الترندات الصحية في مصر آخر ٣ شهور من فيسبوك ٤٠٠ منشور بالتعليقات";
const PROVIDER_WORDS = /treg|icypeas|firecrawl|context\.dev|tikhub|apify|openai|anthropic|resend|supabase|usd|\$|endpoint/i;

class Chat {
  private db: any = createChatDb();
  private handler: ChatHandler;
  constructor(private balance = 20000) {
    this.handler = new ChatHandler(this.db);
    (this.handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  }
  async start() {
    await this.db.createRow({ tableId: "conversations", rowId: "conv_p5", data: { userId: "user_p5", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    return this;
  }
  send(message: string): Promise<any> {
    return this.handler.handleUserMessage({ userId: "user_p5", conversationId: "conv_p5", message, userBalance: this.balance }) as Promise<any>;
  }
  answer(answers: Array<{ questionId: string; value?: string; skipped?: boolean }>) {
    return this.send(JSON.stringify({ type: "clarification_answers", answers: answers.map((a) => ({ question: a.questionId, ...a })) }));
  }
}
const chat = (balance?: number) => new Chat(balance).start();
const visible = (r: any) => [r.contentAr, r.clarificationIntro, ...(r.clarificationQuestions || []), ...((r.clarificationItems || []).flatMap((q: any) => [q.text, ...(q.options || [])]))].filter(Boolean).join(" \n ");

const PAGE_REQUEST = "هات ٤٠٠ منشور بالتعليقات من صفحة اليوم السابع على فيسبوك آخر ٣ شهور";

describe("A1: ask only what the request does not already say", () => {
  it("reads the facts of the owner's request: platform, topic, period, posts and comments are stated; only the comments per post is not", () => {
    expect(readSocialFacts(OWNER_REQUEST)).toMatchObject({ platform: "facebook", topic: true, period: true, postsCount: 400, commentsWanted: true, commentsPerPost: null, source: false });
  });

  it("the owner's request gets ONE question, with tappable numbers and free text: nothing it already says is asked again", async () => {
    const items = socialDiscoveryItems(OWNER_REQUEST, { otherFacebookService: true });
    expect(items.map((q) => q.id)).toEqual(["social_comments_per_post"]);
    expect(items[0]).toMatchObject({ type: "single", options: ["١٠", "٢٠", "٥٠", "١٠٠"], allowOther: true });
    const c = await chat();
    const r = await c.send(OWNER_REQUEST);
    expect(r.outputType).toBe("ask_clarification");
    expect((r.clarificationItems as any[]).map((q) => q.id)).toEqual(["social_comments_per_post"]);
    const text = visible(r);
    for (const asked of ["على أي منصة", "ما الموضوع", "ما الفترة الزمنية", "كم منشورًا", "هل تريد تعليقات", "اسم الصفحة"]) expect(text, asked).not.toContain(asked);
    expect(text).toContain("كم تعليقًا تريد من كل منشور؟");
    expect(text).not.toMatch(PROVIDER_WORDS);
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("with no other Facebook service registered the same request also needs a page (Facebook is not searched by topic), said once and plainly", () => {
    const items = socialDiscoveryItems(OWNER_REQUEST, { otherFacebookService: false });
    expect(items.map((q) => q.id)).toEqual(["social_page_required", "social_comments_per_post"]);
    expect(items[0]).toMatchObject({ type: "free", options: [] });
    expect(socialDiscoveryIntroAr(OWNER_REQUEST, { otherFacebookService: false })).toContain("فيسبوك لا يتيح البحث بالموضوع");
    expect(socialDiscoveryIntroAr(OWNER_REQUEST, { otherFacebookService: true })).not.toContain("فيسبوك لا يتيح");
    const question = getDeterministicDiscoveryQuestion(OWNER_REQUEST, { platforms: [], topics: [], notes: "" } as any, [], {});
    expect(question).toMatchObject({ id: "social_page_required", type: "free" });
  });

  it("when more is missing the same card carries it, and only it: how many posts, comments or not, comments per post", () => {
    const ids = (text: string) => socialDiscoveryItems(text, { otherFacebookService: false }).map((q) => q.id);
    expect(ids("بوستات فيسبوك بالتعليقات 50 منشور")).toEqual(["social_page_required", "social_comments_per_post", "social_time_required"]);
    expect(ids(PAGE_REQUEST)).toEqual(["social_comments_per_post"]);
    expect(ids("هات ٤٠٠ منشور بالتعليقات من صفحة اليوم السابع على فيسبوك ٢٠ تعليق من كل منشور")).toEqual([]);
  });

  it("does nothing when the request is complete, is not stated with posts and comments, or another verified Facebook service can serve a topic", () => {
    expect(socialDiscoveryTrigger("هات ٤٠٠ منشور بالتعليقات من صفحة اليوم السابع على فيسبوك ٢٠ تعليق من كل منشور")).toBeNull();
    expect(socialDiscoveryTrigger("الترندات الصحية في مصر آخر ٣ شهور من تيك توك ٤٠٠ منشور بالتعليقات")).toBeNull();
    expect(socialDiscoveryTrigger(OWNER_REQUEST, { otherFacebookService: true })).toBe("per_post");
    expect(socialDiscoveryTrigger("عايز بيانات من فيسبوك عن الدهب")).toBeNull(); // a plain topic request keeps its old route
    expect(socialDiscoveryTrigger("هات ٥٠ منشور من صفحة اليوم السابع على فيسبوك")).toBeNull(); // posts only: nothing to ask
    expect(otherFacebookServiceExists([{ slug: "social-facebook-comments", platform: "facebook", enabled: true, status: "verified" }])).toBe(false);
    expect(otherFacebookServiceExists([{ slug: "facebook-hashtag-search", platform: "facebook", enabled: true, status: "verified" }])).toBe(true);
    expect(otherFacebookServiceExists([{ slug: "facebook-hashtag-search", platform: "facebook", enabled: false, status: "verified" }])).toBe(false);
    expect(otherFacebookServiceExists([{ slug: "facebook-post-search", platform: "facebook", enabled: true, status: "pending_verification" }])).toBe(false);
  });

  it("the card's answers become plain request words the readers already understand, and a page's name stops before the next answer", () => {
    expect(discoveryAnswerAsRequestText("social_page_required", "اليوم السابع")).toBe("صفحة اليوم السابع ·");
    expect(discoveryAnswerAsRequestText("social_page_required", "facebook.com/youm7")).toBe("facebook.com/youm7 ·");
    expect(discoveryAnswerAsRequestText("social_posts_count_required", "٥٠")).toBe("٥٠ منشور");
    expect(discoveryAnswerAsRequestText("social_comments_wanted", COMMENTS_YES_AR)).toBe("مع التعليقات");
    expect(discoveryAnswerAsRequestText("social_comments_wanted", COMMENTS_NO_AR)).toBe("المنشورات فقط");
    expect(discoveryAnswerAsRequestText("social_comments_per_post", "٢٠")).toBe("٢٠ تعليق من كل منشور");
    expect(discoveryAnswerAsRequestText("volume_cap_required", "٥٠٠")).toBeNull();
    const text = `${OWNER_REQUEST} صفحة اليوم السابع · ٢٠ تعليق من كل منشور`;
    expect(facebookPageNameIn(text)).toBe("اليوم السابع");
    expect(detectSocialIntent(text)).toMatchObject({ platform: "facebook", task: "comments", discover: "channel", pageName: "اليوم السابع" });
    expect(understandMission(text)).toMatchObject({ videos: 400, commentsPerVideo: 20, missing: [] });
  });

  it("a card answer travels with the request it completes (it is never read as a new request)", async () => {
    const c = await chat();
    await c.send(PAGE_REQUEST);
    const r = await c.answer([{ questionId: "social_comments_per_post", value: "٢٠" }]);
    expect(r.outputType).toBe("propose_plan"); // the platform, the page and the period of the first message are still there
    expect(r.planQuote.items[0].params).toMatchObject({ channels: ["اليوم السابع"], perVideo: 20 });
  });

  it("a Facebook page named in the request is the scope of its comments (it went to the model before)", () => {
    expect(detectSocialIntent("تعليقات منشورات صفحة اليوم السابع على فيسبوك")).toMatchObject({ task: "comments", discover: "channel", pageName: "اليوم السابع" });
    expect(detectSocialIntent("٢٠ بوست من صفحة اليوم السابع على فيسبوك")).toMatchObject({ task: "page_posts", pageName: "اليوم السابع" }); // unchanged
  });
});

describe("A2 + A3: the plan says honestly what fits, why, and whether the balance covers it", () => {
  async function ownerPlan(balance = 20000) {
    const c = await chat(balance);
    const first = await c.send(PAGE_REQUEST);
    expect(first.outputType).toBe("ask_clarification");
    expect((first.clarificationItems as any[]).map((q) => q.id)).toEqual(["social_comments_per_post"]);
    return c.answer([{ questionId: "social_comments_per_post", value: "٢٠" }]);
  }

  it("the answers make a priced plan (no model): the page, 20 posts at most per page, 20 comments from each, the period the customer wrote", async () => {
    const r = await ownerPlan();
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-facebook-comments");
    expect(item.params).toMatchObject({ channels: ["اليوم السابع"], topPerChannel: 20, perVideo: 20, dateFrom: "2026-07-23", dateTo: "2026-10-23" });
    expect(r.planQuote.targetVolumeMax).toBe(400); // 20 posts x 20 comments: never more than can be read
    expect(r.planQuote.askedVolumeMax).toBe(8000); // 400 posts x 20 comments
  });

  it("every shrink is said with its exact reason and the number that fits: the posts a job reads, and the comments they can reach, are the service's limit and not the balance", async () => {
    const r = await ownerPlan();
    const text = r.contentAr as string;
    expect(text).toContain("طلبت ٤٠٠ منشور، واعتمدت أحدث ٢٠ منشور من كل صفحة");
    expect(text).toContain("حدّ الطلب الواحد لا رصيدك");
    expect(text).toContain("طلبت ٨٠٠٠ تعليق، والذي يتسع له هذا الطلب ٤٠٠ تعليق (٢٠ منشور × ٢٠ تعليقًا لكل منشور)");
    expect(text).toContain("هذا حدّ الطلب الواحد، وليس رصيدك");
    expect(text).not.toContain(VOLUME_LIMIT_REASON_AR); // never blamed on the points cap
    expect(r.planQuote.volumeLimitLineAr).toContain("طلبت ٨٠٠٠ تعليق");
    expect(text).not.toMatch(PROVIDER_WORDS);
  });

  it("a balance that covers the plan: «يكفي رصيدك» with the balance, the hold (15% on the hold only) and what is charged at most, all from the quote", async () => {
    const r = await ownerPlan(20000);
    const q = r.planQuote;
    expect(r.contentAr).toContain("- الرصيد: يكفي رصيدك");
    expect(q.balanceVerdictAr).toBe(balanceVerdictAr({ balance: 20000, quotedPoints: q.quotedPoints, expectedPoints: q.expectedPoints, targetVolumeMax: q.targetVolumeMax, downscaledOffer: q.downscaledOffer }));
    const arabic = (n: number) => String(Math.round(n)).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
    expect(q.balanceVerdictAr).toContain(`الحجز المؤقت ${arabic(q.quotedPoints)} نقطة`);
    expect(q.balanceVerdictAr).toContain("احتياطي ١٥٪ على الحجز وحده");
    expect(q.balanceVerdictAr).toContain(`حتى ${arabic(q.expectedPoints)} نقطة`);
    expect(q.quotedPoints).toBeGreaterThanOrEqual(q.expectedPoints); // the charge is never above the hold
    expect(q.isAffordable).toBe(true);
  });

  it("a balance that does not: «رصيدك لا يكفي، أقصى عدد يتسع X» with the number the quote worked out, then the usual options", async () => {
    const r = await ownerPlan(150);
    const q = r.planQuote;
    expect(q.isAffordable).toBe(false);
    expect(q.downscaledOffer.maxAffordableUnits).toBeGreaterThan(0);
    const arabic = (n: number) => String(Math.round(n)).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
    expect(r.contentAr).toContain(`- الرصيد: رصيدك لا يكفي، أقصى عدد يتسع ${arabic(q.downscaledOffer.maxAffordableUnits)} سجل`);
    expect(r.contentAr).toContain("تنبيه الرصيد"); // the options and the top-up line are unchanged
  });

  it("a Facebook page's posts, asked for 400: the plan holds 60 and says it is the service's own ceiling, not the job cap and not the balance", async () => {
    const c = await chat(20000);
    const r = await c.send("هات ٤٠٠ منشور من صفحة اليوم السابع على فيسبوك آخر ٣ شهور");
    expect(r.outputType).toBe("propose_plan");
    expect(getSocialCapability("social-facebook-posts")!.maxRows).toBe(60);
    expect(r.planQuote.targetVolumeMax).toBe(60);
    expect(r.planQuote.serviceCeilingUnits).toBe(60);
    expect(r.contentAr).toContain("طلبت ٤٠٠ منشور، والذي تتسع له هذه الخدمة في الطلب الواحد ٦٠ منشور");
    expect(r.contentAr).toContain(SERVICE_CEILING_REASON_AR);
    expect(r.contentAr).not.toContain(VOLUME_LIMIT_REASON_AR);
  });

  it("when the points cap IS what limits a request, it still says so (unchanged), with the number that fits and what the whole request needed", async () => {
    const c = await chat(20000);
    const r = await c.send("هات ٥٠٠٠ تعليق من فيديوهات تيك توك عن كرة السلة آخر شهر");
    expect(r.planQuote.pointsCapConstrained).toBe(true);
    expect(r.planQuote.pointsCap).toBe(JOB_MAX_POINTS_CAP);
    expect(r.contentAr).toContain(VOLUME_LIMIT_REASON_AR);
    expect(r.contentAr).toContain("وهو أكبر من سقف الطلب الواحد");
    expect(r.contentAr).toContain("- الرصيد: يكفي رصيدك");
  });

  it("the plan card renders the same sentences: the server's limit line and a balance verdict computed from the live balance", () => {
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card).toContain("quote.volumeLimitLineAr");
    expect(card).toContain('data-testid="plan-balance-verdict"');
    expect(card).toContain("balanceVerdictAr({ balance,");
  });
});

describe("skipping a question", () => {
  const brief = { platforms: [], topics: [], notes: "" } as any;
  it("a skipped page gets one plain sentence that says how to go on, never the same card again", () => {
    const skipped = getDeterministicDiscoveryQuestion(OWNER_REQUEST, brief, [], { skipped: new Set(["social_page_required"]) });
    expect(skipped).toMatchObject({ plain: true, id: "skipped_social_page_required" });
    expect(skipped.text).toContain("فيسبوك لا يتيح البحث بالموضوع");
    expect(skipped.text).toContain("اكتب اسم الصفحة");
    expect(skipped.text).not.toMatch(PROVIDER_WORDS);
  });

  it("a skipped comments-per-post is never asked again: the older cap question takes over, and nothing is asked a second time", async () => {
    const asked = getDeterministicDiscoveryQuestion(PAGE_REQUEST, brief, [], { skipped: new Set(["social_comments_per_post"]) });
    expect(asked?.id).toBe("volume_cap_required");
    const c = await chat();
    await c.send(PAGE_REQUEST);
    const r = await c.answer([{ questionId: "social_comments_per_post", skipped: true }]);
    expect((r.clarificationItems as any[] | undefined)?.map((q) => q.id)).not.toContain("social_comments_per_post");
  });
});

describe("limits and constants: where the per-job cap and the Facebook ceilings live (a change to one without the others fails here)", () => {
  const read = (file: string) => readFileSync(file, "utf8");
  it("the points cap is 600 in the one TypeScript constant and in the three SQL functions that hold it", () => {
    expect(JOB_MAX_POINTS_CAP).toBe(600);
    expect(read("supabase/migrations/20261017180000_create_quote_atomic.sql")).toMatch(/v_cap numeric := 600;/);
    expect(read("supabase/migrations/20261017175500_settle_completed_jobs_with_stale_lease.sql")).toMatch(/p_points_cap numeric DEFAULT 600/);
    expect(read("supabase/migrations/20261017181000_settle_decision_maker_fields.sql")).toMatch(/COALESCE\(p_points_cap,600\), 600/);
  });

  it("the service ceilings: Facebook posts 60 (not raisable), Facebook comments 500, page posts per mission 20", () => {
    expect(getSocialCapability("social-facebook-posts")!.maxRows).toBe(60);
    expect(getSocialCapability("social-facebook-comments")!.maxRows).toBe(500);
    const sources = read("src/lib/socialSources.ts");
    expect(sources).toContain("export const MAX_TOP_PER_CHANNEL = 20;");
    expect(read("src/lib/scaleConfig.ts")).toContain('kind === "comments" || (kind === "posts" && defaultMaxRows >= 500)');
  });

  it("the proposal's file:line references still point at the constants they name", () => {
    const lineOf = (file: string, needle: string) => read(file).split("\n").findIndex((line) => line.includes(needle)) + 1;
    expect(lineOf("src/lib/jobPointsCap.ts", "export const JOB_MAX_POINTS_CAP = 600;")).toBe(8);
    expect(lineOf("supabase/migrations/20261017180000_create_quote_atomic.sql", "v_cap numeric := 600;")).toBe(19);
    expect(lineOf("supabase/migrations/20261017181000_settle_decision_maker_fields.sql", "COALESCE(p_points_cap,600), 600")).toBe(75);
    expect(lineOf("supabase/migrations/20261017175500_settle_completed_jobs_with_stale_lease.sql", "LEAST(v_raw_charge, v_job.reserved_credits, p_points_cap)")).toBe(98);
    expect(lineOf("src/functions/shared/planManager.ts", "const pointsCap = Math.min(getConfiguredJobPointsCap(), DEFAULT_JOB_POINTS_CAP);")).toBe(622);
    expect(lineOf("src/lib/socialSources.ts", "maxRows: 60,")).toBe(612);
    expect(lineOf("src/lib/socialSources.ts", "export const MAX_TOP_PER_CHANNEL = 20;")).toBe(660);
  });
});

describe("the balance verdict", () => {
  const base = { quotedPoints: 476, expectedPoints: 414, targetVolumeMax: 400 };
  it("covers: says so with the hold, the buffer on the hold only, and the most that can be charged", () => {
    const text = balanceVerdictAr({ ...base, balance: 1000 });
    expect(text).toBe("يكفي رصيدك: رصيدك ١٠٠٠ نقطة، والحجز المؤقت ٤٧٦ نقطة (يشمل احتياطي ١٥٪ على الحجز وحده)، ولا يُخصم إلا ثمن ما يُسلَّم فعلًا وهو حتى ٤١٤ نقطة.");
  });
  it("exactly the hold is enough; one point short is not", () => {
    expect(balanceVerdictAr({ ...base, balance: 476 })).toContain("يكفي رصيدك");
    expect(balanceVerdictAr({ ...base, balance: 475 })).toContain("رصيدك لا يكفي");
  });
  it("does not cover: the most that fits comes from the quote's own offer; with none, it says so", () => {
    expect(balanceVerdictAr({ ...base, balance: 200, downscaledOffer: { maxAffordableUnits: 168, affordableQuotedPoints: 199 } })).toBe("رصيدك لا يكفي، أقصى عدد يتسع ١٦٨ سجل بحجز ١٩٩ نقطة.");
    expect(balanceVerdictAr({ ...base, balance: 200, downscaledOffer: { maxAffordableUnits: 168, affordableQuotedPoints: 199 }, unitLabelAr: "تعليق" })).toContain("١٦٨ تعليق");
    expect(balanceVerdictAr({ ...base, balance: 0 })).toBe("رصيدك لا يكفي، ولا يوجد عدد أقل يناسب رصيدك الحالي.");
  });
  it("is Arabic only: Arabic-Indic digits, no Latin letters, no emoji, no money in dollars", () => {
    for (const text of [balanceVerdictAr({ ...base, balance: 1000 }), balanceVerdictAr({ ...base, balance: 10 })]) {
      expect(text).not.toMatch(/[A-Za-z0-9]/);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("the limit statements", () => {
  it("service ceiling and reach have their own reasons; the points cap keeps its sentence", () => {
    expect(volumeLimitStatementAr({ askedUnits: 400, fittedUnits: 60, reason: "service", unitLabelAr: "منشور" })).toBe(`طلبت ٤٠٠ منشور، والذي تتسع له هذه الخدمة في الطلب الواحد ٦٠ منشور. ${SERVICE_CEILING_REASON_AR} ويمكنك طلب الباقي في طلب منفصل.`);
    expect(volumeLimitStatementAr({ askedUnits: 8000, fittedUnits: 400, reason: "reach", reachDetailAr: "٢٠ منشور × ٢٠ تعليقًا لكل منشور", unitLabelAr: "تعليق" })).toContain("هذا حدّ الطلب الواحد، وليس رصيدك");
    expect(volumeLimitStatementAr({ askedUnits: 5000, fittedUnits: 1897 })).toContain(VOLUME_LIMIT_REASON_AR);
    expect(volumeLimitStatementAr({ askedUnits: 50, fittedUnits: 50, reason: "service" })).toBeNull(); // nothing cut: nothing said
  });
});
