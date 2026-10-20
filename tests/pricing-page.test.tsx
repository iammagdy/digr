import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: any) => createElement("a", { href, ...rest }, children) }));

import PricingPage from "../src/app/pricing/page";
import CapacityCalculator from "../src/components/pricing/CapacityCalculator";
import { CAPACITY_AMOUNTS_EGP, PRICING_FAQ_AR, buildPriceRows, capacityForAmount, capacityLineAr, pointsForAmountEgp } from "../src/lib/pricingPage";
import { computePublicCalculatorQuote } from "../src/lib/calculatorPricing";
import { volumeForPointsCap } from "../src/lib/pointsCap";
import { FAILURE_STATE_AR } from "../src/lib/publicCopy";

const html = renderToStaticMarkup(createElement(PricingPage));
const text = html.replace(/<[^>]+>/g, " ");

describe("the pricing page", () => {
  it("lists a price per type taken from the shared pricing function", () => {
    const rows = buildPriceRows();
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const youtube = rows.find((row) => row.id === "youtube-comments")!;
    expect(youtube.unitPricePoints).toBe(computePublicCalculatorQuote("social-youtube-comments", 1, 1).unitPricePoints);
    expect(html).toContain('data-testid="price-table"');
    expect(html).toContain("صنّاع قرار");
  });

  it("a capacity is what the amount can RESERVE (with the buffer), never above the amount", () => {
    for (const amount of CAPACITY_AMOUNTS_EGP) {
      const points = pointsForAmountEgp(amount);
      expect(points).toBe(amount * 10);
      for (const row of buildPriceRows()) {
        const records = capacityForAmount(amount).find((line) => line.id === row.id)!.records;
        expect(records).toBe(volumeForPointsCap(points, row.unitPricePoints, 0.15));
        expect(Math.ceil(records * row.unitPricePoints * 1.15)).toBeLessThanOrEqual(points);
      }
    }
  });

  it("every capacity is worded «حتى حوالي» and a too-small amount says so plainly", () => {
    expect(capacityLineAr({ id: "x", labelAr: "x", unitLabelAr: "تعليق", records: 12 })).toBe("حتى حوالي ١٢ تعليق");
    expect(capacityLineAr({ id: "x", labelAr: "x", unitLabelAr: "تعليق", records: 0 })).toBe("لا يكفي لسجل واحد");
    expect(html).toContain("حتى حوالي");
  });

  it("explains when money is taken, the failure state, the one-job limit and the honest limits", () => {
    const faq = PRICING_FAQ_AR.map(([q, a]) => `${q} ${a}`).join(" ");
    expect(faq).toContain("لا يُخصم شيء أثناء المحادثة");
    expect(faq).toContain(FAILURE_STATE_AR);
    expect(FAILURE_STATE_AR).toContain("لم يُخصم أي رصيد");
    expect(faq).toContain("أكثر من طلب");
    expect(text).toContain("حدود نذكرها بصراحة");
    expect(html).toContain('href="/calculator"');
    expect(html).toContain('href="/register"');
  });

  it("is Arabic only: no digits, vendor names, dollars, «100%» or technical words", () => {
    expect(text).not.toMatch(/[0-9]|undefined|null|NaN|USD|\$|treg|scrapecreators|tikhub|serpapi|openai|anthropic|100\s*%/i);
    expect(text).not.toMatch(/endpoint|API|JSON/);
  });

  it("does not advertise bundles, bonuses or referral rewards (those wait for the owner's approval)", () => {
    expect(text).not.toMatch(/باقة|باقات|بونص|مكافأة|هدية|إحالة|خصم على الشحن|رصيد إضافي|عرض خاص/);
  });

  it("has a free-amount calculator that runs in the browser with no network call", () => {
    const source = readFileSync("src/components/pricing/CapacityCalculator.tsx", "utf8");
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest/);
    expect(renderToStaticMarkup(createElement(CapacityCalculator))).toContain("اكتب أي مبلغ بالجنيه");
  });

  it("is linked from the header, the footer and the sitemap", () => {
    expect(readFileSync("src/components/landing/GlassHeader.tsx", "utf8")).toContain('href="/pricing"');
    expect(readFileSync("src/components/landing/Sections.tsx", "utf8")).toContain('href="/pricing"');
    expect(readFileSync("src/app/sitemap.ts", "utf8")).toContain("/pricing");
  });
});
