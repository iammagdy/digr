import { pointsAr } from "./pointsFormat";
import { toArabicDigits } from "./arabicDigits";
import { maxVolumeUnderCap, reserveForUnits as exactReserveForUnits } from "./recordPricing";

/**
 * The customer's own budget cap, in points. It is a smaller limit the customer sets on the plan: it turns into the most
 * records the reserve (with the 15% buffer) can hold under it, so the job stops there and the charge, which is only for
 * what was delivered and never above the reserve, can never pass the cap. The live per-job cap (and any change to it) is
 * not touched here: this can only lower a plan, never raise it.
 */
export const RESERVE_BUFFER = 0.15;

/** The most records whose reserve stays at or under `capPoints`; 0 when even one record does not fit. Exact integer arithmetic. */
export function volumeForPointsCap(capPoints: number, unitPricePoints: number, buffer = RESERVE_BUFFER): number {
  return maxVolumeUnderCap(capPoints, unitPricePoints, buffer);
}

/** The reserve the plan would hold for `units` records. Exact integer arithmetic. */
export function reserveForUnits(units: number, unitPricePoints: number, buffer = RESERVE_BUFFER): number {
  return exactReserveForUnits(units, unitPricePoints, buffer);
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
    return { ok: false, reasonAr: `الحد الأقصى الذي كتبته لا يكفي لسجل واحد؛ أقل حد ممكن ${pointsAr(reserveForUnits(1, input.unitPricePoints), toArabicDigits)}.` };
  }
  const volume = Math.max(1, Math.min(fit, Math.floor(input.currentVolume)));
  return { ok: true, volume, reservePoints: reserveForUnits(volume, input.unitPricePoints) };
}
