import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tiktokWorld } from "./helpers/round11Worlds";
import { ME, MISSION, OTHER_MISSION, objectsOf, previewClient, sizedVersion } from "./helpers/reviewQuoteWorld";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any, viewerCalls: 0, adminCalls: 0 }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => { state.adminCalls += 1; return state.client; }, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => { state.viewerCalls += 1; return state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) }; }) };
});

import { GET } from "../src/app/api/missions/[id]/review-report/route";
import { checkReviewReport, listReviewedVersions, readReviewReport, reviewReportAvailable } from "../src/lib/agentMission/stage4/reviewReport";
import { REVIEW_ISSUE_AR, reviewCellsOf, reviewFile } from "../src/lib/agentMission/stage4/review";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { firstVersionFromCells, type FileVersion } from "../src/lib/agentMission/stage4/versions";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * STAGE A: THE CUSTOMER'S REVIEW REPORT. GET /api/missions/[id]/review-report?version=N answers the PUBLISHED report `reviews/rNNNN.json` of the customer's own mission, after the server has checked that it is exactly the review of that version (mission, number, the digest of the version
 * as stored now, cells, rows, score and issues). Without `version` it lists the versions that have a published report. It is READ-ONLY (no add-on row, no hold, no charge, no provider), behind DIGER_STAGE4_REVIEW read first, and it never shows a pending
 * report (`addons/<id>/review.json`), a storage path, a row id or an add-on id. Every dependency is a fake; the reports are made by the real `reviewFile`.
 */
const ADDON = "msn_0123456789abcdef0123";
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  state.viewer = { userId: ME, isGuest: false, emailVerified: true }; state.viewerCalls = 0; state.adminCalls = 0;
  vi.stubEnv("DIGER_STAGE4_REVIEW", "on");
  vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const call = async (query: string, id = MISSION) => GET(new NextRequest(`http://localhost/api/missions/${id}/review-report${query ? `?${query}` : ""}`), { params: Promise.resolve({ id }) });
const reviewPath = (n: number, m = MISSION) => `${m}/reviews/r${String(n).padStart(4, "0")}.json`;
const reportOf = (v: FileVersion, over: Record<string, unknown> = {}) => ({ v: 1, addonId: ADDON, missionId: v.missionId, version: v.version, baseDigest: v.digest, createdAt: "2026-11-04T10:00:00.000Z", ...reviewFile(v), ...over });
const world = (objects: Record<string, string>, opts: Parameters<typeof previewClient>[1] = {}) => { state.client = previewClient(objects, opts); return state.client as ReturnType<typeof previewClient>; };
const put = (o: Record<string, string>, n: number, report: unknown, m = MISSION) => { o[reviewPath(n, m)] = typeof report === "string" ? report : JSON.stringify(report); return o; };

/** A file with one fault of each kind a review finds. */
function messyVersion(): FileVersion {
  const head = ["المعرّف", "الاسم", "البريد الإلكتروني", "الهاتف"];
  return firstVersionFromCells({ missionId: MISSION, createdAt: "2026-11-02T12:00:00.000Z", cells: { "العملاء": [head,
    ["row_1", "أحمد", "a@b.co", "01000000000"],
    ["row_2", "", "not-an-email", "123"],
    ["row_3", "سارة", "غير متوفر", "01111111111"],
    ["row_4", "أحمد", "a@b.co", "01000000000"],
    ["row_5", "منى", "m@x.org", "01222222222"],
  ] } });
}
const cleanVersion = (): FileVersion => firstVersionFromCells({ missionId: MISSION, createdAt: "2026-11-02T12:00:00.000Z", cells: { "العملاء": [["المعرّف", "الاسم", "البريد الإلكتروني"], ["a_1", "أحمد", "a@b.co"], ["a_2", "سارة", "s@b.co"]] } });

let mess: FileVersion; let clean: FileVersion; let tiktok: FileVersion;
beforeAll(async () => {
  mess = messyVersion(); clean = cleanVersion();
  const { cells } = await tiktokWorld();
  tiktok = firstVersionFromCells({ missionId: MISSION, cells, createdAt: "2026-11-02T12:00:00.000Z" });
}, 60_000);

