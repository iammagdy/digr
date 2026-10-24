import { describe, expect, it } from "vitest";
import { facebookReportWorld, runReportJob, postUrl, DAY_MS, REPORT_PARAMS, COMMENTS_CALL_MICRO, PAGE_CALL_MICRO, type WorldPage, type WorldPost } from "./helpers/fakeFacebookReport";
import { FACEBOOK_PAGE_REGISTRY } from "../src/lib/facebookReport/registry";
import { PER_PUBLISHER_MAX_SHARE } from "../src/lib/facebookReport/constants";
import { concentrationOf } from "../src/lib/facebookReport/publishers";

/**
 * The collector of the Facebook topic report, run chunk by chunk against FAKE sources (no provider, no model, no SQL). The world follows the owner's run: the seeded Pages of the
 * Egypt health registry, a Ministry Page whose address is not a valid Page (it answers «not found»), posts newest first, some of them outside the window.
 */
const END = Date.parse("2026-10-23T12:00:00Z");
const urls = Object.fromEntries(FACEBOOK_PAGE_REGISTRY.map((entry) => [entry.id, entry.url]));
const usableIds = ["eg_health_el_consolto", "eg_health_drug_authority", "eg_health_medical_syndicate", "eg_health_cairo24", "eg_health_masrawy"];

/** `count` posts newest first, one per day from `startMs` going back; every `video`-th is a video. */
function posts(count: number, startMs = END, step = 1, from = 0, extra: Partial<WorldPost> = {}): WorldPost[] {
  return Array.from({ length: count }, (_, i) => ({ n: from + i, dateMs: startMs - i * step * DAY_MS, reactions: 20 + i, comments: 8, shares: 2, text: `منشور ${from + i} عن الصحة والأدوية`, ...extra }));
}
const page = (id: string, list: WorldPost[], mode: WorldPage["mode"] = "ok"): WorldPage => ({ url: urls[id], posts: list, mode, perCall: 3 });
const fullWorld = (each = 60) => facebookReportWorld({ pages: usableIds.map((id) => page(id, posts(each))) });

