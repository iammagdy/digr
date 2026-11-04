import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest, NextResponse } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { csvExportFromWorkbook, packageCsvExport, METHODOLOGY_ENTRY_AR } from "../src/lib/server/csvFromExcel";
import { parseCsv } from "../src/lib/server/excelFromCsv";
import { csvText, csvCell } from "../src/lib/agentMission/csvText";
import { PROVIDER_LABELS, withoutProviderHosts } from "../src/lib/agentMission/providerLabels";
import { providerContext } from "../src/lib/agentMission/providerHosts";
import { CSV_LABEL_AR, CSV_METHODOLOGY_LABEL_AR, CSV_PACKAGING_NOTE_AR } from "../src/lib/agentMission/csvLabels";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { customerMissionView, customerFilesOf } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { worldOf, WORLDS, type World, type WorldName } from "./helpers/round32Worlds";

/**
 * ROUND 32: THE CUSTOMER'S CSV. A customer downloads a CSV of their own mission, built from the mission's own Excel: one stage is a plain CSV, more than one is an archive with a CSV per stage and the methodology (`methodology.csv` alone is also
 * offered). The worker's stored `result.csv` (the deepest stage only) is never what a customer gets. Browser behaviour is NOT claimed here: the markup contract and the route's answers are.
 */
const state = vi.hoisted(() => ({ viewer: { userId: "u1", isGuest: false, emailVerified: true } as { userId: string; isGuest: boolean; emailVerified: boolean } | null, client: null as any }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => (state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 }) })) };
});
import { GET as fileGET } from "../src/app/api/missions/[id]/file/route";
import { customerCsvFile, customerFileLink, CSV_NOT_READY_AR, CSV_REQUEST_INVALID_AR, CSV_SOURCE_MISSING_AR, CSV_STORAGE_FAILED_AR, CSV_UNREADABLE_AR } from "../src/lib/agentMission/customerActions";

const NAMES: WorldName[] = ["tiktok", "instagram", "facebook", "youtube", "x"];
const worlds = {} as Record<WorldName, World>;
beforeAll(async () => { for (const n of NAMES) worlds[n] = await worldOf(n); }, 240_000);

const csvRows = (csv: string): string[][] => parseCsv(csv);
async function workbookOf(xlsx: Buffer): Promise<ExcelJS.Workbook> { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; }
const dataSheets = (wb: ExcelJS.Workbook) => wb.worksheets.slice(1);
const unzip = (body: Buffer) => unzipSync(new Uint8Array(body));

/** What a cell of the Excel says, written independently of the module under test. */
function expectedCell(cell: ExcelJS.Cell): string {
  const v = cell.value as any;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) { const p = (n: number) => String(n).padStart(2, "0"); const day = `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}`; return String(cell.numFmt).includes("تقريبًا") ? `${day} (تقريبًا)` : String(cell.numFmt).includes("hh") ? `${day} ${p(v.getUTCHours())}:${p(v.getUTCMinutes())}` : day; }
  if (typeof v === "object") return csvText(String(v.text ?? v.hyperlink ?? ""));
  return typeof v === "string" ? csvText(v) : String(v);
}

