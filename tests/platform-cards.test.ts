import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_CARDS, cardOf, cardsFor, mapPage, CATALOG_ONLY_CAP_USD } from "../src/lib/agentMission/foundation/toolCards";
import { checkCardOnPage } from "../src/lib/agentMission/foundation/toolCards/verify";
import { loadTregCatalog } from "../src/lib/treg/catalog";

/**
 * FOUNDATION-PLAN PR 3, THE FACEBOOK, INSTAGRAM AND YOUTUBE CARDS (data). Owner decision 7.4: a card is `verified` only when REAL stored pages map with it (anonymised,
 * tests/fixtures/live/missions); otherwise it is `catalog_only` (test accounts only, inside the 0.20 USD a mission). This file is the gate: a verified card must be checked
 * on every page it lists, a catalog_only card must list none, and the status table below is the one the PR reports.
 */
const page = (mission: string, call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));
const index = JSON.parse(readFileSync(new URL("./fixtures/live/call-index.json", import.meta.url), "utf8")) as { missions: Record<string, Array<[string, string, string, string, number, Record<string, unknown>]>> };
const endpointOfCall = (mission: string, call: string): string | null => index.missions[mission]?.find((c) => c[0] === call)?.[2] ?? null;
const rowsOfCall = (mission: string, call: string): number | null => index.missions[mission]?.find((c) => c[0] === call)?.[4] ?? null;
const catalog = loadTregCatalog();

const M17 = "msn_6bb78c15d116268b0b9b";
const M16 = "msn_e3e7632e2fb2d42f9c19";
const M15 = "msn_afe9bb0b436670e35a3c";
const M2 = "msn_ee599cdbbde993073b15";

/** endpoint -> status, the table the PR reports. */
const STATUS: Record<string, "verified" | "catalog_only"> = {
  "justoneapi.x.facebook-search-post-v1": "verified",
  "anyapi.facebook.search_posts": "catalog_only",
  "anyapi.facebook.user.posts": "verified",
  "scrapecreators.x.v1-facebook-post-comments": "verified",
  "anyapi.facebook.post_comments": "verified", // CHANGED (round 20): verified on the first real pages of msn_934781c56a01a96825af (calls 8 and 10), ids proven equal to the main card's (tests/round20-facebook-alt-comments.test.ts)
  "scrapecreators.x.v1-facebook-post-comment-replies": "catalog_only",
  "anyapi.facebook.comment_replies": "verified", // CHANGED (round 14): verified on the 36 real pages of live round 12 (tests/round14-facebook-replies-real.test.ts)
  "scrapecreators.instagram.user.posts": "verified",
  "anyapi.instagram.user.posts": "catalog_only",
  "anyapi.instagram.post.comments": "verified",
  "scrapecreators.instagram.post.comments": "verified",
  "anyapi.instagram.comment_replies": "verified",
  "tikhub.x.youtube-web-v2-search-channels": "verified",
  "tikhub.x.youtube-web-search-channel": "verified",
  "youtube.youtube.video.detail": "catalog_only",
  "crawl4ai.youtube.video.comments": "verified",
  // CHANGED (round 12): both verified on the real pages of the YouTube mission of live round 11
  "tikhub.youtube.video.comments": "verified",
  "anyapi.youtube.comment_replies": "verified",
};
const NEW_CARDS = TOOL_CARDS.filter((c) => c.platform === "facebook" || c.platform === "instagram" || c.platform === "youtube");

