import { describe, expect, it } from "vitest";
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import type { ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";
import { canonicalSocialParams, channelsOf, extractSocialRef, resolveSocialMode, validateSocialParams, viewCountOf, getSocialCapability } from "../src/lib/socialSources";
import { detectSocialIntent } from "../src/lib/socialTasks";

/**
 * A mission over several channels (M1): each channel's latest videos are read, ranked by views, the top N kept, and the
 * comments of every kept video collected with the video link. A fake provider answers; nothing here calls a network.
 */
let seq = 0;
const ok = (data: any, costMicro = 900): SocialCallOutcome => ({ ok: true, httpStatus: 200, data, costMicro, tregCallId: `call_${++seq}` });
const fail = (status = 502): SocialCallOutcome => ({ ok: false, httpStatus: status, data: null, costMicro: 0, tregCallId: "", errorCode: `http_${status}`, errorMessageAr: "تعذر استخراج البيانات من المصدر بعد عدة محاولات." });

interface Recorded { endpointId: string; params: Record<string, any> }
function fakeCall(handler: (endpointId: string, params: Record<string, any>) => SocialCallOutcome): { call: SocialCall; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return { calls, call: async (source, params) => { calls.push({ endpointId: source.endpointId, params }); return handler(source.endpointId, params); } };
}

const vid = (channel: string, i: number, views: number | string, title = `فيديو ${channel} ${i}`) => ({ video_id: `${channel.replace(/\W/g, "").padEnd(6, "x").slice(0, 6)}${String(i).padStart(5, "0")}`, title, view_count: views });
const channelVideos = (channel: string, n: number) => Array.from({ length: n }, (_, i) => vid(channel, i + 1, (i + 1) * 1000));
const commentsOf = (video: string, n: number) => Array.from({ length: n }, (_, i) => ({ comment_id: `${video}_${i + 1}`, text: `تعليق ${i + 1}`, author: "أحمد" }));

function input(params: Record<string, any>, over: Partial<ProviderAdapterCallInput> = {}): ProviderAdapterCallInput {
  return { jobId: "job_m1", userId: "u1", step: 0, endpointId: "x", capabilitySlug: "social-youtube-comments", method: "POST", params, paginationStrategy: "cursor", cursor: null, pageSize: 50, remainingNeeded: 200, targetVolumeMax: 200, deliveredSoFar: 0, ...over };
}

async function runToCompletion(params: Record<string, any>, target: number, call: SocialCall) {
  const rows: Record<string, any>[] = [];
  let cursor: string | null = null;
  let chunks = 0;
  let last: Awaited<ReturnType<typeof runSocialChunk>> | null = null;
  for (let step = 0; step < 40; step++) {
    last = await runSocialChunk(input(params, { step, cursor, remainingNeeded: target - rows.length, targetVolumeMax: target, deliveredSoFar: rows.length }), { call });
    chunks++;
    if (!last.ok) break;
    rows.push(...last.rows);
    cursor = last.nextCursor;
    if (!cursor || rows.length >= target) break;
  }
  return { rows, last: last!, chunks };
}

describe("the mission parameters", () => {
  it("a channel list is a channel mission, cleaned and capped", () => {
    expect(resolveSocialMode({ channels: ["@a", "@b"] })).toBe("channel");
    expect(channelsOf({ channels: [" @a ", "@a", "", 5, "@b"] })).toEqual(["@a", "@b"]);
    expect(channelsOf({ channels: Array.from({ length: 30 }, (_, i) => `@c${i}`) })).toHaveLength(10);
    expect(validateSocialParams("social-youtube-comments", { channels: ["@a"] })).toBeNull();
  });

  it("canonical params carry the channels, top-N and ranking, and drop a single channel/query", () => {
    const cap = getSocialCapability("social-youtube-comments")!;
    const intent = detectSocialIntent("أكتر ١٠ فيديوهات مشاهدة من قناة @AlArabiya على يوتيوب مع كل التعليقات");
    const params = canonicalSocialParams(cap, intent, "x", {}, { channels: ["@AlArabiya", "@SkyNewsArabia"], topPerChannel: 10, rankBy: "views" });
    expect(params).toMatchObject({ channels: ["@AlArabiya", "@SkyNewsArabia"], topPerChannel: 10, rankBy: "views" });
    expect(params).not.toHaveProperty("channel");
    expect(params).not.toHaveProperty("query");
    expect(canonicalSocialParams(cap, intent, "x", {}, { channels: ["@a"], topPerChannel: 999 }).topPerChannel).toBe(20);
  });

  it("view counts are read from the fields providers use", () => {
    expect(viewCountOf({ view_count: 1234 })).toBe(1234);
    expect(viewCountOf({ views: "1,234 views" })).toBe(1234);
    expect(viewCountOf({ viewCount: "1.2M" })).toBe(1200000);
    expect(viewCountOf({ views: "1.2M views" })).toBe(1200000);
    expect(viewCountOf({ play_count: "٣٤٥ ألف" })).toBe(345000);
    expect(viewCountOf({ title: "no views here" })).toBeNull();
    expect(extractSocialRef("youtube", { video_id: "dQw4w9WgXcQ", title: "t", view_count: 99 })).toMatchObject({ id: "dQw4w9WgXcQ", views: 99 });
  });
});

describe("two channels, top 3 by views, all comments up to the cap", () => {
  const params = { channels: ["@A", "@B"], topPerChannel: 3, rankBy: "views" };
  const handler = (id: string, p: Record<string, any>) => {
    if (id === "crawl4ai.youtube.channel.videos") return ok({ rows: channelVideos(String(p.channel), 12) });
    if (id === "crawl4ai.youtube.video.comments") return ok({ rows: commentsOf(String(p.video), Math.min(Number(p.limit), 40)) });
    return fail();
  };

  it("keeps the three most viewed videos of each channel, tags every comment with its video link, channel and views", async () => {
    const { call, calls } = fakeCall(handler);
    const { rows, last } = await runToCompletion(params, 240, call);
    expect(last.ok).toBe(true);
    const videos = new Map<string, { channel: string; views: number; url: string }>();
    for (const row of rows) videos.set(row.video_url, { channel: row.channel_name, views: row.video_views, url: row.video_url });
    expect(videos.size).toBe(6);
    for (const channel of ["@A", "@B"]) {
      const views = [...videos.values()].filter((v) => v.channel === channel).map((v) => v.views).sort((a, b) => b - a);
      expect(views).toEqual([12000, 11000, 10000]); // the top three of twelve, ranked by views
    }
    for (const row of rows) expect(row.video_url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
    expect(calls.filter((c) => c.endpointId === "crawl4ai.youtube.channel.videos").map((c) => c.params.channel)).toEqual(["@A", "@B"]);
    expect(rows).toHaveLength(240);
  });

  it("stops at the volume cap, never above it", async () => {
    const { call } = fakeCall(handler);
    const { rows } = await runToCompletion(params, 100, call);
    expect(rows).toHaveLength(100);
  });

  it("never returns the same comment twice", async () => {
    const { call } = fakeCall(handler);
    const { rows } = await runToCompletion(params, 240, call);
    const ids = rows.map((r) => r.comment_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each chunk makes a bounded number of calls and stays resumable through its cursor", async () => {
    const { call, calls } = fakeCall(handler);
    let cursor: string | null = null;
    let delivered = 0;
    for (let step = 0; step < 40; step++) {
      const before = calls.length;
      const out = await runSocialChunk(input(params, { step, cursor, remainingNeeded: 240 - delivered, targetVolumeMax: 240, deliveredSoFar: delivered }), { call });
      expect(calls.length - before).toBeLessThanOrEqual(6);
      expect(out.ok).toBe(true);
      delivered += out.rows.length;
      cursor = out.nextCursor;
      if (!cursor) break;
    }
    expect(delivered).toBe(240);
  });

  it("a restarted chunk (same cursor) does not duplicate or lose a video", async () => {
    const a = fakeCall(handler);
    const first = await runSocialChunk(input(params), { call: a.call });
    const replay = fakeCall(handler);
    const again = await runSocialChunk(input(params), { call: replay.call });
    expect(again.rows.map((r) => r.comment_id)).toEqual(first.rows.map((r) => r.comment_id));
    const resumedA = await runSocialChunk(input(params, { step: 1, cursor: first.nextCursor, deliveredSoFar: first.rows.length }), { call: a.call });
    const resumedB = await runSocialChunk(input(params, { step: 1, cursor: first.nextCursor, deliveredSoFar: first.rows.length }), { call: replay.call });
    expect(resumedB.rows.map((r) => r.comment_id)).toEqual(resumedA.rows.map((r) => r.comment_id));
    expect(first.rows.some((r) => resumedA.rows.some((s) => s.comment_id === r.comment_id))).toBe(false);
  });
});

describe("a topic inside a channel (M2) and unreadable channels", () => {
  it("keeps only the videos whose title is about the topic, before ranking, and ranks those by views", async () => {
    const { call } = fakeCall((id, p) => id === "crawl4ai.youtube.channel.videos"
      ? ok({ rows: [vid("FIFA", 1, 9000, "ملخص مباراة مصر في كأس العالم"), vid("FIFA", 2, 50000, "حفل الافتتاح"), vid("FIFA", 3, 7000, "أهداف منتخب مصر")] })
      : ok({ rows: commentsOf(String(p.video), 5) }));
    const { rows } = await runToCompletion({ channels: ["الفيفا"], topPerChannel: 20, rankBy: "views", topic: "منتخب مصر" }, 50, call);
    const titles = [...new Set(rows.map((r) => r.video_title))];
    expect(titles).toEqual(["ملخص مباراة مصر في كأس العالم", "أهداف منتخب مصر"]); // the unrelated video (more views) is out; the rest ranked by views
    expect(titles).not.toContain("حفل الافتتاح");
  });

  it("a channel that cannot be read is skipped; the others are still collected", async () => {
    const { call } = fakeCall((id, p) => {
      if (id === "crawl4ai.youtube.channel.videos") return p.channel === "@bad" ? fail(503) : ok({ rows: channelVideos("@ok", 3) });
      if (id === "tikhub.youtube.channel.videos") return fail(503);
      return ok({ rows: commentsOf(String(p.video), 10) });
    });
    const { rows, last } = await runToCompletion({ channels: ["@bad", "@ok"], topPerChannel: 2, rankBy: "views" }, 100, call);
    expect(last.ok).toBe(true);
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((r) => r.channel_name))).toEqual(new Set(["@ok"]));
  });

  it("when no channel can be read and nothing was delivered, it is a source failure (the job is released), not an empty result", async () => {
    const { call } = fakeCall(() => fail(503));
    const out = await runSocialChunk(input({ channels: ["@a", "@b"], topPerChannel: 2 }), { call });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBeTruthy();
  });

  it("when every channel answers but none has a matching video, it is an empty result, not a failure", async () => {
    const { call } = fakeCall(() => ok({ rows: [vid("A", 1, 10, "حفل الافتتاح")] }));
    const out = await runSocialChunk(input({ channels: ["@a"], topic: "منتخب مصر" }), { call });
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(0);
  });
});

describe("the existing single-channel and link flows are unchanged", () => {
  it("a plain channel (no list) still reads the channel's latest videos then their comments", async () => {
    const { call, calls } = fakeCall((id, p) => id === "crawl4ai.youtube.channel.videos" ? ok({ rows: channelVideos("@one", 3) }) : ok({ rows: commentsOf(String(p.video), 20) }));
    const out = await runSocialChunk(input({ channel: "@one", videoCount: 2 }, { remainingNeeded: 20, targetVolumeMax: 20 }), { call });
    expect(out.ok).toBe(true);
    expect(calls[0].endpointId).toBe("crawl4ai.youtube.channel.videos");
  });
});
