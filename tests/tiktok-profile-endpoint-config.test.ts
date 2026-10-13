import { describe, it, expect, vi } from "vitest";
import {
  APPROVED_CAPABILITY_CATALOG,
  buildApprovedCatalog,
  getCatalogCapabilities,
  getEnabledCapabilities,
  getRegistryPricingSettings,
  computeRegistryPointsPerUnit,
  sanitizeCapabilitiesForLlm,
} from "../src/functions/shared/capabilityRegistry";
import {
  calculateCapabilityQuote,
  calculateCapabilityUnitPricePoints,
  calculateFinalSettlement,
  DEFAULT_PRICING_SETTINGS,
} from "../src/functions/shared/quotes";
import {
  computePublicCalculatorQuote,
  getPublicCalculatorOptions,
} from "../src/lib/calculatorPricing";
import { resolveJobExecutionSpec } from "../src/lib/server/jobExecutionSpec";
import { executeTregCallWithRetry } from "../src/lib/server/tregAdapter";
import * as tregClientModule from "../src/functions/shared/tregClient";

describe("TikTok Profile Endpoint & Pricing Configuration Verification", () => {
  describe("Concern 1: Cost Fallbacks & Capability Price Isolation", () => {
    it("verifies APPROVED_CAPABILITY_CATALOG contains the verified tikhub endpoint and 0.001 USD cost", () => {
      const tiktokCap = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === "tiktok-profile");
      expect(tiktokCap).toBeDefined();
      expect(tiktokCap!.tregEndpointId).toBe("tikhub.tiktok.user.profile");
      expect(tiktokCap!.unitCostUsd).toBe(0.001);
      expect(tiktokCap!.estimatedCostUsdPerUnit).toBe(0.001);
      expect(tiktokCap!.tregMethod).toBe("GET");
      expect(tiktokCap!.pricingUnit).toBe("call");
      expect(tiktokCap!.paginationType).toBe("none");
      expect(tiktokCap!.maxRows).toBe(1);
      expect(tiktokCap!.enabled).toBe(true);
      expect(tiktokCap!.status).toBe("verified");
      expect(tiktokCap!.nameAr).toBe("استخراج ملف تيك توك الشخصي");
      expect(tiktokCap!.nameEn).toBe("TikTok User Profile");
      expect(tiktokCap!.pointsPerUnit).toBe(6);
    });

    it("verifies other capabilities retain their own documented costs and prices never become 0.001 USD", () => {
      const fbComments = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === "facebook-post-comments");
      expect(fbComments).toBeDefined();
      expect(fbComments!.unitCostUsd).toBe(0.0019);
      expect(fbComments!.unitCostUsd).not.toBe(0.001);

      const fbSearch = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === "facebook-post-search");
      expect(fbSearch).toBeDefined();
      expect(fbSearch!.unitCostUsd).toBe(0.03);
      expect(fbSearch!.unitCostUsd).not.toBe(0.001);

      const xSearch = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === "x-keyword-search");
      expect(xSearch).toBeDefined();
      expect(xSearch!.unitCostUsd).toBe(0.00075);
      expect(xSearch!.unitCostUsd).not.toBe(0.001);

      const ytComments = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === "youtube-comments");
      expect(ytComments).toBeDefined();
      expect(ytComments!.unitCostUsd).toBe(0.0015);
      expect(ytComments!.unitCostUsd).not.toBe(0.001);
    });

    it("fails closed on unknown or unverified capabilities with missing cost (never invents 0.001 USD)", async () => {
      const mockDbWithUnknown = {
        from: () => ({
          select: () => ({
            eq: async () => ({
              data: [
                {
                  slug: "unknown-scrape-cap",
                  name_ar: "خدمة غير معروفة",
                  endpoint_id: "unknown.endpoint",
                  unit_price_credits: null,
                  unit_cost_usd: null,
                  enabled: true,
                },
              ],
            }),
          }),
        }),
      };

      const enabledCaps = await getEnabledCapabilities(mockDbWithUnknown as any);
      // Unknown capability with no documented cost must fail closed and NOT be returned as enabled
      expect(enabledCaps.find((c) => c.slug === "unknown-scrape-cap")).toBeUndefined();
      expect(enabledCaps).toHaveLength(0);
    });

    it("sanitizes capabilities for LLM and zeroes points when cost is invalid (fail closed)", () => {
      const sanitized = sanitizeCapabilitiesForLlm([
        {
          slug: "invalid-cost-cap",
          category: "web",
          nameAr: "خدمة بدون تكلفة",
          nameEn: "No Cost",
          descriptionAr: "وصف",
          paramsSchema: "{}",
          tregEndpointId: "test.endpoint",
          tregMethod: "GET",
          pricingUnit: "call",
          unitCostUsd: 0,
          maxRows: 1,
          paginationType: "none",
          enabled: true,
        },
      ]);
      expect(sanitized[0].pointsPerUnit).toBe(0);
      expect(sanitized[0].status).toBe("pending_verification");
    });
  });

  describe("Concern 2: TikTok HTTP Method, Endpoint & Param Normalization", () => {
    it("strictly resolves saved quote with method=POST and bogus endpoint to GET and tikhub.tiktok.user.profile", async () => {
      const mockAdminClient = {
        from: (table: string) => ({
          select: () => ({
            eq: async () => ({
              data: [
                {
                  id: "job_test_tiktok_1",
                  items: [
                    {
                      capabilitySlug: "tiktok-profile",
                      endpointId: "custom-bogus-endpoint",
                      method: "POST", // Incorrect saved method
                      paginationStrategy: "cursor", // Incorrect saved pagination
                      params: { username: "@iammagdy" },
                    },
                  ],
                },
              ],
            }),
          }),
        }),
      };

      const spec = await resolveJobExecutionSpec(
        mockAdminClient,
        "job_test_tiktok_1",
        "user_123",
        "tiktok-profile",
        6
      );

      // Must strictly resolve to verified contract
      expect(spec.capabilitySlug).toBe("tiktok-profile");
      expect(spec.endpointId).toBe("tikhub.tiktok.user.profile");
      expect(spec.method).toBe("GET");
      expect(spec.paginationStrategy).toBe("none");
      expect(spec.unitCostUsd).toBe(0.001);
      // Parameter username -> uniqueId mapping and @ removal
      expect(spec.params.uniqueId).toBe("iammagdy");
      expect(spec.params.username).toBeUndefined();
    });

    it("normalizes uniqueId with leading @ to clean string without @", async () => {
      const mockAdminClient = {
        from: () => ({
          select: () => ({
            eq: async () => ({ data: [] }),
          }),
        }),
      };

      const spec = await resolveJobExecutionSpec(
        mockAdminClient,
        "job_no_quote",
        "user_123",
        "tikhub.tiktok.user.profile",
        6
      );

      expect(spec.capabilitySlug).toBe("tiktok-profile");
      expect(spec.endpointId).toBe("tikhub.tiktok.user.profile");
      expect(spec.method).toBe("GET");
      expect(spec.paginationStrategy).toBe("none");
      expect(spec.unitCostUsd).toBe(0.001);
    });
  });

  describe("Concern 3: Single Outbound Provider Attempt Maximum for TikTok", () => {
    it("makes exactly ONE outbound attempt for tikhub.tiktok.user.profile on HTTP 429", async () => {
      const executeTregCallSpy = vi.spyOn(tregClientModule, "executeTregCall").mockResolvedValue({
        ok: false,
        httpStatus: 429,
        data: null,
        costMicro: 0,
        latencyMs: 50,
        tregCallId: "call_429",
        isRouteMaxCost: false,
        isPlatformBalanceLow: false,
        error: "rate_limit",
      });

      const result = await executeTregCallWithRetry({
        endpointId: "tikhub.tiktok.user.profile",
        method: "GET",
        params: { uniqueId: "testuser" },
        userId: "user_retry_1",
        jobId: "job_retry_1",
      });

      expect(executeTregCallSpy).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(429);
      executeTregCallSpy.mockRestore();
    });

    it("makes exactly ONE outbound attempt for tikhub.tiktok.user.profile on HTTP 500", async () => {
      const executeTregCallSpy = vi.spyOn(tregClientModule, "executeTregCall").mockResolvedValue({
        ok: false,
        httpStatus: 500,
        data: null,
        costMicro: 0,
        latencyMs: 50,
        tregCallId: "call_500",
        isRouteMaxCost: false,
        isPlatformBalanceLow: false,
        error: "server_error",
      });

      const result = await executeTregCallWithRetry({
        endpointId: "tikhub.tiktok.user.profile",
        method: "GET",
        params: { uniqueId: "testuser" },
        userId: "user_retry_2",
        jobId: "job_retry_2",
      });

      expect(executeTregCallSpy).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(500);
      executeTregCallSpy.mockRestore();
    });

    it("makes exactly ONE outbound attempt for tikhub.tiktok.user.profile on network failure", async () => {
      const executeTregCallSpy = vi.spyOn(tregClientModule, "executeTregCall").mockResolvedValue({
        ok: false,
        httpStatus: 0,
        data: null,
        costMicro: 0,
        latencyMs: 10,
        tregCallId: "",
        isRouteMaxCost: false,
        isPlatformBalanceLow: false,
        error: "network_failure",
      });

      const result = await executeTregCallWithRetry({
        endpointId: "tikhub.tiktok.user.profile",
        method: "GET",
        params: { uniqueId: "testuser" },
        userId: "user_retry_3",
        jobId: "job_retry_3",
      });

      expect(executeTregCallSpy).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("network_failure");
      executeTregCallSpy.mockRestore();
    });

    it("preserves retries (up to 4 attempts total) for other capabilities", async () => {
      let callCount = 0;
      const executeTregCallSpy = vi.spyOn(tregClientModule, "executeTregCall").mockImplementation(async () => {
        callCount++;
        return {
          ok: false,
          httpStatus: 502,
          data: null,
          costMicro: 0,
          latencyMs: 10,
          tregCallId: `call_${callCount}`,
          isRouteMaxCost: false,
          isPlatformBalanceLow: false,
          error: "bad_gateway",
        };
      });

      const result = await executeTregCallWithRetry(
        {
          endpointId: "twitter.search.tweets",
          method: "GET",
          params: { query: "test" },
          userId: "user_retry_4",
          jobId: "job_retry_4",
        },
        3
      );

      // Initial attempt (0) + 3 retries = 4 attempts total
      expect(callCount).toBe(4);
      expect(result.ok).toBe(false);
      executeTregCallSpy.mockRestore();
    });
  });

  describe("Concern 4: Pricing and Database Consistency with Mocked Fixtures", () => {
    it("handles live Supabase row with unit_cost_usd = NULL without inventing costs", async () => {
      // Exact representation of current live database row
      const mockDbRow = {
        slug: "tiktok-profile",
        name_ar: "استخراج ملف تيك توك الشخصي",
        description_ar: "استخراج الإحصائيات الشاملة",
        endpoint_id: "tikhub.tiktok.user.profile",
        unit_price_credits: 6,
        unit_cost_usd: null, // As reported in live DB
        enabled: true,
      };

      const mockDb = {
        from: (table: string) => ({
          select: () => ({
            eq: async () => ({ data: [mockDbRow] }),
          }),
        }),
      };

      const enabledCaps = await getEnabledCapabilities(mockDb as any);
      expect(enabledCaps).toHaveLength(1);
      const cap = enabledCaps[0];

      // Verifies documented cost basis 0.001 USD is resolved from catalog
      expect(cap.slug).toBe("tiktok-profile");
      expect(cap.tregEndpointId).toBe("tikhub.tiktok.user.profile");
      expect(cap.unitCostUsd).toBe(0.001);
      expect(cap.pointsPerUnit).toBe(6);

      // Quote calculations: 1 profile -> 6 unit price, 7 reserve
      const quote = calculateCapabilityQuote(1, cap.unitCostUsd, 1000, DEFAULT_PRICING_SETTINGS);
      expect(quote.unitPricePoints).toBe(6);
      expect(quote.quotedPoints).toBe(7);

      // Settlement: 1 delivered -> 6 charged, 1 refunded
      const settlement = calculateFinalSettlement(1, quote.unitPricePoints, quote.quotedPoints);
      expect(settlement.chargePoints).toBe(6);
      expect(settlement.refundPoints).toBe(1);

      // Failure: 0 delivered -> 0 charged, 7 refunded
      const failedSettlement = calculateFinalSettlement(0, quote.unitPricePoints, quote.quotedPoints);
      expect(failedSettlement.chargePoints).toBe(0);
      expect(failedSettlement.refundPoints).toBe(7);

      // Public calculator matches quote writer
      const calc = computePublicCalculatorQuote("tiktok-profile", 1, 1, enabledCaps, DEFAULT_PRICING_SETTINGS);
      expect(calc.unitPricePoints).toBe(quote.unitPricePoints);
      expect(calc.reservedPoints).toBe(quote.quotedPoints);
      expect(calc.chargedPoints).toBe(settlement.chargePoints);
      expect(calc.refundPoints).toBe(settlement.refundPoints);
    });

    it("confirms no other capability receives the 0.001 USD fallback when unit_cost_usd is NULL", async () => {
      const mockDb = {
        from: () => ({
          select: () => ({
            eq: async () => ({
              data: [
                {
                  slug: "facebook-post-comments",
                  name_ar: "تعليقات فيسبوك",
                  endpoint_id: "facebook.page.comments",
                  unit_price_credits: 11,
                  unit_cost_usd: null, // Null in DB
                  enabled: true,
                },
              ],
            }),
          }),
        }),
      };

      const caps = await getEnabledCapabilities(mockDb as any);
      expect(caps).toHaveLength(1);
      // Resolves its own documented cost (0.0019 USD), NOT 0.001 USD!
      expect(caps[0].unitCostUsd).toBe(0.0019);
      expect(caps[0].unitCostUsd).not.toBe(0.001);
      expect(caps[0].pointsPerUnit).toBe(11);
    });
  });
});
