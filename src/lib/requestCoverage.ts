import { detectMentionedPlatforms } from "../functions/shared/capabilityRegistry";
import { extractRequestIntent } from "./requestIntent";

/**
 * What the platform can really sell, request family by request family, and the plain Arabic answer for the ones it cannot.
 * Pure: no database, no provider, no model. The families are the scenario matrix of docs/CAPABILITY_COVERAGE.md; a test keeps the
 * document and this table in step, so the page the owner reads is the table the code uses.
 */

export type CoverageStatus = "supported" | "partly" | "not_supported";

export type FamilyId =
  | "news_articles"
  | "price_series"
  | "academic_studies"
  | "brand_monitoring"
  | "named_comments"
  | "channel_top_videos_comments"
  | "competitor_ads"
  | "places_reviews"
  | "search_results"
  | "companies_decision_makers"
  | "jobs_product_prices"
  | "telegram_reddit_forums"
  | "analysis_of_delivered"
  | "vague_or_impossible"
  | "private_data";

export interface CoverageFamily {
  id: FamilyId;
  /** The number of the family in the scenario matrix (1-14); private data is the refusal row (15). */
  no: number;
  titleAr: string;
  status: CoverageStatus;
  /** What serves it today (service name in plain words), or what is missing. */
  servedByAr: string;
  priceUnit: string;
  ceiling: string;
  shapes: string[];
  missingAr: string;
}

