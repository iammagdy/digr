import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { deriveEngineSpecsChecked } from "../agent/src/engine/spec";
import { runInSandbox } from "../agent/src/sandbox";
import { buildMissionFiles } from "../agent/src/workbook";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { cheaperSameJobMessage, newRunState } from "../agent/src/tools";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { assumptionLinesShown, filterLineAr, filterVerdict, type StageFilter } from "../src/lib/agentMission/filters";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { cairoText, parseMoment } from "../src/lib/agentMission/dateCells";
import { placeCellsAr } from "../src/lib/agentMission/places";
import type { CallRow } from "../agent/src/types";
import { NOT_ADMIN, makeHarness } from "./helpers/agentHarness";
import { buildTools } from "../agent/src/tools";

/**
 * FIX MISSION 10, REPLAYED FROM THE LIVE DATA (test account, 2026-10-29 ~20:00-21:02 UTC). Every plan, filter, mapping code, count and price below is the one stored by the live mission (read with SELECT); the pages of the sources are not stored
 * in the database, so the rows are shaped like the live ones (their names are in the comments). Each test fails on the code of main (77685e2) and passes with the fix.
 */
const catalog = loadTregCatalog();
const NOW = Date.parse("2026-10-29T20:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------------------------------- 1. YouTube: the named channels (msn_0b46eb78112469f35e12)
/** The videos stage of the stored plan: three named channels, the last 90 days, the topic by English and Arabic phrases; the model's review for the uncertain. */
const VIDEOS_STAGE = {
  key: "videos", title_ar: "فيديوهات من القنوات الثلاث عن حرب إيران وإسرائيل", endpoint_id: "tikhub.x.youtube-web-search-video", parent_key: null, deliver: true, expected_rows: 15, planned_rows: 15,
  columns: [{ key: "title", title_ar: "عنوان الفيديو" }, { key: "channel", title_ar: "القناة" }, { key: "views", title_ar: "المشاهدات" }, { key: "length", title_ar: "المدة" }, { key: "published_text", title_ar: "منذ متى نُشر" }, { key: "description", title_ar: "الوصف" }],
  filters: [{ kind: "account", field: "username", values: ["العربية", "اليوم السابع", "BBC News"] }, { kind: "period", days: 90, field: "published" }, { kind: "exclude_replies", enabled: false }, { kind: "exclude_reposts", enabled: false }, { kind: "language", lang: "ar", enabled: false }] as StageFilter[],
  relevance: { terms: ["حرب إيران", "الحرب على إيران", "الحرب مع إيران", "حرب إسرائيل وإيران", "إيران وإسرائيل", "إسرائيل وإيران", "war in Iran", "Iran war", "Israel Iran war", "Iran-Israel war"], review: true, subject_ar: "حرب إيران وإسرائيل", text_columns: ["title", "description"], min_own_words: 2 },
  sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.00005,
};
const video = (id: string, author: string, title: string, ageDays: number, description = "") => ({ id, title, channel: author, username: author, views: 1000, length: "10:00", published_text: `${ageDays} days ago`, published: day(ageDays).slice(0, 10), description });

async function sandboxJson(code: string, inputs: Record<string, unknown>): Promise<string> {
  const r = await runInSandbox(code, inputs);
  if (!r.ok || r.resultJson === null) throw new Error("the sandbox gave no result");
  return r.resultJson;
}

function reviewer(accept: (text: string) => boolean) {
  const asked: string[] = [];
  return { asked, budgetUsd: 1, state: async () => ({ stop: null }) as any, review: async ({ rows }: { rows: Array<{ id: string; text: string }> }) => { for (const r of rows) asked.push(r.id); return new Map(rows.map((r) => [r.id, accept(r.text)])); } };
}

async function runVideos(rows: Array<Record<string, unknown>>, accept = (t: string) => /iran/i.test(t)) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, "msn_video");
  const rv = reviewer(accept);
  const plan = { summary_ar: "x", stages: [VIDEOS_STAGE], price: {} } as unknown as PricedPlan;
  await ingestRows({ items, plan, reviewer: rv as any, addEvent: async () => {} }, VIDEOS_STAGE as any, rows, { now: NOW, silent: true, idField: null });
  const state = (id: string) => items.item("videos", id);
  return { state, rv, counts: items.counts("videos") };
}

