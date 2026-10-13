import { NextRequest, NextResponse } from "next/server";
import { Query } from "node-appwrite";
import { authenticateAdmin, enrichTopupsWithApprovals, getTopupApprovalMap, listAll, listAllUsers } from "../../../../lib/server/adminAuth";
import { DAY_MS } from "../../../../lib/server/adminStats";
import { ledgerBalance } from "../../../../lib/server/userStats";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 14;
const SCAN_CAP = 2000;
const topupAmount = (t: any) => t.confirmedAmountEgp || t.amountEgp || 0;

/** Users list: search, filters (all / active / new / zero top-ups), pagination of 14, optional CSV export. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables, users } = auth.ctx;

  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") || "").trim().slice(0, 80);
  const filter = (["all", "active", "new", "zero"] as const).find((f) => f === sp.get("filter")) ?? "all";
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

  const baseQueries = [Query.orderDesc("registration")];
  if (filter === "active") baseQueries.push(Query.greaterThanEqual("accessedAt", week));
  if (filter === "new") baseQueries.push(Query.greaterThanEqual("registration", week));

  let rows: any[];
  let filteredTotal: number;
  if (filter === "zero") {
    // «بلا شحن» can't be expressed as a Users query: scan (bounded) and drop payers.
    const scanned = (await listAllUsers(users, [...baseQueries], SCAN_CAP)).filter((u) => !perUser.has(u.$id) && (!q || `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase())));
    filteredTotal = scanned.length;
    rows = csv ? scanned : scanned.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  } else if (csv) {
    rows = await listAllUsers(users, baseQueries, SCAN_CAP);
    if (q) rows = rows.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));
    filteredTotal = rows.length;
  } else {
    const res = await (users.list as any)({ queries: [...baseQueries, Query.limit(PAGE_SIZE), Query.offset((page - 1) * PAGE_SIZE)], ...(q ? { search: q } : {}) });
    rows = res.users;
    filteredTotal = res.total;
  }

  const enriched = await Promise.all(rows.map(async (u) => {
    const p = perUser.get(u.$id);
    const base = {
      id: u.$id, name: u.name || "", email: u.email || "", registration: u.registration, lastLogin: u.accessedAt || null,
      totalTopupsEgp: p?.total ?? 0, lastTopupAt: p?.last || null,
      isNew: new Date(u.registration).getTime() >= now - 7 * DAY_MS, recent: u.accessedAt ? new Date(u.accessedAt).getTime() >= now - 7 * DAY_MS : false,
    };
    if (csv) return { ...base, balance: 0, jobs: 0 };
    const [balance, jobs] = await Promise.all([
      ledgerBalance(tables, u.$id),
      tables.listRows({ databaseId: "digr", tableId: "jobs", queries: [Query.equal("userId", u.$id), Query.limit(1)] }).then((r) => r.total),
    ]);
    return { ...base, balance, jobs };
  }));

  if (csv) {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = [["الاسم", "البريد", "تاريخ التسجيل", "آخر دخول", "إجمالي الشحن (ج.م)", "آخر شحن"], ...enriched.map((u) => [u.name, u.email, u.registration, u.lastLogin, u.totalTopupsEgp, u.lastTopupAt])]
      .map((r) => r.map(esc).join(",")).join("\r\n");
    await auth.ctx.audit("setting", "تصدير المستخدمين", `تصدير ${enriched.length} مستخدم إلى CSV`, { targetType: "users" });
    return new NextResponse("﻿" + body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="digr-users.csv"' } });
  }

  return NextResponse.json({
    users: enriched, total: filteredTotal, page, pageSize: PAGE_SIZE,
    counts: { all: totalAll, active: active7, new: new7, zero: Math.max(0, totalAll - payers) },
    stats: { total: totalAll, active30, newWeek: new7, payers },
  });
}
