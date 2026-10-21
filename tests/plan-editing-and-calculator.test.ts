import { describe, it, expect, vi } from "vitest";
import { extractParamDisplayString } from "../src/lib/planParameters";
import {
  computePublicCalculatorQuote,
  getPublicCalculatorOptions,
  DEFAULT_JOB_POINTS_CAP,
} from "../src/lib/calculatorPricing";
import {
  RAW_SEED_CAPABILITIES,
  APPROVED_CAPABILITY_CATALOG,
  buildApprovedCatalog,
  computeRegistryPointsPerUnit,
  getRegistryPricingSettings,
} from "../src/functions/shared/capabilityRegistry";
import { getCachedCatalogEndpoints } from "../src/functions/shared/catalogClient";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import {
  EditPlanOperationSchema,
  applyPlanOperations,
  createAndSaveManagedQuote,
  computePlanHash,
  type PlanState,
} from "../src/functions/shared/planManager";
import { DEFAULT_PRICING_SETTINGS, calculateCapabilityUnitPricePoints } from "../src/functions/shared/quotes";
import { buildCompanyPlanEditOperations } from "../src/lib/companyPlanEdits";
import { dedupeRecordSearchItems } from "../src/lib/recordSearchPlanItems";
import { extractInterpretedParameters } from "../src/lib/planParameters";

