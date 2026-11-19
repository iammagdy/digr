import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../agent/src/gateway";
import { createSourceGateway, stageScopeOf } from "../agent/src/engine/sourceGateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { callMoney, createJobCallBudget, floorMicroUsd } from "../src/lib/server/callBudget";
import { executionBudgetUsd } from "../src/lib/agentMission/price";
import { createMemorySpendGate } from "../src/lib/server/spendGate/gate";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { executeTregCall, type TregCallOptions, type TregCallResult } from "../src/functions/shared/tregClient";
import { fakeRecorder, NOT_ADMIN, USER_ID, tregResult } from "./helpers/agentHarness";

/**
 * DT-20261119-11 (D1-D3, D5; Gate 1 round 1 and 2 probes turned into tests). The header sent to TREG is the money that is left, and it is the amount RESERVED on every ledger BEFORE the request: the job's money, the planning stage's kept share, a
 * capped stage, the provider's daily cap and the owner's grant. No network: TREG is a fake that bills its REAL price and refuses (402) any call whose header is below it.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const MISSION = "msn_dt11";
const catalog = loadTregCatalog();
const FIND = "findymail.search.employees";
const findParams = (count: number | undefined) => ({ website: "acme.example", job_titles: ["CEO"], ...(count === undefined ? {} : { count }) });
const T0 = Date.now();
const CLIENT = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };
const people = (n: number) => [{ name: "A", linkedinUrl: "https://www.linkedin.com/in/a", companyWebsite: "acme.example", companyName: "Acme", jobTitle: "CEO" }].slice(0, Math.max(1, n));

/** A provider that bills `realUsd` and answers 402 `route_max_cost` (nothing charged) when the header is below it. */
const provider = (realUsd: number, log: TregCallOptions[] = []) => async (o: TregCallOptions): Promise<TregCallResult> => {
  log.push(o);
  const header = Number(o.routeMaxCostUsd);
  if (!(header >= realUsd - 1e-12)) return { ok: false, httpStatus: 402, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, error: "route_max_cost", isRouteMaxCost: true, isPlatformBalanceLow: false };
  return tregResult(people(1), realUsd);
};

function world(o: { budgetUsd?: number; dailyCapUsd?: number; spendGate?: Parameters<typeof createGateway>[0]["spendGate"]; phase?: "planning" | "execution"; stageBudget?: Parameters<typeof createGateway>[0]["stageBudget"]; call: (x: TregCallOptions) => Promise<TregCallResult> }) {
  const store = createMemoryStore();
  store.missions.set(MISSION, newMission({ id: MISSION, user_id: USER_ID, request_text: "x", status: "executing", job_id: "job_dt11" }));
  const rec = fakeRecorder({ dailyCapUsd: o.dailyCapUsd ?? 100 });
  const call = vi.fn(o.call);
  const budget = createJobCallBudget({ ceilingUsd: o.budgetUsd ?? 5, spentUsd: 0 });
  const gateway = createGateway({
    store, client: CLIENT, missionId: MISSION, userId: USER_ID, jobId: "job_dt11", phase: o.phase ?? "execution", access: NOT_ADMIN, catalog, budget, recorder: rec.recorder, commit: rec.commit, call, defaultPurpose: "test", counter: { seq: 0 },
    ...(o.spendGate ? { spendGate: o.spendGate } : {}), ...(o.stageBudget ? { stageBudget: o.stageBudget } : {}),
  });
  return { store, rec, call, budget, gateway };
}
const ask = (w: ReturnType<typeof world>, count: number | undefined, extra: Record<string, unknown> = {}) => w.gateway.tregCall({ endpoint_id: FIND, params: findParams(count), ...extra });
const grantOf = (w: ReturnType<typeof createMemorySpendGate>, g: Partial<{ ceilingUsd: number; perOpMaxUsd: number; perMissionMaxUsd: number }> = {}) =>
  w.owner.issueGrant({ id: "g1", ceilingUsd: g.ceilingUsd ?? 1, perOpMaxUsd: g.perOpMaxUsd ?? 1, perMissionMaxUsd: g.perMissionMaxUsd ?? 1, kinds: ["provider", "model"], opensAt: T0 - 60_000, closesAt: T0 + 3_600_000 } as never);

