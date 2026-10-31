import { describe, expect, it } from "vitest";
import { countAr, itemNounOf, itemNounOfPlan } from "../src/lib/agentMission/itemNoun";

/**
 * LIVE RETEST 2026-10-31 16:28 (B2, Facebook): the plan card said «هتستلم: ٥ صفحات» for FIVE POSTS. The stage is titled «بوستات صفحة طلبات مصر عن توصيل الطعام»: «بوستات» is not in the noun table, so the first-words scan skipped it and took the
 * next known noun, «صفحة» (the PAGE the posts come from), as the unit of the items. Two defects, one cause: (1) the word customers write for a post was unknown; (2) a noun that names the SOURCE (a page, an account, a channel) was accepted as the
 * unit of the items although it came after a word the table did not know.
 */
describe("the unit of the items is the items', not the source's", () => {
  it("B2's stage: five «بوستات» are counted as «بوستات»", () => {
    const noun = itemNounOf("بوستات صفحة طلبات مصر عن توصيل الطعام");
    expect(noun.singular).toBe("بوست");
    expect(countAr(5, noun)).toBe("٥ بوستات");
    expect(itemNounOfPlan({ stages: [{ title_ar: "بوستات صفحة طلبات مصر عن توصيل الطعام", deliver: true }] }).plural).toBe("بوستات");
  });
  it("every count form of the word customers write: one, two, many", () => {
    const noun = itemNounOf("بوستات");
    expect(countAr(1, noun)).toBe("بوست واحد");
    expect(countAr(2, noun)).toBe("بوستين");
    expect(countAr(11, noun)).toBe("١١ بوست");
    expect(itemNounOf("البوست").singular).toBe("بوست");
  });
  it("a page, an account or a channel named AFTER a word the table does not know is the source, never the unit: the honest «عنصر»", () => {
    for (const title of ["سناب حساب فلان", "ريلز صفحة فلان", "كليبات قناة فلان"]) expect(itemNounOf(title).singular, title).toBe("عنصر");
    expect(countAr(5, itemNounOf("ريلز صفحة فلان"))).toBe("٥ عناصر");
  });
  it("nothing that worked before changes: a known noun first, a leading modifier before a page or a channel, the people of a company", () => {
    expect(itemNounOf("منشورات حساب مصر للطيران").singular).toBe("منشور");
    expect(itemNounOf("التغريدات التي تذكر محمد صلاح").singular).toBe("تغريدة");
    expect(itemNounOf("تعليقات كل منشور").singular).toBe("تعليق");
    expect(itemNounOf("حساب مصر للطيران").singular).toBe("حساب");
    expect(itemNounOf("صفحات فيسبوك").singular).toBe("صفحة");
    expect(itemNounOf("أحدث صفحات فيسبوك").singular).toBe("صفحة");
    expect(itemNounOf("أفضل قنوات يوتيوب").singular).toBe("قناة");
    expect(itemNounOf("أحدث تغريدات الحساب").singular).toBe("تغريدة");
    expect(itemNounOf("موظفو كل شركة").singular).toBe("موظف");
    expect(itemNounOf("الشركات المصرية في قطاع البترول").singular).toBe("شركة");
    expect(itemNounOf("شيء لا نعرفه").singular).toBe("عنصر");
  });
});
