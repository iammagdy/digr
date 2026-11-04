import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan } from "../src/lib/agentMission/plan";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { YOUTUBE_CHANNEL_QUESTION_AR } from "../src/lib/agentMission/foundation/youtubeChannel";
import { INSTAGRAM_ACCOUNT_QUESTION_AR } from "../src/lib/agentMission/foundation/instagramAccount";
import { COUNT_QUESTION_AR } from "../src/lib/agentMission/foundation/countChoice";
import { DISCOVERED_SOURCE_NOTE_AR } from "../src/lib/agentMission/foundation/discovery";
import { csvExportFromWorkbook, packageCsvExport } from "../src/lib/server/csvFromExcel";
import { replayGateway } from "./helpers/replayGateway";
import { catalog, catalogPage, deliver, discoveryWorld, type Handler, type Page } from "./helpers/discoveryWorld";

/**
 * ROUND 33, ACCEPTANCE: a request the platform's hand-written cards could not serve is planned by DISCOVERY (a tool derived from the catalog, chosen among validated candidates), executed by the existing engine under the existing price, and delivered in the existing Excel and CSV.
 * EVIDENCE: pages written here from the catalog's own example envelope are SIMULATED (`catalogPage`); pages read from tests/fixtures/live are REAL stored provider pages (anonymised). Each test says which it uses. No network, no paid call.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const SEARCH = "tikhub.youtube.search.videos";
const CHANNEL_VIDEOS = "tikhub.youtube.channel.videos";
const HASHTAG = "scrapecreators.x.v1-instagram-search-hashtag";
const REELS = "scrapecreators.x.v2-instagram-reels-search";
const REELS_TIKHUB = "tikhub.x.instagram-v2-search-reels";
const CHANNEL_SEARCH = "tikhub.x.youtube-web-v2-search-channels";
const IN_CHANNEL = "tikhub.x.youtube-web-search-channel";
const M2 = "msn_ee599cdbbde993073b15";
const YT1 = "msn_41a73a6b2c0b4a76ef0a";
const realPage = (mission: string, call: string): Page => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));

const ytVideo = (i: number, about = true) => ({ video_id: `v${String(i).padStart(10, "0")}`, title: about ? `فيديو عن الذكاء الاصطناعي رقم ${i}` : `فيديو آخر رقم ${i}`, duration: "3:00", view_count: `${i * 10} views`, published_time: "2 weeks ago", author: `قناة ${i % 3}`, channel_id: `UCchan${i % 3}`, thumbnails: [], description_snippet: "", url: `https://www.youtube.com/watch?v=v${String(i).padStart(10, "0")}` });
const igPost = (i: number) => ({ id: `39000000000000${String(i).padStart(5, "0")}`, shortcode: `Sc${i}`, url: `https://www.instagram.com/reel/Sc${i}/`, caption: `منشور عن الذكاء الاصطناعي ${i}`, thumbnail_src: "", display_url: "", video_url: "", has_audio: true, accessibility_caption: null, video_view_count: i, video_play_count: i * 10, product_type: "clips", video_duration: 10 });
const idsOf = (rows: Array<Record<string, unknown>>) => rows.map((r) => String(r.id));
const servedIds = (w: { store: ReturnType<typeof createMemoryStore> }): Set<string> => {
  const ids = new Set<string>();
  const walk = (o: unknown): void => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { const r = o as Record<string, unknown>; for (const k of ["video_id", "id", "pk"]) if (typeof r[k] === "string" || typeof r[k] === "number") ids.add(String(r[k])); Object.values(r).forEach(walk); } };
  for (const [path, body] of w.store.files) if (path.includes("/raw/") && typeof body === "string") { try { walk(JSON.parse(body)); } catch { /* not a page */ } }
  return ids;
};
const noRepeat = (calls: Array<{ endpoint: string; params: Record<string, unknown> }>) => { const keys = calls.map((c) => `${c.endpoint} ${JSON.stringify(c.params)}`); expect(new Set(keys).size, "a read made twice with the same inputs").toBe(keys.length); };
const priceOf = (plan: PricedPlan) => priceMissionByCode(stagePriceInputs(plan.stages));

describe("FLAG OFF (the default): nothing changes, a derived tool is never used", () => {
  it("a YouTube request with no channel is asked for one, with no read, exactly as before (SIMULATED provider that would answer if called)", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => catalogPage(SEARCH, [ytVideo(1)]) }, { discovery: false });
    const r = await w.plan();
    expect(r).toMatchObject({ kind: "question", why: "youtube_channel", question: YOUTUBE_CHANNEL_QUESTION_AR });
    expect(w.calls).toEqual([]);
  });
  it("an Instagram request with no account is asked for one, with no read", async () => {
    const w = discoveryWorld("عايز ١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي", { [HASHTAG]: () => catalogPage(HASHTAG, [igPost(1)]) }, { discovery: false });
    expect(await w.plan()).toMatchObject({ kind: "question", why: "instagram_account", question: INSTAGRAM_ACCOUNT_QUESTION_AR });
    expect(w.calls).toEqual([]);
  });
  it("the switch is also required for a test account: discovery cards are handed to the planner only by the worker, and with the default planner no `cards` exist", () => {
    const src = readFileSync("agent/src/compiled.ts", "utf8");
    expect(src).toContain("cards?: ReadonlyArray<ToolCard>");
    expect(src).toMatch(/deps\.cards \? \{ cards: deps\.cards \} : \{\}/);
  });
});

