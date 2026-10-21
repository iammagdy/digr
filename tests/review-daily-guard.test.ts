import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** Everything the chat route and the daily guard's read touch on the data API, in order, so the tests can say what the chat did NOT do. */
const chatDb = vi.hoisted(() => ({ tables: [] as string[], likes: [] as Array<[string, string]>, usageCosts: [] as number[], usageFails: false }));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user_chat_1", email: "a@diger.test", email_confirmed_at: "2026-10-12T00:00:00Z" } }, error: null })) },
  })),
  createAdminClient: vi.fn(() => ({
    storage: { from: vi.fn(() => ({ download: vi.fn(async () => ({ data: null, error: new Error("none") })) })) },
    from: vi.fn((table: string) => {
      chatDb.tables.push(table);
      const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        like: vi.fn((column: string, pattern: string) => { chatDb.likes.push([column, pattern]); return chain; }),
        gte: vi.fn(() => chain),
        gt: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        range: vi.fn(async () => (chatDb.usageFails ? { data: null, error: { message: "read failed" } } : { data: chatDb.usageCosts.map((cost_usd) => ({ cost_usd })), error: null })),
        maybeSingle: vi.fn(async () => (table === "settings_public" ? { data: { value: { daily_cap_usd: 100 } }, error: null } : { data: null, error: null })),
        single: vi.fn(async () => ({ data: null, error: null })),
        insert: vi.fn(async () => ({ data: null, error: null })),
        update: vi.fn(() => chain),
        then: (resolve: any) => resolve(table === "llm_usage" && !chatDb.usageFails ? { data: chatDb.usageCosts.map((cost_usd) => ({ cost_usd })), count: 0, error: null } : { data: [], count: 0, error: null }),
      };
      return chain;
    }),
    rpc: vi.fn(async () => ({ data: { allowed: true }, error: null })),
  })),
}));

import { POST as postChat } from "../src/app/api/chat/route";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { checkGlobalDailySpendCap, resetSpendReadCacheForTesting } from "../src/functions/shared/rateLimits";
import {
  noteReviewSpend, readReviewSpendTodayUsd, resolveReviewBudget, REVIEW_DAILY_CACHE_MS, reviewSpendToday, setReviewDailyGuardForTesting, utcDayStartIso,
} from "../src/lib/server/reviewDailyGuard";
import {
  REVIEW_DAILY_CEILING_USD, REVIEW_JOB_CEILING_USD, REVIEW_MIN_BUDGET_USD, socialReviewCapPreviousRuleUsd, socialReviewCapUsd,
} from "../src/lib/server/rowReviewAdvisor";
import { isCustomerVisibleJobEvent, REVIEW_FALLBACK_EVENT_TYPE } from "../src/lib/reviewCostEvent";
import { reviewFallbackEventMessage } from "../src/lib/server/reviewSpendLog";
import { emptyRunningSet, extendRunningSet } from "../src/lib/server/jobRunningSet";

const NOW = Date.parse("2026-10-23T10:00:00Z");

/** A data API stand-in for the review rows of `llm_usage`: rows can grow between reads (other instances), reads are counted, one can fail. */
function usageClient(costs: number[]) {
  const state = { reads: 0, fail: false, throwNext: false, sinces: [] as string[], likes: [] as string[], ranges: [] as Array<[number, number]> };
  const rows = costs.slice();
  const chain: any = {
    select: () => chain,
    like: (_column: string, pattern: string) => { state.likes.push(pattern); return chain; },
    gte: (_column: string, since: string) => { state.sinces.push(since); return chain; },
    order: () => chain,
    range: async (from: number, to: number) => {
      state.reads += 1;
      state.ranges.push([from, to]);
      if (state.throwNext) { state.throwNext = false; throw new Error("network"); }
      if (state.fail) return { data: null, error: { message: "read failed" } };
      return { data: rows.slice(from, to + 1).map((cost_usd) => ({ cost_usd })), error: null };
    },
  };
  return { admin: { from: (table: string) => { expect(table).toBe("llm_usage"); return chain; } }, state, rows };
}

