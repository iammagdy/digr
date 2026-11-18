import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./helpers/fakeSupabase";

/**
 * DT-20261118-06 phase 1B: the users list. Segments (chips) with counts, the sort, the page size, «نشط» = accessed in 30 days, the request count read from `missions`
 * (never `jobs`), and ONE grouped read of the ledger per request (no read per user). The real admin adapters run over an in-memory database; only the server client is faked.
 */
const NOW = Date.parse("2026-11-19T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const ADMIN = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "a@x.test", app_metadata: { role: "admin" }, user_metadata: {} };

type Read = { table: string; select: string; eq: Array<[string, unknown]> };
const state = vi.hoisted(() => ({ user: null as any, db: null as any, reads: [] as Read[], authPages: 0 }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.db),
}));

import { GET } from "../src/app/api/admin/users/route";
import { LOW_BALANCE_POINTS } from "../src/lib/server/adminUsersList";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";

/** A fake world: profiles, an append-only ledger, top-ups, missions, old jobs, and the sign-in service's accounts (with `banned_until`). Every read is recorded. */
function world(input: { profiles: any[]; ledger: any[]; topups: any[]; missions?: any[]; jobs?: any[]; banned?: Record<string, string> }) {
  const base = fakeSupabase({ tables: { profiles: input.profiles, credit_ledger: input.ledger, topups: input.topups, missions: input.missions ?? [], jobs: input.jobs ?? [], admin_audit_log: [] } });
  const accounts = input.profiles.map((p) => ({ id: p.id, banned_until: input.banned?.[p.id] ?? null }));
  return {
    ...base,
    from: (table: string) => {
      const b = base.from(table);
      const rec: Read = { table, select: "", eq: [] };
      state.reads.push(rec);
      const select = b.select, eq = b.eq;
      b.select = (s: string, o?: unknown) => { rec.select = s; return select(s, o); };
      b.eq = (c: string, v: unknown) => { rec.eq.push([c, v]); return eq(c, v); };
      return b;
    },
    auth: {
      admin: {
        getUserById: base.auth.admin.getUserById,
        listUsers: async ({ page = 1, perPage = 50 }: { page?: number; perPage?: number } = {}) => {
          state.authPages += 1;
          return { data: { users: accounts.slice((page - 1) * perPage, page * perPage) }, error: null };
        },
      },
    },
  };
}

const profile = (id: string, registeredDaysAgo: number, accessedDaysAgo: number) => ({ id, name: `اسم ${id}`, email: `${id}@x.test`, created_at: ago(registeredDaysAgo), updated_at: ago(accessedDaysAgo) });
let seq = 0;
const entry = (user: string, delta: number, type = "grant") => ({ id: `led_${String(++seq).padStart(6, "0")}`, user_id: user, delta, type, created_at: ago(1) });
const topup = (user: string, egp: number, status = "approved") => ({ id: `top-${++seq}`, user_id: user, amount_egp: egp, status, created_at: ago(5) });

/**
 * Seven people, by hand:
 * rich      registered 60 d, seen 2 d,  balance 1000, top-ups 500  → active (also active7)
 * fresh     registered 3 d,  seen 3 d,  balance 50,   no approved top-up (one pending) → active, new, zero, low
 * idle      registered 100 d, seen 45 d, balance 300, top-ups 100  → inactive
 * idleLow   registered 200 d, seen 90 d, balance 0,   none         → inactive, zero, low
 * mid       registered 20 d, seen 20 d,  balance 199, top-ups 50   → active (30 d, not 7 d), low (just under the line)
 * susp      registered 50 d, seen 10 d,  balance 200, top-ups 1000 → active, suspended (ban in the future); 200 is NOT low
 * wasSusp   registered 40 d, seen 35 d,  balance 250, top-ups 20   → inactive; the ban ended yesterday: not suspended
 */