export const COVERAGE_FAMILIES: readonly CoverageFamily[] = [
  {
    id: "news_articles", no: 1, titleAr: "أخبار ومقالات صحفية عن موضوع من مواقع الصحف", status: "not_supported",
    servedByAr: "لا توجد خدمة تقرأ مواقع الصحف أو خلاصاتها",
    priceUnit: "—", ceiling: "—", shapes: ["اسحب أخبار موضوع من الجرايد خلال فترة", "مقالات صحفية عن موضوع من صحف مصرية"],
    missingAr: "خدمة قراءة صفحات الويب (استخراج المحتوى أو خلاصات الأخبار) غير مفعّلة؛ ولا نبيع مصدرًا لا نستطيع قراءته. تحتاج موافقة المالك على خدمة مسمّاة وسعرها.",
  },
  {
    id: "price_series", no: 2, titleAr: "سلاسل أسعار العملات والذهب مع التغير", status: "not_supported",
    servedByAr: "لا يوجد مصدر أسعار عملات أو معادن",
    priceUnit: "—", ceiling: "—", shapes: ["سعر الدولار يوميًا في السوق المصري مع التغير", "سعر الذهب أسبوعيًا خلال ٣ شهور"],
    missingAr: "لا توجد خدمة أسعار عملات أو ذهب في القائمة المعتمدة؛ ولا نقدّر الأسعار من منشورات الناس.",
  },
  {
    id: "academic_studies", no: 3, titleAr: "دراسات وأوراق بحثية", status: "not_supported",
    servedByAr: "لا يوجد مصدر أكاديمي",
    priceUnit: "—", ceiling: "—", shapes: ["اجمع ١٠ دراسات عن الطاقة الشمسية", "أوراق بحثية عن التعليم الإلكتروني"],
    missingAr: "لا توجد خدمة بحث أكاديمي؛ ومنصات التواصل ليست مصدرًا للدراسات.",
  },
  {
    id: "brand_monitoring", no: 4, titleAr: "رصد علامة أو موضوع عبر إكس وتيك توك ويوتيوب وفيسبوك", status: "partly",
    servedByAr: "منصة واحدة في كل خطة: منشورات إكس، وتعليقات وفيديوهات تيك توك ويوتيوب، وتعليقات ومنشورات فيسبوك لصفحة أو منشور بعينه",
    priceUnit: "تعليق / منشور / فيديو", ceiling: "حسب الخدمة (حتى ٥٠٠ منشور إكس، ١٠٠٠ تعليق)",
    shapes: ["١٠٠ منشور على إكس عن اسم علامتي", "تعليقات تيك توك ويوتيوب عن موضوع"],
    missingAr: "لا توجد خطة واحدة تجمع عدة منصات؛ تُجهَّز خطة لكل منصة. وبحث فيسبوك بكلمة يمر عبر الكتالوج العام وغير مؤكد حيًّا بعد.",
  },
  {
    id: "named_comments", no: 5, titleAr: "تعليقات فيديو أو منشور أو قناة محددة", status: "supported",
    servedByAr: "تعليقات يوتيوب وتيك توك وفيسبوك برابط الفيديو أو المنشور",
    priceUnit: "تعليق", ceiling: "حتى ١٠٠٠ تعليق للمهمة (٥٠٠ لفيسبوك)",
    shapes: ["تعليقات هذا الفيديو + رابط", "كل تعليقات فيديو معين"], missingAr: "—",
  },
  {
    id: "channel_top_videos_comments", no: 6, titleAr: "أعلى فيديوهات قنوات ثم تعليقاتها", status: "supported",
    servedByAr: "مهمة القنوات: أعلى الفيديوهات مشاهدة لكل قناة ثم تعليقاتها",
    priceUnit: "تعليق", ceiling: "حتى ٢٠ قناة، وأعلى ٢٠ فيديو لكل قناة، وحتى ١٠٠٠ تعليق",
    shapes: ["أعلى ١٠ فيديوهات من كل قناة من هذه القنوات مع التعليقات"], missingAr: "—",
  },
  {
    id: "competitor_ads", no: 7, titleAr: "إعلانات المنافسين (مكتبات الإعلانات)", status: "not_supported",
    servedByAr: "لا يوجد مصدر لمكتبات الإعلانات",
    priceUnit: "—", ceiling: "—", shapes: ["إعلانات منافسي على فيسبوك", "مكتبة إعلانات ميتا لعلامة"],
    missingAr: "لا توجد خدمة مكتبات إعلانات معتمدة.",
  },
  {
    id: "places_reviews", no: 8, titleAr: "تقييمات الأماكن والأعمال ومتاجر التطبيقات", status: "not_supported",
    servedByAr: "لا يوجد مصدر خرائط أو متاجر تطبيقات",
    priceUnit: "—", ceiling: "—", shapes: ["تقييمات مطاعم في القاهرة من الخرائط", "مراجعات تطبيق في المتجر"],
    missingAr: "لا توجد خدمة خرائط أو متاجر تطبيقات معتمدة.",
  },
  {
    id: "search_results", no: 9, titleAr: "نتائج محركات البحث وحجم البحث", status: "not_supported",
    servedByAr: "لا يوجد مصدر نتائج بحث أو إحصاءات كلمات",
    priceUnit: "—", ceiling: "—", shapes: ["أول ١٠٠ نتيجة جوجل لكلمة", "حجم البحث الشهري لكلمات"],
    missingAr: "لا توجد خدمة نتائج بحث معتمدة (الخدمة القديمة في القائمة غير مفعّلة وغير مؤكدة).",
  },
  {
    id: "companies_decision_makers", no: 10, titleAr: "قوائم شركات ثم صناع القرار بالبريد المهني والهاتف", status: "supported",
    servedByAr: "قوائم الشركات حسب النشاط والدولة، وصناع القرار مع بيانات التواصل المهنية",
    priceUnit: "شركة / جهة اتصال", ceiling: "حتى ٥٠٠ سجل للمهمة",
    shapes: ["٥٠ شركة كهرباء في مصر", "٣ صناع قرار في شركات برمجيات بالسعودية مع البريد"], missingAr: "—",
  },
  {
    id: "jobs_product_prices", no: 11, titleAr: "إعلانات الوظائف وأسعار المنتجات", status: "not_supported",
    servedByAr: "لا يوجد مصدر وظائف أو متاجر",
    priceUnit: "—", ceiling: "—", shapes: ["وظايف مفتوحة في شركات التقنية", "أسعار الهواتف في المتاجر الإلكترونية"],
    missingAr: "لا توجد خدمة وظائف أو أسعار منتجات معتمدة.",
  },
  {
    id: "telegram_reddit_forums", no: 12, titleAr: "تيليجرام وريديت والمنتديات", status: "not_supported",
    servedByAr: "لا يوجد مصدر لهذه المنصات",
    priceUnit: "—", ceiling: "—", shapes: ["رسائل قناة تيليجرام", "نقاشات ريديت عن موضوع"],
    missingAr: "خدمات هذه المنصات غير موجودة في القائمة المعتمدة (كانت مقترحة وغير مفعّلة).",
  },
  {
    id: "analysis_of_delivered", no: 13, titleAr: "مقارنة أو تحليل لبيانات سُلِّمت سابقًا", status: "partly",
    servedByAr: "تعديل شكل الملف المسلَّم وترتيبه وتصفيته وإعادة تسميته مجانًا من البيانات المحفوظة",
    priceUnit: "—", ceiling: "—", shapes: ["رتّب الملف حسب الإعجابات", "اترك أعمدة معينة فقط"],
    missingAr: "لا يوجد تحليل إحصائي أو تحليل مشاعر أو مقارنة بين ملفين.",
  },
  {
    id: "vague_or_impossible", no: 14, titleAr: "طلب غامض أو غير ممكن", status: "partly",
    servedByAr: "نسأل سؤالًا واحدًا محددًا عمّا ينقص، أو نقول صراحة أن الطلب غير ممكن",
    priceUnit: "—", ceiling: "—", shapes: ["عايز بيانات", "اجمع كل شيء عن كل الناس"],
    missingAr: "لا تُسعَّر خطة قبل أن يتضح نوع البيانات والموضوع.",
  },
  {
    id: "private_data", no: 15, titleAr: "بيانات خاصة", status: "not_supported",
    servedByAr: "مرفوض صراحة",
    priceUnit: "—", ceiling: "—", shapes: ["رسائل خاصة", "الرقم القومي لشخص", "كلمات المرور"],
    missingAr: "لا نجمع بيانات خاصة أو غير منشورة للعامة.",
  },
];

