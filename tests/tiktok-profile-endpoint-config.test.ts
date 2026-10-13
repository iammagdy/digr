import { describe, it, expect } from "vitest";
import {
  APPROVED_CAPABILITY_CATALOG,
  buildApprovedCatalog,
  getEnabledCapabilities,
  getRegistryPricingSettings,
  computeRegistryPointsPerUnit,
} from "../src/functions/shared/capabilityRegistry";
import {
  calculateCapabilityQuote,
  calculateCapabilityUnitPricePoints,
  calculateFinalSettlement,
  DEFAULT_PRICING_SETTINGS,
} from "../src/functions/shared/quotes";
import {
  computePublicCalculatorQuote,
  getPublicCalculatorOptions,
} from "../src/lib/calculatorPricing";

describe("TikTok Profile Endpoint & Pricing Configuration Verification", () => {
  it("verifies APPROVED_CAPABILITY_CATALOG contains the verified tikhub endpoint and 0.001 USD cost", () => {
    const tiktokCap = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === "tiktok-profile");
    expect(tiktokCap).toBeDefined();
    expect(tiktokCap!.tregEndpointId).toBe("tikhub.tiktok.user.profile");
    expect(tiktokCap!.unitCostUsd).toBe(0.001);
    expect(tiktokCap!.estimatedCostUsdPerUnit).toBe(0.001);
    expect(tiktokCap!.tregMethod).toBe("GET");
    expect(tiktokCap!.pricingUnit).toBe("call");
    expect(tiktokCap!.paginationType).toBe("none");
    expect(tiktokCap!.maxRows).toBe(1);
    expect(tiktokCap!.enabled).toBe(true);
    expect(tiktokCap!.status).toBe("verified");
    expect(tiktokCap!.nameAr).toBe("استخراج ملف تيك توك الشخصي");
    expect(tiktokCap!.nameEn).toBe("TikTok User Profile");
    expect(tiktokCap!.pointsPerUnit).toBe(6);
  });

  it("verifies tiktok-profile is enabled and server registry returns only enabled verified capabilities", async () => {
    const tiktokCap = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === "tiktok-profile");
    expect(tiktokCap!.enabled).toBe(true);

    const mockDbOnlyTikTokEnabled = {
      from: () => ({
        select: () => ({
          eq: async () => ({
            data: [
              {
                slug: "tiktok-profile",
                name_ar: "استخراج ملف تيك توك الشخصي",
                endpoint_id: "tikhub.tiktok.user.profile",
                unit_price_credits: 6,
                unit_cost_usd: 0.001,
                enabled: true,
              },
            ],
          }),
        }),
      }),
    };

    const serverCaps = await getEnabledCapabilities(mockDbOnlyTikTokEnabled as any);
    expect(serverCaps).toHaveLength(1);
    expect(serverCaps[0].slug).toBe("tiktok-profile");
    expect(serverCaps[0].enabled).toBe(true);
  });

  it("verifies approved pricing: 5500 points/USD, unit price = 6, reserve = 7 for 1 profile", () => {
    const settings = DEFAULT_PRICING_SETTINGS;
    // 55 USD/EGP * 10 markup / 0.10 EGP/point = 5500 points per USD
    const pointsPerUsd = (settings.usdToEgp * settings.markup) / settings.creditValueEgp;
    expect(pointsPerUsd).toBe(5500);

    // 0.001 USD * 5500 = 5.5 -> ceil = 6 points
    const unitPrice = calculateCapabilityUnitPricePoints(0.001, settings);
    expect(unitPrice).toBe(6);

    // Quote for 1 profile: reserve = ceil(1 * 6 * 1.15) = ceil(6.9) = 7 points
    const quote = calculateCapabilityQuote(1, 0.001, 1000, settings);
    expect(quote.unitPricePoints).toBe(6);
    expect(quote.quotedPoints).toBe(7);

    // Delivered 1: charge = 6, refund = 1
    const delivered1 = calculateFinalSettlement(1, quote.unitPricePoints, quote.quotedPoints);
    expect(delivered1.chargePoints).toBe(6);
    expect(delivered1.refundPoints).toBe(1);

    // Delivered 0 (failed or stalled): charge = 0, refund = 7 (full reserve released)
    const delivered0 = calculateFinalSettlement(0, quote.unitPricePoints, quote.quotedPoints);
    expect(delivered0.chargePoints).toBe(0);
    expect(delivered0.refundPoints).toBe(7);
  });

  it("verifies public calculator matches quote writer for tiktok-profile at 0.001 USD", () => {
    const calc = computePublicCalculatorQuote("tiktok-profile", 1, 1);
    expect(calc.unitPricePoints).toBe(6);
    expect(calc.reservedPoints).toBe(7);
    expect(calc.chargedPoints).toBe(6);
    expect(calc.refundPoints).toBe(1);
    expect(calc.reservedEgp).toBe(0.70);
    expect(calc.chargedEgp).toBe(0.60);
    expect(calc.refundEgp).toBe(0.10);
  });

  it("verifies getEnabledCapabilities returns tiktok-profile with verified endpoint and 6 points", async () => {
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: async () => ({
            data: [
              {
                slug: "tiktok-profile",
                name_ar: "استخراج ملف تيك توك الشخصي",
                endpoint_id: "tikhub.tiktok.user.profile",
                unit_price_credits: 6,
                unit_cost_usd: 0.001,
                enabled: true,
              },
            ],
          }),
        }),
      }),
    };

    const caps = await getEnabledCapabilities(mockDb as any);
    expect(caps).toHaveLength(1);
    expect(caps[0].slug).toBe("tiktok-profile");
    expect(caps[0].tregEndpointId).toBe("tikhub.tiktok.user.profile");
    expect(caps[0].unitCostUsd).toBe(0.001);
    expect(caps[0].pointsPerUnit).toBe(6);
  });
});
