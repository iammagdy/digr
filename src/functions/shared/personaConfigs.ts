export type PersonaType = "student" | "researcher" | "statistician" | "marketer" | "other";

export interface PersonaConfig {
  key: PersonaType;
  titleAr: string;
  tone: string;
  styleGuidanceAr: string;
  defaultVolumeMax: number;
  anonymizeDefault: boolean;
  samplePurposes: string[];
}

export const PERSONA_CONFIGS: Record<PersonaType, PersonaConfig> = {
  student: {
    key: "student",
    titleAr: "طالب جامعي / دراسات عليا",
    tone: "plain language, explains each step, moderate volumes suggested, simple methodology wording, codebook with plain explanations",
    styleGuidanceAr: "لغة عربية مبسطة ومريحة، شرح الخطوات بوضوح، اقتراح أحجام بيانات معتدلة تناسب أبحاث التخرج والماجستير، مع صياغة منهجية ودليل بيانات مبسطين.",
    defaultVolumeMax: 100,
    anonymizeDefault: false,
    samplePurposes: ["رسالة أو بحث أكاديمي", "مشروع تخرج", "تحليل تعليمي"],
  },
  researcher: {
    key: "researcher",
    titleAr: "باحث / أستاذ جامعي",
    tone: "formal academic methodology, limitations and coverage stressed, anonymization offered by default, reproducibility details (IDs, links, absolute times)",
    styleGuidanceAr: "منهجية علمية رصينة ومحكمة، التركيز على حدود العينة ونسبة التغطية، عرض إخفاء هوية الحسابات افتراضياً (Anonymization)، وإبراز معايير التكرار العلمي (معرفات ثابتة، روابط المصادر، وتوقيتات مطلقة).",
    defaultVolumeMax: 500,
    anonymizeDefault: true,
    samplePurposes: ["نشر علمي في مجلة محكمة", "رسالة دكتوراه", "مشروع بحثي ممول"],
  },
  statistician: {
    key: "statistician",
    titleAr: "إحصائي / محلل بيانات",
    tone: "tidy data (one row per item, long format), codebook with types and missing values, parent/child IDs for networks, minimal prose",
    styleGuidanceAr: "بنية بيانات قياسية Tidy Data (سجل واحد لكل سطر بتنسيق طولي)، دليل بيانات صارم يحدد أنواع المتغيرات والقيم المفقودة، معرفات هرمية للشبكات والردود، وتركيز رقمي دقيق دون نصوص إنشائية.",
    defaultVolumeMax: 1000,
    anonymizeDefault: false,
    samplePurposes: ["تحليل إحصائي ونمذجة", "تحليل شبكات التواصل", "أبحاث كمية"],
  },
  marketer: {
    key: "marketer",
    titleAr: "مسوّق / صانع محتوى",
    tone: "insight-oriented, engagement metrics and ranking, short summary, no academic wording",
    styleGuidanceAr: "تركيز تسويقي عملي مباشر، إبراز مؤشرات التفاعل والوصول والمقارنة والتصنيف، ملخص تنفيذي موجز، وتجنب المصطلحات الأكاديمية.",
    defaultVolumeMax: 200,
    anonymizeDefault: false,
    samplePurposes: ["تحليل السوق والمنافسين", "صناعة المحتوى وتتبع الرأي العام", "حملات تسويقية"],
  },
  other: {
    key: "other",
    titleAr: "أخرى",
    tone: "ask one short clarifying question the first time",
    styleGuidanceAr: "سؤال استكشافي موجز لتحديد أهداف التحليل بدقة، ثم اقتراح خطة مرنة متوازنة.",
    defaultVolumeMax: 150,
    anonymizeDefault: false,
    samplePurposes: ["استطلاع عام", "استكشاف"],
  },
};

export function getPersonaConfig(persona?: string): PersonaConfig {
  if (persona && persona in PERSONA_CONFIGS) {
    return PERSONA_CONFIGS[persona as PersonaType];
  }
  return PERSONA_CONFIGS.student;
}
