import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runExecution, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { approveMission } from "../src/lib/agentMission/lifecycle";
import { buildMissionNotice } from "../src/lib/agentMission/notices";
import { sendMissionNotice } from "../src/lib/server/missionNotify";
import { customerFacingCapabilityLabel, customerFacingQuoteSummary } from "../src/lib/customerFacingRequestLabels";

const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };

function deps(store = createMemoryStore(), money = fakeMoneyClient(), notify = vi.fn(async () => undefined)) {
  const rec = fakeRecorder();
  const d = (driver: ReturnType<typeof createFakeDriver>): RunnerDeps => ({ store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: vi.fn() as any, models: MODELS, resolveAccess: async () => NOT_ADMIN, notify: notify as any });
  return { store, money, notify, d };
}

describe("the worker tells the customer how a mission ended", () => {
  it("planning that cannot serve: an «unserved» notice with nothing reserved", async () => {
    const t = deps();
    t.store.missions.set("msn_n1", newMission({ id: "msn_n1", user_id: USER_ID, status: "planning" }));
    await runPlanning(t.d(createFakeDriver([{ tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لا يوجد مصدر متاح يخدم هذا الطلب بدقة، ولم يُحجز أي رصيد." } }])), t.store.missions.get("msn_n1")!);
    expect(t.notify).toHaveBeenCalledWith({ userId: USER_ID, missionId: "msn_n1", jobId: null, kind: "unserved", facts: { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false } });
  });

  it("planning that ends without a plan: a «failed» notice", async () => {
    const t = deps();
    t.store.missions.set("msn_n2", newMission({ id: "msn_n2", user_id: USER_ID, status: "planning" }));
    await runPlanning(t.d(createFakeDriver([])), t.store.missions.get("msn_n2")!);
    expect(t.store.missions.get("msn_n2")!.status).toBe("failed");
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed", jobId: null }));
  });

  it("execution that delivers nothing: the whole reserve came back, said in the notice", async () => {
    const t = deps();
    const m = newMission({ id: "msn_n3", user_id: USER_ID, status: "executing", plan: pricedTwoStagePlan() });
    t.store.missions.set(m.id, m);
    const a = await approveMission(t.money.client, { id: m.id, user_id: m.user_id, plan: m.plan! });
    if (!a.ok) throw new Error(a.messageAr);
    Object.assign(m, { job_id: a.jobId, reserved_points: a.reservePoints, unit_price_points: a.unitPricePoints });
    await runExecution(t.d(createFakeDriver([{ tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لم يعد المصدر يعطي بيانات، فلم يُسلَّم شيء ولم يُخصم رصيد." } }])), m);
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "unserved", jobId: a.jobId, facts: expect.objectContaining({ delivered: 0, chargedPoints: 0, releasedPoints: a.reservePoints, hasJob: true }) }));
    const n = buildMissionNotice("unserved", { delivered: 0, planned: 220, chargedPoints: 0, releasedPoints: a.reservePoints, hasJob: true });
    expect(n.body).toContain("حجز مؤقت مُحرَّر");
  });

  it("a notice that throws never changes the mission", async () => {
    const t = deps(createMemoryStore(), fakeMoneyClient(), vi.fn(async () => { throw new Error("mail down"); }));
    t.store.missions.set("msn_n4", newMission({ id: "msn_n4", user_id: USER_ID, status: "planning" }));
    await runPlanning(t.d(createFakeDriver([{ tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لا يوجد مصدر يخدم الطلب ولم يُحجز أي رصيد." } }])), t.store.missions.get("msn_n4")!);
    expect(t.store.missions.get("msn_n4")!.status).toBe("unserved");
  });
});

describe("the in-site notice and the e-mail (through the existing send-email function)", () => {
  const sent: Array<{ url: string; body: any }> = [];
  beforeEach(() => {
    sent.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-for-test";
    vi.stubGlobal("fetch", async (url: string, init: any) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}) } as any; });
  });

  const client = (user: any, existing: string[] = []) => {
    const rows: any[] = existing.map((id) => ({ id }));
    return { rows, auth: { admin: { getUserById: async () => ({ data: { user }, error: null }) } }, from: () => ({ insert: async (r: any) => { if (rows.some((x) => x.id === r.id)) return { error: { code: "23505" } }; rows.push(r); return { error: null }; } }) };
  };
  const facts = { delivered: 20, planned: 20, chargedPoints: 4, releasedPoints: 1, hasJob: true };

  it("a customer gets the notice and one e-mail with a stable key; the same notice twice sends nothing more", async () => {
    const c = client({ id: "u1", email: "customer@example.com", user_metadata: { full_name: "منى" } });
    expect(await sendMissionNotice(c, { userId: "u1", missionId: "msn_abc00001", jobId: "job_x", kind: "completed", facts })).toEqual({ inApp: true, email: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://project.supabase.example/functions/v1/send-email");
    expect(sent[0].body).toMatchObject({ template: "job-update", to: "customer@example.com", idempotencyKey: "mission-update:completed:msn_abc00001" });
    expect(sent[0].body.vars.JobURL).toContain("/dashboard/requests?job=job_x");
    expect(c.rows[0].id).toBe("notif_completed_msn_abc00001");
    expect(await sendMissionNotice(c, { userId: "u1", missionId: "msn_abc00001", jobId: "job_x", kind: "completed", facts })).toEqual({ inApp: false, email: false });
    expect(sent).toHaveLength(1);
  });

  it("a guest is never e-mailed, a customer who turned «done» notices off is not e-mailed, and the «started» notice is in-site only", async () => {
    expect((await sendMissionNotice(client({ id: "g", email: "guest_1@diger.tech", user_metadata: { is_guest: true } }), { userId: "g", missionId: "msn_g0000001", jobId: null, kind: "unserved", facts })).email).toBe(false);
    expect((await sendMissionNotice(client({ id: "u2", email: "a@example.com", user_metadata: { prefs: { notif: { done: false } } } }), { userId: "u2", missionId: "msn_g0000002", jobId: "job_y", kind: "completed", facts })).email).toBe(false);
    expect(await sendMissionNotice(client({ id: "u3", email: "b@example.com", user_metadata: {} }), { userId: "u3", missionId: "msn_g0000003", jobId: "job_z", kind: "started", facts })).toEqual({ inApp: true, email: false });
    expect(sent).toHaveLength(0);
  });

  it("a failing e-mail or a missing user never throws", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("network"); });
    await expect(sendMissionNotice(client({ id: "u4", email: "c@example.com", user_metadata: {} }), { userId: "u4", missionId: "msn_g0000004", jobId: null, kind: "failed", facts })).resolves.toMatchObject({ inApp: true, email: false });
    await expect(sendMissionNotice({ auth: {}, from: () => { throw new Error("db down"); } }, { userId: "u5", missionId: "msn_g0000005", jobId: null, kind: "failed", facts })).resolves.toEqual({ inApp: false, email: false });
  });
});

describe("«طلباتي» names a mission's job in plain Arabic", () => {
  it("the capability word and the summary of the request", () => {
    expect(customerFacingCapabilityLabel("agent-mission")).toBe("مهمة بيانات");
    expect(customerFacingQuoteSummary("agent-mission")).toBe("طلب مهمة بيانات");
  });
});