describe("rounding: remaining money is whole micro-dollars rounded DOWN (D2)", () => {
  it("200 points hold 0.145454545… USD of provider money: 145,454 micro, never 145,455; a non-positive amount is 0 and sends nothing", () => {
    const budget = executionBudgetUsd(200);
    expect(budget).toBeCloseTo(0.1454545454, 9);
    expect(floorMicroUsd(budget)).toBe(0.145454);
    expect(createJobCallBudget({ ceilingUsd: budget, spentUsd: 0 }).leftUsd()).toBe(0.145454);
    expect(floorMicroUsd(0)).toBe(0);
    expect(floorMicroUsd(-1)).toBe(0);
    expect(floorMicroUsd(Number.NaN)).toBe(0);
    expect(callMoney(0.0000004, 0.0000001, 1)).toBeNull();
  });
  it("callMoney splits the money over the requests the call can make, or makes ONE request when it does not stretch", () => {
    expect(callMoney(0.4, 0.02, 4)).toEqual({ perRequestUsd: 0.1, attempts: 4, holdUsd: 0.4 });
    expect(callMoney(0.05, 0.02, 4)).toEqual({ perRequestUsd: 0.05, attempts: 1, holdUsd: 0.05 });
    expect(callMoney(0.01, 0.02, 4)).toBeNull();
  });
  it("the gateway sends exactly the rounded-down money of a 200-point hold", async () => {
    const w = world({ budgetUsd: executionBudgetUsd(200), call: provider(0.0198) });
    expect((await ask(w, 1)).ok).toBe(true);
    expect(Number((w.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd)).toBe(0.145454);
  });
});

describe("(a) a call whose catalog estimate is BELOW the real price is sent and succeeds while the approved money is left (D1/D5)", () => {
  it.each([[1, 0.0198], [2, 0.0396], [3, 0.0594]])("findymail count %i: the provider bills %d; the header is the money left (never the estimate) and the call succeeds", async (count, real) => {
    const w = world({ budgetUsd: 0.3069, call: provider(real) });
    const r = await ask(w, count);
    expect(r.ok).toBe(true);
    const sent = w.call.mock.calls[0][0] as TregCallOptions;
    expect(Number(sent.routeMaxCostUsd)).toBe(0.3069);
    expect(Number(sent.routeMaxCostUsd)).toBeGreaterThanOrEqual(real);
    expect(w.budget.spentUsd()).toBeCloseTo(real, 6);
  });
  it("main's behaviour, for the record: a header equal to the estimate (0.0198) is refused by the same provider at count 3", async () => {
    const log: TregCallOptions[] = [];
    const r = await provider(0.0594, log)({ endpointId: FIND, userId: "u", jobId: "j", routeMaxCostUsd: 0.0198 } as TregCallOptions);
    expect(r.httpStatus).toBe(402);
  });
  it("an estimate never refuses a call when money is there: the only refusal is money that does not cover the estimate (over_budget, nothing sent)", async () => {
    const w = world({ budgetUsd: 0.01, call: provider(0.0198) });
    const r = await ask(w, 1);
    expect(r).toMatchObject({ ok: false, refused: "over_budget" });
    expect(w.call).not.toHaveBeenCalled();
    expect(w.budget.spentUsd()).toBe(0);
  });
});

describe("two calls in flight cannot hold the same money (R1)", () => {
  it("the first holds ALL the job money before it is sent, the second is refused over_budget with no request, and the money held is released once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = world({ budgetUsd: 0.1, call: async (o) => { await gate; return provider(0.0198)(o); } });
    const first = ask(w, 1);
    await new Promise((r) => setTimeout(r, 20));
    const second = await ask(w, 1);
    expect(second).toMatchObject({ ok: false, refused: "over_budget" });
    expect(w.call).toHaveBeenCalledTimes(1);
    release();
    expect((await first).ok).toBe(true);
    expect(w.budget.spentUsd()).toBeCloseTo(0.0198, 6);
    // nothing stays held: the next call sees the rest of the money
    const third = await ask(w, 1);
    expect(third.ok).toBe(true);
  });
});

