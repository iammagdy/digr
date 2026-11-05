/**
 * STAGE 2, FINDING F-2: ONE PROGRESS COUNTER ON A PHONE. While the live sheet is shown the phone has a counter «X من N» whose N is `promisedTotalOf` (the total the final Excel uses). The request card above it kept its OWN progress («وصلنا ١٤ من ٤٢ عنصرًا», a bar of
 * the delivering stages' rows, no replies), so the screen carried two totals for the same run, and the card could say «٤٢ من ٤٢» while the live counter said «٦٢ من ٧٠». The rule: when live data with a KNOWN promised total is visible, the live counter owns the progress on a phone and
 * the card's bar follows it; with no live data, or an unknown promised total (the counter then shows only a number: nothing competes), the card is today's. Pure; display only: no money, no row, no file.
 */
export interface LiveProgress { delivered: number; promised: number; ratio: number }

const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The progress the live counter shows, or null when there is none to follow (no live data, an unknown or zero promised total, numbers that are not whole numbers). The ratio never exceeds 1: a delivery above the promise is a full bar, the counter says why. */
export function liveProgressOf(live: { delivered: unknown; promised: unknown } | null | undefined): LiveProgress | null {
  if (!live || !whole(live.delivered) || !whole(live.promised) || live.promised <= 0) return null;
  return { delivered: live.delivered, promised: live.promised, ratio: Math.min(1, live.delivered / live.promised) };
}

/**
 * MERGE WITH MAIN'S ROUND 26 CARD (see docs/STAGE-2.md section 14). Main's status sentence carries a count of its own: «نجمع العناصر (١٤ من ٤٢)» (`collectLineOf`), and once the card's total is reached it says «جمعنا العناصر، ونجهّز ملفك الآن», which is made on that other total while the live counter may
 * still say «٦٢ من ٧٠». On a phone with live progress the first is shown without its count; the second only once the live snapshot is complete (done, or delivered reached promised), else «نجمع العناصر». A sentence of any other shape, or nothing to follow, is returned as it is.
 */
const COUNTED = /^(نجمع .+?) \([٠-٩٬]+ من [٠-٩٬]+\)$/;
const COLLECTED = /^جمعنا (.+?)، ونجهّز ملفك الآن$/;
export function phoneCollectLine(line: string, live: { status: unknown; delivered: unknown; promised: unknown } | null | undefined): string {
  const progress = liveProgressOf(live);
  if (!progress || typeof line !== "string") return line;
  const counted = COUNTED.exec(line);
  if (counted) return counted[1];
  const collected = COLLECTED.exec(line);
  if (collected) return live?.status === "done" || progress.delivered >= progress.promised ? line : `نجمع ${collected[1]}`;
  return line;
}
