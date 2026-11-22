import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog, type CatalogEndpoint, type TregCatalog } from "../src/lib/treg/catalog";
import * as catalogView from "../agent/src/llmPlanner/catalogView";
import { createGateway, estimateCallUsd, RAW_PATH, tregCallBoundOf } from "../agent/src/gateway";
import { oneCallUsd } from "../src/lib/agentMission/planningBudget";
import * as asyncTreg from "../agent/src/asyncTreg";
import * as planner from "../agent/src/llmPlanner/planner";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { verifiedCallMaxUsdOf } from "../agent/src/engine/sourceGateway";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { settlementChargeFor } from "../src/lib/missionPricing";
import { fakeRecorder, NOT_ADMIN, USER_ID } from "./helpers/agentHarness";
import { tregResult } from "./helpers/agentFakeWorld";

vi.stubGlobal("fetch", () => {
  throw new Error("FX-CAT pricing test attempted real network access");
});

const catalog = loadTregCatalog();

function makeEndpoint(over: Partial<CatalogEndpoint> & { id: string }): CatalogEndpoint {
  return {
    provider: "fixture",
    platform: "web",
    category: "data",
    capability: "web.search",
    name: over.id,
    method: "GET",
    path: "/fixture",
    kind: "direct",
    tier: "core",
    async: false,
    async_config: null,
    summary: "fixture endpoint",
    inputs: [{ name: "q", in: "query", type: "string", required: true, enum: null, minimum: null, maximum: null, default: null, example: "ai", note: null }],
    pagination: [],
    cost: { unit: "call", usd: 0.005, type: "per_call", currency: "USD", value: 0.005, per: 1, billing_note: null, failed_or_empty_billed: null },
    observed: { ok_rate: 0.99, hit_rate: 0.99, samples: 100 },
    scope: "public",
    item_fields: {},
    siblings: [],
    ...over,
  } as unknown as CatalogEndpoint;
}

function fakeCatalogWith(extra: CatalogEndpoint[]): TregCatalog {
  const endpoints = [...catalog.endpoints, ...extra];
  const byId = new Map<string, CatalogEndpoint>();
  for (const e of endpoints) byId.set(e.id, e);
  return { ...catalog, endpoints, byId };
}

function makeGatewayEnv(cat: TregCatalog, opts: { ceilingUsd?: number; call?: any; phase?: "planning" | "execution"; spendGate?: any } = {}) {
  const store = createMemoryStore();
  const mission = newMission({ id: "msn_fxcat_pricing", user_id: USER_ID, request_text: "test", status: "executing" });
  store.missions.set(mission.id, mission);
  const { recorder, commit } = fakeRecorder({});
  const client: any = {
    from: () => ({
      insert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({}) }),
      select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }),
    }),
  };
  const callFn = opts.call ?? vi.fn(async () => tregResult({ results: [{ id: "r1", title: "row 1" }] }, 0));
  const budget = createJobCallBudget({ ceilingUsd: opts.ceilingUsd ?? 1, spentUsd: 0 });
  const gateway = createGateway({
    store,
    client,
    missionId: mission.id,
    userId: USER_ID,
    jobId: "job_fxcat_pricing",
    phase: opts.phase ?? "execution",
    access: NOT_ADMIN,
    catalog: cat,
    budget,
    recorder,
    commit,
    call: callFn,
    defaultPurpose: "test",
    counter: { seq: 0 },
    ...(opts.spendGate ? { spendGate: opts.spendGate } : {}),
  } as any);
  return { store, mission, recorder, commit, callFn, budget, gateway };
}

function makeBuiltStep(ep: CatalogEndpoint, opts: { rowsPerPage?: number; chargedUsd?: number; more?: Record<string, unknown>[] } = {}): any {
  const rowsPerPage = opts.rowsPerPage ?? 10;
  return {
    step: {
      key: "items",
      title_ar: "العناصر",
      platform: ep.platform,
      capability: ep.capability ?? `${ep.platform}.search`,
      parent: null,
      deliver: true,
      count: { total: 20, per_parent: null, all: false },
    },
    option: {
      endpoint: ep,
      params: { q: "test" },
      cursor: null,
      parent: null,
      more: opts.more ?? [],
      notCarried: [],
    },
    mapCode: "return []",
    columns: [{ key: "id", title_ar: "المعرّف" }],
    carryKeys: [],
    sampleRows: [{ id: "1" }],
    rowsPerPage,
    callIds: ["call_0001"],
    hasMore: true,
    ...(opts.chargedUsd !== undefined ? { sample: { rowsPerPage, chargedUsd: opts.chargedUsd, checkedParams: { q: "test" } } } : {}),
  };
}

