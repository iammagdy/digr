import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** DT-20261118-06 phase 1A: the overview's mission numbers come from the `missions` table only (customer requests are inserted there: customerActions.ts createCustomerMission). Fakes only. */
const state = vi.hoisted(() => ({ admin: true, tables: [] as string[], windowRows: [] as any[], liveRows: [] as any[], fail: false, filters: [] as string[],
  // ADDED (DT-20261118-06 Gate 1 P1-2): one record per query, the previous-period head counts and the paged window read
  queries: [] as Array<{ cols: string; head: boolean; filters: string[]; ranges: Array<[number, number]> }>, prevEnded: 0 as number, prevSucceeded: 0 as number }));

vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin ? { ok: true, ctx: { adminId: "adm-1", audit: vi.fn() } } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(),
  createAdminClient: () => ({
    from: (table: string) => {
      state.tables.push(table);
      let live = false;
      const q = { cols: "", head: false, filters: [] as string[], ranges: [] as Array<[number, number]> };
      state.queries.push(q);
      const chain: any = {
        select: (cols: string, o?: { head?: boolean }) => { q.cols = cols; q.head = Boolean(o?.head); return chain; },
        gte: (col: string, v: string | number) => { state.filters.push(`gte:${col}:${String(v).slice(0, 10)}`); q.filters.push(`gte:${col}:${String(v).slice(0, 10)}`); return chain; },
        lt: (col: string, v: string) => { q.filters.push(`lt:${col}:${v.slice(0, 10)}`); return chain; },
        eq: (col: string, v: string) => { q.filters.push(`eq:${col}:${v}`); return chain; },
        is: (col: string, v: unknown) => { q.filters.push(`is:${col}:${String(v)}`); return chain; },
        in: (col: string, v: string[]) => { live = true; state.filters.push(`in:${col}:${v.join("|")}`); q.filters.push(`in:${col}:${v.join("|")}`); return chain; },
        order: () => chain,
        limit: async () => (state.fail ? { data: null, error: { message: "boom" } } : { data: live ? state.liveRows : state.windowRows, error: null }),
        range: async (from: number, to: number) => { q.ranges.push([from, to]); return state.fail ? { data: null, error: { message: "boom" } } : { data: state.windowRows.slice(from, to + 1), error: null }; },
        // a head count is awaited on the builder itself
        then: (resolve: (v: unknown) => void) => resolve(state.fail ? { count: null, error: { message: "boom" } } : { count: q.filters.includes("eq:status:completed") ? state.prevSucceeded : state.prevEnded, error: null }),
      };
      return chain;
    },
  }),
}));

import { GET } from "../src/app/api/admin/overview/route";
import { parseOverviewRange, summarizeMissions } from "../src/lib/server/adminOverview";
import { customerMissionView, requestedRowsOf } from "../src/lib/agentMission/customerView";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
/** A plan of 100 delivered rows whose target (80) is below what was asked (100): the card's «المطلوب» is 80 + (100 - 80) = 100. */
const plan = (rows: number, quantity?: { requested: number; target: number }) => ({ stages: [{ key: "s1", title_ar: "تغريدات", expected_rows: rows, deliver: true }, { key: "s2", title_ar: "بحث", expected_rows: 7, deliver: false }], ...(quantity ? { quantity } : {}) });
const row = (over: Record<string, unknown>) => ({ id: `msn_${Math.random().toString(36).slice(2, 12)}`, status: "completed", delivered_units: null, reserved_points: null, charged_points: null, plan_public: null, lease_until: null, created_at: ago(DAY), updated_at: ago(DAY), addon: null, ...over });

