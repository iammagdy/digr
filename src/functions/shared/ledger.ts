import { TablesDB, Query, Permission, Role } from "node-appwrite";

export const DATABASE_ID = "digr";
export const CREDIT_LEDGER_TABLE = "credit_ledger";

/**
 * Paginates through all ledger entries for a user and calculates the true balance.
 * Appwrite default limit is 25, max is 100.
 */
export async function calculateBalance(tables: TablesDB, userId: string): Promise<number> {
  let total = 0;
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await tables.listRows({
      databaseId: DATABASE_ID,
      tableId: CREDIT_LEDGER_TABLE,
      queries: [
        Query.equal("userId", userId),
        Query.limit(limit),
        Query.offset(offset),
      ],
    });

    for (const row of res.rows) {
      total += (row as any).delta || 0;
    }

    if (res.rows.length < limit) {
      break;
    }
    offset += limit;
  }

  return total;
}

export const getBalance = calculateBalance;

/**
 * Creates a deterministic reserve entry: ID = res_<jobId>
 */
export async function reserveCredits(
  tables: TablesDB,
  userId: string,
  jobId: string,
  amount: number,
  note?: string
) {
  const rowId = `res_${jobId}`;
  return await tables.createRow({
    databaseId: DATABASE_ID,
    tableId: CREDIT_LEDGER_TABLE,
    rowId,
    data: {
      userId,
      delta: -Math.abs(amount),
      type: "reserve",
      jobId,
      note: note || "حجز رصيد للطلب",
      createdAt: new Date().toISOString(),
    },
    permissions: [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))],
  });
}

/**
 * Creates a deterministic release entry: ID = rel_<jobId>
 */
export async function releaseCredits(
  tables: TablesDB,
  userId: string,
  jobId: string,
  amount: number,
  note?: string
) {
  const rowId = `rel_${jobId}`;
  return await tables.createRow({
    databaseId: DATABASE_ID,
    tableId: CREDIT_LEDGER_TABLE,
    rowId,
    data: {
      userId,
      delta: Math.abs(amount),
      type: "release",
      jobId,
      note: note || "إلغاء حجز الرصيد",
      createdAt: new Date().toISOString(),
    },
    permissions: [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))],
  });
}

/**
 * Creates a deterministic charge entry: ID = chg_<jobId>
 * Capped at reservedCredits if provided.
 */
export async function chargeCredits(
  tables: TablesDB,
  userId: string,
  jobId: string,
  amount: number,
  reservedCredits?: number,
  note?: string
) {
  let finalAmount = Math.abs(amount);
  if (reservedCredits !== undefined && reservedCredits !== null) {
    finalAmount = Math.min(finalAmount, Math.abs(reservedCredits));
  }
  const rowId = `chg_${jobId}`;
  return await tables.createRow({
    databaseId: DATABASE_ID,
    tableId: CREDIT_LEDGER_TABLE,
    rowId,
    data: {
      userId,
      delta: -finalAmount,
      type: "charge",
      jobId,
      note: note || "خصم تكلفة الطلب الفعلية",
      createdAt: new Date().toISOString(),
    },
    permissions: [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))],
  });
}

/**
 * Executes the rel-first completion sequence:
 * 1. Create rel_<jobId> (+reserve)
 *    If rel_ fails with 409 Conflict, abort without charging (already settled/refunded).
 * 2. If rel_ succeeded, create chg_<jobId> (-chargedCredits, capped at reservedCredits).
 */
export async function completeJobWithRelFirst(
  tables: TablesDB,
  userId: string,
  jobId: string,
  reservedCredits: number,
  chargedCredits: number,
  note?: string
): Promise<{ released: boolean; charged: boolean; finalCharged: number }> {
  const finalCharged = Math.min(Math.abs(reservedCredits), Math.max(0, Math.abs(chargedCredits)));

  // 1. Release first
  try {
    await releaseCredits(tables, userId, jobId, reservedCredits, note || "إلغاء حجز الرصيد عند اكتمال الطلب");
  } catch (err: any) {
    if (err.code === 409 || err.status === 409) {
      return { released: false, charged: false, finalCharged: 0 };
    }
    throw err;
  }

  // 2. Charge delivered credits (only if release succeeded)
  await chargeCredits(tables, userId, jobId, finalCharged, reservedCredits, note || "خصم تكلفة الطلب الفعلية");
  return { released: true, charged: true, finalCharged };
}

/**
 * Attempts to reserve credits for a job.
 * If user balance becomes negative, immediately compensates by creating rel_<jobId>
 * and throws an Error.
 */
export async function reserveWithBalanceCheck(
  tables: TablesDB,
  userId: string,
  jobId: string,
  amount: number
): Promise<{ success: boolean; newBalance: number }> {
  // 1. Reserve first
  await reserveCredits(tables, userId, jobId, amount);

  // 2. Recompute balance across all pages
  const currentBalance = await calculateBalance(tables, userId);

  // 3. If negative, compensate immediately and fail
  if (currentBalance < 0) {
    await releaseCredits(tables, userId, jobId, amount, "إلغاء الحجز لعدم كفاية الرصيد");
    throw new Error(`Insufficient credits: balance would be ${currentBalance}`);
  }

  return { success: true, newBalance: currentBalance };
}

/**
 * Creates a deterministic top-up entry: ID = top_<topupId>
 */
export async function applyTopup(
  tables: TablesDB,
  userId: string,
  topupId: string,
  credits: number,
  note?: string
) {
  const rowId = `top_${topupId}`;
  return await tables.createRow({
    databaseId: DATABASE_ID,
    tableId: CREDIT_LEDGER_TABLE,
    rowId,
    data: {
      userId,
      delta: Math.abs(credits),
      type: "topup",
      topupId,
      note: note || "شحن رصيد معتمد",
      createdAt: new Date().toISOString(),
    },
    permissions: [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))],
  });
}
