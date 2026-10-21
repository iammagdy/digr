import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SELECT_MAX_ROWS, SELECT_PAGE_SIZE, selectAllRows } from "../src/lib/server/selectAll";
import { readSpendForCeilings } from "../src/lib/server/providerLimits";
import { getDailyProviderSpendUsd, getTotalProviderSpendUsd, resetProviderBalanceCacheForTesting } from "../src/functions/shared/providerSpend";
import { loadProviderLimitsState } from "../src/lib/server/providerLimitsAdmin";

/** A client that answers like PostgREST: at most 1,000 rows per request unless the client asks for a range. */
function postgrest(tables: Record<string, any[]>, log: Array<{ table: string; kind: string; detail?: unknown }> = []) {
  const MAX_ROWS = 1000;
  return {
    from: (table: string) => {
      const preds: Array<(row: any) => boolean> = [];
      let range: [number, number] | null = null;
      let limit = Infinity;
      let order: string | null = null;
      const run = () => {
        let rows = (tables[table] ?? []).filter((row) => preds.every((p) => p(row)));
        if (order) rows = [...rows].sort((a, b) => Number(a[order!]) - Number(b[order!]));
        if (range) return rows.slice(range[0], range[1] + 1);
        return rows.slice(0, Math.min(limit, MAX_ROWS));
      };
      const api: any = {
        select: () => api,
        eq: (col: string, v: unknown) => { preds.push((r) => r[col] === v); return api; },
        gte: (col: string, v: string) => { preds.push((r) => String(r[col]) >= v); return api; },
        in: (col: string, vals: unknown[]) => { log.push({ table, kind: "in", detail: vals.length }); preds.push((r) => vals.includes(r[col])); return api; },
        order: (col: string) => { order = col; return api; },
        limit: (n: number) => { limit = n; return api; },
        range: (from: number, to: number) => { range = [from, to]; log.push({ table, kind: "range", detail: [from, to] }); return Promise.resolve({ data: run(), error: null }); },
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (res: any, rej: any) => Promise.resolve({ data: run(), error: null }).then(res, rej),
      };
      return api;
    },
  };
}

const today = new Date().toISOString();
const costRows = (n: number, jobOf: (i: number) => string, cost = 0.001) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, job_id: jobOf(i), provider: "treg", cost_usd: cost, created_at: today }));
const round = (n: number) => Math.round(n * 1e6) / 1e6;

describe("selectAllRows", () => {
  it("reads every page: 2,500 rows are 2,500 rows, not 1,000", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1 }));
    const log: any[] = [];
    const { data, error, truncated } = await selectAllRows(() => postgrest({ t: rows }, log).from("t").select("id"), { orderBy: "id" });
    expect(error).toBeNull();
    expect(truncated).toBe(false);
    expect(data).toHaveLength(2500);
    expect(new Set(data.map((r: any) => r.id)).size).toBe(2500);
    expect(log.filter((entry) => entry.kind === "range").map((entry) => entry.detail)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    // a plain request is cut at 1,000: this is what the sums did before
    const plain = await postgrest({ t: rows }).from("t").select("id");
    expect(plain.data).toHaveLength(1000);
  });

  it("an exact multiple of the page ends on the empty page, nothing missing and nothing twice", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1 }));
    const { data } = await selectAllRows(() => postgrest({ t: rows }).from("t").select("id"), { orderBy: "id" });
    expect(data).toHaveLength(2000);
  });

  it("an error stops the read and is returned with the rows read so far; a runaway read is cut and says so", async () => {
    let page = 0;
    const failing = () => ({ range: async () => (++page === 2 ? { data: null, error: { message: "boom" } } : { data: Array.from({ length: SELECT_PAGE_SIZE }, (_, i) => ({ i })), error: null }) });
    const result = await selectAllRows(failing as any);
    expect(result.error).toEqual({ message: "boom" });
    expect(result.data).toHaveLength(SELECT_PAGE_SIZE);
    const endless = () => ({ range: async () => ({ data: Array.from({ length: 10 }, (_, i) => ({ i })), error: null }) });
    const cut = await selectAllRows(endless as any, { pageSize: 10, maxRows: 55 });
    expect(cut.truncated).toBe(true);
    expect(cut.data.length).toBeLessThanOrEqual(60);
    expect(SELECT_MAX_ROWS).toBe(200_000);
  });

  it("a query that cannot page is awaited once, exactly as before", async () => {
    const simple = () => Promise.resolve({ data: [{ cost_usd: 1 }, { cost_usd: 2 }], error: null });
    const { data, error } = await selectAllRows(simple as any);
    expect(data).toHaveLength(2);
    expect(error).toBeNull();
    const failing = await selectAllRows((() => Promise.resolve({ data: null, error: { message: "x" } })) as any);
    expect(failing.data).toEqual([]);
    expect(failing.error).toEqual({ message: "x" });
  });
});

