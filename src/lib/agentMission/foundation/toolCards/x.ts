import type { ToolCard } from "./types";

/**
 * THE X CARD (data), verified on the stored real pages of M14 and M5 (tests/foundation-cards.test.ts). The query takes the search operators: the period is written as
 * `since:` / `until:` Cairo instants in UTC (toolInput.ts, S10) and the language as `lang:`. Tweets asked WITH their replies are requested as originals only (`-filter:replies`, compilePlan.ts).
 * The X replies card is `catalog_only` (live D5): no stored real page of an X replies tool exists, so it is used for TEST accounts only (owner decision 7.4), within CATALOG_ONLY_CAP_USD of calls
 * a mission; every other account gets the «not included» line (F6), never a model recipe.
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
  {
    // THE REPLIES TO A TWEET by its link, paged by cursor, up to 40 a page (the catalog's input note: «Opaque pagination cursor from a previous response's nextCursor»). CATALOG ONLY: written from the catalog entry
    // (data/treg/treg_catalog_sellable.json: inputs url/cursor/limit, list_path output.data.items, item_fields authorHandle/authorName/createdUtc/id/likeCount/replyCount/text/url/viewCount, price per successful call);
    // FIRST REAL RESPONSES (live round 7, msn_9fa5ba384c05a25247e1, tests/live-e-x-replies-real.test.ts): the list path, the ids, the fields and the parent link (`conversationId` = the tweet asked) are RIGHT; `output.data.nextCursor` is present and NULL on every page and the
    // response says its source cannot page (it may be incomplete): 16 of at least 23 direct replies came for one tweet. So the card stays catalog_only: «every reply the source shows» is not met. One row per call is assumed for the hold (a tweet with one reply costs a whole call).
    // ROUND 8 (owner decision, TEST accounts only, which is the only place this card is ever used): the call asks the provider for a source that CAN page, `requireFields: ["nextCursor"]` (the provider's own suggestion in that response), declared as an optional input of the catalog entry in code (catalog.ts DECLARED_EXTRA_INPUTS: the snapshot file is pinned and not edited); the engine
    // follows nextCursor until it is null or the stage's page cap. NOT VERIFIED: what the provider answers to it (whether it serves the call, what it charges, whether the token continues the replies) needs a paid call. The first live test of the owner decides; the card stays catalog_only until then.
    endpointId: "anyapi.x.post.comments",
    platform: "x",
    role: "tweet.replies",
    status: "catalog_only",
    inputs: { cursor: "cursor", parent: { param: "url", from: "link" }, fixed: { requireFields: ["nextCursor"] } },
    page: { list: ["output", "data", "items"], cursor: ["output", "data", "nextCursor"], observedRowsPerPage: 1 },
    mapping: {
      kind: "fields",
      fields: { id: ["id"], text: ["text"], author: ["authorName"], username: ["authorHandle"], posted_at: ["createdUtc"], link: ["url"], likes: ["likeCount"], replies_count: ["replyCount"], shares: ["repostCount"], views: ["viewCount"] },
    },
    counter: null,
    costUsdPerPage: 0.0005,
    verifiedOn: [],
  },
];
