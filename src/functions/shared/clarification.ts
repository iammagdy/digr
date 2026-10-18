import { z } from "zod";
import type { Capability } from "./capabilityRegistry";

export const MAX_CLARIFICATION_QUESTIONS = 8;

export const ClarificationParameterTypeSchema = z.enum([
  "platform",
  "time_window",
  "volume",
  "output_format",
  "anonymize",
  "language",
  "topic",
]);

export const INTERNAL_DISCOVERY_KEYS = new Set([
  "questionid",
  "answers",
  "clarification",
  "type",
  "question",
  "value",
  "skipped",
  "resolveddefault",
  "needsuserchoice",
  "allowother",
  "defaultoption",
  "parametertype",
]);

export const ClarificationQuestionInputSchema = z
  .object({
    id: z.string().trim().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    text: z.string().trim().min(1).max(120).optional(),
    // Legacy field retained for callers using the original { question, options } shape.
    question: z.string().trim().min(1).max(120).optional(),
    type: z.enum(["single", "multi", "free"]).optional(),
    parameterType: ClarificationParameterTypeSchema.optional(),
    options: z.array(z.string().trim().min(1).max(40)).max(4).optional(),
    allowOther: z.boolean().optional(),
    defaultOption: z.string().trim().min(1).max(40).optional(),
  })
  .strict()
  .refine((item) => Boolean(item.text || item.question), {
    message: "A clarification question needs text or a legacy question field",
  });

export const AskClarificationSchema = z
  .object({
    type: z.literal("ask_clarification"),
    intro: z.string().trim().max(200).optional(),
    questions: z.array(ClarificationQuestionInputSchema).min(1).max(MAX_CLARIFICATION_QUESTIONS).optional(),
    // Legacy fields are accepted only as compatibility inputs and normalized server-side.
    questionsAr: z.array(z.string().trim().min(1).max(120)).min(1).max(MAX_CLARIFICATION_QUESTIONS).optional(),
    optionsAr: z.array(z.array(z.string().trim().min(1).max(40)).max(4)).max(MAX_CLARIFICATION_QUESTIONS).optional(),
    reasonAr: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((item) => Boolean(item.questions?.length || item.questionsAr?.length), {
    message: "At least one clarification question is required",
  });

export type ClarificationQuestionInput = z.infer<typeof ClarificationQuestionInputSchema>;
export type AskClarificationInput = z.infer<typeof AskClarificationSchema>;
export type ClarificationQuestionType = "single" | "multi" | "free";
export type ClarificationParameterType = z.infer<typeof ClarificationParameterTypeSchema>;

/**
 * Discovery question priority: topic keywords first, then number of posts,
 * then comments per post, then date range. Never comments-per-post before
 * number of posts. Used to order questions before the bounded dynamic-question slice.
 */
export function discoveryQuestionPriority(q: { text?: string; parameterType?: string }): number {
  const text = (q.text || "").toLowerCase();
  const pt = q.parameterType;
  if (pt === "platform" || /منصة/.test(text)) return 0;
  if (/كلمات|موضوع|كلمة|محور|angle|keyword/.test(text)) return 1;
  const isVolume = pt === "volume" || /عدد|حجم|عينة|سجل|كم/.test(text);
  if (isVolume) {
    if (/تعليق|comment/.test(text)) return 3; // comments per post — after post count
    return 2; // number of posts
  }
  if (pt === "time_window" || /فترة|تاريخ|زمن|شهر|أسبوع|يوم|آخر/.test(text)) return 4;
  if (!pt) return 1; // open/unknown question: treat as topic-ish, ask early
  return 5;
}

export interface NormalizedClarificationQuestion {
  id: string;
  text: string;
  question: string;
  type: ClarificationQuestionType;
  options: string[];
  allowOther: boolean;
  defaultOption?: string;
  parameterType?: ClarificationParameterType;
}

export interface ClarificationOptionContext {
  capabilities: Array<Pick<Capability, "category" | "enabled" | "nameAr" | "slug">>;
  userBalancePoints?: number;
  persona?: string;
}

const PROVIDER_OR_INTERNAL_WORDS = [
  /openai/gi,
  /chatgpt/gi,
  /gpt[-\s]?[3456][\w.-]*/gi,
  /treg/gi,
  /tikhub/gi,
  /serpapi/gi,
];

/** Removes markup, control characters, URLs, and internal/provider names from untrusted copy. */
export function sanitizeClarificationText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  let text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, " ")
    .replace(/\]\((?:https?:\/\/|www\.)[^)]*\)/gi, "]")
    .replace(/[\u2066-\u2069\u200e\u200f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const pattern of PROVIDER_OR_INTERNAL_WORDS) {
    text = text.replace(pattern, "منصة Diger");
  }
  return text.slice(0, maxLength).trim();
}