export const familyById = (id: FamilyId): CoverageFamily => COVERAGE_FAMILIES.find((family) => family.id === id)!;

/** The request read for matching: no diacritics, one form of alef, ya and ta marbuta, Western digits. */
export function coverageText(text: string): string {
  return String(text || "").toLowerCase().normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\s+/g, " ").trim();
}

const PREP_BEFORE = /(?:^|\s)(?:عن|حول|بخصوص|في|ب|من|علي|على|ل|لل|ضد|بشان)\s*(?:ال)?$/u;

/**
 * The nouns that name what a request wants delivered, per family. A noun that follows a topic preposition («تعليقات تيك توك عن أخبار
 * الدولار») is the subject of the thing before it, not a second thing to deliver; the first noun of a request is its head.
 */
const FAMILY_NOUNS: Array<{ id: FamilyId; patterns: RegExp[] }> = [
  { id: "private_data", patterns: [/(?:رسايل|رسائل|محادثات|شات|شاتات)\s*(?:ال)?(?:خاصه|واتساب|ماسنجر|فلان|شخصيه)|حسابات?\s+(?:ال)?خاصه|(?:رقم|ارقام)\s*(?:ال)?(?:تليفون|هاتف|موبايل|جوال)\s*(?:ال)?(?:ل|الخاص ب|الشخصي ل)\s*(?:فلان|شخص|اشخاص|ناس|مواطنين|افراد)|(?:ال)?رقم القومي|ارقام قوميه|بيانات\s*(?:ال)?(?:بنكيه|ائتمانيه)|كلمات?\s*(?:ال)?مرور|باسوورد|password|اخترق|اختراق|هاك|تجسس|ايميلات?\s*شخصيه|عنوان\s*(?:ال)?(?:سكن|منزل)\s*(?:ل|لـ)/u] },
  { id: "news_articles", patterns: [/اخبار|(?:^|\s)خبر(?:\s|$)|مقالات|(?:^|\s)مقال(?:\s|$)|(?:ال)?صحف|(?:ال)?جرايد|(?:ال)?جرائد|(?:ال)?جريده|(?:ال)?صحيفه|تغطيه صحفيه|مواقع (?:ال)?اخباريه|مواقع صحفيه|وكالات (?:ال)?انباء|عناوين (?:ال)?صحف/u] },
  { id: "price_series", patterns: [/(?:سعر|اسعار|سعر صرف|اسعار صرف)\s*(?:ال)?(?:دولار|يورو|جنيه|ذهب|فضه|عمله|عملات|ريال|درهم|دينار|بيتكوين|نفط|بترول|اسهم|سهم)|(?:ال)?(?:دولار|يورو|ذهب|بيتكوين)\s+(?:و?سعره|و?سعرها|و?اسعاره|يوميا|اسبوعيا)|(?:سلسله|سلاسل)\s*(?:ال)?اسعار|بورصه|مؤشر(?:ات)?\s*(?:ال)?(?:بورصه|اسهم)|فوركس|forex|سوق (?:ال)?صرف|اسعار (?:ال)?صرف/u] },
  { id: "academic_studies", patterns: [/دراسات|(?:^|\s)دراسه(?:\s|$)|ابحاث|بحوث|ورقه بحثيه|اوراق بحثيه|اوراق علميه|ورقه علميه|مقالات علميه|مقالات اكاديميه|مراجع علميه|رسائل (?:ماجستير|دكتوراه)|مواد علميه|مواد اكاديميه|مواد بحثيه|google scholar|\bscholar\b|جوجل سكولار|مجلات (?:علميه|محكمه)|\bpapers\b|\bstudies\b/u] },
  { id: "competitor_ads", patterns: [/(?:اعلانات|اعلان)\s*(?:ال)?(?:منافس|منافسين|منافسي|منافسينا|فيسبوك|ميتا|انستجرام|تيك توك|جوجل)|مكتبه (?:ال)?اعلانات|ad library|ads library|(?:اعلانات|اعلان) (?:شركه|شركات|علامه|براند)/u] },
  { id: "places_reviews", patterns: [/(?:تقييمات|تقييم|مراجعات|ريفيوز?|reviews?)\s*(?:ال)?(?:مطاعم|مطعم|فنادق|فندق|اماكن|مكان|محلات|محل|كافيهات|مستشفيات|عيادات|تطبيق|تطبيقات|فروع|فرع)|خرائط جوجل|google maps|جوجل ماب|جوجل مابس|(?:من|علي|على) (?:ال)?خرائط|متجر (?:ال)?تطبيقات|app store|play store|جوجل بلاي|ابل ستور/u] },
  { id: "search_results", patterns: [/نت(?:ايج|ائج|يجه)\s*(?:ال)?(?:بحث|جوجل)|محرك(?:ات)? (?:ال)?بحث|\bserp\b|\bseo\b|(?:ال)?كلمات (?:ال)?مفتاحيه|حجم (?:ال)?بحث|search volume|ترتيب (?:ال)?موقع/u] },
  { id: "jobs_product_prices", patterns: [/وظايف|وظائف|فرص عمل|فرصه عمل|linkedin jobs|\bjob (?:postings?|listings?|openings?|ads?)\b|\bjobs (?:in|at|for|board)\b|(?:اسعار|سعر)\s*(?:ال)?(?:منتجات|سلع|هواتف|موبايلات|لابتوبات|سيارات|شقق|عقارات|اجهزه)|مقارنه (?:ال)?اسعار|شقق (?:للبيع|للايجار)|امازون|جوميا|\bolx\b|اوليكس|اسعار (?:ال)?متاجر|(?:ال)?متاجر (?:ال)?الكترونيه/u] },
  { id: "telegram_reddit_forums", patterns: [/تيليجرام|تلجرام|تليجرام|telegram|ريديت|reddit|منتدي|منتديات|forums?|ديسكورد|discord|جروبات واتساب|مجموعات واتساب|\bquora\b|كورا\b/u] },
];

