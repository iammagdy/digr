import { pointsAr } from "./pointsFormat";

/**
 * The activity line written when a job settles. The ledger records TWO rows at settlement: the WHOLE hold released, then the charge of
 * what was delivered. The line says exactly that (never «the remainder only»), and the net amount that is back in the balance. Never
 * «استرداد» or «حجز مؤقت مُحرَّر»: a returned hold is «رجع لمحفظتك» (Megz D-0187).
 */
export function settlementEventAr(input: { reservedPoints: number; chargedPoints: number }, digits: (value: string | number) => string): string {
  const reserved = Math.max(0, Math.round(Number(input.reservedPoints) || 0));
  const charged = Math.max(0, Math.min(reserved, Math.round(Number(input.chargedPoints) || 0)));
  const back = reserved - charged;
  if (charged === 0) return `لم يُخصم شيء، ورجع لمحفظتك ${pointsAr(reserved, digits)}.`;
  return `حُجز ${pointsAr(reserved, digits)}، وخُصم ثمن ما سُلّم فقط (${pointsAr(charged, digits)})، ورجع لمحفظتك ${pointsAr(back, digits)}.`;
}

/** `record_chunk_failure` (SQL) stores «Exceeded maximum retry attempts (5): <cause>» on the fifth failure; screens read the text through normalizeReleaseWording, which strips that English prefix. */
export function stripRetryPrefix(t: string): string {
  return t.replace(/^Exceeded maximum retry attempts \(\d+\):\s*/, "");
}

/**
 * A released hold is «حجز مؤقت مُحرَّر», always. Old job messages (stored before this rule, and written by the worker for failures) say
 * «تم إرجاع النقاط المحجوزة إلى رصيدك», «أُعيدت النقاط المحجوزة», «استرداد…»: the stored text is never rewritten; it is read through this on the
 * request cards and the activity panel, so the customer sees one wording and the ledger lines say the same.
 */
export function normalizeReleaseWording(text: unknown): string {
  return stripRetryPrefix(String(text ?? ""))
    // «تم إرجاع (كامل) النقاط المحجوزة (كاملة) (إلى رصيدك)» and its spellings
    .replace(/(?:تم\s+)?(?:إرجاع|ارجاع|استرداد|استرجاع|رد)\s+(?:كامل\s+)?(?:ال)?نقاط(?:ك)?\s+(?:ال)?محجوزة(?:\s+كاملة)?(?:\s+(?:إلى|الى|لـ?|في)\s*(?:رصيدك|حسابك))?/g, "رجع لمحفظتك كاملًا")
    .replace(/(?:أُعيدت|أعيدت|رجعت)\s+(?:ال)?نقاط\s+(?:ال)?محجوزة(?:\s+كاملة)?(?:\s+(?:إلى|الى)\s+رصيدك)?/g, "رجع لمحفظتك كاملًا")
    .replace(/وإرجاع\s+(?:كامل\s+)?(?:ال)?نقاط\s+(?:ال)?محجوزة/g, "ورجع لمحفظتك كاملًا")
    .replace(/(?:وأُعيد|وأعيد)\s+(?:ال)?رصيد\s+(?:ال)?محجوز/g, "ورجع لمحفظتك")
    .replace(/(?:أُعيد|أعيد)\s+(?:ال)?رصيد\s+(?:ال)?محجوز/g, "رجع لمحفظتك")
    .replace(/(?:تم\s+)?(?:إرجاع|استرداد|استرجاع)\s+(?:ال)?رصيد\s+(?:ال)?محجوز/g, "رجع لمحفظتك")
    // the notices stored before the wording rule: «فأعدنا نقاطك المحجوزة كاملة لرصيدك», «أعدنا ٣٠ نقطة محجوزة كاملة إلى رصيدك», «وعادت ٤٨ نقطة إلى رصيدك»
    .replace(/(?:ف|و)?أعدنا\s+نقاطك\s+(?:ال)?محجوزة(?:\s+كاملة)?\s+(?:إلى|الى|ل)\s*رصيدك/g, "رجع لمحفظتك كاملًا")
    .replace(/(?:ف|و)?أعدنا\s+([٠-٩0-9٬,]+\s+نقطة|نقطة واحدة|نقطتين|[٠-٩0-9٬,]+\s+نقاط)\s+محجوزة(?:\s+كاملة)?\s+(?:إلى|الى)\s+رصيدك/g, "رجع لمحفظتك $1 كاملًا")
    .replace(/وعاد(?:ت)?\s+([٠-٩0-9٬,]+\s+(?:نقطة|نقاط)|نقطة واحدة|نقطتين)\s+(?:إلى|الى)\s+رصيدك(?:\s+المتاح)?/g, "ورجع لمحفظتك $1")
    .replace(/تعود\s+نقاطك\s+(?:ال)?محجوزة(?:\s+كاملة)?/g, "فهو رجع لمحفظتك كاملًا")
    .replace(/\s*وأعدنا\s+نقاطك(?=$|[\s.،:])/g, ": رجع لمحفظتك")
    // «تم استرداد كامل الرصيد المحجوز دون أي خصم», «تم إرجاع المبلغ المحجوز», «إعادة الرصيد المحجوز إلى حسابك»: the refund wording of request cards and activity lines
    .replace(/(?:تم\s+)?(?:استرداد|إرجاع|ارجاع|استرجاع|إعادة|اعادة|رد)\s+(كامل\s+)?(?:ال)?(?:رصيد|مبلغ|نقاط(?:ك)?)\s+(?:ال)?محجوز(?:ة)?(\s+كاملة)?(?:\s+(?:إلى|الى|لـ?|في)\s*(?:رصيدك|حسابك))?/g, (_m, whole1, whole2) => (whole1 || whole2 ? "رجع لمحفظتك كاملًا" : "رجع لمحفظتك"))
    // «إرجاع الحجز» (the wallet's line explanation) and «استرداد الحجز المؤقت»
    .replace(/(?:تم\s+)?(?:استرداد|إرجاع|ارجاع|استرجاع|إعادة|اعادة)\s+(?:ال)?حجز(?:\s+(?:ال)?مؤقت)?/g, "رجع لمحفظتك")
    // the verb forms stored before the owner's rule: «حُرّر الحجز المؤقت», «حُرّر حجز مؤقت بقيمة X», «حُرّر حجزك المؤقت», «ويُحرَّر الباقي من الحجز المؤقت», «تحرير الحجز المؤقت»
    .replace(/حُرّر\s+(?:ال)?حجز(?:ك)?\s+(?:ال)?مؤقت/g, "رجع لمحفظتك")
    .replace(/(?:و)?يُحرَّر\s+الباقي\s+من\s+الحجز\s+المؤقت/g, "والباقي رجع لمحفظتك")
    .replace(/تحرير\s+(?:ال)?حجز\s+(?:ال)?مؤقت/g, "رجع لمحفظتك")
    .replace(/تعذر\s+تحرير\s+الرصيد\s+المحجوز/g, "تعذر تأكيد الحجز المؤقت المُحرَّر")
    .replace(/(?:و)?حجز\s+مؤقت\s+(?:مُحرَّر|محرر)(?:ًا|ا)?\s+كاملًا/g, (m) => m.startsWith("و") ? "ورجع لمحفظتك كاملًا" : "رجع لمحفظتك كاملًا")
    .replace(/(?:و)?حجز\s+مؤقت\s+(?:مُحرَّر|محرر)(?:ًا|ا)?/g, (m) => m.startsWith("و") ? "ورجع لمحفظتك" : "رجع لمحفظتك")
    .replace(/\s{2,}/g, " ")
    .trim();
}
