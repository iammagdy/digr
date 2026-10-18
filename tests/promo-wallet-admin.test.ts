import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as any,
  rpcCalls: [] as Array<{ fn: string; args: any }>,
  rpcResult: { data: null as any, error: null as any },
  adminClient: null as any,
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) },
  })),
  createAdminClient: vi.fn(() => state.adminClient),
}));

import { classifyLedgerRow, isRealIncomeKind } from "../src/lib/creditKinds";
import { summarizeCredit } from "../src/lib/server/financeSummary";
import { fetchTypedLedger, withRunningBalance } from "../src/lib/server/typedLedger";
import {
  normalizePromoCode,
  promoAttemptsExceeded,
  recordFailedPromoAttempt,
  redeemPromoCode,
  resetPromoAttemptsForTesting,
} from "../src/lib/server/promoCodes";
import { grantCreditAsAdmin, parseGrantPoints } from "../src/lib/server/adminCredit";
import { isNewAccountAtRedemption, summarizePromoCodes } from "../src/lib/server/promoStats";
import { calculateBalance } from "../src/lib/supabase/ledger";
import { POST as grantRoute } from "../src/app/api/admin/users/[id]/credit/route";
import { POST as savePromoRoute } from "../src/app/api/admin/promo-codes/route";
import { POST as redeemRoute } from "../src/app/api/wallet/redeem/route";

const NO_FUNCTION = { code: "PGRST202", message: "Could not find the function public.redeem_promo_code_atomic in the schema cache" };

