import { describe, expect, it } from "vitest";
import { emptyRunningSet, extendRunningSet, loadRunningSet, saveRunningSet } from "../src/lib/server/jobRunningSet";
import { evaluateResearchRowRelevance, isTopicSearchRequest } from "../src/lib/server/researchRelevanceGate";
import {
  applyStrictAdvisory, parseAdvisoryReply, reviewSocialRows, SOCIAL_REVIEW_ROWS_PER_CALL, socialReviewCapUsd, UNREVIEWED_REASON_AR,
  type AdvisoryResult, type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";

const MATCH_TOPIC = "مباراة مصر والمغرب كأس العالم";
const xContext = { capabilitySlug: "social-x-posts", endpointId: "anyapi.x.search.posts", params: { query: MATCH_TOPIC } };
const tiktokContext = { capabilitySlug: "social-tiktok-comments", endpointId: "tikhub.tiktok.video.comments", params: { query: "كرة القدم", region: "EG" } };

/**
 * Golden fixtures. Rows of a TOPIC SEARCH (the source filtered by the topic itself) are presumed on topic; only an empty text, a
 * bare ad or link, or a script with no Arabic or Latin letters is dropped, and a doubtful row (a bare «اتفقت», a long text with no
 * word of the topic anywhere) is flagged for the automatic review. A feed with no topic filter keeps the strict evidence rule.
 */
const PRESUMED = "من نتائج البحث بالموضوع المطلوب";
const FOOTBALL = { query: "كرة القدم", region: "EG" };
const ytContext = { capabilitySlug: "social-youtube-comments", endpointId: "crawl4ai.youtube.video.comments", params: { query: "كرة القدم" } };
type GateContext = { capabilitySlug: string; endpointId: string; params: Record<string, any> };
const decide = (row: Record<string, any>, context: GateContext = tiktokContext) => evaluateResearchRowRelevance(row, context);

describe("topic search rows: short real football comments are delivered without the topic words in them", () => {
  it.each(["ماتش حلو", "الأهلي أحسن", "جامد اوي", "هدف رائع", "الكورة دي فن", "الحكم ظلمنا", "بالتوفيق للمنتخب", "#كرة_القدم", "مبروك"])(
    "«%s» is delivered, not flagged", (comment_text) => {
      expect(decide({ comment_text, video_title: "فيديو" })).toEqual({ decision: "match", reasonAr: PRESUMED });
    },
  );

  it("the same short comments on YouTube", () => {
    for (const text of ["ماتش حلو", "الأهلي أحسن", "هدف رائع"]) expect(decide({ text }, ytContext)).toEqual({ decision: "match", reasonAr: PRESUMED });
  });

  it("emoji only, digits only, an empty text and a bare link are dropped", () => {
    for (const comment_text of ["😂😂😂", "🔥", "123", "", "   ", "https://example.com/x", "@someone"]) {
      expect(decide({ comment_text, video_title: "ملخص مباراة كرة القدم" }).decision, comment_text).toBe("no_match");
    }
    expect(decide({}).decision).toBe("no_match");
  });

  it("an ad is dropped; an ad that is also about the topic is kept", () => {
    expect(decide({ comment_text: "اشترك في قناتي وتابعني واتساب 01012345678" }).decision).toBe("no_match");
    expect(decide({ comment_text: "خصم 50% على كل المنتجات اطلب الان" }).decision).toBe("no_match");
    expect(decide({ comment_text: "تابع ملخص مباراة الأهلي اليوم على قناتي" }).decision).toBe("match");
  });

  it("a text in a script with no Arabic or Latin letters is dropped", () => {
    expect(decide({ comment_text: "Привет всем, отличное видео" }).decision).toBe("no_match");
    expect(decide({ comment_text: "这个视频很好看" }).decision).toBe("no_match");
    expect(decide({ comment_text: "great goal by the striker" }).decision).toBe("match");
  });

  it("comments are judged by their video: a reply «اتفقت» or a long text with no word of the topic is a real comment, presumed and not flagged", () => {
    for (const comment_text of ["اتفقت", "اتفقت تماماً", "ok", "صح"]) expect(decide({ comment_text }), comment_text).toEqual({ decision: "match", reasonAr: PRESUMED });
    const long = "الحياة رحلة طويلة والإنسان يبحث دائماً عن معنى لوجوده في هذا الكون الواسع";
    expect(decide({ comment_text: long })).toEqual({ decision: "match", reasonAr: PRESUMED });
    expect(decide({ comment_text: `${long} وكرة القدم تعلمنا الصبر` })).toEqual({ decision: "match", reasonAr: PRESUMED });
  });

  it("an explicit foreign country is still rejected", () => {
    expect(decide({ comment_text: "ماتش حلو", country_code: "SA" }).decision).toBe("no_match");
  });
});

describe("X posts of a topic search", () => {
  it("on-topic posts, short posts and replies are delivered; the empty and the ad are not", () => {
    for (const text of ["مباراة مصر والمغرب في كأس العالم كانت قوية جداً", "ماتش جامد", "اتفق معاك في كل كلمة عن الماتش"]) expect(evaluateResearchRowRelevance({ text }, xContext).decision, text).toBe("match");
    expect(evaluateResearchRowRelevance({ text: "" }, xContext).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ text: "😂😂" }, xContext).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ text: "للتواصل واتساب 01012345678 خصم خاص" }, xContext).decision).toBe("no_match");
  });

  it("a philosophical post and a bare «اتفقت» reply are flagged for the review, not delivered blindly", () => {
    const philosophical = evaluateResearchRowRelevance({ text: "الحياة رحلة طويلة، والإنسان يبحث دائماً عن معنى لوجوده في هذا الكون" }, xContext);
    expect(philosophical).toMatchObject({ decision: "match", suspicious: true });
    expect(evaluateResearchRowRelevance({ text: "اتفقت", is_reply: true }, xContext)).toMatchObject({ decision: "match", suspicious: true });
  });
});

