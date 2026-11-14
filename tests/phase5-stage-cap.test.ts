import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createGateway, estimateCallUsd, tregRouteMaxUsd, type Gateway } from "../agent/src/gateway";
import { createSourceGateway, stageScopeOf, verifiedCallMaxUsdOf, type StageScope } from "../agent/src/engine/sourceGateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { WEB_SOURCE_IDS, PARSER_IDS } from "../src/lib/agentMission/sources";
import { fakeRecorder, NOT_ADMIN, USER_ID } from "./helpers/agentHarness";
import { tregResult } from "./helpers/agentFakeWorld";
import type { PricedPlan } from "../src/lib/agentMission/plan";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * PHASE 5 FINAL SAFETY GATE: THE STAGE CAP OF THE SOURCEGATEWAY (`multi_stage_engine`, OFF).
 *
 * FINDING (reproduced below on the code as merged in 1fb4c88): the cap was checked AFTER the spend: «has this stage ALREADY spent its cap?». A call whose maximum cost was larger than what was left was still made, so a stage
 * could end past its cap by up to one call's maximum (the merged test let two 0.0008 web calls through a 0.001 cap: 0.0016 spent). Calls racing on one stage could each pass the check, and a call whose cost was unknown counted
 * only what the job budget moved.
 *
 * FIX: before the request, what the stage counts + what its calls in flight may still cost + this call's VERIFIED MAXIMUM must fit in the cap; the maximum is reserved while the call runs; a failed or thrown call counts at
 * least its maximum. Only a maximum the provider enforces counts: TREG's route cap (`X-Treg-Route-Max-Cost`, the value the gateway really sends, pinned here); a direct web source (Firecrawl, Context.dev) has none, so a
 * capped stage never calls one. A stage with no cap is unchanged. Every provider answer here is SIMULATED (labelled); the catalog is the real one.
 */
const catalog: any = loadTregCatalog();
const TREG_ID = "tomba.companies.search.reveal";
const TREG_ID_2 = "tomba.companies.emails.list";
const WEB_ID = "contextdev.parse.emails";

/** A simulated TREG gateway: each call costs what the test says (settled on the job budget as the real gateway does); `fail` answers with a failure whose cost is unknown (the budget keeps the estimate). */
function fakeTreg(budget: ReturnType<typeof createJobCallBudget>, plan: { costUsd: number; estimateUsd?: number; fail?: boolean; throws?: boolean; delayMs?: number }) {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      n += 1;
      const id = `call_${String(n).padStart(4, "0")}`;
      calls.push({ endpoint_id: input.endpoint_id, ...(input.params as Record<string, unknown>) });
      const est = plan.estimateUsd ?? plan.costUsd;
      if (!budget.reserve(est)) return { ok: false as const, call_id: id, refused: "over_budget", message: "no" };
      if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
      if (plan.throws) { budget.settle(est, null); throw new Error("simulated: the call threw after it may have gone out"); }
      if (plan.fail) { budget.settle(est, null); return { ok: false as const, call_id: id, failed: true as const, http_status: 0, message: "simulated timeout" }; }
      budget.settle(est, plan.costUsd);
      return { ok: true as const, call_id: id, http_status: 200, rows_in_page: 1, has_more: false, next_cursor: null };
    },
  } as unknown as Gateway;
  return { gateway, calls };
}
const scopeOf = (capUsd: number | null, ids = [TREG_ID]): Record<string, StageScope> => ({ s: { endpointIds: ids, capUsd }, free: { endpointIds: ids, capUsd: null } });