describe("1. YouTube named channels: the source filter asks for the NAME the customer wrote, the topic is judged in the video's own language", () => {
  // shaped like the live pages: the display name of a channel is longer or written differently than the customer's words
  const rows = [
    video("v1", "BBC News", "What next for the war in Iran after Israeli elections? | BBC News", 0),
    video("v2", "اليوم السابع - Youm7", "حرب إيران وإسرائيل: آخر التطورات", 3),
    video("v3", "Al Arabiya العربية", "الحرب على إيران: تفاصيل جديدة", 5),
    video("v4", "BBC News", "Israel strikes Iranian nuclear sites, officials say", 2, "Tehran retaliates after the overnight raids"),
    video("v5", "قناة الحدث", "حرب إيران وإسرائيل مباشر", 1),
    video("v6", "BBC News", "Premier League highlights: the weekend's best goals", 1),
    video("v7", "اليوم السابع", "حرب إيران وإسرائيل قبل أربعة أشهر", 120),
  ];

  it("a channel is a named source when the name it gives CONTAINS the words the customer wrote (live: 18 of 18 videos were left out by the account filter, the model check never ran)", async () => {
    const r = await runVideos(rows);
    expect(["v1", "v2", "v3", "v4"].map((id) => r.state(id)?.state)).toEqual(["accepted", "accepted", "accepted", "accepted"]);
    expect(r.state("v5")).toMatchObject({ state: "excluded", reason: "filter_account" });
    expect(r.state("v7")).toMatchObject({ state: "excluded", reason: "filter_period" });
  });

  it("an item of a named channel whose text names none of the topic's words goes to the model check, which judges the TOPIC only, in the item's language (an English BBC video about the war is on-topic; a football video is not)", async () => {
    const r = await runVideos(rows);
    expect(r.state("v4")).toMatchObject({ state: "accepted", by: "model" });
    expect(r.state("v6")).toMatchObject({ state: "excluded", reason: "review_no" });
    expect(r.rv.asked.sort()).toEqual(["v4", "v6"]);
    expect(r.counts.accepted).toBe(4);
  });

  it("the card NAMES the sources the customer named (it said only «من حسابات محددة فقط»)", () => {
    const filters = VIDEOS_STAGE.filters;
    const lines = assumptionLinesShown(["الموضوع «حرب إيران وإسرائيل» يُطابَق بعباراته في العنوان أو الوصف"], filters);
    const joined = lines.join(" | ");
    for (const name of ["العربية", "اليوم السابع", "BBC News"]) expect(joined).toContain(name);
    expect(filterLineAr(filters[0])).toContain("BBC News");
  });

  it("a plan whose one recorded search names ONE of three channels is not given to the engine (it would deliver that channel only), and a named channel no sample shows is told on the card", async () => {
    const MISSION = "msn_yt";
    const store = createMemoryStore();
    const map = "const data = inputs.call_0004.data || {};\nconst arr = data.videos || [];\nreturn arr.map(r => ({ id: String(r.video_id), title: r.title, channel: r.author, username: r.author, views: r.number_of_views, length: r.video_length, published_text: r.published_time, published: '2026-10-28', description: r.description }));";
    const page = (authors: string[]) => ({ data: { videos: authors.map((a, i) => ({ video_id: `${a.length}${i}`, title: `حرب إيران وإسرائيل ${i}`, author: a, number_of_views: 10, video_length: "5:00", published_time: "1 day ago", description: "" })) } });
    await store.putFile(MISSION, "raw/call_0004.json", JSON.stringify(page(["BBC News", "BBC News", "Sky News Arabia"])), "application/json");
    await store.putFile(MISSION, "raw/call_0006.json", JSON.stringify(page(["اليوم السابع - Youm7", "Other"])), "application/json");
    const mapped = (p: ReturnType<typeof page>) => p.data.videos.map((r) => ({ id: r.video_id, title: r.title, channel: r.author, username: r.author, views: r.number_of_views, length: r.video_length, published_text: r.published_time, published: "2026-10-28", description: r.description }));
    await store.putFile(MISSION, "out/out_0003.json", JSON.stringify(mapped(page(["BBC News", "BBC News", "Sky News Arabia"]))), "application/json");
    const row = (id: string, n: number): CallRow => ({ id: `${MISSION}:${id}`, mission_id: MISSION, phase: "planning", endpoint_id: "tikhub.x.youtube-web-search-video", params_digest: { search_query: "BBC News Iran Israel war" }, status: "ok", refused_reason: null, http_status: 200, rows_returned: n, cost_usd: 0.001, estimate_usd: 0.001, provider_cost_id: null, storage_path: `raw/${id}.json`, duration_ms: 10 });
    const plan = { summary_ar: "x", stages: [{ ...VIDEOS_STAGE, measured_by: ["call_0004", "call_0006"], measured_from_calls: ["call_0004", "call_0006"], sample_rows: [] }], price: {} } as unknown as PricedPlan;
    const derived = await deriveEngineSpecsChecked(plan, { store, missionId: MISSION, catalog, calls: [row("call_0004", 3), row("call_0006", 2)], codeRuns: new Map([["out_0003", { code: map, files: ["call_0004"] }]]), callParams: new Map([["call_0004", { search_query: "BBC News Iran Israel war" }]]), sandbox: runInSandbox });
    expect(derived.issues).toEqual([]);
    // no recipe: the model searches every named channel and the same checks keep only the named ones
    expect(derived.specs.size).toBe(0);
    // «BBC News» and «اليوم السابع» are found in the two measured pages; «العربية» is in none of them
    expect(derived.unresolved.get("videos")).toEqual(["العربية"]);
  });
});