describe("the collector: round-robin over vetted Pages", () => {
  it("reads a few pages of each Page in turn, never one Page to exhaustion, and every usable Page is read", async () => {
    const world = fullWorld();
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 20, perVideo: 2 }, target: 40 });
    const order = world.asked.filter((entry) => entry.endpoint === "anyapi.facebook.user.posts").map((entry) => entry.params.url);
    // the first reads are two pages of the first Page, two of the second, ... (POST_PAGES_PER_PAGE_PER_ROUND = 2), never six of one Page in a row
    expect(order.slice(0, 4)).toEqual([urls.eg_health_el_consolto, urls.eg_health_el_consolto, urls.eg_health_drug_authority, urls.eg_health_drug_authority]);
    let longest = 1;
    let streak = 1;
    for (let i = 1; i < order.length; i++) { streak = order[i] === order[i - 1] ? streak + 1 : 1; longest = Math.max(longest, streak); }
    expect(longest).toBeLessThanOrEqual(2);
    expect(new Set(order).size).toBe(5);
    expect(run.final.posts.length).toBe(20);
  });

  it("no single Page supplies more than 20% of the delivered posts, whatever the Pages hold (the Consolto case)", async () => {
    // the audit: one Page held 74% of the file. Here one Page has 225 posts in the window and the others 20 each.
    const world = facebookReportWorld({ pages: [page("eg_health_el_consolto", posts(225, END, 0.4)), ...usableIds.slice(1).map((id) => page(id, posts(20)))] });
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 100, perVideo: 1 }, target: 100 });
    const rows = concentrationOf(run.final.posts);
    expect(run.final.posts).toHaveLength(100);
    for (const row of rows) expect(row.share).toBeLessThanOrEqual(PER_PUBLISHER_MAX_SHARE + 1e-9);
    expect(rows[0].posts).toBe(20);
    // nothing is read from the big Page beyond what its share needs: it had 225 and 20 are delivered, the pages read are far fewer than its 75
    const consoltoReads = world.asked.filter((entry) => entry.params.url === urls.eg_health_el_consolto && entry.endpoint === "anyapi.facebook.user.posts").length;
    expect(consoltoReads).toBeLessThanOrEqual(10);
  });

  it("validates each Page with its first call: «not found», no posts (a personal profile) and a refusing source are skipped, counted, and the others are read", async () => {
    const world = facebookReportWorld({ pages: [
      page("eg_health_el_consolto", posts(60)),
      page("eg_health_drug_authority", [], "not_found"),
      page("eg_health_medical_syndicate", [], "empty"),
      page("eg_health_cairo24", posts(60)),
      page("eg_health_masrawy", posts(60)),
    ] });
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 12, perVideo: 2 }, target: 24 });
    const byId = Object.fromEntries(run.final.pages.map((p) => [p.id, p]));
    expect(byId.eg_health_drug_authority.status).toBe("skipped");
    expect(byId.eg_health_drug_authority.end).toBe("not_found");
    expect(byId.eg_health_medical_syndicate.status).toBe("skipped");
    expect(byId.eg_health_medical_syndicate.end).toBe("empty");
    // a skipped Page was called exactly once (its validation), never again
    expect(world.asked.filter((entry) => entry.params.url === urls.eg_health_drug_authority)).toHaveLength(1);
    expect(world.asked.filter((entry) => entry.params.url === urls.eg_health_medical_syndicate)).toHaveLength(1);
    // the Ministry Page of the registry is flagged invalid: never called at all, but counted
    expect(world.asked.some((entry) => entry.params.url === urls.eg_health_mohp)).toBe(false);
    expect(run.final.skippedRegistry.map((entry) => entry.id)).toEqual(["eg_health_mohp"]);
    expect(run.final.posts.length).toBeGreaterThan(0);
  });

  it("stops a Page when its posts go older than the window, and counts the posts it dropped per Page", async () => {
    // 40 posts: 10 inside the window (the last 10 days), then 30 older than the window start (2026-07-24)
    const list = [...posts(6), ...posts(30, Date.parse("2026-07-20T10:00:00Z"), 1, 10)];
    const world = facebookReportWorld({ pages: [page("eg_health_el_consolto", list), ...usableIds.slice(1).map((id) => page(id, posts(6)))] });
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 40, perVideo: 1 }, target: 40 });
    const consolto = run.final.pages.find((p) => p.id === "eg_health_el_consolto")!;
    expect(consolto.end).toBe("older");
    expect(consolto.kept).toBe(6);
    expect(run.final.stats.perPage.eg_health_el_consolto.outside).toBeGreaterThan(0);
    // it was not read to the end of its 40 posts: 14 calls would be needed for that
    expect(world.asked.filter((entry) => entry.params.url === urls.eg_health_el_consolto && entry.endpoint === "anyapi.facebook.user.posts").length).toBeLessThan(13);
  });

  it("the window is EXACT: a post one millisecond outside is dropped and counted, and so is a post with no date; the oldest and newest delivered posts are reported", async () => {
    const edge: WorldPost[] = [
      { n: 1, dateMs: Date.parse("2026-10-24T23:59:59.999Z"), text: "داخل النهاية" },
      { n: 2, dateMs: Date.parse("2026-10-25T00:00:00.000Z"), text: "بعد النهاية بجزء من الثانية" },
      { n: 3, dateMs: Date.parse("2026-07-24T00:00:00.000Z"), text: "داخل البداية" },
      { n: 4, dateMs: Date.parse("2026-07-23T23:59:59.999Z"), text: "قبل البداية بجزء من الثانية" },
    ];
    const world = facebookReportWorld({ pages: usableIds.map((id, i) => page(id, i === 0 ? edge : posts(4, END - 5 * DAY_MS, 1, 100 * (i + 1)))) });
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 24, perVideo: 1 }, target: 24 });
    const first = run.final.stats.perPage.eg_health_el_consolto;
    expect(first.seen).toBe(4);
    expect(first.kept).toBe(2);
    expect(first.outside).toBe(2);
    const keptDates = run.final.posts.filter((p) => p.pageId === "eg_health_el_consolto").map((p) => new Date(p.publishedAtMs!).toISOString()).sort();
    expect(keptDates).toEqual(["2026-07-24T00:00:00.000Z", "2026-10-24T23:59:59.999Z"]);
    expect(run.final.stats.oldestKeptMs).toBe(Date.parse("2026-07-24T00:00:00.000Z"));
    expect(run.final.stats.newestKeptMs).toBe(Date.parse("2026-10-24T23:59:59.999Z"));
  });

  it("a post with no readable date is never kept (it cannot be shown to be inside the window)", async () => {
    const world = facebookReportWorld({ pages: usableIds.map((id) => ({ url: urls[id], posts: posts(6), perCall: 3 })) });
    const original = world.call;
    // strip the date from one Page's answers
    const run = await runReportJob({ world: { ...world, call: async (source: any, params: any, ctx: any) => { const out: any = await original(source, params, ctx); if (params.url === urls.eg_health_cairo24 && out.data?.rows) out.data.rows = out.data.rows.map((row: any) => ({ ...row, createdUtc: undefined })); return out; } } as any, params: { ...REPORT_PARAMS, videoCount: 20, perVideo: 1 }, target: 20 });
    expect(run.final.stats.perPage.eg_health_cairo24.undated).toBeGreaterThan(0);
    expect(run.final.stats.perPage.eg_health_cairo24.kept).toBe(0);
    expect(run.final.posts.some((p) => p.pageId === "eg_health_cairo24")).toBe(false);
  });

  it("duplicates are removed by the post's link (the same post from two Pages is one post) and counted", async () => {
    const shared = posts(3);
    const world = facebookReportWorld({ pages: usableIds.map((id, i) => page(id, i < 2 ? shared.map((p) => ({ ...p })) : posts(10, END, 1, 500 * i))) });
    // both first Pages return posts 0..2 under their OWN slug: different links, so patch the answers to the same link
    const original = world.call;
    const run = await runReportJob({ world: { ...world, call: async (source: any, params: any, ctx: any) => { const out: any = await original(source, params, ctx); if (out.data?.rows && (params.url === urls.eg_health_el_consolto || params.url === urls.eg_health_drug_authority)) out.data.rows = out.data.rows.map((row: any) => ({ ...row, url: postUrl("shared", row.post_id.split("_").pop()) })); return out; } } as any, params: { ...REPORT_PARAMS, videoCount: 24, perVideo: 1 }, target: 24 });
    expect(run.final.duplicates).toBeGreaterThanOrEqual(3);
    expect(new Set(run.final.posts.map((p) => p.key)).size).toBe(run.final.posts.length);
  });
});

