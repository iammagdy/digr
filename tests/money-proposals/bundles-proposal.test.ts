import { describe, expect, it } from "vitest";
import {
  BUNDLE_TIERS, FREE_EMAIL_DOMAINS, basePointsFor, bonusLedgerId, bonusPointsFor, emailDomain, giveawayValue, isWorkEmail, marginImpact,
  referralLedgerId, tierFor, workEmailBonusLedgerId,
} from "../../src/lib/money/bundlesProposal";

describe("proposal 4a: wallet bundles with a bonus", () => {
  it("base points are floor(amount / 0.10), exactly what the top-up credits today", () => {
    expect(basePointsFor(100)).toBe(1000);
    expect(basePointsFor(250)).toBe(2500);
    expect(basePointsFor(99.99)).toBe(999);
  });

  it("each tier gives its bonus, a top-up between tiers earns the lower tier, below the first tier earns none", () => {
    expect(BUNDLE_TIERS.map((t) => [t.amountEgp, bonusPointsFor(t.amountEgp)])).toEqual([[100, 0], [250, 125], [500, 750], [1000, 2500], [2500, 10000]]);
    expect(bonusPointsFor(499)).toBe(Math.floor((basePointsFor(499) * 5) / 100));
    expect(tierFor(99)).toBeNull();
    expect(bonusPointsFor(99)).toBe(0);
  });

  it("bonus ids are deterministic and distinct from the base top-up id", () => {
    expect(bonusLedgerId("tp_1")).toBe("bon_tp_1");
    expect(bonusLedgerId("tp_1")).not.toBe("top_tp_1");
    expect(workEmailBonusLedgerId("u1")).toBe("bon_workemail_u1");
    expect(referralLedgerId("r1", "referrer")).toBe("ref_r1_referrer");
    expect(referralLedgerId("r1", "referee")).not.toBe(referralLedgerId("r1", "referrer"));
  });

  it("the 40% tier cuts gross margin from 90% to 86% before fees; every tier stays above 85%", () => {
    expect(marginImpact(0).grossMargin).toBeCloseTo(0.9, 6);
    expect(marginImpact(40).grossMargin).toBeCloseTo(1 - 1.4 / 10, 6);
    for (const tier of BUNDLE_TIERS) expect(marginImpact(tier.bonusPercent).grossMargin).toBeGreaterThan(0.85);
    // the margin column of docs/proposals/PROPOSAL_NUMBERS.md
    expect(BUNDLE_TIERS.map((t) => Number((marginImpact(t.bonusPercent).grossMargin * 100).toFixed(1)))).toEqual([90, 89.5, 88.5, 87.5, 86]);
  });
});

describe("proposal 4b: work-email bonus", () => {
  it("free mail providers and placeholder domains never earn it; company domains do", () => {
    expect(isWorkEmail("ahmed@acme-contracting.com")).toBe(true);
    expect(isWorkEmail("ahmed@sub.company.com.eg")).toBe(true);
    for (const domain of FREE_EMAIL_DOMAINS) expect(isWorkEmail(`a@${domain}`)).toBe(false);
    expect(isWorkEmail("a@example.com")).toBe(false);
    expect(isWorkEmail("not-an-email")).toBe(false);
    expect(emailDomain("A@Acme.COM")).toBe("acme.com");
  });
});

describe("proposal 4c: referral", () => {
  it("states what is given away in points and pounds", () => {
    expect(giveawayValue(300)).toEqual({ points: 300, egp: 30 });
  });
});
