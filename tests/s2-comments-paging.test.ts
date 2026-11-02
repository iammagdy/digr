import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { withCompleteCount, type Candidate } from "../src/lib/agentMission/completeCount";
import { pageCapOfSource, pageLimitOf } from "../src/lib/agentMission/pageLimit";
import { pageableCommentAlternative, pageableCommentSourcesFor } from "../src/lib/agentMission/pageableComments";

/**
 * S2 ITEM 4 (docs/S1-LIVE-FINDINGS.md, L1: «Alternatives stored: 0»). The planner sampled one comments tool, `crawl4ai.tiktok.video.comments`, which has a size input and no next page; the catalog has comments tools of the same capability WITH a cursor. The plan now prefers a catalog
 * comments tool that has a cursor input (stored as the stage tool, the tool it replaces kept as the next tool) and the engine reads page after page until the promised count or the source's end. Everything about the tools here is what their catalog schemas state
 * (`pagination`, `inputs`, `list_path`, `cursor_path`, `item_fields`); the page shapes below are the ones those schemas describe.
 */
const catalog = loadTregCatalog();
const all = () => true;
const sourcesOf = (o: { id: boolean; url: boolean } = { id: true, url: true }) => pageableCommentSourcesFor("crawl4ai.tiktok.video.comments", catalog, { isAllowed: all, videoIdAvailable: o.id, urlAvailable: o.url });

describe("the pageable comments tools of the catalog (TikTok), by their schemas", () => {
  it("every one has a cursor input, takes the video's id or link, lists comments in a path the mapping reads, and is cheapest first", () => {
    const list = sourcesOf();
    expect(list.length).toBeGreaterThanOrEqual(3);
    for (const s of list) expect(catalog.byId.get(s.id)!.pagination.some((p) => !/^(limit|count)$/i.test(p))).toBe(true);
    expect(list[0].id).toBe("tikhub.tiktok.video.comments");
    expect(list[0]).toMatchObject({ parentParam: "aweme_id", from: "id", cursorParam: "cursor" });
    const ids = list.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["tikhub.tiktok.video.comments", "anyapi.tiktok.video.comments"]));
    // a tool whose schema does not state the text of its items is not mapped (scrapecreators lists only a part of its item fields)
  });
  it("a tool with no cursor, the tool being replaced, a routed one, and one whose list the mapping cannot read are left out", () => {
    const ids = sourcesOf().map((s) => s.id);
    expect(ids).not.toContain("crawl4ai.tiktok.video.comments");
    expect(ids).not.toContain("treg.tiktok.video.comments");
    expect(ids).not.toContain("brightdata.x.tiktok-comments");
    expect(ids).not.toContain("tikhub.x.tiktok-app-v3-fetch-video-comments");
  });
  it("with no link column on the video rows the link-based tools are left out; with no id, the id-based ones", () => {
    expect(sourcesOf({ id: true, url: false }).map((s) => s.id)).not.toContain("anyapi.tiktok.video.comments");
    expect(sourcesOf({ id: false, url: true }).map((s) => s.id)).not.toContain("tikhub.tiktok.video.comments");
  });
});

// ---- the live shape: video 1 shows 168, video 2 shows 20; the tool tikhub.tiktok.video.comments gives `count` (default 20) a page and `data.cursor` / `data.has_more`
const COUNTERS = [168, 20];
const LINK = (i: number) => `https://www.tiktok.com/@creator/video/70000000000000000${i}`;
const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.000025, ...over }) as unknown as PricedStage;
const COLUMNS = [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "صاحب التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "replies_count", title_ar: "عدد الردود" }, { key: "language", title_ar: "لغة التعليق" }];
const CRAWL = { endpoint_id: "crawl4ai.tiktok.video.comments", params: { limit: 20 }, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: { param: "post", from: "id" }, built_by: "code" };
function planOf(): PricedPlan {
  const videos = stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "v.videos", planned_rows: 2, expected_rows: 2, columns: [{ key: "link", title_ar: "رابط الفيديو" }, { key: "caption", title_ar: "الوصف" }, { key: "comments", title_ar: "التعليقات" }], engine: { endpoint_id: "v.videos", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: null, built_by: "code" } });
  const comments = stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "crawl4ai.tiktok.video.comments", parent_key: "videos", per_parent_rows: 20, planned_rows: 40, expected_rows: 40, columns: COLUMNS, engine: CRAWL });
  const stages = [videos, comments];
  return { summary_ar: "ستحصل على فيديوهات وتعليقاتها.", stages, price: priceMissionByCode(stagePriceInputs(stages, undefined), {}) } as unknown as PricedPlan;
}
const cands: Candidate[] = COUNTERS.map((c, i) => ({ id: `${i}`, counter: c }));
const crawl = catalog.byId.get("crawl4ai.tiktok.video.comments")!;
const deps = (counters: Candidate[] = cands) => ({
  request: "كل التعليقات على فيديوهين", candidatesOf: async () => counters,
  pageCapOf: async (c: PricedStage) => pageCapOfSource(catalog.byId.get(c.engine!.endpoint_id)!, c.engine!.cursor_param, 20),
  pageSizeOf: async () => { const l = pageLimitOf(crawl); return l && l.max !== null ? { param: l.param, max: l.max } : null; },
  pageableAlternativeOf: async (c: PricedStage) => pageableCommentAlternative(c, planOf().stages[0], catalog, { isAllowed: all }),
});
const finalPlan = (counters?: Candidate[]) => withCompleteCount(planOf(), deps(counters));