describe("the finding, reproduced: the merged check let a stage pass its cap", () => {
  it("REPRODUCTION (the merged test's own numbers): two 0.0008 web calls against a 0.001 cap. Before: both were made (0.0016 spent). Now: a web source has no verified maximum, so a capped stage makes NO call", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const web = { parsePage: vi.fn(async () => { budget.settle(0, 0.0008); return { ok: true as const, call_id: "w", rows_in_page: 1, next_cursor: null }; }) } as any;
    const sg = createSourceGateway({ gateway: fakeTreg(budget, { costUsd: 0 }).gateway, web, scope: scopeOf(0.001, [WEB_ID]), budget, maxCallUsd: verifiedCallMaxUsdOf(catalog) });
    for (const u of ["https://a.example", "https://b.example"]) expect(await sg.call({ stageKey: "s", endpoint_id: WEB_ID, params: { url: u } })).toMatchObject({ ok: false, refused: "stage_cap_unbounded" });
    expect(web.parsePage).not.toHaveBeenCalled();
    expect(sg.stageSpentUsd("s")).toBe(0);
    expect(budget.spentUsd()).toBe(0);
  });

  it("REPRODUCTION (TREG): 0.0007 counted, a call whose route cap is 0.0004 against a 0.001 cap. The merged check (0.0007 < 0.001) made it; now it is refused before any request", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const t = fakeTreg(budget, { costUsd: 0.0007 });
    const bounds = [0.0007, 0.0004];
    const sg = createSourceGateway({ gateway: t.gateway, scope: scopeOf(0.001), budget, maxCallUsd: () => bounds.shift() ?? null });
    expect((await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).ok).toBe(true);
    expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).toMatchObject({ ok: false, refused: "stage_cap" });
    expect(t.calls).toHaveLength(1);
    expect(sg.stageCapUsedUsd("s")).toBeCloseTo(0.0007, 12);
  });
});

