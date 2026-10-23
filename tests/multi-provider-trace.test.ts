import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: null as any, adminClient: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.adminClient),
}));

import { GET as traceGet } from "../src/app/api/admin/job-trace/route";
import { runChainChunk, type ChainDeps } from "../src/lib/server/multiProvider/chainRunner";
import { createFakeFetch, createFakeRobotsFetch, defaultFakeWorld, type FakeCompany, type FakeScenario } from "../src/lib/server/multiProvider/fakeTransport";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "../src/lib/server/tregAdapter";
import { appendChunkTrace, readRoutingTrace, writeRoutingDecision } from "../src/lib/server/multiProvider/traceStore";
import { maybeUpgradeToChainPlan, chainItemFor, detectContactIntent } from "../src/lib/server/multiProvider/planUpgrade";
import { loadRouterState, resolveChainItemRouting, setRouteChooserForTesting, setRouterStateForTesting } from "../src/lib/server/multiProvider/planRouting";
import { contextDevCheck } from "../src/lib/server/providerStatus";
import { defaultRouterState, type ProviderState } from "../src/lib/multiProvider/router";
import { CHAIN_CAPABILITY_SLUG, routeCodeOf } from "../src/lib/multiProvider/routes";
import { ChunkTraceCollector, decisionPath, mergeChunkTrace, summarizeTrace, tracePath, type ChunkTrace, type RoutingTrace } from "../src/lib/multiProvider/trace";
import { previewWorldActive } from "../src/lib/multiProvider/previewWorld";
import { PLAN_LIMITS_AR } from "../src/lib/multiProvider/copy";
import { createMemoryRecorder } from "./helpers/multiProviderFakes";

const ADMIN = { id: "admin-1", email: "a@t", app_metadata: { role: "admin" }, user_metadata: { name: "مدير" } };

// ---- a fake private bucket -----------------------------------------------------------------------------------------------------
function fakeStorageClient() {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const client: any = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: Buffer) => { calls.push(`upload:${bucket}:${path}`); files.set(`${bucket}/${path}`, body.toString("utf-8")); return { error: null }; },
        download: async (path: string) => { calls.push(`download:${bucket}:${path}`); const v = files.get(`${bucket}/${path}`); return v === undefined ? { data: null, error: { message: "not found" } } : { data: { text: async () => v }, error: null }; },
      }),
    },
  };
  return { client, files, calls };
}

// ---- chain harness (same shape as the chain tests) ------------------------------------------------------------------------------
function harness(world: FakeCompany[], scenario: FakeScenario = {}) {
  const events: string[] = [];
  const traces: ChunkTrace[] = [];
  const fetch = createFakeFetch(world, scenario);
  const rec = createMemoryRecorder({ treg: 1, firecrawl: 5, contextdev: 5 });
  const deps: ChainDeps = {
    providerKeys: { treg: "managed", firecrawl: "fc-test-key-123456", contextdev: "cx-test-key-123456" },
    fetchFn: fetch,
    recorder: rec.recorder,
    robotsFetch: createFakeRobotsFetch(world),
    spentUsdSoFar: async () => rec.spent(),
    emit: async (line) => { events.push(line); },
    trace: async (chunk) => { traces.push(chunk); },
    tregFn: async (): Promise<ProviderAdapterCallOutput> => ({ ok: true, httpStatus: 200, rows: world.slice(0, 10).map((c) => ({ company_name: c.name, website: `https://${c.domain}` })), nextCursor: null, costUsd: 0.00576, costMicro: 5760, tregCallId: "t" }),
  };
  return { deps, events, traces, fetch, rec };
}
const input = (params: Record<string, any>, over: Partial<ProviderAdapterCallInput> = {}): ProviderAdapterCallInput => ({
  jobId: "job_trace_1", userId: "u1", step: 0, endpointId: "mp", capabilitySlug: CHAIN_CAPABILITY_SLUG, method: "POST", params, paginationStrategy: "cursor",
  cursor: null, pageSize: 10, remainingNeeded: params.count, targetVolumeMax: params.count, deliveredSoFar: 0, deadlineMs: Date.now() + 45_000,
  unitPricePoints: (1 * 5500) / (1.15 * params.count), ...over,
});
const params = (over: Record<string, any> = {}) => ({ routeCode: routeCodeOf("chain:contextdev>firecrawl"), industry: "contracting", keyword: "contracting", country: "Egypt", countryIso: "EG", industryAr: "مقاولات", countryAr: "مصر", requiredFields: ["work_email"], count: 3, ...over });

