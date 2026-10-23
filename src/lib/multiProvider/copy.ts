import { toArabicDigits } from "../arabicDigits";

/**
 * Every customer-facing sentence of the multi-provider feature. Arabic only, Arabic-Indic digits, no emoji, and never a provider name,
 * a capability or endpoint id, a USD figure, a model vendor or an internal id. The customer's word for where the data comes from is
 * «مصادر متاحة». A test scans every string this module can produce (and the customer routes) for those leaks.
 */
export const SOURCE_WORDING_AR = "مصادر متاحة";

const n = (value: number) => toArabicDigits(Math.max(0, Math.floor(value)));

/** The honest limits shown BEFORE approval on the plan card. */
export const PLAN_LIMITS_AR: readonly string[] = [
  "نجمع بيانات التواصل المنشورة للعامة على المواقع الرسمية للشركات فقط: صفحات التواصل وعن الشركة والفريق.",
  "قد لا يتوفر البريد الإلكتروني أو الهاتف لبعض الشركات، ولا نحتسب إلا السجلات التي تحققنا من الحقول المطلوبة فيها.",
  "لا نجمع عناوين المنازل ولا معلومات العائلة ولا الحسابات الخاصة ولا أي صفحة تتطلب تسجيل دخول.",
  "لا نضمن دقة تامة؛ نبذل أفضل جهد ممكن، وقد يكون عدد السجلات المسلّمة أقل من المطلوب.",
];

export function whatWeCollectAr(args: { count: number; withEmail: boolean; withPhone: boolean; withDecisionMaker: boolean; industry?: string; country?: string }): string {
  const fields = [
    "اسم الشركة",
    "الموقع الإلكتروني",
    ...(args.withEmail ? ["البريد الإلكتروني المهني"] : []),
    ...(args.withPhone ? ["رقم الهاتف التجاري"] : []),
    ...(args.withDecisionMaker ? ["اسم ومسمى صاحب القرار إن كان معلنًا"] : []),
  ];
  const scope = [args.industry, args.country].filter((part) => typeof part === "string" && part.trim()).join(" في ");
  return `نجمع حتى ${n(args.count)} سجل لشركات${scope ? ` (${scope})` : ""} من ${SOURCE_WORDING_AR}، وفي كل سجل: ${fields.join("، ")}.`;
}

/** Why no route is available, in customer words (no provider, no number). */
export const NO_ROUTE_AR = "هذا النوع من البحث غير متاح حاليًا. جرّب لاحقًا أو غيّر طلبك.";

// ---- Activity lines (the job_events mechanism): source, found, new vs duplicate, running total ----------------------------------

export function discoveryLineAr(args: { found: number; fresh: number; duplicate: number; total: number }): string {
  return `البحث في ${SOURCE_WORDING_AR}: وُجدت ${n(args.found)} شركة، منها ${n(args.fresh)} جديدة و${n(args.duplicate)} مكررة. الإجمالي حتى الآن ${n(args.total)} شركة.`;
}

export function discoveryEmptyLineAr(): string {
  return `البحث في ${SOURCE_WORDING_AR} لم يعد شركات جديدة، وننتقل إلى مصدر آخر متاح.`;
}

export function enrichLineAr(args: { read: number; verified: number; unverified: number; total: number }): string {
  return `قراءة صفحات التواصل العامة لـ ${n(args.read)} شركة: ${n(args.verified)} سجل موثّق و${n(args.unverified)} لم يكتمل التحقق منه فلم يُحتسب. الإجمالي حتى الآن ${n(args.total)} سجل.`;
}

export function skippedSitesLineAr(count: number): string {
  return `تخطّينا ${n(count)} موقع لأن صفحاته غير متاحة للعامة أو لا تسمح بالقراءة الآلية.`;
}

export function stageFallbackLineAr(): string {
  return `تعذّر الحصول على نتيجة من أحد ${SOURCE_WORDING_AR}، فجرّبنا مصدرًا آخر.`;
}

export function chainFinishedLineAr(args: { delivered: number }): string {
  return args.delivered > 0
    ? `اكتملت المعالجة: ${n(args.delivered)} سجل موثّق.`
    : "لم نجد سجلات موثّقة تطابق طلبك، ولن يُخصم أي رصيد.";
}

export function budgetStopLineAr(delivered: number): string {
  return delivered > 0
    ? `توقفنا عند الحد المسموح لهذه المعالجة، وسُلّم ${n(delivered)} سجل موثّق ويُحتسب هذا العدد فقط.`
    : "توقفنا عند الحد المسموح لهذه المعالجة قبل العثور على سجلات موثّقة، ولن يُخصم أي رصيد.";
}

export const ALL_CUSTOMER_STRINGS = (): string[] => [
  SOURCE_WORDING_AR, ...PLAN_LIMITS_AR, NO_ROUTE_AR,
  whatWeCollectAr({ count: 50, withEmail: true, withPhone: true, withDecisionMaker: true, industry: "مقاولات", country: "مصر" }),
  discoveryLineAr({ found: 10, fresh: 8, duplicate: 2, total: 8 }), discoveryEmptyLineAr(),
  enrichLineAr({ read: 8, verified: 3, unverified: 5, total: 3 }), skippedSitesLineAr(2), stageFallbackLineAr(),
  chainFinishedLineAr({ delivered: 3 }), chainFinishedLineAr({ delivered: 0 }), budgetStopLineAr(2), budgetStopLineAr(0),
];
