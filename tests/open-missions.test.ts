import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { AGENT_MAX_OPEN_MISSIONS_PER_USER, AGENT_STUCK_PLANNING_AFTER_MS } from "../src/lib/agentMission/constants";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => (state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) })) };
});

import { GET } from "../src/app/api/missions/route";
import { createCustomerMission, cancelForCustomer } from "../src/lib/agentMission/customerActions";
import { failStuckPlanning, listOpenMissions, openKindOf, openLimitMessageAr, openMissionView } from "../src/lib/agentMission/openMissions";

const ME = "u-1";
const NOW = Date.parse("2026-10-30T15:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
let db: MemoryDb;
const clientOf = (d: MemoryDb) => { const money = fakeMoneyClient(); const client: any = { from: (t: string) => d.from(t), rpc: money.client.rpc }; return { client, money }; };
const m = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id: `msn_${id}`, user_id: ME, status, request_text: `طلب ${id}`, created_at: ago(2 * 3600_000), lease_until: null, job_id: null, ...over });

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }); db = createMemoryDb(); state.client = clientOf(db).client; state.viewer = { userId: ME, isGuest: false, emailVerified: true }; });
afterEach(() => { vi.useRealTimers(); });

describe("one definition of «open»", () => {
  it("the worker's missions count; a question or a plan waiting for the customer never does; a planning mission with no live worker is stuck, not counted", () => {
    expect(openKindOf({ status: "queued" }, NOW)).toBe("worker");
    expect(openKindOf({ status: "planning", lease_until: ago(-2 * MIN) }, NOW)).toBe("worker");
    expect(openKindOf({ status: "planning", lease_until: ago(AGENT_STUCK_PLANNING_AFTER_MS - MIN) }, NOW)).toBe("worker");
    expect(openKindOf({ status: "planning", lease_until: ago(AGENT_STUCK_PLANNING_AFTER_MS + MIN) }, NOW)).toBe("stuck");
    expect(openKindOf({ status: "needs_input" }, NOW)).toBe("waiting_for_customer");
    expect(openKindOf({ status: "plan_ready" }, NOW)).toBe("waiting_for_customer");
    for (const s of ["approved", "executing", "completed", "failed", "unserved", "cancelled"]) expect(openKindOf({ status: s }, NOW)).toBe("closed");
  });

  it("the limit and the list are the same function: for every status, a mission blocks a new request exactly when the list says it blocks", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [["queued", {}], ["planning", { lease_until: ago(-MIN) }], ["planning", { lease_until: ago(30 * MIN) }], ["needs_input", {}], ["plan_ready", {}], ["completed", {}], ["failed", {}], ["cancelled", {}], ["unserved", {}]];
    for (const [status, over] of cases) {
      const d = createMemoryDb();
      d.seed("missions", Array.from({ length: AGENT_MAX_OPEN_MISSIONS_PER_USER }, (_, i) => m(`${status}${i}`, status, over)));
      const { client } = clientOf(d);
      const listed = (await listOpenMissions(client, { userId: ME, now: NOW })).filter((v) => v.blocksNewRequests);
      const accepted = (await createCustomerMission(client, { userId: ME, text: "طلب جديد" })).ok;
      expect(accepted, `${status} ${JSON.stringify(over)}`).toBe(listed.length < AGENT_MAX_OPEN_MISSIONS_PER_USER);
    }
  });
});

