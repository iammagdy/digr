import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { tiktokWorld } from "./helpers/round11Worlds";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any, viewerCalls: 0 }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => { state.viewerCalls += 1; return state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) }; }) };
});

import { GET } from "../src/app/api/missions/[id]/file/route";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { firstVersionFromCells, versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";
import { fileNameFromDisposition } from "../src/lib/downloadName";

/**
 * MONEY PR 7b, PHASE 2B-2 TASK 1: A CUSTOMER DOWNLOADS ANY PUBLISHED VERSION OF THEIR OWN FILE (docs/MONEY-PR-7A.md section 14). GET /api/missions/[id]/file?name=result.xlsx&version=N&stream=1 answers a genuine .xlsx built from
 * the stored `versions/vNNNN.json`, only for the owner, only for a version that is really published, behind DIGER_STAGE4_VERSIONS. Without `version` the route is what it was. Every dependency here is a fake: no storage, no database,
 * no provider, no money.
 */
const MISSION = "msn_5851abc92a1e6645a9cd";
const OTHER = "msn_aaaaaaaaaaaaaaaaaaaa";
const ME = "u-1";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => { state.viewer = { userId: ME, isGuest: false, emailVerified: true }; state.viewerCalls = 0; vi.stubEnv("DIGER_STAGE4_VERSIONS", "on"); });

interface Opts { listError?: boolean; downloadError?: "listed" | "all"; missions?: any[] }
/** A client with the missions table and a bucket of named objects; every write, every signed link and every rpc is counted (a download must make none). */
function clientWith(objects: Record<string, string | Buffer>, opts: Opts = {}) {
  const db = createMemoryDb();
  const file = { name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx", download_name: "تعليقات تيك توك.xlsx" };
  db.seed("missions", opts.missions ?? [
    { id: MISSION, user_id: ME, status: "completed", files: [file], plan: null, request_text: "تعليقات", delivered_units: 60, updated_at: "2026-11-02T12:00:00.000Z" },
    { id: OTHER, user_id: "u-2", status: "completed", files: [file], plan: null, request_text: "x", delivered_units: 1, updated_at: "2026-11-02T12:00:00.000Z" },
  ]);
  const writes: string[] = [];
  const bucket = {
    list: async (dir: string) => opts.listError ? { data: null, error: { message: "down" } } : { data: [...new Set(Object.keys(objects).filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split("/")[0]))].map((name) => ({ name, id: Object.keys(objects).includes(`${dir}/${name}`) ? `id_${name}` : null })), error: null },
    download: async (p: string) => {
      if (opts.downloadError === "all" || (opts.downloadError === "listed" && p.includes("/versions/"))) return { data: null, error: { message: "rate limited", statusCode: "429" } };
      return objects[p] === undefined ? { data: null, error: { message: "Object not found", statusCode: "404" } } : { data: new Blob([objects[p] as any]), error: null };
    },
    upload: async (p: string) => { writes.push(`upload ${p}`); return { data: {}, error: null }; },
    remove: async (p: string) => { writes.push(`remove ${p}`); return { data: {}, error: null }; },
    createSignedUrl: async (p: string) => { writes.push(`signed ${p}`); return { data: { signedUrl: `https://storage.example/signed/${p}` }, error: null }; },
  };
  const from = (t: string) => new Proxy(db.from(t), { get: (target, prop: string) => (["insert", "update", "upsert", "delete"].includes(prop) ? (...a: any[]) => { writes.push(`${prop} ${t}`); return (target as any)[prop](...a); } : (target as any)[prop]) });
  return { from, storage: { from: () => bucket }, rpc: async (name: string) => { writes.push(`rpc ${name}`); return { data: null, error: null }; }, auth: { admin: { getUserById: async () => ({ data: { user: { email: "customer@example.com" } } }) } }, writes };
}
const download = async (query: string, id = MISSION) => GET(new NextRequest(`http://localhost/api/missions/${id}/file?${query}`), { params: Promise.resolve({ id }) });
const versionQuery = (v: string | number) => `name=result.xlsx&version=${v}&stream=1`;
const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());
async function openWorkbook(res: Response) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await bytesOf(res)) as any); return wb; }
const textOf = (v: ExcelJS.CellValue): string => (v === null || v === undefined ? "" : typeof v === "object" ? String((v as any).text ?? (v as any).result ?? "") : String(v));

