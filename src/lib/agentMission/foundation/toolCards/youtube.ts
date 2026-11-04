import type { ToolCard } from "./types";

/**
 * THE YOUTUBE CARDS (data; docs/FOUNDATION-PLAN.md section 4.3, PR 3). `verified` only on real stored pages (owner decision 7.4). The official channels are resolved FIRST, then read inside each:
 *  - `tikhub.x.youtube-web-v2-search-channels` (a keyword gives the channels, 2 a page) and `tikhub.x.youtube-web-search-channel` (the channel's own videos about the topic, 30 a page, a next page) are VERIFIED on the real pages of M2 (calls 3, 4, 6, 7).
 *    No video row of either has a comment counter (V: the real pages).
 *  - THE COUNTER: `youtube.youtube.video.detail` (free, up to 50 ids a call, `statistics.commentCount`) has never been called (0 calls ever; it needs YouTube connected on our provider account: owner decision 7.7), so it is catalog_only. A test account reads it;
 *    when it answers, the promise is the counters of the chosen videos; otherwise it is open.
 *  - COMMENTS: `crawl4ai.youtube.video.comments` is VERIFIED on the real pages of M2 and M18 (up to 500 in one call, no cursor, each comment a replies count, no reply token). `tikhub.youtube.video.comments` (the reply counter and the comment's reply token, paged by
 *    `data.continuation_token`) is VERIFIED since round 12 on the 8 real pages of the YouTube mission of live round 11; the compiler prefers it whenever a replies card can use its token, so every account reads it. Its `published_time` is a relative text in the provider's language: no date.
 *  - REPLIES: `anyapi.youtube.comment_replies` by the comment's reply token is VERIFIED since round 12 on the 3 real pages of the same mission (not seen: a thread of more than one page).
 */
const M2 = "msn_ee599cdbbde993073b15";
const M18 = "msn_3594a5ab6311c8691f20";
const WATCH = "https://www.youtube.com/watch?v={}";

