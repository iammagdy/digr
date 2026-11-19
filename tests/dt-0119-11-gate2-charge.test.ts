import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../agent/src/gateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { createMemorySpendGate } from "../src/lib/server/spendGate/gate";
import { classifyTregCharge } from "../src/lib/server/tregCharge";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { executeTregCall, type TregCallOptions, type TregCallResult } from "../src/functions/shared/tregClient";
import { fakeRecorder, NOT_ADMIN, USER_ID, tregResult } from "./helpers/agentHarness";
import { callOptions, makePoolWorld, teardownPoolWorld } from "./helpers/tregPoolKit";
import { captureConsole } from "./helpers/providerKeyTestKit";

/**
 * DT-20261119-11 Gate 2, F3 (P0-3): ONE shared charge classifier. A charge the answer reported wins on a 4xx/5xx; a documented free refusal is zero; an uncertain charge keeps the reservation; a key hop never drops an earlier charge. Checked on the job,
 * the daily and the owner's-grant ledgers. No network.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const MISSION = "msn_dt11g2";
const catalog = loadTregCatalog();
const FIND = "findymail.search.employees";
const T0 = Date.now();
const CLIENT = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };
const failed = (status: number, extra: Partial<TregCallResult> = {}): TregCallResult => ({ ok: false, httpStatus: status, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, error: `http_${status}`, isRouteMaxCost: false, isPlatformBalanceLow: false, ...extra });

function world(o: { budgetUsd: number; dailyCapUsd?: number; grant?: number; call: (x: TregCallOptions) => Promise<TregCallResult> }) {
  const store = createMemoryStore();
  store.missions.set(MISSION, newMission({ id: MISSION, user_id: USER_ID, request_text: "x", status: "executing", job_id: "job_g2" }));
  const rec = fakeRecorder({ dailyCapUsd: o.dailyCapUsd ?? 100 });
  const sg = createMemorySpendGate();
  if (o.grant !== undefined) sg.owner.issueGrant({ id: "g1", ceilingUsd: o.grant, perOpMaxUsd: o.grant, perMissionMaxUsd: o.grant, kinds: ["provider", "model"], opensAt: T0 - 60_000, closesAt: T0 + 3_600_000 } as never);
  const call = vi.fn(o.call);
  const budget = createJobCallBudget({ ceilingUsd: o.budgetUsd, spentUsd: 0 });
  const gateway = createGateway({
    store, client: CLIENT, missionId: MISSION, userId: USER_ID, jobId: "job_g2", phase: "execution", access: NOT_ADMIN, catalog, budget, recorder: rec.recorder, commit: rec.commit, call, defaultPurpose: "t", counter: { seq: 0 },
    ...(o.grant !== undefined ? { spendGate: { gate: sg.gate, mode: "enforce" as const } } : {}),
  });
  return { rec, call, budget, gateway, sg };
}
const ask = (w: ReturnType<typeof world>) => w.gateway.tregCall({ endpoint_id: FIND, params: { website: "acme.example", job_titles: ["CEO"], count: 1 } });
const facts = (r: unknown) => r as { charge_usd?: number | null; reserved_usd?: number };

describe("F3: the classifier (one reading for gateway, client, exploration and admin)", () => {
  it("a reported charge wins on a failure; a free refusal with no report is zero; uncertain is unknown", () => {
    expect(classifyTregCharge(failed(500, { costMicro: 40_000 }))).toEqual({ known: true, usd: 0.04 });
    expect(classifyTregCharge(failed(500, { costMicro: 0, chargedMicroReported: 40_000 }))).toEqual({ known: true, usd: 0.04 }); // the larger figure counts
    expect(classifyTregCharge(failed(402, { costUnreported: true, isRouteMaxCost: true }))).toEqual({ known: true, usd: 0 });
    expect(classifyTregCharge(failed(402, { costUnreported: true }))).toEqual({ known: true, usd: 0 });
    expect(classifyTregCharge(failed(402, { costMicro: 3_000, isRouteMaxCost: true }))).toEqual({ known: true, usd: 0.003 }); // a conflicting report is not hidden
    expect(classifyTregCharge(failed(500, { costUnreported: true }))).toEqual({ known: false });
    expect(classifyTregCharge(failed(0, { timedOut: true }))).toEqual({ known: false });
    expect(classifyTregCharge(failed(503, { error: "network_failure" }))).toEqual({ known: false });
    expect(classifyTregCharge({ ...tregResult([], 0), costUnreported: true })).toEqual({ known: false });
    expect(classifyTregCharge({ ...tregResult([], 0.02), costIsEstimate: true })).toEqual({ known: false });
    expect(classifyTregCharge(tregResult([], 0.02))).toEqual({ known: true, usd: 0.02 });
    expect(classifyTregCharge(null)).toEqual({ known: false });
  });
});

describe("F3: the gateway books a charged failure on the job, the daily and the owner's ledgers", () => {
  it("a 500 that reports $0.04 books $0.04 everywhere; two such calls book $0.08", async () => {
    const w = world({ budgetUsd: 0.5, grant: 1, call: async () => failed(500, { costMicro: 40_000 }) });
    const r1 = await ask(w);
    expect(r1).toMatchObject({ ok: false, failed: true, http_status: 500 });
    expect(facts(r1).charge_usd).toBe(0.04);
    expect(w.budget.spentUsd()).toBeCloseTo(0.04, 6);
    expect(w.rec.rows[0].committedUsd).toBeCloseTo(0.04, 6);
    expect(w.sg.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0.04 });
    await ask(w);
    expect(w.budget.spentUsd()).toBeCloseTo(0.08, 6);
    expect(w.rec.rows.map((x) => x.committedUsd)).toEqual([0.04, 0.04]);
    expect(w.sg.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0.08 });
  });
  it("the replay of Gate 2: $0.06 of job money, two calls that each report $0.04 on a 500 are booked as $0.08, never zero", async () => {
    const w = world({ budgetUsd: 0.06, dailyCapUsd: 0.06, call: async () => failed(500, { costMicro: 40_000 }) });
    await ask(w); await ask(w);
    expect(w.budget.spentUsd()).toBeGreaterThanOrEqual(0.04);
    expect(w.rec.rows.reduce((n, x) => n + (x.committedUsd ?? 0), 0)).toBeGreaterThanOrEqual(0.04);
  });
  it("a free 402 (price cap) books ZERO on every ledger and releases the hold", async () => {
    const w = world({ budgetUsd: 0.3, grant: 1, call: async () => failed(402, { costUnreported: true, isRouteMaxCost: true, error: "route_max_cost" }) });
    const r = await ask(w);
    expect(facts(r).charge_usd).toBe(0);
    expect(w.budget.spentUsd()).toBe(0);
    expect(w.rec.rows[0].committedUsd).toBe(0);
    expect(w.sg.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0 });
    expect(w.budget.leftUsd()).toBe(0.3); // nothing stays held
  });
  it("a timeout keeps the reservation (at most H) on every ledger", async () => {
    const w = world({ budgetUsd: 0.3, grant: 1, call: async () => failed(0, { timedOut: true, error: "timeout" }) });
    const r = await ask(w);
    expect(facts(r).charge_usd).toBeNull();
    const held = facts(r).reserved_usd!;
    expect(held).toBeLessThanOrEqual(0.3);
    expect(w.budget.spentUsd()).toBe(held);
    expect(w.rec.rows[0].committedUsd).toBe(held);
    expect(w.sg.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: held });
  });
  it("a 5xx whose answer carries no charge is uncertain: the hold stays (≤ H); a 422 with no charge is a known zero", async () => {
    const a = world({ budgetUsd: 0.3, call: async () => failed(500, { costUnreported: true }) });
    const ra = await ask(a);
    expect(facts(ra).charge_usd).toBeNull();
    expect(a.budget.spentUsd()).toBe(facts(ra).reserved_usd);
    const b = world({ budgetUsd: 0.3, call: async () => failed(422, { costUnreported: true }) });
    expect(facts(await ask(b)).charge_usd).toBe(0);
    expect(b.budget.spentUsd()).toBe(0);
  });
  it("counter-case: an ordinary success books exactly its charge", async () => {
    const w = world({ budgetUsd: 0.3, grant: 1, call: async () => tregResult([{ name: "A" }], 0.0198) });
    expect((await ask(w)).ok).toBe(true);
    expect(w.budget.spentUsd()).toBeCloseTo(0.0198, 6);
    expect(w.rec.rows[0].committedUsd).toBeCloseTo(0.0198, 6);
    expect(w.sg.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0.0198 });
  });
});

describe("F3: a key hop never drops an earlier charge", () => {
  let logs: ReturnType<typeof captureConsole>;
  afterEach(() => { logs?.restore(); teardownPoolWorld(); });
  it("a 402 that REPORTS a charge is not retried on the next key (the call ends there and the charge is the call's)", async () => {
    logs = captureConsole();
    const w = makePoolWorld({ source: "website" });
    const main = w.addKey({ isMain: true });
    const a = w.addKey({ tregMode: "charged402", balanceMicro: 0 });
    w.addKey({ tregMode: "ok" });
    w.switchOn(a.id ?? main.id);
    const r = await executeTregCall(callOptions());
    expect(r.httpStatus).toBe(402);
    expect(r.costMicro).toBe(4000);
    expect(w.treg.callCount()).toBe(1);
  });
  it("a verified-zero refusal still hops (a free 402 and a 401 are retried on the next key)", async () => {
    logs = captureConsole();
    const w = makePoolWorld({ source: "website" });
    const main = w.addKey({ isMain: true });
    const a = w.addKey({ tregMode: "revoked" });
    w.addKey({ tregMode: "ok" });
    w.switchOn(a.id ?? main.id);
    const r = await executeTregCall(callOptions());
    expect(r.ok).toBe(true);
  });
});
