import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadLatestResultColumns } from "@/lib/server/savedResultColumns";
import { AGENT_BUCKET, MISSION_TABLE } from "@/lib/agentMission/constants";

describe("shape-delivery-columns (P4 / T4)", () => {
  let workbookBytes: Buffer;

  beforeAll(async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary");
    const ws = wb.addWorksheet("Data");
    ws.addRow(["اسم الشركة", "المدينة", "الموقع"]);
    ws.addRow(["شركة النيل", "القاهرة", "https://nile.example"]);
    workbookBytes = Buffer.from(await wb.xlsx.writeBuffer());
  });

  const dataset = JSON.stringify({
    rows: [{ company_name: "الشركة العربية", website: "https://example.org", location: "القاهرة، مصر", industry: "كهرباء" }],
    metadata: {},
  });

  function createMockAdmin(options: {
    jobs?: any[];
    missions?: any[];
    storageFiles?: Record<string, Buffer | string>;
    storageError?: any;
  }) {
    const jobs = options.jobs || [];
    const missions = options.missions || [];
    const storageFiles = options.storageFiles || {};

    return {
      from: (table: string) => {
        const filters: Array<[string, any]> = [];
        const inFilters: Array<[string, any[]]> = [];
        const b: any = {
          select: () => b,
          eq: (c: string, v: any) => {
            filters.push([c, v]);
            return b;
          },
          in: (c: string, v: any[]) => {
            inFilters.push([c, v]);
            return b;
          },
          order: () => b,
          limit: () => b,
          maybeSingle: async () => {
            if (table === "jobs") {
              const match = jobs.find(
                (j) =>
                  filters.every(([c, v]) => j[c] === v) &&
                  inFilters.every(([c, v]) => v.includes(j[c]))
              );
              return { data: match || null, error: null };
            }
            if (table === MISSION_TABLE || table === "missions") {
              const match = missions.find(
                (m) =>
                  filters.every(([c, v]) => m[c] === v) &&
                  inFilters.every(([c, v]) => v.includes(m[c]))
              );
              return { data: match || null, error: null };
            }
            return { data: null, error: null };
          },
        };
        return b;
      },
      storage: {
        from: (bucket: string) => ({
          download: async (path: string) => {
            if (options.storageError) return { data: null, error: options.storageError };
            const key = `${bucket}/${path}`;
            const file = storageFiles[key];
            if (!file) return { data: null, error: { message: "not found", status: 404 } };
            return {
              data: {
                text: async () => (Buffer.isBuffer(file) ? file.toString("utf-8") : String(file)),
                arrayBuffer: async () =>
                  Buffer.isBuffer(file)
                    ? file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
                    : Buffer.from(String(file)).buffer,
              },
              error: null,
            };
          },
        }),
      },
    };
  }

  it("agent job, no data.json → reads header columns from delivered workbook (M1)", async () => {
    const job = {
      id: "job_agent_1",
      user_id: "u1",
      conversation_id: "c1",
      status: "completed",
      charged_credits: 5,
      endpoint_id: "agent-mission",
    };
    const mission = {
      id: "msn_agent_1",
      user_id: "u1",
      job_id: "job_agent_1",
      files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }],
    };

    const admin = createMockAdmin({
      jobs: [job],
      missions: [mission],
      storageFiles: {
        [`${AGENT_BUCKET}/msn_agent_1/result/result.xlsx`]: workbookBytes,
      },
    });

    const res = await loadLatestResultColumns(admin, { conversationId: "c1", userId: "u1" });
    expect(res.jobId).toBe("job_agent_1");
    expect(res.columns).toEqual([
      { key: "col_1", titleAr: "اسم الشركة" },
      { key: "col_2", titleAr: "المدينة" },
      { key: "col_3", titleAr: "الموقع" },
    ]);
  });

  it("legacy job → exactly today's columns from data.json (C3, matches file-shaping-after-job)", async () => {
    const job = {
      id: "job_legacy_1",
      user_id: "u1",
      conversation_id: "c1",
      status: "completed",
      template_slug: "companies",
      endpoint_id: "icypeas.companies.search",
      platform: "companies",
    };

    const admin = createMockAdmin({
      jobs: [job],
      storageFiles: {
        "results/u1/job_legacy_1/data.json": dataset,
      },
    });

    const res = await loadLatestResultColumns(admin, { conversationId: "c1", userId: "u1" });
    expect(res.jobId).toBe("job_legacy_1");
    expect(res.columns.map((c) => c.key)).toEqual(
      expect.arrayContaining(["company_name", "website", "location"])
    );
    expect(res.columns.find((c) => c.key === "location")?.titleAr).toBe("المقر والنطاق الجغرافي");
  });

  it("sealed mismatch → returns empty columns array { jobId, columns: [] } (M2)", async () => {
    const mismatchSha = "a".repeat(64); // Does not match workbookBytes
    const job = {
      id: "job_sealed_1",
      user_id: "u1",
      conversation_id: "c1",
      status: "completed",
      charged_credits: 5,
      endpoint_id: "agent-mission",
    };
    const mission = {
      id: "msn_sealed_1",
      user_id: "u1",
      job_id: "job_sealed_1",
      files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx", sha256: mismatchSha }],
    };

    const admin = createMockAdmin({
      jobs: [job],
      missions: [mission],
      storageFiles: {
        [`${AGENT_BUCKET}/msn_sealed_1/result/result.xlsx`]: workbookBytes,
      },
    });

    const res = await loadLatestResultColumns(admin, { conversationId: "c1", userId: "u1" });
    expect(res.jobId).toBe("job_sealed_1");
    expect(res.columns).toEqual([]);
  });

  it("read failure (missing file or storage error) → returns empty columns without throwing", async () => {
    const job = {
      id: "job_err_1",
      user_id: "u1",
      conversation_id: "c1",
      status: "completed",
      charged_credits: 5,
      endpoint_id: "agent-mission",
    };
    const mission = {
      id: "msn_err_1",
      user_id: "u1",
      job_id: "job_err_1",
      files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }],
    };

    // Storage 500 failure
    const adminFail = createMockAdmin({
      jobs: [job],
      missions: [mission],
      storageError: { message: "Internal Server Error", status: 500 },
    });

    const resFail = await loadLatestResultColumns(adminFail, { conversationId: "c1", userId: "u1" });
    expect(resFail.jobId).toBe("job_err_1");
    expect(resFail.columns).toEqual([]);

    // Missing mission
    const adminNoMission = createMockAdmin({ jobs: [job] });
    const resNoMission = await loadLatestResultColumns(adminNoMission, { conversationId: "c1", userId: "u1" });
    expect(resNoMission.jobId).toBe("job_err_1");
    expect(resNoMission.columns).toEqual([]);

    // Null admin client
    const resNull = await loadLatestResultColumns(null, { conversationId: "c1", userId: "u1" });
    expect(resNull).toEqual({ jobId: null, columns: [] });
  });
});
