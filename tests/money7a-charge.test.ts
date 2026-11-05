import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ADDON_MAX_HOLD_POINTS, ADDON_MIN_POINTS, addonChargePoints, addonId, addonJobId, addonLedgerIds, addonProviderBudgetUsd, addonQuoteId, reviewHoldPoints } from "../src/lib/agentMission/addonSettlement";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { editQuote, reviewQuote } from "../src/lib/agentMission/stage4/quotes";
import { DEFAULT_MISSION_PRICING_SETTINGS, pointsPerCostUsd } from "../src/lib/missionPricing";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * MONEY PR 7a, PHASE 2A (docs/MONEY-PR-7A.md sections 2 and 3.0): THE CHARGE OF AN ADD-ON IS COMPUTED BY CODE, in whole points, and never passes the hold. The formula:
 *   filled = 0  ->  0 (the whole hold comes back)
 *   charge = min(hold, max(ceil(real cost x points per USD), ceil(100 x filled / requested)))
 * The prices the screens show (quotes.ts) are display only and are NOT imported by the money file; these tests pin the two equal, so a screen's rounding can never change a charge.
 */
const SETTINGS = { ...DEFAULT_MISSION_PRICING_SETTINGS, minChargePoints: 100 };
const PPU = pointsPerCostUsd(SETTINGS);
const full = (realCostUsd: number, n = 10, holdPoints = Number.POSITIVE_INFINITY) => addonChargePoints({ realCostUsd, filled: n, requested: n, holdPoints });

describe("addonChargePoints: the formula", () => {
  it("points per USD is 5,500 with the markup of 10", () => { expect(PPU).toBe(5500); });
  it("nothing filled is no charge, whatever was spent and whatever the hold", () => {
    expect(addonChargePoints({ realCostUsd: 0, filled: 0, requested: 10, holdPoints: 500 })).toBe(0);
    expect(addonChargePoints({ realCostUsd: 0.7, filled: 0, requested: 10, holdPoints: 500 })).toBe(0);
    expect(addonChargePoints({ realCostUsd: 3, filled: 0, requested: 1, holdPoints: Number.POSITIVE_INFINITY })).toBe(0);
  });
  it("a full fill with no provider cost (a rename, cells the customer typed) pays the 100-point minimum: no free path", () => {
    expect(full(0)).toBe(ADDON_MIN_POINTS);
    expect(full(0, 1)).toBe(100);
    expect(full(0, 5000)).toBe(100);
  });
  it("the real cost times 5,500, rounded up, when it is above the minimum", () => {
    expect(full(0.05)).toBe(275);
    expect(full(0.050001)).toBe(276); // 275.0055 rounds up
    expect(full(0.018181)).toBe(100); // 99.9955 rounds up to the minimum
    expect(full(0.0181819)).toBe(101); // 100.00045 rounds up
  });
  it("the minimum is paid in proportion to what was filled: ceil(100 x filled / requested)", () => {
    const part = (filled: number, requested: number, hold = 1000) => addonChargePoints({ realCostUsd: 0, filled, requested, holdPoints: hold });
    expect(part(3, 10)).toBe(30);
    expect(part(1, 3)).toBe(34);
    expect(part(1, 10_000)).toBe(1);
    expect(part(9_999, 10_000)).toBe(100);
    expect(part(10, 10)).toBe(100);
    // the real cost wins when it is larger than the share of the minimum
    expect(addonChargePoints({ realCostUsd: 0.02, filled: 3, requested: 10, holdPoints: 1000 })).toBe(110);
  });
  it("never above the hold: the minimum share and the real cost are both clipped", () => {
    expect(addonChargePoints({ realCostUsd: 0, filled: 10, requested: 10, holdPoints: 60 })).toBe(60);
    expect(addonChargePoints({ realCostUsd: 1, filled: 10, requested: 10, holdPoints: 400 })).toBe(400);
    expect(addonChargePoints({ realCostUsd: 0.05, filled: 10, requested: 10, holdPoints: 275 })).toBe(275);
    expect(addonChargePoints({ realCostUsd: 0.05, filled: 10, requested: 10, holdPoints: 274 })).toBe(274);
  });
  it("filled above requested is read as requested (never a bigger share than the whole)", () => {
    expect(addonChargePoints({ realCostUsd: 0, filled: 99, requested: 10, holdPoints: 1000 })).toBe(100);
  });
  it("refuses numbers that are not numbers (it throws; nothing is charged on a guess)", () => {
    expect(() => addonChargePoints({ realCostUsd: -1, filled: 1, requested: 1, holdPoints: 100 })).toThrow();
    expect(() => addonChargePoints({ realCostUsd: Number.NaN, filled: 1, requested: 1, holdPoints: 100 })).toThrow();
    expect(() => addonChargePoints({ realCostUsd: Number.POSITIVE_INFINITY, filled: 1, requested: 1, holdPoints: 100 })).toThrow();
    expect(() => addonChargePoints({ realCostUsd: 0, filled: 1, requested: 0, holdPoints: 100 })).toThrow();
    expect(() => addonChargePoints({ realCostUsd: 0, filled: 1, requested: 1, holdPoints: Number.NaN })).toThrow();
  });
});

