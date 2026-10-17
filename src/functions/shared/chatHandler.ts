import { logProviderCost } from "./providerCosts";
import { ID, Query, TablesDB } from "./dbCompat";
import { LlmClient, LlmTurnOutput } from "./llmClient";
import {
  getEnabledCapabilitiesWithCoreServices,
  getCatalogCapabilities,
  sanitizeCapabilitiesForLlm,
  validateCapabilityParams,
  validatePlanPlatformMatch,
  detectMentionedPlatforms,
  getPlatformLabelAr,
  getClosestVerifiedCapability,
  getCustomerPriceUsdPerCatalogItem,
  computeRegistryPointsPerUnit,
  UNVERIFIED_PLATFORM_MESSAGE_AR,
  RAW_SEED_CAPABILITIES,
  APPROVED_CAPABILITY_CATALOG,
  Capability,
  resolveCapabilityReference,
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
  PlanItem,
  PlanState,
} from "./planManager";
import { getBalance } from "./ledger";
import { normalizePersonaProfileFields } from "./personaConfigs";
import {
  discoveryQuestionPriority,
  normalizeClarificationQuestions,
  sanitizeClarificationText,
  formatClarificationMessageForAssistant,
  type NormalizedClarificationQuestion,
  INTERNAL_DISCOVERY_KEYS,
} from "./clarification";
import { searchCatalog, getCachedCatalogEndpoints, sanitizeCustomerErrorMessage, CatalogEndpointSummary } from "./catalogClient";
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
  extractTargetVolume,
  type ResearchBrief,
} from "./briefManager";
import { extractResearchIntent, extractEntityType } from "../../lib/server/researchIntent";
import { evaluateDiscoveryDecision } from "../../lib/server/questionDecisionFramework";
import { PEOPLE_ROLE_PATTERN, detectCountryFromText, detectIndustryFromText, getCompanyRequirementItems, getMissingCompanyResearchRequirements, industryDisplayLabelAr, isPeopleSearchRequest, isoCountryCodeFromName, requiredProfessionalContactFields, socialSearchQueryFromTitle } from "../../lib/planParameters";
import { customerFacingConversationTitle } from "../../lib/customerFacingConversationTitle";
import { dedupeRecordSearchItems } from "../../lib/recordSearchPlanItems";
import { resolveRequestAttemptStatus } from "../../lib/requestAttempt";
import { extractNumberFromText } from "../../lib/arabicNumbers";
import { isRetrySamePlanMessage } from "../../lib/retryMessage";
import { toArabicDigits } from "../../lib/arabicDigits";
import { NAME_PROMPT_AR } from "../../lib/customerName";
import { CONTACT_BILLING_NOTE_AR, CONTACT_EXPECTATION_AR } from "../../lib/contactExpectation";
import { findRetryableJob, loadQuoteFirstItem, planParamsSignature, readReusableRows } from "../../lib/server/retryReuse";
import { ACCOUNT_HANDLE_RE, ACCOUNT_LOOKUP_RE, SOCIAL_CONTENT_WORDS_RE, getMissingSocialInputs } from "../../lib/socialDiscovery";
import { SOCIAL_TASK_PLATFORMS, detectSocialIntent, getMissingSocialTaskInputs, socialTaskQuestion } from "../../lib/socialTasks";
import { canonicalSocialParams, socialCapabilityForIntent, socialPlanSummaryAr } from "../../lib/socialSources";

function customerAuthoredRequirementText(message: string): string {
  const trimmed = (message || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.includes("clarification_answers")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.type !== "clarification_answers" || !Array.isArray(parsed.answers)) return trimmed;
    const labels: Record<string, string> = {
      company_country_required: "الدولة المطلوبة",
      company_industry_required: "المجال المطلوب",
      company_count_required: "عدد الشركات المطلوب",
      people_country_required: "دولة صناع القرار المطلوبة",
      people_scope_required: "نطاق صناع القرار",
      people_roles_required: "المسميات الوظيفية المطلوبة",
      people_count_required: "عدد صناع القرار المطلوب",
      social_account_required: "اسم الحساب المطلوب",
      social_topic_required: "موضوع البحث المطلوب",
      social_platform_required: "منصة البحث المطلوبة",
      social_time_required: "الفترة المطلوبة",
    };
    return parsed.answers
      .flatMap((answer: any) => {
        const label = labels[answer?.questionId] || "الإجابة";
        if (typeof answer?.value === "string") return [`${label}: ${sanitizeClarificationText(answer.value, 200)}`];
        if (Array.isArray(answer?.value)) {
          return answer.value
            .filter((value: unknown): value is string => typeof value === "string")
            .map((value: string) => `${label}: ${sanitizeClarificationText(value, 40)}`);
        }
        return [];
      })
      .filter(Boolean)
      .join(" ");
  } catch {
    return trimmed;
  }
}

function explicitCompanyClarificationNotes(notes?: string): string[] {
  const labels = ["الدولة المطلوبة:", "المجال المطلوب:", "إجابة هدف التواصل:"];
  return (notes || "")
    .split(/\s*\|\s*/)
    .map((part) => part.trim())
    .filter((part) => labels.some((label) => part.startsWith(label)))
    .map((part) => part.slice(part.indexOf(":") + 1).trim())
    .filter(Boolean);
}

export function getDeterministicDiscoveryQuestion(text: string, brief: ResearchBrief): any | null {
  const normalized = text || "";
  const isAccount = ACCOUNT_LOOKUP_RE.test(normalized);
  const isPeople = isPeopleSearchRequest(normalized);
  const isCompanies = !isPeople && (/(?:\bcompanies?\b|\bbusinesses\b|شركة|شركات|مؤسسة|مؤسسات|مصنع|مصانع)/iu.test(normalized));
  const isSocialTopic = !isAccount && !isPeople && !isCompanies && SOCIAL_CONTENT_WORDS_RE.test(normalized);
  const accountHandle = ACCOUNT_HANDLE_RE.exec(normalized)?.[1];

  if (isAccount && !accountHandle) {
    return { id: "social_account_required", text: "ما اسم الحساب أو رابطه على المنصة؟", question: "ما اسم الحساب أو رابطه على المنصة؟", type: "free", options: [], allowOther: true };
  }
  if (isPeople) {
    if (!detectCountryFromText(normalized)) return { id: "people_country_required", text: "في أي دولة تريد البحث عن صناع القرار؟", question: "في أي دولة تريد البحث عن صناع القرار؟", type: "single", options: ["مصر", "السعودية", "الإمارات", "أخرى"], allowOther: true };
    const scopeMissing = getMissingCompanyResearchRequirements(normalized).includes("industry") && !/(?:نطاق صناع القرار\s*:|لدى|في شركة|شركة محددة|اسم الشركة|اسم الشركات)\s*\p{L}/iu.test(normalized);
    if (scopeMissing) return { id: "people_scope_required", text: "ما المجال أو الشركة التي تريد صناع القرار منها؟", question: "ما المجال أو الشركة التي تريد صناع القرار منها؟", type: "free", options: [], allowOther: true };
    if (!PEOPLE_ROLE_PATTERN.test(normalized)) return { id: "people_roles_required", text: "ما المسميات الوظيفية التي تريدها؟", question: "ما المسميات الوظيفية التي تريدها؟", type: "free", options: [], allowOther: true };
    if (!extractNumberFromText(normalized)) return { id: "people_count_required", text: "كم صانع قرار تريد؟", question: "كم صانع قرار تريد؟", type: "free", options: [], allowOther: true };
  }
  if (isCompanies) {
    const missing = getMissingCompanyResearchRequirements(normalized);
    if (missing.length) return getCompanyRequirementItems(missing, normalized)[0] || null;
    if (!extractNumberFromText(normalized)) return { id: "company_count_required", text: "كم شركة تريد في النتائج؟", question: "كم شركة تريد في النتائج؟", type: "free", options: [], allowOther: true };
  }
  if (!isAccount && !isPeople && !isCompanies) {
    const socialTaskIntent = detectSocialIntent(normalized);
    const missingSocialTask = getMissingSocialTaskInputs(normalized)[0];
    if (missingSocialTask) return socialTaskQuestion(missingSocialTask);
    // A request the verified social services understand is decided entirely by their own inputs (a link, a
    // channel, a country); the generic topic question below does not apply to it.
    if (socialTaskIntent.task && socialTaskIntent.platform && SOCIAL_TASK_PLATFORMS[socialTaskIntent.task].includes(socialTaskIntent.platform)) return null;
  }
  if (isSocialTopic) {
    const missingSocial = getMissingSocialInputs(normalized);
    if (missingSocial.includes("social_topic_required")) return { id: "social_topic_required", text: "ما الموضوع أو الكلمات التي تريد البحث عنها؟", question: "ما الموضوع أو الكلمات التي تريد البحث عنها؟", type: "free", options: [], allowOther: true };
    if (missingSocial.includes("social_platform_required")) return { id: "social_platform_required", text: "على أي منصة تريد البحث؟", question: "على أي منصة تريد البحث؟", type: "single", options: ["تيك توك", "يوتيوب", "إنستغرام", "أخرى"], allowOther: true };
  }
  return null;
}

