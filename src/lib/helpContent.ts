import { PRICING_FAQ_AR } from "./pricingPage";
import { FAILURE_STATE_AR } from "./publicCopy";
import { SUPPORT_EMAIL } from "./site";

/**
 * THE HELP PAGE «مركز المساعدة»: plain Arabic, in the customer's own words. The points and refund sentences are the site's own (the pricing page's answers), imported, not retyped, so the help page can
 * never say something the prices page does not. Pure data: the page only draws it.
 */
export interface HelpSection { id: string; titleAr: string; paragraphsAr: string[] }

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: "ask",
    titleAr: "كيف أطلب؟",
    paragraphsAr: [
      "اكتب طلبك بكلماتك في «المساعد البحثي»، أو اختر مثالًا من الأمثلة تحت خانة الكتابة واملأ حقوله القليلة ثم اضغط «أرسل».",
      "اذكر ما تريده بالتحديد: ما نوع البيانات، ومن أي حساب أو موضوع أو نشاط، وكم العدد، وفي أي فترة. كلما كان الطلب أوضح كانت الخطة أدق.",
      "بعد إرسال الطلب نجهّز لك خطة بسعرها. لن يبدأ أي جمع ولن يُخصم أي شيء قبل أن تراجع الخطة وتعتمدها.",
    ],
  },
  {
    id: "points",
    titleAr: "كيف تعمل النقاط؟",
    paragraphsAr: [
      "رصيدك بالنقاط، ونقطة واحدة تساوي ٠٫١٠ ج.م. تشحن رصيدك من «المحفظة».",
      PRICING_FAQ_AR[0][1],
      PRICING_FAQ_AR[3][1],
    ],
  },
  {
    id: "approval",
    titleAr: "ماذا يحدث عند الاعتماد؟",
    paragraphsAr: [
      "في بطاقة الخطة تجد ما ستستلمه والعدد والفترة والسعر والحجز المؤقت. اضغط «اعتمد» لتبدأ المهمة، أو «عدّل الطلب» لتغيّر العدد أو الفترة أو الأعمدة قبل الاعتماد.",
      "بعد الاعتماد تظهر في البطاقة حالة المهمة وما وصلك منها حتى الآن، ويمكنك إغلاق الصفحة؛ نرسل لك إشعارًا عند الانتهاء.",
    ],
  },
  {
    id: "files",
    titleAr: "كيف أستلم ملفاتي؟",
    paragraphsAr: [
      "عند اكتمال المهمة تجد ملف إكسل جاهزًا للتنزيل في بطاقة المهمة وفي صفحة «طلباتي»، مع التفاصيل التي وصلتك.",
      "ملفاتك متاحة للتنزيل لمدة ٩٠ يومًا. افتح «طلباتي» واضغط «التفاصيل» لترى حالة أي طلب ونتيجته.",
    ],
  },
  {
    id: "refunds",
    titleAr: "ماذا لو وصلني أقل مما طلبت أو تعذّر الطلب؟",
    paragraphsAr: [PRICING_FAQ_AR[1][1], FAILURE_STATE_AR],
  },
] as const;

/** The support line under the help sections. */
export const HELP_SUPPORT_LINE_AR = "لم تجد ما تبحث عنه؟ اكتب لنا وسنرد على بريدك الإلكتروني.";
export { SUPPORT_EMAIL as HELP_SUPPORT_EMAIL };
