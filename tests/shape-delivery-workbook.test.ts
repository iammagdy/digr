import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DELIVERED_SHAPE_MAX_BYTES,
  isSealedWorkbook,
  readDeliveredWorkbook,
} from "@/lib/agentMission/deliveredWorkbook";
import { customerCsvFile } from "@/lib/agentMission/customerActions";
import { AGENT_BUCKET } from "@/lib/agentMission/constants";

function createMockClient(options: {
  mission?: any;
  storageData?: Buffer | null;
  storageError?: any;
  onStorageDownload?: (path: string) => void;
}) {
  const { mission, storageData, storageError, onStorageDownload } = options;

  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_col1: string, val1: any) => ({
          eq: (_col2: string, val2: any) => ({
            maybeSingle: async () => {
              if (
                mission &&
                ((mission.job_id === val1 && mission.user_id === val2) ||
                  (mission.id === val1 && mission.user_id === val2))
              ) {
                return { data: mission, error: null };
              }
              return { data: null, error: null };
            },
          }),
          maybeSingle: async () => {
            if (mission && (mission.id === val1 || mission.job_id === val1)) {
              return { data: mission, error: null };
            }
            return { data: null, error: null };
          },
        }),
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          if (onStorageDownload) onStorageDownload(path);
          if (storageError) return { data: null, error: storageError };
          if (!storageData) return { data: null, error: { message: "not found", status: 404 } };
          return {
            data: {
              arrayBuffer: async () => storageData.buffer.slice(storageData.byteOffset, storageData.byteOffset + storageData.byteLength),
            },
            error: null,
          };
        },
      }),
    },
  };
}

