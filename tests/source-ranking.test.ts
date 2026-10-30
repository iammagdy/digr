import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { rankedCandidates } from "../src/lib/agentMission/candidates";
import { classifyFailure, cheaperAlternatives, expectedCost, SOURCE_DEMOTE_FACTOR, SOURCE_HEALTH_WINDOW_MS, rankEndpoints, sourceHealth, statsFromCalls, type RecordedCallFact } from "../src/lib/agentMission/sourceRanking";
import { expectedStageCount } from "../src/lib/agentMission/budget";
import { loadSourceHealth } from "../src/lib/agentMission/adminActions";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { COMMENTS_ENDPOINT, NOT_ADMIN, POSTS_ENDPOINT, USER_ID, fakeRecorder, postsPage, commentsPage, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";

/**
 * CHEAPEST SOURCE FIRST, BY CODE, with the health of the sources read from the recorded calls (the live run of 2026-10-29: Facebook spent its planning budget on one source; companies tried ten sources and settled on the one
 * at 0.0098 USD per company while the catalog ranked four of them 40 times cheaper). Nothing here names a provider as a rule: the same code ranks and demotes every source.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const catalog: any = loadTregCatalog();
const access: any = { isAdmin: false, verifiedBusiness: false };
const NOW = Date.parse("2026-10-29T10:30:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const call = (endpoint_id: string, status: string, minutesAgo: number, o: Partial<RecordedCallFact> = {}): RecordedCallFact => ({ endpoint_id, status, created_at: iso(minutesAgo), rows_returned: 0, cost_usd: 0, ...o });

// ------------------------------------------------------------------------------------------------------------------ the ranking, from the catalog and from measurements
describe("the ranking is by expected cost per delivered item, from the catalog and from what the missions recorded", () => {
  const SCENARIOS: Array<{ name: string; words: string[]; platform?: string; capability: RegExp }> = [
    { name: "Facebook post comments", words: ["facebook", "post", "comments"], platform: "facebook", capability: /facebook\.post\.comments/ },
    { name: "companies by sector and country", words: ["companies", "construction", "egypt"], capability: /^companies\./ },
    { name: "TikTok comments", words: ["tiktok", "video", "comments"], platform: "tiktok", capability: /tiktok\.video\.comments/ },
    { name: "X topic posts", words: ["tweets", "search"], platform: "x", capability: /x\.search\.posts/ },
    { name: "Google Maps reviews", words: ["google", "maps", "reviews"], capability: /google\.maps\.(contributor_)?reviews/ },
    { name: "YouTube comments", words: ["youtube", "video", "comments"], platform: "youtube", capability: /youtube\.video\.comments/ },
  ];

  it.each(SCENARIOS)("$name: the candidates are the sources of that job, sorted by effective cost, cheapest first, deterministic", ({ words, platform, capability }) => {
    const a = rankedCandidates({ catalog, access, words, platform, stats: new Map(), now: NOW });
    const b = rankedCandidates({ catalog, access, words, platform, stats: new Map(), now: NOW });
    expect(a.ranked.length).toBeGreaterThan(2);
    const costs = a.ranked.map((r) => r.effectiveUsd);
    expect([...costs].sort((x, y) => x - y)).toEqual(costs);
    expect(a.ranked.map((r) => r.id)).toEqual(b.ranked.map((r) => r.id));
    // the job: the leading candidates are sources of the capability the words name, not another job that mentions the platform
    expect(a.ranked.slice(0, 3).every((r) => capability.test(String(r.capability)))).toBe(true);
    for (const r of a.ranked) { expect(r.usdPerItem).toBeGreaterThan(0); expect(r.successRate).toBeGreaterThanOrEqual(0.1); expect(r.successRate).toBeLessThanOrEqual(1); }
  });

  it("companies: the source the live planning settled on (0.0098 USD per company) ranks far below the cheaper sources of the same job", () => {
    const r = rankedCandidates({ catalog, access, words: ["companies", "construction", "egypt"], stats: new Map(), now: NOW });
    const at = (id: string) => r.ranked.findIndex((x) => x.id === id);
    const company = r.ranked.find((x) => x.id === "companyenrich.companies.search")!;
    expect(company.usdPerItem).toBeCloseTo(0.0098, 4);
    expect(at("icypeas.companies.search")).toBeGreaterThanOrEqual(0);
    expect(at("icypeas.companies.search")).toBeLessThan(at("companyenrich.companies.search"));
    expect(r.ranked[0].usdPerItem * 20).toBeLessThan(company.usdPerItem);
  });

  it("a measurement replaces the catalog's guess: rows per call really returned and what the calls really cost (the live Facebook search: 5 posts a call at 0.0295)", () => {
    const e = catalog.byId.get("justoneapi.x.facebook-search-post-v1");
    const catalogOnly = expectedCost(e, catalog, undefined);
    const stats = statsFromCalls([1, 2, 3].map((n) => call(e.id, "ok", n * 10, { rows_returned: 5, cost_usd: 0.02952 })));
    const measured = expectedCost(e, catalog, stats.get(e.id));
    expect(measured.basis).toBe("measured");
    expect(measured.rowsPerCall).toBe(5);
    expect(measured.usdPerItem!).toBeCloseTo(0.0059, 3);
    expect(measured.usdPerItem!).toBeGreaterThan(catalogOnly.usdPerItem! * 0.9);
  });

  it("a few measured rows do not decide alone: one expensive row is blended with the catalog's price", () => {
    const e = catalog.byId.get("anyapi.x.search.posts");
    const base = expectedCost(e, catalog, undefined).usdPerItem!;
    const stats = statsFromCalls([call(e.id, "ok", 5, { rows_returned: 1, cost_usd: 0.5 })]);
    const blended = expectedCost(e, catalog, stats.get(e.id)).usdPerItem!;
    expect(blended).toBeGreaterThan(base);
    expect(blended).toBeLessThan(0.5);
  });

  it("the chance that a call gives rows moves the ranking: a source that mostly returns nothing costs more per delivered item", () => {
    const e = catalog.byId.get("anyapi.x.search.posts");
    const good = statsFromCalls(Array.from({ length: 10 }, (_, i) => call(e.id, "ok", i + 1, { rows_returned: 20, cost_usd: 0.00075 })));
    const empty = statsFromCalls(Array.from({ length: 10 }, (_, i) => call(e.id, "empty", i + 1)));
    const a = rankEndpoints([e], catalog, good, NOW).ranked[0];
    const b = rankEndpoints([e], catalog, empty, NOW).ranked[0];
    expect(b.successRate).toBeLessThan(a.successRate);
    expect(b.effectiveUsd).toBeGreaterThan(a.effectiveUsd * 2);
  });

  it("recorded data reorders the real catalog: the source measured cheap leads, the source measured dear drops", () => {
    const ids = ["anyapi.x.search.posts", "crawl4ai.x.search.posts", "treg.x.search.posts"];
    const before = rankEndpoints(ids.map((i) => catalog.byId.get(i)), catalog, new Map(), NOW).ranked.map((r) => r.id);
    const stats = statsFromCalls([
      ...Array.from({ length: 5 }, (_, i) => call(before[0], "ok", i + 1, { rows_returned: 2, cost_usd: 0.05 })),
      ...Array.from({ length: 5 }, (_, i) => call(before[2], "ok", i + 1, { rows_returned: 50, cost_usd: 0.00001 })),
    ]);
    const after = rankEndpoints(ids.map((i) => catalog.byId.get(i)), catalog, stats, NOW).ranked.map((r) => r.id);
    // the source measured cheap moves up (it was last), the one measured dear drops to the bottom
    expect(after.indexOf(before[2])).toBeLessThan(before.indexOf(before[2]));
    expect(after[after.length - 1]).toBe(before[0]);
  });

  it("an endpoint with no usable price is not offered", () => {
    const e = { ...catalog.byId.get("anyapi.x.search.posts"), id: "nobody.free.thing", cost: null };
    expect(rankEndpoints([e], catalog, new Map(), NOW).ranked).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ the health of a source, from recorded calls
describe("source health: demoted or skipped for a time window after recorded failures, with no rule about any provider", () => {
  it("what a failed call says about its SOURCE: configuration, input/validation, or nothing", () => {
    expect(classifyFailure({ status: "refused", refused_reason: "source_unavailable:anyone" })).toBe("config");
    expect(classifyFailure({ status: "refused", refused_reason: "needs_login:x" })).toBe("config");
    expect(classifyFailure({ status: "refused", refused_reason: "missing_params:size" })).toBe("validation");
    expect(classifyFailure({ status: "failed", http_status: 400 })).toBe("validation");
    expect(classifyFailure({ status: "failed", http_status: 422, params_digest: { _failure: 'The value "x" is not a valid industry.' } })).toBe("validation");
    expect(classifyFailure({ status: "failed", http_status: 404 })).toBe("validation");
    expect(classifyFailure({ status: "failed", http_status: 401 })).toBe("config");
    // the mission's own limits and the provider's weather say nothing about the source
    for (const r of ["over_budget:planning", "daily_cap:x", "repeat_sample:planning", "choose_cheapest:x", "stage_reserved:planning"]) expect(classifyFailure({ status: "refused", refused_reason: r }), r).toBe("none");
    expect(classifyFailure({ status: "failed", http_status: 402, params_digest: { _failure: '{"error":"route_max_cost"}' } })).toBe("none");
    expect(classifyFailure({ status: "failed", http_status: 503 })).toBe("transient");
    expect(classifyFailure({ status: "failed", http_status: 0 })).toBe("transient");
    expect(classifyFailure({ status: "ok" })).toBe("none");
  });

  it.each([["alpha.companies.search"], ["zeta.x.search.posts"], ["wiza.companies.search"]])("%s: one input failure demotes, three skip, a configuration failure skips at once; one rule for every provider", (id) => {
    const h = (calls: RecordedCallFact[]) => sourceHealth(statsFromCalls(calls).get(id), NOW);
    expect(h([call(id, "ok", 300, { rows_returned: 5 })])).toMatchObject({ state: "ok" });
    expect(h([call(id, "failed", 30, { http_status: 400 })])).toMatchObject({ state: "demoted", reason: "validation", failures: 1 });
    expect(h([call(id, "failed", 30, { http_status: 400 }), call(id, "failed", 20, { http_status: 422 })])).toMatchObject({ state: "demoted", failures: 2 });
    expect(h([30, 20, 10].map((m) => call(id, "failed", m, { http_status: 400 })))).toMatchObject({ state: "skipped", reason: "validation", failures: 3 });
    expect(h([call(id, "refused", 10, { refused_reason: "source_unavailable:x" })])).toMatchObject({ state: "skipped", reason: "config" });
    // the time window: the same failures a day later no longer count; `until` says when it is tried again
    const old = call(id, "failed", SOURCE_HEALTH_WINDOW_MS / 60_000 + 5, { http_status: 400 });
    expect(h([old])).toMatchObject({ state: "ok" });
    const recent = h([call(id, "refused", 60, { refused_reason: "source_unavailable:x" })]);
    expect(recent.until).toBe(NOW - 60 * 60_000 + SOURCE_HEALTH_WINDOW_MS);
    // a call that gives rows again ends the penalty
    expect(h([call(id, "failed", 50, { http_status: 400 }), call(id, "failed", 40, { http_status: 400 }), call(id, "failed", 30, { http_status: 400 }), call(id, "ok", 10, { rows_returned: 3 })])).toMatchObject({ state: "ok" });
    // a failure after the success counts again
    expect(h([call(id, "ok", 40, { rows_returned: 3 }), call(id, "failed", 10, { http_status: 400 })])).toMatchObject({ state: "demoted" });
    // transient failures and the mission's own limits never count
    expect(h([call(id, "failed", 10, { http_status: 503 }), call(id, "refused", 9, { refused_reason: "over_budget:planning" })])).toMatchObject({ state: "ok" });
  });

  it("the live recorded calls of 2026-10-29: the sources that failed on their inputs or configuration drop out, the ones that worked lead", () => {
    const stats = statsFromCalls([
      call("wiza.companies.search", "failed", 30, { http_status: 400, params_digest: { _failure: "The size parameter is not allowed." } }),
      call("wiza.companies.search", "refused", 29, { refused_reason: "missing_params:size" }),
      call("quickenrich.companies.search", "failed", 28, { http_status: 422 }),
      call("quickenrich.companies.search", "failed", 27, { http_status: 422 }),
      call("contextdev.parse.google-maps", "refused", 31, { refused_reason: "source_unavailable:contextdev" }),
      call("aviato.companies.search", "failed", 600, { http_status: 400 }), call("aviato.companies.search", "ok", 590, { rows_returned: 10, cost_usd: 0.0025 }),
    ]);
    expect(sourceHealth(stats.get("wiza.companies.search"), NOW).state).toBe("demoted");
    expect(sourceHealth(stats.get("quickenrich.companies.search"), NOW).state).toBe("demoted");
    expect(sourceHealth(stats.get("contextdev.parse.google-maps"), NOW).state).toBe("skipped");
    expect(sourceHealth(stats.get("aviato.companies.search"), NOW).state).toBe("ok");
    const r = rankedCandidates({ catalog, access, words: ["companies", "search"], stats, now: NOW });
    const pos = (id: string) => r.ranked.findIndex((x) => x.id === id);
    expect(r.ranked[pos("aviato.companies.search")].basis).toBe("measured");
    expect(r.ranked[pos("aviato.companies.search")].usdPerItem).toBeLessThan(0.0005);
    expect(r.ranked.find((x) => x.id === "wiza.companies.search")?.health.state).toBe("demoted");
    expect(r.ranked.find((x) => x.id === "wiza.companies.search")!.effectiveUsd).toBeCloseTo((r.ranked.find((x) => x.id === "wiza.companies.search")!.usdPerItem / r.ranked.find((x) => x.id === "wiza.companies.search")!.successRate) * SOURCE_DEMOTE_FACTOR, 8);
  });

  it("a skipped source is not offered and is listed apart; a demoted one sits below a pricier healthy one", () => {
    const [cheap, mid] = ["crawl4ai.tiktok.video.comments", "tikhub.x.tiktok-app-v3-fetch-video-comments"].map((i) => catalog.byId.get(i));
    const stats = statsFromCalls([call(cheap.id, "refused", 10, { refused_reason: "source_unavailable:x" })]);
    const r = rankEndpoints([cheap, mid], catalog, stats, NOW);
    expect(r.ranked.map((x) => x.id)).toEqual([mid.id]);
    expect(r.skipped.map((x) => x.id)).toEqual([cheap.id]);
    const demoted = rankEndpoints([cheap, mid], catalog, statsFromCalls([call(cheap.id, "failed", 10, { http_status: 400 }), call(cheap.id, "failed", 9, { http_status: 400 })]), NOW);
    expect(demoted.ranked[0].id).toBe(mid.id);
    expect(demoted.ranked[1].health.state).toBe("demoted");
  });

  it("the admin sees the list: state, reason, failures, when it is tried again, and the measured cost per row", async () => {
    const rows: RecordedCallFact[] = [call("x.one", "refused", 10, { refused_reason: "source_unavailable:x" }), call("x.two", "failed", 10, { http_status: 400 }), call("x.three", "ok", 10, { rows_returned: 10, cost_usd: 0.01 })];
    const client: any = { from: () => ({ select: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) }) };
    const r = await loadSourceHealth(client, NOW);
    expect(r.ok).toBe(true);
    expect(r.sources.map((s) => [s.id, s.state, s.reason])).toEqual([["x.one", "skipped", "config"], ["x.two", "demoted", "validation"], ["x.three", "ok", null]]);
    expect(r.sources[0].until).toBe(new Date(NOW - 10 * 60_000 + SOURCE_HEALTH_WINDOW_MS).toISOString());
    expect(r.sources[2].usdPerRow).toBe(0.001);
  });
});

// ------------------------------------------------------------------------------------------------------------------ the planner cannot pick a pricier source without a reason
const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };
function setup(responses: TregCallResult[], priorCalls: RecordedCallFact[] = []) {
  const store = createMemoryStore();
  for (const c of priorCalls) void store.addCall({ id: `old:${Math.random()}`, mission_id: "msn_old", phase: "planning", endpoint_id: c.endpoint_id, params_digest: c.params_digest ?? {}, status: c.status as any, refused_reason: c.refused_reason ?? null, http_status: c.http_status ?? null, rows_returned: c.rows_returned ?? null, cost_usd: Number(c.cost_usd ?? 0), estimate_usd: 0, provider_cost_id: null, storage_path: null, duration_ms: null, created_at: c.created_at } as any);
  const money = fakeMoneyClient();
  const queue = [...responses];
  const callFn = vi.fn(async (o: TregCallOptions) => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n; });
  const rec = fakeRecorder();
  const deps = (driver: ReturnType<typeof createFakeDriver>): RunnerDeps => ({ store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: callFn, models: MODELS, resolveAccess: async () => NOT_ADMIN });
  return { store, callFn, deps };
}
const plan = async (steps: FakeStep[], answers: TregCallResult[], request = "هات منشورات عن القهوة", prior: RecordedCallFact[] = []) => {
  const t = setup(answers, prior);
  t.store.missions.set("msn_x", newMission({ id: "msn_x", user_id: USER_ID, status: "planning", request_text: request }));
  const driver = createFakeDriver([...steps, { tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لا أستطيع خدمة هذا الطلب بدقة." } }]);
  await runPlanning(t.deps(driver), t.store.missions.get("msn_x")!);
  return { ...t, driver, results: driver.results.filter((r) => r.tool === "treg_call").map((r) => r.result as Record<string, any>) };
};
const xPage = tregResult({ output: { data: { items: Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, text: `تغريدة ${i}`, url: `https://x.example/${i}`, author: "a", createdAt: "2026-10-20T10:00:00Z" })), nextCursor: null } } }, 0.00075);

describe("the planner cannot pick a pricier source without a reason", () => {
  // the recorded calls of this block are dated against NOW and the planner reads the real clock for the 24-hour health window: with the real clock the block passed only on the day it was written
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }); });
  afterEach(() => { vi.useRealTimers(); });
  const PRICIER = "x.x.search-posts-all";
  const cheaper = () => cheaperAlternatives(PRICIER, catalog, new Map(), Date.now(), () => true).map((r) => r.id);

  it("with no search at all, a pricier source of the same job is refused (nothing is sent), and the refusal names the cheaper ones with their price", async () => {
    const r = await plan([{ tool: "treg_call", args: { endpoint_id: PRICIER, params: { query: "قهوة", max_results: 5 } } }], []);
    expect(r.results[0]).toMatchObject({ ok: false, refused: "choose_cheapest" });
    expect(r.results[0].message).toContain("do the same job");
    for (const id of cheaper()) expect(r.results[0].message).toContain(id);
    expect(r.callFn).not.toHaveBeenCalled();
  });

  it("it may skip them on purpose with a recorded reason per source: the call goes through and the admin's trace holds each reason", async () => {
    const skip = Object.fromEntries(cheaper().map((id) => [id, "wrong_data"]));
    expect(Object.keys(skip).length).toBeGreaterThan(0);
    const r = await plan([{ tool: "treg_call", args: { endpoint_id: PRICIER, params: { query: "قهوة", max_results: 5 }, skip } }], [tregResult(postsPage(5), 0.025)]);
    expect(r.results[0].ok).toBe(true);
    const logged = (await r.store.listCalls("msn_x"))[0];
    for (const id of cheaper()) expect(String(logged.params_digest._why)).toContain(`skip ${id}=wrong_data`);
  });

  it("a stated reason for the choice as a whole (eight characters) is accepted and recorded, a reason too short is not", async () => {
    const r = await plan([
      { tool: "treg_call", args: { endpoint_id: PRICIER, params: { query: "قهوة", max_results: 5 }, why: "no" } },
      { tool: "treg_call", args: { endpoint_id: PRICIER, params: { query: "قهوة", max_results: 5 }, why: "the cheaper ones return no author" } },
    ], [tregResult(postsPage(5), 0.025)]);
    expect(r.results[0]).toMatchObject({ refused: "choose_cheapest" });
    expect(r.results[1].ok).toBe(true);
    expect((await r.store.listCalls("msn_x"))[0].params_digest._why).toBe("the cheaper ones return no author");
  });

  it("once the cheaper sources were tried (even if they failed) the dearer one needs no reason", async () => {
    const tried = cheaper();
    const required = (id: string, word = "قهوة") => Object.fromEntries(catalog.byId.get(id).inputs.filter((i: any) => i.required).map((i: any) => [i.name, i.type === "number" || i.type === "integer" ? 5 : word]));
    // ONE empty answer is no verdict on a source far cheaper than the dearer one (fix mission 10): each cheaper source is asked with two different inputs, and then the dearer one needs no reason
    const steps: FakeStep[] = tried.flatMap((id) => ["قهوة", "شاي"].map((word): FakeStep => ({ tool: "treg_call", args: { endpoint_id: id, params: { ...required(id, word), limit: 5 } } })));
    const r = await plan([...steps, { tool: "treg_call", args: { endpoint_id: PRICIER, params: { query: "قهوة", max_results: 5 } } }], [...tried.flatMap(() => [0, 1].map(() => tregResult({ output: { data: { items: [], nextCursor: null } } }, 0))), tregResult(postsPage(5), 0.025)]);
    expect(r.results[r.results.length - 1].refused).toBeUndefined();
  });

  it("a cheaper source that is skipped for its health is not asked about: the dearer one goes through with no reason", async () => {
    const prior = cheaper().map((id) => call(id, "refused", 30, { refused_reason: "source_unavailable:x" }));
    const r = await plan([{ tool: "treg_call", args: { endpoint_id: PRICIER, params: { query: "قهوة", max_results: 5 } } }], [tregResult(postsPage(5), 0.025)], "هات منشورات عن القهوة", prior);
    expect(r.results[0].ok).toBe(true);
  });

  it("a source skipped for its health is refused during planning (the next one of the ranking is taken), and costs nothing", async () => {
    const prior = [call("anyapi.x.search.posts", "refused", 30, { refused_reason: "source_unavailable:x" })];
    const r = await plan([{ tool: "treg_call", args: { endpoint_id: "anyapi.x.search.posts", params: { query: "قهوة", limit: 5 } } }], [], "هات منشورات عن القهوة", prior);
    expect(r.results[0]).toMatchObject({ ok: false, refused: "source_unhealthy" });
    expect(r.callFn).not.toHaveBeenCalled();
  });

  it("catalog_search hands the planner the ranked list: cheapest first by code, with the expected cost per item, the sources skipped for health named apart, and the ranking kept for the check", async () => {
    const prior = [call("crawl4ai.x.search.posts", "refused", 30, { refused_reason: "source_unavailable:x" })];
    const t = setup([], prior);
    t.store.missions.set("msn_x", newMission({ id: "msn_x", user_id: USER_ID, status: "planning", request_text: "هات منشورات عن القهوة" }));
    const driver = createFakeDriver([{ tool: "catalog_search", args: { words: ["tweets", "search"], platform: "x", limit: 6 } }, { tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لا أستطيع خدمة هذا الطلب بدقة." } }]);
    await runPlanning(t.deps(driver), t.store.missions.get("msn_x")!);
    const found: any = driver.results[0].result;
    const ids: string[] = found.hits.map((h: any) => h.id);
    expect(found.hits.map((h: any) => h.rank)).toEqual(ids.map((_, i) => i + 1));
    const costs: number[] = found.hits.map((h: any) => h.costPerRecordUsd ?? Infinity);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
    expect(found.hits[0].expected_usd_per_item).toBeGreaterThan(0);
    expect(ids).not.toContain("crawl4ai.x.search.posts");
    expect(found.skipped_for_health).toContain("crawl4ai.x.search.posts");
  });
});

// ------------------------------------------------------------------------------------------------------------------ the planning budget is split among the stages
describe("the planning budget leaves room for every stage", () => {
  it("a parent and its children expect two samples, a single-stage request one", () => {
    expect(expectedStageCount("هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات")).toBe(2);
    expect(expectedStageCount("عايز ١٠ شركات مقاولات في مصر وموظفين كل شركة")).toBe(2);
    expect(expectedStageCount("هات ٥٠ تغريدة عن منتخب مصر")).toBe(1);
  });

  const ask = (endpoint: string, params: Record<string, unknown>): FakeStep => ({ tool: "treg_call", args: { endpoint_id: endpoint, params, why: "the fixture source is the one under test" } });
  const REQUEST = "أريد منشورات عن القهوة مع تعليقاتها";

  it("the first job cannot spend the budget kept for the next stage's first sample; the next stage's first sample always fits", async () => {
    // POSTS: 0.025 an estimate each; the multi-stage budget is 0.10 and 30% is kept for the stage not yet sampled: two calls (0.05) fit, the third (0.075 > 0.07) does not
    const r = await plan([
      ask(POSTS_ENDPOINT, { query: "a", max_results: 5 }), ask(POSTS_ENDPOINT, { query: "b", max_results: 5 }), ask(POSTS_ENDPOINT, { query: "c", max_results: 5 }),
      ask(COMMENTS_ENDPOINT, { url: "https://x.example/p/9000" }),
    ], [tregResult(postsPage(5), 0.025), tregResult(postsPage(5), 0.025), tregResult(commentsPage("9000", 12), 0.00144)], REQUEST);
    expect(r.results.map((x) => x.ok === true ? "ok" : x.refused)).toEqual(["ok", "ok", "stage_reserved", "ok"]);
    expect(r.callFn).toHaveBeenCalledTimes(3);
  });

  it("a request with one stage keeps the whole budget for it (no reserve)", async () => {
    // 0.05 single-stage budget: the second call of 0.025 fits (0.05), nothing is kept back
    const r = await plan([ask(POSTS_ENDPOINT, { query: "a", max_results: 5 }), ask(POSTS_ENDPOINT, { query: "b", max_results: 5 })], [tregResult(postsPage(5), 0.025), tregResult(postsPage(5), 0.025)], "هات منشورات عن القهوة");
    expect(r.results.map((x) => x.ok === true ? "ok" : x.refused)).toEqual(["ok", "ok"]);
  });

  it("the planning's own budget still ends it honestly: refusals for the stage reserve are not our failure, a budget refusal is", async () => {
    const r = await plan([ask(POSTS_ENDPOINT, { query: "a", max_results: 25 })], [], REQUEST);
    expect(r.store.missions.get("msn_x")!.status).toBe("failed");
    expect(String(r.store.missions.get("msn_x")!.error)).toContain("planning_over_budget");
  });
});
