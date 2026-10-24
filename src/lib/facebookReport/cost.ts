import { DEFAULT_PRICING_BASIS, RECORD_COSTS, chargeForUnits, pointsPerUsd, reserveForUnits, unitPricePointsFromCost } from "../recordPricing";
import { FACEBOOK_REPORT_SLUG } from "./constants";
import { REPORT_MAX_COMMENTS, SEARCH_SUPPLEMENT_MAX_SHARE } from "./constants";

/**
 * THE COST BASIS of the Facebook topic report, with the basis of every number: M = measured (by the owner's own run of the same job, 24 Oct 2026), C = catalog (the public
 * price list), A = assumed (nobody measured it). This module PRICES NOTHING: the one place a price lives is `RECORD_COSTS["facebook-topic-report"]` in recordPricing.ts,
 * (this file only reads it back as `FACEBOOK_REPORT_COST_USD_PER_COMMENT`); `chargeForUnits` and `reserveForUnits` of the same file turn it into a charge and a reserve. The owner decides the price:
 * changing that one number changes it everywhere (quote writer, calculator, capacity gate, worker settlement).
 */
export type Basis = "M" | "C" | "A";
export interface Figure { value: number; basis: Basis; note: string }

/** What the owner's run measured (provider usage numbers; everything else below is recomputed from them). */
export const MEASURED = {
  totalSpendUsd: { value: 0.9619, basis: "M", note: "406 calls, 305 posts, 1,753 comments" },
  postsDelivered: { value: 305, basis: "M", note: "after de-duplication (4 of 309 were duplicates)" },
  commentsDelivered: { value: 1753, basis: "M", note: "1,806 raw, 53 duplicates removed" },
  pageBrowseCalls: { value: 86, basis: "M", note: "82 with data" },
  pageBrowseSpendUsd: { value: 0.0996, basis: "M", note: "0.0012 per successful call" },
  pagePostsKept: { value: 225, basis: "M", note: "El Consolto: 75 calls, about 3 posts a call" },
  searchSpendUsd: { value: 0.3648, basis: "M", note: "11 calls at 0.0099 to 0.03 plus 2 calls at 0.0295" },
  searchPostsKept: { value: 80, basis: "M", note: "the audit: the other ~80 posts came from the keyword searches" },
  commentCalls: { value: 307, basis: "M", note: "265 with data, 0.00188 per call returning comments" },
  commentSpendUsd: { value: 0.4975, basis: "M", note: "up to 3 pages for high-engagement posts, 1 otherwise" },
} as const satisfies Record<string, Figure>;

/** The catalog's call prices (what the code's source table holds): used for the worst case, never for the price. */
export const CATALOG = {
  pagePostsCallUsd: { value: 0.002, basis: "C", note: "FACEBOOK_PAGE_POSTS[0] in socialSources (the measured price was 0.0012)" },
  searchCallUsd: { value: 0.0661, basis: "C", note: "the dearest search call (observed 0.0099 to 0.03)" },
  commentCallUsd: { value: 0.00188, basis: "C", note: "scrapecreators comments, 10 comments a page" },
} as const satisfies Record<string, Figure>;

/** Derived measured unit costs (USD). */
export const costPerPagePost = (): number => MEASURED.pageBrowseSpendUsd.value / MEASURED.pagePostsKept.value;
export const costPerSearchPost = (): number => MEASURED.searchSpendUsd.value / MEASURED.searchPostsKept.value;
export const costPerCommentFromCommentCalls = (): number => MEASURED.commentSpendUsd.value / MEASURED.commentsDelivered.value;
export const costPerCommentAllIn = (): number => MEASURED.totalSpendUsd.value / MEASURED.commentsDelivered.value;
export const commentsPerPostMeasured = (): number => MEASURED.commentsDelivered.value / MEASURED.postsDelivered.value;

/** The blended cost of one kept post given the share of posts that come from the keyword search (the supplement's cap is the most it can be). */
export function blendedCostPerPost(searchShare: number = SEARCH_SUPPLEMENT_MAX_SHARE): number {
  return (1 - searchShare) * costPerPagePost() + searchShare * costPerSearchPost();
}

