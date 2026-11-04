import { createHash } from "node:crypto";
import { DEFAULT_MISSION_PRICING_SETTINGS, pointsPerCostUsd, type MissionPricingSettings } from "../missionPricing";

/**
 * MONEY PR 7a, PHASE 2A (docs/MONEY-PR-7A.md): THE MONEY OF A PAID REVIEW, A REVIEW FIX AND A POST-DELIVERY EDIT (an "add-on" of a delivered mission). NOT WIRED: nothing in the site or the worker imports this file
 * (tests/money7a-isolation.test.ts); it is only called by tests until the wiring phase (2B) is briefed and approved.
 *
 * An add-on is a row of the `missions` table linked to the delivered mission inside its `plan` JSON. It goes through the EXISTING money functions, unchanged:
 *   approve  claim plan_ready -> approved (compare-and-set), price AGAIN by code, create_quote_atomic -> accept_quote_atomic (res_<job>) -> claim_job_chunk      (approveAddonOnce)
 *   settle   settleMission: complete_chunk -> settle_job_atomic (rel_<job> FIRST, then chg_<job>), or complete_chunk(0) -> release_job_atomic                 (settleAddon)
 * The job SELLS POINTS at 1 point each (unit price 1, volume = the hold), so the database's own charge, LEAST(CEIL(delivered x 1), reserve, cap), is exactly the charge this file computes.
 *
 * RULES kept here: append-only ledger and deterministic ids (res_/rel_/chg_ of the add-on's own job, itself derived from the quote id, itself from the mission, the base version and the attempt); release first;
 * idempotent; charge never above the hold; the 15% buffer is on the hold only; NOTHING is spent before the customer approves (nothing here calls a provider); the AI never decides money (every number is code).
 * Money files are read and reused, never edited. THE DISPLAYED PRICES (stage4/quotes.ts) ARE NOT IMPORTED HERE: tests pin them equal to these functions instead (tests/money7a-charge.test.ts).
 */

export const ADDON_KINDS = ["review", "review_fix", "edit"] as const;
export type AddonKind = (typeof ADDON_KINDS)[number];
/** The capability (and endpoint) id of the add-on's job: the job row then says which kind it was. */
export const ADDON_SLUG: Readonly<Record<AddonKind, string>> = { review: "agent-review", review_fix: "agent-fix", edit: "agent-edit" };
/** The least an add-on is charged when anything was done (owner rule: no free path), in points. */
export const ADDON_MIN_POINTS = 100;
/** The most one add-on may hold: the database's volume limit of a job (accept_quote_atomic: 5,000 units, and the job sells points at 1 each). */
export const ADDON_MAX_HOLD_POINTS = 5_000;
/** The review: 1 point per 100 cells (rounded up), at least 100. */
export const ADDON_REVIEW_CELLS_PER_POINT = 100;
/** The pricing settings of an add-on: the site's markup, and the add-on minimum (100) instead of a mission's (200). */
export const addonSettings = (settings: MissionPricingSettings = DEFAULT_MISSION_PRICING_SETTINGS): MissionPricingSettings => ({ ...settings, minChargePoints: ADDON_MIN_POINTS });

