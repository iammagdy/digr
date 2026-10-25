import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  admin: true,
  reads: 0,
  writes: 0,
  failAfter: Infinity,
  data: {} as Record<string, any[]>,
}));

vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async (req: Request) => {
    const header = req.headers.get("authorization") || "";
    if (!header) return { ok: false, response: new Response(JSON.stringify({ error: "غير مصرح." }), { status: 401, headers: { "content-type": "application/json" } }) };
    if (!h.admin || header !== "Bearer admin") return { ok: false, response: new Response(JSON.stringify({ error: "ممنوع" }), { status: 403, headers: { "content-type": "application/json" } }) };
    return { ok: true, ctx: { adminId: "a1" } };
  }),
}));
vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: any = {
        select: () => q, order: () => q,
        range: async (from: number, to: number) => {
          h.reads += 1;
          if (h.reads > h.failAfter) return { data: null, error: { message: "connection to db-host.internal:5432 refused" }, count: null };
          const all = h.data[table] || [];
          return { data: all.slice(from, to + 1), error: null, count: all.length };
        },
        insert: () => { h.writes += 1; throw new Error("the export must never write"); },
        update: () => { h.writes += 1; throw new Error("the export must never write"); },
        upsert: () => { h.writes += 1; throw new Error("the export must never write"); },
        delete: () => { h.writes += 1; throw new Error("the export must never write"); },
      };
      return q;
    },
  }),
}));

import * as exportRoute from "../src/app/api/admin/export/route";
import * as zipRoute from "../src/app/api/admin/export/zip/route";
import { prepareBackupZip, ZIP_ERRORS_AR } from "../src/app/api/admin/export/zip/backupZip";
import { backupZipFileName, columnsOf, EXPORT_TABLES, exportFileName, rowsToCsv } from "../src/lib/adminExport";

