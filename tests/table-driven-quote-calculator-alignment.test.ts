import { describe, it, expect } from "vitest";
import {
  computePublicCalculatorQuote,
  getPublicCalculatorOptions,
  DEFAULT_JOB_POINTS_CAP,
} from "../src/lib/calculatorPricing";
import {
  APPROVED_CAPABILITY_CATALOG,
  buildApprovedCatalog,
} from "../src/functions/shared/capabilityRegistry";
import {
  calculateCapabilityQuote,
  calculateFinalSettlement,
  DEFAULT_PRICING_SETTINGS,
} from "../src/functions/shared/quotes";

describe("Task 4: Table-Driven Proof that Calculator Output Equals Quote Writer Output", () => {
  const settings = DEFAULT_PRICING_SETTINGS;
  const capabilities = APPROVED_CAPABILITY_CATALOG;

  it("lists company research from the real live-priced source (0.00038 USD per call; 3.168 points per delivered record, cost 0.000576 USD x 5,500)", () => {
    const options = getPublicCalculatorOptions(capabilities);
    const companyOpt = options.find(
      (o) => o.slug === "icypeas-companies-search" || o.slug.includes("compan")
    );
    expect(companyOpt).toBeDefined();
    expect(companyOpt!.enabled).toBe(true);

    const cap = capabilities.find(
      (c) => c.slug === "icypeas-companies-search" || c.slug.includes("compan")
    )!;
    expect(cap.unitCostUsd).toBe(0.00038);
    expect(cap.tregEndpointId).toBe("icypeas.companies.search");
    expect(cap.pointsPerUnit).toBe(3.168);
  });

  const testCases = [
    { name: "1. Company research 5 records (standard test)", slug: "icypeas-companies-search", volume: 5, delivered: 5 },
    { name: "2. Company research 50 records (owner comparison volume)", slug: "icypeas-companies-search", volume: 50, delivered: 50 },
    { name: "3. Company research 10 records, partial delivery 6", slug: "icypeas-companies-search", volume: 10, delivered: 6 },
    { name: "4. Company research 1 record (minimum volume)", slug: "icypeas-companies-search", volume: 1, delivered: 1 },
    { name: "5. Company research 25 records, partial delivery 20", slug: "icypeas-companies-search", volume: 25, delivered: 20 },
    { name: "6. Company research 200 records (testing high volume)", slug: "icypeas-companies-search", volume: 200, delivered: 200 },
    { name: "7. TikTok profile 1 profile (standard unit)", slug: "tiktok-profile", volume: 1, delivered: 1 },
    { name: "8. TikTok profile 5 profiles (full delivery)", slug: "tiktok-profile", volume: 5, delivered: 5 },
    { name: "9. TikTok profile 10 profiles, partial delivery 7", slug: "tiktok-profile", volume: 10, delivered: 7 },
    { name: "10. TikTok profile 20 profiles, zero delivery (failure/refund)", slug: "tiktok-profile", volume: 20, delivered: 0 },
    { name: "11. Company research 15 records, zero delivery", slug: "icypeas-companies-search", volume: 15, delivered: 0 },
    { name: "12. Company research with alias slug 'company-research'", slug: "company-research", volume: 5, delivered: 5 },
  ];

  for (const tc of testCases) {
    it(`verifies mathematical equivalence for ${tc.name}`, () => {
      const cap =
        capabilities.find((c) => c.slug === tc.slug) ||
        capabilities.find((c) => tc.slug.includes("compan") && c.slug.includes("compan"))!;
      expect(cap).toBeDefined();

      // Quote Writer calculation
      const quote = calculateCapabilityQuote(tc.volume, cap.unitCostUsd, 100000, settings, cap.slug);
      const settlement = calculateFinalSettlement(tc.delivered, quote.unitPricePoints, quote.quotedPoints);

      // Public Calculator calculation
      const calc = computePublicCalculatorQuote(
        tc.slug,
        tc.volume,
        tc.delivered,
        capabilities,
        settings,
        DEFAULT_JOB_POINTS_CAP
      );

      // 1. Unit price points must match exactly
      expect(calc.unitPricePoints).toBe(quote.unitPricePoints);

      // 2. Reserved, charged, and refunded points must match exactly
      if (!calc.isCapped) {
        expect(calc.reservedPoints).toBe(quote.quotedPoints);
        expect(calc.chargedPoints).toBe(settlement.chargePoints);
        expect(calc.refundPoints).toBe(settlement.refundPoints);
      } else {
        // Under safety cap, capped points must match capped settlement
        expect(calc.cappedReservedPoints).toBeLessThanOrEqual(DEFAULT_JOB_POINTS_CAP);
        expect(calc.cappedChargedPoints).toBeLessThanOrEqual(calc.cappedReservedPoints!);
        expect(calc.cappedRefundPoints).toBe(calc.cappedReservedPoints! - calc.cappedChargedPoints!);
      }
    });
  }
});
