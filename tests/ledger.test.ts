import { describe, it, expect, beforeEach } from "vitest";
import {
  calculateBalance,
  reserveCredits,
  releaseCredits,
  chargeCredits,
  applyTopup,
  completeJobWithRelFirst,
  reserveWithBalanceCheck,
} from "../src/functions/shared/ledger";

interface StoredRow {
  $id: string;
  data: Record<string, any>;
  permissions: any[];
}

/**
 * In-memory Mock of Appwrite TablesDB adhering to deterministic row IDs,
 * pagination (limit & offset), and 409 conflict on duplicate ID creation.
 */
class MockTablesDB {
  private rows: Map<string, StoredRow> = new Map();

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
      const err: any = new Error(`Row with ID ${rowId} already exists`);
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
    let limit = 25;
    let offset = 0;
    let filterUserId: string | null = null;

    // Parse queries (Appwrite Query format: string representations or objects)
    for (const q of queries) {
      const qStr = typeof q === "string" ? q : JSON.stringify(q);
      if (qStr.includes("equal") && qStr.includes("userId")) {
        // Extract userId value
        const match = qStr.match(/"values":\["([^"]+)"\]/) || qStr.match(/equal\("userId",\s*"([^"]+)"\)/);
        if (match) filterUserId = match[1];
      }
      if (qStr.includes("limit")) {
        const match = qStr.match(/"values":\[(\d+)\]/) || qStr.match(/limit\((\d+)\)/);
        if (match) limit = parseInt(match[1], 10);
      }
      if (qStr.includes("offset")) {
        const match = qStr.match(/"values":\[(\d+)\]/) || qStr.match(/offset\((\d+)\)/);
        if (match) offset = parseInt(match[1], 10);
      }
    }

    const allMatching: any[] = [];
    for (const [key, record] of this.rows.entries()) {
      if (key.startsWith(`${tableId}:`)) {
        if (!filterUserId || record.data.userId === filterUserId) {
          allMatching.push(record.data);
        }
      }
    }

    const paged = allMatching.slice(offset, offset + limit);
    return {
      total: allMatching.length,
      rows: paged,
    };
  }

  async getRow({ databaseId, tableId, rowId }: { databaseId: string; tableId: string; rowId: string }) {
    const key = `${tableId}:${rowId}`;
    const found = this.rows.get(key);
    if (!found) {
      const err: any = new Error("Row not found");
      err.code = 404;
      err.status = 404;
      throw err;
    }
    return found.data;
  }

  clear() {
    this.rows.clear();
  }
}

