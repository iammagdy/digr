import { describe, expect, it } from "vitest";

import { usesPostLevelReview, POST_LEVEL_REVIEW_PLATFORMS } from "../src/lib/server/postLevelReview";
import {
  REVIEW_CALL_COST_ESTIMATE_USD,
  REVIEW_JOB_CEILING_USD,
  REVIEW_MIN_BUDGET_USD,
  REVIEW_REVENUE_SHARE,
  SOCIAL_REVIEW_ROWS_PER_CALL,
  socialReviewCapPreviousRuleUsd,
  socialReviewCapUsd,
  type AdvisoryResult,
  type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";
import { resolveReviewBudget } from "../src/lib/server/reviewDailyGuard";
import { groupRowsByVideo, judgeVideos, VIDEO_UNREVIEWED_REASON_AR, type VideoEntry } from "../src/lib/server/videoRelevance";
import { UNREVIEWED_BY_BUDGET_REASON_AR } from "../src/lib/server/rowReviewAdvisor";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { capacityRefusalAr, LARGE_PLAN_FROM_POINTS, PlanRefusalError } from "../src/lib/capacityRefusal";
import { DEFAULT_INPUTS, facebookTopicCostReport } from "../src/lib/costEstimate";
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import { evaluateProviderCallCap } from "../src/lib/server/providerCallCaps";

/**
 * The cost cuts of the review and the honest refusal of a plan the provider capacity cannot hold. Fake advisors and fake providers only: no model,
 * no provider call, no SQL.
 */
const countingAdvisor = (verdict: "match" | "no_match", costPerCallUsd = REVIEW_CALL_COST_ESTIMATE_USD) => {
  const calls: number[] = [];
  const advisor: RowAdvisorFn = async (input) => {
    calls.push(input.rows.length);
    const verdicts: AdvisoryResult["verdicts"] = new Map(input.rows.map((entry) => [entry.index, { verdict, reasonAr: "سبب" }]));
    return { verdicts, usage: { inputTokens: 1000, outputTokens: 100, costUsd: costPerCallUsd, model: "fake", latencyMs: 1 }, failure: null };
  };
  return { advisor, calls };
};

describe("which jobs are reviewed at the level of the post", () => {
  it("comments of a topic search on TikTok, YouTube and Facebook; never a page, a link, a channel or a post feed", () => {
    expect(POST_LEVEL_REVIEW_PLATFORMS).toEqual(["tiktok", "youtube", "facebook"]);
    expect(usesPostLevelReview("social-tiktok-comments", { query: "كرة السلة" })).toBe(true);
    expect(usesPostLevelReview("social-youtube-comments", { query: "كرة القدم" })).toBe(true);
    expect(usesPostLevelReview("social-facebook-comments", { query: "الترندات الصحية في مصر" })).toBe(true);
    expect(usesPostLevelReview("social-facebook-comments", { channels: ["https://www.facebook.com/youm7"], perVideo: 5 })).toBe(false);
    expect(usesPostLevelReview("social-facebook-comments", { url: "https://www.facebook.com/youm7/posts/1" })).toBe(false);
    expect(usesPostLevelReview("social-tiktok-comments", { query: "x", channel: "@someone" })).toBe(false);
    expect(usesPostLevelReview("social-x-posts", { query: "الترندات" })).toBe(false); // the X post is its own unit: reviewed row by row as before
    expect(usesPostLevelReview("social-facebook-posts", { query: "x" })).toBe(false);
    expect(usesPostLevelReview("icypeas-companies-search", { query: "x" })).toBe(false);
    expect(usesPostLevelReview(undefined, undefined)).toBe(false);
  });
});

describe("the review budget of a job: 20% of its revenue when it is reviewed at the level of its posts", () => {
  it("the share is the owner's 20%, one number", () => {
    expect(REVIEW_REVENUE_SHARE).toBe(0.2);
  });

  it("a small post-level job is held to 20% of its revenue (and never below one full review call); the per-row rule is unchanged", () => {
    // 300 comments at 0.275 points: revenue ceil(300 x 0.275) = 83 points = 8.3 EGP = 0.1509 USD; 20% = 0.0301 USD
    const row = socialReviewCapUsd(300, 0.275);
    const post = socialReviewCapUsd(300, 0.275, "post");
    expect(post).toBe(socialReviewCapPreviousRuleUsd(300, 0.275));
    expect(post).toBeCloseTo(0.030181, 6);
    expect(post).toBeLessThan(row);
    expect(socialReviewCapUsd(300, 0.275, "row")).toBe(row);
    // a job so small that 20% of its revenue is under one call keeps one full call
    expect(socialReviewCapUsd(10, 0.275, "post")).toBe(REVIEW_MIN_BUDGET_USD);
    // no valid price, no budget (fail closed), at either level
    expect(socialReviewCapUsd(300, 0, "post")).toBe(0);
    expect(socialReviewCapUsd(300, 0, "row")).toBe(0);
  });

  it("the owner's 300-post request (1,800 rows at 8 and 11 points): 20% of 34 USD is far above the 0.15 ceiling, so the ceiling binds and the review stays at 18 calls of 25 rows", () => {
    const post = socialReviewCapUsd(1800, 8.5, "post");
    expect(post).toBeLessThanOrEqual(REVIEW_JOB_CEILING_USD);
    expect(post).toBe(socialReviewCapUsd(1800, 8.5, "row"));
  });

  it("a post-level budget never exceeds max(one call, 20% of the job's revenue), whatever the size and price (property over a grid)", () => {
    for (const targetMax of [1, 7, 50, 300, 1500, 1897, 4500, 20000]) {
      for (const unit of [0.11715, 0.275, 1.034, 3.168, 3.4485, 8, 11]) {
        const cap = socialReviewCapUsd(targetMax, unit, "post");
        const share = socialReviewCapPreviousRuleUsd(targetMax, unit);
        expect(cap, `${targetMax} x ${unit}`).toBeLessThanOrEqual(Math.max(REVIEW_MIN_BUDGET_USD, share) + 1e-9);
        expect(cap).toBeLessThanOrEqual(socialReviewCapUsd(targetMax, unit, "row") + 1e-9);
        expect(cap).toBeGreaterThanOrEqual(REVIEW_MIN_BUDGET_USD);
      }
    }
  });

  it("the daily guard passes the level through (default row)", async () => {
    const row = await resolveReviewBudget({ admin: null, targetMax: 300, unitPricePoints: 0.275 });
    const post = await resolveReviewBudget({ admin: null, targetMax: 300, unitPricePoints: 0.275, level: "post" });
    expect(row.capUsd).toBe(socialReviewCapUsd(300, 0.275));
    expect(post.capUsd).toBe(socialReviewCapUsd(300, 0.275, "post"));
    expect(post.capUsd).toBeLessThan(row.capUsd);
  });
});

describe("post-level review: the model sees posts, never comments, and the budget is a ceiling", () => {
  // 300 candidate posts, five comments each: 60% say the topic in their own text (settled by evidence, no call), 40% need the review
  const rows = Array.from({ length: 300 }, (_, p) =>
    Array.from({ length: 5 }, (_, c) => ({
      index: p * 5 + c,
      row: { comment_text: `تعليق رقم ${p}-${c} طويل بما يكفي`, video_url: `https://www.facebook.com/p/${p}`, video_title: p % 5 < 3 ? `منشور عن الترندات الصحية ${p}` : `منشور آخر ${p}` },
    })),
  ).flat();
  const { videos } = groupRowsByVideo(rows);
  const request = { query: "الترندات الصحية", region: "" };

  it("300 posts with 1,500 comments: the advisor is called on the posts without evidence only, in batches of 25, and on no comment", async () => {
    expect(videos).toHaveLength(300);
    const fake = countingAdvisor("match");
    const outcome = await judgeVideos({ advisor: fake.advisor, customerRequest: "الترندات الصحية", kind: "social-facebook-comments-video-list", videos, request, budgetUsd: 1, callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD });
    const needReview = 120; // 40% of 300
    expect(fake.calls.reduce((sum, n) => sum + n, 0)).toBe(needReview);
    expect(fake.calls).toEqual([25, 25, 25, 25, 20]);
    expect(Math.max(...fake.calls)).toBeLessThanOrEqual(SOCIAL_REVIEW_ROWS_PER_CALL);
    expect([...outcome.judgements.values()].filter((j) => j.by === "evidence")).toHaveLength(180);
    expect([...outcome.judgements.values()].every((j) => j.decision === "match")).toBe(true);
    // what it cost: five calls, not the seventy-two a per-row review of the 1,800 rows would make
    expect(outcome.costUsd).toBeCloseTo(5 * REVIEW_CALL_COST_ESTIMATE_USD, 6);
    expect(Math.ceil((rows.length + videos.length) / SOCIAL_REVIEW_ROWS_PER_CALL)).toBe(72); // 300 posts + 1,500 comments, row by row
  });

  it("a budget that pays for two calls reviews 50 posts; the 70 left are NOT delivered, say why, and are marked as held by the budget", async () => {
    const fake = countingAdvisor("match");
    const budget = 2 * REVIEW_CALL_COST_ESTIMATE_USD;
    const outcome = await judgeVideos({ advisor: fake.advisor, customerRequest: "الترندات الصحية", kind: "x", videos, request, budgetUsd: budget, callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD });
    expect(fake.calls).toEqual([25, 25]);
    expect(outcome.costUsd).toBeLessThanOrEqual(budget + 1e-12);
    const held = [...outcome.judgements.values()].filter((j) => j.decision === "uncertain");
    expect(held).toHaveLength(70);
    expect(held.every((j) => j.budget === true && j.by === "unreviewed" && j.reasonAr === UNREVIEWED_BY_BUDGET_REASON_AR)).toBe(true);
    expect(UNREVIEWED_BY_BUDGET_REASON_AR).toMatch(/^[؀-ۿ\s\d«».،:؛()\-]+$/u); // Arabic only
    expect(VIDEO_UNREVIEWED_REASON_AR).not.toBe(UNREVIEWED_BY_BUDGET_REASON_AR);
  });

  it("the worker's customer sentence for a used-up budget exists once per chunk and says nothing was charged", async () => {
    const fs = await import("node:fs");
    const worker = fs.readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).toContain('وصل التحقق الآلي إلى الحد المسموح لهذا الطلب؛ وُضع في ورقة «غير مراجَع»: ${countPlainAr(heldByBudget, "comments")}، ولم يُحتسب ذلك عليك.');
    const caps = fs.readFileSync("src/lib/server/providerCallCaps.ts", "utf8");
    expect(caps).toContain("review_budget:");
    expect(worker).toContain("usesPostLevelReview(spec.capabilitySlug, spec.params)");
    expect(worker).toContain('level: postLevelJob ? (getSocialCapability(spec.capabilitySlug)?.pagedDiscovery ? "paged_post" : "post") : "row"');
  });
});

