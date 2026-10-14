import { z } from "zod";
import { detectMentionedPlatforms } from "../../functions/shared/capabilityRegistry";
import { extractDateHint } from "../../functions/shared/chatHandler";

export type ProvenanceStatus = "EXPLICIT" | "INFERRED" | "DEFAULT" | "UNKNOWN";

export interface IntentField<T> {
  value: T;
  provenance: ProvenanceStatus;
  sourceText?: string;
  confidence?: number;
}

export interface UploadedFileReference {
  fileId: string;
  fileName: string;
  fileType: "xlsx" | "csv";
  purpose: "exclusion_list" | "reference_data";
}

export interface ResearchIntentSpec {
  objective: IntentField<string>;
  topic: IntentField<string>;
  platforms: IntentField<string[]>;
  entityType: IntentField<"posts" | "comments" | "videos" | "companies" | "profiles" | "tabular">;
  geographicScope: IntentField<string>;
  language: IntentField<string>;
  dateRange: IntentField<{ from?: string; to?: string; relative?: string }>;
  sampleSize: IntentField<number>;
  requestedFields: IntentField<string[]>;
  outputTypes: IntentField<Array<"xlsx" | "csv" | "pdf" | "json">>;
  userExclusions: IntentField<{
    textExclusions: string[];
    fileReferences: UploadedFileReference[];
    hasExclusionReference: boolean;
  }>;
  searchConstraints: IntentField<Record<string, any>>;
  methodologyRequirements: IntentField<string[]>;
}

export const IntentFieldSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.object({
    value: valueSchema,
    provenance: z.enum(["EXPLICIT", "INFERRED", "DEFAULT", "UNKNOWN"]),
    sourceText: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  });

export const ResearchIntentSchema = z.object({
  objective: IntentFieldSchema(z.string()),
  topic: IntentFieldSchema(z.string()),
  platforms: IntentFieldSchema(z.array(z.string())),
  entityType: IntentFieldSchema(z.enum(["posts", "comments", "videos", "companies", "profiles", "tabular"])),
  geographicScope: IntentFieldSchema(z.string()),
  language: IntentFieldSchema(z.string()),
  dateRange: IntentFieldSchema(
    z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      relative: z.string().optional(),
    })
  ),
  sampleSize: IntentFieldSchema(z.number().positive()),
  requestedFields: IntentFieldSchema(z.array(z.string())),
  outputTypes: IntentFieldSchema(z.array(z.enum(["xlsx", "csv", "pdf", "json"]))),
  userExclusions: IntentFieldSchema(
    z.object({
      textExclusions: z.array(z.string()),
      fileReferences: z.array(
        z.object({
          fileId: z.string(),
          fileName: z.string(),
          fileType: z.enum(["xlsx", "csv"]),
          purpose: z.enum(["exclusion_list", "reference_data"]),
        })
      ),
      hasExclusionReference: z.boolean(),
    })
  ),
  searchConstraints: IntentFieldSchema(z.record(z.string(), z.any())),
  methodologyRequirements: IntentFieldSchema(z.array(z.string())),
});

/**
 * Normalizes Eastern Arabic digits to standard ASCII digits
 */
function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)]);
}

/**
 * Extracts sample size / count from Egyptian Arabic phrasing
 */
export function extractSampleSize(text: string): { count?: number; provenance: ProvenanceStatus; sourceText?: string } {
  const norm = normalizeDigits(text);
  // Match e.g. "50 شركة", "100 فيديو", "500 تعليق", "1000 بوست", "عايز 50", "حجم 200"
  const match = norm.match(
    /(?:عايز|حجم|عدد|بحد أقصى|بحد اقصى|استخرج|اجمع)?\s*(\d+)\s*(?:شركة|شركات|مؤسسة|فيديو|فيديوهات|مقطع|مقاطع|بوست|بوستات|منشور|منشورات|تعليق|تعليقات|سجل|سجلات|عينة|عينات)?/i
  );
  if (match && match[1]) {
    const val = parseInt(match[1], 10);
    if (val > 0 && val <= 100000) {
      return { count: val, provenance: "EXPLICIT", sourceText: match[0].trim() };
    }
  }
  return { provenance: "UNKNOWN" };
}

