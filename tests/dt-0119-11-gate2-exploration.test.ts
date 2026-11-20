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

/**
 * DT-20261119-11 Gate 2 round 2, F1 narrow fix (فزاع P0): truncated successful reads, the UTC rollover, the exact pending row in the checked sum, and a settled row's immutable accounting day. Offline, fake database and provider, no spend.
 */
/** A database that HONORS ranges but never answers more than `serverMax` rows (a configured server row limit); `hideCount` also hides the exact count. `hide` removes rows from every read (a read that misses a row). */
function capped(db: ReturnType<typeof createMemoryDb>, serverMax: number, o: { hideCount?: boolean; hide?: (r: any) => boolean; onInsert?: () => void } = {}) {
  const reads: number[] = [];
  const client: any = {
    storage: db.storage,
    from: (name: string) => {
      if (name !== EXPLORATION_TABLE) return db.from(name);
      const inner: any = db.from(name);
      let headCount = false; let from = 0; let to: number | null = null; let sorted = false;
      const filtersGte: any[] = []; const filtersLt: any[] = [];
      const b: any = {
        select: (_c?: string, opts?: any) => { headCount = Boolean(opts?.head); inner.select(_c, opts); return b; },
        gte: (c: string, v: any) => { filtersGte.push([c, v]); inner.gte(c, v); return b; },
        lt: (c: string, v: any) => { filtersLt.push([c, v]); inner.lt(c, v); return b; },
        order: (c: string) => { sorted = true; inner.order(c); return b; },
        range: (f: number, t: number) => { from = f; to = t; return b; },
        eq: (c: string, v: any) => { inner.eq(c, v); return b; },
        update: (p: any) => { inner.update(p); return b; },
        insert: async (row: any) => { const r = await inner.insert(row); o.onInsert?.(); return r; },
        then: (res: any, rej: any) => {
          const task = (async () => {
            if (headCount) { const all = db.rows(EXPLORATION_TABLE).filter((r: any) => filtersGte.every(([c, v]) => r[c] >= v) && filtersLt.every(([c, v]) => r[c] < v) && !(o.hide?.(r))); return o.hideCount ? { data: null, error: null } : { data: null, count: all.length, error: null }; }
            const out = await inner;
            if (out.error || !Array.isArray(out.data)) return out;
            let data = out.data.filter((r: any) => !(o.hide?.(r)));
            if (sorted) data = [...data].sort((x: any, y: any) => (String(x.id) > String(y.id) ? 1 : -1));
            const want = to === null ? data.length : to - from + 1;
            reads.push(from);
            return { data: data.slice(from, from + Math.min(want, serverMax)), error: null };
          })();
          return task.then(res, rej);
        },
      };
      return b;
    },
  };
  return { client, reads };
}
/** 500 zero-cost rows that sort BEFORE one $0.495 row (ids order the rows). */
const seedTruncated = (db: ReturnType<typeof createMemoryDb>, big = 0.495) => {
  db.seed(EXPLORATION_TABLE, Array.from({ length: 500 }, (_, i) => ({ id: `a_${String(i).padStart(4, "0")}`, request_id: `z${i}`, cost_usd: 0, created_at: `${today()}T00:00:01.000Z` })));
  db.seed(EXPLORATION_TABLE, [{ id: "b_big", request_id: "big", cost_usd: big, created_at: `${today()}T00:00:02.000Z` }]);
};
const exactCap = () => vi.fn(async (o: TregCallOptions): Promise<TregCallResult> => tregResult({ employees: [{ name: "A", linkedinUrl: "https://www.linkedin.com/in/a" }] }, (o as any).routeMaxCostUsd ?? 0.025));

