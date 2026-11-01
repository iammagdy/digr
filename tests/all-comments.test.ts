import { describe, expect, it } from "vitest";
import { directEngine as _unused } from "./helpers/engineDirect";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { allChildrenEstimate, wantsAllChildren, withAllChildren } from "../src/lib/agentMission/allChildren";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * S1 item 1.10: «ALL COMMENTS MEANS ALL» ([PRICE-INPUT]: an estimate input in the plan only; the charge formula in price.ts is not touched). When the customer asks for all the comments, each parent is read to its source's end using ITS OWN comment counter for the
 * estimate; a parent whose counter is 0 is never read; the plan states «كل التعليقات» with the estimated count and its price. Above the job cap the plan keeps today's behaviour (Stage 4 adds staging); Stage 1 ships «all» only inside the cap.
 */
void _unused;
describe("the words", () => {
  it("«كل التعليقات», «جميع التعليقات»: all; «كل فيديو ١٠ تعليقات»: a number per parent, not all", () => {
    expect(wantsAllChildren("هات ٥ فيديوهات تيك توك ومع كل فيديو كل التعليقات")).toBe(true);
    expect(wantsAllChildren("منشورات صفحة العربية ومع كل منشور كل التعليقات وكل الردود")).toBe(true);
    expect(wantsAllChildren("هات جميع التعليقات على الفيديو")).toBe(true);
    expect(wantsAllChildren("هات ٥ فيديوهات ومن كل فيديو ١٠ تعليقات")).toBe(false);
    expect(wantsAllChildren("هات ٥٠ تغريدة")).toBe(false);
  });
});

describe("the estimate from the parents' own counters", () => {
  it("5 videos with counters 12, 40, 7, 0, 100: 159 comments, the largest parent as the per-parent figure, one parent never read", () => {
    expect(allChildrenEstimate([12, 40, 7, 0, 100], 10)).toEqual({ total: 159, perParent: 100, read: 4, skipped: 1, unknown: 0 });
  });
  it("a parent with no counter at all is estimated at the fallback share", () => {
    expect(allChildrenEstimate([12, null, 7], 10)).toEqual({ total: 29, perParent: 12, read: 3, skipped: 0, unknown: 1 });
  });
});

const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0005, ...over }) as unknown as PricedStage;
function planOf(videoRows: number, perParent: number): PricedPlan {
  const videos = stage({ key: "videos", title_ar: "الفيديوهات", planned_rows: videoRows, expected_rows: videoRows, columns: [{ key: "caption", title_ar: "الوصف" }, { key: "comments", title_ar: "التعليقات" }] });
  const comments = stage({ key: "comments", title_ar: "التعليقات", parent_key: "videos", per_parent_rows: perParent, planned_rows: videoRows * perParent, expected_rows: videoRows * perParent, columns: [{ key: "text", title_ar: "نص التعليق" }], engine: { endpoint_id: "v.comments", params: {}, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "page", parent_binding: { param: "videoId", from: "id" } } });
  const stages = [videos, comments];
  return { summary_ar: "ستحصل على فيديوهات وتعليقاتها.", stages, price: priceMissionByCode(stagePriceInputs(stages, undefined), {}) } as unknown as PricedPlan;
}
const COUNTERS = [12, 40, 7, 0, 100];

describe("the plan states all the comments with the estimate and prices it", () => {
  it("159 comments planned, the stage marked all_children, the card says «كل التعليقات» with the count in Arabic digits, the price follows the estimate", async () => {
    const before = planOf(5, 10);
    const after = await withAllChildren(before, { request: "هات ٥ فيديوهات ومع كل فيديو كل التعليقات", parentCountersOf: async () => COUNTERS });
    const c = after.stages.find((s) => s.key === "comments")!;
    expect(c.planned_rows).toBe(159);
    expect(c.per_parent_rows).toBe(100);
    expect(c.all_children).toBe(true);
    const note = (after.notes_ar ?? []).find((n) => n.includes("كل التعليقات"))!;
    expect(note).toContain("١٥٩");
    expect(checkCustomerText(note).issues).toEqual([]);
    expect(after.price.deliveredRows).toBe(5 + 159);
    expect(after.price.reservePoints).toBeGreaterThan(before.price.reservePoints);
  });
  it("without the words «كل التعليقات» the plan is returned as it was", async () => {
    const before = planOf(5, 10);
    expect(await withAllChildren(before, { request: "هات ٥ فيديوهات ومن كل فيديو ١٠ تعليقات", parentCountersOf: async () => COUNTERS })).toBe(before);
  });
  it("above the job cap the plan keeps today's behaviour and says so (Stage 4 adds staging)", async () => {
    const before = planOf(5, 10);
    const after = await withAllChildren(before, { request: "كل التعليقات", parentCountersOf: async () => [40000, 40000, 40000, 40000, 40000] });
    expect(after.stages.find((s) => s.key === "comments")!.all_children).toBeUndefined();
    expect(after.stages.find((s) => s.key === "comments")!.planned_rows).toBe(50);
    expect((after.notes_ar ?? []).join(" ")).toContain("الحد الأقصى");
  });
});

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
