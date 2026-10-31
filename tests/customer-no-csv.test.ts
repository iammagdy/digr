import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { customerFileIds, customerResultFormats, withoutCsvFormat } from "../src/lib/customerFiles";
import { excelFromCsv, parseCsv } from "../src/lib/server/excelFromCsv";
import { customerFilesOf } from "../src/lib/agentMission/customerView";
import { customerFileLink } from "../src/lib/agentMission/customerActions";
import { fileLink } from "../src/lib/agentMission/adminActions";
import { jobHasSavedData } from "../src/lib/server/methodologyPurchase";
import { formatsAr } from "../src/lib/planExplanation";
import { customerFormatLabelAr } from "../src/lib/customerFormatLabels";

/**
 * A CUSTOMER NEVER SEES OR DOWNLOADS A CSV (the CSV is still produced and stored for settlement and the admin). Every customer route gives the Excel; an older request with a CSV and no Excel gets an Excel built from its CSV.
 */
const world = vi.hoisted(() => ({
  admin: false,
  user: "owner-1",
  /** the results bucket: path -> text or bytes */
  files: new Map<string, string | Buffer>(),
  versions: [] as Array<Record<string, unknown>>,
  signed: [] as Array<{ path: string; download?: string }>,
  uploaded: [] as Array<{ path: string; bytes: Buffer }>,
}));

vi.mock("../src/lib/supabase/server", () => {
  const chain = (result: () => any): any => { const c: any = { select: () => c, eq: () => c, not: () => c, order: () => c, limit: () => c, in: () => c, update: () => c, insert: () => c, upsert: () => c, single: async () => result(), maybeSingle: async () => result(), then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject) }; return c; };
  return {
    createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: world.user, app_metadata: world.admin ? { role: "admin" } : {} } }, error: null })) } })),
    createAdminClient: vi.fn(() => ({
      rpc: async () => ({ data: null, error: null }),
      from: (table: string) => {
        if (table === "jobs") return chain(() => ({ data: { id: "job_old1", user_id: "owner-1", status: "completed", delivered_units: 3, charged_credits: 9, reserved_credits: 9, target_volume_max: 3, params: {}, endpoint_id: "x", created_at: "2026-09-01T10:00:00Z", finished_at: "2026-09-01T10:30:00Z" }, error: null }));
        if (table === "artifact_versions") return chain(() => ({ data: world.versions, error: null }));
        return chain(() => ({ data: table === "missions" ? null : [], error: null }));
      },
      storage: {
        from: () => ({
          // like the real storage: a path that holds no file has no signed link and no download
          download: async (path: string) => { const f = world.files.get(path); return f === undefined ? { data: null, error: new Error("not found") } : { data: { text: async () => (typeof f === "string" ? f : f.toString("utf8")) }, error: null }; },
          upload: async (path: string, bytes: Buffer) => { world.files.set(path, bytes); world.uploaded.push({ path, bytes }); return { error: null }; },
          createSignedUrl: async (path: string, _t: number, o?: { download?: string }) => { if (!world.files.has(path)) return { data: null, error: new Error("not found") }; world.signed.push({ path, download: o?.download }); return { data: { signedUrl: `https://signed.example/${path}` }, error: null }; },
        }),
      },
    })),
  };
});
vi.mock("../src/functions/shared/artifactVersionLinking", () => ({ linkArtifactVersion: vi.fn(async () => undefined) }));
import { GET as downloadRoute } from "../src/app/api/jobs/[id]/download/route";

const CSV = `﻿"الاسم","العدد","الرابط","ملاحظة"\r\n"النيل","120","https://nile.example","قال ""أهلًا""\nوسطر ثانٍ"\r\n"دلتا","80","","'=سطر يبدأ كمعادلة"\r\n"المنصورة","0045","https://mansoura.example",""`;

async function ask(query: string): Promise<{ status: number; json: any }> {
  world.signed = []; world.uploaded = [];
  const res = await downloadRoute(new NextRequest(`https://x.example/api/jobs/job_old1/download${query}`, { headers: { authorization: "Bearer t" } }), { params: Promise.resolve({ id: "job_old1" }) });
  return { status: res.status, json: await res.json() };
}
function reset(options: { admin?: boolean; xlsx?: boolean; csv?: boolean } = {}) {
  world.admin = Boolean(options.admin);
  world.files = new Map();
  world.versions = [{ id: "v1", version_number: 1, file_id_xlsx: options.xlsx === false ? null : "owner-1/job_old1/result.xlsx", file_id_csv: options.csv === false ? null : "owner-1/job_old1/result.csv", file_id_pdf: null }];
  if (options.xlsx !== false) world.files.set("owner-1/job_old1/result.xlsx", Buffer.from("xlsx-bytes"));
  if (options.csv !== false) world.files.set("owner-1/job_old1/result.csv", CSV);
}