async function runAll(h: ReturnType<typeof harness>, p: Record<string, any>, maxChunks = 10) {
  const rows: Record<string, any>[] = [];
  let cursor: string | null = null;
  for (let step = 0; step < maxChunks; step += 1) {
    const out: ProviderAdapterCallOutput = await runChainChunk(input(p, { cursor, step, remainingNeeded: Math.max(0, p.count - rows.length), deliveredSoFar: rows.length }), h.deps);
    rows.push(...out.rows);
    if (!out.ok || !out.nextCursor) break;
    cursor = out.nextCursor;
  }
  return rows;
}

describe("routing trace: what each stage did, per chunk, collected by the chain", () => {
  it("per-stage calls, cost, found / new / duplicate and verified counts equal the recorded call rows", async () => {
    const h = harness(defaultFakeWorld(12));
    const rows = await runAll(h, params({ count: 3 }));
    expect(rows.length).toBe(3);
    const trace: RoutingTrace = h.traces.reduce((t, c) => mergeChunkTrace(t, c), { v: 1, jobId: "job_trace_1", decision: null, chunks: [] } as RoutingTrace);
    const summary = summarizeTrace(trace);

    const discover = summary.stages.find((s) => s.stage === "discover")!;
    expect(discover.capabilityId).toBe("contextdev.search");
    expect(discover.provider).toBe("contextdev");
    expect(discover.calls).toBe(h.rec.rows.filter((r) => r.capabilityId === "contextdev.search").length);
    expect(discover.found).toBeGreaterThanOrEqual(discover.fresh);
    expect(discover.found - discover.fresh).toBeGreaterThanOrEqual(discover.duplicate);

    for (const stage of summary.stages.filter((s) => s.capabilityId)) {
      const recorded = h.rec.rows.filter((r) => r.capabilityId === stage.capabilityId);
      expect(stage.calls).toBe(recorded.length);
      expect(stage.costUsd).toBeCloseTo(recorded.reduce((a, r) => a + r.costUsd, 0), 8);
      expect(stage.success + stage.failed + stage.empty).toBe(stage.calls);
    }
    const verify = summary.stages.find((s) => s.stage === "verify")!;
    // rows that pass the gate in a chunk can exceed what is still needed: only the needed ones are delivered (and charged)
    expect(verify.verified).toBeGreaterThanOrEqual(rows.length);
    expect(summary.delivered).toBe(rows.length);
    expect(summary.totalCalls).toBe(h.rec.rows.length);
    // the job total equals the provider spend recorded for the job
    expect(summary.totalCostUsd).toBeCloseTo(h.rec.spent(), 6);
    expect(summary.stoppedBy).toBe("target_reached");
  });

  it("a reading stage that fails records the fallback to the other provider's reader (stage fallback)", async () => {
    const h = harness(defaultFakeWorld(10), { failProvider: { firecrawl: 500 } });
    const rows = await runAll(h, params({ count: 2 }));
    expect(rows.length).toBe(2);
    const summary = summarizeTrace(h.traces.reduce((t, c) => mergeChunkTrace(t, c), { v: 1, jobId: "j", decision: null, chunks: [] } as RoutingTrace));
    expect(summary.fallbacks.some((f) => f.stage === "enrich" && f.fromCapabilityId === "firecrawl.scrape" && f.toCapabilityId === "contextdev.scrape")).toBe(true);
    expect(summary.stages.find((s) => s.capabilityId === "firecrawl.scrape")!.failed).toBeGreaterThan(0);
    expect(summary.stages.find((s) => s.capabilityId === "contextdev.scrape")!.success).toBeGreaterThan(0);
  });

  it("zero result: every stage is traced, nothing is verified, and the job ends with no cursor (full release by the worker)", async () => {
    const world = defaultFakeWorld(6).map((c) => ({ ...c, email: undefined, phone: undefined }));
    const h = harness(world);
    const rows = await runAll(h, params({ count: 3 }));
    expect(rows).toEqual([]);
    const summary = summarizeTrace(h.traces.reduce((t, c) => mergeChunkTrace(t, c), { v: 1, jobId: "j", decision: null, chunks: [] } as RoutingTrace));
    expect(summary.delivered).toBe(0);
    expect(summary.stages.find((s) => s.stage === "verify")!.verified).toBe(0);
    expect(summary.stages.find((s) => s.stage === "verify")!.unverified).toBeGreaterThan(0);
    expect(summary.stoppedBy).toBe("no_more_work");
  });

  it("a decision-maker-only request needs no contact page: one plain read plus the team page, no email is required", async () => {
    const world = defaultFakeWorld(6).map((c) => ({ ...c, email: undefined, phone: undefined, leaders: [{ name: "Mona Samir", title: "Managing Director" }] }));
    const h = harness(world);
    const rows = await runAll(h, params({ requiredFields: ["decision_maker"], count: 2 }));
    expect(rows.length).toBe(2);
    expect(rows[0].contact_name).toBe("Mona Samir");
    expect(rows[0].job_title).toBe("Managing Director");
    expect(rows[0].contact_verification_status).toBeTruthy();
    // no contact page (/contact) was ever read for a people-only request
    expect(h.fetch.log.some((l) => /scrape/.test(l.operation) && /\/contact/.test(l.url))).toBe(false);
    expect(h.rec.rows.some((r) => /scrape_json/.test(r.capabilityId))).toBe(true);
  });

  it("a decision maker is NOT delivered when the page names nobody: unverified fields are neither delivered nor charged", async () => {
    const world = defaultFakeWorld(5).map((c) => ({ ...c, leaders: [] as Array<{ name: string; title: string }> }));
    const h = harness(world);
    const rows = await runAll(h, params({ requiredFields: ["decision_maker"], count: 2 }));
    expect(rows).toEqual([]);
  });

  it("trace collector rounds cost and keeps stages apart by capability", () => {
    const c = new ChunkTraceCollector(3, 0.01);
    c.call("enrich", "firecrawl", "firecrawl.scrape", { status: "success", costUsd: 0.005, durationMs: 100 });
    c.call("enrich", "firecrawl", "firecrawl.scrape", { status: "failed", costUsd: 0, durationMs: 50 });
    c.call("enrich", "contextdev", "contextdev.scrape", { status: "success", costUsd: 0.00254, durationMs: 80 });
    const chunk = c.finish({ at: "2026-01-01T00:00:00.000Z", delivered: 0, costUsd: 0.00754, stoppedBy: null });
    expect(chunk.stages).toHaveLength(2);
    expect(chunk.stages.find((s) => s.capabilityId === "firecrawl.scrape")).toMatchObject({ calls: 2, success: 1, failed: 1, costUsd: 0.005, durationMs: 150 });
    expect(chunk.step).toBe(3);
    expect(chunk.spentBeforeUsd).toBe(0.01);
  });

  it("merging the same step twice replaces it, so a retried chunk is never counted twice", () => {
    const mk = (cost: number): ChunkTrace => ({ step: 2, at: "t", stages: [], fallbacks: [], delivered: 1, spentBeforeUsd: 0, costUsd: cost, stoppedBy: null });
    let t: RoutingTrace = { v: 1, jobId: "j", decision: null, chunks: [] };
    t = mergeChunkTrace(t, mk(0.01));
    t = mergeChunkTrace(t, { ...mk(0.02), step: 1 });
    t = mergeChunkTrace(t, mk(0.03));
    expect(t.chunks.map((c) => [c.step, c.costUsd])).toEqual([[1, 0.02], [2, 0.03]]);
  });
});

