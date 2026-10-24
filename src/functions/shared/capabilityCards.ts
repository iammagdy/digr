import { FACEBOOK_REPORT_ENABLED } from "../../lib/facebookReport/registry";
/**
 * One compact, structured card per capability: what it does, the inputs and filters it accepts (and in what language or
 * format), what it returns, what it is good and not good for, and request-to-parameter examples. The model reads these
 * instead of long prose, so it picks the right service and fills the provider parameters in the form the source matches.
 * Every card is checked against the real catalog by tests: the slug exists, and every input it names is in the
 * capability's own parameter schema.
 */
export interface CapabilityCard {
  slug: string;
  /** One plain Arabic sentence: what it collects. */
  what: string;
  /** name=how to fill it (format and language). Only names that exist in the capability's schema. */
  inputs: string[];
  /** How to filter by activity / country / language, or what cannot be filtered. */
  filters: string;
  returns: string;
  goodFor: string;
  notFor: string;
  /** 2 to 3 request-to-parameter mappings. */
  examples: Array<{ ask: string; params: Record<string, unknown> }>;
}

/** Said once in the block header instead of on every social card. */
export const SOCIAL_COMMON_RULES_AR = "قواعد مشتركة لخدمات المنصات (إكس، تيك توك، يوتيوب، فيسبوك): region=رمز ISO للدولة إن ذكرها العميل؛ الموضوع في query كما كتبه العميل؛ لا فلتر للغة ولا للنشاط، وتُراجَع الصفوف بعد الاستلام؛ الفترة الزمنية تُستخدم فقط إن كتبها العميل ولا تُسأل للتعليقات.";
const SOCIAL_FILTERS = "القواعد المشتركة";

