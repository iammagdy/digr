import { MAX_LINE_CENTS, MAX_UNIT_CC, parseScaled, roundDiv } from "../money";
import type { Currency, Money, PricingInput } from "../types";
import { addMoney, computeTotals, finishTotals, lineMoney, subMoney } from "../totals";

/**
 * «خلي الإجمالي ١٧ دولار»: the owner names a grand total; CODE finds the unit prices that give exactly that total with the existing money library.
 * The model only supplies the number and the currency.
 *
 * THE RULE (deterministic, no randomness, same input = same output):
 *  1. Every line that has a quantity and a price is SCALED by one common factor s / 10^9 (BigInt, each unit price rounded half up, at least one hundredth of a cent,
 *     never above the limits). Lines with a price of 0 or a quantity of 0 are never touched. The largest s whose grand total is not above the target is found by
 *     binary search (the grand total never goes down when prices go up).
 *  2. REMAINDER: the difference to the target is spread by raising unit prices by ONE hundredth of a cent, one line at a time, in document order, round-robin
 *     (line 1, line 2, … then again), accepting a step only if the grand total stays at or below the target. It stops when the target is hit or no line can move.
 *  3. REFINE: single steps (1 to 12 hundredths of a cent, up or down) and paired steps (two lines, 1 to 3 each, up to 40 lines) that bring the total strictly nearer to the target,
 *     until none does. Ties between two equally near totals go to the LOWER one. If the target is still not hit (one hundredth of a cent on a line of q units moves the
 *     total by q/100 cents and every line is rounded on its own), the result is the nearest total this search reaches and the chat says it was NOT exact.
Points and EGP: every line is rounded to whole US CENTS first (the money rule of this feature) and only then converted, so at a rate of 56 one cent is 5.6
 * points or 56 qirsh: a points or EGP total can only land on that lattice and an exact hit is the exception, a dollar total the rule. The chat says so.
 * The target is the document's GRAND total (after discount and tax) in the chosen currency: whole points, or cents / qirsh.
 */
export interface TargetLine { quantity: number; unitCc: number }
export type TargetResult =
  | { ok: false; error: string }
  | { ok: true; units: number[]; targetMinor: number; achievedMinor: number; beforeMinor: number; exact: boolean; changedLines: number };

/** the refinement's moves, in hundredths of a cent: a single line by 1..12 steps up or down, two lines together by 1..3 steps each */
export const SINGLE_STEPS: readonly number[] = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9, -9, 10, -10, 11, -11, 12, -12];
export const PAIR_STEPS: readonly number[] = [1, -1, 2, -2, 3, -3];
export const PAIRS_UP_TO_LINES = 40;
const B = (n: number) => BigInt(n);
const ONE_E9 = B(1_000_000_000);
const pick = (m: Money, cur: Currency): number => (cur === "usd" ? m.usd : cur === "points" ? m.points ?? 0 : m.egp ?? 0);

/** the biggest unit price a line may have: the unit limit and «a line is at most $10,000,000» */
const unitCap = (quantity: number): number => (quantity <= 0 ? MAX_UNIT_CC : Math.min(MAX_UNIT_CC, Number((B(MAX_LINE_CENTS) * B(100)) / B(quantity))));

export function targetMinorOf(amountText: string, currency: Currency): number | null {
  const v = parseScaled(amountText, currency === "points" ? 0 : 2);
  return v === null || v <= 0 ? null : v;
}

