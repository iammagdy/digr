import { NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as any,
  job: null as any,
  dataJson: "" as string,
  uploads: [] as Array<{ path: string; size: number; options: any; buf: Buffer }>,
  linked: [] as any[],
}));

function chain(result: () => any) {
  const c: any = {
    select: () => c, eq: () => c, not: () => c, order: () => c, limit: () => c,
    single: async () => result(),
    maybeSingle: async () => result(),
    then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
  };
  return c;
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === "jobs") return chain(() => ({ data: state.job, error: state.job ? null : new Error("nf") }));
      if (table === "artifact_versions") {
        const c = chain(() => ({ data: [], error: null }));
        c.update = (row: any) => { state.linked.push(row); return { eq: () => ({ eq: async () => ({ error: null }) }) }; };
        c.insert = async (row: any) => { state.linked.push(row); return { error: null }; };
        return c;
      }
      return chain(() => ({ data: [], error: null }));
    },
    storage: {
      from: () => ({
        download: async (path: string) =>
          /data\.json$/.test(path) && state.dataJson ? { data: { text: async () => state.dataJson }, error: null } : { data: null, error: new Error("nf") },
        upload: async (path: string, buf: Buffer, options: any) => { state.uploads.push({ path, size: buf.length, options, buf }); return { error: null }; },
        createSignedUrl: async (path: string, _ttl: number, opts: any) => ({ data: { signedUrl: `https://signed.example/${encodeURIComponent(path)}?n=${encodeURIComponent(opts?.download || "")}` }, error: null }),
      }),
    },
  })),
}));

import { GET as download } from "../src/app/api/jobs/[id]/download/route";
import {
  FILE_SPEC_LIMITS, FileSpecSchema, applySpecToRows, decodeFileSpec, describeFileSpecAr, encodeFileSpec,
  groupRows, resolveColumn, sheetNames, validateFileSpec, type DatasetColumn,
} from "../src/lib/fileSpec";
import { FileShapeError, generateShapedExcelReport, shapedPayload } from "../src/functions/shared/fileGenerators";
import { generateCsvReport } from "../src/functions/shared/fileGenerators";

const COLUMNS: DatasetColumn[] = [
  { key: "region", titleAr: "المحافظة" },
  { key: "name", titleAr: "الاسم" },
  { key: "amount", titleAr: "المبلغ" },
  { key: "note", titleAr: "ملاحظة" },
];
const payload = {
  metadata: { title: "اختبار", platform: "web", template: "web" },
  rows: [
    { region: "القاهرة", name: "أ", amount: 3, note: "=HYPERLINK(\"http://evil.example\",\"x\")" },
    { region: "الجيزة", name: "ب", amount: 10, note: "ok" },
    { region: "القاهرة", name: "ج", amount: 7, note: "+cmd|' /C calc'!A0" },
    { region: "الإسكندرية", name: "د", amount: 1, note: "@SUM(1+1)" },
    { region: "الجيزة", name: "هـ", amount: 5, note: "" },
  ],
};

async function open(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb;
}

