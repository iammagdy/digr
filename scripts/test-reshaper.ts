// @ts-ignore
import reshaper from "arabic-persian-reshaper";
import bidiFactory from "bidi-js";

const bidi = bidiFactory();

function reshapeAndBidi(text: string): string {
  if (!text) return "";
  // 1. Reshape Arabic letters to Presentation Forms
  const reshaped = reshaper.ArabicShaper.convertArabic(text);
  // 2. Reorder according to BiDi
  const embeddingLevels = bidi.getEmbeddingLevels(reshaped, "rtl");
  const reordered = bidi.getReorderedString(reshaped, embeddingLevels);
  return reordered;
}

const testStrings = [
  "نتائج استخراج",
  "عينة من السجلات",
  "ملاحظة منهجية",
  "ملخص استخراج البيانات (1 سجل)",
  "الحساب المستهدف : Megz (@iam_megz)",
  "إجمالي المتابعين: 162,400,000 متابع",
];

for (const s of testStrings) {
  console.log("Original:", s);
  console.log("Reshaped & BiDi:", reshapeAndBidi(s));
  console.log("---");
}
