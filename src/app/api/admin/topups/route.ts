import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin, enrichTopupsWithApprovals, getTopupApprovalMap, listAll, Query } from "../../../../lib/server/adminAuth";

export const dynamic = "force-dynamic";

/** All top-up requests with the account behind each one (name / email) and per-user history counts. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables, users } = auth.ctx;

  const [rowsRaw, topupApprovalMap] = await Promise.all([
    listAll(tables, "topups", [Query.orderDesc("createdAt")], 1000),
    getTopupApprovalMap(tables),
  ]);
  const rows = enrichTopupsWithApprovals(rowsRaw, topupApprovalMap);

  const ids = [...new Set(rows.map((r) => r.userId))];
  const info = new Map<string, { name: string; email: string }>();
  for (let i = 0; i < ids.length; i += 20) {
    await Promise.all(ids.slice(i, i + 20).map(async (id) => {
      try {
        const u = await users.get({ userId: id });
        info.set(id, { name: u.name || "", email: u.email || "" });
      } catch { info.set(id, { name: "", email: "" }); }
    }));
  }

  const byUser = new Map<string, any[]>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);

  const topups = rows.map((r) => ({
    id: r.$id,
    userId: r.userId,
    accName: info.get(r.userId)?.name ?? "",
    accEmail: info.get(r.userId)?.email ?? "",
    senderName: r.senderName ?? "",
    senderPhone: r.senderPhone ?? "",
    amountEgp: r.amountEgp,
    confirmedAmountEgp: r.confirmedAmountEgp ?? null,
    credits: r.credits ?? null,
    reference: r.reference,
    receiptFileId: r.receiptFileId ?? null,
    status: r.status,
    rejectReason: r.rejectReason ?? null,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt ?? null,
    previous: (byUser.get(r.userId) ?? []).filter((x) => x.$id !== r.$id).length,
    previousApproved: (byUser.get(r.userId) ?? []).filter((x) => x.$id !== r.$id && x.status === "approved").length,
  }));

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const reviewed = rows.filter((r) => r.reviewedAt && r.status !== "pending" && Date.now() - new Date(r.reviewedAt).getTime() < 30 * 86400000);
  const avgMs = reviewed.length ? reviewed.reduce((a, r) => a + (new Date(r.reviewedAt).getTime() - new Date(r.createdAt).getTime()), 0) / reviewed.length : null;
  const pending = rows.filter((r) => r.status === "pending");

  return NextResponse.json({
    topups,
    stats: {
      pendingCount: pending.length,
      pendingValueEgp: pending.reduce((a, r) => a + (r.amountEgp || 0), 0),
      approvedThisMonthEgp: rows.filter((r) => r.status === "approved" && r.reviewedAt && new Date(r.reviewedAt) >= monthStart).reduce((a, r) => a + (r.confirmedAmountEgp || r.amountEgp || 0), 0),
      avgReviewMinutes: avgMs === null ? null : Math.round(avgMs / 60000),
    },
  });
}
