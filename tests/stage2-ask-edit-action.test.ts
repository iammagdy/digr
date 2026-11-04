import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * STAGE 2 S3 (docs/STAGE-2.md): the «ask_edit» action of the mission route. Off (the flag unset): 404, nothing read or written. On: only for the customer's own mission in `plan_ready`,
 * checked by code, kept as a create-only object `ask_edits/eNNNN.json`, the mission back to `queued`; NO money line: no hold, no reservation, no money function, no ledger.
 */
const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => (state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) })) };
});
vi.mock("../src/lib/server/missionNotify", () => ({ sendMissionNotice: vi.fn(async () => ({ inApp: true, email: false })) }));

import { GET, POST } from "../src/app/api/missions/[id]/route";
import { ASK_EDIT_NEW_READ_AR, ASK_EDIT_RECEIVED_AR, askEditForCustomer } from "../src/lib/agentMission/stage2/askEditAction";

const ME = "u-1";
const MSN = "msn_askedit0001";
const REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.";
const plan = pricedTwoStagePlan();
const mission = (over: Record<string, unknown> = {}) => ({ id: MSN, user_id: ME, status: "plan_ready", request_text: REQUEST, answer_text: null, created_at: "2026-11-02T11:35:00Z", plan, plan_public: customerPlanView(plan), reserved_points: 777, unit_price_points: 3.5, ...over });

function makeClient(db: MemoryDb, email = "someone@example.com") {
  const written: string[] = [];
  const objects = new Map<string, string>();
  const money = fakeMoneyClient();
  const rpc = vi.fn(money.client.rpc);
  const bucket = {
    list: async (dir: string) => ({ data: [...objects.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => ({ name: k.slice(dir.length + 1), id: k })).sort((a, b) => (a.name < b.name ? -1 : 1)), error: null }),
    download: async (p: string) => (objects.has(p) ? { data: new Blob([objects.get(p)!]), error: null } : { data: null, error: { message: "not found" } }),
    upload: async (p: string, body: string, opts: { upsert?: boolean }) => {
      if (objects.has(p) && opts?.upsert !== true) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
      objects.set(p, String(body));
      return { data: { path: p }, error: null };
    },
  };
  const client: any = {
    from: (t: string) => { const b = db.from(t); for (const m of ["insert", "update", "upsert"]) { const o = b[m]; b[m] = (...a: any[]) => { written.push(t); return o(...a); }; } return b; },
    rpc,
    storage: { from: () => bucket },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, email } }, error: null }) } },
  };
  return { client, written, objects, rpc };
}
const req = (body: unknown) => new NextRequest(`http://localhost/api/missions/${MSN}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const ctx = () => ({ params: Promise.resolve({ id: MSN }) });

let db: MemoryDb;
beforeEach(() => { db = createMemoryDb(); state.viewer = { userId: ME, isGuest: false, emailVerified: true }; });
afterEach(() => { vi.unstubAllEnvs(); });

describe("flag off (unset, as in production): the action does not exist", () => {
  it("404, and nothing is read, written or uploaded", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "");
    db.seed("missions", [mission()]);
    const c = makeClient(db);
    state.client = c.client;
    const res = await POST(req({ action: "ask_edit", edit: { field: "count", value: 1 } }), ctx());
    expect(res.status).toBe(404);
    expect(c.written).toEqual([]);
    expect(c.objects.size).toBe(0);
    expect(db.rows("missions")[0].status).toBe("plan_ready");
  });
  it("«test»: an account that is not a test account gets 404; a test account gets the action", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "test");
    db.seed("missions", [mission()]);
    state.client = makeClient(db, "customer@example.com").client;
    expect((await POST(req({ action: "ask_edit", edit: { field: "count", value: 1 } }), ctx())).status).toBe(404);
    state.client = makeClient(db, "tester@digr.local").client;
    expect((await POST(req({ action: "ask_edit", edit: { field: "count", value: 1 } }), ctx())).status).toBe(200);
  });
});

describe("the mission's GET answer carries the «فهمنا طلبك» card only when the flag is on", () => {
  const get = () => GET(new NextRequest(`http://localhost/api/missions/${MSN}`), ctx());
  it("flag off: no askCard key and no storage read (the answer is today's)", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "");
    db.seed("missions", [mission()]);
    const c = makeClient(db);
    const listed = vi.fn(c.client.storage.from().list);
    c.client.storage = { from: () => ({ ...c.client.storage.from(), list: listed }) };
    state.client = c.client;
    const json = await (await get()).json();
    expect(json.success).toBe(true);
    expect("askCard" in json).toBe(false);
    expect(listed).not.toHaveBeenCalled();
  });
  it("flag on, a plan waiting: the card of the request, with the kept edits applied", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "on");
    db.seed("missions", [mission()]);
    const c = makeClient(db);
    c.objects.set(`${MSN}/ask_edits/e0001.json`, JSON.stringify({ field: "count", value: 1 }));
    state.client = c.client;
    const json = await (await get()).json();
    expect(json.askCard.titleAr).toBe("فهمنا طلبك");
    expect(json.askCard.fields.find((f: { key: string }) => f.key === "count").valueAr).toBe("١");
  });
  it("the live sheet: «liveSheet» only when DIGER_STAGE2_LIVE_SHEET is on for the viewer", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "");
    db.seed("missions", [mission({ status: "executing" })]);
    state.client = makeClient(db).client;
    expect("liveSheet" in (await (await get()).json())).toBe(false);
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "on");
    expect((await (await get()).json()).liveSheet).toBe(true);
  });
  it("flag on, an approved mission: no card", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "on");
    db.seed("missions", [mission({ status: "approved" })]);
    state.client = makeClient(db).client;
    expect("askCard" in (await (await get()).json())).toBe(false);
  });
});

