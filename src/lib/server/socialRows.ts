/**
 * Turns provider-native comment and video rows into one fixed, Arabic-labelled schema.
 *
 * Providers name the same fact differently (likes, digg_count, like_count...) and send dates as unix
 * seconds, relative English phrases or ISO strings. The customer gets one set of columns whatever
 * source answered, with a readable date, and no raw provider column names.
 */

export type SocialRowKind = "comments" | "videos" | "posts";

/** Resolve a stored task to its fixed social export schema when older JSON omitted socialKind. */
export function inferSocialRowKind(...identifiers: Array<string | null | undefined>): SocialRowKind | null {
  const value = identifiers.filter(Boolean).join(" ").toLowerCase();
  if (/comment|comments|تعليق/u.test(value)) return "comments";
  if (/tiktok|youtube|facebook|instagram/.test(value) && /video|channel|trending|trend/u.test(value)) return "videos";
  if (/twitter|\bx\b|tweet|post/u.test(value)) return "posts";
  return null;
}

/** Lower-cased key without separators, so `Digg_Count`, `diggCount` and `digg count` are the same key. */
function squash(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, "");
}

function pick(row: Record<string, any>, aliases: string[]): unknown {
  const byKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row || {})) byKey.set(squash(key), value);
  const present = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "";
  for (const alias of aliases) {
    const value = byKey.get(squash(alias));
    if (present(value)) return value;
  }
  // A nested provider object arrives flattened as parent_child; accept a suffix match last.
  for (const alias of aliases) {
    const suffix = squash(alias);
    for (const [key, value] of byKey) {
      if (key.length > suffix.length && key.endsWith(suffix) && present(value)) return value;
    }
  }
  return undefined;
}

/** "1.2K" → 1200, "3,400" → 3400, 17 → 17. Anything that is not a count stays out. */
export function parseCount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[,\s]/g, "").replace(/(?:views?|likes?|مشاهدة|إعجاب)/gi, "");
  const m = /^(\d+(?:\.\d+)?)([kKmMbB]?)$/.exec(text);
  if (!m) return undefined;
  const factor = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as "" | "k" | "m" | "b"];
  return Math.round(Number(m[1]) * factor);
}

/** An ISO date (YYYY-MM-DD) from unix seconds or milliseconds, an ISO string, or nothing when it cannot be told. */
export function toIsoDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" || /^\d{9,13}$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const ms = n < 1e11 ? n * 1000 : n;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Relative English phrases ("3 years ago") are not dates and are not shown.
  return undefined;
}

const text = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s ? s : undefined;
};

const link = (value: unknown): string | undefined => {
  const s = text(value);
  return s && /^https?:\/\//i.test(s) ? s : undefined;
};

const handle = (value: unknown): string | undefined => {
  const s = text(value);
  if (!s) return undefined;
  const h = s.replace(/^@/, "");
  return /^[\w.\-؀-ۿ]{2,60}$/u.test(h) ? `@${h}` : undefined;
};

function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

