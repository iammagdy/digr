import { describe, expect, it } from "vitest";
import {
  AskClarificationSchema,
  formatStructuredClarificationAnswers,
  getClarificationOptionBank,
  normalizeClarificationQuestions,
  sanitizeClarificationText,
  validateStructuredClarificationAnswers,
} from "../src/functions/shared/clarification";

const capabilities = [
  { slug: "tiktok-profile", category: "tiktok", nameAr: "تيك توك", enabled: true },
  { slug: "youtube-search", category: "youtube", nameAr: "يوتيوب", enabled: false },
] as const;

describe("strict discovery clarification", () => {
  it("validates the new schema and keeps the legacy question/options shape", () => {
    expect(AskClarificationSchema.safeParse({
      type: "ask_clarification",
      intro: "حدد التفاصيل الأساسية.",
      questions: [{
        id: "platform",
        text: "ما المنصة؟",
        type: "single",
        parameterType: "platform",
        options: ["تيك توك"],
        allowOther: true,
        defaultOption: "تيك توك",
      }],
    }).success).toBe(true);

    expect(AskClarificationSchema.safeParse({
      type: "ask_clarification",
      questions: [{ question: "ما المنصة؟", options: ["تيك توك"] }],
      reasonAr: "توضيح مختصر",
    }).success).toBe(true);

    expect(AskClarificationSchema.safeParse({
      type: "ask_clarification",
      intro: "x".repeat(201),
      questions: [{ question: "ما المنصة؟" }],
    }).success).toBe(false);
    expect(AskClarificationSchema.safeParse({
      type: "ask_clarification",
      questions: [{ question: "ما المنصة؟", unexpected: "drop" }],
    }).success).toBe(false);
  });

  it("accepts adaptive clarification flows longer than three questions, with a safe upper bound", () => {
    const questions = Array.from({ length: 5 }, (_, index) => ({ id: `q${index + 1}`, text: `ما التفصيل ${index + 1}؟` }));
    const parsed = AskClarificationSchema.safeParse({ type: "ask_clarification", questions });
    expect(parsed.success).toBe(true);
    const normalized = normalizeClarificationQuestions({ questions }, { capabilities: [] });
    expect(normalized).toHaveLength(5);

    const answers = questions.map((question) => ({ questionId: question.id, question: question.text, value: "إجابة" }));
    expect(validateStructuredClarificationAnswers({ type: "clarification_answers", answers })).not.toBeNull();
    expect(AskClarificationSchema.safeParse({
      type: "ask_clarification",
      questions: Array.from({ length: 9 }, (_, index) => ({ id: `q${index + 1}`, text: `سؤال ${index + 1}` })),
    }).success).toBe(false);
  });

  it("uses only enabled platforms and supplies canonical known-parameter choices", () => {
    expect(getClarificationOptionBank("platform", { capabilities: [...capabilities] })).toEqual(["تيك توك"]);
    expect(getClarificationOptionBank("time_window", { capabilities: [] })).toEqual([
      "آخر أسبوع", "آخر شهر", "آخر ٣ شهور", "آخر سنة",
    ]);
    expect(getClarificationOptionBank("output_format", { capabilities: [] })).toEqual(["Excel", "CSV", "PDF"]);
    expect(getClarificationOptionBank("anonymize", { capabilities: [] })).toEqual([
      "نعم، أخفِ الهوية", "لا، احتفظ بالمعرّفات العامة",
    ]);
    expect(getClarificationOptionBank("language", { capabilities: [] })).toEqual(["العربية", "الإنجليزية", "كل اللغات"]);
  });

  it("bounds volume presets using the current points balance", () => {
    const low = getClarificationOptionBank("volume", { capabilities: [], userBalancePoints: 12 });
    const high = getClarificationOptionBank("volume", { capabilities: [], userBalancePoints: 700 });
    expect(low).toEqual(["حتى 1 سجل", "حتى 5 سجلاً", "حتى 10 سجلاً"]);
    expect(high).toEqual(["حتى 25 سجلاً", "حتى 100 سجلاً", "حتى 500 سجلاً"]);
    expect(getClarificationOptionBank("volume", { capabilities: [], userBalancePoints: 0 })).toEqual([
      "سجل واحد", "أحدد العدد بعد مراجعة الرصيد",
    ]);
  });

  it("replaces model-supplied known-parameter options and sanitizes topic options as plain text", () => {
    const known = normalizeClarificationQuestions({
      questions: [{ question: "ما المنصة المستهدفة؟", options: ["مزود غير متاح"], parameterType: "platform" }],
    }, { capabilities: [...capabilities] });
    expect(known[0].options).toEqual(["تيك توك"]);

    const topic = normalizeClarificationQuestions({
      questions: [{
        id: "topic",
        text: "ما الموضوع؟",
        type: "single",
        parameterType: "topic",
        options: ["<img src=x>", "https://example.invalid/x", "Powered by OpenAI", "خيار صالح"],
        allowOther: true,
      }],
    }, { capabilities: [] });
    expect(topic[0].options).toEqual(["Powered by منصة Diger", "خيار صالح"]);
    expect(topic[0].options.join(" ")).not.toMatch(/<[^>]*>|https?:\/\//i);
    expect(sanitizeClarificationText("<b>موضوع</b> https://example.invalid/a", 120)).toBe("موضوع");
  });

  it("normalizes free-text, single-select, and multi-select questions without duplicate display fields", () => {
    // tiktok is enabled here so the inferred platform question ("المصدر؟")
    // keeps its bank options; with an empty registry it is dropped instead
    // (covered in discovery-defaults.test.ts).
    const result = normalizeClarificationQuestions({
      questions: [
        { id: "topic", text: "الموضوع؟", type: "free", options: [], allowOther: true },
        { id: "source", question: "المصدر؟", type: "single", options: ["تيك توك"] },
        { id: "langs", text: "اللغات؟", type: "multi", options: ["العربية", "الإنجليزية"] },
      ],
    }, { capabilities: [...capabilities] });
    expect(result.map((question) => question.type)).toEqual(["free", "single", "multi"]);
    expect(result.map((question) => question.text)).toEqual(["الموضوع؟", "المصدر؟", "اللغات؟"]);
    expect(result.map((question) => question.id)).toEqual(["topic", "source", "langs"]);
  });

  it("validates and canonicalizes one structured answer message, including skip/default", () => {
    const parsed = validateStructuredClarificationAnswers({
      type: "clarification_answers",
      answers: [
        { questionId: "platform", question: "ما المنصة؟", value: "تيك توك" },
        { questionId: "window", question: "ما الفترة؟", skipped: true, resolvedDefault: true, value: "آخر ٣ شهور" },
        { questionId: "topic", question: "ما الموضوع؟", skipped: true },
      ],
    });
    expect(parsed).not.toBeNull();
    const formatted = formatStructuredClarificationAnswers(parsed!);
    expect(formatted).toContain('"type":"clarification_answers"');
    // The literal UI placeholder must never reach the assistant as a value.
    expect(formatted).not.toContain("استخدم الافتراضي");
    // A skip carrying a value is treated as the user's explicit answer —
    // never labeled as a server-validated default.
    expect(formatted).toContain("آخر ٣ شهور");
    expect(formatted).not.toContain("appliedDefault");
    // A skip without a default must request an explicit user choice.
    expect(formatted).toContain("needsUserChoice");
    expect(validateStructuredClarificationAnswers({
      type: "clarification_answers",
      answers: [{ questionId: "bad id", question: "x", value: "y" }],
    })).toBeNull();
    expect(validateStructuredClarificationAnswers({
      type: "clarification_answers",
      answers: [{ questionId: "q1", question: "x", value: "<script>" }],
    })).toBeNull();
  });

  it("fails closed on malformed/missing questions and malformed answer payloads", () => {
    expect(normalizeClarificationQuestions({ questions: "not-an-array" } as never, { capabilities: [] })).toEqual([]);
    expect(normalizeClarificationQuestions({ questions: [null, {}, { question: "" }] } as never, { capabilities: [] })).toEqual([]);
    expect(AskClarificationSchema.safeParse({ type: "ask_clarification", questions: [] }).success).toBe(false);
    expect(validateStructuredClarificationAnswers({ type: "clarification_answers", answers: [] })).toBeNull();
    expect(validateStructuredClarificationAnswers({ type: "clarification_answers", answers: [{ questionId: "q1", question: "سؤال؟" }] })).toBeNull();
  });
});
