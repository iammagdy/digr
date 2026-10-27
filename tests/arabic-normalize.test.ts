import { describe, expect, it } from "vitest";
import { foldArabicLetters, foldDigits, foldedAlternation, normalizeArabic } from "../src/lib/arabicNormalize";

describe("one Arabic normaliser", () => {
  it("folds the hamza forms of alef to one letter", () => {
    for (const form of ["أكس", "إكس", "آكس", "ٱكس", "اكس"]) expect(foldArabicLetters(form)).toBe("اكس");
    expect(normalizeArabic("أحمد إبراهيم آمن")).toBe("احمد ابراهيم امن");
  });

  it("folds the alef maqsura to ya and the ta marbuta to ha", () => {
    expect(normalizeArabic("مستشفى")).toBe("مستشفي");
    expect(normalizeArabic("تغريدة")).toBe("تغريده");
    expect(normalizeArabic("المملكة")).toBe("المملكه");
  });

  it("drops the tatweel and the diacritics", () => {
    expect(normalizeArabic("اكـــس")).toBe("اكس");
    expect(normalizeArabic("مُحَمَّد")).toBe("محمد");
    expect(normalizeArabic("الحمدُ لِلَّه")).toBe("الحمد لله");
  });

  it("turns Arabic-Indic and Persian digits into Latin digits", () => {
    expect(foldDigits("٤٠٠ منشور و۱۲۳")).toBe("400 منشور و123");
    expect(normalizeArabic("٤٠٠ بوست")).toBe("400 بوست");
  });

  it("lower-cases Latin letters and collapses blanks", () => {
    expect(normalizeArabic("  منصة   X  ")).toBe("منصه x");
  });

  it("builds an alternation written the way normalised text is written", () => {
    const re = new RegExp(foldedAlternation(["أكس", "إيكس"]));
    expect(re.test(normalizeArabic("على أكس"))).toBe(true);
    expect(re.test(normalizeArabic("على إيكس"))).toBe(true);
  });

  it("is safe on empty and non-string input", () => {
    expect(normalizeArabic("")).toBe("");
    expect(normalizeArabic(undefined as any)).toBe("");
    expect(normalizeArabic(null as any)).toBe("");
  });
});
