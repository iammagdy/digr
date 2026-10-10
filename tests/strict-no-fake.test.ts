import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeMultiStepJob, parseTikTokProfileResponse } from "../src/functions/shared/multiStepWorker";

describe("Strict No-Fake Guard and Data Integrity Suite", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  function createMockTables() {
    const jobStore: Record<string, any> = {
      job_test_1: {
        $id: "job_test_1",
        status: "queued",
        reservedCredits: 5,
        userId: "user_test_1",
      },
    };
    const ledgerStore: any[] = [];
    const internalStore: Record<string, any> = {};

    return {
      getRow: async ({ rowId }: any) => jobStore[rowId] || { status: "running" },
      updateRow: async ({ rowId, data }: any) => {
        jobStore[rowId] = { ...(jobStore[rowId] || {}), ...data };
        return jobStore[rowId];
      },
      createRow: async ({ tableId, rowId, data }: any) => {
        if (tableId === "credit_ledger") {
          ledgerStore.push({ $id: rowId, ...data });
        } else if (tableId === "jobs_internal") {
          internalStore[data.jobId] = { $id: rowId, ...data };
        }
        return { $id: rowId, ...data };
      },
      listRows: async ({ tableId, queries }: any) => {
        if (tableId === "credit_ledger") {
          return { rows: ledgerStore, total: ledgerStore.length };
        }
        if (tableId === "jobs_internal") {
          return { rows: Object.values(internalStore), total: Object.values(internalStore).length };
        }
        return { rows: [], total: 0 };
      },
      _stores: { jobStore, ledgerStore, internalStore },
    };
  }

  it("Test 1: A job with dataSource=fake cannot complete in production environment and gets 100% refund", async () => {
    process.env.NODE_ENV = "production";
    const tables = createMockTables();

    const result = await executeMultiStepJob(tables as any, null, {
      jobId: "job_test_1",
      targetVolumeMax: 1,
      unitPricePoints: 1,
      reservedCredits: 5,
      userId: "user_test_1",
      templateSlug: "tiktok-profile",
      params: { username: "iam_megz" },
      isTestMode: true, // test mode in production must be refused!
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.deliveredUnits).toBe(0);
    expect(result.chargedCredits).toBe(0);
    expect(result.refundCredits).toBe(5);
    expect(result.errorAr).toContain("الإنتاج");

    // Check ledger release
    const releaseEntry = tables._stores.ledgerStore.find((l) => l.type === "release");
    expect(releaseEntry).toBeDefined();
    expect(releaseEntry.delta).toBe(5);
  });

  it("Test 2: A job cannot output placeholder text (e.g. 'Record 1 for...') and fails with 100% refund", async () => {
    process.env.NODE_ENV = "development";
    const tables = createMockTables();

    const placeholderFetcher = async () => ({
      ok: true,
      httpStatus: 200,
      items: [
        { id: "1", title: "Record 1 for tiktok-profile" },
      ],
      costMicro: 1000,
    });

    const result = await executeMultiStepJob(tables as any, null, {
      jobId: "job_test_1",
      targetVolumeMax: 1,
      unitPricePoints: 1,
      reservedCredits: 5,
      userId: "user_test_1",
      templateSlug: "tiktok-profile",
      params: { username: "iam_megz" },
      fetchPageFn: placeholderFetcher,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.deliveredUnits).toBe(0);
    expect(result.chargedCredits).toBe(0);
    expect(result.refundCredits).toBe(5);
    expect(result.errorAr).toContain("غير حقيقية");

    // Check ledger release
    const releaseEntry = tables._stores.ledgerStore.find((l) => l.type === "release");
    expect(releaseEntry).toBeDefined();
    expect(releaseEntry.delta).toBe(5);
  });

  it("Test 3: parseTikTokProfileResponse correctly extracts real TikHub structure", () => {
    const rawTikHubResponse = {
      code: 200,
      msg: "success",
      data: {
        userInfo: {
          user: {
            id: "123456789",
            uniqueId: "iam_megz",
            nickname: "Ahmed Megz",
            signature: "Tech creator & Software enthusiast",
            verified: true,
            avatarLarger: { urlList: ["https://p16-sign.tiktokcdn.com/avatar1.jpg"] },
            bioLink: { link: "https://thewise.cloud" },
          },
          stats: {
            followerCount: 25400,
            followingCount: 320,
            heartCount: 450000,
            videoCount: 88,
          },
        },
      },
    };

    const parsed = parseTikTokProfileResponse(rawTikHubResponse, "iam_megz");
    expect(parsed).not.toBeNull();
    expect(parsed?.uniqueId).toBe("iam_megz");
    expect(parsed?.nickname).toBe("Ahmed Megz");
    expect(parsed?.signature).toBe("Tech creator & Software enthusiast");
    expect(parsed?.verified).toBe(true);
    expect(parsed?.followerCount).toBe(25400);
    expect(parsed?.followingCount).toBe(320);
    expect(parsed?.heartCount).toBe(450000);
    expect(parsed?.videoCount).toBe(88);
    expect(parsed?.avatarUrl).toBe("https://p16-sign.tiktokcdn.com/avatar1.jpg");
    expect(parsed?.bioLink).toBe("https://thewise.cloud");
    expect(parsed?.profileUrl).toBe("https://www.tiktok.com/@iam_megz");
  });
});
