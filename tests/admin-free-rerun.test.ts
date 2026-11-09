import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";

const state = vi.hoisted(() => ({ client: null as any, admin: true, audit: [] as any[], notices: [] as any[] }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin
    ? { ok: true, ctx: { adminId: ADMIN, audit: vi.fn(async (...a: any[]) => { state.audit.push(a); }) } }
    : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/server/missionNotify", () => ({ sendMissionNotice: vi.fn(async (_c: unknown, n: any) => { state.notices.push(n); return { inApp: true, email: false }; }) }));

import { GET, POST } from "../src/app/api/admin/users/[id]/reruns/route";
import { approveFreeRerun } from "../src/lib/agentMission/adminActions";
import { compensateFreeRerun, createFreeRerun, holdRequestId, refundRequestId } from "../src/lib/agentMission/freeRerun";
import { FREE_RERUN_MARK, isFreeRerunEvents } from "../src/lib/agentMission/freeRerunMark";
import { settleMission } from "../src/lib/agentMission/lifecycle";
import { FREE_RERUN_MONEY_LINE_AR, moneyLineAr } from "../src/lib/agentMission/moneyText";
import { buildMissionNotice } from "../src/lib/agentMission/notices";
import { isInternalEvent } from "../src/lib/agentMission/eventText";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { AGENT_TEST_ACCOUNT_EMAIL } from "../src/lib/agentMission/constants";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TEST_ACC = "33333333-3333-4333-8333-333333333333";

/**
 * The money functions are the fake of the LIVE ones (tests/helpers/agentMoney.ts); `admin_grant_credit_atomic` is added here with the live function's rules
 * (read on the database, 2026-11-09): an admin only, whole positive points, a note of 3 to 200 characters, a request id `^[A-Za-z0-9_-]{8,64}$`, the ledger row
 * `adm_<request id>` written once (the same id again answers already_granted; with another amount, request_id_conflict).
 */
function makeClient(db: MemoryDb, money = fakeMoneyClient()) {
  const grants: any[] = [];
  const rpc = async (name: string, args: any) => {
    if (name !== "admin_grant_credit_atomic") return money.client.rpc(name, args);
    grants.push(args);
    if (args.p_admin_id !== ADMIN) return { data: { success: false, error: "not_admin" } };
    if (!(args.p_points > 0) || Math.trunc(args.p_points) !== args.p_points || args.p_points > 100000) return { data: { success: false, error: "invalid_amount" } };
    if (typeof args.p_note !== "string" || args.p_note.trim().length < 3 || args.p_note.length > 200) return { data: { success: false, error: "invalid_note" } };
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(args.p_request_id))) return { data: { success: false, error: "invalid_request_id" } };
    const id = `adm_${args.p_request_id}`;
    const existing = money.ledger.find((r) => r.id === id);
    if (existing) return existing.delta === args.p_points ? { data: { success: true, already_granted: true, points: args.p_points, balance: money.balance() } } : { data: { success: false, error: "request_id_conflict" } };
    money.ledger.push({ id, delta: args.p_points, type: "grant", user_id: args.p_user_id });
    return { data: { success: true, already_granted: false, points: args.p_points, balance: money.balance() } };
  };
  return { client: { from: (t: string) => db.from(t), rpc }, money, grants };
}

let db: MemoryDb;
beforeEach(() => {
  db = createMemoryDb();
  state.admin = true; state.audit = []; state.notices = [];
  db.seed("profiles", [{ id: ME, email: "hala@example.com" }]);
  db.seed("profiles", [{ id: OTHER, email: "other@example.com" }]);
  db.seed("profiles", [{ id: TEST_ACC, email: AGENT_TEST_ACCOUNT_EMAIL }]);
  db.seed("missions", [{ id: "msn_source00001", user_id: ME, created_by: ME, status: "unserved", request_text: "سحب تعليقات على ريدت عن الغسل الأخضر", created_at: "2026-11-09T15:36:00Z" }]);
  db.seed("missions", [{ id: "msn_other000001", user_id: OTHER, created_by: OTHER, status: "unserved", request_text: "طلب عميل آخر", created_at: "2026-11-09T15:00:00Z" }]);
});

