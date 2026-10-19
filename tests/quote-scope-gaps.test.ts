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

  describe("Server Guard: edit-plan route", () => {
    it("rejects editing a plan into an incomplete state and creates no quote", async () => {
      authMockState.user = {
        id: "user-verified-1",
        email: "verified@example.com",
        email_confirmed_at: "2026-10-12T00:00:00Z",
        user_metadata: { email_verified: true },
      };
      authMockState.authError = null;

      const validQuoteDoc = {
        id: "quote-valid-1",
        user_id: "user-verified-1",
        conversation_id: "conv-1",
        items: [
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
        ],
        summary_ar: "خطة سابقة",
        output_formats: ["xlsx", "pdf", "csv"],
      };

      authMockState.adminClient = {
        from: vi.fn((table: string) => {
          if (table === "plans_quotes") {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    single: vi.fn(async () => ({ data: validQuoteDoc, error: null })),
                  })),
                })),
              })),
              insert: vi.fn(),
            };
          }
          if (table === "credit_ledger") {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(async () => ({ data: [{ delta: 500 }], error: null })),
              })),
            };
          }
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              })),
            })),
          };
        }),
      };

      const { POST } = await import("../src/app/api/chat/edit-plan/route");
      // Operation that updates params to empty location so it has gaps
      const req = new NextRequest("http://localhost:3000/api/chat/edit-plan", {
        method: "POST",
        body: JSON.stringify({
          quoteId: "quote-valid-1",
          operations: [
            {
              op: "update_params",
              itemIndex: 0,
              params: {
                query: {
                  location: { include: [] },
                  industry: { include: ["Construction"] },
                },
              },
            },
          ],
        }),
      });

      const res = await POST(req);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.quote).toBeUndefined();
    });
  });

  describe("Server Guard: accept-quote route", () => {
    let rpcCalls: Array<{ name: string; params: any }>;

    beforeEach(() => {
      rpcCalls = [];
      authMockState.user = {
        id: "user-verified-1",
        email: "verified@example.com",
        email_confirmed_at: "2026-10-12T00:00:00Z",
        user_metadata: { email_verified: true },
      };
      authMockState.authError = null;

      const incompleteItems = [
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

      authMockState.adminClient = {
        from: vi.fn((table: string) => {
          if (table === "plans_quotes") {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: { id: "quote-incomplete", items: incompleteItems },
                    error: null,
                  })),
                  single: vi.fn(async () => ({
                    data: { id: "quote-incomplete", items: incompleteItems, quote_hash: "hash123" },
                    error: null,
                  })),
                })),
              })),
            };
          }
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              })),
            })),
          };
        }),
        rpc: vi.fn(async (name: string, params: any) => {
          rpcCalls.push({ name, params });
          return { data: { success: true }, error: null };
        }),
      };
    });

    it("returns status 409 with error 'الخطة غير مكتملة' and makes 0 reservation RPC calls", async () => {
      const { POST } = await import("../src/app/api/chat/accept-quote/route");
      const req = new NextRequest("http://localhost:3000/api/chat/accept-quote", {
        method: "POST",
        body: JSON.stringify({
          quoteId: "quote-incomplete",
          explicitApproval: true,
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(409);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe("الخطة غير مكتملة");
      expect(json.gaps).toContain("placeholder");

      // Verify no reserve_job_credits or accept_quote_atomic RPC calls occurred
      const reservationCalls = rpcCalls.filter((c) =>
        /reserve|accept_quote/i.test(c.name)
      );
      expect(reservationCalls).toHaveLength(0);
      expect(rpcCalls).toHaveLength(0);
    });
  });
});
