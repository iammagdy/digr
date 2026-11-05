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

import { editCard } from "../src/lib/agentMission/stage4/addonQuote";
import { editQuoteLinesAr, editRequestLinesAr } from "../src/lib/agentMission/stage4/editRequestLabels";
import { reviewCellsOf, reviewFile } from "../src/lib/agentMission/stage4/review";
import { versionPathOf } from "../src/lib/agentMission/stage4/versions";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { runAddonSafely } from "../agent/src/stage4/runAddon";
import { ADDON_DONE_AR } from "../agent/src/stage4/addonText";
import { checkAddonLedger } from "./helpers/addonWorld";
import { session, signInAs } from "./helpers/e2eSession";
import { CLIENTS_SHEET, MISSION, ME, NOTES_SHEET, OTHER_USER, e2eWorld, parseXlsx, sheetsOfVersion, type E2eWorld, type ParsedSheet } from "./helpers/e2eWorld";
import { api, json } from "./helpers/e2eRoutes";
import { paidEdit, paidReview } from "./helpers/e2eFlows";

/**
 * STAGE F, FLOWS 5 AND 6: THE CUSTOMER'S EDIT, END TO END ON FAKES ONLY. The REAL edit-request routes price an edit the customer typed, the REAL approval of the existing money core (fake clients) holds the price, the REAL worker applies it and settles, and the REAL download route serves
 * both the original and the new version as genuine workbooks (read back with a real parser). Flow 5 starts from a completed review and corrects the cells its report pointed at; flow 6 is the plain edit (rename a column, add items). `fetch` throws: no provider, no live account.
 * An edit that needs a new LOOKUP is not offered yet (Stage B): every flow here is the supported kind, whose values the customer typed, so its provider cost is exactly zero and its charge is the add-on minimum.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear();
  vi.stubEnv("DIGER_STAGE4_VERSIONS", "on"); vi.stubEnv("DIGER_STAGE4_REVIEW", "on"); vi.stubEnv("DIGER_STAGE4_EDITS", "on");
  signInAs(ME);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const world = async (...a: Parameters<typeof e2eWorld>): Promise<E2eWorld> => { const w = await e2eWorld(...a); session.client = w.routes; return w; };
const noDigits = (s: string) => expect(s, s).not.toMatch(/[0-9]/);
const said = (w: E2eWorld, id: string) => w.store.events.filter((e) => e.mission_id === id).map((e) => e.message_ar);
const downloadOf = async (n: number): Promise<ParsedSheet[]> => { const res = await api.versionFile(n); expect(res.status).toBe(200); return parseXlsx(new Uint8Array(await res.arrayBuffer())); };
/** Every cell that differs between two parsed workbooks of the SAME shape, as «sheet|row|column». */
function changedCells(a: ParsedSheet[], b: ParsedSheet[]): string[] {
  const out: string[] = [];
  a.forEach((s, i) => s.rows.forEach((r, j) => r.forEach((v, k) => { if (v !== b[i].rows[j][k]) out.push(`${s.name}|${j + 1}|${s.headers[k]}`); })));
  return out;
}
const FIX = { kind: "set_cells", sheet: CLIENTS_SHEET, cells: [{ row: 2, column: "الاسم", value: "محمد" }, { row: 2, column: "البريد الإلكتروني", value: "m@b.co" }, { row: 2, column: "الهاتف", value: "01222222222" }] };
const priceOf = (units: number) => { const c = editCard({ kind: "edit", units, tools: [] }); if (!c.ok) throw new Error("card refused"); return c; };

