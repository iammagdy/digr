import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase/server", async () => {
  const { session } = await import("./helpers/e2eSession");
  return { createAdminClient: () => { session.adminCalls += 1; return session.client; }, createServerSideClient: vi.fn() };
});
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  const { session } = await import("./helpers/e2eSession");
  return { ...real, resolveMissionViewer: vi.fn(async () => { session.viewerCalls += 1; return session.viewer ? { ok: true, viewer: session.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) }; }) };
});

import { createAddonRow, type AddonRowStore } from "../src/lib/agentMission/stage4/addonRow";
import { createSupabaseAddonRowStore } from "../src/lib/agentMission/stage4/addonRowStore";
import { reviewCard } from "../src/lib/agentMission/stage4/addonQuote";
import { reviewCellsOf } from "../src/lib/agentMission/stage4/review";
import { versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { runAddon, runAddonSafely } from "../agent/src/stage4/runAddon";
import { ADDON_DONE_AR } from "../agent/src/stage4/addonText";
import { checkAddonLedger } from "./helpers/addonWorld";
import { session, signInAs } from "./helpers/e2eSession";
import { CLIENTS_SHEET, MISSION, ME, OTHER_MISSION, OTHER_USER, XLSX_TYPE, e2eWorld, parseXlsx, type E2eWorld } from "./helpers/e2eWorld";
import { api, json } from "./helpers/e2eRoutes";
import { paidEdit } from "./helpers/e2eFlows";

/**
 * STAGE F, FLOWS 7 TO 10: WHAT GOES WRONG, END TO END ON FAKES ONLY. Flow 7: storage fails AFTER the points were charged. Flow 8: two workers on one add-on. Flow 9: two add-ons created at the same moment (the uniqueness risk that is still open). Flow 10: with the flags OFF nothing new answers and
 * the ordinary journey is what it was. The REAL routes, approval (fake clients), worker runner and review engine share one fake world (tests/helpers/e2eWorld.ts). `fetch` throws: no provider, no live account.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
const ALL_ON = () => { vi.stubEnv("DIGER_STAGE4_VERSIONS", "on"); vi.stubEnv("DIGER_STAGE4_REVIEW", "on"); vi.stubEnv("DIGER_STAGE4_EDITS", "on"); };
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); signInAs(ME); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const world = async (...a: Parameters<typeof e2eWorld>): Promise<E2eWorld> => { const w = await e2eWorld(...a); session.client = w.routes; return w; };
const said = (w: E2eWorld, id: string) => w.store.events.filter((e) => e.mission_id === id).map((e) => e.message_ar);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const RENAME = { kind: "rename_column", sheet: CLIENTS_SHEET, from: "الهاتف", to: "رقم الموبايل" };
const FIX = { kind: "set_cells", sheet: CLIENTS_SHEET, cells: [{ row: 2, column: "الاسم", value: "محمد" }, { row: 2, column: "الهاتف", value: "01222222222" }] };

/** Storage that refuses to PUBLISH anything under `prefix` (an outage that starts after the charge); `restore` brings it back. */
function publishOutage(w: E2eWorld, prefix: "versions/" | "reviews/") {
  const put = w.store.putNewStrict.bind(w.store);
  const state = { down: true, attempts: 0 };
  w.store.putNewStrict = async (m, p, c, t) => { if (state.down && p.startsWith(prefix)) { state.attempts += 1; throw new Error("upload: storage is unavailable"); } return put(m, p, c, t); };
  return state;
}
/** One more turn of the worker loop: the next claim and the run (never throws). False when the claim leaves the row alone. */
async function nextTry(w: E2eWorld): Promise<boolean> {
  const claimed = await w.store.claimMission("worker-n", 120);
  if (!claimed) return false;
  await runAddonSafely(w.deps, claimed);
  return true;
}
async function madeEdit(w: E2eWorld, edit: unknown) {
  const made = await json(await api.editRequestPost({ action: "create", version: 1, edit }));
  return w.approveAndClaim(made.request.id);
}

describe("FLOW 7: storage fails after settlement -> no duplicate charge -> a recoverable pending delivery", () => {
  it("an EDIT: charged once, never released, never shown as done; no version is served while the file cannot be saved; 503 (not 404) while storage is down; the same bytes are published when it returns", async () => {
    ALL_ON();
    const w = await world();
    const B = w.money.balance();
    const a = await madeEdit(w, FIX);
    const outage = publishOutage(w, "versions/");
    await runAddonSafely(w.deps, a.row);

    // charged, not published; the ledger is complete and final
    expect(w.ledgerTypes()).toEqual(["topup", "reserve", "release", "charge"]);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 100 })).toEqual([]);
    expect(w.money.balance()).toBe(B - 100);
    const ledger = JSON.stringify(w.money.ledger);
    const pendingPath = `addons/${a.id}/v0002.json`;
    const pending = await w.store.getFileBytes(MISSION, pendingPath);
    expect(pending).not.toBeNull();
    // the customer's routes show no version 2 (a pending one is not published), and the parked request is not shown as «waiting»
    expect((await json(await api.versions())).versions.map((v: any) => v.version)).toEqual([1]);
    expect((await api.versionFile(2)).status).toBe(404);
    expect((await json(await api.editRequest())).request).toBeNull();
    // a storage outage on the READ side is a 503 «unavailable», never «missing»
    w.routes.faults.storage = true;
    expect((await api.versionFile(2)).status).toBe(503);
    expect((await api.versions()).status).toBe(503);
    w.routes.faults.storage = false;
    // honest words: it is owed, not done
    const told = said(w, a.id);
    expect(told).toContain(ADDON_DONE_AR.paidPublishing);
    expect(told).not.toContain(ADDON_DONE_AR.versionDone(2, 100));
    for (const s of told) { expect(checkCustomerText(s).issues, s).toEqual([]); expect(s).not.toMatch(/[0-9]/); }

    // retries: each waits (the claim leaves the row alone until its lease ends), each fails, and not one of them charges again
    for (let i = 0; i < 3; i += 1) {
      expect(w.rowOf(a.id).status).toBe("approved");
      expect(await w.store.claimMission("worker-n", 120)).toBeNull();
      w.expireLease(a.id);
      expect(await nextTry(w)).toBe(true);
      expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    }
    expect(outage.attempts).toBeGreaterThanOrEqual(4);
    expect(w.rowOf(a.id).status).toBe("approved");
    expect(w.versionFiles()).toEqual([`${MISSION}/versions/v0001.json`]);

    // storage returns: the very bytes that were charged for are published, once
    outage.down = false;
    w.expireLease(a.id);
    expect(await nextTry(w)).toBe(true);
    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    expect(w.money.ledger.filter((r) => r.type === "charge")).toHaveLength(1);
    expect(w.versionFiles()).toEqual([`${MISSION}/versions/v0001.json`, `${MISSION}/versions/v0002.json`]);
    expect((await w.store.getFileBytes(MISSION, versionPathOf(2)))!.equals(pending!)).toBe(true);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: 100 });
    expect(said(w, a.id).filter((s) => s === ADDON_DONE_AR.versionDone(2, 100))).toHaveLength(1);
    // the customer can now download it, and it carries what they typed
    const res = await api.versionFile(2);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(XLSX_TYPE);
    const v2 = await parseXlsx(new Uint8Array(await res.arrayBuffer()));
    expect(v2[0].rows[1]).toEqual(["محمد", "not-an-email", "01222222222", "c_2"]);
    expect(v2[0].rows.length).toBe(4);
    expect(w.money.balance()).toBe(B - 100);
  });

  it("a REVIEW: charged once; the report is never shown while it is only pending; it appears (the same bytes) when storage returns; no second charge", async () => {
    ALL_ON();
    const w = await world();
    const B = w.money.balance();
    const quote = (await json(await api.reviewQuote(MISSION, "version=1"))).quote;
    const made = await json(await api.reviewRequestPost({ action: "create", version: 1 }));
    const a = await w.approveAndClaim(made.request.id);
    const outage = publishOutage(w, "reviews/");
    await runAddonSafely(w.deps, a.row);
    const P = quote.points as number;
    expect(checkAddonLedger(w.money, a.jobId, { reserved: P, charged: P })).toEqual([]);
    const ledger = JSON.stringify(w.money.ledger);
    const pending = await w.store.getFileBytes(MISSION, `addons/${a.id}/review.json`);
    expect(pending).not.toBeNull();
    // a pending report is NEVER a completed review: not listed, not shown, not «reuse»
    expect((await api.reviewReport(MISSION, "version=1")).status).toBe(404);
    expect((await json(await api.reviewReport())).versions).toEqual([]);
    expect(said(w, a.id)).not.toContain(ADDON_DONE_AR.reviewDone(P));
    w.routes.faults.storage = true;
    expect((await api.reviewReport(MISSION, "version=1")).status).toBe(503);
    w.routes.faults.storage = false;

    outage.down = false;
    w.expireLease(a.id);
    expect(await nextTry(w)).toBe(true);
    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    expect(w.money.balance()).toBe(B - P);
    expect((await w.store.getFileBytes(MISSION, "reviews/r0001.json"))!.equals(pending!)).toBe(true);
    expect((await api.reviewReport(MISSION, "version=1")).status).toBe(200);
    expect((await json(await api.reviewQuote(MISSION, "version=1"))).quote.state).toBe("reuse");
  });
});