describe("the code-side filters before any model call (kept, pinned)", () => {
  const params = { query: "الترندات الصحية", region: "EG" };
  const gate = (slug: string, row: Record<string, any>, p: Record<string, any> = params) => evaluateResearchRowRelevance(row, { capabilitySlug: slug, endpointId: slug, params: p });

  it("a comment that is empty, shorter than three letters, a bare supplication or only a link never reaches a review", () => {
    for (const text of ["", "ok", "Wr", "اللهم احفظ مصر", "https://example.com/x"]) {
      expect(gate("social-tiktok-comments", { comment_text: text, video_title: "الترندات الصحية في مصر", video_url: "https://www.tiktok.com/@a/video/1" }).decision, text).toBe("no_match");
    }
  });

  it("a post with no word of the topic is excluded before the review; a post that names the topic goes on", () => {
    expect(gate("social-x-posts", { text: "مباراة اليوم كانت رائعة" }).decision).toBe("no_match");
    expect(gate("social-x-posts", { text: "الترندات الصحية في مصر تتغير كل أسبوع" }).decision).toBe("match");
  });
});

describe("a rejected post's comments are never bought: comments are read only under adopted posts", () => {
  const NOW = Date.parse("2026-10-23T12:00:00Z");
  const ok = (rows: Array<Record<string, any>>): SocialCallOutcome => ({ ok: true, httpStatus: 200, data: { ok: true, rows }, costMicro: 1000, tregCallId: "call" });
  const video = (n: number) => ({ aweme_id: `70000000000000${String(n).padStart(4, "0")}`, desc: `فيديو رقم ${n}` });
  it("10 videos found, 2 adopted: the comments endpoint is called for those 2 and for no other", async () => {
    const read: string[] = [];
    const call: SocialCall = async (source, params) => {
      if (source.endpointId.includes(".search.")) return ok(Array.from({ length: 10 }, (_, i) => video(i)));
      read.push(String(params.aweme_id ?? params.video_id ?? params.url ?? params.id ?? JSON.stringify(params)));
      return ok([{ comment_id: `c_${read.length}`, text: "تعليق مفيد عن الموضوع كله" }]);
    };
    const adopted = [0, 1].map((n) => ({ id: video(n).aweme_id, title: video(n).desc }));
    await runSocialChunk({
      jobId: "job_x", userId: "u", step: 0, endpointId: "tikhub.tiktok.video.comments", capabilitySlug: "social-tiktok-comments", method: "POST", params: { query: "كرة السلة", videoCount: 2 },
      paginationStrategy: "cursor", cursor: null, pageSize: 50, remainingNeeded: 20, targetVolumeMax: 20, deliveredSoFar: 0,
    } as any, { call, now: () => NOW, videoSelector: async (refs) => ({ adopted: refs.filter((ref) => adopted.some((a) => a.id === ref.id)) }) });
    expect(read.length).toBeGreaterThan(0);
    expect(read.length).toBeLessThanOrEqual(2);
    for (const entry of read) expect(adopted.some((a) => entry.includes(String(a.id)))).toBe(true);
  });
});

