import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

describe("customer-visible wording: «النظام», not «الخادم»", () => {
  it("the calculator page and the honest display texts no longer say «الخادم»", () => {
    for (const file of ["src/app/calculator/page.tsx", "src/lib/honestDisplay.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toContain("الخادم");
    }
  });

  it("the replaced sentences read correctly", () => {
    const calculator = readFileSync("src/app/calculator/page.tsx", "utf8");
    expect(calculator).toContain("نفس معادلة التسعير المعتمدة في النظام عند إصدار عرض السعر");
    const display = readFileSync("src/lib/honestDisplay.ts", "utf8");
    expect(display).toContain("بانتظار أول حدث مسجَّل من النظام.");
    expect(display).toContain("اكتمل التنفيذ وفق سجلّ النظام");
  });
});