describe("summarizeMissions (pure)", () => {
  it("counts success, failure, delivered of asked, released holds, running and stalled exactly as a hand count of the rows", () => {
    const rows = [
      row({ status: "completed", delivered_units: 80, plan_public: plan(80, { requested: 100, target: 80 }), reserved_points: 500, charged_points: 400 }), // success; asked 100; released 100
      row({ status: "completed", delivered_units: 50, plan_public: plan(50), reserved_points: 300, charged_points: 300 }), // success; asked 50; nothing released
      row({ status: "completed", delivered_units: 0, plan_public: plan(20), reserved_points: 200, charged_points: 0 }), // ended without data; released 200
      row({ status: "failed", delivered_units: null, plan_public: plan(30), reserved_points: 250, charged_points: 0, updated_at: ago(3 * 3600_000) }), // failed in 24 h; released 250
      row({ status: "failed", plan_public: null, updated_at: ago(3 * DAY), created_at: ago(3 * DAY) }), // failed while planning: nothing held, nothing asked
      row({ status: "plan_ready", plan_public: plan(10) }), // waits for the customer: not ended
      row({ status: "cancelled" }),
      row({ status: "completed", delivered_units: 10, plan_public: plan(10), created_at: ago(45 * DAY) }), // previous period (30-day range)
      row({ status: "failed", plan_public: plan(10), created_at: ago(40 * DAY) }), // previous period
    ];
    const liveRows = [
      row({ status: "executing", lease_until: ago(-30_000) }), // live lease: running
      row({ status: "planning", lease_until: ago(-10_000) }), // running
      row({ status: "executing", lease_until: ago(25 * 60_000) }), // lease ran out 25 min ago: stalled
      row({ status: "planning", lease_until: ago(12 * 60_000) }), // stalled 12 min
      row({ status: "executing", lease_until: ago(2 * 60_000) }), // lease just ran out: neither
    ];
    const o = summarizeMissions({ rows, liveRows, range: 30, now: NOW, truncated: false });
    expect(o.missions).toEqual({ total: 7, ended: 5, succeeded: 2, failed: 2, successPct: 40, successPctPrev: 50, delivered: 130, requested: 200, released: 3, releasedPoints: 550 });
    expect(o.live).toEqual({ running: 2, stalled: 2, stalledMinMinutes: 12, failed24h: 1 });
    expect(o.range).toBe(30);
  });

  it("with no ended mission the success rate is null (the card shows its empty sentence, never 0٪)", () => {
    const o = summarizeMissions({ rows: [row({ status: "queued" })], liveRows: [], range: 7, now: NOW, truncated: false });
    expect(o.missions.successPct).toBeNull();
    expect(o.missions.successPctPrev).toBeNull();
    expect(o.live).toEqual({ running: 0, stalled: 0, stalledMinMinutes: null, failed24h: 0 });
  });

  it("«المطلوب» is one definition: requestedRowsOf equals what the customer's card shows for the same plan", () => {
    for (const p of [plan(80, { requested: 100, target: 80 }), plan(50), null]) {
      const view = customerMissionView({ mission: { id: "msn_x", status: "completed", question_ar: null, plan_public: p, reserved_points: 100, unit_price_points: 1, delivered_units: 10, charged_points: 10, summary_ar: null, files: null, created_at: ago(DAY) }, events: [], now: NOW });
      expect(requestedRowsOf(p)).toBe(view.requestedRows);
    }
    expect(requestedRowsOf(plan(80, { requested: 100, target: 80 }))).toBe(100);
  });

  // ADDED (Gate 1 P1-2): the route selects the plan's two fields by JSON path instead of the whole public plan; the count is the same
  it("«المطلوب» from the selected stages/quantity columns equals the one from plan_public; previous-period counts replace the rows for the arrow", () => {
    const p = plan(80, { requested: 100, target: 80 });
    const viaPlan = summarizeMissions({ rows: [row({ delivered_units: 80, plan_public: p })], liveRows: [], range: 30, now: NOW, truncated: false });
    const viaPath = summarizeMissions({ rows: [{ ...row({ delivered_units: 80 }), plan_public: undefined, stages: p.stages, quantity: p.quantity }], liveRows: [], range: 30, now: NOW, truncated: false, previous: { ended: 8, succeeded: 2 } });
    expect(viaPath.missions.requested).toBe(100);
    expect(viaPath.missions.requested).toBe(viaPlan.missions.requested);
    expect(viaPath.missions.successPctPrev).toBe(25);
    expect(summarizeMissions({ rows: [], liveRows: [], range: 7, now: NOW, truncated: false, previous: { ended: 0, succeeded: 0 } }).missions.successPctPrev).toBeNull();
  });

  it.each([["7", 7], ["30", 30], ["90", 90], ["14", 30], [null, 30], ["abc", 30]] as const)("range %s -> %s", (raw, expected) => {
    expect(parseOverviewRange(raw)).toBe(expected);
  });
});