describe("flag on: the edit is kept and the plan is made again, with no money line", () => {
  it("a count edit: the object ask_edits/e0001.json, the mission back to «queued», one event; the hold columns, the ledger and the money functions untouched", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "on");
    db.seed("missions", [mission()]);
    const c = makeClient(db);
    state.client = c.client;
    const res = await POST(req({ action: "ask_edit", edit: { field: "count", value: 1 } }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: "queued", scope: "recompile" });
    expect([...c.objects.keys()]).toEqual([`${MSN}/ask_edits/e0001.json`]);
    expect(JSON.parse(c.objects.get(`${MSN}/ask_edits/e0001.json`)!)).toEqual({ field: "count", value: 1 });
    const m = db.rows("missions")[0];
    expect(m.status).toBe("queued");
    // nothing about money changed: the plan's numbers stay as they were until the worker prices the new plan by code
    expect([m.reserved_points, m.unit_price_points]).toEqual([777, 3.5]);
    expect(c.rpc).not.toHaveBeenCalled();
    expect([...new Set(c.written)].sort()).toEqual(["mission_events", "missions"]);
    expect(db.rows("mission_events").map((e) => e.message_ar)).toEqual([ASK_EDIT_RECEIVED_AR]);
  });
  it("a second edit is e0002.json; a topic edit says it needs a new read", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "on");
    db.seed("missions", [mission()]);
    const c = makeClient(db);
    state.client = c.client;
    await POST(req({ action: "ask_edit", edit: { field: "count", value: 1 } }), ctx());
    db.rows("missions")[0].status = "plan_ready";
    const res = await POST(req({ action: "ask_edit", edit: { field: "topic", value: "الروبوتات" } }), ctx());
    expect(await res.json()).toEqual({ success: true, status: "queued", scope: "new_read" });
    expect([...c.objects.keys()].sort()).toEqual([`${MSN}/ask_edits/e0001.json`, `${MSN}/ask_edits/e0002.json`]);
  });
  it("a refused edit: 400 with its reason code and its fixed sentence; nothing written", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "on");
    db.seed("missions", [mission()]);
    const c = makeClient(db);
    state.client = c.client;
    const res = await POST(req({ action: "ask_edit", edit: { field: "count", value: 0 } }), ctx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("out_of_range");
    expect(checkCustomerText(json.error).issues).toEqual([]);
    expect(c.objects.size).toBe(0);
    expect(c.written).toEqual([]);
    const locked = await POST(req({ action: "ask_edit", edit: { field: "platform", value: "x" } }), ctx());
    expect((await locked.json()).reason).toBe("field_locked");
  });
  it("only before approval: an approved, running or waiting mission is refused (409) and stays as it is", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "on");
    for (const status of ["approved", "executing", "queued", "needs_input", "completed"]) {
      db.reset();
      db.seed("missions", [mission({ status })]);
      const c = makeClient(db);
      state.client = c.client;
      const res = await POST(req({ action: "ask_edit", edit: { field: "count", value: 1 } }), ctx());
      expect(res.status, status).toBe(409);
      expect(db.rows("missions")[0].status).toBe(status);
      expect(c.objects.size).toBe(0);
      expect(c.rpc).not.toHaveBeenCalled();
    }
  });
  it("another customer's mission: 404", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "on");
    db.seed("missions", [mission({ user_id: "u-2" })]);
    state.client = makeClient(db).client;
    expect((await POST(req({ action: "ask_edit", edit: { field: "count", value: 1 } }), ctx())).status).toBe(404);
  });
  it("an edit that would race an approval is not applied: the status guard keeps the approved mission", async () => {
    db.seed("missions", [mission()]);
    const c = makeClient(db);
    // the mission is approved between the read and the update
    const realFrom = c.client.from;
    let reads = 0;
    c.client.from = (t: string) => { const b = realFrom(t); if (t === "missions") { const ms = b.maybeSingle; b.maybeSingle = async () => { const r = await ms(); reads += 1; db.rows("missions")[0].status = "approved"; return r; }; } return b; };
    const r = await askEditForCustomer(c.client, { id: MSN, userId: ME, edit: { field: "count", value: 1 } });
    expect(reads).toBe(1);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(db.rows("missions")[0].status).toBe("approved");
  });
  it("the fixed sentences pass the customer-text rules", () => {
    expect(checkCustomerText(ASK_EDIT_RECEIVED_AR).issues).toEqual([]);
    expect(checkCustomerText(ASK_EDIT_NEW_READ_AR).issues).toEqual([]);
  });
});
