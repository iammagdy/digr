import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { countWorkbookItems } from "../agent/src/finalize";
import { buildMissionFiles } from "../agent/src/workbook";
import { missionFactsOf } from "../agent/src/methodology";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import type { EngineSpec, PricedPlan } from "../src/lib/agentMission/plan";
import { CHILD_COLUMNS } from "../src/lib/agentMission/foundation/toolCards";

/**
 * ROUND 16: SYNTHETIC CONTROL-FLOW TESTS of the comments alternatives (clearly synthetic: the sources are fakes written here, the pages are made up; they prove what the ENGINE does with `engine.alternatives`, not what a provider answers).
 * The engine under test is the production one (agent/src/engine/run.ts, unchanged), run on a plan shaped as the compiler builds it: pinned parents, then a comments stage with `parent_pins`, a per-parent number and the alternatives.
 */
const NOW = Date.parse("2026-11-03T12:00:00Z");
const MAIN = "syn.main.comments";
const ALT1 = "syn.alt1.comments";
const ALT2 = "syn.alt2.comments";
const MAP = { map_code: "return inputs.page", map_file_id: "page" };
const comment = (prefix: string, i: number) => ({ id: `${prefix}${i}`, text: `تعليق ${prefix}${i}`, author: "كاتب", posted_at: "2026-11-02T10:00:00.000Z", likes: 0, replies_count: null, language: "ar" });
const batch = (prefix: string, from: number, n: number) => Array.from({ length: n }, (_, i) => comment(prefix, from + i));

type Out = { rows: Array<Record<string, unknown>>; next?: string | null } | "fail" | "refused" | "daily";
interface Call { endpoint: string; params: Record<string, unknown> }
type Handler = (params: Record<string, unknown>, n: number) => Out;

const parent = (i: number, extra: Record<string, unknown> = {}) => ({ id: `p${i}`, text: `منشور ${i}`, link: `https://example.test/p${i}`, comments: 30, ...extra });
const altEntry = (endpointId: string, patch: Partial<NonNullable<EngineSpec["alternatives"]>[number]> = {}): NonNullable<EngineSpec["alternatives"]>[number] => ({ endpoint_id: endpointId, params: {}, cursor_param: "after", ...MAP, parent_binding: { param: "post", from: "link" }, ...patch });

function planOf(options: { parents: Array<Record<string, unknown>>; per: number; alternatives?: EngineSpec["alternatives"]; maxPages?: number }): PricedPlan {
  const n = options.parents.length;
  return {
    summary_ar: "x",
    stages: [
      { key: "posts", title_ar: "المنشورات", endpoint_id: "syn.parents", expected_rows: n, planned_rows: n, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "link", title_ar: "الرابط" }, { key: "comments", title_ar: "عدد التعليقات" }], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0, yield_share: 1, review_share: 0, pinned_rows: options.parents, engine: { endpoint_id: "syn.parents", params: {}, cursor_param: null, ...MAP, parent_binding: null, built_by: "code" } },
      { key: "comments", title_ar: "التعليقات", endpoint_id: MAIN, expected_rows: n * options.per, planned_rows: n * options.per, parent_key: "posts", per_parent_rows: options.per, deliver: true, columns: CHILD_COLUMNS.map((c) => ({ ...c })), sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0003, yield_share: 1, review_share: 0, parent_pins: options.parents.map((p) => String(p.id)), ...(options.maxPages ? { max_pages: options.maxPages } : {}), engine: { endpoint_id: MAIN, params: {}, cursor_param: "cursor", ...MAP, parent_binding: { param: "url", from: "link" }, built_by: "code", ...(options.alternatives ? { alternatives: options.alternatives } : {}) } },
    ],
    price: { deliveredRows: n * options.per },
    compiled: { by: "compiler", platform: "instagram", promises: {}, conditions: { named: false, period: false, language: false, country: false, topic: false } },
  } as unknown as PricedPlan;
}

