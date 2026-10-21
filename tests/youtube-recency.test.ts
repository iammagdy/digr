import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import { setRelativeDateClockForTesting } from "../src/lib/server/relativeDate";
import { youtubeRecencyFor, YOUTUBE_OLD_WINDOW_NOTE_AR } from "../src/lib/youtubeRecency";
import { getSocialCapability } from "../src/lib/socialSources";
import { youtubeRecencySentenceAr } from "../src/lib/server/dateWindowNotes";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const WINDOW = { dateFrom: "2026-09-20", dateTo: "2026-10-20" };
const SEARCH_TIKHUB = "tikhub.youtube.search.videos";
const SEARCH_CRAWL = "crawl4ai.youtube.search.videos";

const ok = (rows: Array<Record<string, any>>, costMicro = 900): SocialCallOutcome => ({ ok: true, httpStatus: 200, data: { ok: true, rows }, costMicro, tregCallId: "call" });
const failed = (): SocialCallOutcome => ({ ok: false, httpStatus: 500, data: null, costMicro: 0, tregCallId: "", errorCode: "provider_error", errorMessageAr: "تعذر الاتصال بالمصدر" });
const id = (n: number) => `vid${String(n).padStart(8, "0")}`.slice(0, 11).padEnd(11, "x");
const video = (n: number, when: Record<string, any>) => ({ video_id: id(n), title: `مباراة ${n}`, ...when });
const OLD = { published_at: "2026-08-06T10:00:00Z" };
const RECENT = (day: number) => ({ published_at: `2026-10-${String(day).padStart(2, "0")}T10:00:00Z` });
const comments = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ comment_id: `${tag}${i}`, text: `تعليق ${tag} ${i} عن الماتش`, author: "أحمد" }));

type Seen = Array<{ endpoint: string; params: Record<string, any> }>;

function chunk(call: SocialCall, params: Record<string, any> = { query: "كرة القدم", ...WINDOW }, target = 10) {
  return runSocialChunk({
    jobId: "job_yt", userId: "u", step: 0, endpointId: "crawl4ai.youtube.video.comments", capabilitySlug: "social-youtube-comments", method: "POST", params,
    paginationStrategy: "cursor", cursor: null, pageSize: target, remainingNeeded: target, targetVolumeMax: target, deliveredSoFar: 0,
  } as any, { call, now: () => NOW });
}

