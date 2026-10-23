import { assessCoverage, coverageText, familyById, type CoverageAssessment, type CoverageStatus, type FamilyId } from "./requestCoverage";
import { extractRequestIntent, missingInputsForIntent, type RequestIntent } from "./requestIntent";
import { extractNumberFromText } from "./arabicNumbers";
import { resolveTimeWindow } from "./timeWindow";

/**
 * The structured reading of ONE request, made by code before any plan: what kind of task, about what, where, in which language, over
 * which period, how many or within what budget, which fields, in which file, from which sources (named or not) and whether the
 * platform can serve it. At most ONE next question, and never for something the customer already said. The model only phrases it.
 */

export interface UnderstoodSources {
  /** The kind of source set the request needs, when it needs one the customer did not name. */
  kind: "newspapers" | "channels" | "pages" | "forums" | "companies" | null;
  /** Sources the customer named (a newspaper, a channel, a page, a link). */
  named: string[];
  /** The request needs a set of sources and the customer did not name them. */
  unnamed: boolean;
}

export interface UnderstoodPart {
  family: FamilyId;
  labelAr: string;
  status: CoverageStatus;
}

export interface StructuredUnderstanding {
  taskType: "companies" | "people" | "comments" | "posts" | "videos" | "profile" | "news" | "prices" | "studies" | "analysis" | "unserved" | "unknown";
  subject: string | null;
  region: { nameAr: string; iso: string | null } | null;
  /** The language the results should be in, when the customer said. */
  language: "ar" | "en" | null;
  timeFrame: { labelAr: string; dateFrom?: string; dateTo?: string } | null;
  volume: number | null;
  /** A budget in points, when the customer gave one instead of a count. */
  budgetPoints: number | null;
  /** The fields asked for, in plain Arabic. */
  fields: string[];
  output: "xlsx" | "pdf" | "csv" | null;
  sources: UnderstoodSources;
  coverage: CoverageAssessment;
  parts: UnderstoodPart[];
  nextQuestion: { id: string; textAr: string } | null;
}

const FIELD_WORDS: Array<{ re: RegExp; labelAr: string }> = [
  { re: /بريد|ايميل|إيميل|email/iu, labelAr: "البريد الإلكتروني" },
  { re: /هاتف|تليفون|موبايل|رقم/u, labelAr: "الهاتف" },
  { re: /تاريخ/u, labelAr: "التاريخ" },
  { re: /رابط|لينك|link/iu, labelAr: "الرابط" },
  { re: /عنوان(?!\s*(?:سكن|منزل))|headline/iu, labelAr: "العنوان" },
  { re: /مقتطف|ملخص قصير|نبذه|نبذة/u, labelAr: "مقتطف قصير" },
  { re: /منصب|مسمي|مسمى|وظيفه|وظيفة|title/iu, labelAr: "المسمى الوظيفي" },
  { re: /اسم الشركه|اسم الشركة|اسماء الشركات|أسماء الشركات/u, labelAr: "اسم الشركة" },
  { re: /الاعجاب|إعجاب|لايك|likes?/iu, labelAr: "الإعجابات" },
  { re: /مشاهد/u, labelAr: "المشاهدات" },
  { re: /تغير|فرق عن|نسبه التغير|نسبة التغير/u, labelAr: "التغير عن الفترة السابقة" },
];

function fieldsOf(text: string): string[] {
  return FIELD_WORDS.filter(({ re }) => re.test(text)).map(({ labelAr }) => labelAr);
}

function outputOf(text: string): StructuredUnderstanding["output"] {
  if (/اكسل|إكسل|excel|xlsx/iu.test(text)) return "xlsx";
  if (/\bpdf\b|بي دي اف|بي دي إف/iu.test(text)) return "pdf";
  if (/\bcsv\b|سي اس في/iu.test(text)) return "csv";
  return null;
}

function languageOf(text: string): StructuredUnderstanding["language"] {
  if (/بالانجليزي|بالإنجليزي|بالانجليزيه|بالإنجليزية|english only|بالانكليزي/iu.test(text)) return "en";
  if (/بالعربي|بالعربيه|بالعربية|عربي فقط|arabic only/iu.test(text)) return "ar";
  return null;
}

function budgetOf(text: string): number | null {
  const match = /(?:بميزانيه|ميزانيتي|ميزانيه|بحد اقصي|لا تزيد عن|لا تزيد علي|مش اكتر من|مش اكثر من)\s*(?:حوالي\s*)?([0-9]+)\s*نقط/u.exec(coverageText(text));
  if (!match) return null;
  const n = extractNumberFromText(match[1]);
  return n && n > 0 ? n : null;
}

const NEWSPAPER_WORD = /(?:جرايد|جرائد|صحف|صحيفه|صحيفة|جريده|جريدة|مواقع اخباريه|مواقع إخبارية|مواقع صحفيه|وكالات انباء)/u;
const CHANNEL_WORD = /(?:قنوات|قناه|قناة|حسابات|صفحات)/u;
const NAMED_NEWSPAPER = /(?:الاهرام|الأهرام|اليوم السابع|المصري اليوم|الشروق|الوطن|مصراوي|الدستور|صدي البلد|صدى البلد|القاهره 24|القاهرة 24|الجمهوريه|الجمهورية|اخبار اليوم|أخبار اليوم|العربيه|العربية|الاخبار|الأخبار)/gu;

