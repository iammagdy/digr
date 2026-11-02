import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { redesignStagesOf } from "../agent/src/redesign";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { isRepliesStage, withRepliesStages } from "../src/lib/agentMission/replies";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import { withCompleteCount } from "../src/lib/agentMission/completeCount";
import { pageCapOfSource, pageLimitOf } from "../src/lib/agentMission/pageLimit";
import { pageableCommentAlternative } from "../src/lib/agentMission/pageableComments";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";

/**
 * S2, THE LIVE CASE AS ONE REPLAY (docs/S1-LIVE-FINDINGS.md, «Live run of 2026-11-02»): «فيديوهين تيك توك عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود». The planner's recipe is the live one (crawl4ai comments, `limit: 20`, no next page; the replies sample of 20 comments with 7 replies;
 * the model planned 800 comments); the listing is the live shape (video 1 shows 168 comments, video 2 shows 20, a third video exists; a video is published after planning). The catalog schemas of the tools are the real ones; the pages are the shapes those schemas describe.
 * Everything the six fixes do is exercised together: the whole mission passes the gate, the promise is computed from the real counters and the tool's real limit, the comments are read page after page by a cursor tool, the replies promise follows the final comments, the pinned videos are read.
 */
const catalog = loadTregCatalog();
const FLAGS = { social_posts: "test", social_account: "test", social_comments: "test", companies: "off", people: "off", places: "off" } as RedesignFlags;
const REPLY_SAMPLE = [0, 0, 1, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0].map((n, i) => ({ id: `s${i}`, text: `تعليق ${i}`, replies_count: n }));
// CHANGED (S5, owner decision): a video's counter counts comments AND replies together, so the world's counters are the sum: video A 168 = 126 comments + 42 replies, video B 20 = 15 + 5 (47 replies in all)
const TOP = { A: 126, B: 15 } as Record<string, number>;
const LISTING = [{ id: "A", link: "https://www.tiktok.com/@x/video/A", caption: "فيديو أ", comments: 168 }, { id: "B", link: "https://www.tiktok.com/@x/video/B", caption: "فيديو ب", comments: 20 }, { id: "C", link: "https://www.tiktok.com/@x/video/C", caption: "فيديو ج", comments: 12 }];
const AT_EXECUTION = [{ id: "N", link: "https://www.tiktok.com/@x/video/N", caption: "جديد", comments: 3 }, ...LISTING];
// every third comment has one reply: 42 on video A, 5 on video B = 47 replies exist
const hasReply = (k: number) => k % 3 === 0;
const stage = (o: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0002, ...o }) as unknown as PricedStage;
const COLUMNS = [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "صاحب التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "replies_count", title_ar: "عدد الردود" }, { key: "language", title_ar: "لغة التعليق" }];

async function plan(): Promise<PricedPlan> {
  const videos = stage({ key: "videos", title_ar: "فيديوهات تيك توك", endpoint_id: "v.videos", planned_rows: 2, expected_rows: 2, columns: [{ key: "link", title_ar: "رابط الفيديو" }, { key: "caption", title_ar: "الوصف" }, { key: "comments", title_ar: "التعليقات" }], engine: { endpoint_id: "v.videos", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: null, built_by: "code" } });
  const comments = stage({ key: "comments", title_ar: "تعليقات الفيديوهات", endpoint_id: "crawl4ai.tiktok.video.comments", parent_key: "videos", per_parent_rows: 400, planned_rows: 800, expected_rows: 800, columns: COLUMNS, engine: { endpoint_id: "crawl4ai.tiktok.video.comments", params: { limit: 20 }, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: { param: "post", from: "id" }, built_by: "code" } });
  const stages = [videos, comments];
  let p: PricedPlan = { summary_ar: "ستحصل على فيديوهات وتعليقاتها.", stages, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) } as unknown as PricedPlan;
  p = await withRepliesStages(p, { catalog, isAllowed: () => true, sampleRowsOf: async () => REPLY_SAMPLE });
  const crawl = catalog.byId.get("crawl4ai.tiktok.video.comments")!;
  return withCompleteCount(p, {
    request: "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.",
    candidatesOf: async () => LISTING.map((v) => ({ id: v.id, counter: v.comments, row: v })),
    pageCapOf: async (c) => pageCapOfSource(catalog.byId.get(c.engine!.endpoint_id)!, c.engine!.cursor_param, 20),
    pageSizeOf: async () => { const l = pageLimitOf(crawl); return l && l.max !== null ? { param: l.param, max: l.max } : null; },
    pageableAlternativeOf: async (c) => pageableCommentAlternative(c, p.stages[0], catalog, { isAllowed: () => true }),
  });
}

