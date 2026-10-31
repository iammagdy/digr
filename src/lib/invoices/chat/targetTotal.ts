import { MAX_LINE_CENTS, MAX_UNIT_CC, parseScaled, pointsToUnitCc, roundDiv } from "../money";
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
export interface TargetLine {
  quantity: number;
  unitCc: number;
  /** lines with the same group and the same price share ONE price in the shared mode (every «شركة» costs the same in every sector) */
  group?: string;
}
export type TargetResult =
  | { ok: false; error: string }
  | {
      ok: true;
      /** the new unit price of every line, in hundredths of a US cent */
      units: number[];
      /** on the whole-points grid: the whole points per item chosen for each line (null where the line stayed on the cent grid) */
      points: Array<number | null>;
      /** true when the prices are whole points per item, false when they are on the finest (hundredth of a cent) grid */
      clean: boolean;
      /** true when every line of an item type has the SAME whole-points price (the best case); false when lines of one type may differ by a point or two */
      shared: boolean;
      targetMinor: number; achievedMinor: number; beforeMinor: number; exact: boolean; changedLines: number;
    };

/**
 * «Clean» prices for a points or EGP target: whole POINTS per item (a price the owner can say and remember), found with the same search on a grid of whole points. A whole point
 * moves a line of q units by about q points, so it is used only when it lands as near as the exact search (a hundredth of a cent) or within CLEAN_TOLERANCE of the target
 * (0.1 per cent); otherwise the finest grid is used and the chat says the prices are not round.
 */
export const CLEAN_TOLERANCE = 0.001;
/** the three grids tried for a points / EGP target, the most readable first */
type Mode = "cc" | "points" | "shared";

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
  if (currency === "usd" || pricing.rateE4 === null) return solveOnGrid(lines, pricing, currency, targetMinor, "cc");
  const exact = solveOnGrid(lines, pricing, currency, targetMinor, "cc");
  if (!exact.ok) return exact;
  const near = Math.max(Math.abs(exact.achievedMinor - targetMinor), Math.ceil(targetMinor * CLEAN_TOLERANCE));
  for (const mode of ["shared", "points"] as const) {
    const r = solveOnGrid(lines, pricing, currency, targetMinor, mode);
    if (r.ok && r.clean && Math.abs(r.achievedMinor - targetMinor) <= near) return r;
  }
  return exact;
}

/** the finest grid only (a hundredth of a cent): the reference the clean result is judged against */
export const solveFinest = (lines: TargetLine[], pricing: PricingInput, currency: Currency, targetMinor: number): TargetResult => solveOnGrid(lines, pricing, currency, targetMinor, "cc");

/** one price VARIABLE: a line alone, or (shared mode) all the lines of one item type with the same price */
interface Variable { lines: number[]; onPoints: boolean; base: number; cap: number }

