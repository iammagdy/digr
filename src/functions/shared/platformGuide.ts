import { APPROVED_CAPABILITY_CATALOG, type Capability } from "./capabilityRegistry";
import { SOCIAL_CAPABILITIES } from "../../lib/socialSources";

export type GuideService = {
  slug: string;
  nameAr: string;
  descriptionAr: string;
  requiredInputs: string[];
  maxRecords: number;
  exampleAr: string;
  examplePlanAr: string;
  defaultContactFields?: Array<"work_email" | "phone">;
  customerPlanNoteAr?: string;
};

/** Structured product knowledge shared by the assistant and the customer catalog. */
export const PLATFORM_GUIDE = {
  product: {
    nameAr: "ديجر",
    descriptionAr: "منصة بحث وجمع بيانات من الإنترنت لأي موضوع أو دولة أو لغة أو فترة يحددها العميل، مع ملفات منظمة ومنهجية منفصلة عند الطلب.",
    recordCap: 600,
    pointCap: 600,
    openTopics: ["الرياضة", "الشركات", "صناع القرار", "المحتوى الاجتماعي", "أي موضوع يحدده العميل لمنشورات وتعليقات وفيديوهات المنصات"],
    unavailableAr: ["جمع الدراسات والأبحاث الأكاديمية", "جمع المقالات والأخبار من المواقع"],
  },
  services: [
    { slug: "icypeas-companies-search", nameAr: "بحث الشركات", descriptionAr: "قوائم شركات وبياناتها وفق المجال والدولة المطلوبة.", requiredInputs: ["country", "industry", "count"], maxRecords: 500, exampleAr: "عايز ٥ شركات كهرباء في مصر", examplePlanAr: "خطوة واحدة: حتى ٥ شركات كهرباء في مصر، بملف منظم." },
    { slug: "professional-people-search", nameAr: "صناع القرار والمهنيون", descriptionAr: "أسماء ومناصب وشركات وروابط مهنية وبريد عمل وهاتف مكتبي، مع حالة منفصلة لكل حقل.", requiredInputs: ["country", "company_or_industry", "roles", "count"], maxRecords: 500, defaultContactFields: ["work_email", "phone"], customerPlanNoteAr: "يُحتسب سجل الشخص، ثم البريد المهني والهاتف المكتبي كلٌ على حدة عند إعادتهما؛ وتظهر حالة كل حقل.", exampleAr: "عايز ٣ مديرين في شركات الطاقة في السعودية مع إيميلاتهم وأرقام مكاتبهم", examplePlanAr: "خطوة واحدة: حتى ٣ مديرين في شركات الطاقة في السعودية، مع سجل الشخص والبريد المهني والهاتف المكتبي كلٌّ على حدة." },
    ...SOCIAL_CAPABILITIES.map((cap) => ({
      slug: cap.slug,
      nameAr: cap.nameAr,
      descriptionAr: cap.descriptionAr,
      requiredInputs: cap.slug === "social-tiktok-comments" || cap.slug === "social-youtube-comments"
        ? ["platform", "video_url_or_topic", "channel_if_channel_mode", "country_if_trending"]
        : cap.slug === "social-facebook-comments"
          ? ["platform", "post_url_or_page"]
          : cap.slug === "social-tiktok-videos"
            ? ["topic_or_channel", "country_if_trending"]
            : cap.slug === "social-youtube-videos"
              ? ["topic_or_channel"]
              : cap.slug === "social-x-posts"
                ? ["topic_or_account_handle"]
              : ["facebook_page"],
      maxRecords: cap.maxRows,
      exampleAr: cap.slug === "social-youtube-comments" ? "هات ١٠ تعليقات على فيديو يوتيوب، وألصق رابط الفيديو في رسالتك" :
        cap.slug === "social-tiktok-videos" ? "عايز ١٠ فيديوهات ترند على تيك توك في مصر" :
        cap.slug === "social-facebook-comments" ? "هات كومنتات بوست فيسبوك، وألصق رابط البوست في رسالتك" :
        cap.slug === "social-tiktok-comments" ? "هات ١٠ كومنتس على فيديو تيك توك، وألصق رابط الفيديو في رسالتك" :
        cap.slug === "social-youtube-videos" ? "هات ١٠ فيديوهات من قناة يوتيوب، واكتب اسم القناة أو رابطها في رسالتك" :
        cap.slug === "social-x-posts" ? "هات ٢٠ تغريدة عن كرة السلة من الأسبوع الماضي" :
        "هات ١٠ بوستات من صفحة فيسبوك، واكتب اسم الصفحة أو رابطها في رسالتك",
      examplePlanAr: cap.slug.includes("comments") ? "خطوة واحدة: حتى ١٠ تعليقات من الرابط أو الموضوع المحدد." : cap.slug === "social-x-posts" ? "خطوة واحدة: حتى ٢٠ منشوراً عن كرة السلة خلال الأسبوع الماضي." : "خطوة واحدة: حتى ١٠ منشورات أو فيديوهات من القناة أو الموضوع المحدد.",
    })),
    { slug: "tiktok-profile", nameAr: "فيديوهات القنوات والملفات الاجتماعية", descriptionAr: "محتوى قناة أو حساب محدد حسب الخدمة المطلوبة.", requiredInputs: ["account_handle"], maxRecords: 200, exampleAr: "هات آخر ١٠ فيديوهات من حساب تيك توك أحدده لك", examplePlanAr: "خطوة واحدة: حتى ١٠ فيديوهات من القناة المحددة." },
  ] satisfies GuideService[],
  futureSources: [
    { slug: "future-web-collection", nameAr: "بحث وجمع صفحات الويب المتقدمة", statusAr: "قريباً" },
    { slug: "future-context-search", nameAr: "بحث سياقي موسّع", statusAr: "قريباً" },
  ],
  rulesAr: [
    "جمع الدراسات والأبحاث والمقالات والأخبار من المواقع غير متاح بعد: قلها بوضوح مع المتاح (الشركات وصناع القرار ومنشورات وتعليقات وفيديوهات المنصات)، ولا تعرض منصات التواصل كمصدر للدراسات.",
    "كل موضوع مسموح، مثل كرة القدم أو كرة السلة أو أي مجال آخر؛ لا تقل إنك تبحث في مجال واحد فقط.",
    "استخدم القائمة الكاملة للخدمات في كل مرة، حتى إن كانت نتائج بحث الكتالوج مقتصرة على خدمة واحدة.",
    "اعتبر كل خدمة مدرجة ضمن قدرات ديجر؛ اسأل عن المدخل الناقص فقط، ولا تقترح منصة لا تطابق طلب العميل.",
    "إذا نقص مدخل أساسي، اسأل سؤالاً قصيراً واحداً فقط في كل رسالة.",
    "حد المهمة ٦٠٠ نقطة، وحد السجلات تحدده الخدمة. اذكر تقليل العدد إذا لم يلائم السقف.",
    "الأسعار والحجز والخصم يحسبها الخادم فقط؛ لا تستنتج أو تعد بسعر من عندك.",
  ],
} as const;

