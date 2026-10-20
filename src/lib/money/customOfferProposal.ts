import { chargePoints, reservePoints } from "./pricingProposal";

/**
 * PROPOSAL (parked branch, not wired): a custom offer, written by an admin for ONE customer: a fixed unit price, a most volume,
 * an expiry. It never changes the ledger or the settle path: the customer still approves an ordinary plan, the offer only lets
 * the quote writer use the offer's unit price and (for this customer only) a higher per-job cap. Charge stays
 * ceil(delivered x unit) and never exceeds the reserve.
 */
export interface CustomOffer {
  id: string;
  userId: string;
  unitMicro: number;
  maxVolume: number;
  maxReservePoints: number;
  expiresAt: string;
  status: "open" | "used" | "expired" | "cancelled";
}

export const customOfferId = (requestId: string) => `off_${requestId}`;

export type OfferCheck = { ok: true; unitMicro: number; reservePoints: number } | { ok: false; reasonAr: string };

export function applyCustomOffer(offer: CustomOffer, input: { userId: string; volume: number; now: Date; bufferPercent?: number }): OfferCheck {
  if (offer.userId !== input.userId) return { ok: false, reasonAr: "هذا العرض غير مخصص لحسابك." };
  if (offer.status !== "open") return { ok: false, reasonAr: "هذا العرض لم يعد متاحًا." };
  if (new Date(offer.expiresAt).getTime() <= input.now.getTime()) return { ok: false, reasonAr: "انتهت صلاحية هذا العرض." };
  if (input.volume < 1 || input.volume > offer.maxVolume) return { ok: false, reasonAr: "العدد المطلوب خارج حدود العرض." };
  const reserve = reservePoints(input.volume, offer.unitMicro, input.bufferPercent ?? 15);
  if (reserve > offer.maxReservePoints) return { ok: false, reasonAr: "الحجز المطلوب أعلى من حد العرض." };
  return { ok: true, unitMicro: offer.unitMicro, reservePoints: reserve };
}

export function offerCharge(delivered: number, offer: CustomOffer): number {
  return chargePoints(delivered, offer.unitMicro);
}
