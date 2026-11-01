import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan } from "../src/lib/agentMission/plan";
import { withCompleteCount, type Candidate } from "../src/lib/agentMission/completeCount";

/**
 * COMPLETE COUNT, item 1 (owner decision after #332 review): a comments source that cannot page far enough to reach the promised count is replaced by a PAGEABLE source that matches the customer's conditions BEFORE a shortfall is stated. A shortfall
 * on the plan is allowed only when no pageable source exists.
 */
const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0005, ...over }) as unknown as PricedPlan["stages"][number];
const binding = { param: "videoId", from: "id" };
const engineOf = (endpoint: string, cursor: string | null, alternatives?: unknown[]) => ({ endpoint_id: endpoint, params: {}, cursor_param: cursor, map_code: "return inputs.page", map_file_id: "page", parent_binding: binding, ...(alternatives ? { alternatives } : {}) });
const altOf = (endpoint: string, cursor: string | null) => ({ endpoint_id: endpoint, params: {}, cursor_param: cursor, map_code: "return inputs.page", map_file_id: "page", parent_binding: binding });

function planOf(alternatives: unknown[] | undefined): PricedPlan {
  const videos = stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "v.videos", planned_rows: 2, expected_rows: 2, columns: [{ key: "caption", title_ar: "الوصف" }, { key: "comments", title_ar: "التعليقات" }], engine: { endpoint_id: "v.videos", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: null } });
  const comments = stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "v.commentsA", parent_key: "videos", per_parent_rows: 500, planned_rows: 130, expected_rows: 130, columns: [{ key: "text", title_ar: "نص التعليق" }], engine: engineOf("v.commentsA", null, alternatives) });
  const stages = [videos, comments];
  return { summary_ar: "ستحصل على فيديوهات وتعليقاتها.", stages, price: priceMissionByCode(stagePriceInputs(stages, undefined), {}) } as unknown as PricedPlan;
}
const COUNTERS = [171, 11];
const cands: Candidate[] = COUNTERS.map((c, i) => ({ id: `v${i}`, counter: c }));

async function run(plan: PricedPlan) {
  const store = createMemoryStore();
  const calls: string[] = [];
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      calls.push(endpoint);
      let rows: Array<Record<string, unknown>>; let next: string | null = null;
      if (endpoint === "v.videos") rows = COUNTERS.map((n, i) => ({ id: `v${i}`, caption: `فيديو ${i}`, comments: n }));
      else {
        const all = COUNTERS[Number(String(params.videoId).slice(1))];
        const from = Number(params.cursor ?? 0);
        const size = endpoint === "v.commentsA" ? 120 : 20;
        const n = Math.max(0, Math.min(size, all - from));
        rows = Array.from({ length: n }, (_, k) => ({ id: `${endpoint}-${params.videoId}-c${from + k}`, text: `تعليق ${from + k}` }));
        next = endpoint === "v.commentsA" ? null : from + n < all ? String(from + n) : null;
      }
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_ps", RAW_PATH(callId), JSON.stringify(rows), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: next !== null, next_cursor: next, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const items = await ItemStore.open(store, "msn_ps");
  await runEngine({ items, store, plan, missionId: "msn_ps", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: new Set(["videos", "comments"]) });
  return { calls, delivered: items.acceptedRows("comments").length };
}
const plan = (alternatives: unknown[] | undefined) => withCompleteCount(planOf(alternatives), { request: "كل التعليقات على فيديوهين", candidatesOf: async () => cands, pageCapOf: async (child) => (child.engine!.cursor_param === null ? 120 : null) });

describe("a pageable source first, a shortfall only when none exists", () => {
  it("source A has no next page (120 a call), source B pages: the plan picks B, promises 182 and delivers 182", async () => {
    const p = await plan([altOf("v.commentsB", "cursor")]);
    const c = p.stages.find((s) => s.key === "comments")!;
    expect(c.engine!.endpoint_id).toBe("v.commentsB");
    expect(c.planned_rows).toBe(182);
    expect((p.notes_ar ?? []).join(" ")).not.toContain("المصدر يعطي");
    const r = await run(p);
    expect(r.delivered).toBe(182);
    expect(r.calls).not.toContain("v.commentsA");
  });
  it("the source that could not page stays as the next tool (never lost)", async () => {
    const c = (await plan([altOf("v.commentsB", "cursor")])).stages.find((s) => s.key === "comments")!;
    expect((c.engine!.alternatives ?? []).map((a) => a.endpoint_id)).toEqual(["v.commentsA"]);
  });
  it("no pageable source exists: the plan keeps A, promises what it gives (131) and states the shortfall before approval", async () => {
    const p = await plan(undefined);
    const c = p.stages.find((s) => s.key === "comments")!;
    expect(c.engine!.endpoint_id).toBe("v.commentsA");
    expect(c.planned_rows).toBe(131);
    expect((p.notes_ar ?? []).join(" ")).toContain("المصدر يعطي");
    expect((await run(p)).delivered).toBe(131);
  });
  it("an alternative that cannot page either is not chosen", async () => {
    const c = (await plan([altOf("v.commentsC", null)])).stages.find((s) => s.key === "comments")!;
    expect(c.engine!.endpoint_id).toBe("v.commentsA");
    expect(c.planned_rows).toBe(131);
  });
  it("when the first source can page far enough, it stays (nothing is switched for nothing)", async () => {
    const p = await withCompleteCount(planOf([altOf("v.commentsB", "cursor")]), { request: "كل التعليقات على فيديوهين", candidatesOf: async () => [{ id: "v0", counter: 90 }, { id: "v1", counter: 11 }], pageCapOf: async () => 120 });
    expect(p.stages.find((s) => s.key === "comments")!.engine!.endpoint_id).toBe("v.commentsA");
  });
});
