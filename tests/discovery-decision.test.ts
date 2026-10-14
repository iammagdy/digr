import { describe, it, expect } from "vitest";
import { extractResearchIntent } from "../src/lib/server/researchIntent";
import { evaluateDiscoveryDecision } from "../src/lib/server/questionDecisionFramework";

describe("Question Decision Framework: Zero Unnecessary Discovery Questions", () => {
  it("proceeds directly to plan for complete request (topic, source, volume)", () => {
    const userMessage = "أريد 100 مقطع فيديو من يوتيوب عن كأس العالم 2026 مع تفاصيل المشاهدات والإعجابات";
    const intent = extractResearchIntent(userMessage);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("PROCEED_TO_PLAN");
    expect(decision.questions.length).toBe(0);
    expect(decision.isCompleteWithoutQuestions).toBe(true);
    expect(decision.missingCrucialFields.length).toBe(0);
  });

  it("proceeds directly to plan when exclusion spreadsheet IS uploaded with company request", () => {
    const userMessage = "عايز 50 شركة مقاولات كهروميكانيكية في مصر غير الشركات الموجودة في الملف المرفق";
    const uploadedFiles = [
      {
        fileId: "f_mep_1",
        fileName: "current_contractors.xlsx",
        fileType: "xlsx" as const,
        purpose: "exclusion_list" as const,
      },
    ];
    const intent = extractResearchIntent(userMessage, undefined, uploadedFiles);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("PROCEED_TO_PLAN");
    expect(decision.questions.length).toBe(0);
    expect(decision.isCompleteWithoutQuestions).toBe(true);
  });

  it("asks ONLY for the exclusion file when mentioned in text but NOT uploaded", () => {
    const userMessage = "عايز 50 شركة مقاولات كهروميكانيكية في مصر غير الشركات الموجودة في الملف المرفق";
    // No uploaded files
    const intent = extractResearchIntent(userMessage, undefined, []);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("CLARIFY");
    expect(decision.isCompleteWithoutQuestions).toBe(false);
    expect(decision.missingCrucialFields).toContain("exclusion_file");
    expect(decision.questions.length).toBe(1);
    expect(decision.questions[0].id).toBe("missing_exclusion_file");
    expect(decision.questions[0].questionAr).toContain("ملف الاستبعاد");

    // Must NEVER ask for platform or topic when only file is missing
    const askedFields = decision.questions.map((q) => q.field);
    expect(askedFields).not.toContain("platforms");
    expect(askedFields).not.toContain("topic");
  });

  it("asks for core topic only when topic is completely missing from request", () => {
    const userMessage = "عايز بيانات من فيسبوك";
    const intent = extractResearchIntent(userMessage);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("CLARIFY");
    expect(decision.missingCrucialFields).toContain("topic");
    expect(decision.questions.some((q) => q.field === "topic")).toBe(true);

    // Must NEVER ask for platform because Facebook is known
    const askedFields = decision.questions.map((q) => q.field);
    expect(askedFields).not.toContain("platforms");
  });

  it("never interrogates user on format, language, or dates when sensible defaults exist", () => {
    const userMessage = "أريد 200 تغريدة من تويتر حول أسعار الذهب";
    const intent = extractResearchIntent(userMessage);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("PROCEED_TO_PLAN");
    const askedFields = decision.questions.map((q) => q.field);
    expect(askedFields).not.toContain("outputTypes");
    expect(askedFields).not.toContain("language");
    expect(askedFields).not.toContain("dateRange");
  });
});
