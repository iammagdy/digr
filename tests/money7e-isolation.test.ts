import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectingDb, type ProjectingDb } from "./helpers/projectingDb";
import { addonRowOf, reviewPricing, USER } from "./helpers/addonWorld";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { fakeChatModel } from "./helpers/fakeChatModel";
import { AGENT_MAX_MISSIONS_PER_HOUR, AGENT_TEST_ACCOUNT_EMAIL } from "../src/lib/agentMission/constants";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { approveForCustomer, answerForCustomer, cancelForCustomer, createCustomerMission, customerFileLink, editPlanForCustomer, loadCustomerMission, smallerVersionForCustomer } from "../src/lib/agentMission/customerActions";
import { answerQuestion, approvePlan, cancelMission, loadDetail, loadOverview } from "../src/lib/agentMission/adminActions";
import { listOpenMissions } from "../src/lib/agentMission/openMissions";
import { expireWaitingMissions, missionsToExpire } from "../src/lib/requests/expiry";
import { buildRequestIndex } from "../src/lib/requests/buildIndex";
import { agentChatTurn } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { listMethodologyMissions } from "../src/lib/agentMission/methodology/missions";
import { currentReviewRequest, cancelReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import { buildAddonRow } from "../src/lib/agentMission/stage4/addonRow";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { ADDON_MARKER_COLUMN, hasAddonMarker } from "../src/lib/agentMission/addonMarker";
import { isAddonMission } from "../agent/src/stage4/runAddon";

/**
 * MONEY PR 7e, PHASE 2B-2 TASK 4: A REVIEW ADD-ON IS NOT A RESEARCH MISSION (docs/MONEY-PR-7A.md section 17).
 * A waiting review request is a `plan_ready` row of the `missions` table whose `plan` carries the `addon` key. Every ordinary reader of that table (the open-missions list, «طلباتي», the expiry, the per-hour limit, the customer's and the admin's actions, the chat's
 * open request and replace rule) was written before such rows existed. Each is run here against ONE table that holds ordinary missions AND add-on rows (a valid one and a malformed one that still carries the key: an unknown add-on is never an ordinary mission),
 * on a STRICT fake database that returns only the columns a query asks for. The add-on's own endpoint (`reviewRequest.ts`) must keep seeing the row. No money function, ledger, job or storage object is touched by anything here, and nothing calls a provider.
 */
const ME = USER;
const OTHER = "22222222-2222-4222-8222-222222222222";
const DELIVERED = "msn_5851abc92a1e6645a9cd";
const NOW = Date.parse("2026-11-04T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;
const ADDON_ID = addonRowOf({ of: DELIVERED, kind: "review", baseVersion: 1, pricing: reviewPricing(1000) }).id;

const ordinary = (id: string, status: string, over: Record<string, unknown> = {}) => {
  const plan = status === "plan_ready" ? pricedTwoStagePlan() : null;
  return { id: `msn_${id}`, user_id: ME, status, request_text: `طلب ${id}`, created_at: ago(2 * H), lease_until: null, job_id: null, question_ar: null, files: null, plan, plan_public: plan ? customerPlanView(plan) : null, delivered_units: null, ...over };
};
const addon = (over: Record<string, unknown> = {}) => ({ ...addonRowOf({ of: DELIVERED, kind: "review", baseVersion: 1, status: "plan_ready", userId: ME, pricing: reviewPricing(1000) }), created_at: ago(H), lease_until: null, question_ar: null, files: null, plan_public: null, delivered_units: null, ...over });
const MALFORMED = { id: "msn_malformed000000000", user_id: ME, status: "plan_ready", request_text: "طلب غير مفهوم على ملف", created_at: ago(H), lease_until: null, job_id: null, question_ar: null, files: null, plan: { addon: { nonsense: true } }, plan_public: null, delivered_units: null };
const DELIVERED_ROW = ordinary("delivered000000000", "completed", { id: DELIVERED, delivered_units: 60, job_id: "job_1" });

let db: ProjectingDb;
const seedMixed = () => db.seed("missions", [DELIVERED_ROW, ordinary("ready0000000001", "plan_ready"), addon(), MALFORMED]);
const row = (id: string) => db.rows("missions").find((r) => r.id === id)!;
const snapshot = () => JSON.stringify(db.rows("missions"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("a real call was attempted"); }));
  db = projectingDb({ jobs: [], messages: [], conversations: [], mission_events: [], mission_calls: [], agent_heartbeat: [], plans_quotes: [], credit_ledger: [], profiles: [{ id: ME, email: AGENT_TEST_ACCOUNT_EMAIL }] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setChatModelForTesting(null); });

describe("the ONE rule that says a row is an add-on", () => {
  it("is the worker's own rule: a plan that carries the `addon` key, valid or not (an unknown add-on is never an ordinary mission); it needs nothing from the money side", () => {
    expect(hasAddonMarker({ plan: addon().plan })).toBe(true);
    expect(hasAddonMarker({ plan: MALFORMED.plan })).toBe(true);
    expect(hasAddonMarker({ plan: { addon: null } })).toBe(true);
    expect(hasAddonMarker({ plan: pricedTwoStagePlan() })).toBe(false);
    for (const plan of [null, undefined, [], "addon", 7, {}, { stages: [] }, { addons: {} }]) expect(hasAddonMarker({ plan }), JSON.stringify(plan)).toBe(false);
    for (const row of [null, undefined, 7, "x", []]) expect(hasAddonMarker(row as any)).toBe(false);
    // the column a select asks for gives the same answer
    expect(hasAddonMarker({ addon: { v: 1 } })).toBe(true);
    expect(hasAddonMarker({ addon: null })).toBe(false);
    expect(hasAddonMarker({ id: "msn_x" })).toBe(false);
    expect(ADDON_MARKER_COLUMN).toBe("addon:plan->addon");
  });
  it("agrees with the worker's dispatch on every plan: what the worker runs as an add-on is what the site refuses to treat as a mission", () => {
    const plans: unknown[] = [addon().plan, MALFORMED.plan, { addon: null }, pricedTwoStagePlan(), null, undefined, {}, { addons: 1 }, [], buildAddonRow({ userId: ME, of: DELIVERED, kind: "review", baseVersion: 2, attempt: 3, request: { kind: "review" }, pricing: reviewPricing(900), requestText: "طلب مراجعة" }).plan];
    for (const plan of plans) expect(hasAddonMarker({ plan }), JSON.stringify(plan)).toBe(isAddonMission({ plan }));
  });
  it("has no import at all, so any reader may use it without reaching the money side", () => {
    expect(readFileSync("src/lib/agentMission/addonMarker.ts", "utf8")).not.toMatch(/^\s*import\s/m);
  });
});

describe("the customer's lists never show a review request as a research mission", () => {
  it("the open-missions list shows the ordinary waiting plan and neither add-on row, and what the limit counts is unchanged", async () => {
    seedMixed();
    const list = await listOpenMissions(db, { userId: ME, now: NOW });
    expect(list.map((m) => m.id)).toEqual(["msn_ready0000000001"]);
    expect(db.moneyTouched()).toEqual([]);
  });
  it("«طلباتي» lists the ordinary waiting plan only: an add-on is not in the pending block, the running tab, the ended tab or any count", async () => {
    db.seed("missions", [DELIVERED_ROW, ordinary("ready0000000001", "plan_ready"), ordinary("queued000000001", "queued"), addon(), MALFORMED,
      addon({ id: "msn_addonended00000001", status: "cancelled" }), addon({ id: "msn_addonrunning000001", status: "approved" })]);
    const all = await buildRequestIndex(db, { userId: ME, tab: "all", now: NOW });
    expect(all.pending.map((p) => p.id)).toEqual(["msn_ready0000000001"]);
    const ids = all.rows.map((r) => r.id);
    expect(ids).toContain("msn_queued000000001");
    for (const bad of [ADDON_ID, MALFORMED.id, "msn_addonended00000001", "msn_addonrunning000001"]) expect(ids, bad).not.toContain(bad);
    for (const tab of ["running", "ended"] as const) expect((await buildRequestIndex(db, { userId: ME, tab, now: NOW })).rows.map((r) => r.id), tab).not.toContain("msn_addonended00000001");
    // the counts are the ordinary missions only: the completed delivered one has no job row in this fake, so it is not a request here; one waiting plan + one queued mission
    expect(all.counts.all).toBe(2);
    expect(db.moneyTouched()).toEqual([]);
  });
  it("an add-on does not use up the customer's per-hour limit of new research missions", async () => {
    db.seed("missions", Array.from({ length: AGENT_MAX_MISSIONS_PER_HOUR }, (_, i) => addon({ id: `msn_addonhour${String(i).padStart(8, "0")}`, status: "cancelled", created_at: ago(10 * 60_000) })));
    const r = await createCustomerMission(db, { userId: ME, text: "هات تعليقات منشور" });
    expect(r.ok).toBe(true);
    expect(db.rows("missions").filter((x) => x.status === "queued")).toHaveLength(1);
  });
  it("the per-hour limit still counts ordinary missions exactly as before", async () => {
    db.seed("missions", Array.from({ length: AGENT_MAX_MISSIONS_PER_HOUR }, (_, i) => ordinary(`hour${String(i).padStart(10, "0")}`, "completed", { created_at: ago(10 * 60_000) })));
    expect(await createCustomerMission(db, { userId: ME, text: "هات تعليقات منشور" })).toMatchObject({ ok: false, status: 429 });
  });
  it("a mix of ordinary and add-on rows at the limit: the ordinary ones decide, the add-ons are not counted", async () => {
    db.seed("missions", [
      ...Array.from({ length: AGENT_MAX_MISSIONS_PER_HOUR - 1 }, (_, i) => ordinary(`mixa${String(i).padStart(10, "0")}`, "completed", { created_at: ago(10 * 60_000) })),
      ...Array.from({ length: 5 }, (_, i) => addon({ id: `msn_addonmix${String(i).padStart(9, "0")}`, status: "cancelled", created_at: ago(10 * 60_000) })),
    ]);
    expect((await createCustomerMission(db, { userId: ME, text: "هات تعليقات منشور" })).ok).toBe(true);
  });
});

describe("the expiry of unanswered plans leaves a review request alone and is not pushed by it", () => {
  it("an add-on older than 72 hours is not expired by the age rule, and an ordinary plan that old still is", async () => {
    db.seed("missions", [ordinary("old00000000001", "plan_ready", { created_at: ago(80 * H) }), addon({ created_at: ago(80 * H) }), { ...MALFORMED, created_at: ago(80 * H) }]);
    const ended = await expireWaitingMissions(db, { userId: ME, now: NOW });
    expect(ended).toEqual(["msn_old00000000001"]);
    expect(row(ADDON_ID).status).toBe("plan_ready");
    expect(row(MALFORMED.id).status).toBe("plan_ready");
  });
  it("five ordinary waiting plans and a newer add-on: nothing is expired (the add-on does not take one of the five places)", async () => {
    db.seed("missions", [...Array.from({ length: 5 }, (_, i) => ordinary(`wait${i}000000000`, "plan_ready", { created_at: ago((10 + i) * 3_600_00) })), addon({ created_at: ago(1_000) })]);
    expect(await expireWaitingMissions(db, { userId: ME, now: NOW })).toEqual([]);
    expect(db.rows("missions").filter((r) => r.status === "cancelled")).toHaveLength(0);
  });
  it("the cap still expires the oldest ordinary plan beyond five, exactly as before", async () => {
    db.seed("missions", Array.from({ length: 6 }, (_, i) => ordinary(`cap${i}0000000000`, "plan_ready", { created_at: ago((10 + i) * 3_600_00) })));
    expect(await expireWaitingMissions(db, { userId: ME, now: NOW })).toEqual(["msn_cap50000000000"]);
  });
  it("the pure rule ignores rows that carry the marker, by plan or by the selected column", () => {
    const rows = [{ id: "a", status: "plan_ready", created_at: ago(100 * H), plan: { addon: {} } }, { id: "b", status: "plan_ready", created_at: ago(100 * H), addon: { v: 1 } }, { id: "c", status: "plan_ready", created_at: ago(100 * H) }];
    expect(missionsToExpire(rows as any, NOW).map((r) => r.id)).toEqual(["c"]);
  });
});

describe("the customer's own actions on a mission refuse a review request, and change nothing", () => {
  const ADDON_ROWS = [ADDON_ID, MALFORMED.id];
  it("approval answers 409 before any money function, for a valid and a malformed add-on", async () => {
    seedMixed();
    const before = snapshot();
    for (const id of ADDON_ROWS) {
      const r = await approveForCustomer(db, { id, userId: ME, isGuest: false, emailVerified: true });
      expect(r, id).toMatchObject({ ok: false, status: 409 });
    }
    expect(snapshot()).toBe(before);
    expect(db.moneyTouched()).toEqual([]);
  });
  it("the ordinary cancel does not cancel it (its own cancel is the only way: it checks the request is unpaid and never approved)", async () => {
    seedMixed();
    const before = snapshot();
    for (const id of ADDON_ROWS) {
      const r = await cancelForCustomer(db, { id, userId: ME });
      expect(r, id).toMatchObject({ ok: false, status: 409 });
    }
    expect(snapshot()).toBe(before);
    expect(db.log.filter((l) => l.op === "update")).toEqual([]);
  });
  it("the plan edit and the smaller version refuse it instead of crashing on a plan that has no price", async () => {
    seedMixed();
    const before = snapshot();
    for (const id of ADDON_ROWS) {
      expect(await editPlanForCustomer(db, { id, userId: ME, edits: { count: 5 } }), id).toMatchObject({ ok: false, status: 409 });
      expect(await smallerVersionForCustomer(db, { id, userId: ME }), id).toMatchObject({ ok: false, status: 409 });
    }
    expect(snapshot()).toBe(before);
  });
  it("an answer is not accepted for it (it would put the row back in the planner's queue)", async () => {
    db.seed("missions", [addon({ status: "needs_input" })]);
    const before = snapshot();
    expect(await answerForCustomer(db, { id: ADDON_ID, userId: ME, text: "الإجابة" })).toMatchObject({ ok: false, status: 409 });
    expect(snapshot()).toBe(before);
  });
  it("the mission card endpoint and the file link do not serve it as a mission", async () => {
    db.seed("missions", [addon({ files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }] }), MALFORMED]);
    for (const id of ADDON_ROWS) {
      expect(await loadCustomerMission(db, { id, userId: ME, now: NOW }), id).toMatchObject({ ok: false, status: 404 });
      expect(await customerFileLink(db, { id, userId: ME, name: "result.xlsx" }), id).toMatchObject({ ok: false, status: 404 });
    }
    expect(db.storageCalls).toEqual([]);
  });
  it("every refusal is customer-safe Arabic", async () => {
    seedMixed();
    const r = await cancelForCustomer(db, { id: ADDON_ID, userId: ME });
    const e = await editPlanForCustomer(db, { id: ADDON_ID, userId: ME, edits: {} });
    for (const x of [r, e]) { expect(x.ok).toBe(false); if (!x.ok) expect(checkCustomerText(x.error).issues, x.error).toEqual([]); }
  });
  it("another customer's add-on row reads as missing, never as a refusal that confirms it exists", async () => {
    db.seed("missions", [addon({ user_id: OTHER })]);
    for (const r of [await approveForCustomer(db, { id: ADDON_ID, userId: ME, isGuest: false, emailVerified: true }), await cancelForCustomer(db, { id: ADDON_ID, userId: ME }), await editPlanForCustomer(db, { id: ADDON_ID, userId: ME, edits: {} })]) expect(r).toMatchObject({ ok: false, status: 404 });
  });
  it("ordinary missions behave exactly as before: the waiting plan is cancellable, the card loads, a plan edit is applied", async () => {
    db.seed("missions", [ordinary("ready0000000001", "plan_ready"), ordinary("ready0000000002", "plan_ready")]);
    expect(await loadCustomerMission(db, { id: "msn_ready0000000001", userId: ME, now: NOW })).toMatchObject({ ok: true, status: "plan_ready" });
    expect(await editPlanForCustomer(db, { id: "msn_ready0000000001", userId: ME, edits: { count: 5 } })).not.toMatchObject({ status: 409, error: expect.stringContaining("طلب على ملف") });
    expect(await cancelForCustomer(db, { id: "msn_ready0000000002", userId: ME })).toMatchObject({ ok: true });
    expect(row("msn_ready0000000002").status).toBe("cancelled");
  });
});