const P = { rich: "u-rich", fresh: "u-fresh", idle: "u-idle", idleLow: "u-idlelow", mid: "u-mid", susp: "u-susp", wasSusp: "u-wassusp" };
const seven = () => world({
  profiles: [profile(P.rich, 60, 2), profile(P.fresh, 3, 3), profile(P.idle, 100, 45), profile(P.idleLow, 200, 90), profile(P.mid, 20, 20), profile(P.susp, 50, 10), profile(P.wasSusp, 40, 35)],
  ledger: [
    entry(P.rich, 1200), entry(P.rich, -300, "reserve"), entry(P.rich, 100, "release"),
    entry(P.fresh, 50),
    entry(P.idle, 300, "topup"),
    entry(P.idleLow, 100), entry(P.idleLow, -100, "charge"),
    entry(P.mid, 250), entry(P.mid, -51, "charge"),
    entry(P.susp, 200, "topup"),
    entry(P.wasSusp, 250),
  ],
  topups: [topup(P.rich, 500), topup(P.fresh, 70, "pending"), topup(P.idle, 100), topup(P.mid, 50), topup(P.susp, 1000), topup(P.wasSusp, 20)],
  missions: [
    { id: "msn_r1", user_id: P.rich, status: "completed", created_at: ago(3), plan: null },
    { id: "msn_r2", user_id: P.rich, status: "executing", created_at: ago(1), plan: null },
    { id: "msn_r3", user_id: P.rich, status: "plan_ready", created_at: ago(1), plan: { addon: { kind: "review" } } },
  ],
  jobs: [1, 2, 3, 4, 5].map((n) => ({ id: `job_${n}`, user_id: P.rich, status: "completed", created_at: ago(n) })),
  banned: { [P.susp]: new Date(NOW + 7 * DAY).toISOString(), [P.wasSusp]: ago(1) },
});