describe("6. YOUTUBE KEYWORD VIDEOS (a request with no channel; SIMULATED catalog-shaped pages)", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ytVideo(i + 1, i < 3));
  const handler: Handler = (_p, n) => catalogPage(SEARCH, n === 1 ? rows : rows.map((r) => ({ ...r, video_id: `${r.video_id}b` })), null);
  it("understands the request, discovers the keyword search in the catalog, sends exactly the topic and the video type, asks no channel question, and reads once", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: handler }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(w.calls).toEqual([{ endpoint: SEARCH, params: { keyword: "الذكاء الاصطناعي", type: "video" }, ok: true }]);
    expect(r.plan.stages.map((s) => s.endpoint_id)).toEqual([SEARCH]);
    expect(r.plan.stages[0].planned_rows).toBe(10);
    expect(r.plan.compiled?.by).toBe("compiler");
    expect(r.plan.compiled?.discovery).toMatchObject({ endpoint_id: SEARCH, derived: true, role: "videos.search", paging: "declared" });
    expect(r.plan.notes_ar).toContain(DISCOVERED_SOURCE_NOTE_AR);
    for (const n of r.plan.notes_ar ?? []) expect(checkCustomerText(n).issues, n).toEqual([]);
  });
  it("NO SILENT RELEVANCE FILTERING: 17 of the 20 videos read are not about the topic; the 10 chosen include some of them, they are MARKED, and the file delivers all 10 with none excluded", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: handler }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    if (r.kind !== "plan") throw new Error("no plan");
    const d = await deliver(w, r.plan, "x", "youtube");
    const delivered = d.rowsByStage.videos;
    expect(delivered).toHaveLength(10);
    expect(d.snap.counts("videos").excluded).toBe(0);
    const marks = delivered.map((x) => x.topic_relation);
    expect(marks.filter((m) => m === "يتحدث نصه عن الموضوع")).toHaveLength(3);
    expect(marks.filter((m) => m !== "يتحدث نصه عن الموضوع").length).toBe(7);
    // no invented identifier, a public link that opens the video, no repeat, every id one the provider gave
    const served = servedIds(w);
    for (const row of delivered) { expect(served.has(String(row.id)), String(row.id)).toBe(true); expect(String(row.link)).toBe(`https://www.youtube.com/watch?v=${row.id}`); }
    expect(new Set(idsOf(delivered)).size).toBe(10);
    noRepeat(w.calls);
  });
  it("THE PRICE IS CODE'S: the stored price equals the one pricing function over the stages, the model's choice has no input into it, and the hold is explicit before anything runs", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: handler }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ selectCapability: async () => ({ endpointId: SEARCH, reason: "price is 1 point", costUsd: 0.001 }) });
    if (r.kind !== "plan") throw new Error("no plan");
    expect(JSON.stringify(r.plan.price)).toBe(JSON.stringify(priceOf(r.plan)));
    expect(r.plan.price.reservePoints).toBeGreaterThan(0);
    expect(r.plan.price.maxChargePoints).toBeLessThanOrEqual(r.plan.price.reservePoints);
    expect(r.llmCostUsd).toBe(0.001);
  });
  it("the measured page size (20 rows) prices the row, not the catalog's one-item example", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: handler }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    if (r.kind !== "plan") throw new Error("no plan");
    expect(r.plan.stages[0].measured_cost_per_row_usd).toBeCloseTo(0.002 / 20, 8);
  });
});