describe("the collector: the keyword search is a small supplement", () => {
  it("is not called at all when the Pages fill the target", async () => {
    const world = fullWorld();
    await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 20, perVideo: 1 }, target: 20 });
    expect(world.count("justoneapi.x.facebook-search-post-v1")).toBe(0);
  });

  it("fills only what the Pages could not: at most 15% of the target, a few calls, and only posts that show they belong to the country", async () => {
    const searchPosts: WorldPost[] = [
      ...posts(8, END - 2 * DAY_MS, 1, 900, { author: "صفحة طبية", text: "نصائح صحية من مصر عن التغذية والقلب" }),
      ...posts(8, END - 3 * DAY_MS, 1, 950, { author: "الدليل الطبي السوري", text: "نصائح صحية من سوريا لأهل دمشق" }),
      ...posts(8, END - 4 * DAY_MS, 1, 980, { author: "صفحة بلا بلد", text: "نصائح صحية عامة" }),
    ];
    // two Pages are down, so the three others cannot fill 60 posts under the cap: the search supplements
    const world = facebookReportWorld({ pages: [page("eg_health_el_consolto", posts(5)), page("eg_health_drug_authority", [], "not_found"), page("eg_health_medical_syndicate", [], "not_found"), page("eg_health_cairo24", posts(5)), page("eg_health_masrawy", posts(5))], search: { posts: searchPosts, perCall: 6 } });
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 60, perVideo: 1 }, target: 60 });
    const fromSearch = run.final.posts.filter((p) => p.source === "search");
    expect(fromSearch.length).toBeGreaterThan(0);
    expect(fromSearch.length).toBeLessThanOrEqual(Math.floor(60 * 0.15));
    expect(run.final.search.calls).toBeLessThanOrEqual(4);
    // the Syrian page and the page with no country evidence are not counted as Egyptian
    expect(fromSearch.every((p) => p.publisher === "صفحة طبية")).toBe(true);
    expect(run.final.search.rejectedCountry).toBeGreaterThan(0);
    expect(run.final.search.costMicro / 1e6).toBeLessThanOrEqual(0.27);
  });
});