describe("routing trace storage: private bucket only, never job_events or the quote", () => {
  it("the decision is written at the quote and seeds the job's trace at its first chunk", async () => {
    const { client, files, calls } = fakeStorageClient();
    const decision: any = { at: "t", routeId: "chain:contextdev>firecrawl", routeCode: "x", source: "model", reason: "better for local sites", modelCalled: true, request: { count: 3, requiredFields: ["work_email"] }, count: 3, unitPricePoints: 30, reservePoints: 104, budgetUsd: 0.1, stages: [], allowed: [], excluded: [] };
    expect(await writeRoutingDecision(client, "quote_1", decision)).toBe(true);
    expect(files.has(`partials/${decisionPath("quote_1")}`)).toBe(true);
    const chunk: ChunkTrace = { step: 0, at: "t", stages: [], fallbacks: [], delivered: 2, spentBeforeUsd: 0, costUsd: 0.02, stoppedBy: null };
    expect(await appendChunkTrace(client, { jobId: "job_a", quoteId: "quote_1", chunk })).toBe(true);
    await appendChunkTrace(client, { jobId: "job_a", quoteId: "quote_1", chunk: { ...chunk, step: 1, delivered: 1 } });
    await appendChunkTrace(client, { jobId: "job_a", quoteId: "quote_1", chunk }); // a retry of step 0
    const trace = await readRoutingTrace(client, "job_a");
    expect(trace?.decision?.routeId).toBe("chain:contextdev>firecrawl");
    expect(trace?.decision?.reason).toBe("better for local sites");
    expect(trace?.chunks.map((c) => c.step)).toEqual([0, 1]);
    expect(files.has(`partials/${tracePath("job_a")}`)).toBe(true);
    // only the private bucket is ever touched
    expect(calls.every((c) => c.includes(":partials:"))).toBe(true);
  });

  it("a storage failure never throws into a job or a quote", async () => {
    const broken: any = { storage: { from: () => ({ upload: async () => { throw new Error("down"); }, download: async () => { throw new Error("down"); } }) } };
    expect(await writeRoutingDecision(broken, "q", {} as any)).toBe(false);
    expect(await appendChunkTrace(broken, { jobId: "j", chunk: { step: 0, at: "t", stages: [], fallbacks: [], delivered: 0, spentBeforeUsd: 0, costUsd: 0, stoppedBy: null } })).toBe(false);
    expect(await readRoutingTrace(broken, "j")).toBeNull();
    expect(await writeRoutingDecision({}, "q", {} as any)).toBe(false);
  });

  it("the customer activity lines carry none of the trace: no provider names, USD, capability ids or counts of calls", async () => {
    const h = harness(defaultFakeWorld(8));
    await runAll(h, params({ count: 3 }));
    const text = h.events.join("\n");
    expect(text).not.toMatch(/firecrawl|context\.?dev|treg|usd|\$|دولار|mp\.|scrape|search/i);
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(h.traces.length).toBeGreaterThan(0);
  });
});

