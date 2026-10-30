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
import { itemProvesMedia, mediaFieldsOf, rawMediaProof, requestedMedia } from "../src/lib/agentMission/mediaProof";

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

  it("no sampled post proves a video: the plan is refused BEFORE the card, with what to do (live: the card was made and the run ended with nothing)", async () => {
    const r = await run([]);
    const proposals = r.driver.results.filter((x) => x.tool === "propose_plan").map((x) => x.result as { ok?: boolean; issues?: string[] });
    expect(proposals[0].ok).toBe(false);
    expect(JSON.stringify(proposals[0].issues)).toContain("proves one");
    expect(JSON.stringify(proposals[0].issues)).toContain("ask_question");
    expect(r.mission.status).not.toBe("plan_ready");
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
