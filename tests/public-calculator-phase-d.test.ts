import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computePublicCalculatorQuote,
  getPublicCalculatorOptions,
} from "../src/lib/calculatorPricing";
import {
  calculateCapabilityQuote,
  calculateCapabilityUnitPricePoints,
  calculateFinalSettlement,
  DEFAULT_PRICING_SETTINGS,
} from "../src/functions/shared/quotes";
import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { APPROVED_CAPABILITY_CATALOG, type Capability } from "../src/functions/shared/capabilityRegistry";

describe("Phase D: Public /calculator Page & Single Source of Truth Pricing", () => {
  it("verifies exact step-by-step markup-once math for tiktok-profile at 0.001 USD (6 unit price, 7 reserve) and equals quote writer", async () => {
    const mockTables: any = {
      listRows: async () => ({ rows: [], total: 0 }),
      createRow: async () => ({}),
      updateRow: async () => ({}),
    };

    const tiktok001Cap: Capability = {
      ...APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === "tiktok-profile")!,
      unitCostUsd: 0.001,
      estimatedCostUsdPerUnit: 0.001,
    };

    // Step-by-step verification:
    // 0.001 USD -> * 55 = 0.055 EGP -> * 10 = 0.55 EGP -> / 0.10 = 5.5 -> ceil = 6 points
    const unitPrice = calculateCapabilityUnitPricePoints(0.001, DEFAULT_PRICING_SETTINGS);
    expect(unitPrice).toBe(6);

    const calc1 = computePublicCalculatorQuote(
      "tiktok-profile",
      1,
      1,
      [tiktok001Cap],
      DEFAULT_PRICING_SETTINGS
    );
    expect(calc1.unitPricePoints).toBe(6);
    expect(calc1.reservedPoints).toBe(7); // ceil(6 * 1.15) = ceil(6.9) = 7
    expect(calc1.chargedPoints).toBe(6);
    expect(calc1.refundPoints).toBe(1);

    const managed1 = await createAndSaveManagedQuote(mockTables, {
      conversationId: "conv_tiktok_001",
      userId: "user_tiktok_001",
      userBalance: 1000,
      capabilities: [tiktok001Cap],
      plan: {
        summaryAr: "ملف تيك توك",
        items: [
          {
            capabilitySlug: "tiktok-profile",
            params: { username: "iammagdy" },
            targetVolumeMin: 1,
            targetVolumeMax: 1,
          },
        ],
        outputFormats: ["xlsx", "pdf", "csv"],
      },
    });
    expect(managed1.unitPricePoints).toBe(calc1.unitPricePoints);
    expect(managed1.quotedPoints).toBe(calc1.reservedPoints);
    console.log(
      `[equality:tiktok-profile@0.001] calc={unit:${calc1.unitPricePoints}, reserve:${calc1.reservedPoints}, charge:${calc1.chargedPoints}, refund:${calc1.refundPoints}} quoteWriter={unit:${managed1.unitPricePoints}, reserve:${managed1.quotedPoints}}`
    );
  });

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

      const directQuote = calculateCapabilityQuote(
        tc.target,
        cap.unitCostUsd,
        100_000,
        DEFAULT_PRICING_SETTINGS
      );
      const cappedDelivered = Math.min(tc.delivered, calcResult.maxCappedVolume ?? tc.target);
      const directSettlement = calculateFinalSettlement(
        cappedDelivered,
        directQuote.unitPricePoints,
        calcResult.cappedReservedPoints ?? directQuote.quotedPoints
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
      console.log(
        `[equality:${tc.slug}] target=${tc.target} delivered=${tc.delivered} -> unit=${calcResult.unitPricePoints} reserve=${calcResult.reservedPoints} charge=${calcResult.chargedPoints} refund=${calcResult.refundPoints}`
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
