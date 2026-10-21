import { describe, expect, it } from "vitest";
import { understandRequest } from "../src/lib/requestUnderstanding";

/** Family 14 of the scenario matrix: a request too vague to price. One specific question, never a plan and never a guess. */
describe("vague or impossible requests get exactly one specific question, in plain Arabic", () => {
  for (const text of ["عايز بيانات", "ساعدني", "اعمل لي بحث", "اجمع كل شيء عن كل الناس", "محتاج معلومات"]) {
    it(text, () => {
      const understanding = understandRequest(text);
      expect(understanding.taskType).toBe("unknown");
      expect(understanding.nextQuestion).not.toBeNull();
      expect(understanding.nextQuestion!.textAr).toMatch(/\?|؟/);
      expect(understanding.nextQuestion!.textAr).not.toMatch(/[A-Za-z0-9]/);
      expect(understanding.nextQuestion!.textAr.split(/[؟?]/).filter((part) => part.trim()).length).toBe(1);
      expect(understanding.volume).toBeNull();
    });
  }

  it("a request that already says what it needs gets no question about it", () => {
    const understanding = understandRequest("٣٠ تعليق على تيك توك عن كرة القدم في مصر خلال الشهر الماضي");
    expect(understanding.nextQuestion).toBeNull();
    expect(understanding.volume).toBe(30);
    expect(understanding.timeFrame).not.toBeNull();
  });

  it("an unnamed set of sources (newspapers) is asked once, with the named ones kept", () => {
    const unnamed = understandRequest("أخبار الدولار من الجرايد");
    expect(unnamed.sources).toMatchObject({ kind: "newspapers", unnamed: true });
    const named = understandRequest("أخبار الانتخابات من اليوم السابع والمصري اليوم");
    expect(named.sources).toMatchObject({ kind: "newspapers", unnamed: false, named: ["اليوم السابع", "المصري اليوم"] });
  });
});