async function run(p: PricedPlan) {
  const store = createMemoryStore();
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id); const params = (input.params ?? {}) as Record<string, unknown>;
      calls.push({ endpoint, params });
      let body: unknown; let next: string | null = null; let rowsInPage = 0;
      if (endpoint === "v.videos") { body = AT_EXECUTION; rowsInPage = AT_EXECUTION.length; }
      else if (endpoint === "tikhub.tiktok.video.comments") {
        const total = TOP[String(params.aweme_id)] ?? 0; const from = Number(params.cursor ?? 0); const n = Math.max(0, Math.min(Number(params.count ?? 20), total - from));
        body = { data: { comments: Array.from({ length: n }, (_, k) => ({ cid: `${params.aweme_id}-c${from + k}`, text: `تعليق ${from + k}`, user: { nickname: "u" }, create_time: 1788100000, digg_count: 1, reply_comment_total: hasReply(from + k) ? 1 : 0, comment_language: "ar" })), cursor: from + n, has_more: from + n < total ? 1 : 0 } };
        rowsInPage = n; next = from + n < total ? String(from + n) : null;
      } else if (endpoint === "anyapi.tiktok.comment_replies") {
        const id = String(params.commentId); const [video, c] = id.split("-c");
        void video; body = { output: { data: { comments: hasReply(Number(c)) ? [{ id: `${id}-r0`, text: "رد", author: "r", createdUtc: 1788200000, likes: 0 }] : [], nextCursor: null } } };
        rowsInPage = hasReply(Number(c)) ? 1 : 0;
      } else throw new Error(`unexpected tool ${endpoint}`);
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_live", RAW_PATH(callId), JSON.stringify(body), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: rowsInPage, has_more: next !== null, next_cursor: next, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const items = await ItemStore.open(store, "msn_live");
  const stages = redesignStagesOf(p, FLAGS, true);
  await runEngine({ items, store, plan: withPromiseCaps(p), missionId: "msn_live", gateway, sandbox: (code, inputs) => (code === "return inputs.page" ? Promise.resolve({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }) : runInSandbox(code, inputs)), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: stages });
  return { calls, videos: items.acceptedRows("videos").map((r) => String(r.id)), comments: items.acceptedRows("comments"), replies: items.acceptedRows("comments_replies") };
}

describe("the live case, replayed with the six fixes", () => {
  it("the whole mission (videos, comments, replies) passes the gate", async () => {
    expect([...redesignStagesOf(await plan(), FLAGS, true)].sort()).toEqual(["comments", "comments_replies", "videos"]);
  });
  it("the promise: 2 videos and 188 comments and replies together (the counters), the replies a share of it by the sample's 0.35: never a reply estimate on top", async () => {
    const p = await plan();
    expect(p.stages.find((s) => s.key === "videos")!.planned_rows).toBe(2);
    const comments = p.stages.find((s) => s.key === "comments")!.planned_rows;
    const replies = p.stages.find(isRepliesStage)!.planned_rows;
    expect(comments + replies).toBe(188);
    expect(replies).toBe(Math.round(188 * (0.35 / 1.35)));
    expect(p.price.deliveredRows).toBe(2 + 188);
  });
  it("delivered == promised: the pinned videos A and B, no new search, every page read to the end (126 in 7 pages, 15 in one), 141 comments and the 47 replies = 188", async () => {
    const r = await run(await plan());
    expect(r.videos.sort()).toEqual(["A", "B"]);
    expect(r.calls.filter((c) => c.endpoint === "v.videos")).toHaveLength(0);
    expect(r.comments).toHaveLength(141);
    expect(r.replies).toHaveLength(47);
    expect(r.comments.length + r.replies.length).toBe(188);
    expect(r.calls.filter((c) => c.endpoint === "tikhub.tiktok.video.comments")).toHaveLength(8);
    expect(r.calls.map((c) => c.endpoint)).not.toContain("crawl4ai.tiktok.video.comments");
  });
  it("the replies: the comments that say they have replies are read (47 exist), a comment with none is never read", async () => {
    const r = await run(await plan());
    expect(r.replies).toHaveLength(47);
    expect(r.calls.filter((c) => c.endpoint === "anyapi.tiktok.comment_replies")).toHaveLength(47);
  });
});
