import { describe, expect, it } from "vitest";
import { groupRowsByVideo, judgeVideos, videoEvidence, videoKeyOfRow, videoSelectionEventAr, VIDEO_UNREVIEWED_REASON_AR, type VideoJudgement } from "../src/lib/server/videoRelevance";
import { socialDedupeIdentity } from "../src/lib/server/rowDedupe";
import { regionEvidenceWords } from "../src/lib/regionNames";
import type { AdvisoryVerdict, RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";

const request = { query: "كرة القدم", region: "EG" };
const usage = (costUsd: number) => ({ inputTokens: 500, outputTokens: 200, costUsd, model: "claude-haiku-5-5", latencyMs: 10 });
const verdict = (v: AdvisoryVerdict["verdict"]): AdvisoryVerdict => ({ verdict: v, reasonAr: "سبب" });

describe("deterministic evidence in a video's own text", () => {
  it("the topic and the requested country together are evidence", () => {
    expect(videoEvidence("مباراة الأهلي والزمالك في الدوري المصري #كرة_القدم", request)).toBe("match");
    expect(videoEvidence("ملخص مباراة منتخب مصر في كأس العالم", request)).toBe("match");
  });

  it("football words alone are not enough when a country was requested: a Spanish club's highlights go to the review", () => {
    expect(videoEvidence("Real Madrid vs Barcelona highlights goal match", request)).toBe("needs_review");
    expect(videoEvidence("ملخص مباراة ريال مدريد وبرشلونة كرة القدم", request)).toBe("needs_review");
  });

  it("without a country the topic alone is evidence", () => {
    expect(videoEvidence("ملخص مباراة ريال مدريد وبرشلونة كرة القدم", { query: "كرة القدم" })).toBe("match");
  });

  it("no description, or no word of the topic («الاسطوره شيكابالا»), is not a rejection: it needs the review", () => {
    expect(videoEvidence("", request)).toBe("needs_review");
    expect(videoEvidence("   ", request)).toBe("needs_review");
    expect(videoEvidence("الاسطوره شيكابالا", request)).toBe("needs_review");
    expect(videoEvidence("طريقة عمل الكشري", { query: "كرة القدم" })).toBe("needs_review");
  });

  it("the words that show a country", () => {
    expect(regionEvidenceWords("EG")).toContain("مصري");
    expect(regionEvidenceWords("sa")).toContain("السعودية");
    expect(regionEvidenceWords("ZZ")).toEqual([]);
  });
});

describe("grouping the comments of a page by their video", () => {
  const rows = [
    { index: 0, row: { text: "حلو قوي", video_url: "https://www.tiktok.com/@u/video/1", video_title: "مباراة", channel_name: "قناة" } },
    { index: 1, row: { text: "برافو", video_url: "https://www.tiktok.com/@u/video/1", video_title: "مباراة" } },
    { index: 2, row: { text: "اتفقت", video_url: "https://www.tiktok.com/@u/video/2", video_title: "" } },
    { index: 3, row: { text: "بلا فيديو" } },
  ];
  it("one entry per video with its comment positions, and a sample of its comments as context", () => {
    const { videos, withoutVideo } = groupRowsByVideo(rows);
    expect(videos.map((video) => [video.key, video.rowIndexes])).toEqual([["https://www.tiktok.com/@u/video/1", [0, 1]], ["https://www.tiktok.com/@u/video/2", [2]]]);
    expect(videos[0]).toMatchObject({ title: "مباراة", channel: "قناة", sampleComments: ["حلو قوي", "برافو"] });
    expect(withoutVideo).toEqual([3]);
  });
  it("the key is the video's link, else its text", () => {
    expect(videoKeyOfRow({ video_url: " https://x/1 " })).toBe("https://x/1");
    expect(videoKeyOfRow({ video_title: "مباراة" })).toMatch(/^title:/);
    expect(videoKeyOfRow({ text: "x" })).toBeNull();
  });
});

describe("judging the videos of a page", () => {
  const videos = [
    { key: "a", title: "مباراة الأهلي والزمالك في الدوري المصري", channel: "", rowIndexes: [0], sampleComments: [] },
    { key: "b", title: "Real Madrid highlights", channel: "", rowIndexes: [1], sampleComments: ["هلا مدريد"] },
    { key: "c", title: "", channel: "قناة", rowIndexes: [2], sampleComments: ["ماتش حلو"] },
  ];
  const base = { customerRequest: "كرة القدم الدولة المطلوبة: مصر", kind: "social-tiktok-comments-video-list", videos, request, budgetUsd: 0.05 };

  it("evidence settles a video without a call; the others are reviewed in one call; the verdicts decide", async () => {
    const asked: number[] = [];
    const advisor: RowAdvisorFn = async (input) => { asked.push(input.rows.length); return { verdicts: new Map(input.rows.map(({ index, row }) => [index, verdict(String(row.title).includes("Real") ? "no_match" : "match")])), usage: usage(0.003), failure: null }; };
    const out = await judgeVideos({ ...base, advisor });
    expect(asked).toEqual([2]);
    expect(out.judgements.get("a")).toMatchObject({ decision: "match", by: "evidence" });
    expect(out.judgements.get("b")).toMatchObject({ decision: "no_match", by: "review" });
    expect(out.judgements.get("c")).toMatchObject({ decision: "match", by: "review" });
  });

  it("a doubt, a missing verdict and a failed call all leave the video unselected (fail closed)", async () => {
    const doubtful: RowAdvisorFn = async (input) => ({ verdicts: new Map(input.rows.map(({ index }) => [index, verdict("uncertain")])), usage: usage(0.003), failure: null });
    const out1 = await judgeVideos({ ...base, advisor: doubtful });
    expect(out1.judgements.get("b")?.decision).toBe("uncertain");
    const failing: RowAdvisorFn = async () => ({ verdicts: new Map(), usage: usage(0.001), failure: "bad_reply" });
    const out2 = await judgeVideos({ ...base, advisor: failing });
    expect(out2.judgements.get("b")).toEqual({ decision: "uncertain", reasonAr: VIDEO_UNREVIEWED_REASON_AR, by: "unreviewed" });
    expect(out2.judgements.get("a")?.decision).toBe("match");
  });

  it("a spent budget leaves the reviewed videos unselected, never selected by default", async () => {
    const advisor: RowAdvisorFn = async () => { throw new Error("must not be called"); };
    const out = await judgeVideos({ ...base, advisor, budgetUsd: 0 });
    expect(out.judgements.get("b")?.by).toBe("unreviewed");
    expect(out.judgements.get("c")?.by).toBe("unreviewed");
    expect(out.stoppedBy).toBe("cap");
  });

  it("the activity line is Arabic with Arabic-Indic digits", () => {
    const judgements: VideoJudgement[] = [
      { decision: "match", reasonAr: "x", by: "evidence" }, { decision: "match", reasonAr: "x", by: "review" },
      { decision: "no_match", reasonAr: "الفيديو عن نادٍ من دولة أخرى", by: "review" }, { decision: "uncertain", reasonAr: "y", by: "unreviewed" },
    ];
    const line = videoSelectionEventAr(judgements);
    expect(line).toBe("راجعنا فيديوهات هذه الصفحة: اعتمدنا ٢ فيديو، واستبعدنا ١ لأنها لا تتناول موضوعك (الفيديو عن نادٍ من دولة أخرى)، وأحلنا ١ إلى المراجعة لعدم التأكد من موضوعها.");
    expect(line).not.toMatch(/[A-Za-z0-9]/);
  });
});

describe("exact duplicates of a comment", () => {
  const row = (extra: Record<string, any>) => ({ cid: "c1", text: "حلو قوي", user_nickname: "منى", video_url: "https://www.tiktok.com/@u/video/1", ...extra });
  it("the same text by the same author under the same video is one comment, whatever its id", () => {
    expect(socialDedupeIdentity(row({ cid: "c1" }))).toBe(socialDedupeIdentity(row({ cid: "c2", text: "  حلو قوي!! " })));
  });
  it("another author, another video or another text is another comment", () => {
    const base = socialDedupeIdentity(row({}));
    expect(socialDedupeIdentity(row({ user_nickname: "أحمد" }))).not.toBe(base);
    expect(socialDedupeIdentity(row({ video_url: "https://www.tiktok.com/@u/video/2" }))).not.toBe(base);
    expect(socialDedupeIdentity(row({ text: "برافو" }))).not.toBe(base);
  });
  it("a row that is not such a comment keeps the source's own id", () => {
    expect(socialDedupeIdentity({ tweet_id: "T1", text: "x", author: "a" })).toBe("id:t1");
  });
});
