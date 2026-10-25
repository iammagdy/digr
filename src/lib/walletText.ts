import { normalizeReleaseWording } from "./releaseWording";
/**
 * Wallet text is Arabic only: no Latin product names and no internal id. Old ledger notes were written with both
 * («شراء صياغة المنهجية الأكاديمية للطلب job_quote_…»); the stored rows are never rewritten, they are cleaned when shown.
 */
const INTERNAL_ID = /\b(?:job_quote|job|quote|res|rel|chg|top|promo|adm|conv|msg|usr)_[A-Za-z0-9-]{4,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{20,}\b/gi;

/**
 * What the customer reads for one of their top-up requests. The stored reference («rcpt_…») is an internal id: it is never shown, the row
 * carries this plain label instead.
 */
export const TOPUP_REQUEST_LABEL_AR = "طلب شحن عبر إنستاباي";

/**
 * Product names in Latin letters become their Arabic spelling; a released hold is ONLY «حجز مؤقت مُحرَّر». The banned forms, read as that when an old row is shown:
 * «تحرير حجز / تحرير الحجز المؤقت», the verb «حُرّر الحجز المؤقت / حُرّر حجز مؤقت / حُرّر حجزك المؤقت», «يُحرَّر الباقي من الحجز المؤقت» and every refund word («استرداد», «إرجاع»).
 */
export const BANNED_RELEASE_FORMS_AR = ["تحرير حجز", "تحرير الحجز المؤقت", "حُرّر الحجز المؤقت", "حُرّر حجز مؤقت", "حُرّر حجزك المؤقت", "يُحرَّر الباقي", "استرداد", "إرجاع"] as const;
export function walletDisplayText(text: unknown): string {
  // the same normalizer as the notices, request cards and activity lines: every refund word of an old stored row reads «حجز مؤقت مُحرَّر»
  return normalizeReleaseWording(text)
    .replace(/تحرير\s+(?:ال)?حجز\s+المؤقت|تحرير\s+حجز\s+مؤقت/g, "حجز مؤقت مُحرَّر")
    .replace(/حُرّر\s+(?:ال)?حجز(?:ك)?\s+(?:ال)?مؤقت/g, "حجز مؤقت مُحرَّر")
    .replace(/(?:و)?يُحرَّر\s+الباقي\s+من\s+الحجز\s+المؤقت/g, "والباقي حجز مؤقت مُحرَّر")
    .replace(/\s*\(\s*IPA\s*\)/g, "")
    .replace(/\bIPA\b/g, "الدفع اللحظي")
    .replace(/\bInsta\s?pay\b/gi, "إنستاباي")
    .replace(/انستاباي/g, "إنستاباي")
    .replace(/\bDiger\b/g, "ديجر")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * A ledger note as the customer reads it: the internal order id is replaced by plain words, Latin product names are spelled in
 * Arabic, and a note that still has Latin letters after that is dropped (the row keeps its Arabic label).
 */
export function walletNoteForDisplay(note: unknown): string {
  let text = String(note ?? "");
  if (!text.trim()) return "";
  text = text.replace(new RegExp(`\\s*للطلب\\s+(?:${INTERNAL_ID.source})`, "gi"), " لطلبك");
  text = text.replace(INTERNAL_ID, " ");
  text = walletDisplayText(text).replace(/\s*[·:\-–]\s*$/, "").trim();
  return /[A-Za-z]/.test(text) ? "" : text;
}
