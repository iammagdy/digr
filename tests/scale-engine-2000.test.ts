import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { callIds, planningFlow, tregResult, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { ItemStore, readSnapshot, type Op } from "../agent/src/items/itemStore";
import { createMemoryStore } from "../agent/src/memoryStore";
import { buildMissionFiles } from "../agent/src/workbook";
import { createSupabaseStore } from "../agent/src/supabaseStore";
import { ENGINE_MAX_PAGES_PER_STAGE, enginePageCapFor } from "../agent/src/engine/run";
import { AGENT_JOB_POINTS_CAP, AGENT_MAX_DELIVERED_ROWS, AGENT_DYNO_MEMORY_MB, AGENT_MEMORY_HARD_LIMIT_MB, AGENT_EXECUTION_WALL_MS } from "../src/lib/agentMission/constants";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * SCALE READINESS (fix mission 5, C): the real engine, the real item store, the real file builder, on 1,000 and 2,000 tweets and on 20 parents with 50 children each, with the time and the memory MEASURED. Nothing real is called: the provider is a fake
 * that serves pages; what is measured is OUR work (mapping every page in the sandbox, checking every item, saving a segment per page, reading the log back, building the file, settling).
 */
const ENDPOINT = "anyapi.x.search.posts";
const TOPIC = "محمد صلاح";
const PER_PAGE = 20;
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

const LIVE_RELEVANCE = { subject_ar: "لاعب كرة القدم محمد صلاح", terms: [TOPIC, "Mohamed Salah"], text_columns: ["text"], review: true, min_own_words: 2, context_terms: ["ليفربول", "الأهلي", "المنتخب", "هدف"] };
const good = (n: number) => `${TOPIC} يسجل هدفًا رقم ${n} في مباراة ليفربول الليلة، ويقود فريقه إلى فوز مستحق`;

/** `total` tweets: every twentieth is one that must not be delivered (a namesake, a reply, a repeat), in a fixed order. */
function tweetsOf(total: number) {
  let g = 0;
  return Array.from({ length: total }, (_, i) => {
    const bad = i % 20 === 19;
    const text = !bad ? good(g++) : i % 60 === 19 ? `الحكم ${TOPIC} عبد الفتاح يدير مباراة الدوري` : i % 60 === 39 ? `@Ahmed1Afify ${good(0)}` : `🔥 ${good(0)} #ليفربول`;
    return { id: `18${String(i).padStart(7, "0")}`, text, url: `https://x.example/u/status/18${String(i).padStart(7, "0")}`, author: `user${i % 40}`, createdAt: "2026-10-20T10:00:00Z", isReply: false, lang: "ar" };
  });
}

async function runTweets(wanted: number) {
  const bad = Math.ceil(wanted / 19) + 40;
  const tweets = tweetsOf(wanted + bad);
  const pages = Math.ceil(tweets.length / PER_PAGE);
  const pageOf = (p: number) => tregResult({ output: { data: { items: tweets.slice(p * PER_PAGE, (p + 1) * PER_PAGE), nextCursor: (p + 1) * PER_PAGE < tweets.length ? `cur_${(p + 1) * PER_PAGE}` : null } } }, 0.00075);
  const planning = planningFlow({
    progress: "أبحث عن أرخص مصدر مناسب للتغريدات", searchWords: ["tweets", "search"], platform: "x",
    sample: [{ endpoint: ENDPOINT, params: { query: TOPIC, limit: PER_PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" }],
    sampleCode: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt, is_reply: !!t.isReply, lang: t.lang || '' }))",
    plan: (res: Results) => ({
      summary_ar: "ستحصل على تغريدات عربية عن محمد صلاح لاعب كرة القدم، بدون الردود، مع نصها وكاتبها وتاريخها ورابطها.",
      assumptions_ar: ["المقصود: لاعب كرة القدم محمد صلاح."],
      stages: [{
        key: "tweets", title_ar: "التغريدات عن محمد صلاح", endpoint_id: ENDPOINT, expected_rows: wanted, parent_key: null, deliver: true,
        how_ar: "بحث في تغريدات منصة إكس بالاسم الكامل باللغة العربية، مع استبعاد الردود.",
        columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
        sample_rows: [2, 3, 4].map((n) => ({ id: tweets[n].id, text: tweets[n].text, url: tweets[n].url, author: tweets[n].author, date: "2026-10-20T10:00:00Z" })),
        measured_by: [callIds(res)[0]], relevance: LIVE_RELEVANCE, yield_from: firstOutputId(res),
        filters: [{ kind: "exclude_replies" }, { kind: "language", lang: "ar" }],
      }],
    }),
  });
  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const r = await replay({ request: `هات ${wanted} تغريدة عن محمد صلاح`, planning, execution: () => [], answers: [pageOf(0), ...Array.from({ length: pages }, (_, p) => pageOf(p))] });
  const ms = performance.now() - started;
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  const rssDelta = process.memoryUsage().rss - rssBefore;
  return { r, ms, heapDelta, rssDelta, pages };
}

/** The objects the mission left in its storage, and what the item log weighs. */
function storageOf(r: ReplayResult) {
  const keys = [...r.store.files.keys()].filter((k) => k.startsWith(`${r.missionId}/`)).map((k) => k.slice(r.missionId.length + 1));
  const sizeOf = (k: string) => { const v = r.store.files.get(`${r.missionId}/${k}`)!; return typeof v === "string" ? Buffer.byteLength(v) : v.length; };
  const segs = keys.filter((k) => k.startsWith("items/seg_"));
  const raws = keys.filter((k) => k.startsWith("raw/"));
  return { objects: keys.length, segments: segs.length, rawPages: raws.length, segmentBytes: segs.reduce((n, k) => n + sizeOf(k), 0), rawBytes: raws.reduce((n, k) => n + sizeOf(k), 0), xlsxBytes: keys.filter((k) => k.endsWith(".xlsx")).reduce((n, k) => n + sizeOf(k), 0) };
}

const report: string[] = [];
const say = (line: string) => { report.push(line); console.log(`SCALE ${line}`); if (process.env.SCALE_OUT) appendFileSync(process.env.SCALE_OUT, `${line}\n`); };

describe("1,000 and 2,000 tweets through the real engine, store and file builder", () => {
  for (const wanted of [1000, 2000]) {
    it(`${wanted} tweets: every one is delivered, counted once, charged by the file; the time and the memory are measured`, async () => {
      const { r, ms, heapDelta, rssDelta, pages } = await runTweets(wanted);
      assertReplayInvariants(r, { expectDelivered: wanted });
      const snap = await readSnapshot(r.store, r.missionId);
      const c = snap.counts("tweets");
      expect(c.accepted).toBe(wanted);
      expect(snap.stage("tweets").stop).toBe("target_reached");
      // the money rule is the one of every mission: ceil(file x unit price), under the hold
      expect(r.mission.delivered_units).toBe(wanted);
      expect(r.mission.charged_points).toBe(Math.ceil(wanted * r.plannedPlan.price.unitPricePoints));
      expect(Number(r.mission.charged_points)).toBeLessThanOrEqual(Number(r.mission.reserved_points));
      const wb = await readWorkbook(r);
      expect(wb.getWorksheet("التغريدات عن محمد صلاح")!.rowCount - 1).toBe(wanted);
      const st = storageOf(r);
      // no page limit, no early stop: the pages read are the pages the source needed
      expect(c.pages).toBeLessThanOrEqual(pages);
      expect(c.pages).toBeLessThan(enginePageCapFor(wanted));
      // one segment per page and one raw page per call: the number of objects grows with the pages, not with the items squared
      expect(st.segments).toBe(c.pages + 1); // one per page and one for the stage's recorded stop
      expect(st.rawPages).toBe(c.pages + 1); // the pages of the run and the planning sample
      say(`tweets=${wanted} pages_read=${c.pages} source_rows=${c.found} accepted=${c.accepted} excluded=${c.excluded} duplicates=${c.duplicates} wall_ms=${Math.round(ms)} ms_per_page=${Math.round(ms / c.pages)} heap_delta_mb=${mb(heapDelta)} rss_delta_mb=${mb(rssDelta)} storage_objects=${st.objects} segments=${st.segments} segment_mb=${mb(st.segmentBytes)} raw_pages=${st.rawPages} raw_mb=${mb(st.rawBytes)} xlsx_kb=${Math.round(st.xlsxBytes / 1024)} reserve_points=${r.mission.reserved_points} charged_points=${r.mission.charged_points}`);
      // generous ceilings (the numbers above are the measurement): a regression to something quadratic or leaking would break them
      expect(ms).toBeLessThan(5 * 60_000);
      expect(heapDelta / 1024 / 1024).toBeLessThan(250);
    }, 6 * 60_000);
  }
});

describe("20 parents with 50 children each (1,000 children read ten a page)", () => {
  const SEARCH = "crawl4ai.google.serp.maps";
  const REVIEWS = "litescrape.google.maps.reviews";
  const PARENTS = 20;
  const CHILDREN = 50;
  const CPAGE = 10;
  const placeRow = (i: number) => ({ name: `مطعم رقم ${i}`, place_id: `ChIJp${String(i).padStart(5, "0")}`, address: `شارع ${i}، القاهرة`, phone: "+20227945000", category: "مطعم", cid: String(i) });
  const reviewsPage = (parent: string, offset: number) => ({ reviews: Array.from({ length: CPAGE }, (_, i) => ({ review_id: `${parent}-r${offset + i}`, rating: 1 + ((offset + i) % 5), user: { name: `زائر ${offset + i}` }, snippet: `تجربة رقم ${offset + i} في ${parent}`, iso_date: "2026-10-10T12:00:00Z", likes: i % 4 })), pagination: offset + CPAGE < CHILDREN ? { next_page_token: `tok_${offset + CPAGE}` } : null });
  const why = "the cheaper sources return no author or link fields in their catalog description";

  it("every child of every parent is read, saved and delivered; the pages are counted over all the parents, far under the cap", async () => {
    const places = Array.from({ length: PARENTS }, (_, i) => placeRow(i));
    const planning: FakeStep[] = [
      { tool: "report_progress", args: { message_ar: "أبحث عن الأماكن ثم أجرّب مصدر التقييمات", counts: { sources: 3 } } },
      { tool: "catalog_search", args: { words: ["google", "maps"], platform: "google", limit: 5 } },
      { tool: "describe_endpoint", args: { id: SEARCH } },
      { tool: "treg_call", args: { endpoint_id: SEARCH, params: { query: "مطاعم القاهرة", limit: PARENTS }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: "return inputs.call_0001.rows.map(p => ({ id: p.place_id, text: p.name, address: p.address, phone: p.phone, category: p.category }))", files: [callIds(r)[0]] }) },
      { tool: "describe_endpoint", args: { id: REVIEWS } },
      { tool: "treg_call", args: { endpoint_id: REVIEWS, params: { place_id: places[0].place_id, num: CPAGE }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: "return inputs.call_0002.reviews.map(v => ({ id: v.review_id, text: v.snippet, rating: v.rating, writer: v.user.name, date: v.iso_date, likes: v.likes }))", files: [callIds(r)[1]] }) },
      { tool: "propose_plan", args: (res: Results) => ({
        summary_ar: "ستحصل على مطاعم من القاهرة وتقييمات كل مكان.",
        stages: [
          { key: "places", title_ar: "المطاعم", endpoint_id: SEARCH, expected_rows: PARENTS, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "اسم المطعم" }, { key: "address", title_ar: "العنوان" }, { key: "phone", title_ar: "رقم الهاتف" }], sample_rows: [{ id: places[0].place_id, text: places[0].name, address: places[0].address, phone: places[0].phone }], measured_by: [callIds(res)[0]], relevance: { subject_ar: "مطاعم", terms: ["مطعم"], text_columns: ["text"], min_own_words: 0 }, yield_from: firstOutputId(res) },
          { key: "reviews", title_ar: "التقييمات", endpoint_id: REVIEWS, expected_rows: PARENTS * CHILDREN, parent_key: "places", per_parent_rows: CHILDREN, deliver: true, columns: [{ key: "text", title_ar: "نص التقييم" }, { key: "rating", title_ar: "الدرجة" }, { key: "writer", title_ar: "الكاتب" }, { key: "date", title_ar: "التاريخ" }, { key: "likes", title_ar: "الإعجابات" }], sample_rows: [{ id: `${places[0].place_id}-r0`, text: `تجربة رقم 0 في ${places[0].place_id}`, rating: 1, writer: "زائر 0", date: "2026-10-10T12:00:00Z", likes: 0 }], measured_by: [callIds(res)[1]] },
        ],
      }) },
    ];
    const answers = [
      tregResult({ rows: places }, 0.00015), tregResult(reviewsPage(places[0].place_id, 0), 0.00015),
      tregResult({ rows: places }, 0.00015),
      ...places.flatMap((p) => Array.from({ length: CHILDREN / CPAGE }, (_, k) => tregResult(reviewsPage(p.place_id, k * CPAGE), 0.00015))),
    ];
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const r = await replay({ request: "عايز ٢٠ مطعم في القاهرة مع ٥٠ تقييم لكل مكان", planning, execution: () => [], answers });
    const ms = performance.now() - started;
    assertReplayInvariants(r, { expectDelivered: PARENTS + PARENTS * CHILDREN });
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("places").accepted).toBe(PARENTS);
    expect(snap.counts("reviews").accepted).toBe(PARENTS * CHILDREN);
    expect(snap.counts("reviews").pages).toBe(PARENTS * (CHILDREN / CPAGE));
    expect(snap.stage("reviews").stop).toBe("target_reached");
    const wb = await readWorkbook(r);
    expect(wb.getWorksheet("التقييمات")!.rowCount - 1).toBe(PARENTS * CHILDREN);
    const st = storageOf(r);
    say(`parents=${PARENTS} children_each=${CHILDREN} child_pages=${snap.counts("reviews").pages} accepted_children=${snap.counts("reviews").accepted} wall_ms=${Math.round(ms)} heap_delta_mb=${mb(process.memoryUsage().heapUsed - heapBefore)} storage_objects=${st.objects} segments=${st.segments} raw_pages=${st.rawPages} xlsx_kb=${Math.round(st.xlsxBytes / 1024)}`);
    expect(ms).toBeLessThan(5 * 60_000);
  }, 6 * 60_000);
});

