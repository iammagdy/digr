import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createMemoryDb } from "./helpers/memoryDb";
import { propose, sample, say, search, stubGateway, type GatewayStub } from "./helpers/plannerKit";

const state = vi.hoisted(() => ({ admin: true as boolean, client: null as any, transport: null as any }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin ? { ok: true, ctx: { adminId: "adm-1", audit: vi.fn(async () => undefined) } } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/modelPlanner/transport", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/modelPlanner/transport")>()), createAnthropicTransport: () => state.transport }));

import { SELF_TEST_CASES, SELF_TEST_RUN_CAP_USD, gradeCase, runSelfTestCase, selfTestCsv } from "../src/lib/modelPlanner/selfTest";
import { createScriptedTransport } from "../src/lib/modelPlanner/transport";
import { readPlannerHealth } from "../src/lib/modelPlanner/health";
import { runModelPlannerTurn } from "../src/lib/modelPlanner/chatTurn";
import { PLAN_UNAVAILABLE_AR } from "../src/lib/modelPlanner/planner";
import { PLANNER_EVENT_ROW_ENDPOINT, PLANNER_TURN_ROW_ENDPOINT, resetExplorationMemoryForTesting } from "../src/lib/modelPlanner/exploration";
import { reserveForUnits } from "../src/lib/recordPricing";
import { SENSITIVE_NOT_VERIFIED_AR } from "../src/lib/treg/dataPolicy";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { getProviderStatus, invalidateProviderStatusCache, STATUS_FAILURE_TTL_MS } from "../src/lib/server/providerStatus";
import { readFileSync } from "node:fs";

const catalog = loadTregCatalog();
let gateway: GatewayStub | null = null;

