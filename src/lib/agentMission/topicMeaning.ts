import { normalizeText } from "./relevance";

/**
 * WHAT THE REQUEST MEANS BY ITS TOPIC (S8; docs/S1-LIVE-FINDINGS.md, live 2026-11-02 ~13:35: «فيديوهين عن الذكاء الاصطناعي» delivered AI-generated drama stories: the keyword matched the hashtag #قصص_بالذكاء_الاصطناعي and the most-commented order picked the viral stories).
 * OWNER DECISION (request understanding, never filtering): «عن X» means content that talks about or explains X; «معمول بـ X» (made with X) is a different request. The query is built from that meaning; among the results the videos whose own text discusses the topic are preferred over
 * videos where the topic appears only as a made-with hashtag (choosing which videos to read; nothing delivered is removed and no comment is filtered); a request that is ambiguous between the two gets a question card before planning. Code, never a model. The topics are the technologies
 * a video can be MADE WITH (the only topics for which the two meanings differ). Pure.
 */
export type TopicKind = "about" | "made_with" | "ambiguous" | "none";
export interface TopicMeaning { kind: TopicKind; /** The topic as the customer reads it («الذكاء الاصطناعي»); null when the request has none of the topics. */ topic: string | null }

const TOPIC = /(?:^|[\s#_])(?:ب)?(?:ال)?ذكاء[\s_]*(?:ال)?اصطناعي|(?:^|[\s#_])ai(?=$|[\s#_.,؛،!؟?])|(?:^|[\s#_])(?:chat[\s_]*gpt|شات[\s_]*جي[\s_]*بي[\s_]*تي)/;
const TOPIC_LABEL = "الذكاء الاصطناعي";
const MADE_WITH_REQUEST = /(?:معمول|مصنوع|متعمل|اتعمل|بيتعمل|مولد|مصمم|منتج)\w*\s*(?:ب|بال)\s*(?:ال)?(?:ذكاء|ai\b|chat)|(?:^|\s)بال?ذكاء\s*(?:ال)?اصطناعي|made\s+with\s+ai|generated\s+(?:by|with)\s+ai/;
const ABOUT_REQUEST = /(?:^|\s)(?:عن|حول|بخصوص|في)\s+(?:ال)?(?:ذكاء|ai\b|chat|شات)|(?:بتتكلم|بيتكلم|بتشرح|بيشرح|تتحدث|يتحدث|شرح|اخبار)\s+(?:عن\s+)?(?:ال)?(?:ذكاء|ai\b)/;
const CONTENT_NOUN = /فيديو|بوست|منشور|ريلز|ريل|تيك\s*توك|انستجرام|انستا|فيسبوك|يوتيوب|تغريد|reels|tiktok/;

export function topicMeaningOf(request: unknown): TopicMeaning {
  const n = normalizeText(request).replace(/_/g, " ");
  if (!TOPIC.test(` ${n}`)) return { kind: "none", topic: null };
  if (MADE_WITH_REQUEST.test(n)) return { kind: "made_with", topic: TOPIC_LABEL };
  if (ABOUT_REQUEST.test(n)) return { kind: "about", topic: TOPIC_LABEL };
  return { kind: CONTENT_NOUN.test(n) ? "ambiguous" : "none", topic: TOPIC_LABEL };
}

/** The search words that carry the meaning: for «about» the topic with explainer and news wording (the videos that discuss it); for «made with» the topic as it is. Null: nothing to write. */
export function topicQueryOf(meaning: TopicMeaning): string | null {
  if (!meaning.topic) return null;
  if (meaning.kind === "about") return `${meaning.topic} شرح وأخبار`;
  if (meaning.kind === "made_with") return meaning.topic;
  return null;
}

const withBa = (topic: string): string => `بال${topic.replace(/^ال/, "")}`;
export const topicQuestionAr = (topic: string): string => `تقصد فيديوهات بتتكلم عن ${topic}، ولا فيديوهات معمولة بيه؟`;
/** The two ready answers; each one decides the meaning when it is read with the request (topicMeaningOf). */
export const TOPIC_OPTIONS_AR = (topic: string): string[] => [`فيديوهات بتتكلم عن ${topic}`, `فيديوهات معمولة ${withBa(topic)}`];

// ---- which videos DISCUSS the topic
const MADE_WITH_TEXT: ReadonlyArray<RegExp> = [
  /(?:قصص|قصه|حكايات|حكايه|حدوته|حلقه|روايات|دراما)\s*(?:ب|بال)?\s*(?:ال)?(?:ذكاء\s*(?:ال)?اصطناعي|ai\b)/g,
  /\bai\s*(?:stor|generated|art|video|cartoon|animation)\w*/g,
  /حدوته\s*ai\b/g,
  /(?:معمول|مصنوع|متعمل|مولد|مصمم|منتج)\w*\s*(?:ب|بال)\s*(?:ال)?(?:ذكاء|ai\b)/g,
  /made\s+with\s+ai|generated\s+(?:by|with)\s+ai/g,
  /(?:^|\s)بال?ذكاء\s*(?:ال)?اصطناعي/g,
];
const TOPIC_ANYWHERE = /(?:ب)?(?:ال)?ذكاء\s*(?:ال)?اصطناعي|(?:^|[\s#])ai(?=$|[\s#.,؛،!؟?:])|chat\s*gpt|شات\s*جي\s*بي\s*تي/;

/**
 * 2: the video's own text talks about the topic (outside hashtags and outside any made-with phrase); 1: the topic is a plain hashtag with no made-with marker (neutral); 0: the topic appears only inside a made-with marker, or not at all. For a request that means «made with» the order is the
 * other way round (2: a made-with marker, 1: the topic somewhere, 0: neither). Any other meaning: 1 for every text (no preference).
 */
export function topicDiscussionClass(text: unknown, meaning: TopicMeaning): 0 | 1 | 2 {
  if (meaning.kind !== "about" && meaning.kind !== "made_with") return 1;
  const raw = normalizeText(text);
  const n = raw.replace(/_/g, " ");
  const marker = MADE_WITH_TEXT.some((re) => { re.lastIndex = 0; return re.test(n); });
  if (meaning.kind === "made_with") return marker ? 2 : TOPIC_ANYWHERE.test(` ${n}`) ? 1 : 0;
  // the hashtags are cut out BEFORE the underscores become spaces (a hashtag ends at a space: «#حدوتة_AI» is one hashtag)
  const hashtags = (raw.match(/#\S+/g) ?? []).map((h) => h.replace(/_/g, " "));
  let body = raw.replace(/#\S+/g, " ").replace(/_/g, " ");
  for (const re of MADE_WITH_TEXT) { re.lastIndex = 0; body = body.replace(re, " "); }
  if (TOPIC_ANYWHERE.test(` ${body}`)) return 2;
  if (marker) return 0;
  return hashtags.some((h) => TOPIC_ANYWHERE.test(` ${h.replace(/^#/, "")}`)) ? 1 : 0;
}