describe("the admin's research page does not treat a review request as a research mission", () => {
  const ADMIN_ROWS = [ADDON_ID, MALFORMED.id];
  it("cancel, answer and approve are refused with 409 and change nothing (approve answers before any account lookup or money function)", async () => {
    seedMixed();
    db.seed("missions", [addon({ id: "msn_addonask0000000001", status: "needs_input" })]);
    const before = snapshot();
    for (const id of ADMIN_ROWS) {
      expect(await cancelMission(db, { id }), `cancel ${id}`).toMatchObject({ ok: false, status: 409 });
      expect(await approvePlan(db, { id, adminId: "adm-1" }), `approve ${id}`).toMatchObject({ ok: false, status: 409 });
    }
    expect(await answerQuestion(db, { id: "msn_addonask0000000001", text: "الإجابة" })).toMatchObject({ ok: false, status: 409 });
    expect(snapshot()).toBe(before);
    expect(db.moneyTouched()).toEqual([]);
  });
  it("the overview labels each add-on row as one and does not leak the marker column; ordinary rows are not labelled", async () => {
    seedMixed();
    const o = await loadOverview(db, NOW);
    const byId = new Map<string, any>((o.missions as any[]).map((m) => [m.id, m]));
    expect(byId.get(ADDON_ID)?.is_addon).toBe(true);
    expect(byId.get(MALFORMED.id)?.is_addon).toBe(true);
    expect(byId.get("msn_ready0000000001")?.is_addon).toBeUndefined();
    for (const m of o.missions as any[]) expect(m).not.toHaveProperty("addon");
  });
  it("the detail of an add-on row answers without a research plan (no crash, no approve card) and says it is an add-on; an ordinary mission's detail is unchanged", async () => {
    seedMixed();
    for (const id of ADMIN_ROWS) {
      const d: any = await loadDetail(db, { id });
      expect(d.ok, id).toBe(true);
      expect(d.mission.is_addon, id).toBe(true);
      expect(d.customerPlan).toBeNull();
      expect(d.internalPlan).toBeNull();
      expect(d.mission.plan).toBeUndefined();
    }
    const ord: any = await loadDetail(db, { id: "msn_ready0000000001" });
    expect(ord.ok).toBe(true);
    expect(ord.mission.is_addon).toBeUndefined();
    expect(ord.customerPlan).not.toBeNull();
  });
});

