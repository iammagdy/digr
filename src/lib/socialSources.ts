/**
 * Verified services for the social research tasks customers ask for most: comments of a post or
 * video, videos of a keyword, a channel or the trending feed, and the comments of those videos.
 *
 * Every endpoint id, parameter name and limit below was read from the provider catalog's public
 * endpoint pages and the order of the sources follows the catalog's measured success rate and speed
 * (not the lowest price): the first source is tried, and a failed or invalid answer falls through to
 * the next one. Nothing here names a provider to a customer; ids stay on the server.
 *
 * This module is pure data and pure functions (no network), so it can be tested exhaustively.
 */

import { extractUrls, socialSubjectText, type SocialIntent, type SocialPlatformId } from "./socialTasks";
import { detectCountryFromText, isoCountryCodeFromName } from "./planParameters";

export type SocialKind = "comments" | "videos" | "posts";
export type SocialMode = "url" | "query" | "channel" | "trending";
export type SocialPaging = "none" | "cursor" | "offset";

/** A video or post, as far as the provider's row tells. */
export interface SocialRef {
  id?: string;
  url?: string;
  title?: string;
}

export interface SocialSourceRequest {
  ref?: SocialRef;
  query?: string;
  channel?: string;
  region?: string;
  /** Rows wanted from this call. */
  limit: number;
  cursor?: string | null;
}

export interface SocialSource {
  endpointId: string;
  method: "GET" | "POST";
  /** Catalog price of one call, USD. */
  costUsd: number;
  /** Public catalog input names. Kept beside the builder so contract tests catch drift. */
  catalogParams: readonly string[];
  /** Catalog-required inputs, distinct from optional pagination/filter fields. */
  catalogRequiredParams: readonly string[];
  /** True only if this source cannot run without a customer-provided session/login. */
  requiresSession: boolean;
  /** Catalog session note: "optional" means the public path works without customer cookies. */
  sessionNote?: "none" | "optional";
  /** Most rows one call returns. */
  maxPerCall: number;
  paging: SocialPaging;
  /** Request parameters for this source, or null when this source cannot serve the request. */
  build(request: SocialSourceRequest): Record<string, any> | null;
  /** Cursor for the next page when the source pages by something other than the answer's own cursor. */
  nextCursor?(rowCount: number, request: SocialSourceRequest): string | null;
}

export interface SocialCapabilityDef {
  slug: string;
  platform: SocialPlatformId;
  kind: SocialKind;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  /** Request shapes this capability serves. */
  modes: SocialMode[];
  /** Cost basis of one delivered row, USD: the same rule that prices every other service. */
  rowCostUsd: number;
  /** The customer-facing rate per delivered row, when the owner set one apart from the cost basis. */
  customerPriceUsdPerItem?: number;
  /** Most rows one job may ask for (limited by what the sources can return). */
  maxRows: number;
  /** Measured success rate of the first source in the catalog. */
  successRate: number;
  discover: Partial<Record<Exclude<SocialMode, "url">, SocialSource[]>>;
  /** Sources that return the comments of one post or video (kind comments only). */
  comments?: SocialSource[];
}

const ID_RE = {
  tiktokVideo: /^\d{8,}$/,
  youtubeVideo: /^[\w-]{11}$/,
};

