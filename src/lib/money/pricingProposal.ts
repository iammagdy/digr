import { DEFAULT_PRICING_SETTINGS, type PricingSettings } from "../../functions/shared/quotes";

/**
 * PROPOSAL (parked branch, not wired): pricing from the real cost of one DELIVERED record, with fractional unit prices and a
 * whole-point block price shown to the customer.
 *
 * Today the quote prices every delivered record at the cost of one provider CALL (which returns many records), rounded UP to a
 * whole point. That is 5 to 400 times the real cost per record for social data. This module prices the record itself:
 *
 *   unit points per record = cost per delivered record (USD) x USD->EGP x markup / EGP per point      (same 10x markup as today)
 *
 * stored as an exact count of ten-thousandths of a point (integers), so no floating-point drift can make a charge exceed a
 * reserve. Charge = ceil(delivered x unit), reserve = ceil(volume x unit x 1.15), exactly as today, only with a fractional unit.
 * The customer sees the BLOCK price: points per 100 records, rounded up to a whole point.
 */
export const MICRO = 10_000;
export const BLOCK_SIZE = 100;

export interface CostBasis {
  /** The cost the proposed price is built on: the WORST source path in the code (or the measured / owner figure). */
  costUsdPerRecord: number;
  /** The cost when the first source in the chain answers (its call price divided by its records per call); null when measured. */
  primaryCostUsdPerRecord: number | null;
  /** "measured" = from completed jobs; "owner" = the owner's own run; "assumed" = catalog price per call / records per call. */
  basis: "measured" | "owner" | "assumed";
  noteAr: string;
}

/** Unit price in ten-thousandths of a point (integer), rounded UP so the price never undercuts the cost. */
export function unitPriceMicro(costUsdPerRecord: number, settings: PricingSettings = DEFAULT_PRICING_SETTINGS): number {
  if (!Number.isFinite(costUsdPerRecord) || costUsdPerRecord <= 0) throw new Error("cost per record must be positive");
  const pointsPerUsd = (settings.usdToEgp * settings.markup) / settings.creditValueEgp;
  // 1e-9 absorbs float noise from the multiplication before the round-up
  return Math.max(1, Math.ceil(costUsdPerRecord * pointsPerUsd * MICRO - 1e-9));
}

export const microToPoints = (micro: number) => micro / MICRO;

/** Customer-facing price: whole points per block of records. */
export function blockPricePoints(micro: number, blockSize = BLOCK_SIZE): number {
  return Math.max(1, Math.ceil((micro * blockSize) / MICRO));
}

/** The unit (in micro points) the customer is actually charged at: the block price spread over the block. */
export function billedUnitMicro(micro: number, blockSize = BLOCK_SIZE): number {
  return Math.ceil((blockPricePoints(micro, blockSize) * MICRO) / blockSize);
}

/** ceil(delivered x unit), in integer arithmetic. */
export function chargePoints(delivered: number, unitMicro: number): number {
  if (delivered <= 0) return 0;
  return Math.ceil((Math.floor(delivered) * unitMicro) / MICRO);
}

/** ceil(volume x unit x (1 + buffer%)), buffer as a whole percent (15). The buffer is on the reserve only. */
export function reservePoints(volume: number, unitMicro: number, bufferPercent = Math.round(DEFAULT_PRICING_SETTINGS.safetyBuffer * 100)): number {
  if (volume <= 0) return 0;
  return Math.ceil((Math.floor(volume) * unitMicro * (100 + bufferPercent)) / (MICRO * 100));
}

/** The most records whose reserve fits under `capPoints`. */
export function maxVolumeUnderCap(capPoints: number, unitMicro: number, bufferPercent = 15): number {
  if (capPoints < 1) return 0;
  let volume = Math.floor((capPoints * MICRO * 100) / (unitMicro * (100 + bufferPercent)));
  while (volume > 0 && reservePoints(volume, unitMicro, bufferPercent) > capPoints) volume -= 1;
  return Math.max(0, volume);
}

/**
 * Proposed cost basis per delivered record. Only the X figure is the owner's own run (about 0.80 USD for 37,500 posts) and the
 * company figure is measured on completed jobs; every other figure is a CATALOG PRICE PER CALL divided by the records one call
 * returns (`maxPerCall` in `src/lib/socialSources.ts`), i.e. an ASSUMPTION until the scaled-down verification run measures it.
 * The price is built on the worst path in the source chain, so a fallback answering never sells below cost; the first (cheaper)
 * path is kept beside it so the owner can see the gap.
 */
export const PROPOSED_COST_BASIS: Record<string, CostBasis> = {
  "social-x-posts": { costUsdPerRecord: 0.0000213, primaryCostUsdPerRecord: 0.000015, basis: "owner", noteAr: "تشغيل المالك: حوالي ٠٫٨٠ دولار لحوالي ٣٧٬٥٠٠ منشور" },
  "social-youtube-comments": { costUsdPerRecord: 0.00005, primaryCostUsdPerRecord: 0.0000018, basis: "assumed", noteAr: "أسوأ مسار: ٠٫٠٠١ للطلب الواحد و٢٠ تعليقًا؛ المسار الأول ٠٫٠٠٠٩ و٥٠٠ تعليق" },
  "social-tiktok-comments": { costUsdPerRecord: 0.00005, primaryCostUsdPerRecord: 0.00005, basis: "assumed", noteAr: "٠٫٠٠١ للطلب الواحد و٢٠ تعليقًا (المسار الأول)" },
  "social-facebook-comments": { costUsdPerRecord: 0.000188, primaryCostUsdPerRecord: 0.000188, basis: "assumed", noteAr: "٠٫٠٠١٨٨ للطلب الواحد و١٠ تعليقات" },
  "social-facebook-posts": { costUsdPerRecord: 0.000627, primaryCostUsdPerRecord: 0.0002, basis: "assumed", noteAr: "أسوأ مسار: ٠٫٠٠١٨٨ لكل ٣ منشورات؛ المسار الأول ٠٫٠٠٢ لكل ١٠" },
  "icypeas-companies-search": { costUsdPerRecord: 0.000576, primaryCostUsdPerRecord: null, basis: "measured", noteAr: "مقاس على ٤٣٤ سجلًا في ٤٤ طلبًا مكتملًا" },
};

export interface ProposedPrice {
  slug: string;
  basis: CostBasis["basis"];
  unitMicro: number;
  unitPoints: number;
  blockPoints: number;
  billedUnitMicro: number;
}

export function proposedPriceFor(slug: string, settings: PricingSettings = DEFAULT_PRICING_SETTINGS): ProposedPrice | null {
  const cost = PROPOSED_COST_BASIS[slug];
  if (!cost) return null;
  const micro = unitPriceMicro(cost.costUsdPerRecord, settings);
  return { slug, basis: cost.basis, unitMicro: micro, unitPoints: microToPoints(micro), blockPoints: blockPricePoints(micro), billedUnitMicro: billedUnitMicro(micro) };
}