describe("the chat never takes a review request for the customer's open research request", () => {
  /** missions on the strict database, every other table on the plain memory database the chat tests use */
  async function chatWorld() {
    const { createMemoryDb } = await import("./helpers/memoryDb");
    const mem: any = createMemoryDb();
    mem.seed("conversations", [{ id: "conv1", user_id: ME, title: "محادثة جديدة", status: "active" }]);
    mem.seed("credit_ledger", [{ user_id: ME, delta: 11676 }]);
    mem.seed("mission_events", []);
    mem.seed("messages", [{ id: "a0", conversation_id: "conv1", user_id: ME, role: "assistant", content_ar: "بدأ الوكيل دراسة طلبك؛ تابع خطة المهمة هنا.", plan: { agentMissionId: ADDON_ID }, created_at: new Date(NOW - 60_000).toISOString() }]);
    return { from: (t: string) => (t === "missions" ? db.from(t) : mem.from(t)), rpc: db.rpc, mem };
  }
  let n = 0;
  async function turn(sb: any, message: string) {
    n += 1;
    const userMsgId = `uu${n}`, assistantMsgId = `aa${n}`;
    sb.mem.seed("messages", [
      { id: userMsgId, conversation_id: "conv1", user_id: ME, role: "user", content_ar: message, request_status: "planning", created_at: new Date(NOW).toISOString() },
      { id: assistantMsgId, conversation_id: "conv1", user_id: ME, role: "assistant", content_ar: "جاري التفكير وتحليل طلبك...", created_at: new Date(NOW + 1).toISOString() },
    ]);
    return agentChatTurn({ sb, userId: ME, conversationId: "conv1", userMsgId, assistantMsgId, message, conversationTitle: "محادثة جديدة" });
  }
  it("a short follow-up is not applied to the review request as if it were the open plan: the request is untouched", async () => {
    setChatModelForTesting(fakeChatModel().call);
    seedMixed();
    const before = JSON.stringify(row(ADDON_ID));
    const sb = await chatWorld();
    await turn(sb, "خليها ٥ تعليقات بس");
    expect(JSON.stringify(row(ADDON_ID))).toBe(before);
    expect(db.moneyTouched()).toEqual([]);
  });
  it("a new research request does not replace (cancel) the review request that the last card of the conversation points at", async () => {
    setChatModelForTesting(fakeChatModel().call);
    seedMixed();
    const sb = await chatWorld();
    await turn(sb, "هات ٣٠٠ تغريدة عن محمد صلاح");
    expect(row(ADDON_ID).status).toBe("plan_ready");
    expect(db.log.filter((l) => l.op === "update" && l.ids.includes(ADDON_ID))).toEqual([]);
  });
  it("an ordinary open plan is still replaced by a new request, exactly as before", async () => {
    setChatModelForTesting(fakeChatModel().call);
    db.seed("missions", [ordinary("ready0000000001", "plan_ready")]);
    const sb = await chatWorld();
    sb.mem.tables.set("messages", [{ id: "a0", conversation_id: "conv1", user_id: ME, role: "assistant", content_ar: "بدأ الوكيل دراسة طلبك؛ تابع خطة المهمة هنا.", plan: { agentMissionId: "msn_ready0000000001" }, created_at: new Date(NOW - 60_000).toISOString() }]);
    const r = await turn(sb, "هات ٣٠٠ تغريدة عن محمد صلاح");
    expect(r.ok).toBe(true);
    expect(row("msn_ready0000000001").status).toBe("cancelled");
  });
});

