import { describe, it, expect, vi, beforeEach } from "vitest";

const limits = vi.hoisted(() => ({ llmDailyUsd: 2 }));

vi.mock("../src/lib/server/providerLimits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server/providerLimits")>()),
  resolveProviderLimits: vi.fn(async () => ({ limits: { llmDailyUsd: limits.llmDailyUsd, dailyUsd: 0.8, perJobUsd: null, perUserDailyUsd: null, warnPercent: 80 }, source: "settings" })),
}));

import { SPEND_READ_MAX_PAGES, SPEND_READ_PAGE_SIZE, checkGlobalDailySpendCap, sumTodayLlmCostSupabase } from "../src/functions/shared/rateLimits";

/**
 * A client that behaves like the data API for llm_usage: a read returns at most `maxRows` rows, in id order, and a
 * range read returns the requested slice (also capped). Every request is recorded.
 */
function fakeUsageClient(costs: number[], options: { maxRows?: number; rangeMaxRows?: number; failOnRange?: boolean } = {}) {
  const maxRows = options.maxRows ?? 1000;
  const rows = costs.map((cost_usd, i) => ({ id: i + 1, cost_usd, created_at: "2026-10-19T10:00:00Z" }));
  const requests: Array<{ table: string; ranged: boolean; filtered: boolean }> = [];
  const from = (table: string) => {
    let positive = false;
    let range: [number, number] | null = null;
    const run = () => {
      requests.push({ table, ranged: range !== null, filtered: positive });
      if (range && options.failOnRange) return { data: null, error: { message: "range failed" } };
      let out = rows;
      if (positive) out = out.filter((row) => row.cost_usd > 0);
      if (range) out = out.slice(range[0], range[1] + 1);
      const cap = range ? (options.rangeMaxRows ?? maxRows) : maxRows;
      return { data: out.slice(0, cap).map((row) => ({ cost_usd: row.cost_usd })), error: null };
    };
    const chain: any = {
      select: () => chain,
      gte: () => chain,
      gt: (_col: string, value: number) => { positive = value === 0; return chain; },
      order: () => chain,
      range: (from: number, to: number) => { range = [from, to]; return chain; },
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    };
    return chain;
  };
  return { from, requests };
}

const many = (n: number, cost: number) => Array.from({ length: n }, () => cost);

describe("the daily LLM spend sum reads the whole day, not the first 1000 rows", () => {
  beforeEach(() => {
    limits.llmDailyUsd = 2;
    delete process.env.LLM_DAILY_SPEND_CAP_USD;
  });

  it("under the page size: one plain request, same sum as before", async () => {
    const client = fakeUsageClient(many(999, 0.001));
    const total = await sumTodayLlmCostSupabase(client, "2026-10-19T00:00:00Z");
    expect(total).toBeCloseTo(0.999, 9);
    expect(client.requests).toEqual([{ table: "llm_usage", ranged: false, filtered: false }]);
  });

  it("2500 rows: the first plain read is incomplete, so the day is re-read in stable pages and summed in full", async () => {
    const client = fakeUsageClient(many(2500, 0.001));
    const total = await sumTodayLlmCostSupabase(client, "2026-10-19T00:00:00Z");
    expect(total).toBeCloseTo(2.5, 9);
    // 1 plain read, then pages of 1000, 1000, 500 and one empty page that ends the loop
    const ranged = client.requests.filter((request) => request.ranged);
    expect(client.requests[0]).toEqual({ table: "llm_usage", ranged: false, filtered: false });
    expect(ranged.length).toBe(4);
    expect(ranged.every((request) => request.filtered && request.table === "llm_usage")).toBe(true);
  });

  it("exactly one full page (1000 rows) is still read to the end", async () => {
    const client = fakeUsageClient(many(1000, 0.002));
    expect(await sumTodayLlmCostSupabase(client, "2026-10-19T00:00:00Z")).toBeCloseTo(2, 9);
  });

  it("zero-cost rows are ignored in the sum", async () => {
    const client = fakeUsageClient([...many(2000, 0), ...many(10, 0.01)]);
    expect(await sumTodayLlmCostSupabase(client, "2026-10-19T00:00:00Z")).toBeCloseTo(0.1, 9);
  });

  it("a server that returns fewer rows per page than requested cannot make the paging skip or repeat rows", async () => {
    const client = fakeUsageClient(many(3000, 0.001), { maxRows: 1000, rangeMaxRows: 400 });
    expect(await sumTodayLlmCostSupabase(client, "2026-10-19T00:00:00Z")).toBeCloseTo(3, 9);
  });

  it("a read error in a page throws (the chat route answers 503 for that)", async () => {
    const client = fakeUsageClient(many(2500, 0.001), { failOnRange: true });
    await expect(sumTodayLlmCostSupabase(client, "2026-10-19T00:00:00Z")).rejects.toMatchObject({ message: "range failed" });
  });

  it("a day larger than the page ceiling fails closed instead of guessing", async () => {
    const huge = fakeUsageClient(many(SPEND_READ_PAGE_SIZE * SPEND_READ_MAX_PAGES + 10, 0.000001));
    await expect(sumTodayLlmCostSupabase(huge, "2026-10-19T00:00:00Z")).rejects.toThrow("llm_usage_daily_sum_exceeds_page_ceiling");
  });
});

describe("checkGlobalDailySpendCap uses the full sum", () => {
  beforeEach(() => {
    limits.llmDailyUsd = 2;
    delete process.env.LLM_DAILY_SPEND_CAP_USD;
  });

  it("the first 1000 rows alone (1.0 USD) are under the 2.0 cap but the whole day (2.5 USD) is over it: blocked with 503", async () => {
    const client = fakeUsageClient(many(2500, 0.001));
    const result = await checkGlobalDailySpendCap(client);
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.type).toBe("global_spend_cap");
  });

  it("a day under the cap stays allowed, however many rows it has", async () => {
    const client = fakeUsageClient(many(2500, 0.0004));
    expect((await checkGlobalDailySpendCap(client)).allowed).toBe(true);
  });

  it("a paging failure rejects, so the route's existing 503 protection answer is used", async () => {
    const client = fakeUsageClient(many(2500, 0.001), { failOnRange: true });
    await expect(checkGlobalDailySpendCap(client)).rejects.toBeTruthy();
  });

  it("the cap value itself is unchanged: the same boundary behaves as before", async () => {
    limits.llmDailyUsd = 1;
    // 0.0625 is exact in binary, so 16 rows sum to exactly the cap and 15 rows stay under it
    expect((await checkGlobalDailySpendCap(fakeUsageClient(many(15, 0.0625)))).allowed).toBe(true);
    expect((await checkGlobalDailySpendCap(fakeUsageClient(many(16, 0.0625)))).allowed).toBe(false);
  });
});