describe("FLOW 8: two workers overlap -> at most one financial settlement -> no charge for an unpublished output", () => {
  it("worker 1 is held just before it records its outcome; its lease ends; worker 2 finishes the add-on; worker 1 wakes: one reserve, one release, ONE charge, one version", async () => {
    ALL_ON();
    const w = await world();
    const B = w.money.balance();
    const a = await madeEdit(w, FIX);
    const put = w.store.putNewStrict.bind(w.store);
    const reached = deferred(); const gate = deferred();
    let first = true;
    w.store.putNewStrict = async (m, p, c, t) => { if (p.endsWith("outcome.json") && first) { first = false; reached.resolve(); await gate.promise; } return put(m, p, c, t); };

    const run1 = runAddon(w.deps, a.row);
    await reached.promise;
    // its lease ends; worker 2 takes the row and runs it to the end
    w.expireLease(a.id);
    const claimed = await w.reclaim();
    expect(claimed.worker_id).toBe("worker-2");
    await runAddon(w.deps, claimed);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: 100 });
    const ledger = JSON.stringify(w.money.ledger);
    // worker 1 wakes up
    gate.resolve();
    await run1;

    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    expect(w.ledgerTypes()).toEqual(["topup", "reserve", "release", "charge"]);
    expect(w.money.ledger.filter((r) => r.type === "charge")).toHaveLength(1);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 100 })).toEqual([]);
    expect(w.money.balance()).toBe(B - 100);
    expect(w.money.balance()).toBeGreaterThanOrEqual(0);
    expect(w.versionFiles()).toEqual([`${MISSION}/versions/v0001.json`, `${MISSION}/versions/v0002.json`]);
    expect((await w.store.getFileBytes(MISSION, versionPathOf(2)))!.equals((await w.store.getFileBytes(MISSION, `addons/${a.id}/v0002.json`))!)).toBe(true);
    expect(said(w, a.id).filter((s) => s === ADDON_DONE_AR.versionDone(2, 100))).toHaveLength(1);
    // the customer sees exactly one new version, and downloads it
    expect((await json(await api.versions())).versions.map((v: any) => v.version)).toEqual([1, 2]);
    expect((await api.versionFile(2)).status).toBe(200);
    expect([w.call.mock.calls.length, w.providerRows]).toEqual([0, []]);
  });

  it("another object already holds the version's path: nothing is published over it, the WHOLE hold comes back, nothing is charged, and the customer is never served the foreign object", async () => {
    ALL_ON();
    const w = await world();
    const B = w.money.balance();
    const a = await madeEdit(w, FIX);
    w.store.files.set(`${MISSION}/versions/v0002.json`, JSON.stringify({ rival: true }));
    await runAddonSafely(w.deps, a.row);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(w.ledgerTypes()).toEqual(["topup", "reserve", "release"]);
    expect(w.money.balance()).toBe(B);
    expect(w.rowOf(a.id).status).not.toBe("completed");
    expect(w.rowOf(a.id)).toMatchObject({ charged_points: 0 });
    expect(await w.store.getFile(MISSION, versionPathOf(2))).toBe(JSON.stringify({ rival: true }));
    expect(said(w, a.id).join(" ")).not.toContain(ADDON_DONE_AR.versionDone(2, 100));
    // the route lists only intact versions and refuses to serve the damaged object
    expect((await json(await api.versions())).versions.map((v: any) => v.version)).toEqual([1]);
    expect((await api.versionFile(2)).status).toBe(500);
  });
});

