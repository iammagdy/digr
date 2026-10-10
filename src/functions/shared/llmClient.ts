import { z } from "zod";
import { buildSystemPrompt, PROMPT_VERSION } from "./systemPrompt";

// ================= Schema Definitions =================

export const ClarificationQuestionItemSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
});

export const AskClarificationSchema = z.object({
  type: z.literal("ask_clarification"),
  questions: z.array(ClarificationQuestionItemSchema).min(1).max(3).optional(),
  questionsAr: z.array(z.string().min(1)).min(1).max(3).optional(),
  optionsAr: z.array(z.array(z.string().min(1))).optional(),
  reasonAr: z.string().min(1),
});

export const PlanCapabilityItemSchema = z.object({
  capabilitySlug: z.string().min(1),
  params: z.record(z.string(), z.any()),
  targetVolumeMin: z.number().int().min(1),
  targetVolumeMax: z.number().int().min(1),
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

// ================= LLM Client Implementation =================

export class LlmClient {
  private model: string;
  private isLive: boolean;

  constructor() {
    this.model = process.env.LLM_MODEL || "gpt-6-luna";
    this.isLive = process.env.LLM_LIVE === "true";
  }

  /**
   * Main interaction point with budget enforcement & schema validation
   */
  async executeTurn(options: LlmCallOptions): Promise<LlmCallResult> {
    // 1. Kill-switch check
    if (process.env.LLM_ENABLED === "false") {
      return {
        output: {
          type: "refuse",
          reasonAr: "خدمة المساعد الذكي معطلة مؤقتاً للصيانة. يرجى المحاولة في وقت لاحق.",
        },
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        model: this.model,
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
        model: this.model,
        promptVersion: PROMPT_VERSION,
      };
    }

    // 3. Fake vs Live execution
    if (!this.isLive || options.testScenario || !process.env.OPENAI_API_KEY) {
      return this.executeFakeLlm(options);
    }

    return this.executeRealOpenAi(options);
  }

  /**
   * Deterministic Fake LLM for unit tests, offline development, and zero-cost simulation
   */
  private executeFakeLlm(options: LlmCallOptions): LlmCallResult {
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
        model: this.model,
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
        model: this.model,
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
        model: this.model,
        promptVersion: PROMPT_VERSION,
      };
    }

    // D. Unsupported Platforms & "Request this service" trigger
    if (
      promptLower.includes("انستغرام") ||
      promptLower.includes("instagram") ||
      promptLower.includes("linkedin") ||
      promptLower.includes("لينكد إن") ||
      promptLower.includes("فيسبوك") ||
      promptLower.includes("facebook")
    ) {
      const platformName = promptLower.includes("instagram") || promptLower.includes("انستغرام") ? "Instagram" : "LinkedIn";
      return {
        output: {
          type: "suggest_alternative",
          unsupportedService: platformName,
          explanationAr: `خدمة استخراج البيانات من منصة ${platformName} غير متوفرة حالياً في كتالوج الخدمات المعتمد.`,
          closestAlternative: "يمكنك استخدام خدمات تيك توك المعتمدة والمتاحة حالياً، أو تسجيل طلب لتفعيل هذه الخدمة قريباً.",
          canRequestFeature: true,
        },
        inputTokens: 500,
        outputTokens: 80,
        costUsd: (500 * 0.10 + 80 * 0.50) / 1_000_000,
        model: this.model,
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
        model: this.model,
        promptVersion: PROMPT_VERSION,
      };
    }

    const isCapEnabled = (slug: string) => {
      if (!options.sanitizedCapabilities || options.sanitizedCapabilities.length === 0) {
        return true;
      }
      return options.sanitizedCapabilities.some((c: any) => c.slug === slug);
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
          model: this.model,
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
          model: this.model,
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
                  question: "ما هو اسم المستخدم أو المعرف (@username) للحساب المطلوب استخراج بياناته على تيك توك؟",
                  options: ["@tiktok", "@iam_megz", "@khaby.lame"],
                },
              ],
              questionsAr: [
                "ما هو اسم المستخدم أو المعرف (@username) للحساب المطلوب استخراج بياناته على تيك توك؟",
              ],
              reasonAr: "يرجى تحديد معرف الحساب المطلوب استخراج بياناته.",
            },
            inputTokens: 500,
            outputTokens: 60,
            costUsd: (500 * 0.10 + 60 * 0.50) / 1_000_000,
            model: this.model,
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
          model: this.model,
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
            explanationAr: "خدمة استخراج البيانات من منصة X قيد التحقق وستتاح قريباً في المنصة. الخدمة المعتمدة والمتاحة حالياً هي استخراج ملف تيك توك الشخصي.",
            closestAlternative: "يمكنك تجربة استخراج بيانات حساب تيك توك عام (@username).",
            canRequestFeature: true,
          },
          inputTokens: 500,
          outputTokens: 80,
          costUsd: (500 * 0.10 + 80 * 0.50) / 1_000_000,
          model: this.model,
          promptVersion: PROMPT_VERSION,
        };
      }

      if (promptLower.includes("تتبع") || (!promptLower.includes("تغريدة") && !promptLower.includes("200") && !promptLower.includes("500"))) {
        return {
          output: {
            type: "ask_clarification",
            questionsAr: [
              "ما هي الكلمات الدلالية أو الحسابات المستهدفة على منصة X؟",
              "ما هو الحد الأقصى لعدد التغريدات المطلوب جمعها؟",
            ],
            reasonAr: "تحديد تفاصيل طلب تغريدات منصة X بدقة",
          },
          inputTokens: 600,
          outputTokens: 70,
          costUsd: (600 * 0.10 + 70 * 0.50) / 1_000_000,
          model: this.model,
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
        model: this.model,
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
            explanationAr: "خدمة استخراج البيانات من منصة يوتيوب غير مفعلة حالياً في الكتالوج المعتمد بانتظار استكمال اختبارات التحقق. الخدمة المعتمدة والمتاحة حالياً هي استخراج ملف تيك توك الشخصي.",
            closestAlternative: "يمكنك تجربة استخراج بيانات حساب تيك توك عام (@username).",
            canRequestFeature: true,
          },
          inputTokens: 500,
          outputTokens: 80,
          costUsd: (500 * 0.10 + 80 * 0.50) / 1_000_000,
          model: this.model,
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
        model: this.model,
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
            options: ["معرف حساب محدد (@username)", "كلمات مفتاحية عامة"],
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
      model: this.model,
      promptVersion: PROMPT_VERSION,
    };
  }

  /**
   * Real OpenAI Responses API execution
   */
  private async executeRealOpenAi(options: LlmCallOptions): Promise<LlmCallResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const systemPrompt = buildSystemPrompt({
      userProfile: options.userProfile,
      sanitizedCapabilities: options.sanitizedCapabilities,
      todayDate: options.todayDate,
      userBalancePoints: options.userBalancePoints,
      conversationState: options.conversationState,
    });

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
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
                actionResult: {
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
                    questionsAr: { type: "array", items: { type: "string" } },
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
                },
              },
              required: ["actionResult"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errText}`);
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
      parsedResult.questionsAr = parsedResult.questions.map((q: any) => typeof q === "string" ? q : q.question);
    }

    const validatedOutput = LlmTurnOutputSchema.parse(parsedResult);

    const inTokens = data.usage?.input_tokens || 800;
    const outTokens = data.usage?.output_tokens || 150;
    const costUsd = (inTokens * 0.15 + outTokens * 0.60) / 1_000_000;

    return {
      output: validatedOutput,
      inputTokens: inTokens,
      outputTokens: outTokens,
      costUsd,
      model: this.model,
      promptVersion: PROMPT_VERSION,
      rawText: scrubbed,
    };
  }
}