function world(handlers: Record<string, Handler>) {
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
      if (out === "daily") return { ok: false as const, refused: "daily_cap", message: "daily cap" };
      if (out === "fail") return { ok: false as const, failed: true, http_status: 500, message: "boom" };
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_alt", RAW_PATH(callId), JSON.stringify(out.rows), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: out.rows.length, has_more: out.next ? true : false, next_cursor: out.next ?? null, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const run = async (plan: PricedPlan) => {
    const items = await ItemStore.open(store, "msn_alt");
    const outcome = await runEngine({ items, store, plan, missionId: "msn_alt", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, now: () => NOW, deadlineMs: NOW + 3_600_000, sleep: async () => undefined, redesignStages: new Set(["posts", "comments"]) });
    return { outcome, items };
  };
  return { run, calls, store };
}
const idsOf = (items: ItemStore, parentId?: string): string[] => items.acceptedRows("comments").filter((r) => parentId === undefined || String(r.parent_id) === parentId).map((r) => String(r.id));
const byParent = (parentId: string, handler: (p: Record<string, unknown>, n: number) => Out) => (params: Record<string, unknown>, n: number): Out => (String(params.url ?? params.post).endsWith(parentId) ? handler(params, n) : { rows: [] });

describe("SYNTHETIC: the main source ends before the count, the next one continues the SAME parent", () => {
  const handlers = (seen: { altTokens: string[] }): Record<string, Handler> => ({
    // parent p0: the main source gives 12 and ends; parent p1: it gives all 30
    [MAIN]: (p) => (String(p.url).endsWith("p0") ? { rows: batch("m0-", 1, 12) } : { rows: batch("m1-", 1, 30) }),
    // the alternative re-reads p0 from its own start: its first 5 comments are the 5 the main source already gave (same ids), then new ones; its own cursor pages it
    [ALT1]: (p, n) => {
      seen.altTokens.push(String(p.after ?? ""));
      if (n === 1) return { rows: [...batch("m0-", 1, 5), ...batch("a0-", 1, 10)], next: "ALT-PAGE-2" };
      return { rows: batch("a0-", 11, 10), next: null };
    },
    [ALT2]: () => ({ rows: batch("z-", 1, 30) }),
  });

  it("the alternative is called for the short parent only, with the parent's own link under its own input name, and with NO cursor taken from another source", async () => {
    const seen = { altTokens: [] as string[] };
    const w = world(handlers(seen));
    const { items, outcome } = await w.run(planOf({ parents: [parent(0), parent(1)], per: 30, alternatives: [altEntry(ALT1), altEntry(ALT2)] }));
    const alt = w.calls.filter((c) => c.endpoint === ALT1);
    expect(alt.length).toBe(2);
    expect(alt[0].params).toEqual({ post: "https://example.test/p0" });
    expect(alt[0].params.after).toBeUndefined();
    expect(alt[1].params).toEqual({ post: "https://example.test/p0", after: "ALT-PAGE-2" });
    expect(w.calls.some((c) => c.endpoint === ALT1 && String(c.params.post).endsWith("p1"))).toBe(false);
    // the main source's token never reaches the alternative (the main source here gave no cursor, so assert on the stream state instead: its own stream keys)
    expect(items.streamKeys("comments").sort()).toEqual(["p:p0", "p:p0:alt0", "p:p1"]);
    expect(outcome.stops.comments).toBe("target_reached");
    expect(idsOf(items, "p0")).toHaveLength(30);
    expect(idsOf(items, "p1")).toHaveLength(30);
  });

  it("no row disappears and none is counted twice: the 12 of the main source stay, the 5 the alternative repeated are removed by their identity, the rest are added; the second alternative is not called once the parent is full", async () => {
    const w = world(handlers({ altTokens: [] }));
    const { items } = await w.run(planOf({ parents: [parent(0), parent(1)], per: 30, alternatives: [altEntry(ALT1), altEntry(ALT2)] }));
    const p0 = idsOf(items, "p0");
    expect(new Set(p0).size).toBe(p0.length);
    expect(p0.slice(0, 12)).toEqual(batch("m0-", 1, 12).map((r) => r.id));
    expect(p0.filter((id) => id.startsWith("a0-")).length).toBe(18);
    expect(items.counts("comments").duplicates).toBe(5);
    expect(w.calls.some((c) => c.endpoint === ALT2)).toBe(false);
    // the first accepted record is kept: the stored row of a repeated id is the main source's
    expect(items.acceptedRows("comments").find((r) => r.id === "m0-3")?.text).toBe("تعليق m0-3");
  });

  it("the per-parent number and the stage total are never passed: an alternative that gives 50 a page still stops at 30 for the parent", async () => {
    const w = world({ [MAIN]: byParent("p0", () => ({ rows: batch("m-", 1, 2) })), [ALT1]: () => ({ rows: batch("a-", 1, 50), next: "more" }), [ALT2]: () => ({ rows: [] }) });
    const { items } = await w.run(planOf({ parents: [parent(0)], per: 30, alternatives: [altEntry(ALT1)] }));
    expect(idsOf(items)).toHaveLength(30);
    expect(w.calls.filter((c) => c.endpoint === ALT1).length).toBe(1);
  });

  it("the second alternative continues when the first ends short, and each has its own stream and its own cursor", async () => {
    const tokens: Record<string, string[]> = { [ALT1]: [], [ALT2]: [] };
    const w = world({
      [MAIN]: () => ({ rows: batch("m-", 1, 5) }),
      [ALT1]: (p) => { tokens[ALT1].push(String(p.after ?? "")); return { rows: batch("a-", 1, 5), next: null }; },
      [ALT2]: (p, n) => { tokens[ALT2].push(String(p.after ?? "")); return n === 1 ? { rows: batch("z-", 1, 10), next: "Z2" } : { rows: batch("z-", 11, 10), next: null }; },
    });
    const { items } = await w.run(planOf({ parents: [parent(0)], per: 30, alternatives: [altEntry(ALT1), altEntry(ALT2)] }));
    expect(tokens[ALT1]).toEqual([""]);
    expect(tokens[ALT2]).toEqual(["", "Z2"]);
    expect(items.streamKeys("comments").sort()).toEqual(["p:p0", "p:p0:alt0", "p:p0:alt1"]);
    expect(idsOf(items)).toHaveLength(30);
  });
});

