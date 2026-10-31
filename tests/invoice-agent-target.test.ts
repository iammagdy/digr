import { describe, expect, it } from "vitest";
import { CLEAN_TOLERANCE, PAIR_STEPS, SINGLE_STEPS, solveFinest, solveTargetTotal, targetMinorOf, type TargetLine } from "../src/lib/invoices/chat/targetTotal";
import { computeTotals } from "../src/lib/invoices/totals";
import type { Currency, PricingInput } from "../src/lib/invoices/types";

const P = (over: Partial<PricingInput> = {}): PricingInput => ({ rateE4: 560000, creditValueE4: 1000, discountKind: "none", discountValue: 0, taxEnabled: false, taxLabel: "ضريبة", taxBp: 0, ...over });
const totalOf = (lines: TargetLine[], units: number[], p: PricingInput, cur: Currency) => {
  const t = computeTotals(lines.map((l, i) => ({ quantity: l.quantity, unitCc: units[i] })), p).total;
  return cur === "usd" ? t.usd : cur === "points" ? (t.points as number) : (t.egp as number);
};
// the owner's job: 200 companies, 312 managers, 287 e-mails, 140 phones at 12c / 35c / 0.45c / 5c
const JOB: TargetLine[] = [{ quantity: 200, unitCc: 1200 }, { quantity: 312, unitCc: 3500 }, { quantity: 287, unitCc: 45 }, { quantity: 140, unitCc: 500 }];

