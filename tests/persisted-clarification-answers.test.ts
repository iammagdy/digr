import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePersistedClarificationAnswers } from "../src/app/dashboard/chat/components/discoveryQuestions";

describe("restoring clarification answers from saved conversations", () => {
  it("parses stored card answers into sanitized answer data", () => {
    const raw = JSON.stringify({
      type: "clarification_answers",
      answers: [{
        questionId: "topic",
        question: "ما نوع الشركات أو المجال المطلوب؟",
        value: "التقنية المالية في ألمانيا",
      }],
    });

    expect(parsePersistedClarificationAnswers(raw)).toEqual([{
      questionId: "topic",
      question: "ما نوع الشركات أو المجال المطلوب؟",
      value: "التقنية المالية في ألمانيا",
    }]);
  });

  it("ignores ordinary messages and unrelated JSON", () => {
    expect(parsePersistedClarificationAnswers("أريد شركات تقنية مالية في ألمانيا")).toBeNull();
    expect(parsePersistedClarificationAnswers('{"type":"answer_question","answerAr":"تم"}')).toBeNull();
  });

  it("hides the serialized answer and restores it onto the preceding clarification card", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");

    expect(page).toContain("parsePersistedClarificationAnswers(restoredMessages[index].content)");
    expect(page).toContain("restoredMessages[index].hidden = true");
    expect(page).toContain("message.completedClarificationAnswers = answers");
  });
});
