import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin, listAll, Query } from "@/lib/server/adminAuth";
import { summarizeTopups } from "@/lib/server/userStats";
import { fetchTypedLedger, withRunningBalance } from "@/lib/server/typedLedger";
import { CREDIT_KIND_LABEL_AR } from "@/lib/creditKinds";
import { getAuthAccount } from "@/lib/server/authAccount";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  const { tables, users } = auth.ctx;
  const client = createAdminClient();

  let u: any;
  try { u = await users.get({ userId: id }); } catch { return NextResponse.json({ error: "المستخدم غير موجود" }, { status: 404 }); }

  const [account, topups, jobs, lastJob, ledgerRows, promo] = await Promise.all([
    getAuthAccount(client, id),
    listAll(tables, "topups", [Query.equal("userId", id), Query.orderDesc("createdAt")], 200),
    tables.listRows({ databaseId: "digr", tableId: "jobs", queries: [Query.equal("userId", id), Query.limit(1)] }),
    tables.listRows({ databaseId: "digr", tableId: "jobs", queries: [Query.equal("userId", id), Query.orderDesc("createdAt"), Query.limit(1)] }),
    fetchTypedLedger(client, { userId: id }, 5000).catch(() => null),
    client.from("promo_redemptions").select("code,redeemed_at").eq("user_id", id).order("redeemed_at", { ascending: false }),
  ]);
  const sum = summarizeTopups(topups);

  const history = ledgerRows ? withRunningBalance(ledgerRows) : [];
  const balance = history.length ? history[history.length - 1].runningBalance : 0;

  // Name of the admin who granted each manual credit (read-only directory lookups).
  const actorIds = [...new Set(history.map((r) => r.actorId).filter((x): x is string => Boolean(x)))];
  const actorNames = new Map<string, string>();
  await Promise.all(actorIds.map(async (actorId) => {
    const a = await getAuthAccount(client, actorId);
    actorNames.set(actorId, a.name || a.email || "مسؤول");
  }));

  return NextResponse.json({
    id: u.$id,
    name: account.name || u.name || "",
    email: account.email || u.email || "",
    registration: account.createdAt || u.registration,
    lastLogin: account.lastSignInAt || u.accessedAt || null,
    emailVerification: !!u.emailVerification,
    status: u.status,
    balance,
    totalTopupsEgp: sum.total,
    lastTopupAt: sum.last,
    jobs: jobs.total,
    lastJobAt: lastJob.rows?.[0]?.createdAt || null,
    promo: {
      used: !promo.error && (promo.data || []).length > 0,
      codes: promo.error ? [] : (promo.data || []).map((r: any) => ({ code: r.code, redeemedAt: r.redeemed_at })),
    },
    topups: topups.map((t) => ({ id: t.$id, amountEgp: t.amountEgp, confirmedAmountEgp: t.confirmedAmountEgp ?? null, status: t.status, createdAt: t.createdAt })),
    history: [...history].reverse().map((r) => ({
      id: r.id,
      at: r.createdAt,
      kind: r.kind,
      kindAr: CREDIT_KIND_LABEL_AR[r.kind],
      amount: r.delta,
      runningBalance: r.runningBalance,
      note: r.note,
      grantedBy: r.actorId ? actorNames.get(r.actorId) || "مسؤول" : null,
      jobId: r.jobId,
    })),
  });
}
