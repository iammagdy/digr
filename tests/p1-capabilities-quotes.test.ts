import { describe, it, expect } from "vitest";
import {
  calculateUnitPricePoints,
  calculateQuote,
  calculateFinalSettlement,
  isQuoteExpired,
  generateQuoteExpiry,
  DEFAULT_PRICING_SETTINGS,
} from "../src/functions/shared/quotes";
import {
  sanitizeCapabilitiesForLlm,
  validateCapabilityParams,
  Capability,
} from "../src/functions/shared/capabilityRegistry";

describe("P1: Capabilities & Quotes Module", () => {
  const sampleCapability: Capability = {
    slug: "tiktok-profile",
    category: "tiktok",
    nameAr: "استخراج ملف تيك توك الشخصي",
    nameEn: "TikTok User Profile",
    descriptionAr: "استخراج الإحصائيات الشاملة",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { username: { type: "string" } },
      required: ["username"],
    }),
    tregEndpointId: "secret.tikhub.endpoint.123",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.0012,
    maxRows: 1,
    paginationType: "none",
    enabled: true,
  };

  it("should sanitize capabilities for LLM and leak ZERO secret fields (R1)", () => {
    const sanitized = sanitizeCapabilitiesForLlm([sampleCapability]);
    expect(sanitized).toHaveLength(1);
    const item = sanitized[0] as any;

    expect(item.slug).toBe("tiktok-profile");
    expect(item.nameAr).toBeDefined();
    expect(item.paramsSchema).toBeDefined();
    expect(item.maxRows).toBe(1);

    // Hard rule: no secrets
    expect(item.tregEndpointId).toBeUndefined();
    expect(item.unitCostUsd).toBeUndefined();
    expect(item.tregMethod).toBeUndefined();
    expect(item.pricingUnit).toBeUndefined();
  });

  it("should validate capability parameters server-side", () => {
    const validRes = validateCapabilityParams(sampleCapability, { username: "khaby.lame" });
    expect(validRes.valid).toBe(true);

    const invalidRes = validateCapabilityParams(sampleCapability, {});
    expect(invalidRes.valid).toBe(false);
    expect(invalidRes.errors?.[0]).toContain("مفقود");
  });

  it("should compute unit price in points using formula: (cost * usdToEgp * markup) / creditVal", () => {
    // 0.035 USD * 53 * 2.0 / 0.1 = 37.1 points for 500 units -> 0.0742 per unit
    const unitPrice = calculateUnitPricePoints(0.035 / 500, DEFAULT_PRICING_SETTINGS);
    expect(unitPrice).toBeCloseTo(0.0742, 4);
  });

  it("should apply safety buffer (15%) ONLY to the quotedPoints and reserve", () => {
    // 500 units, each 0.0742 points = 37.1 points. With 15% buffer = 42.665 -> ceil is 43 points
    const quote = calculateQuote(500, 0.035 / 500, 100, DEFAULT_PRICING_SETTINGS);
    expect(quote.rawPoints).toBeCloseTo(37.1, 1);
    expect(quote.quotedPoints).toBe(43);
    expect(quote.isAffordable).toBe(true);
  });

  it("should calculate settlement with explicit formula and EXCLUDE safety buffer from charge (Worked Example)", () => {
    // Reserved = 43 points (quote for 500 units)
    const unitPrice = calculateUnitPricePoints(0.035 / 500, DEFAULT_PRICING_SETTINGS);
    const reservedPoints = 43;

    // 420 units delivered
    const settlement = calculateFinalSettlement(420, unitPrice, reservedPoints);

    // charge = ceil(420 * 0.0742) = ceil(31.164) = 32 points
    expect(settlement.chargePoints).toBe(32);

    // refund = 43 - 32 = 11 points refunded to user
    expect(settlement.refundPoints).toBe(11);
  });

  it("should never charge more than the approved quotedPoints if cost overruns", () => {
    const unitPrice = calculateUnitPricePoints(0.001, DEFAULT_PRICING_SETTINGS);
    const reservedPoints = 20;

    // Even if deliveredUnits calculation gives 50 points, it must cap at 20
    const settlement = calculateFinalSettlement(100, unitPrice, reservedPoints);
    expect(settlement.chargePoints).toBe(20);
    expect(settlement.refundPoints).toBe(0);
  });

  it("should compute a downscaled offer if user balance is insufficient", () => {
    // User wants 500 units (quote 43 points) but has only 20 points
    const quote = calculateQuote(500, 0.035 / 500, 20, DEFAULT_PRICING_SETTINGS);
    expect(quote.isAffordable).toBe(false);
    expect(quote.downscaledOffer).toBeDefined();

    // Downscaled offer should fit within 20 points
    expect(quote.downscaledOffer!.affordableQuotedPoints).toBeLessThanOrEqual(20);
    expect(quote.downscaledOffer!.maxAffordableUnits).toBeGreaterThan(0);
    expect(quote.downscaledOffer!.maxAffordableUnits).toBeLessThan(500);
  });

  it("should check quote expiry accurately (30 minutes)", () => {
    const freshExpiry = generateQuoteExpiry(30);
    expect(isQuoteExpired(freshExpiry)).toBe(false);

    const pastExpiry = new Date(Date.now() - 5 * 60 * 1000); // 5 mins ago
    expect(isQuoteExpired(pastExpiry)).toBe(true);
  });
});