export interface ChatHandlerInput {
  userId: string;
  conversationId?: string;
  message: string;
  answers?: any;
  userBalance?: number;
  testScenario?: string;
  uploadedFiles?: any[];
  isGuest?: boolean;
  /** Set by the route when this message only gave the customer's name (already stored); answered without a model turn. */
  capturedName?: string;
  personaProfile?: { persona?: unknown; purposes?: unknown; topic?: unknown; name?: unknown; full_name?: unknown };
}

export interface ChatHandlerResponse {
  conversationId: string;
  conversationTitle?: string;
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

/** Turn stats for replies that finish before any model call or catalog search (greeting, required-input question). */
function zeroModelTurnStats(conversationId: string, messageId: string, turnStartTime: number): NonNullable<ChatHandlerResponse["turnStats"]> {
  const latencyMs = Date.now() - turnStartTime;
  console.log(`[chat:turn] conversationId=${conversationId} messageId=${messageId} modelCalls=0 catalogSearches=0 latencyMs=${latencyMs}`);
  return {
    modelCalls: 0,
    catalogSearches: 0,
    latencyMs,
    stepTimings: { totalMs: latencyMs, tExtractMs: 0, tCatalogSearchMs: 0, tPlanLlmMs: 0, tQuoteMs: 0 },
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
  const requestText = [message, ...(brief.topics || []), ...(brief.keywords || []), brief.notes || ""]
    .filter(Boolean)
    .join(" ");
  const peopleSearch = isPeopleSearchRequest(requestText);
  const isAccountProfileRequest = ACCOUNT_LOOKUP_RE.test(requestText);
  const explicitHandle = /(?:@|tiktok\.com\/@|اسم الحساب المطلوب\s*:\s*@?)([a-zA-Z0-9_.]{2,30})/i.exec(requestText)?.[1];
  const mentionedPlats = detectMentionedPlatforms(message);
  const platform = peopleSearch
    ? "people"
    : (brief.platforms && brief.platforms.length > 0)
    ? brief.platforms[0]
    : (mentionedPlats.length > 0 ? mentionedPlats[0] : (brief.topics?.[0]?.includes("شرك") ? "companies" : "tiktok"));
  const platformNorm = platform.toLowerCase();

  // Find matching capability in validationCaps
  let matchedCap = isAccountProfileRequest
    ? validationCaps.find((c) => /profile|user/i.test(c.slug) && (!mentionedPlats.length || mentionedPlats.some((p) => c.slug.includes(p))))
    : validationCaps.find((c) => {
    const cPlat = (c.platform || c.category || "").toLowerCase();
    const cSlug = (c.slug || "").toLowerCase();
    const cId = (c.tregEndpointId || c.id || "").toLowerCase();
    if (peopleSearch) {
      return cPlat === "people" || cSlug.includes("people") || cId.includes("people");
    }
    if (platformNorm === "companies" || platformNorm === "b2b") {
      return cPlat === "companies" || cPlat === "b2b" || cSlug.includes("companies") || cId.includes("companies");
    }
    return cPlat === platformNorm || cSlug.includes(platformNorm);
    });

  if (!matchedCap) {
    matchedCap = getClosestVerifiedCapability(validationCaps);
  }

  const msgVolume = extractTargetVolume(message);
  const volume = isAccountProfileRequest
    ? 1
    : (brief.targetVolume && brief.targetVolume > 0)
    ? brief.targetVolume
    : (msgVolume && msgVolume > 0
      ? msgVolume
      : (brief.postCount && brief.commentsPerPost ? brief.postCount * brief.commentsPerPost : 10));

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

  const topicLabel = isAccountProfileRequest && explicitHandle
    ? `@${explicitHandle}`
    :
    extractedCurrentTopic ||
    (cleanTopics.length > 0 ? cleanTopics[cleanTopics.length - 1] : "البيانات المطلوبة");

  const isCompanySearch =
    platformNorm === "companies" ||
    platformNorm === "b2b" ||
    matchedCap.slug.includes("companies") ||
    Boolean(matchedCap.tregEndpointId && matchedCap.tregEndpointId.includes("companies"));

  const isPeopleCapability = peopleSearch || /people/i.test(`${matchedCap.slug} ${matchedCap.tregEndpointId || ""}`);
  const platformLabel = isPeopleCapability
    ? "صناع القرار والمهنيون"
    : isCompanySearch
      ? "قواعد بيانات الشركات"
      : getPlatformLabelAr(platformNorm);

  const isProfileCapability =
    (matchedCap.pricingUnit as string) === "profile" ||
    matchedCap.slug.includes("profile") ||
    matchedCap.slug.includes("user");

  const isExplicitHandle =
    typeof topicLabel === "string" &&
    (topicLabel.startsWith("@") || (!topicLabel.includes(" ") && !topicLabel.includes("،") && /^[a-zA-Z0-9_.-]+$/.test(topicLabel)));

  const detectedCountry = detectCountryFromText(requestText);
  const detectedIndustry = detectIndustryFromText(requestText);

  const countryNameAr = detectedCountry?.arabicLabel;
  const hasDetectedIndustry = detectedIndustry.arabicLabel !== "قواعد بيانات الشركات" &&
    detectedIndustry.englishKeywords.some((keyword) => keyword !== "contracting");
  const companyQuery: Record<string, any> = {
    ...(hasDetectedIndustry ? { keyword: { include: detectedIndustry.englishKeywords } } : {}),
    ...(detectedCountry ? { location: { include: [detectedCountry.canonicalEnglish] } } : {}),
  };
  const titleMatch = requestText.match(/\b(ceos?|ctos?|cfos?|coos?|founders?|owners?|directors?|managers?|heads?|vps?|presidents?)\b|الرئيس التنفيذي|مدير(?:ين)?|مؤسس(?:ين)?|رئيس مجلس الإدارة/i);
  const countryCode = detectedCountry ? isoCountryCodeFromName(detectedCountry.canonicalEnglish) : undefined;
  const stepParams: Record<string, any> = isPeopleCapability
    ? {
        q: requestText.slice(0, 300),
        limit: Math.min(volume, 50),
        ...(countryCode ? { country: countryCode } : {}),
        ...(titleMatch ? { title: (titleMatch[1] || titleMatch[0]).replace(/s$/i, "") } : {}),
        ...(hasDetectedIndustry ? { keywords: detectedIndustry.englishKeywords } : {}),
        ...(requiredProfessionalContactFields(requestText).length ? { requiredContactFields: requiredProfessionalContactFields(requestText) } : {}),
        contactFieldsToAttempt: ["work_email", "phone"],
      }
    : isCompanySearch
      ? {
        query: companyQuery,
        search: [hasDetectedIndustry ? detectedIndustry.arabicLabel : "الشركات", countryNameAr]
          .filter(Boolean)
          .join(" في "),
        ...(detectedCountry ? { country: detectedCountry.canonicalEnglish, location: detectedCountry.canonicalEnglish } : {}),
        ...(hasDetectedIndustry ? { industry: detectedIndustry.arabicLabel } : {}),
        pagination: { size: Math.min(volume, 100) },
        }
      : {
          query: topicLabel,
        };

  if (isProfileCapability || isExplicitHandle) {
    stepParams.username = topicLabel.replace(/^@/, "").trim();
  }

  const dateRangeHint = brief.dateRange || message;
  if (dateRangeHint && !isCompanySearch && !isProfileCapability) {
    const dateFilters = dateFiltersFromHint(dateRangeHint);
    if (dateFilters.from) stepParams.dateFrom = dateFilters.from;
    if (dateFilters.to) stepParams.dateTo = dateFilters.to;
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

  const summaryAr = isPeopleCapability
    ? `بحث ${toArabicDigits(volume)} من صناع القرار والمهنيين${countryNameAr ? ` في ${countryNameAr}` : ""}`
    : isAccountProfileRequest
      ? `بيانات الحساب العام ${topicLabel} على ${platformLabel}`
      : isCompanySearch
      ? `استخراج بيانات ${toArabicDigits(volume)} سجل من شركات ${industryDisplayLabelAr(detectedIndustry.arabicLabel)} في ${countryNameAr}`
      : `جمع واستخراج ${toArabicDigits(volume)} سجل حول ${topicLabel} من ${platformLabel}`;

  return {
    type: "propose_plan",
    summaryAr,
    capabilities: [step],
    outputFormats: brief.formats && brief.formats.length > 0 ? brief.formats : ["xlsx"],
    methodologyNotes: isPeopleCapability
      ? "البحث عن صناع القرار والمهنيين بحسب المجال والدولة والمسمى الوظيفي؛ وجود أي حقل لا يعني التحقق المستقل من صحته."
      : `جمع وتوثيق البيانات من المصادر المتاحة عبر ${platformLabel} وفق نطاق البحث المحدد.`,
  };
}

export function dateFiltersFromHint(hint: string, now = new Date()): { from?: string; to?: string } {
  const dates = hint.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  if (dates.length >= 2) return { from: dates[0], to: dates[1] };
  if (dates.length === 1) return { from: dates[0], to: dates[0] };
  const year = /\b((?:19|20)\d{2})\b/.exec(hint)?.[1];
  if (year) return { from: `${year}-01-01`, to: `${year}-12-31` };
  const relative = /(?:آخر|اخر|خلال)\s*(\d+|[٠-٩]+)?\s*(شهر|شهور|أشهر|سنة|سنوات|عام|أعوام|أسبوع|أسابيع|يوم|أيام)/i.exec(hint);
  if (!relative) return {};
  const count = Number((relative[1] || "1").replace(/[٠-٩]/g, (digit) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(digit)])) || 1;
  const from = new Date(now);
  if (/شهر/i.test(relative[2])) from.setMonth(from.getMonth() - count);
  else if (/سنة|عام/i.test(relative[2])) from.setFullYear(from.getFullYear() - count);
  else if (/أسبوع/i.test(relative[2])) from.setDate(from.getDate() - count * 7);
  else from.setDate(from.getDate() - count);
  return { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

/** Keep people-search requests on the people capability, even if the model
 * proposes a generic company plan or refuses while that capability is enabled. */
export function routePeopleAlternative(
  output: any,
  brief: ResearchBrief,
  capabilities: Capability[],
  requestText: string,
): any {
  if (!isPeopleSearchRequest(requestText)) return output;

  const peopleCapability = capabilities.find((capability) =>
    capability.enabled !== false && capability.status === "verified" &&
    /people/i.test(`${capability.platform || ""} ${capability.slug || ""} ${capability.tregEndpointId || capability.id || ""}`),
  ) || APPROVED_CAPABILITY_CATALOG.find((capability) => capability.slug === "professional-people-search");
  if (!peopleCapability) {
    return output;
  }
  const peopleCapabilities = capabilities.some((capability) => capability.slug === peopleCapability.slug)
    ? capabilities
    : [...capabilities, peopleCapability];

  // Respect a model clarification only while a required field is still
  // missing. Once the deterministic inputs are complete, do not let the model
  // insert another question or stall the plan.
  if (output?.type === "ask_clarification" || output?.type === "ask_questions") {
    return getDeterministicDiscoveryQuestion(requestText, brief)
      ? output
      : buildAutoPlanProposal(brief, peopleCapabilities, requestText);
  }

  const proposedPeopleCapability = output?.type === "propose_plan" &&
    Array.isArray(output.capabilities) &&
    output.capabilities.some((step: any) => /people/i.test(
      `${step?.capabilitySlug || ""} ${step?.endpointId || ""}`,
    ));
  if (proposedPeopleCapability) return output;

  if (![
    "suggest_alternative",
    "propose_plan",
    "refuse",
    "answer_question",
    "search_catalog",
  ].includes(output?.type)) return output;

  if (!detectCountryFromText(requestText)) {
    const question = "ما الدولة التي تريد البحث فيها عن صناع القرار والمهنيين؟";
    const intro = "قبل إعداد عرض السعر، أحتاج تحديد الدولة حتى لا أفترضها.";
    return {
      type: "ask_clarification",
      reasonAr: intro,
      intro,
      questions: [{ id: "people_country_required", question, type: "free", allowOther: true }],
      questionsAr: [question],
    };
  }

  return buildAutoPlanProposal(brief, peopleCapabilities, requestText);
}

/** Route explicit company-search intent to the verified company capability when
 * the model stalls or suggests an unrelated service. Never quote without scope.
 */
export function routeCompanySearchRequest(
  output: any,
  brief: ResearchBrief,
  capabilities: Capability[],
  requestText: string,
): any {
  if (isPeopleSearchRequest(requestText)) return output;
  const entity = extractEntityType(requestText);
  if (entity.entityType !== "companies") return output;

  const companyCapability = capabilities.find((capability) =>
    /companies|company/i.test(`${capability.platform || ""} ${capability.category || ""} ${capability.slug || ""} ${capability.tregEndpointId || capability.id || ""}`),
  ) || APPROVED_CAPABILITY_CATALOG.find((capability) => capability.slug === "icypeas-companies-search");
  if (!companyCapability) {
    return output;
  }
  const companyCapabilities = capabilities.some((capability) => capability.slug === companyCapability.slug)
    ? capabilities
    : [...capabilities, companyCapability];

  const missing = getMissingCompanyResearchRequirements(requestText);
  if (missing.length > 0) {
    const items = getCompanyRequirementItems(missing, requestText);
    const questions = items.map((item) => item.text);
    const intro = "قبل إعداد عرض السعر، أحتاج تحديد نطاق البحث وهدف التواصل حتى لا أخمّن تفاصيل قد تغيّر النتائج.";
    return {
      type: "ask_clarification",
      reasonAr: intro,
      intro,
      questions: items,
      questionsAr: questions,
    };
  }

  // Company requests need a single, priceable company-search capability. The
  // model may return a superficially relevant multi-step plan that later fails
  // validation or inflates the requested volume, so rebuild it deterministically.
  return buildAutoPlanProposal(brief, companyCapabilities, requestText);
}

export function routeUnavailablePlatformRequest(output: any, requestText: string): any {
  // TREG-backed capabilities are owner-confirmed and are not blocked by a
  // second local availability gate. Pricing and executable plans are still
  // validated against the server catalog below.
  return output;
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
  const customerPriceUsdPerItem = getCustomerPriceUsdPerCatalogItem({
    id: ep.id,
    slug: ep.slug,
    platform: ep.platform,
    nameEn: ep.nameEn,
    nameAr: ep.nameAr,
  });
  const seeded = RAW_SEED_CAPABILITIES.find((cap) => cap.slug === ep.slug);
  return {
    id: ep.slug,
    slug: ep.slug,
    platform: ep.platform as any,
    category: ep.platform as any,
    status: "verified",
    unit: (ep.billingUnit === "record" || ep.billingUnit === "row" || ep.billingUnit === "item" ? "item" : "page") as any,
    estimatedCostUsdPerUnit: ep.catalogPriceUsd,
    pointsPerUnit:
      customerPriceUsdPerItem !== undefined
        ? computeRegistryPointsPerUnit(customerPriceUsdPerItem)
        : ep.pointsPerUnit,
    maxItemsPerCall: ep.pagination.maxLimit || 100,
    estimatedSuccessRate: ep.observedSuccessRate,
    nameAr: ep.nameAr,
    nameEn: ep.nameEn,
    descriptionAr: ep.summaryAr,
    paramsSchema: JSON.stringify(ep.paramsSchema || {}),
    tregEndpointId: ep.id,
    tregMethod: ep.method,
    pricingUnit: (customerPriceUsdPerItem !== undefined ? "item" : ep.billingUnit === "call" ? "call" : ep.billingUnit === "page" ? "page" : "item") as any,
    unitCostUsd: ep.catalogPriceUsd,
    customerPriceUsdPerItem,
    maxRows: 5000,
    paginationType: ep.pagination.type === "page" ? "offset" : ep.pagination.type === "cursor" ? "cursor" : "none",
    enabled: true,
  };
}

/** A verified capability presented to the model in the same shape as a live catalog result. */
function capabilityAsCatalogEndpoint(cap: Capability): CatalogEndpointSummary {
  let schema: Record<string, any> = {};
  try {
    schema = typeof cap.paramsSchema === "string" ? JSON.parse(cap.paramsSchema) : (cap.paramsSchema as any) || {};
  } catch {
    schema = {};
  }
  return {
    id: cap.slug,
    slug: cap.slug,
    nameAr: cap.nameAr,
    nameEn: cap.nameEn,
    summaryAr: cap.descriptionAr,
    summaryEn: cap.nameEn,
    platform: String(cap.platform || cap.category),
    method: "POST",
    path: "",
    paramsSchema: schema,
    billingUnit: "item",
    catalogPriceUsd: cap.unitCostUsd,
    pointsPerUnit:
      typeof cap.customerPriceUsdPerItem === "number" && cap.customerPriceUsdPerItem > 0
        ? computeRegistryPointsPerUnit(cap.customerPriceUsdPerItem)
        : cap.pointsPerUnit ?? computeRegistryPointsPerUnit(cap.unitCostUsd),
    pagination: { type: "cursor", maxLimit: cap.maxRows },
    observedSuccessRate: cap.estimatedSuccessRate ?? 0.99,
    observedSamples: 1000,
    scope: "any_account",
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
  "في عن من على إلى الي و هاتلي هات عايز عاوز محتاج أسحب سحب جمع بيانات داتا آخر اخر شهور شهر شهورا سنة سنوات عام أعوام أسبوع أسابيع يوم أيام مصر فيسبوك تيك توك انستغرام إنستغرام يوتيوب تويتر ريديت لينكد reddit tiktok instagram facebook youtube x comments comment posts post بوست بوستات منشور منشورات تعليق تعليقات الـ ده دي تلك هذا هذه التي الذي بيتكلموا تتكلم ازيك ازيكوا ازيكم مرحبا مرحباً اهلا أهلا أهلاً هاي سلام سلامو عليكم السلام صباح مساء الخير hello hi hey welcome شكرا شكراً تمام ماشي فندم باشا يا حتى سجل سجلاً سجلات شركة شركات مؤسسة مؤسسات استخرج استخراج اريد أريد مجال تخصص نشاط فقط حجم عدد خمس خمسة ست ستة سبع سبعة ثمانية تمانية تسع تسعة عشر عشرة عشرين ثلاثين أربعين خمسين ستين سبعين ثمانين تسعين مية مائة ألف need want companies company records".split(
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
  if (m) return m[0].trim();
  const year = /(?:في|سنة|عام|خلال|منذ|since|during|in|year)\s+((?:19|20)\d{2})\b/i.exec(userMessage);
  return year?.[1];
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
    let userMsgId = "";

    try {
      // 1. Get or Create Conversation
      let conversationId = input.conversationId;
      let totalConvTokens = 0;
      const tSbConvStart = Date.now();
      let userBalance = input.userBalance;
      let userProfile: any = undefined;
      let convBriefFromDb: any = undefined;
      let assistantMsgId = "";

      const isGreetingMsg = isGreetingOrGeneralQuestion(message).isGreeting;
      const initialTitle = "محادثة جديدة";
      let currentConversationTitle = initialTitle;

      if (!conversationId) {
        conversationId = ID.unique();
        if (sb) {
          const { error: convCreateErr } = await sb.from("conversations").insert({
            id: conversationId,
            user_id: userId,
            title: initialTitle,
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
              title: initialTitle,
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
            .select("id, user_id, status, brief, title")
            .eq("id", conversationId)
            .maybeSingle();
          currentConversationTitle = conv?.title || initialTitle;

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
              title: initialTitle,
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
          currentConversationTitle = conv?.title || initialTitle;
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
      if (input.personaProfile) {
        const metadataPersona = input.personaProfile.persona;
        userProfile = {
          ...(userProfile || {}),
          ...normalizePersonaProfileFields({
            persona: typeof metadataPersona === "string" ? metadataPersona : undefined,
            purposes: input.personaProfile.purposes,
            topic: input.personaProfile.topic,
          }, userProfile || {}),
          ...(typeof input.personaProfile.name === "string" ? { name: input.personaProfile.name } : {}),
          ...(typeof input.personaProfile.full_name === "string" ? { full_name: input.personaProfile.full_name } : {}),
        };
      }
      supabaseMs += Date.now() - tSbProfStart;

      // 3. Save User Message & 4. Assistant Placeholder
      userMsgId = ID.unique();
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
            request_status: "planning",
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
            requestStatus: "planning",
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

    const assistantFacingMessage = formatClarificationMessageForAssistant(message);
    const researchIntent = extractResearchIntent(assistantFacingMessage, undefined, activeFiles);
    const discoveryDecision = evaluateDiscoveryDecision(researchIntent);
    let isPhase2 = false;

    const mentionedPlats = detectMentionedPlatforms(assistantFacingMessage);
    const approvedSocialPlatforms = ["facebook", "x", "twitter", "youtube", "instagram", "tiktok", "reddit", "linkedin"];
    const hasApprovedPlatformInMessage = mentionedPlats.some((p) => approvedSocialPlatforms.includes(p.toLowerCase()));
    const hasApprovedPlatformInBrief = brief.platforms.some((p) => approvedSocialPlatforms.includes(p.toLowerCase()));
    const hasAnyApprovedPlatform = hasApprovedPlatformInMessage || hasApprovedPlatformInBrief;

    const hasExclusionReferenceOrFile = Boolean(
      brief.exclusionFile ||
      activeFiles.length > 0 ||
      researchIntent.userExclusions.value.hasExclusionReference
    );

    // Greetings never enter research discovery or spend an LLM turn. Ask for a
    // missing name once per conversation, then use the persisted profile name.
    if ((isGreeting || input.capturedName) && !isTestSearchScenario) {
      // The real profile name only: account name first, the top-up sender name last. Never a default.
      const displayName = input.capturedName?.trim() || [userProfile?.name, userProfile?.full_name, userProfile?.sender_name]
        .find((value) => typeof value === "string" && value.trim())?.trim();
      let alreadyAskedName = false;
      if (!displayName && sb) {
        try {
          const { data: priorNamePrompts } = await sb.from("messages")
            .select("id")
            .eq("conversation_id", conversationId)
            .eq("role", "assistant")
            .ilike("content_ar", `%${NAME_PROMPT_AR.slice(0, 12)}%`)
            .limit(2);
          alreadyAskedName = Boolean(priorNamePrompts?.length);
        } catch {}
      }
      const balanceLine = typeof userBalance === "number" && Number.isFinite(userBalance)
        ? `رصيدك المتاح ${toArabicDigits(Math.max(0, Math.floor(userBalance)))} نقطة. `
        : "";
      const greeting = input.capturedName
        ? `تشرفنا يا ${displayName}. ${balanceLine}كيف أساعدك اليوم؟`
        : displayName
          ? `أهلًا ${displayName}، ${balanceLine}كيف أساعدك اليوم؟`
          : alreadyAskedName
            ? `أهلًا بك، ${balanceLine}كيف أساعدك اليوم؟`
            : `أهلًا بك، ${NAME_PROMPT_AR}`;
      if (sb) {
        await Promise.all([
          sb.from("messages").update({ content_ar: greeting }).eq("id", assistantMsgId),
          sb.from("messages").update({ request_status: "completed" }).eq("id", userMsgId),
        ]);
      } else {
        await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: greeting, status: "ready" } });
        await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "completed" } });
      }
      return {
        conversationId,
        messageId: assistantMsgId,
        role: "assistant",
        contentAr: greeting,
        outputType: "answer_question",
        intent: "chat",
        tokensUsed: { input: 0, output: 0, costUsd: 0 },
        turnStats: zeroModelTurnStats(conversationId, assistantMsgId, turnStartTime),
      };
    }

    const isCompanyIntent =
      researchIntent.entityType.value === "companies" ||
      extractEntityType(assistantFacingMessage).entityType === "companies" ||
      /\bcompanies?\b|\bbusinesses\b|شركة|شركات|مؤسسات|مؤسسة/.test(assistantFacingMessage.toLowerCase()) ||
      brief.platforms.some((platform) => /compan|b2b|شركة/i.test(platform));
    const requiresExplicitCount = isCompanyIntent || isPeopleSearchRequest(assistantFacingMessage);

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
        await sb.from("messages").update({ request_status: "needs_input" }).eq("id", userMsgId);
      } else {
        await this.tables.updateRow({
          databaseId: "digr",
          tableId: "messages",
          rowId: assistantMsgId,
          data: { content: q.questionAr, status: "ready" },
        });
        await this.tables.updateRow({
          databaseId: "digr",
          tableId: "messages",
          rowId: userMsgId,
          data: { requestStatus: "needs_input" },
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
      if ((!brief.targetVolume || brief.targetVolume <= 0) && !requiresExplicitCount) brief.targetVolume = 10;
      if (!brief.formats || brief.formats.length === 0) brief.formats = ["xlsx"];
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
        if ((!brief.targetVolume || brief.targetVolume <= 0) && !requiresExplicitCount) {
          brief.targetVolume = researchIntent.sampleSize.provenance === "EXPLICIT" ? researchIntent.sampleSize.value : 10;
        }
        const dateVal = researchIntent.dateRange?.value?.relative || (researchIntent.dateRange?.value?.from ? `${researchIntent.dateRange.value.from} إلى ${researchIntent.dateRange.value.to || ""}` : undefined);
        if (!brief.dateRange && dateVal) {
          brief.dateRange = dateVal;
        }
        if (!brief.formats || brief.formats.length === 0) {
          brief.formats = researchIntent.outputTypes?.value?.length > 0
            ? [...researchIntent.outputTypes.value]
            : ["xlsx"];
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
      if ((!brief.targetVolume || brief.targetVolume <= 0) && !requiresExplicitCount) {
        brief.targetVolume = (brief.postCount && brief.commentsPerPost) ? (brief.postCount * brief.commentsPerPost) : 10;
      }
      if (!brief.dateRange) brief.dateRange = "آخر شهر";
      if (!brief.language) brief.language = "العربية";
      await saveConversationBrief(this.tables, conversationId, userId, brief);
      isPhase2 = true;
    } else if (hasPlatform && hasTopic && ((brief.targetVolume !== undefined && brief.targetVolume > 0) || Boolean(brief.postCount && brief.commentsPerPost) || wantsPriceOrProceed || Boolean(brief.dateRange))) {
      // Platform & topic known with volume, plan intent, or dates: DECIDE, never interrogate! Apply sensible defaults
      if ((!brief.targetVolume || brief.targetVolume <= 0) && !requiresExplicitCount) {
        brief.targetVolume = (brief.postCount && brief.commentsPerPost) ? (brief.postCount * brief.commentsPerPost) : 10;
      }
      if (!brief.language) {
        brief.language = "العربية";
      }
      if (!brief.formats || brief.formats.length === 0) {
        brief.formats = ["xlsx"];
      }
      await saveConversationBrief(this.tables, conversationId, userId, brief);
      isPhase2 = true;
    } else if (isComplete || (brief.platforms.length > 0 && brief.topics.length > 0 && brief.targetVolume && brief.dateRange)) {
      isPhase2 = true;
    } else if (wantsPriceOrProceed && brief.platforms.length > 0 && brief.topics.length > 0) {
      isPhase2 = true;
    } else if (testScenario === "search_then_plan" || testScenario === "direct_plan" || testScenario === "summary_then_plan" || testScenario === "multiplatform_plan" || testScenario === "phase2_plan") {
      isPhase2 = true;
    }

      currentStep = "capabilities_load";
      const tSbCapsStart = Date.now();
      const [loadedCapabilities, catalogCapabilities] = await Promise.all([
        getEnabledCapabilitiesWithCoreServices(this.tables),
        getCatalogCapabilities(this.tables),
      ]);
      const capabilities = loadedCapabilities;
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

      let dynamicCapabilities: Capability[] = liveCatalogEndpoints.map(catalogEndpointToCapability);

      let allCapabilities = [...dynamicCapabilities, ...capabilities];
      let allCatalogCapabilities = [...dynamicCapabilities, ...catalogCapabilities];
      let sanitizedCaps = sanitizeCapabilitiesForLlm(allCatalogCapabilities);

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
            content: r.role === "user"
              ? formatClarificationMessageForAssistant(r.content_ar || "")
              : r.content_ar || "",
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
            content: r.role === "user"
              ? formatClarificationMessageForAssistant(r.content || "")
              : r.content,
          }));
      }
      supabaseMs += Date.now() - tSbHistStart;

      // Clarification card answers arrive as a small JSON payload. Keep the
      // original user request in scope so explicit counts and company filters
      // survive the answer turn instead of being replaced by model defaults.
      const priorUserRequirements = messagesContext
        .filter((entry) => entry.role === "user")
        .map((entry) => customerAuthoredRequirementText(entry.content));
      const currentRequirement = customerAuthoredRequirementText(message);
      // The current message was persisted before history was fetched. Avoid
      // adding it twice to the deterministic routing text used for plans.
      if (priorUserRequirements.at(-1) === currentRequirement) priorUserRequirements.pop();
      const conversationRequestText = [
        ...priorUserRequirements,
        currentRequirement,
        ...explicitCompanyClarificationNotes(brief.notes),
      ].filter(Boolean).join(" ");

      const requiredDiscoveryQuestion = getDeterministicDiscoveryQuestion(conversationRequestText, brief);
      if (requiredDiscoveryQuestion) {
        const intro = "قبل إعداد الخطة، أحتاج معلومة واحدة حتى تكون مطابقة لطلبك.";
        const normalizedQuestion = normalizeClarificationQuestions({ questions: [requiredDiscoveryQuestion] }, {
          capabilities: allCapabilities,
          userBalancePoints: userBalance,
          persona: userProfile?.persona,
        })[0] || requiredDiscoveryQuestion;
        const textAr = `${intro}\n${normalizedQuestion.text || normalizedQuestion.question}`;
        if (sb) {
          await Promise.all([
            sb.from("messages").update({ content_ar: textAr }).eq("id", assistantMsgId),
            sb.from("messages").update({ request_status: "needs_input" }).eq("id", userMsgId),
          ]);
        } else {
          await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: textAr, status: "ready" } });
          await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "needs_input" } });
        }
        return {
          conversationId,
          messageId: assistantMsgId,
          role: "assistant",
          contentAr: textAr,
          outputType: "ask_clarification",
          intent: "research",
          clarificationIntro: intro,
          clarificationQuestions: [normalizedQuestion.text || normalizedQuestion.question],
          clarificationItems: [normalizedQuestion],
          tokensUsed: { input: 0, output: 0, costUsd: 0 },
          turnStats: zeroModelTurnStats(conversationId, assistantMsgId, turnStartTime),
        };
      }

      // Verified social services: for a comments / videos / trending / channel request the model is shown only the
      // verified capability for that platform and task, instead of choosing among the whole live catalog (where a
      // post search at hundreds of points ranked above the comments the customer asked for).
      const socialIntent = detectSocialIntent(conversationRequestText);
      const verifiedSocialDef = socialIntent.task ? socialCapabilityForIntent(socialIntent) : undefined;
      const verifiedSocialCap = verifiedSocialDef ? capabilities.find((c) => c.slug === verifiedSocialDef.slug) : undefined;
      if (verifiedSocialCap) {
        liveCatalogEndpoints = [capabilityAsCatalogEndpoint(verifiedSocialCap)];
        dynamicCapabilities = [];
        allCapabilities = [...capabilities];
        allCatalogCapabilities = [...catalogCapabilities];
        sanitizedCaps = sanitizeCapabilitiesForLlm(allCatalogCapabilities);
      }

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
        (userProfile?.name && String(userProfile.name).trim()) ||
        (userProfile?.full_name && String(userProfile.full_name).trim()) ||
        (userProfile?.sender_name && String(userProfile.sender_name).trim()) ||
        "";

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

      // The language model can incorrectly suggest an unrelated alternative for a
      // people-search request. Prefer the verified people capability when present.
      output = routePeopleAlternative(output, brief, validationCaps, conversationRequestText);
      // Explicit company requests receive the same deterministic routing guard.
      output = routeCompanySearchRequest(output, brief, validationCaps, conversationRequestText);
      if (ACCOUNT_LOOKUP_RE.test(conversationRequestText)) {
        // Profile requests have a distinct one-record plan with no country or
        // date filters; don't let a generic social-content plan replace it.
        output = buildAutoPlanProposal(brief, validationCaps, conversationRequestText) as any;
      }

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
        const companyRequirementsText = conversationRequestText;
        const missingCompanyRequirements = isCompanyIntent && !isPeopleSearchRequest(companyRequirementsText)
          ? getMissingCompanyResearchRequirements(companyRequirementsText)
          : [];
        const hasPlatformOrTopic = Boolean(
          (brief.platforms && brief.platforms.length > 0) || (brief.topics && brief.topics.length > 0),
        );
        if (missingCompanyRequirements.length > 0) {
          clarificationItemsList = getCompanyRequirementItems(missingCompanyRequirements, companyRequirementsText);
          clarificationQuestionsList = clarificationItemsList.map((item) => item.text);
          finalContentAr = "قبل إعداد عرض السعر، أحتاج تحديد نطاق البحث وهدف التواصل حتى لا أخمّن تفاصيل قد تغيّر النتائج.";
        } else {
          clarificationItemsList = hasPlatformOrTopic
            ? filterQuestionsAlreadyInBrief(clarification.clarificationItems, brief).slice(0, 1)
            : filterQuestionsAlreadyInBrief(clarification.clarificationItems, brief);
        }
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
        const selectedOutputFormats: Array<"xlsx" | "pdf" | "csv"> = brief.formats?.length
          ? brief.formats.filter((format): format is "xlsx" | "pdf" | "csv" =>
              format === "xlsx" || format === "pdf" || format === "csv",
            )
          : ["xlsx"];
        (output as any).outputFormats = [...selectedOutputFormats];
        const explicitCountry = detectCountryFromText(conversationRequestText);
        const explicitRequestedVolume = researchIntent.sampleSize.provenance === "EXPLICIT"
          ? researchIntent.sampleSize.value
          : (isCardAnswer ? brief.targetVolume : undefined);
        const mapPlanItems = (out: any) =>
          ((out as any).capabilities || (out as any).steps || []).map((c: any) => {
            const itemParams = { ...(c.params || {}) };
            const rawCapabilityId = c.capabilitySlug || c.endpointId || "";
            const isPeopleCapability = /people/i.test(`${rawCapabilityId} ${c.endpointId || ""}`);
            const capabilityId = isPeopleCapability ? "professional-people-search" : rawCapabilityId;
            const isRecordSearchCapability = /compan|b2b|people/i.test(capabilityId);
            const isSocialContentCapability = /video|videos|tiktok|youtube|reels|posts?|social|instagram|facebook|reddit|twitter/i.test(capabilityId);
            if (isSocialContentCapability && (!itemParams.dateFrom || !itemParams.dateTo)) {
              const dateFilters = dateFiltersFromHint(brief.dateRange || conversationRequestText);
              if (dateFilters.from && !itemParams.dateFrom) itemParams.dateFrom = dateFilters.from;
              if (dateFilters.to && !itemParams.dateTo) itemParams.dateTo = dateFilters.to;
            }
            const requestedRecordVolume = isRecordSearchCapability && explicitRequestedVolume && explicitRequestedVolume > 0
              ? explicitRequestedVolume
              : undefined;
            const detectedIndustry = detectIndustryFromText(conversationRequestText);
            if (isSocialContentCapability && typeof itemParams.industry === "string") {
              // Social/video plans have a topic, not a company-industry field.
              // Models sometimes copy the complete natural-language request here.
              delete itemParams.industry;
            }
            if (!isSocialContentCapability && (!itemParams.query || (typeof itemParams.query === "object" && Object.keys(itemParams.query).length === 0))) {
              itemParams.query = {
                ...(detectedIndustry.arabicLabel !== "قواعد بيانات الشركات" ? { keyword: { include: detectedIndustry.englishKeywords } } : {}),
                ...(explicitCountry ? { location: { include: [explicitCountry.canonicalEnglish] } } : {}),
              };
            }
            if (explicitCountry && !itemParams.country && !itemParams.location) {
              itemParams.country = explicitCountry.canonicalEnglish;
              itemParams.location = explicitCountry.canonicalEnglish;
              if (itemParams.query && typeof itemParams.query === "object") {
                itemParams.query.location = { include: [explicitCountry.canonicalEnglish] };
              }
            }
            if (isPeopleCapability) {
              itemParams.q = typeof itemParams.q === "string" && itemParams.q.trim()
                ? itemParams.q.slice(0, 300)
                : conversationRequestText.slice(0, 300);
              itemParams.limit = Math.max(1, Math.min(50, Number(requestedRecordVolume || itemParams.limit || 10)));
              if (explicitCountry) {
                itemParams.country = isoCountryCodeFromName(explicitCountry.canonicalEnglish) || explicitCountry.canonicalEnglish;
              }
              const explicitTitle = conversationRequestText.match(/\b(ceos?|ctos?|cfos?|coos?|founders?|owners?|directors?|managers?|heads?|vps?|presidents?)\b|الرئيس التنفيذي|مدير(?:ين)?|مؤسس(?:ين)?|رئيس مجلس الإدارة/i);
              if (!itemParams.title && explicitTitle) itemParams.title = (explicitTitle[1] || explicitTitle[0]).replace(/s$/i, "");
              if (!itemParams.keywords && detectedIndustry.englishKeywords.length) itemParams.keywords = detectedIndustry.englishKeywords;
              // Contact data is a required part of this B2B capability. The
              // per-person rate covers these bounded enrichment attempts;
              // incomplete rows are excluded before customer billing.
              itemParams.contactFieldsToAttempt = ["work_email", "phone"];
              itemParams.requiredContactFields = ["work_email", "phone"];
              delete itemParams.query;
              delete itemParams.pagination;
            }
            if (requestedRecordVolume && itemParams.pagination && typeof itemParams.pagination === "object") {
              const currentPageSize = Number(itemParams.pagination.size);
              if (!Number.isFinite(currentPageSize) || currentPageSize > requestedRecordVolume) {
                itemParams.pagination.size = requestedRecordVolume;
              }
            }
            return {
              stepId: c.stepId,
              capabilitySlug: capabilityId,
              endpointId: isPeopleCapability ? "treg.people.search" : (c.endpointId || c.capabilitySlug),
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
              targetVolumeMin: requestedRecordVolume
                ? Math.min(c.targetVolumeMin || 1, requestedRecordVolume)
                : c.targetVolumeMin || 1,
              targetVolumeMax: requestedRecordVolume || c.targetVolumeMax,
            };
          });

        const canonicalizePlanItems = (items: PlanItem[]) => items.map((item) => {
          // A social request is served by its verified capability whatever the model proposed; the link, channel,
          // keyword and country are rebuilt from the customer's own words.
          if (verifiedSocialDef && verifiedSocialCap) {
            // Only a period the customer wrote filters the results. The brief's own default window ("آخر شهر") would
            // silently discard every comment on an older video and then report that nothing matched.
            const dates = dateFiltersFromHint(extractDateHint(conversationRequestText) || "");
            const perVideo = brief.commentsPerPost && brief.commentsPerPost > 0 ? brief.commentsPerPost : undefined;
            const videoCount = brief.postCount && brief.postCount > 0 ? brief.postCount : undefined;
            const params = canonicalSocialParams(verifiedSocialDef, socialIntent, conversationRequestText, item.params, {
              dateFrom: dates.from,
              dateTo: dates.to,
              perVideo,
              videoCount,
            });
            // The count the customer stated wins; a videos x comments-per-video request means exactly that many comments.
            const statedVolume = explicitRequestedVolume && explicitRequestedVolume > 0
              ? explicitRequestedVolume
              : perVideo && videoCount && verifiedSocialDef.kind === "comments"
              ? perVideo * videoCount
              : item.targetVolumeMax || 1;
            const volume = Math.max(1, Math.min(statedVolume, verifiedSocialDef.maxRows));
            return {
              ...item,
              capabilitySlug: verifiedSocialDef.slug,
              endpointId: verifiedSocialCap.tregEndpointId || verifiedSocialDef.slug,
              paginationStrategy: "cursor",
              params,
              targetVolumeMin: Math.min(item.targetVolumeMin || 1, volume),
              targetVolumeMax: volume,
            } as PlanItem;
          }
          const capability = resolveCapabilityReference(item.capabilitySlug, validationCaps) ||
            (item.endpointId ? resolveCapabilityReference(item.endpointId, validationCaps) : undefined);
          let params = item.params;
          if (capability && /tiktok.*search.*videos|videos.*search.*tiktok/i.test(`${capability.slug} ${capability.tregEndpointId || capability.id}`)) {
            let schema: any = capability.paramsSchema;
            if (typeof schema === "string") {
              try { schema = JSON.parse(schema); } catch { schema = {}; }
            }
            if (schema?.properties?.query?.type === "string") {
              const requestCountry = detectCountryFromText(conversationRequestText);
              const topic = socialSearchQueryFromTitle(
                typeof planOutput.conversationTitle === "string" ? planOutput.conversationTitle : "",
                requestCountry?.arabicLabel,
              );
              if (topic) params = { ...params, query: topic };
            }
          }
          return capability
            ? {
                ...item,
                capabilitySlug: capability.slug || capability.id || item.capabilitySlug,
                endpointId: capability.tregEndpointId || capability.id || capability.slug || item.endpointId || item.capabilitySlug,
                params,
              }
            : item;
        });

        let planOutput: any = output;
        let planItems = dedupeRecordSearchItems<PlanItem>(canonicalizePlanItems(mapPlanItems(planOutput)));
        const companyPlan = planItems.some((item: any) =>
          /compan|b2b/i.test(`${item.capabilitySlug || ""} ${item.endpointId || ""}`)
        );
        const peoplePlan = planItems.some((item: any) =>
          /people/i.test(`${item.capabilitySlug || ""} ${item.endpointId || ""}`)
        );
        const requiredFieldsText = conversationRequestText;
        const isAccountProfileRequest = ACCOUNT_LOOKUP_RE.test(requiredFieldsText);
        const isSocialTopicRequest = !isAccountProfileRequest && SOCIAL_CONTENT_WORDS_RE.test(requiredFieldsText);
        const accountHandle = ACCOUNT_HANDLE_RE.exec(requiredFieldsText)?.[1];
        const hasExplicitCount = Boolean(extractNumberFromText(requiredFieldsText));
        const missingCompanyFields = companyPlan && !isPeopleSearchRequest(requiredFieldsText)
          ? getMissingCompanyResearchRequirements(requiredFieldsText)
          : [];
        const missingPeopleFields: string[] = [];
        if (peoplePlan) {
          if (!detectCountryFromText(requiredFieldsText)) missingPeopleFields.push("people_country_required");
          const scopeMissing = getMissingCompanyResearchRequirements(requiredFieldsText).includes("industry") && !/\b(?:company|at)\s*[:=]|(?:لدى|في شركة|شركة محددة|اسم الشركة|اسم الشركات)\s+\p{L}/iu.test(requiredFieldsText);
          if (scopeMissing) missingPeopleFields.push("people_scope_required");
          if (!PEOPLE_ROLE_PATTERN.test(requiredFieldsText)) {
            missingPeopleFields.push("people_roles_required");
          }
          if (!hasExplicitCount) missingPeopleFields.push("people_count_required");
        }
        const missingSocialFields: string[] = [];
        if (isAccountProfileRequest && !accountHandle) missingSocialFields.push("social_account_required");
        if (isSocialTopicRequest && !verifiedSocialDef) {
          missingSocialFields.push(...getMissingSocialInputs(requiredFieldsText).filter((id) => id !== "social_account_required"));
        }
        if (!isAccountProfileRequest && !companyPlan && !peoplePlan) {
          missingSocialFields.push(...getMissingSocialTaskInputs(requiredFieldsText));
        }
        const missingCompanyCount = companyPlan && !isPeopleSearchRequest(requiredFieldsText) && !hasExplicitCount;
        const missingRequiredFields = [
          ...missingCompanyFields,
          ...(missingCompanyCount ? ["company_count_required"] : []),
          ...missingPeopleFields,
          ...missingSocialFields,
        ];
        if (missingRequiredFields.length > 0) {
          finalContentAr = "قبل إعداد عرض السعر، أحتاج معلومة واحدة حتى تكون الخطة مطابقة لطلبك.";
          const firstMissing = missingRequiredFields[0];
          const companyItems = companyPlan && !isPeopleSearchRequest(requiredFieldsText)
            ? getCompanyRequirementItems(missingCompanyFields, requiredFieldsText)
            : [];
          const companyItem = companyItems[0];
          const questionByField: Record<string, any> = {
            company_count_required: { id: firstMissing, text: "كم شركة تريد في النتائج؟", question: "كم شركة تريد في النتائج؟", type: "free", options: [], allowOther: true },
            people_country_required: { id: firstMissing, text: "في أي دولة تريد البحث عن صناع القرار؟", question: "في أي دولة تريد البحث عن صناع القرار؟", type: "single", options: ["مصر", "السعودية", "الإمارات", "أخرى"], allowOther: true },
            people_scope_required: { id: firstMissing, text: "ما المجال أو الشركة التي تريد صناع القرار منها؟", question: "ما المجال أو الشركة التي تريد صناع القرار منها؟", type: "free", options: [], allowOther: true },
            people_roles_required: { id: firstMissing, text: "ما المسميات الوظيفية التي تريدها؟", question: "ما المسميات الوظيفية التي تريدها؟", type: "free", options: [], allowOther: true },
            people_count_required: { id: firstMissing, text: "كم صانع قرار تريد؟", question: "كم صانع قرار تريد؟", type: "free", options: [], allowOther: true },
            social_account_required: { id: firstMissing, text: "ما اسم الحساب أو رابطه على تيك توك؟", question: "ما اسم الحساب أو رابطه على تيك توك؟", type: "free", options: [], allowOther: true },
            social_platform_required: { id: firstMissing, text: "على أي منصة تريد البحث؟", question: "على أي منصة تريد البحث؟", type: "single", options: ["تيك توك", "يوتيوب", "إنستغرام", "أخرى"], allowOther: true },
            social_time_required: { id: firstMissing, text: "ما الفترة الزمنية المطلوبة؟", question: "ما الفترة الزمنية المطلوبة؟", type: "single", options: ["آخر أسبوع", "آخر شهر", "آخر ٣ شهور", "آخر سنة"], allowOther: true },
            social_topic_required: { id: firstMissing, text: "ما الموضوع أو الكلمات التي تريد البحث عنها؟", question: "ما الموضوع أو الكلمات التي تريد البحث عنها؟", type: "free", options: [], allowOther: true },
            social_comment_target_required: socialTaskQuestion("social_comment_target_required"),
            social_trending_region_required: socialTaskQuestion("social_trending_region_required"),
            social_trending_platform_required: socialTaskQuestion("social_trending_platform_required"),
            social_channel_required: socialTaskQuestion("social_channel_required"),
          };
          clarificationItemsList = companyItem
            ? [companyItem]
            : [questionByField[firstMissing] || { id: "company_count_required", text: "كم شركة تريد في النتائج؟", question: "كم شركة تريد في النتائج؟", type: "free", options: [], allowOther: true }];
          clarificationQuestionsList = clarificationItemsList.map((item) => item.text);
          output = {
            type: "ask_clarification",
            reasonAr: finalContentAr,
            intro: finalContentAr,
            questions: clarificationItemsList,
            questionsAr: clarificationQuestionsList,
          } as any;
          planOutput = null;
        }

        // Deterministic check: platform mentioned by user must match platform in proposed plan
        let platformCheck = validatePlanPlatformMatch(message, planItems, validationCaps);
        let planValidation = platformCheck.valid
          ? validatePlanAgainstLiveCatalog(planItems, turnEndpoints, allCapabilities)
          : { valid: false, errors: [] as string[], issues: [] as LiveCatalogIssue[] };
        if (missingRequiredFields.length > 0) {
          planValidation = { valid: false, errors: ["missing-company-required-fields"], issues: [] as LiveCatalogIssue[] };
        }

        let planRetries = 0;
        while (missingRequiredFields.length === 0 && platformCheck.valid && !planValidation.valid && planRetries < 3) {
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
            planItems = dedupeRecordSearchItems<PlanItem>(canonicalizePlanItems(mapPlanItems(planOutput)));
            platformCheck = validatePlanPlatformMatch(message, planItems, validationCaps);
            if (platformCheck.valid) {
              planValidation = validatePlanAgainstLiveCatalog(planItems, turnEndpoints, allCapabilities);
            }
          } else {
            planOutput = null;
            planValidation = { valid: false, errors: ["no-plan"], issues: [] as LiveCatalogIssue[] };
          }
        }

        if (missingRequiredFields.length > 0) {
          // Keep the clarification response created above; no quote should be saved with inferred defaults.
        } else if (testScenario === "plan_ghost_then_stall") {
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
          console.warn("[chat:platform_check_invalid]", { message, planItems });
          finalContentAr = UNVERIFIED_PLATFORM_MESSAGE_AR;
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
              const autoPlanItems = dedupeRecordSearchItems<PlanItem>(mapPlanItems(autoPlan));
              const autoCheck = validatePlanAgainstLiveCatalog(autoPlanItems, turnEndpoints, allCapabilities);
              if (autoCheck.valid) {
                planOutput = autoPlan;
                planItems = autoPlanItems;
                planValidation = { valid: true, errors: [], issues: [] };
              } else {
                console.warn("[chat:auto_plan_invalid_pricing]", { errors: autoCheck.errors });
                finalContentAr = "اكتب الموضوع أو أرسل رابط المصدر الذي تريد جمع بياناته، وسأجهز خطة تناسب طلبك.";
                output = {
                  type: "ask_clarification",
                  intro: finalContentAr,
                  reasonAr: finalContentAr,
                  questions: [{ id: "topic_or_source", text: "ما الموضوع أو رابط المصدر المطلوب؟", type: "free" }],
                } as any;
                planOutput = null;
                planValidation = { valid: false, errors: autoCheck.errors, issues: autoCheck.issues };
              }
            }
          }
        }

        if (platformCheck.valid && planValidation.valid && planOutput) {
          const peopleGate = routePeopleAlternative(planOutput, brief, validationCaps, conversationRequestText);
          const platformGate = routeUnavailablePlatformRequest(planOutput, conversationRequestText);
          const unavailableGate = peopleGate.type === "refuse" ? peopleGate : platformGate;
          if (unavailableGate.type === "refuse") {
            output = unavailableGate;
            planOutput = null;
            planValidation = { valid: false, errors: [unavailableGate.reasonAr], issues: [] };
            finalContentAr = unavailableGate.reasonAr;
          }
        }

        // Retry button: reuse the rows a failed run already collected, but only when this plan
        // searches for exactly the same thing. The marker is part of the plan hash, so the
        // customer approves exactly what is reused.
        let reusedRowsForRetry = 0;
        if (platformCheck.valid && planValidation.valid && planOutput && isRetrySamePlanMessage(message) && sb && planItems.length === 1) {
          const retryJob = await findRetryableJob(sb, userId, conversationId);
          const previousItem = retryJob ? await loadQuoteFirstItem(sb, userId, retryJob.quoteId) : null;
          const candidateItem = planItems[0];
          if (
            retryJob && previousItem &&
            planParamsSignature(previousItem.capabilitySlug, previousItem.params) === planParamsSignature(candidateItem.capabilitySlug, candidateItem.params)
          ) {
            const reusable = await readReusableRows(sb, retryJob.jobId, retryJob.step, Math.max(1, Number(candidateItem.targetVolumeMax) || 1));
            if (reusable.rows.length > 0) {
              planItems = [{ ...candidateItem, params: { ...candidateItem.params, retryOfJobId: retryJob.jobId } }];
              reusedRowsForRetry = reusable.rows.length;
            }
          }
        }

        if (platformCheck.valid && planValidation.valid && planOutput) {
          if (verifiedSocialDef && planItems[0]) {
            // The goal line is written by the server so it always matches what will run.
            planOutput.summaryAr = socialPlanSummaryAr(verifiedSocialDef, planItems[0].params || {}, Number(planItems[0].targetVolumeMax) || 1, toArabicDigits);
          }
          currentStep = "quote_save";
          const tQuoteStart = Date.now();
          const managedQuote = await createAndSaveManagedQuote(this.tables, {
            conversationId,
            userId,
            plan: {
              summaryAr: planOutput.summaryAr,
              items: planItems,
              outputFormats: selectedOutputFormats,
            methodologyNotes: isPeopleSearchRequest(conversationRequestText)
                ? `${planOutput.methodologyNotes || ""} سنحاول جمع البريد المهني ورقم الهاتف، ويُعرض كل حقل إذا ورد من المصادر المتاحة مع حالة التحقق التي أعادتها المصادر. لا تُحتسب السجلات التي لا تتضمن الحقلين المطلوبين.`.trim()
                : planOutput.methodologyNotes,
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
            expectedPoints: managedQuote.expectedPoints,
            quotedPoints: managedQuote.quotedPoints,
            isAffordable: managedQuote.isAffordable,
            pointsCapConstrained: managedQuote.pointsCapConstrained,
            requestedVolumeMax: managedQuote.requestedVolumeMax,
            pointsCap: managedQuote.pointsCap,
            userBalance,
            downscaledOffer: managedQuote.downscaledOffer,
            capacityConstrained: managedQuote.capacityConstrained,
            outputFormats: managedQuote.outputFormats,
            expiresAt: managedQuote.expiresAt,
            methodologyNotes: isPeopleSearchRequest(conversationRequestText)
              ? `${planOutput.methodologyNotes || ""} ${CONTACT_EXPECTATION_AR} ${CONTACT_BILLING_NOTE_AR}`.trim()
              : planOutput.methodologyNotes,
          };

          let planSummaryText = `أعددت لك خطة الاستخراج وعرض السعر بالنقاط:\n- الهدف: ${planOutput.summaryAr}\n- الحد الأقصى: حتى ${toArabicDigits(managedQuote.targetVolumeMax)} سجل\n- التكلفة المتوقعة: ${toArabicDigits(managedQuote.expectedPoints)} نقطة`;
          if (managedQuote.pointsCapConstrained) {
            planSummaryText += managedQuote.targetVolumeMax < (managedQuote.requestedVolumeMax || managedQuote.targetVolumeMax)
              ? `\n- تم ضبط العدد من ${toArabicDigits(managedQuote.requestedVolumeMax || managedQuote.targetVolumeMax)} إلى ${toArabicDigits(managedQuote.targetVolumeMax)} سجل حتى يظل السعر والحجز مع احتياطي التنفيذ ضمن سقف ${toArabicDigits(managedQuote.pointsCap || 600)} نقطة. يمكنك تقليل العدد أكثر إذا أردت.`
              : `\n- العدد المطلوب ${toArabicDigits(managedQuote.targetVolumeMax)} أشخاص يناسب سقف السعر. تم تحديد الحجز عند ${toArabicDigits(managedQuote.quotedPoints)} نقطة، ويشمل احتياطي التنفيذ ضمن سقف ${toArabicDigits(managedQuote.pointsCap || 600)} نقطة.`;
          }
          if (brief.exclusionFile) {
            planSummaryText += `\n- ملف الاستبعاد المعتمد: تم التحقق من "${brief.exclusionFile.name}" واستبعاد ${toArabicDigits(brief.exclusionFile.baselineRowCount)} شركة مسجلة مسبقاً لمنع تكرارها.`;
          }
          if (isPeopleSearchRequest(conversationRequestText)) {
            planSummaryText += `\n- بيانات التواصل المتوقعة: ${CONTACT_EXPECTATION_AR}\n- ${CONTACT_BILLING_NOTE_AR}`;
          }
          if (reusedRowsForRetry > 0) {
            planSummaryText += `\n- إعادة استخدام: ${toArabicDigits(reusedRowsForRetry)} سجل جُمعت في المحاولة السابقة تُضاف إلى النتيجة، ويُجلب المتبقي فقط. السعر المعروض يغطي كامل العدد المطلوب، ولا يُخصم إلا ثمن السجلات المسلّمة فعلاً.`;
          }
          if (managedQuote.capacityConstrained) {
            planSummaryText += `\n- تنبيه السعة: تم ضبط الحد الأقصى عند ${toArabicDigits(managedQuote.targetVolumeMax)} سجل لضمان دقة وسرعة التنفيذ المباشر.`;
          }
          if (!managedQuote.isAffordable) {
            planSummaryText += `\n- تنبيه: رصيدك الحالي (${toArabicDigits(userBalance)} نقطة) لا يكفي لتغطية كامل العرض.`;
            if (managedQuote.downscaledOffer) {
              planSummaryText += `\n- اقتراح مخفض: يمكننا جمع حتى ${toArabicDigits(managedQuote.downscaledOffer.maxAffordableUnits)} سجل مقابل ${toArabicDigits(managedQuote.downscaledOffer.affordableQuotedPoints)} نقطة تناسب رصيدك الحالي.`;
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
                expectedPoints: managedQuote.expectedPoints,
                quotedPoints: managedQuote.quotedPoints,
                isAffordable: managedQuote.isAffordable,
              pointsCapConstrained: managedQuote.pointsCapConstrained,
              requestedVolumeMax: managedQuote.requestedVolumeMax,
              pointsCap: managedQuote.pointsCap,
                userBalance,
                downscaledOffer: managedQuote.downscaledOffer,
                capacityConstrained: managedQuote.capacityConstrained,
                outputFormats: managedQuote.outputFormats,
                expiresAt: managedQuote.expiresAt,
              };

              finalContentAr = `تم تعديل الخطة وتحديث عرض السعر بالنقاط:\n• الهدف: ${managedQuote.summaryAr}\n• الحد الأقصى: حتى ${toArabicDigits(managedQuote.targetVolumeMax)} سجل\n• التكلفة المتوقعة: ${toArabicDigits(managedQuote.expectedPoints)} نقطة`;
          if (managedQuote.pointsCapConstrained) {
            finalContentAr += `\n• تم ضبط العدد من ${toArabicDigits(managedQuote.requestedVolumeMax || managedQuote.targetVolumeMax)} إلى ${toArabicDigits(managedQuote.targetVolumeMax)} سجل حتى يظل السعر والحجز ضمن سقف ${toArabicDigits(managedQuote.pointsCap || 600)} نقطة. يمكنك تقليل العدد أكثر إذا أردت.`;
          }
              if (managedQuote.capacityConstrained) {
                finalContentAr += `\n• تنبيه السعة: تم ضبط الحد الأقصى عند ${toArabicDigits(managedQuote.targetVolumeMax)} سجل لضمان دقة وسرعة التنفيذ المباشر.`;
              }
              if (!managedQuote.isAffordable) {
                finalContentAr += `\n• تنبيه: رصيدك الحالي (${toArabicDigits(userBalance)} نقطة) لا يكفي لتغطية كامل العرض المحدث.`;
                if (managedQuote.downscaledOffer) {
                  finalContentAr += `\n• اقتراح مخفض: يمكننا جمع حتى ${toArabicDigits(managedQuote.downscaledOffer.maxAffordableUnits)} سجل مقابل ${toArabicDigits(managedQuote.downscaledOffer.affordableQuotedPoints)} نقطة تناسب رصيدك الحالي.`;
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
        console.warn("[chat:suggest_alternative]", {
          unsupportedService: output.unsupportedService,
          explanationAr: output.explanationAr,
        });
        finalContentAr = "اكتب الموضوع أو أرسل رابط المصدر الذي تريد جمع بياناته، وسأجهز خطة تناسب طلبك.";

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

      // Keep planning attempts in the request history even when no quote/job
      // was created. This write is best-effort so history cannot block replies.
      const requestStatus = resolveRequestAttemptStatus({
        intent: isGreeting || isGeneralQuestion ? "chat" : "research",
        outputType: output.type,
        hasQuote: Boolean(planQuoteData?.quoteId),
      });
      try {
        if (sb) {
          const { error: requestStatusError } = await sb
            .from("messages")
            .update({
              request_status: requestStatus,
              request_error: output.type === "refuse" ? sanitizeCustomerErrorMessage(output.reasonAr) : null,
              request_quote_id: planQuoteData?.quoteId || null,
            })
            .eq("id", userMsgId)
            .eq("user_id", userId);
          if (requestStatusError) throw requestStatusError;
        } else {
          await this.tables.updateRow({
            databaseId: "digr",
            tableId: "messages",
            rowId: userMsgId,
            data: {
              requestStatus,
              requestError: output.type === "refuse" ? sanitizeCustomerErrorMessage(output.reasonAr) : undefined,
              requestQuoteId: planQuoteData?.quoteId || undefined,
            },
          });
        }
      } catch (requestStatusError: any) {
        console.warn("[chat:request_history_update_failed]", requestStatusError?.message || "unknown_error");
      }

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
      const rawTitle = typeof (llmResult.output as any)?.conversationTitle === "string"
        ? (llmResult.output as any).conversationTitle
        : typeof (llmResult.output as any)?.summaryAr === "string"
          ? (llmResult.output as any).summaryAr
          : "";
      const generatedTitle = customerFacingConversationTitle(rawTitle).replace(/[\n\r]+/g, " ").trim();
      const conversationTitle = generatedTitle && generatedTitle !== "محادثة جديدة"
        ? generatedTitle
        : currentConversationTitle;
      const newTotalTokens = totalConvTokens + llmResult.inputTokens + llmResult.outputTokens;
      if (sb) {
        const { error: convUpdateErr } = await sb
          .from("conversations")
          .update({
            updated_at: new Date().toISOString(),
            ...(conversationTitle !== "محادثة جديدة" ? { title: conversationTitle } : {}),
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
            ...(conversationTitle !== "محادثة جديدة" ? { title: conversationTitle } : {}),
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

      // Ask one question per turn so the next clarification can be chosen from
      // the customer's latest answer instead of presenting a fixed questionnaire.
      if (clarificationItemsList?.length) {
        clarificationItemsList = clarificationItemsList.slice(0, 1);
        clarificationQuestionsList = clarificationItemsList.map((item) => item.text);
      } else if (clarificationQuestionsList?.length) {
        clarificationQuestionsList = clarificationQuestionsList.slice(0, 1);
      }

      return {
        conversationId,
        conversationTitle,
        messageId: assistantMsgId,
        role: "assistant",
        contentAr: finalContentAr,
        outputType: computedIntent === "chat" ? "answer_question" : output.type,
        intent: computedIntent,
        planQuote: planQuoteData,
        revisionQuote: revisionQuoteData,
        clarificationQuestions: clarificationQuestionsList,
        clarificationItems: clarificationItemsList,
        clarificationIntro: clarificationItemsList?.length ? finalContentAr : undefined,
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
      if (userMsgId) {
        const customerError = sanitizeCustomerErrorMessage(err?.message || "تعذر إعداد الطلب.");
        try {
          if (sb) {
            await sb
              .from("messages")
              .update({ request_status: "failed", request_error: customerError })
              .eq("id", userMsgId)
              .eq("user_id", userId);
          } else {
            await this.tables.updateRow({
              databaseId: "digr",
              tableId: "messages",
              rowId: userMsgId,
              data: { requestStatus: "failed", requestError: customerError },
            });
          }
        } catch (historyError: any) {
          console.warn("[chat:request_history_failure_write_failed]", historyError?.message || "unknown_error");
        }
      }
      throw err;
    }
  }
}

