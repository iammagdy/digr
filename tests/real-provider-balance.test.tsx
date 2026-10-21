import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { checkPlanProviderCapacity, recordProviderCallSpend, resetProviderBalanceCacheForTesting, setMemoryProviderDailySpendUsdForTesting } from "../src/functions/shared/providerSpend";
import { flushProviderLimitsCache } from "../src/lib/server/providerLimits";
import { resetProviderKeyCache } from "../src/lib/server/providerKeys";
import { invalidateProviderStatusCache, resetLastGoodProviderBalanceForTests } from "../src/lib/server/providerStatus";
import { readRealProviderBalance, REAL_BALANCE_MAX_AGE_MS, setRealBalanceReaderForTesting } from "../src/lib/server/realProviderBalance";
import { CAPACITY_LIMITED_REASON_AR } from "../src/lib/jobCaps";
import { createChatDb } from "./helpers/chatSession";

const NOW = Date.parse("2026-10-21T05:00:00Z");
const REAL = 0.9186;
const originalEnv = { credit: process.env.PROVIDER_CREDIT_USD, cap: process.env.PROVIDER_DAILY_SPEND_CAP_USD, token: process.env.TREG_TOKEN };

/** What the owner's admin page showed: 0.9968 USD recorded in total, 0.009 of it today, daily limit 0.9, the provider's own balance 0.9186. */
async function liveSituation() {
  await recordProviderCallSpend(996_800);
  setMemoryProviderDailySpendUsdForTesting(0.009);
}

beforeEach(() => {
  delete process.env.PROVIDER_CREDIT_USD;
  process.env.PROVIDER_DAILY_SPEND_CAP_USD = "0.9";
  resetProviderBalanceCacheForTesting();
  flushProviderLimitsCache();
  resetLastGoodProviderBalanceForTests();
  invalidateProviderStatusCache();
  setRealBalanceReaderForTesting(null);
});

