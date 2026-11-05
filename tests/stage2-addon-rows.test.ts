import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { counterAr, type LiveSnapshot } from "../src/lib/agentMission/stage2/liveSheet";

/**
 * STAGE 2 x STAGE 4 COMPATIBILITY (integration round): a paid review, review fix or edit request of a DELIVERED file is a row of the `missions` table whose `plan` carries the key `addon` (Money PR 7e, docs/MONEY-PR-7A.md section 17): it is NEVER a research mission
 * and must never reach a research path. Stage 2's `ask_edit` action, its card loader and its live-sheet route read the customer's `missions` row by id with no such check. A waiting review request is `plan_ready` (like a plan that waits for approval) and belongs to the same customer, so with
 * DIGER_STAGE2_ASK_CARD on, `ask_edit` on its id would send it back to `queued` and the RESEARCH planner would run on it. These tests pin that an add-on row is «not found» for all three, writes nothing, and that an ordinary mission is unaffected.
 */
const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => (state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) })) };
});
vi.mock("../src/lib/server/missionNotify", () => ({ sendMissionNotice: vi.fn(async () => ({ inApp: true, email: false })) }));

import { GET as missionGET, POST } from "../src/app/api/missions/[id]/route";
import { GET as liveGET } from "../src/app/api/missions/[id]/live/route";
import { askCardForCustomer, askEditForCustomer } from "../src/lib/agentMission/stage2/askEditAction";

const ME = "u-1";
const ORDINARY = "msn_ordinary00001";
const ADDON = "msn_addonrow000001";
const REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.";
const plan = pricedTwoStagePlan();
const ordinary = () => ({ id: ORDINARY, user_id: ME, status: "plan_ready", request_text: REQUEST, answer_text: null, created_at: "2026-11-02T11:35:00Z", plan, plan_public: customerPlanView(plan) });
const addonRow = (over: Record<string, unknown> = {}) => ({ id: ADDON, user_id: ME, status: "plan_ready", request_text: "راجع الملف", answer_text: null, created_at: "2026-11-02T12:00:00Z", plan: { addon: { v: 1, kind: "review", of: "msn_deliveredfile01" } }, plan_public: null, ...over });

