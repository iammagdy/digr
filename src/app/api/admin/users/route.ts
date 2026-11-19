import { contentDispositionOf } from "@/lib/downloadName";
import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin, enrichTopupsWithApprovals, getTopupApprovalMap, listAll, listAllUsers, Query } from "../../../../lib/server/adminAuth";
import { DAY_MS } from "../../../../lib/server/adminStats";
import { createAdminClient } from "../../../../lib/supabase/server";
import { USER_SEGMENTS, USERS_SCAN_CAP, parseUserSegment, parseUserSort, parseUsersPageSize, type UserSegment } from "../../../../lib/adminUsers";
import { compareUsers, inSegment, listedTimes, readBalances, readSuspendedIds, type ListedUser } from "../../../../lib/server/adminUsersList";
import { countMissionsByUser } from "../../../../lib/server/adminUserMissions";

export const dynamic = "force-dynamic";

const topupAmount = (t: any) => t.confirmedAmountEgp || t.amountEgp || 0;

/**
 * Users list (DT-20261118-06 phase 1B): search, chips with counts (all / active 30 d / new 7 d / no top-up / low balance / inactive 30 d / suspended), sort
 * (last sign-in / balance / top-ups / registration), pages of 25 (20 on a phone), optional CSV export (columns unchanged).
 * The newest 2,000 accounts are read once and segmented in memory; balances come from ONE grouped ledger read, suspensions from the sign-in service, request counts from `missions`.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables, users } = auth.ctx;

  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") || "").trim().slice(0, 80);
  const filter = parseUserSegment(sp.get("filter"));
  const sort = parseUserSort(sp.get("sort"));
  const pageSize = parseUsersPageSize(sp.get("pageSize"));
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const csv = sp.get("format") === "csv";
  const now = Date.now();
  const week = new Date(now - 7 * DAY_MS).toISOString();
  const month = new Date(now - 30 * DAY_MS).toISOString();

  const [approvedRaw, topupApprovalMap] = await Promise.all([
    listAll(tables, "topups", [Query.equal("status", "approved")], 5000),
    getTopupApprovalMap(tables),
  ]);
  const approved = enrichTopupsWithApprovals(approvedRaw, topupApprovalMap);
  const perUser = new Map<string, { total: number; last: string }>();
  for (const t of approved) {
    const e = perUser.get(t.userId) ?? { total: 0, last: "" };
    e.total += topupAmount(t);
    const at = t.reviewedAt || t.createdAt;
    if (at > e.last) e.last = at;
    perUser.set(t.userId, e);
  }

  const count = async (queries: string[]) => (await users.list({ queries: [...queries, Query.limit(1)] })).total;
  const [totalAll, active7, new7, active30] = await Promise.all([
    count([]), count([Query.greaterThanEqual("accessedAt", week)]), count([Query.greaterThanEqual("registration", week)]), count([Query.greaterThanEqual("accessedAt", month)]),
  ]);
  const payers = perUser.size;

  // ONE scan of the newest accounts; the ledger and the sign-in service are read once each, only when the answer needs them (the CSV needs them only for its own chip)
  const scanned = await listAllUsers(users, [Query.orderDesc("registration")], USERS_SCAN_CAP);
  const needBalances = !csv || filter === "low";
  const needBans = !csv || filter === "suspended";
  const client = needBalances || needBans ? createAdminClient() : null;
  const [ledger, bans] = await Promise.all([needBalances ? readBalances(client) : null, needBans ? readSuspendedIds(client, now) : null]);
  if (ledger?.failed) return NextResponse.json({ error: "تعذّر قراءة الأرصدة الآن." }, { status: 500 });

  const needle = q.toLowerCase();
  const people = scanned
    .filter((u) => !needle || `${u.name} ${u.email}`.toLowerCase().includes(needle))
    .map((u) => ({
      u,
      p: { id: u.$id, ...listedTimes(u), balance: ledger?.balances.get(u.$id) ?? 0, topupsEgp: perUser.get(u.$id)?.total ?? 0, paid: perUser.has(u.$id), suspended: bans?.ids.has(u.$id) ?? false } as ListedUser,
    }));
  const counts = Object.fromEntries(USER_SEGMENTS.map(([id]) => [id, people.filter(({ p }) => inSegment(id, p, now)).length])) as Record<UserSegment, number>;
  const matching = people.filter(({ p }) => inSegment(filter, p, now));
  // the CSV keeps today's order (newest registration first); the screen follows the chosen sort
  if (!csv) matching.sort((a, b) => compareUsers(sort)(a.p, b.p));
  const filteredTotal = matching.length;
  const rows = csv ? matching : matching.slice((page - 1) * pageSize, page * pageSize);
  const scanLimited = totalAll > scanned.length || ledger?.complete === false || bans?.complete === false;

  const missionCounts = csv ? new Map<string, number>() : await countMissionsByUser(client, rows.map(({ u }) => u.$id));
  const enriched = rows.map(({ u, p }) => {
    const t = perUser.get(u.$id);
    const base = {
      id: u.$id, name: u.name || "", email: u.email || "", registration: u.registration, lastLogin: u.accessedAt || null,
      totalTopupsEgp: t?.total ?? 0, lastTopupAt: t?.last || null,
      isNew: new Date(u.registration).getTime() >= now - 7 * DAY_MS, recent: u.accessedAt ? new Date(u.accessedAt).getTime() >= now - 7 * DAY_MS : false,
    };
    return { ...base, balance: p.balance, missions: missionCounts.get(u.$id) ?? 0, suspended: p.suspended };
  });

  if (csv) {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = [["الاسم", "البريد", "تاريخ التسجيل", "آخر دخول", "إجمالي الشحن (ج.م)", "آخر شحن"], ...enriched.map((u) => [u.name, u.email, u.registration, u.lastLogin, u.totalTopupsEgp, u.lastTopupAt])]
      .map((r) => r.map(esc).join(",")).join("\r\n");
    await auth.ctx.audit("setting", "تصدير المستخدمين", `تصدير ${enriched.length} مستخدم إلى CSV`, { targetType: "users" });
    return new NextResponse("﻿" + body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDispositionOf("diger-users.csv") } });
  }

  return NextResponse.json({
    users: enriched, total: filteredTotal, page, pageSize, filter, sort, scanLimited,
    counts,
    stats: { total: totalAll, active30, active7, newWeek: new7, payers },
  });
}
