import { calculateCapabilityUnitPricePoints, DEFAULT_PRICING_SETTINGS } from "../functions/shared/quotes";
import { chargeForUnits, recordUnitPricePoints, reserveForUnits } from "./recordPricing";
import { REVIEW_CALL_COST_ESTIMATE_USD, SOCIAL_REVIEW_ROWS_PER_CALL } from "./server/rowReviewAdvisor";

/**
 * A cost estimate of one Facebook topic request (posts found by a topic, then the comments of those posts), written from the code's own numbers and the
 * committed catalog fixture. READ-ONLY: it calls nothing, writes nothing and changes no price. Every number carries its basis:
 *  - MEASURED: taken from a production measurement the code already records (the planning call, the review call);
 *  - CATALOG: a provider catalog price read from the committed fixture (`tests/fixtures/treg-social-catalog.json`, captured 2026-10-17), not a live read;
 *  - ASSUMED: nobody has measured it (rows per call, the share of posts about the topic, the share of rows a code filter drops).
 */
export type Basis = "MEASURED" | "CATALOG" | "ASSUMED";

export interface CostInputs {
  posts: number;
  commentsPerPost: number;
  /** Catalog price of one provider call that lists posts, USD (CATALOG: the page-posts source in the fixture is 0.00135). */
  postsCallUsd: number;
  /** Posts one listing call returns (ASSUMED: the page-posts sources return 3 to 10). */
  postsPerCall: number;
  /** Share of the listed posts that are about the topic (ASSUMED). */
  postRelevance: number;
  /** Catalog price of one comments call, USD (CATALOG 0.00188): one call per post, the endpoint takes a post link. */
  commentsCallUsd: number;
  /** One planning model call, USD (MEASURED, owner figure). */
  planningUsd: number;
  /** Share of rows a code-side filter drops before any model review (ASSUMED). */
  prefilterDropShare: { posts: number; comments: number };
}

export const DEFAULT_INPUTS: CostInputs = {
  posts: 300,
  commentsPerPost: 5,
  postsCallUsd: 0.00135,
  postsPerCall: 10,
  postRelevance: 0.5,
  commentsCallUsd: 0.00188,
  planningUsd: 0.0155,
  prefilterDropShare: { posts: 0.3, comments: 0.2 },
};

export const BASIS: Record<string, Basis> = {
  postsCallUsd: "CATALOG",
  commentsCallUsd: "CATALOG",
  planningUsd: "MEASURED",
  reviewCallUsd: "MEASURED",
  postsPerCall: "ASSUMED",
  postRelevance: "ASSUMED",
  prefilterDropShare: "ASSUMED",
  postsUnitPrice: "CATALOG",
  commentsUnitPrice: "CATALOG",
};

/** What one point is worth to the customer in USD: 0.10 EGP at 55 EGP a dollar (the provider cost behind a point is a tenth of that: the markup is 10). */
const REVENUE_USD_PER_POINT = DEFAULT_PRICING_SETTINGS.creditValueEgp / DEFAULT_PRICING_SETTINGS.usdToEgp;
const round = (value: number, digits = 4) => Number(value.toFixed(digits));

export interface Scenario {
  label: string;
  providerCalls: { posts: number; comments: number };
  providerUsd: number;
  modelCalls: { planning: number; review: number };
  modelUsd: number;
  totalCostUsd: number;
  /** Rows the review budget lets through (rows beyond it are not delivered and not charged). */
  reviewableRows: number | null;
  /** 1 - cost / revenue of the whole job. */
  marginShare: number;
}

export interface CostReport {
  unit: { postsPoints: number; commentsPoints: number };
  rows: { posts: number; comments: number };
  charge: number;
  reserve: number;
  revenueUsd: number;
  scenarios: Scenario[];
}

/** The review of every row by the model, as the per-row path does for X: 25 rows a call at the measured cost of a call. */
const reviewCalls = (rows: number) => Math.ceil(Math.max(0, rows) / SOCIAL_REVIEW_ROWS_PER_CALL);

