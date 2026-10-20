/**
 * Placeholder phrases that belong to our own internal notes, never to the customer: «لم يحدد المستخدم …», a topic that is the text of
 * a question, a stray «إجابة». Applied when text is shown (so old stored messages and titles read clean) and again before a plan is
 * written, as a last guard. The sources are fixed where they arise; this only keeps one from ever reaching the customer.
 */
const QUOTED_PLACEHOLDER_TOPIC = /\s*عن\s*«[^»]*(?:لم\s+يحدد|لم\s+يختر|ما\s+رابط\s+الفيديو|ما\s+الحد\s+الأقصى|ما\s+الفترة\s+الزمنية|على\s+أي\s+منصة)[^»]*»?/gu;
const UNCLOSED_PLACEHOLDER_TOPIC = /\s*عن\s*«\s*(?:لم\s+يحدد|لم\s+يختر)[^»\n]*$/u;
const PLACEHOLDER_SENTENCE = /[^.\n؟!]*(?:لم\s+يحدد\s+المستخدم|لم\s+يختر\s+المستخدم)[^.\n؟!]*[.؟!]?/gu;
const STRAY_ANSWER_WORD = /\s+(?:إجابة|الإجابة)(?=\s*»)/gu;

export function scrubPlaceholderPhrases(text: string): string {
  const raw = String(text ?? "");
  if (!raw) return raw;
  return raw
    .replace(QUOTED_PLACEHOLDER_TOPIC, "")
    .replace(UNCLOSED_PLACEHOLDER_TOPIC, "")
    .replace(PLACEHOLDER_SENTENCE, "")
    .replace(STRAY_ANSWER_WORD, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([،.])/g, "$1")
    .trim();
}
