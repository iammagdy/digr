import { calculateCapabilityUnitPricePoints, DEFAULT_PRICING_SETTINGS } from "../functions/shared/quotes";
import { chargeForUnits, reserveForUnits } from "./recordPricing";
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
