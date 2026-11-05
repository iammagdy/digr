import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ME, MISSION, OTHER_MISSION, addonRowsIn, openRowsIn, requestClient, type RequestWorld } from "./helpers/reviewRequestWorld";
import { addonRowOf, objectsOf } from "./helpers/reviewQuoteWorld";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any, viewerCalls: 0, adminCalls: 0 }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => { state.adminCalls += 1; return state.client; }, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => { state.viewerCalls += 1; return state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) }; }) };
});

import { GET, POST } from "../src/app/api/missions/[id]/edit-request/route";
import { addonId } from "../src/lib/agentMission/addonSettlement";
import { editCard } from "../src/lib/agentMission/stage4/addonQuote";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { firstVersionFromCells, versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";
import { createReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import { reviewFile } from "../src/lib/agentMission/stage4/review";
import { readAddonPlan } from "../src/lib/agentMission/addonSettlement";

/**
 * STAGE B: THE CUSTOMER'S EDIT REQUEST BEFORE PAYMENT, behind DIGER_STAGE4_EDITS. The customer asks for an edit of the LATEST published version of their own file (rename a column, correct selected cells with values they typed, add items they typed); the server prices it
 * by the existing `editCard` (never from the browser, never by a model), shows what will change and what it covers, and makes an UNPAID add-on row (`plan_ready`) that WAITS for approval. Nothing is held, charged or released; no provider is called; the original is never touched;
 * no item is ever deleted. An edit that needs a new LOOKUP (a new column, a correction by search, a fix from a review issue) has no safe recipe or lookup price yet: it is refused with a clear unsupported state and creates nothing.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  state.viewer = { userId: ME, isGuest: false, emailVerified: true }; state.viewerCalls = 0; state.adminCalls = 0;
  vi.stubEnv("DIGER_STAGE4_EDITS", "on");
  vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const SHEET = "العملاء";
const HEAD = ["المعرّف", "الاسم", "البريد الإلكتروني", "الهاتف"];
const v1 = (): FileVersion => firstVersionFromCells({ missionId: MISSION, createdAt: "2026-11-02T12:00:00.000Z", cells: { [SHEET]: [HEAD, ["a_1", "أحمد", "a@b.co", "01000000000"], ["a_2", "", "bad", "123"], ["a_3", "سارة", "s@b.co", "01111111111"], ["a_4", "أحمد", "a@b.co", "01000000000"]] } });
let V1: FileVersion;
const world = (versions: FileVersion[] = [V1 ?? (V1 = v1())], opts: Parameters<typeof requestClient>[1] = {}): RequestWorld => { const w = requestClient(objectsOf(...versions), opts); state.client = w; return w; };
const routeCall = (body: unknown, id = MISSION) => POST(new NextRequest(`http://localhost/api/missions/${id}/edit-request`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const getCall = (query = "", id = MISSION) => GET(new NextRequest(`http://localhost/api/missions/${id}/edit-request${query ? `?${query}` : ""}`), { params: Promise.resolve({ id }) });
const rename = { kind: "rename_column", sheet: SHEET, from: "الهاتف", to: "رقم الموبايل" };
const cells = (...c: Array<[number, string, string]>) => ({ kind: "set_cells", sheet: SHEET, cells: c.map(([row, column, value]) => ({ row, column, value })) });
const quote = async (edit: unknown, version = 1) => (await routeCall({ action: "quote", version, edit })).json();
const create = (edit: unknown, version = 1) => routeCall({ action: "create", version, edit });
const priceOf = (units: number) => { const c = editCard({ kind: "edit", units, tools: [] }); if (!c.ok) throw new Error("card refused"); return { estimatePoints: c.estimatePoints, holdPoints: c.holdPoints }; };
beforeEach(() => { V1 = v1(); });

describe("the flag, the identity and the input", () => {
  it("flag unset, empty, «test» or any other word: 404 before the id, the viewer or the database is looked at (GET and POST)", async () => {
    for (const v of [undefined, "", "off", "test", "yes"]) {
      if (v === undefined) vi.unstubAllEnvs(); else vi.stubEnv("DIGER_STAGE4_EDITS", v);
      world();
      expect((await getCall()).status, String(v)).toBe(404);
      expect((await routeCall({ action: "quote", version: 1, edit: rename })).status, String(v)).toBe(404);
      expect([state.viewerCalls, state.adminCalls]).toEqual([0, 0]);
    }
  });
  it("the REVIEW flag alone does not open the edit route", async () => {
    vi.unstubAllEnvs(); vi.stubEnv("DIGER_STAGE4_REVIEW", "on");
    world();
    expect((await getCall()).status).toBe(404);
  });
  it("a bad id, bad JSON, an unknown action, a missing or bad version are 400", async () => {
    world();
    expect((await routeCall({ action: "quote", version: 1, edit: rename }, "../x")).status).toBe(400);
    expect((await routeCall("{nope")).status).toBe(400);
    expect((await routeCall(null)).status).toBe(400);
    expect((await routeCall({ action: "approve", version: 1, edit: rename })).status).toBe(400);
    for (const version of [undefined, 0, -1, 1.5, "01", "x", 12345, null, [1]]) expect((await routeCall({ action: "quote", version, edit: rename })).status, String(version)).toBe(400);
    expect((await routeCall({ action: "quote", version: 1 })).status).toBe(400);
  });
  it("the body holds the version and the edit and NOTHING else: no price, units, plan, owner, mission id, row id or cost is accepted", async () => {
    world();
    for (const extra of [{ points: 1 }, { price: 1 }, { units: 1 }, { holdPoints: 1 }, { plan: {} }, { userId: "u-2" }, { missionId: OTHER_MISSION }, { rowIds: ["a_1"] }, { costUsd: 0 }, { requestId: "msn_0123456789abcdef0123" }, { status: "approved" }]) {
      expect((await routeCall({ action: "quote", version: 1, edit: rename, ...extra })).status, JSON.stringify(extra)).toBe(400);
      expect((await routeCall({ action: "create", version: 1, edit: rename, ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    // nor inside the edit
    for (const extra of [{ points: 1 }, { rowId: "a_1" }, { id: "x" }, { reread: {} }, { values: {} }]) expect((await routeCall({ action: "quote", version: 1, edit: { ...rename, ...extra } })).status, JSON.stringify(extra)).toBe(400);
    expect((await routeCall({ action: "quote", version: 1, edit: { ...cells([1, "الاسم", "س"]), cells: [{ row: 1, column: "الاسم", value: "س", rowId: "a_1" }] } })).status).toBe(400);
    expect(openRowsIn(state.client as RequestWorld)).toEqual([]);
  });
  it("not signed in: 401 and nothing is read", async () => {
    const w = world(); state.viewer = null;
    expect((await getCall()).status).toBe(401);
    expect((await routeCall({ action: "quote", version: 1, edit: rename })).status).toBe(401);
    expect(w.storageWrites).toEqual([]);
  });
  it("another customer's file and a file that does not exist: 404 with the same body, for the quote, the creation and the list", async () => {
    world();
    const a = await routeCall({ action: "quote", version: 1, edit: rename }, OTHER_MISSION);
    const b = await routeCall({ action: "quote", version: 1, edit: rename }, "msn_bbbbbbbbbbbbbbbbbbbb");
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(await a.json()).toEqual(await b.json());
    expect((await routeCall({ action: "create", version: 1, edit: rename }, OTHER_MISSION)).status).toBe(404);
    expect(addonRowsIn(state.client as RequestWorld, OTHER_MISSION)).toEqual([]);
    expect((await getCall("", OTHER_MISSION)).status).toBe(404);
    expect((await getCall("schema=1", OTHER_MISSION)).status).toBe(404);
  });
});

describe("the quote: server-priced, read-only, shows what will change", () => {
  it("rename: the version, what changes, what it covers, the estimate and the most that may be held; all from the server's card", async () => {
    const w = world();
    const res = await routeCall({ action: "quote", version: 1, edit: rename });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { quote: q } = await res.json();
    expect(q).toEqual({ state: "offer", version: 1, newVersion: 2, change: { kind: "rename_column", sheet: SHEET, from: "الهاتف", to: "رقم الموبايل" }, units: 1, ...priceOf(1) });
    expect(q.holdPoints).toBeGreaterThanOrEqual(q.estimatePoints);
    expect(q.holdPoints).toBeGreaterThanOrEqual(100);
    expect(w.log).toEqual([]); // nothing was written
  });
  it("selected cells the customer typed: the item numbers are resolved on the server; the view names the count and the columns, never an item id", async () => {
    world();
    const { quote: q } = await quote(cells([2, "الاسم", "محمد"], [2, "البريد الإلكتروني", "m@b.co"], [3, "الهاتف", "01222222222"]));
    expect(q).toMatchObject({ state: "offer", version: 1, newVersion: 2, units: 3, change: { kind: "set_cells", sheet: SHEET, cells: 3, columns: ["الاسم", "البريد الإلكتروني", "الهاتف"] }, ...priceOf(3) });
    expect(JSON.stringify(q)).not.toMatch(/a_[0-9]|rowId|rowIds/);
  });
  it("items the customer typed, every column filled: the count is the units", async () => {
    world();
    const { quote: q } = await quote({ kind: "add_rows", sheet: SHEET, rows: [{ values: { "الاسم": "منى", "البريد الإلكتروني": "m@x.org", "الهاتف": "01333333333" } }, { values: { "الاسم": "هالة", "البريد الإلكتروني": "h@x.org", "الهاتف": "01444444444" } }] });
    expect(q).toMatchObject({ state: "offer", units: 2, change: { kind: "add_rows", sheet: SHEET, rows: 2 }, ...priceOf(2) });
  });
  it("the price is the existing card's for every size the API allows, and never above the add-on ceiling", async () => {
    world();
    for (const n of [1, 2, 3, 10, 50, 100]) {
      const list = Array.from({ length: n }, (_, i): [number, string, string] => [(i % 4) + 1, ["الاسم", "البريد الإلكتروني", "الهاتف"][Math.floor(i / 4) % 3], `قيمة ${n}-${i}`]);
      const dedup = [...new Map(list.map((c) => [`${c[0]}|${c[1]}`, c])).values()];
      const { quote: q } = await quote(cells(...dedup));
      expect(q.state).toBe("offer");
      expect(q.units).toBe(dedup.length);
      expect({ e: q.estimatePoints, h: q.holdPoints }).toEqual({ e: priceOf(dedup.length).estimatePoints, h: priceOf(dedup.length).holdPoints });
      expect(q.holdPoints).toBeLessThanOrEqual(5000);
    }
  });
  it("the quote is READ-ONLY: not one write, no add-on row, no rpc, no other table, no storage write, no provider", async () => {
    const w = world();
    await quote(rename); await quote(cells([1, "الاسم", "س"])); await routeCall({ action: "quote", version: 1, edit: { kind: "add_column", sheet: SHEET, titleAr: "العنوان" } });
    expect([w.log, w.other, w.storageWrites, [...w.tables]]).toEqual([[], [], [], ["missions"]]);
    expect(addonRowsIn(w)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("the version asked is the one shown: version 2 of a file that has two versions", async () => {
    const sheet = V1.sheets[0];
    const r = applyEditRequest(V1, { kind: "set_cells", sheet: sheet.nameAr, cells: [{ rowId: "a_1", column: "الاسم", value: "محمد" }] }, { createdAt: "2026-11-03T09:30:00.000Z" });
    if (!r.ok) throw new Error(r.reason);
    world([V1, r.version]);
    expect((await quote(rename, 2)).quote).toMatchObject({ state: "offer", version: 2, newVersion: 3 });
    // an edit goes on the latest version only
    expect((await quote(rename, 1)).quote).toEqual({ state: "not_latest", version: 1 });
  });
  it("a version that is not published: 404 (a pending version is not one)", async () => {
    world();
    expect((await routeCall({ action: "quote", version: 2, edit: rename })).status).toBe(404);
  });
});

describe("what is refused before any price", () => {
  const rejected = async (edit: unknown) => { const q = (await quote(edit)).quote; return q; };
  it("an unknown sheet, an unknown column, a locked id column, an item number that does not exist: a clear sentence, no price", async () => {
    world();
    for (const edit of [
      { ...rename, sheet: "ورقة أخرى" }, { ...rename, from: "عمود غير موجود" }, { ...rename, from: "المعرّف" }, { ...rename, to: "الاسم" }, { ...rename, to: "name" }, { ...rename, to: "" }, { ...rename, to: rename.from },
      cells([9, "الاسم", "س"]), cells([0, "الاسم", "س"]), cells([1, "عمود غير موجود", "س"]), cells([1, "المعرّف", "س"]),
    ]) { const q = await rejected(edit); expect([JSON.stringify(edit), q.state]).toEqual([JSON.stringify(edit), "rejected"]); expect(q.messageAr).toMatch(/[؀-ۿ]/); expect(q).not.toHaveProperty("holdPoints"); }
  });
  it("a typed value that is empty, a stated gap, or too long; the same cell twice; too many cells or items", async () => {
    world();
    for (const edit of [cells([1, "الاسم", ""]), cells([1, "الاسم", "   "]), cells([1, "الاسم", "غير متوفر"]), cells([1, "الاسم", "لم يكتمل البحث"]), cells([1, "الاسم", "س".repeat(501)]), cells([1, "الاسم", "a"], [1, "الاسم", "b"]), { kind: "set_cells", sheet: SHEET, cells: [] }]) {
      const res = await routeCall({ action: "quote", version: 1, edit });
      const body = await res.json();
      expect([JSON.stringify(edit).slice(0, 80), res.status === 400 || body.quote?.state === "rejected"]).toEqual([JSON.stringify(edit).slice(0, 80), true]);
    }
    const many = Array.from({ length: 101 }, (_, i): [number, string, string] => [(i % 4) + 1, "الاسم", `v${i}`]);
    expect((await routeCall({ action: "quote", version: 1, edit: cells(...many) })).status).toBe(400);
    const rows = Array.from({ length: 51 }, () => ({ values: { "الاسم": "س", "البريد الإلكتروني": "a@b.co", "الهاتف": "0100000000" } }));
    expect((await routeCall({ action: "quote", version: 1, edit: { kind: "add_rows", sheet: SHEET, rows } })).status).toBe(400);
  });
  it("an added item must fill every readable column: nothing is invented and no «search incomplete» is written for something nobody searched", async () => {
    world();
    const q = await rejected({ kind: "add_rows", sheet: SHEET, rows: [{ values: { "الاسم": "منى" } }] });
    expect(q.state).toBe("rejected");
    expect((await rejected({ kind: "add_rows", sheet: SHEET, rows: [{ values: { "الاسم": "منى", "البريد الإلكتروني": "m@x.org", "الهاتف": "غير متوفر" } }] })).state).toBe("rejected");
    expect((await rejected({ kind: "add_rows", sheet: SHEET, rows: [{ values: { "الاسم": "منى", "البريد الإلكتروني": "m@x.org", "الهاتف": "01", "المعرّف": "x" } }] })).state).toBe("rejected");
    const empty = await routeCall({ action: "quote", version: 1, edit: { kind: "add_rows", sheet: SHEET, rows: [] } });
    expect(empty.status === 400 || (await empty.json()).quote?.state === "rejected").toBe(true);
  });
  it("removing items is never offered", async () => {
    world();
    for (const kind of ["remove_rows", "delete_rows"]) {
      const q = await rejected({ kind, sheet: SHEET, rows: [1] });
      expect(q).toMatchObject({ state: "rejected" });
      expect(q.messageAr).toBe("حذف عناصر من الملف غير متاح. يبقى ملفك كاملًا، ويمكنك طلب عمود أو تصحيح خانة.");
      expect((await create({ kind, sheet: SHEET, rows: [1] })).status).toBe(409);
    }
    expect(addonRowsIn(state.client as RequestWorld)).toEqual([]);
  });
  it("an edit kind that does not exist is refused", async () => {
    world();
    expect((await rejected({ kind: "make_it_pretty", sheet: SHEET })).state).toBe("rejected");
  });
});

describe("what needs a NEW LOOKUP is unsupported: no quote is guessed, nothing is created", () => {
  it("a new column: unsupported, no price, nothing held (the lookup recipe and its price are not available)", async () => {
    const w = world();
    const q = (await quote({ kind: "add_column", sheet: SHEET, titleAr: "العنوان" })).quote;
    expect(q).toEqual({ state: "unsupported", version: 1, why: "lookup_needed" });
    const c = await create({ kind: "add_column", sheet: SHEET, titleAr: "العنوان" });
    expect([c.status, (await c.json()).error]).toEqual([409, "unsupported"]);
    expect([addonRowsIn(w), w.log]).toEqual([[], []]);
  });
  it("a new column with a bad title or an existing name is refused as such, before «unsupported»", async () => {
    world();
    expect((await quote({ kind: "add_column", sheet: SHEET, titleAr: "name" })).quote.state).toBe("rejected");
    expect((await quote({ kind: "add_column", sheet: SHEET, titleAr: "الاسم" })).quote.state).toBe("rejected");
    expect((await quote({ kind: "add_column", sheet: "ورقة أخرى", titleAr: "العنوان" })).quote.state).toBe("rejected");
  });
  it("a correction from a review issue: the issue is recomputed from the WHOLE version by code; it needs a lookup, so it is unsupported and says how many cells it covers", async () => {
    world();
    const truth = reviewFile(V1, { keepRowIds: Number.POSITIVE_INFINITY });
    const issue = truth.issues.find((i) => i.code === "empty_cells")!;
    const q = (await quote({ kind: "review_fix", sheet: issue.sheet, column: issue.column, code: issue.code })).quote;
    expect(q).toEqual({ state: "unsupported", version: 1, why: "lookup_needed", cells: issue.count });
    // a stated duplicate is never «fixed»: no item is removed
    const dup = truth.issues.find((i) => i.code === "exact_duplicate")!;
    expect((await quote({ kind: "review_fix", sheet: dup.sheet, column: dup.column, code: dup.code })).quote).toEqual({ state: "unsupported", version: 1, why: "duplicates" });
    // an issue the review does not have
    const none = (await quote({ kind: "review_fix", sheet: SHEET, column: "الاسم", code: "invalid_phone" })).quote;
    expect(none.state).toBe("rejected");
  });
  it("a correction that asks for a search (a cell with no typed value) is not an input of this API", async () => {
    world();
    expect((await routeCall({ action: "quote", version: 1, edit: { kind: "set_cells", sheet: SHEET, cells: [{ row: 1, column: "الاسم" }] } })).status).toBe(400);
  });
});

describe("the gates: one open request per file, edits on the latest version only", () => {
  it("another request is open on this file (a waiting review, a waiting edit): the quote says blocked and no price", async () => {
    world([V1], { seed: [addonRowOf({ status: "plan_ready", kind: "review", base: 1 })] });
    expect((await quote(rename)).quote).toEqual({ state: "blocked", version: 1 });
    world([V1], { seed: [addonRowOf({ status: "executing", kind: "edit", base: 1 })] });
    expect((await quote(rename)).quote).toEqual({ state: "blocked", version: 1 });
    const c = await create(rename);
    expect([c.status, (await c.json()).error]).toEqual([409, "open_addon"]);
  });
  it("a version that already has a completed edit cannot be edited again", async () => {
    world([V1], { seed: [addonRowOf({ status: "completed", kind: "edit", base: 1 })] });
    expect((await quote(rename)).quote).toEqual({ state: "already_edited", version: 1 });
  });
  it("a finished or cancelled request does not block", async () => {
    world([V1], { seed: [addonRowOf({ status: "cancelled", kind: "edit", base: 1 }), addonRowOf({ status: "failed", kind: "review", base: 1 })] });
    expect((await quote(rename)).quote.state).toBe("offer");
  });
  it("a request of ANOTHER customer on the same id never blocks this one (the rows are read for this customer only)", async () => {
    world([V1], { seed: [{ ...addonRowOf({ status: "plan_ready", kind: "edit", base: 1 }), user_id: "u-2" }] });
    expect((await quote(rename)).quote.state).toBe("offer");
  });
});

describe("making the request: unpaid, waiting, deterministic, one", () => {
  it("rename: 201, a plan_ready row with no job and no approval, the deterministic id, the code's price, the edit as data", async () => {
    const w = world();
    const res = await create(rename);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, created: true, request: { version: 1, newVersion: 2, units: 1, status: "plan_ready", change: { kind: "rename_column", sheet: SHEET, from: "الهاتف", to: "رقم الموبايل" }, ...priceOf(1) } });
    const row = addonRowsIn(w)[0];
    expect(body.request.id).toBe(row.id);
    expect(row.id).toBe(addonId(MISSION, 1, 1));
    expect(row).toMatchObject({ user_id: ME, status: "plan_ready" });
    expect(row.job_id ?? null).toBeNull(); expect(row.approved_at ?? null).toBeNull();
    const plan = readAddonPlan(row.plan)!;
    expect(plan).toMatchObject({ kind: "edit", of: MISSION, baseVersion: 1, newVersion: 2, attempt: 1, request: { kind: "edit", edit: { kind: "rename_column", sheet: SHEET, from: "الهاتف", to: "رقم الموبايل" } } });
    expect(plan.pricing).toMatchObject({ requested: 1, costPerRowUsd: 0, ...priceOf(1) });
    expect(plan.pricing.holdPoints).toBe(priceOf(1).holdPoints);
    // nothing else moved
    expect([w.other, w.storageWrites]).toEqual([[], []]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("selected cells: the stored edit carries the resolved item ids and the typed values; the customer's view carries neither", async () => {
    const w = world();
    const res = await create(cells([2, "الاسم", "محمد"], [3, "الهاتف", "01222222222"]));
    const body = await res.json();
    expect(res.status).toBe(201);
    const plan = readAddonPlan(addonRowsIn(w)[0].plan)!;
    expect((plan.request as any).edit).toEqual({ kind: "set_cells", sheet: SHEET, cells: [{ rowId: "a_2", column: "الاسم", value: "محمد" }, { rowId: "a_3", column: "الهاتف", value: "01222222222" }] });
    expect(JSON.stringify(body)).not.toMatch(/a_2|a_3|rowId|محمد|01222222222/);
    expect(plan.pricing.requested).toBe(2);
  });
  it("added items: the ids are made by the server (never typed), unique, and the request stores exactly the customer's values", async () => {
    const w = world();
    const res = await create({ kind: "add_rows", sheet: SHEET, rows: [{ values: { "الاسم": "منى", "البريد الإلكتروني": "m@x.org", "الهاتف": "01333333333" } }, { values: { "الاسم": "هالة", "البريد الإلكتروني": "h@x.org", "الهاتف": "01444444444" } }] });
    expect(res.status).toBe(201);
    const edit = (readAddonPlan(addonRowsIn(w)[0].plan)!.request as any).edit;
    expect(edit.kind).toBe("add_rows"); expect(edit.count).toBe(2); expect(edit.rows).toHaveLength(2);
    expect(new Set(edit.rows.map((r: any) => r.id)).size).toBe(2);
    for (const r of edit.rows) { expect(r.id).toMatch(/^add_v2_[0-9]+$/); expect(["a_1", "a_2", "a_3", "a_4"]).not.toContain(r.id); expect(r.values["الاسم"]).toBeTruthy(); }
    // the request, applied by the edit engine to the base, is a valid new version with the items appended and nothing removed
    const out = applyEditRequest(V1, { kind: "add_rows", sheet: SHEET, rows: edit.rows }, { createdAt: "2026-11-04T00:00:00.000Z" });
    expect(out.ok && out.version.sheets[0].rows.length).toBe(6);
  });
  it("a second click, a refresh and five clicks at once never make a second request", async () => {
    const w = world();
    const a = await create(rename); const b = await create(rename);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect((await b.json()).created).toBe(false);
    expect(addonRowsIn(w)).toHaveLength(1);
    const w2 = world();
    const all = await Promise.all(Array.from({ length: 5 }, () => create(rename)));
    expect(all.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201].sort());
    expect(addonRowsIn(w2)).toHaveLength(1);
    expect(openRowsIn(w2)).toHaveLength(1);
  });
  it("a DIFFERENT edit while one waits is refused: one open request per file", async () => {
    const w = world();
    await create(rename);
    const c = await create(cells([1, "الاسم", "س"]));
    expect([c.status, (await c.json()).error]).toEqual([409, "open_addon"]);
    expect(addonRowsIn(w)).toHaveLength(1);
  });
  it("a waiting REVIEW request blocks an edit, and a waiting edit blocks a review request", async () => {
    const w = world();
    const r = await createReviewRequest(w, { missionId: MISSION, userId: ME, version: 1 });
    expect(r.ok).toBe(true);
    expect((await create(rename)).status).toBe(409);
    const w2 = world(); await create(rename);
    const r2 = await createReviewRequest(w2, { missionId: MISSION, userId: ME, version: 1 });
    expect(r2).toMatchObject({ ok: false, error: "open_addon" });
  });
  it("it never goes on an old version", async () => {
    const sheet = V1.sheets[0];
    const r = applyEditRequest(V1, { kind: "set_cells", sheet: sheet.nameAr, cells: [{ rowId: "a_1", column: "الاسم", value: "محمد" }] }, { createdAt: "2026-11-03T09:30:00.000Z" });
    if (!r.ok) throw new Error(r.reason);
    const w = world([V1, r.version]);
    const c = await create(rename, 1);
    expect([c.status, (await c.json()).error]).toEqual([409, "not_latest_version"]);
    expect(addonRowsIn(w)).toEqual([]);
  });
  it("the original is never touched: no storage write, the published bytes are the same, and the base version is not rewritten", async () => {
    const w = world();
    const before = JSON.stringify(V1);
    await create(cells([1, "الاسم", "س"]));
    expect(w.storageWrites).toEqual([]);
    expect(JSON.stringify(V1)).toBe(before);
    expect(JSON.stringify(firstVersionFromCells({ missionId: MISSION, createdAt: "2026-11-02T12:00:00.000Z", cells: { [SHEET]: [HEAD, ["a_1", "أحمد", "a@b.co", "01000000000"], ["a_2", "", "bad", "123"], ["a_3", "سارة", "s@b.co", "01111111111"], ["a_4", "أحمد", "a@b.co", "01000000000"]] } }))).toBe(before);
    expect(Object.keys(objectsOf(V1))).toEqual([`${MISSION}/${versionPathOf(1)}`]);
  });
  it("a store failure is a 503 and never «created»: the insert fails, the add-on rows cannot be read", async () => {
    let w = world([V1], { insertError: true });
    let c = await create(rename);
    expect([c.status, (await c.json()).error]).toEqual([503, "unavailable"]);
    expect(addonRowsIn(w)).toEqual([]);
    w = world([V1], { addonQueryError: true });
    c = await create(rename);
    expect(c.status).toBe(503);
    w = world([V1], { listError: true }); expect((await create(rename)).status).toBe(503);
    w = world([V1], { downloadError: true }); expect((await create(rename)).status).toBe(503);
    w = world([V1], { missionError: true }); expect((await create(rename)).status).toBe(503);
    expect(addonRowsIn(w)).toEqual([]);
  });
  it("a damaged published version is never priced or edited: 500", async () => {
    const bad = { ...V1, digest: "0".repeat(64) } as FileVersion;
    const w = requestClient(objectsOf(bad)); state.client = w;
    expect((await create(rename)).status).toBe(500);
    expect((await routeCall({ action: "quote", version: 1, edit: rename })).status).toBe(500);
    expect(addonRowsIn(w)).toEqual([]);
  });
});

describe("finding the waiting request again, and cancelling it while it is unpaid", () => {
  it("GET: none → null; after the request is made (a refresh) → the same request, priced again by the card", async () => {
    world();
    expect(await (await getCall()).json()).toEqual({ success: true, request: null });
    const made = await (await create(rename)).json();
    const again = await (await getCall()).json();
    expect(again).toEqual({ success: true, request: made.request });
  });
  it("a stored price that is not the code's is shown at the code's price, never at the stored one", async () => {
    const w = world();
    await create(rename);
    const row = addonRowsIn(w)[0];
    row.plan.addon.pricing.holdPoints = 1; row.plan.addon.pricing.estimatePoints = 1;
    const { request } = await (await getCall()).json();
    expect(request).toMatchObject(priceOf(1));
  });
  it("a started request (approved, executing) and a request whose approval was ever attempted are NOT shown as waiting", async () => {
    const w = world(); await create(rename);
    const row = addonRowsIn(w)[0];
    row.status = "approved";
    expect((await (await getCall()).json()).request).toBeNull();
    row.status = "plan_ready"; row.approved_at = new Date().toISOString(); // CHANGED (audit D1): a RECENT mark; one older than 35 minutes with nothing reserved is freed on purpose (tests/stage4-stale-approval-mark.test.ts)
    expect((await (await getCall()).json()).request).toBeNull();
    row.approved_at = null; row.job_id = "job_quote_x";
    expect((await (await getCall()).json()).request).toBeNull();
  });
  it("a review request is not an edit request: the edit endpoint does not show it", async () => {
    const w = world();
    await createReviewRequest(w, { missionId: MISSION, userId: ME, version: 1 });
    expect((await (await getCall()).json()).request).toBeNull();
  });
  it("cancel: one compare-and-set on an unpaid edit request; nothing else is written; a new request can follow", async () => {
    const w = world();
    const id = (await (await create(rename)).json()).request.id;
    const res = await routeCall({ action: "cancel", requestId: id });
    expect(res.status).toBe(200);
    expect(addonRowsIn(w)[0].status).toBe("cancelled");
    expect([w.other, w.storageWrites]).toEqual([[], []]);
    expect((await (await getCall()).json()).request).toBeNull();
    // twice: it is no longer waiting
    const again = await routeCall({ action: "cancel", requestId: id });
    expect([again.status, (await again.json()).error]).toEqual([409, "changed"]);
    // a new request: the next attempt number, a new id
    const next = await create(rename);
    expect(next.status).toBe(201);
    expect(addonRowsIn(w).map((r) => r.id).sort()).toEqual([addonId(MISSION, 1, 1), addonId(MISSION, 1, 2)].sort());
  });
  it("cancel never touches a started, charged or approved request, a stranger's request, a review request or an ordinary mission (the same 404 or a 409, rows unchanged)", async () => {
    const w = world(); const id = (await (await create(rename)).json()).request.id;
    const row = addonRowsIn(w)[0];
    for (const patch of [{ status: "approved" }, { status: "executing" }, { status: "completed" }, { approved_at: "2026-11-04T10:00:00.000Z" }, { job_id: "job_quote_x" }]) {
      const snapshot = { status: row.status, approved_at: row.approved_at ?? null, job_id: row.job_id ?? null };
      Object.assign(row, { status: "plan_ready", approved_at: null, job_id: null }, patch);
      const before = JSON.stringify(row);
      const res = await routeCall({ action: "cancel", requestId: id });
      expect([JSON.stringify(patch), res.status]).toEqual([JSON.stringify(patch), 409]);
      expect(JSON.stringify(row)).toBe(before);
      Object.assign(row, snapshot);
    }
    const wr = world(); const rid = (await createReviewRequest(wr, { missionId: MISSION, userId: ME, version: 1 }) as any).request.id;
    const viaEdit = await routeCall({ action: "cancel", requestId: rid });
    expect(viaEdit.status).toBe(404);
    expect(addonRowsIn(wr)[0].status).toBe("plan_ready");
    const ws = world([V1], { seed: [{ ...addonRowOf({ status: "plan_ready", kind: "edit", base: 1 }), user_id: "u-2" }] });
    const theirs = addonRowsIn(ws)[0].id;
    expect((await routeCall({ action: "cancel", requestId: theirs })).status).toBe(404);
    expect(addonRowsIn(ws)[0].status).toBe("plan_ready");
    expect((await routeCall({ action: "cancel", requestId: MISSION })).status).toBe(404);
    expect((await routeCall({ action: "cancel", requestId: "../x" })).status).toBe(400);
    expect((await routeCall({ action: "cancel", requestId: "msn_ffffffffffffffffffff" })).status).toBe(404);
  });
  it("a status that changes between the read and the update changes nothing (409, the row stays as the other process made it)", async () => {
    const w = world([V1], { beforeUpdate: (rows) => { for (const r of rows.values()) if (r.plan?.addon) { r.status = "approved"; r.approved_at = "2026-11-04T10:00:00.000Z"; } } });
    const id = (await (await create(rename)).json()).request.id;
    const res = await routeCall({ action: "cancel", requestId: id });
    expect(res.status).toBe(409);
    expect(addonRowsIn(w)[0].status).toBe("approved");
  });
});

describe("the editor's schema: the latest version's sheets and columns, nothing private", () => {
  it("GET ?schema=1 gives the latest version, the sheets, the editable columns and the item counts; no item id, digest, path or cell value", async () => {
    world();
    const res = await getCall("schema=1");
    expect(res.status).toBe(200);
    const { schema } = await res.json();
    expect(schema).toEqual({ version: 1, sheets: [{ name: SHEET, columns: ["الاسم", "البريد الإلكتروني", "الهاتف"], items: 4 }] });
    const raw = JSON.stringify(schema);
    for (const secret of ["a_1", "المعرّف", V1.digest, "versions/", "أحمد", "01000000000"]) expect(raw, secret).not.toContain(secret);
  });
  it("the latest version of a file with two versions", async () => {
    const sheet = V1.sheets[0];
    const r = applyEditRequest(V1, { kind: "rename_column", sheet: sheet.nameAr, from: "الهاتف", to: "الموبايل" }, { createdAt: "2026-11-03T09:30:00.000Z" });
    if (!r.ok) throw new Error(r.reason);
    world([V1, r.version]);
    expect((await (await getCall("schema=1")).json()).schema).toMatchObject({ version: 2, sheets: [{ columns: ["الاسم", "البريد الإلكتروني", "الموبايل"] }] });
  });
  it("no published version: 404; the storage cannot answer: 503; bad schema flag: 400", async () => {
    state.client = requestClient({}); expect((await getCall("schema=1")).status).toBe(404);
    world([V1], { listError: true }); expect((await getCall("schema=1")).status).toBe(503);
    world(); expect((await getCall("schema=2")).status).toBe(400);
    expect((await getCall("schema=1&schema=1")).status).toBe(400);
  });
});

describe("the source: the edit request writes one unpaid row and cancels it, and nothing else", () => {
  const code = (f: string) => readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const FILES = ["src/lib/agentMission/stage4/editRequest.ts", "src/app/api/missions/[id]/edit-request/route.ts"];
  it("no rpc, upload, delete, upsert; only the missions table; no settlement, approval, reservation, refund or provider; no row in a started status", () => {
    const src = FILES.map(code).join("\n");
    expect(src).not.toMatch(/\.(rpc|upload|remove|createSignedUrl|upsert|delete)\(/);
    expect(src).not.toMatch(/settleAddon|approveAddon|approveMission|releaseAddon|accept_quote_atomic|release_job_atomic|create_quote_atomic|claim_job_chunk|credit_ledger|refund|gateway|openai|process\.env/i);
    expect(src).not.toMatch(/status:\s*"(approved|executing|completed|failed|unserved)"/);
    expect(src).toMatch(/DIGER_STAGE4_EDITS/);
    expect([...new Set([...src.matchAll(/\.from\(\s*([A-Za-z_"]+)/g)].map((m) => m[1]))]).toEqual(["MISSION_TABLE"]);
  });
});
