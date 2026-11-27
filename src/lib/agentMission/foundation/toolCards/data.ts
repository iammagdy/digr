import type { ToolCard } from "./types";
import toolCardData from "../../../../../data/treg/tool_cards.json";

/**
 * THE TOOL CARDS AS DATA (DT-20261126-wordlist-wave4, UP1, D-0228): what each verified (or catalog-only) endpoint really does — inputs, page paths, field mapping, counter, price, the stored real pages it was verified on — lives in
 * data/treg/tool_cards.json, one record per endpoint, in the order the five platform files had (tiktok, x, facebook, instagram, youtube). The code never names an endpoint: it asks the cards for a platform and a role.
 * `catalog` on a card is that endpoint's own tier, observed reliability and price copied from the catalog (tests/wl4-up1-tool-cards.test.ts proves every copy equals the catalog); `note` is the card's evidence text
 * that used to be a comment in its file. Neither is read except by the tie-break of `rankedCards` (catalogOrder.ts).
 *
 * The header comments of the five files, kept as written:
 *
 * tiktok (was toolCards/tiktok.ts):
 * THE TIKTOK CARDS (data). Each one is verified on the stored real pages it lists (tests/fixtures/live/missions, anonymised; tests/foundation-cards.test.ts):
 * every item an id, the counter where the card says, the cursor where the card says. Prices are the catalog's (data/treg/treg_catalog_sellable.json).
 * (constant) const M12 = "msn_5851abc92a1e6645a9cd";
 * 
 * x (was toolCards/x.ts):
 * THE X CARD (data), verified on the stored real pages of M14 and M5 (tests/foundation-cards.test.ts). The query takes the search operators: the period is written as
 * `since:` / `until:` Cairo instants in UTC (toolInput.ts, S10) and the language as `lang:`. Tweets asked WITH their replies are requested as originals only (`-filter:replies`, compilePlan.ts).
 * P0 (14 Nov 2026): the search takes the named account as `from:<username>` (the catalog entry of anyapi.x.search.posts: «operators like from:, since:, until: … work inline in the query»); the compiler then checks every row's own
 * username against it (foundation/sourceScope.ts).
 * P0 (15 Nov 2026): alternatives are joined by `OR` in one group: the catalog's input note («bare terms are ANDed … use one short phrase or OR between alternatives (e.g. 'anyapi OR getanyapi')») and production calls of this card whose grouped
 * `( … OR … )` queries answered rows (4 Nov 2026: «الذكاء الاصطناعي (أعتقد OR رأيي OR برأيي OR أرى) lang:ar -filter:replies», 20 rows; 3 Nov 2026: «(to:… OR to:… …)», 20 rows a call).
 * The X replies card was `catalog_only` (live D5, rounds 7 and 8: test accounts only, owner decision 7.4) and is VERIFIED since live round 8 (3 Nov 2026): the 14 real pages of msn_50e3b83c44e7ebd7f577 show the route
 * pages (a token on every page with rows, the next call asked for it, an empty page with a null token ends each tweet), at 0.00054 USD a call. Every account gets the replies step; the stage keeps its page cap
 * (CATALOG_ONLY_CAP_USD / (price x CATALOG_ONLY_PRICE_MARGIN) pages: the name is from the card's catalog_only days, the cap is still the one that bounds what a mission may spend on these calls).
 * 
 * facebook (was toolCards/facebook.ts):
 * THE FACEBOOK CARDS (data; docs/FOUNDATION-PLAN.md section 4.1, PR 3). A card is `verified` only when REAL stored pages map with it (owner decision 7.4; tests/platform-cards.test.ts checks every page listed);
 * otherwise it is `catalog_only` (test accounts only, inside the 0.20 USD a mission). Prices are the catalog's.
 *  - The keyword search with dates is the card for «posts about X from page Y in a period»: it carries the topic and the period; the named page is CHOSEN among the rows by their author (a choice, never a filter).
 *    VERIFIED on the real pages of M17 (calls 4 and 5) and of the seven other Facebook search missions: every row has `author.id` / `name` / `url`, `timestamp` in unix seconds, `comments_count`, and `data.cursor` is non-empty.
 *  - The page listing carries neither a topic nor a period (3 posts a page). VERIFIED on the real pages of M17 and M19; its rows have a comment counter (`comments`) and the author id.
 *  - The comments card (scrapecreators) is VERIFIED on 8 real pages: each comment carries `reply_count` and the two tokens (`feedback_id`, `expansion_token`) a replies tool needs. Two of its real answers (M17 calls 7 and 8) are successful
 *    empty answers (`success true`, `comments []`, `has_next_page false`): empty, not an error.
 *  - THE REPLIES CARDS ARE catalog_only: all 8 real reply reads (M17 calls 10-13, M19 calls 7-10) were successful empty answers, so no real reply row has ever been seen to map.
 *  - `anyapi.facebook.search_posts`: never answered with rows (one planning call was refused), so catalog_only.
 *  - `anyapi.facebook.post_comments` (ROUND 20): VERIFIED on its first real pages (msn_934781c56a01a96825af, calls 8 and 10: two posts, 4 comments each, `hasNextPage` false). Its ids are PROVEN equal to the main card's on the SAME two posts (8 of 8 comments: same id, order, text, author, instant, reaction and reply counts;
 *    `COMMENT_ID_PROOFS`, recomputed by tests/round20-facebook-alt-comments.test.ts), so it is an alternative for every account, never the main card (its catalog page costs 0.002 against the main card's 0.00188). NOT seen: a second page (no post had more than 4 comments readable), so its cursor and its real page size are unmeasured;
 *    it gives a non-empty `nextCursor` on a last page, so only `hasNextPage` says the list ended (the gateway reads it). It carries no `feedback_id` or `expansion_token`, so it cannot feed a replies step (the alternatives rule leaves it out then).
 * (constant) const M17 = "msn_6bb78c15d116268b0b9b";
 * (constant) const M19 = "msn_96beb9f7a1d937a90cd0";
 * (constant) const M20 = "msn_934781c56a01a96825af";
 * 
 * instagram (was toolCards/instagram.ts):
 * THE INSTAGRAM CARDS (data; docs/FOUNDATION-PLAN.md section 4.2, PR 3). `verified` only on real stored pages (owner decision 7.4).
 *  - `scrapecreators.instagram.user.posts` is VERIFIED on the real pages of M15 (calls 2 and 7) and M16 (call 2): 12 posts a page, each with its short code (the post link is built from it), `taken_at` in unix seconds, `comment_count`;
 *    and every real page shows `next_max_id` with `more_available true`, so the card pages by `next_max_id` (the catalog's `pagination` is empty; the real pages are the proof).
 *  - `anyapi.instagram.user.posts` (handle, cursor, comment counter, date) has never been called (0 calls ever), so it is catalog_only; it pages by `cursor`.
 *  - The comments cards are verified on real pages. Their comment rows have NO usable reply counter: `anyapi`'s `replies` field is null on every real comment row (3 pages, 15 rows) and `scrapecreators`' `child_comment_count` is null on its one
 *    real page, so the replies promise stays open and a replies read is blind (one read a comment).
 *  - `anyapi.instagram.comment_replies` is VERIFIED on the one real page that has a reply row (M16 call 17); the other 12 real reads (M16 calls 10-22) were successful «not found» answers with no rows.
 * (constant) const M15 = "msn_afe9bb0b436670e35a3c";
 * (constant) const M16 = "msn_e3e7632e2fb2d42f9c19";
 * (constant) const LINK = "https://www.instagram.com/p/{}/";
 * 
 * youtube (was toolCards/youtube.ts):
 * THE YOUTUBE CARDS (data; docs/FOUNDATION-PLAN.md section 4.3, PR 3). `verified` only on real stored pages (owner decision 7.4). The official channels are resolved FIRST, then read inside each:
 *  - `tikhub.x.youtube-web-v2-search-channels` (a keyword gives the channels, 2 a page) and `tikhub.x.youtube-web-search-channel` (the channel's own videos about the topic, 30 a page, a next page) are VERIFIED on the real pages of M2 (calls 3, 4, 6, 7).
 *    No video row of either has a comment counter (V: the real pages).
 *  - THE COUNTER: `youtube.youtube.video.detail` (free, up to 50 ids a call, `statistics.commentCount`) has never been called (0 calls ever; it needs YouTube connected on our provider account: owner decision 7.7), so it is catalog_only. A test account reads it;
 *    when it answers, the promise is the counters of the chosen videos; otherwise it is open.
 *  - COMMENTS: `crawl4ai.youtube.video.comments` is VERIFIED on the real pages of M2 and M18 (up to 500 in one call, no cursor, each comment a replies count, no reply token). `tikhub.youtube.video.comments` (the reply counter and the comment's reply token, paged by
 *    `data.continuation_token`) is VERIFIED since round 12 on the 8 real pages of the YouTube mission of live round 11; the compiler prefers it whenever a replies card can use its token, so every account reads it. Its `published_time` is a relative text in the provider's language: no date.
 *  - REPLIES: `anyapi.youtube.comment_replies` by the comment's reply token is VERIFIED since round 12 on the 3 real pages of the same mission (not seen: a thread of more than one page).
 * (constant) const M2 = "msn_ee599cdbbde993073b15";
 * (constant) const M18 = "msn_3594a5ab6311c8691f20";
 * (constant) const WATCH = "https://www.youtube.com/watch?v={}";
 * (constant) const M_R11_YT = "msn_41a73a6b2c0b4a76ef0a";
 */
export const TOOL_CARD_DATA: ReadonlyArray<ToolCard> = toolCardData as unknown as ReadonlyArray<ToolCard>;
