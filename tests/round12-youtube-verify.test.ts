import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { checkCardOnPage } from "../src/lib/agentMission/foundation/toolCards/verify";
import { replayGateway } from "./helpers/replayGateway";

/**
 * ROUND 12, item 1 (3 Nov 2026): VERIFY `tikhub.youtube.video.comments` AND `anyapi.youtube.comment_replies` ON THE REAL PAGES of the YouTube mission of live round 11 (msn_41a73a6b2c0b4a76ef0a, the owner's admin ZIP, anonymised with anonymise.py).
 * What the real pages show (read in the stored call log and the pages): the comments tool answers `data.comments` (20 a page), each with `comment_id`, `content`, `reply_count` and `like_count` AS TEXT («"1"»), a `reply_continuation_token` on a comment that has replies (3 of 123 comments), and `data.continuation_token` for the next page (null on the last: 8 calls, five chained on the first video); its `published_time` is a RELATIVE TEXT IN CHINESE («11个月前»: the provider answers in its own language), which the
 * mapping wrote as the comment's date (every delivered comment of the live file had «11个月前» in «تاريخ ووقت التعليق»). The replies tool answers `output.data.comments` (1, 1 and 2 rows for the three comments whose counters said 1, 1 and 2), each reply's `id` is `<comment id>.<reply id>`, `createdUtc` is a real instant, and `nextCursor` is an empty text on the last (and only) page of each.
 */