describe("PR 3: the status of every Facebook, Instagram and YouTube card", () => {
  it("is exactly the table: 14 verified on real pages, 4 catalog_only", () => { // CHANGED (round 20): 13 and 5
    expect(Object.fromEntries(NEW_CARDS.map((c) => [c.endpointId, c.status]))).toEqual(STATUS);
    expect(NEW_CARDS.filter((c) => c.status === "verified")).toHaveLength(14);
    expect(NEW_CARDS.filter((c) => c.status === "catalog_only")).toHaveLength(4);
    expect(NEW_CARDS.filter((c) => c.status === "broken")).toEqual([]);
  });

  it("a verified card lists the real pages it was checked on; a catalog_only card lists none; every tool and input exists in the catalog; the price is the catalog's", () => {
    for (const c of NEW_CARDS) {
      if (c.status === "verified") expect(c.verifiedOn.flatMap((v) => v.calls).length, c.endpointId).toBeGreaterThan(0);
      else expect(c.verifiedOn, c.endpointId).toEqual([]);
      const e = catalog.byId.get(c.endpointId);
      expect(e, c.endpointId).toBeTruthy();
      const names = new Set([...(e!.inputs ?? []).map((i) => i.name), ...(e!.pagination ?? [])]);
      const fields = [c.inputs.query?.field, c.inputs.country?.field, c.inputs.order?.field, c.inputs.pageSize?.field, c.inputs.cursor, c.inputs.parent?.param, c.inputs.period?.from, c.inputs.period?.to, c.inputs.source?.param, c.inputs.ids?.param, ...(c.inputs.parent?.also ?? []).map((a) => a.param), ...Object.keys(c.inputs.fixed ?? {})];
      for (const f of fields.filter((x): x is string => typeof x === "string")) expect(names.has(f), `${c.endpointId} input ${f}`).toBe(true);
      expect(c.costUsdPerPage, c.endpointId).toBe(Number((e as unknown as { cost: { usd: number } }).cost.usd));
    }
  });

  for (const card of NEW_CARDS.filter((c) => c.status === "verified")) {
    for (const v of card.verifiedOn) {
      for (const call of v.calls) {
        it(`${card.endpointId} maps ${v.mission}/${call}: one row per item, an id on each, its counter and its next-page field`, () => {
          expect(endpointOfCall(v.mission, call)).toBe(card.endpointId);
          const check = checkCardOnPage(card, page(v.mission, call));
          expect(check.issues).toEqual([]);
          expect(check.rows.length).toBe(rowsOfCall(v.mission, call));
        });
      }
    }
  }

  it("a card is never checked on another tool's page", () => {
    expect(checkCardOnPage(cardOf("scrapecreators.instagram.user.posts")!, page(M17, "call_0004")).issues).toContain("no list at the card's path");
    expect(checkCardOnPage(cardOf("justoneapi.x.facebook-search-post-v1")!, page(M16, "call_0002")).issues).toContain("no list at the card's path");
  });

  it("the catalog_only cap is unchanged: 0.20 USD a mission", () => {
    expect(CATALOG_ONLY_CAP_USD).toBe(0.2);
  });
});

describe("Facebook: what the real pages show (M17)", () => {
  const search = cardOf("justoneapi.x.facebook-search-post-v1")!;
  it("the keyword search card carries the keyword and the two Cairo days, pages by cursor, and maps the author, the unix-seconds time and the comment counter", () => {
    expect(search.role).toBe("posts.search");
    expect(search.inputs.query).toMatchObject({ field: "keyword", required: true });
    expect(search.inputs.period).toEqual({ from: "startDate", to: "endDate" });
    expect(search.inputs.cursor).toBe("cursor");
    expect(search.page.cursor).toEqual(["data", "cursor"]);
    const rows = mapPage(search, page(M17, "call_0004"));
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(typeof r.author_id).toBe("string");
      expect(String(r.author_url)).toMatch(/^https:\/\/www\.facebook\.com\//);
      expect(typeof r.comments).toBe("number");
      expect(String(r.posted_at)).toMatch(/^2026-1[01]-\d\dT\d\d:\d\d:\d\d\.000Z$/);
    }
    expect(rows[0].comments).toBe(66);
    expect(rows[0].posted_at).toBe(new Date(1793616095 * 1000).toISOString());
    // the cursor of the stored page is not empty, so more pages existed
    const cursor = ((page(M17, "call_0004") as { data: { cursor?: string } }).data.cursor ?? "");
    expect(cursor.length).toBeGreaterThan(10);
  });

  it("the keyword search has NO list path in the catalog's note «cannot»: the card says it cannot carry a country, a language or an order (they are a choice among the read posts)", () => {
    expect(search.cannot).toEqual(expect.arrayContaining(["country", "language", "order"]));
    expect(search.cannot).not.toContain("period");
    expect(search.cannot).not.toContain("topic");
  });

  it("the page listing carries no topic and no period, takes the page by its link, and its stored pages show a comment counter and the author id", () => {
    const listing = cardOf("anyapi.facebook.user.posts")!;
    expect(listing.role).toBe("posts.page");
    expect(listing.inputs.source).toMatchObject({ param: "url", kind: "page_url" });
    expect(listing.inputs.query).toBeUndefined();
    expect(listing.inputs.period).toBeUndefined();
    expect(listing.cannot).toEqual(expect.arrayContaining(["topic", "period"]));
    const rows = mapPage(listing, page(M17, "call_0002"));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => typeof r.comments === "number" && r.author_id === "100069103503573")).toBe(true);
  });

  it("the comments card (verified on 4 real pages) carries each comment's own reply counter and the two tokens the replies tool needs", () => {
    const comments = cardOf("scrapecreators.x.v1-facebook-post-comments")!;
    const rows = mapPage(comments, page(M17, "call_0009"));
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(typeof r.replies_count).toBe("number");
      expect(String(r.feedback_id).length).toBeGreaterThan(20);
      expect(String(r.expansion_token).length).toBeGreaterThan(20);
    }
    expect(comments.counter).toEqual({ key: "replies_count", counts: "replies" });
    expect(comments.inputs.parent).toEqual({ param: "url", from: "link" });
  });

  it("the replies cards stay catalog_only: 8 of 8 live reply reads were successful empty answers, no real reply row was ever seen (their reply binding is the comment row's two tokens)", () => {
    // CHANGED (round 14): `anyapi.facebook.comment_replies` is verified on real reply pages; the scrapecreators one was never used and stays catalog_only
    for (const id of ["scrapecreators.x.v1-facebook-post-comment-replies", "anyapi.facebook.comment_replies"]) {
      const c = cardOf(id)!;
      expect(c.status).toBe(id.startsWith("anyapi") ? "verified" : "catalog_only");
      expect(c.role).toBe("comment.replies");
      expect(c.inputs.parent?.also).toHaveLength(1);
    }
    // the empty page is a successful empty answer: nothing to map
    expect(mapPage(cardOf("anyapi.facebook.comment_replies")!, page(M17, "call_0010"))).toEqual([]);
  });

  it("the second keyword search is catalog_only, takes the same Cairo days, no cursor, up to 20 posts, and is the only Facebook card that carries the page's link (authorUrl)", () => {
    const c = cardOf("anyapi.facebook.search_posts")!;
    expect(c.status).toBe("catalog_only");
    expect(c.role).toBe("posts.search");
    expect(c.inputs.cursor).toBeNull();
    expect(c.inputs.pageSize).toEqual({ field: "limit", value: 20 });
    expect(c.inputs.period).toEqual({ from: "startDate", to: "endDate" });
    expect(c.mapping.kind === "fields" && c.mapping.fields.author_url).toEqual(["authorUrl"]);
  });
});