describe("admin-only trace route", () => {
  beforeEach(() => { state.user = null; state.adminClient = null; });

  it("401 without a session, 403 for a customer, 400 for a bad id, and the trace + summary for an admin", async () => {
    const { client } = fakeStorageClient();
    state.adminClient = client;
    const chunk: ChunkTrace = { step: 0, at: "t", stages: [{ stage: "discover", provider: "contextdev", capabilityId: "contextdev.search", calls: 1, success: 1, failed: 0, empty: 0, costUsd: 0.0025, durationMs: 10, found: 5, fresh: 5, duplicate: 0, read: 0, skipped: 0, verified: 0, unverified: 0 }], fallbacks: [], delivered: 0, spentBeforeUsd: 0, costUsd: 0.0025, stoppedBy: null };
    await appendChunkTrace(client, { jobId: "job_route_1", chunk });
    const get = (id: string) => traceGet(new NextRequest(`http://localhost/api/admin/job-trace?jobId=${id}`));

    expect((await get("job_route_1")).status).toBe(401);
    state.user = { id: "u1", email: "c@t", app_metadata: {}, user_metadata: {} };
    expect((await get("job_route_1")).status).toBe(403);
    state.user = ADMIN;
    expect((await get("../etc")).status).toBe(400);
    const ok = await get("job_route_1");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.trace.chunks).toHaveLength(1);
    expect(body.summary.totalCalls).toBe(1);
    const none = await (await get("job_unknown_9")).json();
    expect(none.trace).toBeNull();
  });
});

