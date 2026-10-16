import { describe, expect, it } from "vitest";
import { customerFacingCapabilityLabel, customerFacingQuoteSummary } from "../src/lib/customerFacingRequestLabels";

describe("customer-facing request labels", () => {
  it("never exposes internal people or company capability identifiers", () => {
    const people = customerFacingQuoteSummary("icypeas-people-search");
    const companies = customerFacingQuoteSummary("icypeas-companies-search");

    expect(people).toBe("طلب صناع القرار والمسؤولين");
    expect(companies).toBe("طلب الشركات والأعمال");
    expect(people?.toLowerCase()).not.toContain("icypeas");
    expect(companies?.toLowerCase()).not.toContain("icypeas");
  });

  it("maps known platforms to Arabic and unknown identifiers to a generic label", () => {
    expect(customerFacingCapabilityLabel("tiktok-profile")).toBe("تيك توك");
    expect(customerFacingCapabilityLabel("provider-specific-secret-slug")).toBe("بحث");
    expect(customerFacingQuoteSummary()).toBeUndefined();
  });
});
