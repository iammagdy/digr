import { DEFAULT_PRICING_SETTINGS, type PricingSettings } from "../functions/shared/quotes";

/**
 * Proposed tiered discount for large per-record social jobs. NOT ACTIVE.
 *
 * - The flag VOLUME_PRICING_ENABLED is OFF by default, and the quote builder does not call this module: the live
 *   pricing formula (provider cost USD x 55 x 10 / 0.10 per unit, rounded up) and the 600-point cap are unchanged.
 *   Wiring it in is a separate, reviewed change after the owner picks the tiers (see docs/BATCH_REPORT.md).
 * - A tier lowers the markup multiple applied to the provider's real cost; it never lowers the price below
 *   cost x VOLUME_PRICING_MARKUP_FLOOR, and never raises it above the price the customer would pay today.
 * - Below the first tier the price is exactly today's price.
 */
export const VOLUME_PRICING_MARKUP_FLOOR = 4;

export interface VolumeTier {
  /** applies from this many records */
  minUnits: number;
  /** markup multiple on the provider's cost in points (today's multiple is 10) */
  markup: number;
}

export const VOLUME_PRICING_TIERS: readonly VolumeTier[] = [
  { minUnits: 100, markup: 8 },
  { minUnits: 500, markup: 6 },
  { minUnits: 1000, markup: 5 },
];

export function volumePricingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.VOLUME_PRICING_ENABLED || "").trim().toLowerCase() === "true";
}

/** What the provider's cost is worth in points (1 point = 0.10 EGP at 55 EGP per USD): the break-even price. */
export function costPointsPerUnit(providerCostUsd: number, settings: PricingSettings = DEFAULT_PRICING_SETTINGS): number {
  return (providerCostUsd * settings.usdToEgp) / settings.creditValueEgp;
}

export function tierForVolume(volume: number): VolumeTier | null {
  let found: VolumeTier | null = null;
  for (const tier of VOLUME_PRICING_TIERS) if (volume >= tier.minUnits) found = tier;
  return found;
}

export interface TieredUnitPrice {
  unitPricePoints: number;
  tier: VolumeTier | null;
  /** the lowest price the floor allows */
  floorPoints: number;
  discountPercent: number;
}

export function tieredUnitPricePoints(input: {
  providerCostUsd: number;
  volume: number;
  /** the unit price the customer pays today for this service */
  currentUnitPricePoints: number;
  settings?: PricingSettings;
  enabled?: boolean;
}): TieredUnitPrice {
  const settings = input.settings || DEFAULT_PRICING_SETTINGS;
  const cost = costPointsPerUnit(input.providerCostUsd, settings);
  const floorPoints = Math.max(1, Math.ceil(cost * VOLUME_PRICING_MARKUP_FLOOR));
  const tier = tierForVolume(input.volume);
  const enabled = input.enabled ?? volumePricingEnabled();
  if (!enabled || !tier) return { unitPricePoints: input.currentUnitPricePoints, tier: enabled ? tier : null, floorPoints, discountPercent: 0 };
  const tiered = Math.max(floorPoints, Math.ceil(cost * tier.markup));
  const unitPricePoints = Math.min(input.currentUnitPricePoints, tiered);
  return {
    unitPricePoints,
    tier,
    floorPoints,
    discountPercent: Math.round((1 - unitPricePoints / input.currentUnitPricePoints) * 100),
  };
}

export interface ProposalRow {
  slug: string;
  providerCostUsd: number;
  costPoints: number;
  currentUnitPoints: number;
  floorPoints: number;
  tiers: Array<{ minUnits: number; markup: number; unitPoints: number; discountPercent: number }>;
}

/** The table for the owner: for each service, today's price and the price at every tier, with the floor. */
export function proposeVolumePricing(services: Array<{ slug: string; providerCostUsd: number; currentUnitPoints: number }>): ProposalRow[] {
  return services.map((s) => {
    const base = tieredUnitPricePoints({ providerCostUsd: s.providerCostUsd, volume: 1, currentUnitPricePoints: s.currentUnitPoints, enabled: true });
    return {
      slug: s.slug,
      providerCostUsd: s.providerCostUsd,
      costPoints: Math.round(costPointsPerUnit(s.providerCostUsd) * 1000) / 1000,
      currentUnitPoints: s.currentUnitPoints,
      floorPoints: base.floorPoints,
      tiers: VOLUME_PRICING_TIERS.map((tier) => {
        const t = tieredUnitPricePoints({ providerCostUsd: s.providerCostUsd, volume: tier.minUnits, currentUnitPricePoints: s.currentUnitPoints, enabled: true });
        return { minUnits: tier.minUnits, markup: tier.markup, unitPoints: t.unitPricePoints, discountPercent: t.discountPercent };
      }),
    };
  });
}
