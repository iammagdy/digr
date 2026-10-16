import { toArabicDigits } from "@/lib/arabicDigits";

/** Localizes common English taxonomy labels and numerals in saved conversation titles. */
export function customerFacingConversationTitle(value: string): string {
  const localized = String(value || "")
    .replace(/(?:تقنية مالية|التقنية المالية)\s*\(\s*fintech\s*\)/gi, "التقنية المالية")
    .replace(/\bfintech\b/gi, "التقنية المالية");
  return toArabicDigits(localized);
}