describe("the stage cap is a boundary: the next call can never take the stage past it", () => {
  it("calls are made while their maximum fits; a call that lands exactly on the cap is made, the next one is not", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const t = fakeTreg(budget, { costUsd: 0.0005 });
    const sg = createSourceGateway({ gateway: t.gateway, scope: scopeOf(0.001), budget, maxCallUsd: () => 0.0005 });
    expect((await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).ok).toBe(true);
    expect((await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).ok).toBe(true);
    expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).toMatchObject({ ok: false, refused: "stage_cap" });
    expect(t.calls).toHaveLength(2);
    expect(sg.stageSpentUsd("s")).toBeCloseTo(0.001, 12);
    // the refusal is recorded with no request and no cost
    expect(sg.records().at(-1)).toMatchObject({ outcome: "refused", refused: "stage_cap", via: "none", spentUsd: 0 });
  });

  it("the check uses the call's MAXIMUM, not what calls usually cost: cheap calls with a dear maximum stop early, never late", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const t = fakeTreg(budget, { costUsd: 0.0001 });
    const sg = createSourceGateway({ gateway: t.gateway, scope: scopeOf(0.001), budget, maxCallUsd: () => 0.0004 });
    const outcomes = [];
    for (let i = 0; i < 12; i += 1) outcomes.push((await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).ok);
    // 0.0001 counted per call: the 7th call would need 0.0006 + 0.0004 = 0.001 (fits), the 8th 0.0007 + 0.0004 > 0.001
    expect(outcomes.filter(Boolean)).toHaveLength(7);
    expect(sg.stageSpentUsd("s") + 0.0004).toBeGreaterThan(0.001);
  });

  it("a call whose cost is UNKNOWN (a failure: the provider may have billed it) counts at its maximum, never at zero and never at the smaller estimate", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const t = fakeTreg(budget, { costUsd: 0, estimateUsd: 0.0001, fail: true });
    const sg = createSourceGateway({ gateway: t.gateway, scope: scopeOf(0.001), budget, maxCallUsd: () => 0.0004 });
    expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).toMatchObject({ ok: false, failed: true });
    expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).toMatchObject({ ok: false, failed: true });
    // the job budget kept the estimate (0.0001 each: unchanged), the cap counts the maximum (0.0004 each): a third call (0.0012) is refused
    expect(budget.spentUsd()).toBeCloseTo(0.0002, 12);
    expect(sg.stageSpentUsd("s")).toBeCloseTo(0.0002, 12);
    expect(sg.stageCapUsedUsd("s")).toBeCloseTo(0.0008, 12);
    expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).toMatchObject({ ok: false, refused: "stage_cap" });
    expect(t.calls).toHaveLength(2);
  });

  it("a call that THROWS counts at its maximum, releases its reservation, and the error still reaches the engine", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const t = fakeTreg(budget, { costUsd: 0, estimateUsd: 0.0001, throws: true });
    const sg = createSourceGateway({ gateway: t.gateway, scope: scopeOf(0.001), budget, maxCallUsd: () => 0.0006 });
    await expect(sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).rejects.toThrow(/simulated/);
    expect(sg.stageCapUsedUsd("s")).toBeCloseTo(0.0006, 12);
    // 0.0006 + 0.0006 > 0.001: refused (a leaked reservation would count 0.0012 + 0.0006; a zero count would allow it)
    expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).toMatchObject({ ok: false, refused: "stage_cap" });
    expect(t.calls).toHaveLength(1);
  });

  it("CONCURRENCY: 10 calls racing on one stage (maximum 0.0003 each, cap 0.001): at most 3 are sent, so even if each costs its full maximum the stage stays within its cap", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const t = fakeTreg(budget, { costUsd: 0.0003, delayMs: 5 });
    const sg = createSourceGateway({ gateway: t.gateway, scope: scopeOf(0.001), budget, maxCallUsd: () => 0.0003 });
    const results = await Promise.all(Array.from({ length: 10 }, () => sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })));
    expect(t.calls).toHaveLength(3);
    expect(results.filter((r) => !r.ok && "refused" in r && r.refused === "stage_cap")).toHaveLength(7);
    expect(sg.stageCapUsedUsd("s")).toBeLessThanOrEqual(0.001 + 1e-12);
    // the reservations were all released: a later call sees only what was counted (0.0009 + 0.0003 > 0.001: refused; no leak, no double count)
    expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).toMatchObject({ refused: "stage_cap" });
  });

  it("no verified maximum, no call under a cap: no bound function, a null, zero, negative or non-finite maximum, and every direct web source", async () => {
    for (const maxCallUsd of [undefined, () => null, () => 0, () => -1, () => Number.NaN, () => Number.POSITIVE_INFINITY]) {
      const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
      const t = fakeTreg(budget, { costUsd: 0.0001 });
      const sg = createSourceGateway({ gateway: t.gateway, scope: scopeOf(0.001), budget, ...(maxCallUsd ? { maxCallUsd } : {}) });
      expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).toMatchObject({ ok: false, refused: "stage_cap_unbounded" });
      expect(t.calls).toHaveLength(0);
    }
    const bound = verifiedCallMaxUsdOf(catalog);
    for (const id of [...WEB_SOURCE_IDS, ...Object.keys(PARSER_IDS)]) expect(bound(id, { url: "https://a.example", query: "x" }), id).toBeNull();
    expect(bound("no.such.endpoint", {})).toBeNull();
  });

  it("a stage with NO cap is unchanged: no maximum is asked, every call goes out, its spend is what the budget moved", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const t = fakeTreg(budget, { costUsd: 0.0008 });
    const maxCallUsd = vi.fn(() => 0.0001);
    const sg = createSourceGateway({ gateway: t.gateway, scope: scopeOf(null), budget, maxCallUsd });
    for (let i = 0; i < 5; i += 1) expect((await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).ok).toBe(true);
    expect(maxCallUsd).not.toHaveBeenCalled();
    expect(t.calls).toHaveLength(5);
    expect(sg.stageSpentUsd("s")).toBeCloseTo(0.004, 12);
    expect(sg.stageCapUsedUsd("s")).toBeCloseTo(0.004, 12);
  });

  it("one stage's cap never limits another stage, and the stored scope is still checked first (an out-of-scope id is refused before any maximum is asked)", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const t = fakeTreg(budget, { costUsd: 0.0005 });
    const maxCallUsd = vi.fn(() => 0.0005);
    const sg = createSourceGateway({ gateway: t.gateway, scope: scopeOf(0.0005), budget, maxCallUsd });
    expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID_2, params: {} })).toMatchObject({ refused: "out_of_scope" });
    expect(maxCallUsd).not.toHaveBeenCalled();
    expect((await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).ok).toBe(true);
    expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).toMatchObject({ refused: "stage_cap" });
    expect((await sg.call({ stageKey: "free", endpoint_id: TREG_ID, params: {} })).ok).toBe(true);
  });

  it("PROPERTY: 300 random runs (random cap, maxima, costs within their maximum, failures, throws): what a stage counts never passes its cap, and neither does what it really spent", async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let run = 0; run < 300; run += 1) {
      const cap = Number((0.0005 + rnd() * 0.01).toFixed(6));
      const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
      let n = 0;
      const gateway = {
        async tregCall() {
          n += 1;
          const r = rnd();
          const cost = Number((current * rnd()).toFixed(6));
          if (r < 0.1) { budget.settle(0, current * 0.1); throw new Error("x"); }
          if (r < 0.25) { budget.settle(0, current * 0.1); return { ok: false as const, call_id: `c${n}`, failed: true as const, http_status: 0, message: "x" }; }
          budget.settle(0, cost);
          return { ok: true as const, call_id: `c${n}`, http_status: 200, rows_in_page: 1, has_more: false, next_cursor: null };
        },
      } as unknown as Gateway;
      let current = 0;
      const sg = createSourceGateway({ gateway, scope: scopeOf(cap), budget, maxCallUsd: () => (current = Number((0.0001 + rnd() * 0.003).toFixed(6))) });
      for (let i = 0; i < 40; i += 1) await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} }).catch(() => undefined);
      expect(sg.stageCapUsedUsd("s"), `run ${run}`).toBeLessThanOrEqual(cap + 1e-9);
      expect(sg.stageSpentUsd("s"), `run ${run}`).toBeLessThanOrEqual(cap + 1e-9);
    }
  });
});

