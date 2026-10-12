import { NextRequest, NextResponse } from "next/server";
import { Query } from "node-appwrite";
import { authenticateAdmin, listAll } from "@/lib/server/adminAuth";
import { ledgerBalance, summarizeTopups } from "@/lib/server/userStats";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  const { tables, users } = auth.ctx;

  let u: any;
  try { u = await users.get({ userId: id }); } catch { return NextResponse.json({ error: "المستخدم غير موجود" }, { status: 404 }); }

  const [balance, topups, jobs] = await Promise.all([
    ledgerBalance(tables, id),
    listAll(tables, "topups", [Query.equal("userId", id), Query.orderDesc("createdAt")], 200),
    tables.listRows({ databaseId: "digr", tableId: "jobs", queries: [Query.equal("userId", id), Query.limit(1)] }),
  ]);
  const sum = summarizeTopups(topups);

  return NextResponse.json({
    id: u.$id,
    name: u.name || "",
    email: u.email || "",
    registration: u.registration,
    lastLogin: u.accessedAt || null,
    emailVerification: !!u.emailVerification,
    status: u.status,
    balance,
    totalTopupsEgp: sum.total,
    lastTopupAt: sum.last,
    jobs: jobs.total,
    topups: topups.map((t) => ({ id: t.$id, amountEgp: t.amountEgp, confirmedAmountEgp: t.confirmedAmountEgp ?? null, status: t.status, createdAt: t.createdAt })),
  });
}
