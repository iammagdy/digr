import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limits = vi.hoisted(() => ({ llmDailyUsd: 2 }));
vi.mock("../src/lib/server/providerLimits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server/providerLimits")>()),
  resolveProviderLimits: vi.fn(async () => ({ limits: { llmDailyUsd: limits.llmDailyUsd, dailyUsd: 0.8, perJobUsd: null, perUserDailyUsd: null, warnPercent: 80 }, source: "settings" })),
}));

import { SPEND_READ_CACHE_MS, checkGlobalDailySpendCap, noteLocalLlmSpend, resetSpendReadCacheForTesting } from "../src/functions/shared/rateLimits";

/** A data API stand-in for llm_usage: the rows can grow between checks (other instances' spend), reads are counted, one can fail. */
function usage(initialCosts: number[]) {
  const rows = initialCosts.map((cost_usd, i) => ({ id: i + 1, cost_usd }));
  const state = { reads: 0, failNext: false };
  const from = (table: string) => {
    const chain: any = {
      select: () => chain,
      gte: () => chain,
      gt: () => chain,
      order: () => chain,
      range: () => chain,
      then: (resolve: any, reject: any) => {
        state.reads += 1;
        if (state.failNext) { state.failNext = false; return Promise.resolve({ data: null, error: { message: "read failed" } }).then(resolve, reject); }
        return Promise.resolve({ data: rows.map((row) => ({ cost_usd: row.cost_usd })), error: null }).then(resolve, reject);
      },
    };
    expect(table).toBe("llm_usage");
    return chain;
  };
  return { from, rows, state, add: (cost: number) => rows.push({ id: rows.length + 1, cost_usd: cost }) };
}

const opts = { readCacheMs: SPEND_READ_CACHE_MS };