describe("the verified maximum of a TREG call is the route cap the gateway really sends", () => {
  function gatewayWith(call: ReturnType<typeof vi.fn>) {
    const store = createMemoryStore();
    const mission = newMission({ id: "msn_cap5", user_id: USER_ID, request_text: "شركات", status: "executing" });
    store.missions.set(mission.id, mission);
    const { recorder, commit } = fakeRecorder({});
    const client: any = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };
    return createGateway({ store, client, missionId: mission.id, userId: USER_ID, jobId: "job_cap5", phase: "execution", access: NOT_ADMIN, catalog, budget: createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 }), recorder, commit, call: call as any, defaultPurpose: "x", counter: { seq: 0 } } as any);
  }
  const requiredParams = (id: string): Record<string, unknown> => Object.fromEntries(catalog.byId.get(id).inputs.filter((i: any) => i.required).map((i: any) => [i.name, i.type === "number" || i.type === "integer" ? 5 : "orascom-em.com.eg"]));

  it("for catalog ids with and without a page size, with unknown parameters the gateway drops: the bound equals X-Treg-Route-Max-Cost of the real call, to the micro-dollar", async () => {
    const ids = [TREG_ID, TREG_ID_2, "tomba.people.phone.find", "anyapi.linkedin.email.work.find", "blitzapi.people.waterfall-icp"].filter((id) => catalog.byId.has(id));
    expect(ids.length).toBeGreaterThanOrEqual(3);
    for (const id of ids) {
      for (const extra of [{}, { limit: 50 }, { size: 1 }, { not_a_param: 999, limit: "x" }]) {
        const call = vi.fn(async () => tregResult({ results: [] }, 0.0001));
        const params = { ...requiredParams(id), ...extra };
        const r = await gatewayWith(call).tregCall({ endpoint_id: id, params });
        expect(r.ok, `${id} ${JSON.stringify(extra)}`).toBe(true);
        const sent = Number((call.mock.calls[0] as any[])[0].routeMaxCostUsd);
        expect(tregRouteMaxUsd(id, params, catalog), `${id} ${JSON.stringify(extra)}`).toBe(sent);
        expect(verifiedCallMaxUsdOf(catalog)(id, params)).toBe(sent);
        expect(sent).toBeGreaterThanOrEqual(0.001);
      }
    }
  });
});

