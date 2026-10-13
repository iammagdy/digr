import { NextRequest, NextResponse } from "next/server";
import { Query } from "node-appwrite";
import { authenticateAdmin, creditValueEgp, enrichTopupsWithApprovals, getTopupApprovalMap, listAll } from "../../../../lib/server/adminAuth";
import { DAY_MS, lastMonths, margin, monthKey, monthLabelAr, refundPointsByJob } from "../../../../lib/server/adminStats";

export const dynamic = "force-dynamic";

const topupAmount = (t: any) => t.confirmedAmountEgp || t.amountEgp || 0;

/**
 * Revenue & profit. Definitions (same as the design):
 *  - شحن معتمد: approved top-ups (confirmed amount), by review date
 *  - إيراد محقق: points charged on delivered records × point value
 *  - مستردات: (released − charged) points returned to users × point value
 *  - تكلفة المزودين: provider_costs (TREG + model)
 *  - صافي الربح: شحن معتمد − تكلفة المزودين
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables } = auth.ctx;

  const range = ([7, 30, 90] as const).find((r) => r === Number(req.nextUrl.searchParams.get("range"))) ?? 30;
  const now = Date.now();
  const rangeStart = now - range * DAY_MS;
  const months = lastMonths(6);
  const horizon = new Date(new Date(now).getFullYear(), new Date(now).getMonth() - 5, 1).toISOString();

  const [value, approvedRaw, costs, ledger, topupApprovalMap] = await Promise.all([
    creditValueEgp(tables),
    listAll(tables, "topups", [Query.equal("status", "approved")], 5000),
    listAll(tables, "provider_costs", [Query.greaterThanEqual("at", horizon)], 50000).catch(() => []),
    listAll(tables, "credit_ledger", [Query.greaterThanEqual("createdAt", horizon), Query.equal("type", ["release", "charge"])], 50000),
    getTopupApprovalMap(tables),
  ]);

  const approved = enrichTopupsWithApprovals(approvedRaw, topupApprovalMap);

  const refunds = refundPointsByJob(ledger as any);
  const monthly = months.map((key, i) => {
    const top = approved.filter((t) => t.reviewedAt && monthKey(t.reviewedAt) === key).reduce((a, t) => a + topupAmount(t), 0);
    const realized = ledger.filter((l) => l.type === "charge" && monthKey(l.createdAt) === key).reduce((a, l) => a + Math.abs(l.delta), 0) * value;
    const refund = [...refunds.values()].filter((r) => monthKey(r.at) === key).reduce((a, r) => a + r.refund, 0) * value;
    const cost = costs.filter((c) => monthKey(c.at) === key).reduce((a, c) => a + (c.costEgp || 0), 0);
    return { key, name: monthLabelAr(key, i === 0), top, realized, refunds: refund, cost, profit: top - cost, margin: margin(top, cost) };
  });

  const inRange = (iso: string) => new Date(iso).getTime() >= rangeStart;
  const rev = approved.filter((t) => t.reviewedAt && inRange(t.reviewedAt)).reduce((a, t) => a + topupAmount(t), 0);
  const realized = ledger.filter((l) => l.type === "charge" && inRange(l.createdAt)).reduce((a, l) => a + Math.abs(l.delta), 0) * value;
  const refundEgp = [...refunds.values()].filter((r) => inRange(r.at)).reduce((a, r) => a + r.refund, 0) * value;
  const treg = costs.filter((c) => c.provider === "treg" && inRange(c.at)).reduce((a, c) => a + (c.costEgp || 0), 0);
  const llm = costs.filter((c) => c.provider === "llm" && inRange(c.at)).reduce((a, c) => a + (c.costEgp || 0), 0);

  return NextResponse.json({
    range,
    cards: { rev, realized, refunds: refundEgp, treg, llm, profit: rev - (treg + llm), margin: margin(rev, treg + llm) },
    monthly,
    costSplit: { treg, llm },
  });
}
