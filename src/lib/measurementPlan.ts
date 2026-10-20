import { computePublicCalculatorQuote } from "./calculatorPricing";
import { getSocialCapability } from "./socialSources";

/**
 * The small real requests a tester runs to measure the long-job numbers that cannot be known without the live provider, one per source.
 * Pure: it asks the existing public quote function for the price (it never sets one), and states what each request is expected to
 * quote, to settle if everything arrives, and to cost the provider. Nothing here spends anything or calls a provider.
 *
 * Points are the customer's. The provider cost is an ESTIMATE from the catalog's price per call and how many records one call returns;
 * it is not a measurement (measuring it is what these requests are for).
 */

export interface TesterRequestPlan {
  id: string;
  /** The source, in the customer's words. */
  sourceAr: string;
  slug: string;
  /** The request exactly as a customer would type it, with the parts the tester fills in in brackets. */
  textAr: string;
  /** The volume the owner asked for. */
  asSpecified: TesterQuote;
  /** The largest volume whose quote stays at or under 20 points, or null when even one record is above it. */
  within20Points: TesterQuote | null;
  /** Provider calls and their price for the volume as specified: what the catalog says they should cost. */
  providerCallsExpected: number;
  providerUsdExpected: number;
  /** What to look at, besides the settled points, when measuring this source. */
  measureAr: string;
  /**
   * A smaller version of the request, present only when the one as specified would push the total provider spend of the set past
   * the 0.02 USD limit; the tester runs this one instead.
   */
  adjustedForBudget?: { textAr: string; quote: TesterQuote; providerCallsExpected: number; providerUsdExpected: number; reasonAr: string };
}

export interface TesterQuote {
  volume: number;
  unitPricePoints: number;
  /** What the plan holds (the quote). */
  quotedPoints: number;
  /** What settles if every record arrives: ceil(delivered x unit price). */
  settledIfAllDeliveredPoints: number;
  /** True when one job cannot hold this volume (the plan is cut to what one job holds). */
  cutToOneJob: boolean;
  /** The volume one job holds when it is cut. */
  volumeHeld: number;
}

export const QUOTE_LIMIT_POINTS = 20;
/** The provider spend that all the requests together must stay under, in USD. */
export const TOTAL_PROVIDER_USD_LIMIT = 0.02;

export function testerQuote(slug: string, volume: number): TesterQuote {
  const quote = computePublicCalculatorQuote(slug, volume);
  return {
    volume,
    unitPricePoints: quote.unitPricePoints,
    quotedPoints: quote.isCapped ? Number(quote.cappedReservedPoints) : quote.reservedPoints,
    settledIfAllDeliveredPoints: quote.isCapped ? Number(quote.cappedChargedPoints) : quote.chargedPoints,
    cutToOneJob: Boolean(quote.isCapped),
    volumeHeld: quote.isCapped ? Number(quote.maxCappedVolume) : volume,
  };
}

/** The most records whose quote is at or under `limit` points; null when one record is already above it. */
export function largestVolumeWithin(slug: string, limit: number, upTo: number): TesterQuote | null {
  let best: TesterQuote | null = null;
  for (let volume = 1; volume <= upTo; volume += 1) {
    const quote = testerQuote(slug, volume);
    if (quote.quotedPoints > limit) break;
    best = quote;
  }
  return best;
}

const callPrice = (slug: string, which: "comments" | "query" | "channel") => {
  const cap = getSocialCapability(slug)!;
  const source = which === "comments" ? cap.comments![0] : cap.discover[which]![0];
  return { usd: source.costUsd, perCall: source.maxPerCall };
};

