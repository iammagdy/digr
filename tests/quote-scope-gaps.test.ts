import { describe, it, expect, vi, beforeEach } from "vitest";
import { quoteScopeGaps, planScopeRows } from "../src/lib/quoteScopeGaps";
import { NextRequest } from "next/server";

const authMockState = vi.hoisted(() => ({
  user: null as any,
  authError: null as any,
  adminClient: null as any,
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: authMockState.user },
        error: authMockState.authError,
      })),
    },
  })),
  createAdminClient: vi.fn(() => authMockState.adminClient || {}),
}));

vi.mock("../src/lib/server/providerGate", () => ({
  getLiveProviderGateStatusFromSettings: vi.fn(async () => ({
    isReady: true,
    reasonCode: "ready",
    messageAr: "المزود جاهز",
  })),
}));

describe("Task 4: Quote Scope Guard and Plan Scope Chips", () => {
  describe("Pure function quoteScopeGaps", () => {
    it("returns [] for valid social-x-posts plan with query and volume", () => {
      const items = [
        {
          capabilitySlug: "social-x-posts",
          params: { query: "كرة السلة" },
          targetVolumeMax: 10,
        },
      ];
      expect(quoteScopeGaps(items)).toEqual([]);
    });

    it("returns ['country'] for company research with empty query.location.include", () => {
      const items = [
        {
          capabilitySlug: "icypeas-companies-search",
          params: {
            query: {
              location: { include: [] },
              industry: { include: ["Construction"] },
            },
          },
          targetVolumeMax: 50,
        },
      ];
      expect(quoteScopeGaps(items)).toEqual(["country"]);
    });

    it("includes 'placeholder' when params contain 'يلزم تحديد الدولة'", () => {
      const items = [
        {
          capabilitySlug: "icypeas-companies-search",
          params: {
            country: "يلزم تحديد الدولة",
            query: {
              location: { include: ["يلزم تحديد الدولة"] },
              industry: { include: ["Construction"] },
            },
          },
          targetVolumeMax: 50,
        },
      ];
      const gaps = quoteScopeGaps(items);
      expect(gaps).toContain("placeholder");
    });

    it("identifies missing title/keywords in people research", () => {
      const items = [
        {
          capabilitySlug: "professional-people-search",
          params: {
            country: "Egypt",
          },
          targetVolumeMax: 20,
        },
      ];
      expect(quoteScopeGaps(items)).toContain("title");
    });

    it("identifies invalid social params via validateSocialParams", () => {
      const items = [
        {
          capabilitySlug: "social-x-posts",
          params: {},
          targetVolumeMax: 10,
        },
      ];
      expect(quoteScopeGaps(items)).toContain("social_params");
    });
  });

  describe("Pure function planScopeRows", () => {
    it("returns length 2 (topic, volume) for tweets and none contains 'الدولة'", () => {
      const items = [
        {
          capabilitySlug: "social-x-posts",
          params: { query: "كرة السلة" },
          targetVolumeMax: 10,
        },
      ];
      const chips = planScopeRows(items);
      expect(chips).toHaveLength(2);

      const allText = chips.map((c) => `${c.label} ${c.value}`).join(" ");
      expect(allText).not.toContain("الدولة");

      // First chip is topic
      expect(chips[0].label).toBe("موضوع المحتوى:");
      expect(chips[0].value).toBe("كرة السلة");

      // Second chip is volume
      expect(chips[1].label).toBe("العدد المطلوب:");
      expect(chips[1].value).toContain("١٠");
    });

    it("shows country chip for company search", () => {
      const items = [
        {
          capabilitySlug: "icypeas-companies-search",
          params: {
            query: {
              location: { include: ["Egypt"] },
              industry: { include: ["Construction"] },
            },
          },
          targetVolumeMax: 50,
        },
      ];
      const chips = planScopeRows(items);
      expect(chips.length).toBeGreaterThanOrEqual(3);
      const countryChip = chips.find((c) => c.label.includes("الدولة"));
      expect(countryChip).toBeDefined();
      expect(countryChip?.value).toContain("مصر");
    });

    it("shows country chip for social plan when params.region is explicitly provided", () => {
      const items = [
        {
          capabilitySlug: "social-tiktok-videos",
          params: {
            trending: true,
            region: "SA",
          },
          targetVolumeMax: 30,
        },
      ];
      const chips = planScopeRows(items);
      const countryChip = chips.find((c) => c.label.includes("الدولة"));
      expect(countryChip).toBeDefined();
      expect(countryChip?.value).toContain("المملكة العربية السعودية");
    });
  });

  describe("Server Guard: createAndSaveManagedQuote", () => {
    it("throws an error when plan items have scope gaps and enforceScope is true", async () => {
      const { createAndSaveManagedQuote } = await import("../src/functions/shared/planManager");
      const mockDb: any = {
        from: vi.fn(),
      };

      const planWithGaps: any = {
        summaryAr: "شركات بدون دولة",
        items: [
          {
            capabilitySlug: "icypeas-companies-search",
            params: {
              query: {
                location: { include: [] },
                industry: { include: ["Construction"] },
              },
            },
            targetVolumeMax: 10,
          },
        ],
      };

      await expect(
        createAndSaveManagedQuote(mockDb, {
          conversationId: "conv-incomplete",
          userId: "user-1",
          plan: planWithGaps,
          userBalance: 500,
          capabilities: [],
          enforceScope: true,
        })
      ).rejects.toThrow("الخطة غير مكتملة");
      expect(mockDb.from).not.toHaveBeenCalled();
    });

    it("does not throw scope gap error when enforceScope is false (default)", async () => {
      const { createAndSaveManagedQuote } = await import("../src/functions/shared/planManager");
      const mockDb: any = {
        from: vi.fn(),
      };

      const planWithGaps: any = {
        summaryAr: "شركات بدون دولة",
        items: [
          {
            capabilitySlug: "icypeas-companies-search",
            params: {
              query: {
                location: { include: [] },
                industry: { include: ["Construction"] },
              },
            },
            targetVolumeMax: 10,
          },
        ],
      };

      // Without enforceScope, it passes the scope guard and evaluates capability matching
      await expect(
        createAndSaveManagedQuote(mockDb, {
          conversationId: "conv-incomplete",
          userId: "user-1",
          plan: planWithGaps,
          userBalance: 500,
          capabilities: [],
        })
      ).rejects.toThrow("الخدمة المطلوبة غير معتمدة أو غير موجودة في الكتالوج.");
    });
  });


});