describe("10. the spec is validated against an allowlist", () => {
  it("is strict: price, points, formula or any extra key makes the whole spec invalid", () => {
    for (const extra of [{ price: 0 }, { points: 1 }, { formula: "=1+1" }, { script: "x" }, { creditValue: 0.01 }]) {
      expect(FileSpecSchema.safeParse({ columns: ["name"], ...extra }).success).toBe(false);
      expect(validateFileSpec({ columns: ["name"], ...extra }, COLUMNS).ok).toBe(false);
    }
    expect(FileSpecSchema.safeParse({ filters: [{ column: "name", op: "equals", value: "x", extra: 1 }] }).success).toBe(false);
  });

  it("allows only the listed operators, sizes and counts", () => {
    expect(FileSpecSchema.safeParse({ filters: [{ column: "name", op: "regex", value: ".*" }] }).success).toBe(false);
    expect(FileSpecSchema.safeParse({ filters: Array.from({ length: 6 }, () => ({ column: "name", op: "not_empty" })) }).success).toBe(false);
    expect(FileSpecSchema.safeParse({ sortBy: Array.from({ length: 4 }, () => ({ column: "name" })) }).success).toBe(false);
    expect(FileSpecSchema.safeParse({ columns: Array.from({ length: FILE_SPEC_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`) }).success).toBe(false);
    expect(FileSpecSchema.safeParse({ filters: [{ column: "name", op: "equals", value: "x".repeat(101) }] }).success).toBe(false);
    expect(FileSpecSchema.safeParse({ groupBy: { column: "region", mode: "pdf" } }).success).toBe(false);
  });

  it("maps the customer's Arabic column titles to real keys and refuses columns that do not exist, in Arabic", () => {
    expect(resolveColumn("المحافظة", COLUMNS)?.key).toBe("region");
    expect(resolveColumn("  الاسم ", COLUMNS)?.key).toBe("name");
    const ok = validateFileSpec({ groupBy: { column: "المحافظة" }, sortBy: [{ column: "المبلغ", direction: "desc" }], columns: ["الاسم", "المبلغ"] }, COLUMNS);
    expect(ok).toMatchObject({ ok: true, spec: { groupBy: { column: "region" }, sortBy: [{ column: "amount", direction: "desc" }], columns: ["name", "amount"] } });
    const bad = validateFileSpec({ groupBy: { column: "المدينة" } }, COLUMNS);
    expect(bad.ok).toBe(false);
    expect((bad as any).errorAr).toContain("«المدينة»");
    expect((bad as any).errorAr).not.toMatch(/[A-Za-z]/);
    expect(validateFileSpec({ filters: [{ column: "amount", op: "gt", value: "abc" }] }, COLUMNS).ok).toBe(false);
    expect(validateFileSpec({ filters: [{ column: "name", op: "equals" }] }, COLUMNS).ok).toBe(false);
  });

  it("a spec travels in a link and is decoded defensively", () => {
    const spec = { version: 1 as const, groupBy: { column: "region", mode: "sheets" as const } };
    expect(decodeFileSpec(encodeFileSpec(spec))).toEqual(spec);
    expect(decodeFileSpec("not base64 !!")).toBeNull();
    expect(decodeFileSpec("A".repeat(FILE_SPEC_LIMITS.maxEncodedLength + 1))).toBeNull();
    expect(decodeFileSpec(Buffer.from("{broken").toString("base64url"))).toBeNull();
  });

  it("filters and sorts without touching the input", () => {
    const rows = payload.rows.map((r) => ({ ...r }));
    const before = JSON.stringify(rows);
    const filtered = applySpecToRows(rows, { filters: [{ column: "amount", op: "gte", value: 5 }], sortBy: [{ column: "amount", direction: "desc" }] });
    expect(filtered.map((r) => r.amount)).toEqual([10, 7, 5]);
    expect(applySpecToRows(rows, { filters: [{ column: "region", op: "equals", value: "القاهرة" }] })).toHaveLength(2);
    expect(applySpecToRows(rows, { filters: [{ column: "note", op: "not_empty" }] })).toHaveLength(4);
    expect(applySpecToRows(rows, { filters: [{ column: "name", op: "contains", value: "ب" }] })).toHaveLength(1);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("sheet names obey Excel's rules and stay unique", () => {
    const names = sheetNames(["a/b:c*[d]?", "'quoted'", "x".repeat(60), "x".repeat(60), "", "القاهرة", "القاهرة"]);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(n).not.toMatch(/[\\/?*[\]:]/);
      expect(n.startsWith("'") || n.endsWith("'")).toBe(false);
    }
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it("describes the shape in plain Arabic", () => {
    const text = describeFileSpecAr({ groupBy: { column: "region", mode: "sheets" }, sortBy: [{ column: "amount", direction: "desc" }] }, COLUMNS);
    expect(text).toContain("شيت منفصل لكل قيمة في «المحافظة»");
    expect(text).toContain("ترتيب حسب «المبلغ»");
    expect(text).not.toMatch(/[A-Za-z0-9]/);
  });
});

describe("10. the workbook: group by a column, split into sheets, formula-safe", () => {
  it("one sheet per region, each with the header and only its own rows", async () => {
    const wb = await open(await generateShapedExcelReport(payload, { groupBy: { column: "region", mode: "sheets" }, sortBy: [{ column: "amount", direction: "desc" }] }));
    expect(wb.worksheets.map((w) => w.name).sort()).toEqual(["الإسكندرية", "الجيزة", "القاهرة"].sort());
    const cairo = wb.getWorksheet("القاهرة")!;
    expect(cairo.rowCount).toBe(3); // header + 2 rows
    expect(cairo.getRow(1).getCell(1).value).toBeTruthy();
    const regionCol = (cairo.getRow(1).values as any[]).findIndex((v) => v === "حقل إضافي ١");
    const amountCol = (cairo.getRow(1).values as any[]).findIndex((v) => v === "حقل إضافي ٣");
    expect(regionCol).toBeGreaterThan(0);
    expect(cairo.getRow(2).getCell(amountCol).value).toBe(7); // sorted desc inside the sheet
    expect(cairo.getRow(3).getCell(amountCol).value).toBe(3);
    cairo.eachRow((row, n) => { if (n > 1) expect(row.getCell(regionCol).value).toBe("القاهرة"); });
    expect(wb.getWorksheet("الجيزة")!.rowCount).toBe(3);
    expect(wb.getWorksheet("الإسكندرية")!.rowCount).toBe(2);
    // Total rows across sheets equals the saved rows.
    expect(wb.worksheets.reduce((a, w) => a + w.rowCount - 1, 0)).toBe(payload.rows.length);
  });

  it("columns are chosen and ordered by the spec, filters apply, and without grouping it is one data sheet", async () => {
    const wb = await open(await generateShapedExcelReport(payload, { columns: ["amount", "region"], filters: [{ column: "amount", op: "gt", value: 2 }] }));
    expect(wb.worksheets).toHaveLength(1);
    const sheet = wb.worksheets[0];
    expect((sheet.getRow(1).values as any[]).slice(1)).toEqual(["حقل إضافي ٣", "حقل إضافي ١"]);
    expect(sheet.rowCount).toBe(5); // header + 4 rows with amount > 2
  });

  it("no cell becomes a formula, whatever the data holds", async () => {
    const wb = await open(await generateShapedExcelReport(payload, { groupBy: { column: "region", mode: "sheets" } }));
    for (const sheet of wb.worksheets) {
      sheet.eachRow((row) => row.eachCell((cell) => {
        expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
        const v = cell.value as any;
        if (typeof v === "string") expect(/^[=+\-@]/.test(v)).toBe(false);
      }));
    }
    const all = JSON.stringify(wb.worksheets.map((s) => (s.getSheetValues() as any[])));
    expect(all).toContain("'=HYPERLINK");
  });

  it("refuses, in Arabic, a split into too many sheets and a filter that matches nothing", async () => {
    const many = { ...payload, rows: Array.from({ length: 40 }, (_, i) => ({ region: `م${i}`, name: "x", amount: i, note: "" })) };
    await expect(generateShapedExcelReport(many, { groupBy: { column: "region", mode: "sheets" } })).rejects.toThrow(FileShapeError);
    await expect(generateShapedExcelReport(many, { groupBy: { column: "region", mode: "sheets" } })).rejects.toMatchObject({ messageAr: expect.stringContaining("٢٥") });
    await expect(generateShapedExcelReport(payload, { filters: [{ column: "name", op: "equals", value: "غير موجود" }] })).rejects.toMatchObject({ messageAr: expect.stringContaining("لا توجد سجلات") });
  });

  it("the CSV and PDF inputs follow the same filters, sort and columns", () => {
    const shaped = shapedPayload(payload, { columns: ["name", "amount"], filters: [{ column: "region", op: "equals", value: "الجيزة" }], sortBy: [{ column: "amount", direction: "asc" }] });
    expect(shaped.rows).toEqual([{ name: "هـ", amount: 5 }, { name: "ب", amount: 10 }]);
    expect(shaped.metadata.rowsCount).toBe(2);
    const csv = generateCsvReport(shaped).toString("utf8");
    expect(csv.split("\n").filter(Boolean)).toHaveLength(3);
  });
});

describe("10. the download route builds a shaped file from the saved data, with no provider call", () => {
  const spec = { version: 1 as const, groupBy: { column: "region", mode: "sheets" as const } };
  const req = (encoded?: string, format = "xlsx") =>
    new NextRequest(`http://localhost/api/jobs/job_1/download?format=${format}${encoded ? `&spec=${encoded}` : ""}`);
  const params = { params: Promise.resolve({ id: "job_1" }) };

  beforeEach(() => {
    state.user = { id: "owner-1", app_metadata: {} };
    state.job = { id: "job_1", user_id: "owner-1", status: "completed", delivered_units: 5, target_volume_max: 5, params: {}, template_slug: "web", endpoint_id: "web" };
    state.dataJson = JSON.stringify(payload);
    state.uploads = [];
    state.linked = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("a valid spec produces a separate shaped file, named as custom, not linked as the job's artifact", async () => {
    // The spec names the real key; the Arabic title route is covered above.
    const res = await download(req(encodeFileSpec(spec)), params);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0].path).toMatch(/^owner-1\/job_1\/shaped_[0-9a-f]{10}\.xlsx$/);
    expect(body.downloadFileName).toContain("مخصص");
    expect(state.linked).toHaveLength(0);
    const wb = await open(state.uploads[0].buf);
    expect(wb.worksheets.map((w) => w.name).sort()).toEqual(["الإسكندرية", "الجيزة", "القاهرة"].sort());
  });

  it("an invalid spec (unknown column, forbidden key) is refused in Arabic before anything is built", async () => {
    const unknown = await download(req(encodeFileSpec({ version: 1, groupBy: { column: "عمود غير موجود", mode: "sheets" } })), params);
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain("«عمود غير موجود»");
    const forbidden = await download(req(Buffer.from(JSON.stringify({ columns: ["name"], price: 0 })).toString("base64url")), params);
    expect(forbidden.status).toBe(400);
    const garbage = await download(req("%%%"), params);
    expect(garbage.status).toBe(400);
    expect(state.uploads).toHaveLength(0);
  });

  it("a split that cannot be built is a clear Arabic 422, never the standard file", async () => {
    state.dataJson = JSON.stringify({ ...payload, rows: Array.from({ length: 40 }, (_, i) => ({ region: `م${i}`, name: "x", amount: i, note: "" })) });
    const res = await download(req(encodeFileSpec(spec)), params);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("٢٥");
    expect(state.uploads).toHaveLength(0);
  });

  it("without a spec the standard file path is unchanged (result.xlsx, linked)", async () => {
    const res = await download(req(), params);
    expect(res.status).toBe(200);
    expect(state.uploads[0].path).toBe("owner-1/job_1/result.xlsx");
    expect(state.linked.length).toBeGreaterThan(0);
    const wb = await open(state.uploads[0].buf);
    expect(wb.worksheets).toHaveLength(1);
  });

  it("another customer's job cannot be shaped", async () => {
    state.user = { id: "someone-else", app_metadata: {} };
    const res = await download(req(encodeFileSpec(spec)), params);
    expect(res.status).toBe(403);
    expect(state.uploads).toHaveLength(0);
  });

  it("the route never reaches the provider or the money functions", async () => {
    const source = (await import("node:fs")).readFileSync("src/app/api/jobs/[id]/download/route.ts", "utf8");
    expect(source).not.toMatch(/tregClient|tregAdapter|providerGate|reserve_provider_spend|reserve_credits|settle_job|credit_ledger/);
  });
});

describe("10. the model's spec reaches the customer as a free download, through the real chat handler", async () => {
  const { ChatHandler, sanitizeResultColumns } = await import("../src/functions/shared/chatHandler");
  const { clearBriefCacheForTesting } = await import("../src/functions/shared/briefManager");
  const { makeTables } = await import("./helpers/memoryTables");
  const { readFileSync } = await import("node:fs");

  beforeEach(() => clearBriefCacheForTesting());
  afterEach(() => clearBriefCacheForTesting());

  const ask = (message: string, resultColumns?: any[]) =>
    new ChatHandler(makeTables() as any).handleUserMessage({
      userId: `u_${Math.random()}`, message, userBalance: 500, personaProfile: { name: "سلمى" }, resultColumns,
    }) as Promise<any>;

  it("«عايز شيت لكل محافظة» returns a validated spec, an Arabic description, no revision quote and no charge", async () => {
    const res = await ask("عايز شيت لكل محافظة", [{ key: "region", titleAr: "المحافظة" }]);
    expect(res.outputType).toBe("answer_question");
    expect(res.fileShape.spec).toEqual({ version: 1, groupBy: { column: "region", mode: "sheets" } });
    expect(res.fileShape.descriptionAr).toContain("شيت منفصل لكل قيمة");
    expect(res.contentAr).toContain("تحميل الملف المخصص");
    expect(res.contentAr).toContain("لا يُخصم أي رصيد");
    expect(res.revisionQuote).toBeUndefined();
    expect(res.planQuote).toBeUndefined();
    expect(res.contentAr).not.toMatch(/[A-Za-z]|\p{Extended_Pictographic}/u);
  });

  it("the Arabic word the customer used finds the real column at download", () => {
    expect(validateFileSpec({ groupBy: { column: "محافظة" } }, COLUMNS)).toMatchObject({ ok: true, spec: { groupBy: { column: "region" } } });
  });

  it("column hints from the page are cleaned before they reach the prompt", () => {
    expect(sanitizeResultColumns([{ key: "region", titleAr: "المحافظة" }, { key: "bad key!", titleAr: "x" }, { key: "name", titleAr: "" }, "junk", null])).toEqual([{ key: "region", titleAr: "المحافظة" }]);
    expect(sanitizeResultColumns("nope")).toEqual([]);
    expect(sanitizeResultColumns(Array.from({ length: 200 }, (_, i) => ({ key: `c${i}`, titleAr: "ع" }))).length).toBe(60);
  });

  it("the model is told the spec has no room for money, and the route and page are wired", () => {
    const prompt = readFileSync("src/functions/shared/systemPrompt.ts", "utf8");
    expect(prompt).toContain('"shape_file"');
    expect(prompt).toContain("never add any other key (no prices, points, formulas or scripts)");
    expect(prompt).toContain("Building the file is free");
    expect(readFileSync("src/app/api/chat/route.ts", "utf8")).toContain("resultColumns: Array.isArray(body.resultColumns)");
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain('handleDownload("xlsx", m.fileShape!.spec as FileSpec, m.fileShape!.jobId)');
    expect(page).toContain("resultColumns: activeJob.resultColumns");
  });
});

describe("10. recognising a file-shaping wish", async () => {
  const { looksLikeFileShapingRequest } = await import("../src/lib/fileSpec");
  it("catches the natural ways to ask, and not a new research request", () => {
    for (const q of ["عايز شيت لكل محافظة", "اعمل ملف منفصل لكل مجال", "قسم الملف حسب الدولة", "رتبها حسب التاريخ", "فلتر على القاهرة بس", "خلي بس الأعمدة المهمة"]) {
      expect(looksLikeFileShapingRequest(q), q).toBe(true);
    }
    for (const q of ["عايز ٣ شركات كهرباء في مصر", "هات تعليقات تيك توك عن كرة القدم", "ازيك", "", "x".repeat(400)]) {
      expect(looksLikeFileShapingRequest(q), q).toBe(false);
    }
  });
});
