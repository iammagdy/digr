import { describe, expect, it } from "vitest";
import { withTopicCountryWord } from "../src/lib/xSearchWindow";
import { getSocialCapability, socialPlanSummaryAr, topicCountryNoteAr } from "../src/lib/socialSources";
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";

describe("the country's name in the search text of a topic search for videos", () => {
  it("adds the Arabic name of the requested country, once", () => {
    expect(withTopicCountryWord("كرة القدم", "EG")).toBe("كرة القدم مصر");
    expect(withTopicCountryWord("  كرة القدم  ", "eg")).toBe("كرة القدم مصر");
    expect(withTopicCountryWord("الغلاء", "SA")).toBe("الغلاء السعودية");
  });
  it("leaves the text as it is when it already names the country, when no country was asked for and when the region is unknown", () => {
    expect(withTopicCountryWord("كرة القدم المصرية", "EG")).toBe("كرة القدم المصرية");
    expect(withTopicCountryWord("football in egypt", "EG")).toBe("football in egypt");
    expect(withTopicCountryWord("كرة القدم", undefined)).toBe("كرة القدم");
    expect(withTopicCountryWord("كرة القدم", "ZZ")).toBe("كرة القدم");
    expect(withTopicCountryWord("", "EG")).toBe("");
  });
  it("every YouTube and TikTok topic-search source sends it; none sends it without a country", () => {
    for (const slug of ["social-youtube-comments", "social-youtube-videos", "social-tiktok-comments", "social-tiktok-videos"]) {
      for (const source of getSocialCapability(slug)!.discover.query!) {
        const withCountry = JSON.stringify(source.build({ query: "كرة القدم", limit: 20, region: "EG" }));
        const without = JSON.stringify(source.build({ query: "كرة القدم", limit: 20 }));
        expect(withCountry, `${slug} ${source.endpointId}`).toContain("كرة القدم مصر");
        expect(without, `${slug} ${source.endpointId}`).not.toContain("مصر");
      }
    }
  });
  it("the plan text says so for YouTube and TikTok topic searches, and says nothing without a country or for other kinds of request", () => {
    const fmt = (n: number) => String(n);
    const youtube = getSocialCapability("social-youtube-comments")!;
    const tiktok = getSocialCapability("social-tiktok-comments")!;
    const note = "، ويُضاف اسم الدولة (مصر) إلى كلمات البحث ليقتصر على الفيديوهات التي تخصها";
    expect(topicCountryNoteAr(youtube, { query: "كرة القدم", region: "EG" })).toBe(note);
    expect(topicCountryNoteAr(tiktok, { query: "كرة القدم", region: "EG" })).toBe(note);
    expect(topicCountryNoteAr(youtube, { query: "كرة القدم" })).toBe("");
    expect(topicCountryNoteAr(getSocialCapability("x-search-posts") ?? getSocialCapability("social-x-posts")!, { query: "كرة القدم", region: "EG" })).toBe("");
    expect(socialPlanSummaryAr(youtube, { query: "كرة القدم", region: "EG" }, 300, fmt)).toContain(`عن «كرة القدم»${note}`);
    expect(socialPlanSummaryAr(tiktok, { query: "كرة القدم", region: "EG" }, 30, fmt)).toContain(note);
    expect(socialPlanSummaryAr(youtube, { query: "كرة القدم" }, 300, fmt)).not.toContain("اسم الدولة");
    expect(socialPlanSummaryAr(youtube, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", region: "EG" }, 30, fmt)).not.toContain("اسم الدولة");
  });
});

describe("the wider second search of a topic search with no usable video", () => {
  const NOW = Date.parse("2026-10-23T12:00:00Z");
  const ok = (rows: Array<Record<string, any>>): SocialCallOutcome => ({ ok: true, httpStatus: 200, data: { ok: true, rows }, costMicro: 900, tregCallId: "call" });
  const input = (params: Record<string, any>) => ({
    jobId: "job_w", userId: "u", step: 0, endpointId: "crawl4ai.youtube.video.comments", capabilitySlug: "social-youtube-comments", method: "POST" as const, params,
    paginationStrategy: "cursor" as const, cursor: null, pageSize: 50, remainingNeeded: 300, targetVolumeMax: 300, deliveredSoFar: 0,
  });

  it("with a window and a country: the first search carries the country word and the recency control, the second carries neither and asks the other source first", async () => {
    const seen: Array<{ endpoint: string; params: Record<string, any> }> = [];
    const call: SocialCall = async (source, params) => { seen.push({ endpoint: source.endpointId, params }); return ok(seen.length === 1 ? [{ video_id: "aaaaaaaaaaa", title: "x" }] : [{ video_id: "bbbbbbbbbbb", title: "y" }]); };
    const judged: string[][] = [];
    const out = await runSocialChunk(input({ query: "كرة القدم", region: "EG", dateFrom: "2026-09-23", dateTo: "2026-10-23" }) as any, {
      call, now: () => NOW, videoSelector: async (refs) => { judged.push(refs.map((ref) => String(ref.title))); return { adopted: [] }; },
    });
    expect(seen.map((entry) => entry.endpoint)).toEqual(["tikhub.youtube.search.videos", "crawl4ai.youtube.search.videos"]);
    expect(seen[0].params).toEqual({ keyword: "كرة القدم مصر", upload_date: "year", sort_by: "upload_date" });
    expect(seen[1].params).toEqual({ query: "كرة القدم", limit: 20 });
    expect(judged).toEqual([["x"], ["y"]]);
    expect(out.emptyReason).toBe("no_relevant_videos");
    expect(out.rows).toHaveLength(0);
    expect(out.discoveryWindow).toBe("recency_unsupported");
  });

  it("a second search that finds only the videos the first one showed judges nothing again and stops", async () => {
    let searches = 0;
    const call: SocialCall = async () => { searches += 1; return ok([{ video_id: "aaaaaaaaaaa", title: "x" }]); };
    const judged: string[][] = [];
    const out = await runSocialChunk(input({ query: "كرة القدم", region: "EG" }) as any, { call, now: () => NOW, videoSelector: async (refs) => { judged.push(refs.map((ref) => String(ref.title))); return { adopted: [] }; } });
    expect(searches).toBe(2);
    expect(judged).toEqual([["x"]]);
    expect(out.emptyReason).toBe("no_relevant_videos");
  });

  it("when the first search already gave a video to read (approved or unsure) no second search is made", async () => {
    let searches = 0;
    const call: SocialCall = async (source) => { if (source.endpointId.includes(".search.")) { searches += 1; return ok([{ video_id: "aaaaaaaaaaa", title: "x" }]); } return ok([{ comment_id: "c1", text: "تعليق عن الماتش", author: "منى" }]); };
    const out = await runSocialChunk(input({ query: "كرة القدم", region: "EG" }) as any, { call, now: () => NOW, videoSelector: async (refs) => ({ adopted: [], deferred: refs }) });
    expect(searches).toBe(1);
    expect(out.rows).toHaveLength(1);
  });

  it("a second search whose sources both fail leaves the first answer's verdict: no video, and no further search", async () => {
    const seen: string[] = [];
    const call: SocialCall = async (source) => {
      seen.push(source.endpointId);
      return seen.length === 1 ? ok([{ video_id: "aaaaaaaaaaa", title: "x" }]) : { ok: false, httpStatus: 500, data: null, costMicro: 0, tregCallId: "", errorCode: "http_500" };
    };
    const out = await runSocialChunk(input({ query: "كرة القدم", region: "EG" }) as any, { call, now: () => NOW, videoSelector: async () => ({ adopted: [] }) });
    // the first search, then ONE wider search whose two sources both fail: three calls in all, never a further search
    expect(seen).toEqual(["crawl4ai.youtube.search.videos", "tikhub.youtube.search.videos", "crawl4ai.youtube.search.videos"]);
    expect(out.emptyReason).toBe("no_relevant_videos");
  });
});
