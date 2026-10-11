import { describe, expect, it } from "vitest";
import {
  formatStructuredClarificationAnswers,
  normalizeClarificationQuestions,
  validateStructuredClarificationAnswers,
} from "../src/functions/shared/clarification";

const enabledTiktok = [
  { slug: "tiktok-profile", category: "tiktok", nameAr: "تيك توك", enabled: true },
] as const;

const disabledTiktok = [
  { slug: "tiktok-profile", category: "tiktok", nameAr: "تيك توك", enabled: false },
] as const;

describe("discovery default resolution", () => {
  it("skipping with a value treats it as the user's explicit answer, never a validated default", () => {
    const parsed = validateStructuredClarificationAnswers({
      type: "clarification_answers",
      answers: [
        {
          questionId: "window",
          question: "ما الفترة؟",
          skipped: true,
          resolvedDefault: true,
          value: "آخر ٣ شهور",
        },
      ],
    });
    expect(parsed).not.toBeNull();
    const formatted = formatStructuredClarificationAnswers(parsed!);
    expect(formatted).not.toContain("استخدم الافتراضي");
    expect(formatted).toContain("آخر ٣ شهور");
    // The server cannot revalidate the echoed default, so it must never
    // be labeled as a server-validated default.
    expect(formatted).not.toContain("appliedDefault");
    expect(formatted).not.toContain("validated");
  });

  it("does not trust a forged skipped value as a validated default", () => {
    const parsed = validateStructuredClarificationAnswers({
      type: "clarification_answers",
      answers: [
        {
          questionId: "p1",
          question: "ما المنصة؟",
          skipped: true,
          resolvedDefault: true,
          value: "منصة X",
        },
      ],
    });
    expect(parsed).not.toBeNull();
    const formatted = formatStructuredClarificationAnswers(parsed!);
    // Passes through as a plain user answer; never certified as a default.
    // (Whether "منصة X" is an enabled capability is enforced later by
    // server-side plan validation, not by this formatter.)
    expect(formatted).toContain("منصة X");
    expect(formatted).not.toContain("appliedDefault");
    expect(formatted).not.toContain("validated");
  });

  it("does not trust a forged resolvedDefault flag without a value", () => {
    const parsed = validateStructuredClarificationAnswers({
      type: "clarification_answers",
      answers: [{ questionId: "w", question: "ما الفترة؟", skipped: true, resolvedDefault: true }],
    });
    expect(parsed).not.toBeNull();
    const formatted = formatStructuredClarificationAnswers(parsed!);
    expect(formatted).toContain("needsUserChoice");
    expect(formatted).not.toContain("appliedDefault");
  });

  it("skipping without a valid default requests an explicit user choice", () => {
    const parsed = validateStructuredClarificationAnswers({
      type: "clarification_answers",
      answers: [{ questionId: "window", question: "ما الفترة؟", skipped: true }],
    });
    expect(parsed).not.toBeNull();
    const formatted = formatStructuredClarificationAnswers(parsed!);
    expect(formatted).not.toContain("استخدم الافتراضي");
    expect(formatted).toContain("needsUserChoice");
    // The assistant must be instructed not to guess a missing default.
    expect(formatted).toContain("ولا تفترض");
  });

  it("skipping with an empty value is treated as missing default", () => {
    const parsed = validateStructuredClarificationAnswers({
      type: "clarification_answers",
      answers: [{ questionId: "window", question: "ما الفترة؟", skipped: true, value: "" }],
    });
    expect(parsed).not.toBeNull();
    const formatted = formatStructuredClarificationAnswers(parsed!);
    expect(formatted).toContain("needsUserChoice");
    expect(formatted).not.toContain("استخدم الافتراضي");
  });

  it("default resolution is deterministic across calls", () => {
    const input = {
      type: "clarification_answers",
      answers: [{ questionId: "w", question: "؟", skipped: true, value: "آخر شهر" }],
    } as const;
    const first = formatStructuredClarificationAnswers(validateStructuredClarificationAnswers(input)!);
    const second = formatStructuredClarificationAnswers(validateStructuredClarificationAnswers(input)!);
    expect(first).toBe(second);
  });
});

