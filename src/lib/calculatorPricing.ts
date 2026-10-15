import {
  calculateCapabilityQuote,
  calculateCapabilityUnitPricePoints,
  calculateFinalSettlement,
  DEFAULT_PRICING_SETTINGS,
  type PricingSettings,
} from "../functions/shared/quotes";
import {
  APPROVED_CAPABILITY_CATALOG,
  type Capability,
} from "../functions/shared/capabilityRegistry";
export const DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD = 0.80;
export const DEFAULT_JOB_POINTS_CAP = 600;

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
  isCapped?: boolean;
  maxCapPoints?: number;
  maxCappedVolume?: number;
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
 * pricing functions (calculateCapabilityUnitPricePoints + calculateFinalSettlement)
 * as the quote writer, strictly enforcing JOB_MAX_POINTS_CAP and daily spend cap.
 */
export function computePublicCalculatorQuote(
  capabilitySlug: string,
  targetVolumeMax: number,
  deliveredVolume: number = targetVolumeMax,
  capabilities: Capability[] = APPROVED_CAPABILITY_CATALOG,
  settings: PricingSettings = DEFAULT_PRICING_SETTINGS,
  jobPointsCap: number = DEFAULT_JOB_POINTS_CAP,
  dailySpendCapUsd: number = DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD
): PublicCalculatorBreakdown {
  const safeTarget = Math.max(1, Math.floor(Number(targetVolumeMax) || 1));
  const safeDelivered = Math.max(0, Math.min(safeTarget, Math.floor(Number(deliveredVolume) ?? safeTarget)));

  const cap =
    capabilities.find((c) => c.slug === capabilitySlug) || capabilities[0];

  const unitPricePoints = calculateCapabilityUnitPricePoints(cap.unitCostUsd, settings);
  const rawPoints = safeTarget * unitPricePoints;
  const withBuffer = Math.ceil(rawPoints * (1 + settings.safetyBuffer));
  const reservedPoints = Math.max(settings.minPoints, withBuffer);

  const dailyCapPoints = Math.floor((dailySpendCapUsd * settings.usdToEgp * settings.markup) / settings.creditValueEgp);
  const effectiveMaxCap = Math.min(jobPointsCap, dailyCapPoints);

  const isCapped = reservedPoints > effectiveMaxCap;

  const costPerUnitWithBuffer = unitPricePoints * (1 + settings.safetyBuffer);
  const maxCappedVolume = isCapped
    ? Math.max(1, Math.floor(effectiveMaxCap / costPerUnitWithBuffer))
    : safeTarget;

  const settlement = calculateFinalSettlement(
    safeDelivered,
    unitPricePoints,
    reservedPoints
  );

  const creditValueEgp = settings.creditValueEgp;

  return {
    capabilitySlug: cap.slug,
    nameAr: cap.nameAr,
    targetVolumeMax: safeTarget,
    deliveredVolume: safeDelivered,
    unitPricePoints,
    unitPriceEgp: Number((unitPricePoints * creditValueEgp).toFixed(4)),
    reservedPoints,
    reservedEgp: Number((reservedPoints * creditValueEgp).toFixed(2)),
    chargedPoints: settlement.chargePoints,
    chargedEgp: Number((settlement.chargePoints * creditValueEgp).toFixed(2)),
    refundPoints: settlement.refundPoints,
    refundEgp: Number((settlement.refundPoints * creditValueEgp).toFixed(2)),
    safetyBufferPercent: Math.round(settings.safetyBuffer * 100),
    isCapped,
    maxCapPoints: effectiveMaxCap,
    maxCappedVolume,
  };
}