describe("the limits that could stop a large mission early, from the code", () => {
  it("the page cap grows with the volume sold: a source of five items a page can still give five thousand", () => {
    expect(ENGINE_MAX_PAGES_PER_STAGE).toBe(400);
    expect(enginePageCapFor(100)).toBe(400);
    expect(enginePageCapFor(2000)).toBe(4000);
    expect(enginePageCapFor(AGENT_MAX_DELIVERED_ROWS)).toBe(10_000);
    // 2,000 tweets at 20 a page with a fifth of them left out need 125 pages; at 5 a page 500: more than the old fixed cap of 400, now inside the new one
    expect(Math.ceil(2000 / 0.8 / 5)).toBeGreaterThan(ENGINE_MAX_PAGES_PER_STAGE);
    expect(Math.ceil(2000 / 0.8 / 5)).toBeLessThan(enginePageCapFor(2000));
  });

  it("the points cap and the row limit: what 2,000 and 5,000 items cost on the cheapest and the dearest source of the live runs", () => {
    const priceOf = (rows: number, costPerRowUsd: number) => priceMissionByCode([{ rows, costPerRowUsd, deliver: true }]);
    // a cheap tweet source (0.0000375 a row, measured), the dear Facebook post search (0.0059 a post)
    const cheap2000 = priceOf(2000, 0.0000375);
    const fb100 = priceOf(100, 0.0059);
    const fb5000 = priceOf(5000, 0.0059);
    expect(cheap2000.overCap).toBe(false);
    expect(cheap2000.reservePoints).toBeLessThan(AGENT_JOB_POINTS_CAP);
    expect(fb100.overCap).toBe(false);
    // 5,000 Facebook posts would hold more than the cap (25,000 points): the plan is refused with «lower the expected rows», never started
    expect(fb5000.overCap).toBe(true);
    expect(AGENT_JOB_POINTS_CAP).toBe(25_000);
    expect(AGENT_MAX_DELIVERED_ROWS).toBe(5_000);
    say(`points: 2000_tweets_reserve=${cheap2000.reservePoints} 100_fb_posts_reserve=${fb100.reservePoints} 5000_fb_posts_reserve=${fb5000.reservePoints} cap=${AGENT_JOB_POINTS_CAP} row_limit=${AGENT_MAX_DELIVERED_ROWS}`);
  });

  it("the call log of a mission with thousands of pages is read in pages of a thousand, so the last call number is never lost after a restart", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `msn_x:call_${String(i + 1).padStart(4, "0")}`, mission_id: "msn_x", phase: "execution", endpoint_id: "e", status: "ok" }));
    const asked: Array<[number, number]> = [];
    const client = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ range: async (from: number, to: number) => { asked.push([from, to]); return { data: rows.slice(from, to + 1), error: null }; } }) }) }) }) };
    const store = createSupabaseStore(client);
    const all = await store.listCalls("msn_x");
    expect(all).toHaveLength(2500);
    expect(asked).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("the worker's memory and time: the numbers the dyno is held to", () => {
    // the engine starts no model session (no 270 MB child): a mission is one node process plus the page mapper's short-lived child
    expect(AGENT_DYNO_MEMORY_MB).toBe(512);
    expect(AGENT_MEMORY_HARD_LIMIT_MB).toBeLessThan(AGENT_DYNO_MEMORY_MB * 1.2);
    expect(AGENT_EXECUTION_WALL_MS).toBe(6 * 3600_000);
  });
});

