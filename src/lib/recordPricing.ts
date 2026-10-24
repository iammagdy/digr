import { effectiveJobPointsCap } from "./jobPointsCap";

/**
 * Price of one DELIVERED record, in points, from the real cost of one delivered record:
 *
 *   unit price (points) = cost per delivered record (USD) x USD->EGP x markup / EGP per point  = cost x 5,500 today
 *
 * The unit price stays FRACTIONAL (for example 0.11715 points for an X post): it is never rounded to a whole point. Every total is
 * computed in exact integer arithmetic on millionths of a point, so no floating-point drift can make a charge pass a reserve or make
 * the quote writer, the calculator and the database disagree by a point:
 *
 *   charge  = ceil(delivered x unit)
 *   reserve = ceil(volume x unit x 1.15)         (the 15% buffer is on the reserve only, never on the charge)
 *
 * The database holds the same rule (settle_job_atomic: CEIL(delivered_units x unit_price), numeric); `tests/replica-money-properties.test.ts`
 * proves the two agree on the real production function bodies. Pure module: no server imports.
 */
export const UNIT_SCALE = 1_000_000;

export interface PricingBasis {
  usdToEgp: number;
  markup: number;
  creditValueEgp: number;
  safetyBuffer: number;
}
export const DEFAULT_PRICING_BASIS: PricingBasis = { usdToEgp: 55, markup: 10, creditValueEgp: 0.1, safetyBuffer: 0.15 };

export const pointsPerUsd = (basis: PricingBasis = DEFAULT_PRICING_BASIS): number => (basis.usdToEgp * basis.markup) / basis.creditValueEgp;

/**
 * Where the cost per record comes from. MEASURED: completed jobs or the owner's own run. ASSUMED: the catalog price of one call
 * divided by the records one call returns, on the worst source path in the code, until a verification run measures it.
 */
export type CostBasisKind = "MEASURED" | "ASSUMED";

export interface RecordCost {
  /** USD the provider charges for one DELIVERED record on the worst source path (what the price is built on). */
  costUsdPerRecord: number;
  /** The same when the first (cheaper) source answers; null when measured. */
  primaryCostUsdPerRecord: number | null;
  basis: CostBasisKind;
  /** Internal note (never shown to customers). */
  note: string;
}