describe("YouTube topic search with a window", () => {
  beforeEach(() => setRelativeDateClockForTesting(() => NOW));
  afterEach(() => setRelativeDateClockForTesting(null));

  const provider = (opts: { tikhub: Array<() => SocialCallOutcome>; crawl?: () => SocialCallOutcome; commentsOf: (videoId: string) => Array<Record<string, any>> }) => {
    const seen: Seen = [];
    let tikhubCalls = 0;
    const call: SocialCall = async (source, params) => {
      seen.push({ endpoint: source.endpointId, params });
      if (source.endpointId === SEARCH_TIKHUB) return (opts.tikhub[Math.min(tikhubCalls++, opts.tikhub.length - 1)] ?? failed)();
      if (source.endpointId === SEARCH_CRAWL) return (opts.crawl ?? failed)();
      return ok(opts.commentsOf(String(params.video).replace(/^.*[?&]v=/, "")));
    };
    return { call, seen };
  };
  const searches = (seen: Seen) => seen.filter((entry) => entry.endpoint.includes(".search.")).map((entry) => entry.endpoint);

  it("asks the search for the newest videos first, with the upload-date bucket and the order, before any other source", async () => {
    const { call, seen } = provider({ tikhub: [() => ok([video(1, RECENT(15)), video(2, RECENT(10))])], commentsOf: () => comments(5, "a") });
    const out = await chunk(call);
    expect(out.ok).toBe(true);
    expect(seen[0].endpoint).toBe(SEARCH_TIKHUB);
    expect(seen[0].params).toEqual({ keyword: "كرة القدم", upload_date: "year", sort_by: "upload_date" });
    expect(searches(seen)).toEqual([SEARCH_TIKHUB]);
    expect(out.discoveryWindow).toBe("recency_applied");
  });

  it("the bucket follows the window: last week, last month, last year", () => {
    expect(youtubeRecencyFor("2026-10-17", "2026-10-21", NOW)).toEqual({ upload_date: "week", sort_by: "upload_date" });
    expect(youtubeRecencyFor("2026-10-01", "2026-10-21", NOW)).toEqual({ upload_date: "month", sort_by: "upload_date" });
    expect(youtubeRecencyFor("2026-09-20", "2026-10-20", NOW)).toEqual({ upload_date: "year", sort_by: "upload_date" });
    expect(youtubeRecencyFor("2026-01-01", "2026-03-01", NOW)).toEqual({ upload_date: "year", sort_by: "upload_date" });
    expect(youtubeRecencyFor(undefined, "2026-10-20", NOW)).toEqual({ sort_by: "upload_date" });
  });

  it("a window with no dates, or one that starts more than a year ago, has no recency control", () => {
    expect(youtubeRecencyFor(undefined, undefined, NOW)).toBeNull();
    expect(youtubeRecencyFor("2025-06-01", "2025-06-30", NOW)).toBeNull();
  });

  it("an old page, then a recent one: when the search that takes the control failed and the other source returned only old videos, ONE more attempt with the control reads the recent videos", async () => {
    const { call, seen } = provider({
      tikhub: [failed, () => ok([video(1, RECENT(18)), video(2, RECENT(12))])],
      crawl: () => ok([video(7, OLD), video(8, { published_at: "2026-08-03T10:00:00Z" }), video(9, { published_at: "2026-08-20T10:00:00Z" })]),
      commentsOf: () => comments(5, "r"),
    });
    const out = await chunk(call);
    expect(searches(seen)).toEqual([SEARCH_TIKHUB, SEARCH_CRAWL, SEARCH_TIKHUB]);
    const read = seen.filter((entry) => !entry.endpoint.includes(".search.")).map((entry) => String(entry.params.video));
    expect(read.every((video) => video.includes(id(1)) || video.includes(id(2)))).toBe(true);
    expect(read.some((video) => video.includes(id(7)))).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.rows.length).toBeGreaterThan(0);
    expect(out.discoveryWindow).toBe("recency_applied");
  });

  it("the extra attempt happens once: if it fails too, the old videos are read behind the safety net and the line says the order could not be asked for", async () => {
    const { call, seen } = provider({ tikhub: [failed], crawl: () => ok([video(7, OLD)]), commentsOf: () => comments(4, "o") });
    const out = await chunk(call);
    expect(searches(seen)).toEqual([SEARCH_TIKHUB, SEARCH_CRAWL, SEARCH_TIKHUB]);
    expect(out.ok).toBe(true);
    expect(out.discoveryWindow).toBe("recency_unsupported");
    expect(youtubeRecencySentenceAr("recency_unsupported")).toContain("ننصح بإرسال روابط الفيديوهات أو اسم القناة");
  });

  it("a page already asked for the newest videos that still has none inside the window is not asked again, and the hint says the control was tried", async () => {
    const { call, seen } = provider({ tikhub: [() => ok([video(1, OLD), video(2, { published_at: "2026-08-03T10:00:00Z" })])], commentsOf: () => comments(5, "o") });
    const out = await chunk(call);
    expect(searches(seen)).toEqual([SEARCH_TIKHUB]);
    expect(out.discoveryWindow).toBe("recency_applied");
    expect(youtubeRecencySentenceAr("recency_applied")).toContain("طلبنا من يوتيوب الفيديوهات الأحدث أولاً");
    expect(youtubeRecencySentenceAr("recency_applied")).toContain("ننصح بإرسال روابط الفيديوهات أو اسم القناة");
  });

  it("a window the control cannot express (older than a year) uses the catalog order with no recency parameters and says so", async () => {
    const { call, seen } = provider({ tikhub: [() => ok([video(1, OLD)])], crawl: () => ok([video(1, OLD)]), commentsOf: () => comments(3, "o") });
    const out = await chunk(call, { query: "كرة القدم", dateFrom: "2025-06-01", dateTo: "2025-06-30" });
    expect(seen[0].endpoint).toBe(SEARCH_CRAWL);
    expect(seen[0].params).toEqual({ query: "كرة القدم", limit: expect.any(Number) });
    expect(seen.some((entry) => "upload_date" in entry.params || "sort_by" in entry.params)).toBe(false);
    expect(out.discoveryWindow).toBe("recency_unsupported");
    expect(YOUTUBE_OLD_WINDOW_NOTE_AR).toContain("ننصح بإرسال روابط الفيديوهات أو اسم القناة");
    expect(YOUTUBE_OLD_WINDOW_NOTE_AR).not.toMatch(/[A-Za-z]/);
  });

  it("without a window nothing changes: the catalog order, no recency parameter, no hint", async () => {
    const { call, seen } = provider({ tikhub: [() => ok([video(1, {})])], crawl: () => ok([video(1, {})]), commentsOf: () => comments(3, "n") });
    const out = await chunk(call, { query: "كرة القدم" });
    expect(seen[0].endpoint).toBe(SEARCH_CRAWL);
    expect(seen.some((entry) => "upload_date" in entry.params || "sort_by" in entry.params)).toBe(false);
    expect(out.discoveryWindow).toBeUndefined();
  });

  it("videos inside the window are read first, then the ones with no date, then the old ones", async () => {
    const { call, seen } = provider({
      tikhub: [() => ok([video(1, OLD), video(2, {}), video(3, RECENT(14)), video(4, RECENT(5))])],
      commentsOf: () => [],
    });
    await chunk(call, { query: "كرة القدم", ...WINDOW, videoCount: 4 }, 40);
    const read = seen.filter((entry) => !entry.endpoint.includes(".search.")).map((entry) => String(entry.params.video));
    expect(read.map((video) => [1, 2, 3, 4].find((n) => video.includes(id(n))))).toEqual([3, 4, 2, 1]);
  });

  it("relative video dates: «منذ ٣ أسابيع» and «منذ يومين» are inside the last month, «منذ ٥ أشهر» is not and is read last", async () => {
    const { call, seen } = provider({
      tikhub: [() => ok([video(1, { published_time_text: "منذ ٥ أشهر" }), video(2, { published_time_text: "منذ ٣ أسابيع" }), video(3, { published_time_text: "منذ يومين" })])],
      commentsOf: () => [],
    });
    await chunk(call, { query: "كرة القدم", ...WINDOW, videoCount: 3 }, 40);
    const read = seen.filter((entry) => !entry.endpoint.includes(".search.")).map((entry) => String(entry.params.video));
    expect(read.map((video) => [1, 2, 3].find((n) => video.includes(id(n))))).toEqual([2, 3, 1]);
  });

  it("only the comments inside the window count toward the target: an old video does not end the job, the next one is read", async () => {
    const { call, seen } = provider({
      tikhub: [() => ok([video(1, OLD), video(2, RECENT(15))])],
      commentsOf: (videoId) => (videoId.startsWith(id(1).slice(0, 6)) && videoId.includes(id(1)) ? comments(10, "old") : comments(10, "new")),
    });
    // the old video is listed first by the source but read last; ask for 10 so the in-window one satisfies the job on its own
    const out = await chunk(call, { query: "كرة القدم", ...WINDOW, videoCount: 2 }, 10);
    const read = seen.filter((entry) => !entry.endpoint.includes(".search.")).map((entry) => String(entry.params.video));
    expect(read).toHaveLength(1);
    expect(read[0]).toContain(id(2));
    expect(out.rows.map((row) => row.text).every((text) => String(text).includes("new"))).toBe(true);
  });

  it("comments with their own dates: the first video's comments are all outside, so the job reads the second video instead of stopping at the target", async () => {
    const datedComments = (n: number, tag: string, date: string) => comments(n, tag).map((row) => ({ ...row, published_at: date }));
    const { call, seen } = provider({
      tikhub: [() => ok([video(1, {}), video(2, {})])],
      commentsOf: (videoId) => (videoId.includes(id(1)) ? datedComments(10, "old", "2026-08-06T10:00:00Z") : datedComments(10, "new", "2026-10-10T10:00:00Z")),
    });
    const out = await chunk(call, { query: "كرة القدم", ...WINDOW, videoCount: 2 }, 10);
    const read = seen.filter((entry) => !entry.endpoint.includes(".search.")).map((entry) => String(entry.params.video));
    expect(read).toHaveLength(2);
    expect(out.rows.filter((row) => String(row.text).includes("new"))).toHaveLength(10);
    expect(out.nextCursor).toBeNull();
  });

  it("when every video is outside the window the job reads the next video instead of stopping after the first one, within the call limit", async () => {
    const { call, seen } = provider({
      tikhub: [() => ok(Array.from({ length: 10 }, (_, i) => video(i + 1, OLD)))],
      commentsOf: () => comments(10, "old"),
    });
    const out = await chunk(call, { query: "كرة القدم", ...WINDOW, videoCount: 10 }, 10);
    const reads = seen.filter((entry) => !entry.endpoint.includes(".search.")).length;
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThanOrEqual(6);
    expect(out.ok).toBe(true);
    expect(out.discoveryWindow).toBe("recency_applied");
  });

  it("the capability's catalog order is unchanged (the source measured at 97 percent stays first)", () => {
    const sources = getSocialCapability("social-youtube-comments")!.discover.query!;
    expect(sources.map((source) => source.endpointId)).toEqual([SEARCH_CRAWL, SEARCH_TIKHUB]);
    expect(sources.map((source) => Boolean(source.recency))).toEqual([false, true]);
  });
});