describe("the download route never gives a customer a CSV", () => {
  it("a customer who asks for «csv» (an old link, an old page) is given the Excel", async () => {
    reset();
    const { status, json } = await ask("?format=csv");
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, format: "xlsx" });
    expect(json.downloadFileName).toMatch(/\.xlsx$/);
    expect(world.signed.map((s) => s.path)).toEqual(["owner-1/job_old1/result.xlsx"]);
    expect(world.signed.some((s) => s.path.endsWith(".csv"))).toBe(false);
  });

  it("with no format asked, the default is the Excel (it used to be the CSV)", async () => {
    reset();
    const { json } = await ask("");
    expect(json).toMatchObject({ success: true, format: "xlsx" });
    expect(world.signed[0].path).toBe("owner-1/job_old1/result.xlsx");
  });

  it("only an admin can still ask the route for the stored CSV", async () => {
    reset({ admin: true });
    const { json } = await ask("?format=csv");
    expect(json).toMatchObject({ success: true, format: "csv" });
    expect(world.signed[0].path).toBe("owner-1/job_old1/result.csv");
  });

  it("an older request with a CSV and NO Excel gets an Excel built from that CSV (for «xlsx» and for an old «csv» link), and the stored CSV is untouched", async () => {
    for (const query of ["?format=xlsx", "?format=csv", ""]) {
      reset({ xlsx: false });
      const { status, json } = await ask(query);
      expect(status, query).toBe(200);
      expect(json, query).toMatchObject({ success: true, format: "xlsx" });
      expect(world.signed.map((s) => s.path), query).toEqual(["owner-1/job_old1/result.xlsx"]);
      expect(world.uploaded.map((u) => u.path), query).toEqual(["owner-1/job_old1/result.xlsx"]);
      // the CSV is exactly as it was
      expect(world.files.get("owner-1/job_old1/result.csv")).toBe(CSV);
      // a real reader opens what was built: the header, the cells, a number as a number, a link as a link, the formula mark taken off
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(world.uploaded[0].bytes as unknown as ArrayBuffer);
      const sheet = wb.worksheets[0];
      expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(["الاسم", "العدد", "الرابط", "ملاحظة"]);
      expect(sheet.getRow(2).getCell(1).value).toBe("النيل");
      // this column holds «0045», so none of it is turned into a number (a leading zero is never lost)
      expect(sheet.getRow(2).getCell(2).value).toBe("120");
      expect((sheet.getRow(2).getCell(3).value as any).hyperlink).toBe("https://nile.example");
      expect(sheet.getRow(2).getCell(4).value).toBe('قال "أهلًا"\nوسطر ثانٍ');
      expect(sheet.getRow(3).getCell(3).value).toBeNull();
      expect(sheet.getRow(3).getCell(4).value).toBe("=سطر يبدأ كمعادلة");
      expect(sheet.getRow(4).getCell(2).value).toBe("0045");
      expect(sheet.rowCount).toBe(4);
    }
  });

  it("an older request with nothing stored still says plainly that the file is not ready (never a CSV)", async () => {
    reset({ xlsx: false, csv: false });
    const { status, json } = await ask("?format=xlsx");
    expect(status).toBe(404);
    expect(json.success).toBe(false);
  });
});

describe("the CSV reader and the Excel built from it", () => {
  it("reads quotes, doubled quotes, line breaks inside quotes, CRLF and a leading byte-order mark", () => {
    expect(parseCsv(CSV)).toEqual([["الاسم", "العدد", "الرابط", "ملاحظة"], ["النيل", "120", "https://nile.example", 'قال "أهلًا"\nوسطر ثانٍ'], ["دلتا", "80", "", "'=سطر يبدأ كمعادلة"], ["المنصورة", "0045", "https://mansoura.example", ""]]);
    expect(parseCsv("a,b\nc,d\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("a column is stored as numbers only when EVERY filled cell is a plain number", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await excelFromCsv("الاسم,العدد\r\nأ,1\r\nب,25\r\nج,")) as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    expect(sheet.getRow(2).getCell(2).value).toBe(1);
    expect(sheet.getRow(3).getCell(2).value).toBe(25);
    expect(sheet.getRow(4).getCell(2).value).toBeNull();
  });

  it("an empty CSV still builds a valid, empty workbook", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await excelFromCsv("")) as unknown as ArrayBuffer);
    expect(wb.worksheets).toHaveLength(1);
  });
});

