import { normalizeDigits } from "./arabicDigits";
import { PLATFORM_OTHER_QUESTION_AR, understandMission } from "./consultantCopy";
import { SOCIAL_CONTENT_WORDS_RE, ACCOUNT_LOOKUP_RE, hasSocialTopic } from "./socialDiscovery";
import { commentsAnsweredNo, detectSocialIntent, SOCIAL_PLATFORM_LABEL_AR, TREND_WORDS_RE, type SocialIntent } from "./socialTasks";
import { facebookPageUrl, isSocialCapabilitySlug } from "./socialSources";
import { resolveTimeWindow, windowIsStatedByCustomer, WINDOW_OPTIONS_AR } from "./timeWindow";
import { CLARIFICATION_ANSWER_LABELS } from "./clarificationLabels";

/**
 * Smart discovery for a social request: ask ONLY what the request does not already say, with tappable choices plus free text, in one
 * card. What is already stated is never asked again (a platform, a topic, a period, a count of posts, whether comments are wanted, how
 * many per post). Pure: it reads the text (typed words and stored card answers alike) and builds the questions; no model, no network.
 *
 * It is consulted AFTER the older single questions (the period of a feed search, the cap of an open request), so nothing they already ask
 * changes. It starts a card only when something the plan cannot decide alone is missing:
 *  - a Facebook request with NO topic and no page: the topic or the page is needed (a topic is searched by the keyword service, so a request
 *    with a topic never asks for a page);
 *  - a Facebook request for the comments of posts that does not say how many comments per post.
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


/** «٥٠ منشور» / «١٠٠ بوست» in a request that does not ask for comments (the mission reads a count of posts only in a comments flow). */
function postsCountIn(text: string): number | null {
  const found = [...text.matchAll(/(?:^|[^\d])(\d{1,5})\s*(?:منشورات|منشور|بوستات|بوست)/gu)].pop();
  return found ? Number(found[1]) : null;
}