let v1: FileVersion; let v2: FileVersion; let objects: Record<string, string>;
beforeAll(async () => {
  const { cells } = await tiktokWorld();
  v1 = firstVersionFromCells({ missionId: MISSION, cells, createdAt: "2026-11-02T12:00:00.000Z" });
  const sheet = v1.sheets[0];
  const r = applyEditRequest(v1, { kind: "add_column", sheet: sheet.nameAr, titleAr: "اسم القناة", values: Object.fromEntries(sheet.rows.map((x, i) => [x.id, `قناة ${i + 1}`])) }, { createdAt: "2026-11-03T09:30:00.000Z" });
  if (!r.ok) throw new Error(`the fixture edit was refused: ${r.reason}`);
  v2 = r.version;
  objects = { [`${MISSION}/${versionPathOf(1)}`]: JSON.stringify(v1), [`${MISSION}/${versionPathOf(2)}`]: JSON.stringify(v2) };
}, 60_000);

/** The workbook must be exactly the stored version: same sheet names in order, same headers, same rows (count and every cell). */
async function expectWorkbookOf(res: Response, v: FileVersion) {
  const wb = await openWorkbook(res);
  expect(wb.worksheets.map((w) => w.name)).toEqual(v.sheets.map((s) => s.nameAr));
  v.sheets.forEach((s, i) => {
    const ws = wb.worksheets[i];
    expect(ws.rowCount, s.nameAr).toBe(s.rows.length + 1);
    expect((ws.getRow(1).values as any[]).slice(1).map(textOf)).toEqual(s.headers);
    s.rows.forEach((row, r) => { expect(s.headers.map((_, j) => textOf(ws.getRow(r + 2).getCell(j + 1).value)), `${s.nameAr} row ${r + 2}`).toEqual(row.cells); });
  });
}

