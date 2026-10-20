import { describe, expect, it } from "vitest";
import {
  BUNDLES, FREE_AMOUNT_MIN_EGP, FREE_EMAIL_DOMAINS, basePointsFor, bonusLedgerId, bundleBonusPoints, bundleByCode, bundleEconomics, bundleOutcome,
  bundlePriceEgp, checkFreeAmount, effectiveEgpFor, emailBonusLedgerId, emailBonusPoints, emailDomain, freeAmountEconomics, giveawayValue,
  isWorkOrUniversityEmail, referralLedgerId,
} from "../../src/lib/money/bundlesProposal";

describe("the approved bundles", () => {
  it("social: 2,000 +10%, 5,000 +20%, 10,000 +30%, 25,000 +40%; companies: 3,000 +10%, 8,000 +20%, 20,000 +30%", () => {
    expect(BUNDLES.filter((b) => b.line === "social").map((b) => [b.points, b.bonusPercent])).toEqual([[2000, 10], [5000, 20], [10000, 30], [25000, 40]]);
    expect(BUNDLES.filter((b) => b.line === "companies").map((b) => [b.points, b.bonusPercent])).toEqual([[3000, 10], [8000, 20], [20000, 30]]);
    expect(new Set(BUNDLES.map((b) => b.code)).size).toBe(BUNDLES.length);
  });

  it("a bundle costs points x 0.10 EGP and its bonus is floor(points x percent)", () => {
    expect(BUNDLES.map((b) => [b.code, bundlePriceEgp(b), bundleBonusPoints(b)])).toEqual([
      ["social_2000", 200, 200], ["social_5000", 500, 1000], ["social_10000", 1000, 3000], ["social_25000", 2500, 10000],
      ["companies_3000", 300, 300], ["companies_8000", 800, 1600], ["companies_20000", 2000, 6000],
    ]);
    expect(bundleByCode("social_5000")?.points).toBe(5000);
    expect(bundleByCode("nope")).toBeNull();
  });

  it("the work or university e-mail adds 5 percentage points of the bundle's points, as its own amount", () => {
    expect(BUNDLES.map((b) => emailBonusPoints(b))).toEqual([100, 250, 500, 1250, 150, 400, 1000]);
    expect(bundleOutcome(bundleByCode("social_2000")!, true)).toEqual({ paidEgp: 200, basePoints: 2000, bundleBonus: 200, emailBonus: 100, totalPoints: 2300 });
    expect(bundleOutcome(bundleByCode("social_2000")!, false).emailBonus).toBe(0);
  });

  it("ledger ids are deterministic and distinct from the base top-up id and from each other", () => {
    expect(bonusLedgerId("tp_1")).toBe("bon_tp_1");
    expect(emailBonusLedgerId("tp_1")).toBe("bon_email_tp_1");
    expect(new Set([bonusLedgerId("tp_1"), emailBonusLedgerId("tp_1"), "top_tp_1"]).size).toBe(3);
    expect(referralLedgerId("r1", "referrer")).toBe("ref_r1_referrer");
    expect(referralLedgerId("r1", "referee")).not.toBe(referralLedgerId("r1", "referrer"));
  });
});

describe("a free amount", () => {
  it("is 0.10 EGP per point with no bonus and a minimum of 100 EGP", () => {
    expect(FREE_AMOUNT_MIN_EGP).toBe(100);
    expect(checkFreeAmount(99.99)).toMatchObject({ ok: false });
    expect(checkFreeAmount(100)).toEqual({ ok: true, points: 1000 });
    expect(checkFreeAmount(337.5)).toEqual({ ok: true, points: 3375 });
    expect(checkFreeAmount(Number.NaN)).toMatchObject({ ok: false });
    expect(basePointsFor(99.99)).toBe(999);
    const refusal = checkFreeAmount(50);
    expect(!refusal.ok && refusal.reasonAr).toBe("أقل مبلغ للشحن بمبلغ حر هو ١٠٠ جنيه.");
  });
});

describe("e-mail eligibility («بريد عمل أو جامعي»)", () => {
  it("free mail providers and placeholder domains never earn it; company and university domains do", () => {
    expect(isWorkOrUniversityEmail("ahmed@acme-contracting.com")).toBe(true);
    expect(isWorkOrUniversityEmail("student@cu.edu.eg")).toBe(true);
    for (const domain of FREE_EMAIL_DOMAINS) expect(isWorkOrUniversityEmail(`a@${domain}`)).toBe(false);
    expect(isWorkOrUniversityEmail("a@example.com")).toBe(false);
    expect(isWorkOrUniversityEmail("not-an-email")).toBe(false);
    expect(emailDomain("A@Acme.COM")).toBe("acme.com");
  });
});

describe("margin per bundle (cost per point is 0.01 EGP at the 10x markup, before fees and unspent points)", () => {
  const margin = (code: string, email: boolean) => Number((bundleEconomics(bundleByCode(code)!, email).grossMargin * 100).toFixed(1));

  it("a free amount keeps 90%", () => {
    expect(freeAmountEconomics(500).grossMargin).toBeCloseTo(0.9, 9);
  });

  it("each bundle, without and with the e-mail bonus (the table in PROPOSAL_NUMBERS.md)", () => {
    expect(BUNDLES.map((b) => [b.code, margin(b.code, false), margin(b.code, true)])).toEqual([
      ["social_2000", 89, 88.5], ["social_5000", 88, 87.5], ["social_10000", 87, 86.5], ["social_25000", 86, 85.5],
      ["companies_3000", 89, 88.5], ["companies_8000", 88, 87.5], ["companies_20000", 87, 86.5],
    ]);
  });

  it("the worst case (the 40% bundle with the e-mail bonus) is 45% extra points and still 85.5%", () => {
    const worst = bundleEconomics(bundleByCode("social_25000")!, true);
    expect(worst.totalPoints).toBe(36_250);
    expect(worst.grossMargin).toBeGreaterThan(0.855 - 1e-6);
    expect(worst.pointsPerPound).toBeCloseTo(14.5, 9);
  });
});

describe("what M3 (4,500 points at the proposed price) costs in pounds, by how the points were bought", () => {
  const m3 = 4500;
  it("full price is 450; each bundle lowers it", () => {
    expect(effectiveEgpFor(m3, freeAmountEconomics(450))).toBe(450);
    expect(BUNDLES.filter((b) => b.line === "social").map((b) => [effectiveEgpFor(m3, bundleEconomics(b, false)), effectiveEgpFor(m3, bundleEconomics(b, true))])).toEqual([
      [409.09, 391.3], [375, 360], [346.15, 333.33], [321.43, 310.34],
    ]);
    expect(BUNDLES.filter((b) => b.line === "companies").map((b) => [effectiveEgpFor(m3, bundleEconomics(b, false)), effectiveEgpFor(m3, bundleEconomics(b, true))])).toEqual([
      [409.09, 391.3], [375, 360], [346.15, 333.33],
    ]);
  });
});

describe("referral", () => {
  it("states what is given away in points and pounds", () => {
    expect(giveawayValue(300)).toEqual({ points: 300, egp: 30 });
  });
});
