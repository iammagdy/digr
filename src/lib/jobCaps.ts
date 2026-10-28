import { pointsAr } from "./pointsFormat";
import { toArabicDigits } from "./arabicDigits";
import { reserveForUnits } from "./recordPricing";

/**
 * The live per-job points cap is JOB_MAX_POINTS_CAP (25,000, `src/lib/jobPointsCap.ts`), enforced by the quote builder and the settlement function.
 * Nothing in this file changes it.
 *
 * JOB_MAX_POINTS_CAP_LARGE is a PROPOSAL for very large per-record jobs. It is documented here only: the planner and
 * settlement do not read it. It would apply only when all of these hold: the LARGE_JOB_CAP_ENABLED flag is "true"
 * (default off), the owner has approved the number, and the customer gives an explicit extra confirmation of the
 * larger hold for that one job. Until the owner decides, resolveJobPointsCap always returns the live cap.
 */
export const JOB_MAX_POINTS_CAP_LARGE = 2000;

export function largeJobCapEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.LARGE_JOB_CAP_ENABLED || "").trim().toLowerCase() === "true";
}

export function resolveJobPointsCap(liveCap: number, options: { enabled: boolean; customerConfirmedLarge: boolean }): number {
  if (!options.enabled || !options.customerConfirmedLarge) return liveCap;
  return Math.max(liveCap, JOB_MAX_POINTS_CAP_LARGE);
}

export interface CapStatementInput {
  requestedUnits: number;
  fittedUnits: number;
  unitPricePoints: number;
  /** the live cap */
  pointsCap: number;
  /** reserve buffer, 0.15 */
  safetyBuffer: number;
  /** points held for the fitted plan */
  quotedPoints: number;
  unitLabelAr?: string;
}

const n = (value: number) => toArabicDigits(Math.max(0, Math.round(value)));

/** Said beside a count that the live extraction capacity cut: why, and what to do. No provider word, no money, no technical name. */
export const CAPACITY_LIMITED_REASON_AR = "سعة المصدر المتاحة الآن محدودة، ونوصي بإعادة المحاولة لاحقًا.";

/** The plain reason the live capacity cut a count, by which limit was the smallest (no provider word, no money, no technical name). */
export const CAPACITY_CAUSE_REASON_AR: Record<"balance" | "daily" | "user", string> = {
  balance: "رصيد الاستخراج المتاح لدينا اليوم منخفض، فاقتصر الطلب على ما يتسع له الآن.",
  daily: "بلغنا الحد اليومي لاستخراج هذه الخدمة، فاقتصر الطلب على ما يتسع له الآن. يتجدد الحد غدًا.",
  user: "بلغ حسابك حدّه اليومي للاستخراج، فاقتصر الطلب على ما يتسع له الآن. يتجدد الحد غدًا.",
};
export const capacityReasonAr = (cause?: string | null): string => CAPACITY_CAUSE_REASON_AR[(cause as "balance" | "daily" | "user")] ?? CAPACITY_LIMITED_REASON_AR;

/** Said when the service's own per-request ceiling, and neither the balance nor the points cap, is what limits the count. */
export const SERVICE_CEILING_REASON_AR = "هذا حدّ الخدمة نفسها لكل طلب، وليس رصيدك.";

/** The reason sentence shown whenever the plan holds fewer records than the customer asked for. */
export const VOLUME_LIMIT_REASON_AR = "يتحدد الحد بسبب سقف المهمة الحالي.";

/**
 * What the customer asked, what fits one job now, and why, in two short sentences. The numbers come from the plan; nothing is
 * shrunk without saying so. Null when the plan holds everything that was asked.
 */
export function volumeLimitStatementAr(input: {
  askedUnits: number;
  fittedUnits: number;
  unitLabelAr?: string;
  /** `capacity`: what the live extraction capacity allows right now cut the count, not the job's points cap.
   *  `service`: the service's own ceiling per request cut it (not the balance, not the points cap): the number is `fittedUnits`. */
  reason?: "capacity" | "service" | "reach";
  /** `reach`: how the fitted count comes about («٢٠ منشورًا × ٢٠ تعليقًا لكل منشور»): the posts a job reads times the comments taken from each. */
  reachDetailAr?: string;
  /** The points the plan holds back, said in the sentence when the cut came from the live capacity. */
  reservedPoints?: number;
}): string | null {
  const asked = Math.round(input.askedUnits);
  const fitted = Math.round(input.fittedUnits);
  if (!Number.isFinite(asked) || !Number.isFinite(fitted) || fitted < 1 || fitted >= asked) return null;
  const unit = input.unitLabelAr || "سجل";
  if (input.reason === "capacity") {
    const reserved = input.reservedPoints && input.reservedPoints > 0 ? `، وسيُحجز للخطة حتى ${pointsAr(input.reservedPoints, n)} ولا يُخصم منها إلا ما يُسلَّم` : "";
    return `طلبت ${n(asked)} ${unit}، والذي تتسع له سعة الاستخراج المتاحة الآن ${n(fitted)} ${unit}${reserved}.`;
  }
  if (input.reason === "reach" && input.reachDetailAr) {
    return `طلبت ${n(asked)} ${unit}، والذي يتسع له هذا الطلب ${n(fitted)} ${unit} (${input.reachDetailAr}). هذا حدّ الطلب الواحد، وليس رصيدك. ويمكنك طلب الباقي في طلب منفصل.`;
  }
  if (input.reason === "service") {
    return `طلبت ${n(asked)} ${unit}، والذي تتسع له هذه الخدمة في الطلب الواحد ${n(fitted)} ${unit}. ${SERVICE_CEILING_REASON_AR} ويمكنك طلب الباقي في طلب منفصل.`;
  }
  return `طلبت ${n(asked)} ${unit}، والذي يناسب الطلب الواحد الآن ${n(fitted)} ${unit}. ${VOLUME_LIMIT_REASON_AR}`;
}

/**
 * When a request is larger than the cap allows, say plainly how many records fit and what the full request would
 * have needed. All numbers come from the quote; the model writes none of them. Null when nothing was reduced.
 */
export function capStatementAr(input: CapStatementInput): string | null {
  if (input.fittedUnits >= input.requestedUnits) return null;
  const unit = input.unitLabelAr || "سجل";
  const fullReserve = reserveForUnits(input.requestedUnits, input.unitPricePoints, input.safetyBuffer);
  return `طلبك الكامل (${n(input.requestedUnits)} ${unit}) يحتاج حجز حوالي ${pointsAr(fullReserve, n)}، وهو أكبر من سقف الطلب الواحد (${pointsAr(input.pointsCap, n)}). لذلك تشمل الخطة ${n(input.fittedUnits)} ${unit} بحجز ${pointsAr(input.quotedPoints, n)}، وهذا أكبر عدد يناسب السقف. تقدر تطلب الباقي في طلب منفصل بعد اكتمال هذا الطلب.`;
}
