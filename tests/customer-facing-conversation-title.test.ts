import { describe, expect, it } from "vitest";
import { customerFacingConversationTitle } from "../src/lib/customerFacingConversationTitle";

describe("customer-facing conversation titles", () => {
  it("localizes the FinTech taxonomy label and uses Arabic-Indic digits", () => {
    expect(customerFacingConversationTitle("ابحث عن 50 شركة FinTech في ألمانيا"))
      .toBe("ابحث عن ٥٠ شركة التقنية المالية في ألمانيا");
  });

  it("preserves already localized titles", () => {
    expect(customerFacingConversationTitle("بحث عن شركات التقنية المالية في ألمانيا"))
      .toBe("بحث عن شركات التقنية المالية في ألمانيا");
  });
});
