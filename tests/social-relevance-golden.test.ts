import { describe, expect, it } from "vitest";
import { emptyRunningSet, extendRunningSet, loadRunningSet, saveRunningSet } from "../src/lib/server/jobRunningSet";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import {
  applyStrictAdvisory, parseAdvisoryReply, reviewSocialRows, SOCIAL_REVIEW_ROWS_PER_CALL, socialReviewCapUsd, UNREVIEWED_REASON_AR,
  type AdvisoryResult, type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";

const MATCH_TOPIC = "مباراة مصر والمغرب كأس العالم";
const xContext = { capabilitySlug: "social-x-posts", endpointId: "anyapi.x.search.posts", params: { query: MATCH_TOPIC } };
const tiktokContext = { capabilitySlug: "social-tiktok-comments", endpointId: "tikhub.tiktok.video.comments", params: { query: "كرة القدم", region: "EG" } };

/** Golden fixtures: what each kind of row must do against a topic, by evidence in its own text. */
describe("X posts: the post's own text must carry the topic", () => {
  it("on-topic posts are matched", () => {
    for (const text of [
      "مباراة مصر والمغرب في كأس العالم كانت قوية جداً",
      "ملخص مباراة مصر والمغرب كأس العالم: هدف في الدقيقة الأخيرة",
      "بعد مباراة مصر والمغرب في كأس العالم الجماهير في الشوارع",
    ]) expect(evaluateResearchRowRelevance({ text }, xContext).decision, text).toBe("match");
  });

  it("a philosophical post with no word of the topic is not matched", () => {
    const result = evaluateResearchRowRelevance({ text: "الحياة رحلة طويلة، والإنسان يبحث دائماً عن معنى لوجوده في هذا الكون" }, xContext);
    expect(result.decision).toBe("no_match");
  });

  it("a post that shares a single word with the topic is only a doubt, never a match", () => {
    const result = evaluateResearchRowRelevance({ text: "نحتاج أن نغير العالم من حولنا بالعمل لا بالكلام" }, xContext);
    expect(result.decision).toBe("uncertain");
  });

  it("an empty text is not matched", () => {
    expect(evaluateResearchRowRelevance({ text: "" }, xContext).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ text: "😂😂😂" }, xContext).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({}, xContext).decision).toBe("no_match");
  });

  it("a reply that only says «اتفقت» is not matched", () => {
    expect(evaluateResearchRowRelevance({ text: "اتفقت", is_reply: true }, xContext).decision).toBe("no_match");
  });
});

describe("TikTok comments: the comment's own words first, the video only as context", () => {
  const footballVideo = { video_title: "ملخص مباراة كرة القدم في مصر" };

  it("a comment with its own content under a video about the topic is matched", () => {
    expect(evaluateResearchRowRelevance({ comment_text: "هدف رائع في الدقيقة الأخيرة", ...footballVideo }, tiktokContext).decision).toBe("match");
  });

  it("a comment that names the topic itself is matched, whatever the video", () => {
    expect(evaluateResearchRowRelevance({ comment_text: "أحب كرة القدم المصرية", video_title: "وصفة كنافة" }, tiktokContext).decision).toBe("match");
  });

  it("a reply that only says «اتفقت» under an on-topic video goes to review, not to delivery", () => {
    for (const comment_text of ["اتفقت", "اتفقت تماماً", "ok", "صح"]) {
      expect(evaluateResearchRowRelevance({ comment_text, ...footballVideo }, tiktokContext).decision, comment_text).toBe("uncertain");
    }
  });

  it("an empty comment is not matched, even under an on-topic video", () => {
    expect(evaluateResearchRowRelevance({ comment_text: "", ...footballVideo }, tiktokContext).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ comment_text: "🔥🔥", ...footballVideo }, tiktokContext).decision).toBe("no_match");
  });

  it("a philosophical comment under an unrelated video is not matched", () => {
    expect(evaluateResearchRowRelevance({ comment_text: "الحياة قصيرة فاستمتع بكل لحظة", video_title: "وصفة كنافة" }, tiktokContext).decision).toBe("no_match");
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
