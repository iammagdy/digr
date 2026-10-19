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
import { PLATFORM_GUIDE } from "../functions/shared/platformGuide";
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
  cappedReservedPoints?: number;
  cappedReservedEgp?: number;
  cappedChargedPoints?: number;
  cappedChargedEgp?: number;
  cappedRefundPoints?: number;
  cappedRefundEgp?: number;
}

/** Public pages are Arabic only: no Latin parenthetical, no «X» (the platform is written «إكس»), no sample handles. */
export function cleanArText(text: string): string {
  return (text || "")
    .replace(/\s*\([A-Za-z0-9@_.\s/-]+\)/g, "")
    .replace(/(^|[^A-Za-z0-9])X(?![A-Za-z0-9])/g, "$1إكس")
    .replace(/\s*@example\b/gi, "")
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
  const guideSlugs = new Set(PLATFORM_GUIDE.services.map((service) => service.slug));
  return capabilities.filter((cap) => guideSlugs.has(cap.slug)).map((cap) => {
    const isProfile = cap.slug.endsWith("-profile");
    return {
      slug: cap.slug,
      nameAr: cleanArText(cap.nameAr),
      descriptionAr: cleanArText(cap.descriptionAr),
      unitLabelAr: isProfile ? "حساب" : "سجل",
      enabled: Boolean(cap.enabled),
      defaultVolume: isProfile ? 1 : 100,
      maxVolume: isProfile ? 50 : Math.max(500, cap.maxRows || 500),
    };
  });
}

/** The daily provider limit expressed in customer points (same conversion the quote writer uses). */
export function dailyCapPointsFor(dailySpendCapUsd: number, settings: PricingSettings = DEFAULT_PRICING_SETTINGS): number {
  return Math.floor((dailySpendCapUsd * settings.usdToEgp * settings.markup) / settings.creditValueEgp);
}

/**
 * Computes the customer-visible estimated cost using the same unit rate and
 * settlement formula as the quote writer, with the same job and spend caps.
 */
export function computePublicCalculatorQuote(
  capabilitySlug: string,
  targetVolumeMax: number,
  deliveredVolume: number = targetVolumeMax,
  capabilities: Capability[] = APPROVED_CAPABILITY_CATALOG,
  settings: PricingSettings = DEFAULT_PRICING_SETTINGS,
  jobPointsCap: number = DEFAULT_JOB_POINTS_CAP,
  dailySpendCapUsd: number = DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD,
  /** The live daily limit already converted to points (the server converts it; the page never sees the USD value). */
  dailyCapPointsOverride?: number
): PublicCalculatorBreakdown {
  const safeTarget = Math.max(1, Math.floor(Number(targetVolumeMax) || 1));
  const safeDelivered = Math.max(0, Math.min(safeTarget, Math.floor(Number(deliveredVolume) ?? safeTarget)));

  const cap =
    capabilities.find((c) => c.slug === capabilitySlug) ||
    capabilities.find((c) => (capabilitySlug.includes("compan") || capabilitySlug.includes("search")) && c.slug.includes("compan")) ||
    capabilities[0];

  // Same basis as the quote writer: the customer rate when the service has one, otherwise its cost basis.
  const unitPricePoints = calculateCapabilityUnitPricePoints(cap.customerPriceUsdPerItem && cap.customerPriceUsdPerItem > 0 ? cap.customerPriceUsdPerItem : cap.unitCostUsd, settings);
  const rawPoints = safeTarget * unitPricePoints;
  const reservedPoints = Math.ceil(rawPoints * (1 + settings.safetyBuffer));

  const dailyCapPoints = typeof dailyCapPointsOverride === "number" && Number.isFinite(dailyCapPointsOverride) && dailyCapPointsOverride >= 0
    ? Math.floor(dailyCapPointsOverride)
    : dailyCapPointsFor(dailySpendCapUsd, settings);
  const effectiveMaxCap = Math.min(jobPointsCap, dailyCapPoints);

  const isCapped = reservedPoints > effectiveMaxCap;

  const maxCappedVolume = isCapped
    ? Math.max(1, Math.floor(effectiveMaxCap / Math.max(1, unitPricePoints * (1 + settings.safetyBuffer))))
    : safeTarget;
  const cappedReservedPoints = isCapped
    ? Math.ceil(maxCappedVolume * unitPricePoints * (1 + settings.safetyBuffer))
    : reservedPoints;

  const settlement = calculateFinalSettlement(
    safeDelivered,
    unitPricePoints,
    reservedPoints
  );

  // Downscaled settlement values matching the capped volume when isCapped is true
  const cappedDelivered = isCapped ? Math.min(safeDelivered, maxCappedVolume) : safeDelivered;
  const cappedSettlement = calculateFinalSettlement(
    cappedDelivered,
    unitPricePoints,
    cappedReservedPoints
  );

  const creditValueEgp = settings.creditValueEgp;

  return {
    capabilitySlug: cap.slug,
    nameAr: cleanArText(cap.nameAr),
    targetVolumeMax: isCapped ? maxCappedVolume : safeTarget,
    deliveredVolume: cappedDelivered,
    unitPricePoints,
    unitPriceEgp: Number((unitPricePoints * creditValueEgp).toFixed(4)),
    reservedPoints: cappedReservedPoints,
    reservedEgp: Number((cappedReservedPoints * creditValueEgp).toFixed(2)),
    chargedPoints: cappedSettlement.chargePoints,
    chargedEgp: Number((cappedSettlement.chargePoints * creditValueEgp).toFixed(2)),
    refundPoints: cappedSettlement.refundPoints,
    refundEgp: Number((cappedSettlement.refundPoints * creditValueEgp).toFixed(2)),
    safetyBufferPercent: Math.round(settings.safetyBuffer * 100),
    isCapped,
    maxCapPoints: effectiveMaxCap,
    maxCappedVolume,
    cappedReservedPoints,
    cappedReservedEgp: Number((cappedReservedPoints * creditValueEgp).toFixed(2)),
    cappedChargedPoints: cappedSettlement.chargePoints,
    cappedChargedEgp: Number((cappedSettlement.chargePoints * creditValueEgp).toFixed(2)),
    cappedRefundPoints: cappedSettlement.refundPoints,
    cappedRefundEgp: Number((cappedSettlement.refundPoints * creditValueEgp).toFixed(2)),
  };
}
