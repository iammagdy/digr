import { describe, it, expect } from "vitest";
import { extractNumberFromText, normalizeEasternArabicDigits } from "../src/lib/arabicNumbers";

describe("arabicNumbers parser", () => {
  it("normalizes Eastern Arabic digits correctly", () => {
    expect(normalizeEasternArabicDigits("٥ شركات")).toBe("5 شركات");
    expect(normalizeEasternArabicDigits("١٢٣٤٥٦٧٨٩٠")).toBe("1234567890");
  });

  it("extracts numbers from Arabic word numbers", () => {
    expect(extractNumberFromText("عايز خمس شركات مقاولات في مصر")).toBe(5);
    expect(extractNumberFromText("عايز خمسة شركات في مجال الكهرباء")).toBe(5);
    expect(extractNumberFromText("عايز عشرة شركات")).toBe(10);
    expect(extractNumberFromText("عايز عشر شركات")).toBe(10);
    expect(extractNumberFromText("خمسة وعشرين شركة")).toBe(25);
    expect(extractNumberFromText("خمسين شركة")).toBe(50);
    expect(extractNumberFromText("مية شركة")).toBe(100);
    expect(extractNumberFromText("ألف سجل")).toBe(1000);
  });

  it("extracts numbers from numeric digits", () => {
    expect(extractNumberFromText("عايز 30 شركة مقاولات في مصر")).toBe(30);
    expect(extractNumberFromText("عايز 10 شركات تقنية معلومات في السعودية")).toBe(10);
    expect(extractNumberFromText("عايز 5 شركات صناعة الصواريخ في ليختنشتاين")).toBe(5);
    expect(extractNumberFromText("عايز 50 شركة تقنية في مصر")).toBe(50);
    expect(extractNumberFromText("عايز ٥ شركات")).toBe(5);
  });

  it("extracts English number words", () => {
    expect(extractNumberFromText("I need 6 solar energy companies in Germany")).toBe(6);
    expect(extractNumberFromText("I need five companies")).toBe(5);
    expect(extractNumberFromText("I need ten companies")).toBe(10);
  });
});