/**
 * Extracts geographic scope from Egyptian Arabic phrasing
 */
/**
 * Extracts geographic scope from Egyptian Arabic phrasing
 */
export function extractGeographicScope(text: string): { scope: string; provenance: ProvenanceStatus; sourceText?: string } {
  if (/(?:^|[^\p{L}\p{N}])(مصر|مصرية|مصري|القاهرة|الإسكندرية|اسكندرية|الجيزة|الدلتا|الصعيد)(?:$|[^\p{L}\p{N}])/iu.test(text)) {
    return { scope: "مصر", provenance: "EXPLICIT", sourceText: "مصر" };
  }
  if (/(?:^|[^\p{L}\p{N}])(السعودية|سعودية|الرياض|جدة|الدمام|المملكة)(?:$|[^\p{L}\p{N}])/iu.test(text)) {
    return { scope: "المملكة العربية السعودية", provenance: "EXPLICIT", sourceText: "السعودية" };
  }
  if (/(?:^|[^\p{L}\p{N}])(الإمارات|اماراتية|دبي|أبوظبي|الشارقة)(?:$|[^\p{L}\p{N}])/iu.test(text)) {
    return { scope: "الإمارات", provenance: "EXPLICIT", sourceText: "الإمارات" };
  }
  if (/(?:^|[^\p{L}\p{N}])(الخليج|دول الخليج|الوطن العربي|الشرق الأوسط)(?:$|[^\p{L}\p{N}])/iu.test(text)) {
    return { scope: "الشرق الأوسط والخليج العربي", provenance: "EXPLICIT", sourceText: "الخليج" };
  }
  if (/(?:^|[^\p{L}\p{N}])(عالمي|عالمية|دولي|جميع الدول)(?:$|[^\p{L}\p{N}])/iu.test(text)) {
    return { scope: "عالمي", provenance: "EXPLICIT", sourceText: "عالمي" };
  }
  return { scope: "غير محدد جغرافياً", provenance: "UNKNOWN" };
}

/**
 * Extracts entity type from Egyptian Arabic phrasing
 */
export function extractEntityType(text: string): {
  entityType: "posts" | "comments" | "videos" | "companies" | "profiles" | "tabular";
  provenance: ProvenanceStatus;
} {
  if (/(?:^|[^\p{L}\p{N}])(شركة|شركات|مؤسسة|مؤسسات|مصنع|مصانع|مكاتب|مقاولين|موردين)(?:$|[^\p{L}\p{N}])/iu.test(text)) {
    return { entityType: "companies", provenance: "EXPLICIT" };
  }
  if (/(?:^|[^\p{L}\p{N}])(تعليق|تعليقات|ردود|رد|كومنتات|كومنت)(?:$|[^\p{L}\p{N}])/iu.test(text)) {
    return { entityType: "comments", provenance: "EXPLICIT" };
  }
  if (/(?:^|[^\p{L}\p{N}])(فيديو|فيديوهات|مقطع|مقاطع|ريلز|شورتس)(?:$|[^\p{L}\p{N}])/iu.test(text)) {
    return { entityType: "videos", provenance: "EXPLICIT" };
  }
  if (/(?:^|[^\p{L}\p{N}])(بوست|بوستات|منشور|منشورات|تغريدة|تغريدات|تويتات)(?:$|[^\p{L}\p{N}])/iu.test(text)) {
    return { entityType: "posts", provenance: "EXPLICIT" };
  }
  if (/(?:^|[^\p{L}\p{N}])(حساب|حسابات|بروفايل|صفحة|صفحات|قناة|قنوات)(?:$|[^\p{L}\p{N}])/iu.test(text)) {
    return { entityType: "profiles", provenance: "EXPLICIT" };
  }
  return { entityType: "tabular", provenance: "INFERRED" };
}

/**
 * Extracts user exclusions and detects references to exclusion files
 */
