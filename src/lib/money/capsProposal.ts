import { toArabicDigits } from "../arabicDigits";

/**
 * PROPOSAL (parked branch, not wired): the start-of-job gate for large jobs. A job is allowed to start only if the customer
 * can pay, the job is under the per-job cap, a large reserve was explicitly confirmed, and the provider has the balance and the
 * daily allowance for the estimated cost. Customer text never names a provider and never shows dollars.
 */
export const CONFIRM_ABOVE_POINTS = 600;

export interface StartGateInput {
  reservePoints: number;
  userBalancePoints: number;
  /** Per-job cap on the reserve (the owner's decision at G-MONEY). */
  jobCapPoints: number;
  /** The customer confirmed this large reserve (a distinct, explicit action on the plan). */
  confirmedLargeReserve: boolean;
  /** Provider side, in USD (internal only). */
  estimatedProviderCostUsd: number;
  providerBalanceUsd: number | null;
  providerDailyCapUsd: number | null;
  providerSpentTodayUsd: number;
  /** Spare provider balance required beyond the estimate, as a fraction (0.2 = 20%). */
  balanceMargin?: number;
}

export type StartGateDecision =
  | { decision: "allow" }
  | { decision: "needs_confirmation"; reasonAr: string }
  | { decision: "blocked"; code: "insufficient_balance" | "over_job_cap" | "provider_daily_cap" | "provider_balance_low"; reasonAr: string };

const n = (value: number) => toArabicDigits(Math.max(0, Math.ceil(value)));

export function evaluateStartGate(input: StartGateInput): StartGateDecision {
  if (input.reservePoints > input.userBalancePoints) {
    return { decision: "blocked", code: "insufficient_balance", reasonAr: `رصيدك لا يكفي لحجز ${n(input.reservePoints)} نقطة. اشحن رصيدك أو قلّل العدد.` };
  }
  if (input.reservePoints > input.jobCapPoints) {
    return { decision: "blocked", code: "over_job_cap", reasonAr: `الطلب الواحد لا يتسع لأكثر من ${n(input.jobCapPoints)} نقطة محجوزة. قسّمه على أكثر من طلب.` };
  }
  const margin = input.balanceMargin ?? 0.2;
  if (input.providerDailyCapUsd !== null && input.providerSpentTodayUsd + input.estimatedProviderCostUsd > input.providerDailyCapUsd) {
    return { decision: "blocked", code: "provider_daily_cap", reasonAr: "وصلنا إلى الحد اليومي لجمع البيانات. لم يُخصم أي رصيد؛ جرّب غدًا أو قلّل العدد." };
  }
  if (input.providerBalanceUsd !== null && input.providerBalanceUsd < input.estimatedProviderCostUsd * (1 + margin)) {
    return { decision: "blocked", code: "provider_balance_low", reasonAr: "خدمة الجمع غير متاحة لهذا الحجم الآن. لم يُخصم أي رصيد؛ حاول بعد قليل." };
  }
  if (input.reservePoints > CONFIRM_ABOVE_POINTS && !input.confirmedLargeReserve) {
    return { decision: "needs_confirmation", reasonAr: `سيُحجز ${n(input.reservePoints)} نقطة لهذا الطلب. أكّد موافقتك على هذا الحجز الكبير لنبدأ؛ لا يُخصم إلا ما يصلك فعلًا.` };
  }
  return { decision: "allow" };
}

/** The provider cost to check against balance and daily cap: the expected spend at the reserve's volume. */
export function estimatedProviderCostUsd(volume: number, costUsdPerRecord: number): number {
  return Math.max(0, volume) * costUsdPerRecord;
}
