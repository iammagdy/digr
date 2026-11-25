import { describe, it, expect } from "vitest";
import { extractResearchIntent } from "../src/lib/server/researchIntent";
import { evaluateDiscoveryDecision } from "../src/lib/server/questionDecisionFramework";

describe("Offline Acceptance Scenarios (End-to-End Validation)", () => {
  // Scenario D: Complete Arabic Request -> Zero Discovery Questions
  it("Scenario D: Complete Egyptian Arabic request triggers zero discovery questions", () => {
    const userMessage = "أريد استخراج 1000 تعليق من فيسبوك حول قانون الإيجار القديم في مصر خلال آخر 3 شهور بصيغة إكسل وPDF";
    const intent = extractResearchIntent(userMessage);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("PROCEED_TO_PLAN");
    expect(decision.questions.length).toBe(0);
    expect(decision.isCompleteWithoutQuestions).toBe(true);
  });

  // Scenario E: Incomplete Request with Missing Exclusion File
  it("Scenario E: Incomplete request with missing exclusion file asks ONLY for the file", () => {
    const userMessage = "عايز 50 شركة طاقة متجددة في مصر بدون الشركات الموجودة في شيت الإكسل المرفق";
    const intent = extractResearchIntent(userMessage, undefined, []);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("CLARIFY");
    expect(decision.missingCrucialFields).toEqual(["exclusion_file"]);
    expect(decision.questions.length).toBe(1);
    expect(decision.questions[0].questionAr).toContain("ملف الاستبعاد");
  });
});