describe("the collector: comments", () => {
  it("reads the highest-engagement posts first, up to 3 comment pages for a high-engagement post and 1 otherwise, and never judges a comment", async () => {
    // 20 posts; post 0 of the first Page is the viral one (500 reactions, 80 comments claimed); 25 comments are available under every post
    const list = posts(4).map((p, i) => ({ ...p, reactions: i === 0 ? 500 : 3 + i, comments: i === 0 ? 80 : 4 }));
    const world = facebookReportWorld({
      pages: usableIds.map((id, k) => page(id, k === 0 ? list : posts(4, END - DAY_MS, 1, 100 * (k + 1), { reactions: 3, comments: 4 }))),
      commentsOf: (url) => Array.from({ length: 25 }, (_, i) => ({ comment_id: `${url.slice(-12)}_${i}`, text: i === 0 ? "👍" : i === 1 ? "شكرا" : `تعليق ${i}`, author: `قارئ ${i}` })),
    });
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 20, perVideo: 30 }, target: 600 });
    const reads = world.asked.filter((entry) => entry.endpoint === "scrapecreators.x.v1-facebook-post-comments");
    const viral = postUrl("ElConsolto", 0);
    // the viral post (highest engagement) is read first, with 3 pages
    expect(reads[0].params.url).toBe(viral);
    expect(reads.filter((entry) => entry.params.url === viral)).toHaveLength(3);
    // the posts in the top 20% by engagement may use up to 3 pages; every other post exactly ONE page
    const ranked = [...run.final.posts].sort((a, b) => (b.reactions + b.comments + b.shares) - (a.reactions + a.comments + a.shares));
    const highKeys = new Set(ranked.slice(0, Math.ceil(ranked.length * 0.2)).map((p) => p.url));
    for (const post of run.final.posts) {
      const pages = reads.filter((entry) => entry.params.url === post.url).length;
      if (highKeys.has(post.url)) expect(pages).toBeLessThanOrEqual(3);
      else expect(pages).toBe(1);
    }
    // no comment is judged: the one-emoji and the one-word comments are delivered
    const texts = run.rows.map((row) => row.text);
    expect(texts).toContain("👍");
    expect(texts).toContain("شكرا");
    // the viral post gave 25 comments over its 3 pages (the source had 25)
    expect(run.rows.filter((row) => row.video_url === viral)).toHaveLength(25);
  });

  it("removes only empty comments, exact duplicates (pagination overlap) and link-only comments, and counts each", async () => {
    const world = facebookReportWorld({
      pages: usableIds.map((id, k) => page(id, posts(2, END, 1, 100 * k, { comments: 30 }))),
      commentsOf: (url) => [
        { comment_id: "a", text: "تعليق أول", author: "أحمد" }, { comment_id: "a", text: "تعليق أول", author: "أحمد" },
        { comment_id: "b", text: "   ", author: "منى" },
        { comment_id: "c", text: "https://example.com/x", author: "علي" },
        { comment_id: "d", text: "اطلع على https://example.com/x وأخبرني", author: "سلمى" },
        { comment_id: "e", text: "👍🏽", author: "نور" },
      ].map((row) => ({ ...row, comment_id: `${url.slice(-10)}_${row.comment_id}` })),
    });
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 10, perVideo: 10 }, target: 100 });
    const perPost = run.rows.filter((row) => row.video_url === postUrl("ElConsolto", 0)).map((row) => row.text);
    expect(perPost).toEqual(["تعليق أول", "اطلع على https://example.com/x وأخبرني", "👍🏽"]);
    expect(run.final.comments.empty).toBe(10);
    expect(run.final.comments.duplicates).toBe(10);
    expect(run.final.comments.linkOnly).toBe(10);
  });

  it("stops at the comment target, and the delivered rows are never above it", async () => {
    const world = facebookReportWorld({ pages: usableIds.map((id) => page(id, posts(30, END, 1, 0, { comments: 20 }))) });
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 20, perVideo: 10 }, target: 37 });
    expect(run.rows.length).toBe(37);
    expect(run.final.comments.stopped).toBe("target");
  });

  it("the stall guard: a source that returns no comment for 36 posts in a row ends the reading (nothing more is paid for)", async () => {
    const world = facebookReportWorld({ pages: usableIds.map((id, k) => page(id, posts(40, END, 0.5, 100 * k))), noComments: () => true });
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 100, perVideo: 5 }, target: 500 });
    expect(run.rows).toHaveLength(0);
    expect(run.final.comments.stopped).toBe("stall");
    expect(world.count("scrapecreators.x.v1-facebook-post-comments")).toBe(36);
  });

  it("a Page whose comments call fails is left, the job goes on", async () => {
    const world = fullWorld(10);
    const original = world.call;
    const run = await runReportJob({ world: { ...world, call: async (source: any, params: any, ctx: any) => (source.endpointId === "scrapecreators.x.v1-facebook-post-comments" && /ElConsolto/.test(String(params.url)) ? { ok: false, httpStatus: 500, data: null, costMicro: 0, tregCallId: "x", errorCode: "http_500", errorMessageAr: "تعذر" } : original(source, params, ctx)) } as any, params: { ...REPORT_PARAMS, videoCount: 10, perVideo: 5 }, target: 50 });
    expect(run.rows.length).toBeGreaterThan(0);
    expect(run.rows.some((row) => /ElConsolto/.test(row.video_url))).toBe(false);
  });
});