export const CAPABILITY_CARDS: CapabilityCard[] = [
  {
    slug: "icypeas-companies-search",
    what: "قوائم شركات حسب النشاط والدولة مع الموقع والهاتف والبريد حيث توفر",
    inputs: [
      "query.location.include=[اسم الدولة بالإنجليزية]",
      "query.industry.include=[تصنيف النشاط الإنجليزي من قائمة المصدر]",
      "query.keyword.include=[كلمات إنجليزية للنشاط]",
      "pagination.size=عدد الصفوف في الصفحة",
    ],
    filters: "الدولة: Egypt وليس مصر؛ النشاط: تصنيف المصدر (Utilities، Construction...) مع كلمات إنجليزية؛ لا فلتر لحجم الشركة أو الإيرادات أو المدينة",
    returns: "اسم الشركة والنشاط والموقع والموقع الإلكتروني والهاتف والبريد وصفحة لينكد إن",
    goodFor: "طلب شركات في مجال ودولة",
    notFor: "أشخاص بأسمائهم أو مناصبهم، أو شركة محددة بالاسم، أو تصفية بالحجم والإيراد",
    examples: [
      { ask: "٥ شركات كهرباء في مصر", params: { query: { location: { include: ["Egypt"] }, industry: { include: ["Electrical/Electronic Manufacturing", "Utilities"] }, keyword: { include: ["electrical", "electricity"] } }, pagination: { size: 5 } } },
      { ask: "٢٠ شركة مقاولات في السعودية", params: { query: { location: { include: ["Saudi Arabia"] }, industry: { include: ["Construction"] }, keyword: { include: ["construction", "contracting"] } }, pagination: { size: 20 } } },
    ],
  },
  {
    slug: "professional-people-search",
    what: "صناع قرار ومهنيون بأسمائهم ومناصبهم وشركاتهم مع البريد المهني والهاتف عند توفرهما",
    inputs: [
      "title=المسمى الوظيفي بالإنجليزية (Director, CEO, General Manager, Founder)",
      "country=رمز الدولة ISO (SA, EG)",
      "keywords=[كلمات النشاط بالإنجليزية]",
      "location=مدينة أو دولة بالإنجليزية (اختياري)",
      "company_domain=نطاق شركة محددة إن ذُكرت",
      "limit=العدد",
      "q=اسم شخص أو شركة فقط، ولا تنسخ جملة العميل",
    ],
    filters: "الدولة: رمز ISO؛ النشاط: كلمات إنجليزية في keywords؛ المنصب: عنوان إنجليزي في title؛ لا فلتر لحجم الشركة",
    returns: "الاسم، المنصب، الشركة، رابط مهني، بريد العمل، الهاتف، وحالة كل حقل على حدة",
    goodFor: "طلب مديرين أو رؤساء تنفيذيين أو مؤسسين مع بيانات التواصل",
    notFor: "قائمة شركات بلا أشخاص، أو بيانات شخصية خاصة",
    examples: [
      { ask: "٣ مديرين في شركات الطاقة في السعودية مع إيميلاتهم وأرقامهم", params: { title: "Director", country: "SA", keywords: ["energy", "power", "utilities"], limit: 3 } },
      { ask: "٥ رؤساء تنفيذيين في شركات التقنية في مصر", params: { title: "CEO", country: "EG", keywords: ["information technology", "software"], limit: 5 } },
    ],
  },
  {
    slug: "social-x-posts",
    what: "منشورات عامة على منصة إكس بكلمة أو موضوع، أو أحدث منشورات حساب",
    inputs: ["query=الموضوع كما كتبه العميل", "channel=@حساب لأحدث منشوراته", "region=رمز الدولة ISO إن ذكرها العميل"],
    filters: SOCIAL_FILTERS,
    returns: "نص المنشور، الكاتب، التاريخ، الإعجابات، إعادة النشر، الردود، المشاهدات",
    goodFor: "تغريدات عن موضوع أو حساب",
    notFor: "تعليقات على فيديو، أو دراسات وأبحاث",
    examples: [
      { ask: "هات ١٠ تغريدات عن كرة السلة", params: { query: "كرة السلة" } },
      { ask: "آخر ٢٠ تغريدة من @example_account", params: { channel: "@example_account" } },
    ],
  },
  {
    slug: "social-tiktok-comments",
    what: "تعليقات فيديوهات تيك توك: لفيديو برابطه، أو لفيديوهات يختارها النظام من بحث بكلمة أو قناة أو الرائج",
    inputs: ["url=رابط فيديو", "query=الموضوع", "channel=@قناة", "trending=true مع region", "region=رمز الدولة ISO"],
    filters: SOCIAL_FILTERS,
    returns: "نص التعليق، الكاتب، التاريخ، الإعجابات، الردود، رابط الفيديو",
    goodFor: "آراء الناس على فيديوهات في موضوع",
    notFor: "بيانات الفيديو نفسه (استخدم خدمة الفيديوهات)",
    examples: [
      { ask: "١٠ كومنتس تيك توك عن كرة السلة في مصر", params: { query: "كرة السلة", region: "EG" } },
      { ask: "تعليقات هذا الفيديو https://www.tiktok.com/@a/video/1", params: { url: "https://www.tiktok.com/@a/video/1" } },
    ],
  },
  {
    slug: "social-youtube-comments",
    what: "تعليقات مقاطع يوتيوب: لمقطع برابطه، أو لمقاطع من بحث بكلمة أو قناة أو الرائج",
    inputs: ["url=رابط مقطع", "query=الموضوع", "channel=@قناة", "trending=true", "region=رمز الدولة ISO"],
    filters: SOCIAL_FILTERS,
    returns: "نص التعليق، الكاتب، التاريخ، الإعجابات، الردود، رابط المقطع",
    goodFor: "آراء الناس على مقاطع يوتيوب",
    notFor: "بيانات المقطع نفسه",
    examples: [{ ask: "٣٠ تعليق يوتيوب عن الطاقة الشمسية", params: { query: "الطاقة الشمسية" } }],
  },
  {
    slug: "social-facebook-comments",
    what: "تعليقات منشور فيسبوك عام برابطه أو لمنشورات صفحة",
    inputs: ["url=رابط منشور", "channel=رابط صفحة"],
    filters: "لا بحث بكلمة: يلزم رابط منشور أو صفحة؛ لا فلتر لغة أو نشاط",
    returns: "نص التعليق، الكاتب، التاريخ، الإعجابات",
    goodFor: "تعليقات منشور أو صفحة محددة",
    notFor: "بحث عام بكلمة على فيسبوك",
    examples: [{ ask: "تعليقات هذا المنشور https://www.facebook.com/page/posts/1", params: { url: "https://www.facebook.com/page/posts/1" } }],
  },
  {
    slug: "social-facebook-keyword-comments",
    what: "تعليقات منشورات فيسبوك العامة التي يجدها النظام بكلمة أو موضوع: يختار المنشورات المتعلقة بالموضوع فقط ثم يقرأ تعليقاتها",
    inputs: ["query=الموضوع كما كتبه العميل"],
    filters: SOCIAL_FILTERS,
    returns: "نص التعليق، الكاتب، التاريخ، الإعجابات، رابط المنشور",
    goodFor: "آراء الناس على منشورات فيسبوك في موضوع، مثل «٣٠٠ منشور عن الترندات الصحية بخمسة تعليقات لكل منشور»",
    notFor: "منشورات صفحة بعينها أو رابط منشور (استخدم خدمة تعليقات فيسبوك)، أو منشورات بلا تعليقاتها",
    examples: [{ ask: "٣٠٠ منشور فيسبوك عن الترندات الصحية بخمسة تعليقات لكل منشور", params: { query: "الترندات الصحية" } }],
  },
  ...(FACEBOOK_REPORT_ENABLED ? [{
    slug: "facebook-topic-report",
    what: "تقرير عن موضوع على فيسبوك في دولة وفترة محددتين: منشورات من صفحات عامة موثوقة تخص الدولة وتعليقاتها، مصنّفة على محاور، مع ملف إكسل للبيانات وملف بي دي إف منفصل للمنهجية والتحليل",
    inputs: ["query=الموضوع كما كتبه العميل بلا كلمة «تقرير»", "region=رمز ISO للدولة (إلزامي: لا تُستخدم إلا صفحات الدولة نفسها)"],
    filters: "الدولة إلزامية والفترة يذكرها العميل ولا تُقترح؛ لا فلتر للغة ولا للنشاط؛ لا تُنتقى التعليقات",
    returns: "المنشورات (المحور، الناشر، التاريخ، النص، التفاعلات، المشاركات، الرابط) وتعليقاتها (المعلّق، التاريخ، النص، التفاعلات، الردود)",
    goodFor: "طلب «تقرير» أو «رصد» أو «تحليل» عن موضوع على فيسبوك، مثل «تقرير عن الترندات الصحية في مصر آخر ٣ شهور»",
    notFor: "تعليقات منشورات عن موضوع بلا تقرير (استخدم تعليقات فيسبوك عن موضوع)، أو منشورات صفحة بعينها أو رابط منشور، أو موضوع لا صفحات موثّقة له",
    examples: [{ ask: "تقرير عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور", params: { query: "الترندات الصحية", region: "EG" } }],
  }] : []),
  {
    slug: "social-tiktok-videos",
    what: "فيديوهات تيك توك: بحث بكلمة، أو فيديوهات قناة، أو الرائج في دولة",
    inputs: ["query=الموضوع", "channel=@قناة", "trending=true", "region=رمز الدولة ISO (إلزامي للرائج)"],
    filters: SOCIAL_FILTERS,
    returns: "وصف الفيديو، القناة، التاريخ، المشاهدات، الإعجابات، التعليقات، المشاركات، رابط الفيديو",
    goodFor: "فيديوهات في موضوع أو الرائجة",
    notFor: "نص تعليقات الفيديو",
    examples: [{ ask: "أكتر ١٠ فيديوهات ترند في مصر على تيك توك", params: { trending: true, region: "EG" } }],
  },
  {
    slug: "social-youtube-videos",
    what: "مقاطع يوتيوب: بحث بكلمة، أو مقاطع قناة، أو الشورتس الرائجة",
    inputs: ["query=الموضوع", "channel=@قناة", "trending=true"],
    filters: SOCIAL_FILTERS,
    returns: "عنوان المقطع، القناة، التاريخ، المشاهدات، رابط المقطع",
    goodFor: "مقاطع في موضوع",
    notFor: "نص التعليقات",
    examples: [{ ask: "١٠ فيديوهات يوتيوب عن مشروع صغير", params: { query: "مشروع صغير" } }],
  },
  {
    slug: "social-facebook-posts",
    what: "منشورات صفحة فيسبوك عامة",
    inputs: ["channel=رابط الصفحة"],
    filters: "يلزم رابط صفحة؛ لا بحث بكلمة؛ لا فلتر لغة أو نشاط",
    returns: "نص المنشور، الصفحة، التاريخ، التفاعلات، رابط المنشور",
    goodFor: "منشورات صفحة محددة",
    notFor: "بحث عام بكلمة",
    examples: [{ ask: "آخر ١٠ منشورات من صفحة https://www.facebook.com/example", params: { channel: "https://www.facebook.com/example" } }],
  },
  {
    slug: "tiktok-profile",
    what: "بيانات حساب تيك توك عام: المتابعون والنبذة والتوثيق",
    inputs: ["username=اسم الحساب بلا @"],
    filters: "حساب واحد؛ لا فلاتر",
    returns: "الاسم، النبذة، المتابعون، الإعجابات، عدد الفيديوهات، التوثيق",
    goodFor: "إحصائيات حساب معروف",
    notFor: "فيديوهات الحساب أو تعليقاتها",
    examples: [{ ask: "بيانات حساب تيك توك @example_user", params: { username: "example_user" } }],
  },
  {
    slug: "instagram-profile",
    what: "بيانات حساب إنستغرام عام",
    inputs: ["username=اسم الحساب بلا @"],
    filters: "حساب واحد؛ لا فلاتر",
    returns: "الاسم، النبذة، المتابعون، عدد المنشورات",
    goodFor: "إحصائيات حساب معروف",
    notFor: "منشورات الحساب",
    examples: [{ ask: "بيانات حساب إنستغرام @example_user", params: { username: "example_user" } }],
  },
  {
    slug: "linkedin-profile",
    what: "بيانات صفحة مهنية عامة على لينكد إن برابطها",
    inputs: ["profileUrl=رابط الصفحة"],
    filters: "صفحة واحدة برابطها؛ لا بحث",
    returns: "الاسم، المنصب، الشركة، النبذة",
    goodFor: "صفحة محددة برابطها",
    notFor: "البحث عن أشخاص (استخدم بحث صناع القرار)",
    examples: [{ ask: "بيانات هذا الحساب https://www.linkedin.com/in/example", params: { profileUrl: "https://www.linkedin.com/in/example" } }],
  },
];

