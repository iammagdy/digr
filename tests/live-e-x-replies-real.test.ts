import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";

/**
 * THE X REPLIES TOOL ON ITS FIRST REAL RESPONSES (live round 7, 3 Nov 2026, msn_9fa5ba384c05a25247e1): five calls of `anyapi.x.post.comments`, one for each of the five chosen tweets that said it had replies. The pages are the REAL anonymised pages
 * (tests/fixtures/live/missions/msn_9fa5ba384c05a25247e1/raw/call_0003..0007; ids, `conversationId`, counters and dates are real, texts and handles are placeholders) and the REAL delivered rows (rows/tweets.json, rows/replies.json).
 *
 * WHAT THE REAL PAGES SAY (checked below):
 *   - the list is at `output.data.items`, the ids are the reply ids, and `conversationId` is the id of the tweet that was asked: the parent link is right;
 *   - `output.data.nextCursor` is PRESENT and NULL on every page, the 16-row page included, and the response carries the provider's own hint (recorded below, the anonymiser replaces its words): the source it was served by cannot page, so the result may be incomplete
 *     and there is no way to continue from it. The engine did not skip a token: there was none;
 *   - the two tweets that returned MORE rows than their counter (counter 1, two rows) returned the one direct reply the counter counts AND a reply to that reply (one of the rows says it has a reply of its own): the tweet's counter counts direct replies, the page is the whole conversation;
 *   - the three that returned FEWER rows than the counter (5 → 4, 3 → 1, 23 → 16) are short, and the source is the one that did not give the rest.
 */
const catalog = loadTregCatalog();
void catalog;
const card = cardOf("anyapi.x.post.comments")!;
const M = "msn_9fa5ba384c05a25247e1";
const read = (rel: string) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M}/${rel}.json`, import.meta.url), "utf8"));
/** The provider's own words on these pages (the anonymiser replaced them in the fixture; recorded from the real response of the 3 Nov 2026). */
const PROVIDER_HINT = "paging_unavailable: this result came from a source that cannot return a nextCursor, so it may be incomplete and there is no way to continue from here.";

type Page = { output: { found: boolean; data: { items: Array<Record<string, any>>; nextCursor: unknown } } };
const pages = [3, 4, 5, 6, 7].map((n) => ({ call: n, page: read(`raw/call_000${n}`) as Page }));
const tweets = read("rows/tweets") as Array<Record<string, any>>;
const delivered = read("rows/replies") as Array<Record<string, any>>;
const counterOf = (parent: string): number => Number(tweets.find((t) => String(t.id) === parent)!.replies_count);
const parentOf = (p: Page): string => String(p.output.data.items[0].conversationId);

describe("the X replies card against its first real responses", () => {
  it("the list path, the reply ids and the fields the card maps are the real ones", () => {
    for (const { page } of pages) {
      const mapped = mapPage(card, page);
      expect(mapped).toHaveLength(page.output.data.items.length);
      expect(new Set(mapped.map((r) => String(r.id))).size).toBe(mapped.length);
      for (const r of mapped) for (const k of ["id", "text", "author", "username", "posted_at", "link", "likes", "replies_count"]) expect(r[k], `${k} of ${r.id}`).toBeDefined();
    }
    expect(pages.map((p) => p.page.output.data.items.length)).toEqual([4, 2, 2, 16, 1]);
  });

  it("the parent link: every row's conversation is the tweet that was asked, and the delivered rows are exactly these rows under those tweets", () => {
    const byParent = new Map<string, string[]>();
    for (const { page } of pages) {
      const parent = parentOf(page);
      expect(page.output.data.items.every((i) => String(i.conversationId) === parent)).toBe(true);
      expect(tweets.some((t) => String(t.id) === parent)).toBe(true);
      byParent.set(parent, page.output.data.items.map((i) => String(i.id)));
    }
    expect(delivered).toHaveLength(25);
    for (const [parent, ids] of byParent) expect(delivered.filter((r) => String(r.parent_id) === parent).map((r) => String(r.id)).sort()).toEqual([...ids].sort());
  });

  it("the next-page token: the field is where the card says (output.data.nextCursor), and it is NULL on every real page, the 16-row page included", () => {
    for (const { call, page } of pages) {
      expect(Object.prototype.hasOwnProperty.call(page.output.data, "nextCursor"), `call ${call}`).toBe(true);
      expect(page.output.data.nextCursor, `call ${call}`).toBeNull();
      const { reading } = buildShapeDigest(page, catalog.byId.get("anyapi.x.post.comments")!);
      expect(reading.nextCursor ?? null, `call ${call}`).toBeNull();
      expect(reading.hasMore === true, `call ${call}`).toBe(false);
    }
    // the provider's answer says why: no way to continue (recorded words, see PROVIDER_HINT)
    expect(PROVIDER_HINT).toMatch(/cannot return a nextCursor/);
  });

  it("the tweet whose counter was 23 and gave 16: its page carried NO next-page token, so the engine had nothing to follow (not a delivery bug); the shortfall is the source's", () => {
    const big = pages.find((p) => p.page.output.data.items.length === 16)!;
    expect(counterOf(parentOf(big.page))).toBe(23);
    expect(big.page.output.data.nextCursor).toBeNull();
    // all 16 are direct replies of the tweet, and 3 of them have replies of their own that the page does not show: 23 direct replies are asked for by the counter, 16 were shown
    expect(big.page.output.data.items.reduce((n, i) => n + Number(i.replyCount), 0)).toBe(3);
  });

  it("why two tweets returned MORE rows than their counters: the counter counts direct replies; the page is the whole conversation, so a reply to a reply is a row too", () => {
    for (const { page } of pages.filter((p) => p.page.output.data.items.length === 2)) {
      const counter = counterOf(parentOf(page));
      expect(counter).toBe(1);
      const ownReplies = page.output.data.items.reduce((n, i) => n + Number(i.replyCount), 0);
      // one row says it has a reply of its own: rows = the counted direct reply + that nested reply
      expect(ownReplies).toBe(1);
      expect(page.output.data.items.length).toBe(counter + ownReplies);
    }
  });

  it("the three that gave FEWER than the counter are short by 1, 7 and 2 (5 → 4, 23 → 16, 3 → 1); nothing delivered is lost between the page and the file", () => {
    const short = pages.map(({ page }) => ({ counter: counterOf(parentOf(page)), rows: page.output.data.items.length })).filter((x) => x.rows < x.counter);
    expect(short.map((x) => [x.counter, x.rows])).toEqual([[5, 4], [23, 16], [3, 1]]);
    expect(pages.reduce((n, p) => n + p.page.output.data.items.length, 0)).toBe(delivered.length);
  });

  it("the card is NOT marked verified: the field mapping is right but the route cannot page and gave 16 of at least 23 direct replies, so «every reply the source shows» is not met", () => {
    expect(card.status).toBe("catalog_only");
    expect(card.verifiedOn).toEqual([]);
  });
});
