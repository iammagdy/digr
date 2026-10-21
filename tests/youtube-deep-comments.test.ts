import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSocialChunk, type SocialCall, type SocialCallOutcome, type VideoSelector } from "../src/lib/server/socialAdapter";
import { setRelativeDateClockForTesting } from "../src/lib/server/relativeDate";
import { commentDropReason, commentLanguageOf, isUsableComment, requestWantsArabicComments } from "../src/lib/server/commentQuality";
import { normalizeSocialRow, SOCIAL_COLUMN_ORDER, UNKNOWN_COMMENT_DATE_AR } from "../src/lib/server/socialRows";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { customerResultColumnLabel, previewColumns } from "../src/lib/customerResultColumns";
import { VIDEO_ADOPTED_KEY } from "../src/lib/server/videoAdoption";
import { YOUTUBE_RECENT_SUPPLY_NOTE_AR } from "../src/lib/youtubeRecency";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const ok = (rows: Array<Record<string, any>>): SocialCallOutcome => ({ ok: true, httpStatus: 200, data: { ok: true, rows }, costMicro: 900, tregCallId: "call" });
const id = (n: number) => `vid${String(n).padStart(8, "0")}`.slice(0, 11).padEnd(11, "x");
const video = (n: number, extra: Record<string, any> = {}) => ({ video_id: id(n), title: `مباراة رقم ${n}`, ...extra });
const arabic = (tag: string, n: number) => Array.from({ length: n }, (_, i) => ({ comment_id: `${tag}${i}`, text: `تعليق ${tag} رقم ${i} عن الماتش`, author: `قارئ ${i}` }));
const videoOf = (params: Record<string, any>): number => [1, 2, 3, 4, 5, 6, 7, 8].find((n) => String(params.video).includes(id(n))) ?? 0;

type Asked = Array<{ endpoint: string; params: Record<string, any> }>;
function provider(opts: { videos: Array<Record<string, any>>; commentsOf: (video: number) => Array<Record<string, any>> }) {
  const asked: Asked = [];
  const call: SocialCall = async (source, params) => {
    asked.push({ endpoint: source.endpointId, params });
    if (source.endpointId.includes(".search.")) return ok(opts.videos);
    return ok(opts.commentsOf(videoOf(params)));
  };
  return { call, asked };
}
const searches = (asked: Asked) => asked.filter((entry) => entry.endpoint.includes(".search."));
const reads = (asked: Asked) => asked.filter((entry) => !entry.endpoint.includes(".search."));

type ChunkInput = { step?: number; cursor?: string | null; remaining: number; target: number; pageSize?: number; params?: Record<string, any>; delivered?: number };
function chunk(call: SocialCall, input: ChunkInput, videoSelector?: VideoSelector) {
  return runSocialChunk({
    jobId: "job_deep", userId: "u", step: input.step ?? 0, endpointId: "crawl4ai.youtube.video.comments", capabilitySlug: "social-youtube-comments", method: "POST",
    params: input.params ?? { query: "كرة القدم" }, paginationStrategy: "cursor", cursor: input.cursor ?? null, pageSize: input.pageSize ?? 50,
    remainingNeeded: input.remaining, targetVolumeMax: input.target, deliveredSoFar: input.delivered ?? 0,
  } as any, { call, now: () => NOW, videoSelector });
}

/** Drives the chunks of one job the way the worker does: the cursor and the remaining count carry over. */
async function drive(call: SocialCall, target: number, params: Record<string, any> = { query: "كرة القدم" }, videoSelector?: VideoSelector, pageSize = 50) {
  let cursor: string | null = null;
  let delivered = 0;
  const all: Array<Record<string, any>> = [];
  const outs: Array<Awaited<ReturnType<typeof chunk>>> = [];
  for (let step = 0; step < 12; step++) {
    const out = await chunk(call, { step, cursor, remaining: target - delivered, target, pageSize, params, delivered }, videoSelector);
    outs.push(out);
    expect(out.ok).toBe(true);
    const usable = out.rows.filter(isUsableComment).slice(0, target - delivered);
    all.push(...usable);
    delivered += usable.length;
    cursor = out.nextCursor;
    if (!cursor || delivered >= target) break;
  }
  return { rows: all, outs, delivered };
}