const zipGet = (headers: Record<string, string> = {}) => zipRoute.GET(new NextRequest("http://x/api/admin/export/zip", { headers }));
const rowsOf = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}`, created_at: `2026-10-21T00:${String(i % 60).padStart(2, "0")}:00Z`, note: `سطر ${i}`, delta: i, ...extra }));

beforeEach(() => {
  h.admin = true; h.reads = 0; h.writes = 0; h.failAfter = Infinity;
  h.data = {
    credit_ledger: rowsOf(2500, { access_token: "SECRET-TOKEN-VALUE" }), // three pages
    topups: rowsOf(3, { note: '=HYPERLINK("http://evil.example","pay")' }),
    jobs: rowsOf(1000), // exactly one full page: the next page is empty
    plans_quotes: [{ id: "q1", created_at: "2026-10-21T00:00:00Z", params: { a: 1, "b,c": "x\"y" }, note: "@SUM(A1)" }],
    profiles: [],
  };
});

async function unzipOf(res: Response) {
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return files;
}

describe("the ZIP route is for administrators only and sends nothing otherwise", () => {
  it("signed out: 401, no-store, nothing is read and no table data is in the answer", async () => {
    const res = await zipGet();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.reads).toBe(0);
    const text = await res.text();
    expect(text).not.toMatch(/credit_ledger|SECRET|PK/);
  });
  it("a signed-in customer: 403, no-store, nothing is read", async () => {
    const res = await zipGet({ authorization: "Bearer customer" });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.reads).toBe(0);
    expect(res.headers.get("content-type")).not.toContain("zip");
  });
  it("only GET is exported", () => {
    expect(Object.keys(zipRoute).filter((name) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name))).toEqual(["GET"]);
  });
});

describe("an administrator gets ONE ZIP: five CSV files and a manifest", () => {
  it("headers: zip, an attachment named diger-backup-YYYY-MM-DD-HHmm.zip, never cached, nothing sniffed", async () => {
    const res = await zipGet({ authorization: "Bearer admin" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="diger-backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip"$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Number(res.headers.get("x-export-rows"))).toBe(2500 + 3 + 1000 + 1 + 0);
    await res.arrayBuffer();
  });

  it("the archive holds the five CSV files and manifest.json, and the manifest counts match the files", async () => {
    const files = await unzipOf(await zipGet({ authorization: "Bearer admin" }));
    const names = Object.keys(files);
    expect(names).toHaveLength(6);
    expect(names.filter((name) => name.endsWith(".csv")).sort()).toEqual(EXPORT_TABLES.map((t) => t.id).sort().map((id) => names.find((n) => n.includes(`-${id}-`))!).sort());
    expect(names[names.length - 1]).toBe("manifest.json"); // written last
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest.complete).toBe(true);
    expect(manifest.totalRows).toBe(3504);
    expect(manifest.files).toHaveLength(5);
    for (const entry of manifest.files) {
      const csv = strFromU8(files[entry.file]).replace(/^﻿/, "");
      const lines = entry.rows === 0 ? 1 : csv.split("\r\n").length; // a header line, then one line per row (no cell here holds a line break)
      expect(lines - 1, entry.table).toBe(entry.rows);
      expect(entry.rowsAtStart, entry.table).toBe(entry.rows);
      expect(entry.bytes).toBe(files[entry.file].length);
    }
    const byTable = Object.fromEntries(manifest.files.map((e: any) => [e.table, e.rows]));
    expect(byTable).toEqual({ credit_ledger: 2500, topups: 3, jobs: 1000, plans_quotes: 1, profiles: 0 });
    expect(manifest.files.find((e: any) => e.table === "credit_ledger").omittedColumns).toEqual(["access_token"]);
  });

  it("every CSV is byte-for-byte the file the page-by-page download writes (same reader, same serialisation, BOM included)", async () => {
    const files = await unzipOf(await zipGet({ authorization: "Bearer admin" }));
    for (const table of EXPORT_TABLES) {
      // what the browser does: read every page from the existing route, JSON as the network carries it, then rowsToCsv with a BOM
      const rows: Array<Record<string, unknown>> = [];
      for (let offset = 0; ; ) {
        const res = await exportRoute.GET(new NextRequest(`http://x/api/admin/export?table=${table.id}&offset=${offset}`, { headers: { authorization: "Bearer admin" } }));
        const page = JSON.parse(await res.text());
        rows.push(...page.rows);
        offset += page.rows.length;
        if (page.done || page.rows.length === 0) break;
      }
      const expected = new TextEncoder().encode("﻿" + rowsToCsv(rows, columnsOf(rows)));
      const name = Object.keys(files).find((n) => n.includes(`-${table.id}-`))!;
      expect(Buffer.from(files[name]).equals(Buffer.from(expected)), table.id).toBe(true);
      expect(Array.from(files[name].slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    }
  });

  it("formulas are defused exactly as in the individual export, and no secret value is anywhere in the archive", async () => {
    const files = await unzipOf(await zipGet({ authorization: "Bearer admin" }));
    const topups = strFromU8(files[Object.keys(files).find((n) => n.includes("-topups-"))!]);
    expect(topups).toContain(`"'=HYPERLINK(""http://evil.example"",""pay"")"`);
    const quotes = strFromU8(files[Object.keys(files).find((n) => n.includes("-plans_quotes-"))!]);
    expect(quotes).toContain(`"'@SUM(A1)"`);
    expect(quotes).toContain(`"{""a"":1,""b,c"":""x\\""y""}"`);
    const all = Object.values(files).map((f) => strFromU8(f)).join("\n");
    expect(all).not.toContain("SECRET-TOKEN-VALUE"); // no value anywhere, the manifest included
    const csvOnly = Object.entries(files).filter(([name]) => name.endsWith(".csv")).map(([, f]) => strFromU8(f)).join("\n");
    expect(csvOnly).not.toMatch(/access_token|service_role|Bearer/); // no secret column in any CSV; the manifest only NAMES the columns that were left out
  });

  it("the file names inside carry the table and the time, like the individual downloads", async () => {
    const at = new Date("2026-10-21T21:45:00Z");
    const prepared = await prepareBackupZip({ from: (t: string) => ({ select: () => ({ order: () => ({ order: () => ({ range: async () => ({ data: [], error: null, count: 0 }) }) }) }) }) }, { now: at });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      const files = unzipSync(new Uint8Array(await new Response(prepared.stream).arrayBuffer()));
      for (const table of EXPORT_TABLES) expect(Object.keys(files)).toContain(exportFileName(table.id, at, "csv"));
    }
  });

  it("the archive name is read in Cairo time (UTC+3 in October 2026, summer time ends the last Friday of October)", () => {
    expect(backupZipFileName(new Date("2026-10-21T21:45:00Z"))).toBe("diger-backup-2026-10-22-0045.zip");
    expect(backupZipFileName(new Date("2026-07-01T09:05:00Z"))).toBe("diger-backup-2026-07-01-1205.zip");
    expect(backupZipFileName(new Date("2026-12-31T23:59:00Z"))).toBe("diger-backup-2027-01-01-0159.zip");
  });
});

