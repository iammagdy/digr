import { describe, expect, it } from "vitest";
import { resolveRequestAttemptStatus } from "../src/lib/requestAttempt";

describe("planning attempt history status", () => {
  it("does not add ordinary chat turns to research history", () => {
    expect(resolveRequestAttemptStatus({ intent: "chat", outputType: "answer_question", hasQuote: false })).toBeNull();
  });

  it("records a priced plan as awaiting customer approval", () => {
    expect(resolveRequestAttemptStatus({ intent: "research", outputType: "propose_plan", hasQuote: true })).toBe("quoted");
  });

  it("records missing details as needing input", () => {
    expect(resolveRequestAttemptStatus({ intent: "research", outputType: "ask_clarification", hasQuote: false })).toBe("needs_input");
  });

  it("records unsupported or refused requests without implying a charge", () => {
    expect(resolveRequestAttemptStatus({ intent: "research", outputType: "suggest_alternative", hasQuote: false })).toBe("refused");
  });
});
