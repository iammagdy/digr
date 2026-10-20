import { volumeForPointsCap } from "./pointsCap";

/**
 * How many records ONE job holds, by the quote writer's own rule (`buildQuote` in planManager), so that every public number
 * (the calculator, the estimate box, the segment pages) says what the plan will say. Nothing here changes a cap value: the
 * cap is an input.
 *
 * - Every service except decision makers: the RESERVE (price × records × (1 + buffer)) must stay at or under the cap, so
 *   a plan is cut to the most records whose reserve fits.
 * - Decision makers: the CHARGE (price × records) is cut to the cap first, and only the reserve is then clipped to the cap.
 *   So one job holds floor(cap / price) people, not floor(cap / (price × (1 + buffer))).
 */
export interface JobSizingInput {
  unitPricePoints: number;
  /** The cap in points that one job's hold may not pass (the live job cap, lowered by the live daily limit when known). */
  capPoints: number;
  safetyBuffer: number;
  /** True for decision makers (the writer cuts their charge to the cap first). */
  chargeCapped?: boolean;
}

/** The most records one job holds; 0 when even one record does not fit. */
export function recordsInOneJob(input: JobSizingInput): number {
  const cap = Math.floor(Number(input.capPoints));
  const unit = Number(input.unitPricePoints);
  if (!Number.isFinite(cap) || cap < 1 || !Number.isFinite(unit) || unit <= 0) return 0;
  if (!input.chargeCapped) return volumeForPointsCap(cap, unit, input.safetyBuffer);
  return Math.max(0, Math.floor(cap / unit));
}

/** The hold for `volume` records inside one job: the buffered reserve, clipped to the cap for decision makers. */
export function reserveInOneJob(volume: number, input: JobSizingInput): number {
  const reserve = Math.ceil(Math.max(0, volume) * input.unitPricePoints * (1 + input.safetyBuffer));
  return input.chargeCapped ? Math.min(reserve, Math.max(0, Math.floor(input.capPoints))) : reserve;
}