/** Plans the re-run as the worker would: the plan is ready. */
const planReady = async (id: string) => await db.from("missions").update({ status: "plan_ready", plan: pricedTwoStagePlan(), plan_public: customerPlanView(pricedTwoStagePlan()) }).eq("id", id);
const eventsOfMission = (id: string) => db.rows("mission_events").filter((e: any) => e.mission_id === id);

describe("creating a free re-run", () => {
  it("is the customer's own mission, created by the admin, with the text of their mission and the internal marker", async () => {
    const { client } = makeClient(db);
    const r = await createFreeRerun(client, { adminId: ADMIN, customerId: ME, sourceMissionId: "msn_source00001" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = db.rows("missions").find((m: any) => m.id === r.id);
    expect(row).toMatchObject({ user_id: ME, created_by: ADMIN, status: "queued", request_text: "سحب تعليقات على ريدت عن الغسل الأخضر" });
    const evs = eventsOfMission(r.id);
    expect(isFreeRerunEvents(evs)).toBe(true);
    // the marker is internal: the customer never reads it
    expect(evs.every((e: any) => isInternalEvent(e))).toBe(true);
  });

  it("refuses another customer's mission, an add-on row, the test account, and an empty text", async () => {
    const { client } = makeClient(db);
    expect(await createFreeRerun(client, { adminId: ADMIN, customerId: ME, sourceMissionId: "msn_other000001" })).toMatchObject({ ok: false, status: 404 });
    db.seed("missions", [{ id: "msn_addon000001", user_id: ME, created_by: ME, status: "plan_ready", request_text: "تعديل", plan: { addon: { kind: "edit" } } }]);
    expect(await createFreeRerun(client, { adminId: ADMIN, customerId: ME, sourceMissionId: "msn_addon000001" })).toMatchObject({ ok: false, status: 404 });
    expect(await createFreeRerun(client, { adminId: ADMIN, customerId: TEST_ACC, text: "هات تغريدات" })).toMatchObject({ ok: false, status: 400 });
    expect(await createFreeRerun(client, { adminId: ADMIN, customerId: ME, text: " " })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("the money of a free re-run: the customer pays nothing", () => {
  it("balance covers the hold: hold, settle, and the charge is given back once, so the customer's balance ends exactly where it started", async () => {
    const { client, money, grants } = makeClient(db, fakeMoneyClient({ balance: 10_000 }));
    const start = money.balance();
    const c = await createFreeRerun(client, { adminId: ADMIN, customerId: ME, sourceMissionId: "msn_source00001" });
    if (!c.ok) throw new Error(c.error);
    await planReady(c.id);
    const a = await approveFreeRerun(client, { id: c.id, adminId: ADMIN });
    expect(a, JSON.stringify(a)).toMatchObject({ ok: true, holdGranted: 0 });
    if (!a.ok) return;
    const plan = pricedTwoStagePlan();
    const settled = await settleMission(client, { jobId: a.jobId, deliveredUnits: Math.min(5, plan.price.deliveredRows), unitPricePoints: plan.price.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0.01, resultPath: "results/x.xlsx" });
    expect(settled.ok && settled.kind === "settled").toBe(true);
    if (!settled.ok || settled.kind !== "settled") return;
    expect(settled.chargedPoints).toBeGreaterThan(0);
    expect(money.balance()).toBe(start - settled.chargedPoints);

    const comp = await compensateFreeRerun(client, { missionId: c.id, chargedPoints: settled.chargedPoints });
    expect(comp).toEqual({ status: "granted", points: settled.chargedPoints });
    expect(money.balance()).toBe(start);
    expect(grants.at(-1)).toMatchObject({ p_admin_id: ADMIN, p_user_id: ME, p_points: settled.chargedPoints, p_request_id: refundRequestId(c.id) });

    // again (the worker, then the admin page): granted once, no second row, no second event
    const ledgerRows = money.ledger.length;
    const events = eventsOfMission(c.id).length;
    expect(await compensateFreeRerun(client, { missionId: c.id, chargedPoints: settled.chargedPoints })).toEqual({ status: "already_granted", points: settled.chargedPoints });
    expect(money.ledger.length).toBe(ledgerRows);
    expect(eventsOfMission(c.id).length).toBe(events);
    expect(money.balance()).toBe(start);
  });

  it("balance too low for the hold: the reserve is granted first and the approval goes through; the customer never ends below where they started", async () => {
    const { client, money } = makeClient(db, fakeMoneyClient({ balance: 10 }));
    const start = money.balance();
    const c = await createFreeRerun(client, { adminId: ADMIN, customerId: ME, sourceMissionId: "msn_source00001" });
    if (!c.ok) throw new Error(c.error);
    await planReady(c.id);
    const a = await approveFreeRerun(client, { id: c.id, adminId: ADMIN });
    expect(a, JSON.stringify(a)).toMatchObject({ ok: true });
    if (!a.ok) return;
    expect(a.holdGranted).toBe(a.reservePoints);
    expect(money.ledger.some((r) => r.id === `adm_${holdRequestId(c.id)}`)).toBe(true);
    const plan = pricedTwoStagePlan();
    const settled = await settleMission(client, { jobId: a.jobId, deliveredUnits: Math.min(5, plan.price.deliveredRows), unitPricePoints: plan.price.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0.01, resultPath: "results/x.xlsx" });
    if (!settled.ok || settled.kind !== "settled") throw new Error("not settled");
    const comp = await compensateFreeRerun(client, { missionId: c.id, chargedPoints: settled.chargedPoints });
    expect(comp.status).toBe("nothing_due");
    expect(money.balance()).toBeGreaterThanOrEqual(start);
  });

  it("an ordinary mission is never approved here and never refunded", async () => {
    const { client, grants } = makeClient(db);
    db.seed("missions", [{ id: "msn_plain000001", user_id: ME, created_by: ME, status: "plan_ready", request_text: "هات تغريدات", plan: pricedTwoStagePlan() }]);
    expect(await approveFreeRerun(client, { id: "msn_plain000001", adminId: ADMIN })).toMatchObject({ ok: false, status: 403 });
    expect(await compensateFreeRerun(client, { missionId: "msn_plain000001", chargedPoints: 100 })).toEqual({ status: "not_free" });
    // an admin's test-account mission has created_by ≠ user_id but no marker: not free either
    db.seed("missions", [{ id: "msn_testacc0001", user_id: TEST_ACC, created_by: ADMIN, status: "completed", request_text: "اختبار" }]);
    expect(await compensateFreeRerun(client, { missionId: "msn_testacc0001", chargedPoints: 100 })).toEqual({ status: "not_free" });
    expect(grants).toHaveLength(0);
  });

  it("a refund the worker missed is found from the settled job (the admin page's safety net); an unsettled job waits", async () => {
    const { client, money } = makeClient(db);
    const c = await createFreeRerun(client, { adminId: ADMIN, customerId: ME, text: "هات تغريدات عن الغسل الأخضر" });
    if (!c.ok) throw new Error(c.error);
    await db.from("missions").update({ status: "completed", job_id: "job_x1", charged_points: 120 }).eq("id", c.id);
    db.seed("jobs", [{ id: "job_x1", user_id: ME, status: "running", charged_credits: null }]);
    expect(await compensateFreeRerun(client, { missionId: c.id })).toEqual({ status: "pending" });
    await db.from("jobs").update({ status: "completed", charged_credits: 120 }).eq("id", "job_x1");
    const before = money.balance();
    expect(await compensateFreeRerun(client, { missionId: c.id })).toEqual({ status: "granted", points: 120 });
    expect(money.balance()).toBe(before + 120);
  });

  it("never throws: a broken client is a failed outcome", async () => {
    const broken = { from: () => { throw new Error("db down"); }, rpc: async () => ({ error: { message: "x" } }) };
    expect(await compensateFreeRerun(broken, { missionId: "msn_any00000001", chargedPoints: 5 })).toEqual({ status: "failed", reason: "exception" });
  });
});

describe("what the customer reads: free, nothing paid", () => {
  it("the money line, the completion notice and the panel say the mission was free", () => {
    const noun = { singular: "تغريدة", plural: "تغريدات", dual: "تغريدتان" } as any;
    expect(moneyLineAr({ reservedPoints: 200, chargedPoints: 120, delivered: 5, noun, free: true })).toBe(FREE_RERUN_MONEY_LINE_AR);
    expect(moneyLineAr({ reservedPoints: 200, chargedPoints: 120, delivered: 5, noun })).toMatch(/^خُصم/);
    const n = buildMissionNotice("completed", { delivered: 5, planned: 5, chargedPoints: 120, releasedPoints: 80, reservedPoints: 200, hasJob: true, free: true }, "تغريدات عن الغسل الأخضر");
    expect(n.body).toContain(FREE_RERUN_MONEY_LINE_AR);
    expect(n.body).not.toContain("خُصم");
    expect(n.email?.detail1).toBe(FREE_RERUN_MONEY_LINE_AR);

    const plan = pricedTwoStagePlan();
    const mission: any = { id: "msn_free0000001", status: "completed", request_text: "x", plan_public: customerPlanView(plan), plan, reserved_points: 200, charged_points: 120, delivered_units: 5, files: [], summary_ar: null, created_at: "2026-11-09T10:00:00Z", updated_at: "2026-11-09T10:05:00Z" };
    const marker = { id: 1, kind: "call", message_ar: "علامة داخلية", counts: { [FREE_RERUN_MARK]: 1 }, created_at: "2026-11-09T10:00:00Z" };
    const view: any = customerMissionView({ mission, events: [marker], now: Date.parse("2026-11-09T10:06:00Z") });
    expect(JSON.stringify(view)).toContain(FREE_RERUN_MONEY_LINE_AR);
    expect(JSON.stringify(view)).not.toContain("علامة داخلية");
    const paid: any = customerMissionView({ mission, events: [], now: Date.parse("2026-11-09T10:06:00Z") });
    expect(JSON.stringify(paid)).not.toContain(FREE_RERUN_MONEY_LINE_AR);
  });
});

describe("the admin route", () => {
  const post = (body: unknown, id = ME) => POST(new NextRequest(`http://localhost/api/admin/users/${id}/reruns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const get = (id = ME) => GET(new NextRequest(`http://localhost/api/admin/users/${id}/reruns`), { params: Promise.resolve({ id }) });

  it("admins only", async () => {
    state.client = makeClient(db).client;
    state.admin = false;
    expect((await post({ action: "create", sourceMissionId: "msn_source00001" })).status).toBe(403);
  });

  it("create → plan → approve, audited; the customer is told it started; GET lists it", async () => {
    const m = makeClient(db, fakeMoneyClient({ balance: 10_000 }));
    state.client = m.client;
    const created = await post({ action: "create", sourceMissionId: "msn_source00001" });
    expect(created.status).toBe(200);
    const { id } = await created.json();
    await planReady(id);
    const approved = await post({ action: "approve", missionId: id });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toMatchObject({ userId: ME, missionId: id, kind: "started" });
    expect(state.audit.map((a) => a[1])).toEqual(["إعادة تشغيل مجانية لعميل", "اعتماد تشغيل مجاني لعميل"]);
    const list = await (await get()).json();
    expect(list.reruns.map((r: any) => r.id)).toEqual([id]);
    // the source list never offers a free re-run itself
    expect(list.sources.map((s: any) => s.id)).toEqual(["msn_source00001"]);
  });

  it("an action on another customer's mission, or on an ordinary one, is refused", async () => {
    const m = makeClient(db);
    state.client = m.client;
    const created = await (await post({ action: "create", text: "هات تغريدات عن الغسل الأخضر" }, OTHER)).json();
    await planReady(created.id);
    expect((await post({ action: "approve", missionId: created.id }, ME)).status).toBe(404);
    db.seed("missions", [{ id: "msn_plain000002", user_id: ME, created_by: ME, status: "plan_ready", request_text: "عادي", plan: pricedTwoStagePlan() }]);
    expect((await post({ action: "approve", missionId: "msn_plain000002" })).status).toBe(404);
    expect(m.grants).toHaveLength(0);
  });
});
