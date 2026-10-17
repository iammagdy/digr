/** The one-time question Diger AI asks when the profile has no name (owner decision D2). */
export const NAME_PROMPT_AR = "ما الاسم الذي تفضّل أن أناديك به؟";

const EXPLICIT_NAME = /^(?:(?:أنا|انا)\s+)?(?:اسمي|إسمي|my name is|i am|i'm)\s+([\p{L}][\p{L}\s.'’-]{1,58})[.!؟?\s]*$/iu;
const PLAIN_NAME = /^([\p{L}][\p{L}.'’-]*(?:\s+[\p{L}][\p{L}.'’-]*){0,2})[.!؟?\s]*$/u;

// Words that mean the customer is greeting or asking for research, not giving a name.
const NOT_A_NAME = /(?:^|\s)(?:هاي|مرحبا|مرحباً|اهلا|أهلا|أهلاً|ازيك|ازيكم|سلام|صباح|مساء|شكرا|شكراً|تمام|عايز|عاوز|اريد|أريد|محتاج|ابحث|شركات|شركة|بيانات|تيك|فيسبوك|يوتيوب|hello|hi|hey|thanks|ok|okay|yes|no|نعم|لا|مش|ايه|إيه|كام)(?:\s|$)/iu;

/**
 * The name the customer gave, or null. An explicit statement ("اسمي سلمى") always counts.
 * A bare short reply counts only when the previous assistant message asked for the name.
 */
export function extractCustomerName(message: string, previousAssistantAskedForName: boolean): string | null {
  const text = (message || "").trim();
  if (!text || text.length > 80) return null;
  const explicit = EXPLICIT_NAME.exec(text)?.[1]?.replace(/[.\s]+$/u, "").trim();
  if (explicit && explicit.length >= 2 && explicit.length <= 60) return explicit;
  if (!previousAssistantAskedForName) return null;
  const plain = PLAIN_NAME.exec(text)?.[1]?.replace(/[.\s]+$/u, "").trim();
  if (!plain || plain.length < 2 || plain.length > 40 || NOT_A_NAME.test(plain)) return null;
  return plain;
}
