import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tregResult } from "./helpers/agentFakeWorld";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { GIVE_UP_MIN_SOURCES, GIVE_UP_NO_ROWS_REFUSALS_MAX, untriedBeforeGiveUp, type PlanningCallFact } from "../src/lib/agentMission/giveUp";

/**
 * FIX MISSION 12 (live retest of 2026-10-30 evening, test account; `missions`, `mission_calls`, `mission_events` read with SELECT). Every moment here is FIXED: no test reads the clock.
 */
const FIXED_NOW = "2026-10-30T18:00:00.000Z";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(FIXED_NOW)); });
afterEach(() => { vi.useRealTimers(); });

const REQUEST_YT = "هات من قنوات العربية واليوم السابع وبي بي سي نيوز الإنجليزية على يوتيوب ٥ فيديوهات من كل قناة عن حرب إيران وإسرائيل آخر ٣ شهور، ومن كل فيديو ٢٠ تعليق";
const catalog = loadTregCatalog();
const ACCESS = NOT_ADMIN;

// ---------------------------------------------------------------------------------------------------- 1. YouTube named channels: a give-up after one empty call (msn_b7cfff314b8be6dbb25c, msn_cf68eb4c9052406a8769)
describe("1. YouTube named channels: planning gave up before the channel listings of the catalog were ever called", () => {
  /** The calls of the 18:01 run, as stored: one empty channel search with an id the model made up, two web searches refused as unavailable. */
  const LIVE_1801: PlanningCallFact[] = [
    { endpoint_id: "tikhub.x.youtube-web-search-channel", status: "empty", rows_returned: 0 },
    { endpoint_id: "contextdev.search", status: "refused" },
    { endpoint_id: "firecrawl.search", status: "refused" },
  ];
  /** The calls of the 17:58 run: only web sources, all refused as unavailable. */
  const LIVE_1758: PlanningCallFact[] = [
    { endpoint_id: "contextdev.search", status: "refused" }, { endpoint_id: "firecrawl.search", status: "refused" },
    { endpoint_id: "contextdev.scrape", status: "refused" }, { endpoint_id: "firecrawl.scrape", status: "refused" },
  ];
  const ask = (calls: PlanningCallFact[], request = REQUEST_YT) => untriedBeforeGiveUp({ request, catalog, access: ACCESS, stats: new Map(), now: Date.parse(FIXED_NOW), calls });

  it("the 18:01 run: one source was reached, the channel listings were never called, so a give-up does not stand", () => {
    const r = ask(LIVE_1801);
    expect(r.applies).toBe(true);
    expect(r.reached).toBe(1);
    const listings = r.untried.filter((s) => s.listing).map((s) => s.id);
    expect(listings).toContain("crawl4ai.youtube.channel.videos");
    expect(listings).toContain("scrapecreators.x.v1-youtube-channel-videos");
    // the named source's own listing comes before the keyword searches, and the source already called is not offered again
    expect(r.untried[0].listing).toBe(true);
    expect(r.untried.map((s) => s.id)).not.toContain("tikhub.x.youtube-web-search-channel");
  });

  it("the 17:58 run: only unavailable web sources were called, nothing was reached", () => {
    const r = ask(LIVE_1758);
    expect(r).toMatchObject({ applies: true, reached: 0 });
  });

  it("after three sources were reached (answered, empty or failed) the give-up stands, and a sample with rows leaves it to the other guard", () => {
    const three: PlanningCallFact[] = ["crawl4ai.youtube.channel.videos", "scrapecreators.x.v1-youtube-channel-videos", "tikhub.youtube.channel.videos"].map((endpoint_id, i) => ({ endpoint_id, status: i === 0 ? "empty" : "failed", rows_returned: 0 }));
    expect(GIVE_UP_MIN_SOURCES).toBe(3);
    expect(ask(three).applies).toBe(false);
    expect(ask([...LIVE_1801, { endpoint_id: "crawl4ai.youtube.channel.videos", status: "ok", rows_returned: 12 }]).applies).toBe(false);
  });

  it("a request that names no channel, account or page keeps its behaviour", () => {
    expect(ask([], "هات ٥٠ فيديو عن حرب إيران وإسرائيل على يوتيوب").applies).toBe(false);
    expect(ask([], "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر").applies).toBe(false);
  });

  it("the live sequence through the worker: the first give-up is sent back with the channel listings named, and the run is not stuck (a limit of refusals)", async () => {
    const store = createMemoryStore();
    store.missions.set("msn_yt", newMission({ id: "msn_yt", user_id: USER_ID, status: "planning", request_text: REQUEST_YT }));
    const rec = fakeRecorder();
    const queue = [tregResult({ rows: [] }, 0.001)];
    const call = async () => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n; };
    const giveUp = (): FakeStep => ({ tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "لا أستطيع خدمة هذا الطلب." } });
    const driver = createFakeDriver([
      { tool: "catalog_search", args: { words: ["youtube", "channel", "videos"], platform: "youtube", limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: "tikhub.x.youtube-web-search-channel", params: { channel_id: "UCahpxixMDAE_6rTZq_6v_Zw", search_query: "Iran Israel war" }, why: "the channel search is the only one that takes a channel" } },
      giveUp(), giveUp(), giveUp(), giveUp(),
    ]);
    const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
    await runPlanning(deps, store.missions.get("msn_yt")!);
    const finishes = driver.results.filter((x) => x.tool === "finish").map((x) => x.result as { ok?: boolean; error?: string });
    expect(GIVE_UP_NO_ROWS_REFUSALS_MAX).toBe(3);
    expect(finishes.map((x) => x.ok === true)).toEqual([false, false, false, true]);
    expect(finishes[0].error).toContain("crawl4ai.youtube.channel.videos");
    expect(finishes[0].error).toContain("do not end yet");
    // the mission ends honestly once the limit of refusals is spent (the same classes as before)
    expect(store.missions.get("msn_yt")!.status).toBe("unserved");
  });
});