describe("YouTube topic comments: the videos are found, judged, then read deeply", () => {
  beforeEach(() => setRelativeDateClockForTesting(() => NOW));
  afterEach(() => setRelativeDateClockForTesting(null));

  it("a topic search asks for a full first page of videos, not three: 30 comments used to ask for 3 videos", async () => {
    const { call, asked } = provider({ videos: [video(1)], commentsOf: () => arabic("a", 40) });
    await chunk(call, { remaining: 30, target: 30 });
    expect(searches(asked)[0].params).toEqual({ query: "كرة القدم", limit: 20 });
  });

  it("a named number of videos is still honoured", async () => {
    const { call, asked } = provider({ videos: [video(1)], commentsOf: () => arabic("a", 40) });
    await chunk(call, { remaining: 30, target: 30, params: { query: "كرة القدم", videoCount: 4 } });
    expect(searches(asked)[0].params).toEqual({ query: "كرة القدم", limit: 4 });
  });

  it("only the adopted videos are read; the others cost no call, and their comments never appear", async () => {
    const { call, asked } = provider({ videos: [video(1), video(2), video(3)], commentsOf: (n) => arabic(`v${n}`, 40) });
    const seenByTheSelector: string[][] = [];
    const selector: VideoSelector = async (refs) => {
      seenByTheSelector.push(refs.map((ref) => String(ref.title)));
      return { adopted: [refs[1]] };
    };
    const out = await chunk(call, { remaining: 30, target: 30 }, selector);
    expect(seenByTheSelector).toEqual([["مباراة رقم 1", "مباراة رقم 2", "مباراة رقم 3"]]);
    expect(reads(asked).map((entry) => videoOf(entry.params))).toEqual([2]);
    expect(out.rows).toHaveLength(30);
    expect(out.rows.every((row) => row[VIDEO_ADOPTED_KEY] === true && String(row.video_title) === "مباراة رقم 2")).toBe(true);
  });

  it("no video is about the topic: no comment is read or paid for, and the answer says why", async () => {
    const { call, asked } = provider({ videos: [video(1), video(2)], commentsOf: () => arabic("x", 20) });
    const out = await chunk(call, { remaining: 30, target: 30 }, async () => ({ adopted: [] }));
    expect(reads(asked)).toHaveLength(0);
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(0);
    expect(out.emptyReason).toBe("no_relevant_videos");
  });

  it("a selector that fails adopts nothing and breaks nothing: the videos are read as before and judged later by the worker", async () => {
    const { call, asked } = provider({ videos: [video(1)], commentsOf: () => arabic("a", 10) });
    const out = await chunk(call, { remaining: 10, target: 10 }, async () => { throw new Error("down"); });
    expect(reads(asked)).toHaveLength(1);
    expect(out.rows.some((row) => row[VIDEO_ADOPTED_KEY] === true)).toBe(false);
  });

  it("a video with no text of its own is read after the adopted ones and is not marked as adopted", async () => {
    const { call } = provider({ videos: [video(1, { title: "" }), video(2)], commentsOf: (n) => arabic(`v${n}`, 3) });
    const out = await chunk(call, { remaining: 6, target: 6 }, async (refs) => ({ adopted: refs.filter((ref) => ref.title), deferred: refs.filter((ref) => !ref.title) }));
    expect(out.rows.map((row) => [row.comment_id, row[VIDEO_ADOPTED_KEY] === true])).toEqual([
      ["v20", true], ["v21", true], ["v22", true], ["v10", false], ["v11", false], ["v12", false],
    ]);
  });

  it("DEEP READ: one adopted video holds 120 comments, 100 are wanted; the job reads it across chunks, from where it stopped, with no repeat and no skipped comment", async () => {
    const { call, asked } = provider({ videos: [video(1)], commentsOf: () => arabic("d", 120) });
    const { rows, outs } = await drive(call, 100, { query: "كرة القدم" }, async (refs) => ({ adopted: refs }));
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((row) => row.comment_id)).size).toBe(100);
    expect(rows.map((row) => row.comment_id)).toEqual(Array.from({ length: 100 }, (_, i) => `d${i}`));
    expect(outs).toHaveLength(2);
    expect(searches(asked)).toHaveLength(1);
    expect(reads(asked)).toHaveLength(2); // one call per chunk, never one per comment
  });

  it("when one video cannot fill the volume the job moves on to the next adopted video", async () => {
    const { call, asked } = provider({ videos: [video(1), video(2)], commentsOf: (n) => (n === 1 ? arabic("s", 10) : arabic("L", 120)) });
    const { rows } = await drive(call, 50, { query: "كرة القدم" }, async (refs) => ({ adopted: refs }));
    expect(rows).toHaveLength(50);
    expect(rows.filter((row) => String(row.comment_id).startsWith("s"))).toHaveLength(10);
    expect(rows.filter((row) => String(row.comment_id).startsWith("L"))).toHaveLength(40);
    expect(reads(asked).map((entry) => videoOf(entry.params))).toEqual([1, 2]);
  });
});

