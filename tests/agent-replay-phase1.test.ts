import { describe, expect, it } from "vitest";
import { assertReplayInvariants, pagedAnswers, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, companiesPage, emailFound, emailNotFound, employeesPage, fbCommentsPage, fbPostsPage, igHashtagPage, lastOutputId, mapsReviewsPage, mapsSearch, planningFlow, pagedCalls, tregResult, ttCommentsPage, ttVideosPage, xPage, type Results } from "./helpers/agentFakeWorld";
import type { FakeStep } from "../agent/src/fakeDriver";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { isSellable, loadTregCatalog } from "../src/lib/treg/catalog";

/**
 * PHASE 1 REPLAYS: a customer request through the chat, the agent's plan on the customer's card, the customer's approval, the execution, the settlement, the files and the notice, with a fake
 * model transcript and fake provider answers: ZERO real provider calls (a real network call fails the test).
 */
const catalog = loadTregCatalog();
const sellable = (...ids: string[]) => { for (const id of ids) { expect(isSellable(id, catalog), id).toBe(true); expect(policyVerdict(id, { isAdmin: false, verifiedBusiness: false }).allowed, id).toBe(true); } };

describe("a 300-tweet mission paged through the source", () => {
  const ENDPOINT = "anyapi.x.search.posts";
  const TOPIC = "محمد صلاح بعد انتقاله لتركيا";
  const PER_PAGE = 20;

  it("plans from one measured page, shows the card, runs 15 pages inside the budget, de-duplicates, delivers 300 and settles exactly", async () => {
    sellable(ENDPOINT);
    const answers = [
      tregResult(xPage(TOPIC, 0, PER_PAGE, "cur_20"), 0.00075),
      ...pagedAnswers(300, PER_PAGE, 0.00075, (o, n, next) => xPage(TOPIC, o, n, next), tregResult),
    ];
    const r = await replay({
      request: "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا",
      planning: planningFlow({
        progress: "أبحث عن أرخص مصدر مناسب للتغريدات",
        searchWords: ["tweets", "search"], platform: "x",
        sample: [{ endpoint: ENDPOINT, params: { query: TOPIC, limit: PER_PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" }],
        sampleCode: "return inputs.call_0001.output.data.items.slice(0, 3).map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author }))",
        plan: (res: Results) => ({
          summary_ar: "ستحصل على ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا مع نص كل تغريدة ورابطها.",
          stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 300, parent_key: null, deliver: true,
            columns: [{ key: "id", title_ar: "المعرّف" }, { key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
            sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 3), measured_by: [callIds(res)[0]], relevance: aboutWords(["محمد صلاح"]), yield_from: firstOutputId(res) }],
        }),
      }),
      execution: () => [
        { tool: "report_progress", args: { message_ar: "بدأت جمع التغريدات صفحة بعد صفحة", counts: { pages: 0 } } },
        ...pagedCalls(ENDPOINT, 15, (cursor) => ({ query: TOPIC, limit: PER_PAGE, ...(cursor ? { cursor } : {}) })),
        { tool: "run_code", args: (res: Results) => ({ code: "const seen = new Set(); const out = []; for (const page of Object.values(inputs)) for (const t of page.output.data.items) { if (seen.has(t.id)) continue; seen.add(t.id); out.push({ id: t.id, text: t.text, url: t.url, author: t.author }); } return out;", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "tweets", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا، لكل تغريدة نصها ورابطها." } },
      ],
      answers,
    });

    // the plan on the customer's card
    // (the old line expected ["text", "url", "author"]: the source gives a date, and a plan that leaves a useful field of the source out is refused, so the plan now carries the date column)
    expect(r.plannedPlan.stages[0].columns.map((c) => c.key)).toEqual(["text", "url", "author", "date"]);
    expect(r.planView.phase).toBe("plan");
    expect(r.planView.stages).toHaveLength(1);
    expect(r.planView.totalRows).toBe(300);
    // (the old line expected ["نص التغريدة", "رابط التغريدة", "الحساب"]: the date column was added, see above)
    expect(r.planView.samples!.columns.map((c) => c.titleAr)).toEqual(["نص التغريدة", "رابط التغريدة", "الحساب", "التاريخ والوقت"]);
    // (the old line said «٦٢ … ٧٢»: provider cost alone) the one pricing rule: the 300 tweets cost less than the minimum, so the charge is the minimum and the card says so
    expect(r.planView.priceLineAr).toMatch(/^السعر حتى ٢٠٠ نقطة .* حجز مؤقت ٢٠٠ نقطة .* الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء .* الوقت المتوقع نحو /);
    // 15 pages of 20 = 300 unique rows, saved in ONE stage, inside the execution budget
    expect(r.executionDriver.results.filter((x) => x.tool === "treg_call").every((x) => x.result.ok === true)).toBe(true);
    expect(r.executionDriver.results.filter((x) => x.tool === "save_rows")[0].result).toMatchObject({ saved_now: 300, rejected_over_limit: 0 });
    expect(r.mission.execution_treg_usd).toBeCloseTo(15 * 0.00075, 6);
    assertReplayInvariants(r, { expectDelivered: 300 });
    expect(r.mission.charged_points).toBe(200); // (was 62)
    expect(r.finalView.phase).toBe("done");
    // (the old line expected the released hold: with the minimum the reserve and the charge are both 200, so nothing is left to release)
    // (the old line expected «خُصم ٢٠٠ نقطة مقابل ما سُلّم فقط»: the money is now said as the wallet shows it: the hold, the charge, the whole hold released)
    expect(r.finalView.resultLinesAr).toEqual(["تم تسليم ٣٠٠ من ٣٠٠ تغريدة.", "حُجز مؤقتًا ٢٠٠ نقطة، وخُصم ٢٠٠ نقطة مقابل ما سُلّم، وحجز مؤقت مُحرَّر ٢٠٠ نقطة."]);
    // the live panel ticked from the counts
    // (the old line expected [{ stage: 1, saved: 300, planned: 300 }]: the live tick of a stage with a relevance rule now also carries the check counts, so the panel moves while items are being checked)
    expect(r.store.events.filter((e) => e.counts?.stage === 1).map((e) => e.counts)).toEqual([{ stage: 1, saved: 300, planned: 300, checked: 300, accepted: 300, excluded: 0, pending: 0 }]);
    // the file: the summary sheet first, headers frozen, a filter, readable columns
    const wb = await readWorkbook(r);
    expect(wb.worksheets[0].name).toBe("ملخص المهمة");
    expect(wb.getWorksheet("التغريدات")!.rowCount).toBe(301);
  });
});


/** The saved page ids of the execution run, in order, optionally filtered by the endpoint's params. */
const execCalls = (r: Results) => r.filter((x) => x.tool === "treg_call" && x.result.ok === true).map((x) => String(x.result.call_id));

describe("a Facebook topic mission: posts, then the comments of each post, linked", () => {
  const POSTS = "justoneapi.x.facebook-search-post-v1";
  const COMMENTS = "anyapi.facebook.post_comments";
  const TOPIC = "التضخم وأسعار الغذاء";
  const PAGE = 8;
  const POSTS_N = 24;
  const postId = (i: number) => `fp${String(i).padStart(6, "0")}`;

  it("two linked stages whose sheets show post links and comments, priced from both measured sources", async () => {
    sellable(POSTS, COMMENTS);
    const answers = [
      tregResult(fbPostsPage(TOPIC, 0, PAGE, "cur_8"), 0.02952),
      tregResult(fbCommentsPage(postId(0), 10), 0.002),
      ...pagedAnswers(POSTS_N, PAGE, 0.02952, (o, n, next) => fbPostsPage(TOPIC, o, n, next), tregResult),
      ...Array.from({ length: POSTS_N }, (_, i) => tregResult(fbCommentsPage(postId(i), 10), 0.002)),
    ];
    const r = await replay({
      request: "عايز منشورات فيسبوك عن التضخم وأسعار الغذاء مع روابطها وتعليقات كل منشور",
      planning: planningFlow({
        progress: "أجرّب مصدر المنشورات ومصدر التعليقات",
        searchWords: ["facebook", "posts", "search"], platform: "facebook",
        sample: [{ endpoint: POSTS, params: { keyword: TOPIC }, why: "the cheaper sources return no author or link fields in their catalog description" }, { endpoint: COMMENTS, params: { url: `https://fb.example/posts/${postId(0)}` }, why: "the cheaper sources return no author or link fields in their catalog description" }],
        sampleCode: "return inputs.call_0001.data.results.slice(0, 2).map(p => ({ id: p.post_id, text: p.message, url: p.url, author: p.author.name }))",
        plan: (res) => ({
          summary_ar: "ستحصل على منشورات فيسبوك عن التضخم وأسعار الغذاء مع رابط كل منشور وتعليقاته.",
          stages: [
            { key: "posts", title_ar: "المنشورات", endpoint_id: POSTS, expected_rows: POSTS_N, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط المنشور" }, { key: "author", title_ar: "الصفحة" }, { key: "date", title_ar: "التاريخ والوقت" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "likes", title_ar: "الإعجابات" }],
              sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 2), measured_by: [callIds(res)[0]], relevance: aboutWords(["التضخم"]), yield_from: firstOutputId(res) },
            { key: "comments", title_ar: "تعليقات كل منشور", endpoint_id: COMMENTS, expected_rows: POSTS_N * 5, parent_key: "posts", per_parent_rows: 5, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: [{ id: `${postId(0)}-c00`, text: `تعليق 0 على ${postId(0)}`, author: "قارئ 0" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [
        ...pagedCalls(POSTS, 3, (cursor) => ({ keyword: TOPIC, ...(cursor ? { cursor } : {}) })),
        { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const page of Object.values(inputs)) for (const p of page.data.results) out.push({ id: p.post_id, text: p.message, url: p.url, author: p.author.name }); return out;", files: execCalls(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "posts", from_output: lastOutputId(res) }) },
        ...Array.from({ length: POSTS_N }, (_, i): FakeStep => ({ tool: "treg_call", args: { endpoint_id: COMMENTS, params: { url: `https://fb.example/posts/${postId(i)}` } } })),
        { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const k of Object.keys(inputs).slice(0, 24)) { const page = inputs[k]; for (const c of page.output.data.comments.slice(0, 5)) out.push({ id: c.id, parent_id: c.id.split('-')[0], text: c.text, author: c.author }); } return out;", files: execCalls(res).slice(3) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "comments", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ٢٤ منشورًا مع خمسة تعليقات لكل منشور، وكل تعليق مرتبط بمنشوره." } },
      ],
      answers,
    });
    expect(r.planView.stages.map((s) => [s.n, s.titleAr, s.rows])).toEqual([[1, "المنشورات", 24], [2, "تعليقات كل منشور", 120]]);
    expect(r.planView.totalRows).toBe(144);
    // (the old line expected ["نص التعليق", "كاتب التعليق"]: the comments source gives a date, so the comments stage carries the date column too)
    expect(r.planView.samples!.columns.map((c) => c.titleAr)).toEqual(["نص التعليق", "كاتب التعليق", "التاريخ والوقت"]);
    assertReplayInvariants(r, { expectDelivered: 144 });
    const wb = await readWorkbook(r);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "المنشورات", "تعليقات كل منشور"]);
    expect(wb.getWorksheet("تعليقات كل منشور")!.rowCount).toBe(121);
  });
});

describe("a TikTok mission: videos, then the comments of each video", () => {
  const VIDEOS = "crawl4ai.tiktok.search.videos";
  const COMMENTS = "crawl4ai.tiktok.video.comments";
  const TOPIC = "رحلة إلى الأقصر";
  it("delivers the videos with their numbers and ten comments for each", async () => {
    sellable(VIDEOS, COMMENTS);
    const N = 12;
    const vid = (i: number) => `tv${String(i).padStart(6, "0")}`;
    const answers = [
      tregResult(ttVideosPage(TOPIC, N), 0.0005),
      tregResult(ttCommentsPage(vid(0), 10), 0.0005),
      tregResult(ttVideosPage(TOPIC, N), 0.0005),
      ...Array.from({ length: N }, (_, i) => tregResult(ttCommentsPage(vid(i), 10), 0.0005)),
    ];
    const r = await replay({
      request: "عايز فيديوهات تيك توك عن رحلة إلى الأقصر مع تعليقات كل فيديو",
      planning: planningFlow({
        progress: "أجرّب مصدر الفيديوهات ومصدر تعليقاتها",
        searchWords: ["tiktok", "videos"], platform: "tiktok",
        sample: [{ endpoint: VIDEOS, params: { query: TOPIC, limit: N }, why: "the cheaper sources return no author or link fields in their catalog description" }, { endpoint: COMMENTS, params: { post: `https://tt.example/@creator0/video/${vid(0)}` }, why: "the cheaper sources return no author or link fields in their catalog description" }],
        sampleCode: "return inputs.call_0001.rows.slice(0, 2).map(v => ({ id: v.post_id, text: v.description, url: v.url, views: v.stats.views }))",
        plan: (res) => ({
          summary_ar: "ستحصل على فيديوهات تيك توك عن رحلة إلى الأقصر مع أرقامها وتعليقات كل فيديو.",
          stages: [
            { key: "videos", title_ar: "الفيديوهات", endpoint_id: VIDEOS, expected_rows: N, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "وصف الفيديو" }, { key: "url", title_ar: "رابط الفيديو" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 2), measured_by: [callIds(res)[0]], relevance: aboutWords(["الأقصر"]), yield_from: firstOutputId(res) },
            { key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: COMMENTS, expected_rows: N * 10, parent_key: "videos", per_parent_rows: 10, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: [{ id: `${vid(0)}-k00`, text: `تعليق 0 على الفيديو ${vid(0)}`, author: "viewer0" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [
        { tool: "treg_call", args: { endpoint_id: VIDEOS, params: { query: TOPIC, limit: N } } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.map(v => ({ id: v.post_id, text: v.description, url: v.url, views: v.stats.views }))", files: [execCalls(res)[0]] }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "videos", from_output: lastOutputId(res) }) },
        ...Array.from({ length: N }, (_, i): FakeStep => ({ tool: "treg_call", args: { endpoint_id: COMMENTS, params: { post: `https://tt.example/@creator${i % 7}/video/${vid(i)}` } } })),
        { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const page of Object.values(inputs)) for (const c of page.rows) out.push({ id: c.comment_id, parent_id: c.post_id, text: c.text, author: c.author }); return out;", files: execCalls(res).slice(1) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "comments", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ١٢ فيديو مع عشرة تعليقات لكل فيديو." } },
      ],
      answers,
    });
    expect(r.planView.totalRows).toBe(N + N * 10);
    assertReplayInvariants(r, { expectDelivered: N + N * 10 });
    expect((await readWorkbook(r)).worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "الفيديوهات", "تعليقات كل فيديو"]);
  });
});

describe("an Instagram hashtag mission", () => {
  const ENDPOINT = "anyapi.instagram.hashtag.posts";
  it("pages a hashtag three times and delivers the posts", async () => {
    sellable(ENDPOINT);
    const answers = [tregResult(igHashtagPage("قهوة", 0, 20, "cur_20"), 0.002), ...pagedAnswers(60, 20, 0.002, (o, n, next) => igHashtagPage("قهوة", o, n, next), tregResult)];
    const r = await replay({
      request: "هات ٦٠ بوست إنستجرام عن هاشتاج قهوة",
      planning: planningFlow({
        progress: "أجرّب مصدر منشورات الوسوم", searchWords: ["instagram", "hashtag"], platform: "instagram",
        sample: [{ endpoint: ENDPOINT, params: { hashtag: "قهوة" }, why: "the cheaper sources return no author or link fields in their catalog description" }],
        sampleCode: "return inputs.call_0001.output.data.posts.slice(0, 3).map(p => ({ id: p.id, text: p.caption, url: p.displayUrl, likes: p.likes }))",
        plan: (res) => ({
          summary_ar: "ستحصل على ٦٠ منشورًا من إنستجرام تحت وسم قهوة مع نص كل منشور ورابطه وعدد الإعجابات.",
          stages: [{ key: "posts", title_ar: "المنشورات", endpoint_id: ENDPOINT, expected_rows: 60, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط الصورة" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "date", title_ar: "التاريخ والوقت" }],
            sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 3), measured_by: [callIds(res)[0]], relevance: aboutWords(["قهوة"]), yield_from: firstOutputId(res) }],
        }),
      }),
      execution: () => [
        ...pagedCalls(ENDPOINT, 3, (cursor) => ({ hashtag: "قهوة", ...(cursor ? { cursor } : {}) })),
        { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const page of Object.values(inputs)) for (const p of page.output.data.posts) out.push({ id: p.id, text: p.caption, url: p.displayUrl, likes: p.likes }); return out;", files: execCalls(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "posts", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّم ٦٠ منشورًا من وسم قهوة." } },
      ],
      answers,
    });
    assertReplayInvariants(r, { expectDelivered: 60 });
  });
});

describe("a Google Maps reviews mission", () => {
  const SEARCH = "crawl4ai.google.serp.maps";
  const REVIEWS = "litescrape.google.maps.reviews";
  it("finds the named place, then delivers its reviews in two pages", async () => {
    sellable(SEARCH, REVIEWS);
    const answers = [
      tregResult(mapsSearch("مطعم أبو طارق"), 0.00015),
      tregResult(mapsReviewsPage(0, 10, "tok_10"), 0.00015),
      tregResult(mapsSearch("مطعم أبو طارق"), 0.00015),
      ...pagedAnswers(200, 100, 0.00015, (o, n, next) => mapsReviewsPage(o, n, next ? `tok_${o + n}` : null), tregResult),
    ];
    const r = await replay({
      request: "عايز ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق في القاهرة",
      planning: planningFlow({
        progress: "أبحث عن المكان ثم أجرّب مصدر التقييمات", searchWords: ["google", "maps", "reviews"],
        sample: [{ endpoint: SEARCH, params: { query: "مطعم أبو طارق القاهرة", limit: 3 }, why: "the cheaper sources return no author or link fields in their catalog description" }, { endpoint: REVIEWS, params: { place_id: "ChIJplace0001", num: 10 }, why: "the cheaper sources return no author or link fields in their catalog description" }],
        sampleCode: "return inputs.call_0001.rows.map(p => ({ id: p.place_id, text: p.name, url: p.address }))",
        plan: (res) => ({
          summary_ar: "ستحصل على ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق بتاريخ كل تقييم ونصه ودرجته.",
          stages: [
            { key: "place", title_ar: "المكان", endpoint_id: SEARCH, expected_rows: 1, parent_key: null, deliver: false, columns: [{ key: "text", title_ar: "اسم المكان" }, { key: "url", title_ar: "العنوان" }],
              sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 1), measured_by: [callIds(res)[0]] },
            { key: "reviews", title_ar: "التقييمات", endpoint_id: REVIEWS, expected_rows: 200, parent_key: "place", per_parent_rows: 200, deliver: true, columns: [{ key: "text", title_ar: "نص التقييم" }, { key: "rating", title_ar: "الدرجة" }, { key: "date", title_ar: "التاريخ" }, { key: "writer", title_ar: "الكاتب" }, { key: "likes", title_ar: "الإعجابات" }],
              sample_rows: [{ id: "rv000000", text: "تجربة رقم 0 في المكان", rating: 1, date: "2026-10-10T12:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [
        { tool: "treg_call", args: { endpoint_id: SEARCH, params: { query: "مطعم أبو طارق القاهرة", limit: 3 } } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.slice(0, 1).map(p => ({ id: p.place_id, text: p.name, url: p.address }))", files: [execCalls(res)[0]] }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "place", from_output: lastOutputId(res) }) },
        ...pagedCalls(REVIEWS, 2, (token) => ({ place_id: "ChIJplace0001", num: 100, ...(token ? { next_page_token: token } : {}) })),
        { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const k of Object.keys(inputs).slice(1)) for (const v of inputs[k].reviews) out.push({ id: v.review_id, parent_id: 'ChIJplace0001', text: v.snippet, rating: v.rating, date: v.iso_date }); return out;", files: execCalls(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "reviews", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّم ٢٠٠ تقييم للمكان المطلوب." } },
      ],
      answers,
    });
    // the place row is a helper stage: it is not counted in the customer's file
    expect(r.planView.stages[0].noteAr).toContain("المرحلة التالية");
    expect(r.planView.totalRows).toBe(200);
    assertReplayInvariants(r, { expectDelivered: 200 });
  });
});

describe("a companies + employees + work e-mails mission (the contacts stage)", () => {
  const COMPANIES = "aiark.companies.search";
  const EMPLOYEES = "aviato.companies.employees";
  const EMAILS = "blitzapi.people.email.find";
  const MAILS = ["ahmed.hassan@company1.example", "ahmed.salim@company1.example", "mona.hassan@company2.example", "mona.salim@company2.example", null, "khaled.salim@company3.example"];

  it("delivers 3 companies, 6 employees and only the work e-mails that were found; the missing one is not delivered and not charged (partial)", async () => {
    sellable(COMPANIES, EMPLOYEES, EMAILS);
    expect(policyVerdict(EMAILS, { isAdmin: false, verifiedBusiness: false })).toMatchObject({ allowed: true, category: "b2b_contact" });
    const personId = (c: number, p: number) => `co${c}-p${p}`;
    const answers = [
      tregResult(companiesPage(3), 0.0005267),
      tregResult(employeesPage("co1", 2), 0.005),
      tregResult(emailFound(MAILS[0]!), 0.000495),
      tregResult(companiesPage(3), 0.0005267),
      tregResult(employeesPage("co1", 2), 0.005), tregResult(employeesPage("co2", 2), 0.005), tregResult(employeesPage("co3", 2), 0.005),
      ...MAILS.map((m) => (m ? tregResult(emailFound(m), 0.000495) : tregResult(emailNotFound(), 0))),
    ];
    const r = await replay({
      request: "عايز ٣ شركات كهروميكانيكا في مصر، وجوه كل شركة موظفين اتنين بإيميلاتهم",
      planning: planningFlow({
        progress: "أبحث عن مصدر الشركات ثم الموظفين ثم البريد المهني",
        searchWords: ["companies", "search"],
        sample: [{ endpoint: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" }, why: "the cheaper sources return no author or link fields in their catalog description" }, { endpoint: EMPLOYEES, params: { website: "company1.example", page: 0, perPage: 2 }, why: "the cheaper sources return no author or link fields in their catalog description" }, { endpoint: EMAILS, params: { person_linkedin_url: "https://www.linkedin.com/in/co1-p1" }, why: "the cheaper sources return no author or link fields in their catalog description" }],
        sampleCode: "return inputs.call_0001.content.slice(0, 2).map(c => ({ id: c.id, text: c.name, url: c.domain }))",
        plan: (res) => ({
          summary_ar: "ستحصل على ثلاث شركات كهروميكانيكا في مصر وموظفين اثنين من كل شركة مع بريد كل موظف المهني.",
          stages: [
            { key: "companies", title_ar: "الشركات", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "اسم الشركة" }, { key: "url", title_ar: "الموقع" }],
              sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 2), measured_by: [callIds(res)[0]] },
            { key: "employees", title_ar: "موظفو كل شركة", endpoint_id: EMPLOYEES, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "text", title_ar: "اسم الموظف" }, { key: "title", title_ar: "المسمى الوظيفي" }, { key: "company", title_ar: "الشركة" }],
              sample_rows: [{ id: "co1-p1", text: "أحمد حسن", title: "مدير المشتريات", company: "الشركة المصرية للكهروميكانيكا" }], measured_by: [callIds(res)[1]] },
            { key: "emails", title_ar: "البريد المهني لكل موظف", endpoint_id: EMAILS, expected_rows: 6, parent_key: "employees", per_parent_rows: 1, deliver: true, columns: [{ key: "text", title_ar: "البريد المهني", kind: "work_email" }, { key: "person", title_ar: "الموظف" }],
              sample_rows: [{ id: MAILS[0], text: MAILS[0], person: "أحمد حسن" }], measured_by: [callIds(res)[2]] },
          ],
        }),
      }),
      execution: () => [
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" } } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].content.map(c => ({ id: c.id, text: c.name, url: c.domain }))", files: [execCalls(res)[0]] }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "companies", from_output: lastOutputId(res) }) },
        ...[1, 2, 3].map((c): FakeStep => ({ tool: "treg_call", args: { endpoint_id: EMPLOYEES, params: { website: `company${c}.example`, page: 0, perPage: 2 } } })),
        { tool: "run_code", args: (res: Results) => ({ code: "const names = { co1: 'الشركة المصرية للكهروميكانيكا', co2: 'النيل للتركيبات الكهربائية', co3: 'دلتا للمقاولات الكهروميكانيكية' }; const out = []; for (const page of Object.values(inputs)) for (const e of page.employees) out.push({ id: e.personID, parent_id: e.companyID, text: e.person.fullName, title: e.positionList[0].title, company: names[e.companyID] }); return out;", files: execCalls(res).slice(1) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "employees", from_output: lastOutputId(res) }) },
        ...MAILS.map((_, i): FakeStep => ({ tool: "treg_call", args: { endpoint_id: EMAILS, params: { person_linkedin_url: `https://www.linkedin.com/in/${personId(Math.floor(i / 2) + 1, (i % 2) + 1)}` } } })),
        // only a verified work e-mail is saved; the person without one gets no row (nothing to deliver, nothing to charge)
        { tool: "run_code", args: (res: Results) => ({ code: "const people = ['co1-p1','co1-p2','co2-p1','co2-p2','co3-p1','co3-p2']; const names = ['أحمد حسن','أحمد سليم','منى حسن','منى سليم','خالد حسن','خالد سليم']; const out = []; Object.keys(inputs).forEach((k, i) => { const p = inputs[k]; if (p.found && p.all_emails.length) out.push({ id: p.all_emails[0].email, parent_id: people[i], text: p.all_emails[0].email, person: names[i] }); }); return out;", files: execCalls(res).slice(4) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "emails", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ثلاث شركات وستة موظفين وخمسة بريدات مهنية؛ لم نجد بريدًا مهنيًا للموظف الخامس فلم نضف له صفًّا ولم يُحتسب عليك." } },
      ],
      answers,
    });
    expect(r.planView.stages.map((s) => [s.n, s.titleAr, s.rows])).toEqual([[1, "الشركات", 3], [2, "موظفو كل شركة", 6], [3, "البريد المهني لكل موظف", 6]]);
    expect(r.planView.totalRows).toBe(15);
    // 3 + 6 + 5 delivered of 15 planned: a partial completion, charged for what was delivered only
    assertReplayInvariants(r, { expectDelivered: 14, expectStatus: "partial" });
    expect(r.finalView.phase).toBe("partial");
    expect(r.mission.charged_points).toBeLessThan(r.mission.reserved_points!);
    const emails = JSON.parse((await r.store.getFile(r.missionId, "rows/emails.json"))!);
    expect(emails).toHaveLength(5);
    expect(emails.every((e: any) => /@company\d\.example$/.test(e.text))).toBe(true);
  });
});