export function extractUserExclusions(
  text: string,
  uploadedFiles: UploadedFileReference[] = []
): {
  textExclusions: string[];
  fileReferences: UploadedFileReference[];
  hasExclusionReference: boolean;
  provenance: ProvenanceStatus;
} {
  const textExclusions: string[] = [];
  const fileExclusionRegex = /(?:مع استبعاد|استبعاد|استبعد|غير|بدون|باستثناء)\s*(?:الشركات|الأسماء|الموجود|المسجل|المسجلة|اللي)?\s*(?:في|الموجودة في|المسجلة في|اللي في)?\s*(?:الملف|الشيت|الإكسل|الاكسل|ملف|شيت)/iu;
  const hasExclusionReference = fileExclusionRegex.test(text);

  const directExclusionMatch = text.match(/(?:استبعد|شيل|بدون|غير)\s+([^.،,؛\n!؟?]+)/giu);
  if (directExclusionMatch) {
    for (const m of directExclusionMatch) {
      if (!fileExclusionRegex.test(m)) {
        const cleaned = m.replace(/^(?:استبعد|شيل|بدون|غير)\s+/iu, "").trim();
        if (cleaned.length > 2) textExclusions.push(cleaned);
      }
    }
  }

  const fileReferences: UploadedFileReference[] = (uploadedFiles as any[])
    .filter((f: any) => !f.purpose || f.purpose === "exclusion_list")
    .map((f: any, idx: number) => ({
      fileId: String(f.fileId || `file_${idx}`),
      fileName: String(f.fileName || f.name || `file_${idx}`),
      fileType: ((f.fileType || f.type || "xlsx") as string).toLowerCase().includes("csv") ? "csv" : "xlsx",
      purpose: ((f.purpose || "exclusion_list") as string) === "reference_data" ? "reference_data" : "exclusion_list",
    }));

  const provenance: ProvenanceStatus =
    hasExclusionReference || textExclusions.length > 0 || fileReferences.length > 0
      ? "EXPLICIT"
      : "UNKNOWN";

  return {
    textExclusions,
    fileReferences,
    hasExclusionReference,
    provenance,
  };
}

/**
 * Comprehensive Intent Extractor: Transforms natural language requests into validated IntentSpec
 */
