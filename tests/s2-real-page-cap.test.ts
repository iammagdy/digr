import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";

import { pageCapOfSource, pageLimitOf } from "../src/lib/agentMission/pageLimit";

/**
 * S2 ITEM 3 (docs/S1-LIVE-FINDINGS.md, L0.3). Live msn_48f6c7c80eb7068f2a38: the comments source `crawl4ai.tiktok.video.comments` was sampled with `limit: 20` (the planner's own choice), gave 20 rows, and the plan took 20 as «what one call gives»: it promised 2 x 20 and
 * the engine asked 20 again. The tool's own schema says `limit` is «how many comments (default 50, at most 500)». The page cap is the tool's real maximum from the catalog, never the size of the planner's sample, and the call asks for what the promise needs up to that maximum.
 */
const catalog = loadTregCatalog();
const endpoint = (id: string) => catalog.byId.get(id)!;

describe("the real page limit of a tool, from its catalog schema", () => {
  it("crawl4ai.tiktok.video.comments: `limit`, default 50, at most 500 (stated in the endpoint's own words)", () => {
    expect(pageLimitOf(endpoint("crawl4ai.tiktok.video.comments"))).toEqual({ param: "limit", max: 500, default: 50 });
  });
  it("a tool that states a size input and no maximum gives its default, never a number nobody stated", () => {
    expect(pageLimitOf(endpoint("tikhub.tiktok.video.comments"))).toEqual({ param: "count", max: null, default: 20 });
  });
  it("a tool with no size input has no page limit of its own", () => {
    expect(pageLimitOf(endpoint("anyapi.tiktok.video.comments"))).toBeNull();
    expect(pageLimitOf(endpoint("scrapecreators.tiktok.video.comments"))).toBeNull();
  });
});

describe("the page cap: the tool's maximum, not the planner's sample", () => {
  it("the live case: a sample of 20 rows asked with limit 20 does NOT make 20 the cap: crawl4ai's cap is 500", () => {
    expect(pageCapOfSource(endpoint("crawl4ai.tiktok.video.comments"), null, 20)).toBe(500);
  });
  it("a tool with a next page has no cap (it pages)", () => {
    expect(pageCapOfSource(endpoint("tikhub.tiktok.video.comments"), "cursor", 20)).toBeNull();
  });
  it("a tool with no next page and a size input but no maximum is capped at its stated default", () => {
    expect(pageCapOfSource(endpoint("tikhub.tiktok.video.comments"), null, 5)).toBe(20);
  });
  it("a tool with no size input at all gives what its page gives: the sample measures it (nobody chose that size)", () => {
    expect(pageCapOfSource(endpoint("anyapi.tiktok.video.comments"), null, 37)).toBe(37);
  });
});

// the live shape: video 1 shows 168 (comments and replies), video 2 shows 20; the source gives what its limit allows, at most 500
const COUNTERS = [168, 20];
const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.000025, ...over }) as unknown as PricedStage;
function planOf(): PricedPlan {
  const videos = stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "v.videos", planned_rows: 2, expected_rows: 2, columns: [{ key: "caption", title_ar: "الوصف" }, { key: "comments", title_ar: "التعليقات" }], engine: { endpoint_id: "v.videos", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: null, built_by: "code" } });
  const comments = stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "crawl4ai.tiktok.video.comments", parent_key: "videos", per_parent_rows: 20, planned_rows: 40, expected_rows: 40, columns: [{ key: "text", title_ar: "نص التعليق" }], engine: { endpoint_id: "crawl4ai.tiktok.video.comments", params: { limit: 20 }, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: { param: "post", from: "id" }, built_by: "code" } });
  const stages = [videos, comments];
  return { summary_ar: "ستحصل على فيديوهات وتعليقاتها.", stages, price: priceMissionByCode(stagePriceInputs(stages, undefined), {}) } as unknown as PricedPlan;
}
const comments = endpoint("crawl4ai.tiktok.video.comments");
const wiring = { pageCapOf: async () => pageCapOfSource(comments, null, 20), pageSizeOf: async () => { const l = pageLimitOf(comments); return l && l.max !== null ? { param: l.param, max: l.max } : null; } };

async function run(plan: PricedPlan) {
  const store = createMemoryStore();
  const asked: Array<Record<string, unknown>> = [];
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const params = (input.params ?? {}) as Record<string, unknown>;
      let rows: Array<Record<string, unknown>>;
      if (input.endpoint_id === "v.videos") rows = COUNTERS.map((n, i) => ({ id: `v${i}`, caption: `فيديو ${i}`, comments: n }));
      else {
        asked.push(params);
        // the schema: `limit` how many comments (default 50, at most 500), no next page
        const all = COUNTERS[Number(String(params.post).slice(1))];
        const n = Math.min(Number(params.limit ?? 50), 500, all);
        rows = Array.from({ length: n }, (_, k) => ({ id: `${params.post}-c${k}`, text: `تعليق ${k}` }));
      }
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_pc", RAW_PATH(callId), JSON.stringify(rows), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const items = await ItemStore.open(store, "msn_pc");
  await runEngine({ items, store, plan, missionId: "msn_pc", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: new Set(["videos", "comments"]) });
  return { asked, delivered: items.acceptedRows("comments").length };
}