const M_R11_YT = "msn_41a73a6b2c0b4a76ef0a";
export const YOUTUBE_CARDS: ReadonlyArray<ToolCard> = [
  {
    endpointId: "tikhub.x.youtube-web-v2-search-channels",
    platform: "youtube",
    role: "channels.search",
    status: "verified",
    inputs: { query: { field: "keyword", required: true }, cursor: "continuation_token" },
    page: { list: ["data", "channels"], cursor: ["data", "continuation_token"], observedRowsPerPage: 2 },
    mapping: { kind: "fields", fields: { id: ["channel_id"], title: ["title"], handle: ["handle"], subscribers: ["subscriber_count_text"] } },
    counter: null,
    costUsdPerPage: 0.001,
    verifiedOn: [{ mission: M2, calls: ["call_0003", "call_0004"] }],
  },
  {
    // the channel's own videos about the topic, 30 a page; no comment counter on its rows
    endpointId: "tikhub.x.youtube-web-search-channel",
    platform: "youtube",
    role: "videos.channel",
    status: "verified",
    inputs: { query: { field: "search_query", required: true }, source: { param: "channel_id", kind: "channel_id" }, cursor: "continuation_token" },
    page: { list: ["data", "videos"], cursor: ["data", "continuation_token"], observedRowsPerPage: 30 },
    mapping: {
      kind: "fields",
      fields: { id: ["video_id"], text: ["title"], author: ["author"], channel_id: ["channel_id"], views: ["number_of_views"], published: ["published_time"] },
      linkTemplate: { template: WATCH, field: ["video_id"] },
    },
    counter: null,
    costUsdPerPage: 0.001,
    verifiedOn: [{ mission: M2, calls: ["call_0006", "call_0007"] }],
    cannot: ["country", "language", "period", "order"],
  },
  {
    // the free counter: up to 50 ids a call; catalog_only (never called, and it needs YouTube connected on our provider account)
    endpointId: "youtube.youtube.video.detail",
    platform: "youtube",
    role: "videos.counter",
    status: "catalog_only",
    inputs: { ids: { param: "id", max: 50 }, fixed: { part: "statistics" }, cursor: null },
    page: { list: ["items"], cursor: null, observedRowsPerPage: 50 },
    mapping: { kind: "fields", fields: { id: ["id"], comments: ["statistics", "commentCount"] }, numeric: ["comments"] },
    counter: { key: "comments", counts: "comments" },
    costUsdPerPage: 0,
    verifiedOn: [],
  },
  {
    // up to 500 comments in one call, no cursor, each comment its replies count (`replies`), no reply token: it cannot feed a replies step
    endpointId: "crawl4ai.youtube.video.comments",
    platform: "youtube",
    role: "video.comments",
    status: "verified",
    inputs: { cursor: null, parent: { param: "video", from: "id" }, fixed: { limit: 500 } },
    page: { list: ["rows"], cursor: null, observedRowsPerPage: 15 },
    mapping: { kind: "replies" },
    counter: { key: "replies_count", counts: "replies" },
    costUsdPerPage: 0.0009,
    verifiedOn: [{ mission: M2, calls: ["call_0009", "call_0011", "call_0013"] }, { mission: M18, calls: ["call_0002", "call_0004", "call_0005"] }],
  },
  {
    // the comments with the reply counter (`reply_count`, written as text) and the comment's reply token, paged by `data.continuation_token`. VERIFIED on the 8 real pages of live round 11 (2 videos, 123 comments, 3 with replies). Its `published_time` is a relative text in the provider's own
    // language («11个月前»), never a date: the mapping leaves the comment's date empty (round 12). Round 13: the call sends `language_code: "en"` (a declared input of the catalog entry), so the text is English («3 days ago», «11 months ago (edited)»): the mapping keeps it and the engine turns it into an approximate Cairo day from the moment of the read, marked approximate; a text it cannot read leaves the date empty and is counted in the delivery's limits. NOT SEEN on a real page yet: the English forms are synthetic until the live round.
    endpointId: "tikhub.youtube.video.comments",
    platform: "youtube",
    role: "video.comments",
    status: "verified",
    inputs: { cursor: "continuation_token", parent: { param: "video_id", from: "id" }, fixed: { language_code: "en" } },
    page: { list: ["data", "comments"], cursor: ["data", "continuation_token"], observedRowsPerPage: 20 },
    mapping: { kind: "replies", tokens: [{ key: "reply_continuation_token" }], relativeDates: true },
    counter: { key: "replies_count", counts: "replies" },
    costUsdPerPage: 0.001,
    verifiedOn: [{ mission: M_R11_YT, calls: ["call_0006", "call_0007", "call_0008", "call_0009", "call_0010", "call_0011", "call_0012", "call_0013"] }],
  },
  {
    // the replies of one comment by its reply token (the token is the same input that pages the next page: the engine overwrites it with the next page's token). VERIFIED on the 3 real pages of live round 11 (1, 1 and 2 replies for comments whose counters said 1, 1 and 2; each ends on an empty `nextCursor`).
    // Not seen: a reply thread of more than one page, so the next-page token of a page WITH more replies is the catalog's, not a real one.
    endpointId: "anyapi.youtube.comment_replies",
    platform: "youtube",
    role: "comment.replies",
    status: "verified",
    inputs: { cursor: "continuationToken", parent: { param: "continuationToken", from: "reply_continuation_token" } },
    page: { list: ["output", "data", "comments"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 10 },
    // round 14: `createdUtc` of a reply is an instant the provider computed (the minute of the call minus the age in `publishedTime`, «11 months ago»): the mapping keeps that text beside it (`date_text`), so ingest writes the approximate day and marks it
    mapping: { kind: "replies", relativeDates: true },
    counter: null,
    costUsdPerPage: 0.0012,
    verifiedOn: [{ mission: M_R11_YT, calls: ["call_0014", "call_0015", "call_0016"] }],
  },
];