describe("deliveredWorkbook (P2 / T2)", () => {
  const testBytes = Buffer.from("PK\x03\x04mock xlsx content for testing");
  const testSha256 = createHash("sha256").update(testBytes).digest("hex");

  it("unsealed workbook delivers successfully", async () => {
    const job = { id: "job_unsealed", user_id: "user_a", status: "completed", charged_credits: 5 };
    const mission = {
      id: "msn_unsealed",
      user_id: "user_a",
      job_id: "job_unsealed",
      files: [{ name: "report.xlsx", path: "export/report.xlsx", kind: "xlsx" }],
    };

    const client = createMockClient({ mission, storageData: testBytes });
    const result = await readDeliveredWorkbook(client, { job });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sealed).toBe(false);
      expect(result.bytes.equals(testBytes)).toBe(true);
      expect(result.mission.id).toBe("msn_unsealed");
    }
  });

  it("sealed workbook delivers successfully when hash matches", async () => {
    const job = { id: "job_sealed", user_id: "user_a", status: "done", chargedCredits: 10 };
    const mission = {
      id: "msn_sealed",
      user_id: "user_a",
      job_id: "job_sealed",
      files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx", sha256: testSha256 }],
    };

    const client = createMockClient({ mission, storageData: testBytes });
    const result = await readDeliveredWorkbook(client, { job });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sealed).toBe(true);
      expect(result.bytes.equals(testBytes)).toBe(true);
    }
  });

  it("sealed workbook with one flipped byte returns hash_mismatch and never returns bytes (M2)", async () => {
    const job = { id: "job_tampered", user_id: "user_a", status: "completed", charged_credits: 5 };
    const mission = {
      id: "msn_tampered",
      user_id: "user_a",
      job_id: "job_tampered",
      files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx", sha256: testSha256 }],
    };

    const corruptedBytes = Buffer.from(testBytes);
    corruptedBytes[0] = corruptedBytes[0] ^ 0xff; // flip one byte

    const client = createMockClient({ mission, storageData: corruptedBytes });
    const result = await readDeliveredWorkbook(client, { job });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hash_mismatch");
      expect((result as any).bytes).toBeUndefined();
    }
  });

  it("sealed workbook with descriptor not matching sealed shape returns hash_mismatch", async () => {
    const job = { id: "job_bad_desc", user_id: "user_a", status: "completed", charged_credits: 5 };
    const mission = {
      id: "msn_bad_desc",
      user_id: "user_a",
      job_id: "job_bad_desc",
      // Name or path is not result.xlsx / result/result.xlsx
      files: [{ name: "other.xlsx", path: "custom/other.xlsx", kind: "xlsx", sha256: testSha256 }],
    };

    const client = createMockClient({ mission, storageData: testBytes });
    const result = await readDeliveredWorkbook(client, { job });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hash_mismatch");
    }
  });

  it("other user's mission returns not_found and storage is never touched", async () => {
    const storageSpy = vi.fn();
    const job = { id: "job_other", user_id: "user_attacker", status: "completed", charged_credits: 5 };
    const mission = {
      id: "msn_other",
      user_id: "user_victim",
      job_id: "job_other",
      files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }],
    };

    const client = createMockClient({ mission, storageData: testBytes, onStorageDownload: storageSpy });
    const result = await readDeliveredWorkbook(client, { job });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
    expect(storageSpy).not.toHaveBeenCalled();
  });

  it("empty files array returns not_found", async () => {
    const job = { id: "job_empty_files", user_id: "user_a", status: "completed", charged_credits: 5 };
    const mission = {
      id: "msn_empty_files",
      user_id: "user_a",
      job_id: "job_empty_files",
      files: [],
    };

    const client = createMockClient({ mission, storageData: testBytes });
    const result = await readDeliveredWorkbook(client, { job });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("storage 404 returns not_found; storage 500 returns storage", async () => {
    const job = { id: "job_storage", user_id: "user_a", status: "completed", charged_credits: 5 };
    const mission = {
      id: "msn_storage",
      user_id: "user_a",
      job_id: "job_storage",
      files: [{ name: "report.xlsx", path: "export/report.xlsx", kind: "xlsx" }],
    };

    // 404
    const client404 = createMockClient({ mission, storageError: { status: 404, message: "Object not found" } });
    const res404 = await readDeliveredWorkbook(client404, { job });
    expect(res404.ok).toBe(false);
    if (!res404.ok) expect(res404.reason).toBe("not_found");

    // 500
    const client500 = createMockClient({ mission, storageError: { status: 500, message: "Internal server error" } });
    const res500 = await readDeliveredWorkbook(client500, { job });
    expect(res500.ok).toBe(false);
    if (!res500.ok) expect(res500.reason).toBe("storage");
  });

  it("not_released job (failed with 0 rows or unsettled) returns not_released", async () => {
    const jobFailed = { id: "job_f", user_id: "user_a", status: "failed", delivered_units: 0, charged_credits: 0 };
    const client = createMockClient({ storageData: testBytes });
    const resFailed = await readDeliveredWorkbook(client, { job: jobFailed });
    expect(resFailed.ok).toBe(false);
    if (!resFailed.ok) expect(resFailed.reason).toBe("not_released");

    const jobUncharged = { id: "job_u", user_id: "user_a", status: "running", charged_credits: 0 };
    const resUncharged = await readDeliveredWorkbook(client, { job: jobUncharged });
    expect(resUncharged.ok).toBe(false);
    if (!resUncharged.ok) expect(resUncharged.reason).toBe("not_released");
  });

  it("exceeding DELIVERED_SHAPE_MAX_BYTES returns too_large", async () => {
    const job = { id: "job_large", user_id: "user_a", status: "completed", charged_credits: 5 };
    const mission = {
      id: "msn_large",
      user_id: "user_a",
      job_id: "job_large",
      files: [{ name: "report.xlsx", path: "export/report.xlsx", kind: "xlsx" }],
    };

    const bigBytes = Buffer.alloc(DELIVERED_SHAPE_MAX_BYTES + 10);
    const client = createMockClient({ mission, storageData: bigBytes });
    const result = await readDeliveredWorkbook(client, { job });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("too_large");
    }
  });

  it("addon mission is excluded by hasAddonMarker and returns not_found (Gate 1 item 3)", async () => {
    const job = { id: "job_addon", user_id: "user_a", status: "completed", charged_credits: 5 };
    const mission = {
      id: "msn_addon",
      user_id: "user_a",
      job_id: "job_addon",
      plan: { addon: { kind: "review" } },
      files: [{ name: "report.xlsx", path: "export/report.xlsx", kind: "xlsx" }],
    };

    const client = createMockClient({ mission, storageData: testBytes });
    const result = await readDeliveredWorkbook(client, { job });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("PARITY: readDeliveredWorkbook accepts/refuses on same boundary conditions as customerCsvFile", async () => {
    // Both accept valid unsealed
    const job = { id: "job_p", user_id: "user_a", status: "completed", charged_credits: 5 };
    const mission = {
      id: "msn_p",
      user_id: "user_a",
      job_id: "job_p",
      files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }],
    };
    // valid fake xlsx with header row
    const client = createMockClient({ mission, storageData: testBytes });

    const rdwRes = await readDeliveredWorkbook(client, { job });
    expect(rdwRes.ok).toBe(true);

    // Both reject when mission is missing / 404
    const clientMissing = createMockClient({ mission: null });
    const rdwMissing = await readDeliveredWorkbook(clientMissing, { job });
    const csvMissing = await customerCsvFile(clientMissing, { id: "msn_p", userId: "user_a", name: "result.csv" });
    expect(rdwMissing.ok).toBe(false);
    expect(csvMissing.ok).toBe(false);
    expect(rdwMissing.ok ? "" : rdwMissing.reason).toBe("not_found");
    expect(csvMissing.ok ? 0 : csvMissing.status).toBe(404);

    // Both reject when sealed hash mismatches
    const sealedMission = {
      id: "msn_sealed_parity",
      user_id: "user_a",
      job_id: "job_p",
      files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx", sha256: testSha256 }],
    };
    const corrupted = Buffer.from(testBytes);
    corrupted[1] = corrupted[1] ^ 0xff;
    const clientCorrupt = createMockClient({ mission: sealedMission, storageData: corrupted });
    const rdwCorrupt = await readDeliveredWorkbook(clientCorrupt, { job });
    const csvCorrupt = await customerCsvFile(clientCorrupt, { id: "msn_sealed_parity", userId: "user_a", name: "result.csv" });
    expect(rdwCorrupt.ok).toBe(false);
    expect(csvCorrupt.ok).toBe(false);
    expect(rdwCorrupt.ok ? "" : rdwCorrupt.reason).toBe("hash_mismatch");
    expect(csvCorrupt.ok ? 0 : csvCorrupt.status).toBe(500);

    // Both reject storage 500
    const clientStorageErr = createMockClient({ mission: sealedMission, storageError: { status: 500, message: "Storage down" } });
    const rdwStorage = await readDeliveredWorkbook(clientStorageErr, { job });
    const csvStorage = await customerCsvFile(clientStorageErr, { id: "msn_sealed_parity", userId: "user_a", name: "result.csv" });
    expect(rdwStorage.ok).toBe(false);
    expect(csvStorage.ok).toBe(false);
    expect(rdwStorage.ok ? "" : rdwStorage.reason).toBe("storage");
    expect(csvStorage.ok ? 0 : csvStorage.status).toBe(502);
  });
});
