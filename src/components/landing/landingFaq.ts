import { PRICING_FAQ_AR } from "@/lib/pricingPage";

/** The short FAQ of the home page: price, legality, partial delivery, top-up. The price and partial-delivery answers are the pricing page's own sentences. */
export const FAQS: [string, string][] = [
  ["كم يكلّف طلبي؟", PRICING_FAQ_AR[0][1]],
  ["هل جمع البيانات من المصادر المتاحة قانوني؟", "نجمع البيانات من المصادر المتاحة فقط ولا نحاول الوصول إلى محتوى خاص. مسؤولية الاستخدام تخضع لشروط كل منصة وللقوانين المطبقة في بلدك، ونوصي بمراجعة سياسة المصدر قبل نشر النتائج."],
  ["ماذا لو وصلني أقل مما طلبت؟", PRICING_FAQ_AR[1][1]],
  ["كيف أشحن رصيدي؟", "من صفحة الرصيد تجد بيانات الدفع المعتمدة. بعد التحويل تُدخل الرقم المرجعي وصورة الإيصال، وتتم المراجعة واعتماد الرصيد في محفظتك."],
];