// ---------------------------------------------------------------------------------------------------- 2. time depth (msn_24c9027aba2461708331, msn_f00cdcfec7e8703c400b)
describe("2. the price of 2000 tweets (1,084) against 1000 (242) is the yield the sample measured, and the stored numbers price exactly so", () => {
  it("2000 tweets, 6 of 20 sampled tweets matching (yield 0.3): 1,084; 1000 tweets, 20 of 20 (yield 1): 242 — the same cost per tweet read (0.000027), a third of the tweets read are useful in one and all in the other", () => {
    // CHANGED (PR 2 price): a one-stage plan's planning is priced 0.004 USD lower (base 0.008, was a flat 0.012): 1,084 -> 1,062 and 242 -> 220 (holds 1,247 -> 1,221 and 279 -> 253)
    const iran = priceMissionByCode([{ rows: 2000, costPerRowUsd: 0.000027, deliver: true, yield: 0.3 } as any]);
    const league = priceMissionByCode([{ rows: 1000, costPerRowUsd: 0.000027, deliver: true, yield: 1 } as any]);
    expect(iran).toMatchObject({ maxChargePoints: 1062, reservePoints: 1221, deliveredRows: 2000 });
    expect(league).toMatchObject({ maxChargePoints: 220, reservePoints: 253, deliveredRows: 1000 });
    // provider cost: rows / yield x cost per row
    expect(iran.providerCostUsd).toBeCloseTo(0.18, 6);
    expect(league.providerCostUsd).toBeCloseTo(0.027, 6);
  });
});

