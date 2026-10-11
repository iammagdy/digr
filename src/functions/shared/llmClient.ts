import { z } from "zod";
import { buildSystemPrompt, PROMPT_VERSION } from "./systemPrompt";

// ================= Schema Definitions =================

export const ClarificationQuestionItemSchema = z.object({
  id: z.string().optional(),
  question: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  type: z.enum(["single", "multi", "free"]).optional(),
  parameterType: z.enum(["platform", "time_window", "volume", "output_format", "anonymize", "language", "topic"]).optional(),
  options: z.array(z.string().trim().min(1).max(40)).max(4).optional(),
  allowOther: z.boolean().optional(),
  defaultOption: z.string().optional(),
}).strict();

export const AskClarificationSchema = z.object({
  type: z.literal("ask_clarification"),
  intro: z.string().optional(),
  questions: z.array(ClarificationQuestionItemSchema).min(1).max(3).optional(),
  questionsAr: z.array(z.string().trim().min(1)).min(1).max(3).optional(),
  optionsAr: z.array(z.array(z.string().trim().min(1).max(40)).max(4)).max(3).optional(),
  reasonAr: z.string().min(1),
}).strict();

export const PlanCapabilityItemSchema = z.object({
  stepId: z.string().optional(),
  capabilitySlug: z.string().min(1),
  params: z.record(z.string(), z.any()),
  targetVolumeMin: z.number().int().min(1),
  targetVolumeMax: z.number().int().min(1),
  volumeMode: z.enum(["bounded", "open_ended"]).optional(),
  dependsOn: z.array(z.string()).optional(),
  inputFrom: z
    .object({
      stepId: z.string(),
      field: z.string(),
      paramKey: z.string(),
    })
    .optional(),
  fanOutCap: z.number().int().min(1).max(50).optional(),
  windowed: z.boolean().optional(),
});

export const ExecutionOptionsSchema = z.object({
  windowing: z.enum(["none", "per_day", "per_week", "per_month"]).default("none"),
  windowFrom: z.string().optional(),
  windowTo: z.string().optional(),
  includeReplies: z.boolean().default(false),
  dedupe: z.boolean().default(true),
  languageFilter: z.string().optional(),
  anonymize: z.boolean().default(false),
  qualityReport: z.boolean().default(true),
});

export const OutputColumnSchema = z.object({
  field: z.string().min(1),
  headerAr: z.string().min(1),
});

export const OutputSheetSchema = z.object({
  name: z.string().min(1),
  sourceDataset: z.string().optional(),
  columns: z.array(OutputColumnSchema).min(1),
  sort: z.object({ field: z.string(), order: z.enum(["asc", "desc"]) }).optional(),
  filter: z.record(z.string(), z.any()).optional(),
});

export const OutputSpecSchema = z.object({
  sheets: z.array(OutputSheetSchema).min(1).optional(),
  formats: z.array(z.enum(["xlsx", "pdf", "csv"])).default(["xlsx", "pdf", "csv"]),
});

export const ProposePlanSchema = z.object({
  type: z.literal("propose_plan"),
  summaryAr: z.string().min(1),
  capabilities: z.array(PlanCapabilityItemSchema).min(1),
  executionOptions: ExecutionOptionsSchema.optional(),
  outputSpec: OutputSpecSchema.optional(),
  outputFormats: z.array(z.enum(["xlsx", "pdf", "csv"])).default(["xlsx", "pdf", "csv"]),
  methodologyNotes: z.string().default("تجميع وتوثيق البيانات العامة وفق المعايير البحثية المعتمدة"),
  rationaleAr: z.string().optional(),
});

export const SafeComputeColumnParamsSchema = z.object({
  targetColumnName: z.string().min(1),
  operation: z.enum(["sum", "ratio", "concat", "date_part", "format_number"]),
  sourceColumns: z.array(z.string().min(1)).min(1),
  parameters: z
    .object({
      delimiter: z.string().optional(),
      dateFieldPart: z.enum(["year", "month", "day"]).optional(),
      numberDecimals: z.number().int().min(0).max(6).optional(),
    })
    .optional(),
});

export const EditArtifactSchema = z.object({
  type: z.literal("edit_artifact"),
  target: z.string().optional(),
  action: z.enum([
    "filter",
    "sort",
    "select_columns",
    "rename_column",
    "compute_column",
    "dedupe",
    "update_notes",
  ]),
  parameters: z.record(z.string(), z.any()),
  reasonAr: z.string().min(1),
});

export const WriteNoteSchema = z.object({
  type: z.literal("write_note"),
  titleAr: z.string().min(1),
  contentAr: z.string().min(1),
});

export const AnswerQuestionSchema = z.object({
  type: z.literal("answer_question"),
  answerAr: z.string().min(1),
  topic: z.string().optional(),
});

export const RefuseSchema = z.object({
  type: z.literal("refuse"),
  reasonAr: z.string().min(1),
  alternativeAr: z.string().optional(),
});

export const SuggestAlternativeSchema = z.object({
  type: z.literal("suggest_alternative"),
  unsupportedService: z.string().min(1),
  explanationAr: z.string().min(1),
  closestAlternative: z.string().optional(),
  canRequestFeature: z.literal(true).default(true),
});

export const EditPlanToolSchema = z.object({
  type: z.literal("edit_plan"),
  operations: z.array(
    z.discriminatedUnion("action", [
      z.object({
        action: z.literal("set_param"),
        capabilitySlug: z.string().min(1),
        key: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      }),
      z.object({
        action: z.literal("set_limit"),
        capabilitySlug: z.string().min(1),
        targetVolumeMax: z.number().int().min(1).max(5000),
      }),
      z.object({
        action: z.literal("set_formats"),
        formats: z.array(z.enum(["xlsx", "pdf", "csv"])).min(1),
      }),
      z.object({
        action: z.literal("set_execution_option"),
        option: z.enum([
          "windowing",
          "windowFrom",
          "windowTo",
          "includeReplies",
          "dedupe",
          "languageFilter",
          "anonymize",
          "qualityReport",
        ]),
        value: z.union([z.string(), z.boolean(), z.number()]),
      }),
      z.object({
        action: z.literal("add_capability"),
        capabilitySlug: z.string().min(1),
        params: z.record(z.string(), z.any()),
        targetVolumeMax: z.number().int().min(1).max(5000),
      }),
      z.object({
        action: z.literal("remove_capability"),
        capabilitySlug: z.string().min(1),
      }),
    ])
  ).min(1),
  reasonAr: z.string().min(1),
});

