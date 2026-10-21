import { pointsAr } from "./pointsFormat";
import { toArabicDigits } from "./arabicDigits";

/**
 * The low-balance conversation. Every sentence and number comes from code (the quote and the balance), never from
 * the model: the model explains, code prices.
 */
export interface LowBalanceInput {
  balance: number;
  /** points reserved for the whole plan, including the execution buffer */
  quotedPoints: number;
  /** the expected cost of the whole plan */
  expectedPoints: number;
  targetVolumeMax: number;
  downscaledOffer?: { maxAffordableUnits: number; affordableQuotedPoints: number } | null;
  /** EGP value of one point; the platform default is 0.10 */
  creditValueEgp?: number;
}

export type LowBalanceState = "affordable" | "can_reduce" | "top_up_only";

const n = (value: number) => toArabicDigits(Math.max(0, Math.round(value)));

export function lowBalanceState(input: LowBalanceInput): LowBalanceState {
  if (input.balance >= input.quotedPoints) return "affordable";
  const offer = input.downscaledOffer;
  return offer && offer.maxAffordableUnits >= 1 && offer.maxAffordableUnits < input.targetVolumeMax && offer.affordableQuotedPoints <= input.balance
    ? "can_reduce"
    : "top_up_only";
}

export function shortfallPoints(input: Pick<LowBalanceInput, "balance" | "quotedPoints">): number {
  return Math.max(0, Math.ceil(input.quotedPoints - input.balance));
}

/** The amount to pay to cover the shortfall, rounded up to the next 50 so a transfer is easy to make (minimum 50). */
export function shortfallEgp(points: number, creditValueEgp = 0.1): number {
  return Math.max(50, Math.ceil((points * creditValueEgp) / 50) * 50);
}

/**
 * Message shown with the plan when the balance does not cover it. Null when the balance is enough.
 * Offers exactly what fits, or a top-up that continues in the same conversation with the same plan.
 */
export function lowBalanceMessageAr(input: LowBalanceInput): string | null {
  const state = lowBalanceState(input);
  if (state === "affordable") return null;
  const short = shortfallPoints(input);
  const egp = shortfallEgp(short, input.creditValueEgp);
  const head = `رصيدك الحالي ${pointsAr(input.balance, n)}، والخطة تحجز ${pointsAr(input.quotedPoints, n)} (التكلفة المتوقعة ${pointsAr(input.expectedPoints, n)})، فينقصك ${pointsAr(short, n)}.`;
  const topUp = `اشحن ${n(egp)} جنيهًا تقريبًا ثم ارجع إلى هذه المحادثة، وستجد الخطة نفسها بانتظار موافقتك دون أن تبدأ من جديد.`;
  if (state === "can_reduce") {
    const offer = input.downscaledOffer!;
    return `${head} عندك خياران: أقلل العدد إلى ${n(offer.maxAffordableUnits)} سجل مقابل ${pointsAr(offer.affordableQuotedPoints, n)} تناسب رصيدك الآن، أو ${topUp}`;
  }
  return `${head} لا يوجد عدد أقل يناسب رصيدك الحالي، فالخيار هو أن ${topUp}`;
}

/** Shown in the same conversation after an approved top-up makes the same plan affordable. */
export function topupContinuationMessageAr(input: { balance: number; quotedPoints: number }): string | null {
  if (input.balance < input.quotedPoints) return null;
  return `تم اعتماد الشحن، ورصيدك الآن ${pointsAr(input.balance, n)} ويكفي لتنفيذ الخطة نفسها (الحجز ${pointsAr(input.quotedPoints, n)}). اضغط موافقة على الخطة لبدء البحث.`;
}
