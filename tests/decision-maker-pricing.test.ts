import { describe, expect, it } from "vitest";
import { decisionMakerChargePoints, decisionMakerDeliveredUnits, decisionMakerQuotePoints, markContactRowsForReview } from "../src/functions/shared/decisionMakerPricing";
import { CONTACT_BILLING_NOTE_AR, CONTACT_EXPECTATION_AR } from "../src/lib/contactExpectation";

const prices = { basePerson: 80, workEmail: 2, phone: 3 };
const requested = ["work_email", "phone"] as const;

describe("decision-maker field billing", () => {
  it("charges base plus only the returned email", () => {
    const units = decisionMakerDeliveredUnits([{ work_email: "person@company.test", phone: "" }], [...requested]);
    expect(units).toEqual({ baseUnits: 1, emailUnits: 1, phoneUnits: 0 });
    expect(decisionMakerChargePoints(units, prices)).toBe(82);
  });

  it("charges base plus only the returned phone", () => {
    const units = decisionMakerDeliveredUnits([{ work_email: "", phone: "+20100000000" }], [...requested]);
    expect(units).toEqual({ baseUnits: 1, emailUnits: 0, phoneUnits: 1 });
    expect(decisionMakerChargePoints(units, prices)).toBe(83);
  });

  it("charges base and both returned contact fields", () => {
    const units = decisionMakerDeliveredUnits([{ work_email: "person@company.test", phone: "+20100000000" }], [...requested]);
    expect(units).toEqual({ baseUnits: 1, emailUnits: 1, phoneUnits: 1 });
    expect(decisionMakerChargePoints(units, prices)).toBe(85);
  });

  it("does not charge a row with neither requested contact field", () => {
    const reviewed = markContactRowsForReview([{ name: "مراجع", work_email: "", phone: null }], [...requested]);
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0].contact_review_status).toContain("لم يتوفر");
    const units = decisionMakerDeliveredUnits(reviewed, [...requested]);
    expect(units).toEqual({ baseUnits: 0, emailUnits: 0, phoneUnits: 0 });
    expect(decisionMakerChargePoints(units, prices)).toBe(0);
  });

  it("applies the 15 percent buffer only to the reserve and never quotes above the cap", () => {
    expect(decisionMakerQuotePoints(1, [...requested], prices, 0.15, 600)).toBe(98);
    expect(decisionMakerChargePoints({ baseUnits: 10, emailUnits: 10, phoneUnits: 10 }, prices, 600)).toBe(600);
    expect(decisionMakerQuotePoints(100, [...requested], prices, 0.15, 600)).toBe(600);
  });

  it("describes per-field delivery and billing in Arabic", () => {
    expect(CONTACT_BILLING_NOTE_AR).toContain("السجل المهني الأساسي");
    expect(CONTACT_BILLING_NOTE_AR).toContain("سعر البريد المهني");
    expect(CONTACT_BILLING_NOTE_AR).toContain("سعر الهاتف المكتبي");
    expect(CONTACT_BILLING_NOTE_AR).toContain("لا يُحتسب سعر حقل لم يُرجعه المصدر");
    expect(CONTACT_EXPECTATION_AR).toContain("لم يتوفر تأكيد");
  });
});
