import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin, listAll, userDirectory, Query } from "@/lib/server/adminAuth";
import { DAY_MS } from "@/lib/server/adminStats";
import { ADMIN_JOB_STATE_LABEL_AR, ADMIN_JOB_TAB_STATES, adminJobState, releasedPoints, successRate, type AdminJobState } from "@/lib/server/adminJobState";
import { hidesTestAccounts, testAccountIds } from "@/lib/server/adminTestAccounts";

export const dynamic = "force-dynamic";

function platformOf(slug: string): string {
  const s = (slug || "").toLowerCase();
  if (s === "mp-business-contacts") return "جهات اتصال الأعمال (مزودون متعددون)";
  if (s.includes("tiktok")) return "تيك توك";
  if (s.includes("instagram")) return "إنستجرام";
  if (s.includes("youtube")) return "يوتيوب";
  if (s.includes("facebook")) return "فيسبوك";
  if (s.includes("linkedin")) return "لينكدإن";
  if (s.includes("reddit")) return "ريديت";
  if (s.startsWith("x-") || s.includes("twitter")) return "إكس";
  return "الإنترنت العام";
}

/**
 * Research jobs with the user, records requested/delivered, points held/charged and the provider's cost (USD, read only).
 * Read only: SELECT only. `hideTest` (default on) leaves out the test accounts from every card, count and row; it changes no data.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables, users } = auth.ctx;
  const now = Date.now();
  const monthAgo = new Date(now - 30 * DAY_MS).toISOString();
  const hideTest = hidesTestAccounts(req.nextUrl.searchParams.get("hideTest"));

  // A link from a call log opens ONE job (read only): `?job=<id>`. Without it, the 100 newest jobs as before.
  const oneJob = (req.nextUrl.searchParams.get("job") || "").trim();
  const oneJobId = /^[A-Za-z0-9_.:-]{1,120}$/.test(oneJob) ? oneJob : "";
  const [page, monthJobs, release, openJobs, profiles]: any[][] = await Promise.all([
    tables.listRows({ databaseId: "digr", tableId: "jobs", queries: oneJobId ? [Query.equal("$id", oneJobId), Query.limit(1)] : [Query.orderDesc("createdAt"), Query.limit(100)] }).then((r: any) => (r.rows || []) as any[]),
    listAll(tables, "jobs", [Query.greaterThanEqual("createdAt", monthAgo)], 20000),
    listAll(tables, "credit_ledger", [Query.greaterThanEqual("createdAt", monthAgo), Query.equal("type", "release")], 20000),
    listAll(tables, "jobs", [Query.equal("status", ["queued", "running"])], 5000),
    listAll(tables, "profiles", [], 20000),
  ]);

  const testIds = testAccountIds(profiles as any[]);
  const visible = (row: any) => !hideTest || !testIds.has(row.userId);
  const stateOf = (j: any): AdminJobState => adminJobState({
    id: j.$id, status: j.status, lease_until: j.leaseUntil ?? null, updated_at: j.updatedAt ?? null, created_at: j.createdAt ?? null,
    delivered_units: j.deliveredUnits, charged_credits: j.chargedCredits,
  }, now);

  // Provider cost per job: every TREG cost row of the listed jobs (paged, so no job is cut at 100 rows).
  const ids = page.map((j) => j.$id);
  const costs = ids.length ? await listAll(tables, "provider_costs", [Query.equal("jobId", ids), Query.equal("provider", "treg")], 20000) : [];
  const costByJob = new Map<string, number>();
  for (const c of costs as any[]) costByJob.set(c.jobId, (costByJob.get(c.jobId) ?? 0) + (Number(c.costUsd) || 0));

  const dir = await userDirectory(users, page.map((j) => j.userId));
  const statusFilter = req.nextUrl.searchParams.get("status") || "all";
  const tab = ADMIN_JOB_TAB_STATES[statusFilter] ?? "all";
  const rows = page.filter(visible).map((j) => {
    let target = "";
    try { const p = JSON.parse(j.params || "{}"); target = p.username ? `بيانات حساب @${String(p.username).replace(/^@/, "")}` : p.query || ""; } catch { /* ignore */ }
    return {
      id: j.$id,
      title: target || "طلب بحث",
      platform: platformOf(j.templateSlug || j.endpointId || j.capabilitySlug),
      createdAt: j.createdAt,
      user: dir.get(j.userId)?.name || dir.get(j.userId)?.email || "—",
      requested: typeof j.targetVolumeMax === "number" ? j.targetVolumeMax : null,
      delivered: Number(j.deliveredUnits) || 0,
      held: Number(j.reservedCredits) || 0,
      charged: Number(j.chargedCredits) || 0,
      costUsd: costByJob.get(j.$id) ?? null,
      chain: [j.templateSlug, j.endpointId, j.capabilitySlug].some((v) => v === "mp-business-contacts"),
      status: stateOf(j),
    };
  }).filter((r) => tab === "all" || tab.includes(r.status));

  const period = monthJobs.filter((j) => j.status !== "cancelled" && visible(j));
  const open = openJobs.filter(visible).map((j) => {
    const state = stateOf(j);
    return {
      id: j.$id,
      status: state,
      label: ADMIN_JOB_STATE_LABEL_AR[state],
      ageMinutes: Math.max(0, Math.floor((now - new Date(j.createdAt).getTime()) / 60000)),
      idleMinutes: Math.max(0, Math.floor((now - new Date(j.updatedAt ?? j.createdAt).getTime()) / 60000)),
    };
  });
  const countOpen = (...states: AdminJobState[]) => open.filter((o) => states.includes(o.status)).length;

  return NextResponse.json({
    hideTest,
    jobs: rows,
    open,
    stats: {
      last30: period.length,
      runningNow: countOpen("running", "queued"),
      stalled: countOpen("stalled"),
      queuedStuck: countOpen("queued_stuck"),
      success: successRate(period.map((j) => ({ state: stateOf(j), delivered: Number(j.deliveredUnits) || 0 }))),
      released: releasedPoints(release.filter(visible)),
    },
  });
}
