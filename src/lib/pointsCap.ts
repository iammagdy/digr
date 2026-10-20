import { toArabicDigits } from "./arabicDigits";

/**
 * The customer's own budget cap, in points. It is a smaller limit the customer sets on the plan: it turns into the most
 * records the reserve (with the 15% buffer) can hold under it, so the job stops there and the charge, which is only for
 * what was delivered and never above the reserve, can never pass the cap. The live per-job cap (and any change to it) is
 * not touched here: this can only lower a plan, never raise it.
 */
export const RESERVE_BUFFER = 0.15;

/** The most records whose reserve stays at or under `capPoints`; 0 when even one record does not fit. */
export function volumeForPointsCap(capPoints: number, unitPricePoints: number, buffer = RESERVE_BUFFER): number {
  const cap = Math.floor(Number(capPoints));
  const unit = Number(unitPricePoints);
  if (!Number.isFinite(cap) || cap < 1 || !Number.isFinite(unit) || unit <= 0) return 0;
  let units = Math.floor(cap / (unit * (1 + buffer)));
  // floating point can leave the reserve one point over: step down until it fits
  while (units > 0 && Math.ceil(units * unit * (1 + buffer)) > cap) units -= 1;
  return Math.max(0, units);
}

/** The reserve the plan would hold for `units` records. */
export function reserveForUnits(units: number, unitPricePoints: number, buffer = RESERVE_BUFFER): number {
  return Math.ceil(Math.max(0, units) * unitPricePoints * (1 + buffer));
}

export type CapResolution =
  | { ok: true; volume: number; reservePoints: number }
  | { ok: false; reasonAr: string };

/**
 * The plan volume under a customer cap: never above the current volume (a cap only lowers a plan), and refused with a plain
 * reason when the cap cannot even hold one record.
 */
export function applyCustomerCap(input: { capPoints: number; unitPricePoints: number; currentVolume: number }): CapResolution {
  const fit = volumeForPointsCap(input.capPoints, input.unitPricePoints);
  if (fit < 1) {
    return { ok: false, reasonAr: `الحد الأقصى الذي كتبته لا يكفي لسجل واحد؛ أقل حد ممكن ${toArabicDigits(reserveForUnits(1, input.unitPricePoints))} نقطة.` };
  }
  const volume = Math.max(1, Math.min(fit, Math.floor(input.currentVolume)));
  return { ok: true, volume, reservePoints: reserveForUnits(volume, input.unitPricePoints) };
}