const get = async (query = "") => {
  const res = await GET(new NextRequest(`http://localhost/api/admin/users${query ? `?${query}` : ""}`));
  return { status: res.status, body: await res.json() };
};
const ids = (body: any) => body.users.map((u: any) => u.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  state.user = ADMIN;
  state.reads = [];
  state.authPages = 0;
  seq = 0;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("GET /api/admin/users: segments, counts, sort", () => {
  it("the low-balance line is the minimum charge of a mission (read from the pricing defaults, not a new number)", () => {
    expect(LOW_BALANCE_POINTS).toBe(DEFAULT_MISSION_PRICING_SETTINGS.minChargePoints);
  });

  it.each([
    ["all", [P.rich, P.fresh, P.idle, P.idleLow, P.mid, P.susp, P.wasSusp]],
    ["active", [P.rich, P.fresh, P.mid, P.susp]],
    ["new", [P.fresh]],
    ["zero", [P.fresh, P.idleLow]],
    ["low", [P.fresh, P.idleLow, P.mid]],
    ["inactive", [P.idle, P.idleLow, P.wasSusp]],
    ["suspended", [P.susp]],
  ])("chip %s returns exactly its people, and its count equals the list total", async (filter, expected) => {
    state.db = seven();
    const all = await get();
    const { status, body } = await get(`filter=${filter}`);
    expect(status).toBe(200);
    expect(new Set(ids(body))).toEqual(new Set(expected));
    expect(body.total).toBe(expected.length);
    expect(all.body.counts[filter]).toBe(body.total);
    expect(body.scanLimited).toBe(false);
  });

  it("«نشط» means accessed in 30 days (the tile says ٣٠ يومًا); the 7-day number stays in stats as active7", async () => {
    state.db = seven();
    const { body } = await get("filter=active");
    expect(ids(body)).toContain(P.mid); // seen 20 days ago
    expect(body.counts.active).toBe(4);
    expect(body.stats).toMatchObject({ total: 7, active30: 4, active7: 2, newWeek: 1, payers: 5 });
  });

  it.each([
    ["", [P.rich, P.fresh, P.susp, P.mid, P.wasSusp, P.idle, P.idleLow]],
    ["sort=access", [P.rich, P.fresh, P.susp, P.mid, P.wasSusp, P.idle, P.idleLow]],
    ["sort=balance", [P.rich, P.idle, P.wasSusp, P.susp, P.mid, P.fresh, P.idleLow]],
    ["sort=topups", [P.susp, P.rich, P.idle, P.mid, P.wasSusp, P.fresh, P.idleLow]],
    ["sort=registered", [P.fresh, P.mid, P.wasSusp, P.susp, P.rich, P.idle, P.idleLow]],
  ])("sort «%s» orders the rows", async (query, expected) => {
    state.db = seven();
    expect(ids((await get(query)).body)).toEqual(expected);
  });

  it("each row carries its balance, top-up total, suspension and request count; requests are read from missions (no add-on rows), never from jobs", async () => {
    state.db = seven();
    const { body } = await get();
    const rich = body.users.find((u: any) => u.id === P.rich);
    expect(rich).toMatchObject({ balance: 1000, totalTopupsEgp: 500, missions: 2, suspended: false });
    expect(body.users.find((u: any) => u.id === P.susp)).toMatchObject({ suspended: true, balance: 200 });
    expect(body.users.find((u: any) => u.id === P.fresh)).toMatchObject({ missions: 0, totalTopupsEgp: 0 });
    expect(state.reads.some((r) => r.table === "missions")).toBe(true);
    expect(state.reads.some((r) => r.table === "jobs")).toBe(false);
  });

  it("pages by 25; a phone may ask for 20; any other size is 25", async () => {
    const people = Array.from({ length: 30 }, (_, i) => profile(`u-${String(i).padStart(2, "0")}`, i + 1, i + 1));
    state.db = world({ profiles: people, ledger: [], topups: [] });
    const first = await get();
    expect(first.body).toMatchObject({ pageSize: 25, total: 30 });
    expect(first.body.users).toHaveLength(25);
    expect((await get("page=2")).body.users).toHaveLength(5);
    expect((await get("pageSize=20")).body).toMatchObject({ pageSize: 20 });
    expect((await get("pageSize=20")).body.users).toHaveLength(20);
    expect((await get("pageSize=50")).body.pageSize).toBe(25);
  });

  it("search keeps working inside a segment", async () => {
    state.db = seven();
    const { body } = await get(`filter=low&q=${encodeURIComponent("u-mid")}`);
    expect(ids(body)).toEqual([P.mid]);
  });

  it("the CSV export keeps its columns", async () => {
    state.db = seven();
    const res = await GET(new NextRequest("http://localhost/api/admin/users?format=csv"));
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.subarray(3).toString("utf8");
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // the BOM, so a spreadsheet reads the Arabic right
    expect(text.split("\r\n")[0]).toBe('"الاسم","البريد","تاريخ التسجيل","آخر دخول","إجمالي الشحن (ج.م)","آخر شحن"');
    expect(text.split("\r\n")).toHaveLength(8);
  });

  it("a non-admin is refused", async () => {
    state.db = seven();
    state.user = { id: "u-x", email: "x@x.test", app_metadata: {}, user_metadata: {} };
    expect((await get()).status).toBe(403);
  });
});

describe("no ledger read per user (Gate 1 P1-3)", () => {
  it("2,500 ledger rows and 30 people: one paged grouped read (at most 3 calls of 1,000), no per-user read, and every balance is the hand sum", async () => {
    const people = Array.from({ length: 30 }, (_, i) => profile(`p-${String(i).padStart(2, "0")}`, i + 1, i + 1));
    const ledger = Array.from({ length: 2500 }, (_, i) => entry(people[i % 30].id, (i % 7) - 2));
    const expected = new Map<string, number>();
    for (const r of ledger) expected.set(r.user_id, (expected.get(r.user_id) ?? 0) + r.delta);
    state.db = world({ profiles: people, ledger, topups: [] });
    const { body } = await get("sort=balance&pageSize=20");
    const grouped = state.reads.filter((r) => r.table === "credit_ledger" && r.select === "user_id,delta");
    expect(grouped.length).toBeGreaterThan(0);
    expect(grouped.length).toBeLessThanOrEqual(Math.ceil(2500 / 1000));
    expect(state.reads.filter((r) => r.table === "credit_ledger" && r.eq.some(([c]) => c === "user_id"))).toEqual([]);
    for (const u of body.users) expect(u.balance, u.id).toBe(expected.get(u.id));
    const balances = body.users.map((u: any) => u.balance);
    expect(balances).toEqual([...balances].sort((a, b) => b - a));
  });

  it("more people than the scan reads: the answer says the results come from the newest 2,000 accounts", async () => {
    const people = Array.from({ length: 2001 }, (_, i) => profile(`m-${String(i).padStart(4, "0")}`, (i % 300) + 1, (i % 300) + 1));
    state.db = world({ profiles: people, ledger: [], topups: [] });
    const { body } = await get("filter=low");
    expect(body.scanLimited).toBe(true);
    expect(body.stats.total).toBe(2001);
  });
});