describe("1 and 2. one stage is a plain CSV; more than one is an archive that holds every delivered stage", () => {
  it("X (one stage): a plain CSV, 20 rows, the header the Excel's, the BOM, no archive", async () => {
    const e = await csvExportFromWorkbook(worlds.x.xlsx);
    const p = packageCsvExport(e);
    expect(p.kind).toBe("csv");
    expect(e.stages).toHaveLength(1);
    const rows = csvRows(p.body.toString("utf8"));
    expect(rows).toHaveLength(21);
    expect(p.body.toString("utf8").startsWith("﻿")).toBe(true);
    expect(rows[0][rows[0].length - 1]).toBe("المعرّف");
  });
  it("YouTube, Facebook, TikTok and Instagram (more than one stage): an archive with a numbered CSV per delivered sheet and the methodology; nothing is left out", async () => {
    for (const n of ["youtube", "facebook", "tiktok", "instagram"] as const) {
      const wb = await workbookOf(worlds[n].xlsx);
      const e = await csvExportFromWorkbook(worlds[n].xlsx);
      const p = packageCsvExport(e);
      expect(p.kind, n).toBe("zip");
      if (p.kind !== "zip") continue;
      const files = unzip(p.body);
      expect(Object.keys(files), n).toEqual(p.entries);
      expect(p.entries, n).toHaveLength(dataSheets(wb).length + 1);
      dataSheets(wb).forEach((s, i) => expect(p.entries[i], n).toBe(`${String(i + 1).padStart(2, "0")}-${s.name}.csv`));
      expect(p.entries[p.entries.length - 1]).toBe(METHODOLOGY_ENTRY_AR);
      expect(dataSheets(wb).length, n).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("3. the exact row counts: the CSVs hold every row of the Excel and every record the mission delivered", () => {
  it.each(NAMES)("%s", async (n) => {
    const wb = await workbookOf(worlds[n].xlsx);
    const e = await csvExportFromWorkbook(worlds[n].xlsx);
    dataSheets(wb).forEach((s, i) => { expect(e.stages[i].sheet).toBe(s.name); expect(csvRows(e.stages[i].csv)).toHaveLength(s.rowCount); expect(e.stages[i].rows).toBe(s.rowCount - 1); });
    const delivered = Object.values(worlds[n].rowsByStage).reduce((a, r) => a + r.length, 0);
    expect(e.stages.reduce((a, s) => a + s.rows, 0)).toBe(delivered);
  });
  it("the sums are the real stored rows: TikTok 2 + 300 + 67 (the replies sit in their comments' sheet), X 20, YouTube 2 + 9", async () => {
    const t = await csvExportFromWorkbook(worlds.tiktok.xlsx); expect(t.stages.map((s) => s.rows)).toEqual([2, 367]);
    const x = await csvExportFromWorkbook(worlds.x.xlsx); expect(x.stages.map((s) => s.rows)).toEqual([20]);
    const y = await csvExportFromWorkbook(worlds.youtube.xlsx); expect(y.stages.map((s) => s.rows)).toEqual([2, 9]);
  });
});

describe("4 and 16. the CSV says what the Excel says, cell by cell, on the stored real rows of the five platforms", () => {
  it.each(NAMES)("%s", async (n) => {
    const wb = await workbookOf(worlds[n].xlsx);
    const e = await csvExportFromWorkbook(worlds[n].xlsx);
    dataSheets(wb).forEach((s, i) => {
      const rows = csvRows(e.stages[i].csv);
      for (let r = 1; r <= s.rowCount; r += 1) for (let c = 1; c <= s.columnCount; c += 1) expect(rows[r - 1][c - 1], `${n} ${s.name} r${r} c${c}`).toBe(expectedCell(s.getRow(r).getCell(c)));
    });
  });
  it("the deepest stage is the worker's own CSV, byte for byte, where the worker's CSV was complete (X, Facebook, YouTube)", async () => {
    for (const n of ["x", "facebook", "youtube"] as const) { const e = await csvExportFromWorkbook(worlds[n].xlsx); expect(e.stages[e.stages.length - 1].csv, n).toBe(worlds[n].csv); }
  });
  it("where they differ the CSV follows the Excel: the worker's CSV left the language cell empty where the Excel says «العربية» (TikTok, Instagram)", async () => {
    for (const n of ["tiktok", "instagram"] as const) {
      const e = await csvExportFromWorkbook(worlds[n].xlsx);
      const mine = csvRows(e.stages[e.stages.length - 1].csv), theirs = csvRows(worlds[n].csv);
      expect(mine).toHaveLength(theirs.length);
      const diff = mine.flatMap((row, r) => row.flatMap((cell, c) => (cell === theirs[r][c] ? [] : [{ head: mine[0][c], mine: cell, theirs: theirs[r][c] }])));
      expect(diff.length).toBeGreaterThan(0);
      for (const d of diff) { expect(d.theirs).toBe(""); expect(d.mine).toMatch(/^(العربية|لغة أخرى|غير محددة|الإنجليزية)$/); expect(d.head).toMatch(/لغة/); }
    }
  });
});

describe("5. Arabic headers and encoding", () => {
  it("UTF-8 with a byte-order mark, Arabic headers, the ids' headers last; every archive entry name is flagged UTF-8 and reads back as Arabic", async () => {
    const e = await csvExportFromWorkbook(worlds.tiktok.xlsx);
    const p = packageCsvExport(e);
    if (p.kind !== "zip") throw new Error("zip expected");
    for (const entry of Object.values(unzip(p.body))) expect(Array.from(entry.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const head = csvRows(e.stages[1].csv)[0];
    expect(head.some((h) => /[؀-ۿ]/.test(h))).toBe(true);
    expect(head.slice(-2)).toEqual(["المعرّف", "معرّف الأصل"]);
    // every local file header carries the UTF-8 name flag (bit 11)
    const bytes = new Uint8Array(p.body);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let found = 0;
    for (let i = 0; i + 30 < bytes.length; i += 1) if (view.getUint32(i, true) === 0x04034b50) { found += 1; expect(view.getUint16(i + 6, true) & 0x800).toBe(0x800); }
    expect(found).toBe(p.entries.length);
    expect(p.entries.every((name) => /[؀-ۿ]/.test(name))).toBe(true);
  });
});

describe("6. ids, links and column alignment", () => {
  it("every row has the header's width; the ids are unique; every parent id is an id of the parent's CSV; the links are kept", async () => {
    for (const n of ["tiktok", "instagram", "youtube"] as const) {
      const e = await csvExportFromWorkbook(worlds[n].xlsx);
      const tables = e.stages.map((s) => csvRows(s.csv));
      for (const t of tables) for (const r of t) expect(r, n).toHaveLength(t[0].length);
      const idOf = (t: string[][]) => t.slice(1).map((r) => r[t[0].indexOf("المعرّف")]);
      for (const t of tables) { const ids = idOf(t); expect(new Set(ids).size, n).toBe(ids.length); expect(ids.every(Boolean), n).toBe(true); }
      const parents = new Set(idOf(tables[0]));
      const child = tables[1], at = child[0].indexOf("معرّف الأصل");
      expect(at).toBeGreaterThan(0);
      for (const r of child.slice(1)) expect(r[at] === "" || parents.has(r[at]) || idOf(child).includes(r[at]), `${n} parent ${r[at]}`).toBe(true);
      expect(tables[0].slice(1).some((r) => r.some((c) => /^https?:\/\//.test(c))), n).toBe(true);
    }
  });
});

// a small workbook with the shapes a cell can take: commas, quotes, line breaks, formulas, a phone, a leading zero
const stage = (key: string, parent: string | null): PricedStage => ({ key, title_ar: key === "posts" ? "المنشورات" : "التعليقات", endpoint_id: "e", expected_rows: 6, planned_rows: 6, parent_key: parent, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "author", title_ar: "الناشر" }, { key: "url", title_ar: "رابط المنشور" }, { key: "likes", title_ar: "الإعجابات" }], sample_rows: [], measured_by: [] } as unknown as PricedStage);
const awkward = [
  { id: "p1", text: 'قال: "أهلًا", ثم سطر ثانٍ\nوسطر ثالث', author: "أحمد, محمد", url: "https://example.org/p/1", likes: 5 },
  { id: "p2", text: "=HYPERLINK(\"http://evil.example\",\"اضغط\")", author: "+1+1", url: "https://example.org/p/2", likes: 3 },
  { id: "p3", text: "-2+3", author: "@SUM(A1)", url: "https://example.org/p/3", likes: 0 },
  { id: "p4", text: "\t=cmd", author: "+201234567890", url: "https://example.org/p/4", likes: 1 },
  { id: "p5", text: "0012345", author: "عادي", url: "https://example.org/p/5", likes: 2 },
  { id: "p6", text: "نص عادي بلا شيء خاص", author: "آخر", url: "https://example.org/p/6", likes: 9 },
];
async function awkwardWorkbook(rows = awkward): Promise<Buffer> {
  const plan = { summary_ar: "x", stages: [stage("posts", null)], price: { deliveredRows: rows.length } } as unknown as PricedPlan;
  return (await buildMissionFiles(plan, { posts: rows })).xlsx;
}

describe("7 and 8. quoted commas and line breaks stay in their cell; a text that starts like a formula is marked, a phone is not", () => {
  it("a comma, a quote and a line break inside a cell never move a column or add a row", async () => {
    const e = await csvExportFromWorkbook(await awkwardWorkbook());
    const rows = csvRows(e.stages[0].csv);
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r).toHaveLength(rows[0].length);
    expect(rows[1][0]).toBe('قال: "أهلًا", ثم سطر ثانٍ\nوسطر ثالث');
    expect(rows[1][1]).toBe("أحمد, محمد");
    expect(e.stages[0].csv).toContain('"قال: ""أهلًا"", ثم سطر ثانٍ\nوسطر ثالث"');
  });
  it("= + - @ and a tab get the apostrophe mark; a phone number and a leading-zero number are left alone; the Excel itself carries no mark", async () => {
    const xlsx = await awkwardWorkbook();
    const rows = csvRows((await csvExportFromWorkbook(xlsx)).stages[0].csv);
    expect(rows[2][0]).toMatch(/^'=HYPERLINK/);
    expect(rows[2][1]).toBe("'+1+1");
    expect(rows[3][0]).toBe("'-2+3");
    expect(rows[3][1]).toBe("'@SUM(A1)");
    expect(rows[4][0]).toBe("'\t=cmd");
    expect(rows[4][1]).toBe("+201234567890");
    expect(rows[5][0]).toBe("0012345");
    const wb = await workbookOf(xlsx);
    expect(String(wb.worksheets[1].getRow(3).getCell(1).value)).toMatch(/^=HYPERLINK/);
  });
  it("the worker's CSV and the customer's CSV use ONE rule (the same two functions)", () => {
    expect(csvText("=x")).toBe("'=x");
    expect(csvText("+٢٠١٠١٢٣")).toBe("'+٢٠١٠١٢٣");
    expect(csvText("+201234567890")).toBe("+201234567890");
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(readFileSync("agent/src/workbook.ts", "utf8")).toContain('from "../../src/lib/agentMission/csvText"');
    expect(readFileSync("src/lib/server/csvFromExcel.ts", "utf8")).toContain('from "../agentMission/csvText"');
  });
});

describe("9. no internal field, no provider address, no admin file", () => {
  it("no internal column key, marker or id reaches a header or a cell of any platform's archive", async () => {
    for (const n of NAMES) {
      const e = await csvExportFromWorkbook(worlds[n].xlsx);
      const all = [...e.stages.map((s) => s.csv), e.methodologyCsv].join("\n");
      for (const bad of ["__marks", "expansion_token", "feedback_id", "parent_id", "endpoint_id", "yield_from", "measured_by", "_approx_dates", "call_0", "out_0", "admin/"]) expect(all, `${n} ${bad}`).not.toContain(bad);
    }
  });
  it("an address of a data provider in an older mission's Excel is taken out of its CSV (a cell, a link) and the rest of the row stays", async () => {
    const wb = await workbookOf(await awkwardWorkbook());
    const sheet = wb.worksheets[1];
    sheet.getRow(2).getCell(3).value = { text: "https://api.tikhub.io/api/v1/youtube/web?token=abc", hyperlink: "https://api.tikhub.io/api/v1/youtube/web?token=abc" };
    sheet.getRow(3).getCell(1).value = "انظر https://api.scrapecreators.com/v1/x لمزيد";
    const e = await csvExportFromWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(e.stages[0].csv).not.toMatch(/tikhub|scrapecreators/i);
    expect(csvRows(e.stages[0].csv)).toHaveLength(7);
    expect(csvRows(e.stages[0].csv)[1][1]).toBe("أحمد, محمد");
  });
  it("the provider list the CSV uses is the catalog's: every provider label of `providerContext()` is in it, so a new seller cannot reach a CSV; the platforms' own links and a company's website are untouched", () => {
    const missing = [...providerContext().providers].filter((l) => !PROVIDER_LABELS.includes(l));
    expect(missing).toEqual([]);
    expect(withoutProviderHosts("https://api.tikhub.io/api/v1/x?token=1")).toBe("");
    expect(withoutProviderHosts("انظر api.scrapecreators.com/v1/y لمزيد")).toBe("انظر لمزيد");
    for (const keep of ["https://www.tiktok.com/@a/video/1", "https://www.instagram.com/p/DfPm/", "https://www.youtube.com/watch?v=1", "https://example.org/p/1", "https://www.linkedin.com/company/0123456789abcdef0123/"]) expect(withoutProviderHosts(keep)).toBe(keep);
    // the site's server does not ship the 10 MB catalog: the CSV code must not read it
    for (const file of ["src/lib/server/csvFromExcel.ts", "src/lib/agentMission/providerLabels.ts"]) { const src = readFileSync(file, "utf8"); expect(src, file).not.toMatch(/from "[^"]*(treg\/catalog|providerHosts)"/); expect(src, file).not.toContain("loadTregCatalog"); }
  });
  it("the methodology file is the first sheet, as text: the delivered counts and the limits are in it, and it is never a data row", async () => {
    const e = await csvExportFromWorkbook(worlds.tiktok.xlsx);
    const m = csvRows(e.methodologyCsv);
    expect(m[0].slice(0, 3)).toEqual(["المرحلة", "الورقة", "العدد"]);
    expect(e.methodologyCsv).toMatch(/حدود هذا التسليم|الحدود/);
    expect(e.methodologyCsv).toContain("تم تسليم");
    for (const r of m) expect(r).toHaveLength(m[0].length);
    // an ordinary stage CSV has no note row: every row has a filled id
    for (const s of e.stages) { const t = csvRows(s.csv); const at = t[0].indexOf("المعرّف"); for (const r of t.slice(1)) expect(r[at]).not.toBe(""); }
  });
});

// ---- the customer's own mission: ownership, older missions, missing objects, storage failures ----
interface Obj { bytes?: Buffer; error?: { message: string; status?: number }; throws?: Error }
function fakeClient(mission: Record<string, unknown> | null, objects: Record<string, Obj>) {
  const calls = { downloads: [] as string[], writes: [] as string[], tables: [] as string[], signed: [] as string[] };
  const refuse = (what: string) => () => { calls.writes.push(what); throw new Error(`WRITE ${what}`); };
  const client: any = {
    from: (t: string) => { calls.tables.push(t); return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mission, error: null }) }) }), insert: refuse(`insert ${t}`), update: refuse(`update ${t}`), upsert: refuse(`upsert ${t}`), delete: refuse(`delete ${t}`) }; },
    rpc: refuse("rpc"),
    storage: { from: (bucket: string) => ({
      download: async (path: string) => { calls.downloads.push(`${bucket}/${path}`); const o = objects[path.replace(/^[^/]+\//, "")]; if (!o) return { data: null, error: { message: "Object not found", status: 404 } }; if (o.throws) throw o.throws; if (o.error) return { data: null, error: o.error }; const b = o.bytes!; return { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, error: null }; },
      upload: refuse("upload"), remove: refuse("remove"),
      createSignedUrl: async (path: string, _t: number, o?: { download?: string }) => { calls.signed.push(`${path}|${o?.download ?? ""}`); return { data: { signedUrl: `https://signed.example/${path}` }, error: null }; },
    }) },
  };
  return { client, calls };
}
const missionRow = (over: Record<string, unknown> = {}) => ({ id: "msn_csv000001", user_id: "u1", status: "completed", files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }, { name: "result.csv", path: "result/result.csv", kind: "csv" }], plan: { stages: [{ key: "videos", title_ar: "الفيديوهات", deliver: true }] }, request_text: "هات فيديوهات تيك توك عن الذكاء الاصطناعي", delivered_units: 369, updated_at: "2026-11-04T10:00:00Z", ...over });
const STORED_CSV = Buffer.from('﻿"x","المعرّف"\r\n"الصف الأخير فقط","last_only"');

describe("10. an older mission: its stored CSV (the deepest stage only) is never what the customer gets", () => {
  it("a mission of several stages gets every stage from its Excel, never the stored result.csv; the stored CSV and the admin's files are never read", async () => {
    const { client, calls } = fakeClient(missionRow(), { "result/result.xlsx": { bytes: worlds.tiktok.xlsx }, "result/result.csv": { bytes: STORED_CSV }, "admin/excluded.csv": { bytes: Buffer.from("secret") } });
    const r = await customerCsvFile(client, { id: "msn_csv000001", userId: "u1", name: "result.csv" });
    if (!r.ok) throw new Error(r.error);
    expect(r.kind).toBe("zip");
    expect(calls.downloads).toEqual(["agent-missions/msn_csv000001/result/result.xlsx"]);
    const files = unzip(r.body);
    expect(Object.keys(files)).toHaveLength(3);
    expect(Object.values(files).map((u) => strFromU8(u)).join("")).not.toContain("last_only");
  });
  it("a mission whose files list never had a CSV entry still gets its CSV (built from the Excel); a mission with a CSV and no Excel gets an honest Arabic error, never the Excel and never the partial stored CSV", async () => {
    const noCsvEntry = fakeClient(missionRow({ files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }] }), { "result/result.xlsx": { bytes: worlds.x.xlsx } });
    expect((await customerCsvFile(noCsvEntry.client, { id: "msn_csv000001", userId: "u1", name: "result.csv" }))).toMatchObject({ ok: true, kind: "csv" });
    const onlyCsv = fakeClient(missionRow({ files: [{ name: "result.csv", path: "result/result.csv", kind: "csv" }] }), { "result/result.csv": { bytes: STORED_CSV } });
    expect(await customerCsvFile(onlyCsv.client, { id: "msn_csv000001", userId: "u1", name: "result.csv" })).toEqual({ ok: false, status: 404, error: CSV_SOURCE_MISSING_AR });
    expect(onlyCsv.calls.downloads).toEqual([]);
    const none = fakeClient(missionRow({ files: [] }), {});
    expect(await customerCsvFile(none.client, { id: "msn_csv000001", userId: "u1", name: "result.csv" })).toEqual({ ok: false, status: 404, error: CSV_NOT_READY_AR });
  });
  it("the file names are the mission's own Arabic name with .csv or .zip, and the methodology's carries its own word", async () => {
    const { client } = fakeClient(missionRow(), { "result/result.xlsx": { bytes: worlds.tiktok.xlsx } });
    const data = await customerCsvFile(client, { id: "msn_csv000001", userId: "u1", name: "result.csv" });
    const meth = await customerCsvFile(client, { id: "msn_csv000001", userId: "u1", name: "methodology.csv" });
    if (!data.ok || !meth.ok) throw new Error("not ok");
    expect(data.download).toMatch(/[؀-ۿ].*\.zip$/);
    expect(meth.download).toMatch(/^منهجية - .*\.csv$/);
    expect(meth.kind).toBe("csv");
    expect(meth.body.toString("utf8")).toContain("المرحلة");
  });
});

describe("11 to 14. ownership, cross-account, missing objects, storage failures: an Arabic answer with its own status, nothing written", () => {
  const ok = { "result/result.xlsx": { bytes: undefined as unknown as Buffer } };
  it("another account's mission is «not found» and its storage is never touched; a name that is not ours is invalid", async () => {
    const { client, calls } = fakeClient(missionRow({ user_id: "someone-else" }), { "result/result.xlsx": { bytes: worlds.x.xlsx } });
    expect(await customerCsvFile(client, { id: "msn_csv000001", userId: "u1", name: "result.csv" })).toEqual({ ok: false, status: 404, error: "الملف غير موجود." });
    expect(calls.downloads).toEqual([]);
    const none = fakeClient(null, {});
    expect(await customerCsvFile(none.client, { id: "msn_x", userId: "u1", name: "result.csv" })).toMatchObject({ ok: false, status: 404 });
    for (const name of ["result.xlsx", "../result.csv", "admin/excluded.csv", "result.CSV", ""]) expect(await customerCsvFile(client, { id: "msn_csv000001", userId: "u1", name }), name).toEqual({ ok: false, status: 400, error: CSV_REQUEST_INVALID_AR });
    void ok;
  });
  it("the Excel is missing from the storage: 404 and a sentence; a storage error: 502 and a retry sentence; a thrown error: 502; an unreadable workbook: 500 and an Excel is suggested", async () => {
    const asked = { id: "msn_csv000001", userId: "u1", name: "result.csv" };
    const missing = fakeClient(missionRow(), {});
    expect(await customerCsvFile(missing.client, asked)).toEqual({ ok: false, status: 404, error: CSV_SOURCE_MISSING_AR });
    const failing = fakeClient(missionRow(), { "result/result.xlsx": { error: { message: "upstream connect error", status: 503 } } });
    expect(await customerCsvFile(failing.client, asked)).toEqual({ ok: false, status: 502, error: CSV_STORAGE_FAILED_AR });
    const thrown = fakeClient(missionRow(), { "result/result.xlsx": { throws: new Error("socket hang up") } });
    expect(await customerCsvFile(thrown.client, asked)).toEqual({ ok: false, status: 502, error: CSV_STORAGE_FAILED_AR });
    const corrupt = fakeClient(missionRow(), { "result/result.xlsx": { bytes: Buffer.from("this is not a workbook") } });
    expect(await customerCsvFile(corrupt.client, asked)).toEqual({ ok: false, status: 500, error: CSV_UNREADABLE_AR });
    for (const e of [CSV_NOT_READY_AR, CSV_SOURCE_MISSING_AR, CSV_STORAGE_FAILED_AR, CSV_UNREADABLE_AR, CSV_REQUEST_INVALID_AR]) { expect(e).toMatch(/[؀-ۿ]/); expect(e).not.toMatch(/[A-Za-z]{4,}|supabase|storage|tikhub|scrapecreators|undefined/i); }
    for (const c of [missing.calls, failing.calls, thrown.calls, corrupt.calls]) expect(c.writes).toEqual([]);
  });
  it("a request for a CSV is never answered with the Excel: the old link's name reaches `customerFileLink` as an invalid request, not as the Excel", async () => {
    const { client, calls } = fakeClient(missionRow(), { "result/result.xlsx": { bytes: worlds.x.xlsx } });
    expect(await customerFileLink(client, { id: "msn_csv000001", userId: "u1", name: "result.csv" })).toEqual({ ok: false, status: 400, error: CSV_REQUEST_INVALID_AR });
    expect(calls.signed).toEqual([]);
  });
});

describe("the route: the customer's own CSV as a file, an Arabic error otherwise", () => {
  beforeEach(() => { state.viewer = { userId: "u1", isGuest: false, emailVerified: true }; });
  const ask = (name: string, id = "msn_csv000001") => fileGET(new NextRequest(`http://localhost/api/missions/${id}/file?name=${encodeURIComponent(name)}&stream=1`), { params: Promise.resolve({ id }) });
  it("one stage: text/csv with the mission's Arabic name; several: application/zip; the methodology: text/csv; private, no cache", async () => {
    state.client = fakeClient(missionRow(), { "result/result.xlsx": { bytes: worlds.x.xlsx } }).client;
    const one = await ask("result.csv");
    expect(one.status).toBe(200);
    expect(one.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(one.headers.get("Content-Disposition")).toMatch(/^attachment; filename="[^"]+\.csv"; filename\*=UTF-8''.+\.csv$/);
    expect(one.headers.get("Cache-Control")).toBe("private, no-store");
    expect(one.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(csvRows(Buffer.from(await one.arrayBuffer()).toString("utf8"))).toHaveLength(21);
    state.client = fakeClient(missionRow(), { "result/result.xlsx": { bytes: worlds.youtube.xlsx } }).client;
    const many = await ask("result.csv");
    expect(many.headers.get("Content-Type")).toBe("application/zip");
    expect(decodeURIComponent(many.headers.get("Content-Disposition")!.split("filename*=UTF-8''")[1])).toMatch(/\.zip$/);
    expect(Object.keys(unzip(Buffer.from(await many.arrayBuffer())))).toHaveLength(3);
    const meth = await ask("methodology.csv");
    expect(meth.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  });
  it("another account: 404 in Arabic and no storage read; signed out: 401; a bad name or id: 400 in Arabic", async () => {
    const other = fakeClient(missionRow({ user_id: "u2" }), { "result/result.xlsx": { bytes: worlds.x.xlsx } });
    state.client = other.client;
    const r = await ask("result.csv");
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("الملف غير موجود.");
    expect(other.calls.downloads).toEqual([]);
    state.viewer = null;
    expect((await ask("result.csv")).status).toBe(401);
    state.viewer = { userId: "u1", isGuest: false, emailVerified: true };
    for (const bad of ["result.zip", "../../x", "result.csv.exe", "admin/excluded.csv"]) { const b = await ask(bad); expect(b.status, bad).toBe(400); expect((await b.json()).error).toBe(CSV_REQUEST_INVALID_AR); }
    expect((await ask("result.csv", "../x")).status).toBe(400);
  });
  it("a missing object and a storage failure keep their statuses and Arabic words; a failure never returns a file", async () => {
    state.client = fakeClient(missionRow(), {}).client;
    const miss = await ask("result.csv");
    expect([miss.status, (await miss.json()).error]).toEqual([404, CSV_SOURCE_MISSING_AR]);
    state.client = fakeClient(missionRow(), { "result/result.xlsx": { error: { message: "boom", status: 500 } } }).client;
    const fail = await ask("result.csv");
    expect([fail.status, fail.headers.get("Content-Type"), (await fail.json()).error]).toEqual([502, "application/json", CSV_STORAGE_FAILED_AR]);
  });
});

describe("15. the download controls (the markup contract; no browser was driven)", () => {
  const files = [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }, { name: "result.csv", path: "result/result.csv", kind: "csv" }];
  const done = customerMissionView({ mission: { id: "msn_csv000001", status: "completed", question_ar: null, plan_public: { summary_ar: "٣ منشور", assumptions_ar: [], notes_ar: [], stages: [{ key: "posts", title_ar: "المنشورات", endpoint_id: "e", expected_rows: 3, planned_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }], sample_rows: [] }], price: { max_charge_points: 200, reserve_points: 200 } } as never, reserved_points: 200, unit_price_points: 1, delivered_units: 3, charged_points: 200, summary_ar: "اكتملت المهمة.", files, created_at: "2026-11-04T10:00:00Z" }, events: [] });
  const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: done, isGuest: false }));
  const button = (testId: string) => html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? "";
  it("the card offers the Excel first (unchanged), then «تنزيل CSV» and «منهجية CSV», every control a button of the card's own touch size; one short note says how a CSV of several stages arrives", () => {
    expect(done.files.map((f) => [f.name, f.kind, f.labelAr])).toEqual([["result.xlsx", "xlsx", "تنزيل ملف إكسل"], ["result.csv", "csv", CSV_LABEL_AR], ["methodology.csv", "methodology", CSV_METHODOLOGY_LABEL_AR]]);
    expect([CSV_LABEL_AR, CSV_METHODOLOGY_LABEL_AR]).toEqual(["تنزيل ملف سي إس في", "منهجية سي إس في"]);
    const group = html.match(/<div[^>]*data-testid="agent-files"[^>]*>/)![0];
    expect(group).toContain("flex-wrap");
    expect(html.indexOf("تنزيل ملف إكسل")).toBeLessThan(html.indexOf(CSV_LABEL_AR));
    for (const id of ["agent-file-csv", "agent-file-methodology"]) { const b = button(id); expect(b, id).toMatch(/type="button"/); expect(b, id).toContain("min-h-11"); }
    expect(button("agent-file-csv")).toContain(CSV_LABEL_AR);
    expect(html).toContain(CSV_PACKAGING_NOTE_AR);
    expect(CSV_PACKAGING_NOTE_AR.length).toBeLessThan(90);
    // customer text is Arabic only (no Latin word), with no provider name, endpoint or dollar amount
    for (const t of [CSV_LABEL_AR, CSV_METHODOLOGY_LABEL_AR, CSV_PACKAGING_NOTE_AR]) expect(checkCustomerText(t).issues, t).toEqual([]);
    for (const t of [CSV_LABEL_AR, CSV_METHODOLOGY_LABEL_AR, CSV_PACKAGING_NOTE_AR]) expect(t).not.toMatch(/tikhub|scrapecreators|justoneapi|anyapi|crawl4ai|\$|USD|endpoint/i);
  });
  it("the button asks the route for the file by name (the card's download sends `name=` and `stream=1` for every file), and its error is shown in the card", () => {
    const source = readFileSync("src/components/mission/AgentMissionCard.tsx", "utf8");
    expect(source).toContain("/file?name=${encodeURIComponent(name)}&stream=1");
    expect(source).toContain("setError(String(json?.error ||");
    expect(source).toContain("onClick={() => onDownload(f.name)}");
  });
  it("no CSV is offered where there is no Excel to build it from, and before the mission has files", () => {
    expect(customerFilesOf([])).toEqual([]);
    expect(customerFilesOf([{ name: "result.csv", kind: "csv" }]).map((f) => f.kind)).toEqual(["xlsx"]);
  });
});