describe("FX-CAT pricing 1: Unpriced, credit-zero, and unsupported-unit refusal (0 HTTP calls)", () => {
  it("rejects cost:null, cost.usd:null, credit zero non-free, and unsupported units in usableEndpoint, tregCallBoundOf, and gateway.tregCall", async () => {
    const nullCost = makeEndpoint({ id: "fixture.null.cost", cost: null as any });
    const nullUsd = catalog.byId.get("justoneapi.x.llm-doubao-answer-v1")!;
    const creditZero = catalog.byId.get("getleadsio.companies.acquisitions.feed")!;
    const badUnit = catalog.byId.get("serpstat.google.domain.overview")!;
    const freeBadUnit = makeEndpoint({ id: "fixture.free.char", cost: { unit: "character", usd: 0, type: "free", currency: "USD", value: 0, per: 1, billing_note: null, failed_or_empty_billed: null } });

    expect(nullUsd).toBeDefined();
    expect(creditZero).toBeDefined();
    expect(badUnit).toBeDefined();

    const customCat = fakeCatalogWith([nullCost, freeBadUnit]);
    const callSpy = vi.fn(async () => tregResult({ results: [] }, 0));
    const { gateway, budget } = makeGatewayEnv(customCat, { call: callSpy });

    for (const ep of [nullCost, nullUsd, creditZero, badUnit, freeBadUnit]) {
      expect(catalogView.usableEndpoint(ep, customCat, NOT_ADMIN), ep.id).toBe(false);
      expect(tregCallBoundOf(ep.id, { q: "x", domain: "example.com", domains: ["example.com"] }, customCat), ep.id).toBeNull();
      expect(verifiedCallMaxUsdOf(customCat)(ep.id, { q: "x" }), ep.id).toBeNull();

      const res = await gateway.tregCall({ endpoint_id: ep.id, params: { q: "x", domains: ["example.com"] } });
      expect(res.ok, ep.id).toBe(false);
      if (!res.ok && "refused" in res) {
        expect(res.refused, ep.id).toBe("not_sellable");
      } else {
        throw new Error(`Expected refusal for ${ep.id}`);
      }
    }

    expect(callSpy).not.toHaveBeenCalled();
    expect(budget.spentUsd()).toBe(0);
  });

  it("refuses async submit endpoint whose poll endpoint is unpriced", () => {
    const unpricedPoll = makeEndpoint({ id: "fixture.async.poll.unpriced", cost: { unit: "call", usd: null, type: "per_call", currency: "USD", value: null, per: 1, billing_note: null, failed_or_empty_billed: null } });
    const submitWithBadPoll = makeEndpoint({
      id: "fixture.async.submit.badpoll",
      async: true,
      async_config: { id_from: "id", poll: { endpoint: unpricedPoll.id, param: { in: "query", name: "id" } }, status: { path: "status", success: ["done"] } },
      cost: { unit: "call", usd: 0.006, type: "per_call", currency: "USD", value: 0.006, per: 1, billing_note: null, failed_or_empty_billed: null },
    });
    const cat = fakeCatalogWith([unpricedPoll, submitWithBadPoll]);
    expect(catalogView.usableEndpoint(submitWithBadPoll, cat, NOT_ADMIN)).toBe(false);
  });
});