describe("the collector: judgment of the posts", () => {
  const axisWorld = (texts: string[]) => facebookReportWorld({ pages: usableIds.map((id, k) => page(id, texts.slice(k * 4, k * 4 + 4).map((text, i) => ({ n: 100 * k + i, dateMs: END - i * DAY_MS, text, comments: 3 })))) });
  const mixed = [
    ...Array.from({ length: 20 }, (_, i) => `رأي ${i}: كلام عام لا يخص أي محور صحي محدد (${i})`),
  ];

  it("the rules place the clear posts and ONE model call per 50 posts handles only the ambiguous ones", async () => {
    const world = axisWorld(mixed);
    const calls: Array<{ size: number }> = [];
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 20, perVideo: 1 }, target: 400, axisModel: async ({ posts }) => { calls.push({ size: posts.length }); return { ok: true, axes: Object.fromEntries(posts.map((p) => [p.i, "mental_health"])), usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.004, model: "claude-haiku-5-5", latencyMs: 10 } }; } });
    expect(calls.length).toBe(1);
    expect(calls[0].size).toBe(20);
    expect(run.final.classify.modelCalls).toBe(1);
    expect(run.final.posts.every((post) => post.axis === "mental_health" && post.axisBy === "model")).toBe(true);
  });

  it("a digestive post is never filed under the heart, whatever the model says it is never asked about it", async () => {
    const texts = ["حرقان في القلب وارتجاع المريء بعد الأكل: ما العلاج؟", "القولون العصبي وأعراض الانتفاخ بعد الوجبات", "أعراض الجلطة القلبية والنوبة القلبية عند الشباب"];
    const world = axisWorld(texts);
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 3, perVideo: 1 }, target: 3, axisModel: async () => { throw new Error("the model must not be asked"); } });
    const byText = new Map(run.final.posts.map((post) => [post.text, post.axis]));
    expect(byText.get(texts[0])).toBe("digestive");
    expect(byText.get(texts[1])).toBe("digestive");
    expect(byText.get(texts[2])).toBe("heart");
  });

  it("beyond the model budget the ambiguous posts are «general» and flagged; the model is never asked for them", async () => {
    // 5 comments requested: the job's revenue is tiny, its 20% cannot pay for a call
    const world = axisWorld(mixed);
    let asked = 0;
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 5, perVideo: 1 }, target: 5, axisModel: async () => { asked += 1; return { ok: true, axes: {} }; } });
    expect(run.final.classify.budgetUsd).toBeLessThan(0.0166);
    expect(asked).toBe(0);
    const ambiguous = run.final.posts.filter((post) => post.axisBy === "budget");
    expect(ambiguous.length).toBe(run.final.posts.length);
    expect(ambiguous.every((post) => post.axis === "general")).toBe(true);
    expect(run.final.classify.budgetStopped).toBe(ambiguous.length);
  });

  it("a failed model call leaves the posts flagged as ambiguous, never charged to the customer", async () => {
    const world = axisWorld(mixed);
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 20, perVideo: 1 }, target: 400, axisModel: async () => ({ ok: false, axes: {}, failure: "timeout" }) });
    expect(run.final.posts.every((post) => post.axis === "general" && post.axisBy === "ambiguous")).toBe(true);
    expect(run.final.classify.modelFailed).toBe(20);
    expect(run.rows.length).toBeGreaterThan(0);
  });
});