describe("FLOW 9: add-ons created at the same moment: detect, and document the uniqueness risk that is still open", () => {
  it("two requests at once through the routes (a review and an edit of the same file): exactly one stays open and the other is refused; nothing is held", async () => {
    ALL_ON();
    const w = await world();
    const [r, e] = await Promise.all([api.reviewRequestPost({ action: "create", version: 1 }), api.editRequestPost({ action: "create", version: 1, edit: RENAME })]);
    expect([r.status, e.status].sort()).toEqual([201, 409]);
    expect(w.openRows()).toHaveLength(1);
    expect([w.ledgerTypes(), w.money.jobs.size]).toEqual([["topup"], 0]);
  });

  it("DOCUMENTED RISK (docs/MONEY-PR-7A.md 17.4 and 17.5): « one open add-on per file » is a protocol over reads and writes, NOT a database constraint. A creator that read before the other inserted and then loses the database right after its own insert leaves TWO open requests; the next customer-side read repairs it", async () => {
    ALL_ON();
    const w = await world();
    // a published version 2, made by a real edit, so a review of version 2 has an id different from a review of version 1 (the primary key only stops the SAME id)
    await paidEdit(w, RENAME);
    expect(w.versionFiles()).toHaveLength(2);
    const v2: FileVersion = JSON.parse((await w.store.getFile(MISSION, versionPathOf(2)))!);
    const cardOf = (v: FileVersion) => { const c = reviewCard(reviewCellsOf(v)); if (!c.ok) throw new Error("card"); return c.pricing; };
    const real = createSupabaseAddonRowStore(w.routes, ME);

    // creator A: a review of version 1, completes normally
    const a = await createAddonRow(real, { userId: ME, of: MISSION, kind: "review", baseVersion: 1, latestVersion: 2, request: { kind: "review" }, pricing: cardOf(w.v1), requestText: "طلب مراجعة النسخة ١ من الملف" });
    expect(a.ok).toBe(true);
    // creator B: its first read was taken BEFORE A was visible (stale), its insert works, and then the database is gone for the rest of its protocol
    let outage = false; let stale = true;
    const storeB: AddonRowStore = {
      listFor: async (m) => { if (outage) throw new Error("database is down"); if (stale) { stale = false; return []; } return real.listFor(m); },
      insert: async (row) => { const r = await real.insert(row); outage = true; return r; },
      cancelUnpaid: async (id) => { if (outage) throw new Error("database is down"); return real.cancelUnpaid(id); },
    };
    await expect(createAddonRow(storeB, { userId: ME, of: MISSION, kind: "review", baseVersion: 2, latestVersion: 2, request: { kind: "review" }, pricing: cardOf(v2), requestText: "طلب مراجعة النسخة ٢ من الملف" })).rejects.toThrow();
    // THE RISK, as it really is: two open, unpaid requests on one file. Nothing is held, so nothing is lost, but the guarantee is not a constraint.
    const open = w.openRows();
    expect(open).toHaveLength(2);
    expect(open.every((r) => r.status === "plan_ready" && r.job_id === null)).toBe(true);
    // only the earlier edit's own hold, release and charge exist: neither unpaid request reserved or charged anything
    expect(w.ledgerTypes()).toEqual(["topup", "reserve", "release", "charge"]);
    expect(w.money.jobs.size).toBe(1);

    // the next customer-side read repairs it: the unpaid duplicate is cancelled, exactly one stays (the lowest id when both are unpaid)
    const waiting = await json(await api.reviewRequest());
    expect(w.openRows()).toHaveLength(1);
    expect(waiting.request.id).toBe(w.openRows()[0].id);
    expect(w.openRows()[0].id).toBe([...open.map((r) => r.id)].sort()[0]);
    expect(w.addonRows().filter((r) => r.status === "cancelled").length).toBeGreaterThanOrEqual(1);
  });
});

