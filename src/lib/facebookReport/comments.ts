import { facebookCommentDropReason } from "../server/commentQuality";
import type { ReportComment } from "./types";

/**
 * COMMENTS ARE NEVER JUDGED. Every comment of a kept post is taken. Only three kinds are removed, by rules alone and with a count each:
 *  - an empty comment (no text once control characters are removed);
 *  - an exact duplicate (the same comment id under the same post, or, when the source gave no id, the same author and the same text under the same post: pagination overlap);
 *  - a comment that is only a link.
 * A short comment, a reaction, an emoji, a pleasantry, a comment that never names the topic, a comment from a doubtful account: all kept. Judgment of the report is
 * about POSTS (their axis), never about what people wrote under them.
 */
export interface CommentHygiene {
  kept: ReportComment[];
  empty: number;
  duplicates: number;
  linkOnly: number;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

export function dedupeKeyOf(comment: ReportComment): string {
  return comment.commentId ? `${comment.postKey}|id:${comment.commentId}` : `${comment.postKey}|a:${collapse(comment.author).toLowerCase()}|t:${collapse(comment.text)}`;
}

/** Cleans a batch of comments against the keys already taken (`seen` is updated, so overlapping pages of one post are cleaned across calls). */
export function cleanComments(comments: ReportComment[], seen: Set<string> = new Set()): CommentHygiene {
  const result: CommentHygiene = { kept: [], empty: 0, duplicates: 0, linkOnly: 0 };
  for (const comment of comments) {
    const drop = facebookCommentDropReason(comment.text);
    if (drop === "empty") { result.empty += 1; continue; }
    if (drop === "link_only") { result.linkOnly += 1; continue; }
    const key = dedupeKeyOf(comment);
    if (seen.has(key)) { result.duplicates += 1; continue; }
    // a comment with an id may also repeat under another id only if the source re-issued it: that is not an exact duplicate and is kept
    seen.add(key);
    result.kept.push(comment);
  }
  return result;
}