describe("F1 round 2: a truncated successful read is not a complete sum", () => {
  it("the server answers 500 rows per page, 500 zero rows come before a $0.495 row (exact count available): the day is read to the end, so a call that bills its wire cap never passes the $0.50 day cap", async () => {
    const db = createMemoryDb(); seedTruncated(db);
    const { client, reads } = capped(db, 500);
    const call = exactCap();
    await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client, requestId: "t1", userId: "u", call });
    expect(reads).toContain(500); // the second page started after the 500 rows ACTUALLY received
    for (const c of call.mock.calls) expect((c[0] as any).routeMaxCostUsd).toBeLessThanOrEqual(0.005 + 1e-9); // the header is the money really left ($0.005), never a $0.025 read from a truncated sum
    expect(total(db)).toBeLessThanOrEqual(EXPLORATION_DAY_CAP_USD + 1e-9);
  });
  it("the same truncation with the day at $0.4985 (less than one call is left) → NO dispatch, ledger stays $0.4985", async () => {
    const db = createMemoryDb(); seedTruncated(db, 0.4985);
    const { client } = capped(db, 500);
    const call = exactCap();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client, requestId: "t1a", userId: "u", call });
    expect(call).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(total(db)).toBeCloseTo(0.4985, 6);
  });
  it("the same truncation with NO exact count: completion needs a verified EMPTY terminal page, and the sum is the true $0.495", async () => {
    const db = createMemoryDb(); seedTruncated(db);
    const { client } = capped(db, 500, { hideCount: true });
    const spent = await readExplorationSpend({ client, requestId: "none", userId: "u" });
    expect(spent.source).toBe("database");
    expect(spent.day).toBeCloseTo(0.495, 6);
    const db2 = createMemoryDb(); seedTruncated(db2, 0.4985);
    const call = exactCap();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: capped(db2, 500, { hideCount: true }).client, requestId: "t1b", userId: "u", call });
    expect(call).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(total(db2)).toBeCloseTo(0.4985, 6);
  });
  it("an answer whose rows never reach the exact count is not complete (unavailable → memory), never a silent truncation", async () => {
    const db = createMemoryDb(); seedTruncated(db);
    // the count says 501 rows but the page after the first 500 comes back empty: the sum cannot be proven
    const { client } = capped(db, 500, { hide: (r: any) => r.id === "b_big" });
    const real = client.from;
    client.from = (n: string) => { const b = real(n); const sel = b.select; b.select = (c: string, opts: any) => { const x = sel(c, opts); if (opts?.head) return { gte: () => ({ lt: async () => ({ data: null, count: 501, error: null }) }) }; return x; }; return b; };
    const spent = await readExplorationSpend({ client, requestId: "none", userId: "u" });
    expect(spent.source).toBe("memory");
  });
  it("counter-case: a healthy shared pool with 2 pages of 500 under the cap dispatches", async () => {
    const db = createMemoryDb();
    db.seed(EXPLORATION_TABLE, Array.from({ length: 700 }, (_, i) => ({ id: `h_${String(i).padStart(4, "0")}`, request_id: `h${i}`, cost_usd: 0.0001, created_at: `${today()}T00:00:01.000Z` })));
    const { client } = capped(db, 500);
    const call = answer();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client, requestId: "t2", userId: "u", call });
    expect(r.ok).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("F1 round 2: the exact pending row is inside the checked sum", () => {
  it("a read that does NOT contain this call's own pending row → no dispatch (the pending row is zeroed)", async () => {
    const db = createMemoryDb();
    const { client } = capped(db, 1000, { hide: (r: any) => /^reserved:/.test(String(r.refused_reason ?? "")) });
    const call = answer();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client, requestId: "t3", userId: "u", call });
    expect(call).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(db.rows(EXPLORATION_TABLE).filter((x: any) => /^reserved:/.test(String(x.refused_reason ?? "")) && Number(x.cost_usd) > 0)).toHaveLength(0);
  });
  it("counter-case: a read that contains the own pending row dispatches, and the row is the one settled", async () => {
    const db = createMemoryDb();
    const { client } = capped(db, 1000);
    const call = answer();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client, requestId: "t3b", userId: "u", call });
    expect(r.ok).toBe(true);
    expect(db.rows(EXPLORATION_TABLE).filter((x: any) => x.request_id === "t3b")).toHaveLength(1);
  });
});

describe("F1 round 2: the UTC day", () => {
  const DAY1 = "2026-11-18"; const DAY2 = "2026-11-19";
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(`${DAY1}T23:59:59.000Z`)); });
  afterEach(() => { vi.useRealTimers(); });
  it("the insert starts before midnight and returns after it, the new day already holds $0.4985 → the call is denied, nothing is sent, the new day stays $0.4985", async () => {
    const db = createMemoryDb();
    db.seed(EXPLORATION_TABLE, [{ id: "n1", request_id: "other", cost_usd: 0.4985, created_at: `${DAY2}T00:00:01.000Z` }]);
    const { client } = capped(db, 1000, { onInsert: () => vi.setSystemTime(new Date(`${DAY2}T00:00:02.000Z`)) });
    const call = exactCap();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client, requestId: "t4", userId: "u", call });
    expect(call).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    const day2 = db.rows(EXPLORATION_TABLE).filter((x: any) => String(x.created_at).startsWith(DAY2)).reduce((n: number, x: any) => n + Number(x.cost_usd || 0), 0);
    expect(day2).toBeCloseTo(0.4985, 6);
  });
  it("a settled row's accounting day never changes: the call returns after midnight and the row keeps its original created_at", async () => {
    const db = createMemoryDb();
    const { client } = capped(db, 1000);
    const call = vi.fn(async (_o: TregCallOptions): Promise<TregCallResult> => { vi.setSystemTime(new Date(`${DAY2}T00:00:05.000Z`)); return tregResult({ employees: [{ name: "A", linkedinUrl: "https://www.linkedin.com/in/a" }] }, 0.004); });
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client, requestId: "t5", userId: "u", call });
    expect(r.ok).toBe(true);
    const mine = db.rows(EXPLORATION_TABLE).filter((x: any) => x.request_id === "t5");
    expect(mine).toHaveLength(1);
    expect(String(mine[0].created_at).startsWith(DAY1)).toBe(true);
    expect(Number(mine[0].cost_usd)).toBeCloseTo(0.004, 6);
  });
  it("counter-case: no rollover, same day → dispatches", async () => {
    const db = createMemoryDb();
    const { client } = capped(db, 1000);
    const call = answer();
    const r = await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client, requestId: "t6", userId: "u", call });
    expect(r.ok).toBe(true);
  });
});