afterEach(() => {
  setRealBalanceReaderForTesting(null);
  for (const [key, value] of [["PROVIDER_CREDIT_USD", originalEnv.credit], ["PROVIDER_DAILY_SPEND_CAP_USD", originalEnv.cap], ["TREG_TOKEN", originalEnv.token]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetProviderBalanceCacheForTesting();
  flushProviderLimitsCache();
  resetProviderKeyCache();
  invalidateProviderStatusCache();
  resetLastGoodProviderBalanceForTests();
});

describe("the capacity gate budgets against the provider's real balance", () => {
  it("the owner's figures: real 0.9186 with 0.9968 recorded -> a normal full-size plan (budget 0.9 x min(real, limit - today))", async () => {
    await liveSituation();
    setRealBalanceReaderForTesting(async () => ({ usd: REAL, at: Date.now() }));
    const check = await checkPlanProviderCapacity(1, 30 * 0.001, null);
    expect(check.balanceSource).toBe("real");
    expect(check.allowed).toBe(true);
    expect(check.downscaled).toBe(false);
    expect(check.availableBalanceUsd).toBe(REAL);
    expect(check.safeBudgetUsd).toBeCloseTo(0.9 * Math.min(REAL, 0.9 - 0.009), 10);
  });

  it("the daily limit still binds: a real balance above the limit is cut by what is left of the day", async () => {
    await liveSituation();
    setMemoryProviderDailySpendUsdForTesting(0.85);
    setRealBalanceReaderForTesting(async () => ({ usd: 5, at: Date.now() }));
    const check = await checkPlanProviderCapacity(1, 1, null);
    expect(check.safeBudgetUsd).toBeCloseTo(0.9 * (0.9 - 0.85), 10);
  });

  it("the live read fails (no answer): the old estimate, unchanged", async () => {
    await liveSituation();
    setRealBalanceReaderForTesting(async () => null);
    const check = await checkPlanProviderCapacity(1, 30 * 0.001, null);
    expect(check.balanceSource).toBe("estimate");
    expect(check.availableBalanceUsd).toBeCloseTo(1 - 0.9968, 4);
    expect(check.downscaled).toBe(true);
    expect(check.maxSafeVolume).toBe(Math.floor(((1 - 0.9968) * 0.9) / (30 * 0.001)));
  });

  it("the live read throws: the old estimate", async () => {
    await liveSituation();
    setRealBalanceReaderForTesting(async () => { throw new Error("network"); });
    const check = await checkPlanProviderCapacity(1, 30 * 0.001, null);
    expect(check.balanceSource).toBe("estimate");
  });

  it("a stale reading (older than a few minutes) is not used: the old estimate", async () => {
    await liveSituation();
    setRealBalanceReaderForTesting(async () => ({ usd: REAL, at: Date.now() - REAL_BALANCE_MAX_AGE_MS - 1_000 }));
    expect((await checkPlanProviderCapacity(1, 30 * 0.001, null)).balanceSource).toBe("estimate");
    setRealBalanceReaderForTesting(async () => ({ usd: REAL, at: Date.now() - REAL_BALANCE_MAX_AGE_MS + 5_000 }));
    expect((await checkPlanProviderCapacity(1, 30 * 0.001, null)).balanceSource).toBe("real");
  });

  it("a negative, non-numeric or infinite balance is never used", async () => {
    await liveSituation();
    for (const usd of [-0.5, Number.NaN, Number.POSITIVE_INFINITY, "0.9186" as unknown as number, null as unknown as number, undefined as unknown as number]) {
      setRealBalanceReaderForTesting(async () => ({ usd, at: Date.now() }));
      const check = await checkPlanProviderCapacity(1, 30 * 0.001, null);
      expect(check.balanceSource, String(usd)).toBe("estimate");
      expect(check.availableBalanceUsd).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(check.safeBudgetUsd)).toBe(true);
    }
  });

  it("a real balance of zero is a real answer: nothing fits, with the existing plain sentence", async () => {
    await liveSituation();
    setRealBalanceReaderForTesting(async () => ({ usd: 0, at: Date.now() }));
    const check = await checkPlanProviderCapacity(1, 30 * 0.001, null);
    expect(check.balanceSource).toBe("real");
    expect(check.allowed).toBe(false);
    expect(check.reasonAr).toContain("سعة الاستخراج الفورية مكتملة حالياً");
  });

  it("a real balance below the plan's cost reduces the plan", async () => {
    await liveSituation();
    setRealBalanceReaderForTesting(async () => ({ usd: 0.02, at: Date.now() }));
    const check = await checkPlanProviderCapacity(1, 30 * 0.001, null);
    expect(check.balanceSource).toBe("real");
    expect(check.downscaled).toBe(true);
    expect(check.safeBudgetUsd).toBeCloseTo(0.018, 10);
    // the planner scales every item by safe budget / plan cost (here 0.018 / 0.03): the customer sees the plain sentence, checked end to end below
    expect(check.safeBudgetUsd).toBeLessThan(30 * 0.001);
  });
});

describe("the plan of a TikTok request, end to end", () => {
  async function plan() {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
    await db.createRow({ tableId: "conversations", rowId: "conv_rb", data: { userId: "user_rb", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    return handler.handleUserMessage({ userId: "user_rb", conversationId: "conv_rb", message: "٣٠ تعليق تيك توك عن كرة القدم في مصر خلال الشهر الماضي", userBalance: 5000 });
  }

  it("with the real balance the plan keeps its full size, with no capacity sentence", async () => {
    await liveSituation();
    setRealBalanceReaderForTesting(async () => ({ usd: REAL, at: Date.now() }));
    const response = await plan();
    expect(response.outputType).toBe("propose_plan");
    expect(response.planQuote.capacityConstrained).toBeFalsy();
    expect(response.planQuote.targetVolumeMax).toBe(30);
    expect(String(response.contentAr)).not.toContain(CAPACITY_LIMITED_REASON_AR);
  });

  it("when the live read fails the plan is cut by the old estimate and says so in the plain sentence", async () => {
    await liveSituation();
    setRealBalanceReaderForTesting(async () => null);
    const response = await plan();
    expect(response.planQuote.capacityConstrained).toBe(true);
    expect(response.planQuote.targetVolumeMax).toBeLessThan(30);
    expect(String(response.contentAr)).toContain(CAPACITY_LIMITED_REASON_AR);
  });

  it("when the real balance is below the plan's cost the plan is reduced with the same sentence", async () => {
    await liveSituation();
    setRealBalanceReaderForTesting(async () => ({ usd: 0.02, at: Date.now() }));
    const response = await plan();
    expect(response.planQuote.capacityConstrained).toBe(true);
    expect(response.planQuote.targetVolumeMax).toBeLessThan(30);
    expect(String(response.contentAr)).toContain(CAPACITY_LIMITED_REASON_AR);
  });
});

describe("the read itself: the admin page's call, cached, bounded, with a fallback", () => {
  const body = (micro: unknown) => JSON.stringify({ balance_micro: micro });
  const makeFetch = (opts: { micro?: unknown; failBalance?: boolean; hang?: boolean }) => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(url);
      if (opts.hang) return new Promise<Response>(() => {});
      if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ org_id: "org_1" }), { status: 200 });
      if (opts.failBalance) return new Response("{}", { status: 500 });
      return new Response(body(opts.micro ?? 918_640), { status: 200 });
    });
    return { fetchFn, calls };
  };

  beforeEach(() => { process.env.TREG_TOKEN = "test-token"; resetProviderKeyCache(); });

  it("reads the balance the provider reports (918,640 micro-dollars = 0.91864) through the same two calls as the admin page", async () => {
    const { fetchFn, calls } = makeFetch({});
    const reading = await readRealProviderBalance(null, { fetchFn: fetchFn as any });
    expect(reading).toMatchObject({ usd: 0.91864, source: "live" });
    expect(calls[0]).toMatch(/\/auth\/me$/);
    expect(calls[1]).toMatch(/\/orgs\/org_1\/balance/);
  });

  it("a second plan within the cache window makes no new call", async () => {
    const { fetchFn } = makeFetch({});
    await readRealProviderBalance(null, { fetchFn: fetchFn as any });
    const callsAfterFirst = fetchFn.mock.calls.length;
    const again = await readRealProviderBalance(null, { fetchFn: fetchFn as any });
    expect(again?.usd).toBe(0.91864);
    expect(fetchFn.mock.calls.length).toBe(callsAfterFirst);
  });

  it("a balance the provider answers with something unreadable or negative is not used", async () => {
    expect(await readRealProviderBalance(null, { fetchFn: makeFetch({ micro: "n/a" }).fetchFn as any })).toBeNull();
    invalidateProviderStatusCache(); resetLastGoodProviderBalanceForTests();
    expect(await readRealProviderBalance(null, { fetchFn: makeFetch({ micro: -5_000 }).fetchFn as any })).toBeNull();
  });

  it("a failing balance call with no earlier reading gives nothing (the caller uses the estimate)", async () => {
    expect(await readRealProviderBalance(null, { fetchFn: makeFetch({ failBalance: true }).fetchFn as any })).toBeNull();
  });

  it("a failing call after a good reading falls back to that reading while it is recent, and not after it is stale", async () => {
    const good = await readRealProviderBalance(null, { fetchFn: makeFetch({}).fetchFn as any });
    expect(good?.source).toBe("live");
    invalidateProviderStatusCache();
    const afterFailure = await readRealProviderBalance(null, { fetchFn: makeFetch({ failBalance: true }).fetchFn as any });
    expect(afterFailure).toMatchObject({ usd: 0.91864, source: "last_reading" });
    invalidateProviderStatusCache();
    const later = await readRealProviderBalance(null, { fetchFn: makeFetch({ failBalance: true }).fetchFn as any, now: () => Date.now() + REAL_BALANCE_MAX_AGE_MS + 1_000 });
    expect(later).toBeNull();
  });

  it("a provider that never answers does not hold the plan: it returns inside the budget", async () => {
    const started = Date.now();
    const reading = await readRealProviderBalance(null, { fetchFn: makeFetch({ hang: true }).fetchFn as any, budgetMs: 60 });
    expect(reading).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("without a key there is no reading", async () => {
    delete process.env.TREG_TOKEN;
    delete process.env.TREG_API_KEY;
    resetProviderKeyCache();
    expect(await readRealProviderBalance(null, { fetchFn: makeFetch({}).fetchFn as any })).toBeNull();
  });
});