describe("the daily review ceiling and its fallback rule", () => {
  it("the daily ceiling is one constant of 12 USD; the per-job ceiling and the one-call floor are unchanged", () => {
    expect(REVIEW_DAILY_CEILING_USD).toBe(12);
    expect(REVIEW_JOB_CEILING_USD).toBe(0.15);
    expect(REVIEW_MIN_BUDGET_USD).toBe(0.0083);
  });

  it("the previous rule is exactly the old one: 20% of the expected revenue, never below one full call, 0 without a price", () => {
    expect(socialReviewCapPreviousRuleUsd(30, 0.11715)).toBe(0.0083);
    expect(socialReviewCapPreviousRuleUsd(300, 0.11715)).toBe(0.01309);
    expect(socialReviewCapPreviousRuleUsd(500, 0.11715)).toBe(0.021454);
    expect(socialReviewCapPreviousRuleUsd(1000, 0.11715)).toBe(0.042909);
    expect(socialReviewCapPreviousRuleUsd(4000, 0.11715)).toBe(0.170545);
    expect(socialReviewCapPreviousRuleUsd(300, 0.275)).toBe(0.030181);
    expect(socialReviewCapPreviousRuleUsd(1000, 0.275)).toBe(0.1);
    expect(socialReviewCapPreviousRuleUsd(20, 3.4485)).toBe(0.02509);
    expect(socialReviewCapPreviousRuleUsd(5, 3.168)).toBe(0.0083);
    expect(socialReviewCapPreviousRuleUsd(10, 0)).toBe(0);
    expect(socialReviewCapPreviousRuleUsd(10, Number.NaN)).toBe(0);
  });

  it("the review_fallback row is internal: it has its own type, the customer never sees it, and its message carries no row content", () => {
    expect(REVIEW_FALLBACK_EVENT_TYPE).toBe("review_fallback");
    expect(isCustomerVisibleJobEvent("review_fallback")).toBe(false);
    expect(isCustomerVisibleJobEvent("progress")).toBe(true);
    expect(reviewFallbackEventMessage({ step: 2, reason: "daily_ceiling", todayUsd: 12.5, ceilingUsd: 12, capUsd: 0.0083 })).toBe("review_fallback step=2 reason=daily_ceiling today_usd=12.500000 daily_ceiling_usd=12 job_cap_usd=0.008300");
    expect(reviewFallbackEventMessage({ step: 0, reason: "read_failed", todayUsd: null, ceilingUsd: 12, capUsd: 0.0083 })).toBe("review_fallback step=0 reason=read_failed today_usd=unknown daily_ceiling_usd=12 job_cap_usd=0.008300");
  });

  it("the running record keeps the fallback flag once set, and a record with a flag that is not a boolean is not trusted", () => {
    const first = extendRunningSet(emptyRunningSet(), 0, { rows: [], reviewFallback: true }, () => null);
    expect(first.reviewFallback).toBe(true);
    const second = extendRunningSet(first, 1, { rows: [] }, () => null);
    expect(second.reviewFallback).toBe(true);
    expect(extendRunningSet(emptyRunningSet(), 0, { rows: [] }, () => null).reviewFallback).toBeUndefined();
  });
});

