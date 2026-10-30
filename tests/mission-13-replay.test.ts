import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tregResult } from "./helpers/agentFakeWorld";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { loadSystemPrompt } from "../agent/src/prompt";
import type { ModelDriver, RunInput } from "../agent/src/driver";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { NO_WEB, anyWebAvailable, providerOfWebSource, resolveWebAvailability, usableSearchProvider, webSourceAvailable } from "../src/lib/agentMission/webAvailability";
import { searchAgentSources } from "../src/lib/agentMission/sources";

/**
 * FIX MISSION 13 (live retest of 2026-10-30, test account; `missions`, `mission_calls`, `provider_api_keys` read with SELECT). Every moment here is FIXED: no test reads the clock.
 */
const FIXED_NOW = "2026-10-30T20:00:00.000Z";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(FIXED_NOW)); });
afterEach(() => { vi.useRealTimers(); });

const catalog = loadTregCatalog();
const REQUEST_YT = "هات من قنوات العربية واليوم السابع وبي بي سي نيوز الإنجليزية على يوتيوب ٥ فيديوهات من كل قناة عن حرب إيران وإسرائيل آخر ٣ شهور، ومن كل فيديو ٢٠ تعليق";

// ---------------------------------------------------------------------------------------------------- 1. tools the worker cannot use (msn_592ed6abda7c8e5973e6, msn_898221359b77fb4e050c)
describe("1. a tool the worker has no key for is not offered (live: both YouTube runs called only web search / scrape, 69 of 69 web calls in 3 days refused as «unavailable»)", () => {
  /** A driver that keeps what the run offered (the tool list and the system prompt) and plays the script. */
  const recording = (script: FakeStep[]) => {
    const inner = createFakeDriver(script);
    const seen: RunInput[] = [];
    const driver: ModelDriver & { results: typeof inner.results } = { results: inner.results, run: async (input) => { seen.push(input); return inner.run(input); } };
    return { driver, seen };
  };
  const planning = async (script: FakeStep[], providerKey?: RunnerDeps["providerKey"], answers: unknown[] = []) => {
    const store = createMemoryStore();
    store.missions.set("msn_yt", newMission({ id: "msn_yt", user_id: USER_ID, status: "planning", request_text: REQUEST_YT }));
    const rec = fakeRecorder();
    const queue = [...answers];
    const call = async () => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n; };
    const { driver, seen } = recording(script);
    const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, ...(providerKey ? { providerKey } : {}) };
    await runPlanning(deps, store.missions.get("msn_yt")!);
    return { store, driver, seen };
  };
  const NO_KEY: RunnerDeps["providerKey"] = async () => null;
  const LIVE_SCRIPT = (): FakeStep[] => [
    { tool: "web_search", args: { provider: "contextdev", query: "قناة العربية يوتيوب حرب إيران وإسرائيل" } },
    { tool: "catalog_search", args: { words: ["web", "search", "news", "youtube", "channel", "videos"], limit: 10 } },
    { tool: "describe_endpoint", args: { id: "firecrawl.search" } },
    { tool: "web_scrape", args: { provider: "firecrawl", url: "https://www.youtube.com/@AlArabiya" } },
    { tool: "treg_call", args: { endpoint_id: "crawl4ai.youtube.channel.videos", params: { channel: "UCHnyfMqiRRG1u-2MsSQLbXA", limit: 15 }, why: "the channel's own listing" } },
  ];

  it("no key stored for either provider: the tool list has no web tool, catalog_search lists no web source, describe_endpoint knows none, and the planner reaches a catalog YouTube channel endpoint", async () => {
    const found = await planning(LIVE_SCRIPT(), NO_KEY, [tregResult({ data: [{ video_id: "v1", title: "حرب إيران وإسرائيل", url: "https://www.youtube.com/watch?v=v1", published: "قبل ٤ أيام", views: 100 }] }, 0.001)]);
    const names = found.seen[0].tools.map((t) => t.name);
    for (const web of ["parse_page", "web_search", "web_scrape", "people_search"]) expect(names).not.toContain(web);
    expect(names).toContain("treg_call");
    // the script's web steps find no such tool
    expect(found.driver.results[0]).toMatchObject({ tool: "web_search", result: { ok: false } });
    expect(String(found.driver.results[0].result.error)).toContain("no such tool");
    // catalog_search offers the catalog's sources only
    const hits = (found.driver.results[1].result as { hits: Array<{ id: string }> }).hits.map((h) => h.id);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((id) => /^(contextdev|firecrawl)\./.test(id))).toBe(false);
    // describe_endpoint does not describe one
    expect(found.driver.results[2].result.ok).toBe(false);
    // the system prompt does not name a tool the planner does not have
    const prompt = found.seen[0].systemPrompt;
    for (const web of ["parse_page", "web_search", "web_scrape", "people_search", "Firecrawl", "Context.dev"]) expect(prompt).not.toContain(web);
    expect(prompt).not.toContain("<!--");
    expect(prompt).toContain("catalog_search, describe_endpoint, treg_call, collect_pages, run_code");
    // the catalog's channel listing was called, and nothing was refused as «unavailable»
    const calls = found.store.calls.filter((c) => c.mission_id === "msn_yt");
    expect(calls.map((c) => c.endpoint_id)).toEqual(["crawl4ai.youtube.channel.videos"]);
    expect(calls[0].status).toBe("ok");
    expect(calls.some((c) => String(c.refused_reason ?? "").startsWith("source_unavailable"))).toBe(false);
  });

  it("a key for one provider only: its tools are offered, the other provider's source is not listed, and a search asked of the other provider is served by the one that has a key", async () => {
    const onlyContextDev: RunnerDeps["providerKey"] = async (p) => (p === "contextdev" ? "k" : null);
    const found = await planning([
      { tool: "catalog_search", args: { words: ["web", "search", "news"], limit: 10 } },
      { tool: "describe_endpoint", args: { id: "firecrawl.search" } },
      { tool: "describe_endpoint", args: { id: "contextdev.search" } },
    ], onlyContextDev);
    const names = found.seen[0].tools.map((t) => t.name);
    for (const web of ["parse_page", "web_search", "web_scrape", "people_search"]) expect(names).toContain(web);
    const hits = (found.driver.results[0].result as { hits: Array<{ id: string }> }).hits.map((h) => h.id);
    expect(hits).toContain("contextdev.search");
    expect(hits).not.toContain("firecrawl.search");
    expect(found.driver.results[1].result.ok).toBe(false);
    expect(found.driver.results[2].result.ok).toBe(true);
    expect(found.seen[0].systemPrompt).toContain("web_search and web_scrape");
  });

  it("a key for Firecrawl only: the page parsers and the people search (Context.dev's) are not offered, the web search and scrape are", async () => {
    const onlyFirecrawl: RunnerDeps["providerKey"] = async (p) => (p === "firecrawl" ? "k" : null);
    const found = await planning([{ tool: "catalog_search", args: { words: ["web", "search", "people", "linkedin"], limit: 10 } }], onlyFirecrawl);
    const names = found.seen[0].tools.map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_scrape");
    expect(names).not.toContain("parse_page");
    expect(names).not.toContain("people_search");
    const hits = (found.driver.results[0].result as { hits: Array<{ id: string }> }).hits.map((h) => h.id);
    expect(hits).toContain("firecrawl.search");
    expect(hits.some((id) => id.startsWith("contextdev."))).toBe(false);
  });

  it("a key store that throws counts as no key (nothing is assumed available)", async () => {
    const found = await planning([{ tool: "catalog_search", args: { words: ["web", "search"], limit: 5 } }], async () => { throw new Error("store down"); });
    expect(found.seen[0].tools.map((t) => t.name)).not.toContain("web_search");
  });

  it("the helpers: provider of a source, availability by provider, the provider a search is routed to", async () => {
    expect(providerOfWebSource("contextdev.parse.google-maps")).toBe("contextdev");
    expect(providerOfWebSource("contextdev.people.search")).toBe("contextdev");
    expect(providerOfWebSource("firecrawl.scrape")).toBe("firecrawl");
    expect(providerOfWebSource("crawl4ai.youtube.channel.videos")).toBeNull();
    expect(webSourceAvailable("firecrawl.search", { firecrawl: false, contextdev: true })).toBe(false);
    expect(webSourceAvailable("crawl4ai.youtube.channel.videos", { firecrawl: true, contextdev: true })).toBe(false);
    expect(anyWebAvailable(NO_WEB)).toBe(false);
    expect(usableSearchProvider("firecrawl", { firecrawl: false, contextdev: true })).toBe("contextdev");
    expect(usableSearchProvider("contextdev", { firecrawl: true, contextdev: true })).toBe("contextdev");
    expect(usableSearchProvider("firecrawl", NO_WEB)).toBeNull();
    expect(await resolveWebAvailability(async (p) => (p === "firecrawl" ? "k" : ""))).toEqual({ firecrawl: true, contextdev: false });
    expect(searchAgentSources({ words: ["web", "search"], isAvailable: () => false })).toEqual([]);
    expect(searchAgentSources({ words: ["web", "search"] }).length).toBeGreaterThan(0);
  });

  it("the prompt keeps its web text when the worker has the keys (the default), and the two blocks are removed whole without it", () => {
    const withWeb = loadSystemPrompt("planning");
    const without = loadSystemPrompt("planning", undefined, { web: false });
    expect(withWeb).toContain("parse_page (pre-built page parsers");
    expect(withWeb).not.toContain("<!--");
    expect(without).not.toContain("parse_page");
    expect(without).toContain("treg_call and collect_pages (the catalog). The only way to compute on data is run_code");
    expect(without).toContain("a b2b_contact endpoint of the catalog)");
  });
});

