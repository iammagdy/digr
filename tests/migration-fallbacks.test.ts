import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({ user: null as any, admin: null as any }));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.admin),
}));

import { GET as promoList, POST as promoSave } from "../src/app/api/admin/promo-codes/route";
import { GET as userDetail } from "../src/app/api/admin/users/[id]/route";
import { POST as grant } from "../src/app/api/admin/users/[id]/credit/route";
import { GET as financeGet } from "../src/app/api/admin/finance/route";
import { GET as supportList } from "../src/app/api/admin/support/route";
import { GET as walletHistory } from "../src/app/api/wallet/history/route";
import { POST as redeem } from "../src/app/api/wallet/redeem/route";
import { POST as supportPost } from "../src/app/api/support/messages/route";

const ADMIN = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", email: "a@x.test", app_metadata: { role: "admin" }, user_metadata: {} };
const USER_ID = "11111111-1111-1111-1111-111111111111";
const customer = { id: USER_ID, email: "c@x.test", app_metadata: {}, user_metadata: {} };

const ledger = [
  { id: "top_t1", user_id: USER_ID, delta: 300, type: "topup", topup_id: "t1", note: "شحن", created_at: "2026-10-10T10:00:00Z" },
  { id: "grt_1", user_id: USER_ID, delta: 100, type: "grant", note: "قديم", created_at: "2026-10-11T10:00:00Z" },
  { id: "res_job_1", user_id: USER_ID, delta: -50, type: "reserve", job_id: "job_1", created_at: "2026-10-12T10:00:00Z" },
  { id: "chg_job_1", user_id: USER_ID, delta: -30, type: "charge", job_id: "job_1", created_at: "2026-10-12T10:01:00Z" },
  { id: "rel_job_1", user_id: USER_ID, delta: 50, type: "release", job_id: "job_1", created_at: "2026-10-12T10:01:00Z" },
];
const baseTables = {
  credit_ledger: ledger,
  profiles: [{ id: USER_ID, email: "c@x.test", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" }, { id: ADMIN.id, email: "a@x.test" }],
  topups: [{ id: "t1", user_id: USER_ID, amount_egp: 30, status: "approved", created_at: "2026-10-10T09:00:00Z" }],
  jobs: [{ id: "job_1", user_id: USER_ID, status: "completed", created_at: "2026-10-12T10:00:00Z" }],
  provider_costs: [],
  settings_public: [{ key: "pricing", value: { creditValueEgp: 0.1 } }],
};
const authUsers = { [USER_ID]: { email: "c@x.test", user_metadata: { name: "سلمى" }, created_at: "2026-10-01T00:00:00Z", last_sign_in_at: "2026-10-12T09:00:00Z" } };

const req = (url: string, init?: any) => new NextRequest(`http://localhost${url}`, init);
const params = { params: Promise.resolve({ id: USER_ID }) };

beforeEach(() => {
  state.user = ADMIN;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("BEFORE the migrations are applied: nothing breaks, nothing is written by hand", () => {
  const before = (extra: Record<string, any> = {}) => fakeSupabase({
    tables: baseTables,
    authUsers,
    missing: ["credit_ledger_typed", "promo_codes", "promo_redemptions", "credit_ledger_kinds", "support_messages"],
    rpcMissing: ["redeem_promo_code_atomic", "admin_grant_credit_atomic", "admin_save_promo_code_atomic"],
    ...extra,
  });

  it("the admin user sheet loads with history classified by type, and the balance is the plain sum", async () => {
    state.admin = before();
    const res = await userDetail(req(`/api/admin/users/${USER_ID}`), params);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.balance).toBe(370);
    expect(body.promo).toEqual({ used: false, codes: [] });
    const kinds = Object.fromEntries(body.history.map((h: any) => [h.id, h.kind]));
    expect(kinds).toMatchObject({ top_t1: "topup_instapay", grt_1: "admin_grant", res_job_1: "reserve", chg_job_1: "charge", rel_job_1: "release" });
    expect(body.history[0].runningBalance).toBe(370); // newest first
    expect(body.lastJobAt).toBe("2026-10-12T10:00:00Z");
    expect(body.lastLogin).toBe("2026-10-12T09:00:00Z");
  });

  it("the finance page still answers, with the credit split computed from row types", async () => {
    state.admin = before();
    const res = await financeGet(req("/api/admin/finance?range=30"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.credit.realIncome.points).toBe(300);
    expect(body.credit.adminGrantPoints).toBe(100);
    expect(body.credit.promoPoints).toBe(0);
    expect(body.credit.outstandingPoints).toBe(370);
  });

  it("the customer's history works from row types", async () => {
    state.user = customer;
    state.admin = before();
    const body = await (await walletHistory(req("/api/wallet/history"))).json();
    expect(body.success).toBe(true);
    expect(body.rows.map((r: any) => r.kind)).toEqual(["release", "charge", "reserve", "admin_grant", "topup_instapay"]);
  });

  it("the promo page says the migration is pending instead of failing; saving a code is refused clearly", async () => {
    state.admin = before();
    const list = await (await promoList(req("/api/admin/promo-codes"))).json();
    expect(list).toEqual({ codes: [], migrationPending: true });
    const save = await promoSave(req("/api/admin/promo-codes", { method: "POST", body: JSON.stringify({ code: "FRIENDS", points: 500, maxRedemptions: 5 }) }));
    expect(save.status).toBe(503);
    expect((await save.json()).error).toMatch(/لم يُطبَّق/);
  });

  it("redeeming and granting are refused with Arabic messages and write no credit row", async () => {
    state.admin = before();
    state.user = customer;
    const r = await redeem(req("/api/wallet/redeem", { method: "POST", body: JSON.stringify({ code: "FRIENDS" }) }));
    expect(r.status).toBe(503);
    expect((await r.json()).messageAr).toMatch(/غير متاحة/);
    state.user = ADMIN;
    const g = await grant(req(`/api/admin/users/${USER_ID}/credit`, { method: "POST", body: JSON.stringify({ points: 50, note: "تعويض عن مشكلة", requestId: "req-before-0001" }) }), params);
    expect(g.status).toBe(503);
    expect(state.admin.writes.filter((w: any) => w.table === "credit_ledger")).toHaveLength(0);
  });

  it("the support list says the migration is pending; the contact form still succeeds when the email goes out", async () => {
    state.admin = before({ tables: { ...baseTables, settings_public: [{ key: "support", value: { supportEmail: "help@diger.tech" } }] } });
    expect(await (await supportList(req("/api/admin/support"))).json()).toEqual({ messages: [], migrationPending: true });
    process.env.RESEND_API_KEY = "re_test_not_real";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    state.user = null;
    const res = await supportPost(req("/api/support/messages", { method: "POST", headers: { "x-forwarded-for": "7.7.7.7" }, body: JSON.stringify({ name: "سلمى", email: "c@x.test", message: "عندي سؤال عن الأسعار" }) }));
    delete process.env.RESEND_API_KEY;
    expect(res.status).toBe(200);
  });
});

describe("AFTER the migrations are applied: the same routes use the new functions and tables", () => {
  it("the user sheet shows the recorded kinds, the promo used and who granted credit", async () => {
    const kinds = ledger.map((r) => r).concat([
      { id: "promo_FRIENDS_" + USER_ID, user_id: USER_ID, delta: 500, type: "grant", note: "رصيد ترويجي", created_at: "2026-10-13T10:00:00Z" } as any,
      { id: "adm_req-1", user_id: USER_ID, delta: 25, type: "grant", note: "هدية من الإدارة: تعويض", created_at: "2026-10-14T10:00:00Z" } as any,
    ]);
    const typed = kinds.map((r: any) => ({
      ...r,
      kind: r.id.startsWith("promo_") ? "promo_code" : r.id.startsWith("adm_") ? "admin_grant" : r.type === "topup" ? "topup_instapay" : r.type === "grant" ? "admin_grant" : r.type,
      actor_id: r.id.startsWith("adm_") ? ADMIN.id : null,
    }));
    state.admin = fakeSupabase({
      tables: { ...baseTables, credit_ledger_typed: typed, promo_redemptions: [{ code: "FRIENDS", user_id: USER_ID, redeemed_at: "2026-10-13T10:00:00Z" }] },
      authUsers: { ...authUsers, [ADMIN.id]: { email: "a@x.test", user_metadata: { name: "المدير" } } },
    });
    const body = await (await userDetail(req(`/api/admin/users/${USER_ID}`), params)).json();
    expect(body.balance).toBe(895);
    expect(body.promo).toEqual({ used: true, codes: [{ code: "FRIENDS", redeemedAt: "2026-10-13T10:00:00Z" }] });
    const gift = body.history.find((h: any) => h.id === "adm_req-1");
    expect(gift).toMatchObject({ kind: "admin_grant", kindAr: "هدية من الإدارة", grantedBy: "المدير" });
    expect(body.history.find((h: any) => h.id.startsWith("promo_"))).toMatchObject({ kindAr: "رصيد ترويجي" });
  });

  it("redeeming and granting reach the approved functions, and the admin grant carries the admin's own id", async () => {
    state.admin = fakeSupabase({
      tables: baseTables,
      rpc: {
        redeem_promo_code_atomic: () => ({ data: { success: true, points: 500, balance: 870 } }),
        admin_grant_credit_atomic: () => ({ data: { success: true, points: 50, balance: 420 } }),
      },
    });
    state.user = customer;
    const r = await redeem(req("/api/wallet/redeem", { method: "POST", body: JSON.stringify({ code: "friends" }) }));
    expect((await r.json()).points).toBe(500);
    state.user = ADMIN;
    const g = await grant(req(`/api/admin/users/${USER_ID}/credit`, { method: "POST", body: JSON.stringify({ points: 50, note: "تعويض عن مشكلة", requestId: "req-after-00001" }) }), params);
    expect(g.status).toBe(200);
    expect(state.admin.rpcCalls.map((c: any) => c.fn)).toEqual(["redeem_promo_code_atomic", "admin_grant_credit_atomic"]);
    expect(state.admin.rpcCalls[1].args.p_admin_id).toBe(ADMIN.id);
    expect(state.admin.writes.filter((w: any) => w.table === "credit_ledger")).toHaveLength(0);
  });
});
