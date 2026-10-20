import { estimateMission, estimateSummaryAr, type EstimateInput } from "./missionEstimate";
import { understandMission, understoodLineAr } from "./consultantCopy";

/**
 * Static demo conversations for the landing page. They are EXAMPLES: no live call, no model, no provider. The understanding line
 * comes from the same reader the chat uses, and every price from the same public estimate the calculator uses, so a demo can
 * never show a number the product would not quote.
 */
export const DEMO_LABEL_AR = "مثال توضيحي";

export interface LandingDemo {
  id: string;
  line: "social" | "companies";
  titleAr: string;
  requestAr: string;
  understoodAr: string | null;
  planAr: string[];
  priceAr: string;
  outputAr: string;
}

const TODAY = new Date(Date.UTC(2026, 9, 20));

interface DemoSource {
  id: string;
  line: LandingDemo["line"];
  titleAr: string;
  requestAr: string;
  estimate: EstimateInput;
  planAr: string[];
  outputAr: string;
}

const SOURCES: DemoSource[] = [
  {
    id: "event-x",
    line: "social",
    titleAr: "متابعة حدث على إكس",
    requestAr: "عايز ١٠٠ منشور وردود على إكس عن مباراة مصر والمغرب آخر شهر",
    estimate: { kind: "posts", platform: "x", volume: 100 },
    planAr: ["المنصة: إكس", "الموضوع: مباراة مصر والمغرب", "الفترة: آخر شهر", "العدد: حتى ١٠٠ منشور مع ردودها"],
    outputAr: "ملف إكسل واحد: نص المنشور، تاريخه، رابطه، وعدد التفاعلات.",
  },
  {
    id: "youtube-comments",
    line: "social",
    titleAr: "تعليقات فيديوهات على يوتيوب",
    requestAr: "عايز ٥٠ تعليق من أكثر فيديوهات قناة العربية مشاهدة على يوتيوب",
    estimate: { kind: "comments", platform: "youtube", volume: 50 },
    planAr: ["المنصة: يوتيوب", "المصدر: أكثر فيديوهات القناة مشاهدة", "العدد: حتى ٥٠ تعليقًا", "مع رابط كل فيديو"],
    outputAr: "ملف إكسل واحد: نص التعليق، كاتبه، تاريخه، ورابط الفيديو.",
  },
  {
    id: "facebook-topic",
    line: "social",
    titleAr: "موضوع على فيسبوك بين تاريخين",
    requestAr: "عايز ٤٠ منشور فيسبوك عن الزواج في مصر من ١ يناير ٢٠٢٦ إلى ٣٠ سبتمبر ٢٠٢٦",
    estimate: { kind: "posts", platform: "facebook", volume: 40 },
    planAr: ["المنصة: فيسبوك", "الموضوع: الزواج في مصر", "الفترة: من ١ يناير ٢٠٢٦ إلى ٣٠ سبتمبر ٢٠٢٦", "العدد: حتى ٤٠ منشورًا"],
    outputAr: "ملف إكسل واحد: نص المنشور، تاريخه، رابطه، وعدد التفاعلات.",
  },
  {
    id: "companies",
    line: "companies",
    titleAr: "شركات في قطاع محدد",
    requestAr: "عايز ٥٠ شركة مقاولات في مصر",
    estimate: { kind: "companies", volume: 50 },
    planAr: ["القطاع: مقاولات", "الدولة: مصر", "العدد: حتى ٥٠ شركة", "بيانات الشركة المتاحة علنًا"],
    outputAr: "ملف إكسل واحد: اسم الشركة، موقعها الإلكتروني، مدينتها، وما يتوفر من بيانات التواصل العامة.",
  },
];

export function buildLandingDemos(): LandingDemo[] {
  return SOURCES.map((source) => {
    const result = estimateMission(source.estimate);
    return {
      id: source.id,
      line: source.line,
      titleAr: source.titleAr,
      requestAr: source.requestAr,
      understoodAr: understoodLineAr(understandMission(source.requestAr, { today: TODAY })),
      planAr: source.planAr,
      priceAr: result.status === "ok" ? estimateSummaryAr(result) : "",
      outputAr: source.outputAr,
    };
  });
}

export const PRODUCT_LINES = [
  {
    id: "social",
    titleAr: "بيانات المنصات الاجتماعية",
    taglineAr: "تعليقات ومنشورات وفيديوهات عامة، منظمة في ملف واحد.",
    pointsAr: ["يوتيوب وفيسبوك وإكس وتيك توك", "فترة زمنية تحددها أنت", "رابط المصدر مع كل سجل"],
  },
  {
    id: "companies",
    titleAr: "شركات وصنّاع قرار",
    taglineAr: "قوائم شركات، ومن يتخذ القرار فيها، مع وسائل التواصل المتاحة.",
    pointsAr: ["حسب القطاع والدولة", "البريد المهني والهاتف عند توفرهما", "تدفع فقط مقابل ما يصلك فعلًا"],
  },
] as const;

export const TEN_SECOND_STORY_AR = ["تكتب طلبك بكلماتك.", "تراجع الخطة والسعر التقريبي.", "توافق، فتستلم ملفك."] as const;
