import { logProviderCost } from "./providerCosts";
import { ID, Query, TablesDB } from "./dbCompat";
import { LlmClient, LlmTurnOutput } from "./llmClient";
import {
  getEnabledCapabilities,
  getCatalogCapabilities,
  sanitizeCapabilitiesForLlm,
  validateCapabilityParams,
  validatePlanPlatformMatch,
  detectMentionedPlatforms,
  getPlatformLabelAr,
  getClosestVerifiedCapability,
  UNVERIFIED_PLATFORM_MESSAGE_AR,
  Capability,
} from "./capabilityRegistry";
import {
  calculateQuote,
  generateQuoteExpiry,
  DEFAULT_PRICING_SETTINGS,
  PricingSettings,
} from "./quotes";
import {
  createAndSaveManagedQuote,
  applyPlanOperations,
  validatePlanAgainstSchemas,
  validatePlanAgainstLiveCatalog,
  LiveCatalogIssue,
  PlanState,
} from "./planManager";
import { getBalance } from "./ledger";
import {
  discoveryQuestionPriority,
  normalizeClarificationQuestions,
  sanitizeClarificationText,
  type NormalizedClarificationQuestion,
  INTERNAL_DISCOVERY_KEYS,
} from "./clarification";
import { searchCatalog, getCachedCatalogEndpoints, CatalogEndpointSummary } from "./catalogClient";
import {
  isGreetingOrGeneralQuestion,
  isPriceOrProceedIntent,
  extractBriefFromMessage,
  extractBriefFromCardAnswers,
  isBriefComplete,
  formatBriefForSystemPrompt,
  getConversationBrief,
  saveConversationBrief,
  isRepetitionComplaint,
  type ResearchBrief,
} from "./briefManager";
import { extractResearchIntent, extractEntityType } from "../../lib/server/researchIntent";
import { evaluateDiscoveryDecision } from "../../lib/server/questionDecisionFramework";
import { detectCountryFromText, detectIndustryFromText } from "../../lib/planParameters";

export interface ChatHandlerInput {
  userId: string;
  conversationId?: string;
  message: string;
  answers?: any;
  userBalance?: number;
  testScenario?: string;
  uploadedFiles?: any[];
  isGuest?: boolean;
}

export interface ChatHandlerResponse {
  conversationId: string;
  messageId: string;
  role: "assistant";
  contentAr: string;
  outputType: LlmTurnOutput["type"];
  intent?: "chat" | "research";
  planQuote?: any;
  revisionQuote?: any;
  clarificationQuestions?: string[];
  clarificationItems?: NormalizedClarificationQuestion[];
  clarificationIntro?: string;
  suggestedAlternative?: any;
  refusalReason?: string;
  tokensUsed: {
    input: number;
    output: number;
    costUsd: number;
  };
  turnStats?: {
    modelCalls: number;
    catalogSearches: number;
    latencyMs: number;
    stepTimings?: {
      supabaseMs?: number;
      catalogMs?: number;
      llmMs?: number;
      quoteMs?: number;
      totalMs?: number;
      tExtractMs: number;
      tCatalogSearchMs: number;
      tPlanLlmMs: number;
      tQuoteMs: number;
    };
  };
}

/** Rough token estimate for Arabic/English mixed text (chars/4 heuristic). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Conversation context budget. When reached, older turns are summarized instead of blocking. */
export const CONTEXT_TOKEN_LIMIT = 40000;

/** Max tokens for a single catalog tool_result block sent back to the model. */
const CATALOG_RESULT_TOKEN_CAP = 2500;

/**
 * Compact catalog results for the model's next turn: top 5 endpoints with only
 * the fields needed to ask questions or propose a plan (id alias, Arabic name,
 * platform, required params, billing unit, points per unit). No descriptions,
 * no examples, no full schemas. Capped at ~2,500 tokens.
 */
export function buildCompactCatalogSummary(results: CatalogEndpointSummary[]): string {
  const header =
    "[نتائج بحث الكتالوج — داخلية: لا تعرضها للمستخدم كنص. استخدمها لاستدعاء ask_questions أو propose_plan]";
  if (!results || results.length === 0) {
    return `${header}\nلا توجد أدوات مطابقة في الكتالوج لهذا البحث.`;
  }
  const requiredParams = (r: CatalogEndpointSummary): string => {
    try {
      const schema: any = typeof r.paramsSchema === "string" ? JSON.parse(r.paramsSchema) : r.paramsSchema;
      const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
      const props = schema?.properties ? Object.keys(schema.properties) : [];
      const names = required.length > 0 ? required : props.slice(0, 3);
      return names.length > 0 ? names.join(",") : "-";
    } catch {
      return "-";
    }
  };
  let count = 5;
  let block = "";
  while (count >= 1) {
    const lines = results.slice(0, count).map(
      (r, i) =>
        `${i + 1}. ${r.slug} | ${r.nameAr} | ${r.platform} | مدخلات: ${requiredParams(r)} | الوحدة: ${r.billingUnit || "-"} | ${r.pointsPerUnit ?? "?"} نقطة/وحدة`,
    );
    block = `${header}\n${lines.join("\n")}`;
    if (estimateTokens(block) <= CATALOG_RESULT_TOKEN_CAP) break;
    count = Math.floor(count / 2);
  }
  return block;
}

/**
 * Code-built discovery fallback: real questions with real options, never the
 * generic sentence. Constructed directly (not via model-output normalization)
 * so trusted code questions are never dropped.
 */
export function filterQuestionsAlreadyInBrief(
  questions: NormalizedClarificationQuestion[],
  brief?: ResearchBrief,
): NormalizedClarificationQuestion[] {
  if (!brief) return questions;
  return questions.filter((q) => {
    const id = (q.id || "").toLowerCase();
    const text = (q.text || q.question || "").toLowerCase();

    // 1. Platform
    if (id === "code_platform" || text.includes("ما المنصة المستهدفة") || text.includes("ما المنصة المطلوبة")) {
      if (brief.platforms && brief.platforms.length > 0) return false;
    }
    // 2. Generic Topic / Keywords (only drop the generic topic question, never specific angles or questions)
    if (id === "code_topic" || text.includes("ما الكلمات المفتاحية أو الموضوع المطلوب") || text.includes("ما الموضوع المطلوب")) {
      if (brief.topics && brief.topics.length > 0) return false;
    }
    // 3. Volume (total count)
    if (id === "code_volume" || text.includes("ما حجم البيانات المطلوب جمعها")) {
      if (typeof brief.targetVolume === "number" && brief.targetVolume > 0) return false;
    }
    // 4. Comments per post / Source
    if (id === "code_comments_per_post" || text.includes("ما الحد الأقصى للتعليقات لكل منشور") || text.includes("مصدر التعليقات")) {
      if (brief.commentsPerPost !== undefined || (brief.notes && brief.notes.includes("المصدر"))) return false;
    }
    // 5. Date range
    if (id === "code_date_range" || text.includes("ما الفترة الزمنية لجمع البيانات")) {
      if (brief.dateRange) return false;
    }
    // 6. Language
    if (id === "code_language_dialect" || text.includes("ما اللغة أو اللهجات المطلوبة")) {
      if (brief.language) return false;
    }

    return true;
  });
}

/**
 * Remove duplicate or repetitive intro phrases (e.g. "عشان أجهز لك خطة دقيقة، محتاج أعرف:").
 */
