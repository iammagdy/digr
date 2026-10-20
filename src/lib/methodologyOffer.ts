import { toArabicDigits } from "./arabicDigits";

/** The methodology add-on's price in points, as shown to the customer. The charge itself is made by the server (`/api/jobs/[id]/methodology`). */
export const METHODOLOGY_POINTS = 10;

/**
 * Whether the methodology add-on is offered for a job: it needs at least one delivered record (a partial delivery counts) and a
 * finished job; a request that delivered nothing has nothing to document, and a running one is not complete yet. The offer does
 * not depend on which files the job produced: the document is generated from the saved data on request.
 */
export function methodologyOffered(job: { status?: unknown; delivered?: unknown } | null | undefined): boolean {
  const status = String(job?.status || "").toLowerCase();
  return ["done", "completed"].includes(status) && Number(job?.delivered) > 0;
}

const ASKS_FOR_METHODOLOGY = /(?:منهجي[هة]|methodology)/i;
const ASKS_FOR_A_DOCUMENT = /(?:ملف|تقرير|مستند|وثيق[هة]|pdf|بي\s*دي\s*اف|اكتب|اكتبي|صياغ[هة]|اطلب|حمل|نزل|هات|عايز|عاوز|اريد|ابغى|ابي|محتاج|اعمل|جهز)/i;

function plain(text: string): string {
  return String(text || "").replace(/[ً-ٰٟـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").toLowerCase();
}

/** A message that asks for the methodology document («ملف المنهجية», «تقرير المنهجية PDF», «اكتب المنهجية»…). */
export function asksForMethodology(message: string): boolean {
  const text = plain(message);
  return ASKS_FOR_METHODOLOGY.test(text) && ASKS_FOR_A_DOCUMENT.test(text);
}

/** The answer when the conversation has no delivered result yet: there is nothing to document, and no plan or price is started. */
export function methodologyUnavailableAr(): string {
  return "ملف المنهجية يُكتب لنتائج طلب سُلّم لك؛ بعد أن يصلك سجل واحد على الأقل ستجد زر «اكتب المنهجية الرسمية» في تبويب «الملفات» بلوحة النتائج.";
}

/** The answer to that request, by code: where to press and what it costs. */
export function methodologyAnswerAr(): string {
  return `ملف المنهجية متاح من لوحة النتائج: افتح تبويب «الملفات» ثم اضغط «اكتب المنهجية الرسمية»، وتكلفته ${toArabicDigits(METHODOLOGY_POINTS)} نقاط ولا تُخصم إلا بعد تأكيدك داخل الصفحة.`;
}

/** The ledger row that records a methodology purchase for a job: the single source of truth for "already purchased". */
export function methodologyChargeId(jobId: string): string {
  return `chg_meth_${jobId}`;
}

/** The answer when the methodology was already bought for the delivered job: where the download button is, and that nothing is charged again. */
export function methodologyPurchasedAr(): string {
  return "اشتريت ملف المنهجية لهذا الطلب من قبل؛ ستجد زر «تحميل المنهجية» في تبويب «الملفات» بلوحة النتائج، ولن يُخصم شيء مرة أخرى.";
}
