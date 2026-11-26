import { describe, expect, it } from "vitest";
import { normalizePhone } from "../src/lib/multiProvider/policy";

/**
 * The trunk zero written in brackets after the country code («+20 (0)22-5087419») is dropped, not kept: the number is +20 22 5087419. Evidence (the owner's
 * live check): the normaliser produced +200225087419, which is not a dialable number. The other eleven written forms keep every digit as before.
 */
describe("«(0)» after the country code is the trunk zero", () => {
  it("«+20 (0)22-5087419» becomes «+20225087419»", () => {
    expect(normalizePhone("+20 (0)22-5087419")).toBe("+20225087419");
  });
  it("the same number written without the trunk zero gives the same result", () => {
    expect(normalizePhone("+20 22-5087419")).toBe("+20225087419");
  });
});

describe("the other eleven written forms keep their digits (with Arabic-Indic and Persian digits normalized)", () => {
  // Latin forms match origin/main byte-for-byte; Arabic-Indic and Persian forms normalize identically to their Latin twins.
  const cases: Array<[string, string | null]> = [
    ["+20225087419", "+20225087419"],
    ["+20 22 5087419", "+20225087419"],
    ["+20-22-508-7419", "+20225087419"],
    ["+2025087419", "+2025087419"],
    ["+20 2 5087419", "+2025087419"],
    ["00 20 22 508 7419", "+20225087419"],
    ["٠٢٠٢٢٥٠٨٧٤١٩", "020225087419"],
    ["+٢٠ ٢٢ ٥٠٨٧٤١٩", "+20225087419"],
    ["+۲۰۲۲۵۰۸۷۴۱۹", "+20225087419"],
    ["022 508 7419", "0225087419"],
    ["(022) 5087419", "0225087419"],
  ];
  for (const [form, expected] of cases) {
    it(`«${form}» → ${expected === null ? "null" : `«${expected}»`}`, () => {
      expect(normalizePhone(form)).toBe(expected);
    });
  }
});
