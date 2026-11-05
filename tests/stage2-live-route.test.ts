import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { counterAr, type LiveSnapshot } from "../src/lib/agentMission/stage2/liveSheet";

/**
 * STAGE 2 S7 (docs/STAGE-2.md): the live sheet's polling route. Owner only; 404 unless DIGER_STAGE2_LIVE_SHEET is on for the viewer; the NEWEST create-only snapshot; the shared poll
 * contract; never cached; read only.
 */
const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => (state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) })) };
});
import { GET } from "../src/app/api/missions/[id]/live/route";

const MSN = "msn_livesheet0001";
const snap = (seq: number, rows: number, status: "running" | "done" = "running"): LiveSnapshot => ({
  v: 1, missionId: MSN, cursor: `${seq}.0.${status}`, status, delivered: rows, promised: 40, counterAr: counterAr(rows, 40), workLog: [],
  sheets: [{ stageKey: "comments", nameAr: "التعليقات", headers: ["نص التعليق", "المعرّف"], rows: Array.from({ length: rows }, (_, i) => ({ id: `c${i}`, parentId: null, cells: [{ k: "text" as const, v: "تعليق" }] })) }],
  builtAt: 0,
});

function makeClient(db: MemoryDb, email = "someone@example.com") {
  const objects = new Map<string, string>();
  const calls = { list: 0, download: 0 };
  const bucket = {
    list: async (dir: string, o: { limit?: number; sortBy?: { order?: string } }) => {
      calls.list += 1;
      let names = [...objects.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)).sort();
      if (o?.sortBy?.order === "desc") names = names.reverse();
      return { data: names.slice(0, o?.limit ?? 100).map((name) => ({ name, id: name })), error: null };
    },
    download: async (p: string) => { calls.download += 1; return objects.has(p) ? { data: new Blob([objects.get(p)!]), error: null } : { data: null, error: { message: "missing" } }; },
    upload: async () => { throw new Error("the route must never write"); },
  };
  const client: any = {
    from: (t: string) => { const b = db.from(t); for (const m of ["insert", "update", "upsert"]) b[m] = () => { throw new Error("the route must never write"); }; return b; },
    storage: { from: () => bucket },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, email } }, error: null }) } },
  };
  const put = (name: string, s: LiveSnapshot) => objects.set(`${MSN}/live/${name}`, JSON.stringify(s));
  return { client, put, calls, objects };
}
const get = (query = "") => GET(new NextRequest(`http://localhost/api/missions/${MSN}/live${query}`), { params: Promise.resolve({ id: MSN }) });

let db: MemoryDb;
beforeEach(() => { db = createMemoryDb(); db.seed("missions", [{ id: MSN, user_id: "u-1", status: "executing" }]); state.viewer = { userId: "u-1", isGuest: false, emailVerified: true }; });
afterEach(() => { vi.unstubAllEnvs(); });

describe("flag off (unset, as in production)", () => {
  it("404, never cached, and no storage read", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "");
    const c = makeClient(db);
    state.client = c.client;
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(c.calls).toEqual({ list: 0, download: 0 });
  });
  it("«test»: 404 unless the worker marked the mission as a test account's; marked: the route answers", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "test");
    const c = makeClient(db);
    state.client = c.client;
    expect((await get()).status).toBe(404);
    c.objects.set(`${MSN}/stage2/test_account.json`, JSON.stringify({ test: true }));
    expect((await get()).status).toBe(200);
  });
});

describe("flag on", () => {
  beforeEach(() => { vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "on"); });
  it("another customer's mission: 404; a signed-out viewer: 401", async () => {
    db.reset();
    db.seed("missions", [{ id: MSN, user_id: "u-2", status: "executing" }]);
    state.client = makeClient(db).client;
    expect((await get()).status).toBe(404);
    state.viewer = null;
    expect((await get()).status).toBe(401);
  });
  it("no snapshot yet: the empty answer (the screen keeps today's panel)", async () => {
    state.client = makeClient(db).client;
    const res = await get();
    expect(await res.json()).toEqual({ success: true, changed: false, cursor: null, retryAfterMs: 30_000, empty: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("the NEWEST snapshot is served: the counter, the sheets and one window", async () => {
    const c = makeClient(db);
    c.put("snap_000000003_w1.json", snap(3, 5));
    c.put("snap_000000011_w1.json", snap(11, 120));
    c.put("snap_000000007_w1.json", snap(7, 60));
    state.client = c.client;
    const json = await (await get("?sheet=comments&offset=100&limit=10")).json();
    expect([json.changed, json.cursor, json.counterAr, json.delivered]).toEqual([true, "11.0.running", "١٢٠ (أكثر من التقدير البالغ ٤٠)", 120]);
    expect(json.sheets).toEqual([{ stageKey: "comments", nameAr: "التعليقات", headers: ["نص التعليق", "المعرّف"], total: 120 }]);
    expect(json.window.rows.map((r: { id: string }) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `c${100 + i}`));
  });
  it("the done snapshot of a seq is newer than the running one of the same seq; the same cursor answers «nothing changed»", async () => {
    const c = makeClient(db);
    c.put("snap_000000011_w1.json", snap(11, 120));
    c.put("snap_000000011_w1_done.json", snap(11, 120, "done"));
    state.client = c.client;
    const json = await (await get()).json();
    expect([json.status, json.retryAfterMs]).toEqual(["done", null]);
    const same = await (await get(`?cursor=${encodeURIComponent(json.cursor)}`)).json();
    expect(same).toEqual({ success: true, changed: false, cursor: "11.0.done", retryAfterMs: 30_000 });
  });
  it("a snapshot of another mission or a broken object is never served", async () => {
    const c = makeClient(db);
    c.put("snap_000000011_w1.json", { ...snap(11, 3), missionId: "msn_other00000001" });
    state.client = c.client;
    expect((await (await get()).json()).empty).toBe(true);
  });
});