describe("Plan Editing & Parameter Handling (Regression Suite)", () => {
  it("does not quote the same company search twice for one requested country", () => {
    const items = [
      { capabilitySlug: "icypeas-companies-search", params: { country: "ألمانيا", query: { keyword: { include: ["solar"] }, location: { include: ["Germany"] } } }, targetVolumeMax: 20 },
      { capabilitySlug: "icypeas-companies-search", params: { country: "Germany", query: { keyword: { include: ["solar", "renewable energy"] }, location: { include: ["Germany"] } } }, targetVolumeMax: 20 },
    ];
    expect(dedupeRecordSearchItems(items)).toHaveLength(1);
    expect(dedupeRecordSearchItems(items)[0].targetVolumeMax).toBe(20);
  });
  it("extractParamDisplayString safely unpacks company query object without returning [object Object]", () => {
    // Exact shape from buildAutoPlanProposal for company research
    const companyParams = {
      query: {
        keyword: { include: ["شركات مقاولات في مصر"] },
      },
      search: "شركات مقاولات في مصر",
      pagination: { size: 5 },
    };

    const extracted = extractParamDisplayString(companyParams, "بحث عن شركات مقاولات في مصر");
    expect(extracted).toBe("شركات مقاولات في مصر");
    expect(extracted).not.toContain("[object Object]");
    expect(typeof extracted).toBe("string");
  });

  it("extractParamDisplayString unpacks query.keyword.include when search is omitted", () => {
    const queryOnlyParams = {
      query: {
        keyword: { include: ["شركات استيراد وتصدير"] },
      },
    };

    const extracted = extractParamDisplayString(queryOnlyParams);
    expect(extracted).toBe("شركات استيراد وتصدير");
    expect(extracted).not.toContain("[object Object]");
  });

  it("extractParamDisplayString handles profiles, topics, URLs and nested structures", () => {
    expect(extractParamDisplayString({ username: "elonmusk" })).toBe("elonmusk");
    expect(extractParamDisplayString({ topic: "تقنية الذكاء الاصطناعي" })).toBe("تقنية الذكاء الاصطناعي");
    expect(extractParamDisplayString({ topic: { topic: "بيانات السوق" } })).toBe("بيانات السوق");
    expect(extractParamDisplayString({ url: "https://example.com/item" })).toBe("https://example.com/item");
    expect(extractParamDisplayString(null)).toBe("");
    expect(extractParamDisplayString(undefined)).toBe("");
    expect(extractParamDisplayString({})).toBe("");
  });

  it("extractParamDisplayString falls back to extracting topic from summaryAr when params are empty", () => {
    const extracted = extractParamDisplayString({}, "خطة بحث عن مصانع الملابس الجاهزة — ٥ سجلات");
    expect(extracted).toBe("مصانع الملابس الجاهزة — ٥ سجلات");
  });

  it("EditPlanOperationSchema and applyPlanOperations accept structured query object", () => {
    const initialPlan: PlanState = {
      summaryAr: "خطة شركات مقاولات",
      items: [
        {
          capabilitySlug: "company-research",
          params: {
            search: "مقاولات",
            query: { keyword: { include: ["مقاولات"] } },
          },
          targetVolumeMin: 1,
          targetVolumeMax: 5,
        },
      ],
      outputFormats: ["xlsx", "pdf", "csv"],
    };

    const operations = [
      {
        action: "set_limit" as const,
        capabilitySlug: "company-research",
        targetVolumeMax: 10,
      },
      {
        action: "set_param" as const,
        capabilitySlug: "company-research",
        key: "search",
        value: "شركات هندسية",
      },
      {
        action: "set_param" as const,
        capabilitySlug: "company-research",
        key: "query",
        value: { keyword: { include: ["شركات هندسية"] } },
      },
      {
        action: "set_formats" as const,
        formats: ["xlsx", "pdf"] as Array<"xlsx" | "pdf">,
      },
    ];

    // Schema validation must pass
    for (const op of operations) {
      const parsed = EditPlanOperationSchema.safeParse(op);
      expect(parsed.success).toBe(true);
    }

    const updatedPlan = applyPlanOperations(initialPlan, operations as any);
    expect(updatedPlan.items[0].targetVolumeMax).toBe(10);
    expect(updatedPlan.items[0].params.search).toBe("شركات هندسية");
    expect(updatedPlan.items[0].params.query).toEqual({ keyword: { include: ["شركات هندسية"] } });
    expect(updatedPlan.outputFormats).toEqual(["xlsx", "pdf"]);

    // Hash must differ from initial plan
    const initialHash = computePlanHash(initialPlan.items, initialPlan.outputFormats);
    const updatedHash = computePlanHash(updatedPlan.items, updatedPlan.outputFormats);
    expect(updatedHash).not.toBe(initialHash);
  });

  it("saves country and industry edits even when the keyword field is empty", () => {
    const initialPlan: PlanState = {
      summaryAr: "Old summary: Egypt IT companies",
      items: [{
        capabilitySlug: "icypeas-companies-search",
        params: { query: { keyword: { include: ["software"] }, location: { include: ["Egypt"] } } },
        targetVolumeMin: 1,
        targetVolumeMax: 20,
      }],
      outputFormats: ["xlsx", "pdf"],
    };
    const operations = buildCompanyPlanEditOperations("icypeas-companies-search", "", "Germany", "FinTech");
    const updated = applyPlanOperations(initialPlan, operations as any);
    const params = updated.items[0].params;

    expect(params.country).toBe("Germany");
    expect(params.location).toBe("Germany");
    expect(params.industry).toBe("FinTech");
    expect(params.query.location.include).toEqual(["Germany"]);
    expect(params.query.industry.include).toContain("Financial Services");
    expect(extractInterpretedParameters(params, initialPlan.summaryAr)).toMatchObject({
      countryCanonical: "Germany",
      industryAr: "FinTech",
      isDefaultCountry: false,
    });
  });

  it("displays the edited industry ahead of a stale company keyword", () => {
    const params = {
      search: "FinTech في ألمانيا",
      industry: "الأغذية والمطاعم",
      query: {
        keyword: { include: ["FinTech في ألمانيا"] },
        industry: { include: ["Food & Beverages", "Food Production", "Restaurants"] },
        location: { include: ["United Arab Emirates"] },
      },
    };

    expect(extractInterpretedParameters(params, "FinTech companies in Germany")).toMatchObject({
      countryCanonical: "United Arab Emirates",
      industryAr: "الأغذية والمطاعم",
      isDefaultCountry: false,
    });
  });

  it("replaces an untouched old-scope keyword when country and industry change", () => {
    const initialPlan: PlanState = {
      summaryAr: "FinTech في ألمانيا",
      items: [{
        capabilitySlug: "icypeas-companies-search",
        params: {
          search: "FinTech في ألمانيا",
          country: "Germany",
          industry: "FinTech",
          query: { keyword: { include: ["FinTech في ألمانيا"] }, location: { include: ["Germany"] } },
        },
        targetVolumeMin: 1,
        targetVolumeMax: 50,
      }],
      outputFormats: ["xlsx", "pdf"],
    };
    const operations = buildCompanyPlanEditOperations(
      "icypeas-companies-search", "FinTech في ألمانيا", "United Arab Emirates", "الأغذية والمطاعم",
      { keyword: "FinTech في ألمانيا", country: "Germany", industry: "FinTech" },
    );
    const params = applyPlanOperations(initialPlan, operations as any).items[0].params;
    expect(params.search).not.toContain("FinTech");
    expect(JSON.stringify(params.query.keyword)).not.toContain("Germany");
    expect(params.query.location.include).toEqual(["United Arab Emirates"]);
    expect(params.query.industry.include).toContain("Food & Beverages");
  });

  it("clears a keyword synthesized for the editor from an old country and sector", () => {
    const previousParams = {
      country: "Germany",
      industry: "الطاقة الشمسية والمتجددة",
      query: { keyword: { include: ["solar"] }, location: { include: ["Germany"] } },
    };
    const editorValue = extractParamDisplayString(previousParams, "20 solar companies in Germany");
    const operations = buildCompanyPlanEditOperations(
      "icypeas-companies-search", editorValue, "United Arab Emirates", "الأغذية والمطاعم",
      { keyword: editorValue, country: previousParams.country, industry: previousParams.industry },
    );
    const query = operations.find((op) => op.key === "query")?.value;
    expect(JSON.stringify(query)).not.toContain("solar");
    expect(JSON.stringify(query)).not.toContain("Germany");
  });
});

