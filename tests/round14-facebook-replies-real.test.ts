import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { checkCardOnPage } from "../src/lib/agentMission/foundation/toolCards/verify";

/**
 * ROUND 14, part C: `anyapi.facebook.comment_replies` ON THE REAL PAGES of live round 12 (msn_236f4af6fe4cb890abee, the owner's admin ZIP, anonymised): 36 calls, calls 46 to 81, one per comment that has replies, 95 rows (the first run in which a Facebook replies tool ever returned rows).
 * The comments pages are calls 8 to 45 (tool `scrapecreators.x.v1-facebook-post-comments`, 38 calls, 366 rows).
 */
const M = "msn_236f4af6fe4cb890abee";
const raw = (n: number) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M}/raw/call_${String(n).padStart(4, "0")}.json`, import.meta.url), "utf8"));
const index = JSON.parse(readFileSync(new URL("./fixtures/live/call-index.json", import.meta.url), "utf8")) as { missions: Record<string, Array<[string, string, string, string, number, Record<string, unknown>]>> };
const log = (n: number) => index.missions[M].find((c) => c[0] === `call_${String(n).padStart(4, "0")}`)!;
const REPLY_CALLS = Array.from({ length: 36 }, (_, i) => 46 + i);
const COMMENT_CALLS = Array.from({ length: 38 }, (_, i) => 8 + i);
const card = cardOf("anyapi.facebook.comment_replies")!;

describe("the replies pages of live round 12 map on the card", () => {
  it("the list path, the ids and the next-page field are where the card says, on all 36 pages (the card's own check finds no issue)", () => {
    for (const n of REPLY_CALLS) { const c = checkCardOnPage(card, raw(n)); expect(c.issues, `call ${n}`).toEqual([]); expect(c.rows.length, `call ${n}`).toBe(log(n)[4]); }
  });
  it("95 reply rows in 36 calls: 2.64 rows a call, at most 7 in one, none empty; every reply id is unique", () => {
    const rows = REPLY_CALLS.flatMap((n) => mapPage(card, raw(n)));
    expect(rows).toHaveLength(95);
    expect(new Set(rows.map((r) => r.id)).size).toBe(95);
    const per = REPLY_CALLS.map((n) => mapPage(card, raw(n)).length);
    expect(Math.max(...per)).toBe(7);
    expect(Math.min(...per)).toBe(1);
    expect(Number((95 / 36).toFixed(2))).toBe(2.64);
    for (const r of rows) { expect(typeof r.text).toBe("string"); expect(String(r.posted_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/); }
  });
  it("each call asked with the two tokens of one comment (feedback id and expansion token, the first 80 characters the log keeps), in the order of the comments that have replies", () => {
    const parents = COMMENT_CALLS.flatMap((n) => raw(n).comments as Array<Record<string, unknown>>).filter((c) => Number(c.reply_count) > 0 && c.feedback_id);
    expect(parents).toHaveLength(36);
    REPLY_CALLS.forEach((n, i) => {
      const input = log(n)[5];
      expect(String(parents[i].feedback_id).startsWith(String(input.feedbackId)), `call ${n}`).toBe(true);
      expect(String(parents[i].expansion_token).startsWith(String(input.expansionToken)), `call ${n}`).toBe(true);
    });
    expect(card.inputs.parent).toEqual({ param: "feedbackId", from: "feedback_id", also: [{ param: "expansionToken", from: "expansion_token" }] });
  });
  it("the reply counters of the comments against the rows: 100 counted, 95 returned (four comments gave fewer than their counters: 4 for 3, 6 for 5, 7 for 6, 8 for 6)", () => {
    const parents = COMMENT_CALLS.flatMap((n) => raw(n).comments as Array<Record<string, unknown>>).filter((c) => Number(c.reply_count) > 0 && c.feedback_id);
    expect(parents.reduce((n, c) => n + Number(c.reply_count), 0)).toBe(100);
    const got = REPLY_CALLS.map((n) => mapPage(card, raw(n)).length);
    expect(got.reduce((a, b) => a + b, 0)).toBe(95);
    expect(parents.map((c, i) => [Number(c.reply_count), got[i]]).filter(([a, b]) => a !== b)).toEqual([[4, 3], [6, 5], [7, 6], [8, 6]]);
  });
  it("the next-page field is a text on every page while `hasNextPage` is false: the page says it is the last, the engine stopped after one call per comment", () => {
    for (const n of REPLY_CALLS) { const d = raw(n).output.data; expect(d.hasNextPage, `call ${n}`).toBe(false); expect(typeof d.nextCursor).toBe("string"); }
    expect(card.page.cursor).toEqual(["output", "data", "nextCursor"]);
  });
});

describe("the card is verified on these pages, with the measured rows a page", () => {
  it("status verified, with exactly the real calls", () => {
    expect(card.status).toBe("verified");
    expect(card.verifiedOn).toEqual([{ mission: M, calls: REPLY_CALLS.map((n) => `call_${String(n).padStart(4, "0")}`) }]);
  });
  it("observed rows a page is the measured 95 / 36, rounded down to 2.6 (never above what the pages gave)", () => {
    expect(card.page.observedRowsPerPage).toBe(2.6);
    expect(card.costUsdPerPage / card.page.observedRowsPerPage).toBeCloseTo(0.0012 / 2.6, 8);
  });
  it("the other replies tool, never used, stays catalog_only", () => {
    expect(cardOf("scrapecreators.x.v1-facebook-post-comment-replies")!.status).toBe("catalog_only");
  });
});