describe("the methodology offer cannot pick a review request, and the request still has its own endpoint", () => {
  it("a completed add-on row with delivered values is not a methodology mission", async () => {
    db.seed("missions", [addon({ status: "completed", delivered_units: 40, job_id: "job_a", files: [{ name: "result.xlsx", path: "r.xlsx", kind: "xlsx" }], plan_public: { compiled: true } })]);
    expect(await listMethodologyMissions(db, ME)).toEqual([]);
  });
  it("the review-request endpoint finds the waiting row and cancels it while the ordinary list shows nothing of it", async () => {
    seedMixed();
    const cur = await currentReviewRequest(db, { missionId: DELIVERED, userId: ME });
    expect(cur).toMatchObject({ ok: true, request: { id: ADDON_ID, version: 1, status: "plan_ready" } });
    expect((await listOpenMissions(db, { userId: ME, now: NOW })).map((m) => m.id)).not.toContain(ADDON_ID);
    expect(await cancelReviewRequest(db, { missionId: DELIVERED, userId: ME, requestId: ADDON_ID })).toEqual({ ok: true });
    expect(row(ADDON_ID).status).toBe("cancelled");
    expect(db.moneyTouched()).toEqual([]);
  });
  it("a row that carries a cost and a job is edit-free: the dedicated path refuses to cancel it too", async () => {
    db.seed("missions", [DELIVERED_ROW, addon({ job_id: "job_paid" })]);
    expect(await cancelReviewRequest(db, { missionId: DELIVERED, userId: ME, requestId: ADDON_ID })).toMatchObject({ ok: false, status: 409 });
    expect(row(ADDON_ID).status).toBe("plan_ready");
  });
});

