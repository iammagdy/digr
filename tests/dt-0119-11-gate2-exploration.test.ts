import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { EXPLORATION_READ_PAGE, EXPLORATION_TABLE, readExplorationSpend, resetExplorationMemoryForTesting, runSampleCall } from "../src/lib/modelPlanner/exploration";
import { EXPLORATION_DAY_CAP_USD } from "../src/lib/modelPlanner/constants";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { tregResult } from "./helpers/agentHarness";

/**
 * DT-20261119-11 Gate 2, F1 (P0-1): with a shared client the exploration cap never fails open. No call goes out until the COMPLETE shared sum has been read after this call's reservation row; a failed or incomplete read is "unavailable". No network.
 */
const catalog = loadTregCatalog();
const xParams = [{ name: "website", value: "acme.example", source: "customer_text" as const, quote: "acme.example" }];
const ctx = () => ({ customerText: "اعرض موظفي acme.example", access: { isAdmin: false, verifiedBusiness: false }, catalog, samples: new Map(), stats: { madeCalls: 0 } });
beforeEach(() => { process.env.TREG_TOKEN = "t"; resetExplorationMemoryForTesting(); vi.spyOn(console, "warn").mockImplementation(() => undefined); vi.spyOn(console, "info").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

const today = () => new Date().toISOString().slice(0, 10);
const seedDay = (db: ReturnType<typeof createMemoryDb>, usd: number, n = 1) => db.seed(EXPLORATION_TABLE, Array.from({ length: n }, (_, i) => ({ id: `seed_${String(i).padStart(6, "0")}`, request_id: `other_${i}`, cost_usd: usd / n, created_at: `${today()}T00:00:01.000Z` })));
const total = (db: ReturnType<typeof createMemoryDb>) => db.rows(EXPLORATION_TABLE).reduce((n: number, r: any) => n + Number(r.cost_usd || 0), 0);
const answer = (cost = 0.004) => vi.fn(async (_o: TregCallOptions): Promise<TregCallResult> => tregResult({ employees: [{ name: "A", linkedinUrl: "https://www.linkedin.com/in/a" }] }, cost));
/** A client whose SELECT of the exploration table can be switched to fail (the insert and the update keep working). */
function flaky(db: ReturnType<typeof createMemoryDb>) {
  const state = { failRead: false, failUpdate: false };
  const client: any = {
    storage: db.storage,
    from: (name: string) => {
      const b = db.from(name);
      if (name !== EXPLORATION_TABLE) return b;
      return new Proxy(b, { get(target, prop) {
        if (prop === "select" && state.failRead) return () => { const e: any = { gte: () => e, lt: () => e, order: () => e, range: () => e, then: (res: any) => Promise.resolve({ data: null, error: { message: "read failed" } }).then(res) }; return e; };
        if (prop === "update" && state.failUpdate) return () => { const e: any = { eq: () => e, then: (res: any) => Promise.resolve({ data: null, error: { message: "update failed" } }).then(res) }; return e; };
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      } });
    },
  };
  return { client, state };
}

describe("F1: a shared client fails CLOSED", () => {
  it("shared $0.495 of the $0.50 day cap + the shared read FAILS → NO call is made and the total stays ≤ $0.50", async () => {
    const db = createMemoryDb();
    seedDay(db, 0.495);
    const f = flaky(db);
    f.state.failRead = true;
    const call = answer();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: f.client, requestId: "r1", userId: "u", call });
    expect(call).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(total(db)).toBeLessThanOrEqual(EXPLORATION_DAY_CAP_USD + 1e-9);
  });
  it("the same DB recovers → the next sample goes out (healthy shared DB samples as before)", async () => {
    const db = createMemoryDb();
    seedDay(db, 0.2);
    const f = flaky(db);
    f.state.failRead = true;
    const call = answer();
    await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: f.client, requestId: "r2", userId: "u", call });
    expect(call).not.toHaveBeenCalled();
    f.state.failRead = false;
    resetExplorationMemoryForTesting();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: f.client, requestId: "r2b", userId: "u", call });
    expect(r.ok).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("a denial zeroes the pending row (the update is checked); an UNCONFIRMED cleanup keeps the row at its reserved amount", async () => {
    const db = createMemoryDb();
    const f = flaky(db);
    f.state.failRead = true;
    const call = answer();
    await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: f.client, requestId: "r3", userId: "u", call });
    expect(db.rows(EXPLORATION_TABLE).filter((r: any) => /^reserved:/.test(String(r.refused_reason ?? "")) && Number(r.cost_usd) > 0)).toHaveLength(0);
    resetExplorationMemoryForTesting();
    const db2 = createMemoryDb();
    const g = flaky(db2);
    g.state.failRead = true; g.state.failUpdate = true;
    await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: g.client, requestId: "r4", userId: "u", call });
    expect(call).not.toHaveBeenCalled();
    const kept = db2.rows(EXPLORATION_TABLE).filter((r: any) => /^reserved:/.test(String(r.refused_reason ?? "")));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((r: any) => Number(r.cost_usd) > 0)).toBe(true);
  });
  it("the shared sum is COMPLETE across pages: 2,500 rows are all read (a database that caps one answer at 1,000 rows cannot hide spend)", async () => {
    const db = createMemoryDb();
    seedDay(db, 0.4, 2500);
    const spent = await readExplorationSpend({ client: db, requestId: "none", userId: "u" });
    expect(spent.source).toBe("database");
    expect(spent.day).toBeCloseTo(0.4, 6);
    expect(EXPLORATION_READ_PAGE).toBe(1000);
  });
  it("a client that cannot page and answers a FULL page is not a complete sum (unavailable → memory), never a silent truncation", async () => {
    const rows = Array.from({ length: EXPLORATION_READ_PAGE }, (_, i) => ({ id: `x${i}`, request_id: "q", cost_usd: 0.0001, created_at: `${today()}T00:00:01.000Z` }));
    const client: any = { from: () => ({ select: () => ({ gte: () => ({ lt: async () => ({ data: rows, error: null }) }) }) }) };
    const spent = await readExplorationSpend({ client, requestId: "q", userId: "u" });
    expect(spent.source).toBe("memory");
  });
  it("with 2,500 shared rows summing to $0.499 a sample is denied by the cap read over ALL pages (nothing sent)", async () => {
    const db = createMemoryDb();
    seedDay(db, 0.499, 2500);
    const call = answer();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: db, requestId: "r5", userId: "u", call });
    expect(call).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(total(db)).toBeLessThanOrEqual(EXPLORATION_DAY_CAP_USD + 1e-9);
  });
  it("counter-case: no client (memory mode) is unchanged and a healthy shared DB still samples", async () => {
    const call = answer();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: null, requestId: "r6", userId: "u", call });
    expect(r.ok).toBe(true);
    const db = createMemoryDb();
    const r2 = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: db, requestId: "r7", userId: "u", call });
    expect(r2.ok).toBe(true);
  });
  it("F3 in exploration: a 500 that reports $0.004 is booked $0.004 in the shared ledger; a free 402 is zero", async () => {
    const db = createMemoryDb();
    const failed = async (): Promise<TregCallResult> => ({ ok: false, httpStatus: 500, tregCallId: "", costMicro: 4000, latencyMs: 1, data: null, error: "http_500", isRouteMaxCost: false, isPlatformBalanceLow: false });
    await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: db, requestId: "r8", userId: "u", call: vi.fn(failed) });
    expect(total(db)).toBeGreaterThanOrEqual(0.004 - 1e-9);
    const db2 = createMemoryDb();
    const free = async (): Promise<TregCallResult> => ({ ok: false, httpStatus: 402, tregCallId: "", costMicro: 0, costUnreported: true, latencyMs: 1, data: null, error: "route_max_cost", isRouteMaxCost: true, isPlatformBalanceLow: false });
    await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: db2, requestId: "r9", userId: "u", call: vi.fn(free) });
    expect(total(db2)).toBe(0);
  });
});
