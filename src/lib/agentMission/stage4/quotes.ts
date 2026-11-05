import { pointsAr } from "../../pointsFormat";
import { DEFAULT_MISSION_PRICING_SETTINGS, pointsPerCostUsd, type MissionPricingSettings } from "../../missionPricing";

/**
 * STAGE 4, THE PRICES SHOWN BY CODE (docs/STAGE-4.md, FOUNDATION-PLAN PR 6). DISPLAY ONLY: a price INPUT for the card, never a charge. Nothing here reserves, charges, releases or writes a
 * ledger row; no money path imports this file (tests/stage4-quotes.test.ts walks the import graph). Charging waits for the separate money PR (PR 7), which needs the owner's explicit brief.
 * The only money-related import is the read-only points rate (`pointsPerCostUsd` of missionPricing.ts: the customer's points per USD of cost, the markup included).
 */
export const REVIEW_MIN_POINTS = 100;
export const REVIEW_CELLS_PER_POINT = 100;
export const EDIT_MIN_POINTS = 100;

/** The review's price: 1 point per 100 cells (rounded up), at least 100. `cells`: the readable cells of the file (review.ts `reviewCellsOf`). */
export function reviewQuote(cells: number): number {
  if (!Number.isInteger(cells) || cells < 0) throw new Error("reviewQuote: cells must be a whole number of 0 or more");
  return Math.max(REVIEW_MIN_POINTS, Math.ceil(cells / REVIEW_CELLS_PER_POINT));
}

/**
 * The price of an edit after delivery: its REAL cost (USD, measured on its calls) times the markup, in points (rounded up), at least 100. It takes no reason: an edit that fixes our own
 * mistake is priced like any other (the owner's rule: our mistake is not free). The cost is read to the micro-dollar so the result never depends on floating-point dust.
 */
export function editQuote(realCostUsd: number, settings: MissionPricingSettings = DEFAULT_MISSION_PRICING_SETTINGS): number {
  if (!Number.isFinite(realCostUsd) || realCostUsd < 0) throw new Error("editQuote: the real cost must be a number of 0 or more");
  const micro = Math.round(realCostUsd * 1_000_000);
  const points = Math.ceil((micro * pointsPerCostUsd(settings)) / 1_000_000 - 1e-9);
  return Math.max(EDIT_MIN_POINTS, points);
}

/** The card's line for a quote: the price, said to be computed by code, and that nothing was charged. */
export const quoteLineAr = (kind: "review" | "edit", points: number): string => `${kind === "review" ? "سعر المراجعة" : "سعر التعديل"}: ${pointsAr(points)}، محسوب بالكود. لم يُخصم شيء.`;

/**
 * The card's line for an add-on that is HELD before it runs (docs/MONEY-PR-7A.md section 2): the estimate, the most it can cost (the hold) and that only what it really cost is charged. Display only, like the lines above;
 * the hold and the charge are computed by the money side (addonSettlement.ts), and tests pin the two equal.
 */
export const holdLineAr = (estimatePoints: number, holdPoints: number): string => `يُقدَّر التعديل بنحو ${pointsAr(estimatePoints)}، ولن يتجاوز ${pointsAr(holdPoints)}؛ يُخصم ما كلّفه فعلًا فقط.`;
