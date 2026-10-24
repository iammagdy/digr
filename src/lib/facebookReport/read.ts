import { parseCount } from "../server/socialRows";
import { rowDateMs } from "../server/dateRangeFilter";
import { COMMENT_TEXT_KEEP_CHARS, POST_TEXT_KEEP_CHARS } from "./constants";
import { publisherOf } from "./registry";
import type { ReportComment, ReportPost } from "./types";

/**
 * Readers for the rows the sources return. The shape of a Facebook post or comment answer was NOT read from a live call by this code (see the report's «NOT PROVEN»): every field is
 * looked up under the names the sources are known to use, by a case- and separator-insensitive key, and a field that is absent is simply absent.
 */
const squash = (key: string): string => key.toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, "");

function pick(row: Record<string, any>, aliases: string[]): unknown {
  const byKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row || {})) byKey.set(squash(key), value);
  const present = (value: unknown) => value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "") && typeof value !== "object";
  for (const alias of aliases) {
    const value = byKey.get(squash(alias));
    if (present(value)) return value;
  }
  return undefined;
}

/** A nested object («author»: {name}) arrives flattened as author_name by the row reader; a plain object value is read here too. */
function pickDeep(row: Record<string, any>, paths: string[][]): unknown {
  for (const path of paths) {
    let value: any = row;
    for (const part of path) value = value && typeof value === "object" ? value[part] : undefined;
    if (value !== undefined && value !== null && typeof value !== "object" && String(value).trim() !== "") return value;
  }
  return undefined;
}

const CONTROL_RE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]", "g");
const clean = (value: unknown, limit: number): string => String(value ?? "").replace(CONTROL_RE, "").replace(/\r/g, "").trim().slice(0, limit);

/** The link of a post without its query string and fragment, the form used to tell two reads of one post apart. */
export function postIdentity(url: string, id?: string): string {
  const base = String(url || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  return base || (id ? `id:${String(id).trim()}` : "");
}

const link = (value: unknown): string => {
  const text = String(value ?? "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
};

/** A post row of the page-posts or search source, as the report keeps it; null when it has no link and no id (it could not be told apart or opened). */
export function readPost(row: Record<string, any>, origin: { source: "page" | "search"; pageId?: string }): ReportPost | null {
  const url = link(pick(row, ["url", "post_url", "postUrl", "permalink", "permalink_url", "link", "share_url", "shareUrl", "post_link"]));
  const id = String(pick(row, ["post_id", "postId", "id", "fbid"]) ?? "").trim();
  const key = postIdentity(url, id);
  if (!key) return null;
  const text = clean(pick(row, ["text", "message", "caption", "content", "description", "post_text", "story", "title"]), POST_TEXT_KEEP_CHARS);
  const rawPublisher = String(pickDeep(row, [["author", "name"], ["page", "name"], ["from", "name"], ["owner", "name"]]) ?? pick(row, ["page_name", "pageName", "author_name", "authorName", "publisher", "author", "owner_name", "name"]) ?? "");
  const publisher = publisherOf(rawPublisher, origin.pageId);
  const kind = String(pick(row, ["type", "post_type", "postType", "media_type", "mediaType"]) ?? "").toLowerCase();
  const isVideo = /video|reel|watch/.test(kind) || pick(row, ["is_video", "isVideo", "has_video", "hasVideo"]) === true || /\/(?:reel|reels|watch|videos)\b/i.test(url);
  const reactions = parseCount(pick(row, ["reaction_count", "reactionCount", "reactions", "reactions_count", "likes", "like_count", "likeCount", "total_reactions"]));
  const comments = parseCount(pick(row, ["comment_count", "commentCount", "comments", "comments_count", "commentsCount"]));
  const shares = parseCount(pick(row, ["share_count", "shareCount", "shares", "shares_count", "sharesCount"]));
  const dateMs = rowDateMs(row);
  return {
    key,
    url,
    text,
    publisher: publisher.name,
    publisherKey: publisher.key,
    source: origin.source,
    ...(origin.pageId ? { pageId: origin.pageId } : {}),
    publishedAtMs: dateMs,
    reactions: reactions ?? 0,
    comments: comments ?? 0,
    shares: shares ?? 0,
    contentType: isVideo ? "video" : "text",
  };
}

const BREAKDOWN_KEYS: Array<[keyof NonNullable<ReportComment["breakdown"]>, string[]]> = [
  ["like", ["like", "likes", "like_count"]],
  ["love", ["love", "loves", "love_count"]],
  ["care", ["care", "care_count"]],
  ["haha", ["haha", "haha_count", "laugh"]],
  ["wow", ["wow", "wow_count"]],
  ["sad", ["sad", "sad_count"]],
  ["angry", ["angry", "angry_count"]],
];

/** A comment row, as the report keeps it. Nothing is judged here: an empty text is kept as empty and removed by the hygiene step, with a count. */
export function readComment(row: Record<string, any>, postKey: string): ReportComment {
  const id = String(pick(row, ["comment_id", "commentId", "cid", "id"]) ?? "").trim();
  const reactionsObj: Record<string, any> | null = row && typeof row.reactions === "object" && row.reactions ? row.reactions : row && typeof row.reaction_breakdown === "object" && row.reaction_breakdown ? row.reaction_breakdown : null;
  const breakdown: NonNullable<ReportComment["breakdown"]> = {};
  if (reactionsObj) {
    for (const [name, aliases] of BREAKDOWN_KEYS) {
      const value = parseCount(pick(reactionsObj, aliases));
      if (value !== undefined) breakdown[name] = value;
    }
  }
  const total = parseCount(typeof row?.reactions === "number" || typeof row?.reactions === "string" ? row.reactions : pick(row, ["reaction_count", "reactionCount", "likes", "like_count", "likeCount", "total_reactions", "reactions_count"]));
  const summed = Object.values(breakdown).reduce((sum, n) => sum + (n ?? 0), 0);
  return {
    postKey,
    ...(id ? { commentId: id } : {}),
    author: clean(pickDeep(row, [["author", "name"], ["user", "name"], ["from", "name"]]) ?? pick(row, ["author_name", "authorName", "author", "user_name", "username", "display_name", "name"]) ?? "", 200),
    text: clean(pick(row, ["text", "comment", "comment_text", "commentText", "content", "message", "body"]), COMMENT_TEXT_KEEP_CHARS),
    publishedAtMs: rowDateMs(row),
    reactions: total ?? summed,
    replies: parseCount(pick(row, ["replies", "reply_count", "replyCount", "replies_count", "repliesCount"])) ?? 0,
    ...(Object.keys(breakdown).length > 0 ? { breakdown } : {}),
  };
}
