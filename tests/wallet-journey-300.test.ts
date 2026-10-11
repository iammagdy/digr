/**
 * Reproducible regression for the 300-point simulated customer journey.
 *
 * Executes the REAL server ledger module (src/functions/shared/ledger.ts)
 * against an isolated in-memory mock — no production data, no network.
 * Mirrors the scenario verified hands-on for PR #11 so the evidence is
 * version-controlled and re-runnable via `npm test`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  calculateBalance,
  reserveWithBalanceCheck,
  releaseCredits,
  completeJobWithRelFirst,
  applyTopup,
} from "../src/functions/shared/ledger";

interface StoredRow {
  $id: string;
  data: Record<string, any>;
}

/** In-memory Appwrite TablesDB mock: deterministic IDs, 409 on duplicate, limit/offset pagination. */
class MockTablesDB {
  private rows = new Map<string, StoredRow>();

  async createRow({ tableId, rowId, data }: { tableId: string; rowId: string; data: Record<string, any> }) {
    const key = `${tableId}:${rowId}`;
    if (this.rows.has(key)) {
      const err: any = new Error(`Row ${rowId} already exists`);
      err.code = 409;
      err.status = 409;
      throw err;
    }
    const record = { $id: rowId, data: { ...data, $id: rowId } };
    this.rows.set(key, record);
    return record.data;
  }

  async listRows({ tableId, queries = [] }: { tableId: string; queries?: any[] }) {
    let limit = 25;
    let offset = 0;
    let userId: string | null = null;
    for (const q of queries) {
      const s = typeof q === "string" ? q : JSON.stringify(q);
      let m: RegExpMatchArray | null;
      if ((m = s.match(/"method":"limit","values":\[(\d+)\]/))) limit = parseInt(m[1], 10);
      if ((m = s.match(/"method":"offset","values":\[(\d+)\]/))) offset = parseInt(m[1], 10);
      if ((m = s.match(/"method":"equal","attribute":"userId","values":\["([^"]+)"\]/))) userId = m[1];
    }
    const mine = [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${tableId}:`))
      .map(([, v]) => v.data)
      .filter((r) => !userId || r.userId === userId);
    return { total: mine.length, rows: mine.slice(offset, offset + limit) };
  }

  rowCount() {
    return this.rows.size;
  }
}

const USER = "test_customer_300";

describe("300-point simulated customer journey (PR #11 hands-on scenario)", () => {
  let db: MockTablesDB;
  const balance = () => calculateBalance(db as any, USER);

  beforeEach(async () => {
    db = new MockTablesDB();
    // Seed the simulated starting balance via an approved top-up (isolated only).
    await applyTopup(db as any, USER, "topup_sim_001", 300, "شحن تجريبي معتمد");
  });

  it("starts with exactly 300 points and nothing reserved or charged", async () => {
    expect(await balance()).toBe(300);
    expect(db.rowCount()).toBe(1);
  });

  it("reserves 100 points on explicit start, leaving 200 available", async () => {
    const result = await reserveWithBalanceCheck(db as any, USER, "job_1", 100);
    expect(result.success).toBe(true);
    expect(result.newBalance).toBe(200);
    expect(await balance()).toBe(200);
  });

  it("settles release-first: releases 100 then charges the actual 80, ending at 220", async () => {
    await reserveWithBalanceCheck(db as any, USER, "job_1", 100);
    const completion = await completeJobWithRelFirst(db as any, USER, "job_1", 100, 80);
    expect(completion.released).toBe(true);
    expect(completion.charged).toBe(true);
    expect(completion.finalCharged).toBe(80);
    expect(await balance()).toBe(220);
  });

  it("rejects a duplicate completion — retries cannot double-charge", async () => {
    await reserveWithBalanceCheck(db as any, USER, "job_1", 100);
    await completeJobWithRelFirst(db as any, USER, "job_1", 100, 80);
    const again = await completeJobWithRelFirst(db as any, USER, "job_1", 100, 80);
    expect(again.released).toBe(false);
    expect(again.charged).toBe(false);
    expect(await balance()).toBe(220);
  });

  it("rejects a duplicate reservation with the deterministic row ID", async () => {
    await reserveWithBalanceCheck(db as any, USER, "job_1", 100);
    await expect(reserveWithBalanceCheck(db as any, USER, "job_1", 100)).rejects.toMatchObject({ code: 409 });
    expect(await balance()).toBe(200);
  });

  it("releases the reservation for a failed job and never charges", async () => {
    await reserveWithBalanceCheck(db as any, USER, "job_2", 50);
    expect(await balance()).toBe(250);
    await releaseCredits(db as any, USER, "job_2", 50, "إلغاء لعدم اكتمال الجمع");
    expect(await balance()).toBe(300);
  });

  it("rejects a reservation larger than the balance and compensates fully", async () => {
    await expect(reserveWithBalanceCheck(db as any, USER, "job_3", 500)).rejects.toThrow(/Insufficient/);
    expect(await balance()).toBe(300);
  });

  it("caps the final charge at the reserved amount", async () => {
    await reserveWithBalanceCheck(db as any, USER, "job_4", 60);
    const completion = await completeJobWithRelFirst(db as any, USER, "job_4", 60, 999);
    expect(completion.finalCharged).toBe(60);
    expect(await balance()).toBe(240);
  });

  it("sums the complete ledger correctly beyond 100 entries (full pagination)", async () => {
    for (let i = 0; i < 120; i++) {
      await applyTopup(db as any, USER, `micro_${i}`, 1, "test");
    }
    expect(db.rowCount()).toBe(121);
    expect(await balance()).toBe(420);
  });
});