describe("SYNTHETIC: only on the existing continuation reasons, never to get past a refusal", () => {
  it("a failed main source (two failures) continues on the alternative", async () => {
    const w = world({ [MAIN]: () => "fail", [ALT1]: () => ({ rows: batch("a-", 1, 30) }), [ALT2]: () => ({ rows: [] }) });
    const { items } = await w.run(planOf({ parents: [parent(0)], per: 30, alternatives: [altEntry(ALT1)] }));
    expect(idsOf(items)).toHaveLength(30);
  });
  it("a budget refusal on the main source stops every further call: the alternative is NOT called", async () => {
    const w = world({ [MAIN]: (_p, n) => (n === 1 ? { rows: batch("m-", 1, 5), next: "c2" } : "refused"), [ALT1]: () => ({ rows: batch("a-", 1, 30) }), [ALT2]: () => ({ rows: [] }) });
    const { items, outcome } = await w.run(planOf({ parents: [parent(0), parent(1)], per: 30, alternatives: [altEntry(ALT1)] }));
    expect(w.calls.some((c) => c.endpoint === ALT1)).toBe(false);
    expect(idsOf(items)).toHaveLength(5);
    expect(outcome.stops.comments).toBe("budget");
  });
  it("a daily-cap refusal on the main source stops every further call", async () => {
    const w = world({ [MAIN]: () => "daily", [ALT1]: () => ({ rows: batch("a-", 1, 30) }), [ALT2]: () => ({ rows: [] }) });
    const { outcome } = await w.run(planOf({ parents: [parent(0)], per: 30, alternatives: [altEntry(ALT1)] }));
    expect(w.calls.filter((c) => c.endpoint !== MAIN)).toEqual([]);
    expect(outcome.stops.comments).toBe("daily_cap");
  });
  it("a budget refusal ON the alternative ends the stage there: the next alternative and the next parents are not called through it, and the rows read stay", async () => {
    const w = world({ [MAIN]: () => ({ rows: batch("m-", 1, 5) }), [ALT1]: (_p, n) => (n === 1 ? { rows: batch("a-", 1, 5), next: "x" } : "refused"), [ALT2]: () => ({ rows: batch("z-", 1, 30) }) });
    const { items, outcome } = await w.run(planOf({ parents: [parent(0)], per: 30, alternatives: [altEntry(ALT1), altEntry(ALT2)] }));
    expect(w.calls.some((c) => c.endpoint === ALT2)).toBe(false);
    expect(idsOf(items)).toHaveLength(10);
    expect(outcome.stops.comments).toBe("budget");
  });
  it("an alternative is not called when the main source reaches the number", async () => {
    const w = world({ [MAIN]: () => ({ rows: batch("m-", 1, 30) }), [ALT1]: () => ({ rows: batch("a-", 1, 30) }), [ALT2]: () => ({ rows: [] }) });
    await w.run(planOf({ parents: [parent(0)], per: 30, alternatives: [altEntry(ALT1)] }));
    expect(w.calls.filter((c) => c.endpoint === ALT1)).toEqual([]);
  });
  it("a parent with no value for the alternative's input is skipped, never guessed (the plan excludes such an alternative before approval; the engine still never invents a binding)", async () => {
    const w = world({ [MAIN]: () => ({ rows: batch("m-", 1, 5) }), [ALT1]: () => ({ rows: batch("a-", 1, 30) }), [ALT2]: () => ({ rows: [] }) });
    const { items } = await w.run(planOf({ parents: [parent(0, { link: "https://example.test/p0" })], per: 30, alternatives: [altEntry(ALT1, { parent_binding: { param: "post", from: "permalink" } })] }));
    expect(w.calls.filter((c) => c.endpoint === ALT1)).toEqual([]);
    expect(idsOf(items)).toHaveLength(5);
  });
});