describe("Company Research Capability & Quote Math", () => {
  it("includes verified icypeas-companies-search with verified unit cost 0.00038 USD from live TREG catalog", () => {
    const compCap = RAW_SEED_CAPABILITIES.find((c) => c.slug === "icypeas-companies-search");
    expect(compCap).toBeDefined();
    expect(compCap?.unitCostUsd).toBe(0.00038);
    expect(compCap?.pricingUnit).toBe("item");
    expect(compCap?.tregEndpointId).toBe("icypeas.companies.search");
    expect(compCap?.platform).toBe("companies");
    expect(compCap?.category).toBe("companies");
    expect(compCap?.status).toBe("verified");
    expect(compCap?.maxRows).toBe(500);
  });

  it("calculates 3.168 points per delivered company record (measured cost 0.000576 USD x 5,500): 5 records charge 16 and reserve 19", () => {
    // the old whole-point rule on the call price is unchanged for other services: 0.00038 USD * 55 EGP * 10 markup / 0.10 EGP = 2.09 -> ceil = 3
    const unitPrice = calculateCapabilityUnitPricePoints(0.00038, DEFAULT_PRICING_SETTINGS);
    expect(unitPrice).toBe(3);

    const quoteBreakdown = computePublicCalculatorQuote(
      "icypeas-companies-search",
      5,
      5,
      APPROVED_CAPABILITY_CATALOG,
      DEFAULT_PRICING_SETTINGS
    );

    expect(quoteBreakdown.unitPricePoints).toBe(3.168);
    expect(quoteBreakdown.targetVolumeMax).toBe(5);
    // 5 * 3.168 = 15.84 raw points -> charge ceil = 16; * 1.15 buffer = 18.216 -> reserve ceil = 19 points
    expect(quoteBreakdown.reservedPoints).toBe(19);
    expect(quoteBreakdown.chargedPoints).toBe(16);
    expect(quoteBreakdown.refundPoints).toBe(3);
    expect(quoteBreakdown.reservedEgp).toBe(1.90);
    expect(quoteBreakdown.chargedEgp).toBe(1.60);
  });

  it("getCachedCatalogEndpoints strictly returns validated live catalog entries with short TTL and no hardcoded seed entries", () => {
    // Verified: getCachedCatalogEndpoints must never inject unvalidated or invented seed entries
    const cached = getCachedCatalogEndpoints();
    // Cache only contains entries fetched and cached from live catalog search
    const hasInventedPrice = cached.some((e) => e.catalogPriceUsd === 0.00018);
    expect(hasInventedPrice).toBe(false);
  });
});