describe("Instagram: what the real pages show (M16, M15)", () => {
  const account = cardOf("scrapecreators.instagram.user.posts")!;
  it("the account card pages by `next_max_id` (a real page shows it with `more_available`), gives 12 a page, the comment counter, the date and the post link built from its short code", () => {
    expect(account.role).toBe("posts.account");
    expect(account.inputs.source).toMatchObject({ param: "handle", kind: "handle" });
    expect(account.inputs.cursor).toBe("next_max_id");
    expect(account.page.cursor).toEqual(["next_max_id"]);
    const real = page(M16, "call_0002") as { next_max_id?: string; more_available?: boolean };
    expect(String(real.next_max_id).length).toBeGreaterThan(10);
    expect(real.more_available).toBe(true);
    const rows = mapPage(account, real);
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.comments)).toEqual([2, 2, 2, 0, 5, 1, 1, 9, 0, 0, 0, 0]);
    expect(rows[0].link).toBe("https://www.instagram.com/p/DfPod9DoNO3/");
    expect(rows[0].posted_at).toBe(new Date(1793633432 * 1000).toISOString());
    expect(account.counter).toEqual({ key: "comments", counts: "comments" });
  });

  it("the other account card is catalog_only: it was never called (0 calls ever), so nothing real maps with it", () => {
    const c = cardOf("anyapi.instagram.user.posts")!;
    expect(c.status).toBe("catalog_only");
    expect(c.inputs.cursor).toBe("cursor");
    expect(c.verifiedOn).toEqual([]);
  });

  it("the comments cards map the real pages; the reply counter field exists but is null on every real comment row, so the card has NO counter and the replies promise stays open", () => {
    const c = cardOf("anyapi.instagram.post.comments")!;
    expect(c.counter).toBeNull();
    const rows = mapPage(c, page(M16, "call_0008"));
    expect(rows).toHaveLength(8);
    // CHANGED (live round 11): a comments card with no reply counter never reads the source's field, so its rows carry no counter at all (the key is absent; it was null)
    expect(rows.every((r) => (r.replies_count ?? null) === null)).toBe(true);
    expect(c.inputs.parent).toEqual({ param: "url", from: "link" });
    const scrape = cardOf("scrapecreators.instagram.post.comments")!;
    expect(mapPage(scrape, page(M15, "call_0004"))).toHaveLength(1);
  });

  it("the replies card is verified on the one real page that has a reply row, and the other 12 real reads were successful `not found` answers (no rows)", () => {
    const c = cardOf("anyapi.instagram.comment_replies")!;
    expect(c.status).toBe("verified");
    expect(mapPage(c, page(M16, "call_0017"))).toHaveLength(1);
    expect(mapPage(c, page(M16, "call_0010"))).toEqual([]);
    expect(c.inputs.parent).toMatchObject({ param: "commentId", from: "id", also: [{ param: "url", from: "link", grand: true }] });
  });
});