/** Capabilities priced per delivered record. Everything else keeps its existing rule (decision makers stay at 83 + 55 + 55 points). */
export const RECORD_COSTS: Record<string, RecordCost> = {
  "social-x-posts": { costUsdPerRecord: 0.0000213, primaryCostUsdPerRecord: 0.000015, basis: "MEASURED", note: "owner's run: about 0.80 USD for about 37,500 posts" },
  "social-youtube-comments": { costUsdPerRecord: 0.00005, primaryCostUsdPerRecord: 0.0000018, basis: "ASSUMED", note: "worst path 0.001 per call and 20 comments; first path 0.0009 per call and 500 comments" },
  "social-tiktok-comments": { costUsdPerRecord: 0.00005, primaryCostUsdPerRecord: 0.00005, basis: "ASSUMED", note: "0.001 per call and 20 comments" },
  "social-facebook-comments": { costUsdPerRecord: 0.000188, primaryCostUsdPerRecord: 0.000188, basis: "ASSUMED", note: "0.00188 per call and 10 comments" },
  // A topic job pays for the SEARCH that finds a post as well as for the post's comments, so its cost per delivered comment is far above the comments of a known link. Built from the catalog read
  // of 2026-10-23, worst source path, on stated assumptions (none measured): the first search source costs 0.02952 USD per call (JustOne API, 0.2 CNY) and returns about 6 posts a call (the one
  // figure the catalog's reviews give; the catalog publishes none); about half of the posts found are about the topic; one comments call per adopted post costs 0.00188 USD and the 5 comments
  // taken from it are all delivered. Per adopted post: 0.02952 / (6 x 0.5) + 0.00188 = 0.01172 USD; per comment: 0.01172 / 5 = 0.002344, rounded up to 0.00235. The review model is not in this
  // figure (the table counts what the provider charges). If a call returns more posts or more of them match, the real cost is lower; if fewer, higher (see docs/COST_REPORT_FACEBOOK_TOPIC_300.md).
  "social-facebook-keyword-comments": { costUsdPerRecord: 0.00235, primaryCostUsdPerRecord: 0.00235, basis: "ASSUMED", note: "0.02952 per search call of 6 posts, half adopted, 0.00188 per post for 5 comments" },
  // The Facebook topic REPORT (vetted Pages browsed round-robin, a small search supplement, then the comments of the kept posts): PROPOSED price, the owner decides. 0.00055 USD per delivered
  // comment is the dearer of the owner's measured all-in run (0.9619 USD / 1,753 comments = 0.000549) and the blended expected cost at the search cap (0.000496), rounded up: 3.025 points a comment.
  // Basis of every figure (M measured, C catalog, A assumed): src/lib/facebookReport/cost.ts and docs/proposals/facebook-topic-report/PRICING.md. No existing price is touched.
  "facebook-topic-report": { costUsdPerRecord: 0.00055, primaryCostUsdPerRecord: 0.000496, basis: "ASSUMED", note: "owner's measured run 0.9619 USD for 1,753 comments (0.000549 all-in), 15% search share cap, 5 comments a post" },
  "social-facebook-posts": { costUsdPerRecord: 0.000627, primaryCostUsdPerRecord: 0.0002, basis: "ASSUMED", note: "worst path 0.00188 per 3 posts; first path 0.002 per 10" },
  "icypeas-companies-search": { costUsdPerRecord: 0.000576, primaryCostUsdPerRecord: null, basis: "MEASURED", note: "434 records in 44 completed requests" },
};

export function recordCostFor(slug: string | undefined | null): RecordCost | null {
  return slug && Object.prototype.hasOwnProperty.call(RECORD_COSTS, slug) ? RECORD_COSTS[slug] : null;
}

/** Unit price in millionths of a point, rounded UP so a price never undercuts its cost. */
export function unitPriceMicro(costUsdPerRecord: number, basis: PricingBasis = DEFAULT_PRICING_BASIS): number {
  if (!Number.isFinite(costUsdPerRecord) || costUsdPerRecord <= 0) throw new Error("cost per record must be positive");
  // 1e-6 absorbs the float noise of the multiplication (0.0000213 x 5500 x 1e6 is 117150.00000000001)
  return Math.max(1, Math.ceil(costUsdPerRecord * pointsPerUsd(basis) * UNIT_SCALE - 1e-6));
}

/** Unit price in points of a record cost: fractional, at most six decimals, exactly what the database stores as `unit_price`. */
export function unitPricePointsFromCost(costUsdPerRecord: number, basis: PricingBasis = DEFAULT_PRICING_BASIS): number {
  return unitPriceMicro(costUsdPerRecord, basis) / UNIT_SCALE;
}

/** The unit price of a capability priced per record, or null when the capability keeps its existing rule. */
export function recordUnitPricePoints(slug: string | undefined | null, basis: PricingBasis = DEFAULT_PRICING_BASIS): number | null {
  const cost = recordCostFor(slug);
  return cost ? unitPricePointsFromCost(cost.costUsdPerRecord, basis) : null;
}

/** A unit price as an integer count of millionths of a point (exact for any price with at most six decimals). */
export function toMicro(unitPoints: number): number {
  return Math.round(Number(unitPoints) * UNIT_SCALE);
}

const big = (n: number) => BigInt(Math.trunc(n));
function ceilDiv(num: bigint, den: bigint): bigint { return (num + den - BigInt(1)) / den; }
const bufferBps = (buffer: number) => Math.round(Math.max(0, buffer) * 10_000);

