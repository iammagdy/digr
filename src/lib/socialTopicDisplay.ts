import { socialContentTopicFromTitle } from "./planParameters";
import { socialSubjectText } from "./socialTasks";

/**
 * The topic a social plan shows in its steps and chips. The plan's own parameters say it exactly (the query, subject or topic the
 * search runs on); the conversation title is only a shortened sentence (cut at fifty characters, ending with «…»), so a title that was
 * cut inside the topic («… عن «كرة…» for «كرة القدم») must never be where the topic is read from.
 */
export function socialTopicForDisplay(input: { params?: Record<string, any> | null; conversationTitle?: string; trending?: boolean }): string {
  if (input.trending) return "الفيديوهات الرائجة";
  const params = input.params && typeof input.params === "object" ? input.params : {};
  for (const key of ["subject", "topic", "query"]) {
    const value = params[key];
    if (typeof value !== "string") continue;
    const text = value.trim().replace(/^[«"“]+|[»"”]+$/gu, "").trim();
    if (text && !/^https?:\/\//i.test(text)) return text;
  }
  return topicFromTitle(input.conversationTitle);
}

/** A title that ends with «…» was shortened: no topic is read from it. */
export function topicFromTitle(title: string | undefined): string {
  const text = String(title || "").trim();
  if (!text || /[…]$|\.\.\.$/u.test(text)) return "";
  return socialSubjectText(text) || socialContentTopicFromTitle(text);
}