function toRegion(value: string | undefined): string | undefined {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

function handleOf(channel: string | undefined): string | undefined {
  const raw = String(channel || "").trim();
  if (!raw) return undefined;
  const fromUrl = /tiktok\.com\/@([\w.]{2,30})/i.exec(raw)?.[1];
  const handle = (fromUrl || raw.replace(/^@/, "")).trim();
  return /^[\w.]{2,30}$/.test(handle) ? handle : undefined;
}

function xHandleOf(channel: string | undefined): string | undefined {
  const raw = String(channel || "").trim();
  if (!raw) return undefined;
  const fromUrl = /(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(raw)?.[1];
  const handle = (fromUrl || raw.replace(/^@/, "")).trim();
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : undefined;
}

function youtubeChannelRef(channel: string | undefined): string | undefined {
  const raw = String(channel || "").trim();
  return raw || undefined;
}

function youtubeChannelId(channel: string | undefined): string | undefined {
  const raw = String(channel || "").trim();
  const fromUrl = /youtube\.com\/channel\/(UC[\w-]{20,})/i.exec(raw)?.[1];
  const id = fromUrl || (/^UC[\w-]{20,}$/.test(raw) ? raw : undefined);
  return id;
}

/** The numeric id of a TikTok video, from a plain id or a full video link. */
export function tiktokVideoIdOf(ref: SocialRef | undefined): string | undefined {
  if (ref?.id && ID_RE.tiktokVideo.test(ref.id)) return ref.id;
  const fromUrl = /\/video\/(\d{8,})/.exec(ref?.url || "")?.[1];
  return fromUrl;
}

/** The 11-character id of a YouTube video, from a plain id or any video link. */
export function youtubeVideoIdOf(ref: SocialRef | undefined): string | undefined {
  if (ref?.id && ID_RE.youtubeVideo.test(ref.id)) return ref.id;
  const url = ref?.url || "";
  return (
    /[?&]v=([\w-]{11})/.exec(url)?.[1] ||
    /youtu\.be\/([\w-]{11})/.exec(url)?.[1] ||
    /youtube\.com\/(?:shorts|embed)\/([\w-]{11})/.exec(url)?.[1]
  );
}

const TIKTOK_COMMENTS: SocialSource[] = [
  {
    endpointId: "tikhub.tiktok.video.comments",
    method: "GET",
    costUsd: 0.001,
    catalogParams: ["aweme_id", "cursor", "count", "current_region"],
    catalogRequiredParams: ["aweme_id"],
    requiresSession: false,
    maxPerCall: 20,
    paging: "cursor",
    build: (r) => {
      const id = tiktokVideoIdOf(r.ref);
      if (!id) return null;
      return { aweme_id: id, count: Math.min(20, Math.max(1, r.limit)), ...(r.cursor ? { cursor: Number(r.cursor) } : {}) };
    },
  },
  {
    endpointId: "crawl4ai.tiktok.video.comments",
    method: "POST",
    costUsd: 0.0005,
    catalogParams: ["post", "limit"],
    catalogRequiredParams: ["post"],
    requiresSession: false,
    maxPerCall: 100,
    paging: "none",
    build: (r) => {
      const post = r.ref?.url || r.ref?.id;
      return post ? { post, limit: Math.min(100, Math.max(1, r.limit)) } : null;
    },
  },
];

const YOUTUBE_COMMENTS: SocialSource[] = [
  {
    endpointId: "crawl4ai.youtube.video.comments",
    method: "POST",
    costUsd: 0.0009,
    catalogParams: ["video", "limit"],
    catalogRequiredParams: ["video"],
    requiresSession: false,
    maxPerCall: 500,
    paging: "none",
    build: (r) => {
      const video = youtubeVideoIdOf(r.ref) || r.ref?.url;
      return video ? { video, limit: Math.min(500, Math.max(1, r.limit)) } : null;
    },
  },
  {
    endpointId: "tikhub.youtube.video.comments",
    method: "GET",
    costUsd: 0.001,
    catalogParams: ["video_id", "language_code", "country_code", "sort_by", "continuation_token", "need_format"],
    catalogRequiredParams: ["video_id"],
    requiresSession: false,
    maxPerCall: 20,
    paging: "cursor",
    build: (r) => {
      const id = youtubeVideoIdOf(r.ref);
      return id ? { video_id: id, ...(r.cursor ? { continuation_token: r.cursor } : {}) } : null;
    },
  },
];

const FACEBOOK_COMMENTS: SocialSource[] = [
  {
    endpointId: "scrapecreators.x.v1-facebook-post-comments",
    method: "GET",
    costUsd: 0.00188,
    catalogParams: ["url", "feedback_id", "cursor"],
    catalogRequiredParams: [],
    requiresSession: false,
    maxPerCall: 10,
    paging: "cursor",
    build: (r) => (r.ref?.url ? { url: r.ref.url, ...(r.cursor ? { cursor: r.cursor } : {}) } : null),
  },
  {
    endpointId: "treg.facebook.post.comments",
    method: "POST",
    costUsd: 0.00188,
    catalogParams: ["post_id", "url"],
    catalogRequiredParams: [],
    requiresSession: false,
    maxPerCall: 10,
    paging: "none",
    build: (r) => (r.ref?.url ? { url: r.ref.url } : null),
  },
];

const TIKTOK_SEARCH: SocialSource[] = [
  {
    endpointId: "tikhub.tiktok.search.videos",
    method: "GET",
    costUsd: 0.001,
    catalogParams: ["keyword", "count", "offset", "sort_type", "publish_time", "region"],
    catalogRequiredParams: ["keyword"],
    requiresSession: false,
    maxPerCall: 20,
    paging: "offset",
    build: (r) => (r.query ? { keyword: r.query, count: Math.min(20, Math.max(1, r.limit)), offset: Number(r.cursor || 0) } : null),
    nextCursor: (rowCount, r) => (rowCount > 0 ? String(Number(r.cursor || 0) + rowCount) : null),
  },
  {
    endpointId: "anyapi.tiktok.search.videos",
    method: "POST",
    costUsd: 0.0012,
    catalogParams: ["query", "cursor", "datePosted", "sortBy"],
    catalogRequiredParams: ["query"],
    requiresSession: false,
    maxPerCall: 20,
    paging: "cursor",
    build: (r) => (r.query ? { query: r.query, ...(r.cursor ? { cursor: r.cursor } : {}) } : null),
  },
];

const TIKTOK_CHANNEL: SocialSource[] = [
  {
    endpointId: "anyapi.tiktok.user.videos",
    method: "POST",
    costUsd: 0.0012,
    catalogParams: ["handle", "cursor"],
    catalogRequiredParams: ["handle"],
    requiresSession: false,
    maxPerCall: 20,
    paging: "cursor",
    build: (r) => {
      const handle = handleOf(r.channel);
      return handle ? { handle, ...(r.cursor ? { cursor: r.cursor } : {}) } : null;
    },
  },
  {
    endpointId: "crawl4ai.tiktok.user.videos",
    method: "POST",
    costUsd: 0.0005,
    catalogParams: ["account", "limit"],
    catalogRequiredParams: ["account"],
    requiresSession: false,
    maxPerCall: 20,
    paging: "none",
    build: (r) => {
      const handle = handleOf(r.channel);
      return handle ? { account: `@${handle}`, limit: Math.min(20, Math.max(1, r.limit)) } : null;
    },
  },
];

// The trending feed is region-specific; a source that ignores the region would answer a different
// question, so there is deliberately no fallback to a region-less feed.
const TIKTOK_TRENDING: SocialSource[] = [
  {
    endpointId: "scrapecreators.x.v1-tiktok-get-trending-feed",
    method: "GET",
    costUsd: 0.00188,
    catalogParams: ["region", "trim"],
    catalogRequiredParams: ["region"],
    requiresSession: false,
    maxPerCall: 30,
    paging: "none",
    build: (r) => {
      const region = toRegion(r.region);
      return region ? { region } : null;
    },
  },
];

const YOUTUBE_SEARCH: SocialSource[] = [
  {
    endpointId: "crawl4ai.youtube.search.videos",
    method: "POST",
    costUsd: 0.0009,
    catalogParams: ["query", "limit"],
    catalogRequiredParams: ["query"],
    requiresSession: false,
    maxPerCall: 20,
    paging: "none",
    build: (r) => (r.query ? { query: r.query, limit: Math.min(20, Math.max(1, r.limit)) } : null),
  },
  {
    endpointId: "tikhub.youtube.search.videos",
    method: "GET",
    costUsd: 0.002,
    catalogParams: ["keyword", "continuation_token", "type", "upload_date", "duration", "features", "sort_by"],
    catalogRequiredParams: ["keyword"],
    requiresSession: false,
    maxPerCall: 20,
    paging: "none",
    build: (r) => (r.query ? { keyword: r.query } : null),
  },
];

const YOUTUBE_CHANNEL: SocialSource[] = [
  {
    endpointId: "crawl4ai.youtube.channel.videos",
    method: "POST",
    costUsd: 0.0009,
    catalogParams: ["channel", "limit"],
    catalogRequiredParams: ["channel"],
    requiresSession: false,
    maxPerCall: 30,
    paging: "none",
    build: (r) => {
      const channel = youtubeChannelRef(r.channel);
      return channel ? { channel, limit: Math.min(30, Math.max(1, r.limit)) } : null;
    },
  },
  {
    endpointId: "tikhub.youtube.channel.videos",
    method: "GET",
    costUsd: 0.001,
    catalogParams: ["channel_id", "language_code", "country_code", "continuation_token", "need_format"],
    catalogRequiredParams: ["channel_id"],
    requiresSession: false,
    maxPerCall: 30,
    paging: "none",
    build: (r) => {
      const id = youtubeChannelId(r.channel);
      return id ? { channel_id: id } : null;
    },
  },
];

const YOUTUBE_TRENDING: SocialSource[] = [
  {
    endpointId: "scrapecreators.x.v1-youtube-shorts-trending",
    method: "GET",
    costUsd: 0.00188,
    catalogParams: [],
    catalogRequiredParams: [],
    requiresSession: false,
    maxPerCall: 48,
    paging: "none",
    build: () => ({}),
  },
  {
    endpointId: "anyapi.youtube.trending_shorts",
    method: "POST",
    costUsd: 0.0012,
    catalogParams: [],
    catalogRequiredParams: [],
    requiresSession: false,
    maxPerCall: 48,
    paging: "none",
    build: () => ({}),
  },
];

const FACEBOOK_PAGE_POSTS: SocialSource[] = [
  {
    endpointId: "anyapi.facebook.user.posts",
    method: "POST",
    costUsd: 0.002,
    catalogParams: ["cursor", "pageId", "url"],
    catalogRequiredParams: [],
    requiresSession: false,
    maxPerCall: 10,
    paging: "cursor",
    build: (r) => (r.channel ? { url: /^https?:\/\//i.test(r.channel) ? r.channel : `https://www.facebook.com/${r.channel.replace(/^@/, "")}`, ...(r.cursor ? { cursor: r.cursor } : {}) } : null),
  },
  {
    endpointId: "scrapecreators.x.v1-facebook-profile-posts",
    method: "GET",
    costUsd: 0.00188,
    catalogParams: ["url", "pageId", "cursor"],
    catalogRequiredParams: [],
    requiresSession: false,
    maxPerCall: 3,
    paging: "cursor",
    build: (r) => (r.channel ? { url: /^https?:\/\//i.test(r.channel) ? r.channel : `https://www.facebook.com/${r.channel.replace(/^@/, "")}`, ...(r.cursor ? { cursor: r.cursor } : {}) } : null),
  },
  {
    endpointId: "crawl4ai.facebook.user.posts",
    method: "POST",
    costUsd: 0.00135,
    catalogParams: ["page", "limit"],
    catalogRequiredParams: ["page"],
    requiresSession: false,
    sessionNote: "optional",
    maxPerCall: 20,
    paging: "none",
    build: (r) => (r.channel ? { page: r.channel.replace(/^@/, ""), limit: Math.min(20, Math.max(1, r.limit)) } : null),
  },
];

// Public X search works without a customer session through the search endpoints below. Crawl4AI's
// x.search.posts endpoint is intentionally excluded: its catalog only permits from:<account>
// without a session, which made topic searches fail with HTTP 400.
const X_TOPIC_POSTS: SocialSource[] = [
  {
    endpointId: "anyapi.x.search.posts",
    method: "POST",
    costUsd: 0.00075,
    catalogParams: ["query", "limit", "cursor", "queryType"],
    catalogRequiredParams: ["query"],
    requiresSession: false,
    maxPerCall: 50,
    paging: "cursor",
    build: (r) => r.query ? { query: r.query, limit: Math.min(50, Math.max(1, r.limit)), queryType: "Latest", ...(r.cursor ? { cursor: r.cursor } : {}) } : null,
  },
  {
    endpointId: "tikhub.x.twitter-web-fetch-search-timeline",
    method: "GET",
    costUsd: 0.001,
    catalogParams: ["keyword", "search_type", "cursor"],
    catalogRequiredParams: ["keyword"],
    requiresSession: false,
    maxPerCall: 20,
    paging: "cursor",
    build: (r) => r.query ? { keyword: r.query, search_type: "Latest", ...(r.cursor ? { cursor: r.cursor } : {}) } : null,
  },
];

const X_ACCOUNT_POSTS: SocialSource[] = [
  {
    endpointId: "anyapi.x.user.posts",
    method: "POST",
    costUsd: 0.0005,
    catalogParams: ["handle", "limit", "cursor"],
    catalogRequiredParams: ["handle"],
    requiresSession: false,
    maxPerCall: 100,
    paging: "cursor",
    build: (r) => {
      const handle = xHandleOf(r.channel);
      return handle ? { handle, limit: Math.min(100, Math.max(1, r.limit)), ...(r.cursor ? { cursor: r.cursor } : {}) } : null;
    },
  },
  {
    endpointId: "crawl4ai.x.user.posts",
    method: "POST",
    costUsd: 0.00045,
    catalogParams: ["username", "limit"],
    catalogRequiredParams: ["username"],
    requiresSession: false,
    sessionNote: "optional",
    maxPerCall: 100,
    paging: "none",
    // Catalog says login cookies are optional; without them this reads as a visitor and may fall back.
    build: (r) => {
      const handle = xHandleOf(r.channel);
      return handle ? { username: handle, limit: Math.min(100, Math.max(1, r.limit)) } : null;
    },
  },
];

const RANKED = {
  tiktok: { search: TIKTOK_SEARCH, channel: TIKTOK_CHANNEL, trending: TIKTOK_TRENDING },
  youtube: { search: YOUTUBE_SEARCH, channel: YOUTUBE_CHANNEL, trending: YOUTUBE_TRENDING },
};

export const SOCIAL_CAPABILITIES: SocialCapabilityDef[] = [
  {
    slug: "social-x-posts",
    platform: "x",
    kind: "posts",
    nameAr: "منشورات منصة إكس",
    nameEn: "X Posts",
    descriptionAr: "البحث عن منشورات إكس بموضوع أو كلمة، أو جمع أحدث منشورات حساب محدد.",
    modes: ["query", "channel"],
    rowCostUsd: 0.00075,
    maxRows: 500,
    successRate: 0.9999,
    discover: { query: X_TOPIC_POSTS, channel: X_ACCOUNT_POSTS },
  },
  {
    slug: "social-tiktok-comments",
    platform: "tiktok",
    kind: "comments",
    nameAr: "استخراج تعليقات فيديوهات تيك توك",
    nameEn: "TikTok Video Comments",
    descriptionAr: "سحب التعليقات العامة لفيديو بعينه برابطه، أو لفيديوهات يحددها النظام من بحث بكلمة أو قناة أو الفيديوهات الرائجة، مع بيانات كل تعليق ورابط الفيديو.",
    modes: ["url", "query", "channel", "trending"],
    rowCostUsd: 0.001,
    maxRows: 1000,
    successRate: 0.9997,
    discover: { query: RANKED.tiktok.search, channel: RANKED.tiktok.channel, trending: RANKED.tiktok.trending },
    comments: TIKTOK_COMMENTS,
  },
  {
    slug: "social-youtube-comments",
    platform: "youtube",
    kind: "comments",
    nameAr: "استخراج تعليقات مقاطع يوتيوب",
    nameEn: "YouTube Video Comments",
    descriptionAr: "سحب التعليقات العامة لمقطع بعينه برابطه، أو لمقاطع يحددها النظام من بحث بكلمة أو قناة أو الشورتس الرائجة، مع بيانات كل تعليق ورابط المقطع.",
    modes: ["url", "query", "channel", "trending"],
    rowCostUsd: 0.0009,
    customerPriceUsdPerItem: 0.0015,
    maxRows: 1000,
    successRate: 0.999,
    discover: { query: RANKED.youtube.search, channel: RANKED.youtube.channel, trending: RANKED.youtube.trending },
    comments: YOUTUBE_COMMENTS,
  },
  {
    slug: "social-facebook-comments",
    platform: "facebook",
    kind: "comments",
    nameAr: "استخراج تعليقات منشورات فيسبوك العامة",
    nameEn: "Facebook Post Comments",
    descriptionAr: "سحب التعليقات العامة لمنشور بعينه برابطه، أو لمنشورات صفحة عامة، مع بيانات كل تعليق ورابط المنشور.",
    modes: ["url", "channel"],
    rowCostUsd: 0.00188,
    customerPriceUsdPerItem: 0.0019,
    maxRows: 500,
    successRate: 0.99,
    discover: { channel: FACEBOOK_PAGE_POSTS },
    comments: FACEBOOK_COMMENTS,
  },
  {
    slug: "social-tiktok-videos",
    platform: "tiktok",
    kind: "videos",
    nameAr: "استخراج فيديوهات تيك توك",
    nameEn: "TikTok Videos",
    descriptionAr: "سحب فيديوهات تيك توك بكلمة بحث، أو فيديوهات قناة بعينها، أو الفيديوهات الرائجة في دولة، مع المشاهدات والإعجابات والتعليقات.",
    modes: ["query", "channel", "trending"],
    rowCostUsd: 0.001,
    maxRows: 200,
    successRate: 0.9999,
    discover: { query: RANKED.tiktok.search, channel: RANKED.tiktok.channel, trending: RANKED.tiktok.trending },
  },
  {
    slug: "social-youtube-videos",
    platform: "youtube",
    kind: "videos",
    nameAr: "استخراج مقاطع يوتيوب",
    nameEn: "YouTube Videos",
    descriptionAr: "سحب مقاطع يوتيوب بكلمة بحث، أو مقاطع قناة بعينها، أو الشورتس الرائجة، مع المشاهدات وتاريخ النشر.",
    modes: ["query", "channel", "trending"],
    rowCostUsd: 0.0009,
    maxRows: 48,
    successRate: 0.999,
    discover: { query: RANKED.youtube.search, channel: RANKED.youtube.channel, trending: RANKED.youtube.trending },
  },
  {
    slug: "social-facebook-posts",
    platform: "facebook",
    kind: "videos",
    nameAr: "استخراج منشورات صفحة فيسبوك عامة",
    nameEn: "Facebook Page Posts",
    descriptionAr: "سحب أحدث منشورات صفحة فيسبوك عامة برابطها أو اسمها، مع التفاعلات وعدد التعليقات.",
    modes: ["channel"],
    rowCostUsd: 0.002,
    maxRows: 60,
    successRate: 0.995,
    discover: { channel: FACEBOOK_PAGE_POSTS },
  },
];

export function getSocialCapability(slug: string | undefined | null): SocialCapabilityDef | undefined {
  return SOCIAL_CAPABILITIES.find((cap) => cap.slug === slug);
}

export function isSocialCapabilitySlug(slug: string | undefined | null): boolean {
  return Boolean(getSocialCapability(slug));
}

export function socialCapabilityFor(platform: SocialPlatformId | null | undefined, kind: SocialKind): SocialCapabilityDef | undefined {
  return SOCIAL_CAPABILITIES.find((cap) => cap.platform === platform && cap.kind === kind);
}

/** The one mode a plan item's parameters ask for. A link wins over a keyword, a keyword over a channel. */
export function resolveSocialMode(params: Record<string, any> | undefined): SocialMode | null {
  const p = params || {};
  if (typeof p.url === "string" && p.url.trim()) return "url";
  if (typeof p.query === "string" && p.query.trim()) return "query";
  if (typeof p.channel === "string" && p.channel.trim()) return "channel";
  if (p.trending === true || p.trending === "true") return "trending";
  return null;
}

/** True when the capability's trending feed is specific to a country (so the country is a required input). */
export function trendingNeedsRegion(cap: SocialCapabilityDef): boolean {
  const first = cap.discover.trending?.[0];
  return Boolean(first) && first!.build({ limit: 1 }) === null;
}

/** Arabic reason when the parameters do not name something to collect; null when they do. */
export function validateSocialParams(slug: string, params: Record<string, any> | undefined): string | null {
  const cap = getSocialCapability(slug);
  if (!cap) return null;
  const mode = resolveSocialMode(params);
  if (!mode) return "حدّد رابط الفيديو أو المنشور، أو كلمة بحث، أو قناة، أو اطلب الفيديوهات الرائجة.";
  if (!cap.modes.includes(mode)) return "هذا النوع من الطلبات غير متاح على هذه المنصة.";
  if (mode === "trending" && trendingNeedsRegion(cap) && !toRegion(params?.region)) return "حدّد الدولة التي تريد الفيديوهات الرائجة فيها.";
  return null;
}

/** Sources that answer the request's discovery stage, in the order they are tried. */
export function discoverSourcesFor(cap: SocialCapabilityDef, mode: Exclude<SocialMode, "url">): SocialSource[] {
  return cap.discover[mode] || [];
}

function firstValue(row: Record<string, any>, keys: RegExp): string | undefined {
  for (const [key, value] of Object.entries(row || {})) {
    if (!keys.test(key)) continue;
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return undefined;
}

/** The video or post a discovered row stands for, read from whichever fields the provider used. */
export function extractSocialRef(platform: SocialPlatformId, row: Record<string, any>): SocialRef | null {
  const title = firstValue(row, /^(?:title|desc|description|text|caption|video_desc|message|name)$/i);
  const urlCandidate = firstValue(row, /(?:^|_)(?:share_?url|web_?video_?url|video_?url|permalink(?:_url)?|post_?url|url|link)$/i);
  const url = urlCandidate && /^https?:\/\//i.test(urlCandidate) ? urlCandidate : undefined;

  if (platform === "tiktok") {
    const idKey = firstValue(row, /(?:^|_)(?:aweme_?id|video_?id|item_?id)$/i) || (/^\d{8,}$/.test(String(row.id ?? "")) ? String(row.id) : undefined);
    const id = idKey && ID_RE.tiktokVideo.test(idKey) ? idKey : tiktokVideoIdOf({ url });
    if (!id && !url) return null;
    return { ...(id ? { id } : {}), ...(url ? { url } : {}), ...(title ? { title } : {}) };
  }

  if (platform === "youtube") {
    const idKey = firstValue(row, /(?:^|_)video_?id$/i) || (ID_RE.youtubeVideo.test(String(row.id ?? "")) ? String(row.id) : undefined);
    const id = idKey && ID_RE.youtubeVideo.test(idKey) ? idKey : youtubeVideoIdOf({ url });
    if (!id && !url) return null;
    return { ...(id ? { id } : {}), ...(url ? { url } : id ? { url: `https://www.youtube.com/watch?v=${id}` } : {}), ...(title ? { title } : {}) };
  }

  // Facebook: a post is addressed by its link.
  if (!url) return null;
  return { url, ...(title ? { title } : {}) };
}

/** A reference built from a link the customer gave. */
export function refFromUrl(platform: SocialPlatformId, link: string): SocialRef | null {
  const found = extractUrls(link).find((u) => u.platform === platform) || extractUrls(link)[0];
  if (!found) return null;
  return { url: found.url, ...(found.id ? { id: found.id } : {}) };
}

/** Most calls one chunk may make: one discovery plus a few comment pages. Used for the spend estimate. */
export const SOCIAL_MAX_CALLS_PER_CHUNK = 6;

/** Rows one worker chunk collects. */
export const SOCIAL_ROWS_PER_CHUNK = 50;

/** Comments taken from each discovered video unless the customer says otherwise. */
export const SOCIAL_COMMENTS_PER_VIDEO = 50;

/** Upper bound of the provider spend one chunk can cause, in USD (worst call price times calls). */
export function estimateSocialChunkCostUsd(cap: SocialCapabilityDef): number {
  const prices: number[] = [];
  for (const sources of Object.values(cap.discover)) for (const s of sources || []) prices.push(s.costUsd);
  for (const s of cap.comments || []) prices.push(s.costUsd);
  const worst = prices.length ? Math.max(...prices) : cap.rowCostUsd;
  return Number((worst * SOCIAL_MAX_CALLS_PER_CHUNK).toFixed(6));
}

const KIND_TITLE_AR: Record<string, string> = { comments: "تعليقات", videos: "فيديوهات", posts: "منشورات" };
const PLATFORM_TITLE_AR: Record<string, string> = { tiktok: "تيك توك", youtube: "يوتيوب", facebook: "فيسبوك", x: "منصة إكس" };

/** Arabic title of a finished social job, e.g. "تعليقات تيك توك" (never a service name). */
export function socialResultTitleAr(cap: SocialCapabilityDef): string {
  const kind = cap.platform === "facebook" && cap.kind === "videos" ? "منشورات" : KIND_TITLE_AR[cap.kind];
  return `${kind} ${PLATFORM_TITLE_AR[cap.platform] || ""}`.trim();
}

/** The verified capability that serves what the customer asked for, or undefined when none does. */
export function socialCapabilityForIntent(intent: SocialIntent): SocialCapabilityDef | undefined {
  if (!intent.task || !intent.platform) return undefined;
  const kind: SocialKind = intent.task === "comments" ? "comments" : intent.task === "x_posts" ? "posts" : "videos";
  const cap = socialCapabilityFor(intent.platform, kind);
  if (!cap) return undefined;
  const mode: SocialMode | null =
    intent.discover === "target" ? "url" : intent.discover === "keyword" ? "query" : intent.discover === "channel" ? "channel" : intent.discover === "trending" ? "trending" : null;
  return mode && cap.modes.includes(mode) ? cap : undefined;
}

export interface SocialParamHints {
  /** Only dates the customer asked for; a period the model made up must never filter the results. */
  dateFrom?: string;
  dateTo?: string;
  /** Comments wanted from each video, and how many videos, when the customer said so. */
  perVideo?: number;
  videoCount?: number;
}

/**
 * The provider-bound parameters of a social plan item, rebuilt from what the customer said. The
 * model supplies the count; the link, channel, keyword and country come from the request text, so
 * a garbled or omitted parameter can never change what is collected.
 */
export function canonicalSocialParams(
  cap: SocialCapabilityDef,
  intent: SocialIntent,
  requestText: string,
  modelParams: Record<string, any> | undefined,
  hints: SocialParamHints = {},
): Record<string, any> {
  const params: Record<string, any> = {};
  const model = modelParams || {};
  const country = detectCountryFromText(requestText);
  const region = country ? isoCountryCodeFromName(country.canonicalEnglish) : undefined;
  // Keep the customer's explicit country available to both region-aware routes and plan display.
  if (region) params.region = region;
  if (intent.discover === "target" && intent.targetUrl) params.url = intent.targetUrl.url;
  else if (intent.discover === "channel" && intent.channelRef) params.channel = intent.channelRef;
  else if (intent.discover === "trending") {
    params.trending = true;
  } else if (intent.discover === "keyword") {
    // The subject the customer named wins; a model-written query is only the fallback.
    const subject = socialSubjectText(requestText);
    const query = subject || (typeof model.query === "string" ? model.query.trim() : "");
    if (query) params.query = query;
  }
  if (hints.dateFrom) params.dateFrom = hints.dateFrom;
  if (hints.dateTo) params.dateTo = hints.dateTo;
  if (cap.kind === "comments" && intent.discover !== "target") {
    if (hints.perVideo && hints.perVideo > 0) params.perVideo = Math.min(MAX_PER_VIDEO, Math.floor(hints.perVideo));
    if (hints.videoCount && hints.videoCount > 0) params.videoCount = Math.min(MAX_VIDEOS_PER_JOB, Math.floor(hints.videoCount));
  }
  return params;
}

/** Most comments taken from one video, and most videos one job reads. */
export const MAX_PER_VIDEO = 500;
export const MAX_VIDEOS_PER_JOB = 20;

/** The one-line Arabic goal shown on the plan card, written by the server so it always matches what will run. */
export function socialPlanSummaryAr(
  cap: SocialCapabilityDef,
  params: Record<string, any>,
  volume: number,
  formatNumber: (n: number) => string,
  requestText?: string,
): string {
  const platform = PLATFORM_TITLE_AR[cap.platform] || "";
  const mode = resolveSocialMode(params);
  const what = cap.kind === "comments" ? "التعليقات" : cap.kind === "posts" || cap.platform === "facebook" ? "المنشورات" : "الفيديوهات";
  const perVideo = Number(params.perVideo) > 0 ? Number(params.perVideo) : SOCIAL_COMMENTS_PER_VIDEO;
  const commentLimit = cap.kind === "comments" && mode !== "url"
    ? `، بحد أقصى ${formatNumber(Math.min(perVideo, Math.max(1, volume)))} تعليقاً من كل فيديو، و${formatNumber(volume)} تعليقاً إجمالاً`
    : "";
  const query = mode === "query" && requestText ? socialSubjectText(requestText) : String(params.query || "").trim();
  switch (mode) {
    case "url":
      return `سحب ${what} للرابط المحدد على ${platform}`;
    case "query":
      return cap.kind === "comments"
        ? `سحب ${what} من فيديوهات ${platform} عن «${query}»${commentLimit}`
        : `سحب ${what} على ${platform} عن «${query}»`;
    case "channel":
      return cap.kind === "comments"
        ? `سحب ${what} من أحدث ما نشرته القناة أو الصفحة المحددة على ${platform}${commentLimit}`
        : cap.kind === "posts"
          ? `سحب أحدث ${what} للحساب المحدد على ${platform}`
          : `سحب أحدث ${what} للقناة أو الصفحة المحددة على ${platform}`;
    case "trending":
      return cap.kind === "comments"
        ? `سحب ${what} من الفيديوهات الرائجة على ${platform}${commentLimit}`
        : `سحب الفيديوهات الرائجة على ${platform}`;
    default:
      return `سحب ${what} من ${platform}`;
  }
}
