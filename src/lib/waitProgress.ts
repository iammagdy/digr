/**
 * What the chat says while a turn is still running. The first text says what is being done; a longer wait says that the work
 * goes on, so a slow moment never looks like a frozen page. Plain Arabic, no promise the client cannot keep.
 */
export const WAIT_STAGE_MS = { still: 8_000, slow: 25_000 } as const;
/** After this long the page offers «إيقاف الانتظار» (the customer is never stuck behind disabled inputs). */
export const WAIT_CANCEL_AFTER_MS = 15_000;
/**
 * The page stops waiting here and shows the retry. The server answers within its own 38 s budget (`TURN_BUDGET_MS`) plus the last writes, and the
 * route is cut at 60 s: the page gives up between the two, so a turn that has not answered is never a silent minute.
 */
export const TURN_TIMEOUT_MS = 45_000;
export const WAIT_STILL_AR = "ما زلت أعمل على طلبك، لحظات قليلة...";
export const WAIT_SLOW_AR = "الخدمة أبطأ من المعتاد الآن. إن لم تصلك الخطوة التالية خلال لحظات نوقف الانتظار ونعرض لك زر إعادة المحاولة.";

export function waitProgressText(baseText: string, elapsedMs: number): string {
  if (elapsedMs >= WAIT_STAGE_MS.slow) return WAIT_SLOW_AR;
  if (elapsedMs >= WAIT_STAGE_MS.still) return WAIT_STILL_AR;
  return baseText;
}