function rpcClient() {
  const inserts: any[] = [];
  return {
    inserts,
    rpc: vi.fn(async (fn: string, args: any) => {
      state.rpcCalls.push({ fn, args });
      return state.rpcResult;
    }),
    from: vi.fn(() => ({ insert: vi.fn((row: any) => { inserts.push(row); return { error: null }; }) })),
  };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  state.user = null;
  state.rpcCalls = [];
  state.rpcResult = { data: null, error: null };
  state.adminClient = rpcClient();
  resetPromoAttemptsForTesting();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("1. typed credit rows", () => {
  it("classifies every legacy row: top-ups are Instapay income, grants are admin credit, the rest keep their type", () => {
    expect(classifyLedgerRow({ type: "topup" })).toBe("topup_instapay");
    expect(classifyLedgerRow({ type: "grant" })).toBe("admin_grant");
    expect(classifyLedgerRow({ type: "goodwill" })).toBe("admin_grant");
    expect(classifyLedgerRow({ type: "reserve" })).toBe("reserve");
    expect(classifyLedgerRow({ type: "charge" })).toBe("charge");
    expect(classifyLedgerRow({ type: "release" })).toBe("release");
    // A recorded kind wins over the type (promo credit is stored with the allowed type "grant").
    expect(classifyLedgerRow({ type: "grant", kind: "promo_code" })).toBe("promo_code");
    expect(isRealIncomeKind("topup_instapay")).toBe(true);
    expect(isRealIncomeKind("promo_code")).toBe(false);
    expect(isRealIncomeKind("admin_grant")).toBe(false);
  });

  it("the balance is the plain sum of deltas whatever the kinds, for legacy data too", async () => {
    const legacy = [
      { id: "top_a", user_id: "u", delta: 300, type: "topup", created_at: "2026-10-01T10:00:00Z" },
      { id: "res_j", user_id: "u", delta: -50, type: "reserve", job_id: "j", created_at: "2026-10-01T11:00:00Z" },
      { id: "chg_j", user_id: "u", delta: -30, type: "charge", job_id: "j", created_at: "2026-10-01T11:01:00Z" },
      { id: "rel_j", user_id: "u", delta: 50, type: "release", job_id: "j", created_at: "2026-10-01T11:01:00Z" },
      { id: "grt_1", user_id: "u", delta: 100, type: "grant", created_at: "2026-10-02T09:00:00Z" },
    ];
    const client = { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: legacy, error: null }) }) }) };
    const balance = await calculateBalance(client, "u");
    const typed = withRunningBalance(legacy.map((r) => ({
      id: r.id, userId: r.user_id, delta: r.delta, type: r.type, kind: classifyLedgerRow(r), jobId: null, topupId: null, note: "", createdAt: r.created_at, actorId: null,
    })));
    expect(balance).toBe(370);
    expect(typed.at(-1)!.runningBalance).toBe(balance);
  });

  it("history falls back to the ledger itself when the typed view is not installed yet", async () => {
    const rows = [{ id: "top_x", user_id: "u", delta: 100, type: "topup", created_at: "2026-10-01T00:00:00Z" }];
    const builder = (table: string) => {
      const chain: any = {
        select: () => chain, eq: () => chain, gte: () => chain, lt: () => chain, order: () => chain,
        range: async () => table === "credit_ledger_typed"
          ? { data: null, error: { code: "42P01", message: 'relation "public.credit_ledger_typed" does not exist' } }
          : { data: rows, error: null },
      };
      return chain;
    };
    const result = await fetchTypedLedger({ from: builder }, { userId: "u" });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("topup_instapay");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("2. promo codes and admin credit through the approved functions", () => {
  it("normalizes what is typed on a phone", () => {
    expect(normalizePromoCode("  friends٥٠٠ ")).toBe("FRIENDS500");
    expect(normalizePromoCode(null)).toBe("");
  });

  it("returns the Arabic outcome of every refusal from the function", async () => {
    const reasons: Array<[string, RegExp]> = [
      ["already_redeemed", /من قبل/], ["code_expired", /انتهت/], ["code_exhausted", /استُنفد/], ["code_inactive", /غير مفعّل/], ["code_not_found", /غير صحيح/],
    ];
    for (const [error, pattern] of reasons) {
      const client = rpcClient();
      state.rpcResult = { data: { success: false, error }, error: null };
      const out = await redeemPromoCode(client, "user-1", "friends");
      expect(out.ok).toBe(false);
      expect(out.reason).toBe(error);
      expect(out.messageAr).toMatch(pattern);
      expect(out.messageAr).not.toMatch(/[A-Za-z]/);
    }
  });

  it("a success reports the points and the new balance in Arabic-Indic digits", async () => {
    state.rpcResult = { data: { success: true, points: 500, balance: 1192 }, error: null };
    const out = await redeemPromoCode(rpcClient(), "user-1", "friends");
    expect(out).toMatchObject({ ok: true, points: 500, balance: 1192 });
    expect(out.messageAr).toContain("٥٠٠");
    expect(out.messageAr).toContain("١١٩٢");
    expect(out.messageAr).not.toMatch(/[0-9]/);
  });

  it("before the migration: a clear Arabic message, one safe log line, and no credit row written by hand", async () => {
    const client = rpcClient();
    state.rpcResult = { data: null, error: NO_FUNCTION };
    const out = await redeemPromoCode(client, "user-1", "friends");
    expect(out).toMatchObject({ ok: false, reason: "unavailable" });
    expect(out.messageAr).toMatch(/غير متاحة/);
    expect(client.inserts).toHaveLength(0);
    expect(client.from).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String((console.warn as any).mock.calls[0][0])).toMatch(/redeem_promo_code_atomic_unavailable/);
  });

  it("a permission or data error is never treated as a missing function", async () => {
    state.rpcResult = { data: null, error: { code: "42501", message: "permission denied for function redeem_promo_code_atomic" } };
    const out = await redeemPromoCode(rpcClient(), "user-1", "friends");
    expect(out.reason).toBe("failed");
  });

  it("a malformed code never reaches the database", async () => {
    const client = rpcClient();
    expect((await redeemPromoCode(client, "user-1", "x")).reason).toBe("invalid_code");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("guessing codes is throttled per account", () => {
    for (let i = 0; i < 8; i++) recordFailedPromoAttempt("guesser");
    expect(promoAttemptsExceeded("guesser")).toBe(true);
    expect(promoAttemptsExceeded("someone-else")).toBe(false);
  });

  it("manual credit: whole positive points only, idempotent result reported, unavailable before the migration", async () => {
    expect(parseGrantPoints("١٢٥")).toBe(125);
    expect(parseGrantPoints("-5")).toBeNull();
    expect(parseGrantPoints("0")).toBeNull();
    expect(parseGrantPoints("1.5")).toBeNull();
    expect(parseGrantPoints("100001")).toBeNull();

    state.rpcResult = { data: { success: true, points: 25, balance: 90, already_granted: true }, error: null };
    const repeat = await grantCreditAsAdmin(rpcClient(), { adminId: "a", userId: "u", points: 25, note: "gift", requestId: "req-12345678" });
    expect(repeat).toMatchObject({ ok: true, alreadyGranted: true });

    state.rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function public.admin_grant_credit_atomic" } };
    const missing = await grantCreditAsAdmin(rpcClient(), { adminId: "a", userId: "u", points: 25, note: "gift", requestId: "req-12345678" });
    expect(missing).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("a non-admin cannot grant credit or create codes, even by calling the routes directly", () => {
  const params = { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) };

  it("no session: 401 and nothing is called", async () => {
    const res = await grantRoute(post("/x", { points: 100, note: "free money" }), params);
    expect(res.status).toBe(401);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("a signed-in customer (no admin role): 403 and the database function is never reached", async () => {
    state.user = { id: "22222222-2222-2222-2222-222222222222", email: "c@x.test", app_metadata: {}, user_metadata: {} };
    const grant = await grantRoute(post("/x", { points: 100, note: "free money", requestId: "req-selfgrant1" }), params);
    expect(grant.status).toBe(403);
    const code = await savePromoRoute(post("/x", { code: "HACK", points: 999, maxRedemptions: 5 }));
    expect(code.status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("a spoofed role in the request body or headers changes nothing", async () => {
    state.user = { id: "22222222-2222-2222-2222-222222222222", email: "c@x.test", app_metadata: { role: "user" }, user_metadata: { role: "admin" } };
    const res = await grantRoute(post("/x", { points: 100, note: "free money", role: "admin", adminId: "x" }, { "x-role": "admin" }), params);
    expect(res.status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("an admin reaches the function with their own id, never an id from the body", async () => {
    state.user = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", email: "a@x.test", app_metadata: { role: "admin" }, user_metadata: {} };
    state.rpcResult = { data: { success: true, points: 100, balance: 100 }, error: null };
    const res = await grantRoute(post("/x", { points: "١٠٠", note: "تعويض عن مشكلة", requestId: "req-admin-0001", adminId: "someone-else" }), params);
    expect(res.status).toBe(200);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].fn).toBe("admin_grant_credit_atomic");
    expect(state.rpcCalls[0].args).toMatchObject({ p_admin_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", p_points: 100, p_request_id: "req-admin-0001" });
  });

  it("negative, zero and fractional amounts are refused before the database", async () => {
    state.user = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", email: "a@x.test", app_metadata: { role: "admin" }, user_metadata: {} };
    for (const points of [-5, 0, "1.5", "abc"]) {
      const res = await grantRoute(post("/x", { points, note: "تعويض عن مشكلة" }), params);
      expect(res.status).toBe(400);
    }
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe("the customer redeem route", () => {
  it("needs a session and uses the session's user id, never one from the body", async () => {
    expect((await redeemRoute(post("/api/wallet/redeem", { code: "FRIENDS" }))).status).toBe(401);
    state.user = { id: "33333333-3333-3333-3333-333333333333", email: "c@x.test", app_metadata: {}, user_metadata: {} };
    state.rpcResult = { data: { success: true, points: 500, balance: 500 }, error: null };
    state.adminClient.from = vi.fn(() => ({ select: () => ({ eq: () => Promise.resolve({ data: [{ delta: 500 }], error: null }) }) }));
    const res = await redeemRoute(post("/api/wallet/redeem", { code: "friends", userId: "someone-else", user_id: "someone-else" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, points: 500, balance: 500 });
    expect(state.rpcCalls[0].args).toEqual({ p_user_id: "33333333-3333-3333-3333-333333333333", p_code: "FRIENDS" });
  });

  it("a refused code returns the Arabic reason with status 400", async () => {
    state.user = { id: "33333333-3333-3333-3333-333333333333", email: "c@x.test", app_metadata: {}, user_metadata: {} };
    state.rpcResult = { data: { success: false, error: "already_redeemed" }, error: null };
    const res = await redeemRoute(post("/api/wallet/redeem", { code: "FRIENDS" }));
    expect(res.status).toBe(400);
    expect((await res.json()).messageAr).toMatch(/من قبل/);
  });
});

describe("6. finance summary keeps real income apart from free credit", () => {
  const row = (delta: number, kind: any, createdAt: string) => ({ delta, kind, createdAt });
  const rows = [
    row(1000, "topup_instapay", "2026-10-05T10:00:00Z"),
    row(500, "promo_code", "2026-10-06T10:00:00Z"),
    row(500, "promo_code", "2026-10-06T11:00:00Z"),
    row(200, "admin_grant", "2026-10-07T10:00:00Z"),
    row(-300, "reserve", "2026-10-08T10:00:00Z"),
    row(-250, "charge", "2026-10-08T10:01:00Z"),
    row(300, "release", "2026-10-08T10:01:00Z"),
    row(400, "topup_instapay", "2026-09-01T10:00:00Z"),
  ];
  const topups = [
    { amountEgp: 100, approvedAt: "2026-10-05T10:00:00Z" },
    { amountEgp: 40, approvedAt: "2026-09-01T10:00:00Z" },
  ];

  it("promo and admin credit never count as income", () => {
    const s = summarizeCredit(rows, topups, { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" });
    expect(s.realIncome).toEqual({ egp: 100, points: 1000, count: 1 });
    expect(s.promoPoints).toBe(1000);
    expect(s.adminGrantPoints).toBe(200);
    expect(s.consumedPoints).toBe(250);
    expect(s.refundedPoints).toBe(300);
  });

  it("outstanding is every point still owed, counted over all kinds up to the end of the period", () => {
    const s = summarizeCredit(rows, topups, { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" });
    expect(s.outstandingPoints).toBe(rows.reduce((a, r) => a + r.delta, 0));
    const early = summarizeCredit(rows, topups, { from: "2026-10-01T00:00:00Z", to: "2026-10-06T00:00:00Z" });
    expect(early.outstandingPoints).toBe(1400);
    expect(early.promoPoints).toBe(0);
  });

  it("a period with only promo credit has zero real income", () => {
    const s = summarizeCredit(rows, topups, { from: "2026-10-06T00:00:00Z", to: "2026-10-07T00:00:00Z" });
    expect(s.realIncome).toEqual({ egp: 0, points: 0, count: 0 });
    expect(s.promoPoints).toBe(1000);
  });
});

describe("4. promo admin summary", () => {
  it("marks an account as new only when created within 7 days before the redemption", () => {
    expect(isNewAccountAtRedemption("2026-10-10T00:00:00Z", "2026-10-12T00:00:00Z")).toBe(true);
    expect(isNewAccountAtRedemption("2026-09-01T00:00:00Z", "2026-10-12T00:00:00Z")).toBe(false);
    expect(isNewAccountAtRedemption(null, "2026-10-12T00:00:00Z")).toBe(false);
    expect(isNewAccountAtRedemption("2026-10-13T00:00:00Z", "2026-10-12T00:00:00Z")).toBe(false);
  });

  it("lists redemptions with counts, remaining and the new / existing flag", () => {
    const [summary] = summarizePromoCodes(
      [{ code: "FRIENDS", points: 500, max_redemptions: 3, starts_at: null, expires_at: null, active: true, note: "launch", created_at: "2026-10-01T00:00:00Z" }],
      [
        { code: "FRIENDS", user_id: "n", redeemed_at: "2026-10-12T10:00:00Z" },
        { code: "FRIENDS", user_id: "o", redeemed_at: "2026-10-12T09:00:00Z" },
      ],
      new Map([["n", { name: "جديد", email: "n@x", createdAt: "2026-10-11T00:00:00Z" }], ["o", { name: "قديم", email: "o@x", createdAt: "2026-01-01T00:00:00Z" }]]),
      new Date("2026-10-13T00:00:00Z").getTime(),
    );
    expect(summary).toMatchObject({ used: 2, remaining: 1, state: "active", stateAr: "فعّال" });
    expect(summary.redemptions.map((r) => [r.userId, r.isNewAccount])).toEqual([["n", true], ["o", false]]);
  });
});