// ---------------------------------------------------------------------------------------------------- 3. TikTok comments: 10, 1, 0, 0, 0 per video (msn_3f8c56017afb1bd42645)
import { callIds, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { assertReplayInvariants, replay } from "./helpers/agentReplay";
import { readSnapshot } from "../agent/src/items/itemStore";

describe("3. TikTok «هات ٥ فيديوهات ... ومن كل فيديو ١٠ تعليقات»: a video the comment source gives nothing for is replaced by a spare the search already checked (live: 16 of 55, the five NEWEST videos had 0, 0, 1, 0 and 10 comments)", () => {
  const SEARCH = "anyapi.tiktok.search.videos";
  const COMMENTS = "crawl4ai.tiktok.video.comments";
  const REQUEST = "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات";
  const why = "the cheaper search sources returned videos that are not about the team";
  const cols = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));
  /** The search as the live run read it, newest first (sortBy 2): the first five are minutes old (0, 0, 1, 0 and 12 comments), the other fifteen are older and have comments. */
  const NEW_COMMENTS = [0, 0, 1, 0, 12];
  const vid = (i: number) => `77025${String(i).padStart(14, "0")}`;
  const POOL = Array.from({ length: 20 }, (_, i) => ({ id: vid(i + 1), caption: `منتخب مصر فيديو رقم ${i + 1}`, author: `صانع ${i + 1}`, link: `https://www.tiktok.com/@u${i + 1}/video/${vid(i + 1)}`, comments: i < 5 ? NEW_COMMENTS[i] : 40, createdUtc: "2026-10-30T20:40:00.000Z" }));
  const searchPage = { data: { results: POOL } };
  /** What the comment source holds per video (the live answers: HTTP 200, empty for the new ones). */
  const commentsHeld = (id: string): number => { const i = POOL.findIndex((v) => v.id === id); return i < 0 ? 0 : i < 5 ? NEW_COMMENTS[i] : 40; };
  const commentsOf = (id: string, limit: number) => ({ comments: Array.from({ length: Math.min(limit, commentsHeld(id)) }, (_, k) => ({ id: `${id}-c${k}`, text: `تعليق ${k}`, author: { name: `قارئ ${k}` }, created_at: "2026-10-30T20:41:00.000Z" })) });
  const MAP = "return inputs.call_0001.data.results.map(v => ({ id: v.id, text: v.caption, author: v.author, link: v.link, comments: v.comments, date: v.createdUtc }))";
  const MAP_COMMENTS = "return inputs.call_0002.comments.map(c => ({ id: c.id, text: c.text, author: c.author.name, date: c.created_at }))";
  const flow = (): FakeStep[] => [
    { tool: "catalog_search", args: { words: ["tiktok", "search", "videos"], platform: "tiktok", limit: 5 } },
    { tool: "describe_endpoint", args: { id: SEARCH } },
    { tool: "treg_call", args: { endpoint_id: SEARCH, params: { query: "منتخب مصر", sortBy: 2 }, why } },
    { tool: "describe_endpoint", args: { id: COMMENTS } },
    { tool: "treg_call", args: { endpoint_id: COMMENTS, params: { post: vid(5), limit: 10 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: MAP, files: [callIds(r)[0]] }) },
    { tool: "run_code", args: (r: Results) => ({ code: MAP_COMMENTS, files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: (r: Results) => ({
      summary_ar: "نجمع فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو عشرة تعليقات.",
      stages: [
        { key: "videos", title_ar: "فيديوهات تيك توك عن منتخب مصر", endpoint_id: SEARCH, expected_rows: 5, parent_key: null, deliver: false,
          columns: cols(["text", "وصف الفيديو"], ["author", "الناشر"], ["link", "رابط الفيديو"], ["comments", "عدد التعليقات"], ["date", "التاريخ"]),
          sample_rows: [{ id: vid(5), text: POOL[4].caption, author: POOL[4].author, link: POOL[4].link, comments: 12, date: "2026-10-30T20:40:00.000Z" }], measured_by: [callIds(r)[0]], yield_from: firstOutputId(r),
          relevance: { subject_ar: "منتخب مصر", terms: ["منتخب مصر"], text_columns: ["text"], min_own_words: 0 } },
        { key: "comments", title_ar: "تعليقات على الفيديوهات", endpoint_id: COMMENTS, expected_rows: 50, parent_key: "videos", per_parent_rows: 10, deliver: true,
          columns: cols(["text", "نص التعليق"], ["author", "المعلّق"], ["date", "تاريخ التعليق"]),
          sample_rows: [{ id: `${vid(5)}-c0`, text: "تعليق 0", author: "قارئ 0", date: "2026-10-30T20:41:00.000Z" }], measured_by: [callIds(r)[1]] },
      ],
    }) },
  ];
  const answerFor = (o: { endpointId?: string; params?: unknown }) => {
    const p = (o.params ?? {}) as Record<string, unknown>;
    if (o.endpointId === SEARCH) return tregResult(searchPage, 0.006);
    return tregResult(commentsOf(String(p.post), Number(p.limit) || 10), 0.0006);
  };
  async function run() {
    return replay({
      request: REQUEST,
      planning: flow(),
      execution: () => [],
      answers: [answerFor({ endpointId: SEARCH }), answerFor({ endpointId: COMMENTS, params: { post: vid(5), limit: 10 } }), ...Array.from({ length: 60 }, () => (o: { endpointId: string; params: unknown }) => answerFor(o))] as never,
    });
  }

  it("every video of the file has its ten comments: the three videos with none are replaced by spares, the video with one comment is kept as the source gave it", async () => {
    const r = await run();
    const snap = await readSnapshot(r.store, r.missionId);
    const videos = snap.acceptedRows("videos");
    const comments = snap.acceptedRows("comments");
    expect(videos).toHaveLength(5);
    const per = new Map<string, number>();
    for (const c of comments) per.set(String(c.parent_id), (per.get(String(c.parent_id)) ?? 0) + 1);
    // the file's videos: the two new ones that had comments, and three spares of the same search
    expect(new Set(videos.map((v) => String(v.id)))).toEqual(new Set([vid(3), vid(5), vid(6), vid(7), vid(8)]));
    expect(videos.every((v) => per.has(String(v.id)))).toBe(true);
    expect([...per.values()].sort((a, b) => a - b)).toEqual([1, 10, 10, 10, 10]);
    expect(comments).toHaveLength(41);
    // the videos left out of the file were kept, never delivered, with their reason
    expect(snap.stage("videos").items.get(vid(1))?.state).toBe("excluded");
    assertReplayInvariants(r, { expectDelivered: 46, expectStatus: "partial" });
    // nothing was bought twice for a spare: every video was read once
    const reads = (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]).filter((c) => c.endpointId === COMMENTS).map((c) => String(c.params.post));
    expect(new Set(reads.slice(1)).size).toBe(reads.slice(1).length);
  });
});