/** Short entries for older routes that overlap a main service: the main card is used whenever it fits. */
export const LEGACY_CAPABILITY_NOTES: Record<string, string> = {
  "facebook-post-comments": "تعليقات منشور فيسبوك برابطه (postUrl, maxPages)؛ الأفضل social-facebook-comments",
  "facebook-post-search": "بحث منشورات فيسبوك بكلمة (query, dateFrom, dateTo)",
  "x-keyword-search": "بحث إكس بكلمة (query, max_results)؛ الأفضل social-x-posts",
  "youtube-comments": "تعليقات مقطع (videoId, count)؛ الأفضل social-youtube-comments",
  "youtube-search": "بحث يوتيوب بكلمة (query, count)؛ الأفضل social-youtube-videos",
  "instagram-comments": "تعليقات منشور إنستغرام برابطه (postUrl)",
  "reddit-post-comments": "تعليقات منشور ريديت برابطه (postUrl)",
  "icypeas-people-search": "بحث أشخاص بصيغة الاستعلام المركب؛ الأفضل professional-people-search",
};

const cardIndex = new Map(CAPABILITY_CARDS.map((card) => [card.slug, card]));

export function getCapabilityCard(slug: string): CapabilityCard | undefined {
  return cardIndex.get(slug);
}

/** Compact text of one card. */
export function renderCapabilityCard(card: CapabilityCard): string {
  const examples = card.examples.map((e) => `«${e.ask}» ← ${JSON.stringify(e.params)}`).join(" | ");
  return [
    `[${card.slug}] ${card.what}`,
    `مدخلات: ${card.inputs.join("؛ ")}`,
    `فلاتر: ${card.filters}`,
    `يرجع: ${card.returns}`,
    `يصلح: ${card.goodFor} | لا يصلح: ${card.notFor}`,
    `أمثلة: ${examples}`,
  ].join("\n");
}