describe("the read of today's review spend", () => {
  it("sums only the review rows of the UTC day, in pages: 2,500 rows are read in 3 pages", async () => {
    const client = usageClient(Array.from({ length: 2500 }, () => 0.004));
    const total = await readReviewSpendTodayUsd(client.admin, NOW);
    expect(total).toBeCloseTo(10, 6);
    expect(client.state.reads).toBe(3);
    expect(client.state.ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(client.state.likes).toEqual(["relevance_review%", "relevance_review%", "relevance_review%"]);
    expect(client.state.sinces).toEqual(Array(3).fill("2026-10-23T00:00:00.000Z"));
  });

  it("the day starts at 00:00 UTC, not Cairo time", () => {
    expect(utcDayStartIso(Date.parse("2026-10-23T23:59:59Z"))).toBe("2026-10-23T00:00:00.000Z");
    expect(utcDayStartIso(Date.parse("2026-10-24T00:00:01Z"))).toBe("2026-10-24T00:00:00.000Z");
  });

  it("a failed read, a read that throws and a read that never reaches the last row give null, never a partial sum", async () => {
    const failing = usageClient([5]);
    failing.state.fail = true;
    expect(await readReviewSpendTodayUsd(failing.admin, NOW)).toBeNull();
    const throwing = usageClient([5]);
    throwing.state.throwNext = true;
    expect(await readReviewSpendTodayUsd(throwing.admin, NOW)).toBeNull();
    expect(await readReviewSpendTodayUsd({ from: () => { throw new Error("no table"); } }, NOW)).toBeNull();
    const endless = usageClient(Array.from({ length: 30_000 }, () => 0.0001));
    expect(await readReviewSpendTodayUsd(endless.admin, NOW)).toBeNull();
    expect(endless.state.reads).toBe(30);
  });
});

describe("the budget decision of a job", () => {
  beforeEach(() => { setReviewDailyGuardForTesting("real"); });
  afterEach(() => { setReviewDailyGuardForTesting(undefined); });
  const decide = (admin: any, extra: Record<string, unknown> = {}) => resolveReviewBudget({ admin, targetMax: 300, unitPricePoints: 0.11715, now: NOW, ...extra });

  it("below the ceiling (11.99 of 12 USD): the per-job budget of 0.15 USD, no fallback", async () => {
    expect(await decide(usageClient([11.99]).admin)).toEqual({ capUsd: 0.15, rule: "normal", fresh: false, todayUsd: 11.99 });
  });

  it("at the ceiling (12 USD) and above it: the previous rule (0.01309 USD for 300 X posts), flagged fresh so one row is written", async () => {
    expect(await decide(usageClient([12]).admin)).toEqual({ capUsd: 0.01309, rule: "daily_ceiling", fresh: true, todayUsd: 12 });
    setReviewDailyGuardForTesting("real");
    expect(await decide(usageClient([12.0001]).admin)).toMatchObject({ capUsd: 0.01309, rule: "daily_ceiling", fresh: true });
  });

  it("a small job under the previous rule gets the one-call floor, and the fallback is never above the per-job budget", async () => {
    const small = await resolveReviewBudget({ admin: usageClient([12]).admin, targetMax: 30, unitPricePoints: 0.11715, now: NOW });
    expect(small.capUsd).toBe(0.0083);
    setReviewDailyGuardForTesting("real");
    const huge = await resolveReviewBudget({ admin: usageClient([12]).admin, targetMax: 4000, unitPricePoints: 0.11715, now: NOW });
    expect(socialReviewCapPreviousRuleUsd(4000, 0.11715)).toBe(0.170545);
    expect(huge.capUsd).toBe(REVIEW_JOB_CEILING_USD);
  });

  it("when the read fails or throws: the previous rule, never the 0.15 ceiling, and the row says the read failed", async () => {
    const failing = usageClient([0]);
    failing.state.fail = true;
    expect(await decide(failing.admin)).toEqual({ capUsd: 0.01309, rule: "read_failed", fresh: true, todayUsd: null });
    setReviewDailyGuardForTesting("real");
    expect(await decide({ from: () => { throw new Error("down"); } })).toEqual({ capUsd: 0.01309, rule: "read_failed", fresh: true, todayUsd: null });
  });

  it("a job already on the previous rule keeps it with no read; a job already reviewing keeps its rule with no read, whatever the day says", async () => {
    const client = usageClient([100]);
    expect(await decide(client.admin, { stickyFallback: true })).toEqual({ capUsd: 0.01309, rule: "job_fallback", fresh: false, todayUsd: null });
    expect(await decide(client.admin, { alreadyReviewing: true })).toEqual({ capUsd: 0.15, rule: "normal", fresh: false, todayUsd: null });
    expect(client.state.reads).toBe(0);
  });

  it("no valid price: no review budget under any rule", async () => {
    expect((await resolveReviewBudget({ admin: usageClient([0]).admin, targetMax: 300, unitPricePoints: 0, now: NOW })).capUsd).toBe(0);
    setReviewDailyGuardForTesting("real");
    expect((await resolveReviewBudget({ admin: usageClient([12]).admin, targetMax: 300, unitPricePoints: 0, now: NOW })).capUsd).toBe(0);
  });

  it("in tests the guard is off unless a test switches it on: the per-job budget, no read", async () => {
    setReviewDailyGuardForTesting(undefined);
    const client = usageClient([100]);
    expect((await decide(client.admin)).capUsd).toBe(socialReviewCapUsd(300, 0.11715));
    expect(client.state.reads).toBe(0);
  });
});

describe("the cached read: one read per instance per window, own spend added, failures kept for the window", () => {
  beforeEach(() => { setReviewDailyGuardForTesting("real"); });
  afterEach(() => { setReviewDailyGuardForTesting(undefined); });

  it("the window is between 30 and 60 seconds", () => {
    expect(REVIEW_DAILY_CACHE_MS).toBeGreaterThanOrEqual(30_000);
    expect(REVIEW_DAILY_CACHE_MS).toBeLessThanOrEqual(60_000);
  });

  it("200 decisions inside the window make ONE read", async () => {
    const client = usageClient([5]);
    for (let i = 0; i < 200; i += 1) expect((await resolveReviewBudget({ admin: client.admin, targetMax: 300, unitPricePoints: 0.11715, now: NOW + i })).rule).toBe("normal");
    expect(client.state.reads).toBe(1);
  });

  it("200 concurrent decisions share ONE read", async () => {
    const client = usageClient([5]);
    await Promise.all(Array.from({ length: 200 }, () => resolveReviewBudget({ admin: client.admin, targetMax: 300, unitPricePoints: 0.11715, now: NOW })));
    expect(client.state.reads).toBe(1);
  });

  it("after the window it reads again and sees what other instances spent meanwhile", async () => {
    const client = usageClient([5]);
    expect(await reviewSpendToday(client.admin, NOW)).toBe(5);
    client.rows.push(7.5);
    expect(await reviewSpendToday(client.admin, NOW + REVIEW_DAILY_CACHE_MS - 1)).toBe(5);
    expect(await reviewSpendToday(client.admin, NOW + REVIEW_DAILY_CACHE_MS)).toBe(12.5);
    expect(client.state.reads).toBe(2);
    expect((await resolveReviewBudget({ admin: client.admin, targetMax: 300, unitPricePoints: 0.11715, now: NOW + REVIEW_DAILY_CACHE_MS })).rule).toBe("daily_ceiling");
  });

  it("it never under-counts this instance's own spend: spend noted after the read is added to the cached sum, with no new read", async () => {
    const client = usageClient([11.9]);
    expect((await resolveReviewBudget({ admin: client.admin, targetMax: 300, unitPricePoints: 0.11715, now: NOW })).rule).toBe("normal");
    noteReviewSpend(0.05);
    expect((await resolveReviewBudget({ admin: client.admin, targetMax: 300, unitPricePoints: 0.11715, now: NOW + 1 })).rule).toBe("normal");
    noteReviewSpend(0.05); // 11.9 + 0.1 = 12.0: the ceiling
    const decision = await resolveReviewBudget({ admin: client.admin, targetMax: 300, unitPricePoints: 0.11715, now: NOW + 2 });
    expect(decision.rule).toBe("daily_ceiling");
    expect(decision.todayUsd).toBeCloseTo(12, 6);
    expect(client.state.reads).toBe(1);
  });

  it("junk spend notes (negative, NaN) change nothing", async () => {
    const client = usageClient([5]);
    await reviewSpendToday(client.admin, NOW);
    noteReviewSpend(-3); noteReviewSpend(Number.NaN); noteReviewSpend(Number.POSITIVE_INFINITY);
    expect(await reviewSpendToday(client.admin, NOW + 1)).toBe(5);
  });

  it("a failed read is kept for the window (no hammering), then the next read recovers", async () => {
    const client = usageClient([5]);
    client.state.fail = true;
    for (let i = 0; i < 5; i += 1) expect((await resolveReviewBudget({ admin: client.admin, targetMax: 300, unitPricePoints: 0.11715, now: NOW + i })).rule).toBe("read_failed");
    expect(client.state.reads).toBe(1);
    client.state.fail = false;
    expect((await resolveReviewBudget({ admin: client.admin, targetMax: 300, unitPricePoints: 0.11715, now: NOW + REVIEW_DAILY_CACHE_MS })).rule).toBe("normal");
    expect(client.state.reads).toBe(2);
  });

  it("a new UTC day starts a new read at once, whatever the window", async () => {
    const client = usageClient([5]);
    await reviewSpendToday(client.admin, Date.parse("2026-10-23T23:59:50Z"));
    await reviewSpendToday(client.admin, Date.parse("2026-10-24T00:00:05Z"));
    expect(client.state.reads).toBe(2);
    expect(client.state.sinces).toEqual(["2026-10-23T00:00:00.000Z", "2026-10-24T00:00:00.000Z"]);
  });
});

describe("the review path never blocks the chat", () => {
  beforeEach(() => {
    clearBriefCacheForTesting();
    resetSpendReadCacheForTesting();
    chatDb.tables = []; chatDb.likes = []; chatDb.usageCosts = []; chatDb.usageFails = false;
  });
  afterEach(() => { setReviewDailyGuardForTesting(undefined); });

  const chat = async () => {
    const res = await postChat(new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid_jwt_token" },
      body: JSON.stringify({ conversationId: "conv_guard_test", message: "عايز 50 شركة مقاولات كهروميكانيكية في مصر مع استبعاد الشركات اللي في الملف", uploadedFiles: [] }),
    }));
    return { status: res.status, body: await res.json() };
  };

  it("the chat route and the chat handler do not use the review code or the guard at all", () => {
    for (const file of ["src/app/api/chat/route.ts", "src/functions/shared/chatHandler.ts", "src/functions/shared/rateLimits.ts"]) {
      const source = readFileSync(file, "utf-8");
      expect(source, file).not.toMatch(/reviewDailyGuard|resolveReviewBudget|rowReviewAdvisor|sampledReview|REVIEW_DAILY_CEILING_USD|socialReviewCap/);
    }
  });

  it("with the daily review ceiling reached, the chat answers exactly as without it, and never reads the review spend", async () => {
    const without = await chat();
    expect(without.status).toBe(200);
    expect(without.body.outputType).toBe("ask_clarification");

    chatDb.tables = []; chatDb.likes = [];
    chatDb.usageCosts = [12, 3];
    setReviewDailyGuardForTesting("real");
    const decision = await resolveReviewBudget({ admin: { from: () => { throw new Error("unused"); } }, targetMax: 300, unitPricePoints: 0.11715, now: NOW });
    expect(decision.rule).toBe("read_failed");
    chatDb.tables = []; chatDb.likes = [];

    const reached = await chat();
    expect(reached.status).toBe(200);
    expect(reached.body.success).toBe(true);
    expect(reached.body.outputType).toBe(without.body.outputType);
    expect(reached.body.contentAr).toBe(without.body.contentAr);
    expect(chatDb.likes.filter(([, pattern]) => pattern.startsWith("relevance_review"))).toEqual([]);
  });

  it("with the review read failing, the chat answers exactly as without it", async () => {
    const without = await chat();
    chatDb.usageFails = true;
    setReviewDailyGuardForTesting("real");
    const failedRead = await resolveReviewBudget({ admin: usageClient([0]).admin, targetMax: 300, unitPricePoints: 0.11715, now: NOW });
    expect(["normal", "read_failed"]).toContain(failedRead.rule);
    chatDb.usageFails = false;
    const after = await chat();
    expect(after.status).toBe(without.status);
    expect(after.body.contentAr).toBe(without.body.contentAr);
  });

  it("the chat's own daily model-spend cap keeps its rule: review spend at the review ceiling (12 USD of the 50 USD cap) leaves the chat allowed, 50 USD refuses it, as before", async () => {
    const tables = (costs: number[]) => ({ from: () => ({ select: () => ({ gte: async () => ({ data: costs.map((cost_usd) => ({ cost_usd })), error: null }) }) }) });
    expect((await checkGlobalDailySpendCap(tables([12]))).allowed).toBe(true);
    expect((await checkGlobalDailySpendCap(tables([12, 0.0131 * 100]))).allowed).toBe(true);
    const refused = await checkGlobalDailySpendCap(tables([50]));
    expect(refused.allowed).toBe(false);
  });
});
