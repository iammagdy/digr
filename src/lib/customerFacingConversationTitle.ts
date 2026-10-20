import { toArabicDigits } from "@/lib/arabicDigits";
import { scrubPlaceholderPhrases } from "@/lib/customerScrub";

/** Localizes common English taxonomy labels and numerals in saved conversation titles. */
export function customerFacingConversationTitle(value: string): string {
  const raw = String(value || "").trim();
  // Card answers are stored as JSON message payloads in some older
  // conversations. Never expose those internal payloads as a chat title.
  if (raw.startsWith("{") && /\"(?:type|answers)\"/.test(raw)) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.type === "clarification_answers" || Array.isArray(parsed?.answers)) return "محادثة جديدة";
    } catch { /* keep ordinary user text that happens to start with a brace */ }
  }
  const greetingOnly = raw
    .replace(/[!！؟?.,،؛;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (/^(?:السلام عليكم|السلام عليكم ورحمة الله وبركاته|صباح الخير|مساء الخير|اهلا|أهلا|أهلاً|مرحبا|مرحباً|ازيك|ازيكم|هاي|hello|hi|hey)(?: يا [\u0600-\u06ff\w]+)?$/.test(greetingOnly)) {
    return "محادثة جديدة";
  }

  const localized = scrubPlaceholderPhrases(raw)
    .replace(/(?:تقنية مالية|التقنية المالية)\s*\(\s*fintech\s*\)/gi, "التقنية المالية")
    .replace(/\bfintech\b/gi, "التقنية المالية");
  const title = toArabicDigits(localized);
  if (title.length <= 50) return title;
  const candidate = title.slice(0, 50);
  const lastSpace = candidate.lastIndexOf(" ");
  return `${(lastSpace >= 24 ? candidate.slice(0, lastSpace) : candidate).trimEnd()}…`;
}
