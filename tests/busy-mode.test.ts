import { PUBLIC_LIMITS_PER_MINUTE } from "../src/lib/server/publicRateLimit";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const accept = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1", email: "a@b.c", email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} } }, error: null })) } })),
  createAdminClient: vi.fn(() => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), rpc: async () => ({ data: null, error: null }) })),
}));
vi.mock("../src/lib/server/providerGate", () => ({ getLiveProviderGateStatusFromSettings: vi.fn(async () => ({ isReady: true })) }));
vi.mock("../src/lib/supabase/quoteAccept", () => ({ acceptQuoteSupabase: vi.fn(async () => { accept.calls += 1; return { success: true }; }) }));

import { BUSY_BELOW_SAFE_BUDGET_USD, evaluateBusy, NOT_BUSY } from "../src/lib/busyMode";
import { BUSY_CACHE_MS, getBusyState, setBusyStateForTesting } from "../src/lib/server/busyState";
import { POST as acceptQuote } from "../src/app/api/chat/accept-quote/route";
import { GET as busyStatus } from "../src/app/api/busy-status/route";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createStatefulSupabase } from "./helpers/statefulSupabase";

afterEach(() => setBusyStateForTesting(undefined));

describe("when the provider's daily allowance or capacity is used up, new requests are paused (pure rule)", () => {
  it("the daily limit left cannot pay for a small request: busy, reason daily limit, with the queue", () => {
    const state = evaluateBusy({ remainingDailyUsd: 0, realBalanceUsd: 0.9, queuedOrRunning: 7 });
    expect(state).toMatchObject({ busy: true, reason: "daily_cap", queueAhead: 7, position: 8 });
    expect(state.messageAr).toContain("وصلنا إلى حد المعالجة اليومي");
    expect(state.messageAr).toContain("٧");
    expect(state.messageAr).toContain("ترتيب طلبك إن بدأ بعدها: ٨");
    expect(state.messageAr).not.toMatch(/[A-Za-z0-9]/);
  });
  it("the REAL balance is spent: busy, reason balance", () => {
    const state = evaluateBusy({ remainingDailyUsd: 0.8, realBalanceUsd: 0.005, queuedOrRunning: 0 });
    expect(state).toMatchObject({ busy: true, reason: "balance", queueAhead: 0, position: 1 });
    expect(state.messageAr).toContain("سعة المصدر المتاحة نفدت مؤقتًا");
    expect(state.messageAr).not.toContain("الطلبات قيد التنفيذ");
  });
  it("a balance that was only estimated never closes the door: no real reading means only the daily limit counts", () => {
    expect(evaluateBusy({ remainingDailyUsd: 0.8, realBalanceUsd: null, queuedOrRunning: 3 }).busy).toBe(false);
  });
  it("enough of both is not busy, the line between is the documented safe budget (with the 10% margin)", () => {
    expect(evaluateBusy({ remainingDailyUsd: 0.8, realBalanceUsd: 0.9186, queuedOrRunning: 0 })).toMatchObject({ busy: false, messageAr: "" });
    const edge = BUSY_BELOW_SAFE_BUDGET_USD / 0.9;
    expect(evaluateBusy({ remainingDailyUsd: edge + 0.0001, realBalanceUsd: 1, queuedOrRunning: 0 }).busy).toBe(false);
    expect(evaluateBusy({ remainingDailyUsd: edge - 0.0001, realBalanceUsd: 1, queuedOrRunning: 0 }).busy).toBe(true);
  });
  it("garbage in never closes the door by accident: a NaN or negative reading is treated as no reading", () => {
    expect(evaluateBusy({ remainingDailyUsd: 0.8, realBalanceUsd: Number.NaN, queuedOrRunning: -3 })).toMatchObject({ busy: false, queueAhead: 0 });
    expect(evaluateBusy({ remainingDailyUsd: 0.8, realBalanceUsd: -1, queuedOrRunning: 0 }).busy).toBe(false);
  });
});

describe("the live busy state: cached, read only, fails open", () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => { (process.env as any).NODE_ENV = originalEnv; });

  it("in tests it is not busy unless a test fixes it", async () => {
    expect(await getBusyState({})).toEqual(NOT_BUSY);
    setBusyStateForTesting(evaluateBusy({ remainingDailyUsd: 0, realBalanceUsd: null, queuedOrRunning: 0 }));
    expect((await getBusyState({})).busy).toBe(true);
  });
  it("a read that fails leaves the door open (the plan gate and the worker still protect the money)", async () => {
    (process.env as any).NODE_ENV = "production";
    setBusyStateForTesting(undefined);
    const broken: any = { from: () => { throw new Error("db down"); } };
    expect((await getBusyState(broken, 1_000_000_000)).busy).toBe(false);
  });
  it("one set of reads serves every visitor for the cache period", async () => {
    (process.env as any).NODE_ENV = "production";
    setBusyStateForTesting(undefined);
    let reads = 0;
    const admin: any = { from: () => { reads += 1; return { select: () => ({ in: async () => ({ count: 4 }), eq: () => ({ maybeSingle: async () => ({ data: null }) }), limit: () => ({ then: (r: any) => r({ data: [], error: null }) }), then: (r: any) => r({ data: [], error: null }) }), }; } };
    const t = 2_000_000_000_000;
    await getBusyState(admin, t);
    const after = reads;
    await getBusyState(admin, t + BUSY_CACHE_MS - 1);
    expect(reads).toBe(after);
  });
});