describe("the mission card and the file link", () => {
  it("the card offers ONE button, the Excel; a mission that holds only a CSV is offered an Excel too", () => {
    expect(customerFilesOf([{ name: "result.xlsx", kind: "xlsx" }, { name: "result.csv", kind: "csv" }])).toEqual([{ name: "result.xlsx", kind: "xlsx", labelAr: "تنزيل ملف إكسل" }]);
    expect(customerFilesOf([{ name: "result.csv", kind: "csv" }])).toEqual([{ name: "result.xlsx", kind: "xlsx", labelAr: "تنزيل ملف إكسل" }]);
    expect(customerFilesOf([])).toEqual([]);
  });

  const mission = (files: unknown) => ({ id: "msn_1", user_id: "u1", files, plan: { stages: [{ key: "s", title_ar: "التغريدات", deliver: true }] }, request_text: "هات ٣ تغريدات", delivered_units: 3, updated_at: "2026-10-29T07:00:00Z" });
  const fakeClient = (row: any, signed: Array<{ path: string; download?: string }>, store: Map<string, string | Buffer>) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
    storage: { from: () => ({
      download: async (path: string) => { const f = store.get(path); return f === undefined ? { data: null, error: new Error("nf") } : { data: { text: async () => String(f) }, error: null }; },
      upload: async (path: string, bytes: Buffer) => { store.set(path, bytes); return { error: null }; },
      createSignedUrl: async (path: string, _t: number, o?: { download?: string }) => { signed.push({ path, download: o?.download }); return { data: { signedUrl: `https://signed.example/${path}` }, error: null }; },
    }) },
  });

  it("a link asked for by the CSV's name is the Excel's; the admin's link keeps the CSV", async () => {
    const signed: Array<{ path: string; download?: string }> = [];
    const client = fakeClient(mission([{ kind: "xlsx", name: "result.xlsx", path: "result/result.xlsx" }, { kind: "csv", name: "result.csv", path: "result/result.csv" }]), signed, new Map());
    expect(await customerFileLink(client, { id: "msn_1", userId: "u1", name: "result.csv" })).toMatchObject({ ok: true });
    expect(signed[0].path).toBe("msn_1/result/result.xlsx");
    expect(signed[0].download).toMatch(/\.xlsx$/);
    signed.length = 0;
    expect(await fileLink(client, { id: "msn_1", name: "result.csv" })).toMatchObject({ ok: true });
    expect(signed[0].path).toBe("msn_1/result/result.csv");
    expect(signed[0].download).toMatch(/\.csv$/);
  });

  it("a mission that holds only a CSV gets an Excel built from it, saved in the mission's own folder", async () => {
    const signed: Array<{ path: string; download?: string }> = [];
    const store = new Map<string, string | Buffer>([["msn_1/result/result.csv", CSV]]);
    const client = fakeClient(mission([{ kind: "csv", name: "result.csv", path: "result/result.csv" }]), signed, store);
    expect(await customerFileLink(client, { id: "msn_1", userId: "u1", name: "result.xlsx" })).toMatchObject({ ok: true });
    expect(signed[0].path).toBe("msn_1/result/result.xlsx");
    expect(signed[0].download).toMatch(/\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(store.get("msn_1/result/result.xlsx") as unknown as ArrayBuffer);
    expect(wb.worksheets[0].getRow(2).getCell(1).value).toBe("النيل");
    expect(store.get("msn_1/result/result.csv")).toBe(CSV);
  });
});