describe("TEST 1-3, 9, 10: each version downloads as its own genuine workbook", () => {
  it("version 1: a real .xlsx with the stored sheets, headers and every row, and safe headers", async () => {
    state.client = clientWith(objects);
    const res = await download(versionQuery(1));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(XLSX_TYPE);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const name = fileNameFromDisposition(res.headers.get("Content-Disposition"));
    expect(name).toMatch(/\.xlsx$/);
    expect(name).toContain("تعليقات تيك توك");
    expect(name).toContain("النسخة ١");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    await expectWorkbookOf(res, v1);
  }, 60_000);

  it("version 2: the edited data (the added column), not version 1's; each file holds its own version's data", async () => {
    state.client = clientWith(objects);
    const r1 = await download(versionQuery(1));
    const r2 = await download(versionQuery(2));
    expect(r2.status).toBe(200);
    expect(fileNameFromDisposition(r2.headers.get("Content-Disposition"))).toContain("النسخة ٢");
    const b1 = await bytesOf(r1); const b2 = await bytesOf(r2);
    expect(b1.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(b2.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(b1.equals(b2)).toBe(false);
    const w1 = new ExcelJS.Workbook(); await w1.xlsx.load(b1 as any);
    const w2 = new ExcelJS.Workbook(); await w2.xlsx.load(b2 as any);
    expect(w1.worksheets[0].columnCount).toBe(v1.sheets[0].headers.length);
    expect(w2.worksheets[0].columnCount).toBe(v1.sheets[0].headers.length + 1);
    expect(textOf(w2.worksheets[0].getRow(1).getCell(v2.sheets[0].headers.length).value)).toBe("اسم القناة");
    await expectWorkbookOf(new Response(b1), v1);
    await expectWorkbookOf(new Response(b2), v2);
  }, 60_000);

  it("version 1 stays byte-for-byte what it was: the stored objects are untouched and nothing is written by any download", async () => {
    const c = clientWith(objects);
    state.client = c;
    const before = JSON.stringify(objects);
    for (const v of [1, 2, 1, 2]) expect((await download(versionQuery(v))).status).toBe(200);
    expect(JSON.stringify(objects)).toBe(before);
    expect(objects[`${MISSION}/${versionPathOf(1)}`]).toBe(JSON.stringify(v1));
    expect(c.writes).toEqual([]);
  }, 60_000);

  it("Arabic sheet names, headers and values survive exactly, and a text that looks like a formula is kept as the very same text", async () => {
    const odd = { ...v2, sheets: v2.sheets.map((s, i) => (i === 0 ? { ...s, rows: s.rows.map((r, j) => (j === 0 ? { ...r, cells: r.cells.map((c, k) => (k === r.cells.length - 1 ? "=1+1" : c)) } : r)) } : s)) } as FileVersion;
    const { digestOf } = await import("../src/lib/agentMission/stage4/versions");
    const fixed = { ...odd, digest: digestOf(odd.sheets) } as FileVersion;
    state.client = clientWith({ ...objects, [`${MISSION}/${versionPathOf(2)}`]: JSON.stringify(fixed) });
    const res = await download(versionQuery(2));
    expect(res.status).toBe(200);
    const wb = await openWorkbook(res);
    const last = fixed.sheets[0].headers.length;
    expect(wb.worksheets[0].getRow(2).getCell(last).value).toBe("=1+1");
    expect(wb.worksheets[0].getRow(2).getCell(last).type).toBe(ExcelJS.ValueType.String);
  }, 60_000);
});

describe("TEST 5: ownership and authentication", () => {
  it("someone else's mission and a mission that does not exist read exactly the same (404), and name nothing", async () => {
    state.client = clientWith({ ...objects, [`${OTHER}/${versionPathOf(1)}`]: JSON.stringify({ ...v1, missionId: OTHER }) });
    const theirs = await download(versionQuery(1), OTHER);
    const nobody = await download(versionQuery(1), "msn_bbbbbbbbbbbbbbbbbbbb");
    expect(theirs.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect(await theirs.json()).toEqual(await nobody.json());
    expect(theirs.headers.get("Content-Disposition")).toBeNull();
    expect(theirs.headers.get("Cache-Control")).toBe("no-store");
  });
  it("not signed in: 401, and nothing is read", async () => {
    const c = clientWith(objects); state.client = c; state.viewer = null;
    expect((await download(versionQuery(1))).status).toBe(401);
  });
  it("the owner is asked from the server's viewer, never from the URL (a user id in the query changes nothing)", async () => {
    state.client = clientWith(objects); state.viewer = { userId: "u-2", isGuest: false, emailVerified: true };
    expect((await download(`${versionQuery(1)}&userId=u-1&user_id=u-1`)).status).toBe(404);
  });
  it("a stored object that belongs to another mission is never served as this mission's version", async () => {
    state.client = clientWith({ ...objects, [`${MISSION}/${versionPathOf(2)}`]: JSON.stringify({ ...v2, missionId: OTHER }) });
    const res = await download(versionQuery(2));
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).not.toBe(XLSX_TYPE);
  }, 60_000);
});

describe("TEST 6, 7: only a published, valid version number", () => {
  it("a pending version (addons/<id>/v0002.json) and its freeze are not published: 404, never served", async () => {
    state.client = clientWith({ [`${MISSION}/${versionPathOf(1)}`]: JSON.stringify(v1), [`${MISSION}/addons/mad_1/v0002.json`]: JSON.stringify(v2), [`${MISSION}/addons/mad_1/freeze.json`]: "{}", [`${MISSION}/addons/mad_1/outcome.json`]: "{}" });
    const res = await download(versionQuery(2));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).not.toBe(XLSX_TYPE);
    expect(JSON.stringify(await res.json())).not.toMatch(/addons|freeze|pending|v0002/);
  });
  it("a version that does not exist is 404, never another version", async () => {
    state.client = clientWith(objects);
    for (const v of [3, 4, 9999]) { const res = await download(versionQuery(v)); expect(res.status, String(v)).toBe(404); expect(res.headers.get("Content-Disposition")).toBeNull(); }
  });
  it("an old mission with no version object: version 1 is 404 (not a substitute); the ordinary download is unchanged", async () => {
    state.client = clientWith({});
    expect((await download(versionQuery(1))).status).toBe(404);
    const plain = await download("name=result.xlsx");
    expect(plain.status).toBe(200);
    expect((await plain.json()).url).toContain(`${MISSION}/result/result.xlsx`);
  });
  it("an invalid version number is 400 and reads nothing", async () => {
    const c = clientWith(objects); state.client = c;
    for (const v of ["0", "-1", "abc", "1.5", "01", "10000", "99999", "", "1e1", "2%20", "%202", "0x2", "2,3", "../2", "2/../1", "%00", "٢"]) {
      const res = await download(`name=result.xlsx&version=${v}&stream=1`);
      expect(res.status, JSON.stringify(v)).toBe(400);
      expect(res.headers.get("Content-Disposition")).toBeNull();
    }
    expect((await download("name=result.xlsx&version=1&version=2&stream=1")).status).toBe(400);
  });
  it("a version request is for the Excel file only: the CSV's name with a version is 400", async () => {
    state.client = clientWith(objects);
    expect((await download("name=result.csv&version=1&stream=1")).status).toBe(400);
    expect((await download("version=1&stream=1")).status).toBe(400);
  });
});

describe("TEST 8: a storage error is never «missing», and a damaged object is never a file", () => {
  it("a listing that fails is 503; a read that fails for a listed version is 503 (not 404)", async () => {
    state.client = clientWith(objects, { listError: true });
    const a = await download(versionQuery(1));
    expect(a.status).toBe(503);
    state.client = clientWith(objects, { downloadError: "listed" });
    const b = await download(versionQuery(1));
    expect(b.status).toBe(503);
    for (const res of [a, b]) { expect(res.headers.get("Content-Disposition")).toBeNull(); expect(res.headers.get("Cache-Control")).toBe("no-store"); expect(JSON.stringify(await res.json())).not.toMatch(/storage|supabase|rate limited|\/versions\//i); }
  });
  it("a stored object that is not a well-formed version is 500, never a file, never «not found»", async () => {
    const bad: Array<[string, string]> = [
      ["not json", "{not json"],
      ["an array", "[]"],
      ["another version number", JSON.stringify({ ...v2, version: 7 })],
      ["a digest that does not match the sheets", JSON.stringify({ ...v2, digest: "0".repeat(64) })],
      ["no sheets", JSON.stringify({ ...v2, sheets: [] })],
      ["a row with fewer cells than headers", JSON.stringify({ ...v2, sheets: [{ ...v2.sheets[0], rows: [{ ...v2.sheets[0].rows[0], cells: ["x"] }] }] })],
      ["cells that are not text", JSON.stringify({ ...v2, sheets: [{ ...v2.sheets[0], rows: [{ ...v2.sheets[0].rows[0], cells: v2.sheets[0].headers.map(() => 7) }] }] })],
    ];
    for (const [label, body] of bad) {
      state.client = clientWith({ ...objects, [`${MISSION}/${versionPathOf(2)}`]: body });
      const res = await download(versionQuery(2));
      expect(res.status, label).toBe(500);
      expect(res.headers.get("Content-Type"), label).not.toBe(XLSX_TYPE);
      expect(res.headers.get("Content-Disposition"), label).toBeNull();
    }
    // the neighbour is not affected
    state.client = clientWith({ ...objects, [`${MISSION}/${versionPathOf(2)}`]: "{not json" });
    expect((await download(versionQuery(1))).status).toBe(200);
  }, 60_000);
});

describe("TEST 11, 12: flag off, and the ordinary download unchanged", () => {
  it("flag off (unset, empty, off, test, any other word): a version request is 404 before anyone is asked who they are; nothing is served", async () => {
    state.client = clientWith(objects);
    for (const v of ["", "off", "test", "yes", "true", "1"]) {
      vi.stubEnv("DIGER_STAGE4_VERSIONS", v);
      state.viewerCalls = 0;
      const res = await download(versionQuery(1));
      expect(res.status, v).toBe(404);
      expect(res.headers.get("Content-Disposition")).toBeNull();
      expect(state.viewerCalls).toBe(0);
    }
    vi.unstubAllEnvs();
    expect((await download(versionQuery(1))).status).toBe(404);
  });
  it("without `version` the route answers the same with the flag off and on: the two-minute link, and the file itself with stream=1", async () => {
    const fetchSpy = vi.fn(async () => new Response(Buffer.from("PK-original"), { status: 200, headers: { "content-length": "11" } }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const seen: Array<{ link: unknown; streamed: string; type: string | null }> = [];
      for (const flag of ["", "on"]) {
        vi.stubEnv("DIGER_STAGE4_VERSIONS", flag);
        state.client = clientWith(objects);
        const link = await (await download("name=result.xlsx")).json();
        const streamed = await download("name=result.xlsx&stream=1");
        seen.push({ link, streamed: (await bytesOf(streamed)).toString(), type: streamed.headers.get("Content-Type") });
      }
      expect(seen[0]).toEqual(seen[1]);
      expect(seen[0].link).toMatchObject({ success: true });
      expect(String((seen[0].link as any).url)).toContain(`${MISSION}/result/result.xlsx`);
      expect(seen[0].streamed).toBe("PK-original");
      expect(seen[0].type).toBe(XLSX_TYPE);
      // the old rules: a bad name is 400, a stranger's mission is 404
      expect((await download("name=other.xlsx")).status).toBe(400);
      expect((await download("name=result.xlsx", OTHER)).status).toBe(404);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("TEST 14: a download is not a financial operation", () => {
  it("no insert, update, upsert, delete, rpc, upload, remove or signed link for any version request, successful or not", async () => {
    const c = clientWith(objects); state.client = c;
    for (const q of [versionQuery(1), versionQuery(2), versionQuery(3), versionQuery(0), "name=result.csv&version=1&stream=1"]) await download(q);
    state.client = clientWith({ ...objects, [`${MISSION}/${versionPathOf(2)}`]: "{bad" }); await download(versionQuery(2));
    expect(c.writes).toEqual([]);
    expect(state.client.writes).toEqual([]);
  }, 60_000);
  it("the version code touches no money, price, ledger, wallet or settlement, and no write", () => {
    const code = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const src = code("../src/lib/agentMission/stage4/versionFile.ts");
    expect(src).not.toMatch(/\.(upload|insert|update|upsert|delete|remove|rpc|createSignedUrl)\(/);
    expect(src).not.toMatch(/quotes|price|ledger|charge|wallet|settle|reserve|release|points/i);
  });
});
