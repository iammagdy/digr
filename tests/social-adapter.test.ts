import { describe, it, expect } from "vitest";
import { runSocialChunk, SOCIAL_CHUNK_BUDGET_MS, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import type { ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";

let seq = 0;
const ok = (data: any, costMicro = 1000): SocialCallOutcome => ({ ok: true, httpStatus: 200, data, costMicro, tregCallId: `call_${++seq}` });
const fail = (status = 502): SocialCallOutcome => ({ ok: false, httpStatus: status, data: null, costMicro: 0, tregCallId: "", errorCode: `http_${status}`, errorMessageAr: "تعذر استخراج البيانات من المصدر بعد عدة محاولات." });

interface Recorded { endpointId: string; params: Record<string, any>; key: string }
function fakeCall(handler: (endpointId: string, params: Record<string, any>, n: number) => SocialCallOutcome, onCall?: () => void): { call: SocialCall; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    call: async (source, params, ctx) => {
      calls.push({ endpointId: source.endpointId, params, key: ctx.idempotencyKey });
      onCall?.();
      return handler(source.endpointId, params, calls.length);
    },
  };
}

function input(slug: string, params: Record<string, any>, over: Partial<ProviderAdapterCallInput> = {}): ProviderAdapterCallInput {
  return {
    jobId: "job_x", userId: "u1", step: 0, endpointId: "x", capabilitySlug: slug, method: "POST", params,
    paginationStrategy: "cursor", cursor: null, pageSize: 50, remainingNeeded: 20, targetVolumeMax: 20, deliveredSoFar: 0, ...over,
  };
}

/** Runs chunk after chunk, following the cursor, the way the worker does until the job is done or a chunk fails. */
async function runToCompletion(slug: string, params: Record<string, any>, target: number, call: SocialCall, over: Partial<ProviderAdapterCallInput> = {}) {
  const rows: Record<string, any>[] = [];
  let cursor: string | null = null;
  let chunks = 0;
  let last: Awaited<ReturnType<typeof runSocialChunk>> | null = null;
  for (let step = 0; step < 12; step++) {
    last = await runSocialChunk(input(slug, params, { step, cursor, remainingNeeded: target - rows.length, targetVolumeMax: target, deliveredSoFar: rows.length, ...over }), { call });
    chunks++;
    if (!last.ok) break;
    rows.push(...last.rows);
    cursor = last.nextCursor;
    if (!cursor || rows.length >= target) break;
  }
  return { rows, last: last!, chunks };
}

const comments = (n: number, prefix = "c", extra: Record<string, any> = {}) =>
  Array.from({ length: n }, (_, i) => ({ comment_id: `${prefix}${i + 1}`, text: `تعليق ${i + 1}`, author: "أحمد", likes: i, ...extra }));
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("one source answers", () => {
  it("searches X topics on a public keyword source and falls back without a login session", async () => {
    const { call, calls } = fakeCall((id) => id === "anyapi.x.search.posts"
      ? fail(503)
      : ok({ rows: [{ id: "t1", text: "كرة السلة" }] }, 1000));
    const out = await runSocialChunk(input("social-x-posts", { query: "كرة السلة" }, { remainingNeeded: 1, targetVolumeMax: 1, pageSize: 1 }), { call });
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(calls.map((call) => call.endpointId)).toEqual(["anyapi.x.search.posts", "tikhub.x.twitter-web-fetch-search-timeline"]);
    expect(calls[0].params).toMatchObject({ query: "كرة السلة", limit: 1 });
    expect(calls[1].params).toMatchObject({ keyword: "كرة السلة" });
  });

  it("reads X posts by account handle only when the customer supplies one", async () => {
    const { call, calls } = fakeCall(() => ok({ rows: [{ id: "t1", text: "latest" }] }));
    const out = await runSocialChunk(input("social-x-posts", { channel: "@nasa" }, { remainingNeeded: 1, targetVolumeMax: 1, pageSize: 1 }), { call });
    expect(out.ok).toBe(true);
    expect(calls[0].endpointId).toBe("anyapi.x.user.posts");
    expect(calls[0].params).toEqual({ handle: "nasa", limit: 1 });
  });

  it("collects the comments of a link from the first source, with one call and its real cost", async () => {
    const { call, calls } = fakeCall(() => ok({ ok: true, rows: comments(20) }, 900));
    const out = await runSocialChunk(input("social-youtube-comments", { url: YT }), { call });
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(20);
    expect(out.nextCursor).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].endpointId).toBe("crawl4ai.youtube.video.comments");
    expect(calls[0].params).toEqual({ video: "dQw4w9WgXcQ", limit: 20 });
    expect(out.costMicro).toBe(900);
    expect(out.costUsd).toBeCloseTo(0.0009, 6);
  });

  it("never returns more rows than the job still needs", async () => {
    const { call } = fakeCall(() => ok({ rows: comments(500) }));
    const out = await runSocialChunk(input("social-youtube-comments", { url: YT }, { remainingNeeded: 20, targetVolumeMax: 20 }), { call });
    expect(out.rows).toHaveLength(20);
  });
});