describe("FLOW 10: flags OFF -> every new route answers 404 first, and the ordinary journey is unchanged", () => {
  it("with no flag set, every new route is a 404 before the viewer or the database is touched, signed in or not", async () => {
    vi.unstubAllEnvs();
    for (const f of ["DIGER_STAGE4_VERSIONS", "DIGER_STAGE4_REVIEW", "DIGER_STAGE4_EDITS"]) expect(process.env[f], f).toBeUndefined();
    const w = await world();
    const calls: Array<[string, () => Promise<Response>]> = [
      ["versions", () => api.versions()],
      ["version file", () => api.versionFile(1)],
      ["review quote", () => api.reviewQuote(MISSION, "version=1")],
      ["review quote list", () => api.reviewQuote()],
      ["review request get", () => api.reviewRequest()],
      ["review request create", () => api.reviewRequestPost({ action: "create", version: 1 })],
      ["review report", () => api.reviewReport(MISSION, "version=1")],
      ["review report list", () => api.reviewReport()],
      ["edit get", () => api.editRequest()],
      ["edit schema", () => api.editRequest(MISSION, "schema=1")],
      ["edit quote", () => api.editRequestPost({ action: "quote", version: 1, edit: FIX })],
      ["edit create", () => api.editRequestPost({ action: "create", version: 1, edit: FIX })],
    ];
    for (const user of [ME, OTHER_USER, null]) {
      for (const [label, call] of calls) {
        signInAs(user);
        const res = await call();
        expect([label, res.status]).toEqual([label, 404]);
        expect([label, session.viewerCalls, session.adminCalls]).toEqual([label, 0, 0]);
      }
    }
    // «test» mode is a worker-side mode: no customer-facing route is served by it
    vi.stubEnv("DIGER_STAGE4_REVIEW", "test"); vi.stubEnv("DIGER_STAGE4_EDITS", "test"); vi.stubEnv("DIGER_STAGE4_VERSIONS", "test");
    signInAs(ME);
    for (const [label, call] of calls) expect([label, (await call()).status]).toEqual([label, 404]);
    expect([session.viewerCalls, session.adminCalls]).toEqual([0, 0]);
    expect([w.addonRows().length, w.routes.log, w.routes.other, w.routes.storageWrites, w.ledgerTypes()]).toEqual([0, [], [], [], ["topup"]]);
  });

  it("the ordinary delivery journey is exactly what it was: the same link, the same refusals, nothing written, the delivered mission and its files untouched", async () => {
    vi.unstubAllEnvs();
    const w = await world();
    const snapshot = () => JSON.stringify({ missions: [...w.store.missions.entries()], files: [...w.store.files.keys()].sort(), ledger: w.money.ledger, jobs: [...w.money.jobs.entries()] });
    const before = snapshot();
    const ok = await api.file(MISSION, "name=result.xlsx");
    expect(ok.status).toBe(200);
    expect((await json(ok)).url).toContain(`${MISSION}/result/result.xlsx`);
    // REHEARSAL AGAINST main (Round 32, customer CSV): a CSV asked for by name is BUILT from the customer's own Excel and answered as the file itself (a CSV), so NO second link is signed. Before Round 32 the answer was the Excel through a second signed link.
    const csv = await api.file(MISSION, "name=result.csv");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type") ?? "").toContain("csv");
    expect(w.routes.signed).toEqual([`${MISSION}/result/result.xlsx`]);
    // refusals: a bad name, another customer's file, a missing file, a signed-out visitor
    expect((await api.file(MISSION, "name=../../etc/passwd")).status).toBe(400);
    expect((await api.file(MISSION, "")).status).toBe(400);
    signInAs(OTHER_USER);
    const theirs = await api.file(MISSION, "name=result.xlsx");
    const missing = await api.file("msn_bbbbbbbbbbbbbbbbbbbb", "name=result.xlsx");
    expect([theirs.status, missing.status]).toEqual([404, 404]);
    expect(await json(theirs)).toEqual(await json(missing));
    signInAs(OTHER_USER);
    expect((await json(await api.file(OTHER_MISSION, "name=result.xlsx"))).success).toBe(true);
    signInAs(null);
    expect((await api.file(MISSION, "name=result.xlsx")).status).toBe(401);
    // nothing about the mission, its files, its ledger or its jobs changed
    expect(snapshot()).toBe(before);
    expect([w.routes.log, w.routes.other, w.routes.storageWrites]).toEqual([[], [], []]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("turning the flags ON and only looking changes nothing either: the same data, the same ledger; the journey is additive", async () => {
    const w = await world();
    const snapshot = () => JSON.stringify({ missions: [...w.store.missions.entries()], files: [...w.store.files.keys()].sort(), ledger: w.money.ledger, jobs: [...w.money.jobs.entries()] });
    vi.unstubAllEnvs();
    const off = await json(await api.file(MISSION, "name=result.xlsx"));
    ALL_ON();
    const before = snapshot();
    const on = await json(await api.file(MISSION, "name=result.xlsx"));
    expect(on).toEqual(off);
    for (const call of [() => api.versions(), () => api.versionFile(1), () => api.reviewQuote(MISSION, "version=1"), () => api.reviewReport(), () => api.editRequest(MISSION, "schema=1"), () => api.editRequestPost({ action: "quote", version: 1, edit: FIX })]) await call();
    expect(snapshot()).toBe(before);
    expect([w.routes.log, w.routes.other, w.routes.storageWrites]).toEqual([[], [], []]);
  });
});
