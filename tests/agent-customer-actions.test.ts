import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient, withAtomicMissionApproval } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { approveWithRecovery } from "../src/lib/missionApprove";
import { settleMission } from "../src/lib/agentMission/lifecycle";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { customerPlanView, validateAndPricePlan } from "../src/lib/agentMission/plan";
import { AGENT_MAX_OPEN_MISSIONS_PER_USER, AGENT_SERVES_CHAT } from "../src/lib/agentMission/constants";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any, gate: { isReady: true, messageAr: "" } as any, duringGate: undefined as (() => Promise<void>) | undefined, busy: { busy: false, messageAr: "" } as any, notices: [] as any[] }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => (state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) })) };
});
vi.mock("../src/lib/server/providerGate", () => ({ getLiveProviderGateStatusFromSettings: vi.fn(async () => { await state.duringGate?.(); return state.gate; }) }));
vi.mock("../src/lib/server/busyState", () => ({ getBusyState: vi.fn(async () => state.busy) }));
vi.mock("../src/lib/server/missionNotify", () => ({ sendMissionNotice: vi.fn(async (_c: unknown, n: any) => { state.notices.push(n); return { inApp: true, email: false }; }) }));

import { GET, POST } from "../src/app/api/missions/[id]/route";
import { GET as fileGET } from "../src/app/api/missions/[id]/file/route";
import { agentChatTurn, AGENT_PRESS_APPROVE_AR } from "../src/lib/agentMission/chatTurn";
import { answerForCustomer, approveForCustomer, cancelForCustomer, createCustomerMission, customerFileLink, editPlanForCustomer, loadCustomerMission, readQueue, SIGNUP_TO_APPROVE_AR } from "../src/lib/agentMission/customerActions";

const ME = "u-1";
const OTHER = "u-2";
const ready = (over: Record<string, unknown> = {}) => ({ id: "msn_ready0001", user_id: ME, status: "plan_ready", request_text: "هات منشورات", plan: pricedTwoStagePlan(), plan_public: customerPlanView(pricedTwoStagePlan()), created_at: "2026-10-28T10:00:00Z", updated_at: "2026-11-21T06:00:00.000Z", ...over });

