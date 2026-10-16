import { toArabicDigits } from "@/lib/arabicDigits";

/** Localizes common English taxonomy labels and numerals in saved conversation titles. */
export function customerFacingConversationTitle(value: string): string {
  const raw = String(value || "").trim();
  const greetingOnly = raw
    .replace(/[!！؟?.,،؛;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (/^(?:السلام عليكم|السلام عليكم ورحمة الله وبركاته|صباح الخير|مساء الخير|اهلا|أهلا|أهلاً|مرحبا|مرحباً|ازيك|ازيكم|هاي|hello|hi|hey)(?: يا [\u0600-\u06ff\w]+)?$/.test(greetingOnly)) {
    return "محادثة جديدة";
  }

  const localized = raw
    .replace(/(?:تقنية مالية|التقنية المالية)\s*\(\s*fintech\s*\)/gi, "التقنية المالية")
    .replace(/\bfintech\b/gi, "التقنية المالية");
  return toArabicDigits(localized);
}