export function buildPlatformGuideServices(capabilities: Capability[] = APPROVED_CAPABILITY_CATALOG): GuideService[] {
  const liveBySlug = new Map(capabilities.map((cap) => [cap.slug, cap]));
  const socialSlugs = new Set(SOCIAL_CAPABILITIES.map((cap) => cap.slug));
  return PLATFORM_GUIDE.services.map((service) => {
    if (socialSlugs.has(service.slug)) return service;
    const cap = liveBySlug.get(service.slug);
    if (!cap) return service;
    return {
      ...service,
      nameAr: cap.nameAr,
      descriptionAr: cap.descriptionAr,
      maxRecords: cap.maxRows,
      requiredInputs: cap.requiredInputs || service.requiredInputs,
    };
  });
}

export function platformGuidePromptText(): string {
  // This is immutable product knowledge. Keep it compact and place it in the cacheable system prefix. The full service list
  // stays here by slug and name only; each service's inputs, filters, returns and examples are its structured card
  // (capabilityCards.ts) in the capability block, so the prose descriptions are not repeated.
  const services = buildPlatformGuideServices().map((service) => ({ slug: service.slug, nameAr: service.nameAr, maxRecords: service.maxRecords }));
  return JSON.stringify({ ...PLATFORM_GUIDE, services });
}
