import { describe, it, expect } from "vitest";
import { expandSearchStrategy, buildProviderExecutionQuery } from "../src/lib/server/queryExpansion";
import { extractResearchIntent } from "../src/lib/server/researchIntent";

describe("Query Expansion & Search Strategy Engine", () => {
  it("expands MEP / electromechanical domain terms into multi-angle queries", () => {
    const intent = extractResearchIntent("شركات مقاولات كهروميكانيكية MEP في مصر");
    const strategy = expandSearchStrategy(intent);

    expect(strategy.primaryTopic).toContain("كهروميكانيكية");
    expect(strategy.arabicQueries.some((q) => q.includes("كهروميكانيكية"))).toBe(true);
    expect(strategy.englishQueries.some((q) => q.toLowerCase().includes("mep"))).toBe(true);
    expect(strategy.industrySynonyms.length).toBeGreaterThanOrEqual(3);
    expect(strategy.hashtags).toContain("#MEP");
  });

  it("expands sports / Egypt national football team queries", () => {
    const intent = extractResearchIntent("فيديوهات ملخص وأهداف مباراة منتخب مصر مع بلجيكا");
    const strategy = expandSearchStrategy(intent);

    expect(strategy.arabicQueries.some((q) => q.includes("منتخب مصر"))).toBe(true);
    expect(strategy.englishQueries.some((q) => q.toLowerCase().includes("egypt"))).toBe(true);
    expect(strategy.hashtags.some((h) => h.includes("منتخب_مصر"))).toBe(true);
  });

  it("maps query text to provider execution parameters matching target schema", () => {
    const intent = extractResearchIntent("عايز 50 مقطع فيديو من يوتيوب عن الذكاء الاصطناعي");
    const capability = {
      slug: "youtube-search",
      tregEndpointId: "treg_yt_search_v1",
      paramsSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "integer" },
        },
        required: ["query"],
      },
    };

    const execQuery = buildProviderExecutionQuery("الذكاء الاصطناعي في التعليم", capability, intent);

    expect(execQuery.queryText).toBe("الذكاء الاصطناعي في التعليم");
    expect(execQuery.platform).toBe("youtube");
    expect(execQuery.mappedParams.query).toBe("الذكاء الاصطناعي في التعليم");
    expect(execQuery.mappedParams.count).toBe(50);
  });
});
