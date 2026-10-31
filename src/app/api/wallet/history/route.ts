import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import { fetchNewestLedgerRows } from "@/lib/server/typedLedger";
import { CREDIT_KIND_LABEL_AR } from "@/lib/creditKinds";
import { walletDisplayText, walletNoteForDisplay } from "@/lib/walletText";
import { jobFactsForWallet, jobLedgerLineAr } from "@/lib/agentMission/walletLine";
import { isMethodologyChargeId, jobLedgerTotals, methodologyPurchaseLineAr } from "@/lib/walletView";
import { readLedgerRowsOfJobs } from "@/lib/server/jobLedger";

export const dynamic = "force-dynamic";

/** The signed-in customer's own credit history, newest first, with the kind of every row. Never shows an admin's identity. */
export async function GET(req: NextRequest) {
  // where the time goes, per stage, in the standard Server-Timing header (read in the browser's network panel): the 10-second wait of the wallet could not be located from the code alone
  const started = Date.now();
  const marks: string[] = [];
  const mark = (name: string, since: number) => { marks.push(`${name};dur=${Date.now() - since}`); return Date.now(); };
  const auth = await authenticateUser(req);
  let t = mark("auth", started);
  if (!auth.ok) return auth.response;
  try {
    const admin = createAdminClient();
    const rows = await fetchNewestLedgerRows(admin, { userId: auth.user.id }, 500);
    t = mark("ledger", t);
    // THE ONE LINE OF EACH JOB, from the ledger: the points are the sums of the job's own credit_ledger rows (all of them, not only the newest 500 shown), the same sign the balance uses; the mission or job row
    // supplies only how many items were delivered and what to call them. A failed read gives no line (the rows are then listed one by one), never a guess.
    const lineByJob = new Map<string, string>();
    try {
      const jobIds = [...new Set(rows.map((r) => r.jobId).filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, 200);
      if (jobIds.length > 0) {
        const totals = jobLedgerTotals(await readLedgerRowsOfJobs(admin, auth.user.id, jobIds));
        t = mark("jobledger", t);
        const { data: missions } = await (admin as any).from("missions").select("job_id,delivered_units,plan_public").eq("user_id", auth.user.id).in("job_id", jobIds);
        const missionOf = new Map<string, { delivered_units: number | null; plan_public: unknown }>();
        for (const m of (missions ?? []) as Array<{ job_id: string | null; delivered_units: number | null; plan_public: unknown }>) if (m.job_id) missionOf.set(m.job_id, m);
        const olderIds = jobIds.filter((id) => !missionOf.has(id));
        const jobOf = new Map<string, { delivered_units: number | null }>();
        if (olderIds.length > 0) {
          const { data: jobs } = await (admin as any).from("jobs").select("id,delivered_units").eq("user_id", auth.user.id).in("id", olderIds);
          for (const j of (jobs ?? []) as Array<{ id: string; delivered_units: number | null }>) jobOf.set(j.id, j);
        }
        for (const id of jobIds) {
          const line = jobLedgerLineAr(totals.get(id), jobFactsForWallet(missionOf.get(id), jobOf.get(id)));
          if (line) lineByJob.set(id, line);
        }
      }
    } catch { /* the rows are then listed one by one */ }
    mark("facts", t);
    const newestFirst = rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      type: r.type,
      kind: r.kind,
      // the methodology purchase (`chg_meth_<job id>`) is a line of its own, not a row of the job's delivery line
      labelAr: isMethodologyChargeId(r.id) ? methodologyPurchaseLineAr(r.delta) : walletDisplayText(CREDIT_KIND_LABEL_AR[r.kind]),
      jobId: r.jobId,
      missionLineAr: r.jobId && !isMethodologyChargeId(r.id) ? lineByJob.get(r.jobId) ?? null : null,
      topupId: r.topupId,
      // The stored note is never rewritten: it is cleaned (internal ids, Latin names) only in what the customer is sent.
      note: r.kind === "admin_grant" || isMethodologyChargeId(r.id) ? "" : walletNoteForDisplay(r.note),
      createdAt: r.createdAt,
    }));
    return NextResponse.json({ success: true, rows: newestFirst }, { headers: { "Server-Timing": [...marks, `total;dur=${Date.now() - started}`].join(", ") } });
  } catch {
    return NextResponse.json({ success: false, error: "تعذّر تحميل سجل الحركات الآن." }, { status: 500 });
  }
}
