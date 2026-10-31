import { toArabicDigits } from "@/lib/arabicDigits";
import { roundDiv } from "./money";
import type { Currency } from "./types";

/**
 * The unit-price column of the sheet. A unit price is stored in hundredths of a US cent; in points it is cc x rate / (10,000 x pointValue), in EGP cc x rate / 10^8, in dollars cc / 10,000.
 * A column shows the FEWEST decimals at which, for EVERY printed line, quantity x the displayed unit is within TOLERANCE of the line's printed total. The tolerance is what the
 * printing itself costs and nothing more: a line is rounded to whole US CENTS once, and only then converted, so half a cent (in points: rate / (200 x point value); in EGP: rate / 20,000
 * qirsh) plus half of the total's last digit (half a point; half a qirsh; for EGP derived from points, half the point value). What the decimals remove is the big mismatch:
 * 250 x 61 points = 15,250 against a printed 15,225 shows 60.9.
 * One count per column (the rows stay aligned), at most 6. Exact BigInt arithmetic, no float.
 */
const B = (n: number): bigint => BigInt(n);
const TEN = B(10);
const pow10 = (d: number): bigint => { let r = B(1); for (let i = 0; i < d; i++) r *= TEN; return r; };

/** the unit price as a fraction of the currency's MAJOR unit (dollar, point, pound) */
function exactUnit(cur: Currency, cc: number, rateE4: number, creditE4: number): { num: bigint; den: bigint } {
  if (cur === "usd") return { num: B(cc), den: B(10_000) };
  if (cur === "points") return { num: B(cc) * B(rateE4), den: B(10_000) * B(creditE4) };
  return { num: B(cc) * B(rateE4), den: B(100_000_000) };
}
/** minor units of the total per major unit: cents per dollar, qirsh per pound, 1 per point */
const SCALE: Record<Currency, bigint> = { usd: B(100), points: B(1), egp: B(100) };
export const BASE_DECIMALS: Record<Currency, number> = { usd: 2, points: 0, egp: 2 };
export const MAX_DECIMALS: Record<Currency, number> = { usd: 4, points: 6, egp: 6 };

export interface UnitLine { quantity: number; unitCc: number; /** the printed line total in the currency's minor unit (cents, points, qirsh) */ totalMinor: number }

/** the unit price as an integer at `decimals` places (rounded half up) */
export function unitAt(cur: Currency, cc: number, rateE4: number, creditE4: number, decimals: number): bigint {
  const { num, den } = exactUnit(cur, cc, rateE4, creditE4);
  return roundDiv(num * pow10(decimals), den);
}

/**
 * does quantity x (the unit shown with `decimals` places) match the printed total within the tolerance above?  With diff = q x N x scale - total x 10^d (all integers):
 *   points            |diff| x 200 x pointValueE4        <=  (rateE4 + 100 x pointValueE4) x 10^d
 *   EGP, independent  |diff| x 20,000                    <=  (rateE4 + 10,000) x 10^d
 *   EGP from points   |diff| x 20,000                    <=  (rateE4 + 100 x pointValueE4) x 10^d
 */
export function lineMatches(cur: Currency, line: UnitLine, rateE4: number, creditE4: number, decimals: number, egpDerived = false): boolean {
  const n = unitAt(cur, line.unitCc, rateE4, creditE4, decimals);
  const diff = B(line.quantity) * n * SCALE[cur] - B(line.totalMinor) * pow10(decimals);
  const abs = diff < B(0) ? -diff : diff;
  if (cur === "points") return abs * B(200) * B(creditE4) <= (B(rateE4) + B(100) * B(creditE4)) * pow10(decimals);
  const tolerance = egpDerived ? B(rateE4) + B(100) * B(creditE4) : B(rateE4) + B(10_000);
  return abs * B(20_000) <= tolerance * pow10(decimals);
}

export function unitDecimals(cur: Currency, lines: UnitLine[], rateE4: number, creditE4: number, egpDerived = false): { decimals: number; ok: boolean } {
  if (cur === "usd") return { decimals: BASE_DECIMALS.usd, ok: true }; // dollars are shown to 4 places, trimmed to 2: the stored price itself
  for (let d = BASE_DECIMALS[cur]; d <= MAX_DECIMALS[cur]; d++) if (lines.every((l) => lineMatches(cur, l, rateE4, creditE4, d, egpDerived))) return { decimals: d, ok: true };
  return { decimals: MAX_DECIMALS[cur], ok: false };
}

/** «١٧.٨٥٧» from the integer at d places; digits Arabic-Indic, thousands «٬», the decimal mark a plain «.» (the document font draws «٫» like a slash) */
export function fmtFixed(n: bigint, decimals: number): string {
  const unit = pow10(decimals);
  const int = (n / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  const frac = decimals > 0 ? (n % unit).toString().padStart(decimals, "0") : "";
  return toArabicDigits(frac ? `${int}.${frac}` : int);
}
