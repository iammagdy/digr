import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { commentsEngineByCode } from "../src/lib/agentMission/pageableComments";
import { runInSandbox } from "../agent/src/sandbox";

/** S3: the comments stage's recipe written by code from the tool's own schema (the live stage had none and the mission ran on the old pipeline). */
const catalog = loadTregCatalog();
const COLUMNS = [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "صاحب التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "replies_count", title_ar: "عدد الردود" }, { key: "language", title_ar: "لغة التعليق" }];
const parent = { columns: [{ key: "link", title_ar: "رابط الفيديو" }], engine: { built_by: "code" } as never };
const of = (endpoint_id: string, p: unknown = parent) => commentsEngineByCode({ endpoint_id, columns: COLUMNS, parent_key: "videos" }, p as never, catalog);

describe("the comments recipe by code", () => {
  it("crawl4ai (`post`: the post's URL or id): the video's id; no next page", () => {
    expect(of("crawl4ai.tiktok.video.comments")).toMatchObject({ endpoint_id: "crawl4ai.tiktok.video.comments", cursor_param: null, parent_binding: { param: "post", from: "id" }, built_by: "code" });
  });
  it("tikhub (`aweme_id`): the video's id and the tool's cursor", () => {
    expect(of("tikhub.tiktok.video.comments")).toMatchObject({ cursor_param: "cursor", parent_binding: { param: "aweme_id", from: "id" } });
  });
  it("anyapi (`url`): the video's link column, and the cursor", () => {
    expect(of("anyapi.tiktok.video.comments")).toMatchObject({ cursor_param: "cursor", parent_binding: { param: "url", from: "link" } });
  });
  it("no recipe when the parent was not built by code, the tool is not a comments tool, or a required input is not the video's", () => {
    expect(of("tikhub.tiktok.video.comments", { ...parent, engine: { built_by: "model" } })).toBeNull();
    expect(of("tikhub.tiktok.search.videos")).toBeNull();
    expect(of("brightdata.x.tiktok-comments")).toBeNull();
    expect(of("anyapi.tiktok.video.comments", { columns: [], engine: { built_by: "code" } })).toBeNull();
  });
  it("the mapping it writes reads a page of the schema's shape into the stage's columns (every row, keyed by the comment's own id)", async () => {
    const e = of("tikhub.tiktok.video.comments")!;
    const page = { data: { comments: [{ cid: "c1", text: "أهلا", user: { nickname: "u" }, create_time: 1788100000, digg_count: 3, reply_comment_total: 2, comment_language: "ar" }, { cid: "c2", text: "x", user: { nickname: "v" }, create_time: 1788100001, digg_count: 0, reply_comment_total: 0, comment_language: "en" }], cursor: 2, has_more: 0 } };
    const out = await runInSandbox(e.map_code, { page });
    expect(out.ok).toBe(true);
    const rows = JSON.parse((out as { resultJson: string }).resultJson);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "c1", text: "أهلا", author: "u", likes: 3, replies_count: 2, language: "ar" });
  });
});