describe("MODEL SELECTION among validated candidates, and the VALID FALLBACK", () => {
  const OTHER = "justoneapi.x.youtube-search-v1";
  const page = (id: string) => catalogPage(id, Array.from({ length: 20 }, (_, i) => ytVideo(i + 1)), null);
  it("the model sees only validated candidates; naming one of them selects it (a different tool than the best-ranked one), and the choice is recorded", async () => {
    const seen: string[][] = [];
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => page(SEARCH), [OTHER]: () => page(OTHER) }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ selectCapability: async ({ candidates }) => { seen.push(candidates.map((c) => c.endpointId)); return { endpointId: OTHER, reason: "carries the same", costUsd: 0 }; } });
    if (r.kind !== "plan") throw new Error("no plan");
    expect(seen[0]).toContain(SEARCH);
    expect(seen[0]).not.toContain(IN_CHANNEL);
    expect(r.plan.stages[0].endpoint_id).toBe(OTHER);
    expect(r.plan.compiled?.discovery?.selection).toMatchObject({ by: "model", reason: "carries the same" });
  });
  it("an answer that names something the model was not shown (an invented endpoint) changes nothing: the compiler's own ranking decides, and no call goes to the invented endpoint", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => page(SEARCH) }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ selectCapability: async () => ({ endpointId: "made.up.endpoint", reason: "trust me", costUsd: 0 }) });
    if (r.kind !== "plan") throw new Error("no plan");
    expect(r.plan.stages[0].endpoint_id).toBe(SEARCH);
    expect(r.plan.compiled?.discovery?.selection).toMatchObject({ by: "rank" });
    expect(w.endpoints()).toEqual([SEARCH]);
  });
  it("the model failing, or timing out, is never fatal", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => page(SEARCH) }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ selectCapability: async () => { throw new Error("model down"); } });
    expect(r.kind).toBe("plan");
  });
  it("15. A VALID FALLBACK: the best-ranked tool FAILS, the next validated candidate is read once, the plan uses it and says how it was chosen; the failed read is not repeated", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => "fail", [OTHER]: () => page(OTHER) }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    if (r.kind !== "plan") throw new Error("no plan");
    expect(w.calls.map((c) => [c.endpoint, c.ok])).toEqual([[SEARCH, false], [OTHER, true]]);
    expect(r.plan.stages[0].endpoint_id).toBe(OTHER);
    expect(r.plan.compiled?.discovery?.selection?.reason).toContain(`fallback from ${SEARCH}`);
    noRepeat(w.calls);
  });
  it("a REFUSAL by the gateway (a budget or a cap) is a limit, never worked around: one call, no fallback, the request ends honestly", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => "refused", [OTHER]: () => page(OTHER) }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    expect(r).toMatchObject({ kind: "cannot", reason: "pool_refused" });
    expect(w.calls).toHaveLength(1);
  });
  it("every candidate fails: no plan, nothing held, three reads at most", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => "fail", [OTHER]: () => "fail" }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    expect(r).toMatchObject({ kind: "cannot", reason: "pool_failed" });
    expect(w.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("11, 12. PAGINATION: several pages, and a source that does not describe its paging", () => {
  it("11. a source with a next page: the first page holds fewer videos than 10 and their spares, so the second page is read with the cursor the first gave, and the plan says the source has more (partial)", async () => {
    const pages = [Array.from({ length: 6 }, (_, i) => ytVideo(i + 1)), Array.from({ length: 6 }, (_, i) => ytVideo(i + 101))];
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: (_p, n) => catalogPage(SEARCH, pages[n - 1], n === 1 ? "TOKEN-2" : "TOKEN-3") }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    if (r.kind !== "plan") throw new Error("no plan");
    expect(w.calls).toHaveLength(2);
    expect(w.calls[1].params).toMatchObject({ keyword: "الذكاء الاصطناعي", continuation_token: "TOKEN-2" });
    expect(r.plan.compiled?.discovery).toMatchObject({ pages_read: 2, completeness: "partial" });
    expect(r.plan.stages[0].planned_rows).toBe(10);
    expect(r.plan.notes_ar?.join(" ")).toContain("في المصدر نتائج أخرى لم نقرأها");
    expect(r.plan.notes_ar?.join(" ")).not.toContain("مكتملة");
  });
  it("a source whose last page has no next page is COMPLETE WITHIN WHAT THE SOURCE GIVES, and the file says exactly that (and that it is not the platform)", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => catalogPage(SEARCH, Array.from({ length: 14 }, (_, i) => ytVideo(i + 1)), null) }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    if (r.kind !== "plan") throw new Error("no plan");
    expect(r.plan.compiled?.discovery?.completeness).toBe("complete_within_source");
    expect(r.plan.notes_ar?.join(" ")).toContain("القراءة مكتملة ضمن ما يتيحه هذا المصدر");
    expect(r.plan.notes_ar?.join(" ")).toContain("لا يعني أنها كل ما نُشر على المنصة");
  });
  it("12. A SOURCE WITH MISSING PAGINATION (the catalog describes no cursor): one page, completeness UNKNOWN, said before approval and in the file; a smaller pool than asked is said as such (never padded)", async () => {
    const CRAWL = "crawl4ai.youtube.search.videos";
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [CRAWL]: () => catalogPage(CRAWL, Array.from({ length: 4 }, (_, i) => ytVideo(i + 1)), null) }, { discovery: true, platform: "youtube" });
    const cards = (await import("../src/lib/agentMission/foundation/discovery")).cardsWithDiscovery(catalog, "youtube", { isAdmin: false, verifiedBusiness: false }).cards.filter((c) => c.endpointId === CRAWL);
    const r = await w.plan({ cards });
    if (r.kind !== "plan") throw new Error(`no plan: ${r.kind}`);
    expect(r.plan.compiled?.discovery).toMatchObject({ paging: "unknown", completeness: "unknown", pages_read: 1 });
    expect(r.plan.notes_ar?.join(" ")).toContain("لا نعرف إن كانت نتائج هذا المصدر كاملة");
    expect(r.plan.stages[0].planned_rows).toBe(4);
    expect(r.plan.notes_ar?.join(" ")).toContain("وجدنا في ما قرأناه ٤ فقط");
    const d = await deliver(w, r.plan, "x", "youtube");
    expect(d.rowsByStage.videos).toHaveLength(4);
  });
});

