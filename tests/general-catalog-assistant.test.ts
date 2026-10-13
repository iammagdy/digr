import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  searchCatalog,
  getEndpointDetails,
  normalizeCatalogEndpoint,
  clearCatalogCache,
  sanitizeCatalogEndpointForCustomer,
  type CatalogEndpointSummary,
} from "../src/functions/shared/catalogClient";
import {
  calculateCapabilityQuote,
  calculateCapabilityUnitPricePoints,
  calculateFinalSettlement,
  DEFAULT_PRICING_SETTINGS,
} from "../src/functions/shared/quotes";
import {
  validatePlanAgainstLiveCatalog,
  type PlanItem,
} from "../src/functions/shared/planManager";
import { resolveJobExecutionSpec } from "../src/lib/server/jobExecutionSpec";
import { isGreetingOrGeneralQuestion } from "../src/functions/shared/briefManager";
import { buildSystemPrompt } from "../src/functions/shared/systemPrompt";
import { executeTregCallWithRetry } from "../src/lib/server/tregAdapter";
import * as tregClientModule from "../src/functions/shared/tregClient";

describe("General-Purpose Catalog-Driven AI Assistant Integration Test Suite", () => {
  beforeEach(() => {
    clearCatalogCache();
    vi.restoreAllMocks();
  });

  describe("Scenario 1: Natural Greetings & General Conversation", () => {
    it("recognizes greetings naturally without interrogations or tool calls", () => {
      const greetings = [
        "مرحبا",
        "أهلاً",
        "السلام عليكم",
        "صباح الخير",
        "مساء الخير",
        "ازيك يا فندم",
        "هاي",
      ];
      for (const g of greetings) {
        const { isGreeting, isGeneralQuestion } = isGreetingOrGeneralQuestion(g);
        expect(isGreeting).toBe(true);
        expect(isGeneralQuestion).toBe(false);
      }
    });

    it("recognizes identity and general platform questions naturally", () => {
      const generalQuestions = [
        "من أنت؟",
        "ماذا تفعل؟",
        "كيف تعمل المنصة؟",
        "ما هي خدماتك؟",
        "هل يمكنك مساعدتي؟",
      ];
      for (const q of generalQuestions) {
        const { isGeneralQuestion } = isGreetingOrGeneralQuestion(q);
        expect(isGeneralQuestion).toBe(true);
      }
    });

    it("builds clean system prompt v6 instructing natural ChatGPT-style interaction without emoji", () => {
      const prompt = buildSystemPrompt({ sanitizedCapabilities: [] });
      expect(prompt).toContain("Natural Research Assistant");
      expect(prompt).toContain("Dynamic Catalog Search");
      expect(prompt).toContain("NO EMOJI");
      expect(prompt).not.toContain("Do NOT search the catalog in Phase 1");
    });
  });

  describe("Scenario 2: Public Facebook Comments Journey", () => {
    const fbEndpointRaw = {
      id: "scrapecreators.facebook.post-comments",
      name: "Facebook Post Comments",
      summary: "Extract public comments and replies from Facebook posts",
      platform: "facebook",
      method: "POST",
      path: "/v1/facebook/comments",
      cost: { usd: 0.0019, unit: "record" },
      input: {
        body: {
          postUrl: { type: "string", required: true, description: "URL of the Facebook post" },
          limit: { type: "integer", maximum: 100 },
        },
      },
      observed: { ok_rate: 0.96, samples: 150 },
      scope: "any_account",
    };

    it("normalizes Facebook endpoint with documented cost and method", () => {
      const ep = normalizeCatalogEndpoint(fbEndpointRaw);
      expect(ep.platform).toBe("facebook");
      expect(ep.method).toBe("POST");
      expect(ep.catalogPriceUsd).toBe(0.0019);
      // Math: ceil(0.0019 * 55 * 10 / 0.10) = ceil(10.45) = 11 points
      expect(ep.pointsPerUnit).toBe(11);
      expect(ep.billingUnit).toBe("record");
      expect(ep.scope).toBe("any_account");
    });

    it("validates plan against live catalog, quotes 50 comments, and settles correctly", () => {
      const ep = normalizeCatalogEndpoint(fbEndpointRaw);
      const planItems: PlanItem[] = [
        {
          capabilitySlug: ep.slug,
          endpointId: ep.id,
          params: { postUrl: "https://www.facebook.com/page/posts/12345" },
          targetVolumeMin: 10,
          targetVolumeMax: 50,
          paginationStrategy: "cursor",
        },
      ];

      const val = validatePlanAgainstLiveCatalog(planItems, [ep]);
      expect(val.valid).toBe(true);
      expect(val.errors).toHaveLength(0);

      // Quote: 50 * 11 = 550 points base. 15% safety buffer on reserve: ceil(550 * 1.15) = 633 points
      const unitPrice = calculateCapabilityUnitPricePoints(ep.catalogPriceUsd, DEFAULT_PRICING_SETTINGS);
      expect(unitPrice).toBe(11);
      const quote = calculateCapabilityQuote(50, ep.catalogPriceUsd, 1000, DEFAULT_PRICING_SETTINGS);
      expect(quote.unitPricePoints).toBe(11);
      expect(quote.rawPoints).toBe(550);
      expect(quote.quotedPoints).toBe(633);

      // Full delivery settlement: 50 delivered -> charge 550, refund 83
      const settlement = calculateFinalSettlement(50, quote.unitPricePoints, quote.quotedPoints);
      expect(settlement.chargePoints).toBe(550);
      expect(settlement.refundPoints).toBe(83);

      // Partial delivery: 30 delivered -> charge 330, refund 303
      const partialSettlement = calculateFinalSettlement(30, quote.unitPricePoints, quote.quotedPoints);
      expect(partialSettlement.chargePoints).toBe(330);
      expect(partialSettlement.refundPoints).toBe(303);
    });

    it("resolves job execution spec for Facebook with POST method", async () => {
      const mockAdmin = {
        from: (tbl: string) => ({
          select: () => ({
            eq: () => Promise.resolve({
              data: [
                {
                  id: "job_quote_fb",
                  items: [
                    {
                      capabilitySlug: "fb-comments",
                      endpointId: "scrapecreators.facebook.post-comments",
                      method: "POST",
                      params: { postUrl: "https://facebook.com/p/1" },
                      paginationStrategy: "cursor",
                      unitCostUsd: 0.0019,
                    },
                  ],
                },
              ],
            }),
          }),
        }),
      };

      const spec = await resolveJobExecutionSpec(mockAdmin, "job_quote_fb", "user_1", "fb-comments", 11);
      expect(spec.endpointId).toBe("scrapecreators.facebook.post-comments");
      expect(spec.method).toBe("POST");
      expect(spec.paginationStrategy).toBe("cursor");
      expect(spec.unitCostUsd).toBe(0.0019);
    });
  });

  describe("Scenario 3: Public X Posts / Keyword Search Journey", () => {
    const xEndpointRaw = {
      id: "socialdata.twitter.search-tweets",
      name: "X Keyword Search",
      summary: "Search public tweets and replies by query or keyword",
      platform: "x",
      method: "GET",
      path: "/twitter/search",
      cost: { usd: 0.00075, unit: "record" },
      input: {
        queryParams: {
          query: { type: "string", required: true, description: "Search query" },
          limit: { type: "integer", maximum: 100 },
        },
      },
      observed: { ok_rate: 0.98, samples: 300 },
      scope: "any_account",
    };

    it("normalizes X search endpoint with 0.00075 USD -> 5 points", () => {
      const ep = normalizeCatalogEndpoint(xEndpointRaw);
      expect(ep.platform).toBe("x");
      expect(ep.method).toBe("GET");
      expect(ep.catalogPriceUsd).toBe(0.00075);
      // Math: ceil(0.00075 * 55 * 10 / 0.10) = ceil(4.125) = 5 points
      expect(ep.pointsPerUnit).toBe(5);
    });

    it("calculates quotes and resolves GET execution spec for X search", async () => {
      const ep = normalizeCatalogEndpoint(xEndpointRaw);
      const quote = calculateCapabilityQuote(20, ep.catalogPriceUsd, 500, DEFAULT_PRICING_SETTINGS);
      expect(quote.unitPricePoints).toBe(5);
      expect(quote.rawPoints).toBe(100);
      // Reserve: ceil(100 * 1.15) = 115 points
      expect(quote.quotedPoints).toBe(115);

      const mockAdmin = {
        from: (tbl: string) => ({
          select: () => ({
            eq: () => Promise.resolve({
              data: [
                {
                  id: "job_quote_x",
                  items: [
                    {
                      capabilitySlug: ep.slug,
                      endpointId: ep.id,
                      method: "GET",
                      params: { query: "ذكاء اصطناعي" },
                      paginationStrategy: "cursor",
                      unitCostUsd: 0.00075,
                    },
                  ],
                },
              ],
            }),
          }),
        }),
      };

      const spec = await resolveJobExecutionSpec(mockAdmin, "job_quote_x", "user_x", ep.slug, 5);
      expect(spec.endpointId).toBe(ep.id);
      expect(spec.method).toBe("GET");
      expect(spec.paginationStrategy).toBe("cursor");
      expect(spec.unitCostUsd).toBe(0.00075);
      expect(spec.params.query).toBe("ذكاء اصطناعي");
    });
  });

  describe("Scenario 4: Public YouTube Comments Journey", () => {
    const ytEndpointRaw = {
      id: "anyapi.youtube.video-comments",
      name: "YouTube Video Comments",
      summary: "Collect public comments from a YouTube video",
      platform: "youtube",
      method: "GET",
      path: "/youtube/comments",
      cost: { usd: 0.0015, unit: "row" },
      input: {
        queryParams: {
          videoId: { type: "string", required: true, description: "YouTube Video ID" },
        },
      },
      observed: { ok_rate: 0.94, samples: 220 },
      scope: "any_account",
    };

    it("calculates 9 points per unit and settles 100 comments cleanly", () => {
      const ep = normalizeCatalogEndpoint(ytEndpointRaw);
      // Math: ceil(0.0015 * 5500) = ceil(8.25) = 9 points
      expect(ep.pointsPerUnit).toBe(9);

      const quote = calculateCapabilityQuote(100, ep.catalogPriceUsd, 2000, DEFAULT_PRICING_SETTINGS);
      expect(quote.unitPricePoints).toBe(9);
      expect(quote.rawPoints).toBe(900);
      expect(quote.quotedPoints).toBe(1035); // ceil(900 * 1.15) = 1035

      const settlement = calculateFinalSettlement(100, 9, 1035);
      expect(settlement.chargePoints).toBe(900);
      expect(settlement.refundPoints).toBe(135);
    });
  });

  describe("Scenario 5: Public TikTok Profiles and Posts", () => {
    it("strictly preserves verified TikTok Profile config: GET, 0.001 USD, single attempt, uniqueId", async () => {
      const mockAdmin = {
        from: () => ({
          select: () => ({
            eq: () => Promise.resolve({ data: [] }),
          }),
        }),
      };

      const spec = await resolveJobExecutionSpec(mockAdmin, "job_tt_1", "user_tt", "tiktok-profile", 6);
      expect(spec.endpointId).toBe("tikhub.tiktok.user.profile");
      expect(spec.method).toBe("GET");
      expect(spec.paginationStrategy).toBe("none");
      expect(spec.unitCostUsd).toBe(0.001);

      // Verify single attempt retry guard
      const executeTregCallSpy = vi.spyOn(tregClientModule, "executeTregCall").mockResolvedValue({
        ok: false,
        httpStatus: 500,
        data: null,
        costMicro: 0,
        latencyMs: 30,
        tregCallId: "call_err",
        isRouteMaxCost: false,
        isPlatformBalanceLow: false,
        error: "server_error",
      });

      await executeTregCallWithRetry({
        endpointId: "tikhub.tiktok.user.profile",
        method: "GET",
        params: { username: "@famous_creator" },
        userId: "user_tt",
        jobId: "job_tt_1",
      });

      expect(executeTregCallSpy).toHaveBeenCalledTimes(1);
      executeTregCallSpy.mockRestore();
    });

    it("normalizes TikTok posts endpoint with cursor pagination and distinct pricing", () => {
      const ttPostsRaw = {
        id: "tikhub.tiktok.user.posts",
        name: "TikTok User Posts",
        summary: "Collect public videos from a user",
        platform: "tiktok",
        method: "GET",
        cost: { usd: 0.0012, unit: "record" },
        input: {
          queryParams: {
            uniqueId: { type: "string", required: true },
            cursor: { type: "string" },
          },
        },
        observed: { ok_rate: 0.95, samples: 400 },
        scope: "any_account",
      };

      const ep = normalizeCatalogEndpoint(ttPostsRaw);
      expect(ep.catalogPriceUsd).toBe(0.0012);
      // Math: ceil(0.0012 * 5500) = ceil(6.6) = 7 points
      expect(ep.pointsPerUnit).toBe(7);
      expect(ep.pagination.type).toBe("cursor");
    });
  });

  describe("Scenario 6: Public Website & Company Information", () => {
    const webEndpointRaw = {
      id: "crawl4ai.web.extract",
      name: "Web Content Extractor",
      summary: "Extract public web page data, structured markdown, and links",
      platform: "web",
      method: "POST",
      path: "/web/extract",
      cost: { usd: 0.002, unit: "call" },
      input: {
        body: {
          url: { type: "string", required: true, description: "Public web page URL" },
        },
      },
      observed: { ok_rate: 0.97, samples: 500 },
      scope: "any_account",
    };

    it("supports general web data collection without platform restrictions", () => {
      const ep = normalizeCatalogEndpoint(webEndpointRaw);
      expect(ep.platform).toBe("web");
      expect(ep.method).toBe("POST");
      expect(ep.catalogPriceUsd).toBe(0.002);
      // Math: ceil(0.002 * 5500) = 11 points
      expect(ep.pointsPerUnit).toBe(11);
      expect(ep.billingUnit).toBe("call");

      const plan: PlanItem[] = [
        {
          capabilitySlug: ep.slug,
          endpointId: ep.id,
          params: { url: "https://example.com/company-profile" },
          targetVolumeMin: 1,
          targetVolumeMax: 1,
          paginationStrategy: "none",
        },
      ];

      const val = validatePlanAgainstLiveCatalog(plan, [ep]);
      expect(val.valid).toBe(true);
      expect(val.errors).toHaveLength(0);
    });
  });

  describe("Scenario 7: Multi-Platform Research Request", () => {
    it("validates multi-step plan across distinct platforms with dependencies", () => {
      const epFb = normalizeCatalogEndpoint({
        id: "scrapecreators.facebook.search",
        name: "Facebook Search",
        platform: "facebook",
        method: "POST",
        cost: { usd: 0.003, unit: "record" },
        input: { body: { query: { type: "string", required: true } } },
        observed: { ok_rate: 0.95, samples: 100 },
        scope: "any_account",
      });

      const epX = normalizeCatalogEndpoint({
        id: "socialdata.twitter.search-tweets",
        name: "X Search",
        platform: "x",
        method: "GET",
        cost: { usd: 0.00075, unit: "record" },
        input: { queryParams: { query: { type: "string", required: true } } },
        observed: { ok_rate: 0.98, samples: 100 },
        scope: "any_account",
      });

      const multiPlan: PlanItem[] = [
        {
          stepId: "step_fb",
          capabilitySlug: epFb.slug,
          endpointId: epFb.id,
          params: { query: "تكاليف الزواج" },
          targetVolumeMin: 10,
          targetVolumeMax: 20,
          paginationStrategy: "cursor",
        },
        {
          stepId: "step_x",
          capabilitySlug: epX.slug,
          endpointId: epX.id,
          params: { query: "تكاليف الزواج" },
          targetVolumeMin: 20,
          targetVolumeMax: 50,
          paginationStrategy: "cursor",
        },
      ];

      const val = validatePlanAgainstLiveCatalog(multiPlan, [epFb, epX]);
      expect(val.valid).toBe(true);
      expect(val.errors).toHaveLength(0);
    });
  });

  describe("Scenario 8: Catalog Endpoint with Missing Cost or Schema (Fails Closed)", () => {
    it("fails closed with 0 points when provider cost is missing; unknown costs never invent prices", () => {
      const invalidCostEndpoint = normalizeCatalogEndpoint({
        id: "broken.endpoint.no-cost",
        name: "Unpriced Tool",
        platform: "web",
        cost: null, // Missing cost
        input: { queryParams: { q: { type: "string", required: true } } },
        observed: { ok_rate: 0.9, samples: 10 },
        scope: "any_account",
      });

      expect(invalidCostEndpoint.catalogPriceUsd).toBe(0);
      expect(invalidCostEndpoint.pointsPerUnit).toBe(0);

      const plan: PlanItem[] = [
        {
          capabilitySlug: invalidCostEndpoint.slug,
          endpointId: invalidCostEndpoint.id,
          params: { q: "test" },
          targetVolumeMin: 1,
          targetVolumeMax: 10,
        },
      ];

      const val = validatePlanAgainstLiveCatalog(plan, [invalidCostEndpoint]);
      expect(val.valid).toBe(false);
      expect(val.errors[0]).toContain("لا تملك تكلفة معتمدة وموثقة");
      expect(val.issues[0].kind).toBe("missing_cost");
    });
  });

  describe("Scenario 9: Unavailable or Private Scope Public Endpoint", () => {
    it("rejects private own_account scope endpoint from public research planning", () => {
      const privateEndpoint = normalizeCatalogEndpoint({
        id: "private.personal.data",
        name: "Private Account Data",
        platform: "facebook",
        cost: { usd: 0.005, unit: "call" },
        input: { queryParams: { id: { type: "string", required: true } } },
        observed: { ok_rate: 0.99, samples: 50 },
        scope: "own_account", // Private scope!
      });

      const plan: PlanItem[] = [
        {
          capabilitySlug: privateEndpoint.slug,
          endpointId: privateEndpoint.id,
          params: { id: "123" },
          targetVolumeMin: 1,
          targetVolumeMax: 1,
        },
      ];

      const val = validatePlanAgainstLiveCatalog(plan, [privateEndpoint]);
      expect(val.valid).toBe(false);
      expect(val.errors[0]).toContain("مخصصة للبيانات الخاصة فقط");
      expect(val.issues[0].kind).toBe("private_scope");
    });

    it("sanitizes endpoints for customer view, scrubbing upstream provider names and internal IDs", () => {
      const ep = normalizeCatalogEndpoint({
        id: "scrapecreators.x.v1-facebook-group",
        name: "ScrapeCreators Facebook Groups",
        summary: "Extract public group posts via Apify and TikHub engine",
        platform: "facebook",
        cost: { usd: 0.002, unit: "record" },
        input: { queryParams: { groupUrl: { type: "string" } } },
        observed: { ok_rate: 0.95, samples: 100 },
        scope: "any_account",
      });

      const sanitized = sanitizeCatalogEndpointForCustomer(ep);
      expect(sanitized.slug).toBe(ep.slug);
      expect(sanitized.nameAr).not.toContain("ScrapeCreators");
      expect(sanitized.descriptionAr).not.toContain("Apify");
      expect(sanitized.descriptionAr).not.toContain("TikHub");
      expect((sanitized as any).catalogPriceUsd).toBeUndefined();
      expect((sanitized as any).id).toBeUndefined();
    });
  });

  describe("Scenario 10: TREG Catalog Endpoints Lookup API", () => {
    it("fetches endpoint details via GET /catalog/endpoints/{endpoint_id}", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "treg.reddit.post-comments",
          name: "Reddit Comments",
          summary: "Extract public Reddit comments",
          platform: "reddit",
          method: "GET",
          cost: { usd: 0.001, unit: "record" },
          input: { queryParams: { postUrl: { type: "string", required: true } } },
          observed: { ok_rate: 0.98, samples: 50 },
          scope: "any_account",
        }),
      });

      const details = await getEndpointDetails("treg.reddit.post-comments", {
        bypassCache: true,
        fetchFn: mockFetch as any,
      });

      expect(details).toBeDefined();
      expect(details!.id).toBe("treg.reddit.post-comments");
      expect(details!.platform).toBe("reddit");
      expect(details!.catalogPriceUsd).toBe(0.001);
      expect(details!.pointsPerUnit).toBe(6);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/catalog/endpoints/treg.reddit.post-comments"),
        expect.objectContaining({ method: "GET" })
      );
    });
  });
});
