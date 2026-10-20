/**
 * Wallet text is Arabic only: no Latin product names and no internal id. Old ledger notes were written with both
 * («شراء صياغة المنهجية الأكاديمية للطلب job_quote_…»); the stored rows are never rewritten, they are cleaned when shown.
 */
const INTERNAL_ID = /\b(?:job_quote|job|quote|res|rel|chg|top|promo|adm|conv|msg|usr)_[A-Za-z0-9-]{4,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{20,}\b/gi;

/** Product names in Latin letters become their Arabic spelling. */
export function walletDisplayText(text: unknown): string {
  return String(text ?? "")
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
