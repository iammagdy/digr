import { pointsAr } from "./pointsFormat";
import { toArabicDigits } from "./arabicDigits";

/**
 * One plain verdict on the balance, shown with the plan BEFORE approval: «يكفي رصيدك» or «رصيدك لا يكفي، أقصى عدد يتسع X». Every number
 * comes from the quote and the balance (code); the model phrases nothing here. The sentence about what is held says the truth about the
 * hold: only what is delivered is charged, and the 15% buffer sits on the hold alone (the charge is never above the hold).
 */
export interface BalanceVerdictInput {
  balance: number;
  /** The hold for the plan (the reserve, with the buffer). */
  quotedPoints: number;
  /** What the plan costs if every record is delivered (no buffer). */
  expectedPoints: number;
  targetVolumeMax: number;
  /** The most records the balance holds, when the quote worked it out. */
  downscaledOffer?: { maxAffordableUnits: number; affordableQuotedPoints: number } | null;
  unitLabelAr?: string;
}

const n = (value: number) => toArabicDigits(Math.max(0, Math.round(value)));

export function balanceVerdictAr(input: BalanceVerdictInput): string {
  const balance = Math.max(0, Number(input.balance) || 0);
  const unit = input.unitLabelAr || "سجل";
  if (balance >= input.quotedPoints) {
    return `يكفي رصيدك: رصيدك ${pointsAr(balance, n)}، والحجز المؤقت ${pointsAr(input.quotedPoints, n)} (يشمل احتياطي ١٥٪ على الحجز وحده)، ولا يُخصم إلا ثمن ما يُسلَّم فعلًا وهو حتى ${pointsAr(input.expectedPoints, n)}.`;
  }
  const offer = input.downscaledOffer;
  if (offer && offer.maxAffordableUnits >= 1 && offer.maxAffordableUnits < input.targetVolumeMax && offer.affordableQuotedPoints <= balance) {
    return `رصيدك لا يكفي، أقصى عدد يتسع ${n(offer.maxAffordableUnits)} ${unit} بحجز ${pointsAr(offer.affordableQuotedPoints, n)}.`;
  }
  return "رصيدك لا يكفي، ولا يوجد عدد أقل يناسب رصيدك الحالي.";
}