describe("the collector: the cost the provider is paid", () => {
  it("one job of 20 posts x 5 comments costs the provider far less than its revenue, and every chunk stays inside the calls-per-chunk limit", async () => {
    const world = fullWorld(40);
    const run = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 20, perVideo: 5 }, target: 100 });
    expect(run.rows).toHaveLength(100);
    const total = world.asked.length;
    expect(total).toBeLessThanOrEqual(run.chunks * 14);
    const expected = world.count("anyapi.facebook.user.posts") * PAGE_CALL_MICRO + world.count("scrapecreators.x.v1-facebook-post-comments") * COMMENTS_CALL_MICRO;
    expect(run.cost).toBe(expected);
    // revenue of 100 comments at 3.025 points: 303 points = 30.3 EGP = 0.55 USD; the cost of the job is a small fraction of it
    expect(run.cost / 1e6).toBeLessThan(0.25);
  });

  it("chunks that deliver no row (browsing, classifying) say so, so the worker does not stop the job as empty pages", async () => {
    const run = await runReportJob({ world: fullWorld(60), params: { ...REPORT_PARAMS, videoCount: 100, perVideo: 1 }, target: 100 });
    expect(run.progressChunks).toBeGreaterThan(0);
    expect(run.rows).toHaveLength(100);
  });
});

describe("the collector: resumable", () => {
  it("a chunk run again from the record of the chunk before it gives the same result (the provider's idempotent replay)", async () => {
    const world = fullWorld(30);
    const first = await runReportJob({ world, params: { ...REPORT_PARAMS, videoCount: 10, perVideo: 3 }, target: 30 });
    const world2 = fullWorld(30);
    const second = await runReportJob({ world: world2, params: { ...REPORT_PARAMS, videoCount: 10, perVideo: 3 }, target: 30 });
    expect(second.rows).toEqual(first.rows);
    expect(second.final.posts.map((p) => p.key)).toEqual(first.final.posts.map((p) => p.key));
    expect(second.chunks).toBe(first.chunks);
  });

  it("a job whose record was lost fails loudly instead of starting over", async () => {
    const { runFacebookReportChunk } = await import("../src/lib/server/facebookReportAdapter");
    const { memoryStore, chunkInput, facebookReportWorld: fw } = await import("./helpers/fakeFacebookReport");
    const out = await runFacebookReportChunk(chunkInput(3, JSON.stringify({ r: 1, s: 3, ph: "browse" }), REPORT_PARAMS, 100), { call: fw({ pages: [] }).call, store: memoryStore(), now: () => 0 });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("report_state_missing");
  });
});
