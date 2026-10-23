import { describe, expect, it } from "vitest";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { groupRowsByVideo, judgeVideos, videoEvidence } from "../src/lib/server/videoRelevance";
import type { AdvisoryVerdict, RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";

/**
 * The customer's TikTok request «٥٠ تعليق من فيديوهات تيك توك الأكثر انتشارًا عن كرة السلة في مصر»: the source returned 113 comments and the
 * topic filter rejected every one. Before the fix a basketball request was the only topic carved OUT of the topic-search rule, so each short
 * comment was judged on its own words (and on its video's title) against a strict list of basketball words; the comments of a video titled
 * with a hashtag, an emoji or a player's name never said «كرة السلة», so all of them were «no_match» and the video-level review never ran.
 */
const context = { capabilitySlug: "social-tiktok-comments", endpointId: "tikhub.tiktok.video.comments", params: { query: "كرة السلة", region: "EG" } };
const decide = (row: Record<string, any>) => evaluateResearchRowRelevance(row, context);
const verdict = (v: AdvisoryVerdict["verdict"]): AdvisoryVerdict => ({ verdict: v, reasonAr: "سبب" });
const usage = { inputTokens: 400, outputTokens: 100, costUsd: 0.002, model: "fake-model", latencyMs: 5 };

const VIDEOS = [
  { url: "https://www.tiktok.com/@a/video/1", title: "أفضل لقطات الدوري المصري لكرة السلة #كرة_السلة #مصر", on: true },
  { url: "https://www.tiktok.com/@b/video/2", title: "🔥🔥 دانك خرافي من لاعب الأهلي", on: true },
  { url: "https://www.tiktok.com/@c/video/3", title: "", on: true },
  { url: "https://www.tiktok.com/@d/video/4", title: "ملخص مباراة الأهلي والزمالك كرة القدم", on: false },
  { url: "https://www.tiktok.com/@e/video/5", title: "طريقة عمل الكشري", on: false },
];
const COMMENTS = ["ماتش حلو", "الله على الدانك ده", "برافو عليكم", "ايه الجمال ده", "اللعيبة دول فنانين", "نفسي أحضر مباراة زي دي", "يا سلام على الأداء", "تسلم ايدك على الفيديو"];

function pageRows(): Array<Record<string, any>> {
  const rows: Array<Record<string, any>> = [];
  for (const video of VIDEOS) {
    for (let i = 0; i < 22; i += 1) rows.push({ cid: `${video.url}-${i}`, text: `${COMMENTS[i % COMMENTS.length]} ${i}`, video_url: video.url, video_title: video.title, channel_name: "قناة" });
  }
  return rows;
}

describe("TikTok basketball comments found by the topic search", () => {
  it("the page is the customer's shape: 110 short comments under several videos", () => {
    const rows = pageRows();
    expect(rows).toHaveLength(110);
    expect(groupRowsByVideo(rows.map((row, index) => ({ index, row }))).videos).toHaveLength(5);
  });

  it("a short comment under a video whose text names neither sport is held for the video-level review, not rejected on its own words", () => {
    for (const video_title of ["", "🔥🔥 دانك خرافي من لاعب الأهلي", "#nba", "فيديو"]) {
      expect(decide({ text: "ماتش حلو", video_title }), video_title).toMatchObject({ decision: "match" });
    }
  });

  it("a comment under a basketball video, even a bare reaction, is delivered with the video", () => {
    expect(decide({ text: "مبروك", video_title: "كرة السلة في مصر" }).decision).toBe("match");
    expect(decide({ text: "تمام", video_title: "لقطات #كرة_السلة" }).decision).toBe("match");
    expect(decide({ text: "تمام", video_title: "فريق السلة الأول في مصر" }).decision).toBe("match");
  });

  it("the gate stays meaningful: football, bare reactions of no content, ads, links and empty texts are still dropped", () => {
    expect(decide({ text: "هدف رائع", video_title: "ملخص مباراة كرة القدم" }).decision).toBe("no_match");
    expect(decide({ text: "ماتش حلو", video_title: "ملخص كرة القدم" }).decision).toBe("no_match");
    expect(decide({ text: "ok", video_title: "كرة السلة" }).decision).toBe("no_match");
    expect(decide({ text: "😂😂😂", video_title: "كرة السلة" }).decision).toBe("no_match");
    expect(decide({ text: "https://example.com/x", video_title: "كرة السلة" }).decision).toBe("no_match");
    expect(decide({ text: "اشترك في قناتي وتابعني واتساب 01012345678", video_title: "كرة السلة" }).decision).toBe("no_match");
    expect(decide({ text: "", video_title: "كرة السلة" }).decision).toBe("no_match");
    expect(decide({ text: "ماتش حلو", video_title: "كرة السلة", country_code: "SA" }).decision).toBe("no_match");
  });

  it("a comment that names both sports with football dominating is held, not delivered", () => {
    expect(decide({ text: "كرة القدم أحسن من كرة السلة وكرة القدم أجمل", video_title: "كرة السلة" }).decision).toBe("uncertain");
  });

  it("videos: a basketball word settles a video; a football video never counts as evidence for basketball", () => {
    const request = { query: "كرة السلة", region: "EG" };
    expect(videoEvidence("أفضل لقطات الدوري المصري لكرة السلة #كرة_السلة", request)).toBe("match");
    expect(videoEvidence("لقطات NBA في مصر", request)).toBe("match");
    expect(videoEvidence("لقطات كرة السلة", request)).toBe("needs_review");
    expect(videoEvidence("ملخص مباراة الأهلي والزمالك كرة القدم في مصر", request)).toBe("needs_review");
    expect(videoEvidence("كرة القدم وكرة السلة وكرة القدم في مصر", request)).toBe("needs_review");
    expect(videoEvidence("", request)).toBe("needs_review");
  });

  it("end to end on the page: the on-topic videos' comments are delivered, the football and unrelated videos' comments are not", async () => {
    const rows = pageRows();
    const decisions = rows.map((row) => decide(row));
    // the football video's comments never pass the gate; everything else is waiting for its video's verdict
    const passed = rows.map((row, index) => ({ index, row })).filter(({ index }) => decisions[index].decision === "match");
    expect(passed.length).toBeGreaterThan(0);
    expect(rows.filter((row, index) => row.video_url === VIDEOS[3].url && decisions[index].decision === "match")).toHaveLength(0);

    const { videos } = groupRowsByVideo(passed);
    const advisor: RowAdvisorFn = async (input) => ({
      // a fake reviewer: it answers by the video's title only
      verdicts: new Map(input.rows.map(({ index, row }) => [index, verdict(/دانك|NBA/i.test(String(row.title)) || String(row.title) === "" ? "match" : "no_match")])),
      usage, failure: null,
    });
    const outcome = await judgeVideos({ advisor, customerRequest: "٥٠ تعليق من فيديوهات تيك توك عن كرة السلة في مصر", kind: "social-tiktok-comments-video-list", videos, request: context.params, budgetUsd: 0.05 });
    const delivered = passed.filter(({ index, row }) => {
      const video = videos.find((entry) => entry.rowIndexes.includes(index));
      return outcome.judgements.get(video!.key)?.decision === "match" && decisions[index].decision === "match" && row.video_url !== VIDEOS[4].url;
    });
    // the Egyptian basketball video by evidence, the dunk video and the untitled video by the fake review: 66 comments, never the kushari or the football ones
    expect(delivered).toHaveLength(66);
    expect(delivered.some(({ row }) => row.video_url === VIDEOS[3].url || row.video_url === VIDEOS[4].url)).toBe(false);
    expect(outcome.judgements.get(VIDEOS[0].url)?.by).toBe("evidence");
  });

  it("a video the review could not judge delivers nothing (fail closed)", async () => {
    const rows = pageRows();
    const passed = rows.map((row, index) => ({ index, row })).filter(({ row }) => decide(row).decision === "match");
    const { videos } = groupRowsByVideo(passed);
    const failing: RowAdvisorFn = async () => ({ verdicts: new Map(), usage, failure: "bad_reply" });
    const outcome = await judgeVideos({ advisor: failing, customerRequest: "كرة السلة", kind: "social-tiktok-comments-video-list", videos, request: context.params, budgetUsd: 0.05 });
    const selected = videos.filter((video) => outcome.judgements.get(video.key)?.decision === "match");
    expect(selected.map((video) => video.key)).toEqual([VIDEOS[0].url]);
  });
});