describe("FLOW 6: original -> edit quote -> prepare the edit -> approval (fake core) -> edit execution (fake) -> a new version", () => {
  it("correcting selected cells: priced by the server, nothing moves before approval, the hold is the quoted maximum, the charge is the add-on minimum, v2 is published once and v1 never changes", async () => {
    const w = await world();
    const B = w.money.balance();
    const v1Bytes = await w.store.getFileBytes(MISSION, versionPathOf(1));
    const v1Download = await downloadOf(1);

    // the schema the editor shows: sheets and columns, never ids
    const schema = (await json(await api.editRequest(MISSION, "schema=1"))).schema;
    expect(schema).toEqual({ version: 1, sheets: [{ name: CLIENTS_SHEET, columns: ["الاسم", "البريد الإلكتروني", "الهاتف"], items: 4 }, { name: NOTES_SHEET, columns: ["الملاحظة"], items: 2 }] });

    const quote = (await json(await api.editRequestPost({ action: "quote", version: 1, edit: FIX }))).quote;
    const card = priceOf(3);
    expect(quote).toEqual({ state: "offer", version: 1, newVersion: 2, change: { kind: "set_cells", sheet: CLIENTS_SHEET, cells: 3, columns: ["الاسم", "البريد الإلكتروني", "الهاتف"] }, units: 3, estimatePoints: card.estimatePoints, holdPoints: card.holdPoints });
    for (const l of editQuoteLinesAr(quote)) { noDigits(l); expect(checkCustomerText(l).issues, l).toEqual([]); }
    const made = await api.editRequestPost({ action: "create", version: 1, edit: FIX });
    expect(made.status).toBe(201);
    const { request } = await json(made);
    expect(request).toMatchObject({ version: 1, newVersion: 2, units: 3, status: "plan_ready", holdPoints: card.holdPoints });
    for (const l of editRequestLinesAr(request)) noDigits(l);
    // NO COST BEFORE APPROVAL
    expect([w.ledgerTypes(), w.money.jobs.size, w.money.balance(), w.providerRows, w.call.mock.calls.length, w.versionFiles()]).toEqual([["topup"], 0, B, [], 0, [`${MISSION}/versions/v0001.json`]]);
    expect((await json(await api.editRequest())).request).toEqual(request);

    // approval holds the quoted maximum, and only that
    const a = await w.approveAndClaim(request.id);
    expect(a.hold).toBe(card.holdPoints);
    expect(w.ledgerTypes()).toEqual(["topup", "reserve"]);
    expect(w.money.balance()).toBe(B - card.holdPoints);
    // while it runs, no version 2 is shown
    expect((await api.versionFile(2)).status).toBe(404);
    expect((await json(await api.versions())).versions.map((v: any) => v.version)).toEqual([1]);

    await runAddonSafely(w.deps, a.row);
    const C = 100; // no provider cost: the proportional minimum of the 3 cells that received a real value
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: C })).toEqual([]);
    expect(C).toBeLessThanOrEqual(a.hold);
    expect(w.money.balance()).toBe(B - C);
    expect(w.money.balance()).toBeGreaterThanOrEqual(0);
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "completed", charged_credits: C, reserved_credits: a.hold });
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: C, delivered_units: 3 });
    expect([w.call.mock.calls.length, w.providerRows]).toEqual([0, []]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const told = said(w, a.id);
    expect(told).toContain(ADDON_DONE_AR.versionDone(2, C));
    for (const s of told) { expect(checkCustomerText(s).issues, s).toEqual([]); noDigits(s); }

    // v2 is published once, with its own reason; v1 is byte for byte what it was
    expect(w.versionFiles()).toEqual([`${MISSION}/versions/v0001.json`, `${MISSION}/versions/v0002.json`]);
    expect((await w.store.getFileBytes(MISSION, versionPathOf(1)))!.equals(v1Bytes!)).toBe(true);
    const listed = (await json(await api.versions())).versions;
    expect(listed.map((v: any) => [v.version, v.parent, v.reason])).toEqual([[1, null, "delivery"], [2, 1, "edit"]]);
    // the downloads: v1 is still the original; v2 differs in exactly the three cells the customer typed
    const v1After = await downloadOf(1);
    const v2 = await downloadOf(2);
    expect(v1After).toEqual(v1Download);
    expect(v1After).toEqual(sheetsOfVersion(w.v1));
    expect(v2.map((s) => s.name)).toEqual([CLIENTS_SHEET, NOTES_SHEET]);
    expect(v2.map((s) => s.headers)).toEqual(v1After.map((s) => s.headers));
    expect(v2.map((s) => s.rows.length)).toEqual([4, 2]);
    expect(changedCells(v1After, v2).sort()).toEqual([`${CLIENTS_SHEET}|2|الاسم`, `${CLIENTS_SHEET}|2|البريد الإلكتروني`, `${CLIENTS_SHEET}|2|الهاتف`].sort());
    expect(v2[0].rows[1]).toEqual(["محمد", "m@b.co", "01222222222", "c_2"]);
    // the finished request is no longer «waiting»; edits go on the newest version only
    expect((await json(await api.editRequest())).request).toBeNull();
    expect((await json(await api.editRequestPost({ action: "quote", version: 1, edit: FIX }))).quote).toEqual({ state: "not_latest", version: 1 });
    expect((await json(await api.editRequestPost({ action: "quote", version: 2, edit: { kind: "rename_column", sheet: CLIENTS_SHEET, from: "الهاتف", to: "الموبايل" } }))).quote.state).toBe("offer");
    // a run of the same add-on again changes nothing: no second version, no second charge
    const ledger = JSON.stringify(w.money.ledger);
    await runAddonSafely(w.deps, { ...a.row, status: "executing" });
    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    expect(w.versionFiles()).toHaveLength(2);
  });

  it("renaming a column: the header changes in its place, every value is preserved, the price is the minimum", async () => {
    const w = await world();
    const edit = { kind: "rename_column", sheet: CLIENTS_SHEET, from: "الهاتف", to: "رقم الموبايل" };
    const { quote, a } = await paidEdit(w, edit);
    expect(quote).toMatchObject({ state: "offer", units: 1, change: { kind: "rename_column", from: "الهاتف", to: "رقم الموبايل" } });
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 100 })).toEqual([]);
    const v1 = await downloadOf(1);
    const v2 = await downloadOf(2);
    expect(v2[0].headers).toEqual(["الاسم", "البريد الإلكتروني", "رقم الموبايل", "المعرّف"]);
    expect(v2[0].rows).toEqual(v1[0].rows);
    expect(v2[1]).toEqual(v1[1]);
    expect(v1[0].headers[2]).toBe("الهاتف");
    expect(w.money.balance()).toBe(w.startBalance - 100);
  });

  it("adding items the customer typed: ids made by the server, counts 4 -> 6, the original rows untouched, no cell invented", async () => {
    const w = await world();
    const rows = [{ values: { "الاسم": "هالة", "البريد الإلكتروني": "h@x.org", "الهاتف": "01333333333" } }, { values: { "الاسم": "كريم", "البريد الإلكتروني": "k@x.org", "الهاتف": "01444444444" } }];
    const { quote, a } = await paidEdit(w, { kind: "add_rows", sheet: CLIENTS_SHEET, rows });
    expect(quote).toMatchObject({ state: "offer", units: 2, change: { kind: "add_rows", sheet: CLIENTS_SHEET, rows: 2 } });
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 100 })).toEqual([]);
    const v1 = await downloadOf(1);
    const v2 = await downloadOf(2);
    expect(v2[0].rows.length).toBe(6);
    expect(v2[0].rows.slice(0, 4)).toEqual(v1[0].rows);
    expect(v2[0].rows.slice(4)).toEqual([["هالة", "h@x.org", "01333333333", "add_v2_1"], ["كريم", "k@x.org", "01444444444", "add_v2_2"]]);
    expect(v2[1]).toEqual(v1[1]);
    expect(v2.flatMap((s) => s.rows).flat().every((c) => typeof c === "string")).toBe(true);
    expect(w.versionFiles()).toHaveLength(2);
  });

  it("what is not offered stays out: a new column and a fix by search are «unsupported» with no price, removing items is refused; none of them creates a request or moves money", async () => {
    const w = await world();
    const quote = async (edit: unknown) => (await json(await api.editRequestPost({ action: "quote", version: 1, edit }))).quote;
    expect(await quote({ kind: "add_column", sheet: CLIENTS_SHEET, titleAr: "العنوان" })).toEqual({ state: "unsupported", version: 1, why: "lookup_needed" });
    const issue = reviewFile(w.v1, { keepRowIds: Number.POSITIVE_INFINITY }).issues.find((i) => i.code === "empty_cells")!;
    expect(await quote({ kind: "review_fix", sheet: issue.sheet, column: issue.column, code: issue.code })).toEqual({ state: "unsupported", version: 1, why: "lookup_needed", cells: issue.count });
    expect((await quote({ kind: "remove_rows", sheet: CLIENTS_SHEET, rows: [1] })).state).toBe("rejected");
    for (const edit of [{ kind: "add_column", sheet: CLIENTS_SHEET, titleAr: "العنوان" }, { kind: "remove_rows", sheet: CLIENTS_SHEET, rows: [1] }]) expect((await api.editRequestPost({ action: "create", version: 1, edit })).status).toBe(409);
    expect([w.addonRows().length, w.ledgerTypes(), w.routes.log]).toEqual([0, ["topup"], []]);
  });

  it("only the owner edits: another customer, a missing file and a signed-out visitor are refused; the flag of EDITS alone opens the edit routes", async () => {
    const w = await world();
    signInAs(OTHER_USER);
    expect((await api.editRequestPost({ action: "create", version: 1, edit: FIX })).status).toBe(404);
    expect((await api.editRequest(MISSION, "schema=1")).status).toBe(404);
    signInAs(null);
    expect((await api.editRequestPost({ action: "create", version: 1, edit: FIX })).status).toBe(401);
    signInAs(ME);
    w.routes.faults.storage = true;
    const out = await api.editRequestPost({ action: "quote", version: 1, edit: FIX });
    expect(out.status).toBe(503);
    w.routes.faults.storage = false;
    expect(w.addonRows()).toHaveLength(0);
  });
});