describe("GET /api/admin/overview", () => {
  const get = (q = "?range=7") => GET(new NextRequest(`http://localhost/api/admin/overview${q}`));
  beforeEach(() => { state.admin = true; state.tables = []; state.filters = []; state.fail = false; state.windowRows = []; state.liveRows = []; state.queries = []; state.prevEnded = 0; state.prevSucceeded = 0; vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });

  it("admins only", async () => {
    state.admin = false;
    expect((await get()).status).toBe(403);
    expect(state.tables).toEqual([]);
  });

  it("reads the missions table only (never jobs), twice the range back plus the running statuses, and drops add-on rows", async () => {
    state.windowRows = [row({ status: "completed", delivered_units: 5, plan_public: plan(5) }), row({ status: "completed", delivered_units: 9, plan_public: plan(9), addon: { of: "msn_y" } })];
    state.liveRows = [row({ status: "executing", lease_until: ago(-5000) })];
    const res = await get("?range=7");
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(new Set(state.tables)).toEqual(new Set(["missions"]));
    expect(state.filters).toContain(`gte:created_at:${ago(14 * DAY).slice(0, 10)}`);
    expect(state.filters).toContain("in:status:planning|executing");
    expect(j.missions.total).toBe(1);
    expect(j.missions.delivered).toBe(5);
    expect(j.live.running).toBe(1);
    expect(j.range).toBe(7);
  });

  // ADDED (DT-20261118-06 phase 1A and Gate 1 P1-2)
  const windowQueries = () => state.queries.filter((q) => q.ranges.length > 0);
  const many = (n: number) => Array.from({ length: n }, (_, i) => row({ id: `msn_${i}`, status: "completed", delivered_units: 1, plan_public: plan(2), created_at: ago(DAY + i * 1000) }));

  it("pages the window read 1,000 rows at a time: 2,400 rows are 3 pages, every row is counted, not truncated", async () => {
    state.windowRows = many(2400);
    const j = await (await get("?range=30")).json();
    expect(windowQueries()).toHaveLength(3);
    expect(windowQueries().map((q) => q.ranges[0])).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(j.missions.total).toBe(2400);
    expect(j.missions.delivered).toBe(2400);
    expect(j.truncated).toBe(false);
  });

  it("stops at 5 pages (5,000 rows) and says the numbers are truncated", async () => {
    state.windowRows = many(6000);
    const j = await (await get("?range=30")).json();
    expect(windowQueries()).toHaveLength(5);
    expect(j.missions.total).toBe(5000);
    expect(j.truncated).toBe(true);
  });

  it("range 90 reads 90 days of rows; the previous 90 days are two head counts (ended, succeeded) for the arrow, never rows", async () => {
    state.prevEnded = 4;
    state.prevSucceeded = 3;
    const j = await (await get("?range=90")).json();
    for (const q of windowQueries()) {
      expect(q.filters).toContain(`gte:created_at:${ago(90 * DAY).slice(0, 10)}`);
      expect(q.filters).not.toContain(`gte:created_at:${ago(180 * DAY).slice(0, 10)}`);
    }
    const heads = state.queries.filter((q) => q.head);
    expect(heads).toHaveLength(2);
    for (const q of heads) {
      expect(q.filters).toEqual(expect.arrayContaining([`gte:created_at:${ago(180 * DAY).slice(0, 10)}`, `lt:created_at:${ago(90 * DAY).slice(0, 10)}`, "is:plan->addon:null"]));
    }
    expect(heads.some((q) => q.filters.includes("in:status:completed|failed"))).toBe(true);
    expect(heads.some((q) => q.filters.includes("eq:status:completed") && q.filters.includes("gte:delivered_units:1"))).toBe(true);
    expect(j.missions.successPctPrev).toBe(75);
  });

  it("selects named columns only: the plan's stages and quantity by JSON path, never the whole plan_public", async () => {
    await get();
    expect(windowQueries().length).toBeGreaterThan(0);
    for (const q of windowQueries()) {
      expect(q.cols).toContain("stages:plan_public->stages");
      expect(q.cols).toContain("quantity:plan_public->quantity");
      expect(q.cols.split(",")).not.toContain("plan_public");
      expect(q.cols).not.toContain("*");
    }
  });

  it("returns recentMissions: the newest 8 requests (no add-on row), only id, status, created_at, delivered_units and user_id", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ ...row({ id: `msn_r${i}`, status: i === 0 ? "executing" : "completed", delivered_units: i, created_at: ago(i * 60_000) }), user_id: `u${i}` }));
    state.windowRows = [rows[0], { ...rows[1], id: "msn_addon", addon: { of: "msn_r0" } }, ...rows.slice(1)];
    const j = await (await get()).json();
    expect(j.recentMissions).toHaveLength(8);
    expect(j.recentMissions.map((m: { id: string }) => m.id)).toEqual(["msn_r0", "msn_r1", "msn_r2", "msn_r3", "msn_r4", "msn_r5", "msn_r6", "msn_r7"]);
    expect(j.recentMissions[0]).toEqual({ id: "msn_r0", status: "executing", created_at: rows[0].created_at, delivered_units: 0, user_id: "u0" });
  });

  it("?part=live reads only the running missions (the 60 s tiles) and returns only the live numbers", async () => {
    state.liveRows = [row({ status: "executing", lease_until: ago(-5000) }), row({ status: "planning", lease_until: ago(20 * 60_000) })];
    const j = await (await get("?part=live")).json();
    expect(state.queries).toHaveLength(1);
    expect(state.filters).toEqual(["in:status:planning|executing"]);
    expect(j).toEqual({ live: { running: 1, stalled: 1, stalledMinMinutes: 20, failed24h: 0 } });
  });

  it("a failed read is an error the card can show, not zeros", async () => {
    state.fail = true;
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("تعذّر قراءة المهام الآن.");
  });
});
