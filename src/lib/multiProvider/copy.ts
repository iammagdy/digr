import { toArabicDigits } from "../arabicDigits";
import { countPlainAr } from "../planCounts";

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
  return `نجمع حتى ${countPlainAr(args.count, "records")} لشركات${scope ? ` (${scope})` : ""} من ${SOURCE_WORDING_AR}، وفي كل سجل: ${fields.join("، ")}.`;
}

/** Why no route is available, in customer words (no provider, no number). */
export const NO_ROUTE_AR = "هذا النوع من البحث غير متاح حاليًا. جرّب لاحقًا أو غيّر طلبك.";

// ---- Activity lines (the job_events mechanism): source, found, new vs duplicate, running total ----------------------------------

export function discoveryLineAr(args: { found: number; fresh: number; duplicate: number; total: number }): string {
  return `البحث في ${SOURCE_WORDING_AR}: وُجدت ${countPlainAr(args.found, "companies")}، منها ${n(args.fresh)} جديدة و${n(args.duplicate)} مكررة. الإجمالي حتى الآن ${countPlainAr(args.total, "companies")}.`;
}

export function discoveryEmptyLineAr(): string {
  return `البحث في ${SOURCE_WORDING_AR} لم يعد شركات جديدة، وننتقل إلى مصدر آخر متاح.`;
}

export function enrichLineAr(args: { read: number; verified: number; unverified: number; total: number }): string {
  return `قراءة صفحات التواصل العامة لـ ${countPlainAr(args.read, "companies")}: الموثّق منها ${n(args.verified)}، و${n(args.unverified)} لم يكتمل التحقق منه فلم يُحتسب. الإجمالي حتى الآن ${countPlainAr(args.total, "records")}.`;
}

export function skippedSitesLineAr(count: number): string {
  return `تخطّينا ${n(count)} موقع لأن صفحاته غير متاحة للعامة أو لا تسمح بالقراءة الآلية.`;
}

export function stageFallbackLineAr(): string {
  return `تعذّر الحصول على نتيجة من أحد ${SOURCE_WORDING_AR}، فجرّبنا مصدرًا آخر.`;
}

export function chainFinishedLineAr(args: { delivered: number }): string {
  return args.delivered > 0
    ? `اكتملت المعالجة: الموثّق منها ${countPlainAr(args.delivered, "records")}.`
    : "لم نجد سجلات موثّقة تطابق طلبك، ولن يُخصم أي رصيد.";
}

export function budgetStopLineAr(delivered: number): string {
  return delivered > 0
    ? `توقفنا عند الحد المسموح لهذه المعالجة، وسُلّم من الموثّق ${countPlainAr(delivered, "records")} ويُحتسب هذا العدد فقط.`
    : "توقفنا عند الحد المسموح لهذه المعالجة قبل العثور على سجلات موثّقة، ولن يُخصم أي رصيد.";
}

export function chainStopProgressLineAr(kind: "budget" | "no_more_work" | "target_reached"): string {
  if (kind === "budget") return "توقفنا عند الحد المسموح لهذه المعالجة.";
  if (kind === "no_more_work") return "توقف البحث عند حدود هذه المعالجة الحالية.";
  return "انتهى جمع الشركات الموثّقة لهذه المعالجة، وسيُعلن العدد النهائي بعد حفظ الملف النهائي.";
}

export const CHAIN_CARD_LIMITS_AR: readonly string[] = [
  "نجمع بيانات التواصل المنشورة للعامة على المواقع الرسمية للشركات فقط: صفحات التواصل وعن الشركة والفريق.",
  "قد لا يتوفر البريد الإلكتروني أو الهاتف لبعض الشركات، ولا نحتسب إلا الشركات التي تحققنا من الحقول المطلوبة فيها.",
  "لا نجمع عناوين المنازل ولا معلومات العائلة ولا الحسابات الخاصة ولا أي صفحة تتطلب تسجيل دخول.",
  "لا نضمن دقة تامة؛ نبذل أفضل جهد ممكن، وقد يكون عدد الشركات المسلَّمة أقل من المطلوب.",
];

export function chainGoalLineAr(args: { count: number; withEmail: boolean; withPhone: boolean; withDecisionMaker: boolean; industry?: string; country?: string }): string {
  const fields = [
    "اسم الشركة",
    "الموقع الإلكتروني",
    ...(args.withEmail ? ["البريد الإلكتروني المهني"] : []),
    ...(args.withPhone ? ["رقم الهاتف التجاري"] : []),
    ...(args.withDecisionMaker ? ["اسم ومسمى صاحب القرار إن كان معلنًا"] : []),
  ];
  const scope = [args.industry, args.country].filter((part) => typeof part === "string" && part.trim()).join(" في ");
  return `نجمع حتى ${countPlainAr(args.count, "companies")}${scope ? ` (${scope})` : ""} من ${SOURCE_WORDING_AR}، ومع كل شركة: ${fields.join("، ")}.`;
}

