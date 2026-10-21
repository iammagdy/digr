import { describe, it, expect, beforeEach } from "vitest";
import {
  computePlanHash,
  applyPlanOperations,
  validatePlanAgainstSchemas,
  createAndSaveManagedQuote,
  PlanState,
  EditPlanOperation,
} from "../src/functions/shared/planManager";
import { acceptQuote, MAX_CONCURRENT_JOBS_PER_USER } from "../src/functions/shared/quoteAccept";
import {
  executeMultiStepJob,
  runJobWatchdog,
  PageFetchResult,
} from "../src/functions/shared/multiStepWorker";
import {
  calculateBalance,
  reserveCredits,
  releaseCredits,
  chargeCredits,
  applyTopup,
} from "../src/functions/shared/ledger";
import { calculateFinalSettlement, DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";
import { Capability } from "../src/functions/shared/capabilityRegistry";

interface StoredRow {
  $id: string;
  data: Record<string, any>;
  permissions: any[];
}

/**
 * In-memory Mock of Appwrite TablesDB adhering to deterministic row IDs,
 * pagination (limit & offset), query filtering, and 409 conflict on duplicate IDs.
 */
class MockTablesDB {
  public rows: Map<string, StoredRow> = new Map();

  async createRow({
    databaseId,
    tableId,
    rowId,
    data,
    permissions,
  }: {
    databaseId: string;
    tableId: string;
    rowId: string;
    data: Record<string, any>;
    permissions?: any[];
  }) {
    const key = `${tableId}:${rowId}`;
    if (this.rows.has(key)) {
      const err: any = new Error(`Row with ID ${rowId} already exists in ${tableId}`);
      err.code = 409;
      err.status = 409;
      throw err;
    }
    const record: StoredRow = {
      $id: rowId,
      data: { ...data, $id: rowId },
      permissions: permissions || [],
    };
    this.rows.set(key, record);
    return record.data;
  }

  async listRows({
    databaseId,
    tableId,
    queries = [],
  }: {
    databaseId: string;
    tableId: string;
    queries?: any[];
  }) {
    const prefix = `${tableId}:`;
    let items = Array.from(this.rows.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v.data);

    for (const q of queries) {
      if (typeof q === "string") {
        try {
          const parsed = JSON.parse(q);
          const method = parsed.method;
          const attr = parsed.attribute;
          const vals = parsed.values;

          if (method === "equal") {
            items = items.filter((it) => {
              if (Array.isArray(vals[0])) {
                return vals[0].includes(it[attr]);
              }
              return vals.includes(it[attr]);
            });
          } else if (method === "lessThan") {
            items = items.filter((it) => it[attr] < vals[0]);
          } else if (method === "limit") {
            items = items.slice(0, vals[0]);
          }
        } catch {
          // ignore custom mock parse
        }
      }
    }

    return { total: items.length, rows: items };
  }

  async getRow({ databaseId, tableId, rowId }: { databaseId: string; tableId: string; rowId: string }) {
    const key = `${tableId}:${rowId}`;
    const found = this.rows.get(key);
    if (!found) {
      const err: any = new Error(`Row ${rowId} not found in ${tableId}`);
      err.code = 404;
      err.status = 404;
      throw err;
    }
    return found.data;
  }

  async updateRow({
    databaseId,
    tableId,
    rowId,
    data,
  }: {
    databaseId: string;
    tableId: string;
    rowId: string;
    data: Record<string, any>;
  }) {
    const key = `${tableId}:${rowId}`;
    const found = this.rows.get(key);
    if (!found) {
      const err: any = new Error(`Row ${rowId} not found for update`);
      err.code = 404;
      err.status = 404;
      throw err;
    }
    found.data = { ...found.data, ...data };
    this.rows.set(key, found);
    return found.data;
  }
}

describe("P2: Execution, Multi-Step Worker, and Editable Plans Test Suite", () => {
  let tables: MockTablesDB;
  const userId = "usr_test_p2";

  const testCapability: Capability = {
    slug: "tiktok-profile",
    category: "tiktok",
    nameAr: "استخراج ملف تيك توك الشخصي",
    nameEn: "TikTok User Profile",
    descriptionAr: "استخراج الإحصائيات الشاملة",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { username: { type: "string" } },
      required: ["username"],
    }),
    tregEndpointId: "secret.endpoint.tiktok",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.0012,
    maxRows: 1000,
    paginationType: "none",
    enabled: true,
  };

  const multiPageCapability: Capability = {
    slug: "x-keyword-search",
    category: "x",
    nameAr: "البحث في تغريدات منصة X",
    nameEn: "X Keyword Search",
    descriptionAr: "استخراج التغريدات العامة",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { query: { type: "string" }, count: { type: "number" } },
      required: ["query"],
    }),
    tregEndpointId: "secret.endpoint.twitter",
    tregMethod: "GET",
    pricingUnit: "item",
    unitCostUsd: 0.0005,
    maxRows: 1000,
    paginationType: "cursor",
    enabled: true,
  };

  beforeEach(async () => {
    tables = new MockTablesDB();
    // Fund user with 200 points
    await applyTopup(tables as any, userId, "top_p2_init", 200, "شحن رصيد اختباري");
  });

  // ================= 1. Multi-Page Runs =================
  it("Scenario 1: Multi-page runs (page 1, 2, 3...) accumulating rows up to targetVolumeMax", async () => {
    const targetVolumeMax = 250;
    const unitPricePoints = 0.1;
    const reservedCredits = 30; // 25 + buffer

    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: "job_multipage",
      data: {
        userId,
        templateSlug: "x-keyword-search",
        params: JSON.stringify({ query: "AI News" }),
        status: "queued",
        estCredits: 25,
        reservedCredits,
      },
    });

    let pagesFetched = 0;
    const mockFetcher = async (cursor: string | null, page: number): Promise<PageFetchResult> => {
      pagesFetched++;
      const pageSize = 100;
      const currentCount = (page - 1) * pageSize;
      const items = Array.from({ length: Math.min(pageSize, targetVolumeMax - currentCount) }, (_, i) => ({
        id: `tweet_${page}_${i}`,
        text: `Tweet content ${currentCount + i + 1}`,
      }));

      return {
        ok: true,
        httpStatus: 200,
        items,
        nextCursor: currentCount + items.length >= targetVolumeMax ? null : `cursor_page_${page + 1}`,
        costMicro: 500,
      };
    };

    const result = await executeMultiStepJob(tables as any, null, {
      jobId: "job_multipage",
      targetVolumeMax,
      unitPricePoints,
      reservedCredits,
      userId,
      templateSlug: "x-keyword-search",
      params: { query: "AI News" },
      fetchPageFn: mockFetcher,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("done");
    expect(result.deliveredUnits).toBe(250);
    expect(pagesFetched).toBe(3); // 100 + 100 + 50 = 3 pages

    // Verify progress events recorded in job_events
    const events = await tables.listRows({ databaseId: "digr", tableId: "job_events" });
    expect(events.rows.length).toBeGreaterThanOrEqual(3);
  });

  // ================= 2. Partial Delivery (420 of 500) =================
  it("Scenario 2: Partial delivery (requested 500, delivered 420) with exact formula and refund", async () => {
    // Quote: requested 500 units @ 0.1 points/unit
    // Reserve: ceil(500 * 0.1 * 1.15) = ceil(57.5) = 58 points (or 51 with 2% margin)
    const targetVolumeMax = 500;
    const unitPricePoints = 0.1;
    const reservedCredits = 58;

    await reserveCredits(tables as any, userId, "job_partial_420", reservedCredits, "حجز رصيد مبدئي مع هامش أمان");

    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: "job_partial_420",
      data: {
        userId,
        templateSlug: "x-keyword-search",
        params: JSON.stringify({ query: "Data" }),
        status: "queued",
        estCredits: 50,
        reservedCredits,
      },
    });

    // Mock upstream stream delivering only 420 items then stream ends (no more pages)
    const mockFetcher = async (cursor: string | null, page: number): Promise<PageFetchResult> => {
      if (page === 1) {
        return {
          ok: true,
          httpStatus: 200,
          items: Array.from({ length: 300 }, (_, i) => ({ id: `it_${i}` })),
          nextCursor: "cursor_p2",
        };
      }
      return {
        ok: true,
        httpStatus: 200,
        items: Array.from({ length: 120 }, (_, i) => ({ id: `it_p2_${i}` })),
        nextCursor: null, // End of data
      };
    };

    const result = await executeMultiStepJob(tables as any, null, {
      jobId: "job_partial_420",
      targetVolumeMax,
      unitPricePoints,
      reservedCredits,
      userId,
      templateSlug: "x-keyword-search",
      params: { query: "Data" },
      fetchPageFn: mockFetcher,
    });

    expect(result.success).toBe(true);
    expect(result.deliveredUnits).toBe(420);

    // Exact settlement formula check:
    // charge = ceil(420 * 0.1) = 42 points. Safety buffer is NOT charged.
    expect(result.chargedCredits).toBe(42);
    // Refund = 58 - 42 = 16 points.
    expect(result.refundCredits).toBe(16);

    // Verify deterministic ledger records: rel_job_partial_420 and chg_job_partial_420
    const relDoc = await tables.getRow({ databaseId: "digr", tableId: "credit_ledger", rowId: "rel_job_partial_420" });
    expect(relDoc.delta).toBe(58); // Full reserve released first

    const chgDoc = await tables.getRow({ databaseId: "digr", tableId: "credit_ledger", rowId: "chg_job_partial_420" });
    expect(chgDoc.delta).toBe(-42); // Only actual delivered charged
  });

  // ================= 3. Cancel Mid-Job =================
  it("Scenario 3: Cancel mid-job halts execution and settles partial delivery", async () => {
    const jobId = "job_cancel_mid";
    const targetVolumeMax = 300;
    const reservedCredits = 35;
    const unitPricePoints = 0.1;

    await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز رصيد");

    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: {
        userId,
        templateSlug: "x-keyword-search",
        params: "{}",
        status: "queued",
        reservedCredits,
      },
    });

    let pageCallCount = 0;
    const mockFetcher = async (cursor: string | null, page: number): Promise<PageFetchResult> => {
      pageCallCount++;
      if (page === 1) {
        // After page 1, user cancels the job externally
        await tables.updateRow({
          databaseId: "digr",
          tableId: "jobs",
          rowId: jobId,
          data: { status: "cancelled" },
        });
        return {
          ok: true,
          httpStatus: 200,
          items: Array.from({ length: 100 }, (_, i) => ({ id: `c_${i}` })),
          nextCursor: "cursor_p2",
        };
      }
      return {
        ok: true,
        httpStatus: 200,
        items: Array.from({ length: 100 }, (_, i) => ({ id: `c_p2_${i}` })),
        nextCursor: "cursor_p3",
      };
    };

    const result = await executeMultiStepJob(tables as any, null, {
      jobId,
      targetVolumeMax,
      unitPricePoints,
      reservedCredits,
      userId,
      templateSlug: "x-keyword-search",
      params: {},
      fetchPageFn: mockFetcher,
    });

    expect(result.status).toBe("cancelled");
    expect(result.deliveredUnits).toBe(100);
    // Charged for 100 delivered = ceil(100 * 0.1) = 10 points
    expect(result.chargedCredits).toBe(10);
    expect(result.refundCredits).toBe(25); // 35 - 10
  });

  // ================= 4. Worker Crash / Watchdog Recovery =================
  it("Scenario 4: Worker crash watchdog recovery releases full reserve for abandoned jobs", async () => {
    const staleJobId = "job_stale_crashed";
    const reservedCredits = 40;

    await reserveCredits(tables as any, userId, staleJobId, reservedCredits, "حجز طلب متعثر");

    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000).toISOString();
    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: staleJobId,
      data: {
        userId,
        status: "running",
        reservedCredits,
        createdAt: twoHoursAgo,
      },
    });

    const balanceBefore = await calculateBalance(tables as any, userId);

    // Run watchdog with 30 min threshold
    const recoveryResult = await runJobWatchdog(tables as any, 30);

    expect(recoveryResult.recoveredCount).toBe(1);
    expect(recoveryResult.jobIds).toContain(staleJobId);

    // Verify job is marked as failed
    const jobDoc = await tables.getRow({ databaseId: "digr", tableId: "jobs", rowId: staleJobId });
    expect(jobDoc.status).toBe("failed");
    expect(jobDoc.errorAr).toContain("تجاوز المهلة الزمنية");

    // Verify full reserve released back to user
    const balanceAfter = await calculateBalance(tables as any, userId);
    expect(balanceAfter).toBe(balanceBefore + reservedCredits);
  });

  // ================= 5. route_max_cost 402 vs Platform Balance 402 =================
  it("Scenario 5: Distinguishes route_max_cost 402 (job fail) vs platform balance 402 (pause)", async () => {
    const jobIdA = "job_route_cost_402";
    const reservedCredits = 20;

    await reserveCredits(tables as any, userId, jobIdA, reservedCredits, "حجز طلب 1");
    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobIdA,
      data: { userId, status: "queued", reservedCredits },
    });

    // 1. route_max_cost error
    const routeCostResult = await executeMultiStepJob(tables as any, null, {
      jobId: jobIdA,
      targetVolumeMax: 100,
      unitPricePoints: 0.1,
      reservedCredits,
      userId,
      templateSlug: "tiktok-profile",
      params: {},
      fetchPageFn: async () => ({
        ok: false,
        httpStatus: 402,
        errorType: "route_max_cost",
        errorMessage: "route_max_cost cap exceeded for provider",
        items: [],
      }),
    });

    expect(routeCostResult.status).toBe("failed");
    expect(routeCostResult.errorAr).toContain("سقف التكلفة المسموح به");
    expect(routeCostResult.refundCredits).toBe(reservedCredits);

    // 2. platform balance error
    const jobIdB = "job_platform_balance_402";
    await reserveCredits(tables as any, userId, jobIdB, reservedCredits, "حجز طلب 2");
    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobIdB,
      data: { userId, status: "queued", reservedCredits },
    });

    const platformBalanceResult = await executeMultiStepJob(tables as any, null, {
      jobId: jobIdB,
      targetVolumeMax: 100,
      unitPricePoints: 0.1,
      reservedCredits,
      userId,
      templateSlug: "tiktok-profile",
      params: {},
      fetchPageFn: async () => ({
        ok: false,
        httpStatus: 402,
        errorType: "insufficient_balance",
        errorMessage: "upstream platform_balance empty",
        items: [],
      }),
    });

    expect(platformBalanceResult.status).toBe("failed");
    expect(platformBalanceResult.errorAr).toContain("الخدمة غير متاحة مؤقتاً");
  });

  // ================= 6. 429 Rate Limit Retry =================
  it("Scenario 6: 429 rate limit retries with backoff and succeeds on retry", async () => {
    const jobId = "job_rate_limit_retry";
    const reservedCredits = 15;

    await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز طلب");
    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: { userId, status: "queued", reservedCredits },
    });

    let attempts = 0;
    const retryFetcher = async (): Promise<PageFetchResult> => {
      attempts++;
      if (attempts === 1) {
        return {
          ok: false,
          httpStatus: 429,
          errorType: "rate_limit",
          errorMessage: "Rate limit exceeded, retry later",
          items: [],
        };
      }
      return {
        ok: true,
        httpStatus: 200,
        items: [{ id: "res_ok" }],
        nextCursor: null,
      };
    };

    const result = await executeMultiStepJob(tables as any, null, {
      jobId,
      targetVolumeMax: 1,
      unitPricePoints: 1,
      reservedCredits,
      userId,
      templateSlug: "tiktok-profile",
      params: {},
      fetchPageFn: retryFetcher,
    });

    expect(attempts).toBe(2);
    expect(result.success).toBe(true);
    expect(result.status).toBe("done");
    expect(result.deliveredUnits).toBe(1);
  });

  // ================= 7. 4xx Abort =================
  it("Scenario 7: 4xx client errors abort immediately without useless retries and refund reserve", async () => {
    const jobId = "job_4xx_abort";
    const reservedCredits = 10;

    await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز طلب");
    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: { userId, status: "queued", reservedCredits },
    });

    let callCount = 0;
    const errorFetcher = async (): Promise<PageFetchResult> => {
      callCount++;
      return {
        ok: false,
        httpStatus: 404,
        errorType: "client_error",
        errorMessage: "Target account not found",
        items: [],
      };
    };

    const result = await executeMultiStepJob(tables as any, null, {
      jobId,
      targetVolumeMax: 1,
      unitPricePoints: 1,
      reservedCredits,
      userId,
      templateSlug: "tiktok-profile",
      params: {},
      fetchPageFn: errorFetcher,
    });

    expect(callCount).toBe(1); // Aborted immediately, no retry
    expect(result.status).toBe("failed");
    expect(result.refundCredits).toBe(reservedCredits);
  });

  // ================= 8. Parallel Starts & Concurrency Guard =================
  it("Scenario 8: Enforces per-user concurrency limit and prevents parallel duplicate starts", async () => {
    // 1. Create 2 already active running jobs for this user
    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: "active_job_1",
      data: { userId, status: "running" },
    });
    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: "active_job_2",
      data: { userId, status: "queued" },
    });

    // Create a valid proposed quote
    const items = [{ capabilitySlug: "tiktok-profile", params: { username: "tiktok" }, targetVolumeMin: 1, targetVolumeMax: 1 }];
    const planHash = computePlanHash(items);

    await tables.createRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: "quote_concurrency_test",
      data: {
        userId,
        status: "proposed",
        itemsJson: JSON.stringify(items),
        targetVolumeMax: 1,
        quotedPoints: 10,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    });

    // Attempting to accept a 3rd job should be rejected by concurrency limit
    const acceptRes = await acceptQuote(tables as any, {
      userId,
      quoteId: "quote_concurrency_test",
      expectedPlanHash: planHash,
    });

    expect(acceptRes.success).toBe(false);
    expect(acceptRes.statusCode).toBe(429);
    expect(acceptRes.errorAr).toContain("الحد الأقصى");
  });

  // ================= 9. Editing Plan Sequentially =================
  it("Scenario 9: Sequential plan edits create new quotes and invalidate previous ones", async () => {
    const convId = "conv_edit_sequence";

    // 1. Initial Plan (100 rows)
    const initialPlan: PlanState = {
      summaryAr: "استخراج تغريدات",
      items: [{ capabilitySlug: "x-keyword-search", params: { query: "tech" }, targetVolumeMin: 1, targetVolumeMax: 100 }],
      outputFormats: ["xlsx", "pdf", "csv"],
    };

    const quote1 = await createAndSaveManagedQuote(tables as any, {
      conversationId: convId,
      userId,
      plan: initialPlan,
      userBalance: 200,
      capabilities: [multiPageCapability],
    });

    expect(quote1.targetVolumeMax).toBe(100);

    // 2. Edit 1: change limit to 3000 (3 points a record: the 5,000-point cap alone would hold 1,449; the provider's default daily limit,
    //    0.80 USD with a 10% margin, holds 0.72 / 0.0005 = 1,440 records, which is the lower ceiling here)
    const editOps1: EditPlanOperation[] = [
      { action: "set_limit", capabilitySlug: "x-keyword-search", targetVolumeMax: 3000 },
    ];
    const plan2 = applyPlanOperations(initialPlan, editOps1);
    const quote2 = await createAndSaveManagedQuote(tables as any, {
      conversationId: convId,
      userId,
      plan: plan2,
      userBalance: 200,
      capabilities: [multiPageCapability],
    });

    expect(quote2.targetVolumeMax).toBe(1440);
    expect(quote2.quotedPoints).toBe(4968);
    expect(quote2.quoteId).not.toBe(quote1.quoteId);

    // Check that previous quote1 is now invalidated (expired/superseded)
    const quote1Doc = await tables.getRow({ databaseId: "digr", tableId: "plans_quotes", rowId: quote1.quoteId });
    expect(quote1Doc.status).toBe("expired");

    // 3. Edit 2: change formats to CSV only
    const editOps2: EditPlanOperation[] = [
      { action: "set_formats", formats: ["csv"] },
    ];
    const plan3 = applyPlanOperations(plan2, editOps2);
    const quote3 = await createAndSaveManagedQuote(tables as any, {
      conversationId: convId,
      userId,
      plan: plan3,
      userBalance: 200,
      capabilities: [multiPageCapability],
    });

    expect(quote3.outputFormats).toEqual(["csv"]);
    expect(quote3.planHash).not.toBe(quote2.planHash);
  });

  // ================= 10. Expired Quote Rejection =================
  it("Scenario 10: Start fails after 30-minute quote expiry", async () => {
    const expiredTimestamp = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const items = [{ capabilitySlug: "tiktok-profile", params: { username: "tiktok" }, targetVolumeMin: 1, targetVolumeMax: 1 }];

    await tables.createRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: "quote_expired_test",
      data: {
        userId,
        status: "proposed",
        itemsJson: JSON.stringify(items),
        targetVolumeMax: 1,
        quotedPoints: 10,
        expiresAt: expiredTimestamp,
      },
    });

    const result = await acceptQuote(tables as any, {
      userId,
      quoteId: "quote_expired_test",
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(410);
    expect(result.errorAr).toContain("انتهت صلاحية");
  });

  // ================= 11. Replaced Quote Rejection =================
  it("Scenario 11: Start on previous replaced quote fails", async () => {
    const items = [{ capabilitySlug: "tiktok-profile", params: { username: "tiktok" }, targetVolumeMin: 1, targetVolumeMax: 1 }];

    await tables.createRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: "quote_replaced_old",
      data: {
        userId,
        status: "expired", // Marked as expired after new edit
        itemsJson: JSON.stringify(items),
        targetVolumeMax: 1,
        quotedPoints: 10,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    });

    const result = await acceptQuote(tables as any, {
      userId,
      quoteId: "quote_replaced_old",
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(result.errorAr).toContain("استبداله بعرض أحدث");
  });

  // ================= 12. Plan Tampering & Hash Mismatch =================
  it("Scenario 12: Modified payload rejected via cryptographic plan hash mismatch", async () => {
    const originalItems = [
      { capabilitySlug: "tiktok-profile", params: { username: "original_user" }, targetVolumeMin: 1, targetVolumeMax: 1 },
    ];
    const originalHash = computePlanHash(originalItems);

    await tables.createRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: "quote_tamper_test",
      data: {
        userId,
        status: "proposed",
        itemsJson: JSON.stringify(originalItems),
        targetVolumeMax: 1,
        quotedPoints: 10,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    });

    // Attacker sends an expectedPlanHash representing a different plan (or tampered parameters)
    const forgedHash = computePlanHash([
      { capabilitySlug: "tiktok-profile", params: { username: "forged_victim" }, targetVolumeMin: 1, targetVolumeMax: 1 },
    ]);

    const result = await acceptQuote(tables as any, {
      userId,
      quoteId: "quote_tamper_test",
      expectedPlanHash: forgedHash,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.errorAr).toContain("تغيرت تفاصيل الخطة");
  });

  // ================= 13. Prompt Injection through Edit Tool =================
  it("Scenario 13: Prompt injection attempt through edit tool (eval/calc/prototype pollution) rejected", async () => {
    const currentPlan: PlanState = {
      summaryAr: "خطة آمنة",
      items: [{ capabilitySlug: "tiktok-profile", params: { username: "safe_user" }, targetVolumeMin: 1, targetVolumeMax: 1 }],
      outputFormats: ["xlsx"],
    };

    // 1. Prototype pollution attempt
    const evilOp1: EditPlanOperation = {
      action: "set_param",
      capabilitySlug: "tiktok-profile",
      key: "__proto__",
      value: "malicious",
    };

    expect(() => applyPlanOperations(currentPlan, [evilOp1])).toThrow(/غير مصرح/);

    // 2. Schema validation with invalid action or extra fields
    const invalidOp = {
      action: "eval_code",
      code: "process.exit(1)",
    } as any;

    expect(() => applyPlanOperations(currentPlan, [invalidOp])).not.toThrow(); // unknown action ignored safely without executing
  });

  // ================= 14. Server-Side Rejection of Disabled Capabilities =================
  it("Scenario 14: Server strictly rejects a plan containing a disabled capability even if LLM proposes it", async () => {
    const disabledCap: Capability = {
      slug: "x-keyword-search",
      category: "x",
      nameAr: "البحث في تغريدات منصة X",
      nameEn: "X Keyword Search",
      descriptionAr: "خدمة قيد التحقق",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      }),
      tregEndpointId: "secret.endpoint.twitter",
      tregMethod: "GET",
      pricingUnit: "item",
      unitCostUsd: 0.00007,
      maxRows: 500,
      paginationType: "cursor",
      enabled: false, // DISABLED in registry
    };

    const enabledCap: Capability = {
      slug: "tiktok-profile",
      category: "tiktok",
      nameAr: "استخراج ملف تيك توك الشخصي",
      nameEn: "TikTok User Profile",
      descriptionAr: "الخدمة الوحيدة المفعلة",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
      }),
      tregEndpointId: "secret.endpoint.tiktok",
      tregMethod: "GET",
      pricingUnit: "call",
      unitCostUsd: 0.0012,
      maxRows: 1,
      paginationType: "none",
      enabled: true, // ONLY enabled service
    };

    const capabilities = [enabledCap, disabledCap];

    // LLM hallucinated / attempted to propose the disabled capability
    const proposedItems = [
      {
        capabilitySlug: "x-keyword-search",
        params: { query: "Saudi Vision 2030" },
        targetVolumeMin: 1,
        targetVolumeMax: 100,
      },
    ];

    const validation = validatePlanAgainstSchemas(proposedItems, capabilities);
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toContain("غير مفعلة");
  });
});