function solveOnGrid(lines: TargetLine[], pricing: PricingInput, currency: Currency, targetMinor: number, mode: Mode): TargetResult {
  if ((currency === "points" || currency === "egp") && pricing.rateE4 === null) return { ok: false, error: "اكتب سعر الصرف أولًا حتى أحسب الإجمالي بالنقاط أو الجنيه." };
  const idx = lines.map((l, i) => (l.quantity > 0 && l.unitCc > 0 ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return { ok: false, error: "كل الأسعار صفر. اكتب سعرًا للبنود أولًا ثم اطلب الإجمالي." };

  const base = lines.map((l) => l.unitCc);
  const rate = pricing.rateE4, credit = pricing.creditValueE4;
  const ccCap = lines.map((l) => unitCap(l.quantity));
  const ccOf = (onPoints: boolean, g: number): number => (onPoints ? pointsToUnitCc(g * 100, rate as number, credit) : g);
  // a price is on the whole-points grid when it is at least 2 points; a cheaper one (a quarter-point e-mail) stays on the cent grid
  const pointsOk = (i: number) => mode !== "cc" && rate !== null && B(base[i]) * B(rate) >= B(2) * B(10_000) * B(credit);
  const capOf = (i: number, onPoints: boolean): number => {
    if (!onPoints) return ccCap[i];
    let g = Number((B(ccCap[i]) * B(rate as number)) / (B(10_000) * B(credit))); // whole points whose price is at most the cap: cc x rate / (10,000 x point value)
    while (g > 1 && ccOf(true, g) > ccCap[i]) g -= 1;
    return Math.max(1, g);
  };

  // the price variables
  const vars: Variable[] = [];
  const varOf: number[] = lines.map(() => -1);
  const byKey = new Map<string, number>();
  for (const i of idx) {
    const key = mode === "shared" && lines[i].group ? `g:${lines[i].group}|${base[i]}` : `l:${i}`;
    let v = byKey.get(key);
    if (v === undefined) { v = vars.length; byKey.set(key, v); vars.push({ lines: [], onPoints: pointsOk(i), base: base[i], cap: capOf(i, pointsOk(i)) }); }
    vars[v].lines.push(i); varOf[i] = v;
    vars[v].cap = Math.min(vars[v].cap, capOf(i, vars[v].onPoints));
  }
  const lineCc = (i: number, units: number[]): number => (varOf[i] < 0 ? base[i] : ccOf(vars[varOf[i]].onPoints, units[varOf[i]]));
  const totalOf = (units: number[]): number => pick(computeTotals(lines.map((l, i) => ({ quantity: l.quantity, unitCc: lineCc(i, units) })), pricing).total, currency);
  const beforeMinor = pick(computeTotals(lines.map((l, i) => ({ quantity: l.quantity, unitCc: base[i] })), pricing).total, currency);
  const result = (units: number[], achievedMinor: number): TargetResult => {
    const cc = lines.map((_, i) => lineCc(i, units));
    const anyPoints = vars.some((v) => v.onPoints);
    return {
      ok: true, units: cc, points: lines.map((_, i) => (varOf[i] >= 0 && vars[varOf[i]].onPoints ? units[varOf[i]] : null)), clean: anyPoints,
      shared: mode === "shared" && anyPoints, targetMinor, achievedMinor, beforeMinor, exact: achievedMinor === targetMinor, changedLines: cc.filter((u, i) => u !== base[i]).length,
    };
  };

  // 1. the common factor, per variable
  const unitsOf = (s: bigint): number[] => vars.map((v) => {
    const g = v.onPoints ? roundDiv(B(v.base) * s * B(rate as number), ONE_E9 * B(10_000) * B(credit)) : roundDiv(B(v.base) * s, ONE_E9);
    return Math.min(v.cap, Math.max(1, Number(g)));
  });
  let lo = B(1), hi = ONE_E9;
  let units = unitsOf(lo);
  if (totalOf(units) > targetMinor) return result(units, totalOf(units)); // even the smallest possible prices overshoot: that is the nearest achievable total
  let guard = 0;
  while (totalOf(unitsOf(hi)) <= targetMinor && guard++ < 70) {
    lo = hi; hi = hi * B(2);
    if (unitsOf(hi).every((g, v) => g === vars[v].cap)) break;
  }
  if (totalOf(unitsOf(hi)) <= targetMinor) { units = unitsOf(hi); return result(units, totalOf(units)); } // the cap is reached: the biggest total there is
  while (hi - lo > B(1)) { const mid = (lo + hi) / B(2); if (totalOf(unitsOf(mid)) <= targetMinor) lo = mid; else hi = mid; }
  units = unitsOf(lo);

  // 2. the remainder, one grid step at a time, round-robin over the variables
  let per = lines.map((l, i) => lineMoney(l.quantity, lineCc(i, units), pricing.rateE4, pricing.creditValueE4));
  let subtotal = per.reduce<Money>((s, m) => addMoney(s, m), { usd: 0, points: pricing.rateE4 === null ? null : 0, egp: pricing.rateE4 === null ? null : 0 });
  const grand = (sub: Money): number => pick(finishTotals(per, sub, pricing).total, currency);
  /** the subtotal and the new money of the touched lines if variable v moved to g (and the others stayed) */
  const move = (sub: Money, v: number, g: number): { sub: Money; ms: Array<[number, Money]> } => {
    const ms: Array<[number, Money]> = [];
    let out = sub;
    for (const l of vars[v].lines) { const m = lineMoney(lines[l].quantity, ccOf(vars[v].onPoints, g), pricing.rateE4, pricing.creditValueE4); ms.push([l, m]); out = addMoney(subMoney(out, per[l]), m); }
    return { sub: out, ms };
  };
  let current = grand(subtotal);
  let evals = 0;
  const all = vars.map((_, v) => v);
  for (let pass = 0; pass < 5000 && current < targetMinor && evals < 60_000; pass++) {
    let moved = false;
    for (const v of all) {
      if (current >= targetMinor) break;
      if (units[v] >= vars[v].cap) continue;
      evals++;
      const t = move(subtotal, v, units[v] + 1);
      const g = grand(t.sub);
      if (g > current && g <= targetMinor) { units[v] += 1; per = per.map((m, k) => t.ms.find(([l]) => l === k)?.[1] ?? m); subtotal = t.sub; current = g; moved = true; }
    }
    if (!moved) break;
  }

  // 3. REFINE (see the rule above); ties go to the lower total
  const err = (g: number) => Math.abs(g - targetMinor);
  const better = (g: number, than: number) => err(g) < err(than) || (err(g) === err(than) && g < than);
  const usable = (v: number, d: number) => units[v] + d >= 1 && units[v] + d <= vars[v].cap;
  const pairs = all.length <= PAIRS_UP_TO_LINES;
  while (current !== targetMinor && evals < 60_000) {
    let best: { g: number; moves: Array<[number, number]> } | null = null;
    const consider = (g: number, moves: Array<[number, number]>) => { if (better(g, best ? best.g : current)) best = { g, moves }; };
    const trial = (moves: Array<[number, number]>): number => {
      evals++;
      let sub = subtotal;
      for (const [v, d] of moves) sub = move(sub, v, units[v] + d).sub;
      return grand(sub);
    };
    for (const v of all) for (const d of SINGLE_STEPS) if (usable(v, d)) consider(trial([[v, d]]), [[v, d]]);
    if (pairs) {
      for (let a1 = 0; a1 < all.length; a1++) for (let b1 = a1 + 1; b1 < all.length; b1++) {
        for (const di of PAIR_STEPS) for (const dj of PAIR_STEPS) if (usable(a1, di) && usable(b1, dj)) consider(trial([[a1, di], [b1, dj]]), [[a1, di], [b1, dj]]);
      }
    }
    if (!best) break;
    const chosen = best as { g: number; moves: Array<[number, number]> };
    for (const [v, d] of chosen.moves) {
      const t = move(subtotal, v, units[v] + d);
      subtotal = t.sub; units[v] += d;
      per = per.map((m, k) => t.ms.find(([l]) => l === k)?.[1] ?? m);
    }
    current = grand(subtotal);
  }
  return result(units, current);
}