describe("capability filtering", () => {
  it("drops platform questions when the capability registry is empty", () => {
    const result = normalizeClarificationQuestions(
      {
        questions: [
          { id: "p1", text: "ما المنصة؟", parameterType: "platform", options: ["تيك توك", "منصة X"] },
        ],
      },
      { capabilities: [] },
    );
    // No fallback to model-supplied options: the question is dropped so the
    // assistant fails safely instead of offering phantom platforms.
    expect(result).toEqual([]);
  });

  it("drops platform questions when every capability is disabled", () => {
    const result = normalizeClarificationQuestions(
      {
        questions: [{ id: "p1", text: "ما المنصة؟", parameterType: "platform", options: ["تيك توك"] }],
      },
      { capabilities: [...disabledTiktok] },
    );
    expect(result).toEqual([]);
  });

  it("offers only enabled platforms when some are available", () => {
    const result = normalizeClarificationQuestions(
      {
        questions: [
          {
            id: "p1",
            text: "ما المنصة؟",
            parameterType: "platform",
            options: ["تيك توك", "منصة X", "يوتيوب"],
          },
        ],
      },
      { capabilities: [...enabledTiktok] },
    );
    expect(result).toHaveLength(1);
    expect(result[0].options).toEqual(["تيك توك"]);
    expect(result[0].options).not.toContain("منصة X");
    expect(result[0].options).not.toContain("يوتيوب");
  });

  it("preserves legitimate free-text topic questions when the registry is empty", () => {
    const result = normalizeClarificationQuestions(
      { questions: [{ id: "t1", text: "ما الموضوع؟", parameterType: "topic" }] },
      { capabilities: [] },
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("free");
  });

  it("drops platform questions but keeps other questions with an empty registry", () => {
    const result = normalizeClarificationQuestions(
      {
        questions: [
          { id: "p1", text: "ما المنصة؟", parameterType: "platform", options: ["تيك توك"] },
          { id: "t1", text: "ما الموضوع؟", parameterType: "topic" },
        ],
      },
      { capabilities: [] },
    );
    expect(result.map((question) => question.id)).toEqual(["t1"]);
  });
});

describe("structured answer validation", () => {
  it("accepts the resolvedDefault flag and still rejects unknown fields", () => {
    expect(
      validateStructuredClarificationAnswers({
        type: "clarification_answers",
        answers: [{ questionId: "w", question: "؟", skipped: true, resolvedDefault: true, value: "x" }],
      }),
    ).not.toBeNull();
    expect(
      validateStructuredClarificationAnswers({
        type: "clarification_answers",
        answers: [{ questionId: "w", question: "؟", skipped: true, bogusField: 1 }],
      }),
    ).toBeNull();
  });

  it("passes legitimate free-text answers through unchanged", () => {
    const parsed = validateStructuredClarificationAnswers({
      type: "clarification_answers",
      answers: [{ questionId: "t1", question: "ما الموضوع؟", value: "أبحاث الطاقة المتجددة" }],
    });
    expect(parsed).not.toBeNull();
    const formatted = formatStructuredClarificationAnswers(parsed!);
    expect(formatted).toContain("أبحاث الطاقة المتجددة");
    expect(formatted).not.toContain("needsUserChoice");
    expect(formatted).not.toContain("appliedDefault");
  });

  it("answer formatting is a pure data transform with no financial side effects", () => {
    const parsed = validateStructuredClarificationAnswers({
      type: "clarification_answers",
      answers: [
        { questionId: "v", question: "العدد؟", skipped: true, value: "حتى ١٠ سجلاً" },
        { questionId: "w", question: "الفترة؟", skipped: true },
      ],
    })!;
    const formatted = formatStructuredClarificationAnswers(parsed);
    expect(formatted).not.toMatch(/res_|rel_|chg_|top_|gwl_|ledger|quote|charge|reserve/i);
    expect(JSON.parse(formatted).answers).toHaveLength(2);
  });
});
