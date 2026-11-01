import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { replyColumnKeysOf, replyShares, replySourcesFor, buildReplyMapCode } from "../src/lib/agentMission/replies";
import { childCountOf } from "../src/lib/agentMission/childCount";
import { runInSandbox } from "../agent/src/sandbox";

/**
 * REPLIES, item 2: THE CHEAPEST RANKED REPLY SOURCE OF THE CATALOG, PER PLATFORM, and the arithmetic that never pays for a comment with no replies. The catalog is read from its snapshot (no network).
 */
const catalog = loadTregCatalog();
const all = () => true;
const sourcesOf = (commentsEndpoint: string, o: { id: boolean; url: boolean } = { id: true, url: true }) => replySourcesFor(commentsEndpoint, catalog, { isAllowed: all, videoIdAvailable: o.id, urlAvailable: o.url });

describe("the reply endpoints of the catalog, platform by platform", () => {
  it("TikTok: the sources that take a comment id with the video's id or link, direct and priced, cheapest first; the routed one is not used", () => {
    const list = sourcesOf("tikhub.tiktok.video.comments");
    const ids = list.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["anyapi.tiktok.comment_replies", "tikhub.x.tiktok-app-v3-fetch-video-comment-replies"]));
    expect(ids).not.toContain("treg.tiktok.comment.replies");
    const usd = list.map((s) => s.usd);
    expect(list[0].usd).toBe(Math.min(...usd));
    expect(list[0].id).toBe("anyapi.tiktok.comment_replies");
    expect(list[0]).toMatchObject({ commentParam: "commentId", urlParam: "url", videoIdParam: null });
  });

  it("with only the video's id (no link on the video rows) the source that needs the link is left out and the id-based one is used", () => {
    const list = sourcesOf("tikhub.tiktok.video.comments", { id: true, url: false });
    expect(list.map((s) => s.id)).not.toContain("anyapi.tiktok.comment_replies");
    // two same-price sources take (item_id, comment_id); the ranking between them is by the measured success rate, so the test names the inputs, not which of the two wins
    expect(["tikhub.x.tiktok-app-v3-fetch-video-comment-replies", "tikhub.x.tiktok-web-fetch-post-comment-reply"]).toContain(list[0].id);
    expect(list[0]).toMatchObject({ commentParam: "comment_id", videoIdParam: "item_id", urlParam: null, cursorParam: "cursor", pageSizeParam: "count" });
  });

  it("neither the id nor the link: no source (every reply source needs one of them)", () => {
    expect(sourcesOf("tikhub.tiktok.video.comments", { id: false, url: false })).toEqual([]);
  });

  it("Instagram, Douyin and Kuaishou have a source; Facebook and YouTube need a token that only the comment's own page carries, so they have none", () => {
    expect(sourcesOf("scrapecreators.instagram.post.comments").map((s) => s.id)).toEqual(expect.arrayContaining(["tikhub.x.instagram-v1-fetch-comment-replies"]));
    expect(sourcesOf("tikhub.x.douyin-web-fetch-video-comments").map((s) => s.id)).toEqual(expect.arrayContaining(["tikhub.x.douyin-web-fetch-video-comment-replies"]));
    expect(sourcesOf("tikhub.x.kuaishou-app-fetch-video-comment").map((s) => s.id)).toEqual(expect.arrayContaining(["tikhub.x.kuaishou-app-fetch-video-sub-comments"]));
    expect(sourcesOf("scrapecreators.x.v1-facebook-post-comments")).toEqual([]);
    expect(sourcesOf("scrapecreators.youtube.video.comments")).toEqual([]);
  });

  it("an endpoint the account may not buy is not offered", () => {
    const list = replySourcesFor("tikhub.tiktok.video.comments", catalog, { isAllowed: (id) => id !== "anyapi.tiktok.comment_replies", videoIdAvailable: true, urlAvailable: true });
    expect(list.map((s) => s.id)).not.toContain("anyapi.tiktok.comment_replies");
    expect(list.length).toBeGreaterThan(0);
  });
});