describe("YouTube: what the real pages show (M2)", () => {
  it("the channel search gives the channel ids (2 a page), the in-channel search gives 30 videos with their channel and a next page, and no video row has a comment counter", () => {
    const channels = cardOf("tikhub.x.youtube-web-v2-search-channels")!;
    expect(channels.role).toBe("channels.search");
    expect(mapPage(channels, page(M2, "call_0003")).map((r) => r.id)).toEqual(["UCmeqakSoEdmxEtTnCFSbunw", "UCA86pBGxVPZGrTeTecOtjew"]);
    const inChannel = cardOf("tikhub.x.youtube-web-search-channel")!;
    expect(inChannel.role).toBe("videos.channel");
    expect(inChannel.inputs.source).toMatchObject({ param: "channel_id", kind: "channel_id" });
    expect(inChannel.inputs.query).toMatchObject({ field: "search_query", required: true });
    const rows = mapPage(inChannel, page(M2, "call_0006"));
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.channel_id))).toEqual(new Set(["UCA86pBGxVPZGrTeTecOtjew"]));
    expect(rows[0].link).toBe("https://www.youtube.com/watch?v=RmjKXb5gYiw");
    expect(inChannel.counter).toBeNull();
  });

  it("the free detail card is catalog_only (never called), reads up to 50 ids a call and turns the statistics' numeric strings into counters", () => {
    const d = cardOf("youtube.youtube.video.detail")!;
    expect(d.status).toBe("catalog_only");
    expect(d.role).toBe("videos.counter");
    expect(d.inputs.ids).toMatchObject({ param: "id", max: 50 });
    expect(d.costUsdPerPage).toBe(0);
    const rows = mapPage(d, { items: [{ id: "abc", statistics: { viewCount: "10", commentCount: "1234" } }, { id: "def", statistics: { viewCount: "5" } }] });
    expect(rows.map((r) => [r.id, r.comments])).toEqual([["abc", 1234], ["def", null]]);
  });

  it("the comments card that feeds replies (reply token and reply counter) is verified since round 12; the other verified one (crawl4ai) reads up to 500 in one call and has no token", () => {
    const feeds = cardOf("tikhub.youtube.video.comments")!;
    expect(feeds.status).toBe("verified");
    expect(feeds.mapping.kind === "replies" && feeds.mapping.tokens?.map((t) => t.key)).toEqual(["reply_continuation_token"]);
    const rows = mapPage(feeds, { data: { comments: [{ comment_id: "Ugz1", content: "x", reply_count: "961", reply_continuation_token: "tok1", author: { display_name: "n" }, published_time: "1 year ago" }] } });
    expect(rows[0]).toMatchObject({ id: "Ugz1", replies_count: 961, reply_continuation_token: "tok1" });
    const plain = cardOf("crawl4ai.youtube.video.comments")!;
    expect(plain.status).toBe("verified");
    expect(plain.inputs.fixed).toEqual({ limit: 500 });
    expect(plain.inputs.cursor).toBeNull();
    expect(mapPage(plain, page(M2, "call_0009"))).toHaveLength(9);
    expect(cardOf("anyapi.youtube.comment_replies")!.inputs.parent).toEqual({ param: "continuationToken", from: "reply_continuation_token" });
  });
});

describe("the compiler sees the right cards per role", () => {
  it("Facebook parents: both searches and the listing; test accounts add the catalog_only ones", () => {
    expect(cardsFor("facebook", "posts.search").map((c) => c.endpointId)).toEqual(["justoneapi.x.facebook-search-post-v1"]);
    expect(cardsFor("facebook", "posts.search", { catalogOnly: true }).map((c) => c.endpointId).sort()).toEqual(["anyapi.facebook.search_posts", "justoneapi.x.facebook-search-post-v1"]);
    expect(cardsFor("facebook", "posts.page").map((c) => c.endpointId)).toEqual(["anyapi.facebook.user.posts"]);
    expect(cardsFor("facebook", "comment.replies").map((c) => c.endpointId)).toEqual(["anyapi.facebook.comment_replies"]); // CHANGED (round 14)
    expect(cardsFor("facebook", "comment.replies", { catalogOnly: true })).toHaveLength(2);
    expect(cardsFor("instagram", "comment.replies").map((c) => c.endpointId)).toEqual(["anyapi.instagram.comment_replies"]);
    // CHANGED (round 12): YouTube's replies card is verified on the real pages of live round 11
    expect(cardsFor("youtube", "comment.replies").map((c) => c.endpointId)).toEqual(["anyapi.youtube.comment_replies"]);
  });
});