describe("the item log in the worker's memory", () => {
  it("5,000 accepted items of a text stage held by the writer: the memory per 1,000 items is measured (the log keeps each row once)", async () => {
    const store = createMemoryStore();
    const log = await ItemStore.open(store, "msn_mem");
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let page = 0; page < 250; page += 1) {
      const ops: Op[] = Array.from({ length: 20 }, (_, k) => {
        const n = page * 20 + k;
        return { t: "item", stage: "tweets", id: `18${String(n).padStart(7, "0")}`, state: "accepted", by: "rule", row: { id: `18${String(n).padStart(7, "0")}`, text: good(n), url: `https://x.example/u/status/18${String(n).padStart(7, "0")}`, author: `user${n % 40}`, date: "2026-10-20T10:00:00Z" } };
      });
      ops.push({ t: "page", stage: "tweets", stream: "root", call_id: `call_${page}`, cursor_in: null, cursor_next: `cur_${page}`, has_more: true, ended: false, rows_in_page: 20 });
      await log.commit(ops);
    }
    gc?.();
    const heap = process.memoryUsage().heapUsed - before;
    expect(log.counts("tweets").accepted).toBe(5000);
    // what the settlement does on top: the log is read back whole from storage (a second copy for a moment) and the rows are handed to the builder
    const again = await ItemStore.open(store, "msn_mem");
    expect(again.counts("tweets").accepted).toBe(5000);
    say(`item_log items=5000 heap_mb_for_the_writer_including_the_fake_storage=${mb(heap)} per_1000_items_mb=${mb(heap / 5)} segments=${log.segmentCount()}`);
    expect(heap / 1024 / 1024).toBeLessThan(200);
  }, 120_000);
});

