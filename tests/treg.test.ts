import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFakeTregServer, FakeTregServerInstance } from "../scripts/fake-treg-server";
import { executeTregCall } from "../src/functions/shared/tregClient";

describe("Fake TREG Server & TREG Client Integration", () => {
  let fakeTreg: FakeTregServerInstance;

  beforeAll(async () => {
    // Start fake server on port 4041 to avoid collisions
    fakeTreg = await startFakeTregServer(4041);
  });

  afterAll(async () => {
    await fakeTreg.close();
  });

  it("should successfully execute TikTok profile call with headers and white-label tracking", async () => {
    const res = await executeTregCall({
      baseUrl: fakeTreg.url,
      endpointId: "tikhub.tiktok.user.profile",
      method: "GET",
      params: { username: "khaby.lame" },
      userId: "user_test_456",
      jobId: "job_test_789",
      routeMaxCostUsd: "0.05",
    });

    expect(res.ok).toBe(true);
    expect(res.httpStatus).toBe(200);
    expect(res.costMicro).toBe(1200);
    expect(res.tregCallId).toContain("call_mock_ok");
    expect(res.data).toBeDefined();
    expect(res.data.data.user.uniqueId).toBe("khaby.lame");
    expect(res.data.data.stats.followerCount).toBeGreaterThan(0);
    expect(res.isRouteMaxCost).toBe(false);
    expect(res.isPlatformBalanceLow).toBe(false);
  });

  it("should distinguish 402 route_max_cost error correctly", async () => {
    const res = await executeTregCall({
      baseUrl: fakeTreg.url,
      endpointId: "tikhub.tiktok.user.profile",
      method: "GET",
      params: { username: "expensive_user" },
      userId: "user_test_456",
      jobId: "job_test_789",
      routeMaxCostUsd: "0.05",
      testScenario: "route_max_cost",
    });

    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(402);
    expect(res.isRouteMaxCost).toBe(true);
    expect(res.isPlatformBalanceLow).toBe(false);
    expect(res.error).toBe("route_max_cost");
  });

  it("should distinguish 402 insufficient_balance (platform low balance) error correctly", async () => {
    const res = await executeTregCall({
      baseUrl: fakeTreg.url,
      endpointId: "tikhub.tiktok.user.profile",
      method: "GET",
      params: { username: "normal_user" },
      userId: "user_test_456",
      jobId: "job_test_789",
      routeMaxCostUsd: "0.05",
      testScenario: "insufficient_balance",
    });

    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(402);
    expect(res.isRouteMaxCost).toBe(false);
    expect(res.isPlatformBalanceLow).toBe(true);
    expect(res.error).toBe("insufficient_balance");
  });

  it("should handle 429 rate limit correctly", async () => {
    const res = await executeTregCall({
      baseUrl: fakeTreg.url,
      endpointId: "tikhub.tiktok.user.profile",
      method: "GET",
      params: { username: "fast_user" },
      userId: "user_test_456",
      jobId: "job_test_789",
      routeMaxCostUsd: "0.05",
      testScenario: "rate_limit",
    });

    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(429);
    expect(res.error).toBe("rate_limit_exceeded");
  });

  it("should handle upstream 502/500 errors gracefully", async () => {
    const res = await executeTregCall({
      baseUrl: fakeTreg.url,
      endpointId: "tikhub.tiktok.user.profile",
      method: "GET",
      params: { username: "error_user" },
      userId: "user_test_456",
      jobId: "job_test_789",
      routeMaxCostUsd: "0.05",
      testScenario: "upstream_error",
    });

    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(502);
    expect(res.error).toBe("provider_unavailable");
  });
});
