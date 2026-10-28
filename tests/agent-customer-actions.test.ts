import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { AGENT_MAX_OPEN_MISSIONS_PER_USER, AGENT_SERVES_CHAT } from "../src/lib/agentMission/constants";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any, gate: { isReady: true, messageAr: "" } as any, busy: { busy: false, messageAr: "" } as any, notices: [] as any[] }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => (state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) })) };
});
vi.mock("../src/lib/server/providerGate", () => ({ getLiveProviderGateStatusFromSettings: vi.fn(async () => state.gate) }));
vi.mock("../src/lib/server/busyState", () => ({ getBusyState: vi.fn(async () => state.busy) }));
vi.mock("../src/lib/server/missionNotify", () => ({ sendMissionNotice: vi.fn(async (_c: unknown, n: any) => { state.notices.push(n); return { inApp: true, email: false }; }) }));

import { GET, POST } from "../src/app/api/missions/[id]/route";
import { GET as fileGET } from "../src/app/api/missions/[id]/file/route";
import { agentChatTurn, AGENT_PRESS_APPROVE_AR } from "../src/lib/agentMission/chatTurn";
import { answerForCustomer, approveForCustomer, cancelForCustomer, createCustomerMission, customerFileLink, loadCustomerMission, readQueue, SIGNUP_TO_APPROVE_AR } from "../src/lib/agentMission/customerActions";

const ME = "u-1";
const OTHER = "u-2";
const ready = (over: Record<string, unknown> = {}) => ({ id: "msn_ready0001", user_id: ME, status: "plan_ready", request_text: "هات منشورات", plan: pricedTwoStagePlan(), plan_public: customerPlanView(pricedTwoStagePlan()), created_at: "2026-10-28T10:00:00Z", ...over });

