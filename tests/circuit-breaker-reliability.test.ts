import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cbModule from "../src/lib/treg/circuitBreaker";
import {
  EndpointCircuitBreaker,
  getCircuitBreaker,
  setCircuitBreaker,
  DEFAULT_COOLDOWN_MS,
  EXTENDED_COOLDOWN_MS,
} from "../src/lib/treg/circuitBreaker";
import { candidatesFor } from "../agent/src/llmPlanner/catalogView";
import { callTregWithAsync, type AsyncTregDeps } from "../agent/src/asyncTreg";
import { executeTregCall, executeControlProbe, parseRetryAfter } from "../src/functions/shared/tregClient";
import type { CatalogEndpoint, TregCatalog } from "../src/lib/treg/catalog";

describe("Phase 2: Live Reliability & Circuit Breaker (DT-20261123-treg-p2)", () => {
  let virtualTime: number;
  const mockNow = () => virtualTime;

  beforeEach(() => {
    vi.restoreAllMocks();
    virtualTime = 1763884800000; // 2025-11-23T08:00:00.000Z
    setCircuitBreaker(null);

    // Provide registry fixture through setResearchRegistry
    cbModule.setResearchRegistry({
      endpoints: [
        {
          endpoint_id: "tikhub.x.twitter-web-fetch-search-timeline",
          current_status: "failing",
          example_http: { method: "GET" },
          example_request: { params: { keyword: "Elon Musk" } },
        },
        {
          endpoint_id: "anyapi.x.search.posts",
          current_status: "working",
          example_http: { method: "POST" },
          example_request: { params: { query: "test", limit: 20 } },
        },
      ],
    });
  });

  describe("Point 2.1: EndpointCircuitBreaker State Transitions", () => {
    it("1. Boot initialization sets TikHub search to open based on registry current_status: failing", () => {
      const cb = new EndpointCircuitBreaker(undefined, mockNow);
      expect(cb.getState("tikhub.x.twitter-web-fetch-search-timeline")).toBe("open");
    });

    it("behaves as no contract data when in-repo registry file is absent (defaults to closed)", () => {
      cbModule.clearResearchRegistryCache();
      cbModule.setResearchRegistry(null);
      const cb = new EndpointCircuitBreaker(undefined, mockNow);
      expect(cb.getState("arbitrary.endpoint.id")).toBe("closed");
      expect(cb.isAvailable("arbitrary.endpoint.id")).toBe(true);
    });

    it("2. While open, circuitBreaker.isAvailable(endpointId) returns false", () => {
      const cb = new EndpointCircuitBreaker(undefined, mockNow);
      const epId = "tikhub.x.twitter-web-fetch-search-timeline";
      expect(cb.getState(epId)).toBe("open");
      expect(cb.isAvailable(epId)).toBe(false);
    });

    it("transitions from open to half-open after 5-minute cooldown, where isAvailable returns true", () => {
      const cb = new EndpointCircuitBreaker(undefined, mockNow);
      const epId = "tikhub.x.twitter-web-fetch-search-timeline";
      expect(cb.getState(epId)).toBe("open");
      expect(cb.isAvailable(epId)).toBe(false);

      // Advance time by 4 minutes (not yet cooled down)
      virtualTime += 4 * 60 * 1000;
      expect(cb.getState(epId)).toBe("open");
      expect(cb.isAvailable(epId)).toBe(false);

      // Advance time past 5 minutes
      virtualTime += 1 * 60 * 1000 + 1;
      expect(cb.getState(epId)).toBe("half-open");
      expect(cb.isAvailable(epId)).toBe(true);
    });

    it("in half-open: a single success resets to closed, while a single failure returns to open", () => {
      const cb = new EndpointCircuitBreaker(undefined, mockNow);
      const epId = "tikhub.x.twitter-web-fetch-search-timeline";

      // Advance to half-open
      virtualTime += DEFAULT_COOLDOWN_MS + 10;
      expect(cb.getState(epId)).toBe("half-open");

      // Failure returns to open
      cb.recordFailure(epId, 500);
      expect(cb.getState(epId)).toBe("open");
      expect(cb.isAvailable(epId)).toBe(false);

      // Advance to half-open again
      virtualTime += DEFAULT_COOLDOWN_MS + 10;
      expect(cb.getState(epId)).toBe("half-open");

      // Success resets to closed
      cb.recordSuccess(epId);
      expect(cb.getState(epId)).toBe("closed");
      expect(cb.isAvailable(epId)).toBe(true);
    });

    it("requires 3 consecutive 400 or 5xx errors to trip from closed to open", () => {
      const cb = new EndpointCircuitBreaker({ "anyapi.x.search.posts": "working" }, mockNow);
      const epId = "anyapi.x.search.posts";
      expect(cb.getState(epId)).toBe("closed");

      // First failure: remains closed
      cb.recordFailure(epId, 500);
      expect(cb.getState(epId)).toBe("closed");
      expect(cb.isAvailable(epId)).toBe(true);

      // Intermittent success resets consecutive counter
      cb.recordSuccess(epId);
      expect(cb.getState(epId)).toBe("closed");

      // Two consecutive failures: still closed
      cb.recordFailure(epId, 400);
      cb.recordFailure(epId, 502);
      expect(cb.getState(epId)).toBe("closed");

      // Third consecutive failure: trips to open
      cb.recordFailure(epId, 503);
      expect(cb.getState(epId)).toBe("open");
      expect(cb.isAvailable(epId)).toBe(false);
    });

    it("reset(endpointId) manually clears circuit to closed", () => {
      const cb = new EndpointCircuitBreaker(undefined, mockNow);
      const epId = "tikhub.x.twitter-web-fetch-search-timeline";
      expect(cb.getState(epId)).toBe("open");

      cb.reset(epId);
      expect(cb.getState(epId)).toBe("closed");
      expect(cb.isAvailable(epId)).toBe(true);
    });

    it("4. Control probe failure immediately trips circuit to open with 30-minute extended cooldown", () => {
      const cb = new EndpointCircuitBreaker({ "anyapi.x.search.posts": "working" }, mockNow);
      const epId = "anyapi.x.search.posts";
      expect(cb.getState(epId)).toBe("closed");

      // Control probe fails with 400
      cb.recordFailure(epId, 400, true);
      expect(cb.getState(epId)).toBe("open");
      expect(cb.isAvailable(epId)).toBe(false);

      // After 5 minutes, still open due to 30-min extended cooldown
      virtualTime += 5 * 60 * 1000 + 10;
      expect(cb.getState(epId)).toBe("open");

      // After 30 minutes, transitions to half-open
      virtualTime += 25 * 60 * 1000 + 10;
      expect(cb.getState(epId)).toBe("half-open");
    });
  });

  describe("Point 2.2: Bypass Open Circuits in catalogView.ts", () => {
    it("3. catalogView.ts excludes open-circuit endpoints from model candidates", () => {
      const deadEp: CatalogEndpoint = {
        id: "tikhub.x.twitter-web-fetch-search-timeline",
        platform: "x",
        name: "TikHub X Search",
        category: "Social",
        capability: "x.search.posts",
        method: "GET",
        inputs: [],
        cost: { type: "free", unit: "call", usd: 0 },
        scope: "public",
        observed: { ok_rate: 0.1, hit_rate: 0.1, samples: 10 },
      } as any;

      const healthyEp: CatalogEndpoint = {
        id: "anyapi.x.search.posts",
        platform: "x",
        name: "AnyAPI X Search",
        category: "Social",
        capability: "x.search.posts",
        method: "POST",
        inputs: [],
        cost: { type: "metered", unit: "call", usd: 0.003 },
        scope: "public",
        observed: { ok_rate: 0.98, hit_rate: 0.95, samples: 200 },
      } as any;

      const mockCatalog: TregCatalog = {
        endpoints: [deadEp, healthyEp],
        byId: new Map([
          [deadEp.id, deadEp],
          [healthyEp.id, healthyEp],
        ]),
        writeIds: new Set(),
        withdrawnIds: new Set(),
      } as any;

      // Circuit breaker where deadEp is open
      const cb = new EndpointCircuitBreaker({
        "tikhub.x.twitter-web-fetch-search-timeline": "failing",
        "anyapi.x.search.posts": "working",
      }, mockNow);

      const candidates = candidatesFor(
        mockCatalog,
        null,
        "x",
        "x.search.posts",
        8,
        { circuitBreaker: cb }
      );

      const candidateIds = candidates.map((c) => c.id);
      expect(candidateIds).toContain("anyapi.x.search.posts");
      expect(candidateIds).not.toContain("tikhub.x.twitter-web-fetch-search-timeline");
    });
  });

  describe("Point 2.3: Retry-After, Idempotency & HTTP 200 Errors in tregClient.ts", () => {
    it("parses Retry-After header as seconds or HTTP date", () => {
      expect(parseRetryAfter("5")).toBe(5);
      expect(parseRetryAfter("0")).toBe(0);
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter("invalid")).toBeNull();

      const futureDate = new Date(Date.now() + 8000).toUTCString();
      const parsedSec = parseRetryAfter(futureDate);
      expect(parsedSec).toBeGreaterThanOrEqual(7);
      expect(parsedSec).toBeLessThanOrEqual(9);
    });

    it("5. 429 with Retry-After delays and succeeds on retry", async () => {
      let callCount = 0;
      let sleptMs = 0;
      const sleepMock = vi.fn(async (ms: number) => {
        sleptMs += ms;
      });

      // Mock global fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: "rate_limited" }), {
            status: 429,
            headers: { "retry-after": "2" },
          });
        }
        return new Response(JSON.stringify({ ok: true, data: [{ id: "123" }] }), {
          status: 200,
          headers: { "x-treg-cost-micro": "3000", "x-treg-call-id": "call_ok_retry" },
        });
      }) as any;

      try {
        const res = await executeTregCall({
          endpointId: "anyapi.x.search.posts",
          userId: "test_user",
          jobId: "test_job",
          sleep: sleepMock,
        });

        expect(callCount).toBe(2);
        expect(sleepMock).toHaveBeenCalled();
        expect(sleptMs).toBeGreaterThanOrEqual(2000);
        expect(res.ok).toBe(true);
        expect(res.httpStatus).toBe(200);
        expect(res.tregCallId).toBe("call_ok_retry");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("retries on transient 502/503/504 with X-Treg-Idempotency-Key and exponential backoff", async () => {
      let callCount = 0;
      let capturedHeaders: HeadersInit | undefined;
      const sleepMock = vi.fn(async () => {});

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url: any, init: any) => {
        callCount++;
        capturedHeaders = init?.headers;
        if (callCount < 3) {
          return new Response("Bad Gateway", { status: 502 });
        }
        return new Response(JSON.stringify({ output: { items: [] } }), {
          status: 200,
          headers: { "x-treg-cost-micro": "2000" },
        });
      }) as any;

      try {
        const res = await executeTregCall({
          endpointId: "anyapi.x.search.posts",
          userId: "test_user",
          jobId: "test_job",
          idempotencyKey: "test_custom_idem_key_123",
          sleep: sleepMock,
        });

        expect(callCount).toBe(3); // 1 initial + 2 retries
        expect(sleepMock).toHaveBeenCalledTimes(2);
        expect(res.ok).toBe(true);
        expect((capturedHeaders as Record<string, string>)["X-Treg-Idempotency-Key"]).toBe("test_custom_idem_key_123");
        expect((capturedHeaders as Record<string, string>)["Idempotency-Key"]).toBe("test_custom_idem_key_123");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("treats HTTP 200 containing provider error payload as failure feeding the circuit breaker", async () => {
      const cb = new EndpointCircuitBreaker({ "anyapi.x.search.posts": "working" }, mockNow);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ code: 400, message: "Invalid query syntax" }), {
          status: 200,
          headers: { "x-treg-cost-micro": "0" },
        });
      }) as any;

      try {
        const res = await executeTregCall({
          endpointId: "anyapi.x.search.posts",
          userId: "test_user",
          jobId: "test_job",
          circuitBreaker: cb,
          skipControlProbe: true,
        });

        expect(res.ok).toBe(false);
        expect(res.httpStatus).toBe(400);
        expect(res.error).toBe("Invalid query syntax");
        expect(cb.getRecord("anyapi.x.search.posts").consecutive400).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("diagnoses 400 with minimal control probe and trips circuit if control probe fails", async () => {
      const cb = new EndpointCircuitBreaker({ "anyapi.x.search.posts": "working" }, mockNow);

      const originalFetch = globalThis.fetch;
      // Both original query and control probe return 400
      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ error: "Provider outage / broken schema" }), {
          status: 400,
        });
      }) as any;

      try {
        const res = await executeTregCall({
          endpointId: "anyapi.x.search.posts",
          userId: "test_user",
          jobId: "test_job",
          circuitBreaker: cb,
        });

        expect(res.ok).toBe(false);
        expect(res.httpStatus).toBe(400);
        // Because control probe also failed with 400, circuit breaker trips to open immediately
        expect(cb.getState("anyapi.x.search.posts")).toBe("open");
        expect(cb.isAvailable("anyapi.x.search.posts")).toBe(false);
        expect(cb.getRecord("anyapi.x.search.posts").cooldownMs).toBe(EXTENDED_COOLDOWN_MS);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Point 2.4: Integrate Circuit Breaker into asyncTreg.ts", () => {
    it("early rejects call with circuit_open when endpoint circuit is open without calling callFn", async () => {
      const cb = new EndpointCircuitBreaker({ "tikhub.x.twitter-web-fetch-search-timeline": "failing" }, mockNow);
      const callFnMock = vi.fn();

      const deps: AsyncTregDeps = {
        catalog: { endpoints: [], byId: new Map() } as any,
        store: {} as any,
        missionId: "msn_test_1",
        circuitBreaker: cb,
      };

      const result = await callTregWithAsync(
        deps,
        callFnMock,
        "tikhub.x.twitter-web-fetch-search-timeline",
        { q: "test" }
      );

      expect(callFnMock).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect((result as any).blocked).toBe("circuit_open");
      expect((result as any).error).toBe("Endpoint circuit is open due to recent repeated failures");
    });

    it("records success on successful callFn dispatch", async () => {
      const cb = new EndpointCircuitBreaker({ "anyapi.x.search.posts": "working" }, mockNow);
      cb.recordFailure("anyapi.x.search.posts", 500);
      expect(cb.getRecord("anyapi.x.search.posts").consecutiveFailures).toBe(1);

      const callFnMock = vi.fn(async () => ({
        ok: true,
        call_id: "c_1",
        http_status: 200,
        rows_in_page: 5,
        has_more: false,
        next_cursor: null,
        shape: {},
        first_rows: [],
        warnings: [],
        saved: "saved",
      }));

      const deps: AsyncTregDeps = {
        catalog: { endpoints: [], byId: new Map() } as any,
        store: {} as any,
        missionId: "msn_test_2",
        circuitBreaker: cb,
      };

      const result = await callTregWithAsync(
        deps,
        callFnMock as any,
        "anyapi.x.search.posts",
        { q: "test" }
      );

      expect(callFnMock).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(cb.getRecord("anyapi.x.search.posts").consecutiveFailures).toBe(0);
      expect(cb.getState("anyapi.x.search.posts")).toBe("closed");
    });
  });
});