describe("FLOW 5: completed review -> a selected correction -> approval (fake) -> execution (fake) -> a new version -> download the original and the corrected version", () => {
  it("the customer reads the report, corrects the cells it pointed at with values they typed; both versions download; the review of the original stays reusable and free; two jobs, each balanced", async () => {
    const w = await world();
    const B = w.money.balance();
    const review = await paidReview(w);
    const reviewLedger = JSON.stringify(w.money.ledger);
    // the report names the faults: an empty name, a bad e-mail, a short phone
    const { report } = await json(await api.reviewReport(MISSION, "version=1"));
    const codes = report.issues.map((i: any) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["empty_cells", "invalid_email", "invalid_phone"]));
    const faulty = report.score;

    const edit = await paidEdit(w, FIX);
    expect(edit.quote.state).toBe("offer");
    expect(checkAddonLedger(w.money, review.a.jobId, { reserved: review.P, charged: review.P })).toEqual([]);
    expect(checkAddonLedger(w.money, edit.a.jobId, { reserved: edit.R, charged: 100 })).toEqual([]);
    expect(w.money.balance()).toBe(B - review.P - 100);
    expect(w.money.balance()).toBeGreaterThanOrEqual(0);
    expect(w.money.ledger.filter((r) => r.type === "charge")).toHaveLength(2);
    expect(w.money.jobs.size).toBe(2);
    expect(w.ledgerTypes()).toEqual(["topup", "reserve", "release", "charge", "reserve", "release", "charge"]);
    // the review's three ledger rows are exactly what they were before the edit began
    expect(JSON.stringify(w.money.ledger.slice(0, 4))).toBe(reviewLedger);
    expect([w.call.mock.calls.length, w.providerRows]).toEqual([0, []]);

    // both versions download; the original is untouched, the corrected one carries exactly the typed values
    const v1 = await downloadOf(1);
    const v2 = await downloadOf(2);
    expect(v1).toEqual(sheetsOfVersion(w.v1));
    expect(v2[0].rows[1]).toEqual(["محمد", "m@b.co", "01222222222", "c_2"]);
    expect(changedCells(v1, v2)).toHaveLength(3);
    expect(v2.map((s) => s.rows.length)).toEqual([4, 2]);

    // the review of version 1 is still there, still free, never charged again
    expect((await json(await api.reviewQuote(MISSION, "version=1"))).quote.state).toBe("reuse");
    expect((await json(await api.reviewReport(MISSION, "version=1"))).report.score).toBe(faulty);
    expect((await api.reviewRequestPost({ action: "create", version: 1 })).status).toBe(409);
    // version 2 has NO report: none is invented; it can be reviewed (and priced) on its own
    expect((await api.reviewReport(MISSION, "version=2")).status).toBe(404);
    expect((await json(await api.reviewReport())).versions).toEqual([1]);
    const q2 = (await json(await api.reviewQuote(MISSION, "version=2"))).quote;
    expect(q2).toMatchObject({ state: "offer", version: 2, reason: "edit", cells: reviewCellsOf(JSON.parse((await w.store.getFile(MISSION, versionPathOf(2)))!)) });
    expect(w.money.ledger.filter((r) => r.type === "charge")).toHaveLength(2);
    expect(w.versionFiles()).toEqual([`${MISSION}/versions/v0001.json`, `${MISSION}/versions/v0002.json`]);
    expect(w.reviewFiles()).toEqual([`${MISSION}/reviews/r0001.json`]);
  });
});
