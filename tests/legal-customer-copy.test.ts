import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TERMS } from "../src/lib/legalText";

describe("customer legal and brand wording", () => {
  it("states only the requested verification limits without implying a measured rate", () => {
    const terms = TERMS.map(([, body]) => body).join(" ");
    const legalPage = readFileSync("src/components/LegalPage.tsx", "utf8");

    expect(terms).toContain("نبذل أقصى جهد للتحقق، ونوضح حالة التحقق لكل خانة، ولا نضمن حداثة كل معلومة");
    expect(terms).not.toContain("معدلات التحقق");
    expect(legalPage).not.toContain("مسودة للتصميم");
    expect(legalPage).not.toContain("مستشار قانوني");
  });

  it("uses sources-available wording in the visible email footer", () => {
    const templates = readFileSync("src/functions/shared/emailTemplates.ts", "utf8");
    expect(templates).toContain("مصادر متاحة جاهزة للتحليل");
    expect(templates).not.toContain("بيانات عامة جاهزة للتحليل");
  });
});
