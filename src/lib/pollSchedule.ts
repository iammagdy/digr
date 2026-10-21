/**
 * How often a page asks the server about a running request. A page that asks every 3 seconds, forever, is fine for one customer and a
 * flood for five hundred: so the first minute is quick (the customer is watching it start), then it slows down, a tab nobody looks at
 * asks rarely, and every delay carries jitter so a room of phones does not ask in the same second.
 * Pure: the caller supplies the clock and the random number.
 */

/** A random source that returns something odd (negative, above one, not a number) is treated as the middle of the range. */
function unit(random: number): number {
  return Number.isFinite(random) ? Math.min(Math.max(random, 0), 0.999999) : 0.5;
}

export interface PollDelayInput {
  /** Milliseconds since this page started following the request. */
  elapsedMs: number;
  /** The tab is in the background. */
  hidden: boolean;
  /** A number in [0, 1): the caller's random source (a test passes a fixed one). */
  random: number;
}

/** Base delays by age of the request: 3 s for the first minute, 5 s up to 5 minutes, 10 s up to 20 minutes, then 15 s. A hidden tab: 30 s. */
export function basePollDelayMs(elapsedMs: number, hidden: boolean): number {
  if (hidden) return 30_000;
  if (elapsedMs < 60_000) return 3_000;
  if (elapsedMs < 5 * 60_000) return 5_000;
  if (elapsedMs < 20 * 60_000) return 10_000;
  return 15_000;
}

/** The delay to the next question: the base delay plus or minus 20%. Never below one second. */
export function nextPollDelayMs(input: PollDelayInput): number {
  const base = basePollDelayMs(Math.max(0, input.elapsedMs), input.hidden);
  const spread = (unit(input.random) * 2 - 1) * 0.2;
  return Math.max(1_000, Math.round(base * (1 + spread)));
}

/** A steady background count (for example «requests running» in the menu): every 30 s, with jitter, and not at all while the tab is hidden. */
export const BACKGROUND_COUNT_POLL_MS = 30_000;
export function nextBackgroundDelayMs(random: number): number {
  const spread = (unit(random) * 2 - 1) * 0.2;
  return Math.round(BACKGROUND_COUNT_POLL_MS * (1 + spread));
}
