import type { ToolCard } from "./types";

/**
 * THE TIKTOK CARDS (data). Each one is verified on the stored real pages it lists (tests/fixtures/live/missions, anonymised; tests/foundation-cards.test.ts):
 * every item an id, the counter where the card says, the cursor where the card says. Prices are the catalog's (data/treg/treg_catalog_sellable.json).
 */
const M12 = "msn_5851abc92a1e6645a9cd";

export const TIKTOK_CARDS: ReadonlyArray<ToolCard> = [
  {
    // keyword + region + order + page size, paged by offset; 10 rows on a page of count 20 (V: M6, M7, M11, M12, M13)
    endpointId: "tikhub.tiktok.search.videos",
    platform: "tiktok",
    role: "videos.search",
    status: "verified",
    inputs: { query: { field: "keyword" }, country: { field: "region" }, order: { field: "sort_type", most_commented: 1, newest: 2 }, pageSize: { field: "count", value: 20 }, cursor: "offset" },
    page: { list: ["data", "search_item_list"], item: ["aweme_info"], cursor: ["data", "cursor"], observedRowsPerPage: 10 },
    mapping: {
      kind: "fields",
      fields: {
        id: ["aweme_id"], text: ["desc"], author: ["author", "nickname"], username: ["author", "unique_id"], posted_at: ["create_time"], link: ["share_url"],
        country: ["region"], language: ["desc_language"], likes: ["statistics", "digg_count"], comments: ["statistics", "comment_count"], shares: ["statistics", "share_count"],
        views: ["statistics", "play_count"], saves: ["statistics", "collect_count"],
      },
    },
    counter: { key: "comments", counts: "comments_and_replies" },
    costUsdPerPage: 0.001,
    verifiedOn: [{ mission: M12, calls: ["call_0006", "call_0007"] }, { mission: "msn_48f6c7c80eb7068f2a38", calls: ["call_0002"] }, { mission: "msn_a6dacebce7e7b7432aa1", calls: ["call_0002", "call_0003"] }, { mission: "msn_6066498b5da3dd512595", calls: ["call_0003"] }, { mission: "msn_5d849cbac96092de0287", calls: ["call_0001", "call_0004"] }, { mission: "msn_f22426e67810c2ce852e", calls: ["call_0002"] }],
    // a period has no day input here (publish_time is a preset), and the language has no input: both are a choice among the read rows and a mark
    cannot: ["language", "period"],
  },
  {
    // query + order, paged by cursor; no country input (M8: both videos Iraqi)
    endpointId: "anyapi.tiktok.search.videos",
    platform: "tiktok",
    role: "videos.search",
    status: "verified",
    inputs: { query: { field: "query" }, order: { field: "sortBy", most_commented: 2 }, cursor: "cursor" },
    page: { list: ["output", "data", "videos"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 20 },
    mapping: {
      kind: "fields",
      fields: { id: ["id"], text: ["caption"], author: ["authorName"], username: ["author"], posted_at: ["createdUtc"], link: ["url"], country: ["region"], likes: ["likes"], comments: ["comments"], shares: ["shares"], views: ["views"], saves: ["saves"] },
    },
    counter: { key: "comments", counts: "comments_and_replies" },
    costUsdPerPage: 0.0012,
    verifiedOn: [{ mission: M12, calls: ["call_0002"] }, { mission: "msn_481a78e310d9e68fddce", calls: ["call_0002"] }, { mission: "msn_7a35b44e35e6f3f1b8e9", calls: ["call_0002"] }],
    cannot: ["country", "language", "period"],
  },
  {
    // query + limit, one page; no country, no order, no next page; failed in 3 of 8 planning calls (timeouts)
    endpointId: "crawl4ai.tiktok.search.videos",
    platform: "tiktok",
    role: "videos.search",
    status: "verified",
    inputs: { query: { field: "query" }, pageSize: { field: "limit", value: 30 }, cursor: null },
    page: { list: ["rows"], cursor: null, observedRowsPerPage: 30 },
    mapping: {
      kind: "fields",
      fields: { id: ["post_id"], text: ["description"], author: ["author", "name"], username: ["author", "username"], posted_at: ["created_at"], link: ["url"], likes: ["stats", "likes"], comments: ["stats", "comments"], shares: ["stats", "shares"], views: ["stats", "plays"], saves: ["stats", "saves"] },
    },
    counter: { key: "comments", counts: "comments_and_replies" },
    costUsdPerPage: 0.0005,
    verifiedOn: [{ mission: "msn_48f6c7c80eb7068f2a38", calls: ["call_0001"] }, { mission: "msn_a6dacebce7e7b7432aa1", calls: ["call_0001"] }, { mission: "msn_c796a6ff13d79f7a973d", calls: ["call_0001"] }, { mission: "msn_6066498b5da3dd512595", calls: ["call_0001"] }, { mission: "msn_f22426e67810c2ce852e", calls: ["call_0001"] }],
    cannot: ["country", "language", "period", "order"],
  },
  {
    // the comments of one video by its link, paged by cursor; each comment carries its own replies counter (V: M12 calls 5, 8-29)
    endpointId: "anyapi.tiktok.video.comments",
    platform: "tiktok",
    role: "video.comments",
    status: "verified",
    inputs: { cursor: "cursor", parent: { param: "url", from: "link" } },
    page: { list: ["output", "data", "comments"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 20 },
    mapping: { kind: "replies" },
    counter: { key: "replies_count", counts: "replies" },
    costUsdPerPage: 0.002,
    verifiedOn: [{ mission: M12, calls: ["call_0005", "call_0008", "call_0009", "call_0010", "call_0018", "call_0019", "call_0029"] }],
  },
  {
    // the replies of one comment by the comment's id and the video's link (V: M12 calls 30-96)
    endpointId: "anyapi.tiktok.comment_replies",
    platform: "tiktok",
    role: "comment.replies",
    status: "verified",
    inputs: { cursor: "cursor", parent: { param: "commentId", from: "id", also: [{ param: "url", from: "link", grand: true }] } },
    page: { list: ["output", "data", "comments"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 1 },
    mapping: { kind: "replies" },
    counter: null,
    costUsdPerPage: 0.0009,
    verifiedOn: [{ mission: M12, calls: ["call_0030", "call_0031", "call_0032", "call_0049", "call_0090", "call_0096"] }],
  },
];
