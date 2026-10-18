/**
 * Guards that keep one chat turn from stalling: a time budget for the whole turn, detection of a model reply that
 * only announces a plan, and the provider failures that code can answer without the model.
 */

/** The page gives up at 55 s and the route at 60 s; a turn that has not produced a next step by here is finished by code. */
export const TURN_BUDGET_MS = 38_000;
/** A further model call is only started when at least this much of the budget is left (one call can take up to 30 s). */
export const MIN_MODEL_CALL_BUDGET_MS = 12_000;

export const turnBudgetLeftMs = (turnStartMs: number, now = Date.now()): number => TURN_BUDGET_MS - (now - turnStartMs);

/** A reply like «هجهز لك خطة...» that names a plan but carries none. */
const ANNOUNCEMENT_VERB = /(?:هجهز|هجهزلك|هجهز لك|هعمل لك|هعملك|هعد لك|هعد|سأجهز|سأعد|سأقوم بإعداد|سأقوم بتجهيز|أجهز لك|اجهز لك|أعد لك|اعد لك|جارٍ تجهيز|جاري تجهيز|جارٍ إعداد|جاري إعداد|لحظات وأجهز|ثواني وأجهز|دقيقة وأجهز)/;
const PLAN_WORD = /(?:خطة|الخطة|خطه|عرض سعر|عرض السعر|تسعير|السعر)/;

export function isPlanAnnouncementOnly(text: string | undefined | null): boolean {
  const t = (text || "").trim();
  if (!t || t.length > 260) return false;
  return ANNOUNCEMENT_VERB.test(t) && PLAN_WORD.test(t);
}

export const SLOW_TURN_INTRO_AR = "استغرق الرد وقتًا أطول من المعتاد، فاخترت لك أبسط خطوة تالية.";