describe("the stall guard of the page cap (kept from the previous change)", () => {
  it("two pages in a row with nothing new, the second a repeat, stop the job", () => {
    expect(evaluateProviderCallCap({ pagesDone: 3, acceptedThisPage: 0, priorBatchUnits: [3, 0], targetMax: 10, pageSize: 3, kind: "feed", deliveredTotal: 3, pageRepeatedOnly: true })).toBe("source_repeats");
  });
});

describe("a plan the provider capacity cannot hold is refused in one plain sentence", () => {
  it("says what the capacity does hold, in Arabic, with no money, no provider word and no Latin letter", () => {
    const items = [{ capabilitySlug: "facebook-post-search", targetVolumeMax: 300 }, { capabilitySlug: "facebook-post-comments", targetVolumeMax: 1500 }];
    const text = capacityRefusalAr(items, 0.22);
    expect(text).toBe("هذا الطلب أكبر من طاقة الاستخراج المتاحة اليوم؛ تتسع الطاقة الحالية لنحو ٦٦ منشورًا و٣٣٠ تعليقًا فقط. اطلب هذا العدد أو أقل، أو أعد المحاولة لاحقًا، ولم يُحجز أي رصيد.");
    expect(text).not.toMatch(/[A-Za-z0-9]|usd|\$|treg|endpoint/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("a capacity that holds no part of the plan says so", () => {
    expect(capacityRefusalAr([{ capabilitySlug: "facebook-post-search", targetVolumeMax: 3 }], 0.1)).toBe("هذا الطلب أكبر من طاقة الاستخراج المتاحة اليوم، ولا تتسع الطاقة الحالية لأي جزء منه. أعد المحاولة لاحقًا، ولم يُحجز أي رصيد.");
  });

  it("the refusal is an error object with the sentence, and only a plan above the old per-job cap of 600 points can be refused", () => {
    expect(LARGE_PLAN_FROM_POINTS).toBe(600);
    const refusal = new PlanRefusalError("جملة");
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.messageAr).toBe("جملة");
  });
});

describe("the cost estimate of the 300-post request is pinned (read-only, no call)", () => {
  const report = facebookTopicCostReport(DEFAULT_INPUTS);
  it("the charge, the reserve and the revenue", () => {
    expect(report.unit).toEqual({ postsPoints: 8, commentsPoints: 11 });
    expect(report.rows).toEqual({ posts: 300, comments: 1500 });
    expect(report.charge).toBe(18_900);
    expect(report.reserve).toBe(21_735);
    expect(report.revenueUsd).toBe(34.36);
  });
  it("the per-row review of every row would cost far more than the post-level one, and the 0.15 USD ceiling would let 450 of 3,600 rows through", () => {
    const [every, ceiling, postLevel] = report.scenarios;
    expect(every.modelCalls.review).toBe(144);
    expect(ceiling.reviewableRows).toBe(450);
    expect(ceiling.modelCalls.review).toBe(18);
    expect(postLevel.modelCalls.review).toBe(17);
    expect(postLevel.providerCalls.comments).toBe(300);
    expect(every.providerCalls.comments).toBe(600);
    expect(postLevel.totalCostUsd).toBeLessThan(ceiling.totalCostUsd);
    expect(postLevel.totalCostUsd).toBeLessThan(every.totalCostUsd);
    expect(postLevel.marginShare).toBeGreaterThan(0.97);
  });
});