describe("the flag, the identity and the input", () => {
  it("flag unset, empty, «test» or any other word: 404 before the id, the viewer or the database is looked at", async () => {
    for (const v of [undefined, "", "off", "test", "yes", "ON "]) {
      if (v === undefined) vi.unstubAllEnvs(); else vi.stubEnv("DIGER_STAGE4_REVIEW", v);
      world(put({ ...objectsOf(mess) }, 1, reportOf(mess)));
      const res = await call("version=1");
      expect(res.status, String(v)).toBe(v === "ON " ? 200 : 404);
      if (v !== "ON ") { expect(state.viewerCalls).toBe(0); expect(state.adminCalls).toBe(0); }
      state.viewerCalls = 0; state.adminCalls = 0;
    }
    vi.unstubAllEnvs();
    expect(reviewReportAvailable({ DIGER_STAGE4_REVIEW: "on" })).toBe(true);
    expect(reviewReportAvailable({})).toBe(false);
    expect(reviewReportAvailable({ DIGER_STAGE4_REVIEW: "test" })).toBe(false);
  });
  it("a bad mission id, a repeated version, or anything but one positive whole ASCII number is a 400", async () => {
    world({});
    expect((await call("version=1", "../etc")).status).toBe(400);
    for (const q of ["version=1&version=2", "version=0", "version=01", "version=-1", "version=1.5", "version=%D9%A1", "version=1e2", "version=", "version=12345", "version=%201", "version=abc"]) expect((await call(q)).status, q).toBe(400);
  });
  it("not signed in: 401, and the storage is not touched", async () => {
    const w = world(put(objectsOf(mess), 1, reportOf(mess)));
    state.viewer = null;
    expect((await call("version=1")).status).toBe(401);
    expect(w.calls).toEqual([]);
  });
  it("another customer's mission and a mission that does not exist: 404 with the same body", async () => {
    world(put({ ...objectsOf(mess), ...put({}, 1, reportOf(sizedVersion(2, 2, OTHER_MISSION)), OTHER_MISSION) }, 1, reportOf(mess)));
    const theirs = await call("version=1", OTHER_MISSION);
    const missing = await call("version=1", "msn_bbbbbbbbbbbbbbbbbbbb");
    expect([theirs.status, missing.status]).toEqual([404, 404]);
    expect(await theirs.json()).toEqual(await missing.json());
    // nor does the list reveal them
    expect((await call("", OTHER_MISSION)).status).toBe(404);
  });
});

