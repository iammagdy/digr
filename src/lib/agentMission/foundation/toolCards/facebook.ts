import type { ToolCard } from "./types";

/**
 * THE FACEBOOK CARDS (data; docs/FOUNDATION-PLAN.md section 4.1, PR 3). A card is `verified` only when REAL stored pages map with it (owner decision 7.4; tests/platform-cards.test.ts checks every page listed);
 * otherwise it is `catalog_only` (test accounts only, inside the 0.20 USD a mission). Prices are the catalog's.
 *
 *  - The keyword search with dates is the card for «posts about X from page Y in a period»: it carries the topic and the period; the named page is CHOSEN among the rows by their author (a choice, never a filter).
 *    VERIFIED on the real pages of M17 (calls 4 and 5) and of the seven other Facebook search missions: every row has `author.id` / `name` / `url`, `timestamp` in unix seconds, `comments_count`, and `data.cursor` is non-empty.
 *  - The page listing carries neither a topic nor a period (3 posts a page). VERIFIED on the real pages of M17 and M19; its rows have a comment counter (`comments`) and the author id.
 *  - The comments card (scrapecreators) is VERIFIED on 8 real pages: each comment carries `reply_count` and the two tokens (`feedback_id`, `expansion_token`) a replies tool needs. Two of its real answers (M17 calls 7 and 8) are successful
 *    empty answers (`success true`, `comments []`, `has_next_page false`): empty, not an error.
 *  - THE REPLIES CARDS ARE catalog_only: all 8 real reply reads (M17 calls 10-13, M19 calls 7-10) were successful empty answers, so no real reply row has ever been seen to map.
 *  - `anyapi.facebook.search_posts`, `anyapi.facebook.post_comments`: never answered with rows (one planning call was refused), so catalog_only.
 */
const M17 = "msn_6bb78c15d116268b0b9b";
const M19 = "msn_96beb9f7a1d937a90cd0";

