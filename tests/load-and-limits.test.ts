import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getUserCalls: 0, activeJobs: 0, acceptCalls: 0 }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => { auth.getUserCalls += 1; return { data: { user: null } }; } } }) }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1", email: "a@b.c", email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} } }, error: null })) } })),
  createAdminClient: vi.fn(() => ({ from: (table: string) => (table === "jobs"
    ? { select: () => ({ eq: () => ({ in: async () => ({ count: auth.activeJobs, error: null }) }) }) }
    : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), rpc: async () => ({ data: null, error: null }) })),
}));
vi.mock("../src/lib/server/providerGate", () => ({ getLiveProviderGateStatusFromSettings: vi.fn(async () => ({ isReady: true })) }));
vi.mock("../src/lib/supabase/quoteAccept", () => ({ acceptQuoteSupabase: vi.fn(async () => { auth.acceptCalls += 1; return { success: true }; }) }));

import { BACKGROUND_COUNT_POLL_MS, basePollDelayMs, nextBackgroundDelayMs, nextPollDelayMs } from "../src/lib/pollSchedule";
import { isPublicPath } from "../src/lib/publicPaths";
import { middleware } from "../src/middleware";
import { PUBLIC_LIMITS_PER_MINUTE } from "../src/lib/server/publicRateLimit";
import { DEFAULT_MAX_CONCURRENT_JOBS, evaluateConcurrentJobs, maxConcurrentJobsPerUser } from "../src/lib/server/concurrentJobs";
import { POST as acceptQuote } from "../src/app/api/chat/accept-quote/route";
import { fetchNewestLedgerRows } from "../src/lib/server/typedLedger";
import { checkPlanProviderCapacity, resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { setBusyStateForTesting } from "../src/lib/server/busyState";

afterEach(() => { setBusyStateForTesting(undefined); resetProviderBalanceCacheForTesting(); });

describe("a page following a request asks less as it ages, rarely when hidden, and never in step with the room", () => {
  it("the base delay: 3 s for the first minute, 5 s to five minutes, 10 s to twenty, then 15 s; a hidden tab 30 s", () => {
    expect([0, 59_999, 60_000, 299_999, 300_000, 1_199_999, 1_200_000, 9_999_999].map((ms) => basePollDelayMs(ms, false))).toEqual([3000, 3000, 5000, 5000, 10000, 10000, 15000, 15000]);
    expect(basePollDelayMs(0, true)).toBe(30_000);
  });
  it("jitter is within ±20% and never below one second", () => {
    expect(nextPollDelayMs({ elapsedMs: 0, hidden: false, random: 0 })).toBe(2400);
    expect(nextPollDelayMs({ elapsedMs: 0, hidden: false, random: 0.5 })).toBe(3000);
    expect(nextPollDelayMs({ elapsedMs: 0, hidden: false, random: 0.999999 })).toBe(3600);
    for (const random of [-5, 7, Number.NaN]) expect(nextPollDelayMs({ elapsedMs: -10, hidden: true, random })).toBeGreaterThanOrEqual(1000);
    expect(nextBackgroundDelayMs(0)).toBe(BACKGROUND_COUNT_POLL_MS * 0.8);
  });
  it("the chat page follows a request with a jittered timeout chain that stops on a finished request (no fixed 3-second interval), and the menu count is hidden-aware", () => {
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chat).toContain("nextPollDelayMs(");
    expect(chat).not.toContain("setInterval(poll, 3000)");
    expect(chat).toMatch(/isTerminalJobStatus\(activeJobRef\.current\?\.status\)\) scheduleNext\(\)/);
    const shell = readFileSync("src/components/app/AppShell.tsx", "utf8");
    expect(shell).toContain("nextBackgroundDelayMs(");
    expect(shell).toContain("document.hidden");
    expect(shell).not.toContain("setInterval(load, 20000)");
  });
});

describe("a visitor who only looks never spends a call on the sign-in service", () => {
  it("public pages and status endpoints are public; the dashboard, the admin and every private endpoint are not", () => {
    for (const path of ["/", "/pricing", "/calculator", "/join", "/join/CONF26", "/legal/terms", "/for/students", "/api/busy-status", "/api/calculator/estimate", "/robots.txt"]) expect(isPublicPath(path), path).toBe(true);
    for (const path of ["/dashboard/chat", "/admin", "/admin/conference", "/api/chat", "/api/wallet/balance", "/api/admin/operations", "/login", "/register", "/verify", "/api/chat/accept-quote", "/api/jobs/x/download"]) expect(isPublicPath(path), path).toBe(false);
  });
  it("the middleware does not call the sign-in service for a public path, and still does for the rest", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock";
    auth.getUserCalls = 0;
    await middleware(new NextRequest("http://localhost:3000/"));
    await middleware(new NextRequest("http://localhost:3000/join/CONF26"));
    await middleware(new NextRequest("http://localhost:3000/api/busy-status"));
    expect(auth.getUserCalls).toBe(0);
    await middleware(new NextRequest("http://localhost:3000/login"));
    await middleware(new NextRequest("http://localhost:3000/dashboard/chat"));
    expect(auth.getUserCalls).toBe(2);
  });
});

