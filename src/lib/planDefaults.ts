import { toArabicDigits } from "./arabicDigits";

/**
 * What a plan uses when the customer left a quantity open (a skipped or unanswered cap). It is never silent: the plan states the value and
 * that the customer can edit it. The price is still set by the quote from the count the plan holds; no price or cap changes here.
 */
export const DEFAULT_COMMENTS_CAP = 500;
export const DEFAULT_RECORDS_CAP = 500;

export function defaultCapFor(noun: "comments" | "records"): number {
  return noun === "comments" ? DEFAULT_COMMENTS_CAP : DEFAULT_RECORDS_CAP;
}

/** The plan line that says the count is a default and can be edited. */
export function defaultCapLineAr(noun: "comments" | "records", units: number): string {
  const word = noun === "comments" ? "تعليق" : "سجل";
  return `العدد المطلوب: ${toArabicDigits(units)} ${word} (قيمة افتراضية لأنك لم تحدد عددًا)، وتقدر تعدّله من الخطة.`;
}

/** When the default count does not fit one job: what the plan holds instead, in plain words (the numbers come from the quote). */
export function defaultCapFittedLineAr(input: { noun: "comments" | "records"; fittedUnits: number; quotedPoints: number; pointsCap: number }): string {
  const word = input.noun === "comments" ? "تعليق" : "سجل";
  return `لكن الطلب الواحد يتسع الآن لـ${toArabicDigits(input.fittedUnits)} ${word} بحجز ${toArabicDigits(input.quotedPoints)} نقطة ضمن سقف ${toArabicDigits(input.pointsCap)} نقطة، ويمكنك طلب الباقي في طلب منفصل.`;
}