export function expectedTargetLineAr(args: { asked: number; fitted: number }): string {
  const fitted = Math.max(1, Math.floor(args.fitted));
  const asked = Math.max(fitted, Math.floor(args.asked));
  const TAIL = "وقد يكون العدد المسلَّم أقل من المستهدف لأسباب قد تتعلق بالمصادر المتاحة أو بحدود المعالجة، وسنذكر لك العدد الفعلي والسبب، ولا يُحتسب عليك إلا ما يُسلَّم.";
  if (asked === fitted) {
    return `العدد المستهدف تسليمه: ${countPlainAr(fitted, "companies")}، كما طلبت. ${TAIL}`;
  }
  const fittedTxt = countPlainAr(fitted, "companies");
  const askedTxt = countPlainAr(asked, "companies");
  return `العدد المستهدف تسليمه: ${fittedTxt} من أصل ${askedTxt} مطلوبة، لأن الحد الأقصى لحجز المهمة الواحدة لا يتسع لأكثر من ذلك. ${TAIL}`;
}

export type ChainRunnerStop = "budget" | "no_more_work" | "target_reached" | "coverage_end" | "sources_limited" | "stalled" | "work_limit";

export function chainShortfallReasonAr(args: { stop: ChainRunnerStop | null; callCap: string | null; excluded: number }): string {
  const excl = `استُبعد ${countPlainAr(args.excluded, "companies")} لأنه مكرر أو غير مطابق قبل اكتمال العدد.`;
  let primary: string | null = null;
  if (args.stop === "budget") {
    primary = "توقفنا عند الحد المسموح لتكلفة هذه المعالجة قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
  } else if (args.stop === "no_more_work") {
    primary = "توقفت المعالجة عند حدود البحث الحالية قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
  } else if (args.callCap === "page_cap") {
    primary = "توقفت المعالجة عند الحد الأقصى لعدد الدفعات المسموح لهذا الطلب قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
  } else if (args.callCap === "empty_pages" || args.callCap === "no_progress") {
    primary = "توقفت المعالجة لأن دفعتين متتاليتين لم تضيفا شركات موثّقة جديدة قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
  } else if (args.callCap === "source_repeats") {
    primary = "توقفت المعالجة لأن الدفعة الأخيرة أعادت شركات سبق تسليمها قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
  } else if (args.excluded > 0) {
    return excl;
  } else {
    return "لم يصلنا سبب محدد لتوقف المعالجة قبل اكتمال العدد.";
  }

  if (args.excluded > 0) {
    return `${primary} ${excl}`;
  }
  return primary;
}

export const ALL_CUSTOMER_STRINGS = (): string[] => [
  SOURCE_WORDING_AR, ...PLAN_LIMITS_AR, NO_ROUTE_AR,
  whatWeCollectAr({ count: 50, withEmail: true, withPhone: true, withDecisionMaker: true, industry: "مقاولات", country: "مصر" }),
  discoveryLineAr({ found: 10, fresh: 8, duplicate: 2, total: 8 }), discoveryEmptyLineAr(),
  enrichLineAr({ read: 8, verified: 3, unverified: 5, total: 3 }), skippedSitesLineAr(2), stageFallbackLineAr(),
  chainFinishedLineAr({ delivered: 3 }), chainFinishedLineAr({ delivered: 0 }), budgetStopLineAr(2), budgetStopLineAr(0),
  chainStopProgressLineAr("budget"), chainStopProgressLineAr("no_more_work"), chainStopProgressLineAr("target_reached"),
  ...CHAIN_CARD_LIMITS_AR,
  chainGoalLineAr({ count: 50, withEmail: true, withPhone: true, withDecisionMaker: true, industry: "مقاولات", country: "مصر" }),
  expectedTargetLineAr({ asked: 50, fitted: 50 }),
  expectedTargetLineAr({ asked: 50, fitted: 41 }),
  chainShortfallReasonAr({ stop: "budget", callCap: null, excluded: 0 }),
  chainShortfallReasonAr({ stop: "no_more_work", callCap: null, excluded: 0 }),
  chainShortfallReasonAr({ stop: null, callCap: "page_cap", excluded: 0 }),
  chainShortfallReasonAr({ stop: null, callCap: "empty_pages", excluded: 0 }),
  chainShortfallReasonAr({ stop: null, callCap: "source_repeats", excluded: 0 }),
  chainShortfallReasonAr({ stop: null, callCap: null, excluded: 3 }),
  chainShortfallReasonAr({ stop: null, callCap: null, excluded: 0 }),
];