describe("FX-CAT pricing 2: Documented free endpoints stay sellable ($0 provider cost, model floor)", () => {
  it("allows tinyfish.web.search.news and 200+ free catalog endpoints without $0.01 guess", async () => {
    const tinyfish = catalog.byId.get("tinyfish.web.search.news")!;
    expect(tinyfish).toBeDefined();
    expect(catalogView.usableEndpoint(tinyfish, catalog, null)).toBe(true);
    expect(catalogView.callUsdOf(tinyfish)).toBe(0);
    expect(oneCallUsd(tinyfish, catalog)).toBe(0);
    expect(estimateCallUsd(tinyfish, {}, catalog)).toBe(0);
    expect(tregCallBoundOf(tinyfish.id, { query: "ai" }, catalog)).toBe(0.001);

    const freeSellableCount = catalog.endpoints.filter((e) => e.cost?.type === "free" && e.cost?.usd === 0 && catalogView.usableEndpoint(e, catalog, null)).length;
    expect(freeSellableCount).toBeGreaterThanOrEqual(200);

    const callSpy = vi.fn(async () => tregResult({ results: [{ id: "n1", title: "News", url: "https://ex.com" }] }, 0));
    const { gateway, budget } = makeGatewayEnv(catalog, { call: callSpy });
    const res = await gateway.tregCall({ endpoint_id: tinyfish.id, params: { query: "ai", domain_type: "news" } });
    expect(res.ok).toBe(true);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(Number(callSpy.mock.calls[0][0].routeMaxCostUsd)).toBeGreaterThanOrEqual(0.001);
    expect(budget.spentUsd()).toBe(0);
    expect((res as any).charge_usd).toBe(0);

    const desc = catalogView.describeForModel(tinyfish);
    expect(desc.usd_per_call).toBe(0);
    expect(desc.cost_unit).toBe("call");

    const built = makeBuiltStep(tinyfish, { rowsPerPage: 10 });
    const costPerRawRow = (planner as any).stageCostPerRawRowUsd(built, catalog);
    expect(costPerRawRow).toBe(0);

    const plan = planner.assemblePlan(
      { understanding_ar: "أخبار الذكاء الاصطناعي", assumptions_ar: [], steps: [built.step] } as any,
      [built],
      [],
      undefined,
      [],
      undefined,
      catalog,
    );
    expect(plan.stages[0].measured_cost_per_row_usd).toBe(0);
    expect(plan.price.providerCostUsd).toBe(0);
    expect(plan.price.modelCostUsd).toBeGreaterThan(0);
    expect(plan.price.reservePoints).toBeGreaterThanOrEqual(200);
  });
});

describe("FX-CAT pricing 3: Per-record, routed worst sibling, sample overrun, single_object, and real refusal vs stub fallback", () => {
  it("prices per-record endpoints without dividing by rowsPerPage, routed by worst sibling, and respects measured sample overruns", () => {
    const perRecord = catalog.byId.get("brightdata.x.amazon-products")!;
    expect(perRecord).toBeDefined();
    expect(perRecord.cost?.unit).toBe("record");
    const r10 = (planner as any).stageCostPerRawRowUsd(makeBuiltStep(perRecord, { rowsPerPage: 10 }), catalog);
    const r50 = (planner as any).stageCostPerRawRowUsd(makeBuiltStep(perRecord, { rowsPerPage: 50 }), catalog);
    expect(r10).toBeCloseTo(0.0015 * planner.VARIANT_OVERLAP_FACTOR, 9);
    expect(r50).toBeCloseTo(r10, 9);

    const routed = catalog.byId.get("treg.amazon.product.detail")!;
    expect(routed).toBeDefined();
    expect(routed.kind).toBe("routed");
    const routedCost = (planner as any).stageCostPerRawRowUsd(makeBuiltStep(routed, { rowsPerPage: 10 }), catalog);
    expect(routedCost).toBeCloseTo((0.015 / 10) * planner.VARIANT_OVERLAP_FACTOR, 9);

    const routedZero = catalog.byId.get("treg.companies.search")!;
    expect(routedZero).toBeDefined();
    expect(catalogView.usableEndpoint(routedZero, catalog, null)).toBe(true);
    expect((planner as any).stageCostPerRawRowUsd(makeBuiltStep(routedZero, { rowsPerPage: 10 }), catalog)).toBeCloseTo((0.02 / 10) * planner.VARIANT_OVERLAP_FACTOR, 9);

    const overrun = (planner as any).stageCostPerRawRowUsd(makeBuiltStep(perRecord, { rowsPerPage: 10, chargedUsd: 0.04 }), catalog);
    expect(overrun).toBeCloseTo((0.04 / 10) * planner.VARIANT_OVERLAP_FACTOR, 9);

    const singleObjCost = (planner as any).stageCostPerRawRowUsd(makeBuiltStep(catalog.byId.get("tikhub.x.telegram-web-fetch-channel-info")!, { rowsPerPage: 1 }), catalog);
    expect(singleObjCost).toBeCloseTo(0.001 * planner.VARIANT_OVERLAP_FACTOR, 9);

    const unpricedReal = catalog.byId.get("justoneapi.x.llm-doubao-answer-v1")!;
    const zeroCredit = catalog.byId.get("getleadsio.companies.acquisitions.feed")!;
    const badUnit = catalog.byId.get("serpstat.google.domain.overview")!;
    for (const bad of [unpricedReal, zeroCredit, badUnit]) {
      expect(() => (planner as any).stageCostPerRawRowUsd(makeBuiltStep(bad, { rowsPerPage: 10 }), catalog)).toThrow();
    }

    const undefinedCostStub = { id: "synthetic.stub", platform: "facebook", inputs: [], pagination: [] } as unknown as CatalogEndpoint;
    expect((planner as any).stageCostPerRawRowUsd(makeBuiltStep(undefinedCostStub, { rowsPerPage: 5 }))).toBeCloseTo((0.01 / 5) * planner.VARIANT_OVERLAP_FACTOR, 9);
  });
});

