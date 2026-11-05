import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHEETS } from "../src/components/landing/data";
import { METHODOLOGY_POINTS } from "../src/lib/methodologyOffer";

/**
 * The product's only PDF is the data-collection methodology, an optional paid add-on (METHODOLOGY_POINTS, ledger id chg_meth_<job>); the Excel
 * and CSV are included. The landing page must not promise a PDF «executive summary» that no code produces.
 */
describe("the landing page promises the PDF the product really delivers", () => {
  it("the PDF sheet is the methodology, marked optional; no executive-summary PDF is advertised", () => {
    const pdf = SHEETS.find((s) => s.name.includes("بي دي إف"));
    expect(pdf).toBeTruthy();
    expect(pdf!.desc).toContain("المنهجية");
    expect(pdf!.desc).toContain("اختيارية");
    expect(SHEETS.map((s) => s.desc).join(" ")).not.toContain("ملخص تنفيذي");
    expect(readFileSync("src/components/landing/heroField.ts", "utf8")).not.toContain("بي دي إف · ملخص تنفيذي");
  });
  it("the methodology stays a priced add-on (the price constant exists and is positive)", () => {
    expect(METHODOLOGY_POINTS).toBeGreaterThan(0);
  });
});
