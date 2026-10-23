import { describe, expect, it } from "vitest";

import {
  MISSION_BASIS,
  MISSION_DEFAULT_INPUTS,
  MISSION_MAX_SEARCH_PAGES,
  facebookKeywordMissionReport,
  facebookKeywordMissionSensitivity,
} from "../src/lib/costEstimate";
import { RECORD_COSTS, recordUnitPricePoints, unitPriceMicro } from "../src/lib/recordPricing";
import { getSocialCapability } from "../src/lib/socialSources";
import { REVIEW_PAGED_JOB_CEILING_USD, REVIEW_CALL_COST_ESTIMATE_USD } from "../src/lib/server/rowReviewAdvisor";
import catalog from "./fixtures/treg-social-catalog.json";

/**
 * The cost of the Facebook keyword mission, from the catalog read of 2026-10-23 (prices) and stated assumptions (rows per call, share of posts about the topic, share settled
 * by text). Nothing here calls anything. Every input carries its basis; the grid shows what the three unmeasured inputs do to the bill and to the margin.
 */
describe("the unit price of the keyword service is built from stated numbers, by the one shared rule", () => {
  const cost = RECORD_COSTS["social-facebook-keyword-comments"];

  it("0.00235 USD a delivered comment x 5,500 = 12.925 points, ASSUMED (nobody has measured the search's rows a call), and it is the same number the capability carries", () => {
    expect(cost.costUsdPerRecord).toBe(0.00235);
    expect(cost.basis).toBe("ASSUMED");
    expect(unitPriceMicro(cost.costUsdPerRecord)).toBe(12_925_000);
    expect(recordUnitPricePoints("social-facebook-keyword-comments")).toBe(12.925);
    expect(getSocialCapability("social-facebook-keyword-comments")!.rowCostUsd).toBe(cost.costUsdPerRecord);
  });

  it("the cost basis is the catalog's: one search call per 6 posts at 0.02952 USD, half adopted, one comments call (0.00188) per adopted post that gives 5 comments, rounded up", () => {
    const first = catalog["justoneapi.x.facebook-search-post-v1" as keyof typeof catalog] as { costUsd: number };
    const comments = catalog["scrapecreators.x.v1-facebook-post-comments" as keyof typeof catalog] as { costUsd: number };
    const perAdoptedPost = first.costUsd / (6 * 0.5) + comments.costUsd; // 0.02952 / 3 + 0.00188
    expect(perAdoptedPost).toBeCloseTo(0.01172, 6);
    expect(perAdoptedPost / 5).toBeCloseTo(0.002344, 6);
    expect(Math.ceil((perAdoptedPost / 5) * 100_000) / 100_000).toBe(cost.costUsdPerRecord);
  });
});

