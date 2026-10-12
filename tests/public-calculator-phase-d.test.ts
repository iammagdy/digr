import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computePublicCalculatorQuote,
  getPublicCalculatorOptions,
} from "../src/lib/calculatorPricing";
import {
  calculateQuote,
  calculateFinalSettlement,
  DEFAULT_PRICING_SETTINGS,
} from "../src/functions/shared/quotes";
import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";

describe("Phase D: Public /calculator Page & Single Source of Truth Pricing", () => {
  it("produces identical unitPricePoints, reservedPoints, chargedPoints, and refundPoints as the quote writer across all capabilities", async () => {
    const mockTables: any = {
      listRows: async () => ({ rows: [], total: 0 }),
      createRow: async () => ({}),
      updateRow: async () => ({}),
    };

    const testCases = [
      { slug: "tiktok-profile", target: 1, delivered: 1 },
      { slug: "facebook-post-comments", target: 100, delivered: 80 },
      { slug: "x-keyword-search", target: 500, delivered: 420 },
      { slug: "instagram-comments", target: 250, delivered: 250 },
      { slug: "youtube-comments", target: 300, delivered: 0 },
    ];

    for (const tc of testCases) {
      const calcResult = computePublicCalculatorQuote(
        tc.slug,
        tc.target,
        tc.delivered,
        APPROVED_CAPABILITY_CATALOG,
        DEFAULT_PRICING_SETTINGS
      );

      const cap = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === tc.slug)!;
      const managedQuote = await createAndSaveManagedQuote(mockTables, {
        conversationId: "conv_test_calc",
        userId: "user_test_calc",
        userBalance: 100_000,
        capabilities: APPROVED_CAPABILITY_CATALOG,
        pricingSettings: DEFAULT_PRICING_SETTINGS,
        plan: {
          summaryAr: "خطة اختبار المطابقة",
          items: [
            {
              capabilitySlug: tc.slug,
              params: { username: "test" },
              targetVolumeMin: 1,
              targetVolumeMax: tc.target,
              unitCostUsd: cap.unitCostUsd,
            },
          ],
          outputFormats: ["xlsx", "pdf", "csv"],
        },
      });

      const directQuote = calculateQuote(
        tc.target,
        cap.unitCostUsd,
        100_000,
        DEFAULT_PRICING_SETTINGS
      );
      const directSettlement = calculateFinalSettlement(
        tc.delivered,
        directQuote.unitPricePoints,
        directQuote.quotedPoints
      );

      expect(calcResult.unitPricePoints).toBe(managedQuote.unitPricePoints);
      expect(calcResult.reservedPoints).toBe(managedQuote.quotedPoints);
      expect(calcResult.chargedPoints).toBe(directSettlement.chargePoints);
      expect(calcResult.refundPoints).toBe(directSettlement.refundPoints);
      expect(calcResult.reservedEgp).toBe(
        Number((managedQuote.quotedPoints * 0.1).toFixed(2))
      );
      expect(calcResult.chargedEgp).toBe(
        Number((directSettlement.chargePoints * 0.1).toFixed(2))
      );
    }
  });

  it("never exposes provider names, endpoint IDs, or USD in public calculator options or page source", () => {
    const options = getPublicCalculatorOptions();
    const serializedOptions = JSON.stringify(options);
    expect(serializedOptions).not.toMatch(/treg|scrapecreators|tikhub|serpapi|usd|anthropic|openai/i);

    const pageSource = readFileSync(
      join(process.cwd(), "src/app/calculator/page.tsx"),
      "utf-8"
    );
    expect(pageSource).toContain('dir="rtl"');
    expect(pageSource).toContain('lang="ar"');
    expect(pageSource).toContain("نقطة");
    expect(pageSource).toContain("ج.م");
    expect(pageSource).toContain("العمل المسلَّم فعليًا");
    // No approximate wording allowed on /calculator
    expect(pageSource).not.toMatch(/تقريبًا|تقريبي|حوالي|≈|approximate/i);
    expect(pageSource).not.toMatch(/treg|scrapecreators|tikhub|serpapi|usd|دولار|anthropic|openai/i);
  });
});