/** ceil(delivered x unit): the charge for delivered records. Never includes the buffer. */
export function chargeForUnits(delivered: number, unitPoints: number): number {
  const d = Math.floor(Number(delivered));
  const micro = toMicro(unitPoints);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(micro) || micro <= 0) return 0;
  return Number(ceilDiv(big(d) * big(micro), big(UNIT_SCALE)));
}

/** ceil(volume x unit x (1 + buffer)): the reserve held for the plan. */
export function reserveForUnits(volume: number, unitPoints: number, buffer: number = DEFAULT_PRICING_BASIS.safetyBuffer): number {
  const v = Math.floor(Number(volume));
  const micro = toMicro(unitPoints);
  if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(micro) || micro <= 0) return 0;
  return Number(ceilDiv(big(v) * big(micro) * big(10_000 + bufferBps(buffer)), big(UNIT_SCALE) * big(10_000)));
}

/** The most records whose reserve is at or under `capPoints`; 0 when even one record does not fit. */
export function maxVolumeUnderCap(capPoints: number, unitPoints: number, buffer: number = DEFAULT_PRICING_BASIS.safetyBuffer): number {
  const cap = Math.floor(Number(capPoints));
  const micro = toMicro(unitPoints);
  if (!Number.isFinite(cap) || cap < 1 || !Number.isFinite(micro) || micro <= 0) return 0;
  let volume = Math.floor((cap * UNIT_SCALE * 10_000) / (micro * (10_000 + bufferBps(buffer))));
  while (volume > 0 && reserveForUnits(volume, unitPoints, buffer) > cap) volume -= 1;
  while (reserveForUnits(volume + 1, unitPoints, buffer) <= cap) volume += 1;
  return Math.max(0, volume);
}

/** The most records one job holds by the shared rule: the reserve stays within the cap in force. */
export function maxRecordsInOneJob(unitPoints: number, capPoints: number = effectiveJobPointsCap(), buffer: number = DEFAULT_PRICING_BASIS.safetyBuffer): number {
  return maxVolumeUnderCap(capPoints, unitPoints, buffer);
}

/** The largest CHARGE a job can end with under the cap: the buffer is held back, so it is below the cap (about cap / 1.15). */
export function maxChargeInOneJob(unitPoints: number, capPoints: number = effectiveJobPointsCap(), buffer: number = DEFAULT_PRICING_BASIS.safetyBuffer): number {
  return chargeForUnits(maxRecordsInOneJob(unitPoints, capPoints, buffer), unitPoints);
}

/** The smallest cap that lets a job with this charge be sold: its reserve. */
export function capNeededForCharge(chargePoints: number, buffer: number = DEFAULT_PRICING_BASIS.safetyBuffer): number {
  return Math.ceil(Math.max(0, chargePoints) * (1 + buffer) - 1e-9);
}

/** Provider cost estimate of a plan item: volume x cost of one delivered record (worst path), for the capacity gate. */
export function estimatedProviderUsd(slug: string | undefined | null, volume: number, fallbackUnitCostUsd: number): number {
  const cost = recordCostFor(slug);
  return Math.max(0, volume) * (cost ? cost.costUsdPerRecord : fallbackUnitCostUsd);
}

/**
 * Points for the customer: at most two decimals, and only where there are any (11.72, 3.17, 12). Prices are rounded UP at the
 * display so the screen never shows less than the system charges; totals are whole points already.
 */
export function pointsDisplay(points: number, maxDecimals = 2): string {
  const factor = 10 ** maxDecimals;
  const rounded = Math.ceil(Number(points) * factor - 1e-9) / factor;
  const fixed = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(maxDecimals).replace(/0+$/, "").replace(/\.$/, "");
  return fixed;
}

/** The unit price shown to the customer: points per 100 records (the price a person can read), at most two decimals. */
export function pricePer100Points(unitPoints: number): number {
  return Math.ceil(Number(unitPoints) * 100 * 100 - 1e-6) / 100;
}
