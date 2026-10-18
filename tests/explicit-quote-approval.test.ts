import { describe, expect, it } from "vitest";
import { hasExplicitQuoteApproval } from "../src/lib/server/explicitQuoteApproval";

describe("explicit quote approval boundary", () => {
  it("accepts only the explicit plan-card approval signal", () => {
    expect(hasExplicitQuoteApproval({ explicitApproval: true })).toBe(true);
    expect(hasExplicitQuoteApproval({})).toBe(false);
    expect(hasExplicitQuoteApproval({ explicitApproval: false })).toBe(false);
    expect(hasExplicitQuoteApproval({ explicitApproval: "true" })).toBe(false);
    expect(hasExplicitQuoteApproval(null)).toBe(false);
    expect(hasExplicitQuoteApproval("accepted")).toBe(false);
  });
});
