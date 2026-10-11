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
  PlanState,
} from "./planManager";
import { getBalance } from "./ledger";
import {
  normalizeClarificationQuestions,
  sanitizeClarificationText,
  type NormalizedClarificationQuestion,
} from "./clarification";
import { searchCatalog, CatalogEndpointSummary } from "./catalogClient";

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
export function buildCodeDiscoveryFallback(
  allCapabilities: Capability[],
): { intro: string; items: NormalizedClarificationQuestion[] } {
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
  const intro = "عشان أجهز لك خطة دقيقة، محتاج أعرف:";
  const items: NormalizedClarificationQuestion[] = [
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
      type: "free",
      options: [],
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

export function buildClarificationPresentation(
  output: Extract<LlmTurnOutput, { type: "ask_clarification" }>,
  context: { capabilities?: Capability[]; userBalancePoints?: number; persona?: string } = {},
) {
  // PR #3 trust boundary (release port): questions are normalized against the
  // enabled capabilities only — platform questions with no enabled backing
  // capability are dropped rather than offered as phantom choices.
  const clarificationItems = normalizeClarificationQuestions(output, {
    capabilities: context.capabilities ?? [],
    userBalancePoints: context.userBalancePoints,
    persona: context.persona,
  });
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

    // 5. Fetch Capabilities and Sanitize for LLM (R1: zero leaks)
    const [capabilities, catalogCapabilities] = await Promise.all([
      getEnabledCapabilities(this.tables),
      getCatalogCapabilities(this.tables),
    ]);

    // Live catalog access (Phase A & B)
    const mentionedPlatforms = detectMentionedPlatforms(message);
    const platformHint = mentionedPlatforms[0] || undefined;
    const liveCatalogEndpoints = await searchCatalog(message, platformHint);

    const dynamicCapabilities: Capability[] = liveCatalogEndpoints.map((ep) => ({
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
    }));

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
    const repeatTurn = async () => {
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
      const searchRes = await searchCatalog(output.query, output.platform);
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
    const fallbackToDiscovery = () => {
      const fallback = buildCodeDiscoveryFallback(allCapabilities);
      clarificationQuestionsList = fallback.items.map((item) => item.text);
      clarificationItemsList = fallback.items;
      finalContentAr = fallback.intro;
    };

    // 8. Process Output Actions
    const stalledAnswerText =
      output.type === "answer_question" ? (((output as any).answerAr || "") as string).trim() : "";
    if (output.type === "search_catalog" || (output.type === "answer_question" && !stalledAnswerText)) {
      // The model stalled even after the catalog loop + one explicit retry.
      // Fall back to code-built discovery questions — never the raw catalog list.
      fallbackToDiscovery();
    } else if (output.type === "ask_clarification" || output.type === "ask_questions") {
      const clarification = buildClarificationPresentation(output as any, {
        capabilities: allCapabilities,
        userBalancePoints: userBalance,
        persona: userProfile?.persona,
      });
      clarificationQuestionsList = clarification.clarificationQuestions;
      clarificationItemsList = clarification.clarificationItems;
      finalContentAr = clarification.contentAr;
    } else if (output.type === "answer_question") {
      finalContentAr = output.answerAr;
    } else if (output.type === "write_note") {
      finalContentAr = `${output.titleAr}\n\n${output.contentAr}`;
    } else if (output.type === "propose_plan") {
      const rawCaps = (output as any).capabilities || (output as any).steps || [];
      const planItems = rawCaps.map((c: any) => ({
        stepId: c.stepId,
        capabilitySlug: c.capabilitySlug || c.endpointId,
        endpointId: c.endpointId || c.capabilitySlug,
        paginationStrategy: c.paginationStrategy,
        params: c.params,
        targetVolumeMin: c.targetVolumeMin || 1,
        targetVolumeMax: c.targetVolumeMax,
      }));

      // Deterministic check: platform mentioned by user must match platform in proposed plan
      const platformCheck = validatePlanPlatformMatch(message, planItems, allCatalogCapabilities);
      if (!platformCheck.valid) {
        const closest = getClosestVerifiedCapability(capabilities);
        finalContentAr = `${platformCheck.errorAr || UNVERIFIED_PLATFORM_MESSAGE_AR}\n\nأقرب خدمة معتمدة متاحة حالياً: ${closest.nameAr}.`;
      } else {
        const planValidation = validatePlanAgainstSchemas(planItems, allCapabilities);
        if (!planValidation.valid) {
          finalContentAr = `يرجى تدقيق المدخلات: ${planValidation.errors.join(", ")}`;
        } else {
          const managedQuote = await createAndSaveManagedQuote(this.tables, {
            conversationId,
            userId,
            plan: {
              summaryAr: output.summaryAr,
              items: planItems,
              outputFormats: (output.outputFormats as any) || ["xlsx", "pdf", "csv"],
              methodologyNotes: output.methodologyNotes,
            },
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
            outputFormats: managedQuote.outputFormats,
            expiresAt: managedQuote.expiresAt,
            methodologyNotes: output.methodologyNotes,
          };

          finalContentAr = `أعددت لك خطة الاستخراج وعرض السعر بالنقاط:\n• الهدف: ${output.summaryAr}\n• الحد الأقصى: حتى ${managedQuote.targetVolumeMax} سجل\n• التكلفة: ${managedQuote.quotedPoints} نقطة`;
          if (!managedQuote.isAffordable) {
            finalContentAr += `\n• تنبيه: رصيدك الحالي (${userBalance} نقطة) لا يكفي لتغطية كامل العرض.`;
            if (managedQuote.downscaledOffer) {
              finalContentAr += `\n• اقتراح مخفض: يمكننا جمع حتى ${managedQuote.downscaledOffer.maxAffordableUnits} سجل مقابل ${managedQuote.downscaledOffer.affordableQuotedPoints} نقطة تناسب رصيدك الحالي.`;
            }
          }
        }
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
              outputFormats: managedQuote.outputFormats,
              expiresAt: managedQuote.expiresAt,
            };

            finalContentAr = `تم تعديل الخطة وتحديث عرض السعر بالنقاط:\n• الهدف: ${managedQuote.summaryAr}\n• الحد الأقصى: حتى ${managedQuote.targetVolumeMax} سجل\n• التكلفة المحدثة: ${managedQuote.quotedPoints} نقطة`;
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
      const baseExplanation = output.explanationAr.includes(UNVERIFIED_PLATFORM_MESSAGE_AR)
        ? output.explanationAr
        : `${UNVERIFIED_PLATFORM_MESSAGE_AR} (${output.unsupportedService}). ${output.explanationAr}`;
      const closestText = output.closestAlternative || `أقرب خدمة معتمدة متاحة حالياً: ${closest.nameAr}.`;
      finalContentAr = `${baseExplanation}\n\n${closestText}`;

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

    // 10. Record Token Usage & Stats in llm_usage (Server-only)
    await this.tables.createRow({
      databaseId: "digr",
      tableId: "llm_usage",
      rowId: ID.unique(),
      data: {
        conversationId,
        userId,
        model: llmResult.model,
        inputTokens: llmResult.inputTokens,
        outputTokens: llmResult.outputTokens,
        costUsd: Number(llmResult.costUsd.toFixed(6)),
        createdAt: new Date().toISOString(),
      },
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
    };
  }
}