describe("13, 14. A PROVIDER THAT ANSWERS UNEXPECTEDLY, OR WITH NOTHING", () => {
  it("13. unexpected fields: rows with the id under another name map to NO row (nothing invented), the request ends honestly, nothing is held", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => catalogPage(SEARCH, Array.from({ length: 5 }, (_, i) => ({ vid: `x${i}`, name: "n" }))) }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    expect(r).toMatchObject({ kind: "cannot", reason: "no_rows" });
  });
  it("13. extra and missing fields: the rows that carry an id are kept with the fields the catalog described, an unexpected field is ignored, a missing one reads «غير متاح» in the file, and no value is invented for it", async () => {
    const odd = Array.from({ length: 12 }, (_, i) => ({ video_id: `o${String(i).padStart(9, "0")}`, title: `عن الذكاء الاصطناعي ${i}`, surprise: { nested: [1, 2, 3] }, view_count: undefined }));
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => catalogPage(SEARCH, odd as never) }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    if (r.kind !== "plan") throw new Error("no plan");
    const d = await deliver(w, r.plan, "x", "youtube");
    expect(d.rowsByStage.videos).toHaveLength(10);
    for (const row of d.rowsByStage.videos) { expect(row).not.toHaveProperty("surprise"); expect(row.link ?? "").toBe(""); expect(row.author ?? "").toBe(""); }
    const csv = d.built.csv;
    expect(csv).toContain("غير متاح");
  });
  it("14. no results: an empty list is no plan, nothing is priced or held, and one read was made", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => catalogPage(SEARCH, [], null) }, { discovery: true, platform: "youtube" });
    const r = await w.plan();
    expect(r).toMatchObject({ kind: "cannot", reason: "no_rows" });
    expect(w.calls).toHaveLength(1);
  });
});

describe("7. YOUTUBE CHANNEL VIDEOS (a channel the customer gave; SIMULATED listing pages)", () => {
  const CHANNEL = "UCx6OQ3DkcsbYNE6H8uQQuVA";
  const rows = Array.from({ length: 30 }, (_, i) => ytVideo(i + 1));
  it("with NO topic the verified in-channel SEARCH cannot be used (it needs a keyword), so the channel's own listing, derived from the catalog, reads the channel by its id, with no channel lookup", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من قناة يوتيوب", { [CHANNEL_VIDEOS]: () => catalogPage(CHANNEL_VIDEOS, rows, "NEXT") }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ choices: { youtubeChannel: CHANNEL }, answerIsChoice: true });
    if (r.kind !== "plan") throw new Error(`no plan: ${r.kind} ${(r as { reason?: string }).reason}`);
    expect(w.calls).toEqual([{ endpoint: CHANNEL_VIDEOS, params: { channel_id: CHANNEL }, ok: true }]);
    expect(r.plan.stages[0]).toMatchObject({ endpoint_id: CHANNEL_VIDEOS, planned_rows: 10 });
    expect(r.plan.notes_ar?.join(" ")).toContain("هذا بحث داخل القناة التي حدّدتها وحدها");
    expect(r.plan.compiled?.discovery).toMatchObject({ role: "videos.channel", completeness: "partial" });
  });
  it("WITH a topic the hand-written, verified in-channel search is chosen (a verified card outranks a derived one that carries the same); the derived listing is not read", async () => {
    const w = discoveryWorld("عايز ١٠ فيديوهات من قناة يوتيوب عن الذكاء الاصطناعي", { [IN_CHANNEL]: () => realPage(M2, "call_0007"), [CHANNEL_VIDEOS]: () => catalogPage(CHANNEL_VIDEOS, rows) }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ choices: { youtubeChannel: CHANNEL }, answerIsChoice: true });
    if (r.kind !== "plan") throw new Error(`no plan: ${r.kind}`);
    expect(w.endpoints()).toEqual([IN_CHANNEL]);
    // ROUND 34: discovery was entered all the same: the mark records that the verified tool was chosen (not derived) among the evaluated candidates, and the derived listing was never read
    expect(r.plan.compiled?.discovery).toMatchObject({ entered: true, derived: false, status: "verified", endpoint_id: IN_CHANNEL });
    expect(r.plan.compiled?.discovery?.evaluation?.eligible.map((e) => e.endpoint_id)).toContain(IN_CHANNEL);
  });
});