type CardCapability = { slug?: string; id?: string; platform?: string; category?: string; nameAr?: string; paramsSchema?: unknown; maxRows?: number };

/** The fixed part of the inventory: every card and every older-route note. It never depends on a catalog search. */
function fixedCapabilityBlocks(): string[] {
  const blocks: string[] = CAPABILITY_CARDS.map(renderCapabilityCard);
  blocks.push(...Object.entries(LEGACY_CAPABILITY_NOTES).map(([slug, note]) => `[${slug}] ${note}`));
  return blocks;
}

/** One short line per capability passed in that has neither a card nor an older-route note (a newly seeded or live-catalog one). */
function extraCapabilityBlocks(capabilities: CardCapability[] = []): string[] {
  const blocks: string[] = [];
  const seen = new Set<string>([...CAPABILITY_CARDS.map((c) => c.slug), ...Object.keys(LEGACY_CAPABILITY_NOTES)]);
  for (const cap of capabilities || []) {
    const slug = String(cap.slug || cap.id || "");
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    let names: string[] = [];
    try {
      const schema = typeof cap.paramsSchema === "string" ? JSON.parse(cap.paramsSchema) : (cap.paramsSchema as any) || {};
      names = Object.keys(schema?.properties || {}).slice(0, 8);
    } catch { /* no schema */ }
    blocks.push(`[${slug}] ${cap.nameAr || slug} (${cap.platform || cap.category || "-"}) مدخلات: ${names.join(", ") || "-"}${cap.maxRows ? ` حتى ${cap.maxRows} سجل` : ""}`);
  }
  return blocks;
}

/**
 * The cacheable part of the prompt: the common social rules, every card and every older-route note. Byte-identical for
 * every user and every turn, so a live catalog search can never change it (and break the prompt cache).
 */
export function renderFixedCapabilityCards(): string {
  return [SOCIAL_COMMON_RULES_AR, ...fixedCapabilityBlocks()].join("\n");
}

/** The per-turn part: services beyond the fixed inventory (empty string when there are none). */
export function renderCapabilityExtras(capabilities: CardCapability[] = []): string {
  return extraCapabilityBlocks(capabilities).join("\n");
}

/**
 * All capabilities as cards. Every card and every older-route note is ALWAYS listed (the full list never depends on what a
 * catalog search returned); a capability passed in that has neither (a newly seeded one) is added with its slug, platform
 * and parameter names, so the list is never shortened either.
 */
export function renderCapabilityCards(capabilities: CardCapability[] = []): string {
  return [SOCIAL_COMMON_RULES_AR, ...fixedCapabilityBlocks(), ...extraCapabilityBlocks(capabilities)].join("\n");
}