/** The source-level fence: a reader added later cannot forget the rule. */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
describe("the fence in the source", () => {
  const SRC = walk("src");
  it("every caller of the ordinary approval is guarded by the marker (the approval itself is money code and is not edited)", () => {
    const callers = SRC.filter((f) => /\bapproveMissionOnce\(/.test(readFileSync(f, "utf8")) && !/agentMission\/(approval|addonSettlement)\.ts$/.test(f));
    expect(callers.sort()).toEqual(["src/lib/agentMission/adminActions.ts", "src/lib/agentMission/customerActions.ts"]);
    for (const f of callers) expect(readFileSync(f, "utf8"), f).toContain("hasAddonMarker");
  });
  it("every ordinary reader of the missions table uses the marker (or is listed below with its reason)", () => {
    const READERS = ["src/lib/agentMission/openMissions.ts", "src/lib/requests/expiry.ts", "src/lib/requests/buildIndex.ts", "src/lib/agentMission/customerActions.ts", "src/lib/agentMission/adminActions.ts", "src/lib/agentMission/chatTurn.ts", "src/lib/agentMission/methodology/missions.ts"];
    for (const f of READERS) expect(readFileSync(f, "utf8"), f).toContain("addonMarker");
  });
  it("no reader outside the add-on's own code writes or reads add-on rows without the marker: every file that reads the missions table is either a reader above or in the reviewed list", () => {
    const REVIEWED = new Set([
      // the add-on's own code (it must see add-on rows)
      "src/lib/agentMission/stage4/addonRowStore.ts", "src/lib/agentMission/stage4/reviewRequest.ts", "src/lib/agentMission/stage4/reviewPreview.ts", "src/lib/agentMission/stage4/versionFile.ts", "src/lib/agentMission/stage4/versionList.ts", "src/lib/agentMission/addonSettlement.ts",
      // the shared approval path: its callers are the guarded ones above (asserted in the first test)
      "src/lib/agentMission/approval.ts",
      // a read by job id or by the delivered mission's own id: an add-on row is never the subject of a notice, a conversation link, a job download or a wallet line (it holds no job until the approval task); see docs/MONEY-PR-7A.md section 17.5
      "src/lib/server/missionNotify.ts", "src/lib/server/jobConversation.ts", "src/app/api/jobs/[id]/download/route.ts", "src/app/api/wallet/history/route.ts",
      // the guest-to-customer account transfer moves every row of the guest, whatever it is
      "src/app/api/chat/route.ts",
      // browser reads of the customer's own row by id or job (cannot ask for the plan column): see 17.5
      "src/app/dashboard/requests/[id]/page.tsx", "src/app/dashboard/requests/page.tsx",
      // the constant itself
      "src/lib/agentMission/constants.ts",
    ]);
    const readers = SRC.filter((f) => /from\(["']missions["']\)|MISSION_TABLE/.test(readFileSync(f, "utf8"))).map((f) => f.replace(/\\/g, "/"));
    const unknown = readers.filter((f) => !REVIEWED.has(f) && !/addonMarker/.test(readFileSync(f, "utf8")));
    expect(unknown).toEqual([]);
  });
});

describe("nothing here is money or a provider", () => {
  it("running every ordinary reader over the mixed table touched no money table, no rpc, no storage write and no fetch", async () => {
    seedMixed();
    await listOpenMissions(db, { userId: ME, now: NOW });
    await buildRequestIndex(db, { userId: ME, tab: "all", now: NOW });
    await expireWaitingMissions(db, { userId: ME, now: NOW });
    await loadOverview(db, NOW);
    expect(db.moneyTouched()).toEqual([]);
    expect(db.storageCalls).toEqual([]);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });
});
