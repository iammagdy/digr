import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";

const state = vi.hoisted(() => ({ admin: true as boolean, client: null as any, audits: [] as string[] }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin ? { ok: true, ctx: { adminId: "adm-1", audit: async (_k: string, label: string) => { state.audits.push(label); } } } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/components/admin/AdminShell", () => ({ useAdmin: () => ({ toast: () => undefined }) }));

import { GET as overviewGET, POST as overviewPOST } from "../src/app/api/admin/agent/route";
import { GET as detailGET, POST as detailPOST } from "../src/app/api/admin/agent/[id]/route";
import { GET as fileGET } from "../src/app/api/admin/agent/[id]/file/route";
import AgentPage from "../src/app/admin/agent/page";
import { ADMIN_PAGES, adminHref } from "../src/components/admin/icons";
import { answerQuestion, approvePlan, cancelMission, createMission, fileLink, findTestAccount, loadDetail, loadOverview, setPlanningModel } from "../src/lib/agentMission/adminActions";

const TEST_USER = "00000000-0000-0000-0000-0000000000aa";
const OTHER_USER = "00000000-0000-0000-0000-0000000000bb";
const MONEY_TABLES = ["credit_ledger", "jobs", "topups", "profiles_write", "plans_quotes", "provider_costs"];

/** The memory database plus the money functions' fake, with a record of every table touched and every write. */
function makeClient(db: MemoryDb, money = fakeMoneyClient()) {
  const touched: string[] = [];
  const written: string[] = [];
  const client: any = {
    from: (t: string) => {
      touched.push(t);
      const b = db.from(t);
      for (const m of ["insert", "update", "upsert"]) { const orig = b[m]; b[m] = (...a: any[]) => { written.push(t); return orig(...a); }; }
      return b;
    },
    rpc: money.client.rpc,
    storage: { from: (bucket: string) => ({ createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.example/${bucket}/${p}` }, error: null }) }) },
  };
  return { client, touched, written, money };
}

let db: MemoryDb;
beforeEach(() => {
  db = createMemoryDb();
  db.seed("profiles", [{ id: TEST_USER, email: "iam.magdy+1@outlook.com" }, { id: OTHER_USER, email: "customer@example.com" }]);
  state.admin = true; state.audits = [];
});

describe("the admin page «الوكيل» is for the test account only", () => {
  it("finds the test account by its e-mail and nothing else", async () => {
    const { client } = makeClient(db);
    expect(await findTestAccount(client)).toEqual({ id: TEST_USER, email: "iam.magdy+1@outlook.com" });
    db.tables.set("profiles", [{ id: OTHER_USER, email: "customer@example.com" }]);
    expect(await findTestAccount(client)).toBeNull();
  });

  it("creates a mission FOR THE TEST ACCOUNT, queued for the worker, and rejects empty or oversize text", async () => {
    const { client } = makeClient(db);
    const r = await createMission(client, { adminId: "adm-1", text: "  هات   منشورات عن القهوة  " });
    expect(r.ok).toBe(true);
    const row = db.rows("missions")[0];
    expect(row).toMatchObject({ user_id: TEST_USER, created_by: "adm-1", status: "queued", request_text: "هات منشورات عن القهوة" });
    expect(await createMission(client, { adminId: "adm-1", text: " " })).toMatchObject({ ok: false, status: 400 });
    expect(await createMission(client, { adminId: "adm-1", text: "x".repeat(4001) })).toMatchObject({ ok: false, status: 400 });
    expect(db.rows("missions")).toHaveLength(1);
  });

  it("refuses to approve a mission of any other account", async () => {
    const { client, money } = makeClient(db);
    db.seed("missions", [{ id: "msn_other0001", user_id: OTHER_USER, status: "plan_ready", plan: pricedTwoStagePlan() }]);
    expect(await approvePlan(client, { id: "msn_other0001", adminId: "adm-1" })).toMatchObject({ ok: false, status: 403 });
    expect(money.calls).toHaveLength(0);
    expect(db.rows("missions")[0].status).toBe("plan_ready");
  });
});

describe("approve reserves through the existing functions and hands the mission to the worker", () => {
  const seedReady = () => db.seed("missions", [{ id: "msn_ready0001", user_id: TEST_USER, status: "plan_ready", plan: pricedTwoStagePlan() }]);

  it("plan_ready -> approved with the job, the reserve and the unit price computed by code; no money table is written by hand", async () => {
    seedReady();
    const { client, money, written, touched } = makeClient(db);
    const r = await approvePlan(client, { id: "msn_ready0001", adminId: "adm-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = db.rows("missions")[0];
    expect(row).toMatchObject({ status: "approved", job_id: r.jobId, reserved_points: r.reservePoints, unit_price_points: r.unitPricePoints, approved_by: "adm-1", lease_until: null });
    expect(money.calls.map((c) => c.name)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
    expect(money.ledger.find((l) => l.type === "reserve")!.delta).toBe(-r.reservePoints);
    // only the agent's own tables (and profiles, read) were touched; no money table
    expect(new Set(touched)).toEqual(new Set(["profiles", "missions", "mission_events"]));
    for (const t of written) expect(MONEY_TABLES).not.toContain(t);
    expect(written.filter((t) => t === "profiles")).toHaveLength(0);
    expect(db.rows("mission_events").map((e) => e.kind)).toContain("system");
  });

  it("a second approval (double click) reserves nothing more", async () => {
    seedReady();
    const { client, money } = makeClient(db);
    await approvePlan(client, { id: "msn_ready0001", adminId: "adm-1" });
    const again = await approvePlan(client, { id: "msn_ready0001", adminId: "adm-1" });
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
  });

  it("an insufficient balance returns the mission to plan_ready and holds nothing", async () => {
    seedReady();
    const { client, money } = makeClient(db, fakeMoneyClient({ balance: 3 }));
    const r = await approvePlan(client, { id: "msn_ready0001", adminId: "adm-1" });
    expect(r).toMatchObject({ ok: false, status: 402 });
    expect(db.rows("missions")[0].status).toBe("plan_ready");
    expect(money.ledger.filter((l) => l.type === "reserve")).toHaveLength(0);
  });

  it("only a mission with a ready plan can be approved", async () => {
    db.seed("missions", [{ id: "msn_queued001", user_id: TEST_USER, status: "queued", plan: null }]);
    const { client, money } = makeClient(db);
    expect(await approvePlan(client, { id: "msn_queued001", adminId: "adm-1" })).toMatchObject({ ok: false, status: 409 });
    expect(money.calls).toHaveLength(0);
  });
});

describe("questions, cancelling, settings, files, the live view", () => {
  it("an answer re-queues a mission that asked its one question; a mission that did not ask refuses it", async () => {
    db.seed("missions", [{ id: "msn_ask000001", user_id: TEST_USER, status: "needs_input", question_ar: "أي حساب؟" }, { id: "msn_run000001", user_id: TEST_USER, status: "planning" }]);
    const { client } = makeClient(db);
    expect(await answerQuestion(client, { id: "msn_ask000001", text: "حساب القهوة" })).toEqual({ ok: true });
    expect(db.rows("missions")[0]).toMatchObject({ status: "queued", answer_text: "حساب القهوة", question_ar: null });
    expect(await answerQuestion(client, { id: "msn_run000001", text: "x" })).toMatchObject({ ok: false, status: 409 });
  });

  it("cancels only a mission that holds nothing", async () => {
    db.seed("missions", [{ id: "msn_a0000001", user_id: TEST_USER, status: "plan_ready" }, { id: "msn_b0000001", user_id: TEST_USER, status: "executing" }, { id: "msn_c0000001", user_id: TEST_USER, status: "approved" }]);
    const { client } = makeClient(db);
    expect(await cancelMission(client, { id: "msn_a0000001" })).toEqual({ ok: true });
    expect(await cancelMission(client, { id: "msn_b0000001" })).toMatchObject({ ok: false, status: 409 });
    expect(await cancelMission(client, { id: "msn_c0000001" })).toMatchObject({ ok: false, status: 409 });
  });

  it("the planning model setting accepts only the two allowed models", async () => {
    const { client } = makeClient(db);
    expect(await setPlanningModel(client, { model: "claude-sonnet-5-5", adminId: "adm-1" })).toEqual({ ok: true, model: "claude-sonnet-5-5" });
    expect(db.rows("agent_settings")[0]).toMatchObject({ key: "planning_model", value: { model: "claude-sonnet-5-5" } });
    expect(await setPlanningModel(client, { model: "gpt-5", adminId: "adm-1" })).toMatchObject({ ok: false, status: 400 });
  });

  it("the overview says whether the worker is alive from its heartbeat", async () => {
    const { client } = makeClient(db);
    const now = Date.parse("2026-10-28T10:00:00Z");
    db.seed("agent_worker_heartbeat", [{ worker_id: "w1", beat_at: "2026-10-28T09:59:50Z", active_missions: 1, model: "m", version: "v", rss_mb: 180, tree_rss_mb: 300 }]);
    expect((await loadOverview(client, now)).worker).toMatchObject({ alive: true, ageSeconds: 10, memory: { rssMb: 180, treeRssMb: 300, limitMb: 512, warn: false } });
    expect((await loadOverview(client, now + 5 * 60_000)).worker.alive).toBe(false);
    db.tables.set("agent_worker_heartbeat", []);
    expect((await loadOverview(client, now)).worker).toMatchObject({ alive: false, ageSeconds: null });
  });

  it("the overview reports the worker's memory from its heartbeat, warns near the dyno's limit, and says nothing before any is reported", async () => {
    const { client } = makeClient(db);
    const now = Date.parse("2026-10-28T10:00:00Z");
    db.seed("agent_worker_heartbeat", [{ worker_id: "w1", beat_at: "2026-10-28T09:59:50Z", active_missions: 1, rss_mb: 200, tree_rss_mb: 450 }]);
    expect((await loadOverview(client, now)).worker.memory).toEqual({ rssMb: 200, treeRssMb: 450, limitMb: 512, warn: true });
    db.tables.set("agent_worker_heartbeat", [{ worker_id: "w1", beat_at: "2026-10-28T09:59:50Z", active_missions: 0, rss_mb: 120, tree_rss_mb: null }]);
    expect((await loadOverview(client, now)).worker.memory).toEqual({ rssMb: 120, treeRssMb: null, limitMb: 512, warn: false });
    db.tables.set("agent_worker_heartbeat", [{ worker_id: "w1", beat_at: "2026-10-28T09:59:50Z", active_missions: 0, rss_mb: null, tree_rss_mb: null }]);
    expect((await loadOverview(client, now)).worker.memory).toBeNull();
  });

  it("the overview works before the SQL is applied (tablesReady false, nothing throws)", async () => {
    const missing = createMemoryDb({ missing: ["missions", "mission_events", "agent_worker_heartbeat", "agent_settings", "mission_calls"] });
    const o = await loadOverview({ from: missing.from } as any);
    expect(o.tablesReady).toBe(false);
    expect(o.worker.alive).toBe(false);
  });

  it("the detail shows the live events after a cursor, the customer's view of the plan, and the internal view with the price recomputed by code", async () => {
    const plan = pricedTwoStagePlan();
    db.seed("missions", [{ id: "msn_view00001", user_id: TEST_USER, status: "plan_ready", plan, request_text: "x" }]);
    db.seed("mission_events", [1, 2, 3].map((id) => ({ id, mission_id: "msn_view00001", kind: "progress", message_ar: `سطر ${id}`, counts: {}, created_at: "2026-10-28T10:00:00Z" })));
    db.seed("mission_calls", [{ id: "msn_view00001:call_0001", mission_id: "msn_view00001", phase: "planning", endpoint_id: "x.y", status: "ok", cost_usd: 0.01, created_at: "2026-10-28T10:00:00Z" }, { id: "msn_view00001:call_0002", mission_id: "msn_view00001", phase: "planning", endpoint_id: "x.y", status: "refused", cost_usd: 0, created_at: "2026-10-28T10:00:01Z" }]);
    const { client } = makeClient(db);
    const d = await loadDetail(client, { id: "msn_view00001", afterEventId: 1 });
    if (!d.ok) throw new Error("expected detail");
    expect(d.events.map((e: any) => e.id)).toEqual([2, 3]);
    expect(d.calls).toMatchObject({ total: 2, refused: 1 });
    expect(JSON.stringify(d.customerPlan)).not.toMatch(/x\.x\.search-posts-all|anyapi|usd|cost/i);
    expect(d.customerPlan!.price.unit_price_points).toBe(plan.price.unitPricePoints);
    expect(d.internalPlan!.price.unitPricePoints).toBe(plan.price.unitPricePoints);
    expect(d.internalPlan!.stages[0].endpoint_id).toBe("x.x.search-posts-all");
    expect((d.mission as any).plan).toBeUndefined();
  });

  it("a file link is made only for a file the mission lists", async () => {
    db.seed("missions", [{ id: "msn_files0001", user_id: TEST_USER, files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }] }]);
    const { client } = makeClient(db);
    expect(await fileLink(client, { id: "msn_files0001", name: "result.xlsx" })).toEqual({ ok: true, url: "https://signed.example/agent-missions/msn_files0001/result/result.xlsx" });
    expect(await fileLink(client, { id: "msn_files0001", name: "../../secret" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the routes check the admin and nothing else answers", () => {
  const req = (url: string, body?: unknown) => new Request(url, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined }) as any;
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("a non-admin gets 403 from every route and nothing is written", async () => {
    state.admin = false;
    const { client, written } = makeClient(db);
    state.client = client;
    expect((await overviewGET(req("http://x/api/admin/agent"))).status).toBe(403);
    expect((await overviewPOST(req("http://x/api/admin/agent", { action: "create", text: "هات منشورات" }))).status).toBe(403);
    expect((await detailGET(req("http://x/api/admin/agent/msn_aaaaaaaa"), ctx("msn_aaaaaaaa"))).status).toBe(403);
    expect((await detailPOST(req("http://x/api/admin/agent/msn_aaaaaaaa", { action: "approve" }), ctx("msn_aaaaaaaa"))).status).toBe(403);
    expect((await fileGET(req("http://x/api/admin/agent/msn_aaaaaaaa/file?name=result.xlsx"), ctx("msn_aaaaaaaa"))).status).toBe(403);
    expect(written).toHaveLength(0);
  });

  it("an admin creates, reads and approves; bad ids and actions are 400", async () => {
    const { client, money } = makeClient(db);
    state.client = client;
    const created = await overviewPOST(req("http://x/api/admin/agent", { action: "create", text: "هات منشورات عن القهوة" }));
    expect(created.status).toBe(200);
    const id = (await created.json()).id as string;
    expect(state.audits).toContain("إنشاء مهمة وكيل");
    const mission = db.rows("missions").find((m) => m.id === id)!;
    Object.assign(mission, { status: "plan_ready", plan: pricedTwoStagePlan() });
    expect((await detailGET(req(`http://x/api/admin/agent/${id}`), ctx(id))).status).toBe(200);
    expect((await detailGET(req("http://x/api/admin/agent/not-an-id"), ctx("not-an-id"))).status).toBe(400);
    expect((await detailPOST(req(`http://x/api/admin/agent/${id}`, { action: "explode" }), ctx(id))).status).toBe(400);
    const approved = await detailPOST(req(`http://x/api/admin/agent/${id}`, { action: "approve" }), ctx(id));
    expect(approved.status).toBe(200);
    expect(money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    expect(state.audits).toContain("اعتماد خطة وكيل");
  });
});

describe("the page and the menu", () => {
  it("«الوكيل» is in the admin menu", () => {
    expect(ADMIN_PAGES.find(([id]) => id === "agent")![1]).toBe("الوكيل");
    expect(adminHref("agent")).toBe("/admin/agent");
  });
  it("renders in Arabic: the heartbeat, the test-account notice, the mission box and the model switch", () => {
    const html = renderToStaticMarkup(createElement(AgentPage as any));
    expect(html).toContain("الوكيل");
    expect(html).toContain("agent-heartbeat");
    expect(html).toContain("agent-memory");
    expect(html).toContain("ذاكرة العامل");
    expect(html).toContain("لحساب الاختبار فقط");
    expect(html).toContain("agent-text");
    expect(html).toContain("شغّل الوكيل");
    expect(html).toContain("نموذج التخطيط");
    expect(html).toContain('dir="rtl"');
  });
});

describe("the SQL proposal (docs/proposals/agent-worker): not applied, RLS on, service role writes, no money table", () => {
  const dir = path.resolve(__dirname, "../docs/proposals/agent-worker");
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const MONEY = /\b(credit_ledger|topups|plans_quotes|provider_costs|profiles|jobs)\b/;
  const code = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("every file says it is NOT APPLIED, and every apply step has a rollback", () => {
    for (const f of files) expect(read(f)).toMatch(/NOT APPLIED/);
    for (const step of ["01_agent_tables", "02_agent_claim_function", "03_agent_storage"]) { expect(files).toContain(`${step}.sql`); expect(files).toContain(`${step}.rollback.sql`); }
    expect(files).toContain("00_verify_before_apply.sql");
    expect(files).toContain("04_verify_after_apply.sql");
  });
  it("RLS is on for all five tables; no policy lets a role other than the service role write; anon gets nothing", () => {
    const sql = code(read("01_agent_tables.sql"));
    for (const t of ["missions", "mission_events", "mission_calls", "agent_worker_heartbeat", "agent_settings"]) expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    expect(sql).toMatch(/REVOKE ALL ON public\.missions[^;]*FROM PUBLIC, anon, authenticated/);
    const policies = [...sql.matchAll(/CREATE POLICY (\w+) ON public\.(\w+) FOR (\w+)/g)].map((m) => `${m[2]}:${m[3]}`);
    expect(policies.sort()).toEqual(["mission_events:SELECT", "missions:SELECT"]);
    expect(sql).toMatch(/USING \(user_id = auth\.uid\(\)\)/);
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO[^;]*(authenticated|anon)/i);
    // the customer's column list leaves out every internal column
    const grant = sql.match(/GRANT SELECT \(([^)]*)\)\s+ON public\.missions TO authenticated/)![1];
    for (const internal of ["plan,", "error", "worker_id", "lease_until", "llm_usd", "treg_usd", "planning_model", "execution_model", "quote_id", "created_by"]) expect(grant.replace(/plan_public/, "")).not.toContain(internal);
  });
  it("no file writes, alters or calls a money table or function; the verify files are read only", () => {
    for (const f of files.filter((x) => !x.startsWith("04_") && !x.startsWith("00_") && !x.startsWith("05_"))) {
      const sql = code(read(f));
      expect(sql, f).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE|TRUNCATE|REFERENCES|FROM)\s+(public\.)?(credit_ledger|topups|plans_quotes|provider_costs|profiles|jobs)\b/i);
      expect(sql, f).not.toMatch(/(reserve_credits_atomic|settle_job_atomic|release_job_atomic|accept_quote_atomic|approve_topup_atomic)\s*\(/);
    }
    for (const f of ["00_verify_before_apply.sql", "04_verify_after_apply.sql"]) expect(code(read(f))).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
    void MONEY;
  });
  it("the heartbeat table carries the two memory columns, nothing else changed in its access", () => {
    const sql = code(read("01_agent_tables.sql"));
    const table = sql.match(/CREATE TABLE IF NOT EXISTS public\.agent_worker_heartbeat \(([\s\S]*?)\n\);/)![1];
    expect(table).toMatch(/rss_mb\s+integer/);
    expect(table).toMatch(/tree_rss_mb\s+integer/);
    expect(code(read("04_verify_after_apply.sql"))).toMatch(/'rss_mb', 'tree_rss_mb'/);
  });
  it("the claim function is service-role only and takes missions with FOR UPDATE SKIP LOCKED", () => {
    const sql = read("02_agent_claim_function.sql");
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.agent_claim_mission\(text, integer\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.agent_claim_mission\(text, integer\) TO service_role/);
  });
  it("the bucket is private and has no storage policy", () => {
    const sql = code(read("03_agent_storage.sql"));
    expect(sql).toMatch(/'agent-missions', 'agent-missions', false/);
    expect(sql).not.toMatch(/CREATE POLICY/);
  });
});
