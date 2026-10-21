import {
  calculateCapabilityQuote,
  unitPricePointsForCapability,
  calculateFinalSettlement,
  DEFAULT_PRICING_SETTINGS,
  type PricingSettings,
} from "../functions/shared/quotes";
import {
  APPROVED_CAPABILITY_CATALOG,
  type Capability,
} from "../functions/shared/capabilityRegistry";
import { PLATFORM_GUIDE } from "../functions/shared/platformGuide";
import { DECISION_MAKER_UNIT_PRICES_POINTS } from "../functions/shared/decisionMakerPricing";
import { recordsInOneJob, reserveInOneJob } from "./jobSizing";
import { reserveForUnits } from "./recordPricing";
export const DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD = 0.80;
import { JOB_MAX_POINTS_CAP } from "./jobPointsCap";
export const DEFAULT_JOB_POINTS_CAP = JOB_MAX_POINTS_CAP;

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

  // Same basis as the quote writer: the customer rate when the service has one, otherwise its cost basis. Decision makers are
  // priced per person plus the contact fields (the writer's default asks for both), never at the base rate alone.
  const isPeople = cap.slug === "professional-people-search";
  const unitPricePoints = isPeople
    ? DECISION_MAKER_UNIT_PRICES_POINTS.basePerson + DECISION_MAKER_UNIT_PRICES_POINTS.workEmail + DECISION_MAKER_UNIT_PRICES_POINTS.phone
    : unitPricePointsForCapability(cap, settings);
  const reservedPoints = reserveForUnits(safeTarget, unitPricePoints, settings.safetyBuffer);

  const dailyCapPoints = typeof dailyCapPointsOverride === "number" && Number.isFinite(dailyCapPointsOverride) && dailyCapPointsOverride >= 0
    ? Math.floor(dailyCapPointsOverride)
    : dailyCapPointsFor(dailySpendCapUsd, settings);
  const effectiveMaxCap = Math.min(jobPointsCap, dailyCapPoints);

  // One shared rule for the one-job size (the quote writer's own: see jobSizing).
  const sizing = { unitPricePoints, capPoints: effectiveMaxCap, safetyBuffer: settings.safetyBuffer, chargeCapped: isPeople };
  const isCapped = safeTarget > recordsInOneJob(sizing);

  const maxCappedVolume = isCapped ? Math.max(1, recordsInOneJob(sizing)) : safeTarget;
  const cappedReservedPoints = reserveInOneJob(maxCappedVolume, sizing);

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