describe("the floor of the route cap: a call estimated under 0.001 is still bounded by what TREG is told (0.001), never by its smaller estimate", () => {
  it("for cheap catalog ids the gateway accepts, the bound equals the route cap really sent, and it is the 0.001 floor", async () => {
    const store = createMemoryStore();
    const mission = newMission({ id: "msn_cap6", user_id: USER_ID, request_text: "x", status: "executing" });
    store.missions.set(mission.id, mission);
    const client: any = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };
    const req = (id: string): Record<string, unknown> => Object.fromEntries(catalog.byId.get(id).inputs.filter((i: any) => i.required).map((i: any) => [i.name, i.type === "number" || i.type === "integer" ? 5 : "orascom-em.com.eg"]));
    const cheap = [...catalog.byId.entries()].filter(([, e]: any) => estimateCallUsd(e, {}, catalog) < 0.001).map(([id]: any) => id as string);
    let checked = 0;
    for (const id of cheap) {
      if (checked >= 5) break;
      const call = vi.fn(async () => tregResult({ results: [] }, 0.0001));
      const { recorder, commit } = fakeRecorder({});
      const g = createGateway({ store, client, missionId: mission.id, userId: USER_ID, jobId: "job_cap6", phase: "execution", access: NOT_ADMIN, catalog, budget: createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 }), recorder, commit, call: call as any, defaultPurpose: "x", counter: { seq: checked * 10 } } as any);
      const r = await g.tregCall({ endpoint_id: id, params: req(id) });
      if (!r.ok || call.mock.calls.length === 0) continue;
      const sent = Number((call.mock.calls[0] as any[])[0].routeMaxCostUsd);
      expect(tregRouteMaxUsd(id, req(id), catalog), id).toBe(sent);
      expect(sent, id).toBe(0.001);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});

describe("where a stage cap can come from", () => {
  it("only a finite, non-negative number on the stored stage is a cap; anything else leaves the stage uncapped (the job budget is then its only bound, as before)", () => {
    const st = (max: unknown) => ({ key: "s", parent_key: null, engine: { endpoint_id: TREG_ID }, ...(max === "absent" ? {} : { max_usd: max }) });
    const capOf = (max: unknown) => stageScopeOf({ stages: [st(max)] } as unknown as Pick<PricedPlan, "stages">).s.capUsd;
    expect(capOf("absent")).toBeNull();
    for (const bad of ["0.001", null, -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) expect(capOf(bad)).toBeNull();
    expect(capOf(0)).toBe(0);
    expect(capOf(0.002)).toBe(0.002);
  });

  it("a cap of 0 makes no call at all", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const t = fakeTreg(budget, { costUsd: 0.0001 });
    const sg = createSourceGateway({ gateway: t.gateway, scope: scopeOf(0), budget, maxCallUsd: () => 0.001 });
    expect(await sg.call({ stageKey: "s", endpoint_id: TREG_ID, params: {} })).toMatchObject({ refused: "stage_cap" });
    expect(t.calls).toHaveLength(0);
  });
});

describe("the worker wires the verified maximum (under the switch only)", () => {
  it("runMission gives the SourceGateway the catalog's verified maxima; the gateway still has no ledger, price, reservation or settlement code of its own", () => {
    const src = readFileSync("agent/src/runMission.ts", "utf-8");
    expect(src).toContain("const sources = multiStage ? createSourceGateway({ gateway, ...(web ? { web } : {}), scope: stageScopeOf(plan), budget, maxCallUsd: verifiedCallMaxUsdOf(deps.catalog) }) : undefined;");
    const sg = readFileSync("agent/src/engine/sourceGateway.ts", "utf-8");
    expect(sg).not.toMatch(/accept_quote_atomic|settle_job_atomic|release_job_atomic|credit_ledger|priceMission|\.reserve\(|\.settle\(/);
  });
});
