import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileNameFromDisposition } from "../src/lib/downloadName";

const state = vi.hoisted(() => ({
  customer: "customer-a",
  job: {} as Record<string, unknown>,
  mission: {} as Record<string, unknown>,
  receipt: { data: null, error: null } as { data: unknown; error: unknown },
  objects: new Map<string, Buffer>(),
  signed: [] as string[],
}));

vi.mock("../src/lib/supabase/server", () => {
  const chain = (result: { data: unknown; error: unknown }) => {
    const query = {
      select: () => query, insert: () => query, update: () => query, eq: () => query, order: () => query, limit: () => query, not: () => query,
      single: async () => result, maybeSingle: async () => result,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return query;
  };
  return {
    createServerSideClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: state.customer } } }) } }),
    createAdminClient: () => ({
      from: (table: string) => chain(table === "agent_delivery_receipts" ? state.receipt : {
        data: table === "jobs" ? state.job : table === "missions" ? state.mission
          : table === "artifact_versions" ? [{ file_id_xlsx: "customer-a/job-example/result.xlsx" }] : null,
        error: null,
      }),
      storage: { from: (bucket: string) => ({
        download: async (path: string) => {
          const bytes = state.objects.get(`${bucket}/${path}`);
          return bytes ? { data: new Blob([new Uint8Array(bytes)]) } : { error: { status: 404, message: "not found" } };
        },
        createSignedUrl: async (path: string) => {
          state.signed.push(path);
          return { data: { signedUrl: `https://fixture.example/${path}` } };
        },
      }) },
    }),
  };
});

import { GET } from "../src/app/api/jobs/[id]/download/route";
import { createAdminClient } from "../src/lib/supabase/server";
import { customerCsvFile, customerFileLink } from "../src/lib/agentMission/customerActions";

const jobId = "job-example";
const missionId = "msn_example";
const userId = "customer-a";
const name = "الأشخاص - ٢";
const legacy = `${userId}/${jobId}/result.xlsx`;
let xlsx: Buffer;
let path: string;
const request = (format: string, stream = true) => GET(new NextRequest(`https://fixture.example/download?format=${format}&stream=${stream ? 1 : 0}`), { params: Promise.resolve({ id: jobId }) });

beforeEach(async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("ملخص المهمة").addRow(["المرحلة"]);
  const sheet = workbook.addWorksheet("الأشخاص");
  sheet.addRows([["الاسم"], ["الأول"], ["الثاني"]]);
  xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const sha = createHash("sha256").update(xlsx).digest("hex");
  path = `${userId}/${jobId}/sealed/${sha}/result.xlsx`;
  const files = [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx", sha256: sha, download_name: `${name}.xlsx` },
    { name: "result.csv", path: "result/result.csv", kind: "csv", download_name: `${name}.csv` }];
  state.customer = userId;
  state.signed = [];
  state.job = { id: jobId, user_id: userId, endpoint_id: "agent-mission", status: "failed", delivered_units: 0, charged_credits: 0 };
  state.mission = { id: missionId, user_id: userId, delivered_units: 2, files };
  state.receipt = { error: null, data: { mission_id: missionId, user_id: userId, xlsx_path: path, xlsx_sha: sha, physical_units: 2, binding: { files } } };
  state.objects = new Map([
    [`results/${path}`, xlsx], [`agent-missions/${missionId}/result/result.xlsx`, xlsx],
    [`results/${legacy}`, Buffer.from("an untrusted fallback object")],
  ]);
});

describe("the paid artifact is the only source for a sealed download", () => {
  it("serves the receipt's XLSX and CSV even when the physical rows were free", async () => {
    const stream = await request("xlsx");
    expect(stream.status).toBe(200);
    expect(Buffer.from(await stream.arrayBuffer())).toEqual(xlsx);
    expect(fileNameFromDisposition(stream.headers.get("content-disposition"))).toBe(`${name}.xlsx`);
    expect(await (await request("xlsx", false)).json()).toMatchObject({ success: true, signedUrl: `https://fixture.example/${path}` });
    const csv = await request("csv");
    expect(csv.status).toBe(200);
    expect((await csv.text()).trim().split(/\r?\n/)).toHaveLength(3);
    expect(fileNameFromDisposition(csv.headers.get("content-disposition"))).toBe(`${name}.csv`);
  });

  it.each(["bad digest", "missing", "read error"] as const)("a sealed %s refuses fallback", async (failure) => {
    if (failure === "read error") state.receipt = { data: null, error: new Error("database unavailable") };
    if (failure === "missing") state.objects.delete(`results/${path}`);
    if (failure === "bad digest") state.objects.set(`results/${path}`, Buffer.from("damaged file"));
    expect((await request("xlsx", false)).status).toBe(404);
    expect(state.signed).toEqual([]);
    if (failure !== "bad digest") return;
    state.objects.set(`agent-missions/${missionId}/result/result.xlsx`, Buffer.from("different bytes"));
    const input = { id: missionId, userId };
    expect(await customerFileLink(createAdminClient(), { ...input, name: "result.xlsx" })).toMatchObject({ ok: false });
    expect(await customerCsvFile(createAdminClient(), { ...input, name: "result.csv" })).toMatchObject({ ok: false });
    expect(state.signed).toEqual([]);
  });

  it("authorizes the job owner before looking up the receipt", async () => {
    state.customer = "customer-b";
    expect((await request("xlsx", false)).status).toBe(403);
    expect(state.signed).toEqual([]);
  });

  it("a positively absent receipt preserves the historical artifact link", async () => {
    state.receipt = { data: null, error: null };
    state.job = { ...state.job, status: "completed", delivered_units: 2, charged_credits: 2 };
    expect(await (await request("xlsx", false)).json()).toMatchObject({ success: true, signedUrl: `https://fixture.example/${legacy}` });
  });
});
