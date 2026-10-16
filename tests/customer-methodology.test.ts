import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getCustomerMethodologyNote } from "../src/lib/customerMethodology";

describe("customer-facing quote methodology", () => {
  it("uses Arabic source-available wording for company plans instead of raw model notes", () => {
    const note = getCustomerMethodologyNote(false, true);
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");

    expect(note).toContain("المصادر المتاحة");
    expect(note).not.toMatch(/[A-Za-z]/);
    expect(note).not.toContain("المصدر العام");
    expect(note).not.toContain("verified");
    expect(card).toContain("getCustomerMethodologyNote(isPeoplePlan, isCompanyPlan)");
    expect(card).not.toContain("quote.methodologyNotes ||");
  });

  it("states people field presence without claiming verification", () => {
    const note = getCustomerMethodologyNote(true, false);

    expect(note).toContain("الحقول الموجودة أو غير الموجودة");
    expect(note).toContain("وجود البريد لا يعني التحقق من صحته");
    expect(note).not.toContain("متحقق");
  });

  it("uses the same source wording for other quote types", () => {
    const note = getCustomerMethodologyNote(false, false);

    expect(note).toContain("المصادر المتاحة");
    expect(note).not.toContain("البيانات العامة");
    expect(note).not.toMatch(/[A-Za-z]/);
  });
});