// ---- plan time: the upgrade is code-decided and falls back to the original plan --------------------------------------------------
const ready = (): ProviderState => ({ enabled: true, keyPresent: true, healthOk: true, dailyCapUsd: 1, spentTodayUsd: 0 });
const readyState = () => defaultRouterState(true, { treg: ready(), firecrawl: ready(), contextdev: ready() });
const companyItem = (over: Record<string, any> = {}) => ({ capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", params: {} as Record<string, any>, targetVolumeMin: 1, targetVolumeMax: 5, paginationStrategy: "cursor" as const, stepId: "s1", ...over });
const REQUEST = "عايز ٥ شركات مقاولات في مصر مع الإيميل ورقم التليفون";

describe("plan time: staged chain for a contact request, TREG plan otherwise", () => {
  afterEach(() => { vi.unstubAllEnvs(); setRouterStateForTesting(null); setRouteChooserForTesting(undefined); });

  it("contact intent is read from the customer's words by code", () => {
    expect(detectContactIntent(REQUEST)).toMatchObject({ email: true, phone: true, decisionMaker: false });
    expect(detectContactIntent("هات لي صناع القرار من صفحات الفريق على مواقع الشركات")).toMatchObject({ decisionMaker: true, teamPagesNamed: true });
    expect(detectContactIntent("عايز ٥ شركات مقاولات في مصر")).toMatchObject({ email: false, phone: false, decisionMaker: false });
  });

  it("flag OFF: the plan comes back untouched and the router is never read", async () => {
    vi.stubEnv("MULTI_PROVIDER_ENABLED", "");
    setRouterStateForTesting(readyState()); // would allow a route if it were consulted
    const items = [companyItem()];
    const out = await maybeUpgradeToChainPlan({ client: {}, items, requestText: REQUEST, summaryAr: "ملخص", methodologyNotes: "ملاحظات" });
    expect(out.upgraded).toBe(false);
    expect(out.items).toBe(items);
    expect(out.summaryAr).toBe("ملخص");
    expect(out.methodologyNotes).toBe("ملاحظات");
  });

  it("flag ON, companies + email/phone, route allowed: the chain item with normalized fields, a plain-Arabic summary and the honest limits", async () => {
    vi.stubEnv("MULTI_PROVIDER_ENABLED", "true");
    setRouterStateForTesting(readyState());
    const out = await maybeUpgradeToChainPlan({ client: {}, items: [companyItem()], requestText: REQUEST, summaryAr: "ملخص", methodologyNotes: "ملاحظات" });
    expect(out.upgraded).toBe(true);
    const item = out.items[0];
    expect(item.capabilitySlug).toBe(CHAIN_CAPABILITY_SLUG);
    expect(item.targetVolumeMax).toBe(5);
    expect(item.params.requiredFields).toEqual(["work_email", "office_phone"]);
    expect(item.params.country).toBe("Egypt");
    expect(item.params.countryIso).toBe("EG");
    expect(item.params.routeCode).toBeUndefined(); // the router sets the opaque route code at the quote
    expect(out.summaryAr).toMatch(/مصادر متاحة/);
    expect(out.summaryAr).toMatch(/[٠-٩]/);
    expect(out.summaryAr).not.toMatch(/[A-Za-z0-9]/);
    expect(out.methodologyNotes).toBe(PLAN_LIMITS_AR.join(" "));
    expect(out.methodologyNotes).toMatch(/لا نجمع عناوين المنازل/);
  });

  it("no allowed route (provider has no cap): the ORIGINAL plan is kept — the fallback to the existing directory", async () => {
    vi.stubEnv("MULTI_PROVIDER_ENABLED", "true");
    const none = (): ProviderState => ({ ...ready(), dailyCapUsd: 0 });
    setRouterStateForTesting(defaultRouterState(true, { treg: none(), firecrawl: none(), contextdev: none() }));
    const items = [companyItem()];
    const out = await maybeUpgradeToChainPlan({ client: {}, items, requestText: REQUEST, summaryAr: "ملخص", methodologyNotes: "ملاحظات" });
    expect(out.upgraded).toBe(false);
    expect(out.items).toBe(items);
  });

  it("a plain company list (no contact words), a missing country or activity, or a people plan without team pages are not upgraded", () => {
    expect(chainItemFor([companyItem()], "عايز ٥ شركات مقاولات في مصر")).toBeNull();
    expect(chainItemFor([companyItem()], "عايز ٥ شركات مع الإيميل")).toBeNull();
    expect(chainItemFor([companyItem({ capabilitySlug: "professional-people-search" })], "هات لي صناع القرار في شركات مقاولات في مصر")).toBeNull();
    expect(chainItemFor([companyItem(), companyItem()], REQUEST)).toBeNull();
    expect(chainItemFor([companyItem({ capabilitySlug: "tiktok-profile" })], REQUEST)).toBeNull();
  });

  it("decision makers from public team pages become a decision_maker chain item", () => {
    const out = chainItemFor([companyItem({ capabilitySlug: "professional-people-search" })], "هات لي ٣ من صناع القرار من صفحات الفريق على مواقع شركات مقاولات في مصر");
    expect(out?.requiredFields).toEqual(["decision_maker"]);
    expect(out?.item.targetVolumeMax).toBe(5);
  });

  it("the quote-time decision names who chose and why, and the excluded routes; the model is consulted once at most", async () => {
    vi.stubEnv("MULTI_PROVIDER_ENABLED", "true");
    const state = readyState();
    state.providers.firecrawl = { ...ready(), keyPresent: false };
    setRouterStateForTesting(state);
    let calls = 0;
    setRouteChooserForTesting(async ({ options }) => { calls += 1; return { routeId: options[options.length - 1].routeId, reason: "الأنسب لمواقع الشركات المحلية" }; });
    const routed = await resolveChainItemRouting({ client: {}, params: { industry: "contracting", country: "Egypt", requiredFields: ["work_email"] }, volume: 5 });
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(calls).toBeLessThanOrEqual(1);
    expect(routed.decision.routeId).toBe(routed.routeId);
    expect(routed.decision.routeCode).toBe(routed.routeCode);
    expect(["model", "cheapest_allowed", "only_option"]).toContain(routed.decision.source);
    expect(routed.decision.stages.length).toBeGreaterThanOrEqual(2);
    for (const s of routed.decision.stages) { expect(s.maxCalls).toBeGreaterThanOrEqual(0); expect(s.unitPricePoints).toBeGreaterThanOrEqual(0); }
    expect(routed.decision.excluded.some((e) => e.reason === "key_missing" && e.provider === "firecrawl")).toBe(true);
    // the decision's price is the same shared-rule price the quote uses
    expect(routed.decision.unitPricePoints).toBe(routed.unitPricePoints);
    expect(routed.decision.reservePoints).toBe(routed.reservePoints);
  });

  it("the model failing or answering an invalid route means code picks the cheapest allowed route, recorded in the decision", async () => {
    vi.stubEnv("MULTI_PROVIDER_ENABLED", "true");
    setRouterStateForTesting(readyState());
    setRouteChooserForTesting(async () => { throw new Error("model down"); });
    const failed = await resolveChainItemRouting({ client: {}, params: { industry: "contracting", country: "Egypt", requiredFields: ["work_email"] }, volume: 5 });
    expect(failed.ok && failed.decision.source).toBe("cheapest_allowed");
    expect(failed.ok && failed.decision.fallbackReason).toBe("model_failed");
    setRouteChooserForTesting(async () => ({ routeId: "chain:made-up", reason: "x" }));
    const invalid = await resolveChainItemRouting({ client: {}, params: { industry: "contracting", country: "Egypt", requiredFields: ["work_email"] }, volume: 5 });
    expect(invalid.ok && invalid.decision.fallbackReason).toBe("invalid_choice");
  });
});

describe("Context.dev key without the usage scope, and the preview fake world switch", () => {
  const health = (httpStatus: number) => ({ ok: false, reason: "auth_rejected" as const, httpStatus, statusClass: "4xx" as const, latencyMs: 5, checkedAt: "t" });

  it("a 403 that names the missing permission is a healthy key with no balance; any other 403/401 stays rejected", () => {
    const scope = contextDevCheck({ health: health(403), body: { error: "forbidden", required_permission: "logs:read" } });
    expect(scope.health.ok).toBe(true);
    expect(scope.health.reason).toBe("missing_scope");
    expect(contextDevCheck({ health: health(403), body: { error: "forbidden" } }).health.reason).toBe("auth_rejected");
    expect(contextDevCheck({ health: health(401), body: { required_permission: "logs:read" } }).health.reason).toBe("auth_rejected");
  });

  it("the preview world needs the flag, a preview deployment and a non-live database; a live deployment can never satisfy it", () => {
    const on = { PRESSURE_FAKE_PROVIDER: "on", VERCEL_ENV: "preview", NEXT_PUBLIC_SUPABASE_URL: "https://testdb.supabase.co" };
    expect(previewWorldActive(on)).toBe(true);
    expect(previewWorldActive({})).toBe(false);
    expect(previewWorldActive({ ...on, PRESSURE_FAKE_PROVIDER: "true" })).toBe(false);
    expect(previewWorldActive({ ...on, VERCEL_ENV: "production" })).toBe(false);
    expect(previewWorldActive({ ...on, NEXT_PUBLIC_SUPABASE_URL: "https://pfinlfaqwnytesedchik.supabase.co" })).toBe(false);
  });
});

describe("flag ON in a preview with the fake world: the router sees ready providers within a small limit; never on a live deployment", () => {
  afterEach(() => { vi.unstubAllEnvs(); setRouterStateForTesting(null); });

  it("preview world: every provider is ready with the small limit, so a contact plan routes with no real key", async () => {
    vi.stubEnv("MULTI_PROVIDER_ENABLED", "true");
    vi.stubEnv("PRESSURE_FAKE_PROVIDER", "on");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://testdb.supabase.co");
    const state = await loadRouterState({});
    expect(state.flagOn).toBe(true);
    for (const id of ["treg", "firecrawl", "contextdev"] as const) expect(state.providers[id]).toMatchObject({ enabled: true, keyPresent: true, healthOk: true, dailyCapUsd: 1, spentTodayUsd: 0 });
    const out = await maybeUpgradeToChainPlan({ client: {}, items: [companyItem()], requestText: REQUEST, summaryAr: "ملخص", methodologyNotes: undefined });
    expect(out.upgraded).toBe(true);
  });

  it("without the preview world the router state comes from the real system: no key, no health, no cap means nothing is allowed", async () => {
    vi.stubEnv("MULTI_PROVIDER_ENABLED", "true");
    vi.stubEnv("PRESSURE_FAKE_PROVIDER", "");
    vi.stubEnv("VERCEL_ENV", "production");
    const emptyClient: any = { from: () => { const b: any = { select: () => b, eq: () => b, in: () => b, gte: () => b, lt: () => b, maybeSingle: async () => ({ data: null, error: null }), then: (r: any) => Promise.resolve({ data: [], error: null }).then(r) }; return b; }, rpc: async () => ({ data: null, error: null }) };
    const state = await loadRouterState(emptyClient);
    expect(state.providers.firecrawl.dailyCapUsd).toBe(0);
    expect(state.providers.contextdev.keyPresent).toBe(false);
  });
});
