export type PersonaType = "student" | "researcher" | "statistician" | "marketer" | "other";

export interface PersonaConfig {
  key: PersonaType;
  titleAr: string;
  tone: string;
  styleGuidanceAr: string;
  promptModuleAr: string;
  defaultVolumeMax: number;
  anonymizeDefault: boolean;
  defaultTimeWindow: string;
  defaultOutputFormats: string[];
  samplePurposes: string[];
}

export interface PersonaWelcomeExample {
  key: string;
  title: string;
  description: string;
  available: boolean;
  prompt?: string;
}

export const PERSONA_CONFIGS: Record<PersonaType, PersonaConfig> = {
  student: {
    key: "student",
    titleAr: "طالب جامعي / دراسات عليا",
    tone: "plain language, explains each step, moderate volumes suggested, simple methodology wording",
    styleGuidanceAr: "لغة عربية مبسطة ومريحة، شرح الخطوات بوضوح، واقتراح أحجام بيانات معتدلة تناسب الرصيد المتاح.",
    promptModuleAr: "خاطب الطالب بلغة بسيطة. اشرح الخطوات واحدة واحدة، اقترح عينة صغيرة أو متوسطة تناسب رصيده، واكتب المنهجية ودليل البيانات بلغة واضحة. لا تفترض أن كل البيانات المطلوبة قابلة للجمع.",
    defaultVolumeMax: 100,
    anonymizeDefault: false,
    defaultTimeWindow: "آخر ٣ شهور",
    defaultOutputFormats: ["xlsx", "csv"],
    samplePurposes: ["رسالة أو بحث أكاديمي", "مشروع تخرج", "تحليل تعليمي"],
  },
  researcher: {
    key: "researcher",
    titleAr: "باحث أو أستاذ جامعي",
    tone: "formal academic methodology, research question and selection criteria, limitations, coverage, ethics",
    styleGuidanceAr: "منهجية علمية رصينة، إبراز معايير الاختيار وحدود العينة ونسبة التغطية، مع عرض إخفاء الهوية افتراضياً.",
    promptModuleAr: "للباحث أو الأستاذ الجامعي، اسأل عند الحاجة عن سؤال البحث ومعايير اختيار العينة والفترة الزمنية والاعتبارات الأخلاقية. اقترح إخفاء هوية الحسابات افتراضياً، واكتب منهجية أكاديمية تذكر حدود البيانات والتغطية ومصادر الانحياز، واقترح تنسيقاً جاهزاً للتحليل.",
    defaultVolumeMax: 500,
    anonymizeDefault: true,
    defaultTimeWindow: "آخر ٣ شهور",
    defaultOutputFormats: ["xlsx", "csv", "pdf"],
    samplePurposes: ["نشر علمي في مجلة محكمة", "رسالة دكتوراه", "مشروع بحثي ممول"],
  },
  statistician: {
    key: "statistician",
    titleAr: "إحصائي / محلل بيانات",
    tone: "tidy data, one row per item, typed codebook, missing values, linked IDs, minimal prose",
    styleGuidanceAr: "بيانات منظمة في سجل لكل صف، دليل أنواع ومتغيرات وقيم مفقودة، ومعرّفات تربط السجلات ذات الصلة.",
    promptModuleAr: "للإحصائي، فضّل سجلاً واحداً لكل عنصر وتنسيقاً طولياً قابلاً للتحليل. اقترح قاموس بيانات يوضح أنواع الحقول والقيم المفقودة ومعرّفات الربط، وقلّل النص الإنشائي. لا تخترع حقولاً غير موجودة في البيانات.",
    defaultVolumeMax: 1000,
    anonymizeDefault: false,
    defaultTimeWindow: "آخر ٣ شهور",
    defaultOutputFormats: ["csv", "xlsx"],
    samplePurposes: ["تحليل إحصائي ونمذجة", "تحليل شبكات التواصل", "أبحاث كمية"],
  },
  marketer: {
    key: "marketer",
    titleAr: "مسوّق أو صانع محتوى",
    tone: "practical engagement metrics, rankings and concise insights, no academic wording",
    styleGuidanceAr: "تركيز تسويقي مباشر على مؤشرات التفاعل والمقارنة والتصنيف، مع ملخص عملي موجز.",
    promptModuleAr: "للمسوّق أو صانع المحتوى، ركّز على التفاعل والمقارنة والترتيب والأنماط القابلة للتنفيذ. قدّم استنتاجات قصيرة، وتجنّب اللغة الأكاديمية ما لم يطلبها المستخدم.",
    defaultVolumeMax: 200,
    anonymizeDefault: false,
    defaultTimeWindow: "آخر شهر",
    defaultOutputFormats: ["xlsx", "pdf"],
    samplePurposes: ["تحليل السوق والمنافسين", "صناعة المحتوى وتتبع اتجاهات الرأي العام", "حملات تسويقية"],
  },
  other: {
    key: "other",
    titleAr: "أخرى / استخدام عام",
    tone: "ask one short clarifying question the first time, then guide concisely",
    styleGuidanceAr: "سؤال استكشافي واحد وموجز عند الحاجة لتحديد الهدف، ثم اقتراح خطة مرنة متوازنة.",
    promptModuleAr: "للاستخدام العام، ابدأ بسؤال استكشافي واحد قصير في أول طلب غامض فقط. بعد فهم الهدف، قدّم شرحاً موجزاً وخيارات واضحة من دون افتراض خلفية المستخدم.",
    defaultVolumeMax: 150,
    anonymizeDefault: false,
    defaultTimeWindow: "آخر شهر",
    defaultOutputFormats: ["xlsx", "csv"],
    samplePurposes: ["استطلاع عام", "استكشاف"],
  },
};

