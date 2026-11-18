import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DT-20261118-06 phase 1A: the admin bell's «failed in the last 24 h» reads the `missions` table (every customer request is inserted there: customerActions.ts),
 * never the old `jobs` table. The fake applies the route's own filters to the rows, so a wrong status or time filter gives a wrong count.
 */
const NOW = Date.parse("2026-11-18T12:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const state = vi.hoisted(() => ({ admin: true, supabaseTables: [] as string[], appTables: [] as string[], missions: [] as any[], fail: false }));

vi.mock("../src/lib/server/adminAuth", () => ({
  Query: { equal: (a: string, b: unknown) => `eq:${a}:${b}`, greaterThanEqual: (a: string, b: unknown) => `gte:${a}:${b}`, orderDesc: (a: string) => `desc:${a}`, limit: (n: number) => `limit:${n}` },
  authenticateAdmin: vi.fn(async () => (state.admin
    ? {
      ok: true,
      ctx: {
        adminId: "adm-1",
        audit: vi.fn(),
        tables: { listRows: async ({ tableId }: { tableId: string }) => { state.appTables.push(tableId); return { rows: tableId === "topups" ? [{ $id: "t1", senderName: "أحمد", reference: "R1", amountEgp: 100, createdAt: ago(HOUR) }] : [{ $id: "job-old", reservedCredits: 9, createdAt: ago(HOUR) }], total: 1 }; } },
        users: { list: async () => ({ total: 0, users: [] }) },
      },
    }
    : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(),
  createAdminClient: () => ({
    from: (table: string) => {
      state.supabaseTables.push(table);
      let rows = table === "missions" ? [...state.missions] : [];
      const chain: any = {
        select: () => chain,
        eq: (col: string, v: unknown) => { rows = rows.filter((r) => r[col] === v); return chain; },
        gte: (col: string, v: string) => { rows = rows.filter((r) => String(r[col]) >= v); return chain; },
        order: (col: string, o?: { ascending?: boolean }) => { rows.sort((a, b) => (o?.ascending ? 1 : -1) * String(a[col]).localeCompare(String(b[col]))); return chain; },
        limit: async (n: number) => (state.fail ? { data: null, error: { message: "boom" } } : { data: rows.slice(0, n), error: null }),
      };
      return chain;
    },
  }),
}));

import { GET } from "../src/app/api/admin/alerts/route";

const mission = (over: Record<string, unknown>) => ({ id: `msn_${Math.random().toString(36).slice(2, 10)}`, status: "failed", reserved_points: 120, created_at: ago(30 * HOUR), updated_at: ago(2 * HOUR), addon: null, ...over });

describe("GET /api/admin/alerts: failed requests come from missions", () => {
  beforeEach(() => { state.admin = true; state.supabaseTables = []; state.appTables = []; state.missions = []; state.fail = false; vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });

  it("counts only failed missions updated in the last 24 h, never an add-on row, and maps reserved_points to reservedCredits", async () => {
    const recent = mission({ id: "msn_recent", reserved_points: 300, created_at: ago(3 * HOUR), updated_at: ago(1 * HOUR) });
    state.missions = [
      recent,
      mission({ id: "msn_older_created", updated_at: ago(23 * HOUR) }), // created before the 24 h but failed inside them: counts
      mission({ id: "msn_old_fail", updated_at: ago(25 * HOUR) }), // failed more than 24 h ago
      mission({ id: "msn_done", status: "completed", updated_at: ago(HOUR) }),
      mission({ id: "msn_running", status: "executing", updated_at: ago(HOUR) }),
      mission({ id: "msn_addon", updated_at: ago(HOUR), addon: { of: "msn_recent" } }), // a failed paid review is not a failed request
    ];
    const res = await GET(new NextRequest("http://localhost/api/admin/alerts"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.failedTotal).toBe(2);
    expect(j.failedJobs).toEqual([
      { id: "msn_recent", reservedCredits: 300, createdAt: recent.created_at },
      { id: "msn_older_created", reservedCredits: 120, createdAt: state.missions[1].created_at },
    ]);
    // the rest of the bell is unchanged
    expect(j.pendingTotal).toBe(1);
    expect(j.pendingTopups[0]).toMatchObject({ id: "t1", amountEgp: 100 });
  });

  it("never reads the jobs table, by either client", async () => {
    await GET(new NextRequest("http://localhost/api/admin/alerts"));
    expect(state.supabaseTables).toEqual(["missions"]);
    expect(state.appTables).not.toContain("jobs");
  });

  it("at most 5 items are listed, the total counts them all", async () => {
    state.missions = Array.from({ length: 7 }, (_, i) => mission({ id: `msn_${i}`, updated_at: ago((i + 1) * HOUR) }));
    const j = await (await GET(new NextRequest("http://localhost/api/admin/alerts"))).json();
    expect(j.failedTotal).toBe(7);
    expect(j.failedJobs.map((f: { id: string }) => f.id)).toEqual(["msn_0", "msn_1", "msn_2", "msn_3", "msn_4"]);
  });

  it("admins only: nothing is read for anyone else", async () => {
    state.admin = false;
    expect((await GET(new NextRequest("http://localhost/api/admin/alerts"))).status).toBe(403);
    expect(state.supabaseTables).toEqual([]);
  });
});
