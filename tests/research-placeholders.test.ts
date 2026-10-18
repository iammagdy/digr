import { describe, expect, it } from "vitest";
import { findUnresolvedResearchPlaceholder, unresolvedResearchPlaceholderMessageAr } from "../src/lib/researchPlaceholders";

describe("unresolved starter placeholders", () => {
  it.each([
    "بيانات حساب [@اسم_الحساب] على تيك توك",
    "منشورات عن [الموضوع] خلال [٣ أشهر]",
    "اجمع فيديوهات عن كرة القدم على تيك توك خلال [٣ أشهر]",
    "بحث عن [#الوسم]",
    "ابحث عن [industry] companies in [country]",
  ])("blocks unresolved slot: %s", (text) => {
    expect(findUnresolvedResearchPlaceholder(text)).not.toBeNull();
  });

  it.each([
    "بيانات حساب @diger على تيك توك",
    "أريد خمس شركات كهرباء في ألمانيا",
    "ابحث عن شركات [اسم العميل] داخل ملف مرفق",
  ])("allows ordinary request text: %s", (text) => {
    expect(findUnresolvedResearchPlaceholder(text)).toBeNull();
  });

  it("returns a polite Arabic prompt", () => {
    expect(unresolvedResearchPlaceholderMessageAr()).toContain("استبدل النص");
  });
});
