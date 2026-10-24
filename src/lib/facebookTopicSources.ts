import { FACEBOOK_JOB_CEILINGS } from "./facebookCeilings";
import { RECORD_COSTS } from "./recordPricing";
import { FACEBOOK_REPORT_SLUG, REPORT_MAX_COMMENTS, REPORT_MAX_POSTS } from "./facebookReport/constants";
import { withTopicCountryWord } from "./xSearchWindow";
import type { SocialCapabilityDef, SocialSource } from "./socialSources";

/**
 * Facebook posts found by a topic. Read from the public catalog on 2026-10-23 (`GET https://treg.to/catalog/platforms/facebook`): the catalog lists two keyword
 * searches, and neither publishes how many posts one call returns.
 *  - `justoneapi.x.facebook-search-post-v1`: GET, 0.2 CNY = 0.02952 USD per successful call, `keyword` required, `startDate` / `endDate` (yyyy-MM-dd) and `cursor`.
 *    Rows per call are NOT published; one team's catalog review reports 6 posts in one call, which is the figure used here (ASSUMED, see RECORD_COSTS).
 *  - `anyapi.facebook.search_posts`: POST, 0.06606 USD per call, `query` required, `limit` 1-20 (default 20), `startDate` / `endDate`, `location`; it has NO cursor, so it
 *    can serve one page only (at most 20 posts). It is the fallback when the first source fails, never the way a 300-post job is served.
 * Neither search has a country filter that fits a topic request (the second one has a free-text `location`, which the catalog says to give as city and country): a country the customer
 * asked for travels in the search text, as it does for TikTok and YouTube, and the plan says so.
 * The shape of the rows of either answer was not read: the field that holds a post's link is found by the same reader as every other Facebook post.
 */
export const FACEBOOK_TOPIC_POSTS: SocialSource[] = [
  {
    endpointId: "justoneapi.x.facebook-search-post-v1",
    method: "GET",
    costUsd: 0.02952,
    catalogParams: ["keyword", "startDate", "endDate", "cursor"],
    catalogRequiredParams: ["keyword"],
    requiresSession: false,
    maxPerCall: 6,
    paging: "cursor",
    build: (r) => (r.query ? { keyword: withTopicCountryWord(r.query, r.region), ...(r.dateFrom ? { startDate: r.dateFrom } : {}), ...(r.dateTo ? { endDate: r.dateTo } : {}), ...(r.cursor ? { cursor: r.cursor } : {}) } : null),
  },
  {
    endpointId: "anyapi.facebook.search_posts",
    method: "POST",
    costUsd: 0.06606,
    catalogParams: ["query", "limit", "startDate", "endDate", "location"],
    catalogRequiredParams: ["query"],
    requiresSession: false,
    maxPerCall: 20,
    paging: "none",
    build: (r) => (r.query ? { query: withTopicCountryWord(r.query, r.region), limit: Math.min(20, Math.max(1, r.limit)), ...(r.dateFrom ? { startDate: r.dateFrom } : {}), ...(r.dateTo ? { endDate: r.dateTo } : {}) } : null),
  },
];

/**
 * What sets a topic service that reads POSTS and then their comments apart from the TikTok and YouTube topic services (which read one page of videos): how many posts a
 * job may read, how few comments one post gives (the price is built on that), and whether the search keeps paging until the posts wanted are adopted.
 */
export interface PostTopicTraits {
  /** Most posts one job reads (the Facebook topic service reads up to its 300-post ceiling; the shared video limit of 20 applies to the others). */
  maxVideos?: number;
  /** Fewest comments read from one post: the unit price assumes this many comments share the cost of finding their post. */
  minPerVideo?: number;
  /** A topic search keeps paging the discovery source, each page judged before any comment is read, until the posts wanted are adopted. */
  pagedDiscovery?: boolean;
  /** The Facebook topic REPORT: the posts come from vetted Pages (see facebookReport/registry), the search is only a small supplement, and the result is a report workbook plus a methodology file. */
  topicReport?: boolean;
}

/**
 * The service that finds Facebook posts by a keyword and reads the comments of the posts about it: ONE item in a quote, like the TikTok and YouTube topic services.
 * `comments` is the Facebook comments source list the other Facebook service uses (a post is read through its link). The unit price is built in `recordPricing.RECORD_COSTS`.
 */
export function facebookTopicCapability(comments: SocialSource[]): SocialCapabilityDef {
  return {
    slug: "social-facebook-keyword-comments",
    platform: "facebook",
    kind: "comments",
    nameAr: "تعليقات منشورات فيسبوك عن موضوع",
    nameEn: "Facebook Keyword Post Comments",
    descriptionAr: "البحث عن منشورات فيسبوك العامة بكلمة أو موضوع، واختيار المنشورات المتعلقة بالموضوع فقط، ثم سحب تعليقات كل منشور مختار، مع بيانات كل تعليق ورابط المنشور.",
    modes: ["query"],
    // The cost of one DELIVERED comment including the search that found its post (see RECORD_COSTS): the same function prices it, no other number is added.
    rowCostUsd: 0.00235,
    maxRows: FACEBOOK_JOB_CEILINGS.comments,
    // The catalog publishes no success rate for the topic search (added 2026-07-28, mixed reviews): 0.9 is an assumption, not a measurement.
    successRate: 0.9,
    discover: { query: FACEBOOK_TOPIC_POSTS },
    comments,
    maxVideos: FACEBOOK_JOB_CEILINGS.posts,
    minPerVideo: 5,
    pagedDiscovery: true,
  };
}

/**
 * The Facebook topic REPORT (`facebook-topic-report`): ONE item in a quote, like the keyword service, whose unit is a delivered comment. It is NOT a paged topic search: its posts are
 * read from the registry's Pages round-robin (the sources of `social-facebook-posts`), the keyword search above is only a small supplement, and its comments are read through the sources
 * of `social-facebook-comments`. The collector is `facebookReportAdapter`; the price is the one `RECORD_COSTS` entry.
 */
export function facebookReportCapability(comments: SocialSource[], pagePosts: SocialSource[] = []): SocialCapabilityDef {
  return {
    slug: FACEBOOK_REPORT_SLUG,
    platform: "facebook",
    kind: "comments",
    nameAr: "تقرير منشورات فيسبوك عن موضوع",
    nameEn: "Facebook Topic Report",
    descriptionAr: "تقرير عن موضوع على فيسبوك في دولة وفترة محددتين: منشورات من صفحات عامة موثوقة وتعليقاتها، مصنّفة على محاور، مع ملف إكسل للبيانات وملف منفصل للمنهجية والتحليل.",
    modes: ["query"],
    rowCostUsd: RECORD_COSTS[FACEBOOK_REPORT_SLUG].costUsdPerRecord,
    maxRows: REPORT_MAX_COMMENTS,
    // not measured with this collector: the figure of the keyword service (an assumption) is kept, nothing better exists
    successRate: 0.9,
    // the sources the collector browses a Page with (and, one read, the comments); the keyword search (FACEBOOK_TOPIC_POSTS) is its small supplement, used directly by the collector and
    // deliberately NOT listed here: the per-chunk spend estimate is the dearest listed source times a chunk's calls, and a search call is priced for the supplement's own job-level cost ceiling.
    discover: { channel: pagePosts },
    comments,
    maxVideos: REPORT_MAX_POSTS,
    topicReport: true,
  };
}