/** Bounds and scrubs untrusted model text before the strict response schema is applied. */
export function sanitizeModelClarificationOutput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const result = { ...(input as Record<string, unknown>) };
  if (result.type !== "ask_clarification") return input;

  if (typeof result.intro === "string") result.intro = sanitizeClarificationText(result.intro, 200);
  if (typeof result.reasonAr === "string") result.reasonAr = sanitizeClarificationText(result.reasonAr, 200);
  if (Array.isArray(result.questions)) {
    result.questions = result.questions.slice(0, MAX_CLARIFICATION_QUESTIONS).map((rawQuestion) => {
      if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) return rawQuestion;
      const question = { ...(rawQuestion as Record<string, unknown>) };
      if (typeof question.text === "string") question.text = sanitizeClarificationText(question.text, 120);
      if (typeof question.question === "string") question.question = sanitizeClarificationText(question.question, 120);
      if (Array.isArray(question.options)) {
        question.options = unique(question.options
          .filter((option): option is string => typeof option === "string")
          .map((option) => sanitizeClarificationText(option, 40))).slice(0, 4);
      }
      if (typeof question.defaultOption === "string") question.defaultOption = sanitizeClarificationText(question.defaultOption, 40);
      return question;
    });
  }
  if (Array.isArray(result.questionsAr)) {
    result.questionsAr = result.questionsAr.slice(0, MAX_CLARIFICATION_QUESTIONS).map((question) => sanitizeClarificationText(question, 120));
  }
  if (Array.isArray(result.optionsAr)) {
    result.optionsAr = result.optionsAr.slice(0, MAX_CLARIFICATION_QUESTIONS).map((options) => Array.isArray(options)
      ? unique(options.filter((option): option is string => typeof option === "string")
          .map((option) => sanitizeClarificationText(option, 40))).slice(0, 4)
      : []);
  }
  return result;
}

function inferParameterType(text: string): ClarificationParameterType | undefined {
  const normalized = text.toLowerCase();
  if (/منصة|مصدر|platform|source|تيك توك|يوتيوب|تويتر|منصة x/.test(normalized)) return "platform";
  if (/فترة|تاريخ|زمن|شهر|أسبوع|يوم|آخر|date|period|window/.test(normalized)) return "time_window";
  if (/عدد|حجم|عينة|سجل|فيديو|تغريدة|volume|sample|count/.test(normalized)) return "volume";
  if (/صيغة|تنسيق|ملف|excel|csv|pdf|format/.test(normalized)) return "output_format";
  if (/إخفاء|مجهول|هوية|anonym/.test(normalized)) return "anonymize";
  if (/لغة|لغات|language/.test(normalized)) return "language";
  return undefined;
}

function unique(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter((value) => Boolean(value) && !INTERNAL_DISCOVERY_KEYS.has(value.toLowerCase())),
    ),
  ].slice(0, 4);
}

function enabledPlatformOptions(context: ClarificationOptionContext): string[] {
  const categories = new Set(
    context.capabilities.filter((capability) => capability.enabled !== false).map((capability) => capability.category),
  );
  const labels: Array<[string, string]> = [
    ["tiktok", "تيك توك"],
    ["x", "منصة X"],
    ["youtube", "يوتيوب"],
    ["web", "الويب العام"],
  ];
  return labels.filter(([category]) => categories.has(category as Capability["category"])).map(([, label]) => label);
}

function balanceAwareVolumeOptions(context: ClarificationOptionContext): string[] {
  const balance = Math.max(0, Math.floor(context.userBalancePoints ?? 0));
  if (balance <= 0) return ["سجل واحد", "أحدد العدد بعد مراجعة الرصيد"];
  const candidates = balance < 25 ? [1, 5, 10] : balance < 100 ? [5, 10, 25] : balance < 300 ? [10, 25, 100] : [25, 100, 500];
  const values = [...new Set(candidates.map((value) => Math.min(value, balance)))].filter((value) => value > 0);
  return unique(values.map((value) => `حتى ${value} ${value === 1 ? "سجل" : "سجلاً"}`));
}

export function getClarificationOptionBank(
  parameterType: ClarificationParameterType,
  context: ClarificationOptionContext,
): string[] {
  switch (parameterType) {
    case "platform":
      return enabledPlatformOptions(context);
    case "time_window":
      return ["آخر أسبوع", "آخر شهر", "آخر ٣ شهور", "آخر سنة"];
    case "volume":
      return balanceAwareVolumeOptions(context);
    case "output_format":
      return ["Excel", "CSV", "PDF"];
    case "anonymize":
      return ["نعم، أخفِ الهوية", "لا، احتفظ بالمعرّفات العامة"];
    case "language":
      return ["العربية", "الإنجليزية", "كل اللغات"];
    case "topic":
      return [];
  }
}