describe("how many replies are read for each comment", () => {
  it("a comment that says it has none gets none (nothing is paid for it); the others get what they have, up to the cap", () => {
    expect(replyShares([6, 0, 2, 40], 100, 10)).toEqual([6, 0, 2, 10]);
  });
  it("a comment with no counter at all is read up to the cap", () => {
    expect(replyShares([null, 3], 100, 10)).toEqual([10, 3]);
  });
  it("when the approved number is smaller than the need, every comment with replies gets an equal part first, never the first comment taking all of it", () => {
    const shares = replyShares([10, 10, 10, 10], 8, 10);
    expect(shares).toEqual([2, 2, 2, 2]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(8);
  });
  it("the shares never add up to more than the approved number, and a small comment's unused part goes to the others", () => {
    const shares = replyShares([1, 10, 10], 12, 10);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(12);
    expect(shares[0]).toBe(1);
    expect(shares[1] + shares[2]).toBe(11);
  });
  it("zero approved gives nothing; an empty list gives an empty list", () => {
    expect(replyShares([5, 5], 0, 10)).toEqual([0, 0]);
    expect(replyShares([], 10, 10)).toEqual([]);
  });
  it("the counter is read from the planner's own key: replies_count, reply_count, replies", () => {
    expect(childCountOf({ id: "1", replies_count: 6 })).toBe(6);
    expect(childCountOf({ id: "1", reply_count: "4" })).toBe(4);
    expect(childCountOf({ id: "1", replies: 0 })).toBe(0);
    expect(childCountOf({ id: "1", likes: 9 })).toBeNull();
  });
});

describe("the mapping code of a reply page (built by code: the replies are not measured by the model)", () => {
  const columns = [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "صاحب التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "replies_count", title_ar: "عدد الردود" }, { key: "language", title_ar: "لغة التعليق" }];

  it("finds the column keys of a comments stage by what they hold", () => {
    expect(replyColumnKeysOf(columns)).toEqual({ text: "text", author: "author", date: "posted_at", likes: "likes", replies: "replies_count", language: "language" });
  });

  it("maps the reply page of one provider (data.comments, nested user, epoch seconds)", async () => {
    const page = { data: { cursor: 5, has_more: 1, comments: [{ cid: "r1", text: "رد أول", user: { nickname: "منى" }, create_time: 1771033137, digg_count: 7, reply_comment_total: 0, comment_language: "ar", reply_id: "c9" }] } };
    const out = await runInSandbox(buildReplyMapCode(replyColumnKeysOf(columns)), { page });
    expect(out.ok).toBe(true);
    const rows = JSON.parse((out as { resultJson: string }).resultJson);
    expect(rows).toEqual([{ id: "r1", text: "رد أول", author: "منى", posted_at: "2026-02-14T01:38:57.000Z", likes: 7, replies_count: 0, language: "ar" }]);
  });

  it("maps the reply page of another provider (output.data.comments, flat fields, createdUtc)", async () => {
    const page = { output: { data: { comments: [{ id: "r2", text: "thanks", author: "sam", createdUtc: 1775065855, likes: 3 }, { id: "r3", text: "", author: "lee", createdUtc: 1775065900, likes: 0 }] } } };
    const out = await runInSandbox(buildReplyMapCode(replyColumnKeysOf(columns)), { page });
    const rows = JSON.parse((out as { resultJson: string }).resultJson);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["r2", "r3"]);
    expect(rows[0]).toMatchObject({ text: "thanks", author: "sam", likes: 3, posted_at: "2026-04-01T17:50:55.000Z" });
    expect(rows[1].text).toBe("");
  });

  it("a page with no list gives no rows, and a row with no id is not a row", async () => {
    const code = buildReplyMapCode(replyColumnKeysOf(columns));
    const empty = await runInSandbox(code, { page: { data: { has_more: 0 } } });
    expect(JSON.parse((empty as { resultJson: string }).resultJson)).toEqual([]);
    const noId = await runInSandbox(code, { page: { comments: [{ text: "x" }] } });
    expect(JSON.parse((noId as { resultJson: string }).resultJson)).toEqual([]);
  });
});
