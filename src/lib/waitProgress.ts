/**
 * What the chat says while a turn is still running. The first text says what is being done; a longer wait says that the work
 * goes on, so a slow moment never looks like a frozen page. Plain Arabic, no promise the client cannot keep.
 */
export const WAIT_STAGE_MS = { still: 8_000, slow: 25_000 } as const;
export const WAIT_STILL_AR = "ما زلت أعمل على طلبك، لحظات قليلة...";
export const WAIT_SLOW_AR = "الخدمة أبطأ من المعتاد الآن، نواصل العمل وستصلك النتيجة هنا.";

export function waitProgressText(baseText: string, elapsedMs: number): string {
  if (elapsedMs >= WAIT_STAGE_MS.slow) return WAIT_SLOW_AR;
  if (elapsedMs >= WAIT_STAGE_MS.still) return WAIT_STILL_AR;
  return baseText;
}
