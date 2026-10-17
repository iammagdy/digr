import { z } from "zod";
import { buildSystemPrompt, buildSystemPromptParts, PROMPT_VERSION } from "./systemPrompt";
import { isGreetingOrGeneralQuestion, extractTargetVolume } from "./briefManager";
import { INTERNAL_DISCOVERY_KEYS, MAX_CLARIFICATION_QUESTIONS } from "./clarification";
import { toArabicDigits } from "../../lib/arabicDigits";
import { detectCountryFromText, detectIndustryFromText, getCompanyRequirementItems, getMissingCompanyResearchRequirements, isPeopleSearchRequest, requiredProfessionalContactFields } from "../../lib/planParameters";

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
  questions: z.array(ClarificationQuestionItemSchema).min(1).max(MAX_CLARIFICATION_QUESTIONS).optional(),
  questionsAr: z.array(z.string().trim().min(1)).min(1).max(MAX_CLARIFICATION_QUESTIONS).optional(),
  optionsAr: z.array(z.array(z.string().trim().min(1).max(40)).max(4)).max(MAX_CLARIFICATION_QUESTIONS).optional(),
  reasonAr: z.string().min(1),
  intent: z.enum(["chat", "research"]).optional(),
}).passthrough();

export const AskQuestionsSchema = z.object({
  type: z.literal("ask_questions"),
  intro: z.string().optional(),
  questions: z.preprocess((val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) return [val];
    if (Array.isArray(val)) return val.slice(0, MAX_CLARIFICATION_QUESTIONS);
    return [];
  }, z.array(ClarificationQuestionItemSchema).max(MAX_CLARIFICATION_QUESTIONS)).optional(),
  questionsAr: z.preprocess((val) => {
    if (typeof val === "string") return [val];
    if (Array.isArray(val)) return val.filter((x): x is string => typeof x === "string").slice(0, MAX_CLARIFICATION_QUESTIONS);
    return undefined;
  }, z.array(z.string().trim().min(1)).max(MAX_CLARIFICATION_QUESTIONS)).optional(),
  optionsAr: z.preprocess((val) => {
    if (Array.isArray(val)) {
      return val.map((row) => (Array.isArray(row) ? row.filter((x): x is string => typeof x === "string").slice(0, 4) : []));
    }
    return undefined;
  }, z.array(z.array(z.string().trim().min(1).max(40)).max(4)).max(MAX_CLARIFICATION_QUESTIONS)).optional(),
  reasonAr: z.preprocess((val) => {
    if (typeof val === "string" && val.trim().length > 0) return val;
    return "تحديد تفاصيل الطلب بدقة";
  }, z.string().min(1)),
}).passthrough();

export const SearchCatalogSchema = z.object({
  type: z.literal("search_catalog"),
  query: z.string().min(1),
  platform: z.string().optional(),
}).passthrough();

export const PlanCapabilityItemSchema = z.object({
  stepId: z.string().optional(),
  capabilitySlug: z.string().min(1),
  endpointId: z.string().optional(),
  params: z.preprocess((val) => (val && typeof val === "object" ? val : {}), z.record(z.string(), z.any())),
  targetVolumeMin: z.preprocess((val) => (typeof val === "string" ? parseInt(val, 10) : typeof val === "number" ? val : 1), z.number().int().min(1)),
  targetVolumeMax: z.preprocess((val) => (typeof val === "string" ? parseInt(val, 10) : typeof val === "number" ? val : 1), z.number().int().min(1)),
  paginationStrategy: z.enum(["cursor", "offset", "page", "none"]).optional(),
  volumeMode: z.enum(["bounded", "open_ended"]).optional(),
  dependsOn: z.array(z.string()).optional(),
  inputFrom: z
    .object({
      stepId: z.string(),
      field: z.string(),
      paramKey: z.string(),
    })
    .passthrough()
    .optional(),
  fanOutCap: z.number().int().min(1).max(50).optional(),
  windowed: z.boolean().optional(),
}).passthrough();

export const ExecutionOptionsSchema = z.object({
  windowing: z.enum(["none", "per_day", "per_week", "per_month"]).default("none"),
  windowFrom: z.string().optional(),
  windowTo: z.string().optional(),
  includeReplies: z.boolean().default(false),
  dedupe: z.boolean().default(true),
  languageFilter: z.string().optional(),
  anonymize: z.boolean().default(false),
  qualityReport: z.boolean().default(true),
}).passthrough();

export const OutputColumnSchema = z.object({
  field: z.string().min(1),
  headerAr: z.string().min(1),
}).passthrough();

export const OutputSheetSchema = z.object({
  name: z.string().min(1),
  sourceDataset: z.string().optional(),
  columns: z.array(OutputColumnSchema).min(1),
  sort: z.object({ field: z.string(), order: z.enum(["asc", "desc"]) }).passthrough().optional(),
  filter: z.record(z.string(), z.any()).optional(),
}).passthrough();

export const OutputSpecSchema = z.object({
  sheets: z.array(OutputSheetSchema).min(1).optional(),
  formats: z.preprocess((val) => (typeof val === "string" ? [val] : val), z.array(z.enum(["xlsx", "pdf", "csv"])).default(["xlsx", "pdf", "csv"])),
}).passthrough();

export const ProposePlanSchema = z.object({
  type: z.literal("propose_plan"),
  summaryAr: z.preprocess((val) => (typeof val === "string" && val.trim().length > 0 ? val : "خطة مقترحة لجمع البيانات"), z.string().min(1)),
  capabilities: z.preprocess((val) => (val && typeof val === "object" && !Array.isArray(val) ? [val] : Array.isArray(val) ? val : []), z.array(PlanCapabilityItemSchema).min(1)),
  steps: z.preprocess((val) => (val && typeof val === "object" && !Array.isArray(val) ? [val] : Array.isArray(val) ? val : undefined), z.array(PlanCapabilityItemSchema).optional()),
  executionOptions: ExecutionOptionsSchema.optional(),
  outputSpec: OutputSpecSchema.optional(),
  outputFormats: z.preprocess((val) => (typeof val === "string" ? [val] : val), z.array(z.enum(["xlsx", "pdf", "csv"])).default(["xlsx", "pdf", "csv"])),
  methodologyNotes: z.string().default("تجميع وتوثيق البيانات من المصادر المتاحة وفق نطاق البحث المحدد"),
  rationaleAr: z.string().optional(),
}).passthrough();

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
    .passthrough()
    .optional(),
}).passthrough();

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
}).passthrough();

export const WriteNoteSchema = z.object({
  type: z.literal("write_note"),
  titleAr: z.string().min(1),
  contentAr: z.string().min(1),
}).passthrough();

export const AnswerQuestionSchema = z.object({
  type: z.literal("answer_question"),
  answerAr: z.preprocess((val) => (typeof val === "string" ? val : String(val || "")), z.string().min(1)),
  topic: z.string().optional(),
  intent: z.enum(["chat", "research"]).default("chat").optional(),
}).passthrough();

export const RefuseSchema = z.object({
  type: z.literal("refuse"),
  reasonAr: z.string().min(1),
  alternativeAr: z.string().optional(),
}).passthrough();

export const SuggestAlternativeSchema = z.object({
  type: z.literal("suggest_alternative"),
  unsupportedService: z.string().min(1),
  explanationAr: z.string().min(1),
  closestAlternative: z.string().optional(),
  canRequestFeature: z.literal(true).default(true),
}).passthrough();

export const EditPlanToolSchema = z.object({
  type: z.literal("edit_plan"),
  operations: z.array(
    z.discriminatedUnion("action", [
      z.object({
        action: z.literal("set_param"),
        capabilitySlug: z.string().min(1),
        key: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      }).passthrough(),
      z.object({
        action: z.literal("set_limit"),
        capabilitySlug: z.string().min(1),
        targetVolumeMax: z.number().int().min(1).max(5000),
      }).passthrough(),
      z.object({
        action: z.literal("set_formats"),
        formats: z.array(z.enum(["xlsx", "pdf", "csv"])).min(1),
      }).passthrough(),
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
      }).passthrough(),
      z.object({
        action: z.literal("add_capability"),
        capabilitySlug: z.string().min(1),
        params: z.record(z.string(), z.any()),
        targetVolumeMax: z.number().int().min(1).max(5000),
      }).passthrough(),
      z.object({
        action: z.literal("remove_capability"),
        capabilitySlug: z.string().min(1),
      }).passthrough(),
    ])
  ).min(1),
  reasonAr: z.string().min(1),
}).passthrough();

export const UpdateBriefSchema = z.object({
  type: z.literal("update_brief"),
  platforms: z.preprocess((val) => (typeof val === "string" ? [val] : val), z.array(z.string()).optional()),
  topics: z.preprocess((val) => (typeof val === "string" ? [val] : val), z.array(z.string()).optional()),
  keywords: z.preprocess((val) => (typeof val === "string" ? [val] : val), z.array(z.string()).optional()),
  targetVolume: z.preprocess((val) => (typeof val === "string" ? parseInt(val, 10) : val), z.number().int().positive().optional()),
  postCount: z.preprocess((val) => (typeof val === "string" ? parseInt(val, 10) : val), z.number().int().positive().optional()),
  commentsPerPost: z.preprocess((val) => (typeof val === "string" ? parseInt(val, 10) : val), z.number().int().positive().optional()),
  dateRange: z.string().optional(),
  language: z.string().optional(),
  formats: z.preprocess((val) => (typeof val === "string" ? [val] : val), z.array(z.string()).optional()),
  notes: z.string().optional(),
  replyAr: z.string().optional(),
  questions: z.preprocess((val) => (val && typeof val === "object" && !Array.isArray(val) ? [val] : val), z.array(ClarificationQuestionItemSchema).optional()),
}).passthrough();

