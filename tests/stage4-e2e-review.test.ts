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

import { reviewCellsOf, reviewFile, REVIEW_ISSUE_AR } from "../src/lib/agentMission/stage4/review";
import { reviewQuoteLinesAr } from "../src/lib/agentMission/stage4/reviewPreviewLabels";
import { reviewRequestLinesAr } from "../src/lib/agentMission/stage4/reviewRequestLabels";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { runAddonSafely } from "../agent/src/stage4/runAddon";
import { ADDON_DONE_AR } from "../agent/src/stage4/addonText";
import { checkAddonLedger } from "./helpers/addonWorld";
import { session, signInAs } from "./helpers/e2eSession";
import { CLIENTS_SHEET, MISSING_MISSION, MISSION, ME, NOTES_SHEET, OTHER_MISSION, OTHER_USER, XLSX_TYPE, e2eWorld, parseXlsx, sheetsOfVersion, type E2eWorld } from "./helpers/e2eWorld";
import { api, json } from "./helpers/e2eRoutes";
import { paidReview } from "./helpers/e2eFlows";

/**
 * STAGE F, FLOWS 1 TO 4: THE CUSTOMER'S FILE AND ITS REVIEW, END TO END ON FAKES ONLY. The REAL routes, the REAL approval of the existing money core (fake clients), the REAL worker runner and the REAL review engine share one fake world
 * (tests/helpers/e2eWorld.ts): a row a route makes is the row the approval and the worker read; a report the worker publishes is the report the route checks and shows. `fetch` throws: no provider, no live account, no model.
 * Flow 1: the original and its versions download as genuine workbooks. Flow 2: a review request is made and cancelled with no money moved. Flow 3: price, request, approval (hold), review, charge, published report, the customer's view of it.
 * Flow 4: a completed review is reused: free, never a second request or charge.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear();
  vi.stubEnv("DIGER_STAGE4_VERSIONS", "on"); vi.stubEnv("DIGER_STAGE4_REVIEW", "on");
  signInAs(ME);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const world = async (...a: Parameters<typeof e2eWorld>): Promise<E2eWorld> => { const w = await e2eWorld(...a); session.client = w.routes; return w; };
const noDigits = (s: string) => expect(s, s).not.toMatch(/[0-9]/);
const said = (w: E2eWorld, id: string) => w.store.events.filter((e) => e.mission_id === id).map((e) => e.message_ar);

describe("FLOW 1: original delivery -> version listing -> the right Excel download", () => {
  it("lists the delivered version, and downloads it as a genuine workbook: same sheet names, headers, row counts and every cell; read back with a real parser", async () => {
    const w = await world();
    const listed = await json(await api.versions());
    expect(listed.success).toBe(true);
    expect(listed.versions).toEqual([{ version: 1, parent: null, reason: "delivery", createdAt: w.v1.createdAt, digest: w.v1.digest }]);

    const res = await api.versionFile(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(XLSX_TYPE);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Disposition")).toMatch(/filename\*=UTF-8''/);
    const sheets = await parseXlsx(new Uint8Array(await res.arrayBuffer()));
    expect(sheets.map((s) => s.name)).toEqual([CLIENTS_SHEET, NOTES_SHEET]);
    expect(sheets.map((s) => s.rows.length)).toEqual([4, 2]);
    expect(sheets[0].headers).toEqual(["الاسم", "البريد الإلكتروني", "الهاتف", "المعرّف"]);
    expect(sheets).toEqual(sheetsOfVersion(w.v1));
    // nothing was written, charged or priced to show a file
    expect([w.routes.log, w.routes.other, w.routes.storageWrites, w.ledgerTypes()]).toEqual([[], [], [], ["topup"]]);
  });
  it("the ordinary delivery link (no `version`) is the mission's own result file, unchanged by the new routes", async () => {
    const w = await world();
    const res = await api.file(MISSION, "name=result.xlsx");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(w.routes.signed).toEqual([`${MISSION}/result/result.xlsx`]);
    expect(body.url).toContain(`${MISSION}/result/result.xlsx`);
  });
  it("on the stored REAL TikTok file (M12) the version download is the same data: every sheet and every row", async () => {
    const w = await world({ version: "m12" });
    const sheets = await parseXlsx(new Uint8Array(await (await api.versionFile(1)).arrayBuffer()));
    expect(sheets).toEqual(sheetsOfVersion(w.v1));
    expect(sheets.reduce((n, s) => n + s.rows.length, 0)).toBe(w.v1.sheets.reduce((n, s) => n + s.rows.length, 0));
    expect(sheets.length).toBeGreaterThanOrEqual(2);
  }, 90_000);
  it("only the owner reaches it: another customer and a missing file read the same 404; signed out is 401; a version that is not published is 404; a malformed version is 400", async () => {
    await world();
    signInAs(OTHER_USER);
    const theirs = await api.versionFile(1);
    const missing = await api.versionFile(1, MISSING_MISSION);
    expect([theirs.status, missing.status]).toEqual([404, 404]);
    expect(await json(theirs)).toEqual(await json(missing));
    expect((await api.versions(MISSION)).status).toBe(404);
    signInAs(ME);
    expect((await api.versionFile(2)).status).toBe(404);
    for (const bad of ["0", "01", "x", "1.5", "١"]) expect((await api.versionFile(bad)).status, bad).toBe(400);
    signInAs(null);
    expect((await api.versionFile(1)).status).toBe(401);
    expect((await api.versions()).status).toBe(401);
  });
  it("a storage outage is a 503, never «not found»: the listing, the file and the report routes all say so", async () => {
    const w = await world();
    w.routes.faults.storage = true;
    expect((await api.versionFile(1)).status).toBe(503);
    expect((await api.versions()).status).toBe(503);
    expect((await api.reviewReport(MISSION, "version=1")).status).toBe(503);
    expect((await api.reviewQuote(MISSION, "version=1")).status).toBe(503);
    w.routes.faults.storage = false;
    expect((await api.versionFile(1)).status).toBe(200);
  });
  it("DOCUMENTED FINDING: when the DATABASE cannot answer, the versions LIST route says 404 «not found» (ownsMission reads an error as «not theirs»), while the download, report and review routes say 503; nothing is exposed or charged, but the list cannot tell an outage from a missing file", async () => {
    const w = await world();
    w.routes.faults.db = true;
    expect((await api.versionFile(1)).status).toBe(503);
    expect((await api.reviewReport(MISSION, "version=1")).status).toBe(503);
    expect((await api.versions()).status).toBe(404);
    w.routes.faults.db = false;
  });
});

describe("FLOW 2: original -> review quote -> create an unpaid review request -> cancel -> no charge", () => {
  it("the price is shown by code, the request waits unpaid, a refresh finds it, a second click makes no second request, and cancelling moves no money", async () => {
    const w = await world();
    const B = w.money.balance();
    const cells = reviewCellsOf(w.v1);
    expect(cells).toBe(14);

    const quote = (await json(await api.reviewQuote(MISSION, "version=1"))).quote;
    expect(quote).toEqual({ state: "offer", version: 1, reason: "delivery", cells, points: 100 });
    for (const line of reviewQuoteLinesAr(quote)) { noDigits(line); expect(checkCustomerText(line).issues, line).toEqual([]); }
    // the price alone costs nothing and makes nothing
    expect([w.ledgerTypes(), w.addonRows().length, w.routes.log, w.providerRows, w.call.mock.calls.length]).toEqual([["topup"], 0, [], [], 0]);

    const made = await api.reviewRequestPost({ action: "create", version: 1 });
    expect(made.status).toBe(201);
    const { request } = await json(made);
    expect(request).toMatchObject({ version: 1, cells, points: 100, status: "plan_ready" });
    for (const line of reviewRequestLinesAr(request)) noDigits(line);
    const row = w.addonRows()[0];
    expect(row).toMatchObject({ id: request.id, user_id: ME, status: "plan_ready", job_id: null });
    expect((row.plan as any).addon).toMatchObject({ kind: "review", of: MISSION, baseVersion: 1, newVersion: null, attempt: 1 });
    // unpaid: no reserve, no job, no balance change
    expect([w.ledgerTypes(), w.money.jobs.size, w.money.balance()]).toEqual([["topup"], 0, B]);

    // a refresh finds the same request; a second click and a click in parallel make no second one
    expect((await json(await api.reviewRequest())).request).toEqual(request);
    const again = await api.reviewRequestPost({ action: "create", version: 1 });
    expect([again.status, (await json(again)).created]).toEqual([200, false]);
    const parallel = await Promise.all(Array.from({ length: 4 }, () => api.reviewRequestPost({ action: "create", version: 1 })));
    expect(parallel.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(w.addonRows()).toHaveLength(1);

    // another customer cannot cancel it, a stranger's attempt changes nothing
    signInAs(OTHER_USER);
    expect((await api.reviewRequestPost({ action: "cancel", requestId: request.id })).status).toBe(404);
    expect(w.rowOf(request.id).status).toBe("plan_ready");
    signInAs(null);
    expect((await api.reviewRequestPost({ action: "cancel", requestId: request.id })).status).toBe(401);
    signInAs(ME);

    const cancelled = await api.reviewRequestPost({ action: "cancel", requestId: request.id });
    expect(cancelled.status).toBe(200);
    expect(w.rowOf(request.id).status).toBe("cancelled");
    expect((await json(await api.reviewRequest())).request).toBeNull();
    // NO CHARGE, ever: not one ledger row besides the starting top-up, no job, the same balance, no provider
    expect([w.ledgerTypes(), w.money.jobs.size, w.money.balance(), w.providerRows, w.call.mock.calls.length]).toEqual([["topup"], 0, B, [], 0]);
    expect(w.routes.other).toEqual([]);
    expect(w.routes.storageWrites).toEqual([]);
    // cancelling again says the state changed; the file can be quoted again
    const twice = await api.reviewRequestPost({ action: "cancel", requestId: request.id });
    expect([twice.status, (await json(twice)).error]).toEqual([409, "changed"]);
    expect((await json(await api.reviewQuote(MISSION, "version=1"))).quote.state).toBe("offer");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("FLOW 3: price -> request -> approval (the existing money core, fake) -> review -> published report -> the customer's view", () => {
  it("nothing moves before approval; approval holds exactly the price; the review charges it once; the report the customer sees is exactly the engine's review of that version", async () => {
    const w = await world();
    const B = w.money.balance();
    const quote = (await json(await api.reviewQuote(MISSION, "version=1"))).quote;
    const made = await json(await api.reviewRequestPost({ action: "create", version: 1 }));
    // COST BEFORE APPROVAL IS ZERO: no ledger row but the top-up, no job, no provider call, no report yet
    expect([w.ledgerTypes(), w.money.jobs.size, w.providerRows, w.call.mock.calls.length]).toEqual([["topup"], 0, [], 0]);
    expect((await api.reviewReport(MISSION, "version=1")).status).toBe(404);

    const a = await w.approveAndClaim(made.request.id);
    const P = quote.points as number;
    expect(a.hold).toBe(P);
    expect(w.ledgerTypes()).toEqual(["topup", "reserve"]);
    expect(w.money.balance()).toBe(B - P);
    // while it runs nothing is shown as done: the report route still has nothing
    expect((await api.reviewReport(MISSION, "version=1")).status).toBe(404);

    await runAddonSafely(w.deps, a.row);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: P, charged: P })).toEqual([]);
    expect(w.ledgerTypes()).toEqual(["topup", "reserve", "release", "charge"]);
    expect(w.money.balance()).toBe(B - P);
    expect(w.money.balance()).toBeGreaterThanOrEqual(0);
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "completed", charged_credits: P, reserved_credits: P });
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: P });
    expect(w.call).not.toHaveBeenCalled();
    expect(w.providerRows).toEqual([]);
    const told = said(w, a.id);
    expect(told).toContain(ADDON_DONE_AR.reviewDone(P));
    for (const s of told) { expect(checkCustomerText(s).issues, s).toEqual([]); noDigits(s); }

    // the customer's view of the published report
    expect((await json(await api.reviewReport())).versions).toEqual([1]);
    const res = await api.reviewReport(MISSION, "version=1");
    expect(res.status).toBe(200);
    const { report } = await json(res);
    const truth = reviewFile(w.v1);
    expect(report).toMatchObject({ version: 1, reason: "delivery", score: truth.score, cells: truth.cells, rowsReviewed: 6 });
    expect(report.issues.map((i: any) => [i.code, i.sheet, i.column, i.count])).toEqual(truth.issues.map((i) => [i.code, i.sheet, i.column, i.count]));
    expect(report.issues.length).toBeGreaterThanOrEqual(4);
    for (const i of report.issues) expect(i.textAr).toBe(REVIEW_ISSUE_AR[i.code as keyof typeof REVIEW_ISSUE_AR](i.column, i.count));
    // an honest score: faults were found, so it is not 100; nothing private leaks
    expect(report.score).toBeLessThan(100);
    const raw = JSON.stringify(report);
    for (const secret of [a.id, "c_1", "c_2", "reviews/", "addons/", "versions/", w.v1.digest]) expect(raw, secret).not.toContain(secret);
    // the review changed nothing: version 1 is the same, no other version exists
    expect(w.versionFiles()).toEqual([`${MISSION}/versions/v0001.json`]);
    expect(JSON.parse((await w.store.getFile(MISSION, "versions/v0001.json"))!).digest).toBe(w.v1.digest);
    // no version 2 report is invented
    expect((await api.reviewReport(MISSION, "version=2")).status).toBe(404);
    // and the report is only the owner's
    signInAs(OTHER_USER);
    expect((await api.reviewReport(MISSION, "version=1")).status).toBe(404);
    signInAs(null);
    expect((await api.reviewReport(MISSION, "version=1")).status).toBe(401);
  });
});

describe("FLOW 4: a completed review is reused, never charged twice", () => {
  it("the quote says «reuse», a new request is refused as free, the stored report is shown again, and the ledger does not move", async () => {
    const w = await world();
    const { a, P } = await paidReview(w);
    const ledger = JSON.stringify(w.money.ledger);
    const rowsBefore = w.addonRows().length;
    const balance = w.money.balance();

    const quote = (await json(await api.reviewQuote(MISSION, "version=1"))).quote;
    expect(quote).toEqual({ state: "reuse", version: 1, reason: "delivery" });
    for (const line of (await import("../src/lib/agentMission/stage4/reviewPreviewLabels")).reviewQuoteLinesAr(quote)) { noDigits(line); expect(checkCustomerText(line).issues).toEqual([]); }

    const second = await api.reviewRequestPost({ action: "create", version: 1 });
    expect([second.status, (await json(second)).error]).toEqual([409, "review_exists"]);

    const first = await json(await api.reviewReport(MISSION, "version=1"));
    const again = await json(await api.reviewReport(MISSION, "version=1"));
    expect(again).toEqual(first);
    expect(first.report.score).toBe(reviewFile(w.v1).score);

    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    expect(w.money.balance()).toBe(balance);
    expect(w.addonRows()).toHaveLength(rowsBefore);
    expect(w.money.ledger.filter((r) => r.type === "charge")).toHaveLength(1);
    expect(w.money.jobs.size).toBe(1);
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "completed", charged_credits: P });
    expect(w.reviewFiles()).toEqual([`${MISSION}/reviews/r0001.json`]);
    expect(w.providerRows).toEqual([]);
  });
  it("even a second paid add-on made behind the routes' back (a stale tab) is released whole by the worker: the first report stands and nothing is charged again", async () => {
    const w = await world();
    const { a, P } = await paidReview(w);
    const report = await w.store.getFile(MISSION, "reviews/r0001.json");
    const second = await w.createApproved({ kind: "review", request: { kind: "review" }, pricing: { requested: 1, cells: reviewCellsOf(w.v1), settings: (await import("./helpers/addonWorld")).SETTINGS, estimatePoints: P, holdPoints: P }, attempt: 2 });
    await runAddonSafely(w.deps, second.row);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: P, charged: P })).toEqual([]);
    expect(checkAddonLedger(w.money, second.jobId, { reserved: P, charged: "none" })).toEqual([]);
    expect(w.money.balance()).toBe(w.startBalance - P);
    expect(await w.store.getFile(MISSION, "reviews/r0001.json")).toBe(report);
    expect(w.rowOf(second.id)).toMatchObject({ status: "unserved", charged_points: 0 });
  });
});