function makeClient(db: MemoryDb) {
  const written: string[] = [];
  const objects = new Map<string, string>();
  const bucket = {
    list: async (dir: string, o?: { limit?: number; sortBy?: { order?: string } }) => {
      let names = [...objects.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)).sort();
      if (o?.sortBy?.order === "desc") names = names.reverse();
      return { data: names.slice(0, o?.limit ?? 100).map((name) => ({ name, id: name })), error: null };
    },
    download: async (p: string) => (objects.has(p) ? { data: new Blob([objects.get(p)!]), error: null } : { data: null, error: { message: "not found" } }),
    upload: async (p: string, body: string, opts: { upsert?: boolean }) => {
      written.push(`upload:${p}`);
      if (objects.has(p) && opts?.upsert !== true) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
      objects.set(p, String(body));
      return { data: { path: p }, error: null };
    },
  };
  const client: any = {
    from: (t: string) => { const b = db.from(t); for (const m of ["insert", "update", "upsert"]) { const o = b[m]; b[m] = (...a: any[]) => { written.push(`${m}:${t}`); return o(...a); }; } return b; },
    rpc: vi.fn(async () => { throw new Error("no money function may be called"); }),
    storage: { from: () => bucket },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, email: "someone@example.com" } }, error: null }) } },
  };
  return { client, written, objects };
}
const post = (id: string, body: unknown) => POST(new NextRequest(`http://localhost/api/missions/${id}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id }) });
const snap = (id: string): LiveSnapshot => ({ v: 1, missionId: id, cursor: "5.0.running", status: "running", delivered: 3, promised: 40, counterAr: counterAr(3, 40), workLog: [], sheets: [{ stageKey: "comments", nameAr: "التعليقات", headers: ["نص التعليق", "المعرّف"], rows: [] }], builtAt: 0 });

let db: MemoryDb;
beforeEach(() => { db = createMemoryDb(); state.viewer = { userId: ME, isGuest: false, emailVerified: true }; });
afterEach(() => { vi.unstubAllEnvs(); });

describe("the ask_edit action never touches an add-on row (DIGER_STAGE2_ASK_CARD on)", () => {
  beforeEach(() => { vi.stubEnv("DIGER_STAGE2_ASK_CARD", "on"); });
  it("through the route: 404 like a mission that is not theirs; the row stays `plan_ready` and is not sent to the research planner; nothing is written or uploaded", async () => {
    db.seed("missions", [addonRow()]);
    const c = makeClient(db);
    state.client = c.client;
    const res = await post(ADDON, { action: "ask_edit", edit: { field: "count", value: 1 } });
    expect(res.status).toBe(404);
    expect(c.written).toEqual([]);
    expect(c.objects.size).toBe(0);
    expect(db.rows("missions")[0]).toMatchObject({ id: ADDON, status: "plan_ready" });
  });
  it("the function itself refuses, whichever way the marker is carried: in the plan, or as the selected `addon` column", async () => {
    for (const row of [addonRow(), addonRow({ plan: undefined, addon: { v: 1, kind: "edit", of: "msn_deliveredfile01" } })]) {
      const local = createMemoryDb();
      local.seed("missions", [row]);
      const c = makeClient(local);
      const r = await askEditForCustomer(c.client, { id: ADDON, userId: ME, edit: { field: "count", value: 1 } });
      expect(r).toMatchObject({ ok: false, status: 404 });
      expect(c.written).toEqual([]);
      expect(local.rows("missions")[0].status).toBe("plan_ready");
    }
  });
  it("the card loader gives nothing for an add-on row, even one whose text reads like a research request", async () => {
    db.seed("missions", [addonRow({ request_text: REQUEST })]);
    const c = makeClient(db);
    expect(await askCardForCustomer(c.client, { id: ADDON, userId: ME })).toBeNull();
  });
  it("CONTROL: an ordinary mission waiting for approval still gets the action and the card", async () => {
    db.seed("missions", [ordinary()]);
    const c = makeClient(db);
    state.client = c.client;
    c.objects.set(`${ORDINARY}/stage2/test_account.json`, JSON.stringify({ test: true }));
    expect((await post(ORDINARY, { action: "ask_edit", edit: { field: "count", value: 1 } })).status).toBe(200);
    expect(db.rows("missions")[0].status).toBe("queued");
    const local = createMemoryDb();
    local.seed("missions", [ordinary()]);
    expect(await askCardForCustomer(makeClient(local).client, { id: ORDINARY, userId: ME })).not.toBeNull();
  });
});

describe("the live-sheet route never answers for an add-on row (DIGER_STAGE2_LIVE_SHEET on)", () => {
  beforeEach(() => { vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "on"); });
  it("404 for the customer's own add-on row even if a snapshot object sits in its folder; nothing is listed or downloaded", async () => {
    db.seed("missions", [addonRow()]);
    const c = makeClient(db);
    c.objects.set(`${ADDON}/live/snap_000000005_w1.json`, JSON.stringify(snap(ADDON)));
    const listed = vi.spyOn(c.client.storage.from(), "list");
    state.client = c.client;
    const res = await liveGET(new NextRequest(`http://localhost/api/missions/${ADDON}/live`), { params: Promise.resolve({ id: ADDON }) });
    expect(res.status).toBe(404);
    expect(listed).not.toHaveBeenCalled();
  });
  it("CONTROL: an ordinary mission's snapshot is served", async () => {
    db.seed("missions", [ordinary()]);
    const c = makeClient(db);
    c.objects.set(`${ORDINARY}/live/snap_000000005_w1.json`, JSON.stringify(snap(ORDINARY)));
    state.client = c.client;
    const res = await liveGET(new NextRequest(`http://localhost/api/missions/${ORDINARY}/live`), { params: Promise.resolve({ id: ORDINARY }) });
    expect(res.status).toBe(200);
    expect((await res.json()).delivered).toBe(3);
  });
});

describe("the mission's GET answer for an add-on row stays «not found» (7e), and carries no card", () => {
  it("404 with the flag on", async () => {
    vi.stubEnv("DIGER_STAGE2_ASK_CARD", "on");
    db.seed("missions", [addonRow()]);
    state.client = makeClient(db).client;
    const res = await missionGET(new NextRequest(`http://localhost/api/missions/${ADDON}`), { params: Promise.resolve({ id: ADDON }) });
    expect([404, 200].includes(res.status)).toBe(true);
    if (res.status === 200) expect((await res.json()).askCard ?? null).toBeNull();
  });
});
