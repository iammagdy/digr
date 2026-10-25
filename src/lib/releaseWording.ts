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
  if (charged === 0) return `حجز مؤقت مُحرَّر كاملًا (${pointsAr(reserved, digits)}) ولم يُخصم أي رصيد.`;
  return `حجز مؤقت مُحرَّر كاملًا (${pointsAr(reserved, digits)})، ثم خُصم ثمن ما سُلّم فقط (${pointsAr(charged, digits)})، فيبقى في رصيدك ${pointsAr(back, digits)} من هذا الحجز.`;
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
    .replace(/(?:تم\s+)?(?:إرجاع|استرداد|استرجاع)\s+(?:ال)?رصيد\s+(?:ال)?محجوز/g, "حجز مؤقت مُحرَّر")
    // the notices stored before the wording rule: «فأعدنا نقاطك المحجوزة كاملة لرصيدك», «أعدنا ٣٠ نقطة محجوزة كاملة إلى رصيدك», «وعادت ٤٨ نقطة إلى رصيدك»
    .replace(/(?:ف|و)?أعدنا\s+نقاطك\s+(?:ال)?محجوزة(?:\s+كاملة)?\s+(?:إلى|الى|ل)\s*رصيدك/g, "حجز مؤقت مُحرَّر كاملًا")
    .replace(/(?:ف|و)?أعدنا\s+([٠-٩0-9٬,]+\s+نقطة|نقطة واحدة|نقطتين|[٠-٩0-9٬,]+\s+نقاط)\s+محجوزة(?:\s+كاملة)?\s+(?:إلى|الى)\s+رصيدك/g, "حجز مؤقت مُحرَّر $1 كاملًا")
    .replace(/وعاد(?:ت)?\s+([٠-٩0-9٬,]+\s+(?:نقطة|نقاط)|نقطة واحدة|نقطتين)\s+(?:إلى|الى)\s+رصيدك(?:\s+المتاح)?/g, "وحجز مؤقت مُحرَّر $1")
    .replace(/تعود\s+نقاطك\s+(?:ال)?محجوزة(?:\s+كاملة)?/g, "فهو حجز مؤقت مُحرَّر كاملًا")
    .replace(/\s*وأعدنا\s+نقاطك(?=$|[\s.،:])/g, ": حجز مؤقت مُحرَّر")
    // «تم استرداد كامل الرصيد المحجوز دون أي خصم», «تم إرجاع المبلغ المحجوز», «إعادة الرصيد المحجوز إلى حسابك»: the refund wording of request cards and activity lines
    .replace(/(?:تم\s+)?(?:استرداد|إرجاع|ارجاع|استرجاع|إعادة|اعادة|رد)\s+(كامل\s+)?(?:ال)?(?:رصيد|مبلغ|نقاط(?:ك)?)\s+(?:ال)?محجوز(?:ة)?(\s+كاملة)?(?:\s+(?:إلى|الى|لـ?|في)\s*(?:رصيدك|حسابك))?/g, (_m, whole1, whole2) => (whole1 || whole2 ? "حجز مؤقت مُحرَّر كاملًا" : "حجز مؤقت مُحرَّر"))
    // «إرجاع الحجز» (the wallet's line explanation) and «استرداد الحجز المؤقت»
    .replace(/(?:تم\s+)?(?:استرداد|إرجاع|ارجاع|استرجاع|إعادة|اعادة)\s+(?:ال)?حجز(?:\s+(?:ال)?مؤقت)?/g, "حجز مؤقت مُحرَّر")
    // the verb forms stored before the owner's rule: «حُرّر الحجز المؤقت», «حُرّر حجز مؤقت بقيمة X», «حُرّر حجزك المؤقت», «ويُحرَّر الباقي من الحجز المؤقت», «تحرير الحجز المؤقت»
    .replace(/حُرّر\s+(?:ال)?حجز(?:ك)?\s+(?:ال)?مؤقت/g, "حجز مؤقت مُحرَّر")
    .replace(/(?:و)?يُحرَّر\s+الباقي\s+من\s+الحجز\s+المؤقت/g, "والباقي حجز مؤقت مُحرَّر")
    .replace(/تحرير\s+(?:ال)?حجز\s+(?:ال)?مؤقت/g, "حجز مؤقت مُحرَّر")
    .replace(/تعذر\s+تحرير\s+الرصيد\s+المحجوز/g, "تعذر تأكيد الحجز المؤقت المُحرَّر")
    .replace(/\s{2,}/g, " ")
    .trim();
}
