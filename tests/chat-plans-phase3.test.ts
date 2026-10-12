import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkUserRateLimits,
  checkMessageLength,
  checkGlobalDailySpendCap,
  DEFAULT_RATE_LIMITS,
} from "../src/functions/shared/rateLimits";
import {
  createAndSaveManagedQuote,
  computePlanHash,
  PlanState,
} from "../src/functions/shared/planManager";
import {
  calculateUnitPricePoints,
  calculateQuote,
  DEFAULT_PRICING_SETTINGS,
} from "../src/functions/shared/quotes";
import { Capability } from "../src/functions/shared/capabilityRegistry";

describe("Phase 3: Chat, Plans & Rate Limits Integration", () => {
  const sampleCapability: Capability = {
    slug: "tiktok-profile",
    category: "tiktok",
    nameAr: "استخراج ملف تيك توك الشخصي",
    nameEn: "TikTok User Profile",
    descriptionAr: "استخراج الإحصائيات الشاملة لحساب تيك توك",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { username: { type: "string" } },
      required: ["username"],
    }),
    tregEndpointId: "tikhub.tiktok.user.profile",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.001,
    maxRows: 1000,
    paginationType: "none",
    enabled: true,
  };

  describe("1. Rate Limits & Guardrails", () => {
    it("allows messages up to 4000 characters and rejects > 4000 with 413", () => {
      const okMessage = "أ".repeat(4000);
      const okRes = checkMessageLength(okMessage);
      expect(okRes.allowed).toBe(true);

      const tooLongMessage = "أ".repeat(4001);
      const failRes = checkMessageLength(tooLongMessage);
      expect(failRes.allowed).toBe(false);
      expect(failRes.statusCode).toBe(413);
      expect(failRes.reasonAr).toContain("4000 حرف");
    });

    it("enforces 20 messages/min burst limit on Supabase table query", async () => {
      // Mock Supabase client returning 20 messages in last minute
      const mockSupabase = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                gte: vi.fn(async () => ({ count: 20, error: null })),
              })),
            })),
          })),
        })),
      };

      const res = await checkUserRateLimits(mockSupabase, "user-test-burst");
      expect(res.allowed).toBe(false);
      expect(res.statusCode).toBe(429);
      expect(res.reasonAr).toContain("أرسلت رسائل كثيرة بسرعة");
    });

    it("allows user under burst limit on Supabase table query", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                gte: vi.fn(async () => ({ count: 5, error: null })),
              })),
            })),
          })),
        })),
      };

      const res = await checkUserRateLimits(mockSupabase, "user-test-normal");
      expect(res.allowed).toBe(true);
    });

    it("enforces global daily spend cap from llm_usage table", async () => {
      // Mock Supabase returning $1.20 accumulated LLM cost today (cap is $1.00)
      const mockSupabase = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            gte: vi.fn(async () => ({
              data: [{ cost_usd: 0.70 }, { cost_usd: 0.50 }],
              error: null,
            })),
          })),
        })),
      };

      const res = await checkGlobalDailySpendCap(mockSupabase, {
        ...DEFAULT_RATE_LIMITS,
        globalDailySpendCapUsd: 1.0,
      });
      expect(res.allowed).toBe(false);
      expect(res.statusCode).toBe(503);
      expect(res.reasonAr).toBe("المساعد مشغول الآن، حاول بعد قليل.");
      expect(res.reasonAr).not.toContain("غدا");
    });
  });

  describe("2. Quote Writer & Single-Item Pricing Rules", () => {
    it("sets unitPricePoints per item WITHOUT 15% buffer and total quoted WITH buffer", async () => {
      const mockSupabaseInserted: any[] = [];
      const mockSupabase = {
        from: vi.fn(() => ({
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(async () => ({ data: [], error: null })),
            })),
          })),
          insert: vi.fn(async (doc: any) => {
            mockSupabaseInserted.push(doc);
            return { data: doc, error: null };
          }),
        })),
      };

      const plan: PlanState = {
        summaryAr: "استخراج ملف تيك توك الشخصي",
        items: [
          {
            capabilitySlug: "tiktok-profile",
            params: { username: "iammagdy" },
            targetVolumeMin: 1,
            targetVolumeMax: 10,
          },
        ],
        outputFormats: ["xlsx", "csv"],
      };

      // Unit cost: 0.001 USD. With 53 EGP/USD, markup 2.0, point value 0.1 EGP:
      // unitPricePoints = (0.001 * 53 * 2.0) / 0.1 = 1.06 points/unit
      const expectedUnitPrice = calculateUnitPricePoints(0.001, DEFAULT_PRICING_SETTINGS);
      expect(expectedUnitPrice).toBeCloseTo(1.06, 2);

      const quoteResult = await createAndSaveManagedQuote(mockSupabase as any, {
        conversationId: "conv-single-item",
        userId: "user-quote-1",
        plan,
        userBalance: 500,
        capabilities: [sampleCapability],
        pricingSettings: DEFAULT_PRICING_SETTINGS,
      });

      expect(quoteResult.quoteId).toBeDefined();
      expect(quoteResult.items).toHaveLength(1);

      // Item has unitPricePoints explicitly attached WITHOUT 15% buffer
      const item = quoteResult.items[0] as any;
      expect(item.unitPricePoints).toBe(expectedUnitPrice);

      // Total quoted points has 15% buffer: ceil(10 * 1.06 * 1.15) = ceil(12.19) = 13 points
      const rawPoints = 10 * expectedUnitPrice;
      const expectedQuoted = Math.ceil(rawPoints * 1.15);
      expect(quoteResult.quotedPoints).toBe(expectedQuoted);
      expect(quoteResult.quotedPoints).toBeGreaterThan(rawPoints);

      // Verify Supabase insert occurred with correct fields
      expect(mockSupabaseInserted).toHaveLength(1);
      const inserted = mockSupabaseInserted[0];
      expect(inserted.total_reserved_credits).toBe(expectedQuoted);
      expect(inserted.items[0].unitPricePoints).toBe(expectedUnitPrice);
    });

    it("fails closed with Arabic error if unit price <= 0", async () => {
      const zeroCostCap: Capability = {
        ...sampleCapability,
        unitCostUsd: 0, // invalid zero cost
      };

      const mockSupabase = {
        from: vi.fn(),
      };

      const plan: PlanState = {
        summaryAr: "خدمة مجانية غير صالحة",
        items: [
          {
            capabilitySlug: "tiktok-profile",
            params: { username: "iammagdy" },
            targetVolumeMin: 1,
            targetVolumeMax: 10,
          },
        ],
        outputFormats: ["xlsx"],
      };

      await expect(
        createAndSaveManagedQuote(mockSupabase as any, {
          conversationId: "conv-zero-price",
          userId: "user-zero",
          plan,
          userBalance: 100,
          capabilities: [zeroCostCap],
        })
      ).rejects.toThrow("سعر الوحدة غير صالح للخدمة المطلوبة.");
    });
  });
});