export function testerRequests(): TesterRequestPlan[] {
  const yt = callPrice("social-youtube-comments", "comments");
  const tt = callPrice("social-tiktok-comments", "comments");
  const ttChannel = callPrice("social-tiktok-comments", "channel");
  const x = callPrice("social-x-posts", "query");
  const fb = callPrice("social-facebook-posts", "channel");
  const round = (n: number) => Number(n.toFixed(6));
  const plans: TesterRequestPlan[] = [
    {
      id: "youtube-comments",
      sourceAr: "تعليقات يوتيوب",
      slug: "social-youtube-comments",
      textAr: "استخرج تعليقات هذين الفيديوهين على يوتيوب بحد أقصى ٣٠ تعليقًا: [رابط الفيديو الأول] [رابط الفيديو الثاني]",
      asSpecified: testerQuote("social-youtube-comments", 30),
      within20Points: largestVolumeWithin("social-youtube-comments", QUOTE_LIMIT_POINTS, 30),
      // one call per video: this source returns up to 500 comments in one call
      providerCallsExpected: 2,
      providerUsdExpected: round(2 * yt.usd),
      measureAr: "عدد التعليقات المسلَّمة من كل فيديو، وزمن الدفعة، وهل تكفي مكالمة واحدة لكل فيديو.",
    },
    {
      id: "tiktok-comments",
      sourceAr: "تعليقات تيك توك",
      slug: "social-tiktok-comments",
      textAr: "استخرج ٣٠ تعليقًا من هذا الفيديو على تيك توك: [رابط الفيديو]",
      asSpecified: testerQuote("social-tiktok-comments", 30),
      within20Points: largestVolumeWithin("social-tiktok-comments", QUOTE_LIMIT_POINTS, 30),
      providerCallsExpected: Math.ceil(30 / tt.perCall),
      providerUsdExpected: round(Math.ceil(30 / tt.perCall) * tt.usd),
      measureAr: "تعليقات لكل مكالمة (المصدر يعطي حتى ٢٠)، وزمن المكالمة، وعدد الدفعات.",
    },
    {
      id: "tiktok-channels-top-videos",
      sourceAr: "أعلى فيديوهات قناتين على تيك توك مع تعليقاتها",
      slug: "social-tiktok-comments",
      textAr: "استخرج تعليقات أعلى ٣ فيديوهات من قناتين على تيك توك، حتى ٢٠ تعليقًا لكل فيديو: [القناة الأولى] و[القناة الثانية]",
      // 2 channels x 3 videos x 20 comments
      asSpecified: testerQuote("social-tiktok-comments", 120),
      within20Points: largestVolumeWithin("social-tiktok-comments", QUOTE_LIMIT_POINTS, 120),
      // one list call per channel, then one comment call (20 a call) per video
      providerCallsExpected: 2 + 6,
      providerUsdExpected: round(2 * ttChannel.usd + 6 * tt.usd),
      measureAr: "مكالمات الاكتشاف لكل قناة، وكم فيديو يُقرأ فعلًا، وزمن الدفعة، وأن الطلب يُقصّ إلى ما يتسع له طلب واحد.",
      adjustedForBudget: {
        textAr: "استخرج تعليقات أعلى فيديوهين من قناتين على تيك توك، حتى ٢٠ تعليقًا لكل فيديو: [القناة الأولى] و[القناة الثانية]",
        // 2 channels x 2 videos x 20 comments
        quote: testerQuote("social-tiktok-comments", 80),
        providerCallsExpected: 2 + 4,
        providerUsdExpected: round(2 * ttChannel.usd + 4 * tt.usd),
        reasonAr: "الطلب كما حُدِّد (٣ فيديوهات لكل قناة) يرفع مجموع تكلفة المزود المتوقعة للمجموعة فوق ٠٫٠٢ دولار؛ فيديوهان لكل قناة يُبقيانه تحتها.",
      },
    },
    {
      id: "x-posts-event",
      sourceAr: "منشورات منصة إكس عن حدث",
      slug: "social-x-posts",
      textAr: "استخرج ١٠٠ منشور عن [حدث محدد] من منصة إكس",
      asSpecified: testerQuote("social-x-posts", 100),
      within20Points: largestVolumeWithin("social-x-posts", QUOTE_LIMIT_POINTS, 100),
      providerCallsExpected: Math.ceil(100 / x.perCall),
      providerUsdExpected: round(Math.ceil(100 / x.perCall) * x.usd),
      measureAr: "منشورات لكل مكالمة (المصدر يعطي حتى ٥٠)، والمكرر بين الصفحات، وزمن الدفعة.",
    },
    {
      id: "facebook-page-posts",
      sourceAr: "منشورات صفحة فيسبوك بنافذة تاريخ",
      slug: "social-facebook-posts",
      textAr: "استخرج آخر ٢٠ منشورًا من صفحة [اسم الصفحة] على فيسبوك بين [تاريخ البداية] و[تاريخ النهاية]",
      asSpecified: testerQuote("social-facebook-posts", 20),
      within20Points: largestVolumeWithin("social-facebook-posts", QUOTE_LIMIT_POINTS, 20),
      providerCallsExpected: Math.ceil(20 / fb.perCall),
      providerUsdExpected: round(Math.ceil(20 / fb.perCall) * fb.usd),
      measureAr: "منشورات لكل مكالمة (المصدر يعطي ١٠)، وكم منشورًا يخرج عن النافذة ولا يُحتسب، وزمن الدفعة.",
    },
    {
      id: "companies",
      sourceAr: "شركات",
      slug: "icypeas-companies-search",
      textAr: "ابحث عن ٥ شركات [نشاط] في [مدينة]",
      asSpecified: testerQuote("icypeas-companies-search", 5),
      within20Points: largestVolumeWithin("icypeas-companies-search", QUOTE_LIMIT_POINTS, 5),
      // measured on the production company jobs (read-only query, section 3 of the measurement plan): 0.000576 USD a record
      providerCallsExpected: 1,
      providerUsdExpected: round(5 * 0.000576),
      measureAr: "التكلفة الفعلية لكل سجل، وعدد السجلات المرفوضة بالنطاق الجغرافي، وزمن الدفعة.",
    },
    {
      id: "decision-makers",
      sourceAr: "صناع القرار",
      slug: "professional-people-search",
      textAr: "ابحث عن صانع قرار واحد في شركة [اسم الشركة]",
      asSpecified: testerQuote("professional-people-search", 1),
      within20Points: largestVolumeWithin("professional-people-search", QUOTE_LIMIT_POINTS, 1),
      // measured on the one production people job (0.00076 USD a record); the route's own cap is far higher, so this is the expected, not the worst case
      providerCallsExpected: 1,
      providerUsdExpected: 0.00076,
      measureAr: "التكلفة الفعلية للمكالمة، وهل وصل البريد المهني والهاتف، وما يُحتسب فعلًا.",
    },
  ];
  return plans;
}

/** The expected provider spend of the whole set: as specified, or with the adjusted versions where one exists. */
export function totalExpectedProviderUsd(plans: TesterRequestPlan[] = testerRequests(), version: "asSpecified" | "recommended" = "asSpecified"): number {
  const each = (plan: TesterRequestPlan) => (version === "recommended" && plan.adjustedForBudget ? plan.adjustedForBudget.providerUsdExpected : plan.providerUsdExpected);
  return Number(plans.reduce((sum, plan) => sum + each(plan), 0).toFixed(6));
}