describe("what the customer is told and shown", () => {
  it("the formats a customer is offered never include a CSV, and a request with a CSV is always offered the Excel", () => {
    expect(customerResultFormats(["xlsx", "pdf", "csv"])).toEqual(["xlsx", "pdf"]);
    expect(customerResultFormats(["csv"])).toEqual(["xlsx"]);
    expect(customerResultFormats(["pdf", "csv"])).toEqual(["xlsx", "pdf"]);
    expect(customerResultFormats(["xlsx"])).toEqual(["xlsx"]);
    expect(customerResultFormats([])).toEqual([]);
    expect(withoutCsvFormat(["xlsx", "csv", "pdf"])).toEqual(["xlsx", "pdf"]);
  });

  it("an API never tells a customer the id of a CSV; a request with only a CSV says its Excel is ready", () => {
    expect(customerFileIds({ xlsx: "a", pdf: "b", csv: "c" })).toEqual({ xlsx: "a", pdf: "b", csv: null });
    expect(customerFileIds({ xlsx: null, pdf: null, csv: "c" })).toEqual({ xlsx: "ready", pdf: null, csv: null });
    expect(customerFileIds(null)).toEqual({ xlsx: null, pdf: null, csv: null });
    for (const file of ["src/app/api/jobs/[id]/data/route.ts", "src/app/api/jobs/[id]/artifacts/route.ts"]) expect(readFileSync(file, "utf8")).toContain("customerFileIds(");
  });

  it("no plan sentence, chip, label, answer or landing line names a CSV", () => {
    expect(formatsAr(["xlsx", "pdf", "csv"])).toBe("إكسل وبي دي إف");
    expect(formatsAr(["csv"])).toBe("إكسل");
    expect(customerFormatLabelAr("csv")).toBe("ملف بيانات");
    for (const file of [
      "src/app/dashboard/requests/page.tsx", "src/lib/agentMission/customerView.ts", "src/app/dashboard/chat/components/ResultsCanvas.tsx", "src/app/dashboard/chat/components/RunSections.tsx",
      "src/app/dashboard/chat/components/ActivityTerminal.tsx", "src/app/dashboard/chat/components/PlanQuoteCard.tsx", "src/lib/planExplanation.ts", "src/lib/customerFormatLabels.ts",
      "src/components/landing/data.ts", "src/components/landing/heroField.ts", "src/functions/shared/systemPrompt.ts", "src/functions/shared/emailTemplates.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/سي إس في/);
      expect(source, file).not.toMatch(/Excel · PDF · CSV|Excel وPDF وCSV|Excel, CSV and PDF/);
    }
    const llm = readFileSync("src/functions/shared/llmClient.ts", "utf8");
    expect(llm).not.toContain("ملف CSV، وملف PDF");
    // the plan card's chips and editor list the Excel and the PDF only
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card).toContain('{["xlsx", "pdf"].map((f) => (');
    expect(card).toContain("withoutCsvFormat(");
  });

  it("the customer's file buttons of the three surfaces come from one function that drops the CSV", () => {
    for (const file of ["src/app/dashboard/chat/components/ResultsCanvas.tsx", "src/app/dashboard/chat/components/RunSections.tsx", "src/app/dashboard/chat/components/ActivityTerminal.tsx"]) expect(readFileSync(file, "utf8"), file).toContain("customerResultFormats(producedFormats(fileIds))");
    expect(readFileSync("src/lib/requests/files.ts", "utf8")).toContain("customerResultFormats(available)");
  });
});

describe("the chat never points to the paid methodology button for a job with no saved data", () => {
  const storage = (files: Record<string, string>, fail = false) => ({ storage: { from: (bucket: string) => ({ download: async (path: string) => { if (fail) throw new Error("boom"); const f = files[`${bucket}/${path}`]; return f === undefined ? { data: null, error: new Error("nf") } : { data: { text: async () => f }, error: null }; } }) } });
  it("true when the job's data.json has rows, false when it has none or is not there, null when it cannot be read", async () => {
    const rows = JSON.stringify({ rows: [{ a: 1 }] });
    expect(await jobHasSavedData(storage({ "results/u1/j1/data.json": rows }), { userId: "u1", jobId: "j1" })).toBe(true);
    expect(await jobHasSavedData(storage({ "partials/j1/data.json": rows }), { userId: "u1", jobId: "j1" })).toBe(true);
    expect(await jobHasSavedData(storage({ "results/u1/j1/data.json": JSON.stringify({ rows: [] }) }), { userId: "u1", jobId: "j1" })).toBe(false);
    expect(await jobHasSavedData(storage({}), { userId: "u1", jobId: "j1" })).toBe(false);
    expect(await jobHasSavedData(storage({}, true), { userId: "u1", jobId: "j1" })).toBeNull();
    expect(await jobHasSavedData(null, { userId: "u1", jobId: "j1" })).toBeNull();
  });
});
