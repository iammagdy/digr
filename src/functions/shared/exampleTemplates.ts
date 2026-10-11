import {
  buildApprovedCatalog,
  getRegistryPricingSettings,
  type CapabilityStatus,
  type RegistryPricingSettings,
} from "./capabilityRegistry";

export const EXAMPLE_TEMPLATES_HEADING_AR = "أمثلة جاهزة";
export const EXAMPLE_PRICE_DISCLAIMER_AR = "السعر تقريبي ويُحسب نهائيًا بعد الموافقة على الخطة";

export interface ExampleTemplateStep {
  capabilityId: string;
  estimatedUnits: number;
}

export interface ReadyExampleTemplate {
  id: string;
  titleAr: string;
  platformAr: string;
  status: CapabilityStatus;
  shortDescriptionAr: string;
  deliverablesAr: string;
  editablePromptAr: string;
  steps: ExampleTemplateStep[];
  approximatePoints: number;
  disclaimerAr: string;
}

interface ExampleTemplateSeed {
  id: string;
  titleAr: string;
  platformAr: string;
  shortDescriptionAr: string;
  deliverablesAr: string;
  editablePromptAr: string;
  steps: ExampleTemplateStep[];
}

const EXAMPLE_TEMPLATE_SEEDS: ExampleTemplateSeed[] = [
  {
    id: "tiktok-public-profile-study",
    titleAr: "تحليل ملف حساب عام على تيك توك",
    platformAr: "تيك توك",
    shortDescriptionAr: "فحص المؤشرات العامة لحساب رسمي أو صانع محتوى على تيك توك وتوثيق إحصائياته.",
    deliverablesAr: "ملفات Excel وCSV وPDF تتضمن المعرّف والنبذة وعدد المتابعين والإعجابات والمقاطع مع بطاقة المنهجية.",
    editablePromptAr: "أريد استخراج بيانات الملف العام لحساب @tiktok على تيك توك مع الإحصائيات الأساسية بصيغة Excel وPDF وCSV.",
    steps: [{ capabilityId: "tiktok-profile", estimatedUnits: 1 }],
  },
  {
    id: "facebook-marriage-topics-comments",
    titleAr: "رصد تعليقات فيسبوك حول قضايا الأسرة وقائمة المنقولات",
    platformAr: "فيسبوك",
    shortDescriptionAr: "بحث متعدد الكلمات في المنشورات العامة على فيسبوك ثم جمع التعليقات والردود لتحليل اتجاهات الرأي العام.",
    deliverablesAr: "ملفات Excel وCSV وPDF تشمل جدول المنشورات وجدول التعليقات المرتبطة بمعرّف المنشور وتاريخ النشر ودليل المتغيرات.",
    editablePromptAr:
      "أريد خطة لجمع المنشورات العامة والتعليقات على فيسبوك حول قائمة المنقولات وتكاليف الزواج في مصر خلال الفترة من 1 يناير 2026 إلى 30 سبتمبر 2026 بحد أقصى 10 منشورات و50 تعليقاً لكل منشور.",
    steps: [
      { capabilityId: "facebook-post-search", estimatedUnits: 1 },
      { capabilityId: "facebook-post-comments", estimatedUnits: 5 },
    ],
  },
  {
    id: "x-public-keyword-sample",
    titleAr: "عينة تغريدات عامة حول موضوع بحثي على منصة X",
    platformAr: "منصة X",
    shortDescriptionAr: "جمع عينة محددة السقف من المنشورات العامة حسب الكلمات المفتاحية والفترة الزمنية.",
    deliverablesAr: "ملفات Excel وCSV وPDF تحتوي على نص التغريدة وتاريخ النشر ومؤشرات التفاعل ورابط المصدر.",
    editablePromptAr: "أريد جمع عينة حتى 100 تغريدة عامة على منصة X حول الذكاء الاصطناعي في التعليم خلال آخر 30 يوماً.",
    steps: [{ capabilityId: "x-keyword-search", estimatedUnits: 5 }],
  },
  {
    id: "youtube-video-comments-analysis",
    titleAr: "تحليل مقاطع وتعليقات يوتيوب حول موضوع علمي",
    platformAr: "يوتيوب",
    shortDescriptionAr: "البحث عن مقاطع يوتيوب عامة حول موضوع محدد مع سحب عينة من تعليقات الجمهور.",
    deliverablesAr: "ملفات Excel وCSV وPDF تضم قائمة المقاطع وإحصائيات المشاهدة وجدول التعليقات وملخص التغطية.",
    editablePromptAr: "أريد البحث عن مقاطع يوتيوب عامة حول الطاقة المتجددة واستخراج حتى 100 تعليق من أبرز المقاطع.",
    steps: [
      { capabilityId: "youtube-search", estimatedUnits: 1 },
      { capabilityId: "youtube-comments", estimatedUnits: 4 },
    ],
  },
];

/**
 * Builds ready-to-use example templates with approximate points dynamically computed
 * from the capability registry (never hardcoded by hand).
 */
export function buildReadyExampleTemplates(
  settingsOverride?: Partial<RegistryPricingSettings>
): ReadyExampleTemplate[] {
  const catalog = buildApprovedCatalog(getRegistryPricingSettings(settingsOverride));
  const byId = new Map(catalog.map((c) => [c.id, c]));

  return EXAMPLE_TEMPLATE_SEEDS.map((seed) => {
    let approximatePoints = 0;
    let overallStatus: CapabilityStatus = "verified";

    for (const step of seed.steps) {
      const cap = byId.get(step.capabilityId);
      if (!cap) {
        throw new Error(`Example template "${seed.id}" references unknown capability "${step.capabilityId}"`);
      }
      approximatePoints += (cap.pointsPerUnit ?? 0) * step.estimatedUnits;
      if (cap.status === "planned") {
        overallStatus = "planned";
      } else if (cap.status === "pending_verification" && overallStatus === "verified") {
        overallStatus = "pending_verification";
      }
    }

    return {
      id: seed.id,
      titleAr: seed.titleAr,
      platformAr: seed.platformAr,
      status: overallStatus,
      shortDescriptionAr: seed.shortDescriptionAr,
      deliverablesAr: seed.deliverablesAr,
      editablePromptAr: seed.editablePromptAr,
      steps: seed.steps,
      approximatePoints,
      disclaimerAr: EXAMPLE_PRICE_DISCLAIMER_AR,
    };
  });
}
