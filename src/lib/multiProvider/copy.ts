import { toArabicDigits } from "../arabicDigits";
import { countPlainAr } from "../planCounts";
import { pointsAr } from "../pointsFormat";

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

export function chainStopProgressLineAr(kind: ChainRunnerStop): string {
  if (kind === "budget") return "توقفنا عند الحد المسموح لهذه المعالجة.";
  if (kind === "no_more_work") return "توقف البحث عند حدود هذه المعالجة الحالية.";
  if (kind === "coverage_end") return "انتهت صيغ البحث المحددة لدينا في مصادر متاحة (٨ صيغ لكل مصدر بحث).";
  if (kind === "sources_limited") return "توقفنا لأن بعض مصادر متاحة لم تكن متاحة أو لم تُجب أو بلغت حدّها المسموح.";
  if (kind === "stalled") return "توقفنا لأن المعالجة لم تتقدم في الوقت المسموح.";
  if (kind === "work_limit") return "توقفنا عند الحد الأقصى لحجم العمل المسموح لهذه المعالجة.";
  return "انتهى جمع الشركات الموثّقة لهذه المعالجة، وسيُعلن العدد النهائي بعد حفظ الملف النهائي.";
}

export const CHAIN_CARD_LIMITS_AR: readonly string[] = [
  "نجمع بيانات التواصل المنشورة للعامة على المواقع الرسمية للشركات فقط: صفحات التواصل وعن الشركة والفريق.",
  "قد لا يتوفر البريد الإلكتروني أو الهاتف لبعض الشركات، ولا نحتسب إلا الشركات التي تحققنا من الحقول المطلوبة فيها.",
  "لا نجمع عناوين المنازل ولا معلومات العائلة ولا الحسابات الخاصة ولا أي صفحة تتطلب تسجيل دخول.",
  "لا نضمن دقة تامة؛ نبذل أفضل جهد ممكن، وقد يكون عدد الشركات المسلَّمة أقل من المطلوب.",
];