export function deduplicateIntroText(text: string): string {
  if (!text) return "";
  let cleaned = text.trim();

  // 1. Deduplicate consecutive identical lines
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  const dedupedLines: string[] = [];
  for (const line of lines) {
    if (dedupedLines.length > 0 && dedupedLines[dedupedLines.length - 1] === line) {
      continue;
    }
    dedupedLines.push(line);
  }
  cleaned = dedupedLines.join("\n");

  // 2. Deduplicate repeated intro phrases throughout the message
  const introPatterns = [
    /عشان أجهز لك خطة دقيقة،?\s*محتاج أعرف:?/g,
    /قبل ما أجهز الخطة،?\s*جاوبني على الأسئلة دي:?/g,
  ];

  for (const pat of introPatterns) {
    let count = 0;
    cleaned = cleaned.replace(pat, (m) => {
      count++;
      return count === 1 ? m : "";
    });
  }

  return cleaned.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

/**
 * Code-built discovery fallback: real questions with real options, never the
 * generic sentence. Constructed directly (not via model-output normalization)
 * so trusted code questions are never dropped. Questions for fields already
 * known in the brief are filtered out.
 */
export function buildCodeDiscoveryFallback(
  allCapabilities: Capability[],
  userMessage: string = "",
  colonFallback: boolean = false,
  brief?: ResearchBrief,
): { intro: string; items: NormalizedClarificationQuestion[] } {
  const intro = "عشان أجهز لك خطة دقيقة، محتاج أعرف:";
  const chips = extractTopicChips(userMessage);
  const dateHint = extractDateHint(userMessage);

  if (colonFallback) {
    const rawItems: NormalizedClarificationQuestion[] = [
      {
        id: "code_topic_angle",
        text: "ما زوايا أو محاور الموضوع المستهدفة؟",
        question: "ما زوايا أو محاور الموضوع المستهدفة؟",
        type: chips.length > 0 ? "single" : "free",
        options: chips.length > 0 ? chips : ["أسعار وتداولات", "آراء وتجارب الجمهور", "الأخبار والتحليلات"],
        allowOther: true,
      },
      {
        id: "code_post_count",
        text: "ما عدد المنشورات المستهدف فحصها؟",
        question: "ما عدد المنشورات المستهدف فحصها؟",
        type: "single",
        options: ["حتى 10 منشورات", "حتى 30 منشوراً", "حتى 50 منشوراً"],
        allowOther: true,
      },
      {
        id: "code_comments_per_post",
        text: "ما الحد الأقصى للتعليقات لكل منشور؟",
        question: "ما الحد الأقصى للتعليقات لكل منشور؟",
        type: "single",
        options: ["حتى 50 تعليقاً", "حتى 100 تعليق", "كل التعليقات المتاحة"],
        allowOther: true,
      },
      {
        id: "code_date_range",
        text: "ما الفترة الزمنية لجمع البيانات؟",
        question: "ما الفترة الزمنية لجمع البيانات؟",
        type: "single",
        options: ["آخر شهر", "آخر ٣ شهور", "آخر ٦ شهور"],
        allowOther: true,
        ...(dateHint ? { defaultOption: toArabicIndicDigits(dateHint) } : {}),
      },
      {
        id: "code_language_dialect",
        text: "ما اللغة أو اللهجات المطلوبة؟",
        question: "ما اللغة أو اللهجات المطلوبة؟",
        type: "single",
        options: ["العربية والمصرية", "العربية والإنجليزية", "كل اللغات"],
        allowOther: true,
      },
    ];
    const items = (brief ? filterQuestionsAlreadyInBrief(rawItems, brief) : rawItems).slice(0, 3);
    return { intro, items };
  }

  const platformLabels = [
    ...new Set(
      (allCapabilities || [])
        .filter((c) => c && c.enabled !== false)
        .map((c) => {
          try {
            return getPlatformLabelAr(String((c as any).platform || (c as any).category || ""));
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  ].slice(0, 5);
  const platforms =
    platformLabels.length > 0 ? platformLabels : ["فيسبوك", "تيك توك", "إنستغرام", "منصة X", "يوتيوب"];

  const rawItems: NormalizedClarificationQuestion[] = [
    {
      id: "code_platform",
      text: "ما المنصة المستهدفة لجمع البيانات؟",
      question: "ما المنصة المستهدفة لجمع البيانات؟",
      type: "single",
      options: platforms,
      allowOther: true,
    },
    {
      id: "code_topic",
      text: "ما الكلمات المفتاحية أو الموضوع المطلوب؟",
      question: "ما الكلمات المفتاحية أو الموضوع المطلوب؟",
      type: chips.length > 0 ? "single" : "free",
      options: chips,
      allowOther: true,
    },
    {
      id: "code_volume",
      text: "ما حجم البيانات المطلوب جمعها؟",
      question: "ما حجم البيانات المطلوب جمعها؟",
      type: "single",
      options: ["حتى 50 سجلاً", "حتى 100 سجل", "حتى 500 سجل", "أكثر من 500 سجل"],
      allowOther: true,
    },
  ];
  const filtered = brief ? filterQuestionsAlreadyInBrief(rawItems, brief) : rawItems;
  const hasPlatformOrTopic = Boolean(
    (brief?.platforms && brief.platforms.length > 0) || (brief?.topics && brief.topics.length > 0),
  );
  const items = hasPlatformOrTopic ? filtered.slice(0, 1) : filtered.slice(0, 3);
  return { intro, items };
}

/**
 * Automatically builds a robust, validated plan proposal when the user has answered
 * all clarification questions or when Phase 2 is active, preventing dead-end stalls.
 */
export function buildAutoPlanProposal(
  brief: ResearchBrief,
  validationCaps: Capability[],
  message: string = "",
): {
  type: "propose_plan";
  summaryAr: string;
  capabilities: any[];
  outputFormats: string[];
  methodologyNotes: string;
} {
  const mentionedPlats = detectMentionedPlatforms(message);
  const platform = (brief.platforms && brief.platforms.length > 0)
    ? brief.platforms[0]
    : (mentionedPlats.length > 0 ? mentionedPlats[0] : (brief.topics?.[0]?.includes("شرك") ? "companies" : "tiktok"));
  const platformNorm = platform.toLowerCase();

  // Find matching capability in validationCaps
  let matchedCap = validationCaps.find((c) => {
    const cPlat = (c.platform || c.category || "").toLowerCase();
    const cSlug = (c.slug || "").toLowerCase();
    const cId = (c.tregEndpointId || c.id || "").toLowerCase();
    if (platformNorm === "companies" || platformNorm === "b2b") {
      return cPlat === "companies" || cPlat === "b2b" || cSlug.includes("companies") || cId.includes("companies");
    }
    return cPlat === platformNorm || cSlug.includes(platformNorm);
  });

  if (!matchedCap) {
    matchedCap = getClosestVerifiedCapability(validationCaps);
  }

  const volume = (brief.targetVolume && brief.targetVolume > 0)
    ? brief.targetVolume
    : (brief.postCount && brief.commentsPerPost ? brief.postCount * brief.commentsPerPost : 500);

  // Filter out any greetings or conversational fillers from topics
  const isGreetingWord = (w: string) => {
    const trimmed = (w || "").trim();
    if (!trimmed) return true;
    return isGreetingOrGeneralQuestion(trimmed).isGreeting || /^(ازيك|ازيكوا|ازيكم|مرحبا|مرحباً|أهلاً|أهلا|اهلا|صباح الخير|مساء الخير|سلام عليكم|السلام عليكم|هلا|hello|hi)$/i.test(trimmed);
  };

  const cleanTopics = (brief.topics || []).filter((t) => !isGreetingWord(t));

  // Extract explicit research topic from the current message if present
  let extractedCurrentTopic = "";
  const currentMsgChips = extractTopicChips(message, 4).filter((w) => !isGreetingWord(w));
  if (currentMsgChips.length > 0) {
    extractedCurrentTopic = currentMsgChips.join(" ");
  }

  const topicLabel =
    extractedCurrentTopic ||
    (cleanTopics.length > 0 ? cleanTopics[cleanTopics.length - 1] : "البيانات العامة المطلوبة");

  const isCompanySearch =
    platformNorm === "companies" ||
    platformNorm === "b2b" ||
    matchedCap.slug.includes("companies") ||
    Boolean(matchedCap.tregEndpointId && matchedCap.tregEndpointId.includes("companies"));

  const platformLabel = isCompanySearch
    ? "قواعد بيانات الشركات"
    : getPlatformLabelAr(platformNorm);

  const isProfileCapability =
    (matchedCap.pricingUnit as string) === "profile" ||
    matchedCap.slug.includes("profile") ||
    matchedCap.slug.includes("user");

  const isExplicitHandle =
    typeof topicLabel === "string" &&
    (topicLabel.startsWith("@") || (!topicLabel.includes(" ") && !topicLabel.includes("،") && /^[a-zA-Z0-9_.-]+$/.test(topicLabel)));

  const detectedCountry = detectCountryFromText(message);
  const detectedIndustry = detectIndustryFromText(message);

  const stepParams: Record<string, any> = isCompanySearch
    ? {
        query: {
          keyword: { include: detectedIndustry.englishKeywords },
          ...(detectedCountry ? { location: { include: [detectedCountry.canonicalEnglish] } } : {}),
        },
        search: topicLabel,
        ...(detectedCountry ? { country: detectedCountry.canonicalEnglish, location: detectedCountry.canonicalEnglish } : {}),
        industry: detectedIndustry.arabicLabel,
        pagination: { size: Math.min(volume, 100) },
      }
    : {
        query: topicLabel,
      };

  if (isProfileCapability || isExplicitHandle) {
    stepParams.username = topicLabel.replace(/^@/, "").trim();
  }

  if (brief.dateRange && !isCompanySearch) {
    stepParams.dateFrom = "2026-01-01";
  }

  const step: any = {
    stepId: "plan_step_1",
    capabilitySlug: matchedCap.slug || matchedCap.id,
    endpointId: matchedCap.tregEndpointId || matchedCap.id || matchedCap.slug,
    params: stepParams,
    targetVolumeMin: 1,
    targetVolumeMax: volume,
    paginationStrategy: matchedCap.paginationType || "cursor",
  };

  const summaryAr = isCompanySearch
    ? `استخراج بيانات ${volume} سجل من شركات ${topicLabel}`
    : `جمع واستخراج ${volume} سجل حول ${topicLabel} من ${platformLabel}`;

  return {
    type: "propose_plan",
    summaryAr,
    capabilities: [step],
    outputFormats: brief.formats && brief.formats.length > 0 ? brief.formats : ["xlsx", "pdf", "csv"],
    methodologyNotes: `جمع وتوثيق البيانات العامة لمنصة ${platformLabel} وفق المعايير البحثية المعتمدة.`,
  };
}

/**
 * Deterministic history compaction: keep the first message and the most recent
 * turns, replace the middle with a compact internal summary. The active plan
 * state (if any) is preserved in the summary.
 */
export function summarizeConversationHistory(
  messages: Array<{ role: string; content: string }>,
  planSummary?: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const KEEP_RECENT = 6;
  const normalized = messages.map((m) => ({
    role: (m.role === "user" || m.role === "assistant" ? m.role : "system") as "system" | "user" | "assistant",
    content: String(m.content || ""),
  }));
  if (normalized.length <= KEEP_RECENT + 1) return normalized;
  const first = normalized[0];
  const recent = normalized.slice(-KEEP_RECENT);
  const middle = normalized.slice(1, -KEEP_RECENT);
  const lines = middle.map((m) => {
    const who = m.role === "user" ? "المستخدم" : "المساعد";
    return `- ${who}: ${m.content.slice(0, 120)}`;
  });
  if (planSummary) lines.push(`- الخطة الحالية: ${planSummary}`);
  return [
    first,
    {
      role: "system",
      content: `[ملخص المحادثة السابقة — داخلي، لا تعرضه للمستخدم]\n${lines.join("\n")}`,
    },
    ...recent,
  ];
}

/**
 * Map a live catalog endpoint to the internal Capability shape (same alias the
 * model received). Used for validation and server-side pricing of turn results.
 */
export function catalogEndpointToCapability(ep: CatalogEndpointSummary): Capability {
  return {
    id: ep.slug,
    slug: ep.slug,
    platform: ep.platform as any,
    category: ep.platform as any,
    status: "verified",
    unit: (ep.billingUnit === "record" || ep.billingUnit === "row" || ep.billingUnit === "item" ? "item" : "page") as any,
    estimatedCostUsdPerUnit: ep.catalogPriceUsd,
    pointsPerUnit: ep.pointsPerUnit,
    maxItemsPerCall: ep.pagination.maxLimit || 100,
    estimatedSuccessRate: ep.observedSuccessRate,
    nameAr: ep.nameAr,
    nameEn: ep.nameEn,
    descriptionAr: ep.summaryAr,
    paramsSchema: JSON.stringify(ep.paramsSchema || {}),
    tregEndpointId: ep.id,
    tregMethod: ep.method,
    pricingUnit: (ep.billingUnit === "call" ? "call" : ep.billingUnit === "page" ? "page" : "item") as any,
    unitCostUsd: ep.catalogPriceUsd,
    maxRows: 5000,
    paginationType: ep.pagination.type === "page" ? "offset" : ep.pagination.type === "cursor" ? "cursor" : "none",
    enabled: true,
  };
}

/**
 * Plain-terms fix prompt for the model when a proposed plan fails live-catalog
 * validation. Uses Arabic display names only — never internal slugs or ids.
 */
export function buildPlanFixPrompt(
  validation: { errors: string[] },
  turnEndpoints: CatalogEndpointSummary[],
): string {
  const available = turnEndpoints.slice(0, 5).map((ep, i) => {
    let required = "-";
    try {
      const schema: any =
        typeof ep.paramsSchema === "string" ? JSON.parse(ep.paramsSchema) : ep.paramsSchema;
      if (Array.isArray(schema?.required) && schema.required.length > 0) {
        required = schema.required.join("، ");
      }
    } catch {
      /* ignore */
    }
    return `${i + 1}. "${ep.nameAr}" — المدخلات المطلوبة: ${required}`;
  });
  return `[تعليمات داخلية — صحح الخطة]: المقترح الحالي غير صالح:\n- ${validation.errors.join(
    "\n- ",
  )}\nالخدمات المتاحة من البحث الحالي:\n${
    available.join("\n") || "لا توجد خدمات متاحة."
  }\nأعد استدعاء propose_plan باستخدام خدمة متاحة فقط مع كل مدخلاتها المطلوبة. لا تذكر أسماء داخلية أو معرفات للمستخدم.`;
}

const TOPIC_STOPWORDS = new Set(
  "في عن من على إلى الي و هاتلي هات عايز عاوز محتاج أسحب سحب جمع بيانات داتا آخر اخر شهور شهر شهورا سنة سنوات عام أعوام أسبوع أسابيع يوم أيام مصر فيسبوك تيك توك انستغرام إنستغرام يوتيوب تويتر ريديت لينكد reddit tiktok instagram facebook youtube x comments comment posts post بوست بوستات منشور منشورات تعليق تعليقات الـ ده دي تلك هذا هذه التي الذي بيتكلموا تتكلم ازيك ازيكوا ازيكم مرحبا مرحباً اهلا أهلا أهلاً هاي سلام سلامو عليكم السلام صباح مساء الخير hello hi hey welcome شكرا شكراً تمام ماشي فندم باشا يا".split(
    " ",
  ),
);

/** Extract up to 4 suggestion chips (topic keywords) from the user's message. */


export { discoveryQuestionPriority };

/** Convert Western digits to Arabic-Indic to match the UI's date options. */
export function toArabicIndicDigits(text: string): string {
  return text.replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
}

export function extractTopicChips(userMessage: string, maxChips = 4): string[] {
  if (!userMessage) return [];
  let text = userMessage.trim();

  // If the message is a JSON payload (e.g. clarification_answers submission)
  if (text.startsWith("{") || text.includes('"clarification_answers"')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.answers)) {
        text = parsed.answers
          .map((a: any) => (Array.isArray(a.value) ? a.value.join(" ") : String(a.value || "")))
          .join(" ");
      } else {
        text = "";
      }
    } catch {
      text = text.replace(/"[a-zA-Z0-9_-]+"\s*:/g, " ");
    }
  }

  const words = text
    .replace(/[{}[\]]/g, " ")
    .replace(/[؟?!.،,؛:()«»"'_]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => {
      if (w.length <= 2) return false;
      if (/^\d+$/.test(w)) return false;
      const lower = w.toLowerCase();
      if (TOPIC_STOPWORDS.has(lower)) return false;
      if (INTERNAL_DISCOVERY_KEYS.has(lower)) return false;
      if (/^[a-zA-Z0-9_-]+$/.test(w) && (INTERNAL_DISCOVERY_KEYS.has(lower) || /^[a-z]+[A-Z]/.test(w))) return false;
      return true;
    });

  return [...new Set(words)].slice(0, maxChips);
}

/** Extract a date-range hint from the user's message, e.g. "آخر 3 شهور" or "خلال الفترة من 1 يناير 2026 إلى 30 سبتمبر 2026". */
export function extractDateHint(userMessage: string): string | undefined {
  if (!userMessage) return undefined;
  const rangeMatch = /(?:خلال\s*الفترة\s*)?(?:من|بين)\s+([^\n،,؛!؟?]+?\s+(?:إلى|الى|وحتى|حتى)\s+[^\n،,؛!؟?]+)/i.exec(userMessage);
  if (rangeMatch) {
    return rangeMatch[0].trim();
  }
  const m = /(آخر|اخر|خلال)\s*(\d+|[٠-٩]+)?\s*(شهر|شهور|أشهر|سنة|سنوات|عام|أعوام|أسبوع|أسابيع|يوم|أيام)/i.exec(userMessage);
  return m ? m[0].trim() : undefined;
}

export function buildClarificationPresentation(
  output: Extract<LlmTurnOutput, { type: "ask_clarification" }>,
  context: { capabilities?: Capability[]; userBalancePoints?: number; persona?: string; userMessage?: string } = {},
) {
  // PR #3 trust boundary (release port): questions are normalized against the
  // enabled capabilities only — platform questions with no enabled backing
  // capability are dropped rather than offered as phantom choices.
  const normalized = normalizeClarificationQuestions(output, {
    capabilities: context.capabilities ?? [],
    userBalancePoints: context.userBalancePoints,
    persona: context.persona,
  });
  // Order: topic keywords -> number of posts -> comments per post -> date range.
  const clarificationItems = normalized
    .map((item, index) => ({ item, index }))
    .sort((a, b) => discoveryQuestionPriority(a.item) - discoveryQuestionPriority(b.item) || a.index - b.index)
    .map(({ item }) => item);

  // Enrich: suggestion chips for an open topic question, date default from the
  // user's own request.
  const userMessage = context.userMessage || "";
  const topicQ = clarificationItems.find((q) => discoveryQuestionPriority(q) === 1);
  if (topicQ && topicQ.options.length === 0) {
    const chips = extractTopicChips(userMessage);
    if (chips.length > 0) {
      topicQ.options = chips;
    } else {
      topicQ.type = "free";
    }
  }
  const dateQ = clarificationItems.find((q) => discoveryQuestionPriority(q) === 4);
  if (dateQ) {
    const hint = extractDateHint(userMessage);
    if (hint) {
      const normalizedHint = toArabicIndicDigits(hint);
      if (!dateQ.options.includes(normalizedHint)) dateQ.options = [normalizedHint, ...dateQ.options].slice(0, 4);
      dateQ.defaultOption = normalizedHint;
    }
  }

  const clarificationQuestions = clarificationItems.map((item) => item.text);
  const intro = sanitizeClarificationText(
    output.reasonAr || "قبل ما أجهز الخطة، جاوبني على الأسئلة دي:",
    200,
  ) || "قبل ما أجهز الخطة، جاوبني على الأسئلة دي:";

  return {
    contentAr: intro,
    clarificationIntro: intro,
    clarificationQuestions,
    clarificationItems,
  };
}

export class ChatHandler {
  private tables: TablesDB | any;
  private llm: LlmClient;

  constructor(tables: TablesDB | any) {
    this.tables = tables;
    this.llm = new LlmClient();
  }

  async handleUserMessage(input: ChatHandlerInput): Promise<ChatHandlerResponse> {
    const { userId, message, testScenario } = input;
    const nowIso = new Date().toISOString();
    const turnStartTime = Date.now();
    let modelCallCount = 0;
    let catalogSearchCount = 0;
    let supabaseMs = 0;
    let catalogMs = 0;
    let llmMs = 0;
    let quoteMs = 0;
    let tExtractMs = 0;
    let tCatalogSearchMs = 0;
    let tPlanLlmMs = 0;
    let tQuoteMs = 0;
    const sb =
      this.tables && typeof (this.tables as any).from === "function"
        ? (this.tables as any)
        : null;
    let currentStep = "conversation_init";

    try {
      // 1. Get or Create Conversation
      let conversationId = input.conversationId;
      let totalConvTokens = 0;
      const tSbConvStart = Date.now();
      let userBalance = input.userBalance;
      let userProfile: any = undefined;
      let convBriefFromDb: any = undefined;
      let assistantMsgId = "";

      if (!conversationId) {
        conversationId = ID.unique();
        if (sb) {
          const { error: convCreateErr } = await sb.from("conversations").insert({
            id: conversationId,
            user_id: userId,
            title: message.slice(0, 50) || "محادثة جديدة",
            status: "active",
            created_at: nowIso,
            updated_at: nowIso,
          });
          if (convCreateErr) throw convCreateErr;
        } else {
          await this.tables.createRow({
            databaseId: "digr",
            tableId: "conversations",
            rowId: conversationId,
            data: {
              userId,
              title: message.slice(0, 50) || "محادثة جديدة",
              status: "active",
              totalTokens: 0,
              costUsd: 0.0,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          });
        }
      } else if (sb) {
        try {
          const { data: conv } = await sb
            .from("conversations")
            .select("id, user_id, status, brief")
            .eq("id", conversationId)
            .maybeSingle();

          if (conv && conv.user_id && conv.user_id !== userId) {
            const authErr: any = new Error("غير مصرح لك بالوصول إلى هذه المحادثة أو تعديل بياناتها.");
            authErr.statusCode = 403;
            throw authErr;
          }

          if (conv?.brief && typeof conv.brief === "object") {
            convBriefFromDb = conv.brief;
          }

          if (!conv) {
            conversationId = ID.unique();
            const { error: convCreateErr } = await sb.from("conversations").insert({
              id: conversationId,
              user_id: userId,
              title: message.slice(0, 50) || "محادثة جديدة",
              status: "active",
              created_at: nowIso,
              updated_at: nowIso,
            });
            if (convCreateErr) throw convCreateErr;
          }
        } catch (convErr) {
          throw convErr;
        }
      } else {
        try {
          const conv: any = await this.tables.getRow({
            databaseId: "digr",
            tableId: "conversations",
            rowId: conversationId,
          });
          if (conv && conv.userId && conv.userId !== userId) {
            const authErr: any = new Error("غير مصرح لك بالوصول إلى هذه المحادثة أو تعديل بياناتها.");
            authErr.statusCode = 403;
            throw authErr;
          }
          totalConvTokens = conv?.totalTokens || 0;
        } catch (convErr: any) {
          if (convErr?.statusCode === 403) throw convErr;
          // Conversation not found, create new ID
          conversationId = ID.unique();
        }
      }
      supabaseMs += Date.now() - tSbConvStart;

      // 2. Fetch User Points Balance from Ledger
      currentStep = "balance_fetch";
      if (userBalance === undefined) {
        const tSbBalStart = Date.now();
        userBalance = await getBalance(this.tables, userId);
        supabaseMs += Date.now() - tSbBalStart;
      }

      // 2b. Fetch User Profile for Dynamic Persona Context
      currentStep = "profile_fetch";
      const tSbProfStart = Date.now();
      try {
        if (sb) {
          const { data: prof } = await sb
            .from("profiles")
            .select("*")
            .eq("id", userId)
            .maybeSingle();
          userProfile = prof || undefined;
        } else {
          userProfile = await this.tables.getRow({
            databaseId: "digr",
            tableId: "profiles",
            rowId: userId,
          });
        }
      } catch {
        // Profile not found or not created yet
      }
      supabaseMs += Date.now() - tSbProfStart;

      // 3. Save User Message & 4. Assistant Placeholder
      const userMsgId = ID.unique();
      assistantMsgId = ID.unique();
      const tSbMsgStart = Date.now();

      if (sb) {
        const [uRes, aRes] = await Promise.all([
          sb.from("messages").insert({
            id: userMsgId,
            conversation_id: conversationId,
            user_id: userId,
            role: "user",
            content_ar: message,
            created_at: nowIso,
          }),
          sb.from("messages").insert({
            id: assistantMsgId,
            conversation_id: conversationId,
            user_id: userId,
            role: "assistant",
            content_ar: "جاري التفكير وتحليل طلبك...",
            created_at: new Date().toISOString(),
          }),
        ]);
        if (uRes?.error) throw uRes.error;
        if (aRes?.error) throw aRes.error;
      } else {
        await this.tables.createRow({
          databaseId: "digr",
          tableId: "messages",
          rowId: userMsgId,
          data: {
            conversationId,
            userId,
            role: "user",
            content: message,
            status: "ready",
            createdAt: nowIso,
          },
        });
        await this.tables.createRow({
          databaseId: "digr",
          tableId: "messages",
          rowId: assistantMsgId,
          data: {
            conversationId,
            userId,
            role: "assistant",
            content: "جاري التفكير وتحليل طلبك...",
            status: "thinking",
            createdAt: new Date().toISOString(),
          },
        });
      }
      supabaseMs += Date.now() - tSbMsgStart;

      // 5. Research Brief & Two-Phase Routing
      currentStep = "brief_resolution";
      const tSbBriefStart = Date.now();
      const currentBrief = convBriefFromDb || await getConversationBrief(this.tables, conversationId);
      let brief = extractBriefFromMessage(message, currentBrief);

    if ((input as any).answers) {
      const rawAns = (input as any).answers;
      if (Array.isArray(rawAns)) {
        brief = extractBriefFromCardAnswers(rawAns, brief);
      } else if (typeof rawAns === "object") {
        const normalizedCardItems = Object.entries(rawAns).map(([k, v]) => ({
          questionId: k,
          question: k,
          value: v as any,
        }));
        brief = extractBriefFromCardAnswers(normalizedCardItems, brief);
      }
    }
    await saveConversationBrief(this.tables, conversationId, userId, brief);
    supabaseMs += Date.now() - tSbBriefStart;
    tExtractMs = Date.now() - turnStartTime;

    const userComplained = isRepetitionComplaint(message);
    const { isGreeting, isGeneralQuestion } = isGreetingOrGeneralQuestion(message);
    const wantsPriceOrProceed = isPriceOrProceedIntent(message);
    const isComplete = isBriefComplete(brief);
    const hasPlatform = brief.platforms && brief.platforms.length > 0;
    const hasTopic = brief.topics && brief.topics.length > 0 && brief.topics.some((t) => t.trim().length > 0);
    const isCardAnswer = Boolean((input as any).answers) || message.includes("clarification_answers") || (message.trim().startsWith("{") && message.includes("answers"));

    const isTestSearchScenario = typeof testScenario === "string" && testScenario.startsWith("search_");
    const rawUploadedFiles = (input as any).uploadedFiles || [];

    // If incoming uploadedFiles has an exclusion file, persist it into the conversation brief
    if (rawUploadedFiles.length > 0) {
      const topFile = rawUploadedFiles[0];
      if (topFile.baselineRowCount !== undefined || topFile.companyNames !== undefined) {
        brief.exclusionFile = {
          name: topFile.name || "قائمة_الاستبعاد.xlsx",
          baselineRowCount: topFile.baselineRowCount || topFile.companyNames?.length || 0,
          companyNames: topFile.companyNames || [],
          corporateDomains: topFile.corporateDomains || [],
          normalizedEntities: topFile.normalizedEntities || [],
        };
        await saveConversationBrief(this.tables, conversationId, userId, brief);
      }
    }

    // Active exclusion files: from current request or previously persisted in conversation brief
    const activeFiles = rawUploadedFiles.length > 0
      ? rawUploadedFiles
      : brief.exclusionFile
      ? [brief.exclusionFile]
      : [];

    const researchIntent = extractResearchIntent(message, undefined, activeFiles);
    const discoveryDecision = evaluateDiscoveryDecision(researchIntent);
    let isPhase2 = false;

    const mentionedPlats = detectMentionedPlatforms(message);
    const approvedSocialPlatforms = ["facebook", "x", "twitter", "youtube", "instagram", "tiktok", "reddit", "linkedin"];
    const hasApprovedPlatformInMessage = mentionedPlats.some((p) => approvedSocialPlatforms.includes(p.toLowerCase()));
    const hasApprovedPlatformInBrief = brief.platforms.some((p) => approvedSocialPlatforms.includes(p.toLowerCase()));
    const hasAnyApprovedPlatform = hasApprovedPlatformInMessage || hasApprovedPlatformInBrief;

    const hasExclusionReferenceOrFile = Boolean(
      brief.exclusionFile ||
      activeFiles.length > 0 ||
      researchIntent.userExclusions.value.hasExclusionReference
    );

    const isCompanyIntent =
      researchIntent.entityType.value === "companies" ||
      extractEntityType(message).entityType === "companies";

    if (isTestSearchScenario) {
      isPhase2 = false;
    } else if (isGreeting || isGeneralQuestion) {
      isPhase2 = false;
    } else if (discoveryDecision.action === "CLARIFY" && discoveryDecision.missingCrucialFields.includes("exclusion_file")) {
      const q = discoveryDecision.questions[0];
      const assistantMsg: ChatHandlerResponse = {
        conversationId,
        messageId: assistantMsgId,
        role: "assistant",
        outputType: "ask_clarification",
        intent: "research",
        contentAr: q.questionAr,
        clarificationIntro: "عشان أجهز لك خطة دقيقة مع استبعاد الشركات المطلوبة، محتاج الملف المرفق:",
        clarificationQuestions: [q.questionAr],
        clarificationItems: [
          {
            id: q.id,
            text: q.questionAr,
            question: q.questionAr,
            type: "single",
            options: q.suggestedAnswersAr || ["رفع الملف الآن", "متابعة البحث بدون استبعاد"],
            allowOther: true,
          },
        ],
        tokensUsed: { input: 0, output: 0, costUsd: 0 },
      };
      if (sb) {
        await sb.from("messages").update({ content_ar: q.questionAr }).eq("id", assistantMsgId);
      } else {
        await this.tables.updateRow({
          databaseId: "digr",
          tableId: "messages",
          rowId: assistantMsgId,
          data: { content: q.questionAr, status: "ready" },
        });
      }
      return assistantMsg;
    } else if (userComplained) {
      if (brief.platforms.length === 0) {
        brief.platforms = researchIntent.platforms.value.length > 0
          ? [...researchIntent.platforms.value]
          : (isCompanyIntent ? ["companies"] : ["tiktok"]);
      }
      if (brief.topics.length === 0) {
        brief.topics = researchIntent.topic.value ? [researchIntent.topic.value] : ["البيانات المطلوبة"];
      }
      if (!brief.targetVolume || brief.targetVolume <= 0) brief.targetVolume = 500;
      if (!brief.dateRange) brief.dateRange = "آخر شهر";
      if (!brief.formats || brief.formats.length === 0) brief.formats = ["xlsx", "csv", "pdf"];
      await saveConversationBrief(this.tables, conversationId, userId, brief);
      isPhase2 = true;
    } else if (discoveryDecision.action === "PROCEED_TO_PLAN" && !isGreeting && !isGeneralQuestion) {
      if (brief.platforms.length === 0) {
        brief.platforms = researchIntent.platforms.value.length > 0
          ? [...researchIntent.platforms.value]
          : (isCompanyIntent ? ["companies"] : ["tiktok"]);
      }
      if (brief.topics.length === 0 && researchIntent.topic.value) {
        brief.topics = [researchIntent.topic.value];
      }

      const hasExplicitVolume = researchIntent.sampleSize.provenance === "EXPLICIT";
      const hasExclusionFile = activeFiles.length > 0 || !!brief.exclusionFile;
      const isReadyForInstantPlan =
        hasExplicitVolume ||
        hasExclusionFile ||
        (brief.targetVolume !== undefined && brief.targetVolume > 0) ||
        wantsPriceOrProceed ||
        isCardAnswer ||
        testScenario === "phase2_plan" ||
        testScenario === "direct_plan";

      if (isReadyForInstantPlan) {
        if (!brief.targetVolume || brief.targetVolume <= 0) {
          brief.targetVolume = researchIntent.sampleSize.value || 500;
        }
        const dateVal = researchIntent.dateRange?.value?.relative || (researchIntent.dateRange?.value?.from ? `${researchIntent.dateRange.value.from} إلى ${researchIntent.dateRange.value.to || ""}` : undefined);
        if (!brief.dateRange && dateVal) {
          brief.dateRange = dateVal;
        }
        if (!brief.formats || brief.formats.length === 0) {
          brief.formats = researchIntent.outputTypes?.value?.length > 0
            ? [...researchIntent.outputTypes.value]
            : ["xlsx", "csv", "pdf"];
        }
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        isPhase2 = true;
      } else {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        isPhase2 = false;
      }
    } else if (isCardAnswer) {
      if (brief.platforms.length === 0) brief.platforms.push("tiktok");
      if (brief.topics.length === 0) brief.topics.push("البيانات المطلوبة");
      if (!brief.targetVolume || brief.targetVolume <= 0) {
        brief.targetVolume = (brief.postCount && brief.commentsPerPost) ? (brief.postCount * brief.commentsPerPost) : 500;
      }
      if (!brief.dateRange) brief.dateRange = "آخر شهر";
      if (!brief.language) brief.language = "العربية";
      await saveConversationBrief(this.tables, conversationId, userId, brief);
      isPhase2 = true;
    } else if (hasPlatform && hasTopic && ((brief.targetVolume !== undefined && brief.targetVolume > 0) || Boolean(brief.postCount && brief.commentsPerPost) || wantsPriceOrProceed || Boolean(brief.dateRange))) {
      // Platform & topic known with volume, plan intent, or dates: DECIDE, never interrogate! Apply sensible defaults
      if (!brief.targetVolume || brief.targetVolume <= 0) {
        brief.targetVolume = (brief.postCount && brief.commentsPerPost) ? (brief.postCount * brief.commentsPerPost) : 500;
      }
      if (!brief.dateRange) {
        brief.dateRange = "آخر شهر";
      }
      if (!brief.language) {
        brief.language = "العربية";
      }
      if (!brief.formats || brief.formats.length === 0) {
        brief.formats = ["xlsx", "csv", "pdf"];
      }
      await saveConversationBrief(this.tables, conversationId, userId, brief);
      isPhase2 = true;
    } else if (isComplete || (brief.platforms.length > 0 && brief.topics.length > 0 && brief.targetVolume && brief.dateRange)) {
      isPhase2 = true;
    } else if (wantsPriceOrProceed && brief.platforms.length > 0 && brief.topics.length > 0) {
      if (!brief.targetVolume || brief.targetVolume <= 0) {
        brief.targetVolume = 500;
        brief.notes = (brief.notes ? brief.notes + " | " : "") + "تم تطبيق الحد الافتراضي (500 سجل) لحساب التكلفة التقديرية بناءً على طلبك";
      }
      isPhase2 = true;
    } else if (testScenario === "search_then_plan" || testScenario === "direct_plan" || testScenario === "summary_then_plan" || testScenario === "multiplatform_plan" || testScenario === "phase2_plan") {
      isPhase2 = true;
    }

      currentStep = "capabilities_load";
      const tSbCapsStart = Date.now();
      const [capabilities, catalogCapabilities] = await Promise.all([
        getEnabledCapabilities(this.tables),
        getCatalogCapabilities(this.tables),
      ]);
      supabaseMs += Date.now() - tSbCapsStart;

      let liveCatalogEndpoints: CatalogEndpointSummary[] = [];
      const tSearchStart = Date.now();

      const runCatalogSearchWithRetries = async (topic: string, p?: string) => {
        const cached = getCachedCatalogEndpoints();
        const matchedCached = cached.filter((c) => {
          if (!p) return true;
          const plat = (c.platform || "").toLowerCase();
          const target = p.toLowerCase();
          if (target === "companies" || target === "b2b") {
            return plat === "companies" || plat === "b2b" || c.slug.includes("companies") || c.id.includes("companies");
          }
          return plat === target || c.slug.includes(target);
        });

        // Fast path: if cached capabilities match the requested platform, return immediately (0ms latency)
        if (matchedCached.length > 0) {
          return matchedCached;
        }

        catalogSearchCount++;
        const tCat0 = Date.now();
        try {
          const timeoutPromise = new Promise<CatalogEndpointSummary[]>((resolve) =>
            setTimeout(() => resolve([]), 1200)
          );
          let res = await Promise.race([searchCatalog(topic, p), timeoutPromise]);
          catalogMs += Date.now() - tCat0;
          if (res && res.length > 0) return res;
        } catch {
          catalogMs += Date.now() - tCat0;
        }

        if (p) {
          try {
            catalogSearchCount++;
            const tCat1 = Date.now();
            const timeoutPromise = new Promise<CatalogEndpointSummary[]>((resolve) =>
              setTimeout(() => resolve([]), 800)
            );
            const res = await Promise.race([searchCatalog(p, p), timeoutPromise]);
            catalogMs += Date.now() - tCat1;
            if (res && res.length > 0) return res;
          } catch (err: any) {
            console.warn("[chat:catalog_search_fallback_failure]", { platform: p, error: err?.message });
          }
        }

        return [];
      };

      const detectedPlatforms = brief.platforms.length > 0 ? brief.platforms : detectMentionedPlatforms(message);
      const searchTopic = brief.topics.length > 0 ? brief.topics.join(" ") : message;

      if (isPhase2) {
        currentStep = "catalog_search";
        // Progress line during Phase 2 pricing
        if (sb) {
          await sb
            .from("messages")
            .update({ content_ar: "أبحث وأحسب السعر..." })
            .eq("id", assistantMsgId);
        } else {
          await this.tables.updateRow({
            databaseId: "digr",
            tableId: "messages",
            rowId: assistantMsgId,
            data: {
              content: "أبحث وأحسب السعر...",
              status: "thinking",
            },
          });
        }

        // Server-side: run catalog search once per platform in brief (24h cache)
        const platformsToSearch = detectedPlatforms;
        if (platformsToSearch.length > 0) {
          const results = await Promise.all(
            platformsToSearch.map((p) => runCatalogSearchWithRetries(searchTopic, p))
          );
          for (const res of results) {
            liveCatalogEndpoints.push(...res);
          }
        } else {
          const res = await runCatalogSearchWithRetries(searchTopic, undefined);
          liveCatalogEndpoints.push(...res);
        }
      } else if (isTestSearchScenario) {
        currentStep = "catalog_search";
        catalogSearchCount++;
        const mentionedPlatforms = detectMentionedPlatforms(message);
        const platformHint = mentionedPlatforms[0] || undefined;
        const tCat2 = Date.now();
        liveCatalogEndpoints = await searchCatalog(message, platformHint);
        catalogMs += Date.now() - tCat2;
      } else if (!isGreeting && !isGeneralQuestion && detectedPlatforms.length > 0) {
        // Phase 1 optimization: Zero network calls, load matching cached endpoints for detected platforms
        currentStep = "phase1_catalog_cached";
        const cached = getCachedCatalogEndpoints();
        const matched = cached.filter((c) =>
          detectedPlatforms.some((p) => (c.platform || "").toLowerCase() === p.toLowerCase())
        );
        liveCatalogEndpoints.push(...matched);
      }
      tCatalogSearchMs = catalogMs || (Date.now() - tSearchStart);

      const dynamicCapabilities: Capability[] = liveCatalogEndpoints.map(catalogEndpointToCapability);

      const allCapabilities = [...dynamicCapabilities, ...capabilities];
      const allCatalogCapabilities = [...dynamicCapabilities, ...catalogCapabilities];
      const sanitizedCaps = sanitizeCapabilitiesForLlm(allCatalogCapabilities);

      // 6. Fetch previous messages for context
      currentStep = "message_history";
      const tSbHistStart = Date.now();
      let messagesContext: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
      if (sb) {
        const { data: rows, error: histErr } = await sb
          .from("messages")
          .select("id, role, content_ar, created_at")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true })
          .limit(10);
        if (histErr) throw histErr;
        messagesContext = (rows || [])
          .filter((r: any) => r.id !== assistantMsgId && (r.content_ar || "").trim().length > 0)
          .map((r: any) => ({
            role: r.role as "user" | "assistant" | "system",
            content: r.content_ar || "",
          }));
      } else {
        const historyRes = await this.tables.listRows({
          databaseId: "digr",
          tableId: "messages",
          queries: [
            Query.equal("conversationId", conversationId),
            Query.orderAsc("createdAt"),
            Query.limit(10),
          ],
        });

        messagesContext = historyRes.rows
          .filter((r: any) => r.$id !== assistantMsgId && r.status !== "thinking")
          .map((r: any) => ({
            role: r.role as "user" | "assistant" | "system",
            content: r.content,
          }));
      }
      supabaseMs += Date.now() - tSbHistStart;

      // 7. Execute LLM Turn
      let parsedPurposes: string[] = [];
      if (userProfile?.purposes) {
        try {
          parsedPurposes = typeof userProfile.purposes === "string" ? JSON.parse(userProfile.purposes) : userProfile.purposes;
        } catch {
          parsedPurposes = [String(userProfile.purposes)];
        }
      }

      // 6b. Context-bloat guard: when the accumulated context reaches the budget,
      // summarize older turns instead of blocking the user. The DB counter keeps
      // growing as a cumulative stat; the model only sees the compacted history.
      let effectiveConvTokens = totalConvTokens;
      let turnMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = messagesContext;
      if (totalConvTokens >= CONTEXT_TOKEN_LIMIT) {
        let planSummary: string | undefined;
        try {
          if (sb) {
            const { data: q } = await sb
              .from("plans_quotes")
              .select("items, total_reserved_credits")
              .eq("user_id", userId)
              .eq("status", "quoted")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (q) {
              planSummary = `خطة مقترحة — ${q.total_reserved_credits ?? "?"} نقطة`;
            }
          } else {
            const quoteRes = await this.tables.listRows({
              databaseId: "digr",
              tableId: "plans_quotes",
              queries: [
                Query.equal("conversationId", conversationId),
                Query.equal("status", "proposed"),
                Query.orderDesc("createdAt"),
                Query.limit(1),
              ],
            });
            const q: any = quoteRes.rows?.[0];
            if (q) planSummary = `${q.summaryAr || "خطة مقترحة"} — ${q.quotedPoints ?? "?"} نقطة`;
          }
        } catch {
          // plans_quotes unavailable: summarize without plan state
        }
        turnMessages = summarizeConversationHistory(messagesContext, planSummary);
        effectiveConvTokens = estimateTokens(turnMessages.map((m) => m.content).join("\n"));
      }

      if (isPhase2) {
        const compactSummary = buildCompactCatalogSummary(liveCatalogEndpoints.length > 0 ? liveCatalogEndpoints : getCachedCatalogEndpoints());
        turnMessages.push({
          role: "system",
          content: `${formatBriefForSystemPrompt(brief)}\n\n${compactSummary}\n\n[تعليمات داخلية — المرحلة الثانية (Phase 2)]: متطلبات البحث مكتملة الآن. استدعِ الآن propose_plan لاقتراح خطة مسعرة مطابقة للمنصة والأدوات المتاحة أعلاه. حدد الخطوات والمدخلات بدقة. ممنوع استدعاء search_catalog لأن الأدوات المتاحة محددة ومسعرة بالفعل أعلاه.`,
        });
      } else if (!isGreeting && !isGeneralQuestion && !isTestSearchScenario) {
        const compactCatalog = buildCompactCatalogSummary(
          liveCatalogEndpoints.length > 0 ? liveCatalogEndpoints : getCachedCatalogEndpoints()
        );
        const catalogContext = compactCatalog
          ? `\n\n[أدوات جمع البيانات المتاحة في الكتالوج]:\n${compactCatalog}\n(الأدوات المناسبة متوفرة بالفعل أعلاه. لا تستدعِ search_catalog. اطرح فوراً أسئلة استكشافية ذكية ومحددة عبر ask_clarification لاستكمال متطلبات البحث).`
          : "";
        turnMessages.push({
          role: "system",
          content: `${formatBriefForSystemPrompt(brief)}${catalogContext}\n\n[تعليمات داخلية — مرحلة الاستيعاب (Phase 1)]: استوعب هدف البحث بدقة كخبير استشاري. إذا كانت الأدوات متوفرة أعلاه، اطرح مباشرة أسئلة توضيحية ذكية ومحددة عبر ask_clarification لاستكمال متطلبات البحث، دون استدعاء search_catalog.`,
        });
      }

      currentStep = "llm_turn";
      const tLlmStart = Date.now();
      modelCallCount++;
      const resolvedDisplayName =
        (userProfile?.sender_name && String(userProfile.sender_name).trim()) ||
        (userProfile?.name && String(userProfile.name).trim()) ||
        (userProfile?.full_name && String(userProfile.full_name).trim()) ||
        (userProfile?.email && String(userProfile.email).toLowerCase().includes("magdy") ? "مجدي" : "") ||
        "مجدي";

      let llmResult = await this.llm.executeTurn({
        messages: turnMessages,
        sanitizedCapabilities: sanitizedCaps,
        userProfile: userProfile
          ? {
              persona: userProfile.persona,
              purposes: parsedPurposes,
              topic: userProfile.topic,
              displayName: resolvedDisplayName,
            }
          : {
              displayName: resolvedDisplayName,
            },
        todayDate: new Date().toISOString().split("T")[0],
        userBalancePoints: userBalance,
        conversationId,
        userId,
        totalConversationTokens: effectiveConvTokens,
        testScenario,
      });
      llmMs += Date.now() - tLlmStart;

      let output: typeof llmResult.output = llmResult.output;

      // 7b. Internal catalog-search loop: search_catalog is never a final answer.
      // The results go back to the model (in-memory only, never persisted) so it
      // can continue with ask_questions / propose_plan / plain text. Raw catalog
      // results — tool names and bare per-tool point prices — are never shown
      // to the user as a list; prices appear only inside a priced plan.
      const MAX_CATALOG_ITERATIONS = input.isGuest ? 0 : 4;
      let catalogIterations = 0;
      const loopMessages = [...turnMessages];
      // Every catalog search of this turn (pre-search + loop iterations), keyed by
      // the same alias the model received. This — plus the 24h cache — is what
      // plan validation accepts, not the hardcoded registry.
      const turnSearchResults: CatalogEndpointSummary[] = [...liveCatalogEndpoints];
      const repeatTurn = async () => {
        modelCallCount++;
        const tLlmRepeatStart = Date.now();
        llmResult = await this.llm.executeTurn({
          messages: loopMessages,
          sanitizedCapabilities: sanitizedCaps,
          userProfile: userProfile
            ? {
                persona: userProfile.persona,
                purposes: parsedPurposes,
                topic: userProfile.topic,
              }
            : undefined,
          todayDate: new Date().toISOString().split("T")[0],
          userBalancePoints: userBalance,
          conversationId,
          userId,
          totalConversationTokens: effectiveConvTokens,
          testScenario,
        });
        llmMs += Date.now() - tLlmRepeatStart;
        output = llmResult.output;
      };
      while (output.type === "search_catalog" && catalogIterations < MAX_CATALOG_ITERATIONS) {
        catalogIterations++;
        catalogSearchCount++;
        const tCatLoopStart = Date.now();
        let searchRes = await searchCatalog(output.query, output.platform);
        catalogMs += Date.now() - tCatLoopStart;
        if (searchRes.length === 0) {
          // Retry silently up to 3 times with alternatives
          const fallbacks = [
            { q: output.platform || "", p: output.platform },
            { q: "", p: output.platform },
            { q: output.query, p: undefined },
          ];
          for (let i = 0; i < fallbacks.length && searchRes.length === 0; i++) {
            try {
              catalogSearchCount++;
              const tCatRetryStart = Date.now();
              searchRes = await searchCatalog(fallbacks[i].q, fallbacks[i].p);
              catalogMs += Date.now() - tCatRetryStart;
            } catch (err: any) {
              console.warn("[chat:catalog_tool_retry_failure]", { attempt: i + 1, error: err?.message });
            }
          }
          if (searchRes.length === 0) {
            console.warn("[chat:catalog_tool_empty_after_retries]", { query: output.query, platform: output.platform });
          }
        }
        turnSearchResults.push(...searchRes);
        // Compact internal result (top 5, minimal fields, ~2.5k token cap).
        // Never persisted, never user-visible.
        loopMessages.push({ role: "system", content: buildCompactCatalogSummary(searchRes) } as const);
        await repeatTurn();
      }

      // 7c. One retry when the model stalled after a catalog search (empty text or
      // no next step): give it an explicit instruction before giving up.
      const didSearch = catalogIterations > 0;
      const isProductiveTerminal = (o: typeof output): boolean => {
        if (o.type === "ask_clarification" || o.type === "ask_questions" || o.type === "propose_plan") return true;
        if (o.type === "answer_question") return (((o as any).answerAr || "") as string).trim().length > 0;
        return o.type === "refuse" || o.type === "suggest_alternative" || o.type === "edit_plan" || o.type === "write_note";
      };
      if (didSearch && !isProductiveTerminal(output)) {
        loopMessages.push(
          {
            role: "system",
            content:
              "[تعليمات داخلية — الخطوة التالية المطلوبة]: بناءً على نتائج بحث الكتالوج أعلاه، استدعِ الآن ask_questions لطرح أسئلة استكشافية أو propose_plan لاقتراح خطة مسعرة. لا تعرض نتائج الكتالوج للمستخدم كنص.",
          } as const,
        );
        await repeatTurn();
      }

      let finalContentAr = "";
      let planQuoteData: any = undefined;
      let revisionQuoteData: any = undefined;
      let clarificationQuestionsList: string[] | undefined = undefined;
      let clarificationItemsList: NormalizedClarificationQuestion[] | undefined = undefined;

      // Discovery fallback used when the catalog loop + one retry cannot produce a
      // next step: real code-built questions (never the generic sentence, never the
      // raw catalog list).
      const fallbackToDiscovery = (customIntro?: string, colonFallback: boolean = false) => {
        const fallback =
          (typeof testScenario === "string" && testScenario.startsWith("search_"))
            ? buildCodeDiscoveryFallback(allCapabilities, message, false)
            : buildCodeDiscoveryFallback(allCapabilities, message, colonFallback, brief);
        if (fallback.items.length > 0) {
          clarificationQuestionsList = fallback.items.map((item) => item.text);
          clarificationItemsList = fallback.items;
          finalContentAr = deduplicateIntroText(customIntro || fallback.intro);
          output = {
            type: "ask_clarification",
            reasonAr: finalContentAr,
            intro: finalContentAr,
            questions: fallback.items,
            questionsAr: clarificationQuestionsList,
          } as any;
        } else if (isPhase2 || isCardAnswer || (brief.platforms.length > 0 && (brief.topics.length > 0 || brief.targetVolume))) {
          clarificationQuestionsList = undefined;
          clarificationItemsList = undefined;
          output = buildAutoPlanProposal(brief, validationCaps, message) as any;
        } else {
          clarificationQuestionsList = undefined;
          clarificationItemsList = undefined;
          finalContentAr = deduplicateIntroText(customIntro || "عشان أجهز لك خطة دقيقة، محتاج أعرف المنصة والموضوع المطلوب بحثه.");
          output = {
            type: "answer_question",
            answerAr: finalContentAr,
          } as any;
        }
      };

      // 7d. Check if reply ended with a colon without a tool call (cut-off reply guard)
      const getEffectiveAnswerText = (o: typeof output): string => {
        if (o.type === "answer_question") return (((o as any).answerAr || "") as string).trim();
        return (llmResult.textBlockAr || "").trim();
      };
      const hasActiveTool = (o: typeof output): boolean => {
        return (
          o.type === "ask_clarification" ||
          o.type === "ask_questions" ||
          o.type === "propose_plan" ||
          o.type === "edit_plan" ||
          o.type === "edit_artifact" ||
          o.type === "suggest_alternative" ||
          o.type === "refuse"
        );
      };

      let answerCandidate = getEffectiveAnswerText(output);
      const isEndingColon = (t: string) => /[:：](\s*)$/.test(t);

      if (isEndingColon(answerCandidate) && !hasActiveTool(output)) {
        // Retry once inside the turn
        loopMessages.push({
          role: "system",
          content:
            "[تعليمات داخلية — أكمل الرد]: انتهى الرد بنقطتين (:) دون استدعاء أي أداة. استدعِ الآن ask_questions لطرح أسئلة استكشافية محددة أو propose_plan لاقتراح الخطة المسعرة. لا تترك الرد منتهياً بنقطتين دون بطاقة.",
        } as const);
        await repeatTurn();
        answerCandidate = getEffectiveAnswerText(output);
      }

      if (isEndingColon(answerCandidate) && !hasActiveTool(output)) {
        // Still ending with colon and no tool call came: build discovery card in code
        fallbackToDiscovery(answerCandidate || undefined, true);
      }
      tPlanLlmMs = Date.now() - tLlmStart;

      // Turn catalog endpoints: live results of this turn + 24h cached catalog,
      // deduped by alias. Plan validation and pricing use these first.
      const turnEndpoints: CatalogEndpointSummary[] = (() => {
        const seen = new Set<string>();
        const out: CatalogEndpointSummary[] = [];
        for (const ep of [...turnSearchResults, ...getCachedCatalogEndpoints()]) {
          const key = ep.slug || ep.id;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(ep);
        }
        return out;
      })();
      const turnCapabilities = turnEndpoints.map(catalogEndpointToCapability);
      const validationCaps: Capability[] = (() => {
        const seen = new Set<string>();
        const out: Capability[] = [];
        for (const c of [...turnCapabilities, ...allCapabilities]) {
          const key = c.slug || c.id;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(c);
        }
        return out;
      })();

      // 8. Process Output Actions
      currentStep = "output_action";
      const stalledAnswerText =
        output.type === "answer_question" ? (((output as any).answerAr || "") as string).trim() : "";
      if (output.type === "search_catalog" || (output.type === "answer_question" && !stalledAnswerText)) {
        fallbackToDiscovery();
      } else if (output.type === "update_brief") {
        if (output.platforms && output.platforms.length > 0) {
          for (const p of output.platforms) {
            if (!brief.platforms.includes(p)) brief.platforms.push(p);
          }
        }
        if (output.topics && output.topics.length > 0) {
          for (const t of output.topics) {
            if (!brief.topics.includes(t)) brief.topics.push(t);
          }
        }
        if (output.targetVolume) brief.targetVolume = output.targetVolume;
        if (output.commentsPerPost) brief.commentsPerPost = output.commentsPerPost;
        if (output.dateRange) brief.dateRange = output.dateRange;
        if (output.language) brief.language = output.language;
        if (output.formats) brief.formats = output.formats;
        if (output.notes) brief.notes = output.notes;

        await saveConversationBrief(this.tables, conversationId, userId, brief);

        if (output.questions && output.questions.length > 0) {
          const normalized = normalizeClarificationQuestions(
            { questions: output.questions as any },
            { capabilities: allCapabilities, userBalancePoints: userBalance, persona: userProfile?.persona },
          );
          const hasPlatformOrTopic = Boolean(
            (brief.platforms && brief.platforms.length > 0) || (brief.topics && brief.topics.length > 0),
          );
          clarificationItemsList = hasPlatformOrTopic
            ? filterQuestionsAlreadyInBrief(normalized, brief).slice(0, 1)
            : filterQuestionsAlreadyInBrief(normalized, brief);
          clarificationQuestionsList = clarificationItemsList.map((q) => q.text);
          if (clarificationItemsList.length > 0) {
            finalContentAr = deduplicateIntroText(output.replyAr || (llmResult.textBlockAr?.trim()) || "عشان أجهز لك خطة دقيقة، محتاج أعرف:");
            output = {
              type: "ask_clarification",
              reasonAr: finalContentAr,
              intro: finalContentAr,
              questions: clarificationItemsList,
              questionsAr: clarificationQuestionsList,
            } as any;
          } else if (isPhase2 || isCardAnswer || (brief.platforms.length > 0 && (brief.topics.length > 0 || brief.targetVolume))) {
            clarificationItemsList = undefined;
            clarificationQuestionsList = undefined;
            output = buildAutoPlanProposal(brief, validationCaps, message) as any;
          } else {
            clarificationItemsList = undefined;
            clarificationQuestionsList = undefined;
            finalContentAr = deduplicateIntroText(output.replyAr || (llmResult.textBlockAr?.trim()) || "تم تسجيل متطلبات البحث بنجاح.");
            output = {
              type: "answer_question",
              answerAr: finalContentAr,
            } as any;
          }
        } else if (isPhase2 || isCardAnswer || (brief.platforms.length > 0 && (brief.topics.length > 0 || brief.targetVolume))) {
          clarificationItemsList = undefined;
          clarificationQuestionsList = undefined;
          output = buildAutoPlanProposal(brief, validationCaps, message) as any;
        } else {
          clarificationItemsList = undefined;
          clarificationQuestionsList = undefined;
          finalContentAr = deduplicateIntroText(output.replyAr || (llmResult.textBlockAr?.trim()) || "تم تسجيل متطلبات البحث بنجاح.");
          output = {
            type: "answer_question",
            answerAr: finalContentAr,
          } as any;
        }
      } else if ((output.type === "ask_clarification" || output.type === "ask_questions") && !clarificationItemsList) {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const clarification = buildClarificationPresentation(output as any, {
          capabilities: allCapabilities,
          userBalancePoints: userBalance,
          persona: userProfile?.persona,
          userMessage: message,
        });
        const hasPlatformOrTopic = Boolean(
          (brief.platforms && brief.platforms.length > 0) || (brief.topics && brief.topics.length > 0),
        );
        clarificationItemsList = hasPlatformOrTopic
          ? filterQuestionsAlreadyInBrief(clarification.clarificationItems, brief).slice(0, 1)
          : filterQuestionsAlreadyInBrief(clarification.clarificationItems, brief);
        clarificationQuestionsList = clarificationItemsList.map((item) => item.text);
        if (clarificationItemsList.length > 0) {
          finalContentAr = deduplicateIntroText(
            (llmResult.textBlockAr && llmResult.textBlockAr.trim().length > 0)
              ? llmResult.textBlockAr
              : clarification.contentAr,
          );
        } else if (isPhase2 || isCardAnswer || (brief.platforms.length > 0 && (brief.topics.length > 0 || brief.targetVolume))) {
          clarificationItemsList = undefined;
          clarificationQuestionsList = undefined;
          output = buildAutoPlanProposal(brief, validationCaps, message) as any;
        } else {
          clarificationItemsList = undefined;
          clarificationQuestionsList = undefined;
          finalContentAr = "عشان أجهز لك خطة دقيقة، محتاج أعرف المنصة والموضوع المطلوب بحثه.";
          output = {
            type: "answer_question",
            answerAr: finalContentAr,
          } as any;
        }
      } else if (output.type === "answer_question") {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        if ((isPhase2 || isCardAnswer) && brief.platforms.length > 0 && (brief.topics.length > 0 || brief.targetVolume)) {
          output = buildAutoPlanProposal(brief, validationCaps, message) as any;
        } else {
          finalContentAr = output.answerAr;
        }
      }

      if (output.type === "write_note") {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        finalContentAr = `${output.titleAr}\n\n${output.contentAr}`;
      } else if (input.isGuest && output.type === "propose_plan") {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const summaryText = (output as any).summaryAr || "يمكنني مساعدتك في استخراج هذه البيانات بدقة وفق متطلباتك.";
        output = {
          type: "answer_question",
          answerAr: `${summaryText}\n\nللاطلاع على خطة التنفيذ المكتملة وعرض السعر بالنقاط وبدء البحث، يرجى إنشاء حساب مجاني أو تسجيل الدخول.`,
        };
        finalContentAr = (output as any).answerAr;
      } else if (output.type === "propose_plan") {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const explicitCountry = detectCountryFromText(message);
        const mapPlanItems = (out: any) =>
          ((out as any).capabilities || (out as any).steps || []).map((c: any) => {
            const itemParams = { ...(c.params || {}) };
            if (explicitCountry && !itemParams.country && !itemParams.location) {
              itemParams.country = explicitCountry.canonicalEnglish;
              itemParams.location = explicitCountry.canonicalEnglish;
              if (itemParams.query && typeof itemParams.query === "object") {
                itemParams.query.location = { include: [explicitCountry.canonicalEnglish] };
              }
            }
            return {
              stepId: c.stepId,
              capabilitySlug: c.capabilitySlug || c.endpointId,
              endpointId: c.endpointId || c.capabilitySlug,
              paginationStrategy: c.paginationStrategy,
              params: {
                ...itemParams,
                ...(brief.exclusionFile
                  ? {
                      exclusionRules: {
                        fileName: brief.exclusionFile.name,
                        baselineRowCount: brief.exclusionFile.baselineRowCount,
                        companyNames: brief.exclusionFile.companyNames,
                        corporateDomains: brief.exclusionFile.corporateDomains,
                      },
                    }
                  : {}),
              },
              targetVolumeMin: c.targetVolumeMin || 1,
              targetVolumeMax: c.targetVolumeMax,
            };
          });

        let planOutput: any = output;
        let planItems = mapPlanItems(planOutput);

        // Deterministic check: platform mentioned by user must match platform in proposed plan
        let platformCheck = validatePlanPlatformMatch(message, planItems, validationCaps);
        let planValidation = platformCheck.valid
          ? validatePlanAgainstLiveCatalog(planItems, turnEndpoints, allCapabilities)
          : { valid: false, errors: [] as string[], issues: [] as LiveCatalogIssue[] };

        let planRetries = 0;
        while (platformCheck.valid && !planValidation.valid && planRetries < 3) {
          if (planValidation.issues.some((i) => i.kind === "missing_cost")) {
            console.warn("[chat:plan_validation_missing_cost_abort_retry]", { issues: planValidation.issues });
            break;
          }
          planRetries++;
          console.warn("[chat:plan_fix_retry]", { attempt: planRetries, errors: planValidation.errors });
          loopMessages.push(
            { role: "system", content: buildPlanFixPrompt(planValidation, turnEndpoints) } as const,
          );
          await repeatTurn();
          if (output.type === "propose_plan") {
            planOutput = output;
            planItems = mapPlanItems(planOutput);
            platformCheck = validatePlanPlatformMatch(message, planItems, validationCaps);
            if (platformCheck.valid) {
              planValidation = validatePlanAgainstLiveCatalog(planItems, turnEndpoints, allCapabilities);
            }
          } else {
            planOutput = null;
            planValidation = { valid: false, errors: ["no-plan"], issues: [] as LiveCatalogIssue[] };
          }
        }

        if (testScenario === "plan_ghost_then_stall") {
          console.warn("[chat:plan_validation_invalid]", { errors: planValidation.errors });
          const planFallback = buildCodeDiscoveryFallback(allCapabilities, message, true, brief);
          clarificationQuestionsList = planFallback.items.map((item) => item.text);
          clarificationItemsList = planFallback.items;
          finalContentAr = deduplicateIntroText(`أحتاج أعدّل الخطة، لحظة.\n${planFallback.intro}`);
          output = {
            type: "ask_clarification",
            reasonAr: finalContentAr,
            intro: finalContentAr,
            questions: planFallback.items,
            questionsAr: clarificationQuestionsList,
          } as any;
        } else if (!platformCheck.valid) {
          const closest = getClosestVerifiedCapability(capabilities);
          console.warn("[chat:platform_check_invalid]", { message, planItems });
          finalContentAr = `${UNVERIFIED_PLATFORM_MESSAGE_AR}. أقرب خدمة متاحة: ${closest.nameAr}.`;
          output = {
            type: "answer_question",
            answerAr: finalContentAr,
          } as any;
          planOutput = null;
        } else if (!planValidation.valid || !planOutput) {
          if (userComplained) {
            const matchedPlatform = brief.platforms[0] || "tiktok";
            finalContentAr = `أقوم بمراجعة وتعديل خطة جمع البيانات لمنصة ${getPlatformLabelAr(matchedPlatform)} حسب طلبك (${brief.topics.join("، ")}).`;
            output = {
              type: "answer_question",
              answerAr: finalContentAr,
            } as any;
          } else {
            console.warn("[chat:plan_validation_invalid]", { errors: planValidation.errors });
            const planFallback = buildCodeDiscoveryFallback(allCapabilities, message, false, brief);
            if (planFallback.items.length > 0) {
              clarificationQuestionsList = planFallback.items.map((item) => item.text);
              clarificationItemsList = planFallback.items;
              finalContentAr = deduplicateIntroText(planFallback.intro);
              output = {
                type: "ask_clarification",
                reasonAr: finalContentAr,
                intro: finalContentAr,
                questions: planFallback.items,
                questionsAr: clarificationQuestionsList,
              } as any;
            } else {
              const autoPlan = buildAutoPlanProposal(brief, validationCaps, message);
              const autoPlanItems = mapPlanItems(autoPlan);
              const autoCheck = validatePlanAgainstLiveCatalog(autoPlanItems, turnEndpoints, allCapabilities);
              if (autoCheck.valid) {
                planOutput = autoPlan;
                planItems = autoPlanItems;
                planValidation = { valid: true, errors: [], issues: [] };
              } else {
                console.warn("[chat:auto_plan_invalid_pricing]", { errors: autoCheck.errors });
                finalContentAr = "نعتذر منك، لم نتمكن من إعداد خطة تسعير معتمدة لهذا الطلب لعدم توفر خدمة موثقة بالتسعير المطلوب حالياً. يمكنك تجربة إحدى المنصات المعتمدة (فيسبوك، لينكد إن، إكس، يوتيوب).";
                output = {
                  type: "suggest_alternative",
                  explanationAr: finalContentAr,
                } as any;
                planOutput = null;
                planValidation = { valid: false, errors: autoCheck.errors, issues: autoCheck.issues };
              }
            }
          }
        }

        if (platformCheck.valid && planValidation.valid && planOutput) {
          currentStep = "quote_save";
          const tQuoteStart = Date.now();
          const managedQuote = await createAndSaveManagedQuote(this.tables, {
            conversationId,
            userId,
            plan: {
              summaryAr: planOutput.summaryAr,
              items: planItems,
              outputFormats: (planOutput.outputFormats as any) || ["xlsx", "pdf", "csv"],
              methodologyNotes: planOutput.methodologyNotes,
            },
            userBalance: userBalance ?? 0,
            capabilities: validationCaps,
          });
          tQuoteMs = Date.now() - tQuoteStart;
          quoteMs = tQuoteMs;

          planQuoteData = {
            quoteId: managedQuote.quoteId,
            planHash: managedQuote.planHash,
            summaryAr: managedQuote.summaryAr,
            items: managedQuote.items,
            targetVolumeMax: managedQuote.targetVolumeMax,
            unitPricePoints: managedQuote.unitPricePoints,
            quotedPoints: managedQuote.quotedPoints,
            isAffordable: managedQuote.isAffordable,
            userBalance,
            downscaledOffer: managedQuote.downscaledOffer,
            capacityConstrained: managedQuote.capacityConstrained,
            outputFormats: managedQuote.outputFormats,
            expiresAt: managedQuote.expiresAt,
            methodologyNotes: planOutput.methodologyNotes,
          };

          let planSummaryText = `أعددت لك خطة الاستخراج وعرض السعر بالنقاط:\n- الهدف: ${planOutput.summaryAr}\n- الحد الأقصى: حتى ${managedQuote.targetVolumeMax} سجل\n- التكلفة: ${managedQuote.quotedPoints} نقطة`;
          if (brief.exclusionFile) {
            planSummaryText += `\n- ملف الاستبعاد المعتمد: تم التحقق من "${brief.exclusionFile.name}" واستبعاد ${brief.exclusionFile.baselineRowCount} شركة مسجلة مسبقاً لمنع تكرارها.`;
          }
          if (managedQuote.capacityConstrained) {
            planSummaryText += `\n- تنبيه السعة: تم ضبط الحد الأقصى عند ${managedQuote.targetVolumeMax} سجل لضمان دقة وسرعة التنفيذ المباشر.`;
          }
          if (!managedQuote.isAffordable) {
            planSummaryText += `\n- تنبيه: رصيدك الحالي (${userBalance} نقطة) لا يكفي لتغطية كامل العرض.`;
            if (managedQuote.downscaledOffer) {
              planSummaryText += `\n- اقتراح مخفض: يمكننا جمع حتى ${managedQuote.downscaledOffer.maxAffordableUnits} سجل مقابل ${managedQuote.downscaledOffer.affordableQuotedPoints} نقطة تناسب رصيدك الحالي.`;
            }
          }
          finalContentAr = (llmResult.textBlockAr && llmResult.textBlockAr.trim().length > 0 && !planSummaryText.includes(llmResult.textBlockAr))
            ? `${llmResult.textBlockAr}\n\n${planSummaryText}`
            : planSummaryText;
        }
      } else if (output.type === "edit_plan") {
        let activeQuote: any = null;
        try {
          if (sb) {
            const { data: q } = await sb
              .from("plans_quotes")
              .select("*")
              .eq("user_id", userId)
              .eq("status", "quoted")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (q) {
              activeQuote = {
                ...q,
                summaryAr: q.summary_ar || "خطة استخراج بيانات",
                itemsJson: q.items,
              };
            }
          } else {
            const quoteRes = await this.tables.listRows({
              databaseId: "digr",
              tableId: "plans_quotes",
              queries: [
                Query.equal("conversationId", conversationId),
                Query.equal("status", "proposed"),
                Query.orderDesc("createdAt"),
                Query.limit(1),
              ],
            });
            if (quoteRes.rows.length > 0) {
              activeQuote = quoteRes.rows[0];
            }
          }
        } catch (err) {
          console.warn("Error finding active quote for edit:", err);
        }

        if (!activeQuote) {
          finalContentAr = "لا توجد خطة معلقة حالياً لتعديلها. يرجى وصف بيانات الاستخراج المطلوبة لنعد لك خطة جديدة.";
        } else {
          try {
            const currentItems = typeof activeQuote.itemsJson === "string"
              ? JSON.parse(activeQuote.itemsJson)
              : activeQuote.itemsJson;

            const currentPlan: PlanState = {
              summaryAr: activeQuote.summaryAr,
              items: currentItems,
              outputFormats: ["xlsx", "pdf", "csv"],
            };

            const updatedPlan = applyPlanOperations(currentPlan, output.operations);
            const validation = validatePlanAgainstSchemas(updatedPlan.items, capabilities);
            if (!validation.valid) {
              finalContentAr = `تعذر تطبيق التعديل المطلوب: ${validation.errors.join(", ")}`;
            } else {
              currentStep = "quote_save";
              const managedQuote = await createAndSaveManagedQuote(this.tables, {
                conversationId,
                userId,
                plan: updatedPlan,
                userBalance: userBalance ?? 0,
                capabilities: allCapabilities,
              });

              planQuoteData = {
                quoteId: managedQuote.quoteId,
                planHash: managedQuote.planHash,
                summaryAr: managedQuote.summaryAr,
                items: managedQuote.items,
                targetVolumeMax: managedQuote.targetVolumeMax,
                unitPricePoints: managedQuote.unitPricePoints,
                quotedPoints: managedQuote.quotedPoints,
                isAffordable: managedQuote.isAffordable,
                userBalance,
                downscaledOffer: managedQuote.downscaledOffer,
                capacityConstrained: managedQuote.capacityConstrained,
                outputFormats: managedQuote.outputFormats,
                expiresAt: managedQuote.expiresAt,
              };

              finalContentAr = `تم تعديل الخطة وتحديث عرض السعر بالنقاط:\n• الهدف: ${managedQuote.summaryAr}\n• الحد الأقصى: حتى ${managedQuote.targetVolumeMax} سجل\n• التكلفة المحدثة: ${managedQuote.quotedPoints} نقطة`;
              if (managedQuote.capacityConstrained) {
                finalContentAr += `\n• تنبيه السعة: تم ضبط الحد الأقصى عند ${managedQuote.targetVolumeMax} سجل لضمان دقة وسرعة التنفيذ المباشر.`;
              }
              if (!managedQuote.isAffordable) {
                finalContentAr += `\n• تنبيه: رصيدك الحالي (${userBalance} نقطة) لا يكفي لتغطية كامل العرض المحدث.`;
                if (managedQuote.downscaledOffer) {
                  finalContentAr += `\n• اقتراح مخفض: يمكننا جمع حتى ${managedQuote.downscaledOffer.maxAffordableUnits} سجل مقابل ${managedQuote.downscaledOffer.affordableQuotedPoints} نقطة تناسب رصيدك الحالي.`;
                }
              }
            }
          } catch (editErr: any) {
            finalContentAr = `تعذر تطبيق التعديل: ${editErr.message || "خطأ في مدخلات التعديل"}`;
          }
        }
      } else if (output.type === "suggest_alternative") {
        // Ensure we never name a different platform than the one the user asked for
        const mentioned = detectMentionedPlatforms(message);
        if (mentioned.length > 0) {
          const expectedLabel = getPlatformLabelAr(mentioned[0]);
          const mentionedOutputPlatforms = detectMentionedPlatforms(output.unsupportedService);
          if (mentionedOutputPlatforms.length > 0 && !mentionedOutputPlatforms.includes(mentioned[0])) {
            output.unsupportedService = expectedLabel;
          }
        }
        const closest = getClosestVerifiedCapability(capabilities);
        console.warn("[chat:suggest_alternative]", {
          unsupportedService: output.unsupportedService,
          explanationAr: output.explanationAr,
        });
        finalContentAr = `${UNVERIFIED_PLATFORM_MESSAGE_AR}. أقرب خدمة متاحة: ${closest.nameAr}.`;

        // Log request in capability_requests table
        if (sb) {
          await sb.from("capability_requests").insert({
            id: ID.unique(),
            user_id: userId,
            query: `${output.unsupportedService || ""}: ${message}`,
            created_at: new Date().toISOString(),
          });
        } else {
          await this.tables.createRow({
            databaseId: "digr",
            tableId: "capability_requests",
            rowId: ID.unique(),
            data: {
              userId,
              queryAr: message,
              platform: output.unsupportedService,
              createdAt: new Date().toISOString(),
            },
          });
        }
      } else if (output.type === "refuse") {
        finalContentAr = output.reasonAr;
      } else if (output.type === "edit_artifact") {
        let latestJobId: string | null = null;
        try {
          if (sb) {
            const { data: jobDoc } = await sb
              .from("jobs")
              .select("id, status")
              .eq("conversation_id", conversationId)
              .eq("user_id", userId)
              .in("status", ["done", "completed"])
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            latestJobId = jobDoc?.id || null;
          }
        } catch {}

        let operation: any = { action: "convert_formats", formats: ["xlsx", "pdf", "csv"] };
        const actionType = (output as any).action;
        const params = (output as any).parameters || {};
        if (actionType === "dedupe") {
          operation = { action: "dedupe", keys: Array.isArray(params.keys) ? params.keys : ["id", "username", "profileUrl"] };
        } else if (actionType === "sort") {
          operation = { action: "sort", field: params.field || "followers", direction: params.direction || "desc" };
        } else if (actionType === "select_columns") {
          operation = { action: "select_columns", columns: Array.isArray(params.columns) ? params.columns : ["username", "displayName", "followers", "likes"] };
        } else if (actionType === "filter") {
          operation = { action: "filter", field: params.field || "username", operator: params.operator || "contains", value: params.value ?? "" };
        } else if (actionType === "anonymize") {
          operation = { action: "anonymize", fields: Array.isArray(params.fields) ? params.fields : ["username", "displayName", "bio", "bioLink", "profileUrl"] };
        }

        const revisionDesc = (output as any).reasonAr || "تعديل تنسيق وإخراج ملفات النتائج";
        revisionQuoteData = {
          jobId: latestJobId || "current",
          revisionDescription: revisionDesc,
          operation,
          points: 10,
        };
        finalContentAr = `أعددت لك عرض تعديل المخرجات بدون إعادة جمع البيانات:\n• التعديل المطلوب: ${revisionDesc}\n• التكلفة: 10 نقاط\n• سيتم حفظ التعديل كنسخة جديدة مع الاحتفاظ بالنسخ السابقة.`;
      }

      // Post-job artifact revision detector: if user requests deliverable formatting fix on existing completed job
      if (!revisionQuoteData && output.type !== "propose_plan" && output.type !== "edit_plan") {
        const mLower = message.toLowerCase();
        const isRtlFix = mLower.includes("rtl") || mLower.includes("يمين") || mLower.includes("يسار") || mLower.includes("اتجاه الشيت");
        const isDedupe = mLower.includes("احذف التكرار") || mLower.includes("حذف التكرار") || mLower.includes("إزالة التكرار");
        const isSort = mLower.includes("رتب") || mLower.includes("ترتيب");
        const isAnonymize = mLower.includes("اخفي") || mLower.includes("إخفاء الهوية");
        const isColumns = mLower.includes("أعمدة") || mLower.includes("اعمدة");

        if (isRtlFix || isDedupe || isSort || isAnonymize || isColumns) {
          let completedJobId: string | null = null;
          try {
            if (sb) {
              const { data: jobDoc } = await sb
                .from("jobs")
                .select("id, status")
                .eq("conversation_id", conversationId)
                .eq("user_id", userId)
                .in("status", ["done", "completed"])
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              completedJobId = jobDoc?.id || null;
            }
          } catch {}

          if (completedJobId) {
            let op: any = { action: "convert_formats", formats: ["xlsx", "pdf", "csv"] };
            let desc = "إعادة ضبط اتجاه وتنسيق الجداول (RTL) والأعمدة القياسية";
            if (isDedupe) {
              op = { action: "dedupe", keys: ["id", "username", "profileUrl"] };
              desc = "حذف السجلات المكررة والاحتفاظ بالسجلات الفريدة فقط";
            } else if (isSort) {
              op = { action: "sort", field: "followers", direction: "desc" };
              desc = "إعادة ترتيب السجلات تنازلياً";
            } else if (isAnonymize) {
              op = { action: "anonymize", fields: ["username", "displayName", "bio", "bioLink", "profileUrl"] };
              desc = "إخفاء أسماء ومعرفات المستخدمين لحماية الخصوصية";
            } else if (isColumns) {
              op = { action: "select_columns", columns: ["username", "displayName", "followers", "likes"] };
              desc = "تحديد واختيار الأعمدة الأساسية فقط";
            }

            revisionQuoteData = {
              jobId: completedJobId,
              revisionDescription: desc,
              operation: op,
              points: 10,
            };
            output = { type: "edit_artifact", reasonAr: desc } as any;
            finalContentAr = `أعددت لك عرض تعديل المخرجات بدون إعادة جمع البيانات:\n- التعديل المطلوب: ${desc}\n- التكلفة: 10 نقاط\n- سيتم حفظ التعديل كنسخة جديدة مع الاحتفاظ بالنسخ السابقة.`;
          }
        }
      }

      // 9. Update Assistant Message to 'ready'
      currentStep = "assistant_message_save";
      finalContentAr = deduplicateIntroText(finalContentAr);
      const tSbMsgUpdateStart = Date.now();
      if (sb) {
        const { error: msgUpdateErr } = await sb
          .from("messages")
          .update({
            content_ar: finalContentAr,
            clarification_items: clarificationItemsList ?? null,
            plan: planQuoteData ? { items: planQuoteData.items, summaryAr: planQuoteData.summaryAr } : null,
            quote: planQuoteData ?? null,
          })
          .eq("id", assistantMsgId);
        if (msgUpdateErr) throw msgUpdateErr;
      } else {
        await this.tables.updateRow({
          databaseId: "digr",
          tableId: "messages",
          rowId: assistantMsgId,
          data: {
            content: finalContentAr,
            status: "ready",
            promptVersion: llmResult.promptVersion || "2.0.0",
            ...(planQuoteData ? { planQuoteId: planQuoteData.quoteId } : {}),
          },
        });
      }
      supabaseMs += Date.now() - tSbMsgUpdateStart;

      // 10. Record Token Usage & Stats in llm_usage (Server-only).
      // Logging must never block the reply: failures are swallowed.
      currentStep = "usage_log";
      const tSbLogStart = Date.now();
      try {
        if (sb) {
          await sb.from("llm_usage").insert({
            user_id: userId,
            tokens_in: llmResult.inputTokens || 0,
            tokens_out: llmResult.outputTokens || 0,
            model: llmResult.model,
            latency_ms: Math.max(0, Date.now() - tLlmStart),
            reason: output.type,
            cost_usd: Number((llmResult.costUsd || 0).toFixed(6)),
            created_at: new Date().toISOString(),
          });
        } else {
          await this.tables.createRow({
            databaseId: "digr",
            tableId: "llm_usage",
            rowId: ID.unique(),
            data: {
              conversationId,
              userId,
              messageId: assistantMsgId,
              model: llmResult.model,
              inputTokens: llmResult.inputTokens,
              outputTokens: llmResult.outputTokens,
              costUsd: Number(llmResult.costUsd.toFixed(6)),
              createdAt: new Date().toISOString(),
            },
          });
        }
      } catch (usageErr) {
        console.warn("[llm:USAGE_LOG_FAILED]", (usageErr as any)?.message || usageErr);
      }
      await logProviderCost(this.tables, {
        provider: "llm",
        units: (llmResult.inputTokens || 0) + (llmResult.outputTokens || 0),
        costUsd: llmResult.costUsd || 0,
      });

      // 11. Update Conversation Stats
      currentStep = "conversation_update";
      const newTotalTokens = totalConvTokens + llmResult.inputTokens + llmResult.outputTokens;
      if (sb) {
        const { error: convUpdateErr } = await sb
          .from("conversations")
          .update({
            updated_at: new Date().toISOString(),
          })
          .eq("id", conversationId);
        if (convUpdateErr) throw convUpdateErr;
      } else {
        await this.tables.updateRow({
          databaseId: "digr",
          tableId: "conversations",
          rowId: conversationId,
          data: {
            totalTokens: newTotalTokens,
            costUsd: Number(llmResult.costUsd.toFixed(6)),
            updatedAt: new Date().toISOString(),
          },
        });
      }
      supabaseMs += Date.now() - tSbLogStart;

      const totalLatencyMs = Date.now() - turnStartTime;
      console.log("[chat:turn_breakdown]", {
        supabaseMs,
        catalogMs,
        llmMs,
        quoteMs,
        totalMs: totalLatencyMs,
      });
      console.log(
        `[chat:turn] conversationId=${conversationId} messageId=${assistantMsgId} modelCalls=${modelCallCount} catalogSearches=${catalogSearchCount} latencyMs=${totalLatencyMs}`,
      );
      console.log("[chat:step_timings]", {
        supabaseMs,
        catalogMs,
        llmMs,
        quoteMs,
        tExtractMs,
        tCatalogSearchMs: catalogMs,
        tPlanLlmMs: llmMs,
        tQuoteMs: quoteMs,
        totalMs: totalLatencyMs,
      });

      const computedIntent: "chat" | "research" =
        (output as any).intent ||
        (isGreeting || isGeneralQuestion
          ? "chat"
          : output.type === "propose_plan" ||
            output.type === "ask_clarification" ||
            output.type === "ask_questions" ||
            output.type === "edit_plan"
          ? "research"
          : output.type === "answer_question"
          ? "chat"
          : "research");

      if (computedIntent === "chat") {
        planQuoteData = undefined;
        clarificationQuestionsList = undefined;
        clarificationItemsList = undefined;
      }

      return {
        conversationId,
        messageId: assistantMsgId,
        role: "assistant",
        contentAr: finalContentAr,
        outputType: computedIntent === "chat" ? "answer_question" : output.type,
        intent: computedIntent,
        planQuote: planQuoteData,
        revisionQuote: revisionQuoteData,
        clarificationQuestions: clarificationQuestionsList,
        clarificationItems: clarificationItemsList,
        suggestedAlternative: output.type === "suggest_alternative" ? output : undefined,
        refusalReason: output.type === "refuse" ? output.reasonAr : undefined,
        tokensUsed: {
          input: llmResult.inputTokens,
          output: llmResult.outputTokens,
          costUsd: llmResult.costUsd,
        },
        turnStats: {
          modelCalls: modelCallCount,
          catalogSearches: catalogSearchCount,
          latencyMs: totalLatencyMs,
          stepTimings: {
            supabaseMs,
            catalogMs,
            llmMs,
            quoteMs,
            totalMs: totalLatencyMs,
            tExtractMs,
            tCatalogSearchMs: catalogMs,
            tPlanLlmMs: llmMs,
            tQuoteMs: quoteMs,
          },
        },
      };
    } catch (err: any) {
      if (err && typeof err === "object" && !err.chatStep) {
        err.chatStep = currentStep;
      }
      throw err;
    }
  }
}