describe("Credit Ledger Core Functions & Safety Invariants", () => {
  let mockTables: MockTablesDB;
  const userId = "user_test_123";
  const jobId = "job_test_abc";

  beforeEach(() => {
    mockTables = new MockTablesDB();
  });

  describe("Deterministic IDs & Idempotency", () => {
    it("should prevent duplicate reserve with deterministic ID res_<jobId>", async () => {
      await reserveCredits(mockTables as any, userId, jobId, 100);

      // Attempt second reserve on same jobId must throw 409
      await expect(
        reserveCredits(mockTables as any, userId, jobId, 100)
      ).rejects.toMatchObject({ code: 409 });
    });

    it("should prevent duplicate release with deterministic ID rel_<jobId>", async () => {
      await releaseCredits(mockTables as any, userId, jobId, 100);

      await expect(
        releaseCredits(mockTables as any, userId, jobId, 100)
      ).rejects.toMatchObject({ code: 409 });
    });

    it("should prevent duplicate charge with deterministic ID chg_<jobId>", async () => {
      await chargeCredits(mockTables as any, userId, jobId, 50);

      await expect(
        chargeCredits(mockTables as any, userId, jobId, 50)
      ).rejects.toMatchObject({ code: 409 });
    });

    it("should prevent duplicate topup credit with deterministic ID top_<topupId>", async () => {
      const topupId = "topup_xyz";
      await applyTopup(mockTables as any, userId, topupId, 500);

      await expect(
        applyTopup(mockTables as any, userId, topupId, 500)
      ).rejects.toMatchObject({ code: 409 });
    });
  });

  describe("Balance Calculation & Pagination", () => {
    it("should calculate correct balance by paging across all pages (> 100 entries)", async () => {
      // Seed 250 rows (+10 each)
      for (let i = 0; i < 250; i++) {
        await mockTables.createRow({
          databaseId: "digr",
          tableId: "credit_ledger",
          rowId: `entry_${i}`,
          data: {
            userId,
            delta: 10,
            type: "promo",
          },
        });
      }

      // Expected balance = 250 * 10 = 2500
      const balance = await calculateBalance(mockTables as any, userId);
      expect(balance).toBe(2500);
    });
  });

  describe("reserveWithBalanceCheck & Negative Balance Compensation", () => {
    it("should succeed and deduct reserve when user has sufficient balance", async () => {
      // Initial balance = 200
      await applyTopup(mockTables as any, userId, "top_init", 200);

      const result = await reserveWithBalanceCheck(mockTables as any, userId, jobId, 50);
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(150);

      const bal = await calculateBalance(mockTables as any, userId);
      expect(bal).toBe(150);
    });

    it("should compensate with rel_<jobId> and reject if balance would be negative", async () => {
      // Initial balance = 50
      await applyTopup(mockTables as any, userId, "top_init", 50);

      // Attempt to reserve 100 (balance would become -50)
      await expect(
        reserveWithBalanceCheck(mockTables as any, userId, jobId, 100)
      ).rejects.toThrow("Insufficient credits");

      // Verify compensating release was created (rel_job_test_abc)
      const releaseRow = await mockTables.getRow({
        databaseId: "digr",
        tableId: "credit_ledger",
        rowId: `rel_${jobId}`,
      });
      expect(releaseRow.delta).toBe(100);
      expect(releaseRow.type).toBe("release");

      // Verify balance was fully restored to initial 50
      const finalBal = await calculateBalance(mockTables as any, userId);
      expect(finalBal).toBe(50);
    });
  });

  describe("completeJobWithRelFirst (Release-First Completion Order)", () => {
    it("should release reserve first and charge actual delivered amount", async () => {
      // User has 500, reserves 100 for job
      await applyTopup(mockTables as any, userId, "top_init", 500);
      await reserveCredits(mockTables as any, userId, jobId, 100);

      // Balance during execution: 500 - 100 = 400
      expect(await calculateBalance(mockTables as any, userId)).toBe(400);

      // Complete job with 60 delivered units
      const result = await completeJobWithRelFirst(
        mockTables as any,
        userId,
        jobId,
        100, // reserved
        60  // delivered / actual
      );

      expect(result.released).toBe(true);
      expect(result.charged).toBe(true);
      expect(result.finalCharged).toBe(60);

      // Final balance: 400 + 100 (rel) - 60 (chg) = 440 (net charge of 60)
      const finalBal = await calculateBalance(mockTables as any, userId);
      expect(finalBal).toBe(440);
    });

    it("should cap chargedCredits at reservedCredits (never charge more than reserved)", async () => {
      await applyTopup(mockTables as any, userId, "top_init", 500);
      await reserveCredits(mockTables as any, userId, jobId, 100);

      // Delivered 140, but reserve was only 100
      const result = await completeJobWithRelFirst(
        mockTables as any,
        userId,
        jobId,
        100, // reserved
        140 // delivered exceeds reserve
      );

      expect(result.finalCharged).toBe(100); // capped at 100!

      // Final balance: 400 + 100 - 100 = 400
      const finalBal = await calculateBalance(mockTables as any, userId);
      expect(finalBal).toBe(400);
    });

    it("should abort without charging if rel_<jobId> already exists (e.g. cancelled/timed out)", async () => {
      await applyTopup(mockTables as any, userId, "top_init", 500);
      await reserveCredits(mockTables as any, userId, jobId, 100);

      // Pre-release (simulating watchdog timeout or cancellation refund)
      await releaseCredits(mockTables as any, userId, jobId, 100);

      // Now worker tries to complete
      const result = await completeJobWithRelFirst(
        mockTables as any,
        userId,
        jobId,
        100,
        50
      );

      expect(result.released).toBe(false);
      expect(result.charged).toBe(false);
      expect(result.finalCharged).toBe(0);

      // Verify charge row was NOT created
      await expect(
        mockTables.getRow({
          databaseId: "digr",
          tableId: "credit_ledger",
          rowId: `chg_${jobId}`,
        })
      ).rejects.toMatchObject({ code: 404 });
    });
  });
});
