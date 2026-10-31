import { toArabicDigits } from "./arabicDigits";

/** The methodology add-on's price in points, as shown to the customer. The charge itself is made by the server (`/api/jobs/[id]/methodology`). */
export const METHODOLOGY_POINTS = 10;

/**
 * Whether the methodology add-on is offered for a job: it needs at least one delivered record (a partial delivery counts) and a
 * finished job; a request that delivered nothing has nothing to document, and a running one is not complete yet. The offer does
 * not depend on which files the job produced: the document is generated from the saved data on request.
 */
export function methodologyOffered(job: { status?: unknown; delivered?: unknown; savedRows?: unknown } | null | undefined): boolean {
  const status = String(job?.status || "").toLowerCase();
  if (!(["done", "completed"].includes(status) && Number(job?.delivered) > 0)) return false;
  // `savedRows`: the rows the results panel loaded from the job's saved data (`/api/jobs/<id>/data`, which reads the very file the purchase reads). The document is written from that saved data, so a job with
  // none (a mission-era job keeps its results in the workbook, not in that file) would get «لم يتم خصم أي نقاط» after the customer confirmed: the offer is then not shown at all. Left out = not checked.
  if (job && "savedRows" in job && !(Number(job.savedRows) > 0)) return false;
  return true;
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

/**
 * What a plan card says about the PDF, in one sentence: whether it is part of this plan's files at no extra charge, or not part of it, and in both
 * cases that the full official methodology document is a separate, optional purchase after delivery (the same price the results panel shows).
 */
export function planPdfLineAr(outputFormats: string[] | undefined | null): string {
  const points = toArabicDigits(METHODOLOGY_POINTS);
  const hasPdf = !outputFormats || outputFormats.length === 0 || outputFormats.includes("pdf");
  return hasPdf
    ? `ملف بي دي إف مشمول في سعر هذه الخطة بلا رسوم إضافية؛ أما المنهجية الرسمية المفصّلة فاختيارية بعد التسليم مقابل ${points} نقاط.`
    : `هذه الخطة بلا ملف بي دي إف؛ ويمكنك بعد التسليم طلب المنهجية الرسمية بي دي إف مقابل ${points} نقاط.`;
}
