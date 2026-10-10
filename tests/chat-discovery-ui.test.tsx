import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildClarificationPresentation } from "../src/functions/shared/chatHandler";
import { LlmClient } from "../src/functions/shared/llmClient";

describe("chat discovery clarification UI", () => {
  it("keeps the message as a short intro and routes each question to one card renderer", () => {
    const question = "ما المنصة المستهدفة؟";
    const presentation = buildClarificationPresentation({
      type: "ask_clarification",
      reasonAr: "نحتاج تحديد المصدر قبل إعداد الخطة.",
      questions: [{ question, options: ["تيك توك"] }],
    });

    expect(presentation.contentAr).toBe("قبل ما أجهز الخطة، جاوبني على الأسئلة دي:");
    expect(presentation.contentAr).not.toContain(question);
    expect(presentation.clarificationItems).toEqual([
      { question, options: ["تيك توك"] },
    ]);

    const displayedQuestionText = [
      presentation.contentAr,
      ...presentation.clarificationItems.map((item) => item.question),
    ].join("\n");
    expect(displayedQuestionText.split(question)).toHaveLength(2);

    const chatPage = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chatPage.split("<ClarificationReply")).toHaveLength(2);
    expect(chatPage).toContain("questions={msg.clarificationItems || msg.clarificationQuestions || []}");
    expect(chatPage).not.toContain("<DiscoveryCard");
  });

  it("uses bounded, neutral options in the fake LLM clarification response", async () => {
    const result = await new LlmClient().executeTurn({
      messages: [{ role: "user", content: "أريد بيانات الملف العام لحساب على تيك توك" }],
      sanitizedCapabilities: [],
      testScenario: "fake-chat-ui",
    });

    expect(result.output.type).toBe("ask_clarification");
    if (result.output.type !== "ask_clarification") return;

    expect(result.output.questions?.length).toBeGreaterThan(0);
    for (const question of result.output.questions ?? []) {
      expect(question.options?.length).toBeLessThanOrEqual(4);
      for (const option of question.options ?? []) {
        expect(option.length).toBeLessThanOrEqual(40);
        expect(option).not.toContain("@");
      }
    }
  });
});
