import { pointsAr } from "./pointsFormat";

/**
 * The activity line written when a job settles. The ledger records TWO rows at settlement: the WHOLE hold released, then the charge of
 * what was delivered. The line says exactly that (never «the remainder only»), and the net amount that is back in the balance. Never
 * «استرداد»: a released hold is «حجز مؤقت مُحرَّر».
 */
export function settlementEventAr(input: { reservedPoints: number; chargedPoints: number }, digits: (value: string | number) => string): string {
  const reserved = Math.max(0, Math.round(Number(input.reservedPoints) || 0));
  const charged = Math.max(0, Math.min(reserved, Math.round(Number(input.chargedPoints) || 0)));
  const back = reserved - charged;
  if (charged === 0) return `حُرّر الحجز المؤقت كاملًا (${pointsAr(reserved, digits)}) ولم يُخصم أي رصيد.`;
  return `حُرّر الحجز المؤقت كاملًا (${pointsAr(reserved, digits)})، ثم خُصم ثمن ما سُلّم فقط (${pointsAr(charged, digits)})، فيبقى في رصيدك ${pointsAr(back, digits)} من هذا الحجز.`;
}

/**
 * A released hold is «حجز مؤقت مُحرَّر», always. Old job messages (stored before this rule, and written by the worker for failures) say
 * «تم إرجاع النقاط المحجوزة إلى رصيدك», «أُعيدت النقاط المحجوزة», «استرداد…»: the stored text is never rewritten; it is read through this on the
 * request cards and the activity panel, so the customer sees one wording and the ledger lines say the same.
 */
export function normalizeReleaseWording(text: unknown): string {
  return String(text ?? "")
    // «تم إرجاع (كامل) النقاط المحجوزة (كاملة) (إلى رصيدك)» and its spellings
    .replace(/(?:تم\s+)?(?:إرجاع|ارجاع|استرداد|استرجاع|رد)\s+(?:كامل\s+)?(?:ال)?نقاط(?:ك)?\s+(?:ال)?محجوزة(?:\s+كاملة)?(?:\s+(?:إلى|الى|لـ?|في)\s*(?:رصيدك|حسابك))?/g, "حجز مؤقت مُحرَّر كاملًا")
    .replace(/(?:أُعيدت|أعيدت|رجعت)\s+(?:ال)?نقاط\s+(?:ال)?محجوزة(?:\s+كاملة)?(?:\s+(?:إلى|الى)\s+رصيدك)?/g, "حجز مؤقت مُحرَّر كاملًا")
    .replace(/وإرجاع\s+(?:كامل\s+)?(?:ال)?نقاط\s+(?:ال)?محجوزة/g, "وحجز مؤقت مُحرَّر كاملًا")
    .replace(/(?:وأُعيد|وأعيد)\s+(?:ال)?رصيد\s+(?:ال)?محجوز/g, "وحجز مؤقت مُحرَّر")
    .replace(/(?:أُعيد|أعيد)\s+(?:ال)?رصيد\s+(?:ال)?محجوز/g, "حجز مؤقت مُحرَّر")
    .replace(/(?:إرجاع|استرداد|استرجاع)\s+(?:ال)?رصيد\s+(?:ال)?محجوز/g, "حجز مؤقت مُحرَّر")
    .replace(/\s{2,}/g, " ")
    .trim();
}
