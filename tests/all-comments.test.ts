import { describe, expect, it } from "vitest";
import { directEngine as _unused } from "./helpers/engineDirect";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";

/**
 * S1 item 1.10: «ALL COMMENTS MEANS ALL» ([PRICE-INPUT]: an estimate input in the plan only; the charge formula in price.ts is not touched). When the customer asks for all the comments, each parent is read to its source's end using ITS OWN comment counter for the
 * estimate; a parent whose counter is 0 is never read; the plan states «كل التعليقات» with the estimated count and its price. Above the job cap the plan keeps today's behaviour (Stage 4 adds staging); Stage 1 ships «all» only inside the cap.
 */
void _unused;

const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0005, ...over }) as unknown as PricedStage;
const COUNTERS = [12, 40, 7, 0, 100];

describe("the engine reads every parent to its own counter and never reads a parent whose counter is 0", () => {
  async function run(all: boolean) {
    const store = createMemoryStore();
    const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
    let seq = 0;
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const endpoint = String(input.endpoint_id);
        const params = (input.params ?? {}) as Record<string, unknown>;
        calls.push({ endpoint, params });
        let rows: Array<Record<string, unknown>>; let next: string | null = null;
        if (endpoint === "v.videos") rows = COUNTERS.map((n, i) => ({ id: `v${i}`, caption: `فيديو ${i}`, comments: n }));
        else {
          const total = COUNTERS[Number(String(params.videoId).slice(1))];
          const from = Number(params.cursor ?? 0);
          const n = Math.max(0, Math.min(20, total - from));
          rows = Array.from({ length: n }, (_, k) => ({ id: `${params.videoId}-c${from + k}`, text: `تعليق ${from + k}` }));
          next = from + n < total ? String(from + n) : null;
        }
        const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
        await store.putFile("msn_ac", RAW_PATH(callId), JSON.stringify(rows), "application/json");
        return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: next !== null, next_cursor: next, shape: null, first_rows: [], warnings: [], saved: "" };
      },
    } as unknown as Gateway;
    const videos = stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "v.videos", planned_rows: 5, columns: [{ key: "caption", title_ar: "الوصف" }, { key: "comments", title_ar: "التعليقات" }], engine: { endpoint_id: "v.videos", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: null } });
    const comments = stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "v.comments", parent_key: "videos", per_parent_rows: 100, planned_rows: 159, expected_rows: 159, ...(all ? { all_children: true } : {}), columns: [{ key: "text", title_ar: "نص التعليق" }], engine: { endpoint_id: "v.comments", params: {}, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "page", parent_binding: { param: "videoId", from: "id" } } });
    const plan = { summary_ar: "x", stages: [videos, comments], price: { deliveredRows: 164 } } as unknown as PricedPlan;
    const items = await ItemStore.open(store, "msn_ac");
    await runEngine({ items, store, plan, missionId: "msn_ac", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined });
    return { items, calls };
  }
  it("all_children: 159 comments delivered, the parent with counter 0 is never read", async () => {
    const { items, calls } = await run(true);
    expect(items.acceptedRows("comments")).toHaveLength(159);
    expect(calls.some((c) => c.endpoint === "v.comments" && c.params.videoId === "v3")).toBe(false);
    const perVideo = (v: string) => items.acceptedRows("comments").filter((r) => r.parent_id === v).length;
    expect([perVideo("v0"), perVideo("v1"), perVideo("v2"), perVideo("v4")]).toEqual([12, 40, 7, 100]);
  });
  it("without all_children (the old shares): the same plan delivers fewer than 159", async () => {
    const { items } = await run(false);
    expect(items.acceptedRows("comments").length).toBeLessThan(159);
  });
});