/** What an add-on was priced on, stored in its row. The hold is what is reserved; the estimate is what it should cost (the hold without the 15% buffer). */
export interface AddonPricing {
  /** Units the add-on asks for: the cells or rows an edit must fill (1 for a review). Whole number, 1 or more. */
  requested: number;
  /** A review: the readable cells reviewed. */
  cells?: number;
  /** An edit or a fix: the per-row cost of the lookup chain of its columns, USD (from recorded calls or the catalog: stage4/addonQuote.ts). */
  costPerRowUsd?: number;
  settings: MissionPricingSettings;
  estimatePoints: number;
  holdPoints: number;
}
export interface AddonPlan {
  v: 1;
  kind: AddonKind;
  /** The delivered mission this add-on belongs to. */
  of: string;
  baseVersion: number;
  /** The version the edit or the fix will make (base + 1); null for a review (it makes no version). */
  newVersion: number | null;
  attempt: number;
  /** The customer's request as data (stage4/addonRow.ts types it); the money code never reads it. */
  request: unknown;
  pricing: AddonPricing;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1;
const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

// ---------- the deterministic ids ----------

/** The add-on's id (its row in `missions`): msn_ + 20 hex of sha256("<mission id>|v<base version>|a<attempt>"). Two creations of the same request compute the same id, and the primary key refuses the second. */
export function addonId(missionId: string, baseVersion: number, attempt: number): string {
  if (typeof missionId !== "string" || missionId.trim() === "") throw new Error("addonId: the mission id is empty");
  if (!isCount(baseVersion) || !isCount(attempt)) throw new Error("addonId: the base version and the attempt are whole numbers of 1 or more");
  return `msn_${sha256Hex(`${missionId}|v${baseVersion}|a${attempt}`).slice(0, 20)}`;
}
export const addonQuoteId = (id: string): string => `quote_addon_${id}`;
/** What accept_quote_atomic makes of a quote id: job_quote_<md5(quote id)> (the live definition and the migration agree). */
export const addonJobId = (quoteId: string): string => `job_quote_${createHash("md5").update(quoteId).digest("hex")}`;
export const addonLedgerIds = (jobId: string): { reserve: string; release: string; charge: string } => ({ reserve: `res_${jobId}`, release: `rel_${jobId}`, charge: `chg_${jobId}` });

// ---------- the prices, by code ----------

/** The review's hold and price: 1 point per 100 cells, rounded up, at least 100. Held as is (no buffer): a review spends nothing on providers. quotes.ts `reviewQuote` is pinned equal by a test. */
export function reviewHoldPoints(cells: number): number {
  if (!Number.isInteger(cells) || cells < 0) throw new Error("reviewHoldPoints: cells must be a whole number of 0 or more");
  return Math.max(ADDON_MIN_POINTS, Math.ceil(cells / ADDON_REVIEW_CELLS_PER_POINT));
}

/** The provider budget of an add-on's run, USD, in millionths: hold / points per USD, rounded DOWN, so the real cost times the markup, rounded up, is at most the hold. The gateway refuses any call that would pass it. */
export function addonProviderBudgetUsd(holdPoints: number, settings: MissionPricingSettings = addonSettings()): number {
  if (!Number.isFinite(holdPoints) || holdPoints < 0) throw new Error("addonProviderBudgetUsd: the hold must be a number of 0 or more");
  return Math.floor((holdPoints / pointsPerCostUsd(settings)) * 1_000_000) / 1_000_000;
}

/**
 * The charge of an add-on, in whole points (integer arithmetic on millionths of a dollar):
 *   nothing filled -> 0 (the whole hold comes back)
 *   charge = min(hold, max(ceil(real cost x points per USD), ceil(100 x filled / requested)))
 * `filled` counts cells that received a VALUE (a stated gap is not a value: the caller counts); it is read as at most `requested`. The share of the 100-point minimum is proportional to what was filled.
 * `holdPoints` may be Infinity (the displayed price has no hold). It throws on anything that is not a number: nothing is charged on a guess.
 */
export function addonChargePoints(input: { realCostUsd: number; filled: number; requested: number; holdPoints: number; settings?: MissionPricingSettings }): number {
  const { realCostUsd, holdPoints } = input;
  if (!Number.isFinite(realCostUsd) || realCostUsd < 0) throw new Error("addonChargePoints: the real cost must be a number of 0 or more");
  if (typeof holdPoints !== "number" || Number.isNaN(holdPoints)) throw new Error("addonChargePoints: the hold must be a number");
  const requested = Math.floor(input.requested);
  if (!(requested >= 1)) throw new Error("addonChargePoints: requested must be 1 or more");
  const filled = Math.min(Math.max(0, Math.floor(input.filled)), requested);
  if (filled === 0) return 0;
  const micro = BigInt(Math.round(realCostUsd * 1_000_000));
  // points per USD in thousandths (5,500 -> 5,500,000): exact for the markups the owner can set (steps of 0.001 and more)
  const perUsdMilli = BigInt(Math.round(pointsPerCostUsd(input.settings ?? addonSettings()) * 1000));
  const unit = BigInt(1_000_000_000);
  const raw = (micro * perUsdMilli + unit - BigInt(1)) / unit;
  const share = (BigInt(100) * BigInt(filled) + BigInt(requested) - BigInt(1)) / BigInt(requested);
  const wanted = raw > share ? raw : share;
  const hold = Math.max(0, Math.floor(holdPoints));
  return Number(holdPoints === Number.POSITIVE_INFINITY ? wanted : wanted < BigInt(hold) ? wanted : BigInt(hold));
}
