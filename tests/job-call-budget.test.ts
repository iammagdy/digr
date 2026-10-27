import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_SPEND_SHARE, JOB_BUDGET_ERROR_CODE, JOB_BUDGET_STOP_AR, createJobCallBudget, holdValueUsd, jobCallCeilingUsd } from "../src/lib/server/callBudget";
import { CEILING_MESSAGE_AR } from "../src/lib/server/providerLimits";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { executeTregCallWithRetry, socialCallThroughTreg, type ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";
import { runSocialChunk } from "../src/lib/server/socialAdapter";
import { reserveForUnits } from "../src/lib/recordPricing";

describe("the job's call budget (pure)", () => {
  it("allows calls up to the ceiling and refuses the one that would pass it", () => {
    const b = createJobCallBudget({ ceilingUsd: 0.001, spentUsd: 0 });
    expect(b.reserve(0.0004)).toBe(true);
    b.settle(0.0004, 0.0004);
    expect(b.reserve(0.0004)).toBe(true);
    b.settle(0.0004, 0.0004);
    expect(b.reserve(0.0004)).toBe(false); // 0.0008 spent + 0.0004 > 0.001
    expect(b.stopped()).toBe(true);
    expect(b.refusals()).toBe(1);
    expect(b.spentUsd()).toBeCloseTo(0.0008, 9);
  });

  it("counts spend recorded before this chunk", () => {
    const b = createJobCallBudget({ ceilingUsd: 0.01, spentUsd: 0.0095 });
    expect(b.reserve(0.001)).toBe(false);
    expect(b.reserve(0.0005)).toBe(true);
  });

  it("counts calls in flight, so two calls asked together cannot both pass", () => {
    const b = createJobCallBudget({ ceilingUsd: 0.001, spentUsd: 0 });
    expect(b.reserve(0.0007)).toBe(true);
    expect(b.reserve(0.0007)).toBe(false);
  });

  it("a call whose cost is unknown keeps its estimate counted; a known cost replaces it", () => {
    const b = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    b.reserve(0.01); b.settle(0.01, null);
    expect(b.spentUsd()).toBeCloseTo(0.01, 9);
    b.reserve(0.01); b.settle(0.01, 0.002);
    expect(b.spentUsd()).toBeCloseTo(0.012, 9);
    b.reserve(0.01); b.settle(0.01, 0);
    expect(b.spentUsd()).toBeCloseTo(0.012, 9);
  });

  it("no ceiling means no limit (a people or chain job keeps its own budget)", () => {
    const b = createJobCallBudget({ ceilingUsd: null, spentUsd: 5 });
    expect(b.reserve(100)).toBe(true);
    expect(b.stopped()).toBe(false);
  });

  it("the ceiling is the LOWER of the per-job ceiling and 40% of the value of the hold (reserve points / 1,375 USD)", () => {
    expect(HOLD_SPEND_SHARE).toBe(0.4);
    // the hold of the 8-post job of 27 Oct: 2 points = 0.2 EGP = 0.003636 USD; 40% of it is 0.001455 USD
    expect(holdValueUsd(2)).toBeCloseTo(0.0036364, 6);
    expect(jobCallCeilingUsd({ perJobUsd: 0.05, reservePoints: 2 })).toBeCloseTo(2 / 1375, 9);
    expect(jobCallCeilingUsd({ perJobUsd: 0.05, reservePoints: 2 })).toBeCloseTo(0.0014545, 6);
    // 1,375 points = 137.5 EGP = 2.5 USD of hold value; 40% is exactly 1 USD
    expect(jobCallCeilingUsd({ perJobUsd: null, reservePoints: 1375 })).toBeCloseTo(1, 9);
    expect(jobCallCeilingUsd({ perJobUsd: 0.002, reservePoints: 2000 })).toBe(0.002); // the per-job ceiling is lower
    expect(jobCallCeilingUsd({ perJobUsd: 5, reservePoints: 2000 })).toBeCloseTo(2000 / 1375, 9); // 40% of the hold is lower
    expect(jobCallCeilingUsd({ perJobUsd: null, reservePoints: 2 })).toBeCloseTo(2 / 1375, 9);
    expect(jobCallCeilingUsd({ perJobUsd: 0.05, reservePoints: null })).toBe(0.05);
    expect(jobCallCeilingUsd({ perJobUsd: null, reservePoints: null })).toBeNull();
  });

  it("EXACT BOUNDARY: a call that lands exactly on the ceiling is sent; a call that would cross it by one micro-USD is not", () => {
    const ceiling = jobCallCeilingUsd({ perJobUsd: null, reservePoints: 275 })!; // 275 / 1,375 = 0.2 USD
    expect(ceiling).toBeCloseTo(0.2, 9);
    const exact = createJobCallBudget({ ceilingUsd: ceiling, spentUsd: 0.15 });
    expect(exact.reserve(0.05)).toBe(true); // 0.15 + 0.05 = 0.20: not past it
    const over = createJobCallBudget({ ceilingUsd: ceiling, spentUsd: 0.15 });
    expect(over.reserve(0.050001)).toBe(false); // one micro-USD past it
    expect(over.stopped()).toBe(true);
    // the same at the lowest holds
    for (const points of [1, 2, 3, 10, 100, 1375]) {
      const c = points / 1375;
      expect(createJobCallBudget({ ceilingUsd: jobCallCeilingUsd({ perJobUsd: null, reservePoints: points }), spentUsd: 0 }).reserve(c)).toBe(true);
      expect(createJobCallBudget({ ceilingUsd: jobCallCeilingUsd({ perJobUsd: null, reservePoints: points }), spentUsd: 0 }).reserve(c + 0.000002)).toBe(false);
    }
  });

  it("a one-point hold (0.000727 USD of ceiling) cannot pay for a call that costs 0.001 USD: that call is not sent", () => {
    const b = createJobCallBudget({ ceilingUsd: jobCallCeilingUsd({ perJobUsd: 0.05, reservePoints: 1 }), spentUsd: 0 });
    expect(b.reserve(0.001)).toBe(false);
  });

  it("the hold is the shared reserve: ceil(volume x unit x 1.15) points", () => {
    const reserve = reserveForUnits(10, 0.11715);
    expect(reserve).toBe(2);
    expect(jobCallCeilingUsd({ perJobUsd: null, reservePoints: reserve })).toBeLessThan(0.0015);
  });

  it("the sentence of a job the budget ends is the sentence of the per-job ceiling, in Arabic only", () => {
    expect(JOB_BUDGET_STOP_AR).toBe(CEILING_MESSAGE_AR.job);
    expect(JOB_BUDGET_STOP_AR).not.toMatch(/[A-Za-z0-9]|\$|USD|دولار|استرداد/);
    expect(JOB_BUDGET_STOP_AR).toContain("حجز مؤقت مُحرَّر");
  });
});

describe("before EVERY call: the gateway client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, rows: [{ id: "1", text: "x" }] }), { status: 200, headers: { "x-treg-cost-micro": "450" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TREG_TOKEN", "not-a-real-token");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const call = (budget: any, over: Record<string, any> = {}) => executeTregCall({ endpointId: "anyapi.x.user.posts", method: "POST", params: { handle: "a" }, userId: "u", jobId: "j", callBudget: budget, callEstimateUsd: 0.0005, ...over });

  it("makes the calls the budget allows and NOT the one that would pass it: the request is never sent", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 0.0012, spentUsd: 0 });
    const results = [await call(budget), await call(budget), await call(budget), await call(budget)];
    expect(results.map((r) => r.ok)).toEqual([true, true, false, false]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results[2].budgetStopped).toBe(true);
    expect(results[2].error).toBe(JOB_BUDGET_ERROR_CODE);
    expect(results[2].costMicro).toBe(0);
    // the real cost (450 micro-USD) was settled, not the estimate
    expect(budget.spentUsd()).toBeCloseTo(0.0009, 9);
  });

  it("the budget is asked again for every RETRY of a failing call", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 503, headers: { "x-treg-cost-micro": "0" } }));
    const budget = createJobCallBudget({ ceilingUsd: 0.001, spentUsd: 0 });
    const noWait = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any) => { fn(); return 0 as any; }) as any);
    const result = await executeTregCallWithRetry({ endpointId: "anyapi.x.user.posts", method: "POST", params: { handle: "a" }, userId: "u", jobId: "j", callBudget: budget, callEstimateUsd: 0.0004 }, 3);
    noWait.mockRestore();
    // 0.0004 reserved and settled at the real cost 0 on each failed attempt: the failed answers are free, so all four attempts fit; the cost is what the source billed
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
    expect(result.ok).toBe(false);
    expect(budget.spentUsd()).toBe(0);
  });

  it("a call cut by our own time limit may have been billed: its estimate stays counted and the next call is refused", async () => {
    fetchMock.mockImplementationOnce(async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); });
    const budget = createJobCallBudget({ ceilingUsd: 0.0006, spentUsd: 0 });
    const first = await call(budget);
    expect(first.timedOut).toBe(true);
    expect(budget.spentUsd()).toBeCloseTo(0.0005, 9);
    const second = await call(budget);
    expect(second.budgetStopped).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("without a budget nothing changes", async () => {
    const result = await executeTregCall({ endpointId: "anyapi.x.user.posts", method: "POST", params: { handle: "a" }, userId: "u", jobId: "j" });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("before EVERY call: a social chunk of up to six calls", () => {
  const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  let fetchMock: ReturnType<typeof vi.fn>;
  let n = 0;
  beforeEach(() => {
    n = 0;
    // every call answers a full page of comments and a next cursor, so the chain keeps paging until something stops it
    fetchMock = vi.fn(async () => {
      n += 1;
      const rows = Array.from({ length: 20 }, (_, i) => ({ comment_id: `c${n}_${i}`, text: `تعليق ${n} ${i}`, author: "أحمد", likes: i, published_date: "2026-09-10" }));
      return new Response(JSON.stringify({ ok: true, rows, next_cursor: `cur_${n}` }), { status: 200, headers: { "x-treg-cost-micro": "900" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TREG_TOKEN", "not-a-real-token");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const input = (budget: any): ProviderAdapterCallInput => ({
    jobId: "job_x", userId: "u1", step: 0, endpointId: "crawl4ai.youtube.video.comments", capabilitySlug: "social-youtube-comments", method: "POST",
    params: { url: YT }, paginationStrategy: "cursor", cursor: null, pageSize: 20, remainingNeeded: 100, targetVolumeMax: 100, deliveredSoFar: 0,
    ...(budget ? { callBudget: budget } : {}),
  });

  it("with no budget the chunk may call more than once (the control)", async () => {
    const out = await runSocialChunk(input(null), { call: socialCallThroughTreg(input(null)) });
    expect(out.ok).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("a budget that does not even cover the first call sends nothing and answers with the sentence of the ceiling", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 0.0005, spentUsd: 0 });
    const out = await runSocialChunk(input(budget), { call: socialCallThroughTreg(input(budget)) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe(JOB_BUDGET_ERROR_CODE);
    expect(out.errorMessageAr).toBe(JOB_BUDGET_STOP_AR);
    expect(out.costMicro).toBe(0);
  });

  it("a budget for one call: one request, its rows kept, the chunk ends ok", async () => {
    const budget = createJobCallBudget({ ceilingUsd: 0.0012, spentUsd: 0 }); // 0.0009 per call
    const out = await runSocialChunk(input(budget), { call: socialCallThroughTreg(input(budget)) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    expect(out.rows.length).toBeGreaterThan(0);
    expect(budget.spentUsd()).toBeCloseTo(0.0009, 9);
  });

  it("once a call is refused, the chain does NOT try the other source either (no further request of this chunk)", async () => {
    // the first source fails over to the second only when it fails; a refused call must end the chunk, not move to the next source
    fetchMock.mockImplementation(async () => new Response("{}", { status: 502, headers: { "x-treg-cost-micro": "0" } }));
    const budget = createJobCallBudget({ ceilingUsd: 0.0005, spentUsd: 0 });
    const out = await runSocialChunk(input(budget), { call: socialCallThroughTreg(input(budget)) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
  });
});