/** The nouns of what we sell: a platform's comments, posts or videos, companies, decision makers. */
const SOLD_NOUNS = /(?:تعليقات?|كومنتات?|كومنتس|تعليقهم|منشورات|منشور|بوستات?|تغريدات?|تويتات?|فيديوهات|فيديو|مقاطع|شركات|شركه|مؤسسات|مصانع|مصنع|صناع (?:ال)?قرار|مدراء|مديرين|ceo|ceos|يوتيوب|تيك توك|tiktok|youtube|فيسبوك|facebook|تويتر|twitter|منصه اكس|علي اكس|على اكس|(?:^|\s)اكس(?:\s|$))/u;

interface Noun { family: FamilyId | "sold"; at: number }

function nounsOf(t: string): Noun[] {
  const nouns: Noun[] = [];
  for (const { id, patterns } of FAMILY_NOUNS) for (const pattern of patterns) { const m = pattern.exec(t); if (m) nouns.push({ family: id, at: m.index }); }
  const sold = SOLD_NOUNS.exec(t);
  if (sold) nouns.push({ family: "sold", at: sold.index });
  return nouns.sort((x, y) => x.at - y.at);
}

const PLATFORM_WORD = /(?:يوتيوب|تيك توك|tiktok|youtube|فيسبوك|facebook|تويتر|twitter|منصه اكس|(?:علي|على|في|من) اكس(?:\s|$)|(?:^|\s)اكس(?:\s|$))/u;
/** A conjunction right before a noun: «وكمان أخبار», «مع سعر الدولار», «ثم …». It is a second thing to deliver, not a topic. */
const JOINED_BEFORE = /(?:^|\s)(?:و|مع|وكمان|كمان|ثم|وبعدين|وايضا|ايضا|بالاضافه الي|بالاضافه|اضافه الي|\+)$|[،,+]$/u;