beforeEach(() => {
  process.env.TREG_TOKEN = "test-token";
  state.admin = true;
  state.client = createMemoryDb();
  resetExplorationMemoryForTesting();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { gateway?.restore(); gateway = null; vi.restoreAllMocks(); });

const caseOf = (id: string) => SELF_TEST_CASES.find((c) => c.id === id)!;
const natgeoScript = () => [
  search("instagram", ["user", "profile"]),
  sample("crawl4ai.instagram.user.profile", [{ name: "username", value: "natgeo", source: "customer_text", quote: "@natgeo" }]),
  propose({ summaryAr: "بيانات حساب انستقرام natgeo", steps: [{ endpointId: "crawl4ai.instagram.user.profile", volume: 1, params: [{ name: "username", value: "natgeo", source: "customer_text", quote: "@natgeo" }], fieldMap: { columns: [{ field: "username", headerAr: "اسم المستخدم", role: "author_handle" }, { field: "followers", headerAr: "المتابعون", role: "followers", transform: "number" }], pagination: { kind: "single" } }, filters: [] }] }),
];
const profileBody = { username: "natgeo", full_name: "National Geographic", followers: 268273892, is_verified: true };

describe("the 30 requests of «فحص المخطط»", () => {
  it("are fixed: 20 Phase 0 phrasings and 10 production requests, unique ids, each with an expected outcome stored with it, and the owner's wordings are in the list", () => {
    expect(SELF_TEST_CASES).toHaveLength(30);
    expect(new Set(SELF_TEST_CASES.map((c) => c.id)).size).toBe(30);
    expect(SELF_TEST_CASES.filter((c) => c.group === "phase0")).toHaveLength(20);
    expect(SELF_TEST_CASES.filter((c) => c.group === "production")).toHaveLength(10);
    for (const c of SELF_TEST_CASES) { expect(c.expect.length, c.id).toBeGreaterThan(0); expect(c.request.length, c.id).toBeGreaterThan(1); }
    const requests = SELF_TEST_CASES.map((c) => c.request);
    for (const wanted of ["هات ١٠ بوستات من حساب @elonmusk على أكس", "هات ٣٠ تعليق تيك توك عن كرة السلة في مصر", "عايز ٥ شركات كهرباء في مصر", "هات ٢٠ مراجعة على جوجل ماب لمطعم أبو طارق في القاهرة", "عايز ٥ شركات صواريخ في ليختنشتاين", "هات بيانات حساب انستقرام @natgeo", "ابغى بيانات انستقرام لحساب فلان"]) expect(requests, wanted).toContain(wanted);
    expect(requests.some((r) => r.includes("فيسبوك") && r.includes("٥ تعليقات"))).toBe(true);
    expect(requests.some((r) => r.includes("مين صاحب الرقم"))).toBe(true);
    expect(SELF_TEST_RUN_CAP_USD).toBe(0.30);
  });
});

describe("one request through the REAL planner path, stopping before any quote", () => {
  it("runs the planner and reports what was understood, the endpoint and its attempts, the parameters with their source, the window, the sample rows, the unit price and the hold, the turns, the tokens and both costs; PASS against the stored expectation", async () => {
    gateway = stubGateway({ "crawl4ai.instagram.user.profile": profileBody }, { "crawl4ai.instagram.user.profile": 900 });
    const out = await runSelfTestCase({ test: caseOf("N7"), transport: createScriptedTransport(natgeoScript() as any), client: state.client, adminId: "adm-1", runId: "t1", spentUsd: 0 });
    if (out.stopped) throw new Error("stopped");
    const row = out.row;
    expect(row).toMatchObject({ id: "N7", outcome: "plan", pass: true, reason: "", endpoints: ["crawl4ai.instagram.user.profile"], window: "none", sampleRows: 1, unitPricePoints: 4.95, turns: 3 });
    expect(row.holdPoints).toBe(reserveForUnits(1, 4.95));
    expect(row.params).toEqual([{ step: 1, name: "username", value: "natgeo", source: "customer_text", quote: "@natgeo" }]);
    expect(row.alternativesTried).toEqual([expect.objectContaining({ endpoint: "crawl4ai.instagram.user.profile", outcome: "ok", httpStatus: 200, costUsd: 0.0009 })]);
    expect(row.providerUsd).toBeCloseTo(0.0009, 9);
    expect(row.modelUsd).toBeGreaterThan(0);
    expect(row.tokensIn).toBeGreaterThan(0);
    expect(row.stopReasons).toEqual(["tool_use", "tool_use", "tool_use"]);
    expect(row.trace.length).toBe(3);
    expect(out.spentUsd).toBeCloseTo(row.modelUsd + row.providerUsd, 9);
  });

  it("NOTHING of a customer is written: the only table touched is the exploration bookkeeping, no quote, no job, no hold, no ledger, no storage upload", async () => {
    gateway = stubGateway({ "crawl4ai.instagram.user.profile": profileBody }, { "crawl4ai.instagram.user.profile": 900 });
    const touched: string[] = [];
    const db = createMemoryDb();
    const spying = { from: (t: string) => { touched.push(t); return db.from(t); }, storage: db.storage };
    await runSelfTestCase({ test: caseOf("N7"), transport: createScriptedTransport(natgeoScript() as any), client: spying, adminId: "adm-1", runId: "t2", spentUsd: 0 });
    expect(new Set(touched)).toEqual(new Set(["exploration_calls"]));
    expect([...db.tables.keys()]).toEqual(["exploration_calls"]);
    expect(db.uploads).toHaveLength(0);
    expect(db.rows("exploration_calls")[0]).toMatchObject({ request_id: "selftest_t2_N7", user_id: "adm-1", endpoint_id: "crawl4ai.instagram.user.profile" });
  });

  it("is graded FAIL with the reason when the outcome is not the expected one, and when a lookup of one thing is given a topic review", async () => {
    const refusal = await runSelfTestCase({ test: caseOf("N7"), transport: createScriptedTransport([[say("هذه الخدمة غير متاحة حاليًا")]] as any), client: state.client, adminId: "adm-1", runId: "t3", spentUsd: 0 });
    if (refusal.stopped) throw new Error("stopped");
    expect(refusal.row).toMatchObject({ outcome: "refusal", pass: false });
    expect(refusal.row.reason).toMatch(/expected plan, got refusal/);
    const asked = await runSelfTestCase({ test: caseOf("N9"), transport: createScriptedTransport([[say("أي حساب انستقرام تقصد؟")]] as any), client: state.client, adminId: "adm-1", runId: "t4", spentUsd: 0 });
    if (asked.stopped) throw new Error("stopped");
    expect(asked.row).toMatchObject({ outcome: "question", pass: true });
    // the restricted sentence for a customer who is not a verified business
    const restricted = await runSelfTestCase({ test: caseOf("N8"), transport: createScriptedTransport([search("people", ["phone", "reverse"]), [say(SENSITIVE_NOT_VERIFIED_AR)]] as any), client: state.client, adminId: "adm-1", runId: "t5", spentUsd: 0 });
    if (restricted.stopped) throw new Error("stopped");
    expect(["restricted", "refusal", "question"]).toContain(restricted.row.outcome);
    expect(gradeCase(caseOf("N7"), { kind: "message", reason: "unavailable", messageAr: "x" } as any, "refusal", []).pass).toBe(false);
  });

  it("the run's cost cap is enforced before each request: at the cap nothing is run and no model call is made", async () => {
    const transport = createScriptedTransport(natgeoScript() as any);
    const stopped = await runSelfTestCase({ test: caseOf("N7"), transport, client: state.client, adminId: "adm-1", runId: "t6", spentUsd: 0.295 });
    expect(stopped).toEqual({ stopped: "cap", spentUsd: 0.295, capUsd: 0.3 });
    expect(transport.requests).toHaveLength(0);
    // under the cap the sample calls of the request share what is left: a request never spends more than the run has
    gateway = stubGateway({ "crawl4ai.instagram.user.profile": profileBody }, { "crawl4ai.instagram.user.profile": 900 });
    const tight = await runSelfTestCase({ test: caseOf("N7"), transport: createScriptedTransport(natgeoScript() as any), client: state.client, adminId: "adm-1", runId: "t7", spentUsd: 0.285 });
    if (tight.stopped) throw new Error("stopped");
    expect(tight.row.providerUsd).toBeLessThanOrEqual(SELF_TEST_RUN_CAP_USD - 0.285);
  });

  it("the table exports as CSV (BOM, one line per request, quotes escaped)", async () => {
    gateway = stubGateway({ "crawl4ai.instagram.user.profile": profileBody }, { "crawl4ai.instagram.user.profile": 900 });
    const out = await runSelfTestCase({ test: caseOf("N7"), transport: createScriptedTransport(natgeoScript() as any), client: state.client, adminId: "adm-1", runId: "t8", spentUsd: 0 });
    if (out.stopped) throw new Error("stopped");
    const csv = selfTestCsv([out.row, { ...out.row, id: "X", request: 'say "hi"' }]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.trim().split("\n")).toHaveLength(3);
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain("PASS");
  });
});

describe("the admin route: admin only, one request per call, the health line", () => {
  const get = () => import("../src/app/api/admin/planner-selftest/route").then((m) => m.GET(new NextRequest("http://127.0.0.1:3000/api/admin/planner-selftest")));
  const post = (body: unknown) => import("../src/app/api/admin/planner-selftest/route").then((m) => m.POST(new NextRequest("http://127.0.0.1:3000/api/admin/planner-selftest", { method: "POST", body: JSON.stringify(body) })));

  it("a non-admin gets 403 and nothing runs; bad input gets 400", async () => {
    state.admin = false;
    state.transport = createScriptedTransport(natgeoScript() as any);
    expect((await get()).status).toBe(403);
    expect((await post({ caseId: "N7", runId: "r", spentUsd: 0 })).status).toBe(403);
    expect(state.transport.requests).toHaveLength(0);
    state.admin = true;
    expect((await post({ caseId: "nope", runId: "r", spentUsd: 0 })).status).toBe(400);
    expect((await post({ caseId: "N7", runId: "r", spentUsd: -1 })).status).toBe(400);
    expect((await post({ caseId: "N7", spentUsd: 0 })).status).toBe(400);
  });

  it("GET lists the 30 requests with their expectations, the cap and the health line (the catalog the bundle loaded, the last planner error, the last exploration)", async () => {
    state.client.seed("exploration_calls", [
      { id: "a", request_id: "r1", endpoint_id: "tikhub.tiktok.search.videos", cost_usd: 0.001, http_status: 200, rows_returned: 12, created_at: "2026-10-27T17:51:53Z", refused_reason: null },
      { id: "b", request_id: "r2", endpoint_id: PLANNER_TURN_ROW_ENDPOINT, cost_usd: 0, created_at: "2026-10-27T17:52:14Z", refused_reason: "no_model: no time left for another model turn (4 s left of the turn)" },
    ]);
    const body = await (await get()).json();
    expect(body.cases).toHaveLength(30);
    expect(body.cases[0]).toMatchObject({ id: "P1", expected: expect.any(String) });
    expect(body.capUsd).toBe(0.3);
    expect(body.health.catalog.endpoints).toBe(catalog.endpoints.length);
    expect(body.health.lastPlannerError).toEqual({ at: "2026-10-27T17:52:14Z", reason: expect.stringContaining("no time left") });
    expect(body.health.lastExploration).toMatchObject({ endpoint: "tikhub.tiktok.search.videos", result: "ok", httpStatus: 200, rows: 12 });
  });

  it("POST runs one request with the real transport (replaced here by a recorded one), returns the row and the running total", async () => {
    gateway = stubGateway({ "crawl4ai.instagram.user.profile": profileBody }, { "crawl4ai.instagram.user.profile": 900 });
    state.transport = createScriptedTransport(natgeoScript() as any);
    const res = await post({ caseId: "N7", runId: "run1", spentUsd: 0.01 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.row).toMatchObject({ id: "N7", pass: true, outcome: "plan" });
    expect(body.spentUsd).toBeGreaterThan(0.01);
    expect(body.capUsd).toBe(0.3);
    expect(readFileSync("src/app/admin/planner-selftest/page.tsx", "utf-8")).toContain("selftest-csv");
  });

  it("the health line never throws: without the table it still reports the catalog", async () => {
    const h = await readPlannerHealth(createMemoryDb({ missing: ["exploration_calls"] }));
    expect(h.catalog).toMatchObject({ endpoints: catalog.endpoints.length });
    expect(h.lastPlannerError).toBeNull();
    expect(h.lastExploration).toBeNull();
  });
});

describe("a chat turn that ends without a plan records why (the health line reads it); a plan and a question record nothing", () => {
  const turn = (script: any[], message: string, db = createMemoryDb()) => runModelPlannerTurn({ config: { transport: createScriptedTransport(script) as any, client: db, catalog }, tables: db, userId: "u1", conversationId: "c1", userBalance: 100, message, messagesContext: [], requestId: "req_turn" }).then((t) => ({ t, db }));

  it("a refusal leaves one row with the reason, the planner's end reason and the validation codes; the customer reads the one sentence", async () => {
    const { t, db } = await turn([[say("غير متاح حاليًا")]], "هات بيانات حساب انستقرام @natgeo");
    expect(t).toMatchObject({ kind: "message", reason: "unavailable", contentAr: PLAN_UNAVAILABLE_AR });
    // Phase 3: the planner's own step log (the panel's planning steps) is written beside the turn row; it is not an error or an exploration call
    const rows = db.rows("exploration_calls").filter((r: any) => r.endpoint_id !== PLANNER_EVENT_ROW_ENDPOINT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint_id: PLANNER_TURN_ROW_ENDPOINT, request_id: "req_turn", user_id: "u1", cost_usd: 0 });
    expect(rows[0].refused_reason).toMatch(/^unavailable: /);
    const health = await readPlannerHealth(db);
    expect(health.lastPlannerError?.reason).toContain("unavailable");
    expect(health.lastExploration).toBeNull(); // the turn row is not an exploration call
  });

  it("a question is not an error: nothing is recorded", async () => {
    const { t, db } = await turn([[say("أي حساب انستقرام تقصد؟")]], "ابغى بيانات انستقرام لحساب فلان");
    expect(t).toMatchObject({ kind: "message", reason: "clarification" });
    expect(db.rows("exploration_calls").filter((r: any) => r.endpoint_id !== PLANNER_EVENT_ROW_ENDPOINT)).toHaveLength(0);
  });
});

describe("the admin sidebar reads the same live check as the TREG tab, and one failed check is not remembered for a minute", () => {
  beforeEach(() => invalidateProviderStatusCache());
  const ok = () => new Response(JSON.stringify({ org_id: "o1", balance_micro: 8_160_000 }), { status: 200 });

  it("a timeout or a network blip is tried once more (the same check the tab runs); a rejected key is not", async () => {
    let n = 0;
    const flaky = vi.fn(async () => { n += 1; if (n === 1) throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); return ok(); });
    const status = await getProviderStatus("treg", "tok-1234567890", { forceRefresh: true, fetchFn: flaky as any });
    expect(status.health).toMatchObject({ ok: true, httpStatus: 200 });
    expect(flaky.mock.calls.length).toBeGreaterThanOrEqual(2);
    const rejected = vi.fn(async () => new Response("{}", { status: 401 }));
    const bad = await getProviderStatus("treg", "tok-1234567890", { forceRefresh: true, fetchFn: rejected as any });
    expect(bad.health).toMatchObject({ ok: false, reason: "auth_rejected" });
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("a FAILED check is cached only a few seconds, a good one for a minute, so the next poll re-checks", async () => {
    let t = 1_000_000;
    const now = () => t;
    const down = vi.fn(async () => { throw Object.assign(new Error("net"), { name: "TypeError" }); });
    const first = await getProviderStatus("treg", "tok-1234567890", { fetchFn: down as any, now });
    expect(first.health.ok).toBe(false);
    const callsAfterFirst = down.mock.calls.length;
    t += STATUS_FAILURE_TTL_MS - 1;
    await getProviderStatus("treg", "tok-1234567890", { fetchFn: down as any, now });
    expect(down.mock.calls.length).toBe(callsAfterFirst); // still the cached failure
    t += 2;
    const up = vi.fn(async () => ok());
    const again = await getProviderStatus("treg", "tok-1234567890", { fetchFn: up as any, now });
    expect(again.health.ok).toBe(true);
    t += 30_000;
    await getProviderStatus("treg", "tok-1234567890", { fetchFn: down as any, now });
    expect(down.mock.calls.length).toBe(callsAfterFirst); // a good result is kept for the minute
  });

  it("the sidebar fetch asks the route for a fresh check, and the route passes it on", () => {
    expect(readFileSync("src/components/admin/AdminShell.tsx", "utf-8")).toContain('"/api/admin/providers?refresh=true"');
    expect(readFileSync("src/app/api/admin/providers/route.ts", "utf-8")).toContain('searchParams.get("refresh") === "true"');
  });
});

describe("Phase 4: choose what to run, see the cost first, M1 to M4 and the price ranges", () => {
  it("M1 to M4 are fixed and marked as missions; the 34 cases have unique ids; the base 30 are unchanged", async () => {
    const { MISSION_SELF_TEST_CASES, ALL_SELF_TEST_CASES } = await import("../src/lib/modelPlanner/selfTest");
    expect(MISSION_SELF_TEST_CASES.map((c) => c.id)).toEqual(["M1", "M2", "M3", "M4"]);
    expect(MISSION_SELF_TEST_CASES.every((c) => c.group === "mission")).toBe(true);
    expect(ALL_SELF_TEST_CASES).toHaveLength(34);
    expect(new Set(ALL_SELF_TEST_CASES.map((c) => c.id)).size).toBe(34);
    expect(SELF_TEST_CASES).toHaveLength(30);
    expect(MISSION_SELF_TEST_CASES.filter((c) => (c.minSteps ?? 1) >= 2).map((c) => c.id)).toEqual(["M1", "M2", "M4"]);
  });

  it("the estimate is shown per case and for any selection, before running: questions and refusals cost the model only, plans add their samples, missions sample every stage", async () => {
    const { estimateCaseCostUsd, estimateRunCostUsd, ALL_SELF_TEST_CASES } = await import("../src/lib/modelPlanner/selfTest");
    expect(estimateCaseCostUsd({ expect: ["question"], group: "phase0" })).toBe(0.004);
    expect(estimateCaseCostUsd({ expect: ["plan"], group: "phase0" })).toBe(0.012);
    expect(estimateCaseCostUsd({ expect: ["plan"], group: "mission", minSteps: 2 })).toBe(0.03);
    expect(estimateRunCostUsd([])).toBe(0);
    expect(estimateRunCostUsd(ALL_SELF_TEST_CASES.filter((c) => c.group === "mission"))).toBeCloseTo(0.12, 9);
    expect(estimateRunCostUsd(SELF_TEST_CASES)).toBeLessThanOrEqual(SELF_TEST_RUN_CAP_USD + 0.2);
  });

  it("a plan outside its expected price range is graded FAIL with both figures; inside it passes; fewer stages than expected fails", async () => {
    const { ALL_SELF_TEST_CASES } = await import("../src/lib/modelPlanner/selfTest");
    const m3 = ALL_SELF_TEST_CASES.find((c) => c.id === "M3")!;
    const planOf = (unit: number, steps: number) => ({ kind: "plan", plan: { steps: Array.from({ length: steps }, () => ({ endpoint: { platform: "x" } })), stored: {}, price: { unitPricePoints: unit } } }) as any;
    expect(gradeCase(m3, planOf(1, 1), "plan", []).pass).toBe(true);
    const high = gradeCase(m3, planOf(500, 1), "plan", []);
    expect(high.pass).toBe(false);
    expect(high.reason).toMatch(/outside the expected range 0\.05 to 6/);
    const m1 = ALL_SELF_TEST_CASES.find((c) => c.id === "M1")!;
    expect(gradeCase(m1, planOf(10, 1), "plan", []).reason).toMatch(/expected at least 2/);
    expect(gradeCase(m1, planOf(10, 3), "plan", []).pass).toBe(true);
  });

  it("the route lists the 30 cases and the four missions with their price range and estimate, and runs an M case by id", async () => {
    const getRes = await (await import("../src/app/api/admin/planner-selftest/route")).GET(new NextRequest("http://127.0.0.1:3000/api/admin/planner-selftest"));
    const info = await getRes.json();
    expect(info.cases).toHaveLength(30);
    expect(info.missionCases.map((c: any) => c.id)).toEqual(["M1", "M2", "M3", "M4"]);
    expect(info.missionCases[0]).toMatchObject({ estimateUsd: 0.03 });
    expect(info.missionCases[2].priceRange).toBe("0.05..6");
    state.transport = createScriptedTransport([[say("أي مباراة تقصد؟")]] as any);
    const res = await (await import("../src/app/api/admin/planner-selftest/route")).POST(new NextRequest("http://127.0.0.1:3000/api/admin/planner-selftest", { method: "POST", body: JSON.stringify({ caseId: "M3", runId: "m3", spentUsd: 0 }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).row).toMatchObject({ id: "M3" });
  });

  it("the page shows a checkbox for every case, select all / none / missions only, the estimate for the selection before running, and runs only the selected cases", () => {
    const page = readFileSync("src/app/admin/planner-selftest/page.tsx", "utf-8");
    for (const needle of ["selftest-select", "selftest-estimate", "تحديد الكل", "إلغاء التحديد", "المهام فقط", "التكلفة التقديرية قبل التشغيل", "estimateUsd", "priceRange", "selected?.has(c.id)", "missionCases"]) expect(page, needle).toContain(needle);
    expect(page).not.toMatch(/for \(const c of info\.cases\)/);
  });
});
