import { describe, it, expect } from "vitest";
import { candidatesFor } from "../agent/src/llmPlanner/catalogView";
import { loadTregCatalog } from "../src/lib/treg/catalog";

const catalog = loadTregCatalog();
const access = null;

describe("D-0086 Compliance: Generality across platforms (YouTube, TikTok, Facebook, Instagram)", () => {
  it("YouTube: candidatesFor includes channel videos and search videos when source is present", () => {
    const candidates = candidatesFor(catalog, access, "youtube", "youtube.search.videos", 8, {
      hasSource: true,
      alsoSearch: true,
    });
    const ids = candidates.map((c) => c.id);
    const capabilities = candidates.map((c) => c.capability);

    // Must include both channel listing endpoints and search endpoints
    expect(capabilities).toContain("youtube.channel.videos");
    expect(capabilities).toContain("youtube.search.videos");

    // Must have at least 2 distinct providers
    const providers = new Set(candidates.map((c) => c.provider));
    expect(providers.size).toBeGreaterThanOrEqual(2);
  });

  it("TikTok: candidatesFor includes user videos and search videos when source is present", () => {
    const candidates = candidatesFor(catalog, access, "tiktok", "tiktok.search.videos", 8, {
      hasSource: true,
      alsoSearch: true,
    });
    const capabilities = candidates.map((c) => c.capability);

    // Must include user video listing endpoints and search endpoints
    expect(capabilities).toContain("tiktok.user.videos");
    expect(capabilities).toContain("tiktok.search.videos");

    // Must have at least 2 distinct providers
    const providers = new Set(candidates.map((c) => c.provider));
    expect(providers.size).toBeGreaterThanOrEqual(2);
  });

  it("Facebook: candidatesFor includes page/user posts and search posts when source is present", () => {
    const candidates = candidatesFor(catalog, access, "facebook", "facebook.search.posts", 8, {
      hasSource: true,
      alsoSearch: true,
    });
    const capabilities = candidates.map((c) => c.capability);

    // Must include user/page posts and search posts
    expect(capabilities).toContain("facebook.user.posts");
    expect(capabilities).toContain("facebook.search.posts");

    // Must have at least 2 distinct providers
    const providers = new Set(candidates.map((c) => c.provider));
    expect(providers.size).toBeGreaterThanOrEqual(2);
  });

  it("Instagram: candidatesFor includes user posts when source is present", () => {
    const candidates = candidatesFor(catalog, access, "instagram", "instagram.user.posts", 8, {
      hasSource: true,
      alsoSearch: true,
    });
    const capabilities = candidates.map((c) => c.capability);

    expect(capabilities).toContain("instagram.user.posts");
    expect(capabilities.some((c) => Boolean(c?.includes("search")))).toBe(true);
  });

  it("Source-first ordering: when capability is user posts, search is also available", () => {
    const candidates = candidatesFor(catalog, access, "x", "x.user.posts", 8, {
      hasSource: true,
      alsoSearch: true,
    });
    const capabilities = candidates.map((c) => c.capability);

    expect(capabilities).toContain("x.user.posts");
    expect(capabilities).toContain("x.search.posts");
  });

  it("Generality & Zero ID-word dependency: account-posts endpoint with arbitrary ID shape (not .user.posts) is chosen via fallback group", () => {
    const customEndpoint = {
      id: "vendor_x.custom_stream_feed",
      provider: "vendor_x",
      platform: "custom_platform",
      capability: "custom_platform.stream_feed",
      fallback_group: "social.parents:custom_platform",
      method: "GET",
      path: "/feed",
      cost: { unit: "call", usd: 0.001, currency: "USD" },
      inputs: [{ name: "handle", type: "string", required: true }],
      observed: { ok_rate: 0.99, hit_rate: 0.98, samples: 500 },
    } as any;

    const customSearchEndpoint = {
      id: "vendor_x.search_query",
      provider: "vendor_x",
      platform: "custom_platform",
      capability: "custom_platform.search",
      fallback_group: "social.parents:custom_platform",
      method: "GET",
      path: "/search",
      cost: { unit: "call", usd: 0.001, currency: "USD" },
      inputs: [{ name: "query", type: "string", required: true }],
      observed: { ok_rate: 0.95, hit_rate: 0.90, samples: 300 },
    } as any;

    const mockCatalog = {
      ...catalog,
      endpoints: [...catalog.endpoints, customEndpoint, customSearchEndpoint],
      byId: new Map([...catalog.byId.entries(), [customEndpoint.id, customEndpoint], [customSearchEndpoint.id, customSearchEndpoint]]),
    };

    // When step requests search on custom_platform with hasSource: true (e.g. handle provided)
    const candidates = candidatesFor(mockCatalog as any, null, "custom_platform", "custom_platform.search", 8, {
      hasSource: true,
      alsoSearch: true,
    });

    const ids = candidates.map((c) => c.id);
    // Custom stream feed with arbitrary ID shape (zero .user.posts in ID) is included because of shared fallback_group
    expect(ids).toContain("vendor_x.custom_stream_feed");
    expect(ids).toContain("vendor_x.search_query");
    // Reliability ordering puts higher reliability custom_stream_feed first
    expect(candidates[0].id).toBe("vendor_x.custom_stream_feed");
  });
});