// ---------------------------------------------------------------------------------------------------- 2. Facebook videos: a card for videos from a post search that proves none (msn_e39585e687833914039e)
import { callIds, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { filterVerdict, type StageFilter } from "../src/lib/agentMission/filters";
import { itemProvesMedia, mediaFieldsOf, mediaProofSources, rawMediaProof, requestedMedia } from "../src/lib/agentMission/mediaProof";

describe("2. Facebook «هات ٥ فيديوهات ... عن منتخب مصر، ومن كل فيديو ١٠ تعليقات»: the card promises videos only when the sampled items prove them (live: card 405 points, approved, then «لم يُسلَّم أي شيء»)", () => {
  const POSTS = "justoneapi.x.facebook-search-post-v1";
  const COMMENTS = "scrapecreators.x.v1-facebook-post-comments";
  const REQUEST = "هات ٥ فيديوهات من فيسبوك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات";
  const why = "the cheaper sources return no author or link fields in their catalog description";
  const REEL = "https://www.facebook.com/reel/1533703954771013/";
  /** The post search as the catalog's own example shows it: `video` is null for a text or photo post and an object for a video. Five posts of the live sample; `videoAt` says which carry one. */
  const page = (videoAt: number[]) => ({ code: 0, data: { results: Array.from({ length: 5 }, (_, i) => ({ post_id: `fp00000${i}`, type: "post", url: `https://www.facebook.com/page${i}/posts/pfbid0${i}`, message: `منتخب مصر منشور رقم ${i}`, timestamp: 1785202291 + i, comments_count: 10, reactions_count: 20, author: { name: `صفحة ${i}` }, video: videoAt.includes(i) ? { id: "1533703954771013", url: REEL } : null, video_files: null })), cursor: null } });
  const commentsPage = { success: true, comments: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, text: `تعليق ${i}`, author: { name: `قارئ ${i}` }, created_at: "2026-10-03T09:42:08.000Z" })) };
  const MAP = "return inputs.call_0001.data.results.map(p => ({ id: p.post_id, text: p.message, author: p.author.name, link: p.url, shared_video_link: p.video ? p.video.url : '', comments: p.comments_count, date: new Date(p.timestamp * 1000).toISOString() }))";
  const MAP_COMMENTS = "return inputs.call_0002.comments.map(c => ({ id: c.id, text: c.text, author: c.author.name, date: c.created_at }))";
  const cols = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));
  const rowOf = (i: number, withVideo: boolean) => ({ id: `fp00000${i}`, text: `منتخب مصر منشور رقم ${i}`, author: `صفحة ${i}`, link: `https://www.facebook.com/page${i}/posts/pfbid0${i}`, shared_video_link: withVideo ? REEL : "", comments: 10, date: "2026-07-28T13:59:55.000Z" });

  const steps = (videoAt: number[]): FakeStep[] => [
    { tool: "catalog_search", args: { words: ["facebook", "posts", "search"], platform: "facebook", limit: 5 } },
    { tool: "describe_endpoint", args: { id: POSTS } },
    { tool: "treg_call", args: { endpoint_id: POSTS, params: { keyword: "منتخب مصر" }, why } },
    { tool: "describe_endpoint", args: { id: COMMENTS } },
    { tool: "treg_call", args: { endpoint_id: COMMENTS, params: { url: "https://www.facebook.com/page0/posts/pfbid00" }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: MAP, files: [callIds(r)[0]] }) },
    { tool: "run_code", args: (r: Results) => ({ code: MAP_COMMENTS, files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: (r: Results) => ({
      summary_ar: "نجمع منشورات فيسبوك عن منتخب مصر التي تتضمن فيديو، ومن كل منشور عشرة تعليقات.",
      stages: [
        { key: "posts", title_ar: "منشورات فيسبوك عن منتخب مصر تتضمن فيديو", endpoint_id: POSTS, expected_rows: 5, target_reason_ar: "الفيديوهات قليلة بين نتائج البحث", parent_key: null, deliver: false,
          columns: cols(["text", "نص المنشور"], ["author", "الناشر"], ["link", "رابط المنشور"], ["shared_video_link", "رابط الفيديو المرفق"], ["comments", "عدد التعليقات"], ["date", "تاريخ المنشور"]),
          sample_rows: [rowOf(0, videoAt.includes(0))], measured_by: [callIds(r)[0]], yield_from: firstOutputId(r),
          relevance: { subject_ar: "منتخب مصر", terms: ["منتخب مصر"], text_columns: ["text"], min_own_words: 0 } },
        { key: "comments", title_ar: "تعليقات على المنشورات المختارة", endpoint_id: COMMENTS, expected_rows: 50, parent_key: "posts", per_parent_rows: 10, deliver: true,
          columns: cols(["text", "نص التعليق"], ["author", "المعلّق"], ["date", "تاريخ التعليق"]),
          sample_rows: [{ id: "c0", text: "تعليق 0", author: "قارئ 0", date: "2026-10-03T09:42:08.000Z" }], measured_by: [callIds(r)[1]] },
      ],
    }) },
  ];
  async function run(videoAt: number[]) {
    const store = createMemoryStore();
    store.missions.set("msn_fbv", newMission({ id: "msn_fbv", user_id: USER_ID, status: "planning", request_text: REQUEST }));
    const queue = [tregResult(page(videoAt), 0.02952), tregResult(commentsPage, 0.00188)];
    const call = async () => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n; };
    const driver = createFakeDriver(steps(videoAt));
    const rec = fakeRecorder();
    const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
    await runPlanning(deps, store.missions.get("msn_fbv")!);
    return { store, driver, mission: store.missions.get("msn_fbv")! };
  }

  it("the request counts videos; the item kinds are read by code", () => {
    expect(requestedMedia(REQUEST)).toBe("video");
    expect(requestedMedia("هات ٣٠ صورة من انستجرام عن القهوة")).toBe("image");
    expect(requestedMedia("هات ٥٠ بوست عن غلاء الأسعار")).toBeNull();
  });

  it("the live sample (one post of five carries a video): the card is made, the stage keeps ONLY posts that prove a video, and the card says so", async () => {
    const r = await run([0]);
    expect(r.mission.status).toBe("plan_ready");
    const posts = r.mission.plan!.stages.find((s) => s.key === "posts")!;
    const media = (posts.filters ?? []).find((f) => f.kind === "media");
    expect(media).toMatchObject({ kind: "media", media: "video" });
    expect(media!.enabled).not.toBe(false);
    // the price rests on the measured share of posts that prove a video: one of five at most
    expect(posts.yield_share!).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(JSON.stringify(r.mission.plan_public)).toContain("المنشورات التي تحمل فيديو فقط");
  });

  it("the engine's check on the five live posts: only the one with a video is delivered, the other four are left out with their reason", async () => {
    const r = await run([0]);
    const filters = r.mission.plan!.stages.find((s) => s.key === "posts")!.filters as StageFilter[];
    const verdicts = [0, 1, 2, 3, 4].map((i) => filterVerdict(filters, rowOf(i, i === 0), { textKey: "text", now: Date.parse(FIXED_NOW) }));
    expect(verdicts).toEqual([null, "filter_media", "filter_media", "filter_media", "filter_media"]);
  });

  const REELS = "scrapecreators.x.v1-facebook-profile-reels";
  const reelsPage = { success: true, reels: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, post_id: `rp${i}`, creation_time: "2026-10-03T09:42:08.000Z", url: `https://www.facebook.com/reel/15337039547710${i}`, view_count: 1000 + i, description: `منتخب مصر ريل رقم ${i}`, video_id: `15337039547710${i}` })) };
  const MAP_REELS = "return inputs.call_0003.reels.map(r => ({ id: r.video_id, text: r.description, link: r.url, views: r.view_count, date: r.creation_time }))";
  /** The live plan shape (a post search whose sampled posts prove no video), then the planner does what it is sent to do: it samples the page's reels and builds the card from them. */
  const reelsFlow = (): FakeStep[] => [
    ...steps([]),
    { tool: "describe_endpoint", args: { id: REELS } },
    { tool: "treg_call", args: { endpoint_id: REELS, params: { url: "https://www.facebook.com/page0" }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: MAP_REELS, files: [callIds(r)[2]] }) },
    { tool: "propose_plan", args: (r: Results) => ({
      summary_ar: "نجمع ريلز فيسبوك عن منتخب مصر، ومن كل ريل عشرة تعليقات.",
      stages: [
        { key: "posts", title_ar: "ريلز فيسبوك عن منتخب مصر", endpoint_id: REELS, expected_rows: 5, parent_key: null, deliver: false,
          columns: cols(["text", "وصف الريل"], ["link", "رابط الريل"], ["views", "المشاهدات"], ["date", "التاريخ"]),
          sample_rows: [{ id: "153370395477100", text: "منتخب مصر ريل رقم 0", link: "https://www.facebook.com/reel/153370395477100", views: 1000, date: "2026-10-03T09:42:08.000Z" }], measured_by: [callIds(r)[2]], yield_from: firstOutputId(r),
          relevance: { subject_ar: "منتخب مصر", terms: ["منتخب مصر"], text_columns: ["text"], min_own_words: 0 } },
        { key: "comments", title_ar: "تعليقات على الريلز المختارة", endpoint_id: COMMENTS, expected_rows: 50, parent_key: "posts", per_parent_rows: 10, deliver: true,
          columns: cols(["text", "نص التعليق"], ["author", "المعلّق"], ["date", "تاريخ التعليق"]),
          sample_rows: [{ id: "c0", text: "تعليق 0", author: "قارئ 0", date: "2026-10-03T09:42:08.000Z" }], measured_by: [callIds(r)[1]] },
      ],
    }) },
  ];
  async function runFlow(flow: FakeStep[], answers: unknown[]) {
    const store = createMemoryStore();
    store.missions.set("msn_fbv2", newMission({ id: "msn_fbv2", user_id: USER_ID, status: "planning", request_text: REQUEST }));
    const queue = [...answers];
    const call = async () => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n as never; };
    const driver = createFakeDriver(flow);
    const rec = fakeRecorder();
    const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
    await runPlanning(deps, store.missions.get("msn_fbv2")!);
    return { store, driver, mission: store.missions.get("msn_fbv2")! };
  }

  it("no sampled post proves a video: the plan is NOT refused, it is sent to the catalog's video and reel sources, and the card is built from the one that proves video", async () => {
    const r = await runFlow(reelsFlow(), [tregResult(page([]), 0.02952), tregResult(commentsPage, 0.00188), tregResult(reelsPage, 0.00188)]);
    const proposals = r.driver.results.filter((x) => x.tool === "propose_plan").map((x) => x.result as { ok?: boolean; issues?: string[] });
    expect(proposals[0].ok).toBe(false);
    const sentBack = JSON.stringify(proposals[0].issues);
    // it names the catalog's sources that can prove a video: the page's reels first, then the post search that carries a video object, then the post's detail and transcript
    expect(sentBack).toContain(REELS);
    expect(sentBack).toContain("anyapi.facebook.profile_reels");
    expect(sentBack).not.toContain("justoneapi.x.facebook-search-post-v1"); // already sampled: not offered again
    expect(sentBack).toContain("anyapi.facebook.post_transcript");
    expect(proposals[1].ok).toBe(true);
    expect(r.mission.status).toBe("plan_ready");
    expect(r.mission.plan!.stages[0].endpoint_id).toBe(REELS);
    // the source's items ARE reels: no media filter is needed and the card does not say that video could not be proven
    expect((r.mission.plan!.stages[0].filters ?? []).some((f) => f.kind === "media")).toBe(false);
    expect(JSON.stringify(r.mission.plan_public)).not.toContain("لم نجد في المصادر المتاحة ما يثبت وجود فيديو");
  });

  it("after three send-backs with fewer than three media sources reached, the plan is accepted and the card tells the customer BEFORE approval (the filter stays, only proven posts are delivered)", async () => {
    const same = steps([]);
    const propose = same[same.length - 1];
    const r = await runFlow([...same, propose, propose, propose], [tregResult(page([]), 0.02952), tregResult(commentsPage, 0.00188)]);
    const proposals = r.driver.results.filter((x) => x.tool === "propose_plan").map((x) => (x.result as { ok?: boolean }).ok === true);
    expect(proposals).toEqual([false, false, false, true]);
    expect(r.mission.status).toBe("plan_ready");
    expect(JSON.stringify(r.mission.plan_public)).toContain("لم نجد في المصادر المتاحة ما يثبت وجود فيديو");
  });

  it("the catalog's media sources of Facebook, by how they prove it", () => {
    const list = mediaProofSources(catalog, "facebook", "video", () => true);
    const by = (how: string) => list.filter((x) => x.how === how).map((x) => x.id);
    expect(by("own")).toEqual(["anyapi.facebook.profile_reels", "scrapecreators.x.v1-facebook-profile-reels"]);
    expect(by("field")).toContain("justoneapi.x.facebook-search-post-v1");
    expect(by("verify")).toEqual(expect.arrayContaining(["scrapecreators.x.v1-facebook-post-transcript", "anyapi.facebook.post_transcript", "scrapecreators.x.v1-facebook-post"]));
  });

  it("the proof reader: the catalog's own item fields (a video object, a reel address, a type) prove a video; a null field, a text or a photo post prove nothing", () => {
    const raw = page([1, 3]);
    expect(rawMediaProof("video", [JSON.stringify(raw)])).toEqual({ examined: 5, proven: 2 });
    expect(rawMediaProof("video", [JSON.stringify(page([]))])).toEqual({ examined: 5, proven: 0 });
    expect(itemProvesMedia("video", { type: "reel", url: "x" }, ["type", "url"])).toBe(true);
    expect(itemProvesMedia("video", { type: "post", url: "https://www.facebook.com/p/posts/1" }, ["type", "url"])).toBe(false);
    expect(itemProvesMedia("video", { url: "https://www.facebook.com/reel/123/" }, ["url"])).toBe(true);
    expect(itemProvesMedia("video", { video: null, video_files: null }, mediaFieldsOf(["video", "video_files"], "video"))).toBe(false);
    expect(itemProvesMedia("image", { image: { uri: "https://x/y.jpg" } }, ["image"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------- 3. Companies: 40 of 148 (msn_f0211c1a4633e0c2114e)
import { assertReplayInvariants, replay } from "./helpers/agentReplay";
import { readSnapshot } from "../agent/src/items/itemStore";
import { createReviewer } from "../agent/src/review";
import { bindingFallbacks, liftedVolume } from "../agent/src/engine/spec";

describe("3. «عايز ٥٠ شركة مقاولات في مصر، ومن كل شركة اتنين من المديرين»: the source is asked for what it can give, the model check is asked again until it answers, the people are asked for every company with a usable input (live: 18 of 49 companies, 22 people for 11 companies, 40 of 148)", () => {
  const COMPANIES = "parallel.companies.search";
  const EMPLOYEES = "aviato.companies.employees";
  const REQUEST_CO = "عايز ٥٠ شركة مقاولات في مصر، ومن كل شركة اتنين من المديرين";
  const cols = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));
  const why = "the cheaper sources are searches by hiring or by people, not by sector and place";
  /** The source's pool as the live page shaped it: an entity with a name, the company's LinkedIn address when it has one, and ONE text field (website, country, short description). Every 5th is a US company, three of four of the rest say nothing the rule can read (they wait for the model check). */
  const entity = (i: number) => {
    const us = i % 5 === 0;
    const unsure = !us && i % 4 !== 1;
    const name = unsure ? `Delta Group ${i}` : `Nile Construction Company ${i}`;
    const sd = unsure ? "Provider of civil works and construction support." : "Provider of engineering, construction, and project management services.";
    return { name, url: i % 2 === 0 ? `https://linkedin.com/company/co-${i}` : "https://example.org/x", description: `Website Url: https://co${i}.eg | Location Country: ${us ? "United States" : "Egypt"} | Short Description: ${sd} | Primary Sector: Construction` };
  };
  const POOL = Array.from({ length: 100 }, (_, i) => entity(i + 1));
  const MAP_CO = "const rows = inputs.call_0001.entities || []; return rows.map(r => { const d = r.description || ''; const web = d.match(/Website Url:\\s*(https?:\\/\\/[^\\s|]+)/); const loc = (d.match(/Location Country:\\s*([^|]+)/)||[])[1] || ''; const sd = (d.match(/Short Description:\\s*([^|]+)/)||[])[1] || ''; const li = /linkedin\\.com\\/company\\//.test(r.url||'') ? r.url : ''; return { id: web ? web[1].replace(/^https?:\\/\\//,'') : r.url, name: r.name, website: web ? web[1] : '', country: loc.trim(), linkedin: li, description: sd.trim() }; })";
  const MAP_EMP = "const rows = inputs.call_0002.employees || []; return rows.map(r => { const p = r.person || {}; const pos = (r.positionList && r.positionList[0]) || {}; return { id: r.personID, parent_company: r.companyName || '', name: p.fullName || '', title: pos.title || '', profile: p.URLs && p.URLs.linkedin ? p.URLs.linkedin : '' }; })";
  const employeesOf = (key: string) => ({ employees: [0, 1].map((k) => ({ personID: `${key}-p${k}`, companyName: key, positionList: [{ title: k === 0 ? "General Manager" : "Operations Manager" }], person: { fullName: `Person ${key} ${k}`, URLs: { linkedin: `linkedin.com/in/${key}-${k}` } } })) });
  const answerFor = (o: { endpointId?: string; params?: unknown }) => {
    const p = (o.params ?? {}) as Record<string, unknown>;
    if (o.endpointId === COMPANIES) return tregResult({ entities: POOL.slice(0, Math.min(Number(p.match_limit) || 100, 100)) }, 0.005);
    const key = String(p.linkedinURL ?? p.website ?? "x").replace(/^.*\/company\//, "").replace(/\/$/, "");
    return tregResult(employeesOf(key), 0.005);
  };
  /** The model check as the live one behaved: asked for 24 rows with 116 tokens of room it wrote more than the room allowed and was cut (4 calls, 464 tokens, none usable); given room, it answers. */
  const cutAt = (n: number) => 4 * n + 20;
  const makeReview = (log: Array<{ rows: number; maxTokens: number; answered: boolean }>) => async ({ user, maxTokens }: { user: string; maxTokens: number }) => {
    const rows = user.split("\n").filter((l) => /^\d+\./.test(l));
    const room = cutAt(rows.length);
    if (maxTokens <= room) { log.push({ rows: rows.length, maxTokens, answered: false }); return { text: "Looking at each row in turn: 1. Delta Group is a company that", usage: { input_tokens: 200, output_tokens: maxTokens } }; }
    log.push({ rows: rows.length, maxTokens, answered: true });
    return { text: JSON.stringify(rows.map((l) => (/construction|civil/i.test(l) ? 1 : 0))), usage: { input_tokens: 200, output_tokens: 60 } };
  };
  const flow = (): FakeStep[] => [
    { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
    { tool: "describe_endpoint", args: { id: COMPANIES } },
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { objective: "construction contractor companies headquartered in Egypt", entity_type: "companies", match_limit: 50 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: MAP_CO, files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: EMPLOYEES } },
    { tool: "treg_call", args: { endpoint_id: EMPLOYEES, params: { page: 1, perPage: 10, linkedinURL: "https://linkedin.com/company/co-2" }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: MAP_EMP, files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: (r: Results) => ({
      summary_ar: "نجمع شركات مقاولات مصرية، ومن كل شركة اثنين من مديريها.",
      stages: [
        { key: "companies", title_ar: "شركات مقاولات في مصر", endpoint_id: COMPANIES, expected_rows: 50, parent_key: null, deliver: true,
          columns: cols(["name", "اسم الشركة"], ["website", "الموقع الإلكتروني"], ["country", "البلد"], ["description", "نشاط الشركة"], ["linkedin", "صفحة لينكدإن"]),
          filters: [{ kind: "place", field: "country", fields: ["country", "website"], places: ["EG"], values: ["مصر"] }],
          sample_rows: [1, 9, 13].map((n) => ({ id: `co${n}.eg`, name: POOL[n - 1].name, website: `https://co${n}.eg`, country: "Egypt", linkedin: POOL[n - 1].url.includes("linkedin") ? POOL[n - 1].url : "", description: "Provider of engineering, construction, and project management services." })),
          measured_by: [callIds(r)[0]], yield_from: firstOutputId(r),
          relevance: { subject_ar: "شركات مقاولات وبناء مصرية", terms: ["construction company", "construction services", "engineering construction", "contracting company", "general contractor", "شركة مقاولات"], text_columns: ["name", "description"], min_own_words: 2, entity: true, review: true } },
        { key: "employees", title_ar: "مديرو كل شركة", endpoint_id: EMPLOYEES, expected_rows: 100, parent_key: "companies", per_parent_rows: 2, deliver: true,
          columns: cols(["name", "اسم الموظف"], ["title", "المسمى الوظيفي"], ["parent_company", "الشركة"], ["profile", "صفحة لينكدإن"]),
          sample_rows: [{ id: "co-2-p0", name: "Person co-2 0", title: "General Manager", parent_company: "co-2", profile: "linkedin.com/in/co-2-0" }], measured_by: [callIds(r)[1]] },
      ],
    }) },
  ];
  async function run(log: Array<{ rows: number; maxTokens: number; answered: boolean }>) {
    return replay({
      deps: (base) => ({ ...base, reviewCall: makeReview(log) as never }),
      request: REQUEST_CO,
      planning: flow(),
      execution: () => [],
      answers: [answerFor({ endpointId: COMPANIES, params: { match_limit: 50 } }), answerFor({ endpointId: EMPLOYEES, params: { linkedinURL: "co-2" } }), ...Array.from({ length: 400 }, () => (o: { endpointId: string; params: unknown }) => answerFor(o))] as never,
    });
  }

  it("the source's limit: a flat price per call with up to 100 results is asked for 100, a source with a next page or a price per result is not touched", () => {
    const cat = loadTregCatalog();
    expect(liftedVolume(cat.byId.get(COMPANIES)!, { match_limit: 50 })).toEqual({ param: "match_limit", from: 50, to: 100 });
    expect(liftedVolume(cat.byId.get(COMPANIES)!, { match_limit: 100 })).toBeNull();
    // a source with a next page (a keyword search of a platform) is read page by page, never lifted
    expect(liftedVolume(cat.byId.get("justoneapi.x.facebook-search-post-v1")!, {})).toBeNull();
    expect(liftedVolume(cat.byId.get("crawl4ai.youtube.channel.videos")!, { channel: "@x", limit: 10 })?.to ?? null).toBeNull();
  });

  it("the people: a company with no LinkedIn page is read through its website (a bare domain), then its name; the page the measuring call used stays first", () => {
    const cat = loadTregCatalog();
    const parents = [{ id: "a.eg", name: "A", website: "https://www.a.eg/", linkedin: "https://linkedin.com/company/a" }, { id: "b.eg", name: "B", website: "https://b.eg", linkedin: "" }];
    expect(bindingFallbacks(cat.byId.get(EMPLOYEES)!, { param: "linkedinURL", from: "linkedin" }, parents)).toEqual([{ param: "website", from: "website", domain: true }]);
  });

  it("the model check asked again until it answers: the live answers cut at their own limit are not the end (24 rows waited for ever)", async () => {
    const log: Array<{ rows: number; maxTokens: number; answered: boolean }> = [];
    const store = createMemoryStore();
    const reviewer = createReviewer({ call: makeReview(log) as never, store, missionId: "msn_rv", requestText: REQUEST_CO, budgetUsd: 0.05 });
    const rows = Array.from({ length: 24 }, (_, i) => ({ id: `r${i}`, text: i % 2 === 0 ? `Delta Group ${i} construction support` : `Alpha ${i} marketing` }));
    const verdicts = await reviewer.review({ subject: "شركات مقاولات", rows });
    expect(verdicts.size).toBe(24);
    expect([...verdicts.values()].filter(Boolean)).toHaveLength(12);
    // the first attempt was cut at the live limit (4 x 24 + 20 = 116), the second had room and was read
    expect(log[0]).toMatchObject({ rows: 24, maxTokens: 116, answered: false });
    expect(log.some((x) => x.answered)).toBe(true);
    expect((await reviewer.state()).stop ?? null).toBeNull();
  });

  it("the file: the source is asked for 100, the model check settles the waiting companies, and the people are asked for companies with no LinkedIn page through their website", async () => {
    const log: Array<{ rows: number; maxTokens: number; answered: boolean }> = [];
    const r = await run(log);
    const snap = await readSnapshot(r.store, r.missionId);
    const execCalls = (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]).slice(2);
    // 1. the first execution call of the companies source asks for the most it gives for the price
    expect(execCalls.find((c) => c.endpointId === COMPANIES)!.params.match_limit).toBe(100);
    // 2. the waiting companies were settled by the model check (live: 24 pending, 0 by the model)
    const c = snap.counts("companies");
    expect(log.some((x) => x.answered)).toBe(true);
    expect(c.accepted).toBe(50);
    // 3. the people: companies without a LinkedIn page were read through their website
    const byWebsite = execCalls.filter((x) => x.endpointId === EMPLOYEES && typeof x.params.website === "string");
    expect(byWebsite.length).toBeGreaterThan(0);
    for (const x of byWebsite) expect(String(x.params.website)).toMatch(/^co\d+\.eg$/);
    const people = snap.acceptedRows("employees");
    const parentsWithPeople = new Set(people.map((p) => String(p.parent_id)));
    expect(parentsWithPeople.size).toBe(50);
    expect(people).toHaveLength(100);
    assertReplayInvariants(r, { expectDelivered: 150 });
    // the card says it before approval
    expect(JSON.stringify(r.planView)).toContain("فلا تُستبعد شركة لمجرد أنه لا صفحة لها");
  });
});

// ---------------------------------------------------------------------------------------------------- 4. Direction marks in name cells (a person's name between U+202A, U+202C and U+200F)
import ExcelJS from "exceljs";
import { buildMissionFiles, withoutDirectionMarks } from "../agent/src/workbook";

describe("4. invisible direction marks are removed from the cells that hold a name, in the workbook and in the CSV, and nowhere else (live: a person's name wrapped in U+202A / U+202C / U+200F)", () => {
  const MARKS = ["‪", "‫", "‬", "‭", "‮", "‎", "‏", "⁦", "⁧", "⁨", "⁩"];
  const st = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over });
  const pl = (stages: unknown[]) => ({ summary_ar: "ستحصل على شركات وموظفيها. وتفاصيل أخرى.", stages: stages as never, price: { totalCostUsd: 0, deliveredRows: 1, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 2, maxChargePoints: 1, overCap: false } }) as never;
  const COMPANIES = st({ key: "companies", title_ar: "الشركات", columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "site", title_ar: "الموقع" }] });
  const PEOPLE = st({ key: "employees", title_ar: "الموظفون", parent_key: "companies", per_parent_rows: 2, columns: [{ key: "person", title_ar: "اسم الموظف" }, { key: "title", title_ar: "المسمى الوظيفي" }, { key: "note", title_ar: "ملاحظة" }] });
  const wrapped = (t: string) => `‪${t}‬‏`;
  const companyRows = [{ id: "co1", name: `‏${"النيل للتركيبات"}‎`, site: "https://nile.example" }];
  const peopleRows = [{ id: "p1", parent_id: "co1", person: wrapped("أحمد حسن"), title: "مدير", note: wrapped("كما كتبه صاحبه") }];

  it("the person's name and the company's name in the context column are clean; the text of another column is delivered as it came", async () => {
    const built = await buildMissionFiles(pl([COMPANIES, PEOPLE]), { companies: companyRows, employees: peopleRows });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("الموظفون")!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    const at = (title: string) => header.indexOf(title) + 1;
    expect(sheet.getRow(2).getCell(at("اسم الموظف")).value).toBe("أحمد حسن");
    expect(sheet.getRow(2).getCell(at("اسم الشركة")).value).toBe("النيل للتركيبات");
    expect(sheet.getRow(2).getCell(at("ملاحظة")).value).toBe(wrapped("كما كتبه صاحبه"));
    // the CSV of the deepest stage: the same columns, the same cleaning
    expect(built.csv).toContain('"أحمد حسن"');
    for (const m of MARKS) expect(built.csv.split("\n")[1] ?? "").not.toContain(`${m}أ`);
  });

  it("every direction mark of the list is removed from a name and nothing else of the text is touched", () => {
    expect(withoutDirectionMarks(`${MARKS.join("")}منى سليم${MARKS.join("")}`)).toBe("منى سليم");
    expect(withoutDirectionMarks("Ahmed ​ Hassan")).toBe("Ahmed ​ Hassan");
    expect(withoutDirectionMarks(12)).toBe(12);
    expect(withoutDirectionMarks(null)).toBeNull();
  });
});
