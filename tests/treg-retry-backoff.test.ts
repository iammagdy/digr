import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeTregCallWithRetry } from "../src/lib/server/tregAdapter";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

describe("Task 3a: Treg retry backoff, timeouts, and execution deadlines", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const baseOptions: TregCallOptions = {
    endpointId: "icypeas.companies.search",
    method: "POST",
    params: { location: { include: ["Egypt"] } },
    userId: "test-user-1",
    jobId: "test-job-1",
    token: "fake-test-token",
  };

  it("retries 429 three times then succeeds with 200: sleeps recorded [2000, 4000, 8000], final ok", async () => {
    const sleeps: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      if (typeof ms === "number" && (ms === 2000 || ms === 4000 || ms === 8000)) {
        sleeps.push(ms);
      }
      return origSetTimeout(fn, ms, ...args);
    }) as any);

    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount <= 3) {
        return {
          ok: false,
          status: 429,
          headers: new Headers(),
          json: async () => ({ error: "rate_limit" }),
          text: async () => JSON.stringify({ error: "rate_limit" }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "x-treg-cost": "2280", "x-treg-call-id": "treg_call_ok" }),
        json: async () => ({ rows: [{ name: "Company A" }] }),
        text: async () => JSON.stringify({ rows: [{ name: "Company A" }] }),
      } as any;
    });

    const promise = executeTregCallWithRetry(baseOptions, 3);

    // Advance through the 3 retries
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);

    const result = await promise;

    expect(sleeps).toEqual([2000, 4000, 8000]);
    expect(fetchCount).toBe(4);
    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
  });

  it("returns the 429 result after exactly 3 sleeps when all 4 attempts return 429", async () => {
    const sleeps: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      if (typeof ms === "number" && (ms === 2000 || ms === 4000 || ms === 8000)) {
        sleeps.push(ms);
      }
      return origSetTimeout(fn, ms, ...args);
    }) as any);

    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount += 1;
      return {
        ok: false,
        status: 429,
        headers: new Headers(),
        json: async () => ({ error: "rate_limit" }),
        text: async () => JSON.stringify({ error: "rate_limit" }),
      } as any;
    });

    const promise = executeTregCallWithRetry(baseOptions, 3);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);

    const result = await promise;

    expect(sleeps).toEqual([2000, 4000, 8000]);
    expect(fetchCount).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(429);
  });

  it("with a deadline of 5000 ms and 429s: only 1 sleep of 2000 then returns", async () => {
    const sleeps: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      if (typeof ms === "number" && (ms === 2000 || ms === 4000 || ms === 8000)) {
        sleeps.push(ms);
      }
      return origSetTimeout(fn, ms, ...args);
    }) as any);

    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount += 1;
      return {
        ok: false,
        status: 429,
        headers: new Headers(),
        json: async () => ({ error: "rate_limit" }),
        text: async () => JSON.stringify({ error: "rate_limit" }),
      } as any;
    });

    const deadlineMs = Date.now() + 5000;
    const promise = executeTregCallWithRetry(baseOptions, 3, { deadlineMs });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    const result = await promise;

    expect(sleeps).toEqual([2000]);
    expect(fetchCount).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(429);
  });

  it("never retries 400, 402, 404 (fetch call count 1)", async () => {
    for (const status of [400, 402, 404]) {
      let fetchCount = 0;
      globalThis.fetch = vi.fn(async () => {
        fetchCount += 1;
        return {
          ok: false,
          status,
          headers: new Headers(),
          json: async () => ({ error: `error_${status}` }),
          text: async () => JSON.stringify({ error: `error_${status}` }),
        } as any;
      });

      const result = await executeTregCallWithRetry(baseOptions, 3);
      expect(fetchCount).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(status);
    }
  });

  it("tikhub.tiktok.user.profile has 0 retries (existing single attempt behavior)", async () => {
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount += 1;
      return {
        ok: false,
        status: 429,
        headers: new Headers(),
        json: async () => ({ error: "rate_limit" }),
        text: async () => JSON.stringify({ error: "rate_limit" }),
      } as any;
    });

    const result = await executeTregCallWithRetry(
      {
        ...baseOptions,
        endpointId: "tikhub.tiktok.user.profile",
      },
      3
    );

    expect(fetchCount).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(429);
  });
});