/** Drops the facts the source did not give. Text is formula-escaped by the dataset pipeline that consumes it. */
function clean<T extends Record<string, any>>(row: T): T {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/** Account verification flags as providers name them; the column appears only when the source returned one. */
const VERIFIED_KEYS = ["author_verified", "is_verified", "verified", "is_blue_verified", "user_verified"];

export function normalizeSocialComment(raw: Record<string, any>): Record<string, any> {
  return clean({
    source_id: text(pick(raw, ["comment_id", "cid", "commentId", "id"])),
    comment_text: text(pick(raw, ["text", "comment", "comment_text", "content", "message", "commentText"])),
    author_name: text(pick(raw, ["author", "author_name", "nickname", "user_nickname", "user_name", "display_name", "name"])),
    username: handle(pick(raw, ["user_unique_id", "unique_id", "author_handle", "author_username", "username", "handle", "screen_name"])),
    author_verified: bool(pick(raw, VERIFIED_KEYS)),
    likes_count: parseCount(pick(raw, ["likes", "like_count", "digg_count", "likeCount", "reaction_count"])),
    replies_count: parseCount(pick(raw, ["replies", "reply_count", "reply_comment_total", "replyCount"])),
    published_at: toIsoDate(pick(raw, ["published_date", "published_at", "create_time", "createTime", "created_at", "date", "timestamp", "time"])),
    url: link(pick(raw, ["url", "comment_url", "permalink"])),
    pinned: bool(pick(raw, ["pinned", "is_pinned"])),
    hearted_by_creator: bool(pick(raw, ["hearted_by_creator", "creator_liked"])),
    video_title: text(raw.video_title),
    video_url: link(raw.video_url),
  });
}

export function normalizeSocialVideo(raw: Record<string, any>): Record<string, any> {
  const hashtags = pick(raw, ["hashtags", "tags", "text_extra"]);
  return clean({
    source_id: text(pick(raw, ["video_id", "aweme_id", "videoId", "id"])),
    video_caption: text(pick(raw, ["title", "desc", "description", "caption", "text", "video_desc", "message"])),
    channel_name: text(pick(raw, ["channel", "channel_title", "author_nickname", "author_name", "author", "uploader", "page_name", "nickname"])),
    username: handle(pick(raw, ["author_unique_id", "author_handle", "unique_id", "username", "handle"])),
    author_verified: bool(pick(raw, VERIFIED_KEYS)),
    published_at: toIsoDate(pick(raw, ["published_date", "published_at", "create_time", "createTime", "publishedAt", "created_at", "date", "timestamp"])),
    views_count: parseCount(pick(raw, ["views", "view_count", "play_count", "playCount", "plays"])),
    likes_count: parseCount(pick(raw, ["likes", "like_count", "digg_count", "reactions", "reaction_count"])),
    comments_count: parseCount(pick(raw, ["comments", "comment_count", "commentCount", "comments_count"])),
    shares_count: parseCount(pick(raw, ["shares", "share_count", "shareCount"])),
    saves_count: parseCount(pick(raw, ["saves", "collect_count", "collectCount", "save_count"])),
    video_duration: text(pick(raw, ["duration", "length", "video_duration"])),
    hashtags: Array.isArray(hashtags) ? hashtags.map(String).join("، ") : text(hashtags),
    url: link(pick(raw, ["url", "link", "share_url", "video_url", "permalink", "post_url"])),
  });
}

/** Fixed public-post schema for X and other post-search sources; provider-native keys stay internal. */
export function normalizeSocialPost(raw: Record<string, any>): Record<string, any> {
  return clean({
    source_id: text(pick(raw, ["tweet_id", "post_id", "postId", "id_str", "source_id", "id"])),
    text: text(pick(raw, ["text", "full_text", "fullText", "content", "post_text", "tweet_text", "caption", "description"])),
    author_name: text(pick(raw, ["author_name", "authorName", "author", "nickname", "display_name", "name"])),
    username: handle(pick(raw, ["author_username", "authorUsername", "username", "screen_name", "handle"])),
    author_verified: bool(pick(raw, VERIFIED_KEYS)),
    published_at: toIsoDate(pick(raw, ["published_at", "publishedAt", "created_at", "createdAt", "createdUtc", "created_utc", "date", "timestamp"])),
    likes_count: parseCount(pick(raw, ["likes", "like_count", "likeCount", "likesCount"])),
    retweets_count: parseCount(pick(raw, ["retweets", "retweet_count", "retweetCount", "shares", "shares_count"])),
    replies_count: parseCount(pick(raw, ["replies", "reply_count", "replyCount", "replies_count"])),
    quotes_count: parseCount(pick(raw, ["quotes", "quote_count", "quoteCount", "quotes_count"])),
    views_count: parseCount(pick(raw, ["views", "view_count", "viewCount", "views_count"])),
    followers_count: parseCount(pick(raw, ["authorFollowers", "followers", "followers_count", "follower_count"])),
    is_reply: bool(pick(raw, ["is_reply", "isReply"])),
    language: text(pick(raw, ["lang", "language"])),
    url: link(pick(raw, ["url", "permalink", "tweet_url", "post_url", "link"])),
  });
}

export function normalizeSocialRow(kind: SocialRowKind, raw: Record<string, any>): Record<string, any> {
  if (kind === "comments") return normalizeSocialComment(raw);
  if (kind === "posts") return normalizeSocialPost(raw);
  return normalizeSocialVideo(raw);
}

/** Column order shown to the customer (only the columns that carry a value are kept). */
export const SOCIAL_COLUMN_ORDER: Record<SocialRowKind, string[]> = {
  comments: ["id", "comment_text", "author_name", "username", "author_verified", "published_at", "likes_count", "replies_count", "url", "video_title", "video_url", "pinned", "hearted_by_creator", "source_id"],
  videos: ["id", "video_caption", "channel_name", "username", "author_verified", "published_at", "views_count", "likes_count", "comments_count", "shares_count", "saves_count", "video_duration", "hashtags", "url", "source_id"],
  posts: ["id", "text", "author_name", "username", "author_verified", "published_at", "likes_count", "retweets_count", "replies_count", "quotes_count", "views_count", "followers_count", "language", "is_reply", "url", "source_id"],
};
