import { describe, expect, it } from "vitest";
import { extractDateHint, buildAutoPlanProposal, routeUnavailablePlatformRequest } from "../src/functions/shared/chatHandler";
import { extractTargetVolume } from "../src/functions/shared/briefManager";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { getPublicCalculatorOptions } from "../src/lib/calculatorPricing";

describe("live testing handoff regressions", () => {
  it("does not treat a year as a requested record count and preserves it as a date filter", () => {
    const request = "اجمع تعليقات فيسبوك في سنة 2024";
    expect(extractTargetVolume(request)).toBeUndefined();
    expect(extractDateHint(request)).toBe("2024");
  });

  it("honors absolute years and date ranges in auto plans instead of inserting a fixed date", () => {
    const yearPlan = buildAutoPlanProposal(
      { platforms: ["x"], topics: ["أسعار الذهب"], targetVolume: 10, dateRange: "2024" },
      APPROVED_CAPABILITY_CATALOG,
      "اجمع 10 منشورات في سنة 2024",
    );
    expect(yearPlan.capabilities[0].params).toMatchObject({ dateFrom: "2024-01-01", dateTo: "2024-12-31" });

    const rangePlan = buildAutoPlanProposal(
      { platforms: ["x"], topics: ["أسعار الذهب"], targetVolume: 10, dateRange: "من 2025-02-01 إلى 2025-03-01" },
      APPROVED_CAPABILITY_CATALOG,
      "اجمع 10 منشورات",
    );
    expect(rangePlan.capabilities[0].params).toMatchObject({ dateFrom: "2025-02-01", dateTo: "2025-03-01" });
  });

  it("refuses unavailable social collection before creating a quote", () => {
    const plan = { type: "propose_plan", capabilities: [{ capabilitySlug: "facebook-post-comments", endpointId: "internal-facebook-post-comments" }] };
    const result = routeUnavailablePlatformRequest(plan, "اجمع 20 تعليق من فيسبوك");
    expect(result.type).toBe("refuse");
    expect(result.reasonAr).toContain("غير متاحة");
  });

  it("does not advertise decision-maker search in the public calculator", () => {
    expect(getPublicCalculatorOptions().some((option) => option.slug === "icypeas-people-search")).toBe(false);
  });
});
