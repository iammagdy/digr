/**
 * Diger AI: one fixed identity and tone, in code. Who the assistant is, and what it will not say about the technology
 * behind it, never depend on what a model happens to write.
 * Customer-facing name: «ديجر الذكي» (Diger AI) in Arabic script, as the product copy requires Arabic only.
 */
export const DIGER_AI_NAME_AR = "ديجر الذكي";

export const IDENTITY_ANSWER_AR =
  `أنا ${DIGER_AI_NAME_AR}، مساعد بحثي يعمل بالذكاء الاصطناعي. بفهم المطلوب منك، وأجهز لك خطة قابلة للتعديل بسعر واضح بالنقاط، وبعد موافقتك أجمع البيانات من مصادر متاحة وأسلّمك ملفات منظمة. تحب نبدأ بإيه؟`;

export const TECHNOLOGY_DEFLECTION_AR =
  `أنا ${DIGER_AI_NAME_AR}، مساعد بحثي يعمل بالذكاء الاصطناعي من ديجر. تفاصيل التقنية اللي بتشغّلني مش بتكلم فيها، لكن أقدر أساعدك في أي بحث وجمع بيانات. تحب نبدأ بإيه؟`;

export type IdentityQuestionKind = "who" | "technology";

const VENDOR_WORDS = /(chat\s*gpt|\bgpt[-\s]?\d*\b|open\s*ai|\bclaude\b|anthropic|gemini|\bllama\b|mistral|deepseek|جي\s*بي\s*تي|شات\s*جي|اوبن\s*اي|أوبن\s*إيه|كلود|انثروبيك|أنثروبيك|جيميناي|ديب\s*سيك)/i;

/**
 * Detects a question about who the assistant is or what powers it. «technology» covers vendor and model names and
 * questions such as «مين عملك» or «شغال على إيه»; «who» covers plain identity questions.
 */
export function identityQuestionKind(text: string): IdentityQuestionKind | null {
  const t = String(text || "").trim();
  if (!t || t.length > 120) return null;
  const technology =
    /(مين\s+(?:اللي\s+)?(?:عملك|صنعك|صمّمك|صممك|طوّرك|طورك|برمجك|شغّلك|شغلك)|مين\s+ورا(?:ك)?|(?:شغال|بتشتغل|تعمل|مبني|مبنى)\s+(?:على|ب|بـ)\s*(?:اي|ايه|إيه|أي|ماذا|تقنية|موديل|نموذج)|أي\s+نموذج|اي\s+نموذج|انهي\s+موديل|ايه\s+الموديل|إيه\s+الموديل|what\s+model|which\s+model|who\s+(?:made|built|created)\s+you|are\s+you\s+(?:chat)?gpt|are\s+you\s+claude)/i.test(t) ||
    (VENDOR_WORDS.test(t) && /(انت|إنت|أنت|you|هل|بتاع|تابع|من|مين)/i.test(t));
  if (technology) return "technology";
  if (/(^|\s)(?:انت|إنت|أنت)\s+(?:مين|من)(?![\p{L}])|(?:من|مين)\s+(?:انت|إنت|أنت)(?![\p{L}])|عرّفني بنفسك|عرفني بنفسك|who\s+are\s+you|(?:انت|إنت|أنت)\s+(?:بوت|روبوت|انسان|إنسان|ذكاء\s*اصطناعي|ai)(?![\p{L}])/iu.test(t)) return "who";
  return null;
}

export function identityAnswerAr(kind: IdentityQuestionKind): string {
  return kind === "technology" ? TECHNOLOGY_DEFLECTION_AR : IDENTITY_ANSWER_AR;
}

/** Phrases a generic chatbot uses; Diger AI never talks about itself this way. */
const GENERIC_AI_PHRASES = [
  /as an? (?:ai )?language model/i,
  /as an ai(?: assistant)?\b/i,
  /i(?:'m| am) (?:just )?an? (?:ai|large language model|llm)/i,
  /trained by/i,
  /(?:بصفتي|كوني|باعتباري)\s+(?:نموذج(?:اً|ا)?\s+(?:لغوي|ذكاء)|ذكاء اصطناعي(?:\s+لغوي)?|برنامج(?:اً|ا)?\s+ذكاء)/,
  /نموذج لغوي/,
  /(?:تم|تمّ)\s+(?:تدريبي|تطويري)\s+(?:بواسطة|من قبل|من طرف)/,
];

const SENTENCE_SPLIT = /(?<=[.!؟?\n])\s*/u;

/**
 * Last line of defence on model text: a sentence that names the technology vendor or talks like a generic chatbot is
 * replaced (once) by the fixed identity sentence. Everything else is untouched.
 */
export function scrubAssistantIdentity(text: string): string {
  if (!text) return text;
  const offending = (sentence: string) => VENDOR_WORDS.test(sentence) || GENERIC_AI_PHRASES.some((p) => p.test(sentence));
  if (!offending(text)) return text;
  const parts = text.split(SENTENCE_SPLIT).filter((s) => s.length > 0);
  let replaced = false;
  const out: string[] = [];
  for (const part of parts) {
    if (offending(part)) {
      if (!replaced) {
        out.push(`أنا ${DIGER_AI_NAME_AR}، مساعد بحثي يعمل بالذكاء الاصطناعي.`);
        replaced = true;
      }
    } else {
      out.push(part);
    }
  }
  return out.join(" ").replace(/\s+\n/g, "\n").trim();
}
