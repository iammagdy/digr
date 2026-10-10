export interface DiscoveryQuestion {
  question: string;
  options?: string[];
}

export function normalizeDiscoveryQuestions(input: unknown): DiscoveryQuestion[] {
  if (!Array.isArray(input)) return [];

  return input.slice(0, 3).flatMap((entry: unknown) => {
    if (typeof entry === "string") {
      const question = entry.trim();
      return question ? [{ question }] : [];
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];

    const item = entry as Record<string, unknown>;
    if (typeof item.question !== "string" || !item.question.trim()) return [];

    const options = Array.isArray(item.options)
      ? item.options
          .filter((option): option is string => typeof option === "string" && option.trim().length > 0)
          .map((option) => option.trim().slice(0, 40))
          .slice(0, 4)
      : [];

    return [{
      question: item.question.trim(),
      ...(options.length ? { options } : {}),
    }];
  });
}