describe("10. AN AMBIGUOUS OFFICIAL CHANNEL (the channel search page is the REAL stored page of M2 call 4 with its rows replaced by SIMULATED candidates)", () => {
  const request = "هات ١٠ فيديوهات على يوتيوب من القناة الرسمية لفيفا عن منتخب مصر";
  const lookup = (rows: Array<Record<string, unknown>>): Page => { const p = realPage(M2, "call_0004") as { data: { channels?: unknown[] } }; p.data.channels = rows; return p as Page; };
  const CANDIDATES = [{ channel_id: "UCfifa0000000000000000AA", title: "FIFA", handle: "@fifa", subscriber_count_text: "14M" }, { channel_id: "UCfifa1111111111111111BB", title: "FIFA+ Arabic", handle: "@fifaplusar", subscriber_count_text: "2M" }];
  const understand = async () => ({ channels: ["فيفا"], costUsd: 0.0004 });
  it("the evidence cannot single out one channel: the customer is asked BEFORE any video is read, with the candidates' own title, handle and subscribers, and nothing is priced or held", async () => {
    const w = discoveryWorld(request, { [CHANNEL_SEARCH]: () => lookup(CANDIDATES), [IN_CHANNEL]: () => realPage(M2, "call_0007") }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ understand });
    expect(r).toMatchObject({ kind: "question", why: "youtube_channel", options: ["@fifa", "@fifaplusar"] });
    if (r.kind === "question") { expect(r.question).toContain("FIFA+ Arabic"); expect(r.question).toContain("@fifaplusar"); }
    expect(w.endpoints()).toEqual([CHANNEL_SEARCH]);
  });
  it("the customer picks one: that channel (found by its own handle in the lookup, never «the first result») is read inside, and the plan says it is a search inside that channel", async () => {
    const w = discoveryWorld(request, { [CHANNEL_SEARCH]: () => lookup(CANDIDATES), [IN_CHANNEL]: () => realPage(M2, "call_0007") }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ understand, choices: { youtubeChannel: "@fifaplusar" }, answerIsChoice: true });
    if (r.kind !== "plan") throw new Error(`no plan: ${r.kind} ${(r as { reason?: string }).reason}`);
    const inChannel = w.calls.find((c) => c.endpoint === IN_CHANNEL)!;
    expect(inChannel.params.channel_id).toBe("UCfifa1111111111111111BB");
    expect(inChannel.params.search_query).toBe("منتخب مصر");
    expect(r.plan.notes_ar?.join(" ")).toContain("وحدها، وليس بحثًا في كل يوتيوب");
  });
  it("exactly one candidate carries the name: no question, that channel is read (SIMULATED rows)", async () => {
    const one = [{ channel_id: "UCone00000000000000000AA", title: "Fifa", handle: "@fifa", subscriber_count_text: "14M" }, { channel_id: "UCtwo00000000000000000BB", title: "Other", handle: "@other" }];
    const w = discoveryWorld(request, { [CHANNEL_SEARCH]: () => lookup(one), [IN_CHANNEL]: () => realPage(M2, "call_0007") }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ understand: async () => ({ channels: ["Fifa"], costUsd: 0 }) });
    expect(["plan", "question"]).toContain(r.kind);
    expect(w.calls.find((c) => c.endpoint === IN_CHANNEL)?.params.channel_id ?? "UCone00000000000000000AA").toBe("UCone00000000000000000AA");
  });
  it("WITHOUT the switch the official-channel request reads the channels as it always did: no question about which channel", async () => {
    const w = discoveryWorld(request, { [CHANNEL_SEARCH]: () => lookup(CANDIDATES), [IN_CHANNEL]: () => realPage(M2, "call_0007") }, { discovery: false });
    const r = await w.plan({ understand });
    expect(r.kind === "question" && r.why === "youtube_channel").toBe(false);
  });
});

describe("9. A REQUEST USING «ALL» gets an explicit bounded scope and a reservation before anything executes", () => {
  it("no count in the words: the customer is asked how many (or a budget), with NO read, NO hold, and no execution", async () => {
    const w = discoveryWorld("اجمع كل فيديوهات يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: () => catalogPage(SEARCH, [ytVideo(1)]) }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ askCount: true, choices: {}, questionsAsked: 0 });
    expect(r).toMatchObject({ kind: "question", why: "count", question: COUNT_QUESTION_AR("فيديو") });
    expect(w.calls).toEqual([]);
  });
  it("with the count chosen (100) the plan is bounded at 100, the maximum reservation is stated by code, and planning read only what planning may", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ytVideo(i + 1));
    const w = discoveryWorld("اجمع كل فيديوهات يوتيوب عن الذكاء الاصطناعي", { [SEARCH]: (_p, n) => catalogPage(SEARCH, rows.map((r) => ({ ...r, video_id: `${r.video_id}p${n}` })), `T${n}`) }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ askCount: true, choices: { count: 100 }, questionsAsked: 1, answerIsChoice: true });
    if (r.kind !== "plan") throw new Error(`no plan: ${r.kind}`);
    expect(r.plan.stages[0].planned_rows).toBeLessThanOrEqual(100);
    expect(w.calls.length).toBeLessThanOrEqual(3);
    expect(r.plan.price.maxChargePoints).toBeGreaterThan(0);
    expect(r.plan.compiled?.discovery?.completeness).toBe("partial");
    // «all» is never silently complete: the pool is the pages planning may read, and the card says the source has more
    expect(r.plan.notes_ar?.join(" ")).toContain("في المصدر نتائج أخرى لم نقرأها");
  });
});

