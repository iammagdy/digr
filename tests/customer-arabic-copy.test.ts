import { describe, expect, it } from "vitest";
import { customerConversationAnswer } from "../src/lib/customerConversationCopy";
import { customerFormatLabelAr } from "../src/lib/customerFormatLabels";
import { isGreetingOrGeneralQuestion } from "../src/functions/shared/briefManager";

describe("Arabic customer-facing copy", () => {
  it("recognizes Egyptian identity wording and returns a deterministic Arabic identity answer", () => {
    expect(isGreetingOrGeneralQuestion("إنت مين؟").isGeneralQuestion).toBe(true);
    const answer = customerConversationAnswer(false);
    expect(answer).toContain("مساعد ديجر");
    expect(answer).not.toMatch(/[A-Za-z]/);
  });

  it("uses Arabic-script labels for every deliverable format", () => {
    // the CSV has no customer label: it is never named to a customer
    expect(["xlsx", "pdf", "csv"].map(customerFormatLabelAr)).toEqual([
      "ملف إكسل",
      "ملف بي دي إف",
      "ملف بيانات",
    ]);
    expect(["xlsx", "pdf", "csv"].map(customerFormatLabelAr).join(" ")).not.toMatch(/[A-Za-z]/);
  });
});