const PROFILE_INJECTION_PATTERNS = [
  /\bignore\b.{0,60}\b(?:all|previous|prior|system|developer|instructions?)\b/i,
  /\b(?:system|developer)\s+prompt\b/i,
  /\b(?:reveal|print|show|dump)\b.{0,60}\b(?:secret|token|password|api\s*key|instructions?)\b/i,
  /\b(?:openai[_\s-]?api[_\s-]?key|api[_\s-]?key|access[_\s-]?token|password|secret)\b/i,
  /(?:تجاهل|انسَ|اترك).{0,60}(?:التعليمات|القواعد|المطور|النظام)/i,
  /(?:اكشف|اطبع|أظهر|استخرج).{0,60}(?:المفتاح|كلمة المرور|الرمز|التعليمات السرية)/i,
  /(?:مفتاح\s*(?:الـ)?api|كلمة\s*المرور|التعليمات\s*السرية)/i,
];

/** Profile text is untrusted context, never executable instructions. */
export function sanitizePersonaContextText(value: unknown, maxLength = 256): string {
  if (typeof value !== "string") return "";
  let text = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, " ")
    .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{12,}\b/gi, " ")
    .replace(/\b(?:api[_\s-]?key|access[_\s-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, " ")
    .replace(/\$\s?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:USD|dollars?)\b/gi, " ")
    .replace(/&(?:lt|gt|amp|quot|#\d+);/gi, " ")
    .replace(/[\u2066-\u2069\u200e\u200f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || PROFILE_INJECTION_PATTERNS.some((pattern) => pattern.test(text))) return "";
  text = text.replace(/\b(?:openai|chatgpt|gpt[-\s]?[3456][\w.-]*|treg|tikhub|serpapi)\b/gi, "منصة Diger");
  return text.slice(0, Math.max(0, maxLength)).trim();
}

function normalizePurposeList(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((purpose) => sanitizePersonaContextText(purpose, 100)).filter(Boolean).slice(0, 10);
}

export function normalizePersonaProfileFields(
  submitted: { persona?: string; purposes?: unknown; topic?: unknown },
  current: { persona?: unknown; purposes?: unknown; topic?: unknown },
): { persona: PersonaType; purposes: string[]; topic: string } {
  return {
    persona: getPersonaConfig(submitted.persona ?? (typeof current.persona === "string" ? current.persona : undefined)).key,
    purposes: submitted.purposes === undefined
      ? normalizePurposeList(current.purposes)
      : normalizePurposeList(submitted.purposes),
    topic: sanitizePersonaContextText(submitted.topic === undefined ? current.topic : submitted.topic, 256),
  };
}

export function getPersonaConfig(persona?: string): PersonaConfig {
  if (persona && Object.prototype.hasOwnProperty.call(PERSONA_CONFIGS, persona)) {
    return PERSONA_CONFIGS[persona as PersonaType];
  }
  return PERSONA_CONFIGS.other;
}

const PROMPTS_BY_PERSONA: Record<PersonaType, Record<string, string>> = {
  student: {
    tiktok: "أريد بيانات الملف العام لحساب على تيك توك لمشروع دراسي، واشرح لي الخطوات ببساطة.",
    x: "أريد عينة من المنشورات العامة عن موضوع أحدده على منصة X، مع شرح بسيط لما يمكن جمعه.",
    youtube: "أريد معلومات متاحة عن قناة أو مقاطع يوتيوب لمشروع دراسي، مع خطوات واضحة.",
    help: "ما البيانات العامة المتاحة، وكيف أختار عينة تناسب رصيدي؟",
  },
  researcher: {
    tiktok: "أحتاج بيانات الملف العام لحساب على تيك توك لدراسة بحثية، مع توضيح حدود التغطية والاعتبارات الأخلاقية.",
    x: "أحتاج عينة من المنشورات العامة حول سؤال بحثي على منصة X، مع تحديد معايير الاختيار والفترة.",
    youtube: "أحتاج معلومات متاحة عن قناة أو مقاطع يوتيوب لدراسة بحثية، مع منهجية وحدود واضحة.",
    help: "كيف أصيغ سؤال البحث ومعايير العينة والاعتبارات الأخلاقية؟",
  },
  statistician: {
    tiktok: "جهّز بيانات الملف العام لحساب على تيك توك في جدول منظم وقاموس حقول واضح.",
    x: "أحتاج سجلات منشورات عامة من منصة X بصيغة قابلة للتحليل وقاموس متغيرات.",
    youtube: "أحتاج بيانات قناة أو مقاطع يوتيوب في صفوف منظمة مع أنواع الحقول والقيم المفقودة.",
    help: "كيف أجهّز البيانات والحقول لتكون صالحة للتحليل الإحصائي؟",
  },
  marketer: {
    tiktok: "حلّل مؤشرات التفاعل العامة لحساب على تيك توك لمقارنته بالمنافسين.",
    x: "أحتاج عينة من المنشورات العامة حول حملة أو موضوع على منصة X لترتيب التفاعل.",
    youtube: "أريد مقارنة مؤشرات التفاعل العامة لقناة أو مقاطع يوتيوب.",
    help: "ما مؤشرات التفاعل العامة التي أستطيع مقارنتها؟",
  },
  other: {
    tiktok: "ما البيانات العامة المتاحة عن حساب تيك توك، وكيف أبدأ؟",
    x: "ما البيانات العامة المتاحة عن موضوع على منصة X؟",
    youtube: "ما البيانات العامة المتاحة عن قناة أو مقاطع يوتيوب؟",
    help: "ما الذي أستطيع عمله هنا؟",
  },
};

export function getPersonaWelcomeExamples(persona: string | undefined, enabledCapabilitySlugs: string[]): PersonaWelcomeExample[] {
  const config = getPersonaConfig(persona);
  const enabled = new Set(enabledCapabilitySlugs.filter((slug) => typeof slug === "string"));
  const examples: PersonaWelcomeExample[] = [];
  const platforms: Array<{ key: string; prefix: string; label: string }> = [
    { key: "tiktok", prefix: "tiktok-", label: "تيك توك" },
    { key: "x", prefix: "x-", label: "منصة X" },
    { key: "youtube", prefix: "youtube-", label: "يوتيوب" },
  ];

  for (const platform of platforms) {
    const available = [...enabled].some((slug) => slug.startsWith(platform.prefix));
    examples.push({
      key: platform.key,
      title: available ? `${platform.label} · مثال مناسب لك` : `${platform.label} · قريباً`,
      description: available ? "خدمة متاحة" : "قريباً",
      available,
      ...(available ? { prompt: PROMPTS_BY_PERSONA[config.key][platform.key] } : {}),
    });
  }
  examples.push({
    key: "help",
    title: "اسأل عن طريقة الاستخدام",
    description: "اقتراحات مخصصة لدورك",
    available: true,
    prompt: PROMPTS_BY_PERSONA[config.key].help,
  });
  return examples;
}
