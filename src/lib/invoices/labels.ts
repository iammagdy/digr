import type { Currency, DocStatus, DocType } from "./types";

/** «فاتورة» only: a document is never labelled a tax invoice anywhere. */
export const DOC_TYPE_AR: Record<DocType, string> = { quote: "عرض سعر", invoice: "فاتورة", statement: "بيان بيانات" };
/** The title printed on a data statement. */
export const STATEMENT_TITLE_AR = "بيان بالبيانات المستخرجة";
export const STATUS_AR: Record<DocStatus, string> = { draft: "مسودة", sent: "مرسلة", paid: "مدفوعة", void: "ملغية" };
export const CURRENCY_AR: Record<Currency, string> = { usd: "دولار", points: "نقطة", egp: "جنيه" };
export const CURRENCY_ORDER: Currency[] = ["usd", "points", "egp"];

export const ROUNDING_NOTE_AR = "إجمالي كل بند محسوب ومقرَّب مرة واحدة على مستوى البند، وقد يختلف عن الكمية × سعر الوحدة بفارق تقريب.";

export const CONFIRM_AR = {
  sent: {
    title: "إرسال الوثيقة",
    body: "بعد الإرسال تُقفل الوثيقة: لا يمكن تعديل البنود أو الأسعار أو سعر الصرف أو بيانات العميل. تُثبَّت الأرقام كما هي الآن. التصحيح يكون بإلغاء الوثيقة ونسخها كوثيقة جديدة.",
    action: "نعم، أرسل",
  },
  paid: {
    title: "تسجيل الدفع",
    body: "سيُسجَّل أن هذه الفاتورة مدفوعة بالتاريخ والمرجع أدناه، ولا يمكن التراجع عن ذلك. لا تُضاف أي نقاط إلى أي محفظة.",
    action: "نعم، سجّل الدفع",
  },
  void: {
    title: "إلغاء الوثيقة",
    body: "ستصبح الوثيقة ملغية ولا يمكن التراجع عن ذلك. للتصحيح انسخها كوثيقة جديدة بعد الإلغاء.",
    action: "نعم، ألغِ",
  },
} as const;

/**
 * The name of an exported file (and of the PDF the print dialog proposes): «فاتورة INV-2026-0002», «بيان STM-2026-0001», «عرض سعر QUO-2026-0003»; a draft has no number yet: «مسودة فاتورة».
 * Characters a file name cannot hold are dropped; the number stays as it is stored (ASCII), so it can be searched and sorted.
 */
export function exportFileBase(doc: { docType: DocType; number: string }): string {
  const word = DOC_TYPE_AR[doc.docType] === "بيان بيانات" ? "بيان" : DOC_TYPE_AR[doc.docType];
  const number = doc.number.trim();
  const base = number === "" ? `مسودة ${word}` : `${word} ${number}`;
  return base.replace(/[\\/:*?"<>|\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
}
/** one page: «فاتورة INV-2026-0002.png»; several: «فاتورة INV-2026-0002 - 2.png» */
export const pngFileName = (base: string, page: number, pages: number): string => (pages <= 1 ? `${base}.png` : `${base} - ${page}.png`);
