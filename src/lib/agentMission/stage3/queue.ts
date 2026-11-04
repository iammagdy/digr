import { toArabicDigits } from "../../arabicDigits";
import type { QueueInfo } from "../customerView";

/**
 * STAGE 3, THE QUEUE MESSAGE (docs/STAGE-3.md, FOUNDATION-PLAN PR 5). Pure: the customer's position, an HONEST reason from a fixed list, and the wait that was MEASURED (the time the request
 * has already waited, from the stored moment it entered the queue), or null. Never a time that was not measured: no estimate of the time left, no «soon». The sentences are a fixed whitelist.
 * Read by the wiring behind `DIGER_STAGE3_QUEUE`; today's `queueLine` (customerView.ts) is unchanged.
 */
export const QUEUE_REASONS = ["starting_now", "behind_own", "behind_others", "behind_both", "service_paused"] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];
export interface QueueState { position: number; reason: QueueReason; measuredWaitMs: number | null; ahead: number; aheadOwn: number }

const whole = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

/** The queue state of a waiting request (status queued or approved), or null when it does not wait. `queuedAtMs`: the stored moment it entered the queue (approval), or null. */
export function queueStateOf(input: { status: string; queue: QueueInfo | null; queuedAtMs: number | null; nowMs: number }): QueueState | null {
  const { queue } = input;
  if (!queue || (input.status !== "queued" && input.status !== "approved")) return null;
  const ahead = whole(queue.ahead), aheadOwn = Math.min(ahead, whole(queue.aheadOwn)), runningOwn = whole(queue.runningOwn), running = whole(queue.running);
  const own = aheadOwn + runningOwn > 0;
  const others = ahead - aheadOwn > 0 || running - runningOwn > 0;
  const reason: QueueReason = !queue.workerAlive ? "service_paused" : own && others ? "behind_both" : own ? "behind_own" : others ? "behind_others" : "starting_now";
  const q = input.queuedAtMs;
  const measuredWaitMs = typeof q === "number" && Number.isFinite(q) && q <= input.nowMs ? input.nowMs - q : null;
  return { position: ahead + 1, reason, measuredWaitMs, ahead, aheadOwn };
}

const requestsAr = (n: number): string => (n === 1 ? "طلب واحد" : n === 2 ? "طلبين" : n >= 3 && n <= 10 ? `${toArabicDigits(n)} طلبات` : `${toArabicDigits(n)} طلبًا`);
/** The time ALREADY waited, in words. */
export function waitedAr(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "أقل من دقيقة";
  if (m < 60) return m === 1 ? "دقيقة" : m === 2 ? "دقيقتين" : m <= 10 ? `${toArabicDigits(m)} دقائق` : `${toArabicDigits(m)} دقيقة`;
  const h = Math.floor(m / 60);
  return h === 1 ? "ساعة" : h === 2 ? "ساعتين" : h <= 10 ? `${toArabicDigits(h)} ساعات` : `${toArabicDigits(h)} ساعة`;
}

/** THE WHITELIST: one sentence per reason; the measured wait is added only when it was measured. */
export function queueLineAr(s: QueueState): string {
  const pos = `طلبك رقم ${toArabicDigits(s.position)} في الدور`;
  const others = Math.max(0, s.ahead - s.aheadOwn);
  const head = ((): string => {
    switch (s.reason) {
      case "starting_now": return "طلبك يبدأ الآن.";
      case "service_paused": return "الخدمة متوقفة مؤقتًا. طلبك محفوظ وسيبدأ تلقائيًا عند عودتها.";
      case "behind_own": return `${pos}، لأنه ينتظر انتهاء طلب آخر لك يعمل الآن.`;
      case "behind_both": return `${pos}، لأن قبله ${requestsAr(Math.max(1, s.aheadOwn))} لك و${requestsAr(Math.max(1, others))} لعملاء آخرين.`;
      case "behind_others": return others > 0 ? `${pos}، لأن قبله ${requestsAr(others)} لعملاء آخرين.` : `${pos}، وسيبدأ عندما ينتهي طلب يعمل الآن.`;
    }
  })();
  return s.measuredWaitMs !== null && s.reason !== "starting_now" ? `${head} ينتظر طلبك منذ ${waitedAr(s.measuredWaitMs)}.` : head;
}