describe("a failing source falls through to the next", () => {
  it("a failed first source is replaced by the second, and both calls are costed", async () => {
    const { call, calls } = fakeCall((id) => (id === "crawl4ai.youtube.video.comments" ? fail(502) : ok({ data: { comments: comments(20) } }, 1000)));
    const out = await runSocialChunk(input("social-youtube-comments", { url: YT }), { call });
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(20);
    expect(calls.map((c) => c.endpointId)).toEqual(["crawl4ai.youtube.video.comments", "tikhub.youtube.video.comments"]);
  });

  it("an answer in an unrecognized shape is treated as a failed source", async () => {
    const { call, calls } = fakeCall((id) => (id === "crawl4ai.youtube.video.comments" ? ok({ message: "rate limited" }) : ok({ comments: comments(5) })));
    const out = await runSocialChunk(input("social-youtube-comments", { url: YT }, { remainingNeeded: 5, targetVolumeMax: 5 }), { call });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("an empty first page is checked with the next source; an empty answer everywhere is a valid empty result, not a failure", async () => {
    const found = fakeCall((id) => (id === "crawl4ai.youtube.video.comments" ? ok({ rows: [] }) : ok({ comments: comments(3) })));
    const a = await runSocialChunk(input("social-youtube-comments", { url: YT }, { remainingNeeded: 3, targetVolumeMax: 3 }), { call: found.call });
    expect(a.ok).toBe(true);
    expect(a.rows).toHaveLength(3);

    const none = fakeCall(() => ok({ rows: [] }));
    const b = await runSocialChunk(input("social-youtube-comments", { url: YT }), { call: none.call });
    expect(b.ok).toBe(true);
    expect(b.rows).toHaveLength(0);
    expect(b.nextCursor).toBeNull();
    expect(none.calls).toHaveLength(2);
  });

  it("when every source fails the chunk fails with a plain Arabic reason and the spend so far", async () => {
    const { call } = fakeCall(() => fail(502));
    const out = await runSocialChunk(input("social-youtube-comments", { url: YT }), { call });
    expect(out.ok).toBe(false);
    expect(out.errorMessageAr).toMatch(/^[^A-Za-z]+$/);
    expect(out.rows).toHaveLength(0);
  });

  it("a request no source can serve fails before any call (a TikTok short link with no usable source)", async () => {
    const { call, calls } = fakeCall(() => ok({ rows: comments(1) }));
    const out = await runSocialChunk(input("social-tiktok-comments", { url: "https://vm.tiktok.com/ZMabc/" }), { call });
    // The first source needs a numeric id; the second accepts the link itself.
    expect(calls.map((c) => c.endpointId)).toEqual(["crawl4ai.tiktok.video.comments"]);
    expect(out.ok).toBe(true);
  });

  it("parameters that name nothing to collect fail without calling anyone", async () => {
    const { call, calls } = fakeCall(() => ok({ rows: [] }));
    const out = await runSocialChunk(input("social-youtube-comments", {}), { call });
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const videosByLink = await runSocialChunk(input("social-tiktok-videos", { url: "https://www.tiktok.com/@u/video/7231337071831321903" }), { call });
    expect(videosByLink.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("paging stays on the source the cursor belongs to", () => {
  const tiktokPage = (n: number, cursor: number, more: number) => ok({ code: 200, data: { comments: comments(n, `t${cursor}_`), cursor, has_more: more } });

  it("continues with the same source and its cursor, and stops when the source says there is no more", async () => {
    const first = fakeCall(() => tiktokPage(20, 20, 1));
    const a = await runSocialChunk(input("social-tiktok-comments", { url: "https://www.tiktok.com/@u/video/7231337071831321903" }, { remainingNeeded: 40, targetVolumeMax: 40, pageSize: 20 }), { call: first.call });
    expect(a.rows).toHaveLength(20);
    expect(a.nextCursor).not.toBeNull();
    expect(first.calls[0].endpointId).toBe("tikhub.tiktok.video.comments");

    const second = fakeCall(() => tiktokPage(20, 40, 0));
    const b = await runSocialChunk(input("social-tiktok-comments", { url: "https://www.tiktok.com/@u/video/7231337071831321903" }, { step: 1, cursor: a.nextCursor, remainingNeeded: 20, targetVolumeMax: 40, deliveredSoFar: 20, pageSize: 20 }), { call: second.call });
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0].endpointId).toBe("tikhub.tiktok.video.comments");
    expect(second.calls[0].params.cursor).toBe(20);
    expect(b.rows).toHaveLength(20);
    expect(b.nextCursor).toBeNull();
  });

  it("an offset-paged search moves its offset by the rows it received", async () => {
    const tiktokVideos = (n: number, tag: string) => ok({ data: { videos: Array.from({ length: n }, (_, i) => ({ aweme_id: `${7000000000 + i}${tag}`, desc: `فيديو ${i}` })) } });
    const a = fakeCall(() => tiktokVideos(20, "a"));
    const first = await runSocialChunk(input("social-tiktok-videos", { query: "قهوة" }, { remainingNeeded: 40, targetVolumeMax: 40, pageSize: 20 }), { call: a.call });
    expect(a.calls[0].params).toMatchObject({ keyword: "قهوة", offset: 0 });
    expect(first.nextCursor).not.toBeNull();

    const b = fakeCall(() => tiktokVideos(20, "b"));
    await runSocialChunk(input("social-tiktok-videos", { query: "قهوة" }, { step: 1, cursor: first.nextCursor, remainingNeeded: 20, targetVolumeMax: 40, deliveredSoFar: 20, pageSize: 20 }), { call: b.call });
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0].endpointId).toBe("tikhub.tiktok.search.videos");
    expect(b.calls[0].params.offset).toBe(20);
  });
});

describe("videos and then their comments, in one job", () => {
  const feed = (n: number) => ok({ aweme_list: Array.from({ length: n }, (_, i) => ({ aweme_id: `72313370718313219${String(i).padStart(2, "0")}`, desc: `فيديو ${i + 1}`, share_url: `https://www.tiktok.com/@u/video/72313370718313219${String(i).padStart(2, "0")}` })) });
  const handler = (id: string, params: Record<string, any>) => {
    if (id === "scrapecreators.x.v1-tiktok-get-trending-feed") return feed(8);
    if (id === "tikhub.tiktok.video.comments") return ok({ data: { comments: comments(10, `${params.aweme_id}_`), cursor: 10, has_more: 0 } });
    return fail(502);
  };

  it("finds the trending videos once, then collects each one's comments and marks which video a comment belongs to", async () => {
    const { call, calls } = fakeCall(handler);
    const out = await runSocialChunk(input("social-tiktok-comments", { trending: true, region: "EG", perVideo: 10 }, { remainingNeeded: 30, targetVolumeMax: 30 }), { call });
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(30);
    expect(calls[0].endpointId).toBe("scrapecreators.x.v1-tiktok-get-trending-feed");
    expect(calls[0].params).toEqual({ region: "EG" });
    expect(calls.slice(1).every((c) => c.endpointId === "tikhub.tiktok.video.comments")).toBe(true);
    expect(out.rows[0].video_url).toBe("https://www.tiktok.com/@u/video/7231337071831321900");
    expect(out.rows[0].video_title).toBe("فيديو 1");
    expect(out.rows[10].video_title).toBe("فيديو 2");
    expect(out.rows[29].video_title).toBe("فيديو 3");
    // The job has what it asked for, so no cursor is left behind.
    expect(out.nextCursor).toBeNull();
  });

  it("a chunk makes a bounded number of calls and the next chunk resumes at the next video without searching again", async () => {
    const first = fakeCall(handler);
    const a = await runSocialChunk(input("social-tiktok-comments", { trending: true, region: "EG", perVideo: 10 }, { remainingNeeded: 70, targetVolumeMax: 70 }), { call: first.call });
    expect(first.calls.length).toBeLessThanOrEqual(6);
    expect(a.rows).toHaveLength(50);
    expect(a.nextCursor).not.toBeNull();

    const second = fakeCall(handler);
    const b = await runSocialChunk(input("social-tiktok-comments", { trending: true, region: "EG", perVideo: 10 }, { step: 1, cursor: a.nextCursor, remainingNeeded: 20, targetVolumeMax: 70, deliveredSoFar: 50 }), { call: second.call });
    expect(second.calls.every((c) => c.endpointId === "tikhub.tiktok.video.comments")).toBe(true);
    expect(b.rows).toHaveLength(20);
    expect(b.rows[0].video_title).toBe("فيديو 6");
    expect(b.nextCursor).toBeNull();
  });

  it("a video whose comments cannot be read is skipped and the others are still collected", async () => {
    const { call } = fakeCall((id, params) => {
      if (id === "tikhub.tiktok.video.comments" && String(params.aweme_id).endsWith("01")) return fail(502);
      if (id === "crawl4ai.tiktok.video.comments") return fail(502);
      return handler(id, params);
    });
    const out = await runToCompletion("social-tiktok-comments", { trending: true, region: "EG", perVideo: 10 }, 20, call);
    expect(out.last.ok).toBe(true);
    expect(out.rows).toHaveLength(20);
    expect(out.rows.some((r) => String(r.video_title) === "فيديو 2")).toBe(false);
  });

  it("when no video's comments can be read at all and nothing was delivered before, the job fails (a refund with the reason), not a fake empty result", async () => {
    const { call } = fakeCall((id) => (id === "scrapecreators.x.v1-tiktok-get-trending-feed" ? feed(3) : fail(502)));
    const out = await runToCompletion("social-tiktok-comments", { trending: true, region: "EG", perVideo: 10 }, 20, call);
    expect(out.last.ok).toBe(false);
    expect(out.last.errorMessageAr).toBeTruthy();
  });

  it("a late failure never discards what earlier chunks already delivered", async () => {
    const { call } = fakeCall((id, params) => (id === "scrapecreators.x.v1-tiktok-get-trending-feed" ? feed(3) : fail(502)));
    const seed = await runSocialChunk(input("social-tiktok-comments", { trending: true, region: "EG", perVideo: 10 }, { remainingNeeded: 20, targetVolumeMax: 20 }), { call });
    // Same job, later chunk: some comments were delivered before, the rest of the videos cannot be read.
    const later = await runSocialChunk(input("social-tiktok-comments", { trending: true, region: "EG", perVideo: 10 }, { step: 3, cursor: seed.nextCursor || JSON.stringify({ ph: "c", refs: [{ id: "7231337071831321902", title: "v" }], i: 0, cc: null, n: 0, si: null }), remainingNeeded: 10, targetVolumeMax: 20, deliveredSoFar: 10 }), { call });
    expect(later.ok).toBe(true);
    expect(later.rows).toHaveLength(0);
    expect(later.nextCursor).toBeNull();
  });

  it("videos that exist but have no comments give a valid empty result, each checked once", async () => {
    const { call, calls } = fakeCall((id) => (id === "scrapecreators.x.v1-tiktok-get-trending-feed" ? feed(3) : ok({ data: { comments: [], cursor: 0, has_more: 0 } })));
    const out = await runToCompletion("social-tiktok-comments", { trending: true, region: "EG", perVideo: 10 }, 20, call);
    expect(out.last.ok).toBe(true);
    expect(out.rows).toHaveLength(0);
    expect(out.last.nextCursor).toBeNull();
    expect(calls.filter((c) => c.endpointId.includes("comments"))).toHaveLength(3);
  });

  it("a feed that gives rows no video can be read from fails clearly instead of billing nothing silently", async () => {
    const { call } = fakeCall((id) => (id === "scrapecreators.x.v1-tiktok-get-trending-feed" ? ok({ aweme_list: [{ note: "no id" }] }) : fail(502)));
    const out = await runSocialChunk(input("social-tiktok-comments", { trending: true, region: "EG" }, { remainingNeeded: 20, targetVolumeMax: 20 }), { call });
    expect(out.ok).toBe(false);
    expect(out.errorMessageAr).toMatch(/روابط الفيديوهات/);
  });

  it("a search subject finds YouTube videos first, then reads their comments by id", async () => {
    const { call, calls } = fakeCall((id, params) => {
      if (id === "crawl4ai.youtube.search.videos") return ok({ rows: [{ video_id: "dQw4w9WgXcQ", title: "قهوة", url: YT }, { video_id: "abcdefghijk", title: "شاي", url: "https://www.youtube.com/watch?v=abcdefghijk" }] });
      return ok({ rows: comments(10, `${params.video}_`) });
    });
    const out = await runSocialChunk(input("social-youtube-comments", { query: "القهوة", perVideo: 10 }, { remainingNeeded: 20, targetVolumeMax: 20 }), { call });
    expect(calls[0].params).toMatchObject({ query: "القهوة" });
    expect(calls[1]).toMatchObject({ endpointId: "crawl4ai.youtube.video.comments", params: { video: "dQw4w9WgXcQ", limit: 10 } });
    expect(out.rows).toHaveLength(20);
    expect(out.rows[0].video_title).toBe("قهوة");
  });
});

describe("video lists as the deliverable", () => {
  it("YouTube's trending feed needs no country", async () => {
    const { call, calls } = fakeCall(() => ok({ shorts: [{ video_id: "dQw4w9WgXcQ", title: "x" }] }));
    const out = await runSocialChunk(input("social-youtube-videos", { trending: true }, { remainingNeeded: 5, targetVolumeMax: 5 }), { call });
    expect(out.ok).toBe(true);
    expect(calls[0].endpointId).toBe("scrapecreators.x.v1-youtube-shorts-trending");
  });

  it("TikTok trending without a country fails without a call, because no region-less source answers the same question", async () => {
    const { call, calls } = fakeCall(() => ok({ aweme_list: [{ aweme_id: "1" }] }));
    const out = await runSocialChunk(input("social-tiktok-videos", { trending: true }), { call });
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("time and idempotency", () => {
  it("no new call starts once the chunk has used its time budget; the cursor carries the rest", async () => {
    let clock = 1_000_000;
    const { call, calls } = fakeCall(
      (id, params) => (id === "scrapecreators.x.v1-tiktok-get-trending-feed" ? ok({ aweme_list: Array.from({ length: 5 }, (_, i) => ({ aweme_id: `72313370718313219${i}0`, desc: `v${i}` })) }) : ok({ data: { comments: comments(10, `${params.aweme_id}_`), cursor: 1, has_more: 0 } })),
      () => { clock += SOCIAL_CHUNK_BUDGET_MS / 2; },
    );
    const out = await runSocialChunk(input("social-tiktok-comments", { trending: true, region: "EG", perVideo: 10 }, { remainingNeeded: 70, targetVolumeMax: 70 }), { call, now: () => clock });
    expect(calls.length).toBeLessThan(6);
    expect(out.ok).toBe(true);
    expect(out.nextCursor).not.toBeNull();
  });

  it("every call in a chunk has its own idempotency key, and the same call has the same key on a retried chunk", async () => {
    const handler = (id: string, params: Record<string, any>) =>
      id === "scrapecreators.x.v1-tiktok-get-trending-feed" ? ok({ aweme_list: [{ aweme_id: "7231337071831321900" }, { aweme_id: "7231337071831321901" }] }) : ok({ data: { comments: comments(5, `${params.aweme_id}_`), cursor: 1, has_more: 0 } });
    const a = fakeCall(handler);
    await runSocialChunk(input("social-tiktok-comments", { trending: true, region: "EG", perVideo: 5 }, { remainingNeeded: 10, targetVolumeMax: 10 }), { call: a.call });
    const b = fakeCall(handler);
    await runSocialChunk(input("social-tiktok-comments", { trending: true, region: "EG", perVideo: 5 }, { remainingNeeded: 10, targetVolumeMax: 10 }), { call: b.call });
    const keysA = a.calls.map((c) => c.key);
    expect(new Set(keysA).size).toBe(keysA.length);
    expect(keysA).toEqual(b.calls.map((c) => c.key));
  });
});
