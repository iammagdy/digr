import { APPROVED_CAPABILITY_CATALOG, registryPointsPerUnit } from "../functions/shared/capabilityRegistry";
import { SOCIAL_CAPABILITIES } from "./socialSources";
import { effectiveSocialMaxRows } from "./scaleConfig";
import { JOB_MAX_POINTS_CAP } from "./jobPointsCap";
import { volumeForPointsCap } from "./pointsCap";
import { COVERAGE_FAMILIES } from "./requestCoverage";
import { EGYPT_NEWS_SOURCES, NEWS_SOURCES_VERIFIED_ON, hasMachineAccess } from "./newsSources";

/**
 * docs/CAPABILITY_COVERAGE.md, built from the code's own tables (the registry, the social sources, the coverage matrix, the newspaper
 * list). A test compares the committed file with this output, so the page the owner reads is the table the platform uses.
 * Regenerate with: npx tsx scripts/generate-coverage-doc.ts
 */

/** What is really executable today (the other registry rows name endpoints the live catalog does not publish). */
const SELLABLE: Array<{ slug: string; shapes: string }> = [
  { slug: "icypeas-companies-search", shapes: "«٥٠ شركة كهرباء في مصر»: نشاط + دولة + عدد" },
  { slug: "professional-people-search", shapes: "«٣ صناع قرار في شركات برمجيات بالسعودية مع البريد والهاتف»" },
  { slug: "social-x-posts", shapes: "منشورات إكس بكلمة أو حدث أو حساب، بنافذة تاريخ" },
  { slug: "social-tiktok-comments", shapes: "تعليقات فيديو برابط، أو فيديوهات تُعثر عليها بكلمة/قناة/ترند، أو مهمة قنوات (أعلى فيديوهات ثم التعليقات)" },
  { slug: "social-youtube-comments", shapes: "كما سبق على يوتيوب (بحث بكلمة مع نافذة تاريخ، أو قنوات، أو رابط)" },
  { slug: "social-facebook-comments", shapes: "تعليقات منشور برابطه أو منشورات صفحة عامة" },
  { slug: "social-facebook-keyword-comments", shapes: "تعليقات منشورات فيسبوك العامة التي يجدها النظام بكلمة أو موضوع (اختيار المنشورات المتعلقة بالموضوع ثم قراءة تعليقاتها)؛ خدمة جديدة لم تُجرَّب حيًّا بعد" },
  { slug: "social-tiktok-videos", shapes: "فيديوهات تيك توك بكلمة أو قناة أو ترند دولة" },
  { slug: "social-youtube-videos", shapes: "فيديوهات يوتيوب بكلمة أو قناة أو شورتس رائجة" },
  { slug: "social-facebook-posts", shapes: "منشورات صفحة فيسبوك عامة" },
];

const STATUS_AR = { supported: "مدعوم", partly: "جزئي", not_supported: "غير مدعوم" } as const;
const n = (value: number) => new Intl.NumberFormat("en-US").format(value);

