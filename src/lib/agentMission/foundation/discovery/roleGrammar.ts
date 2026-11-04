import type { CardRole } from "../toolCards/types";

/**
 * ROUND 33, CATALOG DISCOVERY: THE ROLE GRAMMAR. The catalog classifies every endpoint with a `capability` («youtube.search.videos», «instagram.hashtag.posts», «instagram.user.posts»…); this table says which capabilities can read the PARENTS of a request (the videos, posts or tweets a
 * request collects) and in which role the compiler may use them. It is DATA about the catalog's own vocabulary, not a per-platform case: a capability the table does not list has no role and is never used, and a platform with no row in it gains nothing.
 * Comments and replies are NOT derived: their cards carry the parent-to-child identity contracts (a reply token, a grand-parent field, the comment's own id) that the catalog's metadata cannot express, so they stay hand-verified cards (`toolCards/*`).
 */
export interface RoleRule {
  /** The catalog's capability (exact). */
  capability: string;
  role: Extract<CardRole, "videos.search" | "tweets.search" | "posts.search" | "videos.channel" | "posts.account" | "posts.page">;
  /** Which kind of input takes the thing the request names: a keyword (search) or the source (a listing of one channel, account or page). */
  takes: "keyword" | "source";
  /** For a listing: what the source input is. */
  source?: "handle" | "channel_id" | "page_url";
}

/**
 * The capabilities whose tools may read the parents of a request. ROUND 34: ALL FIVE PLATFORMS ARE IN THE GRAMMAR. TikTok, X and Facebook already have hand-verified keyword searches; their capabilities are listed here so that those verified cards and every OTHER eligible tool of the same capability
 * are evaluated together as candidates (an endpoint that already has a hand card is refused as `has_hand_card`: the verified card stands in its place, it is not derived twice). A verified card still outranks a derived one on a tie; a derived one competes only where the catalog proves it carries more.
 */
export const ROLE_RULES: ReadonlyArray<RoleRule> = [
  { capability: "tiktok.search.videos", role: "videos.search", takes: "keyword" },
  { capability: "x.search.posts", role: "tweets.search", takes: "keyword" },
  { capability: "facebook.search.posts", role: "posts.search", takes: "keyword" },
  { capability: "youtube.search.videos", role: "videos.search", takes: "keyword" },
  { capability: "instagram.search.reels", role: "posts.search", takes: "keyword" },
  { capability: "instagram.hashtag.posts", role: "posts.search", takes: "keyword" },
  { capability: "youtube.channel.videos", role: "videos.channel", takes: "source", source: "channel_id" },
  { capability: "instagram.user.posts", role: "posts.account", takes: "source", source: "handle" },
  { capability: "instagram.user.reels", role: "posts.account", takes: "source", source: "handle" },
];

export const ruleOfCapability = (capability: string | null | undefined): RoleRule | null => ROLE_RULES.find((r) => r.capability === capability) ?? null;

/** The names an input may have, by what it takes (the catalog's own spelling, in order of preference). */
export const QUERY_INPUT_NAMES = ["keyword", "query", "q", "search_query", "search", "term", "text", "hashtag", "tag"] as const;
export const HASHTAG_INPUT_NAMES: ReadonlyArray<string> = ["hashtag", "tag"];
export const SOURCE_INPUT_NAMES: Readonly<Record<NonNullable<RoleRule["source"]>, ReadonlyArray<string>>> = {
  handle: ["handle", "username", "user_name", "unique_id", "user"],
  channel_id: ["channel_id", "channelId"],
  page_url: ["url", "page_url", "profile_url", "page"],
};
export const CURSOR_INPUT_NAMES: ReadonlyArray<string> = ["cursor", "continuation_token", "pagination_token", "next_cursor", "page_token", "next_page_token", "max_id"];
/** A pair of inputs that take the period as two calendar days or instants (an input that takes a RELATIVE window such as «last_week» is not a period). */
export const PERIOD_INPUT_PAIRS: ReadonlyArray<readonly [string, string]> = [["start_date", "end_date"], ["startDate", "endDate"], ["date_from", "date_to"], ["since", "until"], ["from_date", "to_date"], ["published_after", "published_before"]];
export const COUNTRY_INPUT_NAMES: ReadonlyArray<string> = ["country", "country_code", "region", "region_code"];

/** The row keys the compiler reads, and the keys of an item the catalog may call each (first match wins; top-level keys only: a nested path cannot be told from the catalog's flat field list). */
export const FIELD_SYNONYMS: Readonly<Record<string, ReadonlyArray<string>>> = {
  id: ["id", "video_id", "videoId", "pk", "post_id", "postId", "aweme_id", "tweet_id", "media_id", "rest_id"],
  text: ["text", "full_text", "caption", "title", "desc", "description", "content", "message"],
  author: ["author", "author_name", "username", "user_name", "screen_name", "channel_title", "owner_username"],
  posted_at: ["createdUtc", "created_at", "createTime", "create_time", "taken_at", "timestamp", "published_at", "publishedAt", "date"],
  published: ["published_time", "publishedTimeText", "published_text"],
  link: ["url", "link", "permalink", "share_url", "webpage_url"],
  likes: ["likes", "like_count", "likeCount", "digg_count", "favorite_count"],
  comments: ["comments", "comment_count", "commentCount", "comments_count", "reply_count"],
  shares: ["shares", "share_count", "retweet_count", "repost_count"],
  views: ["views", "view_count", "play_count", "video_view_count", "video_play_count", "number_of_views"],
  channel_id: ["channel_id", "channelId"],
};
/** The keys a counter may hold the item's number of children in (a counter is used only when the catalog says the field is a number). */
export const COUNTER_KEYS: ReadonlyArray<string> = ["comments"];