describe("limits: a clear Arabic refusal before anything is sent, and never a short file", () => {
  it("a table above the ceiling is refused with 413 and an Arabic message; no zip is started", async () => {
    const prepared = await prepareBackupZip({ from: () => ({ select: () => ({ order: () => ({ order: () => ({ range: async () => ({ data: rowsOf(10), error: null, count: 500 }) }) }) }) }) }, { maxRowsPerTable: 100 });
    expect(prepared).toEqual({ ok: false, status: 413, error: ZIP_ERRORS_AR.tooLarge });
    expect(ZIP_ERRORS_AR.tooLarge).toMatch(/[؀-ۿ]/);
    h.data.credit_ledger = rowsOf(50_001);
    const res = await zipGet({ authorization: "Bearer admin" });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error).toBe(ZIP_ERRORS_AR.tooLarge);
  });

  it("an unreadable first page is a plain Arabic 500 with no database message", async () => {
    h.failAfter = 0;
    const res = await zipGet({ authorization: "Bearer admin" });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain(ZIP_ERRORS_AR.unreadable);
    expect(text).not.toMatch(/db-host|5432|refused/);
  });

  it("a read that fails in the middle ERRORS the stream: the download fails as a whole, there is no half archive", async () => {
    h.failAfter = 6; // the five first pages succeed, the second page of the big table fails
    const res = await zipGet({ authorization: "Bearer admin" });
    expect(res.status).toBe(200); // the headers are already out when the failure comes; the body then breaks
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("past the time budget the stream errors too (an injected clock, no waiting)", async () => {
    let now = 0;
    const clock = () => now;
    const db = { from: (table: string) => { const q: any = { select: () => q, order: () => q, range: async (from: number, to: number) => { now += 30_000; const all = h.data[table] || []; return { data: all.slice(from, to + 1), error: null, count: all.length }; } }; return q; } };
    const prepared = await prepareBackupZip(db, { clock, budgetMs: 50_000 });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) await expect(new Response(prepared.stream).arrayBuffer()).rejects.toThrow();
  });

  it("a table that grows past the ceiling while it is read is not delivered short", async () => {
    let calls = 0;
    const big = rowsOf(1000);
    const db = { from: () => { const q: any = { select: () => q, order: () => q, range: async (from: number) => { calls += 1; return { data: from < 300 ? big : big, error: null, count: 90 }; } }; return q; } };
    const prepared = await prepareBackupZip(db, { maxRowsPerTable: 1500 });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) await expect(new Response(prepared.stream).arrayBuffer()).rejects.toThrow();
    expect(calls).toBeGreaterThan(5);
  });
});

describe("read only and quiet", () => {
  it("the route and its helpers contain no write call, no logging of rows, and the reads are SELECT only", async () => {
    await (await zipGet({ authorization: "Bearer admin" })).arrayBuffer();
    expect(h.writes).toBe(0);
    for (const file of ["src/app/api/admin/export/zip/route.ts", "src/app/api/admin/export/zip/backupZip.ts", "src/app/api/admin/export/exportRead.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\.(?:insert|update|upsert|delete|rpc)\(|\.from\("(?:credit_ledger|jobs|topups|plans_quotes|provider_costs)"\)\.(?!select)/);
      expect(source.match(/console\.\w+\(/g) ?? [], file).toEqual(file.endsWith("backupZip.ts") ? ['console.error('] : []);
    }
    expect(readFileSync("src/app/api/admin/export/zip/backupZip.ts", "utf8")).toContain('console.error("[admin-export-zip] aborted");');
  });
  it("the page offers the ZIP button next to the existing downloads, in Arabic", () => {
    const page = readFileSync("src/app/admin/export/page.tsx", "utf8");
    expect(page).toContain("تنزيل الكل (ZIP)");
    expect(page).toContain('data-testid="export-zip"');
    expect(page).toContain('adminDownload("/api/admin/export/zip"');
    expect(page).toContain('data-testid="export-all"'); // the five separate CSV downloads stay
    expect(page).toContain("ملف CSV");
    expect(page).toContain("ملف JSON");
    expect(page).not.toMatch(/\p{Extended_Pictographic}/u);
  });
  it("fflate is a direct dependency pinned to an exact version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies.fflate).toBe("0.8.3");
  });
});