// ---------------------------------------------------------------------------------------------------- 4. People coverage and 2. provider links in the file (msn_d6437accaa7421f3f24c)
import { readWorkbook } from "./helpers/agentReplay";
import { cleanRowsForCustomer, isProviderUrl, neutralIdOf, providerContext, withoutProviderNames, withoutProviderUrls } from "../src/lib/agentMission/providerHosts";

describe("4. «عايز ٥٠ شركة مقاولات في مصر، ومن كل شركة اتنين من المديرين»: a company the people source does not know is that source's answer for it, not a failure of the stage (live: 23 of 43 companies were asked, 20 never)", () => {
  const COMPANIES = "parallel.companies.search";
  const EMPLOYEES = "aviato.companies.employees";
  const REQUEST_CO = "عايز ١٢ شركة مقاولات في مصر، ومن كل شركة اتنين من المديرين";
  const TRACXN = "https://platform.tracxn.com/a/d/company/596fa399e4b04791d175d708/albarq%20contra";
  const why = "the cheaper sources are searches by hiring or by people, not by sector and place";
  const cols = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));
  /** The companies as the live page shaped them: a name, ONE text field with the website, and a `url`: the company's LinkedIn page, or (company 8) the record page of a company-data provider. */
  const UNKNOWN_TO_PEOPLE = new Set([3, 4, 5, 6, 8]);
  const entity = (i: number) => ({ name: `Nile Construction Company ${i}`, url: i === 8 ? TRACXN : `https://linkedin.com/company/co-${i}`, description: `${i === 8 ? "" : `Website Url: https://co${i}.eg | `}Location Country: Egypt | Short Description: Provider of engineering, construction, and project management services. | Primary Sector: Construction` });
  const POOL = Array.from({ length: 12 }, (_, i) => entity(i + 1));
  const MAP_CO = "const rows = inputs.call_0001.entities || []; return rows.map(r => { const d = r.description || ''; const web = d.match(/Website Url:\\s*(https?:\\/\\/[^\\s|]+)/); const loc = (d.match(/Location Country:\\s*([^|]+)/)||[])[1] || ''; const sd = (d.match(/Short Description:\\s*([^|]+)/)||[])[1] || ''; return { id: web ? web[1].replace(/^https?:\\/\\//,'') : r.url, name: r.name, website: web ? web[1] : '', country: loc.trim(), linkedin: r.url, description: sd.trim() }; })";
  const MAP_EMP = "const rows = inputs.call_0002.employees || []; return rows.map(r => { const p = r.person || {}; const pos = (r.positionList && r.positionList[0]) || {}; return { id: r.personID, company: r.companyName || '', name: p.fullName || '', title: pos.title || '', linkedin: p.URLs && p.URLs.linkedin ? p.URLs.linkedin : '' }; })";
  const employeesOf = (site: string) => ({ employees: [0, 1].map((k) => ({ personID: `${site}-p${k}`, companyName: site, positionList: [{ title: k === 0 ? "General Manager" : "Operations Manager" }], person: { fullName: `Person ${site} ${k}`, URLs: { linkedin: `linkedin.com/in/${site}-${k}` } } })) });
  const siteIndex = (site: string): number => Number(/^co(\d+)\.eg$/.exec(site)?.[1] ?? 0);
  const answerFor = (o: { endpointId?: string; params?: unknown }) => {
    const p = (o.params ?? {}) as Record<string, unknown>;
    if (o.endpointId === COMPANIES) return tregResult({ entities: POOL.slice(0, Math.min(Number(p.match_limit) || 100, 100)) }, 0.005);
    const site = String(p.website ?? p.linkedinURL ?? "x").replace(/^.*\/company\/co-/, "co").replace(/^www\./, "").replace(/\/.*$/, "");
    if (UNKNOWN_TO_PEOPLE.has(siteIndex(site.replace(/^(co\d+)$/, "$1.eg")))) return tregResult({ error: "Not Found" }, 0, { ok: false, httpStatus: 404, error: "http_404", errorDetails: "Not Found" });
    return tregResult(employeesOf(site), 0.005);
  };
  const flow = (expected = 12, lowered = false): FakeStep[] => [
    { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
    { tool: "describe_endpoint", args: { id: COMPANIES } },
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { objective: "construction contractor companies headquartered in Egypt", entity_type: "companies", match_limit: 12 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: MAP_CO, files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: EMPLOYEES } },
    { tool: "treg_call", args: { endpoint_id: EMPLOYEES, params: { page: 1, perPage: 10, website: "co1.eg" }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: MAP_EMP, files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: (r: Results) => ({
      summary_ar: "نجمع شركات مقاولات مصرية، ومن كل شركة اثنين من مديريها.",
      stages: [
        { key: "companies", title_ar: "شركات مقاولات في مصر", endpoint_id: COMPANIES, expected_rows: expected, ...(lowered ? { target_reason_ar: "الشركات المطابقة قليلة في المصدر" } : {}), parent_key: null, deliver: true,
          columns: cols(["name", "اسم الشركة"], ["website", "الموقع الإلكتروني"], ["country", "البلد"], ["description", "نشاط الشركة"], ["linkedin", "رابط الشركة"]),
          filters: [{ kind: "place", field: "country", fields: ["country", "website"], places: ["EG"], values: ["مصر"] }],
          sample_rows: [1, 2, 7].map((n) => ({ id: `co${n}.eg`, name: POOL[n - 1].name, website: `https://co${n}.eg`, country: "Egypt", linkedin: POOL[n - 1].url, description: "Provider of engineering, construction, and project management services." })),
          measured_by: [callIds(r)[0]], yield_from: firstOutputId(r),
          relevance: { subject_ar: "شركات مقاولات وبناء مصرية", terms: ["construction company", "construction services", "engineering construction", "contracting company", "general contractor", "شركة مقاولات"], text_columns: ["name", "description"], min_own_words: 2, entity: true, review: true } },
        { key: "employees", title_ar: "مديرو كل شركة", endpoint_id: EMPLOYEES, expected_rows: expected * 2, parent_key: "companies", per_parent_rows: 2, deliver: true,
          columns: cols(["name", "اسم الموظف"], ["title", "المسمى الوظيفي"], ["company", "الشركة"], ["linkedin", "رابط الملف الشخصي"]),
          sample_rows: [{ id: "co1.eg-p0", name: "Person co1.eg 0", title: "General Manager", company: "co1.eg", linkedin: "linkedin.com/in/co1.eg-0" }], measured_by: [callIds(r)[1]] },
      ],
    }) },
  ];
  async function run(request = REQUEST_CO, expected = 12, lowered = false) {
    return replay({
      request,
      planning: flow(expected, lowered),
      execution: () => [],
      answers: [answerFor({ endpointId: COMPANIES, params: { match_limit: 12 } }), answerFor({ endpointId: EMPLOYEES, params: { website: "co1.eg" } }), ...Array.from({ length: 100 }, () => (o: { endpointId: string; params: unknown }) => answerFor(o))] as never,
    });
  }

  it("the five companies the people source does not know (four in a row) do not end the stage: every company is asked, each input once, and the people of the others are delivered", async () => {
    const r = await run();
    const snap = await readSnapshot(r.store, r.missionId);
    const execCalls = (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]).slice(2).filter((c) => c.endpointId === EMPLOYEES);
    const people = snap.acceptedRows("employees");
    const withPeople = new Set(people.map((p) => String(p.parent_id)));
    const companies = snap.acceptedRows("companies");
    expect(companies).toHaveLength(12);
    // the seven companies the source knows have their two people; the five it does not know have none and did not stop the others
    expect(withPeople.size).toBe(7);
    expect(people).toHaveLength(14);
    // every company with an input was asked, and no input was asked twice
    const inputs = execCalls.map((c) => String(c.params.website ?? c.params.linkedinURL));
    expect(new Set(inputs).size).toBe(inputs.length);
    expect(inputs).toHaveLength(15);
    // the provider's record page was never handed to the people source as the company's page
    expect(JSON.stringify(execCalls)).not.toContain("tracxn");
    assertReplayInvariants(r, { expectDelivered: 26, expectStatus: "partial" });
  });

  it("the file the customer gets holds no address and no id of the provider, and the id of the company that had one is neutral", async () => {
    const r = await run();
    const wb = await readWorkbook(r);
    let all = "";
    wb.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => { const v = cell.value; all += ` ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "")}`; })));
    expect(all.toLowerCase()).not.toContain("tracxn");
    const companiesSheet = wb.worksheets.find((s) => /مقاولات/.test(s.name))!;
    const header = (companiesSheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    const idCol = header.indexOf("المعرّف");
    const ids = companiesSheet.getColumn(idCol).values.map((v) => String(v ?? "")).slice(2);
    expect(ids.filter((v) => /^id_[0-9a-f]{14}$/.test(v))).toEqual([neutralIdOf(TRACXN)]);
    expect(ids).toContain("co1.eg");
    const csv = (await r.store.getFile(r.missionId, "result/result.csv")) ?? "";
    expect(csv.toLowerCase()).not.toContain("tracxn");
  });

  it("the rule, by code from the catalog: a provider's address goes, a platform's and the company's own stay, a record page of an unknown aggregator goes", () => {
    const ctx = providerContext();
    expect(isProviderUrl(TRACXN, ctx)).toBe(true);
    expect(isProviderUrl("https://app.tomba.io/domain-search", ctx)).toBe(true);
    expect(isProviderUrl("https://crunchbase.com/organization/acme", ctx)).toBe(true);
    for (const stays of ["https://linkedin.com/company/nasr-co", "https://www.linkedin.com/company/596fa399e4b04791d175d708x", "https://x.com/AlAhly", "https://www.facebook.com/page/posts/1", "https://www.youtube.com/watch?v=1", "https://www.tiktok.com/@a/video/1", "https://www.google.com/maps/place/x", "https://co1.eg", "https://www.ahram.org.eg/news/1"]) expect(isProviderUrl(stays, ctx)).toBe(false);
    // the company's own website is never a provider's, whatever its name
    expect(isProviderUrl("https://village.eg", ctx, new Set(["village.eg"]))).toBe(false);
    expect(withoutProviderUrls(`المصدر ${TRACXN} وصفحة https://x.com/a`, ctx)).toBe("المصدر وصفحة https://x.com/a");
    expect(withoutProviderNames("تم الجمع عبر aviato و parallel", ctx)).toBe("تم الجمع عبر و");
  });

  it("an id built from a provider's address is the same neutral id in the parent's sheet and in its children's «معرّف الأصل», so the links between sheets keep working", () => {
    const ctx = providerContext();
    const { rowsByStage, report } = cleanRowsForCustomer({ companies: [{ id: TRACXN, name: "A", linkedin: TRACXN }, { id: "b.eg", name: "B", linkedin: "https://linkedin.com/company/b" }], people: [{ id: "p1", parent_id: TRACXN, name: "P" }, { id: "p2", parent_id: "b.eg", name: "Q" }] }, ctx);
    expect(rowsByStage.companies[0]).toMatchObject({ id: neutralIdOf(TRACXN), linkedin: "" });
    expect(rowsByStage.people[0].parent_id).toBe(rowsByStage.companies[0].id);
    expect(rowsByStage.companies[1]).toMatchObject({ id: "b.eg", linkedin: "https://linkedin.com/company/b" });
    expect(rowsByStage.people[1].parent_id).toBe("b.eg");
    expect(report).toEqual({ urls: 1, ids: 2 });
  });
});

