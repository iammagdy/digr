import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeDiscoveryQuestions } from "../src/app/dashboard/chat/components/discoveryQuestions";
import { buildClarificationPresentation } from "../src/functions/shared/chatHandler";
import { LlmClient } from "../src/functions/shared/llmClient";

describe("chat discovery clarification UI", () => {
  it("keeps each question in one card and sends a tapped option only as a chat message", () => {
    const question = "ما المنصة المستهدفة؟";
    const presentation = buildClarificationPresentation({
      type: "ask_clarification",
      reasonAr: "نحتاج تحديد المصدر قبل إعداد الخطة.",
      questions: [{ question, options: ["تيك توك"] }],
    });

    expect(presentation.contentAr).toBe("قبل ما أجهز الخطة، جاوبني على الأسئلة دي:");
    expect(presentation.contentAr).not.toContain(question);
    expect(presentation.clarificationItems).toEqual([{ question, options: ["تيك توك"] }]);

    const displayedQuestionText = [
      presentation.contentAr,
      ...presentation.clarificationItems.map((item) => item.question),
    ].join("\n");
    expect(displayedQuestionText.split(question)).toHaveLength(2);

    const chatPage = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chatPage.split("<ClarificationReply")).toHaveLength(2);
    expect(chatPage).toContain("questions={msg.clarificationItems || msg.clarificationQuestions || []}");
    expect(chatPage).toContain("onSelectOption={handleSendMessage}");
    expect(chatPage).not.toContain("<DiscoveryCard");

    const sendStart = chatPage.indexOf("async function handleSendMessage(");
    const sendEnd = chatPage.indexOf("\n  }\n", sendStart);
    expect(sendStart).toBeGreaterThanOrEqual(0);
    expect(sendEnd).toBeGreaterThan(sendStart);
    const sendHandler = chatPage.slice(sendStart, sendEnd);
    expect(sendHandler).toContain('role: "user"');
    expect(sendHandler).toContain('fetch("/api/chat"');
    expect(sendHandler).not.toContain("accept-quote");
  });

  it("scrubs provider names in model options and renders markup and URLs as plain text", async () => {
    const markup = "<img src=x onerror=alert(1)>";
    const url = "https://example.invalid/profile";
    const raw = JSON.stringify({
      type: "ask_clarification",
      reasonAr: "نحتاج توضيحاً قصيراً",
      questions: [{ question: "ما المصدر؟", options: [markup, url, "Powered by OpenAI"] }],
    });
    const originalFetch = globalThis.fetch;
    process.env.LLM_LIVE = "true";
    process.env.OPENAI_API_KEY = "local-unit-test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      output_text: raw,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    let displayedOptions: string[] | undefined;
    try {
      const result = await new LlmClient().executeTurn({
        messages: [{ role: "user", content: "أحتاج تحديد المصدر" }],
        sanitizedCapabilities: [],
      });
      expect(result.output.type).toBe("ask_clarification");
      if (result.output.type !== "ask_clarification") return;
      displayedOptions = normalizeDiscoveryQuestions(result.output.questions)[0]?.options;
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.LLM_LIVE;
      delete process.env.OPENAI_API_KEY;
    }

    expect(displayedOptions).toEqual([markup, url, "Powered by منصة Digr"]);

    const cardSource = readFileSync("src/app/dashboard/chat/components/DiscoveryCard.tsx", "utf8");
    expect(cardSource).toContain("{opt}");
    expect(cardSource).not.toMatch(/dangerouslySetInnerHTML/i);
    expect(cardSource).not.toMatch(/<a(?:\s|>)/i);
    expect(cardSource).not.toMatch(/\bhref\s*=/i);
  });

  it("does not crash on missing, empty, malformed options or questions without options", () => {
    expect(normalizeDiscoveryQuestions(undefined)).toEqual([]);
    expect(normalizeDiscoveryQuestions(null)).toEqual([]);
    expect(normalizeDiscoveryQuestions({ question: "not a list" })).toEqual([]);
    expect(normalizeDiscoveryQuestions("malformed")).toEqual([]);

    expect(normalizeDiscoveryQuestions([
      { question: "  سؤال من غير اختيارات  " },
      { question: "اختيارات فارغة", options: [] },
      { question: "اختيارات مش قائمة", options: "نص" },
      { question: "رابع سؤال خارج الحد" },
    ])).toEqual([
      { question: "سؤال من غير اختيارات" },
      { question: "اختيارات فارغة" },
      { question: "اختيارات مش قائمة" },
    ]);

    expect(normalizeDiscoveryQuestions([
      { question: "اختيارات مختلطة", options: [null, 3, " صالح ", { label: "غير صالح" }] },
      { question: "اختيارات طويلة", options: ["x".repeat(50)] },
      { question: 10, options: ["مرفوض"] },
      null,
    ])).toEqual([
      { question: "اختيارات مختلطة", options: ["صالح"] },
      { question: "اختيارات طويلة", options: ["x".repeat(40)] },
    ]);
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
