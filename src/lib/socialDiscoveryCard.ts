import { normalizeDigits } from "./arabicDigits";
import { understandMission } from "./consultantCopy";
import { SOCIAL_CONTENT_WORDS_RE, ACCOUNT_LOOKUP_RE, hasSocialTopic } from "./socialDiscovery";
import { detectSocialIntent, SOCIAL_PLATFORM_LABEL_AR, type SocialIntent } from "./socialTasks";
import { isSocialCapabilitySlug } from "./socialSources";
import { resolveTimeWindow, windowIsStatedByCustomer, WINDOW_OPTIONS_AR } from "./timeWindow";

/**
 * Smart discovery for a social request: ask ONLY what the request does not already say, with tappable choices plus free text, in one
 * card. What is already stated is never asked again (a platform, a topic, a period, a count of posts, whether comments are wanted, how
 * many per post). Pure: it reads the text (typed words and stored card answers alike) and builds the questions; no model, no network.
 *
 * It is consulted AFTER the older single questions (the period of a feed search, the cap of an open request), so nothing they already ask
 * changes. It starts a card only when something the plan cannot decide alone is missing:
 *  - a Facebook request that names no page and no post link (Facebook cannot be searched by topic: its posts are read from one public page);
 *  - a Facebook request for the comments of a page's posts that does not say how many comments per post.
 * The other questions (how many posts, comments or not, the period) ride along in the same card only when they too are missing.
 */
export const SOCIAL_DISCOVERY_IDS = {
  platform: "social_platform_required",
  page: "social_page_required",
  period: "social_time_required",
  posts: "social_posts_count_required",
  commentsWanted: "social_comments_wanted",
  perPost: "social_comments_per_post",
} as const;

/** The ids of the questions this module owns (the generic option banks never replace their choices). */
export const SOCIAL_DISCOVERY_OWN_IDS: ReadonlySet<string> = new Set([SOCIAL_DISCOVERY_IDS.page, SOCIAL_DISCOVERY_IDS.posts, SOCIAL_DISCOVERY_IDS.commentsWanted, SOCIAL_DISCOVERY_IDS.perPost]);

export const COMMENTS_YES_AR = "نعم، مع التعليقات";
export const COMMENTS_NO_AR = "المنشورات فقط";

/** What the request already says. */
export interface SocialFacts {
  platform: SocialIntent["platform"];
  topic: boolean;
  /** A Facebook page (name or link), a channel, or a link to the post itself. */
  source: boolean;
  period: boolean;
  /** How many posts or videos were asked for. */
  postsCount: number | null;
  /** true: comments are wanted; false: the customer said posts only; null: not said. */
  commentsWanted: boolean | null;
  commentsPerPost: number | null;
  /** «كل التعليقات»: the customer wants every comment, so a per-post number is not asked. */
  allComments: boolean;
}

const POSTS_ONLY_RE = /(?:المنشورات فقط|منشورات فقط|بوستات فقط|بدون تعليقات|من غير تعليقات|دون تعليقات)/u;

export function readSocialFacts(rawText: string): SocialFacts {
  const text = normalizeDigits(rawText || "");
  const intent = detectSocialIntent(text);
  const mission = understandMission(text);
  const window = resolveTimeWindow(text, { needsWindow: true });
  const postsOnly = POSTS_ONLY_RE.test(text);
  const commentsWanted = postsOnly ? false : intent.wantsComments || mission.allComments ? true : null;
  return {
    platform: intent.platform,
    topic: hasSocialTopic(text),
    source: Boolean(intent.channelRef || intent.pageName || intent.targetUrl),
    period: windowIsStatedByCustomer(window),
    postsCount: mission.videos ?? null,
    commentsWanted,
    commentsPerPost: mission.commentsPerVideo ?? null,
    allComments: mission.allComments,
  };
}

export interface DiscoveryItem {
  id: string;
  text: string;
  question: string;
  type: "free" | "single";
  options: string[];
  allowOther: boolean;
}

const item = (id: string, text: string, type: "free" | "single", options: string[] = []): DiscoveryItem => ({ id, text, question: text, type, options, allowOther: true });

const platformWordAr = (platform: SocialFacts["platform"]) => (platform ? SOCIAL_PLATFORM_LABEL_AR[platform] : "المنصة");

/** What a Facebook request without a page needs, said once and plainly. */
export const FACEBOOK_NO_TOPIC_SEARCH_AR = "فيسبوك لا يتيح البحث بالموضوع؛ أقرأ منشورات صفحة عامة محددة. أحتاج اسم الصفحة أو رابطها.";

/**
 * True when an enabled, VERIFIED Facebook service OTHER than the verified page services is registered (a live-catalog hashtag or topic search):
 * then a Facebook topic request is not stopped for a page, because that service may serve it (the plan builder decides, as it always did). A
 * service still «pending verification» (the built-in rows) does not count: it is not something the customer can be promised.
 */
export function otherFacebookServiceExists(capabilities: ReadonlyArray<{ slug?: string; platform?: string; tregEndpointId?: string; nameEn?: string; enabled?: boolean; status?: string }> | undefined): boolean {
  return (capabilities || []).some((cap) => cap.enabled !== false && cap.status === "verified" && !isSocialCapabilitySlug(cap.slug) && /facebook/i.test(`${cap.platform ?? ""} ${cap.slug ?? ""} ${cap.tregEndpointId ?? ""} ${cap.nameEn ?? ""}`));
}

