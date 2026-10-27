import { planCountPartsAr, type CountedPlanItem } from "./planCounts";

/**
 * A plan LARGER than the live cap used to be (the old per-job cap, 600 points) is never clipped silently by the provider capacity gate: when today's
 * provider budget (the admin's daily limit, the provider's real balance, the customer's own daily limit) cannot hold it, the plan is REFUSED in one
 * plain sentence that says what the capacity does hold. A plan at or under the old cap keeps the older behaviour (cut, with the reason shown on the card).
 * No money, no provider word, no technical name: only counts. Pure: the numbers come from the plan and the gate.
 */
export const LARGE_PLAN_FROM_POINTS = 600;

/** A plan that is refused with an Arabic sentence the customer reads as it is (nothing was written, nothing was held). */
export class PlanRefusalError extends Error {
  constructor(readonly messageAr: string) {
    super(messageAr);
    this.name = "PlanRefusalError";
  }
}

/** A plan with a scope gap (a placeholder, a missing country…): refused in one plain sentence, never as a build failure. `message` keeps the gap codes for logs and the old callers. */
export class PlanIncompleteError extends PlanRefusalError {
  constructor(readonly gaps: string[]) {
    super("لم نتمكن من استكمال بيانات طلبك؛ اذكر الحساب أو الرابط أو التفاصيل الناقصة وأعد إرسال الطلب، ولم يُحجز أي رصيد.");
    this.name = "PlanIncompleteError";
    this.message = `الخطة غير مكتملة: ${gaps.join(", ")}`;
  }
}

/** The sentence. `share` is the part of the plan today's capacity holds (0 to 1); the counts are that part of every service, rounded down. */
export function capacityRefusalAr(items: ReadonlyArray<CountedPlanItem>, share: number): string {
  const fits = items.map((item) => ({ ...item, targetVolumeMax: Math.floor((Number(item.targetVolumeMax) || 1) * Math.max(0, Math.min(1, share))) }));
  if (fits.some((item) => item.targetVolumeMax < 1)) {
    return "هذا الطلب أكبر من طاقة الاستخراج المتاحة اليوم، ولا تتسع الطاقة الحالية لأي جزء منه. أعد المحاولة لاحقًا، ولم يُحجز أي رصيد.";
  }
  return `هذا الطلب أكبر من طاقة الاستخراج المتاحة اليوم؛ تتسع الطاقة الحالية لنحو ${planCountPartsAr(fits)} فقط. اطلب هذا العدد أو أقل، أو أعد المحاولة لاحقًا، ولم يُحجز أي رصيد.`;
}