// ---------------------------------------------------------------------------------------------------- 4. the time of the tweets (msn_9d1a182d59bb9bf4bd24)
describe("4. the time of a tweet is kept: the live mapping cut it to a day before the file existed (it was not #296)", () => {
  const MISSION = "msn_xs";
  // the stored mapping of the 400-tweet mission, as it was written
  const MAP = "const items = inputs.call_0002.output.data.items;\nreturn items.map(r => ({\n  id: String(r.id),\n  text: r.text,\n  author: r.authorName,\n  username: r.authorUsername,\n  followers: r.authorFollowers,\n  date: new Date(r.createdUtc * 1000).toISOString().slice(0,10),\n  likes: r.likeCount,\n  retweets: r.retweetCount,\n  quotes: r.quoteCount,\n  replies: r.replyCount,\n  bookmarks: r.bookmarkCount,\n  views: r.viewCount,\n  is_reply: r.isReply,\n  lang: r.lang,\n  link: r.url\n}));";
  // «2115856360160034860» is the id of the stored sample row; its time is in the id (a snowflake) and the source gives it as createdUtc (seconds)
  const createdUtc = Math.floor(Number((BigInt("2115856360160034860") >> BigInt(22)) + BigInt("1288834974657")) / 1000);
  const rawPage = { output: { data: { items: [{ id: "2115856360160034860", text: "عربي الرابع» الذي أقيم بالعاصمة المصرية القاهرة، تحت عنوان «الذكاء الاصطناعي وريادة الأعمال»", authorName: "وزارة الرياضة والشباب", authorUsername: "MSYQatar", authorFollowers: 10638, createdUtc, likeCount: 0, retweetCount: 0, quoteCount: 0, replyCount: 0, bookmarkCount: 0, viewCount: 363, isReply: false, lang: "ar", url: "https://x.com/i/web/status/2115856360160034860" }] } } };
  const columns = [["text", "نص التغريدة"], ["author", "اسم الكاتب"], ["username", "اسم المستخدم"], ["followers", "المتابعون"], ["date", "التاريخ"], ["likes", "الإعجابات"], ["retweets", "إعادة التغريد"], ["quotes", "الاقتباسات"], ["replies", "الردود"], ["bookmarks", "الحفظ"], ["views", "المشاهدات"], ["link", "الرابط"]].map(([key, title_ar]) => ({ key, title_ar }));

  it("the recipe keeps the source's time: the cut `.toISOString().slice(0,10)` is removed, proven on the measured page (same row, the day gained its time)", async () => {
    const store = createMemoryStore();
    await store.putFile(MISSION, "raw/call_0002.json", JSON.stringify(rawPage), "application/json");
    const seen = await sandboxJson(MAP, { call_0002: rawPage });
    await store.putFile(MISSION, "out/out_0001.json", seen, "application/json");
    const stage = { key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", parent_key: null, deliver: true, expected_rows: 1, planned_rows: 1, columns, filters: [{ kind: "period", days: 30, field: "date", enabled: false }], sample_rows: [], measured_by: ["call_0002"], measured_from_calls: ["call_0002"], measured_cost_per_row_usd: 0.00003 };
    const row: CallRow = { id: `${MISSION}:call_0002`, mission_id: MISSION, phase: "planning", endpoint_id: "anyapi.x.search.posts", params_digest: { limit: 50, query: "x", queryType: "Latest" }, status: "ok", refused_reason: null, http_status: 200, rows_returned: 1, cost_usd: 0.00054, estimate_usd: 0.00054, provider_cost_id: null, storage_path: "raw/call_0002.json", duration_ms: 10 };
    const derived = await deriveEngineSpecsChecked({ summary_ar: "x", stages: [stage], price: {} } as unknown as PricedPlan, { store, missionId: MISSION, catalog, calls: [row], codeRuns: new Map([["out_0001", { code: MAP, files: ["call_0002"] }]]), callParams: new Map([["call_0002", { limit: 50, query: "x", queryType: "Latest" }]]), sandbox: runInSandbox });
    expect(derived.issues).toEqual([]);
    const spec = derived.specs.get("tweets")!;
    expect(spec.map_code).not.toContain("slice(0,10)");
    const rows = JSON.parse(await sandboxJson(spec.map_code, { call_0002: rawPage })) as Array<{ date: string }>;
    // the day only («2026-10-29») was what the live file got; now the day and the time
    expect(rows[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(JSON.parse(seen)[0].date).toBe(rows[0].date.slice(0, 10));
  });

  it("the raw date strings of every tweet source reach the file with their hours and minutes in Cairo time; only a value with no time is a date", async () => {
    // anyapi.x.search.posts (seconds), crawl4ai.x.user.posts (the live `time` of @AlAhly), the trend source (the long English form of the live sample rows, «Sat Nov 10 08:35:22 +0000 2018»)
    const values: Array<[string, unknown, string]> = [
      ["seconds since 1970 (anyapi.x.search.posts: createdUtc)", createdUtc, cairoText(new Date(createdUtc * 1000))],
      ["ISO with Z (crawl4ai.x.user.posts: created)", "2026-10-29T18:26:35Z", "2026-10-29 21:26"],
      ["long English form (the trend source: created_at)", "Sat Nov 10 08:35:22 +0000 2018", "2018-11-10 10:35"],
      ["the same with a zone offset", "Fri Dec 15 20:20:20 +0000 2023", "2023-12-15 22:20"],
    ];
    for (const [name, raw, expected] of values) {
      expect(parseMoment(raw), name).not.toBeNull();
      expect(cairoText(parseMoment(raw)!), name).toBe(expected);
    }
    const plan = { summary_ar: "ستحصل على تغريدات. وتفاصيل.", stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "e", expected_rows: 3, planned_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "date", title_ar: "التاريخ" }], sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001 }], price: { totalCostUsd: 0, deliveredRows: 3, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 2, maxChargePoints: 1, overCap: false } } as unknown as PricedPlan;
    const built = await buildMissionFiles(plan, { tweets: [{ id: "a", text: "أ", date: "2026-10-29T18:26:35Z" }, { id: "b", text: "ب", date: "Sat Nov 10 08:35:22 +0000 2018" }, { id: "c", text: "ج", date: "2026-10-29" }] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("التغريدات")!;
    const cell = (r: number) => sheet.getRow(r).getCell(2);
    expect((cell(2).value as Date).getUTCHours()).toBe(21);
    expect((cell(2).value as Date).getUTCMinutes()).toBe(26);
    expect(cell(2).numFmt).toBe("yyyy-mm-dd hh:mm");
    expect((cell(3).value as Date).getUTCHours()).toBe(10);
    // a date with no time is a date: midnight, the day format, no zone shift
    expect((cell(4).value as Date).getUTCHours()).toBe(0);
    expect(cell(4).numFmt).toBe("yyyy-mm-dd");
  });
});

// ---------------------------------------------------------------------------------------------------- 5. the same job, cheaper (msn_25fb87d4b0dd80c6ae12)
describe("5. the comments of the Facebook topic request cost 0.02952 a call; the same job is sold at 0.00188, and one empty answer on one reel was taken as its verdict", () => {
  const chosen = "justoneapi.x.facebook-get-post-comments-v1";
  const cheap = "scrapecreators.x.v1-facebook-post-comments";
  const ctx = (state = newRunState()) => ({ catalog, access: NOT_ADMIN, stats: new Map(), now: NOW, state, phase: "planning" as const });
  const key = (url: string) => JSON.stringify([["url", url]]);

  it("a cheaper source that answered empty for ONE input is asked again with another item before a source 15 times dearer is bought (live: one reel, then 0.02952 a call for the 50 comments: 0.738 of the 0.7749 USD of the plan)", () => {
    const state = newRunState();
    state.tried.add(cheap);
    state.samples.set(cheap, [{ rows: 0, key: key("https://www.facebook.com/reel/1533703954771013/") }]);
    // the live call: brightdata skipped by name, the dearer source excused by one sentence
    const live = cheaperSameJobMessage(ctx(state), chosen, "The cheaper comment source returned no rows for a video post; the next one takes the post id.", { "brightdata.x.facebook-comments": "missing_input" });
    expect(live.refusal).toContain("ONE input only");
    expect(live.refusal).toContain(cheap);
    // once it was asked with another post and gave nothing again, the verdict is its own
    state.samples.get(cheap)!.push({ rows: 0, key: key("https://www.facebook.com/alahly/posts/pfbid0jatFVBZ85tSR3uWaKR9soLTS6L3S6U5vUerA") });
    expect(cheaperSameJobMessage(ctx(state), chosen, "both posts gave nothing on the cheaper source", { "brightdata.x.facebook-comments": "missing_input" }).refusal).toBeNull();
  });

  it("a planner that skips ONE cheaper source by name must account for the others (every cheaper source is sampled or skipped); a sentence about the whole choice, with nothing itemized, excuses it as before", () => {
    const one = cheaperSameJobMessage(ctx(), chosen, "The cheaper comment source returned no rows for a video post.", { "brightdata.x.facebook-comments": "missing_input" });
    expect(one.refusal).toContain(cheap);
    expect(one.recorded).toContain("skip brightdata.x.facebook-comments=missing_input");
    expect(cheaperSameJobMessage(ctx(), chosen, "", { "brightdata.x.facebook-comments": "missing_input", [cheap]: "wrong_data" }).refusal).toBeNull();
    expect(cheaperSameJobMessage(ctx(), chosen, "the post id of a video post is the only input these accept", undefined).refusal).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------- 6. companies (msn_e91fd8b36c0ddefebeb5)
describe("6. companies: place by the source's own country filter, names that are domains, city cells, and the sheet that promised managers", () => {
  const COMPANIES = {
    key: "companies", title_ar: "شركات المقاولات في مصر", endpoint_id: "tomba.companies.search.reveal", parent_key: null, deliver: true, expected_rows: 50, planned_rows: 50,
    columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "city", title_ar: "المدينة" }, { key: "website", title_ar: "الموقع الإلكتروني" }, { key: "size", title_ar: "حجم الشركة" }, { key: "description", title_ar: "وصف الشركة" }],
    filters: [{ kind: "place", field: "city", fields: ["city", "website"], places: ["EG"], values: ["مصر"] }] as StageFilter[],
    relevance: { terms: ["construction", "contractor", "contractors", "contracting", "مقاولات", "مقاولة", "مقاول", "إنشاءات"], entity: true, review: true, subject_ar: "شركات مقاولات وإنشاءات", text_columns: ["name", "description"], min_own_words: 2 },
    sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.00000356,
  };
  // the live mapping: name: r.name||'', city: r.city||r.state||'', website: r.website_url||'', size, description: (r.description||'').slice(0,200)
  const company = (n: string, o: Record<string, unknown> = {}) => ({ id: `${n}.com`, name: n, city: "", website: `https://${n.toLowerCase().replace(/\W/g, "")}.com`, size: "11-50", description: "Construction and contracting company", ...o });

  async function run(rows: Array<Record<string, unknown>>, stage = COMPANIES) {
    const items = await ItemStore.open(createMemoryStore(), "msn_co");
    const plan = { summary_ar: "x", stages: [stage], price: {} } as unknown as PricedPlan;
    await ingestRows({ items, plan, reviewer: reviewer(() => true) as any, addEvent: async () => {} }, stage as any, rows, { now: NOW, silent: true, idField: null });
    return items;
  }

  it("the source was asked for Egypt (its own country filter, recorded with the call): a company with a .com website and no city is not thrown away (live: 781 of 842 were); a company that names another country still is", async () => {
    const rows = [company("Alpha Contracting"), company("Beta Construction", { city: "Cairo" }), company("Gamma Contracting", { city: "Luxembourg" }), company("Delta Contracting", { website: "https://delta.com.eg" })];
    const without = await run(rows);
    const bySource = await run(rows, { ...COMPANIES, filters: [{ ...COMPANIES.filters[0], by_source: true }] });
    // without the source's own filter the proof of the place fails for the two .com companies (the code of main)
    expect(without.counts("companies").accepted).toBe(2);
    expect(without.item("companies", "Alpha Contracting.com")).toMatchObject({ state: "excluded", reason: "filter_place" });
    expect(bySource.item("companies", "Alpha Contracting.com")?.state).toBe("accepted");
    expect(bySource.item("companies", "Gamma Contracting.com")).toMatchObject({ state: "excluded", reason: "filter_place" });
    expect(bySource.counts("companies").accepted).toBe(3);
  });

  it("a company name that is only a domain is replaced from another NAME field of the same item, else kept exactly as the source gave it (nothing invented)", async () => {
    const items = await run([company("al-hashemiah.com.eg", { id: "a", legal_name: "الهاشمية للمقاولات", description: "مقاولات عامة" }), company("ecom.com.eg", { id: "b", city: "Cairo", description: "contracting company" })].map((r) => ({ ...r })), { ...COMPANIES, filters: [] });
    expect(items.item("companies", "a")?.row?.name).toBe("الهاشمية للمقاولات");
    expect(items.item("companies", "b")?.row?.name).toBe("ecom.com.eg");
  });

  it("the city cells: a known district or city is written in Arabic, a fragment like «Of» says the source did not give it (the live cells: «Of», «mokattam», «El Agouza», «Sheikh Zayed Egypt»)", () => {
    const cols = [{ key: "city", title_ar: "المدينة" }];
    const cell = (value: string) => { const row: Record<string, unknown> = { city: value }; placeCellsAr(row, cols, { city: value }, null); return row.city; };
    expect(cell("Of")).toBe("غير مذكورة في المصدر");
    expect(cell("mokattam")).toBe("المقطم");
    expect(cell("El Agouza")).toBe("العجوزة");
    expect(cell("Sheikh Zayed Egypt")).toBe("الشيخ زايد");
    expect(cell("Cairo")).toBe("القاهرة");
    // a place the table does not know stays as the source wrote it
    expect(cell("Obour Buildings 12")).toBe("Obour Buildings 12");
  });
});

// ---------------------------------------------------------------------------------------------------- 7. the examples of the card (msn_91475fe55877f790a8e2)
describe("7. the card's example tweets obey the plan's own period (live: «من اليوم فقط» showed tweets of 2018 and 2023)", () => {
  it("an example row the plan's enabled filters would leave out is not shown", () => {
    const plan = {
      summary_ar: "أبحث عن تغريدات عربية من اليوم. وتفاصيل.",
      stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "tikhub.x.twitter-web-fetch-search-timeline", expected_rows: 100, planned_rows: 100, parent_key: null, deliver: true,
        columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "date", title_ar: "التاريخ" }],
        filters: [{ kind: "language", lang: "ar", field: "lang" }, { kind: "period", days: 1, field: "date" }],
        sample_rows: [
          { text: "اهداف مباراة الترجي التونسي و الأهلي المصري التي انتهت بنتيجة 3 - 0", date: "Sat Nov 10 08:35:22 +0000 2018" },
          { text: "الأهلي يفوز اليوم", date: new Date(Date.now() - 3 * 3600_000).toISOString() },
          { text: "تغريدة قديمة", date: "Fri Dec 15 20:20:20 +0000 2023" },
        ],
        measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.00003 }],
      price: { unitPricePoints: 2, reservePoints: 200, maxChargePoints: 200, deliveredRows: 100, rule: 2, minChargePoints: 200, settings: { markup: 10, minChargePoints: 200 } },
    } as unknown as PricedPlan;
    const view = customerPlanView(plan);
    expect(view.stages[0].sample_rows.map((r) => r.text)).toEqual(["الأهلي يفوز اليوم"]);
  });
});