export interface DiscoveryContext {
  /** Another Facebook service is registered (see otherFacebookServiceExists): a topic request is then left to the plan builder. */
  otherFacebookService?: boolean;
}

/**
 * What a request still needs before the plan can be honest about its size: how many comments from each post (stated posts, comments wanted, no
 * per-post number), and, for Facebook with no page and no other verified Facebook service, the page itself (Facebook posts are read from one
 * public page, not searched by topic). Null when nothing of the sort is missing.
 */
export function socialDiscoveryTrigger(rawText: string, context: DiscoveryContext = {}): "page" | "per_post" | null {
  const text = normalizeDigits(rawText || "");
  if (!SOCIAL_CONTENT_WORDS_RE.test(text) || ACCOUNT_LOOKUP_RE.test(text)) return null;
  const facts = readSocialFacts(text);
  if (!facts.platform) return null;
  // Only the shape the verified services cannot read by topic («N منشور بالتعليقات» with no page) is stopped for a page. A plain Facebook topic
  // request goes the way it always did, and so does any Facebook request while another verified Facebook service is registered.
  if (facts.platform === "facebook" && !facts.source && !context.otherFacebookService && facts.postsCount !== null && facts.commentsWanted === true) return "page";
  if (facts.platform === "facebook" && facts.commentsWanted === true && !facts.allComments && facts.postsCount !== null && facts.commentsPerPost === null) return "per_post";
  return null;
}

/**
 * The questions of the card, in the order a customer answers them. Questions in `skipped` are left out (a skipped one is not asked twice).
 * Empty when nothing the plan cannot decide alone is missing.
 */
export function socialDiscoveryItems(rawText: string, options: { skipped?: ReadonlySet<string> } & DiscoveryContext = {}): DiscoveryItem[] {
  const trigger = socialDiscoveryTrigger(rawText, options);
  if (!trigger) return [];
  const skipped = options.skipped ?? new Set<string>();
  const facts = readSocialFacts(rawText);
  const items: DiscoveryItem[] = [];
  if (!facts.source && trigger === "page") {
    items.push(item(SOCIAL_DISCOVERY_IDS.page, `${platformWordAr(facts.platform)}: ما اسم الصفحة العامة أو رابطها؟`, "free"));
  }
  if (facts.postsCount === null && facts.commentsWanted !== true) {
    items.push(item(SOCIAL_DISCOVERY_IDS.posts, "كم منشورًا تريد؟", "single", ["٢٠", "٥٠", "١٠٠", "٢٠٠"]));
  } else if (facts.postsCount === null) {
    items.push(item(SOCIAL_DISCOVERY_IDS.posts, "كم منشورًا تريد أن آخذ تعليقاته؟", "single", ["١٠", "٢٥", "٥٠", "١٠٠"]));
  }
  if (facts.commentsWanted === null) {
    items.push(item(SOCIAL_DISCOVERY_IDS.commentsWanted, "هل تريد تعليقات المنشورات أيضًا؟", "single", [COMMENTS_YES_AR, COMMENTS_NO_AR]));
  }
  if (facts.commentsWanted !== false && !facts.allComments && facts.commentsPerPost === null) {
    items.push(item(SOCIAL_DISCOVERY_IDS.perPost, "كم تعليقًا تريد من كل منشور؟", "single", ["١٠", "٢٠", "٥٠", "١٠٠"]));
  }
  if (!facts.period && trigger === "page" && facts.commentsWanted !== false && facts.postsCount !== null) {
    // a stated count of posts with no period: the plan proposes the last month unless asked; offered, never required
    items.push(item(SOCIAL_DISCOVERY_IDS.period, "ما الفترة الزمنية التي تهمّك؟", "single", [...WINDOW_OPTIONS_AR]));
  }
  return items.filter((entry) => !skipped.has(entry.id));
}

/**
 * The words the discovery card's stored answers become in the request text, in plain Arabic the older readers already understand
 * (a page after «صفحة», a count with its noun, «مع التعليقات»): so a card answer and a typed sentence read the same.
 */
export function discoveryAnswerAsRequestText(questionId: string, rawValue: string): string | null {
  const value = String(rawValue || "").trim();
  if (!value) return null;
  switch (questionId) {
    case SOCIAL_DISCOVERY_IDS.page:
      // the closing «·» ends the page's name, so the words that follow («٢٠ تعليق من كل منشور») are never read as part of it
      return /^(?:https?:\/\/|www\.|facebook\.com|fb\.com|m\.facebook\.com)/iu.test(value) ? `${value} ·` : `صفحة ${value} ·`;
    case SOCIAL_DISCOVERY_IDS.posts:
      return `${value} منشور`;
    case SOCIAL_DISCOVERY_IDS.commentsWanted:
      return value === COMMENTS_NO_AR ? "المنشورات فقط" : value === COMMENTS_YES_AR ? "مع التعليقات" : null;
    case SOCIAL_DISCOVERY_IDS.perPost:
      return `${value} تعليق من كل منشور`;
    default:
      return null;
  }
}

/** One line before the questions: what was understood, so nothing already said is asked again. */
export function socialDiscoveryIntroAr(rawText: string, context: DiscoveryContext = {}): string {
  const trigger = socialDiscoveryTrigger(rawText, context);
  if (trigger === "page") return `فهمت طلبك على فيسبوك. ${FACEBOOK_NO_TOPIC_SEARCH_AR} وأسأل فقط عمّا لم تذكره:`;
  return "فهمت طلبك، وأسأل فقط عمّا لم تذكره:";
}
