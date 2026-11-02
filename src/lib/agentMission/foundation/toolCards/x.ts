import type { ToolCard } from "./types";

/**
 * THE X CARD (data), verified on the stored real pages of M14 and M5 (tests/foundation-cards.test.ts). The query takes the search operators: the period is written as
 * `since:` / `until:` Cairo instants in UTC (toolInput.ts, S10) and the language as `lang:`. No X replies card exists yet: no stored real page of an X replies tool, so a replies
 * stage on X is a «not included» line (F6), never a model recipe.
 */
export const X_CARDS: ReadonlyArray<ToolCard> = [
  {
    endpointId: "anyapi.x.search.posts",
    platform: "x",
    role: "tweets.search",
    status: "verified",
    inputs: { query: { field: "query", operators: true, quoted: true }, order: { field: "queryType", most_commented: "Top", newest: "Latest" }, pageSize: { field: "limit", value: 20 }, cursor: "cursor" },
    page: { list: ["output", "data", "items"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 20 },
    mapping: {
      kind: "fields",
      fields: {
        id: ["id"], text: ["text"], author: ["authorName"], username: ["authorUsername"], followers: ["authorFollowers"], posted_at: ["createdUtc"], link: ["url"], is_reply: ["isReply"],
        language: ["lang"], likes: ["likeCount"], replies_count: ["replyCount"], shares: ["retweetCount"], views: ["viewCount"],
      },
    },
    counter: { key: "replies_count", counts: "replies" },
    costUsdPerPage: 0.00075,
    verifiedOn: [{ mission: "msn_b060d3347ed7660f972e", calls: ["call_0001", "call_0002", "call_0003"] }, { mission: "msn_e3d679014c58168c3227", calls: ["call_0001"] }],
  },
];
