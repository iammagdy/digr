import { describe, expect, it } from "vitest";
import { escapeFormula } from "../src/lib/server/normalizationPipeline";
import { generateCsvReport } from "../src/functions/shared/fileGenerators";

describe("formula injection guard keeps phones and handles clean", () => {
  it("leaves phone numbers and account handles untouched", () => {
    for (const value of ["+201001234567", "+20 100 123 4567", "+49 (30) 1234567", "+966-11-123-4567", "@sports_analyst_ar", "@who"]) {
      expect(escapeFormula(value), value).toBe(value);
    }
  });

  it("still escapes anything that could be a formula", () => {
    for (const value of ["=SUM(A1:A9)", "=ملخص", "+cmd|' /C calc'!A0", "-2+3", "@SUM(1,2)", "+1+1", "=HYPERLINK(\"http://x\")", "\t=1+1"]) {
      expect(String(escapeFormula(value)).startsWith("'"), value).toBe(true);
    }
  });

  it("a short number is not mistaken for a phone", () => {
    expect(escapeFormula("-12")).toBe("'-12");
    expect(escapeFormula("+5")).toBe("'+5");
  });

  it("the CSV phone column has no leading apostrophe", () => {
    const csv = generateCsvReport({ title: "c", entityType: "companies", rows: [{ company_name: "X", phone: "+20 2 2345 6789" }] } as any).toString("utf8");
    expect(csv).toContain('"+20 2 2345 6789"');
    expect(csv).not.toContain("'+20");
  });
});