// ---------------------------------------------------------------------------------------------------- 5. The denominator is the card's total
import { cardTotalOf } from "../src/lib/agentMission/plan";

describe("5. the final line, the first sheet and the notice say «X من» the CARD's total, not the request's own number (live: «تم تسليم ٧٣ من ١٣٦» with a card of 129; «من ١٥» with a card of 11)", () => {
  const COMPANIES = "parallel.companies.search";
  const EMPLOYEES = "aviato.companies.employees";
  const why = "the cheaper sources are searches by hiring or by people, not by sector and place";
  const cols = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));
  const TARGET = 12;
  const entity = (i: number) => ({ name: `Nile Construction Company ${i}`, url: `https://linkedin.com/company/co-${i}`, description: `Website Url: https://co${i}.eg | Location Country: Egypt | Short Description: Provider of engineering, construction, and project management services. | Primary Sector: Construction` });
  const POOL = Array.from({ length: TARGET }, (_, i) => entity(i + 1));
  const MAP_CO = "const rows = inputs.call_0001.entities || []; return rows.map(r => { const d = r.description || ''; const web = d.match(/Website Url:\\s*(https?:\\/\\/[^\\s|]+)/); const sd = (d.match(/Short Description:\\s*([^|]+)/)||[])[1] || ''; return { id: web[1].replace(/^https?:\\/\\//,''), name: r.name, website: web[1], country: 'Egypt', linkedin: r.url, description: sd.trim() }; })";
  const MAP_EMP = "const rows = inputs.call_0002.employees || []; return rows.map(r => { const p = r.person || {}; const pos = (r.positionList && r.positionList[0]) || {}; return { id: r.personID, company: r.companyName || '', name: p.fullName || '', title: pos.title || '' }; })";
  const employeesOf = (site: string, n: number) => ({ employees: Array.from({ length: n }, (_, k) => ({ personID: `${site}-p${k}`, companyName: site, positionList: [{ title: "General Manager" }], person: { fullName: `Person ${site} ${k}` } })) });
  const answerFor = (o: { endpointId?: string; params?: unknown }) => {
    const p = (o.params ?? {}) as Record<string, unknown>;
    if (o.endpointId === COMPANIES) return tregResult({ entities: POOL }, 0.005);
    return tregResult(employeesOf(String(p.website ?? "x").replace(/^www\./, ""), 2), 0.005);
  };
  const flow = (): FakeStep[] => [
    { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
    { tool: "describe_endpoint", args: { id: COMPANIES } },
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { objective: "construction contractor companies headquartered in Egypt", entity_type: "companies", match_limit: 50 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: MAP_CO, files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: EMPLOYEES } },
    { tool: "treg_call", args: { endpoint_id: EMPLOYEES, params: { page: 1, perPage: 10, website: "co1.eg" }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: MAP_EMP, files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: (r: Results) => ({
      summary_ar: "نجمع شركات مقاولات مصرية، ومن كل شركة اثنين من مديريها.",
      stages: [
        { key: "companies", title_ar: "شركات مقاولات في مصر", endpoint_id: COMPANIES, expected_rows: TARGET, target_reason_ar: "الشركات المطابقة قليلة في المصدر", parent_key: null, deliver: true,
          columns: cols(["name", "اسم الشركة"], ["website", "الموقع الإلكتروني"], ["country", "البلد"], ["description", "نشاط الشركة"], ["linkedin", "رابط الشركة"]),
          filters: [{ kind: "place", field: "country", fields: ["country", "website"], places: ["EG"], values: ["مصر"] }],
          sample_rows: [1, 2, 7].map((n) => ({ id: `co${n}.eg`, name: POOL[n - 1].name, website: `https://co${n}.eg`, country: "Egypt", linkedin: POOL[n - 1].url, description: "Provider of engineering, construction, and project management services." })),
          measured_by: [callIds(r)[0]], yield_from: firstOutputId(r),
          relevance: { subject_ar: "شركات مقاولات وبناء مصرية", terms: ["construction company", "construction services", "engineering construction", "contracting company", "general contractor", "شركة مقاولات"], text_columns: ["name", "description"], min_own_words: 2, entity: true, review: true } },
        { key: "employees", title_ar: "مديرو كل شركة", endpoint_id: EMPLOYEES, expected_rows: TARGET * 2, parent_key: "companies", per_parent_rows: 2, deliver: true,
          columns: cols(["name", "اسم الموظف"], ["title", "المسمى الوظيفي"], ["company", "الشركة"]),
          sample_rows: [{ id: "co1.eg-p0", name: "Person co1.eg 0", title: "General Manager", company: "co1.eg" }], measured_by: [callIds(r)[1]] },
      ],
    }) },
  ];
  async function run() {
    return replay({
      request: "عايز ٥٠ شركة مقاولات في مصر، ومن كل شركة اتنين من المديرين",
      planning: flow(),
      execution: () => [],
      answers: [answerFor({ endpointId: COMPANIES }), answerFor({ endpointId: EMPLOYEES, params: { website: "co1.eg" } }), ...Array.from({ length: 60 }, () => (o: { endpointId: string; params: unknown }) => answerFor(o))] as never,
    });
  }

  it("a card of 36 (12 companies + 24 people) that lowered the target from 50 says «من ٣٦» in the final line, the first sheet and the notice", async () => {
    const r = await run();
    expect(cardTotalOf(r.plannedPlan)).toBe(36);
    expect(r.planView.totalRows).toBe(36);
    // the customer's final line
    const line = r.finalView.resultLinesAr.find((l) => l.startsWith("تم تسليم"))!;
    expect(line).toContain("من ٣٦");
    expect(line).not.toMatch(/من (?:٨٦|٧٤)/);
    // the first sheet of the file
    const wb = await readWorkbook(r);
    const summary = wb.worksheets[0];
    const texts: string[] = [];
    summary.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === "string") texts.push(cell.value); }));
    const intro = texts.find((t) => t.startsWith("تم تسليم"))!;
    expect(intro).toContain("من ٣٦");
    // the notice
    expect(r.notices[0].facts.planned).toBe(36);
    // the money is what it was: the charge is settled against the same total
    assertReplayInvariants(r, { expectDelivered: 36, expectStatus: "partial" });
  });
});