export const LlmTurnOutputSchema = z.discriminatedUnion("type", [
  AskClarificationSchema,
  AskQuestionsSchema,
  ProposePlanSchema,
  EditPlanToolSchema,
  EditArtifactSchema,
  WriteNoteSchema,
  AnswerQuestionSchema,
  RefuseSchema,
  SuggestAlternativeSchema,
  SearchCatalogSchema,
  UpdateBriefSchema,
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
    displayName?: string;
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
  textBlockAr?: string;
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
    cleaned = cleaned.replace(regex, "منصة Diger");
  }
  return cleaned;
}

export function sanitizeMessagesForAnthropic(
  messages: Array<{ role: string; content: string }>,
  options?: { ensureUserEnd?: boolean }
): Array<{ role: "user" | "assistant"; content: string }> {
  const filtered = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: (m.content || "").trim(),
    }))
    .filter((m) => m.content.length > 0);

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

  if (options?.ensureUserEnd) {
    while (combined.length > 0 && combined[combined.length - 1].role !== "user") {
      combined.pop();
    }
    if (combined.length === 0) {
      combined.push({ role: "user", content: "مرحباً" });
    }
  }

  return combined;
}

export const ACTION_RESULT_JSON_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [
        "search_catalog",
        "ask_clarification",
        "ask_questions",
        "propose_plan",
        "edit_plan",
        "edit_artifact",
        "write_note",
        "suggest_alternative",
        "answer_question",
        "refuse",
        "update_brief",
      ],
    },
    intent: { type: "string", enum: ["chat", "research"] },
    conversationTitle: { type: "string", maxLength: 50 },
    platforms: { type: "array", items: { type: "string" } },
    topics: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
    targetVolume: { type: "integer" },
    postCount: { type: "integer" },
    commentsPerPost: { type: "integer" },
    dateRange: { type: "string" },
    language: { type: "string" },
    formats: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    replyAr: { type: "string" },
    query: { type: "string" },
    platform: { type: "string" },
    intro: { type: "string" },
    questionsAr: { type: "array", maxItems: MAX_CLARIFICATION_QUESTIONS, items: { type: "string" } },
    questions: {
      type: "array",
      maxItems: MAX_CLARIFICATION_QUESTIONS,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          question: { type: "string" },
          type: { type: "string", enum: ["single", "multi", "free"] },
          parameterType: { type: "string", enum: ["platform", "time_window", "volume", "output_format", "anonymize", "language", "topic"] },
          options: {
            type: "array",
            maxItems: 4,
            items: { type: "string", maxLength: 40 },
          },
          allowOther: { type: "boolean" },
          defaultOption: { type: "string" },
        },
        additionalProperties: true,
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
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stepId: { type: "string" },
          capabilitySlug: { type: "string" },
          endpointId: { type: "string" },
          params: { type: "object", additionalProperties: true },
          targetVolumeMin: { type: "integer" },
          targetVolumeMax: { type: "integer" },
          paginationStrategy: { type: "string", enum: ["cursor", "offset", "page", "none"] },
          volumeMode: { type: "string", enum: ["bounded", "open_ended"] },
          dependsOn: { type: "array", items: { type: "string" } },
          inputFrom: {
            type: "object",
            properties: {
              stepId: { type: "string" },
              field: { type: "string" },
              paramKey: { type: "string" },
            },
            additionalProperties: true,
          },
          fanOutCap: { type: "integer" },
          windowed: { type: "boolean" },
        },
        required: ["params", "targetVolumeMin", "targetVolumeMax"],
        additionalProperties: true,
      },
    },
    capabilities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stepId: { type: "string" },
          capabilitySlug: { type: "string" },
          endpointId: { type: "string" },
          params: { type: "object", additionalProperties: true },
          targetVolumeMin: { type: "integer" },
          targetVolumeMax: { type: "integer" },
          paginationStrategy: { type: "string", enum: ["cursor", "offset", "page", "none"] },
          volumeMode: { type: "string", enum: ["bounded", "open_ended"] },
          dependsOn: { type: "array", items: { type: "string" } },
          inputFrom: {
            type: "object",
            properties: {
              stepId: { type: "string" },
              field: { type: "string" },
              paramKey: { type: "string" },
            },
            additionalProperties: true,
          },
          fanOutCap: { type: "integer" },
          windowed: { type: "boolean" },
        },
        required: ["params", "targetVolumeMin", "targetVolumeMax"],
        additionalProperties: true,
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
        additionalProperties: true,
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
  additionalProperties: true,
};

// ================= LLM Runtime Diagnostics & Status =================

export interface LlmStatusSnapshot {
  provider: LlmProviderType;
  llm_enabled: boolean;
  key_present: boolean;
  model: string;
  reasoning_effort: string;
  reasoning_effort_status: string;
  last_llm_usage_timestamp: string | null;
  last_fallback_reason: string | null;
  last_fallback_detail: string | null;
}

let lastFallbackReason: string | null = null;
let lastFallbackDetail: string | null = null;

export function sanitizeFallbackDetail(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  let clean = raw
    .replace(/sk-[a-zA-Z0-9_\-]{6,}/gi, "[REDACTED]")
    .replace(/key-[a-zA-Z0-9_\-]{6,}/gi, "[REDACTED]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (clean.length > 200) {
    clean = clean.slice(0, 200).trim();
  }
  return clean;
}

export function getLastLlmFallbackReason(): string | null {
  return lastFallbackReason;
}

export function setLastLlmFallbackReason(reason: string | null): void {
  lastFallbackReason = reason;
}

export function getLastLlmFallbackDetail(): string | null {
  return lastFallbackDetail;
}

export function setLastLlmFallbackDetail(detail: string | null): void {
  lastFallbackDetail = detail ? sanitizeFallbackDetail(detail) : null;
}