describe("the file builder on the largest mission the platform sells (5,000 items)", () => {
  it("5,000 items in one sheet: built, with its time and memory measured, and read back as 5,000", async () => {
    const plan = {
      summary_ar: "ستحصل على تغريدات.", stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 5000, planned_rows: 5000, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.00004, measured_from_calls: [] }],
      price: { unitPricePoints: 0.22, reservePoints: 1265, maxChargePoints: 1100, deliveredRows: 5000 },
    } as never;
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `18${String(i).padStart(7, "0")}`, text: good(i), url: `https://x.example/u/status/18${String(i).padStart(7, "0")}`, author: `user${i % 40}`, date: "2026-10-20T10:00:00Z" }));
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const built = await buildMissionFiles(plan, { tweets: rows });
    const ms = performance.now() - started;
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as never);
    expect(wb.getWorksheet("التغريدات")!.rowCount - 1).toBe(5000);
    say(`file_build items=5000 wall_ms=${Math.round(ms)} heap_delta_mb=${mb(heapDelta)} xlsx_kb=${Math.round(built.xlsx.length / 1024)} csv_kb=${Math.round(Buffer.byteLength(built.csv) / 1024)}`);
    expect(ms).toBeLessThan(60_000);
    expect(heapDelta / 1024 / 1024).toBeLessThan(250);
  }, 120_000);
});