function defaultForParameter(
  parameterType: ClarificationParameterType | undefined,
  options: string[],
  persona?: string,
): string | undefined {
  if (!options.length) return undefined;
  if (parameterType === "time_window") return options.find((option) => option === "آخر ٣ شهور");
  if (parameterType === "output_format") return "Excel";
  if (parameterType === "anonymize") return persona === "researcher" ? options[0] : options[1];
  if (parameterType === "language") return "العربية";
  return options[0];
}

export function normalizeClarificationQuestions(
  input: Pick<AskClarificationInput, "questions" | "questionsAr" | "optionsAr">,
  context: ClarificationOptionContext,
): NormalizedClarificationQuestion[] {
  const rawInput = input as unknown as Record<string, unknown> | null;
  const questionsInput = Array.isArray(rawInput?.questions) ? rawInput.questions : [];
  const legacyQuestions = Array.isArray(rawInput?.questionsAr) ? rawInput.questionsAr : [];
  const legacyOptions = Array.isArray(rawInput?.optionsAr) ? rawInput.optionsAr : [];
  const questions = questionsInput.length
    ? questionsInput
    : legacyQuestions.map((question, index) => ({
        question,
        options: legacyOptions[index],
      }));

  // Order questions before the bounded dynamic-question cut so the most important ones survive.
  const ordered = questions
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ta = typeof a.item === "object" && a.item !== null
        ? String((a.item as Record<string, unknown>).text ?? (a.item as Record<string, unknown>).question ?? "")
        : "";
      const tb = typeof b.item === "object" && b.item !== null
        ? String((b.item as Record<string, unknown>).text ?? (b.item as Record<string, unknown>).question ?? "")
        : "";
      return discoveryQuestionPriority({ text: ta }) - discoveryQuestionPriority({ text: tb }) || a.index - b.index;
    })
    .map(({ item }) => item);
  return ordered.slice(0, MAX_CLARIFICATION_QUESTIONS).flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const questionItem = item as Record<string, unknown>;
    const rawQuestion = questionItem.text ?? questionItem.question ?? "";
    const text = sanitizeClarificationText(rawQuestion, 120);
    if (!text) return [];

    const parsedParameterType = ClarificationParameterTypeSchema.safeParse(questionItem.parameterType);
    const parameterType = parsedParameterType.success ? parsedParameterType.data : inferParameterType(text);
    const bankOptions = parameterType && parameterType !== "topic"
      ? getClarificationOptionBank(parameterType, context)
      : [];
    // Never fall back to model-supplied options for a platform question when
    // the enabled-capability bank is empty: that would offer disabled or
    // unavailable platforms as available. Drop the question instead so the
    // assistant fails safely instead of presenting phantom options.
    if (parameterType === "platform" && bankOptions.length === 0) return [];
    const modelOptions = Array.isArray(questionItem.options)
      ? questionItem.options.filter((option): option is string => typeof option === "string")
      : [];
    const sourceOptions = bankOptions.length ? bankOptions : modelOptions;
    const options = unique(sourceOptions.map((option) => sanitizeClarificationText(option, 40))).slice(0, 4);
    const requestedDefault = sanitizeClarificationText(questionItem.defaultOption, 40);
    // Company scope fields are mandatory user decisions. Never preselect Egypt
    // or a sector on those questions, even if a generic option bank has a default.
    const isRequiredScopeField = typeof questionItem.id === "string" && questionItem.id.endsWith("_required");
    const defaultOption = isRequiredScopeField
      ? undefined
      : requestedDefault && options.includes(requestedDefault)
        ? requestedDefault
        : defaultForParameter(parameterType, options, context.persona);
    const questionType = z.enum(["single", "multi", "free"]).safeParse(questionItem.type);
    const type = questionType.success ? questionType.data : options.length ? "single" : "free";
    const question: NormalizedClarificationQuestion = {
      id: typeof questionItem.id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(questionItem.id)
        ? questionItem.id
        : `question_${index + 1}`,
      text,
      question: text,
      type,
      options,
      allowOther: typeof questionItem.allowOther === "boolean" ? questionItem.allowOther : true,
      ...(defaultOption ? { defaultOption } : {}),
      ...(parameterType ? { parameterType } : {}),
    };
    return [question];
  });
}

