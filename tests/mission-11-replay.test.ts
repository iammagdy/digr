import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { readSnapshot } from "../agent/src/items/itemStore";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * REPLAYS OF THE LIVE RETEST OF 2026-10-29 23:50 - 2026-10-30 00:37 CAIRO (after #297, test account; `missions`, `mission_events`, `mission_calls` read with SELECT; the stored plans, the call logs and the counts are the evidence, the pages are
 * shaped like the catalog's own example rows). Every moment here is FIXED: no test reads the clock.
 */
const FIXED_NOW = "2026-10-29T10:00:00.000Z";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(FIXED_NOW)); });
afterEach(() => { vi.useRealTimers(); });

const why = "the cheaper sources return no author or link fields in their catalog description";
const columnsOf = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));
const planFlow = (o: { progress: string; words: string[]; platform?: string; calls: Array<{ endpoint: string; params: Record<string, unknown>; code: string }>; plan: (res: Results) => unknown }): FakeStep[] => [
  { tool: "report_progress", args: { message_ar: o.progress, counts: { sources: 3 } } },
  { tool: "catalog_search", args: { words: o.words, ...(o.platform ? { platform: o.platform } : {}), limit: 5 } },
  ...o.calls.flatMap((c, i): FakeStep[] => [
    { tool: "describe_endpoint", args: { id: c.endpoint } },
    { tool: "treg_call", args: { endpoint_id: c.endpoint, params: c.params, why } },
    { tool: "run_code", args: (r: Results) => ({ code: c.code, files: [callIds(r)[i]] }) },
  ]),
  { tool: "propose_plan", args: (r: Results) => o.plan(r) as Record<string, unknown> },
];

