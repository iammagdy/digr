import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  searchCatalog,
  clearCatalogCache,
  normalizeCatalogEndpoint,
  detectPaginationStrategy,
  buildNormalizedParamsSchema,
  sanitizeCatalogEndpointForCustomer,
  scrubProviderNames,
  mapSearchQueryToEnglish,
} from "../src/functions/shared/catalogClient";

describe("Phase A: Dynamic TREG Catalog Access, Normalization, 24h Caching & Sanitization", () => {
  beforeEach(() => {
    clearCatalogCache();
    vi.restoreAllMocks();
  });

  const mockTregSearchResponse = {
    query: "facebook posts",
    count: 3,
    total: 3,
    results: [
      {
        id: "anyapi.facebook.posts.search",
        provider: "anyapi",
        provider_display: "AnyAPI",
        name: "Facebook Keyword Post Search",
        summary: "Search public Facebook posts by keyword and date range",
        method: "POST",
        path: "/v1/run/facebook.posts",
        platform: "facebook",
        platform_label: "Facebook",
        cost: {
          type: "per_success",
          value: 0.002,
          currency: "USD",
          unit: "call",
          usd: 0.002,
        },
        input: {
          bodyType: "json",
          body: {
            query: { type: "string", required: true, note: "Search keywords" },
            limit: { type: "integer", required: false, maximum: 50, note: "Results limit" },
            cursor: { type: "string", required: false, note: "Pagination cursor" },
          },
        },
        observed: {
          samples: 5000,
          ok_rate: 0.99,
          p50_ms: 1200,
        },
        scope: "any_account",
      },
      {
        id: "scrapecreators.facebook.posts.search",
        provider: "scrapecreators",
        provider_display: "ScrapeCreators",
        name: "Facebook Posts Scraper",
        summary: "Scrapes public Facebook posts",
        method: "GET",
        path: "/v1/facebook/search",
        platform: "facebook",
        platform_label: "Facebook",
        cost: {
          type: "per_call",
          value: 0.005,
          currency: "USD",
          unit: "call",
          usd: 0.005,
        },
        input: {
          queryParams: {
            query: { type: "string", required: true, note: "Search keywords" },
            offset: { type: "integer", required: false, note: "Offset page" },
          },
        },
        observed: {
          samples: 2000,
          ok_rate: 0.92,
          p50_ms: 2200,
        },
        scope: "any_account",
      },
      {
        id: "facebook.facebook.own.posts",
        provider: "facebook",
        provider_display: "Facebook",
        name: "Your Facebook Posts",
        summary: "Requires connected Facebook page token",
        method: "GET",
        path: "/me/posts",
        platform: "facebook",
        cost: { type: "free", value: 0, usd: 0 },
        scope: "own_account", // Private OAuth scope
        observed: { samples: 100, ok_rate: 1.0 },
      },
    ],
  };

  it("1. Searches TREG catalog API and extracts endpoint ID, Arabic name, platform, schema, unit, price, and success rate", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockTregSearchResponse,
    });

    const results = await searchCatalog("facebook posts", "facebook", { fetchFn: mockFetch as any });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain("https://treg.to/catalog/search?q=facebook%20posts");

    // own_account (private OAuth) must be filtered out
    expect(results.length).toBe(2);
    expect(results.some((r) => r.id === "facebook.facebook.own.posts")).toBe(false);

    const first = results[0];
    expect(first.id).toBe("anyapi.facebook.posts.search");
    expect(first.platform).toBe("facebook");
    expect(first.nameAr).toContain("فيسبوك");
    expect(first.billingUnit).toBe("call");
    expect(first.catalogPriceUsd).toBe(0.002);
    expect(first.pointsPerUnit).toBeGreaterThan(0);
    expect(first.observedSuccessRate).toBe(0.99);
    expect(first.pagination.type).toBe("cursor");
    expect(first.pagination.paramName).toBe("cursor");
    expect(first.pagination.limitParam).toBe("limit");
    expect(first.paramsSchema.required).toContain("query");
  });

  it("2. Prefers endpoints with higher observed success rate and lower price", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockTregSearchResponse,
    });

    const results = await searchCatalog("facebook posts", "facebook", { fetchFn: mockFetch as any });

    // anyapi (99% ok, $0.002) should rank before scrapecreators (92% ok, $0.005)
    expect(results[0].id).toBe("anyapi.facebook.posts.search");
    expect(results[1].id).toBe("scrapecreators.facebook.posts.search");
  });

  it("3. Caches search results in memory with 24-hour TTL and serves cached data on repeated calls", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockTregSearchResponse,
    });

    // First call calls network
    const call1 = await searchCatalog("facebook posts", "facebook", { fetchFn: mockFetch as any });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(call1.length).toBe(2);

    // Second call with same query within 24h serves from memory cache
    const call2 = await searchCatalog("facebook posts", "facebook", { fetchFn: mockFetch as any });
    expect(mockFetch).toHaveBeenCalledTimes(1); // Not called again!
    expect(call2).toEqual(call1);

    // Bypass cache forces network fetch
    await searchCatalog("facebook posts", "facebook", { bypassCache: true, fetchFn: mockFetch as any });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("4. Detects pagination strategies accurately (cursor, offset, page, none)", () => {
    const cursorInput = {
      body: {
        cursor: { type: "string" },
        max_results: { type: "integer", maximum: 100 },
      },
    };
    expect(detectPaginationStrategy(cursorInput)).toEqual({
      type: "cursor",
      paramName: "cursor",
      limitParam: "max_results",
      maxLimit: 100,
    });

    const offsetInput = {
      queryParams: {
        offset: { type: "integer" },
        count: { type: "integer", maximum: 50 },
      },
    };
    expect(detectPaginationStrategy(offsetInput)).toEqual({
      type: "offset",
      paramName: "offset",
      limitParam: "count",
      maxLimit: 50,
    });

    const pageInput = {
      queryParams: {
        page: { type: "integer" },
        per_page: { type: "integer" },
      },
    };
    expect(detectPaginationStrategy(pageInput)).toEqual({
      type: "page",
      paramName: "page",
      limitParam: "per_page",
      maxLimit: 100,
    });

    const noneInput = {
      queryParams: {
        username: { type: "string" },
      },
    };
    expect(detectPaginationStrategy(noneInput)).toEqual({
      type: "none",
      limitParam: undefined,
      maxLimit: 100,
    });
  });

  it("5. Strictly scrubs provider names and internal endpoint IDs for customer sanitization", () => {
    const raw: any = {
      id: "tikhub.tiktok.user.profile",
      name: "TikHub TikTok Profile Scraper",
      summary: "Scrapes public profiles via TikHub provider",
      method: "GET",
      platform: "tiktok",
      cost: { usd: 0.001, unit: "call" },
      input: {
        queryParams: {
          username: { type: "string", note: "TikHub username parameter" },
        },
      },
      observed: { ok_rate: 0.99, samples: 1000 },
    };

    const endpoint = normalizeCatalogEndpoint(raw);
    const sanitized = sanitizeCatalogEndpointForCustomer(endpoint);

    // Assert zero leakage of internal provider names or raw endpoint IDs
    expect(sanitized.nameAr).not.toContain("tikhub");
    expect(sanitized.nameAr).not.toContain("TikHub");
    expect(sanitized.descriptionAr).not.toContain("tikhub");
    expect(sanitized.descriptionAr).not.toContain("TikHub");
    expect((sanitized as any).id).toBeUndefined();
    expect((sanitized as any).tregEndpointId).toBeUndefined();
    expect((sanitized as any).costUsd).toBeUndefined();
    expect(sanitized.pointsPerUnit).toBeGreaterThan(0);
    expect(scrubProviderNames("TikHub AnyAPI ScrapeCreators BrightData")).toBe("");
  });

  it("6. Correctly maps Arabic user search terms to English keywords for TREG catalog search", () => {
    expect(mapSearchQueryToEnglish("شركات ومقاولات في مصر")).toBe("companies");
    expect(mapSearchQueryToEnglish("تعليقات فيسبوك عن الذهب")).toBe("facebook comments");
    expect(mapSearchQueryToEnglish("عايز تعليقات", "facebook")).toBe("facebook comments");
    expect(mapSearchQueryToEnglish("منشورات فيسبوك")).toBe("facebook posts");
    expect(mapSearchQueryToEnglish("حساب تيك توك")).toBe("tiktok profile");
    expect(mapSearchQueryToEnglish("linkedin profiles")).toBe("linkedin profiles");
    expect(mapSearchQueryToEnglish("بحث جوجل")).toBe("web search");
    expect(mapSearchQueryToEnglish("بحث", "facebook")).toBe("facebook search");
  });
});