describe("the account filter itself (the stored values and the author names of the live videos)", () => {
  it("«اليوم السابع» is the channel «اليوم السابع - Youm7»; another channel is not", () => {
    const f: StageFilter[] = [{ kind: "account", field: "username", values: ["العربية", "اليوم السابع", "BBC News"] }];
    const ctx = { textKey: null, now: NOW };
    expect(filterVerdict(f, { username: "اليوم السابع - Youm7" }, ctx)).toBeNull();
    expect(filterVerdict(f, { username: "BBC News" }, ctx)).toBeNull();
    expect(filterVerdict(f, { username: "قناة الحدث" }, ctx)).toBe("filter_account");
  });
});

describe("1. a model that carries a named-source plan out may not finish while a named source has nothing", () => {
  it("the customer named three channels; one has items; finish is refused with the two missing names (a limited number of times, so the model is never stuck), then it is allowed", async () => {
    const h = makeHarness({ phase: "execution", mission: { status: "executing" } });
    const stage = { ...VIDEOS_STAGE, columns: [...VIDEOS_STAGE.columns, { key: "username", title_ar: "اسم المستخدم" }] };
    h.ctx.plan = { summary_ar: "x", stages: [stage], price: {} } as unknown as PricedPlan;
    const tool = (name: string) => buildTools(h.ctx).find((t) => t.name === name)!;
    const saved = await tool("save_rows").handler({ stage_key: "videos", rows: [video("v1", "BBC News", "What next for the war in Iran after Israeli elections? | BBC News", 0)] }) as any;
    expect(saved.ok).toBe(true);
    const finish = () => tool("finish").handler({ outcome: "delivered", summary_ar: "سُلّم فيديو واحد من قناة واحدة من القنوات التي سمّيتها." }) as Promise<any>;
    const first = await finish();
    expect(first.ok).toBe(false);
    expect(first.error ?? first.message).toContain("«العربية»");
    expect(first.error ?? first.message).toContain("«اليوم السابع»");
    expect(first.error ?? first.message).not.toContain("«BBC News»");
    await finish();
    await finish();
    // the limit: the fourth try is accepted
    expect((await finish()).ok).toBe(true);
  });
});