/** A small seeded generator: the same cases every run. */
function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

describe("addonChargePoints: properties over thousands of cases", () => {
  it("never above the hold; zero when nothing is filled; a whole number; at least the proportional minimum unless the hold is smaller", () => {
    const rnd = lcg(7);
    for (let i = 0; i < 20_000; i++) {
      const requested = 1 + Math.floor(rnd() * 5000);
      const filled = rnd() < 0.15 ? 0 : Math.floor(rnd() * (requested + 1));
      const realCostUsd = rnd() < 0.2 ? 0 : Math.round(rnd() * 3_000_000) / 1_000_000;
      const holdPoints = 1 + Math.floor(rnd() * 5000);
      const c = addonChargePoints({ realCostUsd, filled, requested, holdPoints });
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeLessThanOrEqual(holdPoints);
      expect(c).toBeGreaterThanOrEqual(0);
      if (filled === 0) expect(c).toBe(0);
      else expect(c).toBeGreaterThanOrEqual(Math.min(holdPoints, Math.ceil((100 * filled) / requested)));
    }
  });
  it("monotone: more real cost never lowers the charge; more filled never lowers it", () => {
    const rnd = lcg(11);
    for (let i = 0; i < 3000; i++) {
      const requested = 1 + Math.floor(rnd() * 200);
      const a = Math.round(rnd() * 500_000) / 1_000_000, b = a + Math.round(rnd() * 500_000) / 1_000_000;
      const hold = 5000;
      expect(addonChargePoints({ realCostUsd: b, filled: requested, requested, holdPoints: hold })).toBeGreaterThanOrEqual(addonChargePoints({ realCostUsd: a, filled: requested, requested, holdPoints: hold }));
      const f1 = Math.floor(rnd() * requested), f2 = f1 + Math.floor(rnd() * (requested - f1 + 1));
      expect(addonChargePoints({ realCostUsd: a, filled: f2, requested, holdPoints: hold })).toBeGreaterThanOrEqual(addonChargePoints({ realCostUsd: a, filled: f1, requested, holdPoints: hold }));
    }
  });
  it("a provider that charges DOUBLE (or far more than) its estimate still gives a charge at most the hold", () => {
    for (const rows of [1, 10, 100, 1000]) {
      for (const perRow of [0.0001, 0.001, 0.01]) {
        const price = priceMissionByCode([{ rows, costPerRowUsd: perRow, deliver: true, codeOnly: true }], { settings: SETTINGS });
        const hold = price.reservePoints;
        const estimate = rows * perRow;
        for (const factor of [1, 2, 10, 1000]) {
          const c = addonChargePoints({ realCostUsd: estimate * factor, filled: rows, requested: rows, holdPoints: hold });
          expect(c).toBeLessThanOrEqual(hold);
          if (factor >= 2 && estimate * factor * PPU >= hold) expect(c).toBe(hold);
        }
      }
    }
  });
});

describe("the price SHOWN equals the charge (quotes.ts is display only, the charge is its own function)", () => {
  const GRID = [0, 0.000001, 0.00001, 0.0001, 0.001, 0.01, 0.018, 0.0181, 0.018181, 0.0181819, 0.01819, 0.02, 0.05, 0.0999999, 0.1, 0.123456, 0.25, 0.5, 0.789, 0.79, 0.8, 1, 1.5, 2, 3.14159, 7.5];
  it("editQuote(c) equals the charge of a full fill with an unlimited hold, over a grid of costs", () => {
    for (const c of GRID) { expect(full(c, 7)).toBe(editQuote(c, SETTINGS)); expect(full(c, 1)).toBe(editQuote(c, SETTINGS)); }
  });
  it("and over many random micro-dollar costs", () => {
    const rnd = lcg(3);
    for (let i = 0; i < 5000; i++) { const c = Math.round(rnd() * 2_000_000) / 1_000_000; expect(full(c, 1 + (i % 40))).toBe(editQuote(c, SETTINGS)); }
  });
  it("the review's hold equals reviewQuote over a grid of cell counts", () => {
    for (const cells of [0, 1, 99, 100, 101, 5000, 9999, 10_000, 10_001, 12_345, 499_999, 500_000]) expect(reviewHoldPoints(cells)).toBe(reviewQuote(cells));
  });
});