export function readSocialFacts(rawText: string): SocialFacts {
  const text = normalizeDigits(rawText || "");
  const intent = detectSocialIntent(text);
  const mission = understandMission(text);
  const window = resolveTimeWindow(text, { needsWindow: true });
  const commentsWanted = commentsAnsweredNo(text) ? false : intent.wantsComments || mission.allComments ? true : null;
  return {
    platform: intent.platform,
    topic: hasSocialTopic(text),
    source: Boolean(intent.channelRef || intent.pageName || intent.targetUrl),
    period: windowIsStatedByCustomer(window),
    postsCount: mission.videos ?? postsCountIn(text),
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

/** What a Facebook request with neither a topic nor a page needs, said once and plainly. */
export const FACEBOOK_TOPIC_OR_PAGE_AR = "أحتاج موضوع المنشورات أو اسم الصفحة العامة أو رابطها.";

/**
 * True when an enabled, VERIFIED Facebook service OTHER than the verified page services is registered (a live-catalog hashtag or topic search):
 * then a Facebook topic request is not stopped for a page, because that service may serve it (the plan builder decides, as it always did). A
 * service still «pending verification» (the built-in rows) does not count: it is not something the customer can be promised.
 */
export function otherFacebookServiceExists(capabilities: ReadonlyArray<{ slug?: string; platform?: string; tregEndpointId?: string; nameEn?: string; enabled?: boolean; status?: string }> | undefined): boolean {
  return (capabilities || []).some((cap) => cap.enabled !== false && cap.status === "verified" && !isSocialCapabilitySlug(cap.slug) && /facebook/i.test(`${cap.platform ?? ""} ${cap.slug ?? ""} ${cap.tregEndpointId ?? ""} ${cap.nameEn ?? ""}`));
}

/**
 * The page a Facebook request names by a display name that is not an address, or null. A link, a username («youm7», «@youm7») and a request that
 * names no page are not this case. The customer's own answer to the question below is in the text too: once a link or a username was given the
 * page is that address and nothing is asked again.
 */
export function facebookPageDisplayName(rawText: string): string | null {
  const text = normalizeDigits(rawText || "");
  const intent = detectSocialIntent(text);
  if (intent.platform !== "facebook" || !intent.pageName || intent.channelRef || intent.targetUrl) return null;
  return facebookPageUrl(intent.pageName) ? null : intent.pageName;
}

/** True when the page's name was given but still is not an address (after the question below, or from the start). */
export function facebookPageNameNeedsLink(rawText: string): boolean {
  return facebookPageDisplayName(rawText) !== null;
}

/** True when the customer already answered the page question (the answer travels in the text under its label) and it still names no address. */
export function facebookPageLinkAlreadyAsked(rawText: string): boolean {
  return /الصفحة المطلوبة\s*:/u.test(rawText || "");
}

export const FACEBOOK_PAGE_LINK_RETRY_AR = "لم أتمكن من التعرف على هذه الصفحة من اسمها. افتح الصفحة على فيسبوك وانسخ رابطها من شريط العنوان، أو اكتب اسم المستخدم الظاهر بعد علامة @ في صفحتها، وسأجهز لك الخطة.";

/** The one question that stops a page named only by its display name. */
export function facebookPageLinkQuestionAr(pageName: string): string {
  return `فيسبوك: ما رابط صفحة «${pageName}»؟ انسخه من شريط العنوان بعد فتح الصفحة، أو اكتب اسم المستخدم الظاهر بعد علامة @.`;
}

export interface DiscoveryContext {
  /** Another Facebook service is registered (see otherFacebookServiceExists): a topic request is then left to the plan builder. */
  otherFacebookService?: boolean;
}

/**
 * What a request still needs before the plan can be honest about its size: how many comments from each post (stated posts, comments wanted, no
 * per-post number), and, for Facebook with NEITHER a topic NOR a page, the topic or the page. A Facebook request with a topic and no page is
 * served by the keyword service (it searches posts by the topic), so it never asks for a page. Null when nothing of the sort is missing.
 */
export function socialDiscoveryTrigger(rawText: string, context: DiscoveryContext = {}): "page" | "page_link" | "per_post" | "trend" | "report" | null {
  const text = normalizeDigits(rawText || "");
  if (!SOCIAL_CONTENT_WORDS_RE.test(text) || ACCOUNT_LOOKUP_RE.test(text)) return null;
  const facts = readSocialFacts(text);
  if (!facts.platform) return null;
  // A Facebook topic REPORT never asks for a page (its Pages are the registry's): only how many posts and how many comments from each, when the request leaves them open.
  if (detectSocialIntent(text).report) return facts.postsCount === null || (facts.commentsPerPost === null && !facts.allComments) ? "report" : null;
  // A page named by its DISPLAY name («اليوم السابع»): no verified service can find a page by that name (they take a link, a username or an id), and a
  // source that finds nothing fails after the customer has approved. Ask once for the link, before any plan or hold.
  if (facebookPageNameNeedsLink(text)) return "page_link";
  // Only the shape the verified services cannot read by topic («N منشور بالتعليقات» with no page) is stopped for a page. A plain Facebook topic
  // request goes the way it always did, and so does any Facebook request while another verified Facebook service is registered.
  if (facts.platform === "facebook" && !facts.source && !facts.topic && !context.otherFacebookService && facts.postsCount !== null && facts.commentsWanted === true) return "page";
  if (facts.platform === "facebook" && facts.commentsWanted === true && !facts.allComments && facts.postsCount !== null && facts.commentsPerPost === null) return "per_post";
  // A Facebook TREND request on a topic with no page («الترندات الصحية في مصر من فيسبوك»): how many posts, comments or not and how many per post are
  // the customer's to say, not defaults the plan picks behind their back. (The period has its own older question, asked first.)
  if (facts.platform === "facebook" && !facts.source && facts.topic && TREND_WORDS_RE.test(text) && facts.commentsWanted !== false && (facts.postsCount === null || facts.commentsWanted === null)) return "trend";
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
  if (trigger === "page_link") {
    const name = facebookPageDisplayName(rawText) ?? "";
    return skipped.has(SOCIAL_DISCOVERY_IDS.page) ? [] : [item(SOCIAL_DISCOVERY_IDS.page, facebookPageLinkQuestionAr(name), "free")];
  }
  const facts = readSocialFacts(rawText);
  const items: DiscoveryItem[] = [];
  if (trigger === "report") {
    if (facts.postsCount === null) items.push(item(SOCIAL_DISCOVERY_IDS.posts, "كم منشورًا تريد في التقرير؟", "single", ["٥٠", "١٠٠", "٢٠٠", "٣٠٠"]));
    if (!facts.allComments && facts.commentsPerPost === null) items.push(item(SOCIAL_DISCOVERY_IDS.perPost, "كم تعليقًا تريد من كل منشور؟", "single", ["٥", "١٠", "٢٠"]));
    return items.filter((entry) => !skipped.has(entry.id));
  }
  if (!facts.source && trigger === "page") {
    items.push(item(SOCIAL_DISCOVERY_IDS.page, "فيسبوك: ما موضوع المنشورات التي تريد تعليقاتها، أو اسم الصفحة العامة أو رابطها؟", "free"));
  }
  if (facts.postsCount === null && facts.commentsWanted !== true) {
    items.push(item(SOCIAL_DISCOVERY_IDS.posts, "كم منشورًا تريد؟", "single", ["٢٠", "٥٠", "١٠٠", "٢٠٠"]));
  } else if (facts.postsCount === null) {
    items.push(item(SOCIAL_DISCOVERY_IDS.posts, "كم منشورًا تريد أن آخذ تعليقاته؟", "single", ["١٠", "٢٥", "٥٠", "١٠٠"]));
  }
  if (facts.commentsWanted === null) {
    items.push(item(SOCIAL_DISCOVERY_IDS.commentsWanted, "هل تريد تعليقات المنشورات أيضًا؟", "single", [COMMENTS_YES_AR, COMMENTS_NO_AR]));
  }
  // On a trend request «comments or not» is asked first; how many per post is asked only for the customer who wants them.
  if ((facts.commentsWanted === true || (facts.commentsWanted === null && trigger !== "trend")) && !facts.allComments && facts.commentsPerPost === null) {
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

/** A link typed without its scheme («facebook.com/youm7») is made a link, so the readers that look for links find it. */
export function withLinkScheme(value: string): string {
  const text = String(value || "").trim();
  return /^(?:www\.|m\.facebook\.com|facebook\.com|fb\.com)/iu.test(text) ? `https://${text}` : text;
}

/** One line before the questions: what was understood, so nothing already said is asked again. */
export function socialDiscoveryIntroAr(rawText: string, context: DiscoveryContext = {}): string {
  const trigger = socialDiscoveryTrigger(rawText, context);
  if (trigger === "page_link") return "فهمت طلبك على فيسبوك. أقرأ الصفحة من رابطها أو اسم مستخدمها، لا من اسمها المكتوب فقط، ولن أبدأ مهمة قد تعود فارغة.";
  if (trigger === "page") return `فهمت طلبك على فيسبوك. ${FACEBOOK_TOPIC_OR_PAGE_AR} وأسأل فقط عمّا لم تذكره:`;
  return "فهمت طلبك، وأسأل فقط عمّا لم تذكره:";
}

/** Said once when the name typed after «أخرى» is not a platform this service reads. No plan, no hold, no balance. */
export const UNSUPPORTED_PLATFORM_AR = "عذرًا، هذه المنصة غير متاحة عندنا الآن، ولم أبدأ أي بحث ولم يُحجز أي رصيد. المنصات المتاحة: تيك توك، فيسبوك، يوتيوب، ومنصة X. اختر إحداها لأجهز لك الخطة.";

/** X has no service that reads the comments of a post. Said once, before any plan, when comments are asked on X: nothing is searched, quoted or held. */
export const X_COMMENTS_UNAVAILABLE_AR = "عذرًا، تعليقات منشورات منصة X غير متاحة عندنا الآن، ولم أبدأ أي بحث ولم يُحجز أي رصيد. المتاح على منصة X هو المنشورات نفسها مع ردودها إن أعادها المصدر، فأعد طلبك بدون التعليقات لأجهز لك الخطة.";

/** A plan for an X request that only another service could run is never shown: said once, nothing held. */
export const X_REQUEST_NOT_SERVED_AR = "عذرًا، لا توجد عندنا خدمة تنفّذ هذا الطلب على منصة X، ولم أبدأ أي بحث ولم يُحجز أي رصيد. المتاح على منصة X هو منشورات حساب واحد أو منشورات موضوع محدد، فأعد صياغة طلبك لأجهز لك الخطة.";

/** An account's posts are read one account at a time: a request that names several accounts is told so, once, before any plan. */
export const X_ONE_ACCOUNT_AR = "عذرًا، أقرأ منشورات حساب واحد على منصة X في كل طلب، ولم أبدأ أي بحث ولم يُحجز أي رصيد. أرسل اسم حساب واحد لأجهز لك الخطة، ثم اطلب الحساب الآخر في طلب منفصل.";

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PLATFORM_LABEL_RE = new RegExp(`${escapeRe(CLARIFICATION_ANSWER_LABELS.social_platform_required)}\\s*:\\s*(?:أخرى|اخرى)(?![\\p{L}])`, "u");
const OTHER_LABEL_RE = new RegExp(`${escapeRe(CLARIFICATION_ANSWER_LABELS.social_platform_other_required)}\\s*:`, "u");

/**
 * Where the platform follow-up stands in the request text: «asked» when the customer answered «أخرى» to the platform question (the follow-up is
 * the next question), «answered» when the name after it is typed and still names no platform this service reads, null otherwise. Stateless: it reads the
 * labelled answers the conversation already carries, so it never repeats a question and never holds anything.
 */
export function platformFollowUpStateAr(rawText: string): "asked" | "answered" | null {
  const text = normalizeDigits(rawText || "");
  if (detectSocialIntent(text).platform) return null;
  if (OTHER_LABEL_RE.test(text)) return "answered";
  return PLATFORM_LABEL_RE.test(text) ? "asked" : null;
}

/**
 * «posts only» on a Facebook TOPIC request: no service of ours reads posts of a topic without their comments (the only Facebook topic search in the
 * catalog is pending verification and not enabled), so the customer is told so, once, and nothing is quoted or held.
 */
export const FACEBOOK_POSTS_ONLY_UNAVAILABLE_AR = "على فيسبوك البحث بالموضوع يعيد التعليقات فقط، ولا توجد عندنا خدمة لمنشورات بلا تعليقات بالموضوع، فاختر «نعم، مع التعليقات» أو أرسل رابط صفحة عامة لقراءة منشوراتها، ولم يُحجز أي رصيد.";

/** A platform name typed as the answer to the platform question that no service of ours reads. The supported names are the four we serve. */
const SUPPORTED_PLATFORM_ANSWER_RE = /تيك\s*توك|tiktok|فيسبوك|فيس\s*بوك|facebook|يوتيوب|youtube|منصة\s*x|\bx\b|إكس|اكس|أكس|تويتر|twitter/iu;

/**
 * True when the LAST platform name given names a platform this service does not read (typed «سناب شات», «انستجرام», …).
 * A bare «أخرى» is not a name: it only opens the free-text field, so it never counts as the answer.
 */
export function unsupportedPlatformAnswerAr(rawText: string): boolean {
  const text = normalizeDigits(rawText || "");
  let value: string | null = null;
  // A value runs up to the next known answer label (or «·»): a bare «أخرى:» must not swallow the word after it.
  const nextLabel = Object.values(CLARIFICATION_ANSWER_LABELS).map(escapeForRegex).join("|");
  for (const label of [CLARIFICATION_ANSWER_LABELS.social_platform_required, CLARIFICATION_ANSWER_LABELS.social_platform_other_required]) {
    for (const match of text.matchAll(new RegExp(`${escapeForRegex(label)}\\s*:\\s*([^·\\n]*?)(?=\\s+(?:${nextLabel})\\s*:|\\s*·|$)`, "gu"))) {
      const named = match[1].trim();
      if (named && !/^(?:أخرى|اخرى)$/u.test(named)) value = named;
    }
  }
  if (!value) return false;
  return !SUPPORTED_PLATFORM_ANSWER_RE.test(value);
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
