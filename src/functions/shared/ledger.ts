import { Databases, Query, Permission, Role, ID } from "node-appwrite";

export const DATABASE_ID = "digr";
export const CREDIT_LEDGER_COLLECTION = "credit_ledger";

/**
 * Paginates through all ledger entries for a user and calculates the true balance.
 * Appwrite default limit is 25, max is 100.
 */
export async function calculateBalance(db: Databases, userId: string): Promise<number> {
  let total = 0;
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await db.listDocuments(DATABASE_ID, CREDIT_LEDGER_COLLECTION, [
      Query.equal("userId", userId),
      Query.limit(limit),
      Query.offset(offset),
    ]);

    for (const doc of res.documents) {
      total += (doc as any).delta || 0;
    }

    if (res.documents.length < limit) {
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
  db: Databases,
  userId: string,
  jobId: string,
  amount: number,
  note?: string
) {
  const docId = `res_${jobId}`;
  return await db.createDocument(
    DATABASE_ID,
    CREDIT_LEDGER_COLLECTION,
    docId,
    {
      userId,
      delta: -Math.abs(amount),
      type: "reserve",
      jobId,
      note: note || "حجز رصيد للطلب",
      createdAt: new Date().toISOString(),
    },
    [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))]
  );
}

/**
 * Creates a deterministic release entry: ID = rel_<jobId>
 */
export async function releaseCredits(
  db: Databases,
  userId: string,
  jobId: string,
  amount: number,
  note?: string
) {
  const docId = `rel_${jobId}`;
  return await db.createDocument(
    DATABASE_ID,
    CREDIT_LEDGER_COLLECTION,
    docId,
    {
      userId,
      delta: Math.abs(amount),
      type: "release",
      jobId,
      note: note || "إلغاء حجز الرصيد",
      createdAt: new Date().toISOString(),
    },
    [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))]
  );
}

/**
 * Creates a deterministic charge entry: ID = chg_<jobId>
 */
export async function chargeCredits(
  db: Databases,
  userId: string,
  jobId: string,
  amount: number,
  note?: string
) {
  const docId = `chg_${jobId}`;
  return await db.createDocument(
    DATABASE_ID,
    CREDIT_LEDGER_COLLECTION,
    docId,
    {
      userId,
      delta: -Math.abs(amount),
      type: "charge",
      jobId,
      note: note || "خصم تكلفة الطلب الفعلية",
      createdAt: new Date().toISOString(),
    },
    [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))]
  );
}

/**
 * Creates a deterministic top-up entry: ID = top_<topupId>
 */
export async function applyTopup(
  db: Databases,
  userId: string,
  topupId: string,
  credits: number,
  note?: string
) {
  const docId = `top_${topupId}`;
  return await db.createDocument(
    DATABASE_ID,
    CREDIT_LEDGER_COLLECTION,
    docId,
    {
      userId,
      delta: Math.abs(credits),
      type: "topup",
      topupId,
      note: note || "شحن رصيد معتمد",
      createdAt: new Date().toISOString(),
    },
    [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))]
  );
}
