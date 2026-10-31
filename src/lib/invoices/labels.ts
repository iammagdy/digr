import type { Currency, DocStatus, DocType } from "./types";

/** «فاتورة» only: a document is never labelled a tax invoice anywhere. */
export const DOC_TYPE_AR: Record<DocType, string> = { quote: "عرض سعر", invoice: "فاتورة" };
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