export function extractResearchIntent(
  userMessage: string,
  previousIntent?: ResearchIntentSpec,
  uploadedFiles: UploadedFileReference[] = []
): ResearchIntentSpec {
  const text = userMessage.trim();

  // 1. Platforms
  const detectedPlats = detectMentionedPlatforms(text);
  let platformsField: IntentField<string[]>;
  if (detectedPlats.length > 0) {
    platformsField = {
      value: detectedPlats,
      provenance: "EXPLICIT",
      sourceText: detectedPlats.join(", "),
      confidence: 1.0,
    };
  } else if (previousIntent && previousIntent.platforms.provenance !== "UNKNOWN") {
    platformsField = previousIntent.platforms;
  } else if (/(يوتيوب|فيديوهات|مقاطع)\b/i.test(text)) {
    platformsField = { value: ["youtube"], provenance: "INFERRED", sourceText: "فيديوهات", confidence: 0.85 };
  } else if (/(تغريدات|تويتر|منصة x|تويتات)\b/i.test(text)) {
    platformsField = { value: ["x"], provenance: "INFERRED", sourceText: "تغريدات", confidence: 0.9 };
  } else if (/(شركات|مقاولين|مصانع|أنشطة تجارية)\b/i.test(text)) {
    platformsField = { value: ["web"], provenance: "INFERRED", sourceText: "شركات", confidence: 0.85 };
  } else {
    platformsField = { value: ["web"], provenance: "DEFAULT", confidence: 0.5 };
  }

  // 2. Entity Type
  const entityExtraction = extractEntityType(text);
  let entityField: IntentField<"posts" | "comments" | "videos" | "companies" | "profiles" | "tabular">;
  if (entityExtraction.provenance === "EXPLICIT") {
    entityField = { value: entityExtraction.entityType, provenance: "EXPLICIT", confidence: 0.95 };
  } else if (previousIntent && previousIntent.entityType.provenance === "EXPLICIT") {
    entityField = previousIntent.entityType;
  } else {
    entityField = { value: entityExtraction.entityType, provenance: "INFERRED", confidence: 0.7 };
  }

  // 3. Geographic Scope
  const geoExtraction = extractGeographicScope(text);
  let geoField: IntentField<string>;
  if (geoExtraction.provenance === "EXPLICIT") {
    geoField = { value: geoExtraction.scope, provenance: "EXPLICIT", sourceText: geoExtraction.sourceText, confidence: 1.0 };
  } else if (previousIntent && previousIntent.geographicScope.provenance === "EXPLICIT") {
    geoField = previousIntent.geographicScope;
  } else {
    geoField = { value: "مصر والشرق الأوسط", provenance: "DEFAULT", confidence: 0.6 };
  }

  // 4. Sample Size
  const sizeExtraction = extractSampleSize(text);
  let sizeField: IntentField<number>;
  if (sizeExtraction.provenance === "EXPLICIT" && sizeExtraction.count) {
    sizeField = { value: sizeExtraction.count, provenance: "EXPLICIT", sourceText: sizeExtraction.sourceText, confidence: 1.0 };
  } else if (previousIntent && previousIntent.sampleSize.provenance === "EXPLICIT") {
    sizeField = previousIntent.sampleSize;
  } else {
    // Sensible defaults based on entity type: 50 for companies, 500 for posts/comments/videos
    const defaultVal = entityField.value === "companies" ? 50 : 500;
    sizeField = { value: defaultVal, provenance: "DEFAULT", confidence: 0.6 };
  }

  // 5. Date Range
  const dateStr = extractDateHint(text);
  let dateField: IntentField<{ from?: string; to?: string; relative?: string }>;
  if (dateStr) {
    dateField = { value: { relative: dateStr }, provenance: "EXPLICIT", sourceText: dateStr, confidence: 0.95 };
  } else if (previousIntent && previousIntent.dateRange.provenance === "EXPLICIT") {
    dateField = previousIntent.dateRange;
  } else {
    dateField = { value: { relative: "آخر 3 شهور" }, provenance: "DEFAULT", confidence: 0.6 };
  }

  // 6. Topic & Objective
  let topicVal = "";
  let topicProv: ProvenanceStatus = "UNKNOWN";

  // Strip exclusion clauses, export requests, and trailing geo qualifiers before extracting topic
  const cleanedForTopic = text
    .replace(/(?:غير|بدون|باستثناء)\s*(?:الشركات|الأسماء|الموجود|المسجل|المسجلة)?\s*(?:في|الموجودة في|المسجلة في)?\s*(?:الملف|الشيت|الإكسل|الاكسل|ملف|شيت)[^.،,؛\n!؟?]*/giu, "")
    .replace(/(?:مع استخراج|استخراج|تصدير|شيت|ملف)\s+(?:إكسل|اكسل|pdf|csv|xlsx)[^.،,؛\n!؟?]*/giu, "")
    .replace(/(?:في\s+مصر|في\s+السعودية|في\s+الإمارات|في\s+الخليج)[^.،,؛\n!؟?]*/giu, "");

  // Match topic patterns: "حصر X", "بحث عن X", "شركات X", "الفيديوهات الخاصة بـ X"
  const topicMatch = cleanedForTopic.match(/(?:حصر|استخراج|جمع|بيانات|بحث عن|حول|بخصوص|فيديوهات|مقاطع|شركات|شركة|منشورات|تعليقات)\s*(?:\d+|[٠-٩]+)?\s*(?:شركة|شركات|مؤسسة|فيديو|فيديوهات|تعليق|تعليقات|منشور|منشورات)?\s+([^.،,؛\n!؟?]+)/iu);
  if (topicMatch && topicMatch[1]) {
    let clean = topicMatch[1]
      .replace(/(?:خلال الفترة|خلال|من الفترة|بحد أقصى|بحد اقصى|عدد|آخر شهر|آخر أسبوع|آخر 3 شهور).*$/iu, "")
      .replace(/(?:يوتيوب|تويتر|فيسبوك|تيك توك|انستغرام|إكس|منصة)/giu, "")
      .trim();
    if (clean.length > 2) {
      topicVal = clean;
      topicProv = "EXPLICIT";
    }
  }

  if (!topicVal && previousIntent && previousIntent.topic.provenance !== "UNKNOWN") {
    topicVal = previousIntent.topic.value;
    topicProv = previousIntent.topic.provenance;
  }

  if (!topicVal) {
    // If text has substantive words not caught above, treat as explicit topic
    const STOP_TERMS = new Set([
      "عايز", "اريد", "أريد", "ابحث", "أبحث", "اعمل", "أعمل", "هات", "اجمع", "أجمع", "شيت", "ملف", "اكسل", "إكسل",
      "بيانات", "داتا", "معلومات", "سجلات", "منشورات", "بوستات", "تعليقات", "كومنتات", "تغريدات", "تويتات",
      "فيديوهات", "مقاطع", "فيسبوك", "فيس", "بوك", "تويتر", "تيك", "توك", "تيك توك", "انستغرام", "إنستغرام",
      "يوتيوب", "لينكدإن", "لينكد", "جوجل", "غوغل", "منصة", "حساب", "صفحة", "جروب", "مجموعة", "قناة",
      "facebook", "twitter", "tiktok", "instagram", "youtube", "linkedin", "google", "x", "data",
      "هيكلفني", "تكلفة", "تكلفته", "تكاليف", "كام", "بكام", "سعره", "احسبلي", "أحسبلي", "احسب", "أحسب", "فلوس", "نقاط", "رصيد"
    ]);
    const words = text
      .split(/[\s,،؛!؟?]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 2 && !STOP_TERMS.has(w));
    if (words.length > 0) {
      topicVal = words.slice(0, 8).join(" ");
      topicProv = "INFERRED";
    }
  }

  const topicField: IntentField<string> = {
    value: topicVal || "بحث عام",
    provenance: topicProv,
    confidence: topicProv === "EXPLICIT" ? 0.95 : 0.6,
  };

  const objectiveField: IntentField<string> = {
    value: `استخراج وتوثيق ${entityField.value} حول موضوع: ${topicField.value}`,
    provenance: topicProv === "EXPLICIT" ? "EXPLICIT" : "INFERRED",
    confidence: 0.85,
  };

  // 7. Output Types
  const detectedOutputs: Array<"xlsx" | "csv" | "pdf" | "json"> = [];
  if (/(excel|إكسل|اكسل|xlsx|شيت)/i.test(text)) detectedOutputs.push("xlsx");
  if (/(csv)/i.test(text)) detectedOutputs.push("csv");
  if (/(pdf|تقرير pdf)/i.test(text)) detectedOutputs.push("pdf");
  if (/(json)/i.test(text)) detectedOutputs.push("json");

  let outputField: IntentField<Array<"xlsx" | "csv" | "pdf" | "json">>;
  if (detectedOutputs.length > 0) {
    outputField = { value: detectedOutputs, provenance: "EXPLICIT", sourceText: detectedOutputs.join(", "), confidence: 1.0 };
  } else if (previousIntent && previousIntent.outputTypes.provenance === "EXPLICIT") {
    outputField = previousIntent.outputTypes;
  } else {
    outputField = { value: ["xlsx", "csv", "pdf"], provenance: "DEFAULT", confidence: 0.8 };
  }

  // 8. User Exclusions
  const exclusionsData = extractUserExclusions(text, uploadedFiles);
  const exclusionsField: IntentField<{
    textExclusions: string[];
    fileReferences: UploadedFileReference[];
    hasExclusionReference: boolean;
  }> = {
    value: {
      textExclusions: exclusionsData.textExclusions,
      fileReferences: exclusionsData.fileReferences,
      hasExclusionReference: exclusionsData.hasExclusionReference,
    },
    provenance: exclusionsData.provenance,
    confidence: 0.9,
  };

  // 9. Requested Fields
  const fields: string[] = [];
  if (/(مواقع|موقع|نشاط|انشطة|activity|domain|website)/i.test(text)) {
    fields.push("company_name", "website", "activity", "category");
  }
  if (/(تعليقات|ردود|مشاهدات|إعجابات|لايكات|تفاعل|engagement)/i.test(text)) {
    fields.push("title", "text", "author", "likes", "views", "comments_count", "published_at");
  }
  const fieldsField: IntentField<string[]> = {
    value: fields.length > 0 ? fields : ["all_standard_fields"],
    provenance: fields.length > 0 ? "EXPLICIT" : "DEFAULT",
    confidence: 0.8,
  };

  // 10. Methodology & Constraints
  const hasDeduplicationReq = /(شيل المكرر|بدون تكرار|حذف التكرار|منع التكرار|deduplicate)/i.test(text);
  const hasHierarchyReq = /(تعليقات وردود|ردود تفاعلية|سلاسل ردود|شجرة التعليقات)/i.test(text);
  const methodologyList: string[] = ["استخراج علني مصرح"];
  if (hasDeduplicationReq) methodologyList.push("تدقيق تفرد واستبعاد مكررات");
  if (hasHierarchyReq) methodologyList.push("ربط هرمي للتعليقات والردود");

  const methodologyField: IntentField<string[]> = {
    value: methodologyList,
    provenance: hasDeduplicationReq || hasHierarchyReq ? "EXPLICIT" : "DEFAULT",
    confidence: 0.85,
  };

  const constraintsField: IntentField<Record<string, any>> = {
    value: {
      excludeDuplicates: hasDeduplicationReq,
      preserveHierarchy: hasHierarchyReq,
    },
    provenance: hasDeduplicationReq || hasHierarchyReq ? "EXPLICIT" : "DEFAULT",
    confidence: 0.9,
  };

  const intent: ResearchIntentSpec = {
    objective: objectiveField,
    topic: topicField,
    platforms: platformsField,
    entityType: entityField,
    geographicScope: geoField,
    language: { value: "العربية", provenance: "DEFAULT", confidence: 0.9 },
    dateRange: dateField,
    sampleSize: sizeField,
    requestedFields: fieldsField,
    outputTypes: outputField,
    userExclusions: exclusionsField,
    searchConstraints: constraintsField,
    methodologyRequirements: methodologyField,
  };

  return ResearchIntentSchema.parse(intent);
}