describe("the published report of a published version", () => {
  it("returns the version, the score, the cells, the rows and every issue, with the review's own Arabic sentence for each", async () => {
    world(put(objectsOf(mess), 1, reportOf(mess)));
    const res = await call("version=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { success, report } = await res.json();
    const truth = reviewFile(mess);
    expect(success).toBe(true);
    expect(report).toMatchObject({ version: 1, reason: "delivery", score: truth.score, cells: truth.cells, rowsReviewed: 5, reviewedAt: "2026-11-04T10:00:00.000Z" });
    expect(report.cells).toBe(reviewCellsOf(mess));
    expect(report.issues.map((i: any) => [i.code, i.sheet, i.column, i.count])).toEqual(truth.issues.map((i) => [i.code, i.sheet, i.column, i.count]));
    expect(report.issues.length).toBeGreaterThanOrEqual(5);
    for (const i of report.issues) { expect(i.textAr).toBe(REVIEW_ISSUE_AR[i.code as keyof typeof REVIEW_ISSUE_AR](i.column, i.count)); expect(checkCustomerText(i.textAr).issues, i.textAr).toEqual([]); }
  });
  it("a clean file: score 100, no issue", async () => {
    world(put(objectsOf(clean), 1, reportOf(clean)));
    const { report } = await (await call("version=1")).json();
    expect(report).toMatchObject({ score: 100, cells: 4, rowsReviewed: 2, issues: [] });
  });
  it("never shows an internal path, an add-on id, a row id, a digest or a storage word", async () => {
    world(put(objectsOf(mess), 1, reportOf(mess)));
    const raw = await (await call("version=1")).text();
    for (const secret of [ADDON, "row_1", "row_2", "reviews/", "versions/", "addons/", "r0001", "v0001", mess.digest, "baseDigest", "addonId", "rowIds", "storage", "agent-", "https://"]) expect(raw, secret).not.toContain(secret);
    expect(Object.keys(JSON.parse(raw).report).sort()).toEqual(["cells", "issues", "reason", "reviewedAt", "rowsReviewed", "score", "version"]);
  });
  it("reading is free: not one write, rpc, upload or signed link, no provider, and no add-on row", async () => {
    const w = world(put(objectsOf(mess), 1, reportOf(mess)));
    await call("version=1"); await call("version=1"); await call("");
    expect(w.writes).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("a second ask for the same review is the same answer (reuse without a second request)", async () => {
    world(put(objectsOf(mess), 1, reportOf(mess)));
    const a = await (await call("version=1")).json(); const b = await (await call("version=1")).json();
    expect(a).toEqual(b);
  });
  it("the review of version 2 is the review of version 2, not of version 1", async () => {
    const sheet = clean.sheets[0];
    const r = applyEditRequest(clean, { kind: "add_column", sheet: sheet.nameAr, titleAr: "الهاتف", values: Object.fromEntries(sheet.rows.map((x) => [x.id, ""])) }, { createdAt: "2026-11-03T09:30:00.000Z" });
    if (!r.ok) throw new Error(r.reason);
    const o = put(put(objectsOf(clean, r.version), 1, reportOf(clean)), 2, reportOf(r.version));
    world(o);
    const one = (await (await call("version=1")).json()).report; const two = (await (await call("version=2")).json()).report;
    expect([one.version, one.reason, two.version, two.reason]).toEqual([1, "delivery", 2, "edit"]);
    expect(two.cells).toBe(reviewCellsOf(r.version));
    expect(two.cells).toBeGreaterThan(one.cells);
  });
  it("a real delivered file (the TikTok M12 world): the report of its own review is accepted, a score of 100 included", async () => {
    world(put(objectsOf(tiktok), 1, reportOf(tiktok)));
    const { report } = await (await call("version=1")).json();
    expect(report.score).toBe(reviewFile(tiktok).score);
    expect(report.cells).toBe(reviewCellsOf(tiktok));
  }, 60_000);
});

describe("what is NOT a published report", () => {
  it("a published version with no report: 404, and no score is invented", async () => {
    world(objectsOf(mess));
    const res = await call("version=1");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: "not_found" });
  });
  it("a PENDING report (addons/<id>/review.json) is never shown as a completed review", async () => {
    const o = objectsOf(mess); o[`${MISSION}/addons/${ADDON}/review.json`] = JSON.stringify(reportOf(mess));
    world(o);
    expect((await call("version=1")).status).toBe(404);
    expect((await (await call("")).json()).versions).toEqual([]);
  });
  it("a report of a version that is not published: 404 (the version is read first)", async () => {
    world(put({}, 1, reportOf(mess)));
    expect((await call("version=1")).status).toBe(404);
  });
  it("the list names only the versions that have a published report, oldest first, and only for the owner", async () => {
    const sheet = clean.sheets[0];
    const r = applyEditRequest(clean, { kind: "set_cells", sheet: sheet.nameAr, cells: [{ rowId: "a_1", column: "الاسم", value: "محمد" }] }, { createdAt: "2026-11-03T09:30:00.000Z" });
    if (!r.ok) throw new Error(r.reason);
    const o = put(put(objectsOf(clean, r.version), 2, reportOf(r.version)), 1, reportOf(clean));
    o[`${MISSION}/reviews/notes.txt`] = "x"; o[`${MISSION}/reviews/r12.json`] = "x";
    world(o);
    expect(await (await call("")).json()).toEqual({ success: true, versions: [1, 2] });
  });
  it("a report that exists in storage for a mission but whose version object is damaged: 500, never shown", async () => {
    const o = put({ [`${MISSION}/versions/v0001.json`]: "{not json" }, 1, reportOf(mess));
    world(o);
    expect((await call("version=1")).status).toBe(500);
  });
});

describe("a report that is not exactly this version's review is refused (500 damaged), never shown", () => {
  const bad = async (over: Record<string, unknown> | string, v = mess) => {
    world(put(objectsOf(v), 1, typeof over === "string" ? over : reportOf(v, over)));
    const res = await call("version=1");
    return { status: res.status, body: await res.json() };
  };
  it("not JSON, not an object, an array", async () => {
    for (const s of ["{broken", "null", "[]", '"text"', "7"]) { const r = await bad(s); expect([s, r.status, r.body.error]).toEqual([s, 500, "damaged"]); }
  });
  it("another mission, another version number, another format, no stamp", async () => {
    for (const over of [{ missionId: OTHER_MISSION }, { version: 2 }, { version: "1" }, { v: 2 }, { v: undefined }, { createdAt: "yesterday" }, { createdAt: 5 }, { createdAt: undefined }, { addonId: undefined }, { addonId: 7 }]) expect((await bad(over)).status, JSON.stringify(over)).toBe(500);
  });
  it("the digest of the reviewed version is not the digest of the version now stored (the file changed, or the report is of another file)", async () => {
    for (const d of ["0".repeat(64), "", "zz", 1, undefined, clean.digest]) expect((await bad({ baseDigest: d })).status, String(d)).toBe(500);
  });
  it("cells or rows that do not match the version", async () => {
    const t = reviewFile(mess);
    for (const over of [{ cells: t.cells + 1 }, { cells: t.cells - 1 }, { cells: "20" }, { cells: -1 }, { rowsReviewed: 4 }, { rowsReviewed: 6 }, { rowsReviewed: 5.5 }]) expect((await bad(over)).status, JSON.stringify(over)).toBe(500);
  });
  it("a score that is not a whole number from 0 to 100", async () => {
    for (const s of [101, -1, 99.5, "80", null, NaN, Infinity, undefined]) expect((await bad({ score: s })).status, String(s)).toBe(500);
  });
  it("a score that the issues cannot produce: 100 with a fault, or less than 100 with none", async () => {
    expect((await bad({ score: 100 })).status).toBe(500); // the messy file has faults
    expect((await bad({ score: 60 }, clean)).status).toBe(500);
    expect((await bad({ score: 0 }, clean)).status).toBe(500);
    // faults only a stated gap: still 100
    const gap = firstVersionFromCells({ missionId: MISSION, createdAt: "2026-11-02T12:00:00.000Z", cells: { "ورقة": [["المعرّف", "الاسم"], ["g_1", "غير متوفر"], ["g_2", "سارة"]] } });
    expect((await bad({}, gap)).status).toBe(200);
    expect((await bad({ score: 90 }, gap)).status).toBe(500);
  });
  it("an issue that is not one: unknown code, unknown sheet, unknown column, a count of zero or more than the cells, row ids that are not text, extra junk", async () => {
    const t = reviewFile(mess); const first = t.issues[0];
    const mk = (patch: Record<string, unknown>) => ({ issues: [{ ...first, ...patch }, ...t.issues.slice(1)] });
    for (const patch of [{ code: "free_money" }, { sheet: "ورقة أخرى" }, { column: "عمود غير موجود" }, { column: "المعرّف" }, { count: 0 }, { count: 1.5 }, { count: 999 }, { count: "1" }, { rowIds: "x" }, { rowIds: [1] }, { rowIds: Array.from({ length: 30 }, (_, i) => `r${i}`) }, { rowIds: [] }, { rowIds: ["nope"] }]) expect((await bad(mk(patch))).status, JSON.stringify(patch)).toBe(500);
    expect((await bad({ issues: "none" })).status).toBe(500);
    expect((await bad({ issues: [null] })).status).toBe(500);
  });
  it("the same finding twice (an issue repeated for one sheet, code and column) is not a report this engine writes", async () => {
    const t = reviewFile(mess);
    expect((await bad({ issues: [t.issues[0], ...t.issues] })).status).toBe(500);
  });
});

describe("the storage: a failure is never «not found»", () => {
  it("a listing that fails, or a read that fails (a rate limit, a 5xx), is a 503 with no score", async () => {
    world(put(objectsOf(mess), 1, reportOf(mess)), { listError: true });
    const a = await call("version=1");
    expect([a.status, (await a.json()).error]).toEqual([503, "unavailable"]);
    world(put(objectsOf(mess), 1, reportOf(mess)), { downloadError: true });
    const b = await call("version=1");
    expect([b.status, (await b.json()).error]).toEqual([503, "unavailable"]);
    world(objectsOf(mess), { listError: true });
    expect((await call("")).status).toBe(503);
  });
  it("the database cannot answer: 503", async () => {
    world(put(objectsOf(mess), 1, reportOf(mess)), { missionError: true });
    expect((await call("version=1")).status).toBe(503);
    expect((await call("")).status).toBe(503);
  });
  it("a missing report object is 404 only when the listing really does not show it", async () => {
    const w = world(objectsOf(mess));
    expect((await call("version=1")).status).toBe(404);
    expect(w.calls.some((c) => c.startsWith("list ") && c.endsWith("/reviews"))).toBe(true);
  });
});

describe("the server module, directly", () => {
  it("checkReviewReport accepts what the engine writes for any file (50 random files) and returns null for the same file with another digest", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let k = 0; k < 50; k += 1) {
      const rows = 1 + Math.floor(rnd() * 12);
      const head = ["المعرّف", "الاسم", "البريد الإلكتروني", "الهاتف", "تاريخ التسجيل", "الموقع الإلكتروني"];
      const pool = ["", "غير متوفر", "لم يكتمل البحث", "x", "a@b.co", "bad@", "0100000000", "12", "2026-01-02", "ليس تاريخًا", "https://a.co", "a.co"];
      const body = Array.from({ length: rows }, (_, i) => [`k${k}_${i}`, ...head.slice(1).map(() => pool[Math.floor(rnd() * pool.length)])]);
      const v = firstVersionFromCells({ missionId: MISSION, createdAt: "2026-11-02T12:00:00.000Z", cells: { "الورقة": [head, ...body] } });
      expect(checkReviewReport(reportOf(v), v), `file ${k}`).not.toBeNull();
      expect(checkReviewReport(reportOf(v, { baseDigest: "a".repeat(64) }), v), `file ${k}`).toBeNull();
    }
  });
  it("readReviewReport and listReviewedVersions report the failures with the same statuses as the route", async () => {
    const w = world(put(objectsOf(mess), 1, reportOf(mess)));
    const ok = await readReviewReport(w, { missionId: MISSION, userId: ME, version: 1 });
    expect(ok.ok).toBe(true);
    expect(await readReviewReport(w, { missionId: MISSION, userId: "u-2", version: 1 })).toMatchObject({ ok: false, status: 404 });
    expect(await listReviewedVersions(w, { missionId: MISSION, userId: ME })).toEqual({ ok: true, versions: [1] });
  });
});

describe("the source: a read-only module", () => {
  const SRC = ["src/lib/agentMission/stage4/reviewReport.ts", "src/app/api/missions/[id]/review-report/route.ts"].map((f) => readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")).join("\n");
  it("no write, no rpc, no upload, no signed link, no add-on row, no money or provider function", () => {
    expect(SRC).not.toMatch(/\.(rpc|insert|update|upsert|delete|upload|remove|createSignedUrl)\(/);
    expect(SRC).not.toMatch(/createAddonRow|settleAddon|approveAddon|accept_quote_atomic|release_job_atomic|credit_ledger|gateway|openai|process\.env/);
  });
  it("it reads the flag by the stage-4 flag reader and does not import the preview or the card (so it never reaches the price)", () => {
    expect(SRC).toMatch(/DIGER_STAGE4_REVIEW/);
    expect(SRC).not.toMatch(/reviewPreview|addonQuote|quotes"/);
  });
});