export const StructuredClarificationAnswerSchema = z
  .object({
    type: z.literal("clarification_answers"),
    answers: z
      .array(
        z
          .object({
            questionId: z.string().trim().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/),
            question: z.string().trim().min(1).max(120),
            value: z.union([z.string().trim().max(200), z.array(z.string().trim().min(1).max(40)).max(4)]).optional(),
            skipped: z.boolean().optional(),
            // Hint from the client that it echoed the displayed default for a
            // skip. Accepted for compatibility but never treated as proof of
            // validation: the server cannot revalidate it, so the value is
            // handled as an explicit user answer (see formatter below).
            resolvedDefault: z.boolean().optional(),
          })
          .strict()
          .refine((answer) => answer.skipped === true || Boolean(answer.value), {
            message: "An answer or a default-skip choice is required",
          }),
      )
      .min(1)
      .max(MAX_CLARIFICATION_QUESTIONS),
  })
  .strict();

export type StructuredClarificationAnswer = z.infer<typeof StructuredClarificationAnswerSchema>;

export function validateStructuredClarificationAnswers(input: unknown): StructuredClarificationAnswer | null {
  const parsed = StructuredClarificationAnswerSchema.safeParse(input);
  if (!parsed.success) return null;
  const answers = parsed.data.answers.map((answer) => ({
    ...answer,
    question: sanitizeClarificationText(answer.question, 120),
    ...(typeof answer.value === "string"
      ? { value: sanitizeClarificationText(answer.value, 200) }
      : Array.isArray(answer.value)
        ? { value: answer.value.map((value) => sanitizeClarificationText(value, 40)).filter(Boolean).slice(0, 4) }
        : {}),
  }));
  if (answers.some((answer) => !answer.question || (answer.skipped !== true && !answer.value))) return null;
  return { type: "clarification_answers", answers };
}

export function formatStructuredClarificationAnswers(answer: StructuredClarificationAnswer): string {
  return JSON.stringify({
    type: "clarification_answers",
    answers: answer.answers.map(({ questionId, question, value, skipped }) => {
      if (skipped) {
        // A skipped answer must never surface the literal UI placeholder text.
        //
        // Trust boundary: the server cannot revalidate that a client-supplied
        // value matches the default previously displayed, so it must never be
        // labeled as a server-validated default. A skipped answer carrying a
        // value is treated as the user's explicit answer: the value was
        // sanitized on input, and any plan built from it still passes
        // server-side plan and quote validation. Without a value, the
        // assistant must ask the user explicitly instead of guessing.
        const hasValue = typeof value === "string"
          ? value.length > 0
          : Array.isArray(value) && value.length > 0;
        if (hasValue) {
          return { questionId, question, value };
        }
        return {
          questionId,
          question,
          needsUserChoice: true,
          note: "لم يختر المستخدم إجابة ولا يوجد افتراضي آمن — اطلب منه الاختيار صراحةً ولا تفترض أي قيمة.",
        };
      }
      return { questionId, question, value };
    }),
  });
}

/** Convert a stored answer payload into clear customer-authored text before
 * it is sent back to the model. Keeping internal question IDs out of the model
 * prompt prevents them from being copied into a search keyword or quote. */
export function formatClarificationMessageForAssistant(message: string): string {
  const trimmed = (message || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.includes("clarification_answers")) return message;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.type !== "clarification_answers" || !Array.isArray(parsed.answers)) return message;

    const labels: Record<string, string> = {
      company_country_required: "الدولة المطلوبة",
      company_industry_required: "المجال المطلوب",
      company_outreach_required: "هدف التواصل والبيانات المطلوبة",
      people_country_required: "دولة صناع القرار المطلوبة",
      people_scope_required: "مجال أو شركة صناع القرار المطلوبة",
      people_roles_required: "المسميات الوظيفية المطلوبة",
      people_count_required: "عدد صناع القرار المطلوب",
      company_count_required: "عدد الشركات المطلوب",
      social_account_required: "اسم الحساب المطلوب",
      social_topic_required: "موضوع البحث المطلوب",
      social_platform_required: "منصة البحث المطلوبة",
      social_time_required: "الفترة المطلوبة",
    };
    return parsed.answers.map((answer: any) => {
      const label = labels[answer?.questionId] || `إجابة عن ${sanitizeClarificationText(String(answer?.question || "السؤال"), 120)}`;
      const values = Array.isArray(answer?.value)
        ? answer.value.filter((value: unknown) => typeof value === "string").map((value: string) => sanitizeClarificationText(value, 40))
        : typeof answer?.value === "string"
          ? [sanitizeClarificationText(answer.value, 200)]
          : [];
      if (values.length > 0) return `${label}: ${values.join("، ")}`;
      return `لم يحدد المستخدم ${label}؛ اسأله عنها ولا تفترض إجابة.`;
    }).filter(Boolean).join("\n");
  } catch {
    return message;
  }
}