describe("the public limiters are sized for a room behind one address, and said to be per instance", () => {
  it("hundreds of requests a minute per address, not tens", () => {
    expect(PUBLIC_LIMITS_PER_MINUTE.estimate).toBeGreaterThanOrEqual(300);
    expect(PUBLIC_LIMITS_PER_MINUTE.cap).toBeGreaterThanOrEqual(300);
    expect(PUBLIC_LIMITS_PER_MINUTE.status).toBeGreaterThanOrEqual(1000);
    expect(readFileSync("src/lib/server/publicRateLimit.ts", "utf8")).toContain("memory of one server");
  });
});

describe("one account may not run more requests at once than the room can afford", () => {
  it("three by default, the owner can change it (1 to 20), a bad value falls back", () => {
    expect(DEFAULT_MAX_CONCURRENT_JOBS).toBe(3);
    expect(maxConcurrentJobsPerUser({})).toBe(3);
    expect(maxConcurrentJobsPerUser({ MAX_CONCURRENT_JOBS_PER_USER: "5" })).toBe(5);
    expect(maxConcurrentJobsPerUser({ MAX_CONCURRENT_JOBS_PER_USER: "500" })).toBe(20);
    for (const bad of ["0", "-2", "abc", ""]) expect(maxConcurrentJobsPerUser({ MAX_CONCURRENT_JOBS_PER_USER: bad })).toBe(3);
  });
  it("the sentence says why and that nothing is deducted, in Arabic digits", () => {
    expect(evaluateConcurrentJobs(2, 3)).toMatchObject({ allowed: true, messageAr: "" });
    const refused = evaluateConcurrentJobs(3, 3);
    expect(refused.allowed).toBe(false);
    expect(refused.messageAr).toContain("٣ طلبات قيد التنفيذ");
    expect(refused.messageAr).toContain("ولا يُخصم شيء");
    expect(refused.messageAr).not.toMatch(/[A-Za-z0-9]/);
  });
  it("the approval route refuses a fourth request with 429 before anything is reserved, and lets a third through", async () => {
    const approve = () => acceptQuote(new NextRequest("http://x/api/chat/accept-quote", { method: "POST", body: JSON.stringify({ quoteId: "q1", explicitApproval: true }) }));
    auth.acceptCalls = 0;
    auth.activeJobs = 3;
    const refused = await approve();
    expect(refused.status).toBe(429);
    expect((await refused.json())).toMatchObject({ success: false, concurrentLimit: true, activeJobs: 3, maxJobs: 3 });
    expect(auth.acceptCalls).toBe(0);
    const source = readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8");
    expect(source.indexOf("evaluateConcurrentJobs(")).toBeLessThan(source.indexOf("acceptQuoteSupabase("));
  });
});

describe("the wallet history reads the newest 500 rows in one query", () => {
  it("one bounded read, newest first, never more than 1000, with the typed view and its fallback", async () => {
    const calls: Array<{ table: string; range: [number, number]; orders: string[] }> = [];
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: `r${i}`, user_id: "u1", delta: 1, type: "topup", created_at: `2026-10-0${1 + (i % 9)}T00:00:00Z` }));
    const client = {
      from: (table: string) => {
        const entry = { table, range: [0, 0] as [number, number], orders: [] as string[] };
        const api: any = {
          select: () => api, eq: () => api,
          order: (col: string) => { entry.orders.push(col); return api; },
          range: async (a: number, b: number) => { entry.range = [a, b]; calls.push(entry); return table === "credit_ledger_typed" ? { data: null, error: { code: "42P01", message: 'relation "credit_ledger_typed" does not exist' } } : { data: rows.slice(a, b + 1), error: null }; },
        };
        return api;
      },
    };
    const newest = await fetchNewestLedgerRows(client, { userId: "u1" }, 500);
    expect(newest).toHaveLength(500);
    expect(calls.map((c) => c.table)).toEqual(["credit_ledger_typed", "credit_ledger"]);
    expect(calls.every((c) => c.range[0] === 0 && c.range[1] === 499)).toBe(true);
    expect(calls[0].orders).toEqual(["created_at", "id"]);
    expect((await fetchNewestLedgerRows(client, { userId: "u1" }, 99_999)).length).toBe(1000);
    expect(readFileSync("src/app/api/wallet/history/route.ts", "utf8")).not.toContain("5000");
  });
});

describe("the admin's per-user daily limit also shapes the plan", () => {
  it("a customer with 0.02 USD left of his daily limit is offered what 0.9 × 0.02 pays for, not what the room could afford", async () => {
    setProviderBalanceForTesting(1);
    const open = await checkPlanProviderCapacity(1, 0.1, null, { userRemainingUsd: null });
    expect(open.allowed).toBe(true);
    const limited = await checkPlanProviderCapacity(1, 0.1, null, { userRemainingUsd: 0.02 });
    expect(limited.downscaled).toBe(true);
    expect(limited.safeBudgetUsd).toBeCloseTo(0.018, 6);
    const spent = await checkPlanProviderCapacity(1, 0.1, null, { userRemainingUsd: 0 });
    expect(spent.allowed).toBe(false);
    expect(readFileSync("src/functions/shared/planManager.ts", "utf8")).toContain("readUserSpendToday(");
  });
});
