import { logProviderCost } from "./providerCosts";
import { TablesDB, ID, Query } from "node-appwrite";
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
  isBriefComplete,
  formatBriefForSystemPrompt,
  getConversationBrief,
  saveConversationBrief,
  isRepetitionComplaint,
  type ResearchBrief,
} from "./briefManager";

export interface ChatHandlerInput {
  userId: string;
  conversationId?: string;
  message: string;
  userBalance?: number;
  testScenario?: string;
}

export interface ChatHandlerResponse {
  conversationId: string;
  messageId: string;
  role: "assistant";
  contentAr: string;
  outputType: LlmTurnOutput["type"];
  planQuote?: any;
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

  let rawItems: NormalizedClarificationQuestion[] = [];

  if (colonFallback) {
    rawItems = [
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
  } else {
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
    rawItems = [
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
        options: ["حتى 100 سجل", "حتى 500 سجل", "أكثر من 500 سجل"],
        allowOther: true,
      },
    ];
  }

  const items = (brief ? filterQuestionsAlreadyInBrief(rawItems, brief) : rawItems).slice(0, 3);
  return { intro, items };
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
  "في عن من على إلى الي و هاتلي هات عايز عاوز محتاج أسحب سحب جمع بيانات داتا آخر اخر شهور شهر شهورا سنة سنوات عام أعوام أسبوع أسابيع يوم أيام مصر فيسبوك تيك توك انستغرام إنستغرام يوتيوب تويتر ريديت لينكد reddit tiktok instagram facebook youtube x comments comment posts post بوست بوستات منشور منشورات تعليق تعليقات الـ ده دي تلك هذا هذه التي الذي بيتكلموا تتكلم".split(
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

/** Extract a date-range hint from the user's message, e.g. "آخر 3 شهور". */
export function extractDateHint(userMessage: string): string | undefined {
  if (!userMessage) return undefined;
  const m = /(آخر|اخر|خلال)\s*(\d+)?\s*(شهر|شهور|أشهر|سنة|سنوات|عام|أعوام|أسبوع|أسابيع|يوم|أيام)/.exec(userMessage);
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
  private tables: TablesDB;
  private llm: LlmClient;

  constructor(tables: TablesDB) {
    this.tables = tables;
    this.llm = new LlmClient();
  }

  async handleUserMessage(input: ChatHandlerInput): Promise<ChatHandlerResponse> {
    const { userId, message, testScenario } = input;
    const nowIso = new Date().toISOString();
    const turnStartTime = Date.now();
    let modelCallCount = 0;
    let catalogSearchCount = 0;

    // 1. Get or Create Conversation
    let conversationId = input.conversationId;
    let totalConvTokens = 0;

    if (!conversationId) {
      conversationId = ID.unique();
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
    } else {
      try {
        const conv: any = await this.tables.getRow({
          databaseId: "digr",
          tableId: "conversations",
          rowId: conversationId,
        });
        totalConvTokens = conv.totalTokens || 0;
      } catch {
        // Conversation not found, create new ID
        conversationId = ID.unique();
      }
    }

    // 2. Fetch User Points Balance from Ledger
    let userBalance = input.userBalance;
    if (userBalance === undefined) {
      userBalance = await getBalance(this.tables, userId);
    }

    // 2b. Fetch User Profile for Dynamic Persona Context
    let userProfile: any = undefined;
    try {
      userProfile = await this.tables.getRow({
        databaseId: "digr",
        tableId: "profiles",
        rowId: userId,
      });
    } catch {
      // Profile not found or not created yet
    }

    // 3. Save User Message in DB
    const userMsgId = ID.unique();
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

    // 4. Create Thinking Assistant Placeholder (for Progressive Realtime Streaming)
    const assistantMsgId = ID.unique();
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

    // 5. Research Brief & Two-Phase Routing
    const currentBrief = await getConversationBrief(this.tables, conversationId);
    const brief = extractBriefFromMessage(message, currentBrief);
    await saveConversationBrief(this.tables, conversationId, userId, brief);

    const userComplained = isRepetitionComplaint(message);
    const { isGreeting, isGeneralQuestion } = isGreetingOrGeneralQuestion(message);
    const wantsPriceOrProceed = isPriceOrProceedIntent(message);
    const isComplete = isBriefComplete(brief);

    const isTestSearchScenario = typeof testScenario === "string" && testScenario.startsWith("search_");
    let isPhase2 = false;

    if (isTestSearchScenario) {
      isPhase2 = false;
    } else if (isGreeting || isGeneralQuestion) {
      isPhase2 = false;
    } else if (userComplained) {
      if (brief.platforms.length === 0) brief.platforms.push("facebook");
      if (brief.topics.length === 0) brief.topics.push("البيانات المطلوبة");
      if (!brief.targetVolume || brief.targetVolume <= 0) brief.targetVolume = 500;
      if (!brief.dateRange) brief.dateRange = "آخر شهر";
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

    const [capabilities, catalogCapabilities] = await Promise.all([
      getEnabledCapabilities(this.tables),
      getCatalogCapabilities(this.tables),
    ]);

    let liveCatalogEndpoints: CatalogEndpointSummary[] = [];

    if (isPhase2) {
      // Progress line during Phase 2 pricing
      await this.tables.updateRow({
        databaseId: "digr",
        tableId: "messages",
        rowId: assistantMsgId,
        data: {
          content: "أبحث وأحسب السعر...",
          status: "thinking",
        },
      });

      // Server-side: run catalog search once per platform in brief (24h cache)
      const platformsToSearch = brief.platforms.length > 0 ? brief.platforms : detectMentionedPlatforms(message);
      const searchTopic = brief.topics.length > 0 ? brief.topics.join(" ") : message;

      const runCatalogSearchWithRetries = async (topic: string, p?: string) => {
        catalogSearchCount++;
        let res = await searchCatalog(topic, p);
        if (res.length > 0) return res;
        // On empty result or failure, retry silently up to 3 times with alternatives
        const fallbacks = [
          { q: p || "", plat: p },
          { q: "", plat: p },
          { q: topic, plat: undefined },
        ];
        for (let i = 0; i < fallbacks.length && res.length === 0; i++) {
          try {
            catalogSearchCount++;
            res = await searchCatalog(fallbacks[i].q, fallbacks[i].plat);
          } catch (err: any) {
            console.warn("[chat:catalog_search_retry_failure]", { attempt: i + 1, error: err?.message });
          }
        }
        if (res.length === 0) {
          console.warn("[chat:catalog_search_empty_after_retries]", { topic, platform: p });
        }
        return res;
      };

      if (platformsToSearch.length > 0) {
        for (const p of platformsToSearch) {
          const res = await runCatalogSearchWithRetries(searchTopic, p);
          liveCatalogEndpoints.push(...res);
        }
      } else {
        const res = await runCatalogSearchWithRetries(searchTopic, undefined);
        liveCatalogEndpoints.push(...res);
      }
    } else if (isTestSearchScenario) {
      catalogSearchCount++;
      const mentionedPlatforms = detectMentionedPlatforms(message);
      const platformHint = mentionedPlatforms[0] || undefined;
      liveCatalogEndpoints = await searchCatalog(message, platformHint);
    }

    const dynamicCapabilities: Capability[] = liveCatalogEndpoints.map(catalogEndpointToCapability);

    const allCapabilities = [...dynamicCapabilities, ...capabilities];
    const allCatalogCapabilities = [...dynamicCapabilities, ...catalogCapabilities];
    const sanitizedCaps = sanitizeCapabilitiesForLlm(allCatalogCapabilities);

    // 6. Fetch previous messages for context
    const historyRes = await this.tables.listRows({
      databaseId: "digr",
      tableId: "messages",
      queries: [
        Query.equal("conversationId", conversationId),
        Query.orderAsc("createdAt"),
        Query.limit(10),
      ],
    });

    const messagesContext = historyRes.rows
      .filter((r: any) => r.$id !== assistantMsgId && r.status !== "thinking")
      .map((r: any) => ({
        role: r.role as "user" | "assistant" | "system",
        content: r.content,
      }));

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
        content: `${formatBriefForSystemPrompt(brief)}\n\n${compactSummary}\n\n[تعليمات داخلية]: متطلبات البحث مكتملة الآن. استدعِ الآن propose_plan لاقتراح خطة مسعرة مطابقة للمنصة والأدوات المتاحة أعلاه. حدد الخطوات والمدخلات بدقة.`,
      });
    } else if (!isGreeting && !isGeneralQuestion && !isTestSearchScenario) {
      turnMessages.push({
        role: "system",
        content: `${formatBriefForSystemPrompt(brief)}\n\n[تعليمات داخلية — مرحلة الاستيعاب (Phase 1)]:\n- لا تبحث في الكتالوج ولا تقترح خطة مسعرة في هذه المرحلة.\n- افهم قصد المستخدم، واطرح حتى ٣ أسئلة متابعة ذكية كحد أقصى (لا تكرر أي سؤال تمت الإجابة عنه سابقاً).\n- احفظ واستكمل متطلبات البحث عبر استدعاء أداة update_brief (المنصات، الكلمات المفتاحية، حجم البيانات، النطاق الزمني، إلخ).`,
      });
    }

    modelCallCount++;
    let llmResult = await this.llm.executeTurn({
      messages: turnMessages,
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

    let output: typeof llmResult.output = llmResult.output;

    // 7b. Internal catalog-search loop: search_catalog is never a final answer.
    // The results go back to the model (in-memory only, never persisted) so it
    // can continue with ask_questions / propose_plan / plain text. Raw catalog
    // results — tool names and bare per-tool point prices — are never shown
    // to the user as a list; prices appear only inside a priced plan.
    const MAX_CATALOG_ITERATIONS = 4;
    let catalogIterations = 0;
    const loopMessages = [...turnMessages];
    // Every catalog search of this turn (pre-search + loop iterations), keyed by
    // the same alias the model received. This — plus the 24h cache — is what
    // plan validation accepts, not the hardcoded registry.
    const turnSearchResults: CatalogEndpointSummary[] = [...liveCatalogEndpoints];
    const repeatTurn = async () => {
      modelCallCount++;
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
      output = llmResult.output;
    };
    while (output.type === "search_catalog" && catalogIterations < MAX_CATALOG_ITERATIONS) {
      catalogIterations++;
      catalogSearchCount++;
      let searchRes = await searchCatalog(output.query, output.platform);
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
            searchRes = await searchCatalog(fallbacks[i].q, fallbacks[i].p);
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
    let clarificationQuestionsList: string[] | undefined = undefined;
    let clarificationItemsList: NormalizedClarificationQuestion[] | undefined = undefined;

    // Discovery fallback used when the catalog loop + one retry cannot produce a
    // next step: real code-built questions (never the generic sentence, never the
    // raw catalog list).
    const fallbackToDiscovery = (customIntro?: string, colonFallback: boolean = false) => {
      const fallback = buildCodeDiscoveryFallback(allCapabilities, message, colonFallback);
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
      } else {
        clarificationQuestionsList = undefined;
        clarificationItemsList = undefined;
        finalContentAr = deduplicateIntroText(customIntro || "تم تسجيل متطلبات البحث بنجاح، جاري إعداد الخطة المناسبة.");
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
      // (topic angle, number of posts, comments per post, date range, language/dialect)
      fallbackToDiscovery(answerCandidate || undefined, true);
    }

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
    const stalledAnswerText =
      output.type === "answer_question" ? (((output as any).answerAr || "") as string).trim() : "";
    if (output.type === "search_catalog" || (output.type === "answer_question" && !stalledAnswerText)) {
      // The model stalled even after the catalog loop + one explicit retry.
      // Fall back to code-built discovery questions — never the raw catalog list.
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
        clarificationItemsList = filterQuestionsAlreadyInBrief(normalized, brief);
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
        } else if (!userComplained) {
          clarificationItemsList = normalized;
          clarificationQuestionsList = normalized.map((q) => q.text);
          finalContentAr = deduplicateIntroText(output.replyAr || (llmResult.textBlockAr?.trim()) || "عشان أجهز لك خطة دقيقة، محتاج أعرف:");
          output = {
            type: "ask_clarification",
            reasonAr: finalContentAr,
            intro: finalContentAr,
            questions: clarificationItemsList,
            questionsAr: clarificationQuestionsList,
          } as any;
        } else {
          finalContentAr = deduplicateIntroText(output.replyAr || (llmResult.textBlockAr?.trim()) || "تم تسجيل متطلبات البحث بنجاح.");
          output = {
            type: "answer_question",
            answerAr: finalContentAr,
          } as any;
        }
      } else {
        finalContentAr = deduplicateIntroText(output.replyAr || (llmResult.textBlockAr?.trim()) || "تم تسجيل متطلبات البحث بنجاح.");
        output = {
          type: "answer_question",
          answerAr: finalContentAr,
        } as any;
      }
    } else if (output.type === "ask_clarification" || output.type === "ask_questions") {
      await saveConversationBrief(this.tables, conversationId, userId, brief);
      const clarification = buildClarificationPresentation(output as any, {
        capabilities: allCapabilities,
        userBalancePoints: userBalance,
        persona: userProfile?.persona,
        userMessage: message,
      });
      clarificationItemsList = filterQuestionsAlreadyInBrief(clarification.clarificationItems, brief);
      clarificationQuestionsList = clarificationItemsList.map((item) => item.text);
      if (clarificationItemsList.length > 0) {
        finalContentAr = deduplicateIntroText(
          (llmResult.textBlockAr && llmResult.textBlockAr.trim().length > 0)
            ? llmResult.textBlockAr
            : clarification.contentAr,
        );
      } else if (!userComplained) {
        clarificationItemsList = clarification.clarificationItems;
        clarificationQuestionsList = clarification.clarificationQuestions;
        finalContentAr = deduplicateIntroText(
          (llmResult.textBlockAr && llmResult.textBlockAr.trim().length > 0)
            ? llmResult.textBlockAr
            : clarification.contentAr,
        );
      } else {
        clarificationItemsList = undefined;
        clarificationQuestionsList = undefined;
        finalContentAr = "تم تسجيل متطلبات البحث بنجاح، جاري إعداد الخطة المناسبة.";
        output = {
          type: "answer_question",
          answerAr: finalContentAr,
        } as any;
      }
    } else if (output.type === "answer_question") {
      await saveConversationBrief(this.tables, conversationId, userId, brief);
      finalContentAr = output.answerAr;
    } else if (output.type === "write_note") {
      await saveConversationBrief(this.tables, conversationId, userId, brief);
      finalContentAr = `${output.titleAr}\n\n${output.contentAr}`;
    } else if (output.type === "propose_plan") {
      await saveConversationBrief(this.tables, conversationId, userId, brief);
      const mapPlanItems = (out: any) =>
        ((out as any).capabilities || (out as any).steps || []).map((c: any) => ({
          stepId: c.stepId,
          capabilitySlug: c.capabilitySlug || c.endpointId,
          endpointId: c.endpointId || c.capabilitySlug,
          paginationStrategy: c.paginationStrategy,
          params: c.params,
          targetVolumeMin: c.targetVolumeMin || 1,
          targetVolumeMax: c.targetVolumeMax,
        }));

      let planOutput: any = output;
      let planItems = mapPlanItems(planOutput);

      // Deterministic check: platform mentioned by user must match platform in proposed plan
      let platformCheck = validatePlanPlatformMatch(message, planItems, validationCaps);
      let planValidation = platformCheck.valid
        ? validatePlanAgainstLiveCatalog(planItems, turnEndpoints, allCapabilities)
        : { valid: false, errors: [] as string[], issues: [] as LiveCatalogIssue[] };

      let planRetries = 0;
      while (platformCheck.valid && !planValidation.valid && planRetries < 3) {
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

      if (!platformCheck.valid) {
        const closest = getClosestVerifiedCapability(capabilities);
        console.warn("[chat:platform_check_invalid]", { message, planItems });
        finalContentAr = `${UNVERIFIED_PLATFORM_MESSAGE_AR}. أقرب خدمة متاحة: ${closest.nameAr}.`;
      } else if (!planValidation.valid || !planOutput) {
        if (userComplained) {
          const matchedPlatform = brief.platforms[0] || "facebook";
          finalContentAr = `أقوم بمراجعة وتعديل خطة جمع البيانات لمنصة ${getPlatformLabelAr(matchedPlatform)} حسب طلبك (${brief.topics.join("، ")}).`;
          output = {
            type: "answer_question",
            answerAr: finalContentAr,
          } as any;
        } else {
          console.warn("[chat:plan_validation_invalid]", { errors: planValidation.errors });
          const planFallback = buildCodeDiscoveryFallback(allCapabilities);
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
        }
      } else {
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

          let planSummaryText = `أعددت لك خطة الاستخراج وعرض السعر بالنقاط:\n• الهدف: ${planOutput.summaryAr}\n• الحد الأقصى: حتى ${managedQuote.targetVolumeMax} سجل\n• التكلفة: ${managedQuote.quotedPoints} نقطة`;
          if (managedQuote.capacityConstrained) {
            planSummaryText += `\n• تنبيه السعة: تم ضبط الحد الأقصى عند ${managedQuote.targetVolumeMax} سجل لضمان دقة وسرعة التنفيذ المباشر.`;
          }
          if (!managedQuote.isAffordable) {
            planSummaryText += `\n• تنبيه: رصيدك الحالي (${userBalance} نقطة) لا يكفي لتغطية كامل العرض.`;
            if (managedQuote.downscaledOffer) {
              planSummaryText += `\n• اقتراح مخفض: يمكننا جمع حتى ${managedQuote.downscaledOffer.maxAffordableUnits} سجل مقابل ${managedQuote.downscaledOffer.affordableQuotedPoints} نقطة تناسب رصيدك الحالي.`;
            }
          }
          finalContentAr = (llmResult.textBlockAr && llmResult.textBlockAr.trim().length > 0 && !planSummaryText.includes(llmResult.textBlockAr))
            ? `${llmResult.textBlockAr}\n\n${planSummaryText}`
            : planSummaryText;
        }
    } else if (output.type === "edit_plan") {
      let activeQuote: any = null;
      try {
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
    } else if (output.type === "refuse") {
      finalContentAr = output.reasonAr;
    } else if (output.type === "edit_artifact") {
      finalContentAr = `تم تطبيق التعديل التحريري المطلق: ${output.reasonAr}`;
    }

    // 9. Update Assistant Message to 'ready' (Progressive streaming event triggers via Appwrite Realtime)
    finalContentAr = deduplicateIntroText(finalContentAr);
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

    // 10. Record Token Usage & Stats in llm_usage (Server-only).
    // Linked to the assistant message id for per-message cost pricing.
    // Logging must never block the reply: failures are swallowed.
    try {
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
    } catch (usageErr) {
      console.warn("[llm:USAGE_LOG_FAILED]", (usageErr as any)?.message || usageErr);
    }
    await logProviderCost(this.tables, {
      provider: "llm",
      units: (llmResult.inputTokens || 0) + (llmResult.outputTokens || 0),
      costUsd: llmResult.costUsd || 0,
    });

    // 11. Update Conversation Stats
    const newTotalTokens = totalConvTokens + llmResult.inputTokens + llmResult.outputTokens;
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

    const totalLatencyMs = Date.now() - turnStartTime;
    console.log(
      `[chat:turn] conversationId=${conversationId} messageId=${assistantMsgId} modelCalls=${modelCallCount} catalogSearches=${catalogSearchCount} latencyMs=${totalLatencyMs}`,
    );

    return {
      conversationId,
      messageId: assistantMsgId,
      role: "assistant",
      contentAr: finalContentAr,
      outputType: output.type,
      planQuote: planQuoteData,
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
      },
    };
  }
}
