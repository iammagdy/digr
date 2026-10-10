export interface PricingSettings {
  usdToEgp: number;
  markup: number;
  creditValueEgp: number;
  safetyBuffer: number; // e.g. 0.15 for 15%
  minPoints: number; // default 1
}

export interface PlanItem {
  capabilitySlug: string;
  params: Record<string, any>;
  targetVolumeMin: number;
  targetVolumeMax: number;
  unitCostUsd: number;
}

export interface QuoteCalculationResult {
  unitPricePoints: number;
  rawPoints: number;
  quotedPoints: number;
  targetVolumeMax: number;
  safetyBufferPercent: number;
  isAffordable: boolean;
  userBalance: number;
  downscaledOffer?: {
    maxAffordableUnits: number;
    affordableQuotedPoints: number;
  };
}

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  usdToEgp: 53.0,
  markup: 2.0,
  creditValueEgp: 0.1,
  safetyBuffer: 0.15, // 15%
  minPoints: 1,
};

/**
 * Compute the explicit unit price in points (EXCLUDING safety buffer)
 * Formula: (unitCostUsd * usdToEgp * markup) / creditValueEgp
 */
export function calculateUnitPricePoints(
  unitCostUsd: number,
  settings: PricingSettings = DEFAULT_PRICING_SETTINGS
): number {
  const pointsPerUsd = (settings.usdToEgp * settings.markup) / settings.creditValueEgp;
  return unitCostUsd * pointsPerUsd;
}

/**
 * Calculate Quote in Points:
 * - unitPricePoints excludes safety buffer
 * - quotedPoints = ceil(targetVolumeMax * unitPricePoints * (1 + safetyBuffer))
 * - downscales automatically if user balance is insufficient
 */
export function calculateQuote(
  targetVolumeMax: number,
  unitCostUsd: number,
  userBalance: number,
  settings: PricingSettings = DEFAULT_PRICING_SETTINGS
): QuoteCalculationResult {
  const unitPricePoints = calculateUnitPricePoints(unitCostUsd, settings);
  const rawPoints = targetVolumeMax * unitPricePoints;
  const withBuffer = rawPoints * (1 + settings.safetyBuffer);
  const quotedPoints = Math.max(settings.minPoints, Math.ceil(withBuffer));

  const isAffordable = userBalance >= quotedPoints;

  let downscaledOffer: QuoteCalculationResult["downscaledOffer"] = undefined;
  if (!isAffordable && userBalance >= settings.minPoints) {
    const costPerUnitWithBuffer = unitPricePoints * (1 + settings.safetyBuffer);
    const maxAffordableUnits = Math.max(1, Math.floor(userBalance / costPerUnitWithBuffer));
    const affordableQuotedPoints = Math.max(
      settings.minPoints,
      Math.ceil(maxAffordableUnits * costPerUnitWithBuffer)
    );
    if (maxAffordableUnits < targetVolumeMax) {
      downscaledOffer = {
        maxAffordableUnits,
        affordableQuotedPoints,
      };
    }
  }

  return {
    unitPricePoints,
    rawPoints,
    quotedPoints,
    targetVolumeMax,
    safetyBufferPercent: settings.safetyBuffer * 100,
    isAffordable,
    userBalance,
    downscaledOffer,
  };
}

/**
 * Calculate Final Charge upon Job Completion:
 * HARD RULE A: charge = ceil(deliveredUnits * unitPricePoints)
 * - Excludes the safety buffer completely!
 * - Never charges more than the approved quotedPoints
 */
export function calculateFinalSettlement(
  deliveredUnits: number,
  unitPricePoints: number,
  reservedPoints: number
): {
  chargePoints: number;
  refundPoints: number;
} {
  const rawCharge = Math.ceil(deliveredUnits * unitPricePoints);
  // Cap at reserved points (platform absorbs any unexpected cost overrun)
  const chargePoints = Math.min(reservedPoints, Math.max(0, rawCharge));
  const refundPoints = Math.max(0, reservedPoints - chargePoints);

  return {
    chargePoints,
    refundPoints,
  };
}

/**
 * Check if a quote is expired (30 minutes default expiry)
 */
export function isQuoteExpired(expiresAt: string | Date, now: Date = new Date()): boolean {
  const expiryDate = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  return now.getTime() > expiryDate.getTime();
}

/**
 * Generate 30-minute expiry timestamp
 */
export function generateQuoteExpiry(minutes: number = 30, from: Date = new Date()): string {
  const expiry = new Date(from.getTime() + minutes * 60 * 1000);
  return expiry.toISOString();
}