export function resolveRuntimeProvider(override?: LlmProviderType): LlmProviderType {
  const raw = (override || process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (raw === "anthropic" || raw === "openai" || raw === "fake") {
    return raw;
  }
  if (
    process.env.VITEST !== "true" &&
    process.env.ANTHROPIC_API_KEY &&
    process.env.ANTHROPIC_API_KEY.trim().length > 0
  ) {
    return "anthropic";
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
  const reasoning_effort = (process.env.LLM_REASONING_EFFORT || "low").trim().toLowerCase();

  let reasoning_effort_status = "not applied (fake provider)";
  if (provider === "anthropic") {
    reasoning_effort_status = "not applied (model does not support it)";
  } else if (provider === "openai") {
    reasoning_effort_status = "applied";
  }

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
    reasoning_effort,
    reasoning_effort_status,
    last_llm_usage_timestamp: lastUsageTimestamp,
    last_fallback_reason: derivedFallback,
    last_fallback_detail: lastFallbackDetail,
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

    // 2. Budget limits check (backstop: the chat handler summarizes older turns
    // before this is reached, so hitting it means compaction did not apply)
    const convTokens = options.totalConversationTokens || 0;
    if (convTokens > 40000) {
      return {
        output: {
          type: "refuse",
          reasonAr: "تم بلوغ الحد الأقصى لسياق هذه المحادثة (40,000 توكن). يرجى بدء محادثة جديدة.",
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

    // Catalog-search loop test scenarios (multi-turn). The internal catalog
    // result marker is appended by the caller when search results are fed back.
    const CATALOG_RESULT_MARKER = "نتائج بحث الكتالوج — داخلية";
    const hasCatalogResults = (options.messages || []).some(
      (m) => typeof m.content === "string" && m.content.includes(CATALOG_RESULT_MARKER),
    );
    const searchCatalogOutput = {
      type: "search_catalog",
      query: "تعليقات فيسبوك",
      platform: "facebook",
    } as const;
    const fakeTokens = { inputTokens: 500, outputTokens: 60, costUsd: 0, model: fakeModel, promptVersion: PROMPT_VERSION };
    if (options.testScenario === "search_then_plan") {
      return hasCatalogResults
        ? {
            output: {
              type: "propose_plan",
              summaryAr: "استخراج تعليقات فيسبوك العامة حول البطالة في مصر",
              capabilities: [
                {
                  stepId: "fb_comments",
                  capabilitySlug: "facebook-post-comments",
                  endpointId: "facebook-post-comments",
                  params: { postUrl: "https://www.facebook.com/post/123", maxPages: 5 },
                  targetVolumeMin: 10,
                  targetVolumeMax: 50,
                  paginationStrategy: "cursor",
                },
              ],
              outputFormats: ["xlsx", "csv"],
              methodologyNotes: "اختبار وهمي.",
            },
            ...fakeTokens,
          }
        : { output: searchCatalogOutput, ...fakeTokens };
    }
    if (options.testScenario === "search_then_questions") {
      return hasCatalogResults
        ? {
            output: {
              type: "ask_clarification",
              reasonAr: "أحتاج توضيحاً قبل إعداد الخطة.",
              questions: [{ question: "ما الفترة الزمنية المستهدفة للتعليقات؟" }],
            },
            ...fakeTokens,
          }
        : { output: searchCatalogOutput, ...fakeTokens };
    }
    if (options.testScenario === "search_then_empty") {
      return hasCatalogResults
        ? { output: { type: "answer_question", answerAr: "" }, ...fakeTokens }
        : { output: searchCatalogOutput, ...fakeTokens };
    }
    if (options.testScenario === "search_then_text") {
      return hasCatalogResults
        ? { output: { type: "answer_question", answerAr: "وجدت أدوات مناسبة في الكتالوج لطلبك." }, ...fakeTokens }
        : { output: searchCatalogOutput, ...fakeTokens };
    }
    if (options.testScenario === "search_forever") {
      return { output: searchCatalogOutput, ...fakeTokens };
    }
    const RETRY_MARKER = "الخطوة التالية المطلوبة";
    const hasRetryInstruction = (options.messages || []).some(
      (m) => typeof m.content === "string" && m.content.includes(RETRY_MARKER),
    );
    const SUMMARY_MARKER = "ملخص المحادثة";
    const hasSummary = (options.messages || []).some(
      (m) => typeof m.content === "string" && m.content.includes(SUMMARY_MARKER),
    );
    if (options.testScenario === "search_retry_then_questions") {
      if (!hasCatalogResults) return { output: searchCatalogOutput, ...fakeTokens };
      if (!hasRetryInstruction) return { output: { type: "answer_question", answerAr: "" }, ...fakeTokens };
      return {
        output: {
          type: "ask_clarification",
          reasonAr: "أحتاج توضيحاً قبل إعداد الخطة.",
          questions: [{ question: "كم عدد المنشورات المطلوب جمع تعليقاتها؟" }],
        },
        ...fakeTokens,
      };
    }
    if (options.testScenario === "search_then_stall") {
      if (!hasCatalogResults) return { output: searchCatalogOutput, ...fakeTokens };
      return { output: { type: "answer_question", answerAr: "   " }, ...fakeTokens };
    }
    const hasColonRetry = (options.messages || []).some(
      (m) => typeof m.content === "string" && m.content.includes("انتهى الرد بنقطتين"),
    );
    if (options.testScenario === "colon_cutoff_then_questions") {
      if (!hasColonRetry) {
        return {
          output: { type: "answer_question", answerAr: "عشان أجهز لك خطة دقيقة، محتاج أعرف:" },
          ...fakeTokens,
          textBlockAr: "عشان أجهز لك خطة دقيقة، محتاج أعرف:",
        };
      }
      return {
        output: {
          type: "ask_clarification",
          reasonAr: "عشان أجهز لك خطة دقيقة، محتاج أعرف:",
          questions: [
            { question: "ما زوايا أو محاور الموضوع المستهدفة؟" },
            { question: "ما عدد المنشورات المستهدف فحصها؟" },
          ],
        },
        ...fakeTokens,
        textBlockAr: "عشان أجهز لك خطة دقيقة، محتاج أعرف:",
      };
    }
    if (options.testScenario === "colon_cutoff_always") {
      return {
        output: { type: "answer_question", answerAr: "عشان أجهز لك خطة دقيقة، محتاج أعرف:" },
        ...fakeTokens,
        textBlockAr: "عشان أجهز لك خطة دقيقة، محتاج أعرف:",
      };
    }
    if (options.testScenario === "text_plus_tool_turn") {
      return {
        output: {
          type: "ask_clarification",
          reasonAr: "عشان أجهز لك خطة دقيقة، محتاج أعرف:",
          questions: [
            { question: "ما زوايا أو محاور الموضوع المستهدفة؟" },
            { question: "ما عدد المنشورات المستهدف فحصها؟" },
          ],
        },
        ...fakeTokens,
        textBlockAr: "عشان أجهز لك خطة دقيقة، محتاج أعرف:",
      };
    }
    if (options.testScenario === "multiplatform_questions") {
      return {
        output: {
          type: "ask_clarification",
          reasonAr: "محتاج توضيح بسيط قبل الخطة.",
          questions: [
            { question: "التعليقات من منشور واحد ولا منشورات كتير؟" },
            { question: "الفترة الزمنية المستهدفة؟" },
            { question: "ملف واحد مجمع ولا ملف لكل منصة؟" },
          ],
        },
        ...fakeTokens,
      };
    }
    if (options.testScenario === "multiplatform_plan") {
      const mpStep = (stepId: string, slug: string, postUrl: string) => ({
        stepId,
        capabilitySlug: slug,
        endpointId: slug,
        params: { postUrl },
        targetVolumeMin: 1,
        targetVolumeMax: 1000,
        paginationStrategy: "cursor" as const,
      });
      return {
        output: {
          type: "propose_plan",
          summaryAr: "سحب 1000 تعليق من فيسبوك و1000 تعليق من تيك توك",
          capabilities: [
            mpStep("fb", "facebook-post-comments", "https://www.facebook.com/post/1"),
            mpStep("tt", "tiktok-post-comments", "https://www.tiktok.com/@x/video/1"),
          ],
          outputFormats: ["xlsx"],
          methodologyNotes: "اختبار وهمي.",
        },
        ...fakeTokens,
      };
    }
    if (options.testScenario === "plan_ghost_then_stall") {
      return {
        output: {
          type: "propose_plan",
          summaryAr: "خطة وهمية بخدمة غير موجودة",
          capabilities: [
            {
              stepId: "ghost",
              capabilitySlug: "facebook-ghost-endpoint",
              endpointId: "facebook-ghost-endpoint",
              params: { postUrl: "https://www.facebook.com/post/1" },
              targetVolumeMin: 1,
              targetVolumeMax: 10,
              paginationStrategy: "cursor",
            },
          ],
          outputFormats: ["xlsx"],
          methodologyNotes: "اختبار وهمي.",
        },
        ...fakeTokens,
      };
    }
    if (options.testScenario === "direct_plan") {
      return {
        output: {
          type: "propose_plan",
          summaryAr: "استخراج تعليقات فيسبوك العامة حول البطالة في مصر",
          capabilities: [
            {
              stepId: "fb_comments",
              capabilitySlug: "facebook-post-comments",
              endpointId: "facebook-post-comments",
              params: { postUrl: "https://www.facebook.com/post/123", maxPages: 5 },
              targetVolumeMin: 10,
              targetVolumeMax: 50,
              paginationStrategy: "cursor",
            },
          ],
          outputFormats: ["xlsx", "csv"],
          methodologyNotes: "اختبار وهمي.",
        },
        ...fakeTokens,
      };
    }
    if (options.testScenario === "summary_then_plan") {
      if (hasSummary) {
        return {
          output: {
            type: "propose_plan",
            summaryAr: "استكمال الخطة بعد تلخيص السياق",
            capabilities: [
              {
                stepId: "fb_comments",
                capabilitySlug: "facebook-post-comments",
                endpointId: "facebook-post-comments",
                params: { postUrl: "https://www.facebook.com/post/123", maxPages: 5 },
                targetVolumeMin: 10,
                targetVolumeMax: 50,
                paginationStrategy: "cursor",
              },
            ],
            outputFormats: ["xlsx", "csv"],
            methodologyNotes: "اختبار وهمي.",
          },
          ...fakeTokens,
        };
      }
      return {
        output: {
          type: "ask_clarification",
          reasonAr: "سؤال بعد التلخيص.",
          questions: [{ question: "هل نستكمل بنفس الخطة؟" }],
        },
        ...fakeTokens,
      };
    }
    const lastUserMsg = [...options.messages].reverse().find((m) => m.role === "user")?.content || "";
    const requestHistoryText = options.messages
      .filter((entry) => entry.role === "user")
      .map((entry) => entry.content)
      .join(" ");
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
          reasonAr: "يمكنني المساعدة في جمع البيانات من المصادر المتاحة، ولا أستطيع الوصول إلى بيانات خاصة أو سرية.",
        },
        inputTokens: 400,
        outputTokens: 40,
        costUsd: (400 * 0.10 + 40 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // B2. Greetings & Casual Questions (Phase 1 fast path)
    const { isGreeting, isGeneralQuestion } = isGreetingOrGeneralQuestion(lastUserMsg);
    if (isGreeting || isGeneralQuestion) {
      const answerText = isGreeting
        ? "أهلاً بك! أنا مساعد Diger للبحث وجمع البيانات من المصادر المتاحة. كيف يمكنني مساعدتك اليوم؟"
        : "أنا مساعد Diger، أساعدك في تصميم البحث وجمع البيانات من المصادر المتاحة وتسليمها في ملفات منظمة. كيف نبدأ؟";
      return {
        output: {
          type: "answer_question",
          answerAr: answerText,
          topic: isGreeting ? "greeting" : "identity",
          intent: "chat",
        },
        inputTokens: 250,
        outputTokens: 50,
        costUsd: 0,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // B2b. Specific Wedding & Manqulat Request (Claude Decides: Complete plan directly)
    const hasPresentCapabilities =
      Array.isArray(options.sanitizedCapabilities) && options.sanitizedCapabilities.length > 0;
    const isExactWeddingPlan =
      hasPresentCapabilities &&
      options.testScenario !== "phase_b_scenario_b" &&
      (promptLower.includes("10 منشورات") ||
        promptLower.includes("50 تعليق") ||
        (promptLower.includes("المنقولات") && promptLower.includes("2026") && !promptLower.includes("ريلز")));
    if (isExactWeddingPlan) {
      return {
        output: {
          type: "propose_plan",
          summaryAr: "جمع 10 منشورات عامة و500 تعليق على فيسبوك حول قائمة المنقولات وتكاليف الزواج في مصر",
          capabilities: [
            {
              stepId: "fb_posts_search",
              capabilitySlug: "facebook-post-search",
              endpointId: "facebook-post-search",
              params: {
                query: "قائمة المنقولات وتكاليف الزواج والمهر والشبكة",
                dateFrom: "2026-01-01",
                dateTo: "2026-09-30",
              },
              targetVolumeMin: 1,
              targetVolumeMax: 10,
              paginationStrategy: "offset",
              volumeMode: "bounded",
            },
            {
              stepId: "fb_post_comments",
              capabilitySlug: "facebook-post-comments",
              endpointId: "facebook-post-comments",
              params: {
                postUrl: "https://www.facebook.com/post/1",
                includeReplies: true,
              },
              targetVolumeMin: 10,
              targetVolumeMax: 500,
              paginationStrategy: "cursor",
              dependsOn: ["fb_posts_search"],
              inputFrom: {
                stepId: "fb_posts_search",
                field: "postUrl",
                paramKey: "postUrl",
              },
              fanOutCap: 50,
              windowed: true,
            },
          ],
          outputFormats: ["xlsx", "csv", "pdf"],
          methodologyNotes:
            "الكلمات المفتاحية المقترحة: قائمة المنقولات، المهر، الشبكة، مؤخر الصداق، تجهيز منزل الزوجية، تكاليف الزواج، أزمة الزواج في مصر. جمع المنشورات بالفترة المحددة بحد أقصى 50 تعليقاً لكل منشور.",
        },
        inputTokens: 600,
        outputTokens: 120,
        costUsd: (600 * 0.10 + 120 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // B2c. Vague request mentioning platform only (e.g. "عايز بيانات فيسبوك", "عايز بيانات تيك توك")
    const isVaguePlatformRequest =
      !options.testScenario?.startsWith("phase_b_scenario_c") &&
      (/^(عايز|عاوز|محتاج|أريد|اريد)\s+بيانات\s+(فيسبوك|تيك توك|انستغرام|تويتر|x)$/i.test(promptLower.trim()) ||
        /^(عايز|عاوز|محتاج|أريد|اريد)\s+(فيسبوك|تيك توك|انستغرام|تويتر|x)\s+بيانات$/i.test(promptLower.trim()) ||
        promptLower.trim() === "عايز بيانات فيسبوك" ||
        promptLower.trim() === "عايز بيانات تيك توك");
    if (isVaguePlatformRequest) {
      return {
        output: {
          type: "ask_clarification",
          reasonAr: "عشان أجهز لك خطة دقيقة، محتاج أعرف:",
          questions: [
            {
              id: "code_topic",
              text: "ما الموضوع أو الكلمات المفتاحية المطلوب البحث عنها؟",
              question: "ما الموضوع أو الكلمات المفتاحية المطلوب البحث عنها؟",
              type: "free",
              options: [],
              allowOther: true,
            },
          ],
        },
        inputTokens: 350,
        outputTokens: 50,
        costUsd: (350 * 0.10 + 50 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // B3. Deterministic Phase 2 Plan Proposal Handling
    const hasPhase2PlanInstruction = (options.messages || []).some(
      (m) =>
        typeof m.content === "string" &&
        (m.content.includes("المرحلة الثانية") || m.content.includes("متطلبات البحث مكتملة")) &&
        m.content.includes("propose_plan"),
    );
    if (hasPhase2PlanInstruction || options.testScenario === "phase2_plan") {
      const isPeoplePrompt = isPeopleSearchRequest(promptLower);

      const isCompanyPrompt =
        !isPeoplePrompt &&
        (promptLower.includes("شركات") ||
        promptLower.includes("شركة") ||
        promptLower.includes("مؤسسات") ||
        promptLower.includes("مؤسسة") ||
        promptLower.includes("companies") ||
        promptLower.includes("b2b"));

      const targetPlatform = isPeoplePrompt
        ? "people"
        : isCompanyPrompt
        ? "compan"
        : promptLower.includes("فيسبوك") || promptLower.includes("facebook")
        ? "facebook"
        : promptLower.includes("instagram") || promptLower.includes("انستغرام")
        ? "instagram"
        : promptLower.includes("tiktok") || promptLower.includes("تيك توك")
        ? "tiktok"
        : promptLower.includes("twitter") || promptLower.includes("تويتر") || /\bمنصة\s*x\b|\bx\b/i.test(promptLower)
        ? "x"
        : promptLower.includes("youtube") || promptLower.includes("يوتيوب")
        ? "youtube"
        : promptLower.includes("reddit") || promptLower.includes("ريديت")
        ? "reddit"
        : "";

      const matchedCap = (options.sanitizedCapabilities || []).find((c: any) =>
        (c.platform || c.slug || c.category || c.id || "").toLowerCase().includes(targetPlatform)
      ) || options.sanitizedCapabilities?.[0] || {
        slug: isPeoplePrompt ? "professional-people-search" : (isCompanyPrompt ? "icypeas-companies-search" : "facebook-post-comments"),
        id: isPeoplePrompt ? "treg.people.search" : (isCompanyPrompt ? "icypeas.companies.search" : "facebook-post-comments"),
        nameAr: isPeoplePrompt ? "استخراج بيانات صناع القرار والمسؤولين" : (isCompanyPrompt ? "بحث واستخراج بيانات الشركات" : "استخراج تعليقات فيسبوك"),
      };

      let volume = 100;
      const volMatch = lastUserMsg.match(/(\d+|[٠-٩]+)/);
      if (volMatch) {
        const raw = volMatch[1].replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)]);
        const parsed = parseInt(raw, 10);
        if (parsed > 0) volume = parsed;
      }
      for (const m of options.messages) {
        if (typeof m.content === "string") {
          const mVol = m.content.match(/حجم البيانات.*حتى\s*(\d+|[٠-٩]+)/);
          if (mVol) {
            const raw = mVol[1].replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)]);
            volume = parseInt(raw, 10);
          }
        }
      }

      const isCompanySearch =
        (!isPeoplePrompt && isCompanyPrompt) ||
        (matchedCap.platform || matchedCap.category || matchedCap.slug || "").toLowerCase().includes("compan") ||
        (matchedCap.platform || matchedCap.category || matchedCap.slug || "").toLowerCase().includes("b2b") ||
        (!isPeoplePrompt && (matchedCap.id || "").includes("icypeas"));

      const fallbackCountry = detectCountryFromText(lastUserMsg);
      const fallbackIndustry = detectIndustryFromText(lastUserMsg);
      const fallbackTitle = lastUserMsg.match(/\b(ceos?|ctos?|cfos?|coos?|founders?|owners?|directors?|managers?|heads?|vps?|presidents?)\b|الرئيس التنفيذي|مدير(?:ين)?|مؤسس(?:ين)?|رئيس مجلس الإدارة/i);
      const missingCompanyRequirements = getMissingCompanyResearchRequirements(requestHistoryText);
      if (isCompanySearch && missingCompanyRequirements.length > 0) {
        const items = getCompanyRequirementItems(missingCompanyRequirements, requestHistoryText);
        const questions = items.map((item) => item.text);
        const intro = "قبل إعداد عرض السعر، أحتاج تحديد نطاق البحث وهدف التواصل حتى لا أخمّن تفاصيل قد تغيّر النتائج.";
        return {
          output: {
            type: "ask_clarification",
            intro,
            reasonAr: intro,
            questions: items,
            questionsAr: questions,
          },
          inputTokens: 600,
          outputTokens: 90,
          costUsd: (600 * 0.10 + 90 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }
      const hasExplicitCompanyIndustry = !missingCompanyRequirements.includes("industry");
      const fallbackScope = [
        hasExplicitCompanyIndustry ? fallbackIndustry.arabicLabel : undefined,
        fallbackCountry?.arabicLabel,
      ].filter(Boolean).join(" في ");
      const params = isPeoplePrompt
        ? {
            q: lastUserMsg.slice(0, 300),
            limit: volume,
            ...(fallbackCountry ? {
              country: ({
                Egypt: "EG", "Saudi Arabia": "SA", "United Arab Emirates": "AE", Kuwait: "KW",
                Qatar: "QA", Bahrain: "BH", Oman: "OM", Jordan: "JO", Germany: "DE",
                Austria: "AT", France: "FR", Italy: "IT", Spain: "ES", Switzerland: "CH",
                Netherlands: "NL", Turkey: "TR", "United Kingdom": "GB", "United States": "US",
              } as Record<string, string>)[fallbackCountry.canonicalEnglish] || fallbackCountry.canonicalEnglish,
            } : {}),
            ...(fallbackTitle ? { title: (fallbackTitle[1] || fallbackTitle[0]).replace(/s$/i, "") } : {}),
            ...(fallbackIndustry.englishKeywords.length ? { keywords: fallbackIndustry.englishKeywords } : {}),
            ...(requiredProfessionalContactFields(lastUserMsg).length ? { requiredContactFields: requiredProfessionalContactFields(lastUserMsg) } : {}),
          }
        : isCompanySearch
        ? {
            query: {
              ...(hasExplicitCompanyIndustry ? { keyword: { include: fallbackIndustry.englishKeywords } } : {}),
              ...(fallbackCountry ? { location: { include: [fallbackCountry.canonicalEnglish] } } : {}),
            },
            pagination: { size: volume },
          }
        : { query: lastUserMsg.slice(0, 50), postUrl: "https://www.facebook.com/post/123" };

      const summaryAr = isPeoplePrompt
        ? `استخراج بيانات ${volume} من صناع القرار والمهنيين وفق معايير الطلب`
        : isCompanySearch
        ? `استخراج بيانات ${volume} سجل من الشركات${fallbackScope ? ` في ${fallbackScope}` : " بعد تحديد الدولة والقطاع"}`
        : `استخراج البيانات المطلوبة عبر خدمة ${matchedCap.nameAr || matchedCap.slug}`;

      return {
        output: {
          type: "propose_plan",
          summaryAr,
          capabilities: [
            {
              stepId: "plan_step_1",
              capabilitySlug: matchedCap.slug || (isCompanySearch ? "icypeas-companies-search" : "facebook-post-comments"),
              endpointId: matchedCap.id || matchedCap.slug || (isCompanySearch ? "icypeas.companies.search" : "facebook-post-comments"),
              params,
              targetVolumeMin: 1,
              targetVolumeMax: volume,
              paginationStrategy: isCompanySearch || isPeoplePrompt ? "none" : "cursor",
            },
          ],
          outputFormats: ["xlsx", "pdf", "csv"],
          methodologyNotes: isCompanySearch
            ? "جمع وتوثيق البيانات من المصادر المتاحة وفق نطاق البحث المحدد."
            : "جمع وتوثيق البيانات من المصادر المتاحة وفق نطاق البحث المحدد.",
        },
        inputTokens: 600,
        outputTokens: 120,
        costUsd: (600 * 0.10 + 120 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // B4. Deterministic Phase 1 Understanding Handling
    const hasPhase1Instruction = (options.messages || []).some(
      (m) =>
        typeof m.content === "string" &&
        (m.content.includes("مرحلة الاستيعاب") ||
          m.content.includes("Phase 1") ||
          m.content.includes("استوعب هدف البحث")),
    );
    if (hasPhase1Instruction || options.testScenario === "phase1_understanding") {
      return {
        output: {
          type: "update_brief",
          replyAr: "عشان أجهز لك خطة دقيقة، محتاج أعرف بعض التفاصيل:",
          questions: [
            {
              id: "q_volume",
              text: "ما حجم البيانات المطلوب جمعها؟",
              question: "ما حجم البيانات المطلوب جمعها؟",
              type: "single",
              options: ["حتى 500 سجل", "حتى 1000 سجل", "أكثر من 1000 سجل"],
              allowOther: true,
            },
          ],
        },
        inputTokens: 450,
        outputTokens: 80,
        costUsd: (450 * 0.10 + 80 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // C0. Greetings and conversational openings (answer_question)
    const isUserGreeting =
      isGreetingOrGeneralQuestion(lastUserMsg).isGreeting ||
      /^(أهلا|أهلاً|اهلا|مرحبا|مرحباً|ازيك|ازيكم|صباح الخير|مساء الخير|السلام عليكم|سلام عليكم|هلا|هاي|hello|hi)/i.test(promptLower.trim());

    if (isUserGreeting) {
      const uName = options.userProfile?.displayName || "مجدي";
      const uBal = options.userBalancePoints != null ? options.userBalancePoints : 500;
      const uBalAr = toArabicDigits(uBal);
      return {
        output: {
          type: "answer_question",
          intent: "chat",
          answerAr: `أهلاً يا ${uName}، رصيدك ${uBalAr} نقطة. كيف يمكنني مساعدتك اليوم في البحث من المصادر المتاحة؟`,
          topic: "greeting",
        },
        inputTokens: 300,
        outputTokens: 40,
        costUsd: (300 * 0.10 + 40 * 0.50) / 1_000_000,
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
      promptLower.includes("ما هي diger") ||
      promptLower.includes("ما هي digr") ||
      promptLower.includes("ما هي ديجر") ||
      promptLower.includes("ما هي الملفات") ||
      promptLower.includes("كم يستغرق")
    ) {
      let answerText = "تتيح لك منصة Diger جمع البيانات من المصادر المتاحة وتسليمها في ملفات منظمة.";
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
              "خطة متعددة الخطوات لجمع منشورات وتعليقات فيسبوك حول موضوعات الزواج في الفترة من 1 يناير إلى 30 سبتمبر 2026 (البحث في المنشورات العامة ثم سحب التعليقات بحد أقصى محدد لكل منشور، مع توضيح أن مقاطع الريلز والفيديو غير المتاحة حالياً تُستثنى بصدق)",
            capabilities: [
              {
                stepId: "fb_posts_search",
                capabilitySlug: "facebook-post-search",
                endpointId: "facebook-post-search",
                params: {
                  query: "قائمة المنقولات، تكاليف الزواج، المهر، الشبكة، النفقة",
                  dateFrom: "2026-01-01",
                  dateTo: "2026-09-30",
                },
                targetVolumeMin: 1,
                targetVolumeMax: 5,
                paginationStrategy: "offset",
                volumeMode: "bounded",
              },
              {
                stepId: "fb_post_comments",
                capabilitySlug: "facebook-post-comments",
                endpointId: "facebook-post-comments",
                params: {
                  includeReplies: true,
                },
                targetVolumeMin: 5,
                targetVolumeMax: 25,
                paginationStrategy: "cursor",
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

    // D. Catalog-driven Platform Handling (Phase B)
    const hasCapForPlatform = (plat: string) => {
      const inCapabilities = (options.sanitizedCapabilities || []).some((c: any) => {
        const cPlat = (c.platform || c.category || c.slug || "").toLowerCase();
        return cPlat.includes(plat.toLowerCase()) && c.enabled !== false;
      });
      // The full platform guide remains authoritative when this turn's catalog
      // search is narrow or empty; it must not become an availability gate.
      return inCapabilities || ["instagram", "reddit", "linkedin", "facebook", "youtube", "tiktok", "x", "twitter"].includes(plat.toLowerCase());
    };

    if (
      options.testScenario === "phase_b_scenario_d" ||
      promptLower.includes("منصة_غير_معروفة") ||
      promptLower.includes("خدمة غير مدعومة")
    ) {
      return {
        output: {
          type: "ask_clarification",
          intro: "ما الموضوع أو البيانات التي تريد جمعها؟",
          reasonAr: "تحديد موضوع البحث المطلوب",
          questions: [{ id: "topic", text: "ما الموضوع أو البيانات المطلوبة؟", type: "free" }],
        },
        inputTokens: 500,
        outputTokens: 80,
        costUsd: (500 * 0.10 + 80 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    if (promptLower.includes("انستغرام") || promptLower.includes("إنستغرام") || promptLower.includes("instagram")) {
      if (hasCapForPlatform("instagram") || options.testScenario === "phase_b_scenario_c_instagram") {
        const cap = (options.sanitizedCapabilities || []).find((c: any) => (c.platform || c.slug || "").toLowerCase().includes("instagram")) || {
          slug: "instagram-profile",
          id: "treg-instagram-profile-v1",
        };
        return {
          output: {
            type: "propose_plan",
            summaryAr: "استخراج بيانات ملف الحساب والمنشورات العامة من إنستغرام",
            capabilities: [
              {
                stepId: "ig_profile",
                capabilitySlug: cap.slug || "instagram-profile",
                endpointId: cap.id || cap.slug || "instagram-profile",
                params: { username: "public_user" },
                targetVolumeMin: 1,
                targetVolumeMax: 10,
                paginationStrategy: "none",
              },
            ],
            outputFormats: ["xlsx", "pdf", "csv"],
            methodologyNotes: "استخراج البيانات من المصادر المتاحة لإنستغرام من خلال الأدوات المعتمدة.",
          },
          inputTokens: 600,
          outputTokens: 120,
          costUsd: (600 * 0.10 + 120 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }
    }

    if (promptLower.includes("ريديت") || promptLower.includes("reddit")) {
      if (hasCapForPlatform("reddit") || options.testScenario === "phase_b_scenario_c_reddit") {
        const cap = (options.sanitizedCapabilities || []).find((c: any) => (c.platform || c.slug || "").toLowerCase().includes("reddit")) || {
          slug: "reddit-post-search",
          id: "treg-reddit-post-search",
        };
        return {
          output: {
            type: "propose_plan",
            summaryAr: "استخراج منشورات وتعليقات عامة من مجتمعات منصة ريديت",
            capabilities: [
              {
                stepId: "reddit_search",
                capabilitySlug: cap.slug || "reddit-post-search",
                endpointId: cap.id || cap.slug || "reddit-post-search",
                params: { query: "search query", limit: 50 },
                targetVolumeMin: 5,
                targetVolumeMax: 50,
                paginationStrategy: "cursor",
              },
            ],
            outputFormats: ["xlsx", "pdf", "csv"],
            methodologyNotes: "استخراج المنشورات العامة ومناقشات المجتمعات من ريديت.",
          },
          inputTokens: 650,
          outputTokens: 120,
          costUsd: (650 * 0.10 + 120 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }
    }

    if (promptLower.includes("لينكد إن") || promptLower.includes("linkedin")) {
      if (hasCapForPlatform("linkedin")) {
        const cap = (options.sanitizedCapabilities || []).find((c: any) => (c.platform || c.slug || "").toLowerCase().includes("linkedin")) || {
          slug: "linkedin-search",
          id: "treg-linkedin-search",
        };
        return {
          output: {
            type: "propose_plan",
            summaryAr: "استخراج بيانات الشركات والوظائف العامة من لينكد إن",
            capabilities: [
              {
                stepId: "li_search",
                capabilitySlug: cap.slug || "linkedin-search",
                endpointId: cap.id || cap.slug || "linkedin-search",
                params: { query: "search query" },
                targetVolumeMin: 1,
                targetVolumeMax: 20,
                paginationStrategy: "page",
              },
            ],
            outputFormats: ["xlsx", "pdf", "csv"],
            methodologyNotes: "استخراج البيانات من المصادر المتاحة على شبكة لينكد إن.",
          },
          inputTokens: 650,
          outputTokens: 120,
          costUsd: (650 * 0.10 + 120 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }
    }

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
          ? "إنستغرام"
          : promptLower.includes("فيسبوك") || promptLower.includes("facebook")
          ? "فيسبوك"
          : promptLower.includes("ريديت") || promptLower.includes("reddit")
          ? "ريديت"
          : "لينكد إن";
      return {
        output: {
          type: "ask_clarification",
          intro: `ما البيانات التي تريد جمعها من ${platformName}؟`,
          reasonAr: "تحديد نوع البيانات المطلوب",
          questions: [{ id: "topic", text: "ما نوع البيانات المطلوبة؟", type: "free" }],
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
      const inCapabilities = (options.sanitizedCapabilities || []).some(
        (c: any) =>
          c.enabled !== false &&
          (c.slug === slug ||
            c.id === slug ||
            c.slug?.includes(slug) ||
            c.id?.includes(slug) ||
            (c.platform && c.platform.toLowerCase() === slug.split("-")[0]?.toLowerCase()))
      );
      return inCapabilities || [
        "tiktok-user-videos", "tiktok-keyword-videos", "tiktok-profile", "youtube-search",
        "youtube-channel-info", "youtube-comments", "x-keyword-search", "x-user-tweets",
      ].includes(slug);
    };

    // F. TikTok requests handling
    if (promptLower.includes("تيك توك") || promptLower.includes("tiktok")) {
      const isVideoRequest =
        promptLower.includes("مقاطع") ||
        promptLower.includes("فيديو") ||
        promptLower.includes("منشورات") ||
        promptLower.includes("posts") ||
        promptLower.includes("videos");

      if (isVideoRequest) {
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
                stepId: "tiktok_profile",
                capabilitySlug: "tiktok-profile",
                endpointId: "tiktok-profile",
                params: { username },
                targetVolumeMin: 1,
                targetVolumeMax: 1,
                paginationStrategy: "none",
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
            methodologyNotes: `استخراج البيانات من المصادر المتاحة لحساب @${username} بتاريخ اليوم.`,
          },
          inputTokens: 800,
          outputTokens: 140,
          costUsd: (800 * 0.10 + 140 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }
    }

    // G. X/Twitter tweets plan proposal
    if (promptLower.includes("تغريدات") || promptLower.includes("تويتر") || promptLower.includes("منصة x")) {
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
      const cap = (options.sanitizedCapabilities || []).find(
        (c: any) =>
          (c.platform || c.category || c.slug || "").toLowerCase().includes("x") ||
          (c.platform || c.category || c.slug || "").toLowerCase().includes("twitter")
      ) || {
        slug: "x-keyword-search",
        id: "treg-x-keyword-search",
      };

      return {
        output: {
          type: "propose_plan",
          summaryAr: `استخراج تغريدات منصة X بالكلمات الدلالية حتى ${targetVolume} تغريدة`,
          capabilities: [
            {
              stepId: "x_search",
              capabilitySlug: cap.slug || "x-keyword-search",
              endpointId: cap.id || cap.slug || "x-keyword-search",
              params: { query: "search query", max_results: targetVolume },
              targetVolumeMin: 1,
              targetVolumeMax: targetVolume,
              paginationStrategy: "cursor",
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

    // H. YouTube research plan
    if (promptLower.includes("يوتيوب") || promptLower.includes("youtube")) {
      const cap = (options.sanitizedCapabilities || []).find(
        (c: any) => (c.platform || c.category || c.slug || "").toLowerCase().includes("youtube")
      ) || {
        slug: promptLower.includes("تعليقات") ? "youtube-comments" : "youtube-search",
        id: promptLower.includes("تعليقات") ? "youtube-comments" : "youtube-search",
      };

      return {
        output: {
          type: "propose_plan",
          summaryAr: "استخراج مقاطع فيديو وتعليقات من منصة يوتيوب",
          capabilities: [
            {
              stepId: "yt_search",
              capabilitySlug: cap.slug || (promptLower.includes("تعليقات") ? "youtube-comments" : "youtube-search"),
              endpointId: cap.id || cap.slug || (promptLower.includes("تعليقات") ? "youtube-comments" : "youtube-search"),
              params: { query: "WHO COVID", count: 100 },
              targetVolumeMin: 50,
              targetVolumeMax: 100,
              paginationStrategy: "page",
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

    // I.1 Route contact and decision-maker requests to the people capability.
    const userHistoryText = requestHistoryText;
    if (isPeopleSearchRequest(userHistoryText)) {
      const parsedVolume = extractTargetVolume(userHistoryText);
      const targetVolume = parsedVolume && parsedVolume > 0 ? parsedVolume : 10;
      const country = detectCountryFromText(userHistoryText);
      const titleText = userHistoryText.toLowerCase();
      const titleMatch = titleText.match(/\b(ceos?|ctos?|cfos?|coos?|founders?|owners?|directors?|managers?|heads?|vps?|presidents?)\b|الرئيس التنفيذي|مدير(?:ين)?|مؤسس(?:ين)?|رئيس مجلس الإدارة/);
      const detectedIndustry = detectIndustryFromText(userHistoryText);
      const isoCountry = country ? ({
        Egypt: "EG", "Saudi Arabia": "SA", "United Arab Emirates": "AE", Kuwait: "KW",
        Qatar: "QA", Bahrain: "BH", Oman: "OM", Jordan: "JO", Germany: "DE",
        Austria: "AT", France: "FR", Italy: "IT", Spain: "ES", Switzerland: "CH",
        Netherlands: "NL", Turkey: "TR", "United Kingdom": "GB", "United States": "US",
      } as Record<string, string>)[country.canonicalEnglish] : undefined;
      const peopleParams: Record<string, any> = {
        q: userHistoryText.slice(0, 300),
        limit: targetVolume,
        ...(isoCountry ? { country: isoCountry } : {}),
        ...(titleMatch ? { title: (titleMatch[1] || titleMatch[0]).replace(/s$/i, "") } : {}),
        ...(detectedIndustry.englishKeywords.length ? { keywords: detectedIndustry.englishKeywords } : {}),
        ...(requiredProfessionalContactFields(userHistoryText).length ? { requiredContactFields: requiredProfessionalContactFields(userHistoryText) } : {}),
      };

      return {
        output: {
          type: "propose_plan",
          summaryAr: `استخراج بيانات ${targetVolume} من صناع القرار والمهنيين وفق معايير الطلب`,
          capabilities: [{
            stepId: "people_search",
            capabilitySlug: "professional-people-search",
            endpointId: "treg.people.search",
            params: peopleParams,
            targetVolumeMin: 1,
            targetVolumeMax: targetVolume,
            paginationStrategy: "none",
          }],
          outputFormats: ["xlsx", "pdf", "csv"],
          methodologyNotes: "البحث عن جهات الاتصال المهنية بحسب الكلمات والمسمى الوظيفي والدولة المذكورة في الطلب.",
        },
        inputTokens: 700,
        outputTokens: 120,
        costUsd: (700 * 0.10 + 120 * 0.50) / 1_000_000,
        model: fakeModel,
        promptVersion: PROMPT_VERSION,
      };
    }

    // I. Companies / B2B research plan proposal
    if (
      !isPeopleSearchRequest(userHistoryText) &&
      /(شركات|شركة|مؤسسات|مؤسسة|companies|\bcompany\b|\bbusiness\b)/i.test(userHistoryText)
    ) {
      const detectedCountry = detectCountryFromText(userHistoryText);
      const detectedIndustry = detectIndustryFromText(userHistoryText);
      const parsedVolume = extractTargetVolume(userHistoryText);
      const targetVolume = parsedVolume && parsedVolume > 0 ? parsedVolume : 10;
      const missingRequirements = getMissingCompanyResearchRequirements(userHistoryText);
      if (missingRequirements.length > 0) {
        const items = getCompanyRequirementItems(missingRequirements, userHistoryText);
        const questions = items.map((item) => item.text);
        const intro = "قبل إعداد عرض السعر، أحتاج تحديد نطاق البحث وهدف التواصل حتى لا أخمّن تفاصيل قد تغيّر النتائج.";
        return {
          output: {
            type: "ask_clarification",
            intro,
            reasonAr: intro,
            questions: items,
            questionsAr: questions,
          },
          inputTokens: 600,
          outputTokens: 70,
          costUsd: (600 * 0.10 + 70 * 0.50) / 1_000_000,
          model: fakeModel,
          promptVersion: PROMPT_VERSION,
        };
      }
      const countryEn = detectedCountry!.canonicalEnglish;
      const countryAr = detectedCountry!.arabicLabel;
      const industryKeywords = detectedIndustry.englishKeywords;
      const industryAr = detectedIndustry.arabicLabel;

      const cap = (options.sanitizedCapabilities || []).find(
        (c: any) =>
          (c.platform || c.category || c.slug || "").toLowerCase().includes("compan") ||
          (c.platform || c.category || c.slug || "").toLowerCase().includes("b2b") ||
          (c.id || "").includes("icypeas")
      ) || {
        slug: "icypeas-companies-search",
        id: "icypeas.companies.search",
      };

      return {
        output: {
          type: "propose_plan",
          summaryAr: `استخراج بيانات ${targetVolume} سجل من شركات ${industryAr} في ${countryAr}`,
          capabilities: [
            {
              stepId: "plan_step_1",
              capabilitySlug: cap.slug || "icypeas-companies-search",
              endpointId: cap.id || cap.slug || "icypeas.companies.search",
              params: {
                query: { keyword: { include: industryKeywords }, location: { include: [countryEn] } },
                country: countryEn,
                location: countryEn,
                industry: industryAr,
                pagination: { size: targetVolume },
              },
              targetVolumeMin: 1,
              targetVolumeMax: targetVolume,
              paginationStrategy: "none",
            },
          ],
          outputFormats: ["xlsx", "pdf", "csv"],
          methodologyNotes: `جمع وتوثيق البيانات من المصادر المتاحة لقواعد بيانات الشركات (${industryAr} في ${countryAr}) وفق المعايير البحثية المعتمدة.`,
        },
        inputTokens: 800,
        outputTokens: 140,
        costUsd: (800 * 0.10 + 140 * 0.50) / 1_000_000,
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
  /**
   * Handle provider errors cleanly (timeout, 429, 404 model, 401 auth, 5xx):
   * Return short Arabic error ("المساعد غير متاح الآن، حاول لاحقًا"), 0 tokens, 0 cost, so no points are held.
   * Records a short reason code in server logs and llm-status without ever logging keys or secrets.
   */
  private handleProviderError(err: any, provider: string, detail?: string | null): LlmCallResult {
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
      if (!detail && err?.issues && Array.isArray(err.issues)) {
        const paths = err.issues.map((iss: any) => (Array.isArray(iss.path) ? iss.path.join(".") : String(iss.path || ""))).filter(Boolean);
        detail = paths.join(", ").slice(0, 200) || "schema_validation_failed";
      }
      if (!detail) {
        detail = "schema_validation_failed";
      }
    }

    const sanitizedDetail = detail ? sanitizeFallbackDetail(detail) : null;
    setLastLlmFallbackReason(fallbackCode);
    setLastLlmFallbackDetail(sanitizedDetail);

    const logDetail = sanitizedDetail ? ` detail=${sanitizedDetail}` : "";
    console.warn(`[llm:error] provider=${provider} model=${model} reason=${fallbackCode}${logDetail}`);

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

  private cleanClarificationQuestions(questions: any[]): any[] {
  if (!Array.isArray(questions)) return [];
  return questions
    .map((q: any) => {
      if (typeof q === "string") return { question: q.trim() };
      if (q && typeof q === "object") {
        const cleaned: any = {};
        if (q.id) cleaned.id = String(q.id);
        const qText = q.question || q.text;
        if (qText) {
          cleaned.question = String(qText).trim();
          cleaned.text = String(qText).trim();
        }
        if (["single", "multi", "free"].includes(q.type)) cleaned.type = q.type;
        if (
          ["platform", "time_window", "volume", "output_format", "anonymize", "language", "topic"].includes(
            q.parameterType,
          )
        ) {
          cleaned.parameterType = q.parameterType;
        }
        if (Array.isArray(q.options)) {
          const opts = q.options
            .map((opt: any) => String(opt || "").trim().slice(0, 40))
            .filter((opt: string) => opt.length > 0 && !INTERNAL_DISCOVERY_KEYS.has(opt.toLowerCase()))
            .slice(0, 4);
          if (opts.length > 0) cleaned.options = opts;
        }
        if (typeof q.allowOther === "boolean") cleaned.allowOther = q.allowOther;
        if (typeof q.defaultOption === "string") cleaned.defaultOption = q.defaultOption;
        return cleaned;
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, MAX_CLARIFICATION_QUESTIONS);
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

    // The long fixed rules are marked cacheable; only the small per-turn context after them changes.
    // Measured before this change: plan turns averaged 17.6k input tokens and 7.4 s (p50 6.3 s).
    const promptParts = buildSystemPromptParts({
      userProfile: options.userProfile,
      sanitizedCapabilities: options.sanitizedCapabilities,
      todayDate: options.todayDate,
      userBalancePoints: options.userBalancePoints,
      conversationState: options.conversationState,
    });
    const systemBlocks = [
      { type: "text", text: promptParts.staticText, cache_control: { type: "ephemeral" } },
      { type: "text", text: promptParts.dynamicText },
    ];

    const formattedMessages = sanitizeMessagesForAnthropic(options.messages, {
      ensureUserEnd: true,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const llmStartTime = Date.now();
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
          system: systemBlocks,
          messages: formattedMessages,
          tools: [
            {
              name: "actionResult",
              description: "Structured output response from the assistant adhering to Diger system protocols",
              input_schema: ACTION_RESULT_JSON_SCHEMA,
              cache_control: { type: "ephemeral" },
            },
          ],
          tool_choice: {
            type: "tool",
            name: "actionResult",
          },
        }),
      });

      clearTimeout(timeoutId);
      const llmLatencyMs = Date.now() - llmStartTime;
      console.log(
        JSON.stringify({
          tag: "anthropic_call_timing",
          model,
          latencyMs: llmLatencyMs,
          status: response.status,
        })
      );

      if (!response.ok) {
        const errText = await response.text();
        let fallbackDetail: string | null = null;
        try {
          const parsed = JSON.parse(errText);
          const errObj = parsed.error || parsed;
          const errType = typeof errObj.type === "string" ? errObj.type.trim() : "";
          const errMsg = typeof errObj.message === "string" ? errObj.message.trim() : "";
          if (errType && errMsg) {
            fallbackDetail = `${errType}: ${errMsg}`;
          } else if (errMsg) {
            fallbackDetail = errMsg;
          } else if (errType) {
            fallbackDetail = errType;
          }
        } catch {
          fallbackDetail = errText;
        }

        const err = new Error(`Anthropic API error (${response.status}): ${errText}`);
        (err as any).status = response.status;
        return this.handleProviderError(err, "anthropic", fallbackDetail);
      }

      const data: any = await response.json();

      let rawPayload: any = null;
      const textBlocks = data.content?.filter(
        (b: any) => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0,
      ) || [];
      const extractedText = textBlocks.map((b: any) => b.text.trim()).join("\n\n");

      const toolUse = data.content?.find((b: any) => b.type === "tool_use");
      if (toolUse && toolUse.input) {
        if (toolUse.name === "search_catalog") {
          rawPayload = { type: "search_catalog", ...toolUse.input };
        } else if (toolUse.name === "ask_questions") {
          rawPayload = { type: "ask_clarification", ...toolUse.input };
        } else if (toolUse.name === "update_brief") {
          rawPayload = { type: "update_brief", ...toolUse.input };
        } else if (toolUse.name === "propose_plan") {
          rawPayload = {
            type: "propose_plan",
            summaryAr: toolUse.input.summaryAr,
            capabilities: toolUse.input.steps || toolUse.input.capabilities,
            outputFormats: toolUse.input.outputFormats,
            methodologyNotes: toolUse.input.methodologyNotes,
          };
        } else {
          rawPayload = toolUse.input;
        }

        if (extractedText) {
          if (rawPayload.type === "ask_clarification" || rawPayload.type === "ask_questions") {
            if (!rawPayload.intro) rawPayload.intro = extractedText;
            if (!rawPayload.reasonAr) rawPayload.reasonAr = extractedText;
          } else if (rawPayload.type === "propose_plan") {
            if (!rawPayload.rationaleAr) rawPayload.rationaleAr = extractedText;
          }
        }
      } else {
        if (extractedText) {
          try {
            rawPayload = JSON.parse(extractedText);
          } catch {
            rawPayload = {
              type: "answer_question",
              answerAr: extractedText,
              intent: "chat",
            };
          }
        } else {
          rawPayload = {};
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

      if (scrubbedPayload.type === "ask_questions") {
        scrubbedPayload.type = "ask_clarification";
      }

      if (scrubbedPayload.type === "ask_clarification") {
        if (Array.isArray(scrubbedPayload.questions)) {
          scrubbedPayload.questions = this.cleanClarificationQuestions(scrubbedPayload.questions);
        }
        if (!scrubbedPayload.questionsAr && scrubbedPayload.questions) {
          scrubbedPayload.questionsAr = scrubbedPayload.questions
            .map((q: any) => (typeof q === "string" ? q : q.question || q.text || ""))
            .filter(Boolean);
        }
        if (!scrubbedPayload.reasonAr) {
          scrubbedPayload.reasonAr = scrubbedPayload.intro || "تحديد تفاصيل الطلب بدقة";
        }
      }

      if (scrubbedPayload.type === "propose_plan") {
        if (!scrubbedPayload.capabilities && scrubbedPayload.steps) {
          scrubbedPayload.capabilities = scrubbedPayload.steps;
        }
        if (!Array.isArray(scrubbedPayload.capabilities) || scrubbedPayload.capabilities.length === 0) {
          const defaultCap = options.sanitizedCapabilities?.[0];
          scrubbedPayload.capabilities = [
            {
              stepId: "plan_step_1",
              capabilitySlug: defaultCap?.slug || "icypeas-companies-search",
              params: {},
              targetVolumeMin: 1,
              targetVolumeMax: defaultCap?.maxRows || 5,
            },
          ];
        }
        const userPromptLower = (options.messages || [])
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join(" ")
          .toLowerCase();

        const isPeoplePrompt = isPeopleSearchRequest(userPromptLower);

        const isCompanyPrompt =
          !isPeoplePrompt &&
          (userPromptLower.includes("شركات") ||
          userPromptLower.includes("شركة") ||
          userPromptLower.includes("مؤسسات") ||
          userPromptLower.includes("مؤسسة") ||
          userPromptLower.includes("companies") ||
          userPromptLower.includes("company") ||
          userPromptLower.includes("b2b"));

        if (Array.isArray(scrubbedPayload.capabilities)) {
          for (const cap of scrubbedPayload.capabilities) {
            if (isPeoplePrompt || cap.capabilitySlug?.includes("people") || cap.endpointId?.includes("people")) {
              cap.capabilitySlug = "professional-people-search";
              cap.endpointId = "treg.people.search";
            } else if (isCompanyPrompt || cap.capabilitySlug?.includes("compan") || cap.capabilitySlug?.includes("b2b")) {
              cap.capabilitySlug = "icypeas-companies-search";
              cap.endpointId = "icypeas.companies.search";
            } else if (!cap.capabilitySlug) {
              cap.capabilitySlug =
                cap.endpointId ||
                cap.slug ||
                cap.id ||
                options.sanitizedCapabilities?.[0]?.slug ||
                "icypeas-companies-search";
            }
            if (!cap.params || typeof cap.params !== "object") cap.params = {};
            if (!cap.targetVolumeMin) cap.targetVolumeMin = 1;
            if (!cap.targetVolumeMax) cap.targetVolumeMax = 5;
          }
        }
        if (!scrubbedPayload.summaryAr) {
          scrubbedPayload.summaryAr = "خطة استخراج بيانات وبحث عامة";
        }
      }

      if (scrubbedPayload.type === "answer_question" && !scrubbedPayload.intent) {
        scrubbedPayload.intent = "chat";
      } else if (
        (scrubbedPayload.type === "propose_plan" ||
          scrubbedPayload.type === "ask_clarification" ||
          scrubbedPayload.type === "ask_questions" ||
          scrubbedPayload.type === "search_catalog") &&
        !scrubbedPayload.intent
      ) {
        scrubbedPayload.intent = "research";
      }

      let validatedOutput: LlmTurnOutput;
      const parseResult = LlmTurnOutputSchema.safeParse(scrubbedPayload);
      if (parseResult.success) {
        validatedOutput = parseResult.data;
      } else {
        const issues = parseResult.error.issues;
        const failingPaths = issues.map((iss) => (Array.isArray(iss.path) ? iss.path.join(".") : String(iss.path || ""))).filter(Boolean).join(", ").slice(0, 200);
        console.warn(`[llm:schema_tolerant_recovery] failingPaths=${failingPaths}`, JSON.stringify(issues), "payload:", JSON.stringify(scrubbedPayload));

        const candidateText =
          extractedText ||
          scrubbedPayload.answerAr ||
          scrubbedPayload.replyAr ||
          scrubbedPayload.reasonAr ||
          scrubbedPayload.summaryAr ||
          (typeof scrubbedPayload === "string" ? scrubbedPayload : "");

        if (typeof candidateText === "string" && candidateText.trim().length > 0) {
          validatedOutput = {
            type: "answer_question",
            answerAr: scrubWhiteLabelText(candidateText.trim()),
            intent: "chat",
          };
        } else {
          throw parseResult.error;
        }
      }

      // Cached prompt tokens are reported separately by the API: reads cost 0.1x and writes 1.25x of the
      // input price. Counting only `input_tokens` would hide most of the real spend from the daily cap.
      const uncachedInTokens = data.usage?.input_tokens || 800;
      const cacheReadTokens = Number(data.usage?.cache_read_input_tokens) || 0;
      const cacheWriteTokens = Number(data.usage?.cache_creation_input_tokens) || 0;
      const inTokens = uncachedInTokens + cacheReadTokens + cacheWriteTokens;
      const outTokens = data.usage?.output_tokens || 150;

      const pricing = getLlmPricingSettings(
        "anthropic",
        model,
        options.pricingSettings || this.customPricing
      );
      const weightedInputTokens = uncachedInTokens + cacheReadTokens * 0.1 + cacheWriteTokens * 1.25;
      const costUsd = (weightedInputTokens * pricing.inputCostPerMillion + outTokens * pricing.outputCostPerMillion) / 1_000_000;

      setLastLlmFallbackReason(null);
      setLastLlmFallbackDetail(null);

      return {
        output: validatedOutput,
        inputTokens: inTokens,
        outputTokens: outTokens,
        costUsd,
        model,
        promptVersion: PROMPT_VERSION,
        rawText: JSON.stringify(scrubbedPayload),
        textBlockAr: extractedText ? scrubWhiteLabelText(extractedText) : undefined,
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
          reasoning: { effort: (process.env.LLM_REASONING_EFFORT || "low").trim().toLowerCase() },
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
      if (parsedResult.type === "ask_questions") {
        parsedResult.type = "ask_clarification";
      }
      if (parsedResult.type === "ask_clarification") {
        if (Array.isArray(parsedResult.questions)) {
          parsedResult.questions = this.cleanClarificationQuestions(parsedResult.questions);
        }
        if (!parsedResult.questionsAr && parsedResult.questions) {
          parsedResult.questionsAr = parsedResult.questions
            .map((q: any) => (typeof q === "string" ? q : q.question || q.text || ""))
            .filter(Boolean);
        }
      }
      if (parsedResult.type === "ask_clarification" && !parsedResult.reasonAr) {
        parsedResult.reasonAr = parsedResult.intro || "تحديد تفاصيل الطلب بدقة";
      }

      if (parsedResult.type === "propose_plan") {
        if (!parsedResult.capabilities && parsedResult.steps) {
          parsedResult.capabilities = parsedResult.steps;
        }
        if (!Array.isArray(parsedResult.capabilities) || parsedResult.capabilities.length === 0) {
          const defaultCap = options.sanitizedCapabilities?.[0];
          parsedResult.capabilities = [
            {
              stepId: "plan_step_1",
              capabilitySlug: defaultCap?.slug || "icypeas-companies-search",
              params: {},
              targetVolumeMin: 1,
              targetVolumeMax: defaultCap?.maxRows || 5,
            },
          ];
        }
        const userPromptLower = (options.messages || [])
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join(" ")
          .toLowerCase();

        const isPeoplePrompt = isPeopleSearchRequest(userPromptLower);

        const isCompanyPrompt =
          !isPeoplePrompt &&
          (userPromptLower.includes("شركات") ||
          userPromptLower.includes("شركة") ||
          userPromptLower.includes("مؤسسات") ||
          userPromptLower.includes("مؤسسة") ||
          userPromptLower.includes("companies") ||
          userPromptLower.includes("company") ||
          userPromptLower.includes("b2b"));

        if (Array.isArray(parsedResult.capabilities)) {
          for (const cap of parsedResult.capabilities) {
            if (isPeoplePrompt || cap.capabilitySlug?.includes("people") || cap.endpointId?.includes("people")) {
              cap.capabilitySlug = "professional-people-search";
              cap.endpointId = "treg.people.search";
            } else if (isCompanyPrompt || cap.capabilitySlug?.includes("compan") || cap.capabilitySlug?.includes("b2b")) {
              cap.capabilitySlug = "icypeas-companies-search";
              cap.endpointId = "icypeas.companies.search";
            } else if (!cap.capabilitySlug) {
              cap.capabilitySlug =
                cap.endpointId ||
                cap.slug ||
                cap.id ||
                options.sanitizedCapabilities?.[0]?.slug ||
                "icypeas-companies-search";
            }
            if (!cap.params || typeof cap.params !== "object") cap.params = {};
            if (!cap.targetVolumeMin) cap.targetVolumeMin = 1;
            if (!cap.targetVolumeMax) cap.targetVolumeMax = 5;
          }
        }
        if (!parsedResult.summaryAr) {
          parsedResult.summaryAr = "خطة استخراج بيانات وبحث عامة";
        }
      }

      let validatedOutput: LlmTurnOutput;
      const parseResult = LlmTurnOutputSchema.safeParse(parsedResult);
      if (parseResult.success) {
        validatedOutput = parseResult.data;
      } else {
        const issues = parseResult.error.issues;
        const failingPaths = issues.map((iss) => (Array.isArray(iss.path) ? iss.path.join(".") : String(iss.path || ""))).filter(Boolean).join(", ").slice(0, 200);
        console.warn(`[llm:schema_tolerant_recovery] failingPaths=${failingPaths}`);

        const candidateText =
          parsedResult.answerAr ||
          parsedResult.replyAr ||
          parsedResult.reasonAr ||
          parsedResult.summaryAr ||
          (typeof parsedResult === "string" ? parsedResult : "");

        if (typeof candidateText === "string" && candidateText.trim().length > 0) {
          validatedOutput = {
            type: "answer_question",
            answerAr: scrubWhiteLabelText(candidateText.trim()),
          };
        } else {
          throw parseResult.error;
        }
      }

      const inTokens = data.usage?.input_tokens || 800;
      const outTokens = data.usage?.output_tokens || 150;

      const pricing = getLlmPricingSettings(
        "openai",
        model,
        options.pricingSettings || this.customPricing
      );
      const costUsd = (inTokens * pricing.inputCostPerMillion + outTokens * pricing.outputCostPerMillion) / 1_000_000;

      setLastLlmFallbackReason(null);
      setLastLlmFallbackDetail(null);

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