export const CHAIN_CARD_LIMITS_V2_AR: readonly string[] = [
  "نجمع بيانات التواصل المنشورة للعامة على المواقع الرسمية للشركات ومن مصادر بيانات تجارية متاحة.",
  "عمودا النشاط والدولة في الملف يعكسان معايير بحثك، ولا يُتحقق منهما لكل شركة على حدة.",
  ...CHAIN_CARD_LIMITS_AR.slice(1),
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

export function chainShortfallReasonAr(args: { stop: ChainRunnerStop | null; callCap: string | null; excluded: number; skippedOrigins?: number }): string {
  const excl = `استُبعد ${countPlainAr(args.excluded, "companies")} لأنه مكرر أو غير مطابق قبل اكتمال العدد.`;
  let primary: string | null = null;
  if (args.stop === "budget") {
    primary = "توقفنا عند الحد المسموح لتكلفة هذه المعالجة قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
  } else if (args.stop === "no_more_work") {
    primary = "توقفت المعالجة عند حدود البحث الحالية قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
  } else if (args.stop === "coverage_end") {
    primary = "السبب: أنهينا صيغ البحث المحددة لدينا في مصادر متاحة (٨ صيغ لكل مصدر بحث). هذا حدّ لنطاق بحثنا، ولا يعني أنه لا توجد شركات أخرى مطابقة.";
  } else if (args.stop === "sources_limited") {
    primary = "السبب: بعض مصادر متاحة لم تكن متاحة أو لم تُجب أو بلغت حدّها المسموح قبل اكتمال العدد، فلم نبحث فيها بالكامل، وقد توجد شركات أخرى مطابقة لم نصل إليها." + ((args.skippedOrigins ?? 0) > 0 ? ` وتخطينا ${countPlainAr(args.skippedOrigins ?? 0, "companies")} لأن عنوانها غير مدعوم.` : "");
  } else if (args.stop === "stalled") {
    primary = "السبب: لم تتقدم المعالجة في الوقت المسموح قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
  } else if (args.stop === "work_limit") {
    primary = "السبب: بلغنا الحد الأقصى المسموح لحجم العمل في هذه المعالجة (عدد عمليات البحث والقراءة أو مدتها أو عدد مرات إعادة التشغيل) قبل اكتمال العدد، وقد توجد شركات أخرى مطابقة لم نصل إليها.";
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

export function chainZeroDeliveryReasonAr(args: { target: number; stop: ChainRunnerStop | null }): string {
  return `المسلَّم ${n(0)} من ${toArabicDigits(args.target)} مطلوب. ${args.stop ? chainShortfallReasonAr({ stop: args.stop, callCap: null, excluded: 0 }) : "السبب: لم يصلنا سبب محدد لتوقف المعالجة قبل اكتمال العدد."}`;
}

export function chainFailureReasonAr(kind: "spend" | "cursor" | "lease"): string {
  if (kind === "spend") return "السبب: تعذّر التحقق من الحد المسموح لتكلفة هذا الطلب فتوقفنا احتياطًا قبل اكتمال العدد.";
  if (kind === "cursor") return "السبب: تعذّر حفظ حالة البحث بشكل آمن فتوقفنا احتياطًا قبل اكتمال العدد.";
  return "السبب: تعذّر التأكد من سلامة تنفيذ هذه المعالجة فتوقفنا احتياطًا قبل اكتمال العدد.";
}

export function staleReleaseReasonAr(target: number): string {
  return `المسلَّم ${n(0)} من ${toArabicDigits(target)} مطلوب. السبب: توقفت المعالجة عن التقدم قبل اكتمال العدد، وهو حجز مؤقت مُحرَّر كاملًا ولم يُخصم منك شيء.`;
}

export function operatorReleaseReasonAr(target: number): string {
  return `المسلَّم ${n(0)} من ${toArabicDigits(target)} مطلوب. السبب: أوقفنا معالجة هذا الطلب من جانبنا قبل اكتمال العدد، وهو حجز مؤقت مُحرَّر كاملًا ولم يُخصم منك شيء.`;
}

export type GroupCloseReason = "all_parts_done" | "deadline" | "deadline_stuck" | "empty_parts" | "part_unfrozen";

export const NEUTRAL_STOP_REASON_AR = "السبب: لم يصلنا سبب محدد لتوقف المعالجة قبل اكتمال العدد.";
export const GROUP_UNAVAILABLE_AR = "تعذّر بدء الطلب المقسَّم الآن، ولم يُحجز أي شيء. حاول مرة أخرى بعد قليل.";
export const GROUP_OPERATOR_CLOSE_AR = "أوقفنا الأجزاء الباقية من هذا الطلب من جانبنا.";
export const GROUP_PART_STOPPED_AR = "أوقفنا هذا الجزء من الطلب لتجاوزه المدة المتاحة، ولم يُخصم عنه شيء، وما حُجز له حجز مؤقت مُحرَّر.";
export const GROUP_PART_FILE_PENDING_AR = "ملف هذا الجزء قيد التجهيز ولم يُتح للتحميل بعد. حاول مرة أخرى لاحقًا.";
export const GROUP_PART_FILE_UNAVAILABLE_AR = "تعذّر تحميل ملف هذا الجزء الآن. حاول مرة أخرى لاحقًا.";
export const GROUP_PARTS_TITLE_AR = "أجزاء هذا الطلب";
export const GROUP_PARTS_UNAVAILABLE_AR = "تعذّر تحميل روابط أجزاء هذا الطلب الآن. حاول مرة أخرى لاحقًا.";
export const GROUP_PART_UNFROZEN_RELEASED_AR = "تعذّر تجهيز ملف هذا الجزء بأمان، فلم نحتسبه من المسلَّم ولم يُخصم عنه شيء، وما حُجز له حجز مؤقت مُحرَّر.";
export const GROUP_CLOSING_NOTICE_AR = "انتهت المدة المتاحة لتنفيذ طلبك، ونعمل الآن على إيقاف الجزء الجاري وإنهاء الطلب. تبقى النقاط محجوزة حتى ذلك الحين، ولن يُخصم منها إلا ثمن ما سُلِّم فعلًا.";

export function splitCardLineAr(split: { parts: number; perPart: number; reachable: number; askedOriginal: number; hold: number }): string {
  const X = split.askedOriginal;
  const V = split.perPart;
  const Y = split.reachable;
  const K = split.parts;
  const G = split.hold;
  if (Y === X) {
    return `طلبت ${countPlainAr(X, "companies")}، وأقصى ما تتسع له المهمة الواحدة ${countPlainAr(V, "companies")} بسبب الحد الأقصى لحجز المهمة الواحدة، لذلك سننفّذ طلبك على ${toArabicDigits(K)} أجزاء متتالية تلقائيًا بموافقة واحدة منك. عند موافقتك نحجز ${pointsAr(G, toArabicDigits)} مرة واحدة لكل الأجزاء، ولا يُخصم منها إلا ثمن ما يُسلَّم فعلًا، والباقي حجز مؤقت مُحرَّر عند انتهاء الطلب. لن نسلّمك الشركة نفسها مرتين.`;
  }
  return `طلبت ${countPlainAr(X, "companies")}، وأقصى ما تتسع له المهمة الواحدة ${countPlainAr(V, "companies")} بسبب الحد الأقصى لحجز المهمة الواحدة، وأقصى عدد أجزاء للطلب الواحد ${toArabicDigits(40)}، لذلك أقصى ما يمكن تسليمه في هذا الطلب ${countPlainAr(Y, "companies")} على ${toArabicDigits(K)} أجزاء متتالية تلقائيًا بموافقة واحدة منك. عند موافقتك نحجز ${pointsAr(G, toArabicDigits)} مرة واحدة لكل الأجزاء، ولا يُخصم منها إلا ثمن ما يُسلَّم فعلًا، والباقي حجز مؤقت مُحرَّر عند انتهاء الطلب. لن نسلّمك الشركة نفسها مرتين.`;
}

export function groupStartLineAr(args: { hold: number; parts: number }): string {
  return `تمت الموافقة على طلبك كاملًا وحُجزت ${pointsAr(args.hold, toArabicDigits)} مرة واحدة. بدأ الجزء ١ من ${toArabicDigits(args.parts)}، وستبدأ الأجزاء التالية تلقائيًا بعد انتهاء كل جزء، وفي صفحة تفاصيل أي جزء من الطلب تجد روابط كل أجزائه.`;
}

export function groupDrawLineAr(args: { k: number; K: number; Z: number; Y: number }): string {
  return `انتهى الجزء ${toArabicDigits(args.k - 1)} من ${toArabicDigits(args.K)}، والمسلَّم حتى الآن ${toArabicDigits(args.Z)} من ${toArabicDigits(args.Y)}. بدأ الجزء ${toArabicDigits(args.k)} تلقائيًا من الحجز الذي وافقت عليه، دون حجز جديد.`;
}

export function groupPartLinkAr(k: number, K: number): string {
  return `الجزء ${toArabicDigits(k)} من ${toArabicDigits(K)}`;
}

export function groupFinalLineAr(args: { reason: GroupCloseReason; Z: number; X: number; Y: number; C: number }): string {
  let reasonClause = "";
  if (args.Z < args.X) {
    let R = "";
    if (args.reason === "all_parts_done" && args.Y < args.X && args.Z === args.Y) {
      R = `أقصى ما يتسع له الطلب الواحد ${countPlainAr(args.Y, "companies")} على ${toArabicDigits(40)} جزءًا، ويمكنك طلب الباقي في طلب جديد.`;
    } else if (args.reason === "all_parts_done") {
      R = "لم يصلنا سبب محدد لتوقف المعالجة قبل اكتمال العدد.";
    } else if (args.reason === "deadline" || args.reason === "deadline_stuck") {
      R = `انتهت المدة المتاحة لتنفيذ الطلب (${toArabicDigits(72)} ساعة) قبل اكتمال الأجزاء.`;
    } else if (args.reason === "empty_parts") {
      R = "لم يُسلَّم شيء في جزأين متتاليين، فأوقفنا الأجزاء الباقية.";
    } else if (args.reason === "part_unfrozen") {
      R = "تعذّر تجهيز ملف جزء من الطلب بأمان، فلم نحتسبه من المسلَّم ولم يُخصم عنه شيء، وأوقفنا الأجزاء الباقية.";
    }
    reasonClause = ` السبب: ${R}`;
  }
  return `المسلَّم ${toArabicDigits(args.Z)} من ${toArabicDigits(args.X)} مطلوب.${reasonClause} الخصم الإجمالي ${pointsAr(args.C, toArabicDigits)}، وحُرِّر باقي الحجز.`;
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
  chainStopProgressLineAr("coverage_end"),
  chainStopProgressLineAr("sources_limited"),
  chainStopProgressLineAr("stalled"),
  chainStopProgressLineAr("work_limit"),
  ...CHAIN_CARD_LIMITS_V2_AR,
  chainShortfallReasonAr({ stop: "coverage_end", callCap: null, excluded: 0 }),
  chainShortfallReasonAr({ stop: "sources_limited", callCap: null, excluded: 0 }),
  chainShortfallReasonAr({ stop: "sources_limited", callCap: null, excluded: 0, skippedOrigins: 2 }),
  chainShortfallReasonAr({ stop: "stalled", callCap: null, excluded: 0 }),
  chainShortfallReasonAr({ stop: "work_limit", callCap: null, excluded: 0 }),
  chainZeroDeliveryReasonAr({ target: 45, stop: null }),
  chainZeroDeliveryReasonAr({ target: 45, stop: "coverage_end" }),
  chainZeroDeliveryReasonAr({ target: 45, stop: "sources_limited" }),
  chainZeroDeliveryReasonAr({ target: 45, stop: "stalled" }),
  chainZeroDeliveryReasonAr({ target: 45, stop: "work_limit" }),
  chainZeroDeliveryReasonAr({ target: 45, stop: "budget" }),
  chainFailureReasonAr("spend"),
  chainFailureReasonAr("cursor"),
  chainFailureReasonAr("lease"),
  staleReleaseReasonAr(45),
  operatorReleaseReasonAr(45),
  NEUTRAL_STOP_REASON_AR,
  GROUP_UNAVAILABLE_AR,
  GROUP_OPERATOR_CLOSE_AR,
  GROUP_PART_STOPPED_AR,
  GROUP_PART_FILE_PENDING_AR,
  GROUP_PART_FILE_UNAVAILABLE_AR,
  GROUP_PARTS_TITLE_AR,
  GROUP_PARTS_UNAVAILABLE_AR,
  GROUP_PART_UNFROZEN_RELEASED_AR,
  GROUP_CLOSING_NOTICE_AR,
  splitCardLineAr({ parts: 3, perPart: 40, reachable: 120, askedOriginal: 120, hold: 1200 }),
  splitCardLineAr({ parts: 40, perPart: 40, reachable: 1600, askedOriginal: 2000, hold: 6000 }),
  groupStartLineAr({ hold: 1200, parts: 3 }),
  groupDrawLineAr({ k: 2, K: 3, Z: 40, Y: 120 }),
  groupPartLinkAr(2, 3),
  groupFinalLineAr({ reason: "all_parts_done", Z: 120, X: 120, Y: 120, C: 1200 }),
  groupFinalLineAr({ reason: "all_parts_done", Z: 1600, X: 2000, Y: 1600, C: 6000 }),
  groupFinalLineAr({ reason: "all_parts_done", Z: 100, X: 120, Y: 120, C: 1000 }),
  groupFinalLineAr({ reason: "deadline", Z: 40, X: 120, Y: 120, C: 400 }),
  groupFinalLineAr({ reason: "deadline_stuck", Z: 40, X: 120, Y: 120, C: 400 }),
  groupFinalLineAr({ reason: "empty_parts", Z: 40, X: 120, Y: 120, C: 400 }),
  groupFinalLineAr({ reason: "part_unfrozen", Z: 40, X: 120, Y: 120, C: 0 }),
];
