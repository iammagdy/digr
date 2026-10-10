export type DiscoveryQuestionType = "single" | "multi" | "free";

export interface DiscoveryQuestion {
  id: string;
  text: string;
  question: string;
  type: DiscoveryQuestionType;
  options: string[];
  allowOther: boolean;
  defaultOption?: string;
  parameterType?: "platform" | "time_window" | "volume" | "output_format" | "anonymize" | "language" | "topic";
}

export interface DiscoveryAnswer {
  questionId: string;
  question: string;
  value?: string | string[];
  skipped?: boolean;
  // Set when the client resolved the server-validated default for a skip.
  resolvedDefault?: boolean;
}

export function sanitizeDiscoveryText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, " ")
    .replace(/\]\((?:https?:\/\/|www\.)[^)]*\)/gi, "]")
    .replace(/\b(?:openai|chatgpt|gpt[-\s]?[3456][\w.-]*|treg|tikhub|serpapi)\b/gi, "منصة Digr")
    .replace(/[\u2066-\u2069\u200e\u200f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function normalizeOptions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const options = input
    .filter((option): option is string => typeof option === "string")
    .map((option) => sanitizeDiscoveryText(option, 40))
    .filter(Boolean);
  return [...new Set(options)].slice(0, 4);
}

export function normalizeDiscoveryQuestions(input: unknown): DiscoveryQuestion[] {
  if (!Array.isArray(input)) return [];

  return input.slice(0, 3).flatMap((entry: unknown, index) => {
    if (typeof entry === "string") {
      const text = sanitizeDiscoveryText(entry, 120);
      if (!text) return [];
      return [{
        id: `question_${index + 1}`,
        text,
        question: text,
        type: "single" as const,
        options: [],
        allowOther: true,
      }];
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];

    const item = entry as Record<string, unknown>;
    const text = sanitizeDiscoveryText(item.text ?? item.question, 120);
    if (!text) return [];

    const options = normalizeOptions(item.options);
    const type: DiscoveryQuestionType = item.type === "multi" || item.type === "free" || item.type === "single"
      ? item.type
      : options.length ? "single" : "free";
    const id = typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(item.id)
      ? item.id
      : `question_${index + 1}`;
    const defaultCandidate = sanitizeDiscoveryText(item.defaultOption, 40);
    const parameterTypes = new Set(["platform", "time_window", "volume", "output_format", "anonymize", "language", "topic"]);
    const parameterType = typeof item.parameterType === "string" && parameterTypes.has(item.parameterType)
      ? item.parameterType as DiscoveryQuestion["parameterType"]
      : undefined;

    return [{
      id,
      text,
      question: text,
      type,
      options,
      allowOther: item.allowOther !== false,
      ...(defaultCandidate && options.includes(defaultCandidate) ? { defaultOption: defaultCandidate } : {}),
      ...(parameterType ? { parameterType } : {}),
    }];
  });
}