describe("what counts as a comment", () => {
  beforeEach(() => setRelativeDateClockForTesting(() => NOW));
  afterEach(() => setRelativeDateClockForTesting(null));

  it("fewer than three letters, emoji only, a link only and an empty text are not comments; a hashtag word and a short real word are", () => {
    for (const text of ["Wr", "ok", "صح", "👍", "😂😂😂", "..", "123", "", "   ", "https://example.com/x", "@someone"]) expect(commentDropReason(text), text).not.toBeNull();
    expect(commentDropReason("Wr")).toBe("too_short");
    expect(commentDropReason("https://example.com/x")).toBe("link_only");
    expect(commentDropReason("")).toBe("empty");
    for (const text of ["حلو", "ماتش حلو", "#كرة_القدم", "great goal", "اتفقت 👍"]) expect(commentDropReason(text), text).toBeNull();
  });

  it("the language is read from the letters", () => {
    expect(commentLanguageOf("ماتش جامد جدا")).toBe("ar");
    expect(commentLanguageOf("great goal by the striker")).toBe("en");
    expect(commentLanguageOf("这个视频很好看")).toBe("other");
    expect(commentLanguageOf("goal يا جماعة هدف رائع")).toBe("ar");
  });

  it("an Arabic request is one whose subject is written in Arabic", () => {
    expect(requestWantsArabicComments({ query: "كرة القدم" })).toBe(true);
    expect(requestWantsArabicComments({ query: "football" })).toBe(false);
    expect(requestWantsArabicComments({})).toBe(false);
  });

  it("unusable comments never fill the volume: the job reads on to the next video, and an exact repeat under one video is delivered once", async () => {
    const junk = ["Wr", "👍", "😂😂", "https://spam.example/x", "ok", ".."].map((text, i) => ({ comment_id: `j${i}`, text }));
    const first = [...arabic("u", 3), ...junk, { comment_id: "dup1", text: "ماتش جامد جدا" }, { comment_id: "dup2", text: "ماتش جامد جدا" }];
    const { call, asked } = provider({ videos: [video(1), video(2)], commentsOf: (n) => (n === 1 ? first : arabic("n", 30)) });
    const { rows } = await drive(call, 8, { query: "كرة القدم" }, async (refs) => ({ adopted: refs }));
    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => row.text === "ماتش جامد جدا")).toHaveLength(1);
    expect(rows.every(isUsableComment)).toBe(true);
    expect(reads(asked).map((entry) => videoOf(entry.params))).toEqual([1, 2]);
  });

  it("a named video keeps every comment as before (the filters belong to a topic search)", async () => {
    const { call } = provider({ videos: [], commentsOf: () => [{ comment_id: "a", text: "ok" }, { comment_id: "b", text: "👍" }] });
    const out = await chunk(call, { remaining: 5, target: 5, params: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    expect(out.rows.map((row) => row.comment_id)).toEqual(["a", "b"]);
  });
});