export const LlmTurnOutputSchema = z.discriminatedUnion("type", [
  AskClarificationSchema,
  ProposePlanSchema,
  EditPlanToolSchema,
  EditArtifactSchema,
  WriteNoteSchema,
  AnswerQuestionSchema,
  RefuseSchema,
  SuggestAlternativeSchema,
]);

export type LlmTurnOutput = z.infer<typeof LlmTurnOutputSchema>;

export type LlmProviderType = "fake" | "openai" | "anthropic";

export interface LlmModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}

export const DEFAULT_LLM_PRICING: Record<string, LlmModelPricing> = {
  "claude-haiku-5-5": { inputCostPerMillion: 0.80, outputCostPerMillion: 4.00 },
  "claude-3-5-haiku-20241022": { inputCostPerMillion: 0.80, outputCostPerMillion: 4.00 },
  "claude-3-haiku-20240307": { inputCostPerMillion: 0.25, outputCostPerMillion: 1.25 },
  "gpt-6-luna": { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 },
  "gpt-4o-mini": { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 },
  "gpt-4o": { inputCostPerMillion: 2.50, outputCostPerMillion: 10.00 },
  "fake": { inputCostPerMillion: 0.10, outputCostPerMillion: 0.50 },
};

export function getLlmPricingSettings(
  provider: LlmProviderType,
  model: string,
  customSettings?: Partial<LlmModelPricing>
): LlmModelPricing {
  if (customSettings?.inputCostPerMillion !== undefined && customSettings?.outputCostPerMillion !== undefined) {
    return {
      inputCostPerMillion: customSettings.inputCostPerMillion,
      outputCostPerMillion: customSettings.outputCostPerMillion,
    };
  }

  const envInput =
    provider === "anthropic"
      ? process.env.ANTHROPIC_INPUT_COST_PER_MILLION || process.env.LLM_INPUT_COST_PER_MILLION
      : process.env.OPENAI_INPUT_COST_PER_MILLION || process.env.LLM_INPUT_COST_PER_MILLION;

  const envOutput =
    provider === "anthropic"
      ? process.env.ANTHROPIC_OUTPUT_COST_PER_MILLION || process.env.LLM_OUTPUT_COST_PER_MILLION
      : process.env.OPENAI_OUTPUT_COST_PER_MILLION || process.env.LLM_OUTPUT_COST_PER_MILLION;

  const fallback = DEFAULT_LLM_PRICING[model] || (
    provider === "anthropic"
      ? { inputCostPerMillion: 0.80, outputCostPerMillion: 4.00 }
      : provider === "openai"
      ? { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 }
      : { inputCostPerMillion: 0.10, outputCostPerMillion: 0.50 }
  );

  return {
    inputCostPerMillion: envInput ? parseFloat(envInput) : (customSettings?.inputCostPerMillion ?? fallback.inputCostPerMillion),
    outputCostPerMillion: envOutput ? parseFloat(envOutput) : (customSettings?.outputCostPerMillion ?? fallback.outputCostPerMillion),
  };
}

export interface LlmCallOptions {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  sanitizedCapabilities: any[];
  userProfile?: {
    persona?: string;
    purposes?: string[];
    topic?: string;
  };
  todayDate?: string;
  userBalancePoints?: number;
  conversationState?: any;
  conversationId?: string;
  userId?: string;
  totalConversationTokens?: number;
  testScenario?: string;
  pricingSettings?: Partial<LlmModelPricing>;
}

export interface LlmCallResult {
  output: LlmTurnOutput;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  promptVersion?: string;
  rawText?: string;
}

// ================= White-Label Scrubber =================

const FORBIDDEN_WORDS = [
  /openai/gi,
  /chatgpt/gi,
  /anthropic/gi,
  /claude/gi,
  /gpt-4/gi,
  /gpt-5/gi,
  /gpt-6/gi,
  /treg/gi,
  /tikhub/gi,
  /serpapi/gi,
  /twitter\.com\/i\/api/gi,
];

export function scrubWhiteLabelText(text: string): string {
  let cleaned = text;
  for (const regex of FORBIDDEN_WORDS) {
    cleaned = cleaned.replace(regex, "منصة Digr");
  }
  return cleaned;
}

export function sanitizeMessagesForAnthropic(
  messages: Array<{ role: string; content: string }>
): Array<{ role: "user" | "assistant"; content: string }> {
  const filtered = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content || "" }));

  if (filtered.length === 0) {
    return [{ role: "user", content: "مرحباً" }];
  }

  const combined: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const msg of filtered) {
    const last = combined[combined.length - 1];
    if (last && last.role === msg.role) {
      last.content += `\n\n${msg.content}`;
    } else {
      combined.push({ role: msg.role, content: msg.content });
    }
  }

  if (combined.length > 0 && combined[0].role !== "user") {
    combined.unshift({ role: "user", content: "مرحباً" });
  }

  return combined;
}

export const ACTION_RESULT_JSON_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [
        "ask_clarification",
        "propose_plan",
        "edit_plan",
        "edit_artifact",
        "write_note",
        "suggest_alternative",
        "answer_question",
        "refuse",
      ],
    },
    questionsAr: { type: "array", maxItems: 3, items: { type: "string" } },
    questions: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            maxItems: 4,
            items: { type: "string", maxLength: 40 },
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    reasonAr: { type: "string" },
    summaryAr: { type: "string" },
    answerAr: { type: "string" },
    titleAr: { type: "string" },
    contentAr: { type: "string" },
    unsupportedService: { type: "string" },
    explanationAr: { type: "string" },
    closestAlternative: { type: "string" },
    canRequestFeature: { type: "boolean" },
    capabilities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          capabilitySlug: { type: "string" },
          params: { type: "object", additionalProperties: true },
          targetVolumeMin: { type: "integer" },
          targetVolumeMax: { type: "integer" },
        },
        required: ["capabilitySlug", "params", "targetVolumeMin", "targetVolumeMax"],
        additionalProperties: false,
      },
    },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string" },
          capabilitySlug: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
          targetVolumeMax: { type: "integer" },
          formats: { type: "array", items: { type: "string" } },
          params: { type: "object", additionalProperties: true },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    outputFormats: {
      type: "array",
      items: { type: "string" },
    },
    methodologyNotes: { type: "string" },
    rationaleAr: { type: "string" },
  },
  required: ["type"],
  additionalProperties: false,
};