describe("FX-CAT pricing 4: Existing 405+ per-call endpoints stay byte-identical & P-10 tinyfish keeps $0", () => {
  it("matches old formula (usd / rowsPerPage) * VARIANT_OVERLAP_FACTOR across all direct positive per-call endpoints", () => {
    const directPerCall = catalog.endpoints.filter(
      (e) => e.kind === "direct" && e.cost && e.cost.usd !== null && e.cost.usd > 0 && ["call", "page", "step"].includes(String(e.cost.unit ?? "").toLowerCase()),
    );
    expect(directPerCall.length).toBeGreaterThanOrEqual(405);
    for (const ep of directPerCall) {
      const legacy = (Number(ep.cost!.usd) / 10) * planner.VARIANT_OVERLAP_FACTOR;
      const next = (planner as any).stageCostPerRawRowUsd(makeBuiltStep(ep, { rowsPerPage: 10 }), catalog);
      expect(next, ep.id).toBe(legacy);
    }
  });
});

describe("FX-CAT pricing 5: Async submit + free poll under exact budget, non-enumerable charge_usd/call_ids, and null charge fallback", () => {
  it("runs poll even when leftUsd() === 0 after exact-budget submit, sets gateBefore floor, and accumulates non-enumerable metadata", async () => {
    const submitId = "dataforseo.x.app-data-apple-app-reviews-task-post";
    const pollId = "dataforseo.x.app-data-apple-app-reviews-task-get-advanced";
    const submitEp = catalog.byId.get(submitId)!;
    const pollEp = catalog.byId.get(pollId)!;
    expect(submitEp).toBeDefined();
    expect(pollEp).toBeDefined();
    expect(tregCallBoundOf(pollId, {}, catalog)).toBe(0.001);

    const submitParams = Object.fromEntries(submitEp.inputs.filter((i) => i.required).map((i) => [i.name, "test"]));
    const pollParamName = (submitEp.async_config as any).poll.param.name;

    const callSpy = vi.fn(async (opts: { endpointId: string }) => {
      if (opts.endpointId === submitId) {
        return tregResult({ tasks: [{ id: "task_999" }] }, 0.006);
      }
      return tregResult({ tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ items: [{ id: "r1", rating: 5, title: "Great" }] }] }] }, 0);
    });

    const { store, mission, gateway, budget } = makeGatewayEnv(catalog, { ceilingUsd: 0.006, call: callSpy });

    const asyncRes = await asyncTreg.callTregWithAsync(
      { catalog, store, missionId: mission.id, sleep: async () => undefined },
      (endpoint_id, params) => gateway.tregCall({ endpoint_id, params }),
      submitId,
      submitParams,
    );

    expect(asyncRes.ok).toBe(true);
    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(budget.spentUsd()).toBeCloseTo(0.006, 9);

    expect((asyncRes as any).charge_usd).toBeCloseTo(0.006, 9);
    expect((asyncRes as any).reserved_usd).toBeCloseTo(0.006, 9);
    expect((asyncRes as any).call_ids).toEqual(["call_0001", "call_0002"]);

    const spread = { ...asyncRes };
    expect("charge_usd" in spread).toBe(false);
    expect("reserved_usd" in spread).toBe(false);
    expect("call_ids" in spread).toBe(false);
    const serialized = JSON.stringify(asyncRes);
    expect(serialized).not.toContain("charge_usd");
    expect(serialized).not.toContain("reserved_usd");
    expect(serialized).not.toContain("call_ids");

    expect((asyncTreg as any).effectiveChargeUsd({ charge_usd: 0, reserved_usd: 0.005 })).toBe(0);
    expect((asyncTreg as any).effectiveChargeUsd({ charge_usd: null, reserved_usd: 0.005 })).toBe(0.005);

    const pollParamKey = pollParamName;
    const directFreeCall = vi.fn(async () => tregResult({ results: [] }, 0));
    const directEnv = makeGatewayEnv(catalog, { ceilingUsd: 0.001, call: directFreeCall });
    await directEnv.gateway.tregCall({ endpoint_id: "tinyfish.web.search.news", params: { query: "ai", domain_type: "news" } });
    expect(directEnv.budget.spentUsd()).toBe(0);
    void pollParamKey;

    const reserveSpy = vi.fn(async () => ({ ok: true as const, reservationId: "res_1", grantId: "grant_1", replay: false }));
    const settleSpy = vi.fn(async () => ({ ok: true as const, state: "settled" as const, countedUsd: 0, overrunUsd: 0, replay: false }));
    const gatedCall = vi.fn(async (opts: { endpointId: string }) =>
      opts.endpointId === submitId
        ? tregResult({ tasks: [{ id: "task_sg" }] }, 0.006)
        : tregResult({ tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ items: [{ id: "r1", rating: 5 }] }] }] }, 0),
    );
    const gatedEnv = makeGatewayEnv(catalog, {
      ceilingUsd: 0.006,
      call: gatedCall,
      spendGate: { mode: "enforce", gate: { reserve: reserveSpy, settle: settleSpy, stop: vi.fn(async () => undefined) } },
    });
    const gatedRes = await asyncTreg.callTregWithAsync(
      { catalog, store: gatedEnv.store, missionId: gatedEnv.mission.id, sleep: async () => undefined },
      (endpoint_id, params) => gatedEnv.gateway.tregCall({ endpoint_id, params }),
      submitId,
      submitParams,
    );
    expect(gatedRes.ok).toBe(true);
    expect(reserveSpy).toHaveBeenCalledTimes(2);
    expect(reserveSpy.mock.calls[1][0].boundUsd).toBe(0.000001);
    expect(Number(gatedCall.mock.calls[1][0].routeMaxCostUsd)).toBe(0);
  });

  it("accumulates reserve fallback when submit returns null charge_usd", async () => {
    const submitId = "dataforseo.x.app-data-apple-app-reviews-task-post";
    const submitEp = catalog.byId.get(submitId)!;
    const submitParams = Object.fromEntries(submitEp.inputs.filter((i) => i.required).map((i) => [i.name, "test"]));

    const callSpy = vi.fn(async (opts: { endpointId: string }) => {
      if (opts.endpointId === submitId) {
        return { ...tregResult({ tasks: [{ id: "task_null" }] }, 0), costUnreported: true };
      }
      return tregResult({ tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ items: [{ id: "r1", rating: 4 }] }] }] }, 0);
    });

    const { store, mission, gateway } = makeGatewayEnv(catalog, { ceilingUsd: 0.01, call: callSpy });
    const asyncRes = await asyncTreg.callTregWithAsync(
      { catalog, store, missionId: mission.id, sleep: async () => undefined },
      (endpoint_id, params) => gateway.tregCall({ endpoint_id, params }),
      submitId,
      submitParams,
    );
    expect(asyncRes.ok).toBe(true);
    expect((asyncRes as any).charge_usd).toBeCloseTo(0.01, 9);
    expect((asyncRes as any).reserved_usd).toBeCloseTo(0.01, 9);
    expect(RAW_PATH("call_0002")).toBe("raw/call_0002.json");
  });
});

