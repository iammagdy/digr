import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  getConfiguredProviderCreditUsd,
  getConfiguredProviderSpendCapUsd,
  getConfiguredJobPointsCap,
  getProviderBalanceStatus,
  getProviderAvailableBalanceUsd,
  checkPlanProviderCapacity,
  recordProviderCallSpend,
  resetProviderBalanceCacheForTesting,
  setProviderBalanceForTesting,
  PROVIDER_BALANCE_CACHE_TTL_MS,
  DEFAULT_PROVIDER_CREDIT_USD,
} from "../src/functions/shared/providerSpend";
import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { GET as getProviderBalanceRoute } from "../src/app/api/admin/provider-balance/route";

const mockSbAuth = vi.hoisted(() => ({
  user: null as any,
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async (jwt?: string) => {
        if (!jwt || !mockSbAuth.user) {
          return { data: { user: null }, error: { message: "Invalid JWT" } };
        }
        return { data: { user: mockSbAuth.user }, error: null };
      }),
    },
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        gte: vi.fn(async () => ({ data: [], error: null })),
      })),
    })),
  })),
}));

describe("Task 5: Provider Balance Awareness & Admin Endpoint", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetProviderBalanceCacheForTesting();
    mockSbAuth.user = null;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetProviderBalanceCacheForTesting();
    mockSbAuth.user = null;
    vi.restoreAllMocks();
  });

  describe("providerSpend configuration and balance tracking", () => {
    it("falls back to default $1.00 credit when PROVIDER_CREDIT_USD is unset", () => {
      delete process.env.PROVIDER_CREDIT_USD;
      expect(getConfiguredProviderCreditUsd()).toBe(DEFAULT_PROVIDER_CREDIT_USD);
    });

    it("reads custom PROVIDER_CREDIT_USD from env", () => {
      process.env.PROVIDER_CREDIT_USD = "3.50";
      expect(getConfiguredProviderCreditUsd()).toBe(3.50);
    });

    it("derives available balance subtracting recorded spend from credit", async () => {
      process.env.PROVIDER_CREDIT_USD = "1.00";
      // Record 100,000 microUSD = $0.10
      await recordProviderCallSpend(100_000);
      const status = await getProviderBalanceStatus(null, true);
      expect(status.creditUsd).toBe(1.00);
      expect(status.totalSpendUsd).toBe(0.10);
      expect(status.availableBalanceUsd).toBe(0.90);
      expect(status.todaySpendUsd).toBe(0.10);
      expect(status.todayCapUsd).toBe(0.80);
      expect(status.isHealthy).toBe(true);
    });

    it("respects 60-second in-memory cache TTL and forces refresh when requested", async () => {
      process.env.PROVIDER_CREDIT_USD = "2.00";
      const status1 = await getProviderBalanceStatus(null, true);
      expect(status1.availableBalanceUsd).toBe(2.00);

      // Now set test override without forceRefresh — cached version should still return 2.00
      // But forceRefresh should pick up new status
      const statusCached = await getProviderBalanceStatus(null, false);
      expect(statusCached.cachedAt).toBe(status1.cachedAt);

      // Advance time beyond 60s cache TTL
      const origDateNow = Date.now;
      try {
        Date.now = () => origDateNow() + PROVIDER_BALANCE_CACHE_TTL_MS + 1000;
        const statusExpired = await getProviderBalanceStatus(null, false);
        expect(statusExpired.cachedAt).toBeDefined();
      } finally {
        Date.now = origDateNow;
      }
    });

    it("marks is_healthy as false when available balance is near zero or daily spend reaches cap", async () => {
      setProviderBalanceForTesting(0.01);
      const lowBalanceStatus = await getProviderBalanceStatus(null, true);
      expect(lowBalanceStatus.isHealthy).toBe(false);

      resetProviderBalanceCacheForTesting();
      process.env.PROVIDER_CREDIT_USD = "5.00";
      process.env.PROVIDER_DAILY_SPEND_CAP_USD = "0.80";
      // Spend equal to cap = $0.80
      await recordProviderCallSpend(800_000);
      const capReachedStatus = await getProviderBalanceStatus(null, true);
      expect(capReachedStatus.isHealthy).toBe(false);
    });
  });

  describe("checkPlanProviderCapacity & 10% safety margin", () => {
    it("allows execution within 10% safety margin (safeBudgetUsd = availableBalanceUsd * 0.90)", async () => {
      setProviderBalanceForTesting(1.00);
      // safe budget = 1.00 * 0.90 = $0.90
      // 100 units at $0.001 = $0.10 < $0.90 -> allowed, not downscaled
      const check = await checkPlanProviderCapacity(100, 0.001, null);
      expect(check.allowed).toBe(true);
      expect(check.downscaled).toBe(false);
      expect(check.safeBudgetUsd).toBe(0.90);
      expect(check.maxSafeVolume).toBe(100);
    });

    it("downscales target count when requested units exceed safe budget", async () => {
      // available balance = $0.10 -> safe budget = $0.09
      setProviderBalanceForTesting(0.10);
      // requested 200 units at $0.001 each = $0.20 > $0.09
      // maxSafeVolume = Math.floor(0.09 / 0.001) = 90
      const check = await checkPlanProviderCapacity(200, 0.001, null);
      expect(check.allowed).toBe(true);
      expect(check.downscaled).toBe(true);
      expect(check.maxSafeVolume).toBe(90);
      expect(check.reasonAr).toContain("تم تعديل الحد الأقصى إلى 90 سجل");
      // Must NOT leak provider name, tool name, or USD
      expect(check.reasonAr).not.toMatch(/treg|provider|usd|\$/i);
    });

    it("returns allowed = false when balance is 0 and capacity is completely exhausted", async () => {
      setProviderBalanceForTesting(0);
      const check = await checkPlanProviderCapacity(50, 0.001, null);
      expect(check.allowed).toBe(false);
      expect(check.maxSafeVolume).toBe(0);
      expect(check.reasonAr).toContain("سعة الاستخراج الفورية مكتملة حالياً");
    });
  });

  describe("Integration with createAndSaveManagedQuote", () => {
    const mockTables = {
      listRows: vi.fn().mockResolvedValue({ total: 0, rows: [] }),
      createRow: vi.fn().mockResolvedValue({ $id: "q_123" }),
      updateRow: vi.fn().mockResolvedValue({}),
    } as any;

    const dummyCapability = {
      slug: "facebook-comments",
      nameAr: "تعليقات فيسبوك",
      platform: "facebook",
      unitCostUsd: 0.001,
      minRows: 1,
      maxRows: 5000,
      enabled: true,
      paramsSchema: "{}",
    } as any;

    it("automatically downscales quote and sets capacityConstrained flag when plan exceeds capacity", async () => {
      // Set balance to $0.10 -> safe budget $0.09 -> max 90 units at $0.001
      setProviderBalanceForTesting(0.10);

      const quote = await createAndSaveManagedQuote(mockTables, {
        conversationId: "conv_test_cap",
        userId: "user_test",
        plan: {
          summaryAr: "سحب تعليقات فيسبوك",
          items: [
            {
              capabilitySlug: "facebook-comments",
              params: { postUrl: "https://facebook.com/post/1" },
              targetVolumeMin: 1,
              targetVolumeMax: 500, // 500 > 90
            },
          ],
          outputFormats: ["xlsx"],
        },
        userBalance: 500,
        capabilities: [dummyCapability],
      });

      expect(quote.capacityConstrained).toBe(true);
      // the capacity cut (90 records) is the only cut: 90 x 6 points x 1.15 = 621 reserve fits the 5,000-point cap
      expect(quote.targetVolumeMax).toBe(90);
      expect(quote.items[0].targetVolumeMax).toBe(90);
      expect(quote.quotedPoints).toBe(621);
      expect(quote.pointsCapConstrained).toBe(false);
    });

    it("does not downscale when requested volume is safely within budget", async () => {
      setProviderBalanceForTesting(1.00); // safe budget $0.90 -> up to 900 units

      const quote = await createAndSaveManagedQuote(mockTables, {
        conversationId: "conv_test_safe",
        userId: "user_test",
        plan: {
          summaryAr: "سحب تعليقات فيسبوك",
          items: [
            {
              capabilitySlug: "facebook-comments",
              params: { postUrl: "https://facebook.com/post/1" },
              targetVolumeMin: 1,
              targetVolumeMax: 50,
            },
          ],
          outputFormats: ["xlsx"],
        },
        userBalance: 500,
        capabilities: [dummyCapability],
      });

      expect(quote.capacityConstrained).toBe(false);
      expect(quote.targetVolumeMax).toBe(50);
    });
  });

  describe("Admin endpoint /api/admin/provider-balance", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const req = new NextRequest("http://localhost:3000/api/admin/provider-balance", {
        method: "GET",
      });
      const res = await getProviderBalanceRoute(req);
      expect(res.status).toBe(401);
    });

    it("rejects authenticated non-admin users with 403", async () => {
      mockSbAuth.user = {
        id: "user_regular",
        email: "user@example.com",
        app_metadata: { role: "user" },
      };

      const req = new NextRequest("http://localhost:3000/api/admin/provider-balance", {
        method: "GET",
        headers: { Authorization: "Bearer valid_jwt" },
      });
      const res = await getProviderBalanceRoute(req);
      expect(res.status).toBe(403);
    });

    it("returns available_balance_usd, today_spend_usd, today_cap_usd, and is_healthy for admin", async () => {
      process.env.PROVIDER_CREDIT_USD = "1.00";
      process.env.PROVIDER_DAILY_SPEND_CAP_USD = "0.80";
      setProviderBalanceForTesting(0.95);

      mockSbAuth.user = {
        id: "admin_user",
        email: "admin@diger.tech",
        app_metadata: { role: "admin" },
      };

      const req = new NextRequest("http://localhost:3000/api/admin/provider-balance", {
        method: "GET",
        headers: { Authorization: "Bearer admin_jwt" },
      });
      const res = await getProviderBalanceRoute(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toHaveProperty("available_balance_usd", 0.95);
      expect(json).toHaveProperty("today_spend_usd");
      expect(json).toHaveProperty("today_cap_usd", 0.80);
      expect(json).toHaveProperty("is_healthy", true);
      expect(json).toHaveProperty("cached_at");
      // Never leak provider credentials, internal keys, or model vendor names
      const jsonStr = JSON.stringify(json);
      expect(jsonStr).not.toMatch(/treg|anthropic|openai|api_key|token/i);
    });
  });
});