export function facebookTopicCostReport(input: CostInputs = DEFAULT_INPUTS, reviewCeilingUsd = 0.15): CostReport {
  const postsPoints = calculateCapabilityUnitPricePoints(input.postsCallUsd, DEFAULT_PRICING_SETTINGS); // the older whole-point rule: 8
  const commentsPoints = calculateCapabilityUnitPricePoints(0.0019, DEFAULT_PRICING_SETTINGS); // customer rate per comment: 11
  const comments = input.posts * input.commentsPerPost;
  const charge = chargeForUnits(input.posts, postsPoints) + chargeForUnits(comments, commentsPoints);
  const reserve = reserveForUnits(input.posts, postsPoints) + reserveForUnits(comments, commentsPoints);
  const revenueUsd = charge * REVENUE_USD_PER_POINT;

  const listed = Math.ceil(input.posts / input.postRelevance); // posts the listing must read to find the wanted ones
  const postCalls = Math.ceil(listed / input.postsPerCall);
  const callUsd = REVIEW_CALL_COST_ESTIMATE_USD;
  // Provider calls: the listing, then ONE comments call per post whose comments are read (the endpoint takes a post link).
  const providerFor = (commentPosts: number) => ({ calls: { posts: postCalls, comments: commentPosts }, usd: postCalls * input.postsCallUsd + commentPosts * input.commentsCallUsd });
  const make = (label: string, review: number, reviewableRows: number | null, commentPosts: number): Scenario => {
    const p = providerFor(commentPosts);
    const modelUsd = input.planningUsd + review * callUsd;
    return { label, providerCalls: p.calls, providerUsd: round(p.usd), modelCalls: { planning: 1, review }, modelUsd: round(modelUsd), totalCostUsd: round(p.usd + modelUsd), reviewableRows, marginShare: round(1 - (p.usd + modelUsd) / revenueUsd, 3) };
  };

  // A. today's per-row review of every listed post and every comment, with the per-job review ceiling (what the worker would face).
  // Without a post-level adoption every listed post has its comments read, and every listed post and every comment of them is a row to review.
  const everyRow = listed + listed * input.commentsPerPost;
  const wanted = reviewCalls(everyRow);
  const allowed = Math.floor(reviewCeilingUsd / callUsd);
  const a = make("A. each row reviewed by the model (the per-row path), review budget ceiling 0.15 USD", Math.min(wanted, allowed), Math.min(everyRow, allowed * SOCIAL_REVIEW_ROWS_PER_CALL), listed);
  // A0. the same without the ceiling: what the review of every row would cost.
  const a0 = make("A0. each row reviewed, no ceiling", wanted, everyRow, listed);
  // B. after this change: code filters first, posts judged as a list, comments accepted by rules under accepted posts, comments fetched only for accepted posts.
  const keptPosts = Math.ceil(listed * (1 - input.prefilterDropShare.posts));
  const b = make("B. code filter, post-level review, comments only for accepted posts", reviewCalls(keptPosts), keptPosts, input.posts);
  return {
    unit: { postsPoints, commentsPoints },
    rows: { posts: input.posts, comments },
    charge,
    reserve,
    revenueUsd: round(revenueUsd, 2),
    scenarios: [a0, a, b],
  };
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------
 * The Facebook KEYWORD MISSION (one item: `social-facebook-keyword-comments`): posts are searched by a keyword, judged as lists, and the comments of the adopted posts
 * are read. Written from the public catalog read of 2026-10-23 (a free GET of the catalog page; no endpoint was called):
 *   CATALOG  the first search source costs 0.02952 USD a call (0.2 CNY), the second 0.06606 USD, a comments call 0.00188 USD;
 *   MEASURED the planning call (0.0155 USD) and the review call (0.0083 USD per 25 rows), the figures of the owner and of production;
 *   ASSUMED  posts one search call returns (the catalog publishes NONE: one catalog review reports 6), the share of listed posts that are about the topic, the share of
 *            listed posts whose own text settles them without the model. Nobody has measured these three: the sensitivity grid below shows what each does to the bill.
 * ------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
export interface MissionInputs {
  posts: number;
  commentsPerPost: number;
  searchCallUsd: number;
  searchRowsPerCall: number;
  postRelevance: number;
  commentsCallUsd: number;
  planningUsd: number;
  reviewCallUsd: number;
  /** Share of the listed posts that the post's own text settles (they never reach the model). */
  evidenceShare: number;
}

export const MISSION_DEFAULT_INPUTS: MissionInputs = {
  posts: 300,
  commentsPerPost: 5,
  searchCallUsd: 0.02952,
  searchRowsPerCall: 6,
  postRelevance: 0.5,
  commentsCallUsd: 0.00188,
  planningUsd: 0.0155,
  reviewCallUsd: REVIEW_CALL_COST_ESTIMATE_USD,
  evidenceShare: 0.5,
};

export const MISSION_BASIS: Record<keyof MissionInputs, Basis> = {
  posts: "ASSUMED",
  commentsPerPost: "ASSUMED",
  searchCallUsd: "CATALOG",
  searchRowsPerCall: "ASSUMED",
  postRelevance: "ASSUMED",
  commentsCallUsd: "CATALOG",
  planningUsd: "MEASURED",
  reviewCallUsd: "MEASURED",
  evidenceShare: "ASSUMED",
};

/** The most pages of search results one job reads (the adapter's bound, `PAGED_MAX_DISCOVERY_PAGES`) and the posts a review list holds. */
export const MISSION_MAX_SEARCH_PAGES = 150;
const MISSION_REVIEW_LIST = 50;

export interface MissionReport {
  unitPoints: number;
  comments: number;
  charge: number;
  reserve: number;
  revenueUsd: number;
  listedPosts: number;
  searchCalls: number;
  commentCalls: number;
  providerUsd: number;
  reviewCalls: number;
  modelUsd: number;
  totalCostUsd: number;
  costPerCommentUsd: number;
  /** The cost the unit price is built on (`RECORD_COSTS`, 0.00235 USD a delivered comment). */
  costBasisUsd: number;
  /** True when the real cost per comment is at or under the cost the price is built on. */
  basisHolds: boolean;
  marginShare: number;
  /** What the capacity gate estimates for this plan (volume x the cost per record). */
  gateEstimateUsd: number;
  /** The most the search can cost one job whatever the source does: the page bound times the dearest-call price, plus one comments call per post. */
  worstCaseProviderUsd: number;
}

export function facebookKeywordMissionReport(input: MissionInputs = MISSION_DEFAULT_INPUTS, costBasisUsd = 0.00235): MissionReport {
  const unitPoints = recordUnitPricePoints("social-facebook-keyword-comments")!;
  const comments = input.posts * input.commentsPerPost;
  const charge = chargeForUnits(comments, unitPoints);
  const reserve = reserveForUnits(comments, unitPoints);
  const revenueUsd = charge * REVENUE_USD_PER_POINT;
  const listedPosts = Math.ceil(input.posts / input.postRelevance);
  const searchCalls = Math.ceil(listedPosts / input.searchRowsPerCall);
  const commentCalls = input.posts;
  const providerUsd = searchCalls * input.searchCallUsd + commentCalls * input.commentsCallUsd;
  // the posts the text settles never reach the model; the others go in lists of 50 (two calls of 25 each)
  const needReview = Math.ceil(listedPosts * (1 - input.evidenceShare));
  const reviewCalls = Math.ceil(needReview / SOCIAL_REVIEW_ROWS_PER_CALL);
  const modelUsd = input.planningUsd + reviewCalls * input.reviewCallUsd;
  const totalCostUsd = providerUsd + modelUsd;
  const costPerCommentUsd = providerUsd / comments;
  return {
    unitPoints,
    comments,
    charge,
    reserve,
    revenueUsd: round(revenueUsd, 2),
    listedPosts,
    searchCalls,
    commentCalls,
    providerUsd: round(providerUsd),
    reviewCalls,
    modelUsd: round(modelUsd),
    totalCostUsd: round(totalCostUsd),
    costPerCommentUsd: round(costPerCommentUsd, 6),
    costBasisUsd,
    basisHolds: costPerCommentUsd <= costBasisUsd + 1e-12,
    marginShare: round(1 - totalCostUsd / revenueUsd, 3),
    gateEstimateUsd: round(comments * costBasisUsd),
    worstCaseProviderUsd: round(MISSION_MAX_SEARCH_PAGES * input.searchCallUsd + commentCalls * input.commentsCallUsd),
  };
}

/** The bill and the margin for every combination of the two figures nobody has measured: posts a search call returns, and the share of listed posts about the topic. */
export function facebookKeywordMissionSensitivity(rowsPerCall = [3, 6, 10, 20], relevance = [0.25, 0.5, 0.75]): Array<{ rowsPerCall: number; relevance: number; report: MissionReport }> {
  return rowsPerCall.flatMap((rows) => relevance.map((share) => ({ rowsPerCall: rows, relevance: share, report: facebookKeywordMissionReport({ ...MISSION_DEFAULT_INPUTS, searchRowsPerCall: rows, postRelevance: share }) })));
}
