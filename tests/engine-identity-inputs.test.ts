import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { bindingAlso, parentBinding } from "../agent/src/engine/spec";
import { assertReplayInvariants, replay } from "./helpers/agentReplay";
import { callIds, tregResult, ttCommentsPage, ttVideosPage, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * AUDIT 2026-11 gap G11 (known issue 5), PR 1 part d: A CHILD SOURCE IS CALLED WITH EVERY IDENTITY INPUT IT ACCEPTS. The routed endpoints (`treg.tiktok.video.comments`: video_id AND url) match their providers on the identity keys they are sent: with the id alone
 * the providers that need the link are dropped (the audit: «tools are called with incomplete inputs, so provider fallbacks are dropped»). The parent row has both the id and the link: both are sent, in the same call, at no extra cost.
 */
const catalog = loadTregCatalog();
const endpoint = (id: string) => catalog.byId.get(id)!;
const parents = [{ id: "tv000001", url: "https://tt.example/@a/video/tv000001", text: "فيديو" }, { id: "tv000002", url: "https://tt.example/@b/video/tv000002", text: "فيديو" }];

describe("the identity inputs of a child source", () => {
  it("a routed source that takes the id and the link gets the link beside the id the plan bound", () => {
    expect(bindingAlso(endpoint("treg.tiktok.video.comments"), { param: "video_id", from: "id" }, parents)).toEqual([{ param: "url", from: "url" }]);
    expect(bindingAlso(endpoint("treg.tiktok.video.comments"), { param: "url", from: "url" }, parents)).toEqual([{ param: "video_id", from: "id" }]);
    expect(bindingAlso(endpoint("treg.youtube.video.comments"), { param: "video_id", from: "id" }, parents)).toEqual([{ param: "url", from: "url" }]);
  });
  it("a source with one identity input gets nothing more; a parent with no link gives nothing to add", () => {
    expect(bindingAlso(endpoint("crawl4ai.tiktok.video.comments"), { param: "post", from: "url" }, parents)).toEqual([]);
    expect(bindingAlso(endpoint("treg.tiktok.video.comments"), { param: "video_id", from: "id" }, [{ id: "tv000001", text: "فيديو" }])).toEqual([]);
  });
  it("a measuring call that passed the id AND the link is a binding with both (it used to be refused: two inputs matched the parent)", () => {
    expect(parentBinding({ video_id: "tv000001", url: "https://tt.example/@a/video/tv000001", limit: 10 }, parents)).toEqual({ param: "video_id", from: "id", also: [{ param: "url", from: "url" }] });
    // two inputs that are NOT an id and a link stay ambiguous: no recipe
    expect(parentBinding({ a: "tv000001", b: "tv000001" }, parents)).toBeNull();
  });
});

const why = "the cheaper sources return no author or link fields in their catalog description";
const planFlow = (calls: Array<{ endpoint: string; params: Record<string, unknown>; code: string }>, plan: (res: Results) => unknown): FakeStep[] => [
  { tool: "report_progress", args: { message_ar: "أجرّب مصدر الفيديوهات ومصدر تعليقاتها", counts: { sources: 3 } } },
  { tool: "catalog_search", args: { words: ["tiktok", "videos"], platform: "tiktok", limit: 5 } },
  ...calls.flatMap((c, i): FakeStep[] => [
    { tool: "describe_endpoint", args: { id: c.endpoint } },
    { tool: "treg_call", args: { endpoint_id: c.endpoint, params: c.params, why } },
    { tool: "run_code", args: (r: Results) => ({ code: c.code, files: [callIds(r)[i]] }) },
  ]),
  { tool: "propose_plan", args: (r: Results) => plan(r) as Record<string, unknown> },
];
const VIDEOS = "crawl4ai.tiktok.search.videos";
const ROUTED = "treg.tiktok.video.comments";
const vid = (i: number) => `tv${String(i).padStart(6, "0")}`;
const url = (i: number) => `https://tt.example/@creator${i % 7}/video/${vid(i)}`;

describe("the engine sends every identity input in the same call (replay, a routed comments source)", () => {
  it("every comment read carries video_id AND url of its own video; 3 videos x 4 comments delivered", async () => {
    const r = await replay({
      request: "هات ٣ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ٤ تعليقات",
      planning: planFlow([
        { endpoint: VIDEOS, params: { query: "منتخب مصر", limit: 3 }, code: "return inputs.call_0001.rows.map(v => ({ id: v.post_id, text: v.description, url: v.url, author: v.author, views: v.stats.views, likes: v.stats.likes, comments_count: v.stats.comments, shares: v.stats.shares, date: v.created_at }))" },
        { endpoint: ROUTED, params: { video_id: vid(0), url: url(0) }, code: "return inputs.call_0002.rows.map(c => ({ id: c.comment_id, text: c.text, author: c.author, likes: c.likes, date: c.created_at }))" },
      ], (res) => ({
        summary_ar: "ستحصل على فيديوهات تيك توك عن منتخب مصر وتعليقات كل فيديو.",
        stages: [
          { key: "videos", title_ar: "الفيديوهات", endpoint_id: VIDEOS, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "وصف الفيديو" }, { key: "url", title_ar: "رابط الفيديو" }, { key: "author", title_ar: "الحساب" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }, { key: "date", title_ar: "التاريخ والوقت" }],
            sample_rows: [0, 1].map((i) => ({ id: vid(i), text: `منتخب مصر فيديو ${i}`, url: url(i), author: `creator${i}`, views: 1000 + i, likes: 50 + i, comments_count: 20, shares: 3, date: "2026-10-19T09:00:00Z" })), measured_by: [callIds(res)[0]], relevance: aboutWords(["منتخب"]), yield_from: firstOutputId(res) },
          { key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: ROUTED, expected_rows: 12, parent_key: "videos", per_parent_rows: 4, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "date", title_ar: "التاريخ والوقت" }],
            sample_rows: [{ id: `${vid(0)}-k00`, text: `تعليق 0 على الفيديو ${vid(0)}`, author: "viewer0", likes: 0, date: "2026-10-20T09:00:00Z" }], measured_by: [callIds(res)[1]] },
        ],
      })),
      execution: () => [],
      answers: [
        tregResult(ttVideosPage("منتخب مصر", 3), 0.0005), tregResult(ttCommentsPage(vid(0), 4), 0.001),
        tregResult(ttVideosPage("منتخب مصر", 3), 0.0005),
        ...Array.from({ length: 3 }, () => (o: { params: unknown }) => tregResult(ttCommentsPage(String((o.params as Record<string, unknown>).video_id), 4), 0.001)),
      ] as never,
    });
    const reads = (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]).filter((c) => c.endpointId === ROUTED).slice(1);
    expect(reads.length).toBe(3);
    for (const read of reads) {
      expect(typeof read.params.video_id).toBe("string");
      expect(read.params.url).toBe(`https://tt.example/@creator${Number(String(read.params.video_id).slice(2)) % 7}/video/${read.params.video_id}`);
    }
    assertReplayInvariants(r, { expectDelivered: 15, expectStatus: "completed" });
  });
});