describe("a stuck planning mission is ended honestly, never kept as a blocker", () => {
  const stuckRows = () => Array.from({ length: 3 }, (_, i) => m(`stuck${i}`, "planning", { worker_id: "w_dead", lease_until: ago(AGENT_STUCK_PLANNING_AFTER_MS + 5 * MIN) }));

  it("three planning missions with no live lease: the next request is accepted, the three are `failed` with the honest sentence and the admin flag, and no money function or ledger row is touched", async () => {
    db.seed("missions", stuckRows());
    db.seed("credit_ledger", []);
    const { client, money } = clientOf(db);
    const r = await createCustomerMission(client, { userId: ME, text: "طلب جديد بعد التعثر" });
    expect(r).toMatchObject({ ok: true });
    const ended = db.rows("missions").filter((x) => x.id.startsWith("msn_stuck"));
    for (const x of ended) {
      expect(x).toMatchObject({ status: "failed", worker_id: null, lease_until: null });
      expect(x.summary_ar).toContain("من جانبنا");
      expect(x.error).toMatch(/^admin: planning_failed class=internal reason=lease_lost_past_timeout/);
    }
    expect(money.calls).toHaveLength(0);
    expect(db.rows("credit_ledger")).toHaveLength(0);
  });

  it("repeating the end changes nothing (idempotent); a lease renewed meanwhile, a young expired lease, and a mission that has a job are never touched", async () => {
    db.seed("missions", [...stuckRows().slice(0, 1), m("live", "planning", { lease_until: ago(-2 * MIN) }), m("young", "planning", { lease_until: ago(2 * MIN) }), m("withjob", "planning", { lease_until: ago(60 * MIN), job_id: "job_quote_x" })]);
    const { client } = clientOf(db);
    expect(await failStuckPlanning(client, { userId: ME, now: NOW })).toEqual(["msn_stuck0"]);
    const after = JSON.stringify(db.rows("missions"));
    expect(await failStuckPlanning(client, { userId: ME, now: NOW })).toEqual([]);
    expect(JSON.stringify(db.rows("missions"))).toBe(after);
    expect(db.rows("missions").filter((x) => x.status === "planning").map((x) => x.id).sort()).toEqual(["msn_live", "msn_withjob", "msn_young"]);
  });

  it("another customer's stuck mission is not ended by this customer's call", async () => {
    db.seed("missions", [{ ...stuckRows()[0], user_id: "u-2" }]);
    expect(await failStuckPlanning(clientOf(db).client, { userId: ME, now: NOW })).toEqual([]);
    expect(db.rows("missions")[0].status).toBe("planning");
  });
});

describe("the customer sees what blocks them", () => {
  it("at the limit, the refusal names each blocking mission with its state, and carries them; nothing is created or charged", async () => {
    db.seed("missions", [m("a", "queued"), m("b", "planning", { lease_until: ago(-MIN) }), m("c", "queued")]);
    const { client, money } = clientOf(db);
    const r = await createCustomerMission(client, { userId: ME, text: "رابع" });
    expect(r).toMatchObject({ ok: false, status: 429 });
    if (r.ok) return;
    expect(r.blockers).toHaveLength(3);
    for (const x of ["طلب a", "طلب b", "طلب c", "قيد الدراسة الآن", "في الدور", "لن يُخصم شيء", "«طلباتي»"]) expect(r.error).toContain(x);
    expect(db.rows("missions")).toHaveLength(3);
    expect(money.calls).toHaveLength(0);
  });

  it("the questions and plans that wait for the customer are listed with their state, do not block, and can be cancelled", async () => {
    db.seed("missions", [m("q1", "needs_input"), m("q2", "needs_input"), m("p1", "plan_ready"), m("done", "completed", { job_id: "job_quote_y" })]);
    const { client } = clientOf(db);
    const list = await listOpenMissions(client, { userId: ME, now: NOW });
    expect(list.map((v) => [v.id, v.stateAr, v.blocksNewRequests, v.cancellable]).sort()).toEqual([
      ["msn_p1", "الخطة جاهزة وتنتظر اعتمادك", false, true],
      ["msn_q1", "تنتظر إجابتك", false, true],
      ["msn_q2", "تنتظر إجابتك", false, true],
    ]);
    expect(await cancelForCustomer(client, { id: "msn_q1", userId: ME })).toMatchObject({ ok: true });
    expect((await listOpenMissions(client, { userId: ME, now: NOW })).map((v) => v.id)).not.toContain("msn_q1");
  });

  it("GET /api/missions answers with the same list and the conversation that holds each card; a signed-out caller gets 401", async () => {
    db.seed("missions", [m("q1", "needs_input"), m("a", "queued")]);
    db.seed("messages", [{ id: "x1", user_id: ME, role: "assistant", conversation_id: "conv-1", plan: { agentMissionId: "msn_q1" }, created_at: ago(MIN) }]);
    const res = await GET(new NextRequest("http://localhost/api/missions"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.missions.map((x: any) => [x.id, x.blocksNewRequests, x.conversationId]).sort()).toEqual([["msn_a", true, null], ["msn_q1", false, "conv-1"]]);
    state.viewer = null;
    expect((await GET(new NextRequest("http://localhost/api/missions"))).status).toBe(401);
  });

  it("the stuck mission shows its honest state if it is read before it is ended, and cannot be cancelled into a different state", () => {
    const v = openMissionView(m("s", "planning", { lease_until: ago(AGENT_STUCK_PLANNING_AFTER_MS + MIN) }), NOW)!;
    expect(v).toMatchObject({ kind: "stuck", blocksNewRequests: false, cancellable: false });
    expect(v.stateAr).toContain("من جانبنا");
    expect(openLimitMessageAr([v])).toContain("من جانبنا");
  });
});
