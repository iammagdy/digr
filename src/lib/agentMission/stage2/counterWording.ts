import { formatAr } from "../../arabicDigits";

/**
 * THE WORDS OF THE LIVE COUNTER (finding F-1). One function, read by the worker's snapshot, the route's answer and the work log, so that no surface can say «١٠٩ من ٧٠» while the delivered Excel says why 109 is more than 70.
 * The numbers are never touched here: they come from `promisedTotalOf` (the Excel summary's own denominator). Pure; display only; no money.
 *
 *  - promised unknown (none or zero): only the delivered number; no total is invented.
 *  - delivered up to the promised number (also «٠ من ٤٠» before the work starts, and «٤٠ من ٤٠» at exact completion): «X من N».
 *  - delivered ABOVE the promised number: the whole delivered number and a sentence that it is above the plan's estimate. Nothing is capped, hidden or removed.
 */
export const OVER_DELIVERED_NOTE_AR = (promised: number): string => `أكثر من التقدير البالغ ${formatAr(promised)}`;

export function counterAr(delivered: number, promised: number | null): string {
  if (promised === null || !(promised > 0)) return formatAr(delivered);
  if (delivered > promised) return `${formatAr(delivered)} (${OVER_DELIVERED_NOTE_AR(promised)})`;
  return `${formatAr(delivered)} من ${formatAr(promised)}`;
}

const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The counter text of a stored snapshot, from its NUMBERS (so a snapshot written by an older worker, with the old words, is shown with the new ones); the stored text when the numbers are not whole numbers. */
export function counterOfStored(stored: { delivered: unknown; promised: unknown; counterAr: string }): string {
  if (!whole(stored.delivered)) return stored.counterAr;
  if (stored.promised !== null && !whole(stored.promised)) return stored.counterAr;
  return counterAr(stored.delivered, stored.promised as number | null);
}