const catalog = loadTregCatalog();
void catalog;
const M = "msn_41a73a6b2c0b4a76ef0a";
const raw = (n: number) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M}/raw/call_${String(n).padStart(4, "0")}.json`, import.meta.url), "utf8"));
const index = JSON.parse(readFileSync(new URL("./fixtures/live/call-index.json", import.meta.url), "utf8")) as { missions: Record<string, Array<[string, string, string, string, number, Record<string, unknown>]>> };
const log = (n: number) => index.missions[M].find((c) => c[0] === `call_${String(n).padStart(4, "0")}`)!;
const COMMENT_CALLS = [6, 7, 8, 9, 10, 11, 12, 13];
const REPLY_CALLS = [14, 15, 16];
const comments = cardOf("tikhub.youtube.video.comments")!;
const replies = cardOf("anyapi.youtube.comment_replies")!;

describe("tikhub.youtube.video.comments on the real pages", () => {
  it("the list path, the ids, the counter and the next-page field map on every real page (the card's own check finds no issue)", () => {
    for (const n of COMMENT_CALLS) {
      const check = checkCardOnPage(comments, raw(n));
      expect(check.issues, `call ${n}`).toEqual([]);
      expect(check.rows.length, `call ${n}`).toBe(log(n)[4]);
      for (const r of check.rows) { expect(r.id).toMatch(/^Ug/); expect(typeof r.replies_count).toBe("number"); }
    }
  });
  it("a comment that has replies carries its reply token (3 of 123 do), the others carry none", () => {
    const rows = COMMENT_CALLS.flatMap((n) => mapPage(comments, raw(n)));
    expect(rows).toHaveLength(123);
    const withReplies = rows.filter((r) => Number(r.replies_count) > 0);
    expect(withReplies.length).toBe(3);
    for (const r of withReplies) expect(typeof r.reply_continuation_token).toBe("string");
    for (const r of rows.filter((x) => Number(x.replies_count) === 0)) expect(r.reply_continuation_token).toBeUndefined();
  });
  it("the next-page token is `data.continuation_token`, and each call asked for exactly the token the page before it gave (calls 8 to 12 are one chain; the last page has none)", () => {
    const chain = [8, 9, 10, 11, 12];
    for (let i = 1; i < chain.length; i += 1) {
      const given = String(raw(chain[i - 1]).data.continuation_token);
      expect(given.startsWith(String(log(chain[i])[5].continuation_token)), `call ${chain[i]}`).toBe(true);
      expect(log(chain[i])[5].video_id).toBe("gCut2DcB9sM");
    }
    expect(raw(12).data.continuation_token).toBeNull();
    expect(raw(7).data.continuation_token).toBeNull();
    expect(raw(13).data.continuation_token).toBeNull();
  });
  it("the parent link is the video's own id (`video_id`), echoed by the page", () => {
    expect(comments.inputs.parent).toEqual({ param: "video_id", from: "id" });
    for (const n of COMMENT_CALLS) expect(raw(n).params.video_id).toBe(String(log(n)[5].video_id));
  });
  // CHANGED (round 13): the MAPPING now keeps the source's relative text as it wrote it (the engine's ingest reads it against the moment of the read, or empties it and counts it: tests/round13-youtube-dates.test.ts, which replays the real pages and shows that no delivered cell holds the foreign words). What round 12 pinned still holds at the delivered cell: a comment's date is never the provider's relative text.
  it("a comment's date is never the provider's relative text in the DELIVERED cell: the mapping carries the text, the stage is flagged to read it, and ingest empties what it cannot read", () => {
    const rows = COMMENT_CALLS.flatMap((n) => mapPage(comments, raw(n)));
    for (const r of rows) expect(r.posted_at === null || r.posted_at === undefined || typeof r.posted_at === "string", String(r.posted_at)).toBe(true);
    expect(comments.mapping).toMatchObject({ kind: "replies", relativeDates: true });
  });
});

describe("anyapi.youtube.comment_replies on the real pages", () => {
  it("the list path, the reply ids, the dates and the end of the pages map; the three pages hold 1, 1 and 2 replies", () => {
    const counts = REPLY_CALLS.map((n) => { const c = checkCardOnPage(replies, raw(n)); expect(c.issues, `call ${n}`).toEqual([]); return c.rows.length; });
    expect(counts).toEqual([1, 1, 2]);
    for (const n of REPLY_CALLS) for (const r of mapPage(replies, raw(n))) { expect(r.id).toMatch(/^Ug.+\.[A-Za-z0-9_-]+/); expect(String(r.posted_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/); }
  });
  it("each call asked with the reply token of one comment, and the replies it got are that comment's (the counters 1, 1 and 2 are the delivered rows)", () => {
    const withReplies = COMMENT_CALLS.flatMap((n) => mapPage(comments, raw(n))).filter((r) => Number(r.replies_count) > 0);
    expect(withReplies.map((r) => r.replies_count)).toEqual([1, 1, 2]);
    REPLY_CALLS.forEach((n, i) => {
      const parent = withReplies[i];
      expect(String(parent.reply_continuation_token).startsWith(String(log(n)[5].continuationToken)), `call ${n}`).toBe(true);
      for (const r of mapPage(replies, raw(n))) expect(String(r.id).startsWith(`${parent.id}.`)).toBe(true);
      expect(mapPage(replies, raw(n)).length).toBe(Number(parent.replies_count));
    });
  });
  it("the end of a reply thread is an empty `nextCursor` (not null): the engine's stop test reads it as the end", () => {
    for (const n of REPLY_CALLS) expect(raw(n).output.data.nextCursor).toBe("");
  });
});

describe("both cards are VERIFIED on these pages (and a customer's account uses them)", () => {
  it("status verified, with exactly the real calls", () => {
    expect(comments.status).toBe("verified");
    expect(comments.verifiedOn).toEqual([{ mission: M, calls: COMMENT_CALLS.map((n) => `call_${String(n).padStart(4, "0")}`) }]);
    expect(replies.status).toBe("verified");
    expect(replies.verifiedOn).toEqual([{ mission: M, calls: REPLY_CALLS.map((n) => `call_${String(n).padStart(4, "0")}`) }]);
  });
  it("the plan of the live request on the real pages, for an account that is NOT a test account: the videos of the two clubs, the comments tool with the reply tokens, and the replies step", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
    const request = "هات فيديوهين على يوتيوب عن نهائي السوبر المصري الأهلي والزمالك من القنوات الرسمية، مع كل التعليقات والردود.";
    void fixture;
    const store = createMemoryStore();
    const { gateway } = replayGateway(M, catalog, store, "msn_r12_yt", { only: { "tikhub.x.youtube-web-search-channel": ["channel_id"] } });
    const out = await planByCompiler({ mission: { id: "msn_r12_yt", request_text: request, answer_text: null, created_at: "2026-11-03T13:38:44Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-03T13:39:44Z"), occurrence: { kind: "latest" } });
    if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}${"reason" in out ? ` ${out.reason}` : ""}`);
    const byKey = Object.fromEntries(out.plan.stages.map((s) => [s.key, s.endpoint_id]));
    expect(byKey.comments).toBe("tikhub.youtube.video.comments");
    expect(byKey.comments_replies).toBe("anyapi.youtube.comment_replies");
    expect(out.plan.unserved_steps ?? []).toEqual([]);
    expect(out.plan.stages.find((s) => s.key === "comments")!.carry_keys).toEqual(["reply_continuation_token"]);
  }, 60_000);
});
