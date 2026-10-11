import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/admin/smoke/route";
import { runSmokeTests } from "../src/functions/shared/smokeTest";

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
    const capturedUrls: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrls.push(url);
      if (url.includes("tikhub.tiktok.user.profile")) {
        return new Response(
          JSON.stringify({
            data: {
              nickname: "IamMagdy",
              uniqueId: "iammagdy",
              followerCount: 5000,
            },
          }),
          { status: 200, headers: { "x-treg-cost-micro": "3000" } }
        );
      }
      if (url.includes("facebook-search")) {
        return new Response(
          JSON.stringify({
            results: [{ id: "fb_1", text: "Facebook news post" }],
          }),
          { status: 200, headers: { "x-treg-cost-micro": "4000" } }
        );
      }
      if (url.includes("x-keyword-search")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "tweet_1", text: "Tech post on X" }],
          }),
          { status: 200, headers: { "x-treg-cost-micro": "4000" } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const summary = await runSmokeTests("admin_user_id");

    expect(summary.auth_ok).toBe(true);
    expect(summary.live_switch).toBe(true);
    expect(summary.provider_token_present).toBe(true);
    expect(summary.results.length).toBe(3);

    // Verify TikTok check
    const tikResult = summary.results.find((r) => r.platform === "tiktok");
    expect(tikResult).toBeDefined();
    expect(tikResult?.ok).toBe(true);
    expect(tikResult?.profile_name).toBe("IamMagdy");
    expect(tikResult?.cost_usd).toBe(0.003);

    // Verify Facebook check
    const fbResult = summary.results.find((r) => r.platform === "facebook");
    expect(fbResult).toBeDefined();
    expect(fbResult?.ok).toBe(true);

    // Verify X check
    const xResult = summary.results.find((r) => r.platform === "x");
    expect(xResult).toBeDefined();
    expect(xResult?.ok).toBe(true);

    // Verify total cost
    expect(summary.total_cost_usd).toBe(0.011);
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
      // Facebook endpoint returns 404 or unsupported
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

  it("returns 401 when request lacks authorization headers and session cookies", async () => {
    const req = new NextRequest("http://localhost:3000/api/admin/smoke", {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.auth_ok).toBe(false);
  });
});