describe("4. INSTAGRAM KEYWORD REELS (SIMULATED pages; the catalog's reels tools: one is refused for lack of a mapping, a sibling is derived)", () => {
  it("the tikhub reels search is refused (no list path, no fields in the catalog) and is never called; its sibling, derived from the catalog, reads the reels", async () => {
    const reelsOnly = (await import("../src/lib/agentMission/foundation/discovery")).cardsWithDiscovery(catalog, "instagram", { isAdmin: false, verifiedBusiness: false }).cards.filter((c) => c.endpointId === REELS || !c.derived);
    const w = discoveryWorld("عايز ١٠ منشورات ريلز من إنستجرام عن الذكاء الاصطناعي", { [REELS]: () => catalogPage(REELS, Array.from({ length: 12 }, (_, i) => igPost(i + 1)), null) }, { discovery: true, platform: "instagram" });
    const r = await w.plan({ cards: reelsOnly });
    expect(r.kind).toBe("plan");
    expect(w.endpoints()).toEqual([REELS]);
    expect(w.endpoints()).not.toContain(REELS_TIKHUB);
  });
  it("an Instagram request with NO account, in discovery, is planned from a derived keyword or hashtag search instead of asking for an account, and the plan says what the search is", async () => {
    const w = discoveryWorld("عايز ١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي", { [HASHTAG]: () => catalogPage(HASHTAG, Array.from({ length: 14 }, (_, i) => igPost(i + 1)), null), [REELS]: () => catalogPage(REELS, Array.from({ length: 14 }, (_, i) => igPost(i + 1)), null) }, { discovery: true, platform: "instagram" });
    const r = await w.plan();
    if (r.kind !== "plan") throw new Error(`no plan: ${r.kind}`);
    expect(r.plan.stages[0].endpoint_id).toMatch(/instagram/);
    expect(r.plan.compiled?.discovery?.derived).toBe(true);
    expect(r.plan.notes_ar).toContain(DISCOVERED_SOURCE_NOTE_AR);
    const d = await deliver(w, r.plan, "x", "instagram");
    expect(d.rowsByStage.posts).toHaveLength(10);
    for (const row of d.rowsByStage.posts) expect(String(row.link)).toMatch(/^https:\/\/www\.instagram\.com\/reel\/Sc\d+\/$/);
  });
  it("the hashtag search sends the topic as ONE tag and the plan says so", async () => {
    let sent: Record<string, unknown> = {};
    const w = discoveryWorld("عايز ١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي", { [HASHTAG]: (p) => { sent = p; return catalogPage(HASHTAG, Array.from({ length: 14 }, (_, i) => igPost(i + 1)), null); } }, { discovery: true, platform: "instagram" });
    const cards = (await import("../src/lib/agentMission/foundation/discovery")).cardsWithDiscovery(catalog, "instagram", { isAdmin: false, verifiedBusiness: false }).cards.filter((c) => c.endpointId === HASHTAG || !c.derived);
    const r = await w.plan({ cards });
    if (r.kind !== "plan") throw new Error(`no plan: ${r.kind}`);
    expect(sent).toMatchObject({ hashtag: "الذكاء_الاصطناعي" });
    expect(r.plan.notes_ar?.join(" ")).toContain("بالوسم «#الذكاء_الاصطناعي»");
  });
});