/** The newspapers named in the request, or links to sites. */
export function namedNewspapers(text: string): string[] {
  const found = new Set<string>();
  for (const match of String(text || "").matchAll(NAMED_NEWSPAPER)) found.add(match[0]);
  for (const match of String(text || "").matchAll(/https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/giu)) found.add(match[1].toLowerCase());
  return [...found];
}

function sourcesOf(text: string, t: string, coverage: CoverageAssessment): UnderstoodSources {
  if (coverage.families.includes("news_articles")) {
    const named = namedNewspapers(text);
    // «الجرايد الرسمية» names a kind of newspaper, not a newspaper: the set is still unnamed.
    return { kind: "newspapers", named, unnamed: named.length === 0 };
  }
  if (CHANNEL_WORD.test(t) && /(?:افضل|أفضل|اهم|أهم|اشهر|أشهر|اكبر|أكبر)\s+(?:ال)?(?:قنوات|حسابات|صفحات)/u.test(t)) return { kind: "channels", named: [], unnamed: true };
  if (coverage.families.includes("telegram_reddit_forums")) return { kind: "forums", named: [], unnamed: true };
  return { kind: null, named: [], unnamed: false };
}

const QUESTION_BY_MISSING: Record<string, { id: string; textAr: string }> = {
  country: { id: "country_required", textAr: "في أي دولة تريد البحث؟" },
  industry: { id: "industry_required", textAr: "ما نشاط الشركات التي تريدها؟" },
  industry_or_company: { id: "industry_required", textAr: "ما نشاط الشركات التي تريد صناع القرار فيها؟" },
  roles: { id: "roles_required", textAr: "ما المناصب التي تريدها (مثل المدير العام أو الرئيس التنفيذي)؟" },
  count: { id: "count_required", textAr: "كم سجلًا تريد تقريبًا؟" },
  platform: { id: "platform_required", textAr: "على أي منصة تريد البحث (إكس، تيك توك، يوتيوب أو فيسبوك)؟" },
  topic: { id: "topic_required", textAr: "ما الموضوع أو الكلمة التي تريد البحث عنها؟" },
};

const TASK_BY_FAMILY: Partial<Record<FamilyId, StructuredUnderstanding["taskType"]>> = {
  news_articles: "news",
  price_series: "prices",
  academic_studies: "studies",
  analysis_of_delivered: "analysis",
};

/** The structured understanding of a request. Pure; no model, no database. */
export function understandRequest(rawText: string, options: { today?: Date } = {}): StructuredUnderstanding {
  const text = String(rawText || "").trim();
  const t = coverageText(text);
  const intent: RequestIntent = extractRequestIntent(text);
  const coverage = assessCoverage(text);

  const unsupportedFirst = coverage.unsupported[0];
  const taskType: StructuredUnderstanding["taskType"] = coverage.status === "not_supported"
    ? (TASK_BY_FAMILY[unsupportedFirst as FamilyId] ?? "unserved")
    : intent.dataType === "studies" ? "studies"
    : intent.dataType === "unknown" ? (coverage.supported.includes("analysis_of_delivered") ? "analysis" : "unknown")
    : intent.dataType;

  const window = resolveTimeWindow(text, { today: options.today, needsWindow: true });
  const timeFrame = window.status === "resolved" && window.source !== "open_scope" && window.source !== "default"
    ? { labelAr: window.labelAr, ...(window.dateFrom ? { dateFrom: window.dateFrom } : {}), ...(window.dateTo ? { dateTo: window.dateTo } : {}) }
    : null;

  const sources = sourcesOf(text, t, coverage);
  const budgetPoints = budgetOf(text);
  const volume = budgetPoints === null ? intent.count : null;

  const parts: UnderstoodPart[] = [
    ...coverage.supported.map((family) => ({ family, labelAr: familyById(family).titleAr, status: familyById(family).status })),
    ...coverage.unsupported.map((family) => ({ family, labelAr: familyById(family).titleAr, status: "not_supported" as CoverageStatus })),
  ];

  // ONE question, only for what a request we can serve still lacks; a request we cannot serve gets the plain answer instead.
  let nextQuestion: StructuredUnderstanding["nextQuestion"] = null;
  if (coverage.status !== "not_supported") {
    const missing = missingInputsForIntent(intent, text).filter((key) => !(key === "count" && budgetPoints !== null));
    if (missing.length > 0) nextQuestion = QUESTION_BY_MISSING[missing[0]] ?? null;
    else if (taskType === "unknown") nextQuestion = QUESTION_BY_MISSING.topic;
  }

  return {
    taskType,
    subject: intent.topic || (intent.industry?.arabic ?? null),
    region: intent.country ? { nameAr: intent.country.arabic, iso: intent.country.iso ?? null } : null,
    language: languageOf(text),
    timeFrame,
    volume,
    budgetPoints,
    fields: fieldsOf(text),
    output: outputOf(text),
    sources,
    coverage,
    parts,
    nextQuestion,
  };
}
