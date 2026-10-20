import { describe, expect, it } from "vitest";
import { CONFIRM_ABOVE_POINTS, evaluateStartGate, estimatedProviderCostUsd, type StartGateInput } from "../../src/lib/money/capsProposal";
import { applyCustomOffer, customOfferId, offerCharge, type CustomOffer } from "../../src/lib/money/customOfferProposal";
import { reservePoints } from "../../src/lib/money/pricingProposal";

const base: StartGateInput = {
  reservePoints: 300, userBalancePoints: 1000, jobCapPoints: 6000, confirmedLargeReserve: false,
  estimatedProviderCostUsd: 0.1, providerBalanceUsd: 5, providerDailyCapUsd: 1, providerSpentTodayUsd: 0.2,
};

describe("proposal 4e: the start-of-job gate", () => {
  it("allows a small affordable job", () => {
    expect(evaluateStartGate(base)).toEqual({ decision: "allow" });
  });
  it("refuses when the balance cannot cover the reserve", () => {
    expect(evaluateStartGate({ ...base, reservePoints: 1500 })).toMatchObject({ decision: "blocked", code: "insufficient_balance" });
  });
  it("refuses above the per-job cap, whatever the balance", () => {
    expect(evaluateStartGate({ ...base, reservePoints: 7000, userBalancePoints: 10_000 })).toMatchObject({ decision: "blocked", code: "over_job_cap" });
  });
  it("asks for an explicit confirmation above 600 points, then allows", () => {
    const big = { ...base, reservePoints: CONFIRM_ABOVE_POINTS + 1 };
    expect(evaluateStartGate(big)).toMatchObject({ decision: "needs_confirmation" });
    expect(evaluateStartGate({ ...big, confirmedLargeReserve: true })).toEqual({ decision: "allow" });
    expect(evaluateStartGate({ ...base, reservePoints: CONFIRM_ABOVE_POINTS })).toEqual({ decision: "allow" });
  });
  it("blocks on the provider's daily allowance and on a low provider balance, with no charge and no vendor or dollar words", () => {
    const daily = evaluateStartGate({ ...base, providerSpentTodayUsd: 0.95 });
    const low = evaluateStartGate({ ...base, providerBalanceUsd: 0.11 });
    expect(daily).toMatchObject({ decision: "blocked", code: "provider_daily_cap" });
    expect(low).toMatchObject({ decision: "blocked", code: "provider_balance_low" });
    for (const decision of [daily, low, evaluateStartGate({ ...base, reservePoints: 1500 }), evaluateStartGate({ ...base, reservePoints: 700 })]) {
      const text = "reasonAr" in decision ? decision.reasonAr : "";
      expect(text).not.toMatch(/[0-9]|USD|\$|دولار|undefined|NaN/i);
    }
    expect((daily as any).reasonAr).toContain("لم يُخصم أي رصيد");
  });
  it("unknown provider balance or cap is not a block (only known limits are enforced)", () => {
    expect(evaluateStartGate({ ...base, providerBalanceUsd: null, providerDailyCapUsd: null })).toEqual({ decision: "allow" });
  });
  it("estimates the provider cost from volume and cost per record", () => {
    expect(estimatedProviderCostUsd(37_500, 0.0000213)).toBeCloseTo(0.79875, 6);
    expect(estimatedProviderCostUsd(-5, 1)).toBe(0);
  });
});

describe("proposal 4f: custom offers", () => {
  const offer: CustomOffer = { id: customOfferId("req_00000001"), userId: "u1", unitMicro: 1_000, maxVolume: 50_000, maxReservePoints: 6_000, expiresAt: "2026-12-31T00:00:00Z", status: "open" };
  const now = new Date("2026-10-20T00:00:00Z");
  it("applies to its customer, inside its limits, with the ordinary 15% reserve buffer", () => {
    expect(applyCustomOffer(offer, { userId: "u1", volume: 40_000, now })).toEqual({ ok: true, unitMicro: 1_000, reservePoints: reservePoints(40_000, 1_000) });
  });
  it.each([
    ["another customer", { userId: "u2", volume: 10, now }],
    ["too much volume", { userId: "u1", volume: 50_001, now }],
    ["zero volume", { userId: "u1", volume: 0, now }],
    ["an expired offer", { userId: "u1", volume: 10, now: new Date("2027-01-01T00:00:00Z") }],
    ["a reserve above the offer's limit", { userId: "u1", volume: 50_000, now, offer: { maxReservePoints: 5_000 } }],
  ])("refuses %s", (_name, input) => {
    const { offer: override, ...rest } = input as any;
    expect(applyCustomOffer({ ...offer, ...(override ?? {}) }, rest)).toMatchObject({ ok: false });
  });
  it("refuses a used or cancelled offer", () => {
    for (const status of ["used", "cancelled", "expired"] as const) expect(applyCustomOffer({ ...offer, status }, { userId: "u1", volume: 10, now })).toMatchObject({ ok: false });
  });
  it("the charge is ceil(delivered x unit) and never above the offer's reserve", () => {
    const volume = 40_000;
    const check = applyCustomOffer(offer, { userId: "u1", volume, now });
    expect(check.ok && offerCharge(volume, offer) <= check.reservePoints).toBe(true);
    expect(offerCharge(0, offer)).toBe(0);
  });
});
