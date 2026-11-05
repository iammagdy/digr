import { readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tiktokWorld } from "./helpers/round11Worlds";
import { ME, MISSION, OTHER_MISSION, addonRowOf, objectsOf, previewClient, sizedVersion } from "./helpers/reviewQuoteWorld";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any, viewerCalls: 0, adminCalls: 0 }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => { state.adminCalls += 1; return state.client; }, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => { state.viewerCalls += 1; return state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) }; }) };
});

import { GET } from "../src/app/api/missions/[id]/review-quote/route";
import { GET as DOWNLOAD } from "../src/app/api/missions/[id]/file/route";
import { reviewCellsOf } from "../src/lib/agentMission/stage4/review";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { digestOf, firstVersionFromCells, versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";

/**
 * MONEY PR 7c, PHASE 2B-2 TASK 2: THE REVIEW-PRICE PREVIEW (docs/MONEY-PR-7A.md section 15). GET /api/missions/[id]/review-quote?version=N answers, for the customer's own mission and a PUBLISHED version, how many cells would be reviewed and what the
 * review would cost, computed on the server by the existing `reviewCellsOf` and `reviewCard` from the stored cells; or says that the review already exists (free) or that another add-on blocks. Without `version` it lists the published versions
 * (what the page offers). Behind DIGER_STAGE4_REVIEW, read first. READ-ONLY: no hold, no charge, no release, no refund, no add-on row, no provider, no model. Every dependency here is a fake.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  state.viewer = { userId: ME, isGuest: false, emailVerified: true }; state.viewerCalls = 0; state.adminCalls = 0;
  vi.stubEnv("DIGER_STAGE4_REVIEW", "on");
  vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const call = async (query: string, id = MISSION) => GET(new NextRequest(`http://localhost/api/missions/${id}/review-quote${query ? `?${query}` : ""}`), { params: Promise.resolve({ id }) });
const dataset = (opts: Parameters<typeof previewClient>[1] = {}, objects?: Record<string, string>) => { state.client = previewClient(objects ?? OBJECTS, opts); return state.client as ReturnType<typeof previewClient>; };
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

describe("TEST 1, 2, 3: the quote is made from the stored cells", () => {
  it("version 1: the version, its readable cells (id columns not counted) and the price of the existing card", async () => {
    dataset();
    const res = await call("version=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    const cells = v1.sheets.reduce((s, sh) => s + sh.rows.length * sh.headers.filter((h) => h !== "المعرّف" && h !== "معرّف الأصل").length, 0);
    expect(cells).toBe(reviewCellsOf(v1));
    expect(body).toEqual({ success: true, quote: { state: "offer", version: 1, reason: "delivery", cells, points: priceOf(cells) } });
  }, 60_000);
  it("version 2 (one more column): more cells, and the price follows the cells of THAT version", async () => {
    dataset();
    const b1 = (await (await call("version=1")).json()).quote;
    const b2 = (await (await call("version=2")).json()).quote;
    expect(b2).toMatchObject({ state: "offer", version: 2, reason: "edit", cells: reviewCellsOf(v2), points: priceOf(reviewCellsOf(v2)) });
    expect(b2.cells).toBe(b1.cells + v1.sheets[0].rows.length);
    expect(b2.cells).toBeGreaterThan(b1.cells);
  }, 60_000);
  it("the price is 1 point per 100 cells rounded up, at least 100, taken from the stored cells (not from a count in the object)", async () => {
    const table: Array<[number, number, number, number]> = [[100, 99, 9_900, 100], [100, 100, 10_000, 100], [101, 100, 10_100, 101], [300, 40, 12_000, 120], [1000, 25, 25_000, 250]];
    for (const [rows, cols, cells, points] of table) {
      dataset({}, objectsOf(sizedVersion(rows, cols)));
      expect((await (await call("version=1")).json()).quote, `${cells} cells`).toMatchObject({ state: "offer", cells, points });
    }
    // an object whose rows were cut is priced on what it holds: the same version with half the rows costs less
    const big = sizedVersion(400, 50);
    const half = firstVersionFromCells({ missionId: MISSION, cells: { "الورقة": [["المعرّف", ...Array.from({ length: 50 }, (_, i) => `عمود ${i + 1}`)], ...big.sheets[0].rows.slice(0, 200).map((r) => r.cells)] }, createdAt: big.createdAt });
    dataset({}, objectsOf(big)); const full = (await (await call("version=1")).json()).quote;
    dataset({}, objectsOf(half)); const cut = (await (await call("version=1")).json()).quote;
    expect([full.cells, cut.cells]).toEqual([20_000, 10_000]);
    expect([full.points, cut.points]).toEqual([200, 100]);
  }, 120_000);
  it("a version too large to be reviewed once has no price at all (never an invented one)", async () => {
    dataset({}, objectsOf(sizedVersion(2600, 200)));
    const body = await (await call("version=1")).json();
    expect(body.quote).toEqual({ state: "too_large", version: 1, reason: "delivery", cells: 520_000 });
    expect(JSON.stringify(body)).not.toMatch(/points/);
  }, 120_000);
  it("a version with no readable cell has nothing to review and no price", async () => {
    dataset({}, objectsOf(firstVersionFromCells({ missionId: MISSION, cells: { "الورقة": [["المعرّف"]] }, createdAt: "2026-11-02T12:00:00.000Z" })));
    const body = await (await call("version=1")).json();
    expect(body.quote).toEqual({ state: "nothing_to_review", version: 1, reason: "delivery", cells: 0 });
  });
});

describe("the list of published versions (no `version`): what the page offers", () => {
  it("each published version with its number and reason only, oldest first; nothing pending, no digest, no cell, no path", async () => {
    dataset({}, { ...OBJECTS, [`${MISSION}/addons/mad_1/v0003.json`]: JSON.stringify({ ...v2, version: 3 }), [`${MISSION}/addons/mad_1/freeze.json`]: "{}" });
    const res = await call("");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, versions: [{ version: 1, reason: "delivery" }, { version: 2, reason: "edit" }] });
    expect(JSON.stringify(body)).not.toMatch(/digest|addons|freeze|v0003|storage|msn_/);
  }, 60_000);
  it("a mission with no version: an empty list; a listing that fails: 503", async () => {
    dataset({}, {});
    expect(await (await call("")).json()).toEqual({ success: true, versions: [] });
    dataset({ listError: true });
    expect((await call("")).status).toBe(503);
  });
});

describe("TEST 4, 5: ownership and authentication", () => {
  it("someone else's mission and a mission that does not exist read exactly the same (404), for the quote and for the list", async () => {
    dataset({}, { ...OBJECTS, ...objectsOf(sizedVersion(10, 10, OTHER_MISSION)) });
    for (const q of ["version=1", ""]) {
      const theirs = await call(q, OTHER_MISSION);
      const nobody = await call(q, "msn_bbbbbbbbbbbbbbbbbbbb");
      expect(theirs.status).toBe(404);
      expect(nobody.status).toBe(404);
      expect(await theirs.json()).toEqual(await nobody.json());
      expect(theirs.headers.get("Cache-Control")).toBe("no-store");
    }
  });
  it("the owner comes from the server's viewer, never from the URL", async () => {
    dataset(); state.viewer = { userId: "u-2", isGuest: false, emailVerified: true };
    expect((await call("version=1&userId=u-1&user_id=u-1")).status).toBe(404);
  });
  it("not signed in: 401, and no storage or table was read", async () => {
    const c = dataset(); state.viewer = null;
    expect((await call("version=1")).status).toBe(401);
    expect(c.calls).toEqual([]);
  });
  it("a stored object of another mission is never priced as this mission's version", async () => {
    dataset({}, { [`${MISSION}/${versionPathOf(1)}`]: JSON.stringify(sizedVersion(10, 10, OTHER_MISSION)) });
    const res = await call("version=1");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/points|cells/);
  });
});

describe("TEST 6, 7, 8, 9: a missing, pending or damaged version and a storage outage get no price", () => {
  it("a version that is not published is 404 (a pending add-on version is not one); a bad version number is 400", async () => {
    dataset({}, { [`${MISSION}/${versionPathOf(1)}`]: JSON.stringify(v1), [`${MISSION}/addons/mad_1/v0002.json`]: JSON.stringify(v2), [`${MISSION}/addons/mad_1/freeze.json`]: "{}" });
    for (const q of ["version=2", "version=3", "version=9999"]) { const res = await call(q); expect(res.status, q).toBe(404); expect(JSON.stringify(await res.json())).not.toMatch(/points|cells|addons|freeze/); }
    for (const q of ["version=0", "version=-1", "version=abc", "version=1.5", "version=01", "version=10000", "version=", "version=1e1", "version=%202", "version=../1", "version=٢", "version=1&version=2"]) expect((await call(q)).status, q).toBe(400);
  });
  it("a damaged published object is 500 with no price", async () => {
    const bad: Array<[string, string]> = [
      ["not json", "{not json"], ["another number", JSON.stringify({ ...v2, version: 7 })], ["a wrong digest", JSON.stringify({ ...v2, digest: "0".repeat(64) })],
      ["no sheets", JSON.stringify({ ...v2, sheets: [], digest: digestOf([]) })], ["a narrow row", JSON.stringify({ ...v2, sheets: [{ ...v2.sheets[0], rows: [{ ...v2.sheets[0].rows[0], cells: ["x"] }] }] })],
    ];
    for (const [label, body] of bad) {
      dataset({}, { ...OBJECTS, [`${MISSION}/${versionPathOf(2)}`]: body });
      const res = await call("version=2");
      expect(res.status, label).toBe(500);
      expect(JSON.stringify(await res.json()), label).not.toMatch(/points|cells/);
    }
  }, 60_000);
  it("a storage outage is 503, never «missing»: the listing, the read, and the question whether another add-on is open", async () => {
    for (const opts of [{ listError: true }, { downloadError: true }, { addonQueryError: true }, { missionError: true }] as const) {
      dataset(opts);
      const res = await call("version=1");
      expect(res.status, JSON.stringify(opts)).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(JSON.stringify(await res.json())).not.toMatch(/points|cells|storage|database|rate limited/);
    }
  });
});

describe("TEST 10: a version that already has a completed review", () => {
  it("is not priced again: the answer says the existing review is reused, with no price", async () => {
    dataset({ addons: [addonRowOf({ status: "completed", kind: "review", base: 1 })] });
    const body = await (await call("version=1")).json();
    expect(body).toEqual({ success: true, quote: { state: "reuse", version: 1, reason: "delivery" } });
    expect(JSON.stringify(body)).not.toMatch(/points|cells/);
  });
  it("another version is still offered at its price; an ended or failed review does not count; a completed review of ANOTHER mission or customer does not count", async () => {
    dataset({ addons: [addonRowOf({ status: "completed", kind: "review", base: 1 })] });
    expect((await (await call("version=2")).json()).quote).toMatchObject({ state: "offer", version: 2 });
    for (const status of ["cancelled", "failed", "unserved"]) {
      dataset({ addons: [addonRowOf({ status, kind: "review", base: 1 })] });
      expect((await (await call("version=1")).json()).quote, status).toMatchObject({ state: "offer", version: 1 });
    }
    dataset({ addons: [addonRowOf({ status: "completed", kind: "review", base: 1, of: OTHER_MISSION }), addonRowOf({ status: "completed", kind: "review", base: 1, user: "u-2", attempt: 2 })] });
    expect((await (await call("version=1")).json()).quote).toMatchObject({ state: "offer" });
  });
  it("a completed EDIT of the version is not a review: the version is still offered for review", async () => {
    dataset({ addons: [addonRowOf({ status: "completed", kind: "edit", base: 1 })] });
    expect((await (await call("version=1")).json()).quote).toMatchObject({ state: "offer", version: 1 });
  });
});

describe("TEST 11: another add-on is open on this file", () => {
  it("every open status blocks, whatever its kind, with no price", async () => {
    for (const status of ["queued", "planning", "needs_input", "plan_ready", "approved", "executing"]) for (const kind of ["review", "edit", "review_fix"] as const) {
      dataset({ addons: [addonRowOf({ status, kind, base: kind === "review" ? 1 : 2 })] });
      const body = await (await call("version=1")).json();
      expect(body, `${status} ${kind}`).toEqual({ success: true, quote: { state: "blocked", version: 1, reason: "delivery" } });
    }
  });
  it("an open add-on blocks even a version whose review is completed (the line comes first), and only THIS file's", async () => {
    dataset({ addons: [addonRowOf({ status: "completed", kind: "review", base: 1 }), addonRowOf({ status: "executing", kind: "edit", base: 2, attempt: 1 })] });
    expect((await (await call("version=1")).json()).quote.state).toBe("blocked");
    dataset({ addons: [addonRowOf({ status: "executing", kind: "edit", base: 1, of: OTHER_MISSION }), addonRowOf({ status: "executing", kind: "edit", base: 1, user: "u-2", attempt: 3 })] });
    expect((await (await call("version=1")).json()).quote.state).toBe("offer");
  });
});

describe("TEST 12, 13: a preview is not a financial operation and calls no provider or model", () => {
  it("no insert, update, upsert, delete, rpc, upload, remove or signed link, for any answer; no fetch", async () => {
    const worlds = [dataset(), dataset({ addons: [addonRowOf({ status: "completed" })] }), dataset({ addons: [addonRowOf({ status: "executing", kind: "edit", base: 2 })] }), dataset({ listError: true }), dataset({}, {})];
    for (const w of worlds) { state.client = w; for (const q of ["version=1", "version=2", "version=3", "version=0", ""]) await call(q); }
    for (const w of worlds) expect(w.writes).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 60_000);
  it("the preview code makes no write, no signed link, no settlement call, no model or provider call", () => {
    const code = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const src = code("../src/lib/agentMission/stage4/reviewPreview.ts") + code("../src/app/api/missions/[id]/review-quote/route.ts");
    expect(src).not.toMatch(/\.(upload|insert|update|upsert|delete|remove|rpc|createSignedUrl)\(/);
    expect(src).not.toMatch(/settleAddon|approveAddon|reserve|release|chargeAddon|accept_quote|credit_ledger|gateway|anthropic|openai|\bfetch\s*\(/i);
    expect(src).toMatch(/reviewCard\(/);
    expect(src).toMatch(/reviewCellsOf\(/);
  });
});

describe("TEST 14: the flags", () => {
  it("DIGER_STAGE4_REVIEW not exactly «on» (unset, empty, off, test, any other word): 404 before the viewer or the database is touched, for the quote and the list", async () => {
    dataset();
    for (const v of ["", "off", "test", "yes", "true", "1", "enabled"]) {
      vi.stubEnv("DIGER_STAGE4_REVIEW", v);
      for (const q of ["version=1", ""]) {
        const res = await call(q);
        expect(res.status, `${v} ${q}`).toBe(404);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(JSON.stringify(await res.json())).not.toMatch(/points|cells|versions/);
      }
    }
    vi.unstubAllEnvs();
    expect((await call("version=1")).status).toBe(404);
    expect(state.viewerCalls).toBe(0);
    expect(state.adminCalls).toBe(0);
  });
  it("the versions flag and the edits flag do not matter: with only the review flag on it works, and with the review flag off a versions flag on exposes nothing", async () => {
    dataset();
    vi.stubEnv("DIGER_STAGE4_VERSIONS", ""); vi.stubEnv("DIGER_STAGE4_EDITS", "");
    expect((await call("version=1")).status).toBe(200);
    vi.stubEnv("DIGER_STAGE4_REVIEW", ""); vi.stubEnv("DIGER_STAGE4_VERSIONS", "on"); vi.stubEnv("DIGER_STAGE4_EDITS", "on");
    expect((await call("version=1")).status).toBe(404);
  });
  it("the existing downloads are unchanged by the review flag (off and on give the same answer)", async () => {
    const answers: number[] = [];
    for (const flag of ["", "on"]) {
      vi.stubEnv("DIGER_STAGE4_REVIEW", flag); vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
      dataset();
      const res = await DOWNLOAD(new NextRequest(`http://localhost/api/missions/${MISSION}/file?name=result.xlsx&version=1&stream=1`), { params: Promise.resolve({ id: MISSION }) });
      answers.push(res.status);
      expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }
    expect(answers).toEqual([200, 200]);
  }, 60_000);
});