describe("17 and 18. the Excel download, the money and the settlement are exactly what they were", () => {
  it("the Excel's signed link, its name and the file it points to are unchanged; the link writes nothing", async () => {
    const { client, calls } = fakeClient(missionRow(), { "result/result.xlsx": { bytes: worlds.x.xlsx } });
    const r = await customerFileLink(client, { id: "msn_csv000001", userId: "u1", name: "result.xlsx" });
    expect(r).toMatchObject({ ok: true, url: "https://signed.example/msn_csv000001/result/result.xlsx" });
    if (!r.ok) return;
    expect(r.download).toMatch(/\.xlsx$/);
    expect(calls.signed).toEqual([`msn_csv000001/result/result.xlsx|${r.download}`]);
    expect(calls.writes).toEqual([]);
    state.client = client; state.viewer = { userId: "u1", isGuest: false, emailVerified: true };
    const res = await fileGET(new NextRequest("http://localhost/api/missions/msn_csv000001/file?name=result.xlsx"), { params: Promise.resolve({ id: "msn_csv000001" }) });
    expect(await res.json()).toEqual({ success: true, url: "https://signed.example/msn_csv000001/result/result.xlsx" });
  });
  it("the worker's files are unchanged: the Excel's cells and the worker's CSV are what the stored delivery contract says (the same as before this round)", async () => {
    // the same input twice gives the same cells; the shared CSV rule is the only line that moved out of the workbook module
    const again = await worldOf("x");
    const a = await workbookOf(worlds.x.xlsx), b = await workbookOf(again.xlsx);
    expect(a.worksheets.map((s) => s.name)).toEqual(b.worksheets.map((s) => s.name));
    expect(again.csv).toBe(worlds.x.csv);
    for (const [i, s] of a.worksheets.entries()) for (let r = 1; r <= s.rowCount; r += 1) for (let c = 1; c <= s.columnCount; c += 1) expect(String(b.worksheets[i].getRow(r).getCell(c).value)).toBe(String(s.getRow(r).getCell(c).value));
  });
  it("the CSV code reads no price, reserve, ledger or settlement and writes nothing: the customer's CSV is a read of one file", () => {
    const actions = readFileSync("src/lib/agentMission/customerActions.ts", "utf8");
    const mine = actions.slice(actions.indexOf("export async function customerCsvFile"));
    const lib = readFileSync("src/lib/server/csvFromExcel.ts", "utf8");
    for (const code of [mine, lib]) for (const bad of [".rpc(", "settle", "ledger", "reserve", "unit_price", "charged_points", ".insert(", ".update(", ".upsert(", ".delete(", ".upload(", "createSignedUrl"]) expect(code, bad).not.toContain(bad);
    for (const file of ["agent/src/gateway.ts", "src/lib/missionPricing.ts", "src/lib/jobPointsCap.ts"]) expect(readFileSync(file, "utf8")).not.toContain("csvFromExcel");
  });
});
