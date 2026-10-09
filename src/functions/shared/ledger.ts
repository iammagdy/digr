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
 */
export async function chargeCredits(
  tables: TablesDB,
  userId: string,
  jobId: string,
  amount: number,
  note?: string
) {
  const rowId = `chg_${jobId}`;
  return await tables.createRow({
    databaseId: DATABASE_ID,
    tableId: CREDIT_LEDGER_TABLE,
    rowId,
    data: {
      userId,
      delta: -Math.abs(amount),
      type: "charge",
      jobId,
      note: note || "خصم تكلفة الطلب الفعلية",
      createdAt: new Date().toISOString(),
    },
    permissions: [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))],
  });
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
