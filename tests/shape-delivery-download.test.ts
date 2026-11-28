import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFileSpec, type FileSpec } from "@/lib/fileSpec";
import { checkCustomerText } from "@/lib/agentMission/text";
import { DELIVERED_SHAPE_TOO_LARGE_AR } from "@/lib/server/shapeDeliveredDownload";
import { fileNameFromDisposition } from "@/lib/downloadName";
import { parseCsv } from "@/lib/server/excelFromCsv";

const state = vi.hoisted(() => ({
  currentUser: "customer-a",
  isAdmin: false,
  job: {} as Record<string, unknown>,
  mission: {} as Record<string, unknown>,
  receipt: { data: null, error: null } as { data: unknown; error: unknown },
  objects: new Map<string, Buffer>(),
  storageUploadCalls: [] as any[],
  dbInsertCalls: [] as any[],
  dbUpdateCalls: [] as any[],
}));

vi.mock("@/lib/supabase/server", () => {
  const chain = (result: { data: unknown; error: unknown }, table: string) => {
    const query: any = {
      select: () => query,
      eq: (col: string, val: any) => query,
      order: () => query,
      limit: () => query,
      not: () => query,
      insert: (record: any) => {
        state.dbInsertCalls.push({ table, record });
        return query;
      },
      update: (record: any) => {
        state.dbUpdateCalls.push({ table, record });
        return query;
      },
      single: async () => result,
      maybeSingle: async () => result,
      then: (resolve: (val: any) => any) => Promise.resolve(result).then(resolve),
    };
    return query;
  };

  return {
    createServerSideClient: async () => ({
      auth: {
        getUser: async () => ({
          data: {
            user: {
              id: state.currentUser,
              app_metadata: state.isAdmin ? { role: "admin" } : {},
            },
          },
        }),
      },
    }),
    createAdminClient: () => ({
      from: (table: string) => {
        if (table === "agent_delivery_receipts") return chain(state.receipt, table);
        if (table === "jobs") return chain({ data: state.job, error: null }, table);
        if (table === "missions") return chain({ data: state.mission, error: null }, table);
        return chain({ data: null, error: null }, table);
      },
      storage: {
        from: (bucket: string) => ({
          download: async (path: string) => {
            const bytes = state.objects.get(`${bucket}/${path}`);
            return bytes
              ? { data: new Blob([new Uint8Array(bytes)]) }
              : { error: { status: 404, message: "not found" } };
          },
          upload: async (path: string, body: any) => {
            state.storageUploadCalls.push({ bucket, path });
            return { data: { path }, error: null };
          },
          createSignedUrl: async (path: string) => ({
            data: { signedUrl: `https://fixture.example/${path}` },
          }),
        }),
      },
    }),
  };
});

import { GET } from "@/app/api/jobs/[id]/download/route";