describe("the provider budget of an add-on is hold / points per USD, so its real cost times the markup cannot pass the hold", () => {
  it("5,000 points of hold is under a dollar of provider budget; the budget times 5,500, rounded up, is at most the hold", () => {
    const rnd = lcg(5);
    for (let i = 0; i < 3000; i++) {
      const hold = 100 + Math.floor(rnd() * 4901);
      const budget = addonProviderBudgetUsd(hold, SETTINGS);
      expect(budget).toBeLessThan(1);
      expect(full(budget, 1, Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(Math.max(hold, ADDON_MIN_POINTS));
      expect(Math.ceil(Math.round(budget * 1_000_000) * PPU / 1_000_000)).toBeLessThanOrEqual(hold);
    }
    expect(addonProviderBudgetUsd(5000, SETTINGS)).toBeCloseTo(0.909090, 5);
    expect(ADDON_MAX_HOLD_POINTS).toBe(5000);
  });
});

describe("deterministic ids", () => {
  it("the add-on id is msn_ plus 20 hex of sha256(mission|vN|ak): the same inputs give the same id, any change gives another", () => {
    const id = addonId("msn_5851abc92a1e6645a9cd", 1, 1);
    expect(id).toBe(`msn_${createHash("sha256").update("msn_5851abc92a1e6645a9cd|v1|a1").digest("hex").slice(0, 20)}`);
    expect(id).toMatch(/^msn_[0-9a-f]{20}$/);
    expect(addonId("msn_5851abc92a1e6645a9cd", 1, 1)).toBe(id);
    const all = new Set([id, addonId("msn_5851abc92a1e6645a9cd", 1, 2), addonId("msn_5851abc92a1e6645a9cd", 2, 1), addonId("msn_b060d3347ed7660f972e", 1, 1)]);
    expect(all.size).toBe(4);
  });
  it("refuses a base version or an attempt that is not a whole number of 1 or more, and an empty mission id", () => {
    expect(() => addonId("msn_a", 0, 1)).toThrow();
    expect(() => addonId("msn_a", 1, 0)).toThrow();
    expect(() => addonId("msn_a", 1.5, 1)).toThrow();
    expect(() => addonId("", 1, 1)).toThrow();
  });
  it("the quote id is quote_addon_<add-on id>, the job id is the database's job_quote_<md5 of the quote id>, and the ledger ids follow the job", async () => {
    const aid = addonId("msn_a", 1, 1);
    expect(addonQuoteId(aid)).toBe(`quote_addon_${aid}`);
    const jobId = addonJobId(addonQuoteId(aid));
    expect(jobId).toBe(`job_quote_${createHash("md5").update(`quote_addon_${aid}`).digest("hex")}`);
    expect(addonLedgerIds(jobId)).toEqual({ reserve: `res_${jobId}`, release: `rel_${jobId}`, charge: `chg_${jobId}` });
    // the fake (which matches the live SQL) makes the very same job id
    const m = fakeMoneyClient({ balance: 1000 });
    const items = [{ capabilitySlug: "agent-edit", endpointId: "agent-edit", missionId: "msn_a", addonId: aid, unitPricePoints: 1, targetVolumeMin: 1, targetVolumeMax: 100 }];
    const hash = createHash("sha256").update(JSON.stringify({ items, formats: ["xlsx", "csv"] })).digest("hex");
    const USER = "11111111-1111-4111-8111-111111111111";
    await m.client.rpc("create_quote_atomic", { p_user_id: USER, p_quote_id: addonQuoteId(aid), p_quote_hash: hash, p_items: items, p_total_points: 100, p_output_formats: ["xlsx", "csv"], p_expires_at: new Date(Date.now() + 60_000).toISOString(), p_previous_quote_ids: [] });
    const accepted = await m.client.rpc("accept_quote_atomic", { p_quote_id: addonQuoteId(aid), p_user_id: USER, p_expected_quote_hash: hash });
    expect((accepted as any).data.job_id).toBe(jobId);
  });
});