/**
 * Formats the structured intent cleanly for Claude system prompt or user review,
 * explicitly tagging provenance status for every parameter.
 */
export function formatIntentForSystemPrompt(intent: ResearchIntentSpec): string {
  const provTag = (p: ProvenanceStatus) => {
    switch (p) {
      case "EXPLICIT":
        return "[محدد صراحة من المستخدم]";
      case "INFERRED":
        return "[مستنتج ذكياً من سياق الطلب]";
      case "DEFAULT":
        return "[مقترح افتراضي من المنصة قابل للتعديل]";
      case "UNKNOWN":
        return "[غير متاح]";
    }
  };

  const lines: string[] = [
    "=== [مواصفات القصد البحثي المهيكل (Structured Research Intent)] ===",
    `- الموضوع: ${intent.topic.value} ${provTag(intent.topic.provenance)}`,
    `- الكيان المستهدف: ${intent.entityType.value} ${provTag(intent.entityType.provenance)}`,
    `- المنصات: ${intent.platforms.value.join("، ")} ${provTag(intent.platforms.provenance)}`,
    `- النطاق الجغرافي: ${intent.geographicScope.value} ${provTag(intent.geographicScope.provenance)}`,
    `- حجم العينة المستهدف: ${intent.sampleSize.value} سجل ${provTag(intent.sampleSize.provenance)}`,
    `- النطاق الزمني: ${intent.dateRange.value.relative || "غير محدد"} ${provTag(intent.dateRange.provenance)}`,
    `- صيغ المخرجات: ${intent.outputTypes.value.join("، ")} ${provTag(intent.outputTypes.provenance)}`,
  ];

  if (intent.userExclusions.value.hasExclusionReference) {
    const fileCount = intent.userExclusions.value.fileReferences.length;
    lines.push(
      `- استبعاد الملفات: تم ذكر ملف استبعاد (${fileCount > 0 ? `${fileCount} ملف مرفق جاهز` : "الملف لم يُرفع بعد"}) ${provTag(
        intent.userExclusions.provenance
      )}`
    );
  }

  if (intent.userExclusions.value.textExclusions.length > 0) {
    lines.push(
      `- استبعادات نصية: ${intent.userExclusions.value.textExclusions.join("، ")} ${provTag(
        intent.userExclusions.provenance
      )}`
    );
  }

  lines.push("================================================================");
  return lines.join("\n");
}
