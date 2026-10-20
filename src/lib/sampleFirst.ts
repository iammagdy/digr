import { toArabicDigits } from "./arabicDigits";

/**
 * «عينة أولًا»: for a large job the customer can pay for a small separate sample first, then ask for the rest.
 *
 *  - The sample is an ORDINARY job: its own quote, its own reserve (only after the customer approves it), settled and
 *    released by the existing path. Nothing here touches the ledger, and nothing here gives a credit or a refund.
 *  - It is offered when the estimate of the whole request reaches 1,500 points. Its size is about 5% of that estimate,
 *    held between 100 and 300 points (the reserve, with the 15% buffer, never above the target).
 *  - After it is delivered the rest is quoted on the REMAINING volume, excluding the rows the sample already delivered,
 *    so nothing is delivered or billed twice; the approximate total includes the sample's own charge.
 * All numbers are computed here from the quote's own figures; the model never writes one.
 */
export const SAMPLE_MIN_ESTIMATE_POINTS = 1500;
export const SAMPLE_SHARE = 0.05;
export const SAMPLE_MIN_POINTS = 100;
export const SAMPLE_MAX_POINTS = 300;

export interface SampleQuoteLike {
  items?: Array<{ capabilitySlug?: string; params?: Record<string, any> }>;
  targetVolumeMax: number;
  unitPricePoints: number;
  /** The volume the customer asked for before any cap fitted it down. */
  requestedVolumeMax?: number;
}

export interface SampleOffer {
  sampleUnits: number;
  /** Points the sample holds (reserve, with the 15% buffer). Never above the target. */
  samplePoints: number;
  /** Points the sample costs if it delivers every record. */
  sampleExpectedPoints: number;
  /** The whole request: its volume and what it would cost expected (no buffer). */
  fullUnits: number;
  fullEstimatePoints: number;
}

const NAMED_LINK = /^https?:\/\//i;

/** The expected points of the whole REQUEST (not of what a cap left of it). */
export function fullEstimatePoints(quote: SampleQuoteLike): number {
  const units = Math.max(quote.targetVolumeMax, quote.requestedVolumeMax ?? 0);
  return Math.ceil(units * quote.unitPricePoints);
}

/** The sample's target in points: 5% of the estimate, between 100 and 300. */
export function sampleTargetPoints(estimatePoints: number): number {
  return Math.min(SAMPLE_MAX_POINTS, Math.max(SAMPLE_MIN_POINTS, Math.round(estimatePoints * SAMPLE_SHARE)));
}

/** The offer for a quote, or null when a sample is not worth offering (a small job, a single link, several items, or no cheaper). */
export function sampleOffer(quote: SampleQuoteLike, safetyBuffer = 0.15): SampleOffer | null {
  const item = quote.items?.[0];
  if (!item || quote.items!.length !== 1) return null;
  if (NAMED_LINK.test(String(item.params?.url || ""))) return null;
  const estimate = fullEstimatePoints(quote);
  if (estimate < SAMPLE_MIN_ESTIMATE_POINTS) return null;
  const unit = Number(quote.unitPricePoints);
  if (!Number.isFinite(unit) || unit <= 0) return null;
  const fullUnits = Math.max(quote.targetVolumeMax, quote.requestedVolumeMax ?? 0);
  const target = sampleTargetPoints(estimate);
  const sampleUnits = Math.max(1, Math.floor(target / (unit * (1 + safetyBuffer))));
  if (sampleUnits >= quote.targetVolumeMax) return null;
  // One record already costs more than a sample may: no sample is offered.
  if (unit * (1 + safetyBuffer) > SAMPLE_MAX_POINTS) return null;
  return {
    sampleUnits,
    samplePoints: Math.ceil(sampleUnits * unit * (1 + safetyBuffer)),
    sampleExpectedPoints: Math.ceil(sampleUnits * unit),
    fullUnits,
    fullEstimatePoints: estimate,
  };
}

/** Records still to ask for once the sample delivered some of them. */
export function remainingUnits(fullUnits: number, deliveredInSample: number): number {
  return Math.max(0, Math.floor(fullUnits) - Math.max(0, Math.floor(deliveredInSample)));
}

/** The approximate total of sample plus the rest: what the sample was charged, plus the rest's expected points. */
export function approximateTotalPoints(input: { sampleChargedPoints: number; remainingUnits: number; unitPricePoints: number }): number {
  return Math.ceil(Math.max(0, input.sampleChargedPoints)) + Math.ceil(Math.max(0, input.remainingUnits) * input.unitPricePoints);
}

/**
 * Keeps the rows whose identity is not in `excluded`; the excluded ones are counted, never delivered, never billed.
 * Used by the worker with the identities of the rows a sample already delivered.
 */
export function withoutExcludedRows<T>(rows: T[], identityOf: (row: T) => string | null, excluded: Iterable<string>): { rows: T[]; excludedCount: number } {
  const blocked = new Set(excluded);
  if (blocked.size === 0) return { rows, excludedCount: 0 };
  let excludedCount = 0;
  const kept = rows.filter((row) => {
    const identity = identityOf(row);
    if (identity && blocked.has(identity)) { excludedCount += 1; return false; }
    return true;
  });
  return { rows: kept, excludedCount };
}

/** The identity keys of delivered rows (rows without an identity cannot be excluded and are skipped). */
export function excludeKeysFromRows<T>(rows: T[], identityOf: (row: T) => string | null, limit = 2000): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = identityOf(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= limit) break;
  }
  return keys;
}

const n = (value: number) => toArabicDigits(Math.max(0, Math.round(value)));

/** The offer as the plan states it: sample size and reserve, the whole request, and the promise to charge only what is delivered. */
export function sampleOfferLineAr(offer: SampleOffer, unitLabelAr = "سجل"): string {
  return `عينة أولًا: ${n(offer.sampleUnits)} ${unitLabelAr} فقط بحجز ${n(offer.samplePoints)} نقطة، ثم تقرر الباقي. الطلب الكامل (${n(offer.fullUnits)} ${unitLabelAr}) تكلفته المتوقعة حوالي ${n(offer.fullEstimatePoints)} نقطة. لا يُخصم إلا ثمن ما يُسلَّم.`;
}

export interface SampleRestOffer {
  deliveredInSample: number;
  sampleChargedPoints: number;
  remainingUnits: number;
  approximateTotalPoints: number;
}

/** The message after the sample is delivered: what came, what the rest would be, and the approximate total with the sample. */
export function sampleRestMessageAr(input: SampleRestOffer, unitLabelAr = "سجل"): string {
  if (input.remainingUnits <= 0) {
    return `اكتملت العينة وسُلّم ${n(input.deliveredInSample)} ${unitLabelAr}، وهي كل ما طلبته؛ لا يوجد باقٍ.`;
  }
  return `اكتملت العينة: سُلّم ${n(input.deliveredInSample)} ${unitLabelAr} وخُصم ${n(input.sampleChargedPoints)} نقطة. الباقي من طلبك ${n(input.remainingUnits)} ${unitLabelAr} دون السجلات التي وصلتك، والإجمالي التقريبي مع العينة حوالي ${n(input.approximateTotalPoints)} نقطة. هل تطلب الباقي؟`;
}