/** A noun after a topic preposition, or one that is the topic of a platform request, belongs to what came before it. */
function isSubjectNoun(t: string, noun: Noun, earlier: Noun[], hasPlatform: boolean): boolean {
  if (noun.family === "private_data") return false;
  const before = t.slice(Math.max(0, noun.at - 14), noun.at).trimEnd();
  if (JOINED_BEFORE.test(before)) return false;
  // «أخبار الدولار من تويتر», «تعليقات تيك توك عن سعر الذهب»: a platform request whose subject is the news or the price.
  if (hasPlatform && (noun.family === "news_articles" || noun.family === "price_series" || noun.family === "academic_studies" || noun.family === "jobs_product_prices")) return true;
  if (earlier.length === 0) return false;
  return PREP_BEFORE.test(before) || /(?:^|\s)(?:ل|ب)$/u.test(before);
}

function countPlatforms(t: string): number {
  const found = new Set(detectMentionedPlatforms(t).filter((p) => ["x", "twitter", "tiktok", "youtube", "facebook", "instagram"].includes(p)));
  if (found.has("twitter")) { found.delete("twitter"); found.add("x"); }
  return found.size;
}

export interface CoverageAssessment {
  /** Every family the request touches, in the matrix order. */
  families: FamilyId[];
  /** What the platform can do of it, and what it cannot. */
  supported: FamilyId[];
  unsupported: FamilyId[];
  status: CoverageStatus;
  /** The request is private data: refused, never priced, whatever else it contains. */
  refused: boolean;
}

const BRAND_RE = /(?:رصد|ارصد|مراقبه|متابعه|تتبع)\s*(?:ال)?(?:علامه|علامتي|براند|اسم|سمعه|ذكر|منتج)|brand monitoring|سمعه (?:ال)?(?:علامه|شركه)|ماذا يقول (?:ال)?(?:ناس|عملاء) عن/u;
const ANALYSIS_RE = /(?:حلل|تحليل|قارن|مقارنه|لخص|ملخص|استخلص|احصائيات|احصاءات|مشاعر|sentiment|اكثر (?:ال)?كلمات)/u;
const DELIVERED_REF_RE = /(?:النتايج|النتائج|الملف|البيانات|اللي سحبت\S*|اللي جمعت\S*|السابق\S*|المسلم\S*|المستخرج\S*|اللي فات|اللي اتسلم\S*)/u;

/**
 * Which families a request belongs to and whether the platform can serve it. A request that names a service we sell (a platform's
 * comments or posts, companies, decision makers) is served for that part even when it also asks for something we do not sell: it is «partly».
 */
