import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import type { EngineSpec, PricedPlan } from "../src/lib/agentMission/plan";

/**
 * S1 item 1.9: FETCH TO THE COUNT, WITH CONTINUATION ACROSS TOOLS (owner decisions D7, D15). When a tool fails twice or runs dry, the engine takes the next tool of the recipe's ordered alternatives and CONTINUES by the remaining count, the date boundary reached
 * (the oldest day read so far) and the stored ids. Everything inside the approved reserve; at the reserve edge it stops with `need_new_plan`. Behind the flag: a stage that is not in `redesignStages` stops where it always stopped.
 */
const NOW = Date.parse("2026-11-01T12:00:00Z");
const day = (n: number): string => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);
const iso = (n: number): string => `${day(n)}T10:00:00Z`;
const A = "a.search.posts";
const B = "b.search.posts";
const MAP = { map_code: "return inputs.page", map_file_id: "page", parent_binding: null as null };

const stage = (planned: number) => ({ key: "posts", title_ar: "المنشورات", endpoint_id: A, expected_rows: planned, planned_rows: planned, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "date", title_ar: "التاريخ" }], sample_rows: [], measured_by: [], filters: [{ kind: "period", field: "date", days: 365 }] });
const specOf = (alternatives: EngineSpec["alternatives"]): EngineSpec => ({ endpoint_id: A, params: { query: "x" }, cursor_param: "cursor", ...MAP, ...(alternatives ? { alternatives } : {}) });
const alt: NonNullable<EngineSpec["alternatives"]>[number] = { endpoint_id: B, params: { keyword: "x" }, cursor_param: "cursor", ...MAP, window: { kind: "range_params", from: "startDate", to: "endDate", format: "date" } };

interface Call { endpoint: string; params: Record<string, unknown> }
type Out = { rows: Array<Record<string, unknown>>; next?: string | null } | "fail" | "refused";

/** A fake gateway: one handler per endpoint, every call recorded, every page saved the way the real gateway saves it. */
function harness(handlers: Record<string, (params: Record<string, unknown>, n: number) => Out>, options: { redesign: boolean; planned: number; alternatives?: EngineSpec["alternatives"] }) {
  const store = createMemoryStore();
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      calls.push({ endpoint, params });
      counts[endpoint] = (counts[endpoint] ?? 0) + 1;
      const out = handlers[endpoint](params, counts[endpoint]);
      if (out === "refused") return { ok: false as const, refused: "over_budget", message: "over budget" };
      if (out === "fail") return { ok: false as const, failed: true, http_status: 500, message: "boom" };
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_fb", RAW_PATH(callId), JSON.stringify(out.rows), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: out.rows.length, has_more: out.next ? true : false, next_cursor: out.next ?? null, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const st = stage(options.planned);
  const plan = { summary_ar: "x", stages: [{ ...st, engine: specOf(options.alternatives) }], price: { deliveredRows: options.planned } } as unknown as PricedPlan;
  const run = async () => {
    const items = await ItemStore.open(store, "msn_fb");
    const outcome = await runEngine({ items, store, plan, missionId: "msn_fb", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, now: () => NOW, deadlineMs: NOW + 3_600_000, sleep: async () => undefined, ...(options.redesign ? { redesignStages: new Set(["posts"]) } : {}) });
    return { outcome, items };
  };
  return { run, calls };
}
const page = (prefix: string, from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${from + i}`, text: `منشور ${prefix}${from + i}`, date: iso(from + i) }));

describe("tool A gives 20 of 50 then fails; tool B continues from the date boundary", () => {
  const handlers = () => ({
    [A]: (_p: Record<string, unknown>, n: number): Out => (n === 1 ? { rows: page("a", 1, 20), next: "c2" } : "fail"),
    [B]: (p: Record<string, unknown>): Out => { const end = Date.parse(`${String(p.endDate)}T00:00:00Z`); const back = Math.round((NOW - end) / 86_400_000); return { rows: page("b", back, 40) }; },
  });
  it("flag on: 50 delivered, no duplicate id, B asked for the days up to the oldest day read from A", async () => {
    const h = harness(handlers(), { redesign: true, planned: 50, alternatives: [alt] });
    const { outcome, items } = await h.run();
    const ids = items.acceptedRows("posts").map((r) => String(r.id));
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
    expect(outcome.stops.posts).toBe("target_reached");
    const bFirst = h.calls.find((c) => c.endpoint === B)!;
    expect(bFirst.params.endDate).toBe(day(20));
    expect(typeof bFirst.params.startDate).toBe("string");
    expect(bFirst.params.keyword).toBe("x");
  });
  it("flag off: the stage stops where it always stopped (20 delivered, reason failed), tool B is never called", async () => {
    const h = harness(handlers(), { redesign: false, planned: 50, alternatives: [alt] });
    const { outcome, items } = await h.run();
    expect(items.acceptedRows("posts")).toHaveLength(20);
    expect(outcome.stops.posts).toBe("failed");
    expect(h.calls.some((c) => c.endpoint === B)).toBe(false);
  });
});

describe("a barren read does not end the stage while another tool remains", () => {
  it("A repeats the same page: B takes over and the count is reached", async () => {
    const h = harness({
      [A]: (): Out => ({ rows: page("a", 1, 10), next: "same" }),
      [B]: (p: Record<string, unknown>): Out => { const back = Math.round((NOW - Date.parse(`${String(p.endDate)}T00:00:00Z`)) / 86_400_000); return { rows: page("b", back, 40) }; },
    }, { redesign: true, planned: 30, alternatives: [alt] });
    const { outcome, items } = await h.run();
    expect(items.acceptedRows("posts")).toHaveLength(30);
    expect(outcome.stops.posts).toBe("target_reached");
    expect(h.calls.filter((c) => c.endpoint === B).length).toBeGreaterThan(0);
  });
});

describe("the reserve edge", () => {
  it("when the budget refuses before the count is reached the stage stops with need_new_plan, not with a lower silent count", async () => {
    const h = harness({
      [A]: (_p: Record<string, unknown>, n: number): Out => (n === 1 ? { rows: page("a", 1, 20), next: "c2" } : "refused"),
      [B]: (): Out => "refused",
    }, { redesign: true, planned: 50, alternatives: [alt] });
    const { outcome, items } = await h.run();
    expect(items.acceptedRows("posts")).toHaveLength(20);
    expect(outcome.stops.posts).toBe("need_new_plan");
  });
  it("flag off: the same edge stops with the old reason «budget»", async () => {
    const h = harness({ [A]: (_p: Record<string, unknown>, n: number): Out => (n === 1 ? { rows: page("a", 1, 20), next: "c2" } : "refused"), [B]: (): Out => "refused" }, { redesign: false, planned: 50, alternatives: [alt] });
    const { outcome } = await h.run();
    expect(outcome.stops.posts).toBe("budget");
  });
});
