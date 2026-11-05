import { describe, expect, it } from "vitest";
import { REVIEW_CODES, REVIEW_ISSUE_AR, type ReviewCode } from "../src/lib/agentMission/stage4/review";
import { EDIT_REJECTIONS, EDIT_REJECTION_AR } from "../src/lib/agentMission/stage4/editVersion";
import { countedAr } from "../src/lib/agentMission/stage4/countAr";
import { quoteLineAr } from "../src/lib/agentMission/stage4/quotes";
import { versionLabelAr } from "../src/lib/agentMission/stage4/versionLabels";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * STAGE 4, S5 (docs/STAGE-4.md section 8): THE WORDING REVIEW. A count in a fixed sentence takes the right Arabic form: one «خانة واحدة», two «خانتان», three to ten «٣ خانات», eleven and more «١١ خانة» (the same rule as `pointsAr`),
 * and the words that agree with it (the adjective, the verb) agree too. «٢ خانة» is wrong Arabic.
 */
const C = "الإيميل";
/** [count, the sentence exactly]. */
const EXPECTED: Record<ReviewCode, Array<[number, string]>> = {
  empty_cells: [[1, `«${C}»: خانة واحدة فارغة دون ذكر السبب.`], [2, `«${C}»: خانتان فارغتان دون ذكر السبب.`], [3, `«${C}»: ٣ خانات فارغة دون ذكر السبب.`], [10, `«${C}»: ١٠ خانات فارغة دون ذكر السبب.`], [11, `«${C}»: ١١ خانة فارغة دون ذكر السبب.`]],
  invalid_email: [[1, `«${C}»: قيمة واحدة لا تبدو عنوان إيميل صحيحًا.`], [2, `«${C}»: قيمتان لا تبدوان عنوان إيميل صحيحًا.`], [3, `«${C}»: ٣ قيم لا تبدو عنوان إيميل صحيحًا.`], [11, `«${C}»: ١١ قيمة لا تبدو عنوان إيميل صحيحًا.`]],
  invalid_phone: [[1, `«${C}»: رقم هاتف واحد أقصر من سبعة أرقام.`], [2, `«${C}»: رقما هاتف أقصر من سبعة أرقام.`], [3, `«${C}»: ٣ أرقام هاتف أقصر من سبعة أرقام.`], [11, `«${C}»: ١١ رقم هاتف أقصر من سبعة أرقام.`]],
  invalid_link: [[1, `«${C}»: قيمة واحدة ليست رابطًا كاملًا.`], [2, `«${C}»: قيمتان ليستا رابطًا كاملًا.`], [3, `«${C}»: ٣ قيم ليست رابطًا كاملًا.`], [11, `«${C}»: ١١ قيمة ليست رابطًا كاملًا.`]],
  invalid_date: [[1, `«${C}»: قيمة واحدة لا تُقرأ كتاريخ.`], [2, `«${C}»: قيمتان لا تُقرآن كتاريخ.`], [3, `«${C}»: ٣ قيم لا تُقرأ كتاريخ.`], [11, `«${C}»: ١١ قيمة لا تُقرأ كتاريخ.`]],
  exact_duplicate: [[1, `«${C}»: عنصر واحد مكرر تمامًا، ولم يُحذف شيء.`], [2, `«${C}»: عنصران مكرران تمامًا، ولم يُحذف شيء.`], [3, `«${C}»: ٣ عناصر مكررة تمامًا، ولم يُحذف شيء.`], [11, `«${C}»: ١١ عنصرًا مكررًا تمامًا، ولم يُحذف شيء.`]],
  stated_gap: [[1, `«${C}»: خانة واحدة ذُكر فيها أن القيمة غير متاحة أو لم يكتمل البحث عنها.`], [2, `«${C}»: خانتان ذُكر فيهما أن القيمة غير متاحة أو لم يكتمل البحث عنها.`], [3, `«${C}»: ٣ خانات ذُكر فيها أن القيمة غير متاحة أو لم يكتمل البحث عنها.`], [11, `«${C}»: ١١ خانة ذُكر فيها أن القيمة غير متاحة أو لم يكتمل البحث عنها.`]],
};

describe("countedAr: the Arabic count of a noun", () => {
  const f = { one: "خانة واحدة", two: "خانتان", few: "خانات", many: "خانة" };
  it("1 and 2 are words without digits; 3 to 10 take the plural; 11 and more take the singular; digits are Arabic-Indic", () => {
    expect([1, 2, 3, 4, 10, 11, 12, 99, 100, 250, 1000].map((k) => countedAr(k, f))).toEqual(["خانة واحدة", "خانتان", "٣ خانات", "٤ خانات", "١٠ خانات", "١١ خانة", "١٢ خانة", "٩٩ خانة", "١٠٠ خانة", "٢٥٠ خانة", "١٠٠٠ خانة"]);
  });
});

describe("every sentence of the review's report", () => {
  for (const code of REVIEW_CODES) {
    it(`${code}: the right form for one, two, three to ten and eleven or more`, () => {
      expect(EXPECTED[code].length).toBeGreaterThanOrEqual(4);
      for (const [k, sentence] of EXPECTED[code]) expect(REVIEW_ISSUE_AR[code](C, k), `${code} ${k}`).toBe(sentence);
    });
    it(`${code}: passes the customer-text rules for any count, with Arabic-Indic numerals only, and never the wrong «٢ خانة» form`, () => {
      for (const k of [1, 2, 3, 5, 10, 11, 20, 99, 100, 101, 1000, 25_000]) {
        const s = REVIEW_ISSUE_AR[code](C, k);
        expect(checkCustomerText(s, { maxChars: 600 }).issues, s).toEqual([]);
        expect(s, s).not.toMatch(/[0-9]/);
        expect(s, s).not.toMatch(/(?:^|\s)[١٢] (?:خانة|قيمة|عنصر|رقم)/);
      }
    });
  }
});

describe("the other fixed sentences of the stage", () => {
  it("every refusal of an edit is one clear Arabic sentence that passes the customer-text rules, and none carries a count", () => {
    for (const code of EDIT_REJECTIONS) { const s = EDIT_REJECTION_AR[code]; expect(checkCustomerText(s).issues, code).toEqual([]); expect(s, code).not.toMatch(/[0-9٠-٩]/); expect(s.trim().endsWith("."), code).toBe(true); }
  });
  it("the quote line counts points the right way (the minimum is a hundred, so it is the many-form), and a version label counts with numerals", () => {
    expect(quoteLineAr("review", 100)).toBe("سعر المراجعة: ١٠٠ نقطة، محسوب بالكود. لم يُخصم شيء.");
    expect(quoteLineAr("edit", 5500)).toContain("نقطة،");
    expect(versionLabelAr(2, "edit")).toBe("النسخة ٢ (تعديل)");
  });
});
