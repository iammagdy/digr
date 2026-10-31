import { customerFormatLabelAr } from "@/lib/customerFormatLabels";

export const DEFAULT_Q = "استخرج لي بيانات حساب عام على تيك توك مع الإحصائيات العامة";

export const STATEMENTS = [
  { big: "تسأل بالعربية.", small: "بالفصحى أو بالعامية. المساعد يفهم السياق، ويوضّح معك التفاصيل التي تحدد الحجم والتكلفة." },
  { big: "توافق على السعر.", small: "خطة قابلة للتعديل وعرض سعر بالنقاط من النظام. لا يبدأ أي جمع قبل موافقتك الصريحة." },
  { big: "تستلم ملفاتك.", small: "ملف إكسل جاهز بالبيانات والمنهجية — وتدفع على النتائج المسلَّمة فعلًا فقط." },
];

export const SHEETS = [
  { name: "ورقة المنهجية", desc: "كيف جُمعت بياناتك وحدودها", z: 1, to: "translate(-52%,4%) rotate(-7deg)", delay: ".15s" },
  { name: customerFormatLabelAr("pdf"), desc: "ملخص تنفيذي", z: 2, to: "translate(52%,4%) rotate(7deg)", delay: ".15s" },
  { name: customerFormatLabelAr("xlsx"), desc: "البيانات ودليل الحقول", z: 3, to: "translateY(-6%)", delay: "0s" },
];