describe("a feed with no source-side topic filter keeps the strict evidence rule", () => {
  const account = { capabilitySlug: "social-x-posts", endpointId: "anyapi.x.user.posts", params: { query: MATCH_TOPIC, channel: "@AlAhly" } };
  it("the post's own text must carry the topic", () => {
    expect(evaluateResearchRowRelevance({ text: "مباراة مصر والمغرب في كأس العالم كانت قوية جداً" }, account).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ text: "الحياة رحلة طويلة والإنسان يبحث دائماً عن معنى لوجوده" }, account).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ text: "نحتاج أن نغير العالم من حولنا بالعمل لا بالكلام" }, account).decision).toBe("uncertain");
    expect(evaluateResearchRowRelevance({ text: "" }, account).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ text: "اتفقت" }, account).decision).toBe("no_match");
  });

  it("a topic search is recognised only when there is a query and no account, channel, link or trending feed", () => {
    expect(isTopicSearchRequest({ query: "كرة القدم" })).toBe(true);
    expect(isTopicSearchRequest({ query: "كرة القدم", region: "EG", dateFrom: "2026-09-20" })).toBe(true);
    for (const extra of [{ channel: "@a" }, { channels: ["@a"] }, { url: "https://youtu.be/x" }, { trending: true }]) expect(isTopicSearchRequest({ query: "كرة القدم", ...extra })).toBe(false);
    expect(isTopicSearchRequest({ channels: [] , query: "x" })).toBe(true);
    expect(isTopicSearchRequest({})).toBe(false);
  });
});

const verdict = (v: "match" | "no_match" | "uncertain", reasonAr = "سبب") => ({ verdict: v, reasonAr });
const row = (i: number) => ({ index: i, row: { text: `منشور ${i}` } });
const review = (index: number, decision: "match" | "no_match" | "uncertain") => ({ index, decision, reasonAr: "حكم آلي" });

describe("the review is a condition of delivery for posts and comments", () => {
  it("a deterministic match is delivered only when the review says match", () => {
    const reviews = [review(0, "match"), review(1, "match"), review(2, "match"), review(3, "no_match"), review(4, "uncertain")];
    const verdicts = new Map([[0, verdict("match")], [1, verdict("no_match", "منشور فلسفي لا يتناول الموضوع")], [3, verdict("match")]]);
    const applied = applyStrictAdvisory(reviews, verdicts);
    expect(applied.reviews.map((r) => r.decision)).toEqual(["match", "uncertain", "uncertain", "no_match", "uncertain"]);
    expect(applied.reviews[1].reasonAr).toContain("منشور فلسفي لا يتناول الموضوع");
    expect(applied.reviews[2].reasonAr).toBe(UNREVIEWED_REASON_AR);
    expect(applied.unreviewed).toBe(1);
    expect(applied.demoted).toBe(2);
  });

  it("the review can never promote: excluded and reviewed-out rows stay where they are", () => {
    const applied = applyStrictAdvisory([review(0, "no_match"), review(1, "uncertain")], new Map([[0, verdict("match")], [1, verdict("match")]]));
    expect(applied.reviews.map((r) => r.decision)).toEqual(["no_match", "uncertain"]);
  });

  it("a long or malformed reply no longer throws every verdict away", () => {
    const reply = JSON.stringify({ reviews: [
      { index: 0, verdict: "match", reasonAr: "ن".repeat(600) },
      { index: 1, verdict: "no_match" },
      { index: "x", verdict: "match", reasonAr: "فهرس فاسد" },
      { index: 3, verdict: "maybe", reasonAr: "حكم غير معروف" },
      { index: 4, verdict: "uncertain", reasonAr: "غير مؤكد" },
    ] });
    const parsed = parseAdvisoryReply(`ملاحظة ${reply}`);
    expect([...parsed.keys()].sort()).toEqual([0, 1, 4]);
    expect(parsed.get(0)!.reasonAr.length).toBeLessThanOrEqual(200);
    expect(parsed.get(1)!.reasonAr).toBe("غير مطابق لموضوع الطلب");
    expect(parseAdvisoryReply("not json").size).toBe(0);
  });
});

