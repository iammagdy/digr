import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, tregResult, ttCommentsPage, ttVideosPage, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * GOLDEN PROMPT G4 (docs/AUDIT-2026-11.md section 7), OFFLINE REPLAY: «هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات».
 * Reference C: every comment row carries the parent video's link and title, zero orphan comments, 10 per parent, and NO PAID READ for a video whose own comment count is 0 (live: 9 of 108 comment reads returned nothing, one of them billed).
 * The search returns 8 videos; two of the first five have `stats.comments` 0. They are skipped before any paid read and the checked videos kept beyond the five take their place.
 */
const why = "the cheaper sources return no author or link fields in their catalog description";
const planFlow = (o: { progress: string; words: string[]; platform?: string; calls: Array<{ endpoint: string; params: Record<string, unknown>; code: string }>; plan: (res: Results) => unknown }): FakeStep[] => [
  { tool: "report_progress", args: { message_ar: o.progress, counts: { sources: 3 } } },
  { tool: "catalog_search", args: { words: o.words, ...(o.platform ? { platform: o.platform } : {}), limit: 5 } },
  ...o.calls.flatMap((c, i): FakeStep[] => [
    { tool: "describe_endpoint", args: { id: c.endpoint } },
    { tool: "treg_call", args: { endpoint_id: c.endpoint, params: c.params, why } },
    { tool: "run_code", args: (r: Results) => ({ code: c.code, files: [callIds(r)[i]] }) },
  ]),
  { tool: "propose_plan", args: (r: Results) => o.plan(r) as Record<string, unknown> },
];

const VIDEOS = "crawl4ai.tiktok.search.videos";
const COMMENTS = "crawl4ai.tiktok.video.comments";
const TOPIC = "منتخب مصر";
const vid = (i: number) => `tv${String(i).padStart(6, "0")}`;
const url = (i: number) => `https://tt.example/@creator${i % 7}/video/${vid(i)}`;
/** The own comment count of each video the search returns: videos 0 and 3 have none (comments turned off, or brand new). */
const OWN_COMMENTS = [0, 20, 20, 0, 20, 20, 20, 20];
const videosPage = () => { const p = ttVideosPage(TOPIC, OWN_COMMENTS.length); return { rows: p.rows.map((v, i) => ({ ...v, stats: { ...v.stats, comments: OWN_COMMENTS[i] } })) }; };
const videoOfUrl = (u: unknown): string => String(u).split("/").pop() ?? "";

async function run() {
  return replay({
    request: "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات",
    planning: planFlow({
      progress: "أجرّب مصدر الفيديوهات ومصدر تعليقاتها", words: ["tiktok", "videos"], platform: "tiktok",
      calls: [
        { endpoint: VIDEOS, params: { query: TOPIC, limit: 8 }, code: "return inputs.call_0001.rows.map(v => ({ id: v.post_id, text: v.description, url: v.url, author: v.author, views: v.stats.views, likes: v.stats.likes, comments_count: v.stats.comments, shares: v.stats.shares, date: v.created_at }))" },
        { endpoint: COMMENTS, params: { post: url(1) }, code: "return inputs.call_0002.rows.map(c => ({ id: c.comment_id, text: c.text, author: c.author, likes: c.likes, date: c.created_at }))" },
      ],
      plan: (res) => ({
        summary_ar: "ستحصل على فيديوهات تيك توك عن منتخب مصر مع أرقامها وتعليقات كل فيديو.",
        stages: [
          { key: "videos", title_ar: "الفيديوهات", endpoint_id: VIDEOS, expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "وصف الفيديو" }, { key: "url", title_ar: "رابط الفيديو" }, { key: "author", title_ar: "الحساب" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }, { key: "date", title_ar: "التاريخ والوقت" }],
            sample_rows: [1, 2].map((i) => ({ id: vid(i), text: `${TOPIC} فيديو ${i}`, url: url(i), author: `creator${i}`, views: 1000 + i, likes: 50 + i, comments_count: 20, shares: 3, date: "2026-10-19T09:00:00Z" })), measured_by: [callIds(res)[0]], relevance: aboutWords(["منتخب"]), yield_from: firstOutputId(res) },
          { key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: COMMENTS, expected_rows: 50, parent_key: "videos", per_parent_rows: 10, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "date", title_ar: "التاريخ والوقت" }],
            sample_rows: [{ id: `${vid(1)}-k00`, text: `تعليق 0 على الفيديو ${vid(1)}`, author: "viewer0", likes: 0, date: "2026-10-20T09:00:00Z" }], measured_by: [callIds(res)[1]] },
        ],
      }),
    }),
    execution: () => [],
    answers: [
      tregResult(videosPage(), 0.0005), tregResult(ttCommentsPage(vid(1), 10), 0.0005),
      tregResult(videosPage(), 0.0005),
      ...Array.from({ length: 12 }, () => (o: { params: unknown }) => tregResult(ttCommentsPage(videoOfUrl((o.params as Record<string, unknown>).post), 10), 0.0005)),
    ] as never,
  });
}

describe("G4: videos and their comments, with videos whose own comment count is 0 (audit gap G10, reference C)", () => {
  it("no paid read is made for a video whose own comment count is 0; the checked videos kept beyond the five take their place, so 5 videos x 10 comments are delivered", async () => {
    const r = await run();
    const calls = (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]).filter((c) => c.endpointId === COMMENTS);
    // 1 planning call for the sample, then one read per video that has comments: never for the videos 0 and 3
    const executionReads = calls.slice(1).map((c) => videoOfUrl(c.params.post));
    expect(executionReads).not.toContain(vid(0));
    expect(executionReads).not.toContain(vid(3));
    expect(executionReads.length).toBe(5);
    assertReplayInvariants(r, { expectDelivered: 55, expectStatus: "completed" });
  });

  it("the comments sheet has the parent video's title and link on EVERY row, 10 comments per video, no orphan comment", async () => {
    const r = await run();
    const wb = await readWorkbook(r);
    const sheet = wb.getWorksheet("تعليقات كل فيديو")!;
    expect(sheet.rowCount - 1).toBe(50);
    const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    const at = (title: string) => { const i = header.indexOf(title); expect(i, title).toBeGreaterThan(0); return i; };
    const rows = Array.from({ length: 50 }, (_, i) => sheet.getRow(i + 2));
    const cell = (row: any, i: number) => { const v = row.getCell(i).value as any; return String(v?.text ?? v ?? "").trim(); };
    const parentTitle = at("وصف الفيديو");
    const parentLink = at("رابط الفيديو");
    for (const row of rows) { expect(cell(row, parentTitle)).not.toBe(""); expect(cell(row, parentLink)).toMatch(/^https:\/\/tt\.example\//); }
    const perVideo = new Map<string, number>();
    for (const row of rows) perVideo.set(cell(row, parentLink), (perVideo.get(cell(row, parentLink)) ?? 0) + 1);
    expect([...perVideo.values()]).toEqual([10, 10, 10, 10, 10]);
    expect([...perVideo.keys()]).not.toContain(url(0));
    expect([...perVideo.keys()]).not.toContain(url(3));
  });
});