describe("the daily model-spend READ is kept for a short time by one instance; the cap and the rule are untouched", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
    limits.llmDailyUsd = 2;
    delete process.env.LLM_DAILY_SPEND_CAP_USD;
    resetSpendReadCacheForTesting();
  });
  afterEach(() => vi.useRealTimers());

  it("the window is between 30 and 60 seconds", () => {
    expect(SPEND_READ_CACHE_MS).toBeGreaterThanOrEqual(30_000);
    expect(SPEND_READ_CACHE_MS).toBeLessThanOrEqual(60_000);
  });

  it("without the option nothing is cached: every check reads (the old behaviour, unchanged)", async () => {
    const client = usage([0.5]);
    for (let i = 0; i < 4; i += 1) await checkGlobalDailySpendCap(client);
    expect(client.state.reads).toBe(4);
  });

  it("with the option, 200 checks inside the window make one read", async () => {
    const client = usage([0.5]);
    for (let i = 0; i < 200; i += 1) expect((await checkGlobalDailySpendCap(client, undefined, opts)).allowed).toBe(true);
    expect(client.state.reads).toBe(1);
  });

  it("after the window it reads again, and sees what other instances spent in the meantime", async () => {
    const client = usage([0.5]);
    await checkGlobalDailySpendCap(client, undefined, opts);
    client.add(0.4);
    vi.setSystemTime(Date.now() + SPEND_READ_CACHE_MS + 1);
    await checkGlobalDailySpendCap(client, undefined, opts);
    expect(client.state.reads).toBe(2);
  });

  it("it never under-counts this instance's own spend: spend noted after the read is added to the cached sum", async () => {
    const client = usage([0.5]); // cap 2, 80% of it is 1.6
    expect((await checkGlobalDailySpendCap(client, undefined, opts)).allowed).toBe(true);
    noteLocalLlmSpend(1.0); // this instance spends 1.0 more: cached 0.5 + 1.0 = 1.5, still under the cap and under 1.6
    expect((await checkGlobalDailySpendCap(client, undefined, opts)).allowed).toBe(true);
    expect(client.state.reads).toBe(1);
    noteLocalLlmSpend(0.2); // 1.7 is past 80% of the cap: the next check reads fresh (the database still says 0.5 because the rows are not written in this test)
    expect((await checkGlobalDailySpendCap(client, undefined, opts)).allowed).toBe(true);
    expect(client.state.reads).toBe(2);
  });

  it("a cached sum plus the instance's own spend can refuse by itself, without a read, once it reaches the cap", async () => {
    limits.llmDailyUsd = 1;
    const client = usage([0.1]); // 80% of the cap is 0.8
    await checkGlobalDailySpendCap(client, undefined, opts);
    noteLocalLlmSpend(0.65); // 0.75: still cached and allowed
    expect((await checkGlobalDailySpendCap(client, undefined, opts)).allowed).toBe(true);
    expect(client.state.reads).toBe(1);
    client.add(0.9); // the rows now say 1.0 (the instance wrote its spend)
    noteLocalLlmSpend(0.2); // 0.95 in memory: past 80%, so it reads fresh and the database sum decides
    const refused = await checkGlobalDailySpendCap(client, undefined, opts);
    expect(refused.allowed).toBe(false);
    expect(refused.statusCode).toBe(503);
    expect(refused.type).toBe("global_spend_cap");
  });

  it("near the cap every check reads fresh: a cache never serves the last 20% of the day", async () => {
    limits.llmDailyUsd = 1;
    const client = usage([0.85]); // already past 80%
    for (let i = 0; i < 5; i += 1) await checkGlobalDailySpendCap(client, undefined, opts);
    expect(client.state.reads).toBe(5);
  });

  it("the cap itself is unchanged: the same boundary refuses with the same answer (also through the cache)", async () => {
    limits.llmDailyUsd = 1;
    // 0.0625 is exact in binary: 16 rows sum to exactly the cap
    const exact = await checkGlobalDailySpendCap(usage(Array.from({ length: 16 }, () => 0.0625)), undefined, opts);
    expect(exact.allowed).toBe(false);
    expect(exact.type).toBe("global_spend_cap");
    resetSpendReadCacheForTesting();
    expect((await checkGlobalDailySpendCap(usage(Array.from({ length: 15 }, () => 0.0625)), undefined, opts)).allowed).toBe(true);
  });

  it("a failed read throws (the route answers 503) and nothing stale is served afterwards", async () => {
    const client = usage([0.5]);
    await checkGlobalDailySpendCap(client, undefined, opts);
    vi.setSystemTime(Date.now() + SPEND_READ_CACHE_MS + 1);
    client.state.failNext = true;
    await expect(checkGlobalDailySpendCap(client, undefined, opts)).rejects.toBeTruthy();
    // the window is over and the read failed: the old sum is not reused, the next check reads again
    const reads = client.state.reads;
    await checkGlobalDailySpendCap(client, undefined, opts);
    expect(client.state.reads).toBe(reads + 1);
  });

  it("a new day never reuses yesterday's sum", async () => {
    const client = usage([1.5]);
    await checkGlobalDailySpendCap(client, undefined, opts);
    vi.setSystemTime(new Date("2026-10-24T00:00:05Z"));
    await checkGlobalDailySpendCap(client, undefined, opts);
    expect(client.state.reads).toBe(2);
  });

  it("the chat route asks for the cache and the handler notes its spend before the usage row is written", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("src/app/api/chat/route.ts", "utf8");
    expect(route).toContain("checkGlobalDailySpendCap(tables, undefined, { readCacheMs: SPEND_READ_CACHE_MS })");
    const handler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    const notes = [...handler.matchAll(/noteLocalLlmSpend\(/g)].length;
    expect(notes).toBe(2);
    for (const marker of ['await sb.from("llm_usage").insert({\n          user_id: input.userId', 'await sb.from("llm_usage").insert({\n            user_id: userId']) {
      const at = handler.indexOf(marker);
      expect(at).toBeGreaterThan(0);
      expect(handler.lastIndexOf("noteLocalLlmSpend(", at)).toBeGreaterThan(at - 400);
    }
  });
});