export const FACEBOOK_CARDS: ReadonlyArray<ToolCard> = [
  {
    // keyword + start day + end day, paged by cursor; 5 rows a page (V: 22 live calls)
    endpointId: "justoneapi.x.facebook-search-post-v1",
    platform: "facebook",
    role: "posts.search",
    status: "verified",
    inputs: { query: { field: "keyword", required: true, withSource: true }, period: { from: "startDate", to: "endDate" }, cursor: "cursor" },
    page: { list: ["data", "results"], cursor: ["data", "cursor"], observedRowsPerPage: 5 },
    mapping: {
      kind: "fields",
      fields: {
        id: ["post_id"], text: ["message"], author: ["author", "name"], author_id: ["author", "id"], author_url: ["author", "url"], posted_at: ["timestamp"], link: ["url"],
        comments: ["comments_count"], likes: ["reactions_count"], shares: ["reshare_count"],
      },
    },
    counter: { key: "comments", counts: "comments" },
    costUsdPerPage: 0.02952,
    verifiedOn: [
      { mission: M17, calls: ["call_0004", "call_0005"] },
      { mission: "msn_71577d2920048f9ebf22", calls: ["call_0001", "call_0003", "call_0004"] },
      { mission: "msn_aaed7fa9ffecc854edc0", calls: ["call_0001", "call_0002"] },
      { mission: "msn_5324df5fff82ef3c6a0e", calls: ["call_0001", "call_0002"] },
      { mission: "msn_a6e52e97658bc41fa7ad", calls: ["call_0001"] },
      { mission: "msn_25fb87d4b0dd80c6ae12", calls: ["call_0001", "call_0002"] },
      { mission: "msn_020bf5c4110c15c86ab8", calls: ["call_0001", "call_0002"] },
      { mission: "msn_e39585e687833914039e", calls: ["call_0001", "call_0002"] },
      { mission: "msn_980f9a239454964b0583", calls: ["call_0001", "call_0002"] },
    ],
    // the search has no country, language or order input: they are a choice among the read posts and a mark
    cannot: ["country", "language", "order"],
  },
  {
    // the second keyword search: up to 20 posts in one call, no cursor, the page's own link on each row. Never answered with rows (its one planning call was refused), so catalog_only.
    endpointId: "anyapi.facebook.search_posts",
    platform: "facebook",
    role: "posts.search",
    status: "catalog_only",
    inputs: { query: { field: "query", required: true, withSource: true }, period: { from: "startDate", to: "endDate" }, pageSize: { field: "limit", value: 20 }, cursor: null },
    page: { list: ["output", "data", "items"], cursor: null, observedRowsPerPage: 20 },
    mapping: {
      kind: "fields",
      fields: { id: ["id"], text: ["text"], author: ["authorName"], author_url: ["authorUrl"], posted_at: ["createdUtc"], link: ["url"], comments: ["commentCount"], likes: ["reactionCount"], shares: ["shareCount"] },
    },
    counter: { key: "comments", counts: "comments" },
    costUsdPerPage: 0.06606,
    verifiedOn: [],
    cannot: ["country", "language", "order"],
  },
  {
    // the page listing by the page's link, 3 posts a page; no keyword and no date (V: 5 listing tools, none has either). Rows carry the comment counter (`comments`) and the author id.
    endpointId: "anyapi.facebook.user.posts",
    platform: "facebook",
    role: "posts.page",
    status: "verified",
    inputs: { source: { param: "url", kind: "page_url" }, cursor: "cursor" },
    page: { list: ["output", "data", "posts"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 3 },
    mapping: { kind: "fields", fields: { id: ["id"], text: ["text"], author: ["author"], author_id: ["authorId"], posted_at: ["createdUtc"], link: ["url"], comments: ["comments"], likes: ["likes"], shares: ["shares"] } },
    counter: { key: "comments", counts: "comments" },
    costUsdPerPage: 0.002,
    verifiedOn: [{ mission: M17, calls: ["call_0002", "call_0003"] }, { mission: M19, calls: ["call_0002", "call_0003"] }],
    cannot: ["topic", "period", "country", "language", "order"],
  },
  {
    // the comments of one post by its link, paged by cursor; each comment carries its reply counter and the two tokens of its replies
    endpointId: "scrapecreators.x.v1-facebook-post-comments",
    platform: "facebook",
    role: "post.comments",
    status: "verified",
    inputs: { cursor: "cursor", parent: { param: "url", from: "link" } },
    page: { list: ["comments"], cursor: ["cursor"], observedRowsPerPage: 6 },
    mapping: { kind: "replies", tokens: [{ key: "feedback_id" }, { key: "expansion_token" }] },
    counter: { key: "replies_count", counts: "replies" },
    costUsdPerPage: 0.00188,
    verifiedOn: [{ mission: M17, calls: ["call_0006", "call_0009"] }, { mission: M19, calls: ["call_0004", "call_0006"] }, { mission: "msn_5324df5fff82ef3c6a0e", calls: ["call_0003"] }],
  },
  {
    // the comments by the post's link or its feedback id; rows carry the replies counter (`replies`) and no token, so this card cannot feed a replies step; never answered with rows by our calls
    endpointId: "anyapi.facebook.post_comments",
    platform: "facebook",
    role: "post.comments",
    status: "catalog_only",
    inputs: { cursor: "cursor", parent: { param: "url", from: "link" } },
    page: { list: ["output", "data", "comments"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 10 },
    mapping: { kind: "replies" },
    counter: { key: "replies_count", counts: "replies" },
    costUsdPerPage: 0.002,
    verifiedOn: [],
  },
  {
    // the replies of one comment by the comment's two tokens: catalog_only (8 of 8 real reads were successful empty answers; no reply row was ever seen)
    endpointId: "anyapi.facebook.comment_replies",
    platform: "facebook",
    role: "comment.replies",
    status: "catalog_only",
    inputs: { cursor: "cursor", parent: { param: "feedbackId", from: "feedback_id", also: [{ param: "expansionToken", from: "expansion_token" }] } },
    page: { list: ["output", "data", "replies"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 1 },
    mapping: { kind: "replies" },
    counter: null,
    costUsdPerPage: 0.0012,
    verifiedOn: [],
  },
  {
    endpointId: "scrapecreators.x.v1-facebook-post-comment-replies",
    platform: "facebook",
    role: "comment.replies",
    status: "catalog_only",
    inputs: { cursor: "cursor", parent: { param: "feedback_id", from: "feedback_id", also: [{ param: "expansion_token", from: "expansion_token" }] } },
    page: { list: ["replies"], cursor: ["cursor"], observedRowsPerPage: 1 },
    mapping: { kind: "replies" },
    counter: null,
    costUsdPerPage: 0.00188,
    verifiedOn: [],
  },
];