export function solveTargetTotal(lines: TargetLine[], pricing: PricingInput, currency: Currency, targetMinor: number): TargetResult {
  if ((currency === "points" || currency === "egp") && pricing.rateE4 === null) return { ok: false, error: "اكتب سعر الصرف أولًا حتى أحسب الإجمالي بالنقاط أو الجنيه." };
  const idx = lines.map((l, i) => (l.quantity > 0 && l.unitCc > 0 ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return { ok: false, error: "كل الأسعار صفر. اكتب سعرًا للبنود أولًا ثم اطلب الإجمالي." };

  const base = lines.map((l) => l.unitCc);
  const caps = lines.map((l) => unitCap(l.quantity));
  const totalOf = (units: number[]): number => pick(computeTotals(lines.map((l, i) => ({ quantity: l.quantity, unitCc: units[i] })), pricing).total, currency);
  const beforeMinor = totalOf(base);

  // 1. the common factor
  const unitsOf = (s: bigint) => { const out = base.slice(); for (const i of idx) out[i] = Math.min(caps[i], Math.max(1, Number(roundDiv(B(base[i]) * s, ONE_E9)))); return out; };
  let lo = B(1), hi = ONE_E9;
  let units = unitsOf(lo);
  if (totalOf(units) > targetMinor) {
    // even the smallest possible prices overshoot: that is the nearest achievable total
    const only = totalOf(units);
    return { ok: true, units, targetMinor, achievedMinor: only, beforeMinor, exact: only === targetMinor, changedLines: units.filter((u, i) => u !== base[i]).length };
  }
  let guard = 0;
  while (totalOf(unitsOf(hi)) <= targetMinor && guard++ < 70) {
    lo = hi; hi = hi * B(2);
    const atCap = idx.every((i) => unitsOf(hi)[i] === caps[i]);
    if (atCap) break;
  }
  if (totalOf(unitsOf(hi)) <= targetMinor) { // the cap is reached: the biggest total there is
    units = unitsOf(hi);
    const t = totalOf(units);
    return { ok: true, units, targetMinor, achievedMinor: t, beforeMinor, exact: t === targetMinor, changedLines: units.filter((u, i) => u !== base[i]).length };
  }
  while (hi - lo > B(1)) { const mid = (lo + hi) / B(2); if (totalOf(unitsOf(mid)) <= targetMinor) lo = mid; else hi = mid; }
  units = unitsOf(lo);

  // 2. the remainder, one hundredth of a cent at a time, round-robin
  let per = lines.map((l, i) => lineMoney(l.quantity, units[i], pricing.rateE4, pricing.creditValueE4));
  let subtotal = per.reduce<Money>((s, m) => addMoney(s, m), { usd: 0, points: pricing.rateE4 === null ? null : 0, egp: pricing.rateE4 === null ? null : 0 });
  const grand = (sub: Money): number => pick(finishTotals(per, sub, pricing).total, currency);
  const withUnit = (i: number, cc: number) => { const m = lineMoney(lines[i].quantity, cc, pricing.rateE4, pricing.creditValueE4); return { m, sub: addMoney(subMoney(subtotal, per[i]), m) }; };
  let current = grand(subtotal);
  let evals = 0;
  for (let pass = 0; pass < 5000 && current < targetMinor && evals < 400_000; pass++) {
    let moved = false;
    for (const i of idx) {
      if (current >= targetMinor) break;
      if (units[i] >= caps[i]) continue;
      evals++;
      const t = withUnit(i, units[i] + 1);
      const g = grand(t.sub);
      if (g > current && g <= targetMinor) { units[i] += 1; per = per.map((m, k) => (k === i ? t.m : m)); subtotal = t.sub; current = g; moved = true; }
    }
    if (!moved) break;
  }

  // 3. REFINE (see the rule above); ties go to the lower total.
  //    (When the quantities are big next to the target, one step on one line moves the total by many units; two lines moving together can land closer.)
  const err = (g: number) => Math.abs(g - targetMinor);
  const better = (g: number, than: number) => err(g) < err(than) || (err(g) === err(than) && g < than);
  const usable = (i: number, d: number) => units[i] + d >= 1 && units[i] + d <= caps[i];
  const pairs = idx.length <= PAIRS_UP_TO_LINES;
  while (current !== targetMinor && evals < 150_000) {
    let best: { g: number; moves: Array<[number, number]> } | null = null;
    const consider = (g: number, moves: Array<[number, number]>) => { if (better(g, best ? best.g : current)) best = { g, moves }; };
    const trial = (moves: Array<[number, number]>): number => {
      evals++;
      let sub = subtotal;
      for (const [i, d] of moves) sub = addMoney(subMoney(sub, lineMoney(lines[i].quantity, units[i], pricing.rateE4, pricing.creditValueE4)), lineMoney(lines[i].quantity, units[i] + d, pricing.rateE4, pricing.creditValueE4));
      return grand(sub);
    };
    for (const i of idx) for (const d of SINGLE_STEPS) if (usable(i, d)) consider(trial([[i, d]]), [[i, d]]);
    if (pairs) {
      for (let a1 = 0; a1 < idx.length; a1++) for (let b1 = a1 + 1; b1 < idx.length; b1++) {
        const i = idx[a1], j = idx[b1];
        for (const di of PAIR_STEPS) for (const dj of PAIR_STEPS) if (usable(i, di) && usable(j, dj)) consider(trial([[i, di], [j, dj]]), [[i, di], [j, dj]]);
      }
    }
    if (!best) break;
    const chosen = best as { g: number; moves: Array<[number, number]> };
    for (const [i, d] of chosen.moves) {
      subtotal = addMoney(subMoney(subtotal, per[i]), lineMoney(lines[i].quantity, units[i] + d, pricing.rateE4, pricing.creditValueE4));
      units[i] += d;
      per = per.map((m, k) => (k === i ? lineMoney(lines[i].quantity, units[i], pricing.rateE4, pricing.creditValueE4) : m));
    }
    current = grand(subtotal);
  }
  return { ok: true, units, targetMinor, achievedMinor: current, beforeMinor, exact: current === targetMinor, changedLines: units.filter((u, i) => u !== base[i]).length };
}