export function buildCoverageDoc(): string {
  const lines: string[] = [];
  lines.push("# تغطية ديجر: ما الذي نبيعه فعلًا، وما الذي لا نبيعه");
  lines.push("");
  lines.push("> يُولَّد هذا الملف من جداول الكود نفسها (`npx tsx scripts/generate-coverage-doc.ts`)، ويقارنه اختبار بالنسخة المولّدة، فلا يختلف ما تقرأه عمّا تستخدمه المنصة.");
  lines.push("> السعر بالنقاط (١ نقطة = ٠٫١٠ جنيه). سقف المهمة الواحدة حاليًا " + n(JOB_MAX_POINTS_CAP) + " نقطة، والحجز يتضمن هامش ١٥٪. لا شيء هنا يغيّر سعرًا أو سقفًا.");
  lines.push("");
  lines.push("## ١. ما نبيعه اليوم");
  lines.push("");
  lines.push("| الخدمة | المصدر (معرّفات الكتالوج) | وحدة السعر | نقاط الوحدة | أقصى حجم بسقف النقاط | أقصى صفوف للخدمة | صيغ الطلب المدعومة |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const { slug, shapes } of SELLABLE) {
    const capability = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === slug);
    if (!capability) throw new Error(`capability ${slug} is not in the catalog`);
    const social = SOCIAL_CAPABILITIES.find((def) => def.slug === slug);
    const endpoints = social
      ? [...new Set([...(social.comments ?? []), ...Object.values(social.discover).flatMap((sources) => sources ?? [])].map((source) => source.endpointId))].join("، ")
      : String((capability as any).tregEndpointId ?? "");
    const unit = social ? registryPointsPerUnit(social.slug, social.customerPriceUsdPerItem ?? social.rowCostUsd) : Number(capability.pointsPerUnit ?? 0);
    const byCap = volumeForPointsCap(JOB_MAX_POINTS_CAP, unit);
    const rows = social ? effectiveSocialMaxRows(social.maxRows, social.kind) : Number((capability as any).maxRows ?? 0);
    lines.push(`| ${capability.nameAr} (\`${slug}\`) | ${endpoints} | ${String((capability as any).pricingUnit ?? capability.unit) === "item" ? "سجل" : String((capability as any).pricingUnit ?? capability.unit)} | ${unit} | ${n(byCap)} | ${n(rows)} | ${shapes} |`);
  }
  lines.push("");
  lines.push("المرجع الرقمي للسعر هو سجل القدرات في الكود، وسقف الصفوف يتبع إعدادات الحجم (`scaleConfig`). ما لم يُذكر هنا فهو غير مباع.");
  lines.push("");
  lines.push("## ٢. مصفوفة السيناريوهات (١٤ عائلة طلب + رفض البيانات الخاصة)");
  lines.push("");
  lines.push("| # | العائلة | الحالة | ما يخدمها اليوم | ما ينقص | أمثلة |");
  lines.push("|---|---|---|---|---|---|");
  for (const family of COVERAGE_FAMILIES) {
    lines.push(`| ${family.no} | ${family.titleAr} (\`${family.id}\`) | **${STATUS_AR[family.status]}** | ${family.servedByAr} | ${family.missingAr} | ${family.shapes.join(" / ")} |`);
  }
  lines.push("");
  lines.push("## ٣. الأخبار والمقالات الصحفية: لماذا هي «غير مدعومة»");
  lines.push("");
  lines.push("لا توجد في سجل القدرات ولا في كتالوج المصادر المحفوظ أي خدمة تقرأ صفحات الويب أو خلاصات الأخبار أو خرائط المواقع. المعرّفات التي ظهرت في ملفات قديمة (`serp.google.search`، `web.article.extract`، `telegram.channel.messages`) غير منشورة في الكتالوج الحي وغير مفعّلة ولا مؤكدة، ومعرّف `crawl4ai.web.extract` يظهر في اختبار فقط. **لم نفعّل أي مصدر جديد.** قرار التفعيل للمالك: يلزم قراءة الكتالوج الحي للتأكد من وجود خدمة استخراج صفحات (معرّفها وسعرها ومعاملاتها) ثم اعتمادها بالاسم.");
  lines.push("");
  lines.push("الجاهز في الكود ومُختبَر ومُطفأ حتى توجد خدمة قراءة: قائمة الصحف الموثقة، وسؤال اختيار المصادر، ومعايير ملف الأخبار (التاريخ، الصحيفة، العنوان، الرابط، مقتطف قصير، الكلمات المطابقة، حذف المكرر بالرابط وبالعنوان المتقارب) وملف سلسلة الأسعار (التاريخ، السعر، المصدر، التغير عن الفترة السابقة).");
  lines.push("");
  lines.push(`### الصحف الموثقة (قيست بتاريخ ${NEWS_SOURCES_VERIFIED_ON})`);
  lines.push("");
  lines.push("| الصحيفة | الموقع | رسمية/قومية | بحث | خريطة موقع | خلاصة | قابلة للقراءة آليًا |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const source of EGYPT_NEWS_SOURCES) {
    lines.push(`| ${source.nameAr} | ${source.domain} | ${source.official ? "نعم" : "لا"} | ${source.access.search ? "نعم" : "لا"} | ${source.access.sitemap ? "نعم" : "لا"} | ${source.access.feed ? "نعم" : "لا"} | ${hasMachineAccess(source) ? "نعم" : "لا"} |`);
  }
  lines.push("");
  lines.push("القياس بطلبات قراءة عامة من بيئة التطوير؛ بعض المواقع تحجب الاتصال الآلي (رمز ٤٠٣)، وهذا لا يعني أنها بلا خرائط، ويُعاد القياس من بيئة الإنتاج قبل الاعتماد على أي صف.");
  lines.push("");
  lines.push("## ٤. الخطط متعددة الأجزاء");
  lines.push("");
  lines.push("التنفيذ والحجز عبر المسار الحالي يدعمان قدرة بحثية واحدة لكل عرض (`quoteAccept`). لذلك يعرض الطلب المختلط **جزأه المباع بسعره** ويذكر في بطاقة الخطة كل جزء غير مباع وسببه، وما سوى ذلك يُطلب بعرض لاحق. لا منطق مال جديد.");
  lines.push("");
  lines.push("## ٥. سجل الطلبات غير المخدومة");
  lines.push("");
  lines.push("كل طلب يُرفض أو يُخدم جزئيًا يُكتب في الجدول القائم `capability_requests` (العمود `query` = «العائلة: كلمات العميل») ويظهر في صفحة المشرف «طلبات غير مدعومة» (`/admin/requests`) بعدّ لكل عائلة. لا جدول جديد ولا هجرة.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}
