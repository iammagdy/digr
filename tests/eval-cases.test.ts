import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "../scripts/eval-cases";
import { buildSystemPrompt } from "../src/functions/shared/systemPrompt";
import { sanitizeCapabilitiesForLlm, type Capability } from "../src/functions/shared/capabilityRegistry";

const capability: Capability = {
  slug: "tiktok-profile",
  category: "tiktok",
  nameAr: "بيانات الحساب العامة",
  nameEn: "Public profile data",
  descriptionAr: "المؤشرات العامة للحساب",
  paramsSchema: JSON.stringify({ type: "object", properties: { username: { type: "string" } } }),
  tregEndpointId: "internal-only",
  tregMethod: "POST",
  pricingUnit: "item",
  unitCostUsd: 0,
  maxRows: 1,
  paginationType: "none",
  enabled: true,
};

const forbiddenPromptContent = /\b(?:openai|chatgpt|gpt[-\s]?[3456][\w.-]*|treg|tikhub|serpapi)\b|\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{12,}\b|\$\s?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:USD|dollars?)\b|\b(?:unitcost|markup|internal\s+price)\b/i;

describe("hermetic evaluator case matrix", () => {
  it("contains exactly 60 cases in the required 30/10/10/10 groups", () => {
    expect(EVAL_CASES).toHaveLength(60);
    expect(EVAL_CASES.filter((testCase) => testCase.category === "arabic_request")).toHaveLength(30);
    expect(EVAL_CASES.filter((testCase) => testCase.category === "not_what_i_wanted")).toHaveLength(10);
    expect(EVAL_CASES.filter((testCase) => testCase.category === "prompt_injection")).toHaveLength(10);
    expect(EVAL_CASES.filter((testCase) => testCase.category === "product_knowledge")).toHaveLength(10);
    expect(new Set(EVAL_CASES.map((testCase) => testCase.id)).size).toBe(60);
  });

  it("covers all five personas evenly and includes influencer and replies-versus-news cases", () => {
    for (const persona of ["student", "researcher", "statistician", "marketer", "other"]) {
      expect(EVAL_CASES.filter((testCase) => testCase.category === "arabic_request" && testCase.persona === persona)).toHaveLength(6);
    }
    expect(EVAL_CASES.some((testCase) => testCase.prompt.includes("مؤثرو التنمية الذاتية المصريون"))).toBe(true);
    expect(EVAL_CASES.some((testCase) => testCase.prompt.includes("الأخبار بالردود"))).toBe(true);
  });

  it("keeps test prompts and constructed persona/capability context free of secrets, vendor names, markup and dollar amounts", () => {
    const safeCapabilities = sanitizeCapabilitiesForLlm([capability]);
    for (const testCase of EVAL_CASES) {
      const prompt = buildSystemPrompt({
        userProfile: { persona: testCase.persona, purposes: [testCase.note], topic: "بيانات عامة للبحث والتحليل" },
        sanitizedCapabilities: safeCapabilities,
        todayDate: "2026-10-10",
        userBalancePoints: 500,
        conversationState: { isFirstUserTurn: true },
      });
      expect(forbiddenPromptContent.test(testCase.prompt), `unsafe case ${testCase.id}`).toBe(false);
      expect(forbiddenPromptContent.test(prompt), `unsafe context for case ${testCase.id}`).toBe(false);
      expect(forbiddenPromptContent.test(JSON.stringify(safeCapabilities)), `unsafe capabilities for case ${testCase.id}`).toBe(false);
    }
  });
});