describe("an Arabic request: Arabic comments first, foreign ones only to fill what Arabic cannot", () => {
  beforeEach(() => setRelativeDateClockForTesting(() => NOW));
  afterEach(() => setRelativeDateClockForTesting(null));
  const english = (tag: string, n: number) => Array.from({ length: n }, (_, i) => ({ comment_id: `${tag}${i}`, text: `great match number ${i} ${tag}`, author: `reader ${i}` }));
  const mixed = (n: number) => (n === 1 ? [...english("e", 6), ...arabic("a", 3)] : []);

  it("enough Arabic comments exist: not one English comment is delivered", async () => {
    const { call } = provider({ videos: [video(1)], commentsOf: () => [...english("e", 10), ...arabic("a", 10)] });
    const { rows } = await drive(call, 8, { query: "كرة القدم" }, async (refs) => ({ adopted: refs }));
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => commentLanguageOf(String(row.text)) === "ar")).toBe(true);
    expect(rows.every((row) => row.comment_language === "عربي")).toBe(true);
  });

  it("Arabic cannot fill the volume: the English comments fill the rest, marked in the language column, after the Arabic ones", async () => {
    const { call } = provider({ videos: [video(1)], commentsOf: mixed });
    const { rows } = await drive(call, 8, { query: "كرة القدم" }, async (refs) => ({ adopted: refs }));
    expect(rows).toHaveLength(8);
    expect(rows.slice(0, 3).map((row) => row.comment_language)).toEqual(["عربي", "عربي", "عربي"]);
    expect(rows.slice(3).map((row) => row.comment_language)).toEqual(["إنجليزي", "إنجليزي", "إنجليزي", "إنجليزي", "إنجليزي"]);
  });

  it("an English subject keeps every language in the order the source gave", async () => {
    const { call } = provider({ videos: [video(1)], commentsOf: () => [...english("e", 3), ...arabic("a", 3)] });
    const { rows } = await drive(call, 6, { query: "football" }, async (refs) => ({ adopted: refs }));
    expect(rows.map((row) => row.comment_id)).toEqual(["e0", "e1", "e2", "a0", "a1", "a2"]);
  });

  it("the English comments set aside travel in the cursor, which stays small", async () => {
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => video(n));
    const { call } = provider({ videos: eight, commentsOf: (n) => [...english(`e${n}_`, 8), ...arabic(`a${n}_`, 1)] });
    const first = await chunk(call, { remaining: 40, target: 40, pageSize: 10 }, async (refs) => ({ adopted: refs }));
    expect(first.nextCursor).not.toBeNull();
    const state = JSON.parse(String(first.nextCursor));
    expect(state.sp.length).toBeGreaterThan(0);
    expect(state.sp.length).toBeLessThanOrEqual(40);
    expect(String(first.nextCursor).length).toBeLessThan(40_000);
    expect(first.rows.every((row) => commentLanguageOf(String(row.text)) === "ar")).toBe(true);
  });
});