describe("shapeDeliveredDownload (P5 / T5)", () => {
  const jobId = "job_delivered_001";
  const missionId = "msn_delivered_001";
  const userId = "customer-a";
  let singleStageXlsx: Buffer;
  let singleStageSha: string;
  let twoStageXlsx: Buffer;
  let twoStageSha: string;

  beforeEach(async () => {
    // 1-stage workbook
    const wb1 = new ExcelJS.Workbook();
    wb1.addWorksheet("ملخص").addRow(["الملخص"]);
    const sheet1 = wb1.addWorksheet("الشركات");
    sheet1.addRow(["اسم الشركة", "المدينة", "عدد الموظفين"]);
    sheet1.addRow(["شركة ألف", "القاهرة", 100]);
    sheet1.addRow(["شركة باء", "الجيزة", 50]);
    sheet1.addRow(["شركة جيم", "القاهرة", 200]);
    singleStageXlsx = Buffer.from(await wb1.xlsx.writeBuffer());
    singleStageSha = createHash("sha256").update(singleStageXlsx).digest("hex");

    // 2-stage workbook
    const wb2 = new ExcelJS.Workbook();
    wb2.addWorksheet("ملخص").addRow(["الملخص"]);
    const s1 = wb2.addWorksheet("الشركات");
    s1.addRow(["اسم الشركة", "المدينة"]);
    s1.addRow(["ألف", "القاهرة"]);
    const s2 = wb2.addWorksheet("الموظفون");
    s2.addRow(["اسم الموظف", "القسم"]);
    s2.addRow(["أحمد", "تقنية"]);
    twoStageXlsx = Buffer.from(await wb2.xlsx.writeBuffer());
    twoStageSha = createHash("sha256").update(twoStageXlsx).digest("hex");

    state.currentUser = userId;
    state.isAdmin = false;
    state.storageUploadCalls = [];
    state.dbInsertCalls = [];
    state.dbUpdateCalls = [];

    state.job = {
      id: jobId,
      user_id: userId,
      endpoint_id: "agent-mission",
      status: "completed",
      delivered_units: 3,
      charged_credits: 3,
    };

    const files = [
      {
        name: "result.xlsx",
        path: "result/result.xlsx",
        kind: "xlsx",
        sha256: singleStageSha,
      },
    ];

    state.mission = {
      id: missionId,
      user_id: userId,
      job_id: jobId,
      delivered_units: 3,
      files,
      plan: { summary_ar: "شركات في مصر" },
      request_text: "بيانات الشركات في مصر",
      updated_at: "2026-11-27T10:00:00Z",
    };

    const receiptPath = `${userId}/${jobId}/sealed/${singleStageSha}/result.xlsx`;
    state.receipt = {
      error: null,
      data: {
        mission_id: missionId,
        user_id: userId,
        xlsx_path: receiptPath,
        xlsx_sha: singleStageSha,
        physical_units: 3,
        binding: { files },
      },
    };

    state.objects = new Map([
      [`agent-missions/${missionId}/result/result.xlsx`, singleStageXlsx],
      [`results/${receiptPath}`, singleStageXlsx],
    ]);
  });

  it("Arabic 413 error line passes checkCustomerText", () => {
    const result = checkCustomerText(DELIVERED_SHAPE_TOO_LARGE_AR);
    expect(result.issues).toEqual([]);
  });

  it("shaped xlsx and csv download for sealed job (Gate 1 item 4a)", async () => {
    // spec: pick col_1 and col_2, sort by col_1 asc
    const spec: FileSpec = {
      columns: ["col_1", "col_2"],
      sortBy: [{ column: "col_1", direction: "asc" }],
    };
    const encoded = encodeFileSpec(spec);

    // 1. XLSX
    const reqXlsx = new NextRequest(`https://fixture.example/download?format=xlsx&spec=${encoded}`);
    const resXlsx = await GET(reqXlsx, { params: Promise.resolve({ id: jobId }) });
    expect(resXlsx.status).toBe(200);
    const dispositionXlsx = resXlsx.headers.get("content-disposition");
    expect(fileNameFromDisposition(dispositionXlsx)).toContain(" - مخصص.xlsx");
    const xlsxBytes = Buffer.from(await resXlsx.arrayBuffer());
    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.load(xlsxBytes as unknown as ArrayBuffer);
    expect(outWb.worksheets[0].rowCount).toBe(4); // header + 3 rows

    // 2. CSV
    const reqCsv = new NextRequest(`https://fixture.example/download?format=csv&spec=${encoded}`);
    const resCsv = await GET(reqCsv, { params: Promise.resolve({ id: jobId }) });
    expect(resCsv.status).toBe(200);
    const dispositionCsv = resCsv.headers.get("content-disposition");
    expect(fileNameFromDisposition(dispositionCsv)).toContain(" - مخصص.csv");
    const csvContent = await resCsv.text();
    const rows = parseCsv(csvContent);
    expect(rows.length).toBe(4); // header + 3 rows
    expect(rows[0]).toEqual(["اسم الشركة", "المدينة"]);
  });

  it("receipt job WITHOUT spec is byte-identical to existing receipt path (Gate 1 item 4b)", async () => {
    const req = new NextRequest("https://fixture.example/download?format=xlsx&stream=1");
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(singleStageXlsx)).toBe(true);
  });

  it("applies filtering and splitting on shaped delivery", async () => {
    const spec: FileSpec = {
      columns: ["col_1", "col_2", "col_3"],
      filters: [{ column: "col_2", op: "equals", value: "القاهرة" }],
    };
    const encoded = encodeFileSpec(spec);

    const req = new NextRequest(`https://fixture.example/download?format=csv&spec=${encoded}`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(200);
    const csv = await res.text();
    const rows = parseCsv(csv);
    // 1 header + 2 matching rows from القاهرة (شركة ألف, شركة جيم)
    expect(rows.length).toBe(3);
    expect(rows[1][0]).toBe("شركة ألف");
    expect(rows[2][0]).toBe("شركة جيم");
  });

  it("spec naming a non-existent column returns 400 + Arabic error and builds nothing", async () => {
    const spec: FileSpec = {
      columns: ["col_non_existent"],
    };
    const encoded = encodeFileSpec(spec);

    const req = new NextRequest(`https://fixture.example/download?format=xlsx&spec=${encoded}`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(typeof json.error).toBe("string");
  });

  it("multi-stage delivery includes sheet name in file name", async () => {
    state.mission = {
      ...state.mission,
      files: [
        {
          name: "result.xlsx",
          path: "result/result.xlsx",
          kind: "xlsx",
          sha256: twoStageSha,
        },
      ],
    };
    state.objects.set(`agent-missions/${missionId}/result/result.xlsx`, twoStageXlsx);

    const spec: FileSpec = { columns: ["col_1", "col_2"] };
    const encoded = encodeFileSpec(spec);

    const req = new NextRequest(`https://fixture.example/download?format=xlsx&spec=${encoded}`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(200);
    const disp = res.headers.get("content-disposition");
    const name = fileNameFromDisposition(disp);
    expect(name).toContain(" - مخصص - الشركات.xlsx");
  });

  it("never calls storage.upload, db insert/update, or artifact linking", async () => {
    const spec: FileSpec = { columns: ["col_1", "col_2"] };
    const encoded = encodeFileSpec(spec);

    const req = new NextRequest(`https://fixture.example/download?format=xlsx&spec=${encoded}`);
    await GET(req, { params: Promise.resolve({ id: jobId }) });

    expect(state.storageUploadCalls).toEqual([]);
    expect(state.dbInsertCalls).toEqual([]);
    expect(state.dbUpdateCalls).toEqual([]);
  });

  it("user isolation: another user receives 403", async () => {
    state.currentUser = "attacker-user";
    const spec: FileSpec = { columns: ["col_1", "col_2"] };
    const encoded = encodeFileSpec(spec);

    const req = new NextRequest(`https://fixture.example/download?format=xlsx&spec=${encoded}`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(403);
  });

  it("sealed hash mismatch: parser never reached via route (Gate 1 item 6)", async () => {
    const loadSpy = vi.spyOn(ExcelJS.Workbook.prototype.xlsx, "load");
    loadSpy.mockClear();

    // Tamper the file in storage
    const tampered = Buffer.from(singleStageXlsx);
    tampered[0] ^= 0xff;
    state.objects.set(`agent-missions/${missionId}/result/result.xlsx`, tampered);

    const spec: FileSpec = { columns: ["col_1", "col_2"] };
    const encoded = encodeFileSpec(spec);

    const req = new NextRequest(`https://fixture.example/download?format=xlsx&spec=${encoded}`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("تعذر قراءة بيانات هذا الطلب.");
    // Proves ExcelJS load was never reached due to hash mismatch guard!
    expect(loadSpy).not.toHaveBeenCalled();
    loadSpy.mockRestore();
  });
});
