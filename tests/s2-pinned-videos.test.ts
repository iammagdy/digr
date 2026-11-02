import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { withCompleteCount, type Candidate } from "../src/lib/agentMission/completeCount";

/**
 * S2 ITEM 6 (docs/S1-LIVE-FINDINGS.md, L0.6). Live msn_48f6c7c80eb7068f2a38: the plan pinned the videos whose counters the promise was computed from (`parent_pins`), but execution ran a NEW video search and read a different second video: the old engine ignores pins,
 * and the redesigned one only swapped a pinned video back in when the new search still carried it. The redesigned engine now reads the videos chosen in the plan: their rows (measured at planning, by the stage's own proven mapping) are stored on the plan and ingested at execution,
 * with no new search call.
 */
// the planning listing: three videos, in the source's order, with their counters; the plan chooses the first two
const PLANNED = [{ id: "A", caption: "فيديو أ", comments: 168 }, { id: "B", caption: "فيديو ب", comments: 20 }, { id: "C", caption: "فيديو ج", comments: 30 }];
// the listing at execution: a video published in between comes first and pushes the planned ones down
const AT_EXECUTION = [{ id: "N", caption: "فيديو جديد", comments: 5 }, ...PLANNED];
const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over }) as unknown as PricedStage;
function planOf(videosPlanned = 2): PricedPlan {
  const videos = stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "v.videos", planned_rows: videosPlanned, expected_rows: videosPlanned, columns: [{ key: "caption", title_ar: "الوصف" }, { key: "comments", title_ar: "التعليقات" }], engine: { endpoint_id: "v.videos", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: null, built_by: "code" } });
  const comments = stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "v.comments", parent_key: "videos", per_parent_rows: 20, planned_rows: 40, expected_rows: 40, columns: [{ key: "text", title_ar: "نص التعليق" }], engine: { endpoint_id: "v.comments", params: {}, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "page", parent_binding: { param: "video", from: "id" }, built_by: "code" } });
  const stages = [videos, comments];
  return { summary_ar: "ستحصل على فيديوهات وتعليقاتها.", stages, price: priceMissionByCode(stagePriceInputs(stages, undefined), {}) } as unknown as PricedPlan;
}
const candidates: Candidate[] = PLANNED.map((v) => ({ id: v.id, counter: v.comments, row: v as unknown as Record<string, unknown> }));
const finalPlan = (plan = planOf()) => withCompleteCount(plan, { request: "كل التعليقات على فيديوهين", candidatesOf: async () => candidates, pageCapOf: async () => null });

async function run(plan: PricedPlan) {
  const store = createMemoryStore();
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      calls.push({ endpoint, params });
      let rows: Array<Record<string, unknown>>; let next: string | null = null;
      if (endpoint === "v.videos") rows = AT_EXECUTION;
      else {
        const total = AT_EXECUTION.find((v) => v.id === params.video)!.comments;
        const from = Number(params.cursor ?? 0);
        const n = Math.max(0, Math.min(20, total - from));
        rows = Array.from({ length: n }, (_, k) => ({ id: `${params.video}-c${from + k}`, text: `تعليق ${from + k}` }));
        next = from + n < total ? String(from + n) : null;
      }
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_pin", RAW_PATH(callId), JSON.stringify(rows), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: next !== null, next_cursor: next, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const items = await ItemStore.open(store, "msn_pin");
  await runEngine({ items, store, plan, missionId: "msn_pin", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: new Set(["videos", "comments"]) });
  return { calls, videos: items.acceptedRows("videos").map((r) => String(r.id)), comments: items.acceptedRows("comments") };
}

describe("execution reads the videos the plan chose", () => {
  it("the plan stores the rows of the pinned videos it measured", async () => {
    const p = await finalPlan();
    expect(p.stages.find((s) => s.key === "comments")!.parent_pins).toEqual(["A", "B"]);
    expect((p.stages.find((s) => s.key === "videos")!.pinned_rows ?? []).map((r) => r.id)).toEqual(["A", "B"]);
  });
  it("a video published after planning does not change what is read: the pinned videos A and B are delivered, with no new search", async () => {
    const r = await run(await finalPlan());
    expect(r.videos.sort()).toEqual(["A", "B"]);
    expect(r.calls.filter((c) => c.endpoint === "v.videos")).toHaveLength(0);
  });
  it("the promise is delivered: 168 + 20 comments of the pinned videos, none of the new one", async () => {
    const r = await run(await finalPlan());
    expect(r.comments).toHaveLength(188);
    expect(r.comments.some((c) => String(c.id).startsWith("N-"))).toBe(false);
  });
  it("a customer edit that changed the number of videos after planning drops the pins' rows (the plan was re-priced for another number): the stage searches as before", async () => {
    const p = await finalPlan();
    p.stages.find((s) => s.key === "videos")!.planned_rows = 3;
    const r = await run(p);
    expect(r.calls.filter((c) => c.endpoint === "v.videos").length).toBeGreaterThan(0);
  });
  it("without the redesigned mode (flags off) nothing changes: the old engine still searches", async () => {
    const plan = await finalPlan();
    const store = createMemoryStore();
    const calls: string[] = [];
    const gateway = { async tregCall(input: { endpoint_id?: unknown }) { calls.push(String(input.endpoint_id)); return { ok: false as const, http_status: 500, error: "x" }; } } as unknown as Gateway;
    const items = await ItemStore.open(store, "msn_pin2");
    await runEngine({ items, store, plan, missionId: "msn_pin2", gateway, sandbox: async () => ({ ok: true, resultJson: "[]", logs: [] }), addEvent: async () => undefined, deadlineMs: Date.now() + 60_000, sleep: async () => undefined });
    expect(calls).toContain("v.videos");
  });
});