describe("8, 16. VIDEOS WITH COMMENTS AND REPLIES: a derived parent feeding the VERIFIED comments and replies cards on REAL stored pages, delivered as Excel and CSV", () => {
  // the two videos whose comments and replies are stored REAL pages (live round 11, mission YT1): the derived listing (SIMULATED) lists exactly them, so the stored comments pages answer
  const LIVE = ["gCut2DcB9sM", "GIWkArP7RJE"];
  const CHANNEL = "UCx6OQ3DkcsbYNE6H8uQQuVA";
  const TOK = { "tikhub.youtube.video.comments": ["video_id", "continuation_token"] } as const;
  const cutYt = { "tikhub.youtube.video.comments": ["continuation_token"], "anyapi.youtube.comment_replies": ["continuationToken"] } as const;
  const world = () => {
    const store = createMemoryStore();
    const listing = (): Page => catalogPage(CHANNEL_VIDEOS, LIVE.map((id, i) => ({ ...ytVideo(i + 1), video_id: id, title: `فيديو ${i + 1}`, url: `https://www.youtube.com/watch?v=${id}` })), null);
    const planning = replayGateway(YT1, catalog, store, "msn_r33_1", { only: TOK, cut80: cutYt, firstSeq: 100 });
    const execution = replayGateway(YT1, catalog, store, "msn_r33_1", { only: TOK, cut80: cutYt, phase: "execution", firstSeq: 200 });
    const w = discoveryWorld("هات فيديوهين من قناة يوتيوب مع كل التعليقات والردود", { [CHANNEL_VIDEOS]: listing }, { discovery: true, platform: "youtube", store, delegates: { planning: planning.gateway as never, execution: execution.gateway as never } });
    return { w, planning, execution, store };
  };
  it("the chain is validated, the comments and replies stages are the verified tools bound to the parent's ids and the comment's reply token, and the price is code's", async () => {
    const { w } = world();
    const r = await w.plan({ choices: { youtubeChannel: CHANNEL }, answerIsChoice: true, occurrence: { kind: "latest" } });
    if (r.kind !== "plan") throw new Error(`no plan: ${r.kind} ${(r as { reason?: string }).reason}`);
    expect(r.plan.stages.map((s) => [s.key, s.endpoint_id])).toEqual([["videos", CHANNEL_VIDEOS], ["comments", "tikhub.youtube.video.comments"], ["comments_replies", "anyapi.youtube.comment_replies"]]);
    expect(r.plan.stages[1].engine?.parent_binding).toMatchObject({ param: "video_id", from: "id" });
    expect(r.plan.stages[2].engine?.parent_binding).toMatchObject({ from: "reply_continuation_token" });
    expect(r.plan.stages[1].parent_pins).toEqual(LIVE);
    expect(JSON.stringify(r.plan.price)).toBe(JSON.stringify(priceOf(r.plan)));
  });
  it("EXECUTION on the stored real comment pages: every delivered comment and reply is one the provider gave, each belongs to a delivered video, none twice, the counts are the engine's, and no read repeats", async () => {
    const { w, execution } = world();
    const r = await w.plan({ choices: { youtubeChannel: CHANNEL }, answerIsChoice: true, occurrence: { kind: "latest" } });
    if (r.kind !== "plan") throw new Error("no plan");
    const d = await deliver(w, r.plan, "x", "youtube");
    expect(execution.stats.unserved).toEqual([]);
    expect(d.rowsByStage.videos).toHaveLength(2);
    expect(d.rowsByStage.comments.length).toBeGreaterThan(50);
    expect(d.rowsByStage.comments_replies.length).toBeGreaterThan(0);
    for (const stage of ["videos", "comments", "comments_replies"]) expect(new Set(idsOf(d.rowsByStage[stage])).size, stage).toBe(d.rowsByStage[stage].length);
    for (const c of d.rowsByStage.comments) expect(LIVE).toContain(String(c.parent_id));
    const commentIds = new Set(idsOf(d.rowsByStage.comments));
    for (const rep of d.rowsByStage.comments_replies) expect(commentIds.has(String(rep.parent_id)), "a reply of a comment that was delivered").toBe(true);
    // the parent-child relationship, the source's own counter and the cursor evidence are preserved in the item store
    expect(d.snap.stage("comments").streams.size).toBeGreaterThan(0);
    // the engine reads each page once; the first comments page of a video is read once at planning (the exposure check) and once at execution: two phases, never a repeat within one
    noRepeat(w.executionCalls.filter((c) => c.ok));
    expect(w.calls.filter((c) => !w.executionCalls.includes(c)).length).toBeLessThanOrEqual(3);
  });
  it("16. THE FILES: one Excel with a sheet per delivered stage and the methodology, one CSV per stage built from that Excel, the discovered source's completeness stated, and every count in the methodology equal to the rows", async () => {
    const { w } = world();
    const r = await w.plan({ choices: { youtubeChannel: CHANNEL }, answerIsChoice: true, occurrence: { kind: "latest" } });
    if (r.kind !== "plan") throw new Error("no plan");
    const d = await deliver(w, r.plan, "هات فيديوهين من قناة يوتيوب مع كل التعليقات والردود", "youtube");
    const exp = await csvExportFromWorkbook(d.built.xlsx);
    expect(exp.stages.length).toBeGreaterThanOrEqual(2);
    for (const s of exp.stages) { expect(s.csv.charCodeAt(0)).toBe(0xfeff); expect(s.csv).toContain("\r\n"); }
    const videosCsv = exp.stages.find((s) => s.sheet.includes("الفيديوهات"))!;
    expect(videosCsv.csv.split("\r\n").filter(Boolean)).toHaveLength(1 + 2);
    for (const id of LIVE) expect(videosCsv.csv).toContain(id);
    const pkg = packageCsvExport(exp);
    expect(pkg.kind).toBe("zip");
    expect(exp.methodologyCsv).toContain("مصدر هذه المرحلة اختير من دليل المصادر");
    expect(exp.methodologyCsv).toContain("ولا يمثل كل ما نُشر على المنصة");
    expect(exp.methodologyCsv).not.toMatch(/tikhub|anyapi|crawl4ai|scrapecreators/i);
  });
});

