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
  expectedPoints: number;
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
  usdToEgp: 55.0,
  markup: 10.0,
  creditValueEgp: 0.10,
  safetyBuffer: 0.15, // 15%
  minPoints: 1,
};

/**
 * Compute the explicit unit price in points (EXCLUDING safety buffer)
 * Formula: Math.ceil(unitCostUsd * (usdToEgp * markup) / creditValueEgp)
 * Produces exactly 5500 points per USD of provider cost.
 */
export function calculateUnitPricePoints(
  unitCostUsd: number,
  settings: PricingSettings = DEFAULT_PRICING_SETTINGS
): number {
  const pointsPerUsd = (settings.usdToEgp * settings.markup) / settings.creditValueEgp;
  return unitCostUsd * pointsPerUsd;
}

/**
 * Compute integer unit price in points for a catalog capability (EXCLUDING safety buffer):
 * Step 1: costEgp = unitCostUsd * settings.usdToEgp (e.g. 0.001 * 55 = 0.055 EGP)
 * Step 2: markedUpEgp = costEgp * settings.markup (e.g. 0.055 * 10 = 0.55 EGP — markup applied ONCE)
 * Step 3: rawUnitPoints = markedUpEgp / settings.creditValueEgp (e.g. 0.55 / 0.10 = 5.5 points)
 * Step 4: unitPricePoints = Math.max(1, Math.ceil(rawUnitPoints)) (e.g. ceil(5.5) = 6 points)
 */
export function calculateCapabilityUnitPricePoints(
  unitCostUsd: number,
  settings: PricingSettings = DEFAULT_PRICING_SETTINGS
): number {
  if (!Number.isFinite(unitCostUsd) || unitCostUsd <= 0) return 0;
  const costEgp = unitCostUsd * settings.usdToEgp;
  const markedUpEgp = costEgp * settings.markup;
  const rawUnitPoints = markedUpEgp / settings.creditValueEgp;
  return Math.max(1, Math.ceil(rawUnitPoints));
}

/**
 * Calculate the customer quote using the same per-unit charge used at settlement:
 * - unitPricePoints = calculateCapabilityUnitPricePoints(unitCostUsd, settings)
 * - rawPoints = targetVolumeMax * unitPricePoints
 * - quotedPoints = ceil(rawPoints * (1 + safetyBuffer)) (internal reserve)
 */
export function calculateCapabilityQuote(
  targetVolumeMax: number,
  unitCostUsd: number,
  userBalance: number,
  settings: PricingSettings = DEFAULT_PRICING_SETTINGS
): QuoteCalculationResult {
  const unitPricePoints = calculateCapabilityUnitPricePoints(unitCostUsd, settings);
  const rawPoints = targetVolumeMax * unitPricePoints;
  const expectedPoints = Math.ceil(rawPoints);
  const quotedPoints = Math.ceil(rawPoints * (1 + settings.safetyBuffer));

  const isAffordable = userBalance >= quotedPoints;

  let downscaledOffer: QuoteCalculationResult["downscaledOffer"] = undefined;
  if (!isAffordable && userBalance >= settings.minPoints && unitPricePoints > 0) {
    const maxAffordableUnits = Math.max(1, Math.floor(userBalance / (unitPricePoints * (1 + settings.safetyBuffer))));
    const affordableQuotedPoints = Math.ceil(maxAffordableUnits * unitPricePoints * (1 + settings.safetyBuffer));
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
    expectedPoints,
    quotedPoints,
    targetVolumeMax,
    safetyBufferPercent: Math.round(settings.safetyBuffer * 100),
    isAffordable,
    userBalance,
    downscaledOffer,
  };
}

/**
 * Calculate Quote in Points:
 * - unitPricePoints excludes safety buffer
 * - quotedPoints = ceil(rawPoints * (1 + safetyBuffer))
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
  const expectedPoints = Math.ceil(rawPoints);
  const quotedPoints = Math.ceil(rawPoints * (1 + settings.safetyBuffer));

  const isAffordable = userBalance >= quotedPoints;

  let downscaledOffer: QuoteCalculationResult["downscaledOffer"] = undefined;
  if (!isAffordable && userBalance >= settings.minPoints && unitPricePoints > 0) {
    const maxAffordableUnits = Math.max(1, Math.floor(userBalance / (unitPricePoints * (1 + settings.safetyBuffer))));
    const affordableQuotedPoints = Math.ceil(maxAffordableUnits * unitPricePoints * (1 + settings.safetyBuffer));
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
    expectedPoints,
    quotedPoints,
    targetVolumeMax,
    safetyBufferPercent: Math.round(settings.safetyBuffer * 100),
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
