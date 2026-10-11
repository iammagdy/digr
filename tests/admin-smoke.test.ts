import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/admin/smoke/route";
import { runSmokeTests } from "../src/functions/shared/smokeTest";
import { executeTregCall } from "../src/functions/shared/tregClient";

describe("Phase D: Admin Smoke Test Endpoint (/api/admin/smoke)", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...origEnv,
      TREG_LIVE: "true",
      TREG_TOKEN: "mock_treg_token_xyz",
      APPWRITE_PROJECT_ID: "proj_test_123",
      NODE_ENV: "test",
    };
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  it("returns live_switch: false and zero external calls when TREG_LIVE is not 'true'", async () => {
    process.env.TREG_LIVE = "false";
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const summary = await runSmokeTests("admin_user_id");

    expect(summary.auth_ok).toBe(true);
    expect(summary.live_switch).toBe(false);
    expect(summary.provider_token_present).toBe(true);
    expect(summary.results).toEqual([]);
    expect(summary.total_cost_usd).toBe(0);
    expect(summary.message_ar).toContain("المفتاح المباشر معطل");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs up to 3 platform checks with hard $0.02 cap and never leaks secrets in response", async () => {
    const capturedCalls: Array<{ url: string; method: string; body: any; headers: any }> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, opts?: any) => {
      capturedCalls.push({
        url,
        method: opts?.method,
        body: opts?.body,
        headers: opts?.headers,
      });

      if (url.includes("tikhub.tiktok.user.profile")) {
        return new Response(
          JSON.stringify({
            data: {
              nickname: "IamMagdy",
              uniqueId: "iammagdy",
              followerCount: 5000,
            },
          }),
          { status: 200, headers: { "x-treg-cost-micro": "1000" } }
        );
      }
      if (url.includes("scrapecreators.x.v1-facebook-profile-posts")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "fb_1", text: "Facebook news post" }],
          }),
          { status: 200, headers: { "x-treg-cost-micro": "1880" } }
        );
      }
      if (url.includes("anyapi.x.search.posts")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "tweet_1", text: "Tech post on X" }],
          }),
          { status: 200, headers: { "x-treg-cost-micro": "750" } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const summary = await runSmokeTests("admin_user_id");

    expect(summary.auth_ok).toBe(true);
    expect(summary.live_switch).toBe(true);
    expect(summary.provider_token_present).toBe(true);
    expect(summary.results.length).toBe(3);

    // Verify TikTok check (GET with params in query string)
    const tikResult = summary.results.find((r) => r.platform === "tiktok");
    expect(tikResult).toBeDefined();
    expect(tikResult?.ok).toBe(true);
    expect(tikResult?.profile_name).toBe("IamMagdy");
    expect(tikResult?.cost_usd).toBe(0.001);

    const tikCall = capturedCalls.find((c) => c.url.includes("tikhub.tiktok.user.profile"));
    expect(tikCall).toBeDefined();
    expect(tikCall?.method).toBe("GET");
    expect(tikCall?.url).toContain("uniqueId=iammagdy");
    expect(tikCall?.body).toBeUndefined();
    expect(tikCall?.headers["X-Treg-Meta"]).toContain("customer=admin_user_id");
    expect(tikCall?.headers["X-Treg-Meta"]).not.toContain("{"); // NOT JSON!

    // Verify Facebook check (GET with params in query string)
    const fbResult = summary.results.find((r) => r.platform === "facebook");
    expect(fbResult).toBeDefined();
    expect(fbResult?.ok).toBe(true);
    expect(fbResult?.cost_usd).toBe(0.00188);

    const fbCall = capturedCalls.find((c) => c.url.includes("scrapecreators.x.v1-facebook-profile-posts"));
    expect(fbCall).toBeDefined();
    expect(fbCall?.method).toBe("GET");
    expect(fbCall?.url).toContain("url=");
    expect(fbCall?.body).toBeUndefined();

    // Verify X check (POST with params in JSON body)
    const xResult = summary.results.find((r) => r.platform === "x");
    expect(xResult).toBeDefined();
    expect(xResult?.ok).toBe(true);
    expect(xResult?.cost_usd).toBe(0.00075);

    const xCall = capturedCalls.find((c) => c.url.includes("anyapi.x.search.posts"));
    expect(xCall).toBeDefined();
    expect(xCall?.method).toBe("POST");
    expect(xCall?.url).not.toContain("query=");
    expect(JSON.parse(xCall?.body)).toEqual({ query: "tech", limit: 1 });
    expect(xCall?.headers["Content-Type"]).toBe("application/json");

    // Verify total cost
    expect(summary.total_cost_usd).toBeCloseTo(0.00363, 5);
    expect(summary.total_cost_usd).toBeLessThanOrEqual(0.02);
    expect(summary.message_ar).toContain("تم فحص الاتصال بمزود البيانات بنجاح");

    // Strict security assertions: never leak token values
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("mock_treg_token_xyz");
    expect(serialized).not.toContain("X-Treg-Token");
  });

  it("handles honest refusal or 4xx responses without failing the entire summary", async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("tikhub.tiktok.user.profile")) {
        return new Response(
          JSON.stringify({ data: { nickname: "Magdy" } }),
          { status: 200, headers: { "x-treg-cost-micro": "2000" } }
        );
      }
      return new Response(
        JSON.stringify({ error: "endpoint_unavailable", message: "Not available" }),
        { status: 404, headers: { "x-treg-cost-micro": "0" } }
      );
    });

    const summary = await runSmokeTests("admin_user_id");

    expect(summary.auth_ok).toBe(true);
    expect(summary.results.length).toBe(3);
    expect(summary.results[0].ok).toBe(true);
    expect(summary.results[1].ok).toBe(false);
    expect(summary.results[1].status).toBe(404);
    expect(summary.message_ar).toContain("جزئياً");
  });

  it("captures 422 provider error message in detail field and sanitizes all tokens", async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("tikhub.tiktok.user.profile")) {
        return new Response(
          JSON.stringify({
            error: "unprocessable_entity",
            detail: "Validation failed: Bearer mock_treg_token_xyz is not accepted for treg_sec_secret123456",
          }),
          { status: 422, headers: { "x-treg-cost-micro": "0" } }
        );
      }
      return new Response(
        JSON.stringify({
          error: "unprocessable_entity",
          message: "Parameter 'url' is required for provider.",
        }),
        { status: 422, headers: { "x-treg-cost-micro": "0" } }
      );
    });

    const summary = await runSmokeTests("admin_user_id");

    expect(summary.auth_ok).toBe(true);
    expect(summary.results.length).toBe(3);

    const tikResult = summary.results.find((r) => r.platform === "tiktok");
    expect(tikResult).toBeDefined();
    expect(tikResult?.ok).toBe(false);
    expect(tikResult?.status).toBe(422);
    expect(tikResult?.detail).toBeDefined();
    expect(tikResult?.detail).toContain("Validation failed");
    expect(tikResult?.detail).toContain("[REDACTED]");
    // Hard assertion: secret token value must NOT appear
    expect(tikResult?.detail).not.toContain("mock_treg_token_xyz");
    expect(tikResult?.detail).not.toContain("treg_sec_secret123456");

    const fbResult = summary.results.find((r) => r.platform === "facebook");
    expect(fbResult).toBeDefined();
    expect(fbResult?.ok).toBe(false);
    expect(fbResult?.status).toBe(422);
    expect(fbResult?.detail).toContain("Parameter 'url' is required");

    const fullJson = JSON.stringify(summary);
    expect(fullJson).not.toContain("mock_treg_token_xyz");
    expect(fullJson).not.toContain("treg_sec_secret123456");
  });

  it("returns 401 when request lacks authorization headers and session cookies", async () => {
    const req = new NextRequest("http://localhost:3000/api/admin/smoke", {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.auth_ok).toBe(false);
  });

  describe("executeTregCall Method & Error Handling Specifications", () => {
    it("sends params in query string for GET and leaves body undefined", async () => {
      let capturedUrl = "";
      let capturedOpts: any;
      global.fetch = vi.fn().mockImplementation(async (url: string, opts?: any) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify({ ok: true, data: { user: "test" } }), { status: 200 });
      });

      const res = await executeTregCall({
        endpointId: "scrapecreators.x.v1-facebook-profile-posts",
        method: "GET",
        params: { url: "https://www.facebook.com/nike", limit: 5 },
        userId: "user_test_get",
        jobId: "job_test_get",
      });

      expect(res.ok).toBe(true);
      expect(capturedUrl).toContain("/call/scrapecreators.x.v1-facebook-profile-posts?");
      expect(capturedUrl).toContain("url=https%3A%2F%2Fwww.facebook.com%2Fnike");
      expect(capturedUrl).toContain("limit=5");
      expect(capturedOpts.method).toBe("GET");
      expect(capturedOpts.body).toBeUndefined();
      expect(capturedOpts.headers["Content-Type"]).toBeUndefined();
      expect(capturedOpts.headers["X-Treg-Meta"]).toBe("customer=user_test_get, job=job_test_get, step=step_1");
    });

    it("sends params in JSON body for POST with Content-Type header", async () => {
      let capturedUrl = "";
      let capturedOpts: any;
      global.fetch = vi.fn().mockImplementation(async (url: string, opts?: any) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
      });

      const res = await executeTregCall({
        endpointId: "anyapi.x.search.posts",
        method: "POST",
        params: { query: "tech", limit: 1 },
        userId: "user_test_post",
        jobId: "job_test_post",
      });

      expect(res.ok).toBe(true);
      expect(capturedUrl).toBe("https://treg.to/call/anyapi.x.search.posts");
      expect(capturedUrl).not.toContain("?");
      expect(capturedOpts.method).toBe("POST");
      expect(capturedOpts.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(capturedOpts.body)).toEqual({ query: "tech", limit: 1 });
      expect(capturedOpts.headers["X-Treg-Meta"]).toBe("customer=user_test_post, job=job_test_post, step=step_1");
    });

    it("captures provider error message in detail on 422 and redacts secrets", async () => {
      global.fetch = vi.fn().mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            error: "unprocessable_entity",
            detail: "The meta bag customer=bad@email.com contains email syntax which is forbidden. Secret: treg_tok_1234567890abcdef",
          }),
          { status: 422, headers: { "x-treg-cost-micro": "0" } }
        );
      });

      const res = await executeTregCall({
        endpointId: "anyapi.x.search.posts",
        method: "POST",
        token: "treg_tok_1234567890abcdef",
        params: { query: "test" },
        userId: "user_123",
        jobId: "job_123",
      });

      expect(res.ok).toBe(false);
      expect(res.httpStatus).toBe(422);
      expect(res.detail).toBeDefined();
      expect(res.detail).toContain("contains email syntax which is forbidden");
      expect(res.detail).toContain("[REDACTED]");
      expect(res.detail).not.toContain("treg_tok_1234567890abcdef");
      expect(res.detail!.length).toBeLessThanOrEqual(300);
    });
  });
});
