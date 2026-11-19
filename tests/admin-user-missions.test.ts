import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./helpers/fakeSupabase";

/** DT-20261118-06 phase 1B: the profile's «المهام» tab. The last 20 missions of ONE customer, without add-on rows, admin only; the same read the e-mail composer uses (extracted, not copied). */
const ADMIN = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "a@x.test", app_metadata: { role: "admin" }, user_metadata: {} };
const ME = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const state = vi.hoisted(() => ({ user: null as any, db: null as any, tables: [] as string[] }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.db),
}));

import { GET } from "../src/app/api/admin/users/[id]/missions/route";
import { requestedRowsOf } from "../src/lib/agentMission/customerView";

const at = (n: number) => new Date(Date.parse("2026-11-01T00:00:00Z") + n * 3_600_000).toISOString();
const plan = (rows: number) => ({ stages: [{ key: "s1", title_ar: "تغريدات", expected_rows: rows, deliver: true }] });
const LONG = "اجمع لي كل التغريدات التي تتحدث عن الغسل الأخضر في مصر خلال آخر ستة أشهر مع اسم الحساب وعدد المتابعين";
const mission = (id: string, user: string, n: number, over: Record<string, unknown> = {}) => ({ id, user_id: user, status: "completed", request_text: `${LONG} ${n}`, created_at: at(n), plan: null, plan_public: plan(100), delivered_units: 80, charged_points: 400, files: [], ...over });

function seed() {
  const rows = [
    ...Array.from({ length: 25 }, (_, i) => mission(`msn_mine${String(i).padStart(4, "0")}`, ME, i)),
    ...Array.from({ length: 4 }, (_, i) => mission(`msn_other${i}`, OTHER, 100 + i)),
    mission("msn_addon0001", ME, 200, { plan: { addon: { kind: "review" } } }),
    mission("msn_addon0002", ME, 201, { plan: { addon: null } }),
  ];
  const base = fakeSupabase({ tables: { missions: rows } });
  return { ...base, from: (t: string) => { state.tables.push(t); return base.from(t); } };
}
const get = (id = ME) => GET(new NextRequest(`http://localhost/api/admin/users/${id}/missions`), { params: Promise.resolve({ id }) });

beforeEach(() => { state.user = ADMIN; state.db = seed(); state.tables = []; });

describe("GET /api/admin/users/[id]/missions", () => {
  it("returns at most 20 rows, only this customer's, newest first, without add-on rows, in the tab's shape", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const { missions } = await res.json();
    expect(missions.length).toBeGreaterThan(0);
    expect(missions.length).toBeLessThanOrEqual(20);
    for (const m of missions) expect(m.id).toMatch(/^msn_mine/);
    expect(missions.map((m: any) => m.id)).not.toContain("msn_addon0001");
    expect(missions.map((m: any) => m.id)).not.toContain("msn_addon0002");
    const dates = missions.map((m: any) => m.created_at);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(missions[0]).toEqual({ id: "msn_mine0024", created_at: at(24), status: "completed", request: `${LONG} 24`.slice(0, 60), delivered: 80, asked: requestedRowsOf(plan(100)), charged_points: 400 });
    expect(missions[0].request.length).toBe(60);
    expect(Object.keys(missions[0]).sort()).toEqual(["asked", "charged_points", "created_at", "delivered", "id", "request", "status"]);
  });

  it("refuses a non-admin before reading anything", async () => {
    state.user = { id: ME, email: "c@x.test", app_metadata: {}, user_metadata: {} };
    expect((await get()).status).toBe(403);
    state.user = null;
    expect((await get()).status).toBe(401);
    expect(state.tables).not.toContain("missions");
  });

  it("refuses a malformed id", async () => {
    expect((await get("bad id;")).status).toBe(400);
  });

  it("the e-mail composer reads the same helper (extracted, not copied)", () => {
    const email = readFileSync("src/app/api/admin/users/[id]/email/route.ts", "utf8");
    const route = readFileSync("src/app/api/admin/users/[id]/missions/route.ts", "utf8");
    expect(email).toContain("readUserMissions(");
    expect(route).toContain("readUserMissions(");
    expect(email).not.toMatch(/\.eq\("user_id", id\)\.order\("created_at"/);
  });
});
