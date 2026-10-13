import { NextRequest, NextResponse } from "next/server";
import { Query } from "node-appwrite";
import { authenticateAdmin, creditValueEgp, enrichTopupsWithApprovals, getTopupApprovalMap, listAll, listAllUsers, userDirectory } from "../../../../lib/server/adminAuth";
import { agoSince } from "../../../../lib/server/agoSince";
import { bucketDays, DAY_MS, margin, netProfit, pctChange, refundPointsByJob, splitPeriods } from "../../../../lib/server/adminStats";

export const dynamic = "force-dynamic";

const topupAmount = (t: any) => t.confirmedAmountEgp || t.amountEgp || 0;

/** KPIs, time series (7/30/90 days vs the previous period), funnel, activity feed and top payers. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables, users } = auth.ctx;

  const range = ([7, 30, 90] as const).find((r) => r === Number(req.nextUrl.searchParams.get("range"))) ?? 30;
  const now = Date.now();
  const since = new Date(now - range * 2 * DAY_MS).toISOString();
  const windowStart = new Date(now - range * DAY_MS).toISOString();

  const [creditValue, approvedRaw, costs, jobs, ledger, topupApprovalMap, convs, newUsersAll, activeNow, usersTotal] = await Promise.all([
    creditValueEgp(tables),
    listAll(tables, "topups", [Query.equal("status", "approved"), Query.orderDesc("createdAt")], 5000),
    listAll(tables, "provider_costs", [Query.greaterThanEqual("at", since)], 20000).catch(() => []),
    listAll(tables, "jobs", [Query.greaterThanEqual("createdAt", since)], 20000),
    listAll(tables, "credit_ledger", [Query.greaterThanEqual("createdAt", since), Query.equal("type", ["release", "charge"])], 20000),
    getTopupApprovalMap(tables),
    listAll(tables, "conversations", [Query.greaterThanEqual("createdAt", windowStart)], 20000),
    listAllUsers(users, [Query.greaterThanEqual("registration", since)], 20000),
    users.list({ queries: [Query.greaterThanEqual("accessedAt", windowStart), Query.limit(1)] }),
    users.list({ queries: [Query.limit(1)] }),
  ]);

  const approved = enrichTopupsWithApprovals(approvedRaw, topupApprovalMap);

  const approvedInWindow = approved.filter((t) => t.reviewedAt && new Date(t.reviewedAt).getTime() >= now - range * 2 * DAY_MS);
  const rev = splitPeriods(bucketDays(approvedInWindow, range, now, (t) => t.reviewedAt, topupAmount), range);
  const treg = splitPeriods(bucketDays(costs, range, now, (c) => c.at, (c) => (c.provider === "treg" ? c.costEgp || 0 : 0)), range);
  const llm = splitPeriods(bucketDays(costs, range, now, (c) => c.at, (c) => (c.provider === "llm" ? c.costEgp || 0 : 0)), range);
  const newU = splitPeriods(bucketDays(newUsersAll, range, now, (u) => u.registration, () => 1), range);
  const jobsS = splitPeriods(bucketDays(jobs.filter((j) => j.status !== "cancelled"), range, now, (j) => j.createdAt, () => 1), range);
  const refundMap = refundPointsByJob(ledger as any);
  const refundRows = [...refundMap.values()];
  const refunds = splitPeriods(bucketDays(refundRows, range, now, (r) => r.at, (r) => r.refund * creditValue), range);

  const cost = { current: treg.current.map((v, i) => v + llm.current[i]), sumCurrent: treg.sumCurrent + llm.sumCurrent, sumPrevious: treg.sumPrevious + llm.sumPrevious };

  // Active users: accessedAt keeps only the last access, so «active» = accessed within the window (previous period
  // is approximated from users whose last access fell in it).
  const activeAll = await listAllUsers(users, [Query.greaterThanEqual("accessedAt", since)], 20000);
  const active = splitPeriods(bucketDays(activeAll, range, now, (u) => u.accessedAt, () => 1), range);

  // Funnel for the users who signed up in the current window.
  const cohort = new Set(newUsersAll.filter((u) => new Date(u.registration).getTime() >= now - range * DAY_MS).map((u) => u.$id));
  const asked = new Set(convs.map((c) => c.userId).filter((id) => cohort.has(id)));
  const paid = new Set(approved.map((t) => t.userId).filter((id) => cohort.has(id)));

  // Top payers (all time)
  const perUser = new Map<string, { total: number; last: string }>();
  for (const t of approved) {
    const e = perUser.get(t.userId) ?? { total: 0, last: "" };
    e.total += topupAmount(t);
    const at = t.reviewedAt || t.createdAt;
    if (at > e.last) e.last = at;
    perUser.set(t.userId, e);
  }
  const top = [...perUser.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5);

  // Latest activity: signups, top-up requests, finished jobs, approvals
  const [recentTopups, recentUsers] = await Promise.all([
    tables.listRows({ databaseId: "digr", tableId: "topups", queries: [Query.orderDesc("createdAt"), Query.limit(6)] }),
    users.list({ queries: [Query.orderDesc("registration"), Query.limit(6)] }),
  ]);
  enrichTopupsWithApprovals(recentTopups.rows as any[], topupApprovalMap);
  const recentJobs = [...jobs].filter((j) => j.status === "done" || j.status === "running").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  const dir = await userDirectory(users, [...top.map(([id]) => id), ...recentTopups.rows.map((t: any) => t.userId), ...recentJobs.map((j) => j.userId)]);
  const nm = (id: string) => dir.get(id)?.name || "مستخدم";

  const events: Array<{ type: "signup" | "pay" | "jobs" | "check"; who: string; what: string; at: string; value: string; tone: "info" | "gold" | "ink" | "ok" }> = [];
  for (const u of recentUsers.users) events.push({ type: "signup", who: u.name || u.email, what: "أنشأ حسابًا جديدًا", at: u.registration, value: "", tone: "info" });
  for (const t of recentTopups.rows as any[]) {
    events.push({ type: "pay", who: nm(t.userId), what: "أرسل طلب شحن عبر إنستاباي", at: t.createdAt, value: `+${Math.round(t.amountEgp)} ج.م`, tone: "gold" });
    if (t.status === "approved" && t.reviewedAt) events.push({ type: "check", who: "الإدارة", what: `اعتمدت شحن ${t.senderName || nm(t.userId)}`, at: t.reviewedAt, value: `+${t.credits ?? 0} نقطة`, tone: "ok" });
  }
  for (const j of recentJobs) events.push({ type: "jobs", who: nm(j.userId), what: j.status === "done" ? `اكتمل بحثه · ${j.rowsCollected ?? 0} سجلًا` : "بدأ بحثًا جديدًا", at: j.createdAt, value: j.status === "done" ? `−${j.chargedCredits ?? 0} نقطة` : `−${j.reservedCredits ?? 0} نقطة`, tone: "ink" });
  events.sort((a, b) => b.at.localeCompare(a.at));

  const pendingCount = (await tables.listRows({ databaseId: "digr", tableId: "topups", queries: [Query.equal("status", "pending"), Query.limit(1)] })).total;

  return NextResponse.json({
    range,
    totals: {
      users: usersTotal.total,
      newUsers: newU.sumCurrent, newUsersPrev: newU.sumPrevious,
      active: activeNow.total, activePrev: active.sumPrevious,
      rev: rev.sumCurrent, revPrev: rev.sumPrevious,
      cost: cost.sumCurrent, costPrev: cost.sumPrevious,
      treg: treg.sumCurrent, llm: llm.sumCurrent,
      profit: netProfit(rev.sumCurrent, cost.sumCurrent), profitPrev: netProfit(rev.sumPrevious, cost.sumPrevious),
      margin: margin(rev.sumCurrent, cost.sumCurrent),
      jobs: jobsS.sumCurrent, jobsPrev: jobsS.sumPrevious,
      refunds: refunds.sumCurrent,
      change: {
        users: pctChange(usersTotal.total, usersTotal.total - newU.sumCurrent), newUsers: pctChange(newU.sumCurrent, newU.sumPrevious),
        active: pctChange(activeNow.total, active.sumPrevious), rev: pctChange(rev.sumCurrent, rev.sumPrevious),
        profit: pctChange(netProfit(rev.sumCurrent, cost.sumCurrent), netProfit(rev.sumPrevious, cost.sumPrevious)), jobs: pctChange(jobsS.sumCurrent, jobsS.sumPrevious),
      },
    },
    series: { rev: rev.current, treg: treg.current, llm: llm.current, cost: cost.current, newUsers: newU.current, active: active.current, jobs: jobsS.current, refunds: refunds.current },
    funnel: { signed: cohort.size, asked: asked.size, paid: paid.size },
    activity: events.slice(0, 8).map((e) => ({ ...e, when: agoSince(e.at, now) })),
    topPayers: top.map(([id, e]) => ({ id, name: dir.get(id)?.name || "", email: dir.get(id)?.email || "", total: e.total, last: agoSince(e.last, now) })),
    pendingCount,
  });
}