describe("every comment row carries its date, its video and its language, with Arabic column titles", () => {
  it("a comment with a date, with a «منذ …» text and with neither", () => {
    const base = { text: "ماتش جامد جدا", author: "منى", video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", video_title: "ملخص المباراة", video_published_at: "2026-10-03", comment_language: "عربي" };
    setRelativeDateClockForTesting(() => NOW);
    const dated = normalizeSocialRow("comments", { ...base, published_date: "2026-10-05" });
    const relative = normalizeSocialRow("comments", { ...base, published_time_text: "منذ ٣ أسابيع" });
    const none = normalizeSocialRow("comments", base);
    setRelativeDateClockForTesting(null);
    expect(dated.published_at).toBe("2026-10-05");
    // «منذ ٣ أسابيع» is an approximate day three weeks back, never a precise one.
    expect(Date.parse(String(relative.published_at))).toBeGreaterThan(NOW - 28 * 86_400_000);
    expect(Date.parse(String(relative.published_at))).toBeLessThan(NOW - 14 * 86_400_000);
    expect(none.published_at).toBe(UNKNOWN_COMMENT_DATE_AR);
    expect(UNKNOWN_COMMENT_DATE_AR).toBe("تاريخ غير معروف");
    for (const row of [dated, relative, none]) {
      expect(row.video_title).toBe("ملخص المباراة");
      expect(row.video_url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(row.video_published_at).toBe("2026-10-03");
      expect(row.comment_language).toBe("عربي");
    }
  });

  it("the table has the date, the video title, the video link and the language, each with an Arabic title, and the preview keeps the video link", () => {
    const columns = SOCIAL_COLUMN_ORDER.comments;
    for (const key of ["published_at", "video_title", "video_published_at", "video_url", "comment_language"]) expect(columns).toContain(key);
    for (const key of ["published_at", "video_title", "video_published_at", "video_url", "comment_language"]) expect(customerResultColumnLabel(key)).not.toMatch(/[A-Za-z_]/);
    expect(customerResultColumnLabel("video_published_at")).toBe("تاريخ نشر الفيديو");
    expect(customerResultColumnLabel("comment_language")).toBe("لغة التعليق");
    const shown = previewColumns(columns, false);
    for (const key of ["published_at", "video_title", "video_url", "comment_language"]) expect(shown).toContain(key);
  });

  it("the delivered dataset names every one of these columns in Arabic, and an undated comment says so", () => {
    const rows = [
      { comment_id: "1", text: "ماتش جامد جدا", author: "منى", video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", video_title: "ملخص", comment_language: "عربي" },
      { comment_id: "2", text: "great goal today", author: "Sam", published_date: "2026-10-05", video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", video_title: "ملخص", video_published_at: "2026-10-03", comment_language: "إنجليزي" },
    ];
    const dataset = normalizeDataset({ metadata: { template: "x" }, rows }, { socialKind: "comments", title: "x" });
    for (const key of ["published_at", "video_title", "video_url", "video_published_at", "comment_language"]) expect(dataset.columns).toContain(key);
    expect(dataset.rows[0].published_at).toBe(UNKNOWN_COMMENT_DATE_AR);
    expect(dataset.rows[1].published_at).toBe("2026-10-05");
    const entries = (dataset.codebook as any[]).filter((entry) => ["published_at", "video_title", "video_url", "video_published_at", "comment_language"].includes(String(entry.key ?? entry.field ?? entry.column)));
    expect(entries.length).toBe(5);
  });
});

describe("the plan says plainly when a large request may not find enough recent videos", () => {
  async function plan(message: string) {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
    await db.createRow({ tableId: "conversations", rowId: "conv_supply", data: { userId: "user_supply", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    return handler.handleUserMessage({ userId: "user_supply", conversationId: "conv_supply", message, userBalance: 5000 });
  }

  it("a large request (50 comments, near the most a job can hold) carries the sentence, with what to send instead", async () => {
    const response = await plan("٥٠ تعليق يوتيوب عن كرة القدم");
    expect(response.outputType).toBe("propose_plan");
    expect(response.planQuote.window.noteAr).toContain(YOUTUBE_RECENT_SUPPLY_NOTE_AR);
    expect(YOUTUBE_RECENT_SUPPLY_NOTE_AR).toContain("أرسل روابط الفيديوهات أو اسم القناة");
    expect(YOUTUBE_RECENT_SUPPLY_NOTE_AR).not.toMatch(/[A-Za-z]/);
  });

  it("30 comments do not: the sentence is for requests the supply could plausibly not cover", async () => {
    const response = await plan("٣٠ تعليق يوتيوب عن كرة القدم");
    expect(String(response.planQuote.window.noteAr)).not.toContain(YOUTUBE_RECENT_SUPPLY_NOTE_AR);
  });
});