/** The cost of one delivered comment for a job that delivers `commentsPerPost` comments per kept post: the post's cost spread over its comments, plus the comment calls. */
export function costPerDeliveredComment(commentsPerPost: number, searchShare: number = SEARCH_SUPPLEMENT_MAX_SHARE): number {
  return costPerCommentFromCommentCalls() + blendedCostPerPost(searchShare) / Math.max(1, commentsPerPost);
}

/**
 * THE cost basis the price is built on, USD per delivered comment: the dearer of (a) the measured all-in cost of the owner's run (0.000549, which had 26% of its posts from
 * the search) and (b) the blended expected cost at the search cap and 5 delivered comments a post (0.000496). Rounded up to 0.00055. ASSUMED in the sense that the run
 * had a different mix than the collector now produces (nothing has been measured with the round-robin and the cap).
 */
export const FACEBOOK_REPORT_COST_USD_PER_COMMENT = RECORD_COSTS[FACEBOOK_REPORT_SLUG].costUsdPerRecord;

export const reportUnitPricePoints = (): number => unitPricePointsFromCost(FACEBOOK_REPORT_COST_USD_PER_COMMENT);

/** Revenue in USD of a charge in points at the platform's point value (0.10 EGP a point, 55 EGP a dollar). */
export const pointsToUsd = (points: number): number => (points * DEFAULT_PRICING_BASIS.creditValueEgp) / DEFAULT_PRICING_BASIS.usdToEgp;

export interface JobArithmetic {
  postsAsked: number;
  commentsPerPost: number;
  /** What the job really holds after the comment ceiling (1,500). */
  comments: number;
  posts: number;
  unitPoints: number;
  chargePoints: number;
  reservePoints: number;
  chargeEgp: number;
  revenueUsd: number;
  /** What the plan-time capacity gate needs: the estimate, and the daily limit / balance that leaves its 10% margin. */
  gateEstimateUsd: number;
  gateNeededUsd: number;
  /** Expected provider cost at the measured all-in figure, and the margin on the charge. */
  expectedCostUsd: number;
  marginAtBasis: number;
  /** The dearest case: one comment per post and every post of the search share. */
  worstCostPerComment: number;
  marginWorst: number;
}

/** The charge and the reserve for a request of `postsAsked` posts with `commentsPerPost` comments each, by the shared pricing rule. */
export function jobArithmetic(postsAsked: number, commentsPerPost: number): JobArithmetic {
  const unitPoints = reportUnitPricePoints();
  const asked = Math.max(1, Math.floor(postsAsked)) * Math.max(1, Math.floor(commentsPerPost));
  const comments = Math.min(asked, REPORT_MAX_COMMENTS);
  const posts = Math.min(Math.floor(postsAsked), Math.ceil(comments / commentsPerPost));
  const chargePoints = chargeForUnits(comments, unitPoints);
  const reservePoints = reserveForUnits(comments, unitPoints);
  const revenueUsd = pointsToUsd(chargePoints);
  const gateEstimateUsd = comments * FACEBOOK_REPORT_COST_USD_PER_COMMENT;
  const expectedCostUsd = comments * costPerCommentAllIn();
  const worst = costPerDeliveredComment(1);
  return {
    postsAsked: Math.floor(postsAsked),
    commentsPerPost,
    comments,
    posts,
    unitPoints,
    chargePoints,
    reservePoints,
    chargeEgp: chargePoints * DEFAULT_PRICING_BASIS.creditValueEgp,
    revenueUsd,
    gateEstimateUsd,
    gateNeededUsd: gateEstimateUsd / 0.9,
    expectedCostUsd,
    marginAtBasis: 1 - expectedCostUsd / revenueUsd,
    worstCostPerComment: worst,
    marginWorst: 1 - (worst * comments) / revenueUsd,
  };
}

export const POINTS_PER_USD = pointsPerUsd();
