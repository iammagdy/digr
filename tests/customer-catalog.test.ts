import { describe, expect, it } from "vitest";
import { computePublicCalculatorQuote, getPublicCalculatorOptions } from "../src/lib/calculatorPricing";
import { DECISION_MAKER_UNIT_PRICES_POINTS } from "../src/functions/shared/decisionMakerPricing";
import { buildPlatformGuideServices, PLATFORM_GUIDE } from "../src/functions/shared/platformGuide";

describe("customer services catalog", () => {
  it("lists the guide's executable services and gets unit rates from the shared calculator", () => {
    const options = getPublicCalculatorOptions();
    const optionSlugs = new Set(options.map((option) => option.slug));
    const guideServices = buildPlatformGuideServices();
    for (const service of guideServices.filter((item) => item.slug !== "topic-news-academic-research")) {
      expect(optionSlugs.has(service.slug), service.slug).toBe(true);
      const quote = computePublicCalculatorQuote(service.slug, 1, 1);
      expect(quote.unitPricePoints).toBeGreaterThan(0);
    }
  });

  it("uses the shared field-by-field price source for decision makers", () => {
    expect(DECISION_MAKER_UNIT_PRICES_POINTS).toEqual({ basePerson: 83, workEmail: 55, phone: 55 });
    expect(PLATFORM_GUIDE.services.find((service) => service.slug === "professional-people-search")?.descriptionAr)
      .toContain("بريد عمل وهاتف مكتبي");
  });

  it("shows only the two future source categories as coming soon", () => {
    expect(PLATFORM_GUIDE.futureSources).toHaveLength(2);
    expect(PLATFORM_GUIDE.futureSources.map((source) => source.statusAr)).toEqual(["قريباً", "قريباً"]);
  });
});