// ================= LLM Runtime Diagnostics & Status =================

export interface LlmStatusSnapshot {
  provider: LlmProviderType;
  llm_enabled: boolean;
  key_present: boolean;
  model: string;
  last_llm_usage_timestamp: string | null;
  last_fallback_reason: string | null;
}

let lastFallbackReason: string | null = null;

export function getLastLlmFallbackReason(): string | null {
  return lastFallbackReason;
}

export function setLastLlmFallbackReason(reason: string | null): void {
  lastFallbackReason = reason;
}

export function resolveRuntimeProvider(override?: LlmProviderType): LlmProviderType {
  const raw = (override || process.env.LLM_PROVIDER || "fake").trim().toLowerCase();
  if (raw === "anthropic" || raw === "openai" || raw === "fake") {
    return raw;
  }
  return "fake";
}

export function resolveRuntimeModel(provider: LlmProviderType, override?: string): string {
  if (override && override.trim()) return override.trim();
  if (provider === "anthropic") {
    return (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim();
  }
  if (provider === "openai") {
    return (process.env.OPENAI_MODEL || process.env.LLM_MODEL || "gpt-6-luna").trim();
  }
  return (process.env.LLM_MODEL || "fake").trim();
}

export function isLlmEnabledRuntime(): boolean {
  const raw = (process.env.LLM_ENABLED || "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

export function isProviderKeyPresent(provider: LlmProviderType): boolean {
  if (provider === "anthropic") {
    return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim().length > 0);
  }
  if (provider === "openai") {
    return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
  }
  return false;
}

export function getLlmStatusSnapshot(lastUsageTimestamp: string | null = null): LlmStatusSnapshot {
  const provider = resolveRuntimeProvider();
  const llm_enabled = isLlmEnabledRuntime();
  const key_present = isProviderKeyPresent(provider);
  const model = resolveRuntimeModel(provider);

  let derivedFallback = lastFallbackReason;
  if (!derivedFallback) {
    if (!llm_enabled) {
      derivedFallback = "llm_disabled";
    } else if (provider === "fake") {
      derivedFallback = "provider_is_fake";
    } else if (!key_present) {
      derivedFallback = "missing_key";
    }
  }

  return {
    provider,
    llm_enabled,
    key_present,
    model,
    last_llm_usage_timestamp: lastUsageTimestamp,
    last_fallback_reason: derivedFallback,
  };
}

// ================= LLM Client Implementation =================

export class LlmClient {
  private providerOverride?: LlmProviderType;
  private modelOverride?: string;
  private isLiveOverride?: boolean;
  private customPricing?: Partial<LlmModelPricing>;

  constructor(options?: {
    provider?: LlmProviderType;
    model?: string;
    isLive?: boolean;
    pricingSettings?: Partial<LlmModelPricing>;
  }) {
    this.providerOverride = options?.provider;
    this.modelOverride = options?.model;
    this.isLiveOverride = options?.isLive;
    this.customPricing = options?.pricingSettings;
  }

  getProvider(): LlmProviderType {
    return resolveRuntimeProvider(this.providerOverride);
  }

  getModel(): string {
    return resolveRuntimeModel(this.getProvider(), this.modelOverride);
  }

  /**
   * Main interaction point with budget enforcement & schema validation
   */
  async executeTurn(options: LlmCallOptions): Promise<LlmCallResult> {
    const provider = this.getProvider();
    const model = this.getModel();

    // 1. Kill-switch check
    if (!isLlmEnabledRuntime()) {
      setLastLlmFallbackReason("llm_disabled");
      return {
        output: {
          type: "refuse",
          reasonAr: "خدمة المساعد الذكي معطلة مؤقتاً للصيانة. يرجى المحاولة في وقت لاحق.",
        },
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        model,
        promptVersion: PROMPT_VERSION,
      };
    }

    // 2. Budget limits check
    const convTokens = options.totalConversationTokens || 0;
    if (convTokens > 15000) {
      return {
        output: {
          type: "refuse",
          reasonAr: "تم بلوغ الحد الأقصى لسياق هذه المحادثة (15,000 توكن). يرجى بدء محادثة جديدة.",
        },
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        model,
        promptVersion: PROMPT_VERSION,
      };
    }

    // 3. Fake vs Live execution — read at runtime; real providers never silently fall back to fake
    if (options.testScenario) {
      setLastLlmFallbackReason("test_scenario");
      return this.executeFakeLlm(options);
    }

    if (this.isLiveOverride === false || (process.env.LLM_LIVE || "").trim().toLowerCase() === "false") {
      setLastLlmFallbackReason("llm_live_disabled");
      return this.executeFakeLlm(options);
    }

    if (provider === "fake") {
      setLastLlmFallbackReason("provider_is_fake");
      return this.executeFakeLlm(options);
    }

    if (provider === "anthropic") {
      return this.executeRealAnthropic(options);
    }

    return this.executeRealOpenAi(options);
  }

  /**
   * Deterministic Fake LLM for unit tests, offline development, and zero-cost simulation
   */
  private executeFakeLlm(options: LlmCallOptions): LlmCallResult {
    const fakeModel = this.modelOverride || "fake";
    const lastUserMsg = [...options.messages].reverse().find((m) => m.role === "user")?.content || "";
    const promptLower = lastUserMsg.toLowerCase();

    // A. Injection & Security Attacks detection
    if (
      promptLower.includes("ignore previous instructions") ||
      promptLower.includes("system prompt") ||
      promptLower.includes("api key") ||
      promptLower.includes("treg token") ||
      promptLower.includes("make price 0") ||
      promptLower.includes("<script>")
    ) {
      return {
        output: {
          type: "refuse",
          reasonAr: "عذراً، لا يمكنني الاستجابة لهذه التعليمات لمخالفتها معايير وسياسات المنصة.",
        },
        inputTokens: 450,
        outputTokens: 50,
        costUsd: (450 * 0.10 + 50 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // B. Refusals for private/illegal/doxxing data
    if (
      promptLower.includes("بطاقة ائتمان") ||
      promptLower.includes("بطاقات") ||
      promptLower.includes("اختراق") ||
      promptLower.includes("سري") ||
      promptLower.includes("هواتف") ||
      promptLower.includes("رقم هاتف") ||
      promptLower.includes("passwords")
    ) {
      return {
        output: {
          type: "refuse",
          reasonAr: "المنصة مخصصة لجمع البيانات العامة والمتاحة علناً فقط، ولا تدعم الوصول لأي بيانات خاصة أو سرية.",
        },
        inputTokens: 400,
        outputTokens: 40,
        costUsd: (400 * 0.10 + 40 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // C. General Platform & Product Questions (answer_question)
    if (
      promptLower.includes("كيف أشحن") ||
      promptLower.includes("طريقة الشحن") ||
      promptLower.includes("إنستاباي") ||
      promptLower.includes("instapay") ||
      promptLower.includes("ما هي digr") ||
      promptLower.includes("ما هي الملفات") ||
      promptLower.includes("كم يستغرق")
    ) {
      let answerText = "تتيح لك منصة Digr استخراج البيانات العامة وتوثيقها بملفات Excel وCSV وPDF موثقة بمنهجية كاملة.";
      if (promptLower.includes("شحن") || promptLower.includes("إنستاباي") || promptLower.includes("instapay")) {
        answerText = "يتم شحن الرصيد عبر إنستاباي (Instapay) من صفحة الرصيد. بعد التحويل ترفع إيصال المعاملة ويتم اعتماد النقاط فورياً لحسابك.";
      } else if (promptLower.includes("ملفات")) {
        answerText = "تحصل مع كل عملية استخراج على 3 ملفات جاهزة للتحميل: ملف Excel تفصيلي مع دليل البيانات والمنهجية، ملف CSV، وملف PDF موجز ومهيأ للطباعة والمراجعة السريعة.";
      }
      return {
        output: {
          type: "answer_question",
          answerAr: answerText,
          topic: "product_knowledge",
        },
        inputTokens: 450,
        outputTokens: 70,
        costUsd: (450 * 0.10 + 70 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // D0. Facebook multi-topic & discovery handling when Facebook capabilities are verified or for Facebook research queries
    const hasVerifiedFacebook =
      Array.isArray(options.sanitizedCapabilities) &&
      options.sanitizedCapabilities.length > 0 &&
      options.sanitizedCapabilities.some(
        (c: any) =>
          (c.slug === "facebook-post-comments" || c.slug === "facebook-post-search" || c.id === "facebook-post-comments" || c.id === "facebook-post-search") &&
          c.enabled !== false &&
          c.status !== "pending_verification" &&
          c.status !== "planned"
      );

    const isFacebookRequest = promptLower.includes("فيسبوك") || promptLower.includes("facebook");
    const isQaimatManqulat = promptLower.includes("قائمة المنقولات");
    const isLongMarriageTopicsRequest =
      (promptLower.includes("الزواج") || promptLower.includes("خطوبة") || promptLower.includes("مهر") || promptLower.includes("شبكة")) &&
      (promptLower.includes("يناير") || promptLower.includes("سبتمبر") || promptLower.includes("2026") || promptLower.includes("reels") || promptLower.includes("ريلز"));

    const hasCatalogCapabilities =
      Array.isArray(options.sanitizedCapabilities) && options.sanitizedCapabilities.length > 0;

    if (isFacebookRequest && (hasVerifiedFacebook || isLongMarriageTopicsRequest || (isQaimatManqulat && hasCatalogCapabilities))) {
      if (isLongMarriageTopicsRequest) {
        return {
          output: {
            type: "propose_plan",
            summaryAr:
              "خطة متعددة الخطوات لجمع منشورات وتعليقات فيسبوك حول موضوعات الزواج في الفترة من 1 يناير إلى 30 سبتمبر 2026 (البحث في المنشورات العامة ثم سحب التعليقات بحد أقصى محدد لكل منشور، مع توضيح أن مقاطع الريلز والفيديو غير المتاحة في الكتالوج المعتمد تُستثنى بصدق)",
            capabilities: [
              {
                stepId: "fb_posts_search",
                capabilitySlug: "facebook-post-search",
                params: {
                  query: "قائمة المنقولات، تكاليف الزواج، المهر، الشبكة، النفقة",
                  dateFrom: "2026-01-01",
                  dateTo: "2026-09-30",
                },
                targetVolumeMin: 1,
                targetVolumeMax: 5,
                volumeMode: "bounded",
              },
              {
                stepId: "fb_post_comments",
                capabilitySlug: "facebook-post-comments",
                params: {
                  includeReplies: true,
                },
                targetVolumeMin: 5,
                targetVolumeMax: 25,
                dependsOn: ["fb_posts_search"],
                inputFrom: {
                  stepId: "fb_posts_search",
                  field: "postUrl",
                  paramKey: "postUrl",
                },
                fanOutCap: 25,
                windowed: true,
              },
            ],
            outputFormats: ["xlsx", "pdf", "csv"],
            methodologyNotes:
              "يتم تقسيم الموضوعات المتعددة خلال الفترة من 2026-01-01 إلى 2026-09-30 إلى خطوة بحث في المنشورات العامة على فيسبوك تليها خطوة جلب التعليقات والردود بحد أقصى صريح لكل منشور. السعر النهائي بالنقاط يُحسب من الخادم فقط.",
          },
          inputTokens: 650,
          outputTokens: 140,
          costUsd: (650 * 0.10 + 140 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }

      return {
        output: {
          type: "ask_clarification",
          intro: "لتجهيز خطة جمع تعليقات فيسبوك حول قائمة المنقولات في مصر بدقة، يرجى تحديد الخيارات الأساسية التالية:",
          questions: [
            {
              id: "time_window",
              text: "ما الفترة الزمنية المطلوبة للمنشورات والتعليقات على فيسبوك؟",
              type: "single",
              parameterType: "time_window",
              options: ["آخر 30 يوماً", "آخر 3 أشهر", "من 1 يناير إلى 30 سبتمبر 2026", "فترة مخصصة"],
              allowOther: true,
              defaultOption: "آخر 30 يوماً",
            },
            {
              id: "volume",
              text: "ما الحد الأقصى لعدد المنشورات وعدد التعليقات لكل منشور؟",
              type: "single",
              parameterType: "volume",
              options: ["حتى 10 منشورات و50 تعليقاً للمنشور", "حتى 25 منشوراً و100 تعليق للمنشور", "حتى 50 منشوراً و100 تعليق للمنشور"],
              allowOther: true,
              defaultOption: "حتى 10 منشورات و50 تعليقاً للمنشور",
            },
          ],
          reasonAr: "تحديد الفترة الزمنية والحد الأقصى للمنشورات والتعليقات على فيسبوك قبل حساب عرض السعر من الخادم",
        },
        inputTokens: 520,
        outputTokens: 95,
        costUsd: (520 * 0.10 + 95 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // D. Unsupported / Pending-Verification Platforms & "Request this service" trigger
    if (
      promptLower.includes("انستغرام") ||
      promptLower.includes("إنستغرام") ||
      promptLower.includes("instagram") ||
      promptLower.includes("linkedin") ||
      promptLower.includes("لينكد إن") ||
      promptLower.includes("فيسبوك") ||
      promptLower.includes("facebook") ||
      promptLower.includes("ريديت") ||
      promptLower.includes("reddit")
    ) {
      const platformName =
        promptLower.includes("instagram") || promptLower.includes("انستغرام") || promptLower.includes("إنستغرام")
          ? "Instagram"
          : promptLower.includes("فيسبوك") || promptLower.includes("facebook")
          ? "Facebook"
          : promptLower.includes("ريديت") || promptLower.includes("reddit")
          ? "Reddit"
          : "LinkedIn";
      return {
        output: {
          type: "suggest_alternative",
          unsupportedService: platformName,
          explanationAr: `هذه المنصة قيد التجهيز وغير متاحة للتشغيل الآن (${platformName}).`,
          closestAlternative: "أقرب خدمة معتمدة متاحة حالياً: استخراج ملف حساب تيك توك العام (@username).",
          canRequestFeature: true,
        },
        inputTokens: 500,
        outputTokens: 80,
        costUsd: (500 * 0.10 + 80 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // E. Edit Artifact requests
    if (promptLower.includes("احذف عمود") || promptLower.includes("رتب") || promptLower.includes("فلتر")) {
      return {
        output: {
          type: "edit_artifact",
          action: "sort",
          parameters: { field: "followers", direction: "desc" },
          reasonAr: "ترتيب السجلات تنازلياً حسب عدد المتابعين",
        },
        inputTokens: 600,
        outputTokens: 60,
        costUsd: (600 * 0.10 + 60 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    const isCapEnabled = (slug: string) => {
      if (!options.sanitizedCapabilities || options.sanitizedCapabilities.length === 0) {
        return true;
      }
      return options.sanitizedCapabilities.some(
        (c: any) =>
          c.slug === slug &&
          c.enabled !== false &&
          c.status !== "pending_verification" &&
          c.status !== "planned"
      );
    };

    // F. TikTok requests handling
    if (promptLower.includes("تيك توك") || promptLower.includes("tiktok")) {
      const isVideoRequest =
        promptLower.includes("مقاطع") ||
        promptLower.includes("فيديو") ||
        promptLower.includes("منشورات") ||
        promptLower.includes("posts") ||
        promptLower.includes("videos");

      if (isVideoRequest && !isCapEnabled("tiktok-user-videos") && !isCapEnabled("tiktok-keyword-videos")) {
        return {
          output: {
            type: "suggest_alternative",
            unsupportedService: "مقاطع فيديو تيك توك",
            explanationAr: "خدمة استخراج مقاطع فيديو تيك توك قيد التحقق وستتاح قريباً في المنصة. الخدمة المعتمدة والمتاحة حالياً هي استخراج بيانات وإحصائيات ملف الحساب الشخصي (@username).",
            closestAlternative: "يمكنك استخراج بيانات الملف الشخصي لأي حساب عام على تيك توك (@username).",
            canRequestFeature: true,
          },
          inputTokens: 500,
          outputTokens: 80,
          costUsd: (500 * 0.10 + 80 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }

      if (isVideoRequest && isCapEnabled("tiktok-user-videos")) {
        const handleMatch = lastUserMsg.match(/@?([a-zA-Z0-9._]{2,30})/);
        const username = handleMatch && !["tiktok", "video", "videos"].includes(handleMatch[1].toLowerCase())
          ? handleMatch[1]
          : (lastUserMsg.includes("بي بي سي") ? "bbc" : "tiktok");

        return {
          output: {
            type: "propose_plan",
            summaryAr: `استخراج مقاطع فيديو تيك توك المنشورة من حساب @${username}`,
            capabilities: [
              {
                capabilitySlug: "tiktok-user-videos",
                params: { username },
                targetVolumeMin: 1,
                targetVolumeMax: 100,
              },
            ],
            outputFormats: ["xlsx", "pdf", "csv"],
            methodologyNotes: `استخراج مقاطع الفيديو العامة لحساب @${username}.`,
          },
          inputTokens: 800,
          outputTokens: 140,
          costUsd: (800 * 0.10 + 140 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }

      if (isCapEnabled("tiktok-profile")) {
        // Find username from conversation history (newest to oldest)
        let foundUsername = "";

        if (promptLower.includes("الحساب الرسمي") || promptLower.includes("@tiktok")) {
          foundUsername = "tiktok";
        }

        if (!foundUsername) {
          for (let i = options.messages.length - 1; i >= 0; i--) {
            const m = options.messages[i];
            if (m.role === "user") {
              const handleMatch = m.content.match(/@([a-zA-Z0-9._]{2,30})/);
              if (handleMatch) {
                foundUsername = handleMatch[1].trim();
                break;
              }
            }
          }
        }

        if (!foundUsername) {
          for (let i = options.messages.length - 1; i >= 0; i--) {
            const m = options.messages[i];
            if (m.role === "user") {
              const tokens = m.content.split(/\s+/);
              for (const tok of tokens) {
                const clean = tok.replace(/^[@#]/, "").trim();
                if (
                  /^[a-zA-Z0-9._]{3,30}$/.test(clean) &&
                  !["tiktok", "twitter", "youtube", "instagram", "facebook", "linkedin", "profile", "user"].includes(clean.toLowerCase())
                ) {
                  foundUsername = clean;
                  break;
                }
              }
              if (foundUsername) break;
            }
          }
        }

        if (!foundUsername) {
          return {
            output: {
              type: "ask_clarification",
              questions: [
                {
                  question: "ما هو معرّف الحساب المطلوب استخراج بياناته على تيك توك؟",
                  options: ["سأكتب المعرّف بنفسي", "أحتاج مساعدة في العثور عليه"],
                },
              ],
              questionsAr: [
                "ما هو معرّف الحساب المطلوب استخراج بياناته على تيك توك؟",
              ],
              reasonAr: "يرجى تحديد معرف الحساب المطلوب استخراج بياناته.",
            },
            inputTokens: 500,
            outputTokens: 60,
            costUsd: (500 * 0.10 + 60 * 0.50) / 1_000_000,
            model: fakeModel,
            promptVersion: PROMPT_VERSION,
          };
        }

        const username = foundUsername;

        return {
          output: {
            type: "propose_plan",
            summaryAr: `استخراج بيانات وإحصائيات الحساب العام @${username} على منصة تيك توك`,
            capabilities: [
              {
                capabilitySlug: "tiktok-profile",
                params: { username },
                targetVolumeMin: 1,
                targetVolumeMax: 1,
              },
            ],
            executionOptions: {
              windowing: "none",
              includeReplies: false,
              dedupe: true,
              anonymize: false,
              qualityReport: true,
            },
            outputSpec: {
              sheets: [
                {
                  name: "ملف الحساب",
                  columns: [
                    { field: "username", headerAr: "اسم المستخدم" },
                    { field: "nickname", headerAr: "الاسم التعريفي" },
                    { field: "followerCount", headerAr: "عدد المتابعين" },
                    { field: "followingCount", headerAr: "عدد المتابَعين" },
                    { field: "heartCount", headerAr: "إجمالي الإعجابات" },
                    { field: "videoCount", headerAr: "عدد المقاطع" },
                  ],
                },
              ],
              formats: ["xlsx", "pdf", "csv"],
            },
            outputFormats: ["xlsx", "pdf", "csv"],
            methodologyNotes: `استخراج البيانات العامة المتاحة لحساب @${username} من المصدر الرسمي بتاريخ اليوم.`,
          },
          inputTokens: 800,
          outputTokens: 140,
          costUsd: (800 * 0.10 + 140 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }
    }

    // G. X/Twitter tweets plan proposal or coming soon alternative
    if (promptLower.includes("تغريدات") || promptLower.includes("تويتر") || promptLower.includes("منصة x")) {
      if (!isCapEnabled("x-keyword-search") && !isCapEnabled("x-user-tweets")) {
        return {
          output: {
            type: "suggest_alternative",
            unsupportedService: "منصة X (تويتر)",
            explanationAr: "هذه المنصة قيد التجهيز وغير متاحة للتشغيل الآن (منصة X). الخدمة المعتمدة والمتاحة حالياً هي استخراج ملف تيك توك الشخصي.",
            closestAlternative: "يمكنك تجربة استخراج بيانات حساب تيك توك عام (@username).",
            canRequestFeature: true,
          },
          inputTokens: 500,
          outputTokens: 80,
          costUsd: (500 * 0.10 + 80 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }

      if (promptLower.includes("تتبع") || (!promptLower.includes("تغريدة") && !promptLower.includes("200") && !promptLower.includes("500"))) {
        return {
          output: {
            type: "ask_clarification",
            questions: [
              {
                question: "ما هي الكلمات الدلالية أو الحسابات المستهدفة على منصة X؟",
                options: ["كلمات مفتاحية", "حساب محدد"],
              },
              {
                question: "ما هو الحد الأقصى لعدد التغريدات المطلوب جمعها؟",
                options: ["حتى 100 تغريدة", "حتى 500 تغريدة", "أحدد العدد لاحقاً"],
              },
            ],
            questionsAr: [
              "ما هي الكلمات الدلالية أو الحسابات المستهدفة على منصة X؟",
              "ما هو الحد الأقصى لعدد التغريدات المطلوب جمعها؟",
            ],
            reasonAr: "تحديد تفاصيل طلب تغريدات منصة X بدقة",
          },
          inputTokens: 600,
          outputTokens: 70,
          costUsd: (600 * 0.10 + 70 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }

      const volumeMatch = lastUserMsg.match(/(\d+)/);
      const targetVolume = volumeMatch ? parseInt(volumeMatch[1], 10) : 100;

      return {
        output: {
          type: "propose_plan",
          summaryAr: `استخراج تغريدات منصة X بالكلمات الدلالية حتى ${targetVolume} تغريدة`,
          capabilities: [
            {
              capabilitySlug: "x-keyword-search",
              params: { query: "search query", max_results: targetVolume },
              targetVolumeMin: 1,
              targetVolumeMax: targetVolume,
            },
          ],
          outputFormats: ["xlsx", "pdf", "csv"],
          methodologyNotes: `استخراج التغريدات العامة المتعلقة بالموضوع المحدد حتى سقف ${targetVolume} تغريدة.`,
        },
        inputTokens: 850,
        outputTokens: 150,
        costUsd: (850 * 0.10 + 150 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // H. YouTube coming soon alternative
    if (promptLower.includes("يوتيوب") || promptLower.includes("youtube")) {
      if (!isCapEnabled("youtube-search") && !isCapEnabled("youtube-channel-info") && !isCapEnabled("youtube-comments")) {
        return {
          output: {
            type: "suggest_alternative",
            unsupportedService: "يوتيوب (YouTube)",
            explanationAr: "هذه المنصة قيد التجهيز وغير متاحة للتشغيل الآن (يوتيوب). الخدمة المعتمدة والمتاحة حالياً هي استخراج ملف تيك توك الشخصي.",
            closestAlternative: "يمكنك تجربة استخراج بيانات حساب تيك توك عام (@username).",
            canRequestFeature: true,
          },
          inputTokens: 500,
          outputTokens: 80,
          costUsd: (500 * 0.10 + 80 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }

      return {
        output: {
          type: "propose_plan",
          summaryAr: "استخراج مقاطع فيديو وتعليقات من منصة يوتيوب",
          capabilities: [
            {
              capabilitySlug: promptLower.includes("تعليقات") ? "youtube-comments" : "youtube-search",
              params: { query: "WHO COVID", count: 100 },
              targetVolumeMin: 50,
              targetVolumeMax: 100,
            },
          ],
          outputFormats: ["xlsx", "pdf", "csv"],
          methodologyNotes: "استخراج مقاطع الفيديو العامة وإحصائيات المشاهدة والتفاعل من يوتيوب.",
        },
        inputTokens: 850,
        outputTokens: 150,
        costUsd: (850 * 0.10 + 150 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // Default: Ask clarifying discovery questions with tappable suggested options
    return {
      output: {
        type: "ask_clarification",
        questions: [
          {
            question: "ما هي المنصة المستهدفة للبحث (تيك توك أو منصة أخرى)؟",
            options: ["تيك توك (TikTok)", "منصة X (تويتر)", "يوتيوب (YouTube)"],
          },
          {
            question: "هل تبحث عن معرف حساب محدد أم كلمات دلالية وموضوع عام؟",
            options: ["حساب محدد", "كلمات مفتاحية عامة"],
          },
          {
            question: "ما هو حجم العينة المستهدف تقريباً؟",
            options: ["سجل واحد (حساب محدد)", "حتى 100 سجل", "حتى 500 سجل"],
          },
        ],
        questionsAr: [
          "ما هي المنصة المستهدفة للبحث (تيك توك، X، يوتيوب، أو الويب العام)؟",
          "هل تبحث عن حساب محدد أم كلمات دلالية وموضوع عام؟",
          "ما هو الحد الأقصى التقريبي لعدد السجلات المطلوبة؟",
        ],
        reasonAr: "تحديد تفاصيل طلب استخراج البيانات وأهدافه بدقة",
      },
      inputTokens: 700,
      outputTokens: 90,
      costUsd: (700 * 0.10 + 90 * 0.50) / 1_000_000,
      model: fakeModel,
      promptVersion: PROMPT_VERSION,
    };
  }

  /**
   * Handle provider errors cleanly (timeout, 429, 404 model, 401 auth, 5xx):
   * Return short Arabic error ("المساعد غير متاح الآن، حاول لاحقًا"), 0 tokens, 0 cost, so no points are held.
   * Records a short reason code in server logs and llm-status without ever logging keys or secrets.
   */
  private handleProviderError(err: any, provider: string): LlmCallResult {
    const model = this.getModel();
    let reasonAr = "المساعد غير متاح الآن، حاول لاحقًا.";
    let fallbackCode = "provider_unreachable";

    const msg = typeof err?.message === "string" ? err.message : "";
    const status = err?.status || err?.statusCode || msg.match(/\((\d{3})\)/)?.[1];
    const statusNum = Number(status);

    if (msg.includes("not configured")) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا (الخدمة غير مهيأة بشكل صحيح).";
      fallbackCode = "missing_key";
    } else if (
      err?.name === "AbortError" ||
      err?.name === "TimeoutError" ||
      msg.includes("timed out") ||
      msg.includes("timeout") ||
      msg.includes("aborted")
    ) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا (استغرقت الاستجابة وقتاً أطول من المعتاد).";
      fallbackCode = "timeout";
    } else if (statusNum === 404 || msg.includes("not_found_error")) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا (اسم النموذج المحدد غير متاح لدى المزود).";
      fallbackCode = "http_404_model";
    } else if (statusNum === 429 || msg.includes("429") || msg.includes("rate_limit")) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا (تجاوز حد الطلبات المؤقت).";
      fallbackCode = "http_429";
    } else if (statusNum === 529 || msg.includes("529") || msg.includes("overloaded")) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا (خوادم الخدمة تواجه ضغطاً كبيراً).";
      fallbackCode = "http_529";
    } else if (
      (statusNum >= 500 && statusNum < 600) ||
      msg.includes("(500)") ||
      msg.includes("(502)") ||
      msg.includes("(503)") ||
      msg.includes("(504)")
    ) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا (صعوبة مؤقتة في الخدمة).";
      fallbackCode = "http_5xx";
    } else if (statusNum === 403) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا (الخدمة غير مهيأة بشكل صحيح).";
      fallbackCode = "http_403";
    } else if (
      statusNum === 401 ||
      msg.includes("API_KEY") ||
      msg.includes("authentication") ||
      msg.includes("credentials")
    ) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا (الخدمة غير مهيأة بشكل صحيح).";
      fallbackCode = "http_401";
    } else if (statusNum === 400 && (msg.toLowerCase().includes("credit balance") || msg.toLowerCase().includes("billing"))) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا (رصيد المزود غير كافٍ).";
      fallbackCode = "http_400_billing";
    } else if (statusNum === 400) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا.";
      fallbackCode = "http_400";
    } else if (err?.name === "ZodError" || msg.includes("Invalid response format")) {
      reasonAr = "المساعد غير متاح الآن، حاول لاحقًا.";
      fallbackCode = "schema_invalid";
    }

    setLastLlmFallbackReason(fallbackCode);
    console.warn(`[llm:error] provider=${provider} model=${model} reason=${fallbackCode}`);

    return {
      output: {
        type: "refuse",
        reasonAr,
      },
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      model,
      promptVersion: PROMPT_VERSION,
    };
  }

  /**
   * Real Anthropic Messages API execution with structured tool use
   */
  private async executeRealAnthropic(options: LlmCallOptions): Promise<LlmCallResult> {
    const model = this.getModel();
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      return this.handleProviderError(new Error("ANTHROPIC_API_KEY is not configured"), "anthropic");
    }

    const systemPrompt = buildSystemPrompt({
      userProfile: options.userProfile,
      sanitizedCapabilities: options.sanitizedCapabilities,
      todayDate: options.todayDate,
      userBalancePoints: options.userBalancePoints,
      conversationState: options.conversationState,
    });

    const formattedMessages = sanitizeMessagesForAnthropic(options.messages);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: formattedMessages,
          tools: [
            {
              name: "actionResult",
              description: "Structured output response from the assistant adhering to Digr system protocols",
              input_schema: ACTION_RESULT_JSON_SCHEMA,
            },
          ],
          tool_choice: {
            type: "tool",
            name: "actionResult",
          },
        }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        return this.handleProviderError(
          new Error(`Anthropic API error (${response.status}): ${errText}`),
          "anthropic"
        );
      }

      const data: any = await response.json();

      let rawPayload: any = null;
      const toolUse = data.content?.find((b: any) => b.type === "tool_use" && b.name === "actionResult");
      if (toolUse && toolUse.input) {
        rawPayload = toolUse.input;
      } else {
        const textBlock = data.content?.find((b: any) => b.type === "text");
        if (textBlock && textBlock.text) {
          try {
            rawPayload = JSON.parse(textBlock.text);
          } catch {
            rawPayload = {};
          }
        }
      }

      if (!rawPayload || typeof rawPayload !== "object") {
        return this.handleProviderError(new Error("Invalid response format from Anthropic"), "anthropic");
      }

      const scrubField = (val: any): any => {
        if (typeof val === "string") return scrubWhiteLabelText(val);
        if (Array.isArray(val)) return val.map(scrubField);
        if (val && typeof val === "object") {
          const obj: any = {};
          for (const [k, v] of Object.entries(val)) {
            obj[k] = scrubField(v);
          }
          return obj;
        }
        return val;
      };

      const scrubbedPayload = scrubField(rawPayload);

      if (scrubbedPayload.type === "ask_clarification") {
        if (!scrubbedPayload.questionsAr && scrubbedPayload.questions) {
          scrubbedPayload.questionsAr = scrubbedPayload.questions
            .map((q: any) => (typeof q === "string" ? q : q.question || q.text || ""))
            .filter(Boolean);
        }
        if (!scrubbedPayload.reasonAr) {
          scrubbedPayload.reasonAr = scrubbedPayload.intro || "تحديد تفاصيل الطلب بدقة";
        }
      }

      const validatedOutput = LlmTurnOutputSchema.parse(scrubbedPayload);

      const inTokens = data.usage?.input_tokens || 800;
      const outTokens = data.usage?.output_tokens || 150;

      const pricing = getLlmPricingSettings(
        "anthropic",
        model,
        options.pricingSettings || this.customPricing
      );
      const costUsd = (inTokens * pricing.inputCostPerMillion + outTokens * pricing.outputCostPerMillion) / 1_000_000;

      setLastLlmFallbackReason(null);

      return {
        output: validatedOutput,
        inputTokens: inTokens,
        outputTokens: outTokens,
        costUsd,
        model,
        promptVersion: PROMPT_VERSION,
        rawText: JSON.stringify(scrubbedPayload),
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      return this.handleProviderError(err, "anthropic");
    }
  }

  /**
   * Real OpenAI Responses API execution
   */
  private async executeRealOpenAi(options: LlmCallOptions): Promise<LlmCallResult> {
    const model = this.getModel();
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return this.handleProviderError(new Error("OPENAI_API_KEY is not configured"), "openai");
    }

    const systemPrompt = buildSystemPrompt({
      userProfile: options.userProfile,
      sanitizedCapabilities: options.sanitizedCapabilities,
      todayDate: options.todayDate,
      userBalancePoints: options.userBalancePoints,
      conversationState: options.conversationState,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          reasoning: { effort: "low" },
          input: [
            { role: "system", content: systemPrompt },
            ...options.messages,
          ],
          text: {
            format: {
              type: "json_schema",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  actionResult: ACTION_RESULT_JSON_SCHEMA,
                },
                required: ["actionResult"],
                additionalProperties: false,
              },
            },
          },
        }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        return this.handleProviderError(
          new Error(`OpenAI API error (${response.status}): ${errText}`),
          "openai"
        );
      }

      const data: any = await response.json();
      const rawContent = data.output_text || data.choices?.[0]?.message?.content || "{}";
      const scrubbed = scrubWhiteLabelText(rawContent);

      let parsedResult: any;
      try {
        const parsedWrapper = JSON.parse(scrubbed);
        parsedResult = parsedWrapper.actionResult || parsedWrapper;
      } catch {
        parsedResult = JSON.parse(scrubbed);
      }

      // Adapt to questionsAr if questions were returned or vice versa
      if (parsedResult.type === "ask_clarification" && !parsedResult.questionsAr && parsedResult.questions) {
        parsedResult.questionsAr = parsedResult.questions
          .map((q: any) => (typeof q === "string" ? q : q.question || q.text || ""))
          .filter(Boolean);
      }

      const validatedOutput = LlmTurnOutputSchema.parse(parsedResult);

      const inTokens = data.usage?.input_tokens || 800;
      const outTokens = data.usage?.output_tokens || 150;

      const pricing = getLlmPricingSettings(
        "openai",
        model,
        options.pricingSettings || this.customPricing
      );
      const costUsd = (inTokens * pricing.inputCostPerMillion + outTokens * pricing.outputCostPerMillion) / 1_000_000;

      setLastLlmFallbackReason(null);

      return {
        output: validatedOutput,
        inputTokens: inTokens,
        outputTokens: outTokens,
        costUsd,
        model,
        promptVersion: PROMPT_VERSION,
        rawText: scrubbed,
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      return this.handleProviderError(err, "openai");
    }
  }
}

