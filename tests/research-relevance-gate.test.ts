import { describe, expect, it } from "vitest";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { filterRowsByDateRange } from "../src/lib/server/dateRangeFilter";

describe("deterministic relevance gate before settlement", () => {
  it("keeps broad Utilities company rows out of charged delivery when the description is unrelated", () => {
    const context = {
      capabilitySlug: "icypeas-companies-search",
      endpointId: "icypeas.companies.search",
      params: { country: "Egypt", industry: "الكهرباء والطاقة الكهربائية" },
    };
    const rows = [
      { company_name: "Water Co", industry: "Utilities", description: "Water treatment and chemical supplies", location: "Alexandria, Egypt" },
      { company_name: "Game App", industry: "Utilities", description: "Android game tools", location: "Giza, Egypt" },
      { company_name: "Power Works", industry: "Utilities", description: "Electrical grid design and power installation", location: "Cairo, Egypt" },
    ];

    expect(rows.map((row) => evaluateResearchRowRelevance(row, context).decision)).toEqual([
      "no_match", "no_match", "match",
    ]);
    expect(evaluateResearchRowRelevance({ company_name: "Unknown Utility", industry: "Utilities", location: "Cairo, Egypt" }, context).decision).toBe("uncertain");
  });

  it("rejects basketball search results whose text is only about football", () => {
    const context = {
      capabilitySlug: "social-x-posts",
      endpointId: "anyapi.x.search.posts",
      params: { query: "كرة السلة" },
    };
    expect(evaluateResearchRowRelevance({ text: "Football highlights and goals from tonight" }, context).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ text: "Basketball game recap and NBA scores" }, context).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ text: "مباراتين كرة سلة في الدوري" }, context).decision).toBe("match");
    // Both sports named, football dominating: not delivered and not discarded either, it goes to the review sheet (never charged).
    expect(evaluateResearchRowRelevance({ text: "كرة سلة مقابل كرة قدم وكرة قدم" }, context).decision).toBe("uncertain");
  });

  it("uses a comment's associated video title as topic context and rejects unrelated video comments", () => {
    const context = {
      capabilitySlug: "social-tiktok-comments",
      endpointId: "tikhub.tiktok.video.comments",
      params: { query: "كرة السلة" },
    };
    expect(evaluateResearchRowRelevance({ comment_text: "مبروك", video_title: "كرة السلة في مصر" }, context).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ comment_text: "هدف رائع", video_title: "ملخص مباراة كرة القدم" }, context).decision).toBe("no_match");
  });

  it("rejects only explicit contradictory country metadata and trusts the region-scoped trending source when metadata is absent or city-only", () => {
    const context = {
      capabilitySlug: "social-tiktok-videos",
      endpointId: "scrapecreators.x.v1-tiktok-get-trending-feed",
      params: { trending: true, region: "EG" },
    };
    expect(evaluateResearchRowRelevance({ title: "كعكة الشوكولاتة", region: "US" }, context).decision).toBe("no_match");
    expect(evaluateResearchRowRelevance({ title: "كعكة الشوكولاتة" }, context).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ title: "كعكة الشوكولاتة", location: "Cairo" }, context).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ title: "كعكة الشوكولاتة", location: "Cairo, Egypt" }, context).decision).toBe("match");
    // Upload age is not a trend timestamp; a region-scoped trending feed may resurface older videos.
    expect(evaluateResearchRowRelevance({ title: "كعكة الشوكولاتة", published_at: "2026-01-01" }, context).decision).toBe("match");
    expect(evaluateResearchRowRelevance({ title: "كعكة الشوكولاتة", country: "Saudi Arabia" }, context).decision).toBe("no_match");
  });

  it("applies requested date boundaries and excludes undated rows when a period was requested", () => {
    const rows = [
      { title: "Solar project", published_at: "2026-10-02T00:00:00Z" },
      { title: "Solar project", published_at: "2026-08-02T00:00:00Z" },
      { title: "Solar project" },
    ];
    const result = filterRowsByDateRange(rows, "2026-09-01", "2026-10-18");
    expect(result.rows).toEqual([rows[0]]);
    expect(result.excludedCount).toBe(2);
  });
});