function makeClient(db: MemoryDb, money = fakeMoneyClient()) {
  const written: string[] = [];
  const atomic = withAtomicMissionApproval(db, money);
  const client: any = {
    from: (t: string) => { const b = db.from(t); for (const m of ["insert", "update", "upsert"]) { const o = b[m]; b[m] = (...a: any[]) => { written.push(t); return o(...a); }; } return b; },
    rpc: atomic.rpc,
    storage: { from: (bucket: string) => ({ createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.example/${bucket}/${p}` }, error: null }) }) },
  };
  return { client, money, written, atomic };
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

describe("approval of the displayed plan (NEW-ISSUES #13)", () => {
  const timestamp = "2026-11-21T06:00:00.000Z";

  beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", ""));
  afterEach(() => {
    state.duringGate = undefined;
    vi.unstubAllEnvs();
  });

  function world() {
    const checked = validateAndPricePlan({
      summary_ar: "ستحصل على شركات المقاولات.",
      stages: [{ key: "companies", title_ar: "الشركات", endpoint_id: "treg.aiark.company.search", expected_rows: 20, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "created_at", title_ar: "التاريخ" }], sample_rows: [{ name: "شركة مثال", created_at: timestamp }], measured_by: ["call_0001"], filters: [{ kind: "period", days: 30 }] }],
    }, {
      call: () => ({ id: "call_0001", endpointId: "treg.aiark.company.search", ok: true, costUsd: 0.05, rows: 10 }),
      evidenceText: () => `شركة مثال ${timestamp}`,
      endpointAllowed: () => true,
    });
    if (!checked.ok) throw new Error(checked.issues.join("; "));
    const { client, money, atomic } = makeClient(db, fakeMoneyClient({ balance: 3_000 }));
    state.client = client;
    const mission = (over: Record<string, unknown> = {}) => ready({ plan: checked.plan, plan_public: customerPlanView(checked.plan), updated_at: timestamp, ...over });
    db.seed("missions", [mission()]);
    const readCard = async (id = "msn_ready0001") => (await GET(req(), ctx(id))).json();
    const submit = (approvalVersion: unknown, id = "msn_ready0001") => POST(req({ action: "approve", approvalVersion }), ctx(id));
    const reserves = () => money.ledger.filter((r) => r.type === "reserve").map((r) => -r.delta);
    const assertNoMoney = () => {
      expect(reserves()).toEqual([]);
      expect(money.quotes.size).toBe(0);
      expect(money.jobs.size).toBe(0);
      expect(money.ledger.map((r) => r.type)).toEqual(["topup"]);
      expect(state.notices).toHaveLength(0);
    };
    return { client, money, atomic, mission, readCard, submit, reserves, assertNoMoney };
  }

  const holdFact = (card: any) => card.view.priceFacts.find((f: any) => f.labelAr === "حجز مؤقت")?.valueAr;

  it.each([
    { when: "before POST", amount: 1348 },
    { when: "during precheck", amount: 1348 },
    { when: "same timestamp and price", amount: 715 },
  ])("refuses an edit $when and accepts only a fresh click at the refreshed price", async ({ when, amount }) => {
    const f = world();
    const shown = await f.readCard();
    expect(holdFact(shown)).toContain("٧١٥");
    const edit = async () => {
      const edits = when === "same timestamp and price"
        ? { stages: [{ key: "companies", filters: [{ kind: "period", enabled: true, days: 7 }] }] }
        : { count: 40 };
      expect(await editPlanForCustomer(f.client, { id: "msn_ready0001", userId: ME, edits })).toMatchObject({ ok: true });
      if (when === "same timestamp and price") db.rows("missions")[0].updated_at = timestamp;
    };
    if (when === "before POST") await edit();
    else state.duringGate = edit;

    const refused = await f.submit(shown.view.approvalVersion);
    state.duringGate = undefined;
    expect({ status: refused.status, reserves: f.reserves() }).toEqual({ status: 409, reserves: [] });
    const body = await refused.json();
    expect(body).toMatchObject({ success: false, code: "stale_plan" });
    expect(checkCustomerText(body.error).issues).toEqual([]);
    f.assertNoMoney();
    expect(db.rows("missions")[0].status).toBe("plan_ready");

    const newCard = await f.readCard();
    expect(newCard.view.approvalVersion.planHash).not.toBe(shown.view.approvalVersion.planHash);
    if (when === "same timestamp and price") expect(newCard.view.approvalVersion.updatedAt).toBe(shown.view.approvalVersion.updatedAt);
    expect(holdFact(newCard)).toContain(amount === 715 ? "٧١٥" : "١٬٣٤٨");
    expect((await f.submit(newCard.view.approvalVersion)).status).toBe(200);
    expect(f.reserves()).toEqual([amount]);
    expect(f.money.quotes.size).toBe(1);
    expect(f.money.jobs.size).toBe(1);
  });

  it("refuses missing or other-mission versions, then holds the unchanged displayed amount once on overlapping clicks", async () => {
    const f = world();
    const second = "msn_other0002";
    db.rows("missions").push(f.mission({ id: second }));
    const shown = await f.readCard();
    const wrong = await f.readCard(second);
    expect(holdFact(shown)).toContain("٧١٥");
    for (const version of [undefined, wrong.view.approvalVersion]) {
      const response = await f.submit(version);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "stale_plan" });
    }
    f.assertNoMoney();

    const clicks = await Promise.all([f.submit(shown.view.approvalVersion), f.submit(shown.view.approvalVersion)]);
    expect(clicks.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(f.reserves()).toEqual([715]);
    expect(f.money.quotes.size).toBe(1);
    expect(f.money.jobs.size).toBe(1);
    expect(state.notices).toHaveLength(1);
    const accepted = await clicks.find((r) => r.ok)!.json();
    expect(db.rows("missions")[0]).toMatchObject({ status: "approved", job_id: accepted.jobId, quote_id: [...f.money.quotes.keys()][0] });
  });

  it.each(["database reply", "browser reply"])("recovers the committed job after losing the %s", async (boundary) => {
    const f = world();
    const shown = await f.readCard();
    if (boundary === "database reply") f.atomic.dropNextReply();
    let discardReply = boundary === "browser reply";
    const recovery = await approveWithRecovery({
      post: async () => {
        const response = await f.submit(shown.view.approvalVersion);
        if (discardReply) { discardReply = false; return null; }
        return { status: response.status, body: await response.json() };
      },
      isApproved: async () => (await f.readCard()).view.approvalState === "confirmed",
      sleep: async () => {},
      refreshSession: async () => {},
    });
    expect(recovery).toEqual({ ok: true, viaRead: true });
    expect(f.reserves()).toEqual([715]);
    expect(f.money.quotes.size).toBe(1);
    const row = db.rows("missions")[0];
    expect([...f.money.jobs.keys()]).toEqual([row.job_id]);
    expect([...f.money.quotes.keys()]).toEqual([row.quote_id]);
    expect((await f.readCard()).view).toMatchObject({ phase: "running", approvalState: "confirmed" });
    expect((await f.submit(shown.view.approvalVersion)).status).toBe(409);
    expect(f.reserves()).toEqual([715]);
    expect(state.notices).toHaveLength(boundary === "database reply" ? 0 : 1);
  });

  it("leaves no hold or false success on link failure and permits a new mission after settlement", async () => {
    const f = world();
    const original = await f.readCard();
    f.atomic.failNextLink();
    const failed = await f.submit(original.view.approvalVersion);
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ success: false });
    f.assertNoMoney();
    expect((await f.readCard()).view.approvalState).toBe("unapproved");
    const retried = await f.submit(original.view.approvalVersion);
    expect(retried.status).toBe(200);
    const { jobId } = await retried.json();
    const row = db.rows("missions")[0];
    const settled = await settleMission(f.client, { jobId, deliveredUnits: 0, unitPricePoints: row.unit_price_points, reservedPoints: 715, costUsd: 0, resultPath: null });
    expect(settled).toMatchObject({ ok: true, releasedPoints: 715, chargedPoints: 0 });
    row.status = "unserved";
    const created = await createCustomerMission(f.client, { userId: ME, text: "هات شركات جديدة" });
    if (!created.ok) throw new Error(created.error);
    Object.assign(db.rows("missions").find((m) => m.id === created.id)!, f.mission({ id: created.id }));
    expect((await f.submit((await f.readCard(created.id)).view.approvalVersion, created.id)).status).toBe(200);
    expect(f.reserves()).toEqual([715, 715]);
    expect(f.money.balance()).toBe(2_285);
  });

  it("labels an understood claim rollback as no hold and keeps an unlinked legacy approval pending", async () => {
    const f = world();
    const shown = await f.readCard();
    f.atomic.refuseNextClaim();
    const refused = await f.submit(shown.view.approvalVersion);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "تعذّر بدء المهمة الآن؛ لم يُحجز أي رصيد." });
    f.assertNoMoney();
    Object.assign(db.rows("missions")[0], { status: "approved", job_id: null, quote_id: null });
    expect((await f.readCard()).view.approvalState).toBe("pending");
    expect((await f.submit(shown.view.approvalVersion)).status).toBe(409);
    f.assertNoMoney();
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
    const view = await loadCustomerMission(client, { id: "msn_ready0001", userId: ME });
    if (!view.ok) throw new Error(view.error);
    const first = await approveForCustomer(client, { id: "msn_ready0001", userId: ME, isGuest: false, emailVerified: true, approvalVersion: view.view.approvalVersion });
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
    const view = await loadCustomerMission(client, { id: "msn_ready0001", userId: ME });
    if (!view.ok) throw new Error(view.error);
    const r = await approveForCustomer(client, { id: "msn_ready0001", userId: ME, isGuest: false, emailVerified: true, approvalVersion: view.view.approvalVersion });
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
    const card = await (await GET(req(), ctx())).json();
    const click = { action: "approve", approvalVersion: card.view.approvalVersion };
    let res = await POST(req(click), ctx());
    expect(res.status).toBe(503);
    expect(money.calls).toHaveLength(0);
    state.gate = { isReady: true, messageAr: "" };
    state.busy = { busy: true, messageAr: "الضغط عالٍ الآن." };
    res = await POST(req(click), ctx());
    expect(res.status).toBe(503);
    expect(money.calls).toHaveLength(0);
    state.busy = { busy: false, messageAr: "" };
    res = await POST(req(click), ctx());
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
    // CHANGED (round 32): a CSV is no longer redirected to the Excel. The customer's CSV is built from the Excel by `customerCsvFile` (tests/round32-customer-csv.test.ts); a signed link asked for by a CSV's name is an invalid request, never a silent Excel
    expect(await customerFileLink(client, { id: "msn_ready0001", userId: ME, name: "result.csv" })).toMatchObject({ ok: false, status: 400 });
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
