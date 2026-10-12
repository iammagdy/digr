import {
  calculateCapabilityQuote,
  calculateFinalSettlement,
  DEFAULT_PRICING_SETTINGS,
  type PricingSettings,
} from "../functions/shared/quotes";
import {
  APPROVED_CAPABILITY_CATALOG,
  type Capability,
} from "../functions/shared/capabilityRegistry";

export interface PublicCalculatorOption {
  slug: string;
  nameAr: string;
  descriptionAr: string;
  unitLabelAr: string;
  enabled: boolean;
  defaultVolume: number;
  maxVolume: number;
}

export interface PublicCalculatorBreakdown {
  capabilitySlug: string;
  nameAr: string;
  targetVolumeMax: number;
  deliveredVolume: number;
  unitPricePoints: number;
  unitPriceEgp: number;
  reservedPoints: number;
  reservedEgp: number;
  chargedPoints: number;
  chargedEgp: number;
  refundPoints: number;
  refundEgp: number;
  safetyBufferPercent: number;
}

function cleanArText(text: string): string {
  return (text || "")
    .replace(/\s*\([A-Za-z0-9@_.\s/-]+\)/g, "")
    .replace(/[~≈]/g, "")
    .trim();
}

/**
 * Returns sanitized Arabic-only options for the public /calculator page.
 * Never exposes provider names, endpoint IDs, or USD costs.
 */
export function getPublicCalculatorOptions(
  capabilities: Capability[] = APPROVED_CAPABILITY_CATALOG
): PublicCalculatorOption[] {
  return capabilities.map((cap) => {
    const isProfile = cap.slug.endsWith("-profile");
    return {
      slug: cap.slug,
      nameAr: cleanArText(cap.nameAr),
      descriptionAr: cleanArText(cap.descriptionAr),
      unitLabelAr: isProfile ? "حساب" : "سجل",
      enabled: Boolean(cap.enabled),
      defaultVolume: isProfile ? 1 : 100,
      maxVolume: isProfile ? 50 : Math.min(1000, (cap.maxItemsPerCall || 100) * 10),
    };
  });
}

/**
 * Computes the exact reservation, final charge, and refund using the SAME
 * pricing functions (calculateCapabilityQuote + calculateFinalSettlement) as the quote writer.
 */
export function computePublicCalculatorQuote(
  capabilitySlug: string,
  targetVolumeMax: number,
  deliveredVolume: number = targetVolumeMax,
  capabilities: Capability[] = APPROVED_CAPABILITY_CATALOG,
  settings: PricingSettings = DEFAULT_PRICING_SETTINGS
): PublicCalculatorBreakdown {
  const safeTarget = Math.max(1, Math.floor(Number(targetVolumeMax) || 1));
  const safeDelivered = Math.max(0, Math.min(safeTarget, Math.floor(Number(deliveredVolume) ?? safeTarget)));

  const cap =
    capabilities.find((c) => c.slug === capabilitySlug) || capabilities[0];

  const quote = calculateCapabilityQuote(
    safeTarget,
    cap.unitCostUsd,
    Number.MAX_SAFE_INTEGER,
    settings
  );

  const settlement = calculateFinalSettlement(
    safeDelivered,
    quote.unitPricePoints,
    quote.quotedPoints
  );

  const creditValueEgp = settings.creditValueEgp;

  return {
    capabilitySlug: cap.slug,
    nameAr: cap.nameAr,
    targetVolumeMax: safeTarget,
    deliveredVolume: safeDelivered,
    unitPricePoints: quote.unitPricePoints,
    unitPriceEgp: Number((quote.unitPricePoints * creditValueEgp).toFixed(4)),
    reservedPoints: quote.quotedPoints,
    reservedEgp: Number((quote.quotedPoints * creditValueEgp).toFixed(2)),
    chargedPoints: settlement.chargePoints,
    chargedEgp: Number((settlement.chargePoints * creditValueEgp).toFixed(2)),
    refundPoints: settlement.refundPoints,
    refundEgp: Number((settlement.refundPoints * creditValueEgp).toFixed(2)),
    safetyBufferPercent: quote.safetyBufferPercent,
  };
}