describe("the owner's request on the stated assumptions", () => {
  const report = facebookKeywordMissionReport();

  it("charge 19,388 points (35.25 USD of revenue), hold 22,296, 100 search calls and 300 comment calls, provider 3.516 USD, model 0.115 USD, margin 89.7%", () => {
    expect(report).toMatchObject({ unitPoints: 12.925, comments: 1500, charge: 19_388, reserve: 22_296, revenueUsd: 35.25, searchCalls: 100, commentCalls: 300, providerUsd: 3.516, reviewCalls: 12 });
    expect(report.modelUsd).toBeCloseTo(0.0155 + 12 * REVIEW_CALL_COST_ESTIMATE_USD, 4);
    expect(report.totalCostUsd).toBeCloseTo(3.6311, 4);
    expect(report.marginShare).toBeCloseTo(0.897, 3);
    expect(report.costPerCommentUsd).toBeCloseTo(0.002344, 6);
    expect(report.basisHolds).toBe(true);
  });

  it("the capacity gate's estimate (volume x the cost of a record) is 3.525 USD: the admin's daily limit must leave 3.92 USD (3.525 / 0.9) for this request to be planned", () => {
    expect(report.gateEstimateUsd).toBe(3.525);
    expect(report.gateEstimateUsd / 0.9).toBeCloseTo(3.9167, 4);
  });

  it("the most the SEARCH can cost one job is bounded: 150 pages at 0.02952 USD plus the comment calls is 4.99 USD, against 35.25 USD of revenue", () => {
    expect(MISSION_MAX_SEARCH_PAGES).toBe(150);
    expect(report.worstCaseProviderUsd).toBe(4.992);
    expect(report.worstCaseProviderUsd).toBeLessThan(report.revenueUsd);
  });

  it("the review budget of such a job (0.25 USD) pays for the worst case of 24 calls the owner's 300 posts can need (600 listed posts, none settled by text)", () => {
    const worstCalls = Math.ceil(600 / 25);
    expect(worstCalls * REVIEW_CALL_COST_ESTIMATE_USD).toBeLessThan(REVIEW_PAGED_JOB_CEILING_USD);
  });

  it("every input carries a basis: the prices CATALOG, the model calls MEASURED, the rows a call and the shares ASSUMED", () => {
    expect(MISSION_BASIS).toMatchObject({ searchCallUsd: "CATALOG", commentsCallUsd: "CATALOG", planningUsd: "MEASURED", reviewCallUsd: "MEASURED", searchRowsPerCall: "ASSUMED", postRelevance: "ASSUMED", evidenceShare: "ASSUMED" });
    expect(Object.keys(MISSION_BASIS).sort()).toEqual(Object.keys(MISSION_DEFAULT_INPUTS).sort());
  });
});

describe("what the three unmeasured numbers do: the job stays profitable at every point of the grid, and the price's cost basis holds only where the search is not poorer than assumed", () => {
  const grid = facebookKeywordMissionSensitivity();

  it("12 combinations of rows a call (3, 6, 10, 20) and the share of posts about the topic (25%, 50%, 75%)", () => {
    expect(grid).toHaveLength(12);
  });

  it("at every point the whole job (provider and model) costs less than half of its revenue: the worst point (3 posts a call, 25% on topic) is 12.59 USD against 35.25 USD", () => {
    for (const { rowsPerCall, relevance, report } of grid) expect(report.totalCostUsd, `${rowsPerCall} rows, ${relevance}`).toBeLessThan(report.revenueUsd * 0.5);
    const worst = grid.find((point) => point.rowsPerCall === 3 && point.relevance === 0.25)!.report;
    expect(worst.totalCostUsd).toBeCloseTo(12.5867, 4);
    expect(worst.marginShare).toBeCloseTo(0.643, 3);
  });

  it("the cost basis of the price (0.00235 USD a comment) holds at 6 posts a call and half on topic, or better, and does NOT hold where the search is poorer: stated, not hidden", () => {
    const holds = (rows: number, share: number) => grid.find((point) => point.rowsPerCall === rows && point.relevance === share)!.report.basisHolds;
    expect(holds(6, 0.5)).toBe(true);
    expect(holds(6, 0.75)).toBe(true);
    expect(holds(10, 0.5)).toBe(true);
    expect(holds(20, 0.25)).toBe(true);
    expect(holds(6, 0.25)).toBe(false);
    expect(holds(3, 0.5)).toBe(false);
    expect(holds(10, 0.25)).toBe(false);
  });

  it("the search never costs more than its page bound: where the grid asks for more than 150 pages (3 posts a call, 25% on topic) the job stops at 150 and delivers less, charged only for what it delivered", () => {
    const poor = grid.find((point) => point.rowsPerCall === 3 && point.relevance === 0.25)!.report;
    expect(poor.searchCalls).toBe(400);
    expect(poor.searchCalls).toBeGreaterThan(MISSION_MAX_SEARCH_PAGES);
    expect(MISSION_MAX_SEARCH_PAGES * 0.02952 + 300 * 0.00188).toBeLessThan(poor.providerUsd);
  });
});
