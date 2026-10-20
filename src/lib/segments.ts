import { estimateMission, estimateSummaryAr, type EstimateInput, type EstimateResult } from "./missionEstimate";
import { understandMission, understoodLineAr } from "./consultantCopy";

/**
 * The segment pages: who the product is for, one big example mission each, and its approximate price from the public estimate
 * (never hand-typed). The wording stays plain; nothing here is a promise about results.
 */
export interface Segment {
  slug: string;
  nameAr: string;
  headlineAr: string;
  painAr: string;
  usesAr: string[];
  exampleTitleAr: string;
  exampleRequestAr: string;
  examplePlanAr: string[];
  exampleOutputAr: string;
  estimate: EstimateInput;
}

export const SEGMENTS: readonly Segment[] = [
  {
    slug: "marketing-agencies",
    nameAr: "وكالات التسويق",
    headlineAr: "اسمع جمهور العلامة وجمهور منافسيها من تعليقاتهم",
    painAr: "قراءة آلاف التعليقات يدويًا تأخذ أيامًا، وتفوتك فيها الأنماط.",
    usesAr: ["تعليقات الجمهور على حملات المنافسين", "ردود الفعل على إطلاق منتج", "قياس الانطباع قبل حملة وبعدها"],
    exampleTitleAr: "تعليقات على أكثر فيديوهات قناة منافسة",
    exampleRequestAr: "عايز ٢٠٠ تعليق من أكثر فيديوهات قناة @AlArabiya مشاهدة على يوتيوب",
    examplePlanAr: ["المنصة: يوتيوب", "المصدر: أكثر فيديوهات القناة مشاهدة", "العدد: حتى ٢٠٠ تعليق", "مع رابط كل فيديو"],
    exampleOutputAr: "ملف إكسل واحد: نص التعليق، كاتبه، تاريخه، ورابط الفيديو.",
    estimate: { kind: "comments", platform: "youtube", volume: 200 },
  },
  {
    slug: "researchers",
    nameAr: "الباحثون والأكاديميون",
    headlineAr: "عيّنة منظمة من النقاش العام حول موضوع بحثك",
    painAr: "جمع عيّنة من المنشورات العامة بمنهج واضح يستنزف وقت البحث.",
    usesAr: ["منشورات عن موضوع ضمن فترة زمنية محددة", "تعليقات على مقاطع تخص ظاهرة اجتماعية", "ملف منظم جاهز للترميز والتحليل"],
    exampleTitleAr: "منشورات عن موضوع اجتماعي ضمن فترة محددة",
    exampleRequestAr: "عايز ٥٠٠ منشور على إكس عن الغلاء في مصر من ١ يناير ٢٠٢٦ إلى ٣٠ سبتمبر ٢٠٢٦",
    examplePlanAr: ["المنصة: إكس", "الموضوع: الغلاء في مصر", "الفترة: من ١ يناير ٢٠٢٦ إلى ٣٠ سبتمبر ٢٠٢٦", "العدد: حتى ٥٠٠ منشور"],
    exampleOutputAr: "ملف إكسل واحد: نص المنشور، تاريخه، رابطه، وعدد التفاعلات.",
    estimate: { kind: "posts", platform: "x", volume: 500 },
  },
  {
    slug: "journalists",
    nameAr: "الصحفيون",
    headlineAr: "كيف تفاعل الناس مع الحدث؟ اجمع الردود بسرعة",
    painAr: "الحدث يتحرك بسرعة، ولا وقت لتجميع الردود بيدك.",
    usesAr: ["ردود الجمهور على مباراة أو خبر", "أكثر ما قيل عن حدث خلال أيامه", "روابط المصادر مع كل منشور للتحقق"],
    exampleTitleAr: "ردود الجمهور على حدث رياضي",
    exampleRequestAr: "عايز ٣٠٠ منشور وردود على إكس عن مباراة مصر والمغرب آخر شهر",
    examplePlanAr: ["المنصة: إكس", "الموضوع: مباراة مصر والمغرب", "الفترة: آخر شهر", "العدد: حتى ٣٠٠ منشور مع ردودها"],
    exampleOutputAr: "ملف إكسل واحد: نص المنشور، تاريخه، رابطه، وعدد التفاعلات.",
    estimate: { kind: "posts", platform: "x", volume: 300 },
  },
  {
    slug: "sales-teams",
    nameAr: "فرق المبيعات للشركات",
    headlineAr: "قائمة شركات مستهدفة، ومن يقرر فيها",
    painAr: "بناء قائمة عملاء محتملين يدويًا يبطئ الفريق قبل أول مكالمة.",
    usesAr: ["شركات في قطاع ودولة محددين", "صنّاع القرار في كل شركة", "البريد المهني والهاتف عند توفرهما"],
    exampleTitleAr: "شركات مقاولات في مصر",
    exampleRequestAr: "عايز ٥٠ شركة مقاولات في مصر",
    examplePlanAr: ["القطاع: مقاولات", "الدولة: مصر", "العدد: حتى ٥٠ شركة", "بيانات الشركة المتاحة علنًا"],
    exampleOutputAr: "ملف إكسل واحد: اسم الشركة، موقعها الإلكتروني، مدينتها، وما يتوفر من بيانات التواصل العامة.",
    estimate: { kind: "companies", volume: 50 },
  },
];

export function segmentBySlug(slug: string): Segment | null {
  return SEGMENTS.find((segment) => segment.slug === slug) ?? null;
}

export interface SegmentExample {
  understoodAr: string | null;
  priceAr: string;
  notesAr: string[];
  result: EstimateResult;
}

const TODAY = new Date(Date.UTC(2026, 9, 20));

export function segmentExample(segment: Segment, dailyCapPoints?: number): SegmentExample {
  const result = estimateMission({ ...segment.estimate, dailyCapPoints });
  return {
    understoodAr: understoodLineAr(understandMission(segment.exampleRequestAr, { today: TODAY })),
    priceAr: result.status === "ok" ? estimateSummaryAr(result) : "",
    notesAr: result.status === "ok" && !result.fitsInOneJob ? result.notesAr.slice(1) : [],
    result,
  };
}