describe("the chat and the approval stop while busy", () => {
  const busy = evaluateBusy({ remainingDailyUsd: 0, realBalanceUsd: null, queuedOrRunning: 2 });

  function session() {
    const store = createStatefulSupabase({ tables: { profiles: [{ id: "u1" }], conversations: [{ id: "c1", user_id: "u1", status: "active", brief: null, title: "x" }], messages: [], plans_quotes: [], jobs: [], llm_usage: [], credit_ledger: [] } });
    const handler = new ChatHandler(store.client as any);
    const model = vi.fn(async () => { throw new Error("the model must not be called"); });
    (handler as any).llm.executeTurn = model;
    return { store, model, send: (message: string) => handler.handleUserMessage({ userId: "u1", conversationId: "c1", message, userBalance: 5000 }) as Promise<any> };
  }

  it("a data request gets the plain busy answer: no plan, no question, no model call, nothing reserved", async () => {
    setBusyStateForTesting(busy);
    const { store, model, send } = session();
    const reply = await send("عايز ٥ شركات كهرباء في مصر");
    expect(reply.contentAr).toBe(busy.messageAr);
    expect(reply.planQuote).toBeUndefined();
    expect(model).not.toHaveBeenCalled();
    expect(store.rows("plans_quotes")).toHaveLength(0);
    expect(store.rows("credit_ledger")).toHaveLength(0);
    expect(store.rpcCalls).toEqual([]);
  });

  it("a greeting is not held back", async () => {
    setBusyStateForTesting(busy);
    const { send } = session();
    const reply = await send("السلام عليكم");
    expect(reply.contentAr).not.toBe(busy.messageAr);
  });

  it("not busy: the same request goes on as usual", async () => {
    setBusyStateForTesting(NOT_BUSY);
    const { send } = session();
    const reply = await send("عايز ٥ شركات كهرباء في مصر").catch(() => ({ contentAr: "" }));
    expect(reply.contentAr).not.toBe(busy.messageAr);
  });

  it("the approval is refused with the same sentence before anything is reserved", async () => {
    setBusyStateForTesting(busy);
    accept.calls = 0;
    const res = await acceptQuote(new NextRequest("http://x/api/chat/accept-quote", { method: "POST", body: JSON.stringify({ quoteId: "q1", explicitApproval: true }) }));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ success: false, busy: true, error: busy.messageAr, queueAhead: 2, position: 3 });
    expect(accept.calls).toBe(0);
  });

  it("the public status answers in one sentence, no number about the provider, and is rate limited", async () => {
    setBusyStateForTesting(busy);
    const res = await busyStatus(new NextRequest("http://x/api/busy-status", { headers: { "x-forwarded-for": "9.9.9.9" } }));
    const body = await res.json();
    expect(body).toEqual({ busy: true, messageAr: busy.messageAr, queueAhead: 2, position: 3 });
    for (let i = 0; i < PUBLIC_LIMITS_PER_MINUTE.status; i++) await busyStatus(new NextRequest("http://x/api/busy-status", { headers: { "x-forwarded-for": "9.9.9.8" } }));
    const limited = await busyStatus(new NextRequest("http://x/api/busy-status", { headers: { "x-forwarded-for": "9.9.9.8" } }));
    expect(limited.status).toBe(429);
  });
});

describe("the busy check sits before anything is reserved, and writes nothing", () => {
  it("in the approval route it comes before the quote is accepted (the reserve)", () => {
    const source = readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8");
    expect(source.indexOf("getBusyState(adminClient)")).toBeGreaterThan(0);
    expect(source.indexOf("getBusyState(adminClient)")).toBeLessThan(source.indexOf("acceptQuoteSupabase("));
  });
  it("the busy state source reads only: no insert, update, upsert, delete or rpc", () => {
    const source = readFileSync("src/lib/server/busyState.ts", "utf8");
    for (const word of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) expect(source).not.toContain(word);
  });
  it("the rule file imports no pricing, ledger or provider code", () => {
    const source = readFileSync("src/lib/busyMode.ts", "utf8");
    expect(source).not.toMatch(/from "[^"]*(?:pricing|ledger|providerSpend|providerLimits)/);
  });
});