/** One page of `tikhub.tiktok.video.comments` as its schema describes it: data.comments[] (cid, text, user.nickname, create_time, digg_count, reply_comment_total, comment_language), data.cursor, data.has_more; `count` a page (default 20). */
const pageOf = (video: number, params: Record<string, unknown>) => {
  const total = COUNTERS[video];
  const from = Number(params.cursor ?? 0);
  const size = Number(params.count ?? 20);
  const n = Math.max(0, Math.min(size, total - from));
  return { data: { comments: Array.from({ length: n }, (_, k) => ({ cid: `v${video}-c${from + k}`, text: `تعليق ${from + k}`, user: { nickname: `u${k}` }, create_time: 1788100000 + k, digg_count: k, reply_comment_total: 0, comment_language: "ar" })), cursor: from + n, has_more: from + n < total ? 1 : 0 } };
};
async function run(plan: PricedPlan, o: { failPageable?: boolean } = {}) {
  const store = createMemoryStore();
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      calls.push({ endpoint, params });
      if (endpoint === "tikhub.tiktok.video.comments" && o.failPageable) return { ok: false as const, http_status: 500, error: "down" };
      let body: unknown; let next: string | null = null; let more: boolean | null = null; let rowsInPage = 0;
      if (endpoint === "v.videos") { const rows = COUNTERS.map((n, i) => ({ id: `${i}`, link: LINK(i), caption: `فيديو ${i}`, comments: n })); body = rows; rowsInPage = rows.length; }
      else if (endpoint === "tikhub.tiktok.video.comments") { const p = pageOf(Number(params.aweme_id), params); body = p; rowsInPage = p.data.comments.length; more = p.data.has_more === 1; next = more ? String(p.data.cursor) : null; }
      else { const v = Number(params.post); const n = Math.min(Number(params.limit ?? 50), 500, COUNTERS[v]); const rows = Array.from({ length: n }, (_, k) => ({ id: `v${v}-c${k}`, text: `تعليق ${k}` })); body = rows; rowsInPage = rows.length; }
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_pg", RAW_PATH(callId), JSON.stringify(body), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: rowsInPage, has_more: more, next_cursor: next, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const items = await ItemStore.open(store, "msn_pg");
  // the videos' page is already a plain list; the comments' mapping is the one the plan stored (written by code), run in the real sandbox
  await runEngine({ items, store, plan, missionId: "msn_pg", gateway, sandbox: (code, inputs) => (code === "return inputs.page" ? Promise.resolve({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }) : runInSandbox(code, inputs)), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: new Set(["videos", "comments"]) });
  return { calls, rows: items.acceptedRows("comments") };
}

describe("the plan prefers a comments tool with a cursor and reads it page after page", () => {
  it("the stage's tool becomes the cheapest pageable one, the tool it replaces stays as the next tool", async () => {
    const c = (await finalPlan()).stages.find((s) => s.key === "comments")!;
    expect(c.engine!.endpoint_id).toBe("tikhub.tiktok.video.comments");
    expect(c.endpoint_id).toBe("tikhub.tiktok.video.comments");
    expect(c.engine!.cursor_param).toBe("cursor");
    expect(c.engine!.parent_binding).toMatchObject({ param: "aweme_id", from: "id" });
    expect((c.engine!.alternatives ?? []).map((a) => a.endpoint_id)).toContain("crawl4ai.tiktok.video.comments");
  });
  it("the promise is the real counters, 168 + 20 = 188, with no statement of a limited source", async () => {
    const p = await finalPlan();
    expect(p.stages.find((s) => s.key === "comments")!.planned_rows).toBe(188);
    expect((p.notes_ar ?? []).join(" ")).not.toContain("المصدر يعطي");
  });
  it("the price follows the tool that will be called (its own call price over the rows a call gives), and the approval re-prices the same plan to the same number", async () => {
    const p = await finalPlan();
    const c = p.stages.find((s) => s.key === "comments")!;
    expect(c.measured_cost_per_row_usd).toBeCloseTo(0.001 / 20, 8);
    const again = priceMissionByCode(stagePriceInputs(p.stages, p.contact_steps), { settings: p.price.settings });
    expect(again.reservePoints).toBe(p.price.reservePoints);
  });
  it("execution reads video 1 page after page to its end (168 = 8 full pages and one of 8) and video 2 in one page; 188 delivered, the old tool never called", async () => {
    const r = await run(await finalPlan());
    expect(r.rows.length).toBe(188);
    const mine = r.calls.filter((c) => c.endpoint === "tikhub.tiktok.video.comments");
    expect(mine.filter((c) => c.params.aweme_id === "0").map((c) => c.params.cursor ?? 0)).toEqual([0, "20", "40", "60", "80", "100", "120", "140", "160"]);
    expect(mine.filter((c) => c.params.aweme_id === "1")).toHaveLength(1);
    expect(r.calls.map((c) => c.endpoint)).not.toContain("crawl4ai.tiktok.video.comments");
  });
  it("the rows are mapped to the stage's columns by the stored mapping (text, author, time, likes, replies, language) and keyed by the comment's own id", async () => {
    const r = await run(await finalPlan());
    expect(r.rows[0]).toMatchObject({ id: "v0-c0", text: "تعليق 0", author: "u0", language: "ar" });
    expect(new Set(r.rows.map((x) => x.id)).size).toBe(188);
  });
  it("when the pageable tool fails for a parent, the tool it replaced reads that parent (nothing promised is lost)", async () => {
    const r = await run(await finalPlan(), { failPageable: true });
    expect(r.calls.map((c) => c.endpoint)).toContain("crawl4ai.tiktok.video.comments");
    // the replaced tool is read as the stage's next tool: its size is the one the promise needed (168), so both videos are complete
    expect(r.rows.length).toBe(188);
  });
});
