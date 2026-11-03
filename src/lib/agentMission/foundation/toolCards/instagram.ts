import type { ToolCard } from "./types";

/**
 * THE INSTAGRAM CARDS (data; docs/FOUNDATION-PLAN.md section 4.2, PR 3). `verified` only on real stored pages (owner decision 7.4).
 *  - `scrapecreators.instagram.user.posts` is VERIFIED on the real pages of M15 (calls 2 and 7) and M16 (call 2): 12 posts a page, each with its short code (the post link is built from it), `taken_at` in unix seconds, `comment_count`;
 *    and every real page shows `next_max_id` with `more_available true`, so the card pages by `next_max_id` (the catalog's `pagination` is empty; the real pages are the proof).
 *  - `anyapi.instagram.user.posts` (handle, cursor, comment counter, date) has never been called (0 calls ever), so it is catalog_only; it pages by `cursor`.
 *  - The comments cards are verified on real pages. Their comment rows have NO usable reply counter: `anyapi`'s `replies` field is null on every real comment row (3 pages, 15 rows) and `scrapecreators`' `child_comment_count` is null on its one
 *    real page, so the replies promise stays open and a replies read is blind (one read a comment).
 *  - `anyapi.instagram.comment_replies` is VERIFIED on the one real page that has a reply row (M16 call 17); the other 12 real reads (M16 calls 10-22) were successful «not found» answers with no rows.
 */
const M15 = "msn_afe9bb0b436670e35a3c";
const M16 = "msn_e3e7632e2fb2d42f9c19";
const LINK = "https://www.instagram.com/p/{}/";

export const INSTAGRAM_CARDS: ReadonlyArray<ToolCard> = [
  {
    endpointId: "scrapecreators.instagram.user.posts",
    platform: "instagram",
    role: "posts.account",
    status: "verified",
    inputs: { source: { param: "handle", kind: "handle" }, cursor: "next_max_id" },
    page: { list: ["items"], cursor: ["next_max_id"], observedRowsPerPage: 12 },
    mapping: {
      kind: "fields",
      fields: { id: ["pk"], text: ["caption", "text"], posted_at: ["taken_at"], likes: ["like_count"], comments: ["comment_count"], views: ["play_count"] },
      linkTemplate: { template: LINK, field: ["code"] },
    },
    counter: { key: "comments", counts: "comments" },
    costUsdPerPage: 0.00188,
    verifiedOn: [{ mission: M15, calls: ["call_0002", "call_0007"] }, { mission: M16, calls: ["call_0002"] }],
    // an account listing has no keyword, no date, no country and no language input: each is a choice among the read posts and a mark
    cannot: ["topic", "period", "country", "language", "order"],
  },
  {
    // handle + cursor, with the comment counter and the date; 0 calls ever, so its page size and shape are the catalog's only
    endpointId: "anyapi.instagram.user.posts",
    platform: "instagram",
    role: "posts.account",
    status: "catalog_only",
    inputs: { source: { param: "handle", kind: "handle" }, cursor: "cursor" },
    page: { list: ["output", "data", "posts"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 12 },
    mapping: { kind: "fields", fields: { id: ["id"], text: ["caption"], username: ["username"], posted_at: ["createdUtc"], link: ["url"], likes: ["likes"], comments: ["comments"] } },
    counter: { key: "comments", counts: "comments" },
    costUsdPerPage: 0.0024,
    verifiedOn: [],
    cannot: ["topic", "period", "country", "language", "order"],
  },
  {
    endpointId: "anyapi.instagram.post.comments",
    platform: "instagram",
    role: "post.comments",
    status: "verified",
    inputs: { cursor: "cursor", parent: { param: "url", from: "link" } },
    page: { list: ["output", "data", "comments"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 5 },
    mapping: { kind: "replies" },
    counter: null,
    costUsdPerPage: 0.00144,
    verifiedOn: [{ mission: "msn_e3e7632e2fb2d42f9c19", calls: ["call_0004", "call_0008", "call_0009"] }, { mission: M15, calls: ["call_0003", "call_0008"] }],
  },
  {
    endpointId: "scrapecreators.instagram.post.comments",
    platform: "instagram",
    role: "post.comments",
    status: "verified",
    inputs: { cursor: "cursor", parent: { param: "url", from: "link" } },
    page: { list: ["comments"], cursor: ["cursor"], observedRowsPerPage: 1 },
    mapping: { kind: "replies" },
    counter: null,
    costUsdPerPage: 0.00188,
    verifiedOn: [{ mission: M15, calls: ["call_0004"] }],
  },
  {
    // the replies of one comment by the comment's id and the post's link (like TikTok's); a successful `not found` answer is an empty one
    endpointId: "anyapi.instagram.comment_replies",
    platform: "instagram",
    role: "comment.replies",
    status: "verified",
    inputs: { cursor: "cursor", parent: { param: "commentId", from: "id", also: [{ param: "url", from: "link", grand: true }] } },
    page: { list: ["output", "data", "comments"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 1 },
    mapping: { kind: "replies" },
    counter: null,
    costUsdPerPage: 0.0011,
    verifiedOn: [{ mission: M16, calls: ["call_0017"] }],
  },
];