// ---------------------------------------------------------------------------------------------------- 1. YouTube: named channels, relative times (msn_f000396ad8994a5cf407)
describe("1. YouTube named channels: the source gives only «قبل ٤ أيام», the channels are read by their own listings, five videos from each (live: 0 of 90 delivered, 0 charged)", () => {
  const VIDEOS = "crawl4ai.youtube.channel.videos";
  const COMMENTS = "crawl4ai.youtube.video.comments";
  const CHANNELS = [{ handle: "@AlArabiya", name: "العربية" }, { handle: "@Youm7", name: "اليوم السابع" }, { handle: "@BBCNews", name: "BBC News" }];
  /** The channel listing as the catalog's example shows it: a title, a relative time, a link, a video id, views; NO channel name. */
  const ON = (c: number, i: number) => `حرب إيران وإسرائيل: تطورات اليوم ${c}-${i}`;
  const OFF = (c: number, i: number) => `ملخص مباراة الدوري ${c}-${i}`;
  const PUBLISHED = ["قبل 3 أيام", "قبل 5 أيام", "قبل أسبوع", "قبل أسبوعين", "قبل 3 أسابيع", "قبل شهر", "قبل شهرين", "قبل 5 أشهر", "قبل سنة", "قبل 4 أيام", "قبل 6 أيام", "قبل 9 أيام"];
  const vid = (c: number, i: number) => `v${c}x${String(i).padStart(2, "0")}`;
  const listing = (c: number) => ({ rows: PUBLISHED.map((published, i) => ({ video_id: vid(c, i), title: i < 9 ? ON(c, i) : OFF(c, i), url: `https://www.youtube.com/watch?v=${vid(c, i)}`, published, views: 1000 * (i + 1), description: null })) });
  const commentsOf = (video: string) => ({ rows: Array.from({ length: 20 }, (_, i) => ({ comment_id: `${video}-k${i}`, video_id: video, text: `تعليق رقم ${i} على ${video}`, author: `قارئ ${i}`, likes: i, replies: 0, published: i < 10 ? "4 days ago" : "قبل أسبوع", url: `https://www.youtube.com/watch?v=${video}&lc=${i}` })) });
  const MAP_VIDEOS = (n: number) => `return inputs.call_000${n}.rows.map(v => ({ id: v.video_id, title: v.title, channel: v.channel || '', views: v.views, published: v.published, description: v.description || '', url: v.url }))`;
  const MAP_COMMENTS = "return inputs.call_0004.rows.map(c => ({ id: c.comment_id, text: c.text, author: c.author, likes: c.likes, replies: c.replies, published: c.published, url: c.url }))";
  const request = "هات من قنوات العربية واليوم السابع وبي بي سي نيوز الإنجليزية على يوتيوب ٥ فيديوهات من كل قناة عن حرب إيران وإسرائيل آخر ٣ شهور، ومن كل فيديو ٢٠ تعليق";
  const relevance = { subject_ar: "حرب إيران وإسرائيل", terms: ["إيران", "Iran", "إسرائيل", "Israel"], context_terms: ["حرب", "الحرب", "war"], text_columns: ["title", "description"], min_own_words: 0 };

  /** The model check: a video about a football match is not about the war; every other row is. */
  const topicReview = async ({ user }: { user: string }) => ({ text: JSON.stringify(user.split("\n").filter((l) => /^\d+\./.test(l)).map((l) => (/ملخص مباراة/.test(l) ? 0 : 1))), usage: { input_tokens: 400, output_tokens: 20 } });
  async function run(o: { calls?: boolean } = {}) {
    return replay({
      deps: (base) => ({ ...base, reviewCall: topicReview as never }),
      request,
      planning: planFlow({
        progress: "أجرّب قوائم القنوات الثلاث ومصدر التعليقات", words: ["youtube", "channel", "videos"], platform: "youtube",
        calls: [
          ...CHANNELS.map((c, i) => ({ endpoint: VIDEOS, params: { channel: c.handle, limit: 12 }, code: MAP_VIDEOS(i + 1) })),
          { endpoint: COMMENTS, params: { video: vid(0, 0), limit: 20 }, code: MAP_COMMENTS },
        ],
        plan: (res) => ({
          summary_ar: "ستحصل على ٥ فيديوهات من كل قناة من القنوات الثلاث عن حرب إيران وإسرائيل خلال آخر ٣ شهور، ومن كل فيديو ٢٠ تعليقًا.",
          stages: [
            { key: "videos", title_ar: "فيديوهات عن حرب إيران وإسرائيل من القنوات الثلاث", endpoint_id: VIDEOS, expected_rows: 15, parent_key: null, deliver: true,
              columns: columnsOf(["title", "عنوان الفيديو"], ["channel", "القناة"], ["views", "المشاهدات"], ["published", "وقت النشر"], ["description", "وصف الفيديو"], ["url", "رابط الفيديو"]),
              filters: [{ kind: "period", days: 90 }, { kind: "account", values: CHANNELS.map((c) => c.name), ...(o.calls === false ? {} : { calls: callIds(res).slice(0, 3) }) }],
              sample_rows: [0, 1, 2].map((i) => ({ id: vid(0, i), title: ON(0, i), channel: "", views: 1000 * (i + 1), published: PUBLISHED[i], description: "", url: `https://www.youtube.com/watch?v=${vid(0, i)}` })),
              measured_by: callIds(res).slice(0, 3), yield_from: firstOutputId(res), relevance },
            { key: "comments", title_ar: "تعليقات على الفيديوهات", endpoint_id: COMMENTS, expected_rows: 300, parent_key: "videos", per_parent_rows: 20, deliver: true,
              columns: columnsOf(["text", "نص التعليق"], ["author", "الكاتب"], ["likes", "الإعجابات"], ["replies", "الردود"], ["published", "وقت النشر"], ["url", "الرابط"]),
              sample_rows: [{ id: `${vid(0, 0)}-k0`, text: `تعليق رقم 0 على ${vid(0, 0)}`, author: "قارئ 0", likes: 0, replies: 0, published: "4 days ago", url: `https://www.youtube.com/watch?v=${vid(0, 0)}&lc=0` }], measured_by: [callIds(res)[3]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [
        ...CHANNELS.map((_, c) => tregResult(listing(c), 0.0009)), tregResult(commentsOf(vid(0, 0)), 0.0009),
        // the engine: each named channel in turn, then the comments of each saved video
        ...CHANNELS.map((_, c) => tregResult(listing(c), 0.0009)),
        ...Array.from({ length: 15 }, () => (o2: { params: unknown }) => tregResult(commentsOf(String((o2.params as { video?: string }).video)), 0.0009)),
      ] as never,
    });
  }

  it("the card: the channels are read by their own listings, the card names the dates as approximate and does not say that the channels were not found", async () => {
    const r = await run();
    const videos = r.plannedPlan.stages[0];
    // the recipe: one entry per named channel, each with the inputs of the call that read it; the channel listing's items name no author, so they belong to the channel asked for
    expect(videos.engine?.sources?.map((s) => [s.names, s.params])).toEqual([[["العربية"], { channel: "@AlArabiya", limit: 12 }], [["اليوم السابع"], { channel: "@Youm7", limit: 12 }], [["BBC News"], { channel: "@BBCNews", limit: 12 }]]);
    expect(videos.engine?.source_listing).toBe(true);
    expect(videos.unresolved_sources ?? []).toEqual([]);
    expect(videos.approx_dates).toEqual(["published"]);
    // the planner saw, next to each source, whether its dates are relative or exact (from the catalog's own examples), and the channel listings among the first hits
    const hits = (r.planningDriver.results.find((x) => x.tool === "catalog_search")!.result as { hits: Array<{ id: string; dates?: string }> }).hits;
    expect(hits.find((h) => h.id === VIDEOS)?.dates).toBe("relative");
    expect(JSON.stringify(r.planView)).not.toContain("لم نجد");
    expect(JSON.stringify(r.planView)).toContain("نسبيًا");
    expect(JSON.stringify(r.planView)).toContain("تقريبيًا");
  });

  it("the file: 5 videos from each channel (the channel's name in its cell), every one inside the 90 days by its approximate date, 20 comments each; the dates are approximate and the file says so; the charge is the delivered count", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 15 + 300 });
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("videos").accepted).toBe(15);
    expect(snap.counts("comments").accepted).toBe(300);
    const rows = snap.acceptedRows("videos");
    for (const c of CHANNELS) expect(rows.filter((x) => x.channel === c.name)).toHaveLength(5);
    // the ones left out: outside the period («قبل 5 أشهر», «قبل سنة») by their relative times, and the matches beyond a channel's five
    const excluded = snap.excludedItems("videos");
    expect(excluded.filter((x) => x.reason === "filter_period")).toHaveLength(6);
    expect(excluded.filter((x) => x.reason === "target_reached")).toHaveLength(6);
    // the three videos of each channel that are about a football match: the topic is judged by the model check (a video of a named channel with no word of the topic is never thrown away by rule), which says no; the third channel's page is not
    // checked at all: its matches already fill the room that is left (the check is spent only where it can be used)
    expect(excluded.filter((x) => x.reason === "review_no")).toHaveLength(6);
    // ...so its three football videos wait, never delivered and never charged
    expect(snap.counts("videos").pending).toBe(3);
    // every delivered video's approximate day lies inside the 90 days before the fixed moment, and is marked approximate
    for (const v of rows) {
      expect(String(v.published)).toMatch(/^2026-(?:08|09|10)-\d{2}$/);
      expect(Date.parse(`${v.published}T00:00:00Z`)).toBeGreaterThanOrEqual(Date.parse(FIXED_NOW) - 92 * 86_400_000);
      expect(v._approx_dates).toEqual(["published"]);
    }
    const wb = await readWorkbook(r);
    const sheet = wb.worksheets[1];
    expect(sheet.rowCount).toBe(16);
    const header = sheet.getRow(1).values as unknown[];
    const publishedAt = header.indexOf("وقت النشر");
    const cell = sheet.getRow(2).getCell(publishedAt);
    expect(cell.value).toBeInstanceOf(Date);
    expect(cell.numFmt).toBe('"تقريبًا "yyyy-mm-dd');
    // the first sheet says that some dates are approximate
    const summary = wb.worksheets[0];
    const lines: string[] = [];
    summary.eachRow((row) => { const v = row.getCell(1).value; if (typeof v === "string") lines.push(v); });
    expect(lines.some((l) => l.includes("تقريبية") && l.includes("قبل ٣ أيام"))).toBe(true);
    expect(r.mission.delivered_units).toBe(315);
  });

  it("without the declared calls the engine still reads each channel when the items name their channel; with a listing that names none, the stage has no recipe and the card tells it", async () => {
    const r = await run({ calls: false });
    // a listing with no author field: nothing shows which channel each call read, so no recipe (the model would carry it out) and the card says the channels were not found in the samples
    expect(r.plannedPlan.stages[0].engine).toBeUndefined();
    expect(r.plannedPlan.stages[0].unresolved_sources).toEqual(["العربية", "اليوم السابع", "BBC News"]);
  });
});

// ---------------------------------------------------------------------------------------------------- 1b. the stored plan's stage, the live relative times (chk_ex_filter_period 16 of 16)
describe("1b. the stored YouTube stage: «قبل ٤ أيام» passes a period of 90 days (live: 16 new videos, 16 left out by the period filter, 0 saved)", () => {
  // the stage as the live plan stored it (msn_f000396a…): the period 90 days on «published», the account filter with the three names, the relevance rule
  const STAGE = {
    key: "videos", title_ar: "فيديوهات عن حرب إيران وإسرائيل من القنوات الثلاث", endpoint_id: "tikhub.x.youtube-web-search-video", expected_rows: 15, planned_rows: 15, parent_key: null, deliver: true,
    columns: columnsOf(["title", "عنوان الفيديو"], ["channel", "القناة"], ["views", "المشاهدات"], ["published", "وقت النشر"], ["length", "المدة"], ["description", "وصف الفيديو"]),
    filters: [{ kind: "period", days: 90, field: "published" }, { kind: "account", field: "username", fields: ["username", "channel"], values: ["AlArabiya العربية", "VideoYoum7 | قناة اليوم السابع", "BBC News"] }],
    relevance: { terms: ["إيران", "Iran", "إسرائيل", "Israel"], review: true, subject_ar: "حرب إيران وإسرائيل", text_columns: ["title", "description"], context_terms: ["حرب", "الحرب", "war", "صواريخ", "قصف", "هجوم", "تصعيد", "قنبلة", "نووية", "strike", "attack"], min_own_words: 2, full_name_is_enough: false },
    measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.00005,
  };
  // the sample row of the stored plan, and rows shaped like the others: every published time is relative, as the live source gave them
  const rows = [
    { id: "ReYdz3a7y-A", title: "قنبلة نووية تدمر تل أبيب.. نتنياهو ينشر صورة لزوال إسرائيل بسبب إيران", views: 702, length: "5:58", channel: "VideoYoum7 | قناة اليوم السابع", username: "@Youm7", published: "قبل 4 أيام", description: "المزيد من التفاصيل" },
    { id: "b2", title: "Iran Israel war: what we know", views: 90000, length: "3:10", channel: "BBC News", username: "@BBCNews", published: "4 days ago", description: "war strike attack" },
    { id: "b3", title: "حرب إيران وإسرائيل: صواريخ جديدة", views: 5000, length: "4:00", channel: "AlArabiya العربية", username: "@AlArabiya", published: "قبل أسبوعين", description: "حرب" },
    { id: "b4", title: "Iran Israel war last year", views: 10, length: "1:00", channel: "BBC News", username: "@BBCNews", published: "2 years ago", description: "war" },
  ];

  it("the rows of the three channels with a relative time inside the 90 days are saved with an approximate day; the one two years old is left out by the period", async () => {
    const { ingestRows } = await import("../agent/src/items/ingest");
    const { ItemStore } = await import("../agent/src/items/itemStore");
    const { createMemoryStore } = await import("../agent/src/memoryStore");
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_yt");
    const plan = { summary_ar: "x", stages: [STAGE], price: { deliveredRows: 15 } } as never;
    const r = await ingestRows({ items, plan, addEvent: async () => {} }, STAGE as never, rows, { now: Date.parse(FIXED_NOW) });
    expect(r.counts).toMatchObject({ found: 4, accepted: 3, excluded: 1 });
    expect(items.counts("videos").excludedByReason).toEqual({ filter_period: 1 });
    const saved = items.acceptedRows("videos");
    expect(saved.map((x) => [x.id, x.published])).toEqual([["ReYdz3a7y-A", "2026-10-25"], ["b2", "2026-10-25"], ["b3", "2026-10-15"]]);
    expect(saved.every((x) => Array.isArray(x._approx_dates) && x._approx_dates.includes("published"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------- 1c. a keyword plan for named channels that no sample shows, while the catalog has the channels' own listings
describe("1c. a plan that searches by keyword for three channels, none of which the samples show, is sent back to sample the channels' own listings (live: the card said «لم نجد» for all three)", () => {
  const SEARCH = "crawl4ai.youtube.search.videos";
  const LISTING = "crawl4ai.youtube.channel.videos";
  const page = (channel: string) => ({ rows: [0, 1, 2].map((i) => ({ video_id: `${channel.length}x${i}`, title: `حرب إيران وإسرائيل ${channel} ${i}`, channel, url: `https://www.youtube.com/watch?v=${channel.length}x${i}`, published: "3 days ago", views: 5, length: "3:00", description: "حرب" })) });
  it("the first proposal is refused with the routes the catalog has; after one listing was sampled the same plan is accepted (and says «not found» only for what was really looked for)", async () => {
    const { runPlanning } = await import("../agent/src/runMission");
    const { createMemoryStore, newMission } = await import("../agent/src/memoryStore");
    const { createFakeDriver } = await import("../agent/src/fakeDriver");
    const { fakeMoneyClient } = await import("./helpers/agentMoney");
    const { fakeRecorder, NOT_ADMIN, USER_ID } = await import("./helpers/agentHarness");
    const { loadTregCatalog } = await import("../src/lib/treg/catalog");
    const store = createMemoryStore();
    store.missions.set("msn_x", newMission({ id: "msn_x", user_id: USER_ID, status: "planning", request_text: request1 }));
    const answers = [tregResult(page("AlArabiya العربية"), 0.0009), tregResult(page("اليوم السابع - Youm7"), 0.0009), tregResult(page("BBC News"), 0.0009)];
    const queue = [...answers];
    const rec = fakeRecorder();
    const money = fakeMoneyClient();
    const call = vi.fn(async () => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n; });
    const stageOf = (res: Results, calls: string[], endpoint: string) => ({ key: "videos", title_ar: "فيديوهات عن حرب إيران وإسرائيل", endpoint_id: endpoint, expected_rows: 6, parent_key: null, deliver: true,
      columns: columnsOf(["title", "عنوان الفيديو"], ["channel", "القناة"], ["views", "المشاهدات"], ["published", "وقت النشر"], ["length", "المدة"], ["description", "وصف الفيديو"], ["url", "الرابط"]),
      filters: [{ kind: "account", values: ["AlArabiya العربية", "Youm7", "BBC News"] }],
      sample_rows: (({ video_id, ...v }) => [{ id: video_id, ...v }])(page("AlArabiya العربية").rows[0]), measured_by: calls, yield_from: firstOutputId(res),
      relevance: { subject_ar: "حرب إيران وإسرائيل", terms: ["إيران", "إسرائيل"], context_terms: ["حرب"], text_columns: ["title", "description"], min_own_words: 0 } });
    const MAP = (n: number) => `return inputs.call_000${n}.rows.map(v => ({ id: v.video_id, title: v.title, channel: v.channel, views: v.views, published: v.published, length: v.length, description: v.description, url: v.url }))`;
    const driver = createFakeDriver([
      { tool: "catalog_search", args: { words: ["youtube", "videos"], platform: "youtube", limit: 5 } },
      { tool: "describe_endpoint", args: { id: SEARCH } },
      { tool: "treg_call", args: { endpoint_id: SEARCH, params: { query: "العربية حرب إيران وإسرائيل", limit: 20 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: MAP(1), files: [callIds(r)[0]] }) },
      { tool: "propose_plan", args: (r: Results) => ({ summary_ar: "ستحصل على فيديوهات عن حرب إيران وإسرائيل من القنوات الثلاث.", stages: [stageOf(r, [callIds(r)[0]], SEARCH)] }) },
      // after the refusal: the channel's own listing, once
      { tool: "describe_endpoint", args: { id: LISTING } },
      { tool: "treg_call", args: { endpoint_id: LISTING, params: { channel: "@AlArabiya", limit: 12 }, why } },
      { tool: "propose_plan", args: (r: Results) => ({ summary_ar: "ستحصل على فيديوهات عن حرب إيران وإسرائيل من القنوات الثلاث.", stages: [stageOf(r, [callIds(r)[0]], SEARCH)] }) },
    ]);
    const deps = { store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
    await runPlanning(deps as never, store.missions.get("msn_x")!);
    const proposals = driver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals).toHaveLength(2);
    expect(proposals[0].result.ok).toBe(false);
    const issue = JSON.stringify(proposals[0].result.issues);
    expect(issue).toContain("take the named source itself");
    expect(issue).toContain("crawl4ai.youtube.channel.videos");
    // after the planner sampled a channel's own listing the proposal is accepted
    expect(proposals[1].result.ok).toBe(true);
    expect(store.missions.get("msn_x")!.status).toBe("plan_ready");
  });
});
const request1 = "هات من قنوات العربية واليوم السابع وبي بي سي نيوز ٥ فيديوهات من كل قناة عن حرب إيران وإسرائيل";

// ---------------------------------------------------------------------------------------------------- 2. Facebook topic videos: no plan, «تعذّر تجهيز خطة ... بسبب حد من جانبنا» (msn_020bf5c4110c15c86ab8)
describe("2. Facebook «هات ٥ فيديوهات ... عن منتخب مصر، ومن كل فيديو ١٠ تعليقات»: a planning run that ends with nothing while it holds real rows is asked once more (live: no_plan(end), no budget, turn or time limit was reached)", () => {
  const POSTS = "justoneapi.x.facebook-search-post-v1";
  const COMMENTS = "anyapi.facebook.post_comments";
  const REQUEST = "هات ٥ فيديوهات من فيسبوك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات";
  const ANSWER = "فيديوهات فقط ولو كان العدد أقل من ٥";
  /** The post search as the catalog shows it: `video` is null for a text post or a photo and an object for a video. Ten posts, three videos (the live question said: most results are text posts and photos, videos are few). */
  const post = (i: number) => ({ post_id: `fp${String(i).padStart(6, "0")}`, type: "post", url: `https://fb.example/posts/fp${String(i).padStart(6, "0")}`, message: `منتخب مصر منشور ${i}`, timestamp: 1785202291, comments_count: 40 + i, reactions_count: 100 + i, author: { name: `صفحة ${i % 5}` }, video: [2, 5, 7].includes(i) ? { url: `https://fb.example/reel/${i}` } : null });
  const postsPage = { code: 0, data: { results: Array.from({ length: 10 }, (_, i) => post(i)), cursor: null } };
  const commentsPage = { output: { data: { comments: Array.from({ length: 10 }, (_, i) => ({ id: `fp000002-c${String(i).padStart(2, "0")}`, text: `تعليق ${i}`, author: `قارئ ${i}`, createdUtc: "2026-10-21T10:00:00Z" })) } } };
  const MAP_POSTS = "return inputs.call_0001.data.results.filter(p => p.video).map(p => ({ id: p.post_id, text: p.message, url: p.url, author: p.author.name, date: p.timestamp, comments_count: p.comments_count, reactions: p.reactions_count }))";
  const MAP_COMMENTS = "return inputs.call_0003.output.data.comments.map(c => ({ id: c.id, text: c.text, author: c.author, date: c.createdUtc }))";

  // the first run: two keyword searches (the live ones), then it ends with a plain end; the second run (asked for by code) does what the planner should have done
  const first: FakeStep[] = [
    { tool: "catalog_search", args: { words: ["facebook", "posts", "search"], platform: "facebook", limit: 5 } },
    { tool: "describe_endpoint", args: { id: POSTS } },
    { tool: "treg_call", args: { endpoint_id: POSTS, params: { keyword: "منتخب مصر" }, why } },
    { tool: "treg_call", args: { endpoint_id: POSTS, params: { keyword: "فيديو منتخب مصر" }, why } },
  ];
  const second: FakeStep[] = [
    { tool: "run_code", args: (r: Results) => ({ code: MAP_POSTS, files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: COMMENTS } },
    { tool: "treg_call", args: { endpoint_id: COMMENTS, params: { url: post(2).url }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: MAP_COMMENTS, files: [callIds(r)[2]] }) },
    { tool: "propose_plan", args: (r: Results) => ({
      summary_ar: "ستحصل على فيديوهات فيسبوك عن منتخب مصر، ومن كل فيديو أول تعليقاته.",
      target_note: undefined,
      stages: [
        { key: "videos", title_ar: "فيديوهات فيسبوك عن منتخب مصر", endpoint_id: POSTS, expected_rows: 5, target_reason_ar: "أغلب منشورات فيسبوك عن منتخب مصر نصوص وصور والفيديوهات قليلة بينها", parent_key: null, deliver: true,
          columns: columnsOf(["text", "نص المنشور"], ["url", "رابط الفيديو"], ["author", "الصفحة"], ["date", "التاريخ والوقت"], ["comments_count", "عدد التعليقات"], ["reactions", "الإعجابات"]),
          sample_rows: [2, 5, 7].map((i) => ({ id: post(i).post_id, text: post(i).message, url: post(i).url, author: post(i).author.name, date: post(i).timestamp, comments_count: post(i).comments_count, reactions: post(i).reactions_count })), measured_by: [callIds(r)[0]], yield_from: firstOutputId(r),
          relevance: { subject_ar: "منتخب مصر", terms: ["منتخب مصر"], text_columns: ["text"], min_own_words: 0 } },
        { key: "comments", title_ar: "تعليقات على الفيديوهات", endpoint_id: COMMENTS, expected_rows: 50, parent_key: "videos", per_parent_rows: 10, deliver: true,
          columns: columnsOf(["text", "نص التعليق"], ["author", "كاتب التعليق"], ["date", "التاريخ والوقت"]),
          sample_rows: [{ id: "fp000002-c00", text: "تعليق 0", author: "قارئ 0", date: "2026-10-21T10:00:00Z" }], measured_by: [callIds(r)[2]] },
      ],
    }) },
  ];

  async function run(nudge: FakeStep[] | undefined) {
    const { runPlanning } = await import("../agent/src/runMission");
    const { createMemoryStore, newMission } = await import("../agent/src/memoryStore");
    const { createFakeDriver } = await import("../agent/src/fakeDriver");
    const { fakeMoneyClient } = await import("./helpers/agentMoney");
    const { fakeRecorder, NOT_ADMIN, USER_ID } = await import("./helpers/agentHarness");
    const { loadTregCatalog } = await import("../src/lib/treg/catalog");
    const store = createMemoryStore();
    store.missions.set("msn_fb", newMission({ id: "msn_fb", user_id: USER_ID, status: "planning", request_text: REQUEST, answer_text: ANSWER }));
    const queue = [tregResult(postsPage, 0.02952), tregResult(postsPage, 0.02952), tregResult(commentsPage, 0.002)];
    const rec = fakeRecorder();
    const money = fakeMoneyClient();
    const call = vi.fn(async () => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n; });
    const driver = createFakeDriver(first, nudge ? { nudgeScript: nudge } : {});
    const deps = { store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
    await runPlanning(deps as never, store.missions.get("msn_fb")!);
    return { store, driver, mission: store.missions.get("msn_fb")! };
  }

  it("without the second run the mission ends as live: «no_plan(end)», an internal failure (the control)", async () => {
    const r = await run(undefined);
    expect(r.mission.status).toBe("failed");
    expect(String(r.mission.error)).toContain("no_plan(end)");
  });

  it("with it, the planner builds the plan from the rows it holds: a card for videos only (fewer than five, said on the card with a reason), with the comments stage", async () => {
    const r = await run(second);
    expect(r.mission.status).toBe("plan_ready");
    const plan = r.mission.plan!;
    expect(plan.stages.map((s) => [s.key, s.deliver])).toEqual([["videos", true], ["comments", true]]);
    expect(plan.price.deliveredRows).toBeGreaterThan(0);
    // both runs' model cost is on the mission and the tokens of both runs are recorded (the admin sees two runs)
    expect(Number(r.mission.planning_llm_usd)).toBeCloseTo(0.02, 6);
    expect(r.store.events.filter((e) => e.counts && "tok_in" in e.counts)).toHaveLength(2);
    // no refusal and no failure was recorded: the first end was a plain end
    expect(String(r.mission.error ?? "")).toBe("");
  });

  it("a run that ends WITHOUT any real rows is not asked again (nothing to build a plan from), and a run stopped by a limit is not asked again either", async () => {
    const { runPlanning } = await import("../agent/src/runMission");
    const { createMemoryStore, newMission } = await import("../agent/src/memoryStore");
    const { fakeMoneyClient } = await import("./helpers/agentMoney");
    const { fakeRecorder, NOT_ADMIN, USER_ID } = await import("./helpers/agentHarness");
    const { loadTregCatalog } = await import("../src/lib/treg/catalog");
    for (const stop of ["end", "wall"]) {
      const store = createMemoryStore();
      store.missions.set("msn_n", newMission({ id: "msn_n", user_id: USER_ID, status: "planning", request_text: REQUEST }));
      let runs = 0;
      const driver = { async run() { runs += 1; return { llmCostUsd: 0.001, turns: 1, stop, usage: { input_tokens: 1, output_tokens: 1 } } as never; } };
      const rec = fakeRecorder();
      await runPlanning({ store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: (async () => { throw new Error("no call"); }) as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN } as never, store.missions.get("msn_n")!);
      expect(runs, stop).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------------------------------- 3. companies: «عايز ٥٠ شركة مقاولات في مصر» (msn_f86308d4f2797152e991)
describe("3. contracting companies in Egypt: a row that is not a contracting company, or not Egyptian, is not delivered; names and cities are cleaned (live: 5 such rows and four English city cells in the file)", () => {
  // the stage as the live plan stored it: the tomba company search asked for Egypt (the place by source), the sector rule, the place filter with the city, country, website and domain
  const COLUMNS = columnsOf(["name", "اسم الشركة"], ["description", "نبذة عن الشركة"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["company_size", "حجم الشركة"], ["linkedin", "ملف الشركة المهني"], ["country", "الدولة"]);
  const STAGE = {
    key: "companies", title_ar: "شركات المقاولات في مصر", endpoint_id: "tomba.companies.search.reveal", expected_rows: 50, planned_rows: 50, parent_key: null, deliver: true, columns: COLUMNS,
    filters: [{ kind: "place", field: "city", fields: ["city", "country", "website", "domain"], places: ["EG"], values: ["مصر"], by_source: true }],
    relevance: { terms: ["مقاولات", "مقاولة", "construction", "contracting", "contractors", "contractor", "builders", "engineering"], entity: true, review: true, subject_ar: "شركات مقاولات", text_columns: ["name", "description", "company_size"], min_own_words: 0 },
    measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.00000356,
  };
  const co = (id: string, name: string, description: string, city: string, country = "EG", website = `${id}.com`) => ({ id, name, description, city, country, website, domain: website, company_size: "51-200", linkedin: `https://linkedin.com/company/${id}`, text: `${name} ${description}` });
  const GOOD = [
    co("orascom", "Orascom Construction", "Orascom Construction is a leading contractor in Egypt, the Middle East and Africa", "Cairo"),
    co("hassanallam", "Hassan Allam Holding", "Egyptian contracting and engineering group", "Nasr City"),
    co("arabcont", "Arab Contractors", "Egyptian contractor founded in 1955", "Down Town"),
    co("mokawloon", "El Mokawloon Engineering", "Engineering and contractors in Egypt", "Zahraa El Maadi"),
    co("samcrete", "Samcrete Egypt", "Construction and engineering consultancy", "First New Cairo"),
    co("metro", "Metro Builders", "Builders of residential compounds", "mokattam"),
    co("nile", "Nile Construction", "Contracting company", "Of"),
  ];
  // the five of the live file, with the text the owner read in it (the CSV line, the law firm in Seattle, the discussion site in Miami, the head office in Abu Dhabi, the Saudi company)
  const BAD = [
    co("big5", "Big 5 Construct Egypt", "Find new business opportunities in Egypt's USD 570 billion construction market", "Cairo"),
    co("serious", 'serious construction "sc",,11-50,seriouscons.com', "A law firm in Seattle serving construction clients", "Seattle", "", ""),
    co("fcc", "FCC Construction & Development", "fcc.com is a discussion site about construction", "miami", "", "fcc.com"),
    co("fibrex", "fibrex construction group", "A construction group whose head office is in Abu Dhabi, United Arab Emirates", "", "EG", "fibrex.com"),
    co("cpc", "cpc egypt", "A leading Saudi contracting company based in Riyadh, Saudi Arabia", "", "EG", "cpc.com"),
  ];
  // a real company whose name is a broken line of a spreadsheet (a size band and a domain after the name): its name is cleaned and the model check looks at it
  const DEBRIS = co("sc2", 'serious construction "sc",,11-50,seriouscons.com', "A general contractor building roads and bridges in Egypt", "Cairo", "EG", "seriouscons.com");

  /** The model check: a row that says it is an event, a law firm, a discussion site or a head office abroad is not a contracting company in Egypt. */
  const asked: string[] = [];
  const review = async ({ user }: { user: string }) => {
    const rows = user.split("\n").filter((l) => /^\d+\./.test(l));
    asked.push(...rows);
    return { text: JSON.stringify(rows.map((l) => (/business opportunities|law firm|discussion site|head office is in|Saudi/i.test(l) ? 0 : 1))), usage: { input_tokens: 300, output_tokens: 20 } };
  };

  async function ingest(rows: unknown[]) {
    const { ingestRows } = await import("../agent/src/items/ingest");
    const { ItemStore } = await import("../agent/src/items/itemStore");
    const { createMemoryStore } = await import("../agent/src/memoryStore");
    const { createReviewer } = await import("../agent/src/review");
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_co");
    const reviewer = createReviewer({ call: review as never, store, missionId: "msn_co", requestText: "عايز ٥٠ شركة مقاولات في مصر", budgetUsd: 0.05 });
    asked.length = 0;
    const plan = { summary_ar: "x", stages: [STAGE], price: { deliveredRows: 50 } } as never;
    await ingestRows({ items, plan, reviewer, addEvent: async () => {} }, STAGE as never, rows, { now: Date.parse(FIXED_NOW) });
    return items;
  }

  it("the five rows of the live file are not delivered: the two whose city is in the USA by the place check, the three whose own text contradicts the card by the model check; the others are delivered", async () => {
    const items = await ingest([...BAD, ...GOOD]);
    const accepted = items.acceptedRows("companies").map((r) => r.id);
    expect(accepted).toEqual(GOOD.map((g) => g.id));
    const excluded = Object.fromEntries(items.excludedItems("companies").map((x) => [x.id, x.reason]));
    expect(excluded).toEqual({ serious: "filter_place", fcc: "filter_place", big5: "review_no", fibrex: "review_no", cpc: "review_no" });
    // only the rows the rule could not vouch for went to the model check: the three, and none of the good ones
    expect(asked).toHaveLength(3);
    expect(asked.join("\n")).toMatch(/Big 5 Construct/);
    expect(asked.join("\n")).not.toMatch(/Orascom|Hassan Allam|Arab Contractors/);
  });

  it("a name that is a broken spreadsheet line is cut back to the name and the row goes to the model check; the delivered name is the clean one, the id is the one the source's own item gave", async () => {
    const items = await ingest([DEBRIS, ...GOOD.slice(0, 2)]);
    const rows = items.acceptedRows("companies");
    expect(rows.map((r) => r.id)).toEqual(["sc2", "orascom", "hassanallam"]);
    expect(rows[0].name).toBe("serious construction sc");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/serious construction sc/);
    expect(asked[0]).not.toContain(",,11-50");
  });

  it("the city cells are Arabic for a district or a city of the table, and «غير مذكورة في المصدر» for a fragment; the company's other cells stay as the source gave them", async () => {
    const items = await ingest(GOOD);
    const city = Object.fromEntries(items.acceptedRows("companies").map((r) => [r.id, r.city]));
    expect(city).toEqual({ orascom: "القاهرة", hassanallam: "مدينة نصر", arabcont: "وسط البلد", mokawloon: "زهراء المعادي", samcrete: "التجمع الأول", metro: "المقطم", nile: "غير مذكورة في المصدر" });
    const first = items.acceptedRows("companies")[0];
    expect(first.name).toBe("Orascom Construction");
    expect(first.country).toBe("مصر");
    expect(first.website).toBe("orascom.com");
  });

  it("without a place promised nothing is sent to the check for a head office abroad (the card promised nothing about the place); a law firm still is", async () => {
    const { ingestRows } = await import("../agent/src/items/ingest");
    const { ItemStore } = await import("../agent/src/items/itemStore");
    const { createMemoryStore } = await import("../agent/src/memoryStore");
    const { createReviewer } = await import("../agent/src/review");
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_co2");
    const reviewer = createReviewer({ call: review as never, store, missionId: "msn_co2", requestText: "شركات مقاولات", budgetUsd: 0.05 });
    asked.length = 0;
    const noPlace = { ...STAGE, filters: [] };
    await ingestRows({ items, plan: { summary_ar: "x", stages: [noPlace], price: { deliveredRows: 50 } } as never, reviewer, addEvent: async () => {} }, noPlace as never, [BAD[3], BAD[0], GOOD[0]], { now: Date.parse(FIXED_NOW) });
    expect(items.acceptedRows("companies").map((r) => r.id)).toEqual(["fibrex", "orascom"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/Big 5/);
  });
});
