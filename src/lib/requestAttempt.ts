export type RequestAttemptStatus =
  | "planning"
  | "needs_input"
  | "quoted"
  | "accepted"
  | "refused"
  | "failed";

export function resolveRequestAttemptStatus(input: {
  intent: "chat" | "research";
  outputType: string;
  hasQuote: boolean;
}): RequestAttemptStatus | null {
  if (input.intent === "chat") return null;
  if (input.hasQuote) return "quoted";
  if (input.outputType === "refuse" || input.outputType === "suggest_alternative") return "refused";
  if (input.outputType === "ask_clarification" || input.outputType === "ask_questions") return "needs_input";
  return "needs_input";
}
