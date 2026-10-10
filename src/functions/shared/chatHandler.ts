import { TablesDB, ID, Query } from "node-appwrite";
import { LlmClient, LlmTurnOutput } from "./llmClient";
import {
  getEnabledCapabilities,
  sanitizeCapabilitiesForLlm,
  validateCapabilityParams,
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
  parseStoredPlan,
  PlanState,
} from "./planManager";
import { getBalance } from "./ledger";
import {
  normalizeClarificationQuestions,
  sanitizeClarificationText,
  type NormalizedClarificationQuestion,
} from "./clarification";

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
  suggestedAlternative?: any;
  refusalReason?: string;
  tokensUsed: {
    input: number;
    output: number;
    costUsd: number;
  };
}

export function buildClarificationPresentation(
  output: Extract<LlmTurnOutput, { type: "ask_clarification" }>,
  context: { capabilities?: Capability[]; userBalancePoints?: number; persona?: string } = {},
) {
  const clarificationItems = normalizeClarificationQuestions(output, {
    capabilities: context.capabilities ?? [],
    userBalancePoints: context.userBalancePoints,
    persona: context.persona,
  });
  const clarificationQuestions = clarificationItems.map((item) => item.text);
  const intro = sanitizeClarificationText(
    output.intro || output.reasonAr || "قبل ما أجهز الخطة، جاوبني على الأسئلة دي:",
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
    const capabilities = await getEnabledCapabilities(this.tables);
    const sanitizedCaps = sanitizeCapabilitiesForLlm(capabilities);

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

    const messagesContext = historyRes.rows.map((r: any) => ({
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

    let llmResult = await this.llm.executeTurn({
      messages: messagesContext,
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
      conversationState: {
        isFirstUserTurn: messagesContext.filter((message) => message.role === "user").length <= 1,
      },
      conversationId,
      userId,
      totalConversationTokens: totalConvTokens,
      testScenario,
    });

    const output = llmResult.output;
    let finalContentAr = "";
    let planQuoteData: any = undefined;
    let clarificationQuestionsList: string[] | undefined = undefined;
    let clarificationItemsList: NormalizedClarificationQuestion[] | undefined = undefined;

    // 8. Process Output Actions
    if (output.type === "ask_clarification") {
      const clarification = buildClarificationPresentation(output, {
        capabilities,
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
      const planItems = output.capabilities.map((c) => ({
        stepId: c.stepId,
        capabilitySlug: c.capabilitySlug,
        params: c.params,
        targetVolumeMin: c.targetVolumeMin,
        targetVolumeMax: c.targetVolumeMax,
        dependsOn: c.dependsOn,
        inputFrom: c.inputFrom,
        fanOutCap: c.fanOutCap,
        volumeMode: c.volumeMode,
        windowed: c.windowed,
      }));

      const planValidation = validatePlanAgainstSchemas(planItems, capabilities);
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
            executionOptions: output.executionOptions,
            outputSpec: output.outputSpec,
            methodologyNotes: output.methodologyNotes,
          },
          userBalance: userBalance ?? 0,
          capabilities,
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
          isDependent: managedQuote.isDependent,
          stepCostRanges: managedQuote.stepCostRanges,
          expiresAt: managedQuote.expiresAt,
          methodologyNotes: output.methodologyNotes,
        };

        finalContentAr = `أعددت لك خطة الاستخراج وعرض السعر بالنقاط:\n• الهدف: ${output.summaryAr}\n• الحد الأقصى: حتى ${managedQuote.targetVolumeMax} سجل\n• التكلفة: ${managedQuote.quotedPoints} نقطة`;
        if (managedQuote.isDependent && managedQuote.stepCostRanges) {
          finalContentAr += "\n• الخطة متعددة المراحل؛ حُسب الحجز على الحد الأعلى لكل مرحلة:";
          for (const range of managedQuote.stepCostRanges) {
            const label = capabilities.find((capability) => capability.slug === range.capabilitySlug)?.nameAr || range.capabilitySlug;
            finalContentAr += `\n  • ${label}: من ${range.minPoints} إلى ${range.maxPoints} نقطة، حتى ${range.maxUnits} وحدة`;
          }
        }
        if (!managedQuote.isAffordable) {
          finalContentAr += `\n• تنبيه: رصيدك الحالي (${userBalance} نقطة) لا يكفي لتغطية كامل العرض.`;
          if (managedQuote.downscaledOffer) {
            finalContentAr += `\n• اقتراح مخفض: يمكننا جمع حتى ${managedQuote.downscaledOffer.maxAffordableUnits} سجل مقابل ${managedQuote.downscaledOffer.affordableQuotedPoints} نقطة تناسب رصيدك الحالي.`;
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
          const storedPlan = parseStoredPlan(activeQuote.itemsJson);
          const currentPlan: PlanState = {
            ...storedPlan,
            summaryAr: activeQuote.summaryAr || storedPlan.summaryAr,
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
              capabilities,
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
              isDependent: managedQuote.isDependent,
              stepCostRanges: managedQuote.stepCostRanges,
              expiresAt: managedQuote.expiresAt,
            };

            finalContentAr = `تم تعديل الخطة وتحديث عرض السعر بالنقاط:\n• الهدف: ${managedQuote.summaryAr}\n• الحد الأقصى: حتى ${managedQuote.targetVolumeMax} سجل\n• التكلفة المحدثة: ${managedQuote.quotedPoints} نقطة`;
            if (managedQuote.isDependent && managedQuote.stepCostRanges) {
              finalContentAr += "\n• الخطة متعددة المراحل؛ حُسب الحجز على الحد الأعلى لكل مرحلة:";
              for (const range of managedQuote.stepCostRanges) {
                const label = capabilities.find((capability) => capability.slug === range.capabilitySlug)?.nameAr || range.capabilitySlug;
                finalContentAr += `\n  • ${label}: من ${range.minPoints} إلى ${range.maxPoints} نقطة، حتى ${range.maxUnits} وحدة`;
              }
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
      finalContentAr = output.explanationAr;
      if (output.closestAlternative) {
        finalContentAr += `\n\n${output.closestAlternative}`;
      }

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
    try {
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
    } catch {
      console.warn("[llm:USAGE_STORAGE_UNAVAILABLE]");
    }

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