describe("FX-CAT pricing 6: Customer card consistency, delivered-only settlement, and no double charge", () => {
  it("preserves unit/reserve parity across priceMissionByCode, customerPlanView, and settlementChargeFor (partial and 0-row)", () => {
    const ep = catalog.byId.get("brightdata.x.amazon-products")!;
    const built = makeBuiltStep(ep, { rowsPerPage: 10 });
    const plan = planner.assemblePlan(
      { understanding_ar: "منتجات أمازون", assumptions_ar: [], steps: [built.step] } as any,
      [built],
      [],
      undefined,
      [],
      undefined,
      catalog,
    );
    const view = customerPlanView(plan);
    const directPrice = priceMissionByCode([{ rows: 20, costPerRowUsd: plan.stages[0].measured_cost_per_row_usd, deliver: true }]);

    expect(view.price.unit_price_points).toBe(directPrice.unitPricePoints);
    expect(view.price.reserve_points).toBe(directPrice.reservePoints);
    expect(view.price.max_charge_points).toBe(directPrice.maxChargePoints);

    const partial = settlementChargeFor(7, {
      jobUnitPoints: view.price.unit_price_points,
      reservePoints: view.price.reserve_points,
    });
    const zero = settlementChargeFor(0, {
      jobUnitPoints: view.price.unit_price_points,
      reservePoints: view.price.reserve_points,
    });
    expect(partial).toBeLessThanOrEqual(view.price.reserve_points);
    expect(partial).toBeGreaterThan(0);
    expect(zero).toBe(0);
  });
});