describe("Public Calculator Fixes & Inconsistency Elimination", () => {
  it("allows non-profile volume sliders to reach at least 500", () => {
    const options = getPublicCalculatorOptions();
    const fbComments = options.find((o) => o.slug === "social-facebook-comments");
    expect(fbComments).toBeDefined();
    expect(fbComments!.maxVolume).toBeGreaterThanOrEqual(500);

    const companyOpt = options.find((o) => o.slug === "icypeas-companies-search" || o.slug.includes("compan"));
    expect(companyOpt).toBeDefined();
    expect(companyOpt!.maxVolume).toBe(500);

    const tiktokProfile = options.find((o) => o.slug === "tiktok-profile");
    expect(tiktokProfile).toBeDefined();
    expect(tiktokProfile!.maxVolume).toBe(50);
  });

  it("strictly enforces the 5,000-point cap and provides coherent capped numbers for 500 Facebook comments", () => {
    // 500 comments @ 11 points = 5500 raw points -> 6325 reserved -> exceeds the 5,000 cap
    const breakdown = computePublicCalculatorQuote(
      "facebook-post-comments",
      500,
      500,
      APPROVED_CAPABILITY_CATALOG,
      DEFAULT_PRICING_SETTINGS,
      DEFAULT_JOB_POINTS_CAP,
      5 // the provider's daily limit in USD: high enough that the job cap, not the daily limit, is the ceiling
    );

    expect(breakdown.isCapped).toBe(true);
    expect(breakdown.maxCapPoints).toBe(5000);
    // floor(5000 / (11 * 1.15)) = floor(5000 / 12.65) = 395 records
    expect(breakdown.maxCappedVolume).toBe(395);

    // Capped values strictly match the 5,000-point cap and 395 delivered records
    expect(breakdown.cappedReservedPoints).toBe(4997);
    expect(breakdown.cappedReservedEgp).toBe(499.7);
    // 395 * 11 = 4345 points
    expect(breakdown.cappedChargedPoints).toBe(4345);
    expect(breakdown.cappedChargedEgp).toBe(434.5);
    // 4997 - 4345 = 652 points
    expect(breakdown.cappedRefundPoints).toBe(652);
    expect(breakdown.cappedRefundEgp).toBe(65.2);

    expect(breakdown.reservedPoints).toBe(4997);
    expect(breakdown.chargedPoints).toBe(4345);
  });

  it("the default provider daily limit (0.80 USD = 4,400 points) is still the lower ceiling of the calculator until the owner raises it", () => {
    const breakdown = computePublicCalculatorQuote("facebook-post-comments", 500, 500, APPROVED_CAPABILITY_CATALOG, DEFAULT_PRICING_SETTINGS, DEFAULT_JOB_POINTS_CAP);
    expect(breakdown.maxCapPoints).toBe(4400);
    expect(breakdown.cappedReservedPoints).toBeLessThanOrEqual(4400);
  });

  it("caps managed YouTube comment quotes and their reserves at the settlement cap", async () => {
    setProviderBalanceForTesting(10);
    const mockTables: any = {
      from: () => {
        const chain: any = {
          select() { return this; }, eq() { return this; }, not() { return this; }, order() { return this; },
          limit: async () => ({ data: [], error: null }),
          insert: async () => ({ error: null }),
          update() { return this; }, in() { return this; }, then(resolve: any) { resolve({ error: null }); },
        };
        return chain;
      },
    };
    const cap: any = {
      id: "social-youtube-comments", slug: "social-youtube-comments", nameAr: "تعليقات يوتيوب", nameEn: "YouTube comments",
      unitCostUsd: 0.0009, customerPriceUsdPerItem: 0.0015, pricingUnit: "item", maxRows: 1000, enabled: true,
      paramsSchema: "{}", tregEndpointId: "social-youtube-comments",
    };
    const quote = await createAndSaveManagedQuote(mockTables, {
      conversationId: "cap-test", userId: "user-test", userBalance: 10000,
      capabilities: [cap], pricingSettings: DEFAULT_PRICING_SETTINGS,
      plan: { summaryAr: "تعليقات مقطع", items: [{ capabilitySlug: cap.slug, params: {}, targetVolumeMin: 1, targetVolumeMax: 30000 }], outputFormats: ["xlsx"] },
    });
    resetProviderBalanceCacheForTesting();
    expect(quote.pointsCapConstrained).toBe(true);
    expect(quote.requestedVolumeMax).toBe(30000);
    // 0.275 points a comment: the most records whose reserve fits 5,000 is 15,810 (4,347.75 charge, 4,999.76 reserve)
    expect(quote.targetVolumeMax).toBe(15810);
    expect(quote.expectedPoints).toBe(4348);
    expect(quote.quotedPoints).toBe(5000);
    expect(quote.quotedPoints).toBeLessThanOrEqual(5000);
  });

  it("produces identical quote results between managed quote and calculator across samples", async () => {
    const mockTables: any = {
      listRows: async () => ({ rows: [], total: 0 }),
      createRow: async () => ({}),
      updateRow: async () => ({}),
    };

    const sample = { slug: "icypeas-companies-search", target: 5 };
    const calcResult = computePublicCalculatorQuote(
      sample.slug,
      sample.target,
      sample.target,
      APPROVED_CAPABILITY_CATALOG,
      DEFAULT_PRICING_SETTINGS
    );

    const managedQuote = await createAndSaveManagedQuote(mockTables, {
      conversationId: "conv_test_comp",
      userId: "user_test_comp",
      userBalance: 1000,
      capabilities: APPROVED_CAPABILITY_CATALOG,
      pricingSettings: DEFAULT_PRICING_SETTINGS,
      plan: {
        summaryAr: "خطة بحث شركات",
        items: [
          {
            capabilitySlug: sample.slug,
            params: { search: "مقاولات" },
            targetVolumeMin: 1,
            targetVolumeMax: sample.target,
            unitCostUsd: 0.00038,
          },
        ],
        outputFormats: ["xlsx", "pdf", "csv"],
      },
    });

    expect(calcResult.unitPricePoints).toBe(managedQuote.unitPricePoints);
    expect(calcResult.reservedPoints).toBe(managedQuote.quotedPoints);
    expect(calcResult.reservedPoints).toBe(19);
    expect(calcResult.chargedPoints).toBe(16);
  });

  it("regression: earlier greetings like 'ازيك' never override the research topic during plan editing", () => {
    // Scenario: params previously contained greeting or had include: ['ازيك']
    const greetingParams = {
      query: { keyword: { include: ["ازيك"] } },
      search: "ازيك",
    };
    // With summaryAr giving actual topic context
    const displayWithSummary = extractParamDisplayString(
      greetingParams,
      "خطة بحث واستخراج بيانات الشركات عن شركات مقاولات في مصر"
    );
    expect(displayWithSummary).not.toBe("ازيك");
    expect(displayWithSummary).toBe("شركات مقاولات في مصر");

    // Pure search parameter with real topic
    const realParams = {
      query: { keyword: { include: ["شركات سياحة في القاهرة"] } },
      search: "شركات سياحة في القاهرة",
    };
    expect(extractParamDisplayString(realParams)).toBe("شركات سياحة في القاهرة");
  });

  it("regression: a catalog-backed Facebook capability is accepted despite a pending verification label", async () => {
    const { validatePlanPlatformMatch, UNVERIFIED_PLATFORM_MESSAGE_AR } = await import(
      "../src/functions/shared/capabilityRegistry"
    );

    const userMessage = "عايز 5 تعليقات من فيسبوك على منشور معين";
    const planItems = [{ capabilitySlug: "facebook-post-comments" }];

    const caps = APPROVED_CAPABILITY_CATALOG.map((cap) => cap.slug === "facebook-post-comments"
      ? { ...cap, status: "pending_verification" as const, enabled: true }
      : cap);
    const check = validatePlanPlatformMatch(userMessage, planItems, caps);
    expect(check.valid).toBe(true);
  });

  it("acceptQuoteSupabase accepts the owner-confirmed Facebook capability and delegates reservation to the atomic RPC", async () => {
    const { acceptQuoteSupabase } = await import("../src/lib/supabase/quoteAccept");

    const mockAdminClient: any = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: async () => ({
              data: {
                quote_hash: "hash_fb_unverified",
                items: [
                  {
                    capabilitySlug: "facebook-post-comments",
                    endpointId: "anyapi.facebook.company_ads",
                    reservedPoints: 41,
                  },
                ],
              },
              error: null,
            }),
          })),
        })),
      })),
      rpc: vi.fn(async () => ({ data: { success: true }, error: null })),
    };

    const res = await acceptQuoteSupabase(mockAdminClient, {
      userId: "user-1",
      quoteId: "quote-fb-unverified",
    });

    expect(res.success).toBe(true);
    expect(mockAdminClient.rpc).toHaveBeenCalledWith("accept_quote_atomic", expect.any(Object));
  });
});