export function assessCoverage(rawText: string): CoverageAssessment {
  const t = coverageText(rawText);
  const intent = extractRequestIntent(rawText);
  const nouns = nounsOf(t);
  const heads: Noun[] = [];
  const hasPlatform = PLATFORM_WORD.test(t);
  for (const noun of nouns) if (!isSubjectNoun(t, noun, heads, hasPlatform)) heads.push(noun);

  const unsupported = [...new Set(heads.filter((n) => n.family !== "sold").map((n) => n.family as FamilyId))];
  const refused = unsupported.includes("private_data");
  const soldHead = heads.some((n) => n.family === "sold") && ["companies", "people", "posts", "comments", "videos", "profile"].includes(intent.dataType);

  const supported: FamilyId[] = [];
  if (!refused) {
    const multiPlatform = countPlatforms(t) >= 2 || BRAND_RE.test(t);
    if (soldHead) {
      if (intent.dataType === "companies" || intent.dataType === "people") supported.push("companies_decision_makers");
      else if (intent.discover === "target") supported.push("named_comments");
      else if (/(?:قنوات|قناه|حسابات)/u.test(t) && intent.dataType !== "posts") supported.push("channel_top_videos_comments");
      else supported.push("brand_monitoring");
    }
    if (multiPlatform && !supported.includes("brand_monitoring") && !supported.includes("companies_decision_makers")) supported.push("brand_monitoring");
    if (ANALYSIS_RE.test(t) && DELIVERED_REF_RE.test(t) && unsupported.length === 0) supported.push("analysis_of_delivered");
  }

  const families = COVERAGE_FAMILIES.map((family) => family.id).filter((id) => (refused ? id === "private_data" : unsupported.includes(id) || supported.includes(id)));
  const multi = !refused && (countPlatforms(t) >= 2 || BRAND_RE.test(t));
  let status: CoverageStatus;
  if (refused) status = "not_supported";
  else if (unsupported.length > 0 && supported.length === 0) status = "not_supported";
  else if (unsupported.length > 0) status = "partly";
  else if (supported.length === 1 && supported[0] === "analysis_of_delivered") status = "partly";
  else if (supported.includes("brand_monitoring") && multi) status = "partly";
  else status = "supported";
  return { families, supported: refused ? [] : supported, unsupported: refused ? ["private_data"] : unsupported, status, refused };
}

/** What the platform sells, in the three lines every «not available» answer ends with. */
export const WHAT_WE_CAN_DO_AR = [
  "قوائم الشركات حسب النشاط والدولة، وصناع القرار مع البريد المهني والهاتف",
  "منشورات إكس، وتعليقات وفيديوهات تيك توك ويوتيوب، وتعليقات ومنشورات فيسبوك العامة",
  "أعلى فيديوهات قنوات تحددها مع تعليقاتها",
] as const;

/** The plain answer for a request none of whose parts we sell. Arabic only; no provider or service name; nothing is priced or charged. */
export function notSupportedReplyAr(assessment: CoverageAssessment): string {
  if (assessment.refused) {
    return "لا أستطيع جمع بيانات خاصة أو غير منشورة للعامة، مثل الرسائل الخاصة أو الأرقام الشخصية أو كلمات المرور.\nالمتاح: بيانات عامة منشورة فقط، منها:\n" + WHAT_WE_CAN_DO_AR.map((line, i) => `${["١", "٢", "٣"][i]}) ${line}`).join("\n");
  }
  const titles = assessment.unsupported.map((id) => familyById(id).titleAr);
  const what = titles.length === 1 ? `«${titles[0]}»` : titles.map((title) => `«${title}»`).join(" و");
  return [
    `طلبك عن ${what} غير متاح في ديجر حاليًا، ولن أخمّن مصدرًا بديلًا أو أبيعك شيئًا لا نستطيع قراءته.`,
    "المتاح الآن:",
    ...WHAT_WE_CAN_DO_AR.map((line, i) => `${["١", "٢", "٣"][i]}) ${line}`),
    "إن أردت، اكتب طلبًا من هذه الأنواع وأجهز لك الخطة والسعر.",
  ].join("\n");
}

/** One line added to a plan when part of the request is not sold: the plan covers the rest and says what it leaves out. */
export function partlyNoteAr(assessment: CoverageAssessment): string {
  const titles = assessment.unsupported.map((id) => `«${familyById(id).titleAr}»`).join(" و");
  return `الجزء الخاص بـ ${titles} غير متاح حاليًا ولم يُسعَّر؛ الخطة تشمل ما نبيعه فقط.`;
}
