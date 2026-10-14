import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin, Query } from "@/lib/server/adminAuth";

export const dynamic = "force-dynamic";

/** Admin bell: pending top-ups, new users (today) and failed jobs (last 24h). */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables, users } = auth.ctx;
  const dayAgo = new Date(Date.now() - 86400000).toISOString();

  const [pending, failed, newUsers] = await Promise.all([
    tables.listRows({ databaseId: "digr", tableId: "topups", queries: [Query.equal("status", "pending"), Query.orderDesc("createdAt"), Query.limit(10)] }),
    tables.listRows({ databaseId: "digr", tableId: "jobs", queries: [Query.equal("status", "failed"), Query.greaterThanEqual("createdAt", dayAgo), Query.orderDesc("createdAt"), Query.limit(5)] }),
    users.list({ queries: [Query.greaterThanEqual("registration", dayAgo), Query.orderDesc("registration"), Query.limit(5)] }),
  ]);

  return NextResponse.json({
    pendingTopups: pending.rows.map((r: any) => ({ id: r.$id, senderName: r.senderName || "", reference: r.reference, amountEgp: r.amountEgp, createdAt: r.createdAt })),
    pendingTotal: pending.total,
    newUsers: { total: newUsers.total, latest: newUsers.users[0] ? { name: newUsers.users[0].name, at: newUsers.users[0].registration } : null },
    failedJobs: failed.rows.map((j: any) => ({ id: j.$id, reservedCredits: j.reservedCredits, createdAt: j.createdAt })),
    failedTotal: failed.total,
  });
}
