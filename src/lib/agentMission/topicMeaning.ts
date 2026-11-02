import { normalizeText } from "./relevance";

/**
 * WHAT THE REQUEST MEANS BY ITS TOPIC (S8; docs/S1-LIVE-FINDINGS.md, live 2026-11-02 ~13:35: «فيديوهين عن الذكاء الاصطناعي» delivered AI-generated drama stories: the keyword matched the hashtag #قصص_بالذكاء_الاصطناعي and the most-commented order picked the viral stories).
 * OWNER DECISION (request understanding, never filtering): «عن X» means content that talks about or explains X; «معمول بـ X» (made with X) is a different request. The query is built from that meaning; among the results the videos whose own text discusses the topic are preferred over
 * videos where the topic appears only as a made-with hashtag (choosing which videos to read; nothing delivered is removed and no comment is filtered); a request that is ambiguous between the two gets a question card before planning. Code, never a model. The topics are the technologies
 * a video can be MADE WITH (the only topics for which the two meanings differ). Pure.
 */
export type TopicKind = "about" | "made_with" | "ambiguous" | "none";
export interface TopicMeaning {
  kind: TopicKind;
  /** The topic as the customer reads it («الذكاء الاصطناعي»); null when the request has none of the topics. */
  topic: string | null;
  /** The search words the model wrote from its understanding of the request (rule 4 of the consolidation: any topic, not a list): written into the tool's query field. */
  query?: string;
  /** The words the model named that mark content MADE WITH the topic rather than ABOUT it («قصص», «معمول بـ», a hashtag): the videos whose text discusses the topic outside them come first (an order, never a filter). */
  markers?: string[];
}

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
  // the model's own query (it understood the request) wins over the fixed wording
  if (meaning.query && (meaning.kind === "about" || meaning.kind === "made_with")) return meaning.query;
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
  if (meaning.topic !== TOPIC_LABEL) return discussionClassOf(text, meaning);
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


/**
 * RULE 4 OF THE CONSOLIDATION: THE MEANING OF ANY TOPIC IS THE MODEL'S UNDERSTANDING, checked by code. `propose_plan` carries `topic_meaning: {relation, topic_ar, search_query?, made_with_markers_ar?}` written by the planner from the customer's words: «عن X» is ABOUT, «معمول بـ X» is MADE WITH, a request that names a thing
 * one can make content with and says neither is AMBIGUOUS (the plan is turned into the question card). Code never takes what it cannot check: the relation is one of the four, the topic is a phrase of the customer's own request (a topic the model invented is refused), the query contains the topic's words.
 * Returns null when the model's reading is missing or fails a check: the old word list then reads the request (the AI family only), as before. Pure.
 */
const RELATIONS: ReadonlySet<string> = new Set(["about", "made_with", "ambiguous", "none"]);
const wordsOfText = (text: string): string[] => normalizeText(text).replace(/[#_]/g, " ").split(/\s+/).filter(Boolean).map((w) => w.replace(/^(?:ال|ب|بال|لل|ل)(?=.{3,})/, ""));
export function topicMeaningFromModel(raw: unknown, request: unknown): TopicMeaning | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const relation = String(r.relation ?? "");
  if (!RELATIONS.has(relation)) return null;
  if (relation === "none") return { kind: "none", topic: null };
  const topic = String(r.topic_ar ?? "").trim();
  if (topic.length < 2 || topic.length > 60) return null;
  // the topic is the customer's own phrase: every word of it is a word of the request
  const asked = new Set(wordsOfText(String(request ?? "")));
  const topicWords = wordsOfText(topic);
  if (topicWords.length === 0 || !topicWords.every((w) => asked.has(w))) return null;
  if (relation === "ambiguous") return { kind: "ambiguous", topic };
  const query = String(r.search_query ?? "").trim();
  if (query !== "") {
    const have = new Set(wordsOfText(query));
    if (query.length > 120 || !topicWords.every((w) => have.has(w))) return null;
  }
  const markers = (Array.isArray(r.made_with_markers_ar) ? r.made_with_markers_ar : []).map((m) => String(m ?? "").trim()).filter((m) => m.length >= 2 && m.length <= 60).slice(0, 12);
  return { kind: relation as TopicKind, topic, ...(query !== "" ? { query } : {}), ...(markers.length > 0 ? { markers } : {}) };
}

/** The same order for any topic the model named: the topic's words in the text outside hashtags and outside the model's made-with markers (2), the topic only as a plain hashtag (1), only inside a made-with marker or not at all (0); for «made with» the other way round. */
function discussionClassOf(text: unknown, meaning: TopicMeaning): 0 | 1 | 2 {
  const raw = normalizeText(text);
  const topicWords = wordsOfText(meaning.topic ?? "");
  const hasTopic = (t: string): boolean => { const have = new Set(wordsOfText(t)); return topicWords.length > 0 && topicWords.every((w) => have.has(w)); };
  const markers = (meaning.markers ?? []).map((m) => normalizeText(m).replace(/#/g, "").replace(/_/g, " ").trim()).filter(Boolean);
  const flat = raw.replace(/_/g, " ");
  const marked = markers.some((m) => flat.includes(m));
  if (meaning.kind === "made_with") return marked ? 2 : hasTopic(raw) ? 1 : 0;
  const hashtags = (raw.match(/#\S+/g) ?? []).map((h) => h.replace(/^#/, ""));
  let body = raw.replace(/#\S+/g, " ").replace(/_/g, " ");
  for (const m of markers) body = body.split(m).join(" ");
  if (hasTopic(body)) return 2;
  if (marked) return 0;
  return hashtags.some((h) => hasTopic(h.replace(/_/g, " "))) ? 1 : 0;
}