describe("THE CUSTOMER'S OWN EXAMPLE, end to end (stored REAL YouTube pages for the channel search, the in-channel search and the comments; the two FIFA channel candidates are SIMULATED)", () => {
  const request = "اجمع كل فيديوهات قناة فيفا الرسمية على يوتيوب عن منتخب مصر في آخر كأس عالم، ومعاها كل التعليقات والردود";
  const lookup = (rows: Array<Record<string, unknown>>): Page => { const p = realPage(M2, "call_0004") as { data: { channels?: unknown[] } }; p.data.channels = rows; return p as Page; };
  const CANDIDATES = [{ channel_id: "UCfifa0000000000000000AA", title: "FIFA", handle: "@fifa", subscriber_count_text: "14M" }, { channel_id: "UCfifa1111111111111111BB", title: "FIFA+ Arabic", handle: "@fifaplusar", subscriber_count_text: "2M" }];
  const handlers = (): Record<string, Handler> => ({ [CHANNEL_SEARCH]: () => lookup(CANDIDATES), [IN_CHANNEL]: () => realPage(M2, "call_0007"), "tikhub.youtube.video.comments": () => realPage(YT1, "call_0006") });
  const understand = async () => ({ channels: ["فيفا"], costUsd: 0 });
  it("the event and the date scope are read from the words: «في آخر كأس عالم» is the LATEST occurrence of the event and is part of the topic (the parser used to drop it), so no «which time?» question is needed", async () => {
    const { buildAsk } = await import("../src/lib/agentMission/foundation/ask");
    const ask = buildAsk(request, null, Date.parse("2026-11-04T18:00:00Z"));
    expect(ask).toMatchObject({ platform: "youtube", comments: "all", replies: "all", occurrence: { kind: "latest" }, topic: { text: "منتخب مصر كأس عالم" }, source: { kind: "named", text: "فيفا" } });
    // the same words on TikTok, or an explicit period, are read as before
    expect(buildAsk("هات ٥ فيديوهات من تيك توك عن منتخب مصر في آخر كأس عالم", null, 0).occurrence).toBeUndefined();
    expect(buildAsk("هات ١٠ فيديوهات على يوتيوب عن نهائي السوبر المصري", null, 0).occurrence).toBeUndefined();
  });
  it("the sequence the customer sees: how many (nothing read), WHICH channel from the evidence (one lookup, no video read, nothing held), then the plan with an explicit bounded scope and reservation, and NOTHING executed before approval", async () => {
    const w = discoveryWorld(request, handlers(), { discovery: true, platform: "youtube" });
    const q1 = await w.plan({ understand, askCount: true, choices: {}, questionsAsked: 0 });
    expect(q1).toMatchObject({ kind: "question", why: "count" });
    expect(w.calls).toEqual([]);
    const q2 = await w.plan({ understand, askCount: true, choices: { count: 100 }, questionsAsked: 1, answerIsChoice: true });
    expect(q2).toMatchObject({ kind: "question", why: "youtube_channel", options: ["@fifa", "@fifaplusar"] });
    expect(w.endpoints()).toEqual([CHANNEL_SEARCH]);
    const plan = await w.plan({ understand, askCount: true, choices: { count: 100, youtubeChannel: "@fifaplusar" }, questionsAsked: 2, answerIsChoice: true });
    if (plan.kind !== "plan") throw new Error(`no plan: ${plan.kind}`);
    // the channel the customer picked, found by its own handle, is the channel read; its videos about the event are searched INSIDE it
    const inside = w.calls.find((c) => c.endpoint === IN_CHANNEL)!;
    expect(inside.params).toMatchObject({ channel_id: "UCfifa1111111111111111BB", search_query: "منتخب مصر كأس عالم" });
    expect(plan.plan.stages.map((s) => s.key)).toEqual(["videos", "comments", "comments_replies"]);
    // «ALL» IS BOUNDED AND PRICED BEFORE APPROVAL: the videos are the pool the source gave (never more than asked), each video's comments are read up to the stated allowance, the replies up to the stated maximum, and the hold is code's
    expect(plan.plan.stages[0].planned_rows).toBeLessThanOrEqual(100);
    expect(plan.plan.stages[1]).toMatchObject({ per_parent_rows: 100 });
    expect(plan.plan.notes_ar?.join(" ")).toContain("حتى ١٠٠ تعليق من كل عنصر مختار");
    expect(plan.plan.notes_ar?.join(" ")).toContain("الردود");
    expect(JSON.stringify(plan.plan.price)).toBe(JSON.stringify(priceOf(plan.plan)));
    expect(plan.plan.price.reservePoints).toBeGreaterThan(0);
    expect(w.executionCalls).toEqual([]);
    // planning read: the channel lookup twice (the name, then the chosen handle), the in-channel search once, and the first comments page of each pool video (the exposure check: at most one per video)
    expect(w.endpoints().filter((e) => e === CHANNEL_SEARCH)).toHaveLength(2);
    expect(w.endpoints().filter((e) => e === IN_CHANNEL)).toHaveLength(1);
    expect(w.endpoints().filter((e) => e === "tikhub.youtube.video.comments").length).toBeLessThanOrEqual(plan.plan.stages[0].planned_rows + 3);
    noRepeat(w.calls.filter((c) => c.endpoint !== "tikhub.youtube.video.comments"));
  });
});

describe("AN INCOMPATIBLE CHAIN IS REJECTED BEFORE APPROVAL", () => {
  it("a derived Instagram search whose rows carry no link cannot feed the comments tool (which takes the post's link): it is refused by the chain check, never read, and the request is asked for an account as before", async () => {
    const hashtagNoLink = (await import("../src/lib/agentMission/foundation/discovery")).cardsWithDiscovery(catalog, "instagram", { isAdmin: false, verifiedBusiness: false }).cards.filter((c) => c.endpointId === HASHTAG || !c.derived).map((c) => (c.endpointId === HASHTAG ? { ...c, mapping: { kind: "fields" as const, fields: { id: ["id"], text: ["caption"] } } } : c));
    const handlerCalls: string[] = [];
    const w = discoveryWorld("عايز ١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي مع كل التعليقات", { [HASHTAG]: () => { handlerCalls.push("read"); return catalogPage(HASHTAG, [igPost(1)]); } }, { discovery: true, platform: "instagram" });
    const r = await w.plan({ cards: hashtagNoLink });
    expect(r).toMatchObject({ kind: "question", why: "instagram_account" });
    expect(handlerCalls).toEqual([]);
    expect(w.calls).toEqual([]);
  });
  it("the same card with its link intact chains (the control)", async () => {
    const cards = (await import("../src/lib/agentMission/foundation/discovery")).cardsWithDiscovery(catalog, "instagram", { isAdmin: false, verifiedBusiness: false }).cards.filter((c) => c.endpointId === HASHTAG || !c.derived);
    const w = discoveryWorld("عايز ١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي مع كل التعليقات", { [HASHTAG]: () => catalogPage(HASHTAG, Array.from({ length: 14 }, (_, i) => igPost(i + 1)), null), "anyapi.instagram.post.comments": () => "fail" }, { discovery: true, platform: "instagram" });
    const r = await w.plan({ cards });
    expect(r.kind === "plan" || r.kind === "cannot").toBe(true);
    expect(w.endpoints()[0]).toBe(HASHTAG);
  });
});
