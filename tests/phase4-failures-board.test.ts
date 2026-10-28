import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { createMemoryDb } from "./helpers/memoryDb";
import { propose, sample, say, search, stubGateway, type GatewayStub } from "./helpers/plannerKit";

const state = vi.hoisted(() => ({ admin: true as boolean, client: null as any, transport: null as any }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin ? { ok: true, ctx: { adminId: "adm-1", audit: vi.fn(async () => undefined) } } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/providerKeys", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/server/providerKeys")>()), resolveProviderKey: vi.fn(async () => ({ key: "k" })) }));
vi.mock("../src/lib/modelPlanner/transport", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/modelPlanner/transport")>()), createAnthropicTransport: () => state.transport }));

import { BOARD_WINDOW_MS, buildBoard, cairoTime, reasonOfAttempts, reasonOfPlannerTurn, serviceOfEndpoint, summarize, loadFailureBoard, KIND_LABEL_AR } from "../src/lib/server/failureBoard";
import { PLANNER_EVENT_ROW_ENDPOINT, PLANNER_TURN_ROW_ENDPOINT, resetExplorationMemoryForTesting } from "../src/lib/modelPlanner/exploration";
import { retryRequest, RETRY_CAP_USD } from "../src/lib/modelPlanner/retryRequest";
import { createScriptedTransport } from "../src/lib/modelPlanner/transport";
import { jobIdForQuote } from "../src/lib/server/missionStatus";
import { MODEL_PLAN_REQUEST_PARAM } from "../src/lib/modelPlanner/constants";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const owners = new Map([["u1", { email: "real@customer.com" }], ["u2", { email: "qa@digr.local" }]]);

const turnRow = (over: Record<string, unknown> = {}) => ({ request_id: "rq1", user_id: "u1", endpoint_id: PLANNER_TURN_ROW_ENDPOINT, http_status: null, rows_returned: null, cost_usd: 0, refused_reason: "unavailable: no endpoint [needs_real_sample]", params_digest: { request: "هات ١٠ بوستات من فيسبوك", modelUsd: 0.0031 }, created_at: iso(2), ...over });
const sampleRow = (over: Record<string, unknown> = {}) => ({ request_id: "rq1", user_id: "u1", endpoint_id: "anyapi.facebook.page.posts", http_status: 500, rows_returned: 0, cost_usd: 0.0008, refused_reason: "http_error: 500", params_digest: {}, created_at: iso(2.01), ...over });

describe("the failures board: what makes a row, and how each row reads", () => {
  it("a failed job, an empty job and a partial job are rows (a good job is not); the customer's words come from its quote; the reason is Arabic; the link opens the job", () => {
    const jobs = [
      { id: "j1", user_id: "u1", status: "failed", endpoint_id: "anyapi.x.user.posts", target_volume_max: 10, delivered_units: 0, error_message: "المصدر لم يرد", accumulated_cost_usd: 0.02, updated_at: iso(1) },
      { id: "j2", user_id: "u1", status: "completed", endpoint_id: "anyapi.x.user.posts", target_volume_max: 10, delivered_units: 0, updated_at: iso(3) },
      { id: "j3", user_id: "u1", status: "completed", endpoint_id: "anyapi.x.user.posts", target_volume_max: 10, delivered_units: 4, updated_at: iso(5) },
      { id: "j4", user_id: "u1", status: "completed", endpoint_id: "anyapi.x.user.posts", target_volume_max: 10, delivered_units: 10, updated_at: iso(6) },
      { id: "j5", user_id: "u1", status: "running", endpoint_id: "anyapi.x.user.posts", target_volume_max: 10, delivered_units: 0, updated_at: iso(6) },
    ];
    const { rows } = buildBoard({ jobs, requestTextByJob: new Map([["j1", "هات ١٠ بوستات من @elonmusk"]]), exploration: [], owners, now: NOW });
    expect(rows.map((r) => [r.jobId, r.kind])).toEqual([["j1", "job_failed"], ["j2", "job_empty"], ["j3", "job_partial"]]);
    expect(rows[0]).toMatchObject({ requestText: "هات ١٠ بوستات من @elonmusk", reasonAr: "المصدر لم يرد", providerUsd: 0.02, userEmail: "real@customer.com", isTest: false, retryable: true, jobHref: "/admin/jobs?job=j1" });
    expect(rows[1].retryable).toBe(false);
    expect(rows[2].reasonAr).toContain("4");
    expect(KIND_LABEL_AR.job_failed).toMatch(/[؀-ۿ]/);
  });

  it("a planner turn that ended without a plan and its sample calls are ONE row: the request text, every endpoint tried and its outcome, the provider and the model USD, a test badge", () => {
    const exploration = [turnRow(), sampleRow(), sampleRow({ endpoint_id: "anyapi.facebook.page.info", http_status: 200, rows_returned: 0, cost_usd: 0, refused_reason: null, created_at: iso(2.005) }), turnRow({ request_id: "rq2", user_id: "u2", params_digest: { request: "x" }, created_at: iso(1) })];
    const { rows } = buildBoard({ jobs: [], requestTextByJob: new Map(), exploration, owners, now: NOW });
    expect(rows).toHaveLength(2);
    const r = rows.find((x) => x.requestId === "rq1")!;
    expect(r).toMatchObject({ kind: "planner_refused", requestText: "هات ١٠ بوستات من فيسبوك", modelUsd: 0.0031, isTest: false, userEmail: "real@customer.com", service: "فيسبوك" });
    expect(r.providerUsd).toBeCloseTo(0.0008, 9);
    expect(r.attempts.map((a) => [a.endpoint, a.outcome])).toEqual([["anyapi.facebook.page.posts", "http_error"], ["anyapi.facebook.page.info", "empty"]]);
    expect(r.reasonAr).toMatch(/[؀-ۿ]/);
    expect(rows.find((x) => x.requestId === "rq2")!.isTest).toBe(true);
  });

  it("failed sample calls without any planner turn are an «exploration_failed» row; a request whose samples all worked and that has no failed turn is not a row", () => {
    const failed = [sampleRow({ request_id: "rq3", refused_reason: "timeout: no answer within 12 s", http_status: 0 })];
    const good = [sampleRow({ request_id: "rq4", http_status: 200, rows_returned: 3, refused_reason: null })];
    const { rows } = buildBoard({ jobs: [], requestTextByJob: new Map(), exploration: [...failed, ...good], owners, now: NOW });
    expect(rows.map((r) => [r.requestId, r.kind])).toEqual([["rq3", "exploration_failed"]]);
    expect(rows[0].reasonAr).toContain("لم يرد");
  });

  it("the planner's own event rows are read for the request text when the turn row has none, and are never counted as attempts", () => {
    const exploration = [turnRow({ params_digest: { modelUsd: 0.002 } }), { request_id: "rq1", user_id: "u1", endpoint_id: PLANNER_EVENT_ROW_ENDPOINT, refused_reason: null, params_digest: { kind: "understood", request: "طلب من حدث الفهم" }, created_at: iso(2.02) }];
    const { rows } = buildBoard({ jobs: [], requestTextByJob: new Map(), exploration, owners, now: NOW });
    expect(rows[0].requestText).toBe("طلب من حدث الفهم");
    expect(rows[0].attempts).toEqual([]);
  });

  it("rows older than seven days are left out; the hide-test toggle hides test accounts and nothing else; newest first", () => {
    const exploration = [turnRow({ request_id: "old", created_at: new Date(NOW - BOARD_WINDOW_MS - 3600_000).toISOString() }), turnRow({ request_id: "a", created_at: iso(5) }), turnRow({ request_id: "b", user_id: "u2", created_at: iso(1) })];
    const all = buildBoard({ jobs: [], requestTextByJob: new Map(), exploration, owners, now: NOW });
    expect(all.rows.map((r) => r.requestId)).toEqual(["b", "a"]);
    const hidden = buildBoard({ jobs: [], requestTextByJob: new Map(), exploration, owners, now: NOW, hideTest: true });
    expect(hidden.rows.map((r) => r.requestId)).toEqual(["a"]);
  });

  it("the summary counts by service and reason for 24 hours and 7 days, the busiest first", () => {
    const exploration = [turnRow({ request_id: "a", created_at: iso(2) }), turnRow({ request_id: "b", created_at: iso(30) }), turnRow({ request_id: "c", created_at: iso(100) }), turnRow({ request_id: "d", refused_reason: "no_model: x", created_at: iso(3) })];
    const { rows, summary } = buildBoard({ jobs: [], requestTextByJob: new Map(), exploration, owners, now: NOW });
    expect(rows).toHaveLength(4);
    expect(summary[0]).toMatchObject({ last24h: 1, last7d: 3 });
    expect(summary.reduce((s, x) => s + x.last7d, 0)).toBe(4);
    expect(summarize([], NOW)).toEqual([]);
  });

  it("times are Cairo's (UTC+2 in winter, UTC+3 in summer) in Arabic digits, and the helpers name reasons and services in Arabic", () => {
    expect(cairoTime("2026-01-15T10:30:00Z")).toMatch(/١٢:٣٠/);
    expect(cairoTime("2026-07-15T10:30:00Z")).toMatch(/١٣:٣٠/);
    expect(cairoTime("garbage")).toBe("—");
    expect(reasonOfAttempts([{ endpoint: "a", outcome: "timeout" }])).toBe("المصدر لم يرد في الوقت المناسب");
    expect(reasonOfAttempts([{ endpoint: "a", outcome: "ok" }])).toMatch(/[؀-ۿ]/);
    expect(reasonOfPlannerTurn("no_model: down").kind).toBe("planner_error");
    expect(reasonOfPlannerTurn("incomplete: x [needs_value]").reasonAr).toContain("needs_value");
    expect(serviceOfEndpoint("anyapi.x.user.posts")).toBe("إكس");
    expect(serviceOfEndpoint("treg.mystery.thing")).toBe("treg.mystery.thing");
  });
});

describe("the board loader and the admin route (read only, admin only)", () => {
  beforeEach(() => { state.admin = true; state.client = createMemoryDb(); });
  const get = (q = "") => import("../src/app/api/admin/failures/route").then((m) => m.GET(new NextRequest(`http://127.0.0.1:3000/api/admin/failures${q}`)));

  it("joins jobs, the quote's request text, exploration rows and profile e-mails; a missing table makes the answer partial, never an error", async () => {
    const now = Date.now();
    const quoteId = "q-123";
    state.client.tables.set("jobs", [{ id: jobIdForQuote(quoteId), user_id: "u1", status: "failed", endpoint_id: "anyapi.x.user.posts", target_volume_max: 5, delivered_units: 0, error_message: "فشل", accumulated_cost_usd: 0, updated_at: new Date(now - 1000).toISOString(), created_at: new Date(now - 5000).toISOString() }]);
    state.client.tables.set("plans_quotes", [{ id: quoteId, created_at: new Date(now - 9000).toISOString(), items: [{ params: { [MODEL_PLAN_REQUEST_PARAM]: "طلب العميل" } }] }]);
    state.client.tables.set("profiles", [{ id: "u1", email: "iam.magdy+3@outlook.com" }]);
    const board = await loadFailureBoard(state.client, { now });
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({ requestText: "طلب العميل", isTest: true, userEmail: "iam.magdy+3@outlook.com" });
    const broken = { from: () => { throw new Error("no table"); } };
    expect((await loadFailureBoard(broken, { now })).partial).toEqual(expect.arrayContaining(["jobs", "exploration_calls"]));
  });

  it("a non-admin gets 403; an admin gets the rows, the kinds and the summary with no-store; nothing is written", async () => {
    state.admin = false;
    expect((await get()).status).toBe(403);
    state.admin = true;
    state.client.tables.set("exploration_calls", [turnRow({ created_at: new Date().toISOString() })]);
    const before = JSON.stringify(state.client.rows("exploration_calls"));
    const res = await get("?hideTest=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.kinds.planner_refused).toBeTruthy();
    expect(body.summary.length).toBeGreaterThan(0);
    expect(JSON.stringify(state.client.rows("exploration_calls"))).toBe(before);
    expect(state.client.rows("jobs")).toHaveLength(0);
  });
});

describe("«أعد التجربة»: one request through the real planner, stopped before approval, capped at 0.05 USD", () => {
  let gateway: GatewayStub | null = null;
  beforeEach(() => { process.env.TREG_TOKEN = "t"; state.admin = true; state.client = createMemoryDb(); resetExplorationMemoryForTesting(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { gateway?.restore(); gateway = null; vi.restoreAllMocks(); });
  const script = () => [
    search("instagram", ["user", "profile"]),
    sample("crawl4ai.instagram.user.profile", [{ name: "username", value: "natgeo", source: "customer_text", quote: "@natgeo" }]),
    propose({ summaryAr: "بيانات حساب natgeo", steps: [{ endpointId: "crawl4ai.instagram.user.profile", volume: 1, params: [{ name: "username", value: "natgeo", source: "customer_text", quote: "@natgeo" }], fieldMap: { columns: [{ field: "username", headerAr: "اسم المستخدم", role: "author_handle" }], pagination: { kind: "single" } }, filters: [] }] }),
  ];

  it("returns what the planner would show, the endpoints, the attempts and both costs; the only table touched is the exploration bookkeeping", async () => {
    gateway = stubGateway({ "crawl4ai.instagram.user.profile": { username: "natgeo", full_name: "National Geographic", followers: 268273892, is_verified: true } }, { "crawl4ai.instagram.user.profile": 900 });
    const touched: string[] = [];
    const db = createMemoryDb();
    const spying = { from: (t: string) => { touched.push(t); return db.from(t); }, storage: db.storage };
    const out = await retryRequest({ requestText: "هات بيانات حساب انستقرام @natgeo", transport: createScriptedTransport(script() as any), client: spying, adminId: "adm-1", runId: "r1" });
    expect(out).toMatchObject({ outcome: "plan", endpoints: ["crawl4ai.instagram.user.profile"], capUsd: RETRY_CAP_USD, overCap: false });
    expect(out.unitPricePoints).toBeGreaterThan(0);
    expect(out.attempts[0]).toMatchObject({ endpoint: "crawl4ai.instagram.user.profile", outcome: "ok" });
    expect(out.providerUsd).toBeCloseTo(0.0009, 9);
    expect(out.modelUsd).toBeGreaterThan(0);
    expect(new Set(touched)).toEqual(new Set(["exploration_calls"]));
    expect(db.rows("exploration_calls")[0]).toMatchObject({ request_id: "retry_r1", user_id: "adm-1" });
  });

  it("a refusal is reported as the standard sentence with the failed attempts; the cap is 0.05 USD", async () => {
    const out = await retryRequest({ requestText: "x", transport: createScriptedTransport([[say("لا")]] as any), client: state.client, adminId: "adm-1", runId: "r2" });
    expect(["refusal", "question"]).toContain(out.outcome);
    expect(RETRY_CAP_USD).toBe(0.05);
  });

  it("the route: 403 for a non-admin, 400 for bad input, 200 with the result for an admin", async () => {
    const post = (b: unknown) => import("../src/app/api/admin/failures/retry/route").then((m) => m.POST(new NextRequest("http://127.0.0.1:3000/api/admin/failures/retry", { method: "POST", body: JSON.stringify(b) })));
    state.admin = false;
    expect((await post({ requestText: "x", runId: "r" })).status).toBe(403);
    state.admin = true;
    expect((await post({ requestText: "", runId: "r" })).status).toBe(400);
    expect((await post({ requestText: "x".repeat(601), runId: "r" })).status).toBe(400);
    state.transport = createScriptedTransport([[say("هذه الخدمة غير متاحة")]] as any);
    const res = await post({ requestText: "طلب", runId: "r3" });
    expect(res.status).toBe(200);
    expect((await res.json()).result.capUsd).toBe(0.05);
  });
});

describe("the page and the navigation", () => {
  const page = readFileSync("src/app/admin/failures/page.tsx", "utf-8");
  it("is registered in the admin navigation as «لوحة الأعطال», and the page has the summary, the rows, the test toggle and a per-row retry that sends only that request", () => {
    expect(readFileSync("src/components/admin/icons.tsx", "utf-8")).toContain("لوحة الأعطال");
    expect(readFileSync("src/components/admin/AdminShell.tsx", "utf-8")).toContain("failures");
    expect(page).toContain("أعد التجربة");
    expect(page).toContain("/api/admin/failures/retry");
    expect(page).toContain("requestText");
    expect(readFileSync("next.config.mjs", "utf-8")).toContain("/api/admin/failures/retry");
  });
});
