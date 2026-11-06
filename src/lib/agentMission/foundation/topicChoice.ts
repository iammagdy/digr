import type { Ask } from "./ask";
import type { TopicTier } from "./pool";

/**
 * LIVE ROUND 7 (3 Nov 2026, msn_4e68812d396bd5db0a01): «عن الذكاء الاصطناعي» again chose two videos that name the topic only in their hashtags, while an earlier run of the same request (msn_e32cd467fe6bbdfa943e) had found videos whose caption body is about it: the source
 * returned another page for the identical request. When the first page the planning reads has no video whose own text is about the topic, the planning uses the one more read the gateway allows for a source to ask a SECOND query built by code from the Ask (the topic with the words
 * of talking about it), ranks the union by the same rule, and, if the union still has none, asks the customer BEFORE approval how to go on. Pure: no I/O, no model. Never a filter: the question only decides whether the plan is made from what was found; nothing found is removed.
 */

/** The second search words: the topic with the words of talking about it. Null when the Ask has no topic, or the customer asked for what is MADE WITH the topic (the first query is what they asked), or the language has no wording here. */
export function aboutQueryOf(ask: Pick<Ask, "topic" | "language">): string | null {
  const topic = ask.topic.text;
  if (!topic || (ask.topic.relation !== "about" && ask.topic.relation !== "ambiguous")) return null;
  if (ask.language === null || ask.language === "ar") return `${topic} شرح وأخبار`;
  if (ask.language === "en") return `${topic} explained`;
  return null;
}

/** The three ready answers of the question card; each is read by its exact words (noAboutChoiceOf). Any other text the customer types is an amendment of the request, read with it. */
export const NO_ABOUT_OPTIONS_AR = {
  // NOV 6 2026: asked on every platform now, so the words name no kind of item; the TikTok-era wording is still read as the same answer (LEGACY_USE_AS_IS_AR)
  useAsIs: "أكمل بما وجدتموه كما هو، مع علامة على كل عنصر",
  change: "سأعدّل طلبي",
  cancel: "ألغِ المهمة",
} as const;

const LEGACY_USE_AS_IS_AR = "أكمل بما وجدتموه كما هو، مع علامة على كل فيديو";
export type NoAboutChoice = "use" | "change" | "cancel";
export function noAboutChoiceOf(answer: unknown): NoAboutChoice | null {
  const t = String(answer ?? "").replace(/\s+/g, " ").trim();
  if (t === NO_ABOUT_OPTIONS_AR.useAsIs || t === LEGACY_USE_AS_IS_AR) return "use";
  if (t === NO_ABOUT_OPTIONS_AR.change) return "change";
  if (t === NO_ABOUT_OPTIONS_AR.cancel) return "cancel";
  return null;
}

/** The question, in the customer's words: what was not found and what the found videos are. `hashtagsOnly`: some video names the topic only in its hashtags. */
export function noAboutQuestionAr(topic: string, noun: { one: string; talks: string }, hashtagsOnly: boolean): string {
  return `لم نجد في ما قرأناه ${noun.one} يطابق طلبك و${noun.talks} عن «${topic}»؛ ${hashtagsOnly ? "ما وجدناه يذكر الموضوع في الوسوم فقط، أي أنه غالبًا صُنع بالموضوع ولا يتحدث عنه" : "ما وجدناه لا يذكر الموضوع في نصه"}. كيف تريد أن نكمل؟`;
}

/** The mark column of a delivery whose videos are not all about the topic: the relation of each one's own text to the topic. */
export const TOPIC_RELATION_KEY = "topic_relation";
export const TOPIC_RELATION_TITLE_AR = "علاقة النص بالموضوع";
export function topicRelationAr(tier: TopicTier): string {
  return tier === 2 ? "يتحدث نصه عن الموضوع" : tier === 1 ? "يذكر الموضوع في الوسوم فقط" : "لا يذكر الموضوع";
}