describe("the provider spend sums count every row", () => {
  beforeEach(() => resetProviderBalanceCacheForTesting());

  it("this job's spend and this user's spend today are exact with 2,500 cost rows of the job and 3,300 of the day", async () => {
    // job_mine: 2,500 rows; 349 other jobs of other users and 100 more of this user's jobs share the day with it
    const rows = [
      ...costRows(2500, () => "job_mine"),
      ...costRows(400, (i) => `job_mine_${i % 100}`, 0.002),
      ...costRows(400, (i) => `job_other_${i % 349}`, 0.003),
    ].map((row, i) => ({ ...row, id: i + 1 }));
    const jobs = [
      { id: "job_mine", user_id: "u1" },
      ...Array.from({ length: 100 }, (_, i) => ({ id: `job_mine_${i}`, user_id: "u1" })),
      ...Array.from({ length: 349 }, (_, i) => ({ id: `job_other_${i}`, user_id: "u2" })),
    ];
    const log: any[] = [];
    // the user's own jobs of the day are read first (their few jobs), then only their cost rows by job: never every customer's cost rows
    const client = { from: (table: string) => postgrest({ jobs: jobs.map((job) => ({ ...job, updated_at: today })), provider_costs: rows }, log).from(table) };
    const spend = await readSpendForCeilings(client, { jobId: "job_mine", userId: "u1" });
    expect(round(spend.jobUsd)).toBe(round(2500 * 0.001));
    expect(round(spend.userTodayUsd)).toBe(round(2500 * 0.001 + 400 * 0.002));
    // the ids reach the database in groups of at most 100, never as one request with 101 ids
    const groups = log.filter((entry) => entry.table === "provider_costs" && entry.kind === "in").map((entry) => entry.detail as number);
    expect(groups.length).toBeGreaterThan(1);
    expect(Math.max(...groups)).toBeLessThanOrEqual(100);
    // only THIS user's 101 jobs are asked about (a group of 100 and a group of 1; a group read in several pages repeats its size): the 349 jobs of other customers never reach the cost read
    expect([...new Set(groups)].sort((x, y) => x - y)).toEqual([1, 100]);
  });

  it("today's provider spend and the all-time provider spend count 2,500 rows, not the first 1,000", async () => {
    const tables = postgrest({ provider_costs: costRows(2500, (i) => `j${i % 7}`) });
    expect(round(await getDailyProviderSpendUsd(tables as any))).toBe(round(2500 * 0.001));
    expect(round(await getTotalProviderSpendUsd(tables as any))).toBe(round(2500 * 0.001));
  });

  it("the admin page's «spent today» (provider and model) counts every row", async () => {
    const costs = costRows(2500, (i) => `j${i % 7}`);
    const llm = Array.from({ length: 1800 }, (_, i) => ({ id: i + 1, cost_usd: 0.0005, created_at: today }));
    const base = postgrest({ provider_costs: costs, llm_usage: llm, settings_private: [], provider_limits_audit: [] });
    const client = {
      from: (table: string) => (table === "provider_limits_audit"
        ? { select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }
        : base.from(table)),
      rpc: async () => ({ data: null, error: null }),
    };
    const state = await loadProviderLimitsState(client as any);
    expect(round(state.spend.todayUsd)).toBe(round(2500 * 0.001));
    expect(round(state.spend.llmTodayUsd)).toBe(round(1800 * 0.0005));
  });
});

describe("nothing else changed", () => {
  it("the readers only read: no insert, update, delete or function call was added", () => {
    for (const file of ["src/lib/server/selectAll.ts"]) expect(readFileSync(file, "utf8")).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
  });

  it("the daily cap, the limits and the ledger are exactly where they were: the cap function and the ledger balance are untouched", () => {
    const spend = readFileSync("src/functions/shared/providerSpend.ts", "utf8");
    expect(spend).toContain("export async function checkPlanProviderCapacity");
    expect(spend).toContain("export function getConfiguredJobPointsCap");
    expect(spend.match(/selectAllRows/g)?.length).toBe(3); // the import and the two sums
    expect(readFileSync("src/lib/supabase/ledger.ts", "utf8")).not.toContain("selectAllRows");
  });
});
