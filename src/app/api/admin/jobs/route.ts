import { NextRequest, NextResponse } from "next/server";
import { Query } from "node-appwrite";
import { authenticateAdmin, listAll, userDirectory } from "@/lib/server/adminAuth";
import { DAY_MS, refundPointsByJob } from "@/lib/server/adminStats";

export const dynamic = "force-dynamic";

type UiStatus = "done" | "running" | "failed" | "refunded";
function uiStatus(j: any): UiStatus {
  if (j.status === "failed") return "failed";
  if (j.status === "cancelled") return "refunded";
  if (j.status === "done") return (j.rowsCollected ?? 0) === 0 && (j.chargedCredits ?? 0) === 0 ? "refunded" : "done";
  return "running";
}

function platformOf(slug: string): string {
  const s = (slug || "").toLowerCase();
  if (s.includes("tiktok")) return "تيك توك";
  if (s.includes("instagram")) return "إنستجرام";
  if (s.includes("youtube")) return "يوتيوب";
  if (s.includes("facebook")) return "فيسبوك";
  if (s.includes("linkedin")) return "لينكدإن";
  if (s.includes("reddit")) return "ريديت";
  if (s.startsWith("x-") || s.includes("twitter")) return "إكس";
  return "الإنترنت العام";
}

/** Research jobs with the user, records requested/delivered, points held/charged and the TREG cost. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables, users } = auth.ctx;
  const now = Date.now();
  const monthAgo = new Date(now - 30 * DAY_MS).toISOString();

  const jobs = (await tables.listRows({ databaseId: "digr", tableId: "jobs", queries: [Query.orderDesc("createdAt"), Query.limit(100)] })).rows as any[];
  const ids = jobs.map((j) => j.$id);

  const [quotes, costs, convs, monthJobs, ledger] = await Promise.all([
    ids.length ? tables.listRows({ databaseId: "digr", tableId: "plans_quotes", queries: [Query.equal("jobId", ids), Query.limit(100)] }).then((r) => r.rows as any[]).catch(() => []) : [],
    ids.length ? tables.listRows({ databaseId: "digr", tableId: "provider_costs", queries: [Query.equal("jobId", ids), Query.equal("provider", "treg"), Query.limit(100)] }).then((r) => r.rows as any[]).catch(() => []) : [],
    tables.listRows({ databaseId: "digr", tableId: "conversations", queries: [Query.orderDesc("updatedAt"), Query.limit(100)] }).then((r) => r.rows as any[]).catch(() => []),
    listAll(tables, "jobs", [Query.greaterThanEqual("createdAt", monthAgo)], 20000),
    listAll(tables, "credit_ledger", [Query.greaterThanEqual("createdAt", monthAgo), Query.equal("type", ["release", "charge"])], 20000),
  ]);
  const quoteByJob = new Map(quotes.map((q) => [q.jobId, q]));
  const convTitle = new Map(convs.map((c) => [c.$id, c.title]));
  const costByJob = new Map<string, number>();
  for (const c of costs) costByJob.set(c.jobId, (costByJob.get(c.jobId) ?? 0) + (c.costEgp || 0));
  const dir = await userDirectory(users, jobs.map((j) => j.userId));

  const statusFilter = req.nextUrl.searchParams.get("status") || "all";
  const rows = jobs.map((j) => {
    const q = quoteByJob.get(j.$id);
    let target = "";
    try { const p = JSON.parse(j.params || "{}"); target = p.username ? `بيانات حساب @${String(p.username).replace(/^@/, "")}` : p.query || ""; } catch { /* ignore */ }
    return {
      id: j.$id,
      title: (q && convTitle.get(q.conversationId)) || q?.summaryAr || target || "طلب بحث",
      platform: platformOf(j.templateSlug),
      createdAt: j.createdAt,
      user: dir.get(j.userId)?.name || dir.get(j.userId)?.email || "—",
      requested: q?.targetVolumeMax ?? null,
      delivered: j.rowsCollected ?? 0,
      held: j.reservedCredits ?? 0,
      charged: j.chargedCredits ?? 0,
      costEgp: costByJob.get(j.$id) ?? null,
      status: uiStatus(j),
    };
  }).filter((r) => statusFilter === "all" || r.status === statusFilter);

  const finished = monthJobs.filter((j) => j.status === "done" || j.status === "failed");
  const refunds = [...refundPointsByJob(ledger as any).values()].reduce((a, r) => a + r.refund, 0);

  return NextResponse.json({
    jobs: rows,
    stats: {
      last30: monthJobs.filter((j) => j.status !== "cancelled").length,
      runningNow: jobs.filter((j) => j.status === "running" || j.status === "queued").length,
      successRate: finished.length ? (finished.filter((j) => j.status === "done").length / finished.length) * 100 : null,
      refundedPoints: refunds,
    },
  });
}
