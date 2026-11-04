import { formatAr } from "../arabicDigits";

/**
 * ROUND 26 (items 1 and 2): how often the card asks, how often the worker takes work, and the holding line of a waiting mission.
 * Pure: the caller gives the clock. The page asks every 2 to 3 seconds while a mission is live, and for a few minutes after the customer's own action (so the next card shows at once);
 * the worker polls every 2 seconds for two minutes after it took work, and the usual 5 seconds otherwise.
 */
export const CARD_FAST_MS = 2500;
export const CARD_SLOW_MS = 8000;
export const CARD_HIDDEN_LIVE_MS = 12000;
export const CARD_HIDDEN_MS = 20000;
/** After a customer's own action the card asks fast for this long. */
export const CARD_FAST_AFTER_ACTION_MS = 3 * 60_000;

export function cardPollDelayMs(input: { live: boolean; fastUntil: number; now: number; hidden: boolean }): number {
  if (input.hidden) return input.live ? CARD_HIDDEN_LIVE_MS : CARD_HIDDEN_MS;
  return input.live || input.now < input.fastUntil ? CARD_FAST_MS : CARD_SLOW_MS;
}

export const WORKER_BUSY_POLL_MS = 2000;
export const WORKER_IDLE_POLL_MS = 5000;
/** For this long after the worker took a mission it polls quickly (the next step of that mission, or the answer the customer just gave, is picked up soon). */
export const WORKER_BUSY_WINDOW_MS = 120_000;

export function workerPollDelayMs(input: { lastTakeAt: number | null; now: number }): number {
  if (input.lastTakeAt === null) return WORKER_IDLE_POLL_MS;
  const since = input.now - input.lastTakeAt;
  return since >= 0 && since <= WORKER_BUSY_WINDOW_MS ? WORKER_BUSY_POLL_MS : WORKER_IDLE_POLL_MS;
}

/** After this much silence the card says one honest line (we are still working, nothing is charged). */
export const HOLDING_STILL_AFTER_MS = 60_000;
export const HOLDING_STILL_AR = "ما زلنا نعمل على طلبك، ولم يُخصم منك شيء.";

/** «نقرأ عينة من المصدر · منذ ٢٠ ثانية»: the live step (a real event's title) and the time since the last change; after a minute one more honest sentence. */
export function holdingLineAr(stepAr: string, quietMs: number): string {
  const ms = Math.max(0, quietMs);
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const since = secs < 60 ? `منذ ${formatAr(secs)} ثانية` : mins === 1 ? "منذ دقيقة" : mins === 2 ? "منذ دقيقتين" : `منذ ${formatAr(mins)} دقائق`;
  const base = `${stepAr} · ${since}`;
  return ms >= HOLDING_STILL_AFTER_MS ? `${base} · ${HOLDING_STILL_AR}` : base;
}