function makeClient(db: MemoryDb, money = fakeMoneyClient()) {
  const written: string[] = [];
  const client: any = {
    from: (t: string) => { const b = db.from(t); for (const m of ["insert", "update", "upsert"]) { const o = b[m]; b[m] = (...a: any[]) => { written.push(t); return o(...a); }; } return b; },
    rpc: money.client.rpc,
    storage: { from: (bucket: string) => ({ createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.example/${bucket}/${p}` }, error: null }) }) },
  };
  return { client, money, written };
}
const req = (body?: unknown, url = "http://localhost/api/missions/msn_ready0001") => new NextRequest(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const ctx = (id = "msn_ready0001") => ({ params: Promise.resolve({ id }) });

let db: MemoryDb;
beforeEach(() => { db = createMemoryDb(); state.viewer = { userId: ME, isGuest: false, emailVerified: true }; state.gate = { isReady: true, messageAr: "" }; state.busy = { busy: false, messageAr: "" }; state.notices = []; });

describe("the rollback constant", () => {
  it("is ONE constant, on; the chat route hands it to the handler and nothing else decides", async () => {
    expect(AGENT_SERVES_CHAT).toBe(true);
    const route = (await import("node:fs")).readFileSync("src/app/api/chat/route.ts", "utf8");
    expect(route).toContain("chatHandler.agentChat = { enabled: AGENT_SERVES_CHAT }");
    const handler = (await import("node:fs")).readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    expect(handler).toContain("public agentChat: { enabled: boolean } | null = null;");
  });
});

describe("a chat request becomes a mission", () => {
  it("creates a queued mission for the user, trimmed, and refuses empty or oversize text", async () => {
    const { client } = makeClient(db);
    const r = await createCustomerMission(client, { userId: ME, text: "  هات   ٢٠ تغريدة  " });
    expect(r.ok).toBe(true);
    expect(db.rows("missions")[0]).toMatchObject({ user_id: ME, created_by: ME, status: "queued", request_text: "هات ٢٠ تغريدة" });
    expect(await createCustomerMission(client, { userId: ME, text: " " })).toMatchObject({ ok: false, status: 400 });
    expect(await createCustomerMission(client, { userId: ME, text: "x".repeat(4001) })).toMatchObject({ ok: false, status: 400 });
  });

  it("at most AGENT_MAX_OPEN_MISSIONS_PER_USER in the worker's hands; a finished, cancelled or approval-waiting one does not count; and a cap per hour", async () => {
    const { client } = makeClient(db);
    db.seed("missions", [{ id: "msn_done00001", user_id: ME, status: "completed" }, { id: "msn_canc00001", user_id: ME, status: "cancelled" }, ready({ id: "msn_wait00001" })]);
    for (let i = 0; i < AGENT_MAX_OPEN_MISSIONS_PER_USER; i += 1) expect((await createCustomerMission(client, { userId: ME, text: `طلب رقم ${i}` })).ok).toBe(true);
    const over = await createCustomerMission(client, { userId: ME, text: "طلب آخر" });
    expect(over).toMatchObject({ ok: false, status: 429 });
    expect((await createCustomerMission(client, { userId: OTHER, text: "طلب شخص آخر" })).ok).toBe(true);
    // the hourly cap
    const fresh = createMemoryDb();
    fresh.seed("missions", Array.from({ length: 20 }, (_, i) => ({ id: `msn_hour${String(i).padStart(5, "0")}`, user_id: ME, status: "completed", created_at: new Date().toISOString() })));
    expect(await createCustomerMission(makeClient(fresh).client, { userId: ME, text: "طلب بعد عشرين" })).toMatchObject({ ok: false, status: 429 });
  });

  it("the chat turn replaces the unapproved plan above it, keeps the mission id on the assistant message, names the conversation", async () => {
    const { client } = makeClient(db);
    db.seed("missions", [ready()]);
    db.seed("messages", [{ id: "a0", conversation_id: "c1", role: "assistant", plan: { agentMissionId: "msn_ready0001" }, created_at: "2026-10-28T10:00:00Z" }, { id: "u1", conversation_id: "c1", role: "user", request_status: "planning" }, { id: "a1", conversation_id: "c1", role: "assistant", content_ar: "جاري التفكير" }]);
    db.seed("conversations", [{ id: "c1", user_id: ME, title: "محادثة جديدة" }]);
    const r = await agentChatTurn({ sb: client, userId: ME, conversationId: "c1", userMsgId: "u1", assistantMsgId: "a1", message: "هات ٣٠٠ تغريدة عن محمد صلاح", conversationTitle: "محادثة جديدة" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(db.rows("missions").find((m) => m.id === "msn_ready0001")!.status).toBe("cancelled");
    expect(db.rows("missions").find((m) => m.id === r.missionId)).toMatchObject({ status: "queued", user_id: ME });
    expect(db.rows("messages").find((m) => m.id === "a1")).toMatchObject({ plan: { agentMissionId: r.missionId } });
    expect(db.rows("conversations")[0].title).toContain("محمد صلاح");
  });

  it("a typed «موافق» starts nothing and says where to press", async () => {
    const { client, money } = makeClient(db);
    db.seed("messages", [{ id: "a1", conversation_id: "c1", role: "assistant" }, { id: "u1", conversation_id: "c1", role: "user" }]);
    const r = await agentChatTurn({ sb: client, userId: ME, conversationId: "c1", userMsgId: "u1", assistantMsgId: "a1", message: "موافق وابدأ" });
    expect(r).toMatchObject({ ok: false, contentAr: AGENT_PRESS_APPROVE_AR });
    expect(db.rows("missions")).toHaveLength(0);
    expect(money.calls).toHaveLength(0);
  });
});

describe("approval by the customer", () => {
  it("a guest must sign up first; an unverified account must verify; another customer's mission does not exist", async () => {
    db.seed("missions", [ready()]);
    const { client, money } = makeClient(db);
    expect(await approveForCustomer(client, { id: "msn_ready0001", userId: ME, isGuest: true, emailVerified: false })).toMatchObject({ ok: false, status: 401, error: SIGNUP_TO_APPROVE_AR });
    expect(await approveForCustomer(client, { id: "msn_ready0001", userId: ME, isGuest: false, emailVerified: false })).toMatchObject({ ok: false, status: 403 });
    expect(await approveForCustomer(client, { id: "msn_ready0001", userId: OTHER, isGuest: false, emailVerified: true })).toMatchObject({ ok: false, status: 404 });
    expect(money.calls).toHaveLength(0);
    expect(db.rows("missions")[0].status).toBe("plan_ready");
  });

  it("reserves through the existing functions ONLY, price and hold computed by code, no money table written by hand; a double click reserves once", async () => {
    db.seed("missions", [ready()]);
    const { client, money, written } = makeClient(db);
    const first = await approveForCustomer(client, { id: "msn_ready0001", userId: ME, isGuest: false, emailVerified: true });
    expect(first.ok).toBe(true);
    const again = await approveForCustomer(client, { id: "msn_ready0001", userId: ME, isGuest: false, emailVerified: true });
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(money.calls.map((c) => c.name)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
    expect(money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    const row = db.rows("missions")[0];
    expect(row).toMatchObject({ status: "approved", approved_by: ME });
    expect(row.reserved_points).toBe(pricedTwoStagePlan().price.reservePoints);
    for (const t of written) expect(["missions", "mission_events"]).toContain(t);
  });

  it("an insufficient balance says so in the customer's words, holds nothing and keeps the plan", async () => {
    db.seed("missions", [ready()]);
    const { client, money } = makeClient(db, fakeMoneyClient({ balance: 2 }));
    const r = await approveForCustomer(client, { id: "msn_ready0001", userId: ME, isGuest: false, emailVerified: true });
    expect(r).toMatchObject({ ok: false, status: 402 });
    expect((r as any).error).toContain("اشحن رصيدك");
    expect((r as any).error).not.toContain("الاختبار");
    expect(db.rows("missions")[0].status).toBe("plan_ready");
    expect(money.ledger.filter((l) => l.type === "reserve")).toHaveLength(0);
  });

  it("the route: checks the gate, the busy state and the user's limit before anything is reserved, then tells the customer once that the page may be closed", async () => {
    db.seed("missions", [ready()]);
    const { client, money } = makeClient(db);
    state.client = client;
    state.gate = { isReady: false, messageAr: "الخدمة متوقفة الآن." };
    let res = await POST(req({ action: "approve" }), ctx());
    expect(res.status).toBe(503);
    expect(money.calls).toHaveLength(0);
    state.gate = { isReady: true, messageAr: "" };
    state.busy = { busy: true, messageAr: "الضغط عالٍ الآن." };
    res = await POST(req({ action: "approve" }), ctx());
    expect(res.status).toBe(503);
    expect(money.calls).toHaveLength(0);
    state.busy = { busy: false, messageAr: "" };
    res = await POST(req({ action: "approve" }), ctx());
    expect(res.status).toBe(200);
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toMatchObject({ userId: ME, missionId: "msn_ready0001", kind: "started" });
  });

  it("a guest on the route is told to sign up and nothing is reserved", async () => {
    db.seed("missions", [ready({ user_id: "guest-1" })]);
    const { client, money } = makeClient(db);
    state.client = client;
    state.viewer = { userId: "guest-1", isGuest: true, emailVerified: false };
    const res = await POST(req({ action: "approve" }), ctx());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe(SIGNUP_TO_APPROVE_AR);
    expect(money.calls).toHaveLength(0);
  });
});

describe("cancel, edit, answer, read and files: only the owner's", () => {
  it("cancel and edit work before approval and return the words; not after", async () => {
    db.seed("missions", [ready(), ready({ id: "msn_run000001", status: "executing" })]);
    const { client } = makeClient(db);
    state.client = client;
    const edit = await POST(req({ action: "edit" }), ctx());
    expect(await edit.json()).toMatchObject({ success: true, requestText: "هات منشورات" });
    expect(db.rows("missions")[0].status).toBe("cancelled");
    expect((await POST(req({ action: "cancel" }, "http://localhost/x"), ctx("msn_run000001"))).status).toBe(409);
    expect(await cancelForCustomer(client, { id: "msn_ready0001", userId: OTHER })).toMatchObject({ ok: false, status: 404 });
  });

  it("answer re-queues the mission for planning", async () => {
    db.seed("missions", [{ id: "msn_ask0000001", user_id: ME, status: "needs_input", question_ar: "أي بلد؟", created_at: "2026-10-28T10:00:00Z" }]);
    const { client } = makeClient(db);
    expect(await answerForCustomer(client, { id: "msn_ask0000001", userId: OTHER, text: "مصر" })).toMatchObject({ ok: false, status: 404 });
    expect((await answerForCustomer(client, { id: "msn_ask0000001", userId: ME, text: "مصر" })).ok).toBe(true);
    expect(db.rows("missions")[0]).toMatchObject({ status: "queued", answer_text: "مصر", question_ar: null });
  });

  it("reads one mission as the card needs it: no plan internals, no error, no model cost; someone else's mission is not found", async () => {
    db.seed("missions", [ready({ error: "boom secret", planning_llm_usd: 0.004, worker_id: "w_1" })]);
    db.seed("mission_events", [{ id: 1, mission_id: "msn_ready0001", kind: "plan", message_ar: "جهّز الوكيل خطة لمهمتك.", counts: { stages: 2 }, created_at: "2026-10-28T10:01:00Z" }]);
    db.seed("mission_calls", [{ id: "msn_ready0001:call_0001", mission_id: "msn_ready0001", status: "ok" }, { id: "msn_ready0001:call_0002", mission_id: "msn_ready0001", status: "refused" }]);
    const { client } = makeClient(db);
    state.client = client;
    const res = await GET(req(undefined), ctx());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.view.phase).toBe("plan");
    expect(JSON.stringify(body)).not.toMatch(/boom secret|llm_usd|worker_id|x\.x\.search|anyapi|endpoint|measured/);
    state.viewer = { userId: OTHER, isGuest: false, emailVerified: true };
    expect((await GET(req(undefined), ctx())).status).toBe(404);
    expect((await GET(req(undefined, "http://localhost/api/missions/bad"), ctx("bad"))).status).toBe(400);
  });

  it("the queue position counts the missions waiting before this one and the missions running now", async () => {
    db.seed("missions", [
      { id: "msn_early0001", user_id: OTHER, status: "queued", created_at: "2026-10-28T09:00:00Z" },
      { id: "msn_early0002", user_id: OTHER, status: "approved", created_at: "2026-10-28T09:30:00Z" },
      { id: "msn_run000002", user_id: OTHER, status: "executing", lease_until: "2026-10-28T11:00:00Z", created_at: "2026-10-28T08:00:00Z" },
      { id: "msn_mine00001", user_id: ME, status: "queued", created_at: "2026-10-28T10:00:00Z" },
      { id: "msn_late00001", user_id: OTHER, status: "queued", created_at: "2026-10-28T10:30:00Z" },
    ]);
    db.seed("agent_worker_heartbeat", [{ worker_id: "w_1", beat_at: "2026-10-28T10:00:40Z" }]);
    const { client } = makeClient(db);
    const q = await readQueue(client, { id: "msn_mine00001", created_at: "2026-10-28T10:00:00Z", status: "queued" }, Date.parse("2026-10-28T10:00:50Z"));
    expect(q).toEqual({ ahead: 2, running: 1, workerAlive: true });
    expect((await readQueue(client, { id: "msn_mine00001", created_at: "2026-10-28T10:00:00Z", status: "queued" }, Date.parse("2026-10-28T10:10:00Z"))).workerAlive).toBe(false);
  });

  it("the file link is the owner's, and only for a file the mission has", async () => {
    db.seed("missions", [ready({ status: "completed", files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }] })]);
    const { client } = makeClient(db);
    state.client = client;
    expect(await customerFileLink(client, { id: "msn_ready0001", userId: OTHER, name: "result.xlsx" })).toMatchObject({ ok: false, status: 404 });
    expect(await customerFileLink(client, { id: "msn_ready0001", userId: ME, name: "result.csv" })).toMatchObject({ ok: false, status: 404 });
    const res = await fileGET(req(undefined, "http://localhost/api/missions/msn_ready0001/file?name=result.xlsx"), ctx());
    expect(await res.json()).toMatchObject({ success: true, url: "https://signed.example/agent-missions/msn_ready0001/result/result.xlsx" });
    expect((await fileGET(req(undefined, "http://localhost/f?name=../../x"), ctx())).status).toBe(400);
  });
});

describe("loading a mission is read only", () => {
  it("writes nothing", async () => {
    db.seed("missions", [ready()]);
    const { client, written } = makeClient(db);
    await loadCustomerMission(client, { id: "msn_ready0001", userId: ME });
    expect(written).toEqual([]);
  });
});
