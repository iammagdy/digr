import { describe, it, expect } from 'vitest';

/**
 * Simulation of PostgreSQL's reserve_credits_atomic state machine:
 * 1. Takes exclusive lock on profile (serialized execution for the same user)
 * 2. Checks current balance SUM(delta)
 * 3. Idempotent re-check: if res_<job_id> already in ledger, returns already_reserved: true
 * 4. Insufficient balance check: if balance < amount, returns insufficient_balance
 * 5. Appends res_<job_id> with delta = -amount
 */
class PostgresAtomicReserveSimulator {
  private ledger: Array<{ id: string; userId: string; delta: number; type: string; jobId?: string }> = [];
  private userLocks = new Map<string, Promise<void>>();

  async executeWithUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    while (this.userLocks.has(userId)) {
      await this.userLocks.get(userId);
    }
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.userLocks.set(userId, lockPromise);
    try {
      return await fn();
    } finally {
      this.userLocks.delete(userId);
      resolveLock();
    }
  }

  grant(userId: string, amount: number, id: string) {
    this.ledger.push({ id, userId, delta: amount, type: 'grant' });
  }

  async reserveCreditsAtomic(userId: string, jobId: string, amount: number): Promise<{
    success: boolean;
    already_reserved: boolean;
    balance: number;
    error?: string;
  }> {
    if (amount <= 0) {
      throw new Error('p_amount must be strictly positive');
    }

    return this.executeWithUserLock(userId, async () => {
      // Simulate non-zero delay under load
      await new Promise((r) => setTimeout(r, Math.random() * 5));

      const currentBalance = this.ledger
        .filter((entry) => entry.userId === userId)
        .reduce((sum, entry) => sum + entry.delta, 0);

      const resId = `res_${jobId}`;
      const existing = this.ledger.find((entry) => entry.id === resId);

      if (existing) {
        return {
          success: true,
          already_reserved: true,
          balance: currentBalance,
        };
      }

      if (currentBalance < amount) {
        return {
          success: false,
          already_reserved: false,
          error: 'insufficient_balance',
          balance: currentBalance,
        };
      }

      this.ledger.push({
        id: resId,
        userId,
        delta: -amount,
        type: 'reserve',
        jobId,
      });

      const updatedBalance = currentBalance - amount;
      return {
        success: true,
        already_reserved: false,
        balance: updatedBalance,
      };
    });
  }

  getLedger(userId: string) {
    return this.ledger.filter((entry) => entry.userId === userId);
  }

  getBalance(userId: string) {
    return this.ledger
      .filter((entry) => entry.userId === userId)
      .reduce((sum, entry) => sum + entry.delta, 0);
  }
}

describe('reserve_credits_atomic Concurrency & Idempotency Invariants', () => {
  it('handles 20 parallel calls: balance never negative, res_<jobId> never duplicated', async () => {
    const db = new PostgresAtomicReserveSimulator();
    const testUserId = '00000000-0000-0000-0000-000000000001';

    // Initial grant: 100 points
    db.grant(testUserId, 100, 'grt_init_concurrency');

    // 20 parallel calls:
    // - 10 calls for the exact same job_id ('job_same_test') requesting 20 points
    // - 10 calls for unique job_ids ('job_seq_1'..'job_seq_10') requesting 15 points
    const sameJobPromises = Array.from({ length: 10 }).map(() =>
      db.reserveCreditsAtomic(testUserId, 'job_same_test', 20)
    );

    const seqJobPromises = Array.from({ length: 10 }).map((_, i) =>
      db.reserveCreditsAtomic(testUserId, `job_seq_${i + 1}`, 15)
    );

    const allResults = await Promise.all([...sameJobPromises, ...seqJobPromises]);

    // Invariant 1: Total reservations for job_same_test in ledger is exactly 1
    const ledger = db.getLedger(testUserId);
    const sameJobLedgerRows = ledger.filter((row) => row.id === 'res_job_same_test');
    expect(sameJobLedgerRows).toHaveLength(1);

    // Invariant 2: Balance never goes negative
    const finalBalance = db.getBalance(testUserId);
    expect(finalBalance).toBeGreaterThanOrEqual(0);

    // Calculation:
    // Initial: 100
    // 1 successful reservation for job_same_test: -20 (balance = 80)
    // 9 remaining calls for job_same_test: already_reserved = true (delta = 0)
    // Up to 5 seq jobs succeed (5 * 15 = 75), leaving 5 points
    // The remaining seq jobs must fail with insufficient_balance
    expect(finalBalance).toBe(5);

    // Invariant 3: Count of rejected calls due to insufficient balance
    const insufficientBalanceResults = allResults.filter((r) => r.error === 'insufficient_balance');
    expect(insufficientBalanceResults).toHaveLength(5);

    // Invariant 4: Count of duplicate calls returning already_reserved
    const alreadyReservedResults = allResults.filter((r) => r.already_reserved === true);
    expect(alreadyReservedResults).toHaveLength(9);

    // Invariant 5: No duplicate IDs anywhere in the ledger
    const ids = ledger.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });
});