describe("the charge is unknown or known (D1/D3)", () => {
  it("a TIMEOUT keeps the whole reserved amount on the job, the daily ledger and the owner's grant (never the estimate, never zero)", async () => {
    const sg = createMemorySpendGate();
    grantOf(sg);
    const w = world({ budgetUsd: 0.3, spendGate: { gate: sg.gate, mode: "enforce" }, call: async () => ({ ok: false, httpStatus: 0, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, error: "timeout", timedOut: true, isRouteMaxCost: false, isPlatformBalanceLow: false }) });
    const r = await ask(w, 1);
    expect(r).toMatchObject({ ok: false, failed: true });
    expect((r as { charge_usd?: number | null }).charge_usd).toBeNull();
    expect((r as { reserved_usd?: number }).reserved_usd).toBe(0.3);
    expect(JSON.stringify(r)).not.toMatch(/charge_usd|reserved_usd/); // the model never sees the money facts
    expect(w.budget.spentUsd()).toBe(0.3);
    expect(w.rec.rows[0].committedUsd).toBe(0.3);
    expect(sg.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0.3 });
  });
  it("a call whose answer carries no charge is unknown too (the bound stays), while a documented zero (a 402 price cap) is a known zero that frees the money", async () => {
    const noCharge = world({ budgetUsd: 0.3, call: async () => ({ ...tregResult(people(1), 0), costUnreported: true }) });
    await ask(noCharge, 1);
    expect(noCharge.budget.spentUsd()).toBe(0.3);
    const zero = world({ budgetUsd: 0.05, call: provider(10) });
    const r = await ask(zero, 1);
    expect(r).toMatchObject({ ok: false, failed: true, http_status: 402 });
    expect((r as { charge_usd?: number | null }).charge_usd).toBe(0);
    expect(zero.budget.spentUsd()).toBe(0);
    expect(zero.rec.rows[0].committedUsd).toBe(0);
  });
  it("a known charge ABOVE the estimate is never clipped (the job counts what TREG billed)", async () => {
    const w = world({ budgetUsd: 0.3, call: async () => tregResult(people(1), 0.07) });
    const ok = await ask(w, 1);
    expect(ok.ok).toBe(true);
    expect((ok as { charge_usd?: number | null }).charge_usd).toBe(0.07);
    expect(w.budget.spentUsd()).toBeCloseTo(0.07, 6);
  });
});

