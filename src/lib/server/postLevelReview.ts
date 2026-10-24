import { getSocialCapability } from "../socialSources";
import { isTopicSearchRequest } from "./researchRelevanceGate";

/**
 * Which jobs are reviewed at the level of the POST (or video) a comment was written under, not comment by comment.
 *
 * The comments of a topic search are judged by their post: the posts are selected first (evidence in the post's own text, then ONE model call per batch of
 * posts, fail closed, inside the job's review budget) and the comments of a selected post are delivered by plain rules (TikTok and YouTube: not empty, not a repeat, at
 * least three letters, not a bare supplication; the Facebook keyword service: only not empty, not a repeat and not a bare link, the comments are taken as they are). No comment ever reaches the model one by one, so the review cost of a job follows its number of POSTS, not its number of
 * comments. TikTok and YouTube have worked this way since PR #205; Facebook joins here so that a Facebook topic request (posts, then their comments) is cheap by
 * construction the day its topic search is wired. A page, a channel, a link and a trending feed are not topic searches and are not touched.
 */
export const POST_LEVEL_REVIEW_PLATFORMS: readonly string[] = ["tiktok", "youtube", "facebook"];

export function usesPostLevelReview(capabilitySlug: string | undefined | null, params: Record<string, any> | undefined | null): boolean {
  const capability = getSocialCapability(capabilitySlug);
  // the Facebook topic report judges its posts by AXIS (rules, then one model call per 50 posts), never by topic relevance, and never its comments
  if (capability?.topicReport) return false;
  return capability?.kind === "comments" && POST_LEVEL_REVIEW_PLATFORMS.includes(String(capability.platform)) && isTopicSearchRequest(params || {});
}