describe("the review's own cost is capped per job", () => {
  const costly = (usd: number, seen: number[][] = []): RowAdvisorFn => async (input) => {
    seen.push(input.rows.map((r) => r.index));
    return {
      verdicts: new Map(input.rows.map((r) => [r.index, verdict("match")])),
      usage: { inputTokens: 3000, outputTokens: 800, costUsd: usd, model: "m", latencyMs: 10 },
      failure: null,
    } satisfies AdvisoryResult;
  };

  it("the cap is at least 5 cents and grows with the request", () => {
    expect(socialReviewCapUsd(30)).toBe(0.05);
    expect(socialReviewCapUsd(50)).toBe(0.05);
    expect(socialReviewCapUsd(500)).toBe(0.3);
    expect(socialReviewCapUsd(100000)).toBe(1);
  });

  it("reviews in small batches and covers every row while the budget lasts", async () => {
    const seen: number[][] = [];
    const rows = Array.from({ length: 60 }, (_, i) => row(i));
    const outcome = await reviewSocialRows({ advisor: costly(0.006, seen), customerRequest: "x", kind: "social-x-posts", rows, budgetUsd: 0.05 });
    expect(seen.map((batch) => batch.length)).toEqual([SOCIAL_REVIEW_ROWS_PER_CALL, SOCIAL_REVIEW_ROWS_PER_CALL, 10]);
    expect(outcome.unreviewed).toEqual([]);
    expect(outcome.stoppedBy).toBeNull();
    expect(outcome.costUsd).toBeCloseTo(0.018, 6);
  });

  it("stops asking once the budget is used: the rest is left unreviewed, not delivered by default", async () => {
    const seen: number[][] = [];
    const rows = Array.from({ length: 60 }, (_, i) => row(i));
    const outcome = await reviewSocialRows({ advisor: costly(0.06, seen), customerRequest: "x", kind: "social-x-posts", rows, budgetUsd: 0.05 });
    expect(seen).toHaveLength(1);
    expect(outcome.unreviewed).toHaveLength(35);
    expect(outcome.stoppedBy).toBe("cap");
    expect(outcome.verdicts.size).toBe(25);
  });

  it("a budget already spent by earlier chunks reviews nothing", async () => {
    const seen: number[][] = [];
    const outcome = await reviewSocialRows({ advisor: costly(0.006, seen), customerRequest: "x", kind: "social-x-posts", rows: [row(0), row(1)], budgetUsd: 0 });
    expect(seen).toHaveLength(0);
    expect(outcome.unreviewed).toEqual([0, 1]);
  });

  it("a reviewer that answers nothing readable is asked once per page, never delivers by default and never throws", async () => {
    let calls = 0;
    const failing: RowAdvisorFn = async () => { calls += 1; return { verdicts: new Map(), usage: { inputTokens: 100, outputTokens: 0, costUsd: 0.001, model: "m", latencyMs: 5 }, failure: "bad_reply" }; };
    const outcome = await reviewSocialRows({ advisor: failing, customerRequest: "x", kind: "social-x-posts", rows: Array.from({ length: 60 }, (_, i) => row(i)), budgetUsd: 0.05 });
    expect(calls).toBe(1);
    expect(outcome.unreviewed).toHaveLength(60);
    expect(outcome.stoppedBy).toBe("failed");
    const throwing: RowAdvisorFn = async () => { throw new Error("down"); };
    const crashed = await reviewSocialRows({ advisor: throwing, customerRequest: "x", kind: "social-x-posts", rows: [row(0)], budgetUsd: 0.05 });
    expect(crashed.unreviewed).toEqual([0]);
  });
});

describe("the review spend travels with the running record so the cap holds across chunks", () => {
  it("adds each chunk's review cost to the record and reads it back", async () => {
    const identityOf = (row: any) => row.id ?? null;
    const first = extendRunningSet(emptyRunningSet(), 0, { rows: [{ id: "a" }], batchUnits: 1, reviewUsd: 0.018 }, identityOf);
    const second = extendRunningSet(first, 1, { rows: [{ id: "b" }], batchUnits: 1, reviewUsd: 0.012 }, identityOf);
    expect(first.reviewUsd).toBe(0.018);
    expect(second.reviewUsd).toBe(0.03);
    const quiet = extendRunningSet(second, 2, { rows: [], batchUnits: 0 }, identityOf);
    expect(quiet.reviewUsd).toBe(0.03);
    const store = new Map<string, Buffer>();
    const bucket = {
      upload: async (path: string, body: Buffer) => { store.set(path, body); return { error: null }; },
      download: async (path: string) => (store.has(path) ? { data: new Blob([new Uint8Array(store.get(path)!)]), error: null } : { data: null, error: { message: "x" } }),
    };
    await saveRunningSet(bucket, "job_x", second);
    expect((await loadRunningSet(bucket, "job_x", 1))?.reviewUsd).toBe(0.03);
  });

  it("a job that is not reviewed this way has no review spend recorded", () => {
    const set = extendRunningSet(emptyRunningSet(), 0, { rows: [{ id: "a" }], batchUnits: 1 }, (row: any) => row.id);
    expect("reviewUsd" in set).toBe(false);
  });
});