describe("the daily ledger and the owner's grant take the SAME amount as the header (D1, D5)", () => {
  it("round 1's replay, inverted: a routed provider that would bill 0.90 with 0.75 of job, grant and stage money and 0.80 daily is refused by the header: no spend, no overrun, the grant stays open", async () => {
    const sg = createMemorySpendGate();
    grantOf(sg, { ceilingUsd: 0.75, perOpMaxUsd: 0.75, perMissionMaxUsd: 0.75 });
    const w = world({ budgetUsd: 0.75, dailyCapUsd: 0.8, spendGate: { gate: sg.gate, mode: "enforce" }, call: provider(0.9) });
    const r = await w.gateway.tregCall({ endpoint_id: "treg.people.search", params: { query: "ceo" } });
    expect(w.call).toHaveBeenCalledTimes(1);
    const sent = w.call.mock.calls[0][0] as TregCallOptions;
    expect(Number(sent.routeMaxCostUsd)).toBeLessThanOrEqual(0.75);
    expect(r).toMatchObject({ ok: false, failed: true, http_status: 402 });
    expect(w.budget.spentUsd()).toBe(0);
    expect(sg.owner.grant("g1")).toMatchObject({ spentUsd: 0, overrunUsd: 0, state: "open" });
  });
  it("a daily cap with room for only part of the money: the header is the amount the daily ledger accepted, never more", async () => {
    const w = world({ budgetUsd: 0.5, dailyCapUsd: 0.05, call: provider(0.0198) });
    expect((await ask(w, 1)).ok).toBe(true);
    const sent = Number((w.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd);
    expect(sent).toBeLessThanOrEqual(0.05);
    expect(sent).toBeGreaterThanOrEqual(0.0198);
    expect(w.rec.rows[0].reservedUsd).toBe(sent);
  });
  it("a grant whose per-operation limit is smaller than the money left: the header is what the grant reserved (the reservation equals the header sent)", async () => {
    const sg = createMemorySpendGate();
    grantOf(sg, { perOpMaxUsd: 0.05 });
    const reserves: number[] = [];
    const gate = { ...sg.gate, reserve: async (req: Parameters<typeof sg.gate.reserve>[0]) => { const r = await sg.gate.reserve(req); if (r.ok) reserves.push(req.boundUsd); return r; } };
    const w = world({ budgetUsd: 0.5, spendGate: { gate, mode: "enforce" }, call: provider(0.0198) });
    expect((await ask(w, 1)).ok).toBe(true);
    const sent = Number((w.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd);
    expect(reserves).toEqual([sent]);
    expect(sent).toBeLessThanOrEqual(0.05);
  });
  it("an unavailable gate is never retried with a smaller amount: nothing is sent and the money is given back", async () => {
    const reserve = vi.fn(async () => { throw new Error("database unreachable"); });
    const w = world({ budgetUsd: 0.5, spendGate: { gate: { reserve, settle: async () => ({ ok: true, state: "settled", countedUsd: 0, overrunUsd: 0, replay: false }), stop: async () => undefined } as never, mode: "enforce" }, call: provider(0.0198) });
    const r = await ask(w, 1);
    expect(r).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(w.call).not.toHaveBeenCalled();
    expect(w.budget.spentUsd()).toBe(0);
    expect(w.rec.rows[0].committedUsd).toBe(0);
  });
});

describe("planning: the kept share of the stages that are not sampled yet is never spent (a planning call is limited by the remaining planning money)", () => {
  it("(c) a planning sample sends the planning money left after the kept share, not the estimate", async () => {
    const w = world({ phase: "planning", budgetUsd: 0.2, stageBudget: { stages: 2, budgetUsd: 0.2, reservesUsd: [0.06, 0.06] }, call: provider(0.0198) });
    expect((await ask(w, 1)).ok).toBe(true);
    expect(Number((w.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd)).toBe(0.14);
  });
});

describe("a capped stage: the gateway reports THIS call's own charge, the stage books it without clipping (D3)", () => {
  const plan = { stages: [{ key: "people", engine: { endpoint_id: FIND, alternatives: [] }, max_usd: 0.1 }] } as never;
  const scope = stageScopeOf(plan);
  const call = { stageKey: "people", endpoint_id: FIND, params: findParams(1) };
  const make = (results: Array<Record<string, unknown>>) => {
    const sent: unknown[] = [];
    const gateway = { tregCall: vi.fn(async (input: unknown) => { sent.push(input); return results.shift() as never; }) };
    const budget = createJobCallBudget({ ceilingUsd: 5, spentUsd: 0 });
    const sources = createSourceGateway({ gateway: gateway as never, scope, budget, maxCallUsd: () => 0.0198 });
    return { sources, sent, gateway };
  };
  it("the stage reserves ALL its money for the call and the gateway is told so (spend_limit_usd); a known charge is booked as it is", async () => {
    const m = make([{ ok: true, call_id: "c1", http_status: 200, rows_in_page: 1, has_more: false, next_cursor: null, charge_usd: 0.0594, reserved_usd: 0.1 }]);
    await m.sources.call(call);
    expect((m.sent[0] as { spend_limit_usd: number }).spend_limit_usd).toBe(0.1);
    expect(m.sources.stageCapUsedUsd("people")).toBeCloseTo(0.0594, 6);
  });
  it("a documented zero-charge 402 leaves the stage's spend unchanged, so a following 0.005 source can run (T3's contradiction fixed)", async () => {
    const m = make([{ ok: false, call_id: "c1", failed: true, http_status: 402, message: "x", charge_usd: 0, reserved_usd: 0.1 }, { ok: true, call_id: "c2", http_status: 200, rows_in_page: 1, has_more: false, next_cursor: null, charge_usd: 0.005, reserved_usd: 0.1 }]);
    await m.sources.call(call);
    expect(m.sources.stageCapUsedUsd("people")).toBe(0);
    const second = await m.sources.call(call);
    expect(second.ok).toBe(true);
  });
  it("a charge that is NOT known keeps the amount reserved for the call (a timeout is not a zero), and the stage then has no money for the next call", async () => {
    const m = make([{ ok: false, call_id: "c1", failed: true, http_status: 0, message: "timeout", charge_usd: null, reserved_usd: 0.1 }]);
    await m.sources.call(call);
    expect(m.sources.stageCapUsedUsd("people")).toBeCloseTo(0.1, 6);
    expect(await m.sources.call(call)).toMatchObject({ ok: false, refused: "stage_cap" });
    expect(m.gateway.tregCall).toHaveBeenCalledTimes(1);
  });
  it("an overrun is never clipped to the bound: the real charge is booked (the old code booked min(delta, bound))", async () => {
    const m = make([{ ok: true, call_id: "c1", http_status: 200, rows_in_page: 1, has_more: false, next_cursor: null, charge_usd: 0.14, reserved_usd: 0.1 }]);
    await m.sources.call(call);
    expect(m.sources.stageCapUsedUsd("people")).toBeCloseTo(0.14, 6);
  });
  it("a call that would not fit the stage by its estimate is refused before any request (the admission rule is unchanged)", async () => {
    const sent: unknown[] = [];
    const sources = createSourceGateway({ gateway: { tregCall: vi.fn(async (i: unknown) => { sent.push(i); return {} as never; }) } as never, scope, budget: createJobCallBudget({ ceilingUsd: 5, spentUsd: 0 }), maxCallUsd: () => 0.2 });
    expect(await sources.call(call)).toMatchObject({ ok: false, refused: "stage_cap" });
    expect(sent).toHaveLength(0);
  });
});

describe("the real client: a budget-held header (stageCall, exploration, admin), headerFromBudget", () => {
  it("holds the money in one step and sends it as the header; two calls on one budget cannot both hold it", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 0.1, spentUsd: 0 });
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", async (_u: string, init: { headers: Record<string, string> }) => { calls.push(init.headers); await new Promise((r) => setTimeout(r, 30)); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "x-treg-cost-micro": "19800" } }); });
    process.env.TREG_TOKEN = "t";
    const opts = { endpointId: "aviato.companies.employees", params: { website: "acme.example", perPage: 1, page: 0 }, userId: "u", jobId: "j", callBudget: budget, callEstimateUsd: 0.0198, headerFromBudget: true, token: "k" } as TregCallOptions;
    const [a, b] = await Promise.all([executeTregCall(opts), executeTregCall({ ...opts, stepId: "s2" })]);
    expect([a.budgetStopped === true, b.budgetStopped === true].sort()).toEqual([false, true]);
    expect(calls).toHaveLength(1);
    expect(calls[0]["X-Treg-Route-Max-Cost"]).toBe("0.1");
    expect(budget.spentUsd()).toBeCloseTo(0.0198, 6);
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
  });
});
