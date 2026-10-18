import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeDiscoveryQuestions } from "../src/app/dashboard/chat/components/discoveryQuestions";
import { buildClarificationPresentation } from "../src/functions/shared/chatHandler";
import { MAX_CLARIFICATION_QUESTIONS } from "../src/functions/shared/clarification";
import { ACTION_RESULT_JSON_SCHEMA, LlmClient } from "../src/functions/shared/llmClient";

describe("chat discovery clarification UI", () => {
  it("normalizes a legacy question once and retains the current Arabic intro", () => {
    const question = "ما المنصة المستهدفة؟";
    // The trust boundary only offers platform options backed by an enabled
    // capability, so the test supplies the enabled TikTok capability explicitly.
    const presentation = buildClarificationPresentation(
      {
        type: "ask_clarification",
        reasonAr: "نحتاج تحديد المصدر قبل إعداد الخطة.",
        questions: [{ question, options: ["تيك توك"] }],
      },
      {
        capabilities: [
          {
            slug: "tiktok-profile",
            category: "tiktok",
            enabled: true,
            nameAr: "تيك توك",
            nameEn: "TikTok Profile",
            descriptionAr: "استخراج بيانات حساب تيك توك",
            paramsSchema: "{}",
            tregEndpointId: "tiktok-profile",
            tregMethod: "GET",
            pricingUnit: "call",
            unitCostUsd: 0.01,
            maxRows: 500,
            paginationType: "none",
          },
        ],
      },
    );

    expect(presentation.contentAr).toBe("نحتاج تحديد المصدر قبل إعداد الخطة.");
    expect(presentation.clarificationItems).toHaveLength(1);
    expect(presentation.clarificationItems[0]).toMatchObject({
      id: "question_1",
      question,
      text: question,
      type: "single",
      options: ["تيك توك"],
    });

    const chatPage = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chatPage.split("<DetailsBlanks")).toHaveLength(2);
    expect(chatPage).toContain("questions={m.clarificationItems || m.clarificationQuestions || []}");
    expect(chatPage).toContain("onComplete={(answers) => handleSubmitClarification(m.id, answers)}");
    expect(chatPage).toContain('clarificationAnswers: { type: "clarification_answers", answers }');
  });

  it("shows editable discovery controls, skip/default, summary, and collapsed Q&A without HTML injection", () => {
    const normalized = normalizeDiscoveryQuestions([
      { id: "source", text: "ما المصدر؟", type: "single", options: ["تيك توك"], allowOther: true, defaultOption: "تيك توك" },
    ]);
    expect(normalized[0].defaultOption).toBe("تيك توك");

    const cardSource = readFileSync("src/app/dashboard/chat/components/DetailsBlanks.tsx", "utf8");
    expect(cardSource).toContain("أخرى");
    expect(cardSource).toContain('option.trim() === "أخرى" && current.allowOther');
    expect(cardSource).toContain("setCustomInputOpen(true)");
    expect(cardSource).toContain('role="group" aria-labelledby={`clarification-${current.id}`}');
    expect(cardSource).toContain("customInputOpen || current.type === \"free\"");
    expect(cardSource).toContain("تخطّي السؤال");
    expect(cardSource).toContain("إجابة ومتابعة");
    expect(cardSource).toContain("onComplete([skippedAnswer])");
    expect(cardSource).toContain("completedAnswers?.length");
    expect(cardSource).not.toMatch(/dangerouslySetInnerHTML/i);
    expect(cardSource).toContain("min-h-11");

    const routeSource = readFileSync("src/app/api/chat/route.ts", "utf8");
    expect(routeSource).toContain("validateStructuredClarificationAnswers");
    expect(routeSource).toContain("formatStructuredClarificationAnswers");
  });

  it("scrubs markup and links and tolerates malformed question/option payloads", () => {
    expect(normalizeDiscoveryQuestions(undefined)).toEqual([]);
    expect(normalizeDiscoveryQuestions(null)).toEqual([]);
    expect(normalizeDiscoveryQuestions({ question: "not a list" })).toEqual([]);
    expect(normalizeDiscoveryQuestions("malformed")).toEqual([]);

    expect(normalizeDiscoveryQuestions([
      { question: "سؤال من غير اختيارات" },
      { question: "اختيارات مختلطة", options: [null, 3, " صالح ", { label: "غير صالح" }] },
      { question: "اختيارات طويلة", options: ["x".repeat(50)] },
      { question: 10, options: ["مرفوض"] },
      null,
    ])).toMatchObject([
      { text: "سؤال من غير اختيارات", type: "free", options: [] },
      { text: "اختيارات مختلطة", options: ["صالح"] },
      { text: "اختيارات طويلة", options: ["x".repeat(40)] },
    ]);

    const clean = normalizeDiscoveryQuestions([{
      text: "<b>ما المصدر؟</b>",
      options: ["<img src=x onerror=alert(1)>", "https://example.invalid/profile", "Powered by OpenAI"],
    }]);
    expect(clean[0].text).toBe("ما المصدر؟");
    expect(clean[0].options.join(" ")).not.toMatch(/<[^>]*>|https?:\/\//i);
    expect(clean[0].options.join(" ")).toContain("منصة Diger");
  });

  it("keeps the fake clarification response deterministic and capped", async () => {
    const result = await new LlmClient().executeTurn({
      messages: [{ role: "user", content: "أريد بيانات الملف العام لحساب على تيك توك" }],
      sanitizedCapabilities: [],
      testScenario: "fake-chat-ui",
    });

    expect(result.output.type).toBe("ask_clarification");
    if (result.output.type !== "ask_clarification") return;
    expect(result.output.questions?.length).toBeGreaterThan(0);
    for (const question of result.output.questions ?? []) {
      expect(question.options?.length ?? 0).toBeLessThanOrEqual(4);
      for (const option of question.options ?? []) expect(option.length).toBeLessThanOrEqual(160);
    }
  });

  it("renders one Arabic question at a time with dynamic progress and back, next, skip, and other-answer controls", () => {
    const cardSource = readFileSync("src/app/dashboard/chat/components/DetailsBlanks.tsx", "utf8");
    expect(cardSource).toContain("سؤال {toArabicDigits(step + 1)} من {toArabicDigits(qs.length)}");
    expect(cardSource).toContain("السابق");
    expect(cardSource).toContain("التالي");
    expect(cardSource).toContain("تخطّي السؤال");
    expect(cardSource).toContain("ملخص طلبك");
    expect(cardSource).toContain('option.trim() === "أخرى"');
    expect(readFileSync("src/app/dashboard/chat/components/discoveryQuestions.ts", "utf8")).toContain("MAX_DISCOVERY_QUESTIONS = 8");
    expect(cardSource).not.toContain("underline");

    const pageSource = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(pageSource).toContain("buildChatTimeline<MessageItem>(messages, activeJob)");
    expect(pageSource).toContain("chatTimeline.map((item) => renderNote(item as MessageItem))");
    expect(pageSource).not.toContain("<ResearchDocument");
    expect(pageSource).toContain("intro={m.clarificationIntro ? customerFacingAssistantCopy(m.clarificationIntro) : undefined}");
  });

  it("lets the model ask more than three adaptive questions when the request needs them", () => {
    expect(MAX_CLARIFICATION_QUESTIONS).toBeGreaterThan(3);
    expect(ACTION_RESULT_JSON_SCHEMA.properties.questions.maxItems).toBe(MAX_CLARIFICATION_QUESTIONS);
    expect(ACTION_RESULT_JSON_SCHEMA.properties.questionsAr.maxItems).toBe(MAX_CLARIFICATION_QUESTIONS);
  });

  it("submits each clarification answer before the assistant decides whether to ask another question", () => {
    const chatHandler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    const finalResponse = chatHandler.slice(chatHandler.indexOf("// Ask one question per turn"));
    expect(finalResponse).toContain("clarificationItemsList = clarificationItemsList.slice(0, 1)");
    expect(finalResponse).toContain("clarificationQuestionsList = clarificationItemsList.map((item) => item.text)");

    const prompt = readFileSync("src/functions/shared/systemPrompt.ts", "utf8");
    expect(prompt).toContain("Ask only the single most useful unanswered question in each turn");
    expect(prompt).toContain("after the user answers, reassess the request");
  });
});

