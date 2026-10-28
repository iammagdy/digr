import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { deriveEngineSpecs, parentBinding } from "../agent/src/engine/spec";
import { runInSandbox } from "../agent/src/sandbox";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import type { CallRow } from "../agent/src/types";

/**
 * WHAT CODE NEEDS TO CARRY A PLAN OUT, derived from what the agent really did and PROVEN on the measured page: a recipe that cannot be proven is not trusted (the model carries that mission out).
 */
const catalog = loadTregCatalog();
const MISSION = "msn_spec01";
const ENDPOINT = "anyapi.x.search.posts";
const page = { output: { data: { items: Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, text: `نص ${i}`, url: `https://x.example/${i}` })) } } };
const MAP = "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url }))";
const callRow = (over: Partial<CallRow> = {}): CallRow => ({ id: `${MISSION}:call_0001`, mission_id: MISSION, phase: "planning", endpoint_id: ENDPOINT, params_digest: { query: "محمد صلاح", limit: 20 }, status: "ok", refused_reason: null, http_status: 200, rows_returned: 4, cost_usd: 0.001, estimate_usd: 0.001, provider_cost_id: null, storage_path: "raw/call_0001.json", duration_ms: 10, ...over });
const stage = (over: Record<string, unknown> = {}) => ({ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 10, planned_rows: 10, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [], measured_by: ["call_0001"], measured_from_calls: ["call_0001"], measured_cost_per_row_usd: 0.0001, ...over });
const planOf = (...stages: Array<Record<string, unknown>>) => ({ summary_ar: "x", stages, price: {} }) as unknown as PricedPlan;

async function world(code: string, output: unknown) {
  const store = createMemoryStore();
  await store.putFile(MISSION, "raw/call_0001.json", JSON.stringify(page), "application/json");
  await store.putFile(MISSION, "out/out_0001.json", JSON.stringify(output), "application/json");
  return store;
}
const mapped = page.output.data.items.map((t) => ({ id: t.id, text: t.text, url: t.url }));
const deps = (store: ReturnType<typeof createMemoryStore>, over: Record<string, unknown> = {}) => ({ store, missionId: MISSION, catalog, calls: [callRow()], codeRuns: new Map([["out_0001", { code: MAP, files: ["call_0001"] }]]), callParams: new Map([["call_0001", { query: "محمد صلاح", limit: 20 }]]), sandbox: runInSandbox, ...over }) as Parameters<typeof deriveEngineSpecs>[1];

describe("the recipe of a stage is proven before it is trusted", () => {
  it("the mapping the agent ran, run again on the page it was written for, gives the rows the agent saw: the stage gets a recipe", async () => {
    const specs = await deriveEngineSpecs(planOf(stage()), deps(await world(MAP, mapped)));
    expect(specs.get("tweets")).toEqual({ endpoint_id: ENDPOINT, params: { query: "محمد صلاح", limit: 20 }, cursor_param: "cursor", map_code: MAP, map_file_id: "call_0001", parent_binding: null });
  });

  it("a mapping of only the first rows of the page (the engine would deliver a fraction of each page) gets NO recipe: the model carries the mission out", async () => {
    const code = "return inputs.call_0001.output.data.items.slice(0, 2).map(t => ({ id: t.id, text: t.text, url: t.url }))";
    const store = await world(code, mapped.slice(0, 2));
    const specs = await deriveEngineSpecs(planOf(stage()), deps(store, { codeRuns: new Map([["out_0001", { code, files: ["call_0001"] }]]) }));
    expect(specs.size).toBe(0);
  });

  it("code that does not reproduce what the agent saw (a different result on the same page) gets NO recipe", async () => {
    const store = await world(MAP, mapped);
    const specs = await deriveEngineSpecs(planOf(stage()), deps(store, { codeRuns: new Map([["out_0001", { code: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id + 'x', text: t.text, url: t.url }))", files: ["call_0001"] }]]) }));
    expect(specs.size).toBe(0);
  });

  it("a mapping over several pages, a measuring call of another source, or a call that failed: no recipe", async () => {
    const store = await world(MAP, mapped);
    expect((await deriveEngineSpecs(planOf(stage()), deps(store, { codeRuns: new Map([["out_0001", { code: MAP, files: ["call_0001", "call_0002"] }]]) }))).size).toBe(0);
    expect((await deriveEngineSpecs(planOf(stage()), deps(store, { calls: [callRow({ endpoint_id: "anyapi.facebook.post_comments" })] }))).size).toBe(0);
    expect((await deriveEngineSpecs(planOf(stage()), deps(store, { calls: [callRow({ status: "failed" })] }))).size).toBe(0);
  });

  it("the inputs of the measuring call come from this run's full copy; a call log cut a long value (80 characters) is not trusted", async () => {
    const store = await world(MAP, mapped);
    const long = "ك".repeat(80);
    expect((await deriveEngineSpecs(planOf(stage()), deps(store, { callParams: new Map(), calls: [callRow({ params_digest: { query: long, limit: 20 } })] }))).size).toBe(0);
    expect((await deriveEngineSpecs(planOf(stage()), deps(store, { callParams: new Map(), calls: [callRow({ params_digest: { query: "محمد صلاح", limit: 20 } })] }))).size).toBe(1);
  });
});

describe("a stage with a parent: which input takes which field of the parent's row", () => {
  const parents = [{ id: "fp1", url: "https://fb.example/posts/fp1", text: "منشور" }, { id: "fp2", url: "https://fb.example/posts/fp2", text: "منشور آخر" }];
  it("the input whose value is one of the parent's fields is the binding (the id first)", () => {
    expect(parentBinding({ url: "https://fb.example/posts/fp1", limit: 10 }, parents)).toEqual({ param: "url", from: "url" });
    expect(parentBinding({ post_id: "fp2" }, parents)).toEqual({ param: "post_id", from: "id" });
  });
  it("no input binds, or two do: no binding (nothing is guessed); a limit and a short number are never a binding", () => {
    expect(parentBinding({ query: "something else" }, parents)).toBeNull();
    expect(parentBinding({ a: "fp1", b: "https://fb.example/posts/fp1" }, parents)).toBeNull();
    expect(parentBinding({ limit: "fp1", page: 1 }, [{ id: "fp1" }, { id: 1 }])).toBeNull();
  });
});
