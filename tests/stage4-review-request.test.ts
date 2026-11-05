import { readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tiktokWorld } from "./helpers/round11Worlds";
import { addonRowOf, objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";
import { ME, MISSION, OTHER_MISSION, addonRowsIn, openRowsIn, requestClient, type RequestWorld, type WorldOpts } from "./helpers/reviewRequestWorld";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any, viewerCalls: 0, adminCalls: 0 }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => { state.adminCalls += 1; return state.client; }, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => { state.viewerCalls += 1; return state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) }; }) };
});

import { GET, POST } from "../src/app/api/missions/[id]/review-request/route";
import { GET as QUOTE } from "../src/app/api/missions/[id]/review-quote/route";
import { GET as DOWNLOAD } from "../src/app/api/missions/[id]/file/route";
import { addonId, checkAddon, readAddonPlan } from "../src/lib/agentMission/addonSettlement";
import { reviewCard } from "../src/lib/agentMission/stage4/addonQuote";
import { reviewCellsOf } from "../src/lib/agentMission/stage4/review";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { digestOf, firstVersionFromCells, versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";

/**
 * MONEY PR 7d, PHASE 2B-2 TASK 3: CREATE AND MANAGE A REVIEW REQUEST BEFORE PAYMENT (docs/MONEY-PR-7A.md section 16). /api/missions/[id]/review-request, behind DIGER_STAGE4_REVIEW (read first):
 *   POST {action:"create", version}   makes the add-on row of a review of that PUBLISHED version: priced again by the server (`reviewCellsOf` + `reviewCard`), checked by `createAddonRow`/`canCreateAddon`, stored `plan_ready` and NOTHING ELSE;
 *   GET                               the waiting request of this file, if any (the page finds it again after a refresh);
 *   POST {action:"cancel", requestId} cancels an UNPAID `plan_ready` review request with one compare-and-set.
 * No point is held, charged, released or refunded; no job, no ledger, no wallet; no provider, no model. The browser sends only the version (and the request id to cancel): never a price, a cell count, a plan or an owner. Every dependency here is a fake.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  state.viewer = { userId: ME, isGuest: false, emailVerified: true }; state.viewerCalls = 0; state.adminCalls = 0;
  vi.stubEnv("DIGER_STAGE4_REVIEW", "on");
  vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const ctx = (id = MISSION) => ({ params: Promise.resolve({ id }) });
const post = async (body: unknown, id = MISSION) => POST(new NextRequest(`http://localhost/api/missions/${id}/review-request`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx(id));
const get = async (id = MISSION) => GET(new NextRequest(`http://localhost/api/missions/${id}/review-request`), ctx(id));
const create = (version: number | string = 1) => post({ action: "create", version });
const cancel = (requestId: string) => post({ action: "cancel", requestId });
const world = (opts: WorldOpts = {}, objects?: Record<string, string>): RequestWorld => { const w = requestClient(objects ?? OBJECTS, opts); state.client = w; return w; };
const priceOf = (cells: number) => Math.max(100, Math.ceil(cells / 100));

let v1: FileVersion; let v2: FileVersion; let OBJECTS: Record<string, string>;
beforeAll(async () => {
  const { cells } = await tiktokWorld();
  v1 = firstVersionFromCells({ missionId: MISSION, cells, createdAt: "2026-11-02T12:00:00.000Z" });
  const sheet = v1.sheets[0];
  const r = applyEditRequest(v1, { kind: "add_column", sheet: sheet.nameAr, titleAr: "اسم القناة", values: Object.fromEntries(sheet.rows.map((x, i) => [x.id, `قناة ${i + 1}`])) }, { createdAt: "2026-11-03T09:30:00.000Z" });
  if (!r.ok) throw new Error(`the fixture edit was refused: ${r.reason}`);
  v2 = r.version;
  OBJECTS = objectsOf(v1, v2);
}, 60_000);

describe("TEST 1, 2, 3: a valid request is created, priced again by the server, and stored waiting", () => {
  it("version 1: 201 with the deterministic id, plan_ready, the server's cells and price; one insert and nothing else", async () => {
    const w = world();
    const res = await create(1);
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const cells = reviewCellsOf(v1);
    const id = addonId(MISSION, 1, 1);
    expect(await res.json()).toEqual({ success: true, created: true, request: { id, version: 1, cells, points: priceOf(cells), status: "plan_ready" } });
    expect(w.log).toEqual([`insert ${id} plan_ready`]);
    const row = w.rows.get(id);
    expect(row).toMatchObject({ user_id: ME, status: "plan_ready" });
    expect(row.request_text.length).toBeGreaterThanOrEqual(3);
    expect(row.job_id ?? null).toBeNull();
    expect(row.reserved_points ?? null).toBeNull();
    const addon = readAddonPlan(row.plan)!;
    expect(addon).toMatchObject({ v: 1, kind: "review", of: MISSION, baseVersion: 1, newVersion: null, attempt: 1, request: { kind: "review" } });
    expect(addon.pricing).toEqual(reviewCard(cells).ok ? (reviewCard(cells) as any).pricing : null);
    expect(checkAddon(id, addon)).toMatchObject({ ok: true, holdPoints: priceOf(cells) });
  }, 60_000);
  it("version 2: another id (the version is in it), the cells and the price of THAT version", async () => {
    const w = world();
    const res = await create(2);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.request).toEqual({ id: addonId(MISSION, 2, 1), version: 2, cells: reviewCellsOf(v2), points: priceOf(reviewCellsOf(v2)), status: "plan_ready" });
    expect(body.request.cells).toBeGreaterThan(reviewCellsOf(v1));
    expect(w.rows.get(body.request.id).plan.addon.baseVersion).toBe(2);
  }, 60_000);
  it("the price is the server's: 12,000 cells are 120 points, and a stored price of ANOTHER size is never used", async () => {
    const w = world({}, objectsOf(sizedVersion(300, 40)));
    const body = await (await create(1)).json();
    expect(body.request).toMatchObject({ cells: 12_000, points: 120 });
    expect(w.rows.get(body.request.id).plan.addon.pricing).toMatchObject({ cells: 12_000, holdPoints: 120, estimatePoints: 120 });
  }, 120_000);
  it("the browser sends the version only: a price, a cell count, a plan, an owner, a mission id or any other field is a 400 and nothing is written", async () => {
    const w = world();
    for (const extra of [{ price: 1 }, { points: 1 }, { cells: 1 }, { plan: { addon: {} } }, { addon: {} }, { userId: "u-2" }, { user_id: "u-2" }, { of: OTHER_MISSION }, { missionId: OTHER_MISSION }, { requestText: "x" }, { status: "approved" }, { pricing: {} }]) {
      const res = await post({ action: "create", version: 1, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(w.log).toEqual([]);
  }, 60_000);
  it("a bad body is 400: not JSON, no action, an unknown action, no version, a version that is not exactly one positive whole number", async () => {
    const w = world();
    for (const body of ["{not json", "[]", "null", {}, { action: "approve", version: 1 }, { action: "create" }, { action: "create", version: 0 }, { action: "create", version: -1 }, { action: "create", version: 1.5 }, { action: "create", version: "01" }, { action: "create", version: "1e1" }, { action: "create", version: true }, { action: "create", version: null }, { action: "create", version: [1] }, { action: "create", version: 10000 }, { action: "cancel" }, { action: "cancel", requestId: 5 }, { action: "cancel", requestId: "../x" }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(w.log).toEqual([]);
  });
});

describe("TEST 4, 5, 6: ownership, authentication, and a version that is missing, pending, damaged or unreadable", () => {
  it("not signed in: 401; a stranger's mission and a missing mission read the same (404); nothing is written", async () => {
    const w = world({}, { ...OBJECTS, ...objectsOf(sizedVersion(10, 10, OTHER_MISSION)) });
    state.viewer = null;
    expect((await create(1)).status).toBe(401);
    expect((await get()).status).toBe(401);
    state.viewer = { userId: ME, isGuest: false, emailVerified: true };
    const theirs = await post({ action: "create", version: 1 }, OTHER_MISSION);
    const nobody = await post({ action: "create", version: 1 }, "msn_bbbbbbbbbbbbbbbbbbbb");
    expect(theirs.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect(await theirs.json()).toEqual(await nobody.json());
    const g1 = await get(OTHER_MISSION); const g2 = await get("msn_bbbbbbbbbbbbbbbbbbbb");
    expect([g1.status, g2.status]).toEqual([404, 404]);
    expect(await g1.json()).toEqual(await g2.json());
    expect(w.log).toEqual([]);
  });
  it("the owner comes from the server's viewer, never from the body or the URL", async () => {
    const w = world(); state.viewer = { userId: "u-2", isGuest: false, emailVerified: true };
    expect((await post({ action: "create", version: 1 })).status).toBe(404);
    expect(w.log).toEqual([]);
  });
  it("a version that is not published is 404 (a pending add-on version is not one), and a stored object of another mission is never used", async () => {
    const w = world({}, { [`${MISSION}/${versionPathOf(1)}`]: JSON.stringify(v1), [`${MISSION}/addons/mad_1/v0002.json`]: JSON.stringify(v2), [`${MISSION}/addons/mad_1/freeze.json`]: "{}" });
    for (const v of [2, 3, 9999]) { const res = await create(v); expect(res.status, String(v)).toBe(404); expect(JSON.stringify(await res.json())).not.toMatch(/addons|freeze|points|cells/); }
    world({}, { [`${MISSION}/${versionPathOf(1)}`]: JSON.stringify(sizedVersion(10, 10, OTHER_MISSION)) });
    expect((await create(1)).status).toBe(500);
    expect(w.log).toEqual([]);
  });
  it("a damaged published version is 500 and creates nothing", async () => {
    for (const body of ["{not json", JSON.stringify({ ...v2, digest: "0".repeat(64) }), JSON.stringify({ ...v2, version: 7 }), JSON.stringify({ ...v2, sheets: [], digest: digestOf([]) })]) {
      const w = world({}, { ...OBJECTS, [`${MISSION}/${versionPathOf(2)}`]: body });
      const res = await create(2);
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toMatch(/points|cells|id"/);
      expect(w.log).toEqual([]);
    }
  }, 60_000);
  it("every storage or database failure is 503 and creates nothing: the listing, the read, the mission read, the add-on read, the insert itself", async () => {
    for (const opts of [{ listError: true }, { downloadError: true }, { missionError: true }, { addonQueryError: true }, { insertError: true }] as WorldOpts[]) {
      const w = world(opts);
      const res = await create(1);
      expect(res.status, JSON.stringify(opts)).toBe(503);
      expect(JSON.stringify(await res.json())).not.toMatch(/database|storage|rate limited|msn_/);
      expect(openRowsIn(w), JSON.stringify(opts)).toEqual([]);
    }
  });
  it("a version too large to review, or with nothing to review, is refused with no row", async () => {
    let w = world({}, objectsOf(sizedVersion(2600, 200)));
    let res = await create(1);
    expect([res.status, (await res.json()).error]).toEqual([409, "too_large"]);
    expect(w.log).toEqual([]);
    w = world({}, objectsOf(firstVersionFromCells({ missionId: MISSION, cells: { "الورقة": [["المعرّف"]] }, createdAt: "2026-11-02T12:00:00.000Z" })));
    res = await create(1);
    expect([res.status, (await res.json()).error]).toEqual([409, "nothing_to_review"]);
    expect(w.log).toEqual([]);
  }, 120_000);
});

describe("TEST 7, 8: a version already reviewed, and another add-on already open", () => {
  it("a completed review of that version: 409 review_exists, no row", async () => {
    const w = world({ seed: [addonRowOf({ status: "completed", kind: "review", base: 1 })] });
    const res = await create(1);
    expect([res.status, (await res.json()).error]).toEqual([409, "review_exists"]);
    expect(w.log).toEqual([]);
    // another version is still requestable
    expect((await create(2)).status).toBe(201);
  }, 60_000);
  it("every open status, whatever its kind: 409 open_addon and no second row", async () => {
    for (const status of ["queued", "planning", "needs_input", "plan_ready", "approved", "executing"]) for (const kind of ["review", "edit"] as const) {
      const w = world({ seed: [addonRowOf({ status, kind, base: kind === "review" ? 2 : 2 })] });
      const res = await create(1);
      expect([res.status, (await res.json()).error], `${status} ${kind}`).toEqual([409, "open_addon"]);
      expect(w.log, `${status} ${kind}`).toEqual([]);
    }
  });
  it("an ended add-on or another customer's or another mission's does not block; the next attempt number makes a new id", async () => {
    for (const status of ["cancelled", "failed", "unserved"]) {
      const w = world({ seed: [addonRowOf({ status, kind: "review", base: 1 })] });
      const res = await create(1);
      expect(res.status, status).toBe(201);
      expect((await res.json()).request.id).toBe(addonId(MISSION, 1, 2));
      expect(openRowsIn(w)).toHaveLength(1);
    }
    const w = world({ seed: [addonRowOf({ status: "executing", kind: "edit", base: 1, of: OTHER_MISSION }), addonRowOf({ status: "executing", kind: "edit", base: 1, user: "u-2", attempt: 3 })] });
    expect((await create(1)).status).toBe(201);
    expect(openRowsIn(w)).toHaveLength(2); // the stranger's executing row and mine: only MY rows were looked at
  }, 60_000);
});

describe("TEST 9, 10: duplicate clicks and concurrent creation", () => {
  it("a second click after the first: 200 with the SAME request, created:false, still one row", async () => {
    const w = world();
    const a = await (await create(1)).json();
    const res = await create(1);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b).toEqual({ success: true, created: false, request: a.request });
    expect(addonRowsIn(w)).toHaveLength(1);
    expect(w.log).toHaveLength(1);
  }, 60_000);
  it("five clicks at the same time on one version: exactly one row, one «created», the same id in every answer", async () => {
    const w = world();
    const answers = await Promise.all(Array.from({ length: 5 }, () => create(1)));
    const bodies = await Promise.all(answers.map((r) => r.json()));
    expect(addonRowsIn(w)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.request?.id)).size).toBe(1);
    expect(bodies.filter((b) => b.created === true)).toHaveLength(1);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(w.log.filter((l) => l.startsWith("insert"))).toHaveLength(1);
  }, 60_000);
  it("two clicks at the same time on DIFFERENT versions: never two open requests; the answer matches the database", async () => {
    const w = world();
    const [a, b] = await Promise.all([create(1), create(2)]);
    expect(openRowsIn(w)).toHaveLength(1);
    const open = openRowsIn(w)[0];
    const bodies = [await a.json(), await b.json()];
    const created = bodies.filter((x) => x.created === true);
    expect(created).toHaveLength(1);
    expect(created[0].request.id).toBe(open.id);
    const refused = bodies.find((x) => x.created !== true)!;
    expect(refused).toMatchObject({ success: false, error: "open_addon" });
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  }, 60_000);
  it("a creator's request that lost the race is cancelled by the winner's compare-and-set only while still plan_ready: no other row changes", async () => {
    const w = world();
    await Promise.all([create(1), create(2)]);
    const rows = addonRowsIn(w);
    for (const r of rows) expect(["plan_ready", "cancelled"]).toContain(r.status);
    for (const l of w.log.filter((x) => x.startsWith("update"))) expect(l).toContain('"status":"cancelled"');
  }, 60_000);
});

describe("TEST 11: a page refresh finds the waiting request again, and creates nothing", () => {
  it("none yet: {request:null}; after the creation: the same request with its server price; many refreshes write nothing", async () => {
    const w = world();
    const none = await get();
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ success: true, request: null });
    const made = (await (await create(1)).json()).request;
    const logLength = w.log.length;
    for (let i = 0; i < 4; i += 1) {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({ success: true, request: made });
    }
    expect(w.log).toHaveLength(logLength);
    expect(addonRowsIn(w)).toHaveLength(1);
  }, 60_000);
  it("the price shown on recovery is recomputed from the stored cells by the card, not read from a stored points field", async () => {
    const seeded = addonRowOf({ status: "plan_ready", kind: "review", base: 1 });
    (seeded.plan as any).addon.pricing.cells = 12_000;
    (seeded.plan as any).addon.pricing.holdPoints = 1;
    (seeded.plan as any).addon.pricing.estimatePoints = 1;
    world({ seed: [seeded] });
    expect((await (await get()).json()).request).toMatchObject({ id: seeded.id, version: 1, cells: 12_000, points: 120, status: "plan_ready" });
  });
  it("no waiting REVIEW request: an open add-on of another kind, a started one, a completed or ended one, another customer's, are not shown as waiting", async () => {
    for (const seed of [addonRowOf({ status: "plan_ready", kind: "edit", base: 1 }), addonRowOf({ status: "executing", kind: "review", base: 1 }), addonRowOf({ status: "completed", kind: "review", base: 1 }), addonRowOf({ status: "cancelled", kind: "review", base: 1 }), addonRowOf({ status: "plan_ready", kind: "review", base: 1, user: "u-2" })]) {
      world({ seed: [seed] });
      expect(await (await get()).json(), `${seed.status}`).toEqual({ success: true, request: null });
    }
  });
  it("a storage or database failure on recovery is 503, never «no request»", async () => {
    world({ addonQueryError: true });
    expect((await get()).status).toBe(503);
    world({ missionError: true });
    expect((await get()).status).toBe(503);
  });
});

describe("TEST 12, 13: cancelling an unpaid request, and refusing once its status changed", () => {
  it("cancels a waiting request with ONE compare-and-set; the row keeps its plan and nothing else changes; the next request gets a new attempt id", async () => {
    const w = world();
    const made = (await (await create(1)).json()).request;
    const before = JSON.stringify(w.rows.get(made.id).plan);
    const res = await cancel(made.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(w.rows.get(made.id).status).toBe("cancelled");
    expect(JSON.stringify(w.rows.get(made.id).plan)).toBe(before);
    expect(w.log.filter((l) => l.startsWith("update"))).toHaveLength(1);
    expect(await (await get()).json()).toEqual({ success: true, request: null });
    const again = await (await create(1)).json();
    expect(again.request.id).toBe(addonId(MISSION, 1, 2));
    expect(openRowsIn(w)).toHaveLength(1);
  }, 60_000);
  it("a second cancel and a cancel of a request in any other status are refused (409) and change nothing: started, running, completed, failed, ended", async () => {
    for (const status of ["cancelled", "queued", "planning", "needs_input", "approved", "executing", "completed", "failed", "unserved"]) {
      const seed = addonRowOf({ status, kind: "review", base: 1 });
      const w = world({ seed: [seed] });
      const res = await cancel(seed.id);
      expect(res.status, status).toBe(409);
      expect(w.rows.get(seed.id).status, status).toBe(status);
      expect(w.log, status).toEqual([]);
    }
  });
  it("a request that already holds a job (money reserved) is refused even if its status still says plan_ready", async () => {
    const seed = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 1 }), job_id: "job_1", reserved_points: 100 };
    const w = world({ seed: [seed] });
    expect((await cancel(seed.id)).status).toBe(409);
    expect(w.rows.get(seed.id).status).toBe("plan_ready");
    expect(w.log).toEqual([]);
  });
  it("the status changes between the read and the update: the compare-and-set matches nothing, the answer is 409 and the row is left as the other process made it", async () => {
    const seed = addonRowOf({ status: "plan_ready", kind: "review", base: 1 });
    const w = world({ seed: [seed], beforeUpdate: (rows, id) => { if (id === seed.id) rows.get(id)!.status = "approved"; } });
    const res = await cancel(seed.id);
    expect(res.status).toBe(409);
    expect(w.rows.get(seed.id).status).toBe("approved");
    expect(w.log).toEqual([]);
  });
  it("a job appears between the read and the update (money reserved in that instant): the compare-and-set also requires no job, matches nothing, and the answer is 409", async () => {
    const seed = addonRowOf({ status: "plan_ready", kind: "review", base: 1 });
    const w = world({ seed: [seed], beforeUpdate: (rows, id) => { if (id === seed.id) rows.get(id)!.job_id = "job_1"; } });
    const res = await cancel(seed.id);
    expect(res.status).toBe(409);
    expect(w.rows.get(seed.id).status).toBe("plan_ready");
    expect(w.log).toEqual([]);
  });
  it("only the customer's OWN review request: a stranger's, a missing one, an ordinary mission, and an add-on of another kind are all 404 and untouched", async () => {
    const mine = addonRowOf({ status: "plan_ready", kind: "review", base: 1 });
    const theirs = addonRowOf({ status: "plan_ready", kind: "review", base: 1, user: "u-2", attempt: 4 });
    const edit = addonRowOf({ status: "plan_ready", kind: "edit", base: 1, attempt: 5 });
    const ordinary = { id: "msn_ordinary000000001", user_id: ME, status: "plan_ready", plan: { stages: [] }, request_text: "هات منشورات" };
    const w = world({ seed: [mine, theirs, edit, ordinary] });
    const answers = await Promise.all([theirs.id, "msn_cccccccccccccccccccc", ordinary.id, edit.id].map((id) => cancel(id)));
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    const bodies = await Promise.all(answers.map((r) => r.json()));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(w.rows.get(theirs.id).status).toBe("plan_ready");
    expect(w.rows.get(ordinary.id).status).toBe("plan_ready");
    expect(w.rows.get(edit.id).status).toBe("plan_ready");
    expect(w.log).toEqual([]);
  });
  it("a request that belongs to another mission than the URL's is not cancelled through this mission's URL", async () => {
    const seed = addonRowOf({ status: "plan_ready", kind: "review", base: 1, of: OTHER_MISSION });
    const w = world({ seed: [{ ...seed, user_id: ME }] });
    expect((await cancel(seed.id)).status).toBe(404);
    expect(w.rows.get(seed.id).status).toBe("plan_ready");
  });
  it("a failing database on cancel is 503 and the row is unchanged", async () => {
    const seed = addonRowOf({ status: "plan_ready", kind: "review", base: 1 });
    const w = world({ seed: [seed], updateError: true });
    expect((await cancel(seed.id)).status).toBe(503);
    expect(w.rows.get(seed.id).status).toBe("plan_ready");
  });
});

describe("TEST 15, 16: no money and no provider", () => {
  it("across every answer only the missions table is touched: no job, ledger, wallet, quote or event row, no rpc, no storage write, no fetch", async () => {
    const worlds: RequestWorld[] = [];
    for (const opts of [{}, { seed: [addonRowOf({ status: "completed", kind: "review", base: 1 })] }, { seed: [addonRowOf({ status: "executing", kind: "edit", base: 2 })] }, { listError: true }, { insertError: true }] as WorldOpts[]) {
      const w = world(opts); worlds.push(w);
      const made = await create(1); await create(2); await get(); await post({ action: "create", version: 0 });
      const body = await made.json();
      if (body.request?.id) await cancel(body.request.id);
    }
    for (const w of worlds) { expect([...w.tables]).toEqual(["missions"]); expect(w.other).toEqual([]); expect(w.storageWrites).toEqual([]); }
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 120_000);
  it("the write code touches only the missions table, inserts only plan_ready, cancels only by compare-and-set on plan_ready, and has no money, approval, settlement or provider call", () => {
    const code = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const files = ["../src/lib/agentMission/stage4/reviewRequest.ts", "../src/lib/agentMission/stage4/addonRowStore.ts", "../src/app/api/missions/[id]/review-request/route.ts"];
    const src = files.map(code).join("\n");
    expect(src).not.toMatch(/\.rpc\(|\.upload\(|\.remove\(|createSignedUrl|\.upsert\(|\.delete\(/);
    expect([...new Set([...src.matchAll(/\.from\(\s*([A-Za-z_"]+)/g)].map((m) => m[1]))]).toEqual(["MISSION_TABLE"]);
    expect(src).not.toMatch(/settleAddon|approveAddon|approveMission|accept_quote|release_job|credit_ledger|reserve|refund|gateway|anthropic|openai|\bfetch\s*\(/i);
    expect(src).not.toMatch(/status:\s*"(approved|executing|completed|failed)"/);
    expect(src).toMatch(/status:\s*"cancelled"/);
    expect(src).toMatch(/\.eq\("status",\s*"plan_ready"\)/);
    expect(src).toMatch(/\.is\("job_id",\s*null\)/);
    expect(src).toMatch(/createAddonRow\(/);
    expect(src).toMatch(/reviewCard\(/);
    expect(src).toMatch(/readPublishedVersion\(/);
    expect(src).not.toMatch(/Math\.ceil|reviewHoldPoints|CELLS_PER_POINT/); // no second price formula
  });
});

describe("TEST 17: the flag", () => {
  it("DIGER_STAGE4_REVIEW not exactly «on»: GET and POST are 404 before the viewer or the database is touched; nothing is written", async () => {
    const w = world();
    for (const v of ["", "off", "test", "yes", "true", "1", "enabled"]) {
      vi.stubEnv("DIGER_STAGE4_REVIEW", v);
      for (const res of [await get(), await create(1), await cancel("msn_aaaaaaaaaaaaaaaaaaaa")]) {
        expect(res.status, v).toBe(404);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
      }
    }
    vi.unstubAllEnvs();
    expect((await create(1)).status).toBe(404);
    expect(state.viewerCalls).toBe(0);
    expect(state.adminCalls).toBe(0);
    expect(w.log).toEqual([]);
  });
  it("the edits and versions flags do not matter, and the existing quote and download routes answer the same with the flag off and on", async () => {
    vi.stubEnv("DIGER_STAGE4_VERSIONS", ""); vi.stubEnv("DIGER_STAGE4_EDITS", "");
    world();
    expect((await create(1)).status).toBe(201);
    vi.stubEnv("DIGER_STAGE4_EDITS", "on");
    const seen: number[][] = [];
    for (const flag of ["", "on"]) {
      vi.stubEnv("DIGER_STAGE4_REVIEW", flag); vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
      world();
      const d = await DOWNLOAD(new NextRequest(`http://localhost/api/missions/${MISSION}/file?name=result.xlsx&version=1&stream=1`), ctx());
      const q = await QUOTE(new NextRequest(`http://localhost/api/missions/${MISSION}/review-quote?version=1`), ctx());
      seen.push([d.status, q.status]);
    }
    expect(seen).toEqual([[200, 404], [200, 200]]);
  }, 60_000);
});