describe("target total: code scales the prices to the exact total", () => {
  it("«خلي الإجمالي ١٧ دولار»: exactly 1700 cents, every priced line moved by the same factor", () => {
    const r = solveTargetTotal(JOB, P(), "usd", 1700);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.achievedMinor).toBe(1700);
    expect(r.exact).toBe(true);
    expect(totalOf(JOB, r.units, P(), "usd")).toBe(1700);
    // the factor is common: prices keep their order and stay close to each other's ratios
    expect(r.units[1] / r.units[0]).toBeGreaterThan(2.7);
    expect(r.units[1] / r.units[0]).toBeLessThan(3.1);
    expect(r.units.every((u) => u >= 1)).toBe(true);
  });

  it("the before-total is the real total (200x12c + 312x35c + 287x0.45c + 140x5c = 14,880.15 cents rounded per line)", () => {
    const r = solveTargetTotal(JOB, P(), "usd", 1700);
    expect(r.ok && r.beforeMinor).toBe(2400 + 10920 + 129 + 700); // 287 x 0.45c = 129.15 -> 129
  });

  it("raising works too: ×10 (a target above the current total)", () => {
    const before = totalOf(JOB, JOB.map((l) => l.unitCc), P(), "usd");
    const r = solveTargetTotal(JOB, P(), "usd", before * 10);
    expect(r.ok && r.achievedMinor).toBe(before * 10);
  });

  it("points and EGP: the total is the real total of the new prices and within a few points of the target; \"exact\" says whether it hit it (each line is rounded to whole cents FIRST, so the lattice is 5.6 points / 56 qirsh wide)", () => {
    const a = solveTargetTotal(JOB, P(), "points", 50_000);
    expect(a.ok).toBe(true);
    if (a.ok) { expect(totalOf(JOB, a.units, P(), "points")).toBe(a.achievedMinor); expect(Math.abs(a.achievedMinor - 50_000)).toBeLessThanOrEqual(6); expect(a.exact).toBe(a.achievedMinor === 50_000); }
    const b = solveTargetTotal(JOB, P(), "egp", 123_456);
    expect(b.ok).toBe(true);
    if (b.ok) { expect(totalOf(JOB, b.units, P(), "egp")).toBe(b.achievedMinor); expect(Math.abs(b.achievedMinor - 123_456)).toBeLessThanOrEqual(60); expect(b.exact).toBe(b.achievedMinor === 123_456); }
  });

  it("CLEAN prices for a points / EGP target: whole points per item when they land within 0.1% (the owner's job at 2,000 EGP), otherwise the finest grid, said so", () => {
    const egp = solveTargetTotal(JOB, P(), "egp", 200_000);
    expect(egp.ok).toBe(true);
    if (!egp.ok) return;
    expect(egp.clean).toBe(true);
    expect(egp.points.filter((x) => x !== null).every((x) => Number.isInteger(x))).toBe(true);
    expect(Math.abs(egp.achievedMinor - 200_000)).toBeLessThanOrEqual(200_000 * CLEAN_TOLERANCE);
    // the chosen prices really give that total (the unit price is the points price converted once)
    expect(totalOf(JOB, egp.units, P(), "egp")).toBe(egp.achievedMinor);
    // dollars are never on the points grid
    const usd = solveTargetTotal(JOB, P(), "usd", 1700);
    expect(usd.ok && usd.clean).toBe(false);
    expect(usd.ok && usd.points.every((x) => x === null)).toBe(true);
    // a line cheaper than 2 points (a quarter-point e-mail) stays on the finest grid
    const cheap = solveTargetTotal([{ quantity: 1000, unitCc: 1 }, { quantity: 100, unitCc: 1200 }], P(), "points", 9000);
    expect(cheap.ok && cheap.points[0]).toBeNull();
  });

  it("SHARED prices come first: when one whole-points price per item type reaches the target, every line of a type has the same price", () => {
    // 200 + 149 companies at 10 points and 601 + 240 managers at 20 points, at R = 50.75 and 1 point = 0.10 EGP
    const lines: TargetLine[] = [{ quantity: 200, unitCc: 0, group: "شركة" }, { quantity: 601, unitCc: 0, group: "مدير" }, { quantity: 149, unitCc: 0, group: "شركة" }, { quantity: 240, unitCc: 0, group: "مدير" }].map((l) => ({ ...l, unitCc: l.group === "شركة" ? 1200 : 3500 }));
    const p = P({ rateE4: 500000 });
    const priced = (pc: number, pm: number) => lines.map((l) => ({ quantity: l.quantity, unitCc: (l.group === "شركة" ? pc : pm) * 20 })); // R = 50: one point = 20 hundredths of a cent
    const target = computeTotals(priced(10, 20), p).total.points as number;
    const r = solveTargetTotal(lines, p, "points", target);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exact).toBe(true);
    expect(r.clean).toBe(true);
    expect(r.shared).toBe(true);
    expect(r.points[0]).toBe(r.points[2]);   // every company has the same price
    expect(r.points[1]).toBe(r.points[3]);   // every manager has the same price
    expect(r.units[0]).toBe(r.units[2]);
  });

  it("a target that is tiny next to the quantities (prices of a few hundredths of a cent) may not be reachable exactly: the nearest total is reported, not exact", () => {
    const r = solveTargetTotal(JOB, P(), "points", 5000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(r.achievedMinor - 5000)).toBeLessThanOrEqual(12);
    expect(r.exact).toBe(r.achievedMinor === 5000);
  });

  it("with a 10% discount and 14% tax the GRAND total (after both) is what is hit", () => {
    const p = P({ discountKind: "percent", discountValue: 1000, taxEnabled: true, taxBp: 1400 });
    const r = solveTargetTotal(JOB, p, "usd", 2000);
    expect(r.ok && totalOf(JOB, r.units, p, "usd")).toBe(r.ok ? r.achievedMinor : -1);
    expect(r.ok && Math.abs(r.achievedMinor - 2000)).toBeLessThanOrEqual(1);
  });

  it("deterministic: the same input gives the same prices, twice", () => {
    const a = solveTargetTotal(JOB, P(), "usd", 1700), b = solveTargetTotal(JOB, P(), "usd", 1700);
    expect(a).toEqual(b);
  });

  it("zero-price and zero-quantity lines are never touched; hidden lines are scaled like the rest", () => {
    const lines: TargetLine[] = [{ quantity: 100, unitCc: 1000 }, { quantity: 50, unitCc: 0 }, { quantity: 0, unitCc: 700 }];
    const r = solveTargetTotal(lines, P(), "usd", 500);
    expect(r.ok && r.units[1]).toBe(0);
    expect(r.ok && r.units[2]).toBe(700);
    expect(r.ok && r.achievedMinor).toBe(500);
  });

  it("when the exact total is impossible the NEAREST achievable total is used and said so (one line of 200 units moves the total by 2 cents a step)", () => {
    const lines: TargetLine[] = [{ quantity: 200, unitCc: 1200 }];
    const r = solveTargetTotal(lines, P(), "usd", 1701); // odd cents: 200 x u / 100 is always even
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exact).toBe(false);
    expect([1700, 1702]).toContain(r.achievedMinor);
    // a tie (1700 vs 1702 for 1701) goes to the LOWER total
    expect(r.achievedMinor).toBe(1700);
    const r2 = solveTargetTotal(lines, P(), "usd", 1703);
    expect(r2.ok && r2.achievedMinor).toBe(1702);
  });

  it("a target below what the smallest prices allow reports the smallest achievable total", () => {
    const lines: TargetLine[] = [{ quantity: 100000, unitCc: 1200 }]; // at 1 hundredth of a cent each: 1000 cents
    const r = solveTargetTotal(lines, P(), "usd", 10);
    expect(r.ok && r.achievedMinor).toBe(1000);
    expect(r.ok && r.exact).toBe(false);
  });

  it("errors in plain Arabic: no priced line, points without a rate", () => {
    expect(solveTargetTotal([{ quantity: 5, unitCc: 0 }], P(), "usd", 100)).toMatchObject({ ok: false });
    const r = solveTargetTotal(JOB, P({ rateE4: null }), "points", 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("سعر الصرف");
  });

  it("the limits hold: no line above $10,000,000 and no unit above the cap, even for an absurd target", () => {
    const lines: TargetLine[] = [{ quantity: 1000, unitCc: 1200 }];
    const r = solveTargetTotal(lines, P(), "usd", 9_000_000_000_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.units[0]).toBeLessThanOrEqual(100_000_000);
    expect(totalOf(lines, r.units, P(), "usd")).toBeLessThanOrEqual(1_000_000_000);
    expect(r.exact).toBe(false);
  });

  it("amount text: cents for dollars and EGP, whole points; bad text is null", () => {
    expect(targetMinorOf("17", "usd")).toBe(1700);
    expect(targetMinorOf("17.5", "usd")).toBe(1750);
    expect(targetMinorOf("٥٠٠٠", "points")).toBe(5000);
    expect(targetMinorOf("17.5", "points")).toBeNull();
    expect(targetMinorOf("17.555", "usd")).toBeNull();
    expect(targetMinorOf("0", "usd")).toBeNull();
  });

  it("property: over 300 random documents the total reported is the real total, it is exact or LOCALLY nearest (no single or paired 1-step move gets closer), and the result is deterministic", () => {
    let seed = 987654;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    let usdCases = 0, usdExact = 0;
    for (let k = 0; k < 300; k++) {
      const n = 1 + rnd(6);
      const lines: TargetLine[] = Array.from({ length: n }, () => ({ quantity: 1 + rnd(900), unitCc: 100 + rnd(9000) }));
      const p = P({ rateE4: 300000 + rnd(500000), discountKind: rnd(3) === 0 ? "percent" : "none", discountValue: rnd(3000) });
      const cur: Currency = (["usd", "points", "egp"] as const)[rnd(3)];
      const beforeTotal = totalOf(lines, lines.map((l) => l.unitCc), p, cur);
      const target = Math.max(50, Math.round(beforeTotal * (0.3 + rnd(300) / 100))); // a realistic request: 0.3x to 3.3x of what the document says now
      const r = solveTargetTotal(lines, p, cur, target);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(totalOf(lines, r.units, p, cur), `case ${k}`).toBe(r.achievedMinor);
      if (cur === "usd") { usdCases++; if (r.exact) usdExact++; }
      if (r.exact) { expect(r.achievedMinor).toBe(target); continue; }
      if (r.clean) {
        // whole points per item were chosen: only because they land within 0.1% of the target or as near as the finest search does
        const finest = solveFinest(lines, p, cur, target);
        expect(finest.ok).toBe(true);
        if (finest.ok) expect(Math.abs(r.achievedMinor - target), `case ${k} clean`).toBeLessThanOrEqual(Math.max(Math.abs(finest.achievedMinor - target), Math.ceil(target * CLEAN_TOLERANCE)));
        expect(r.points.every((x) => x === null || (Number.isInteger(x) && x >= 1))).toBe(true);
        continue;
      }
      // brute force: no single move and no pair of moves of one step (up or down) is strictly nearer (or equally near and lower)
      const err = (g: number) => Math.abs(g - target);
      const cap = (q: number) => Math.min(100_000_000, Number((BigInt(1_000_000_000) * BigInt(100)) / BigInt(q)));
      const priced = r.units.map((u, i) => (lines[i].unitCc > 0 ? i : -1)).filter((i) => i >= 0);
      const tryUnits = (moves: Array<[number, number]>): number | null => {
        const u = r.units.slice();
        for (const [i, d] of moves) { u[i] += d; if (u[i] < 1 || u[i] > cap(lines[i].quantity)) return null; }
        return totalOf(lines, u, p, cur);
      };
      const nearer = (g: number) => err(g) < err(r.achievedMinor) || (err(g) === err(r.achievedMinor) && g < r.achievedMinor);
      for (const i of priced) for (const d of SINGLE_STEPS) { const g = tryUnits([[i, d]]); if (g !== null) expect(nearer(g), `case ${k} single`).toBe(false); }
      for (const i of priced) for (const j of priced) if (j > i) for (const di of PAIR_STEPS) for (const dj of PAIR_STEPS) { const g = tryUnits([[i, di], [j, dj]]); if (g !== null) expect(nearer(g), `case ${k} pair`).toBe(false); }
      expect(solveTargetTotal(lines, p, cur, target)).toEqual(r);
    }
    expect(usdExact / usdCases).toBeGreaterThan(0.7); // a dollar total is hit exactly in the large majority of realistic requests
  });
});