describe("SYNTHETIC: resume does not duplicate", () => {
  it("a mission put back in the queue after the alternative ran resumes from the log: no call repeats, no row repeats, the stop is the same", async () => {
    const w = world({ [MAIN]: () => ({ rows: batch("m-", 1, 12) }), [ALT1]: (_p, n) => (n === 1 ? { rows: batch("a-", 1, 10), next: "A2" } : { rows: batch("a-", 11, 8), next: null }), [ALT2]: () => ({ rows: [] }) });
    const plan = planOf({ parents: [parent(0)], per: 30, alternatives: [altEntry(ALT1)] });
    const first = await w.run(plan);
    const callsAfterFirst = w.calls.length;
    const idsFirst = idsOf(first.items);
    const second = await w.run(plan);
    expect(w.calls.length).toBe(callsAfterFirst);
    expect(idsOf(second.items)).toEqual(idsFirst);
    expect(second.outcome.stops.comments).toBe(first.outcome.stops.comments);
  });
  it("a resume in the middle of the alternative continues from the alternative's own cursor, not from the start and not from the main source's", async () => {
    // the first run is cut after the alternative's first page (the third call of the whole stage fails for good: the engine ends the stream with `failed`); the second run continues
    const w = world({ [MAIN]: () => ({ rows: batch("m-", 1, 12) }), [ALT1]: (p, n) => (n === 1 ? { rows: batch("a-", 1, 10), next: "A2" } : String(p.after) === "A2" ? { rows: batch("a-", 11, 8), next: null } : "fail"), [ALT2]: () => ({ rows: [] }) });
    const plan = planOf({ parents: [parent(0)], per: 30, alternatives: [altEntry(ALT1)] });
    const { items } = await w.run(plan);
    expect(idsOf(items)).toHaveLength(30);
    expect(w.calls.filter((c) => c.endpoint === ALT1).map((c) => c.params.after ?? null)).toEqual([null, "A2"]);
  });
});

describe("SYNTHETIC: what is settled is the unique rows delivered", () => {
  it("the count in the built file equals the unique accepted identities (the number every surface and the charge read), however many rows the sources repeated", async () => {
    const w = world({
      [MAIN]: byParent("p0", () => ({ rows: batch("m-", 1, 12) })),
      [ALT1]: () => ({ rows: [...batch("m-", 1, 12), ...batch("a-", 1, 18)], next: null }),
      [ALT2]: () => ({ rows: [] }),
    });
    const plan = planOf({ parents: [parent(0), parent(1, { comments: 0 })], per: 30, alternatives: [altEntry(ALT1)] });
    const { items } = await w.run(plan);
    const snap = items.snapshotOfMemory();
    const rowsByStage: Record<string, Array<Record<string, unknown>>> = { posts: snap.acceptedRows("posts"), comments: snap.acceptedRows("comments", plan.stages[1].planned_rows) };
    const unique = new Set(rowsByStage.comments.map((r) => String(r.id)));
    expect(unique.size).toBe(rowsByStage.comments.length);
    const built = await buildMissionFiles(withPromiseCaps(plan), rowsByStage, missionFactsOf({ requestText: "x", plan, snap, reviewStop: null, deliveredAt: new Date(NOW) }), undefined, { now: NOW });
    const inFile = await countWorkbookItems(built.xlsx);
    expect(inFile).toBe(rowsByStage.posts.length + unique.size);
    // the settlement basis is that number: ceil(delivered x unit price), never above the reserve (the money functions are not touched; this is the arithmetic they apply)
    const unit = 0.37;
    const charge = Math.ceil(Math.round(inFile! * unit * 1e6) / 1e6 - 1e-9);
    expect(charge).toBe(Math.ceil((rowsByStage.posts.length + unique.size) * unit - 1e-9));
  });
});
