import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import { fetchNewestLedgerRows } from "@/lib/server/typedLedger";
import { CREDIT_KIND_LABEL_AR } from "@/lib/creditKinds";
import { walletDisplayText, walletNoteForDisplay } from "@/lib/walletText";
import { jobWalletLineAr, missionWalletLineAr } from "@/lib/agentMission/walletLine";

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
    // the money line of every finished mission whose jobs appear in this history (the customer's own missions only): the wallet groups the hold, the charge and the release of one mission under it
    const lineByJob = new Map<string, string>();
    try {
      const jobIds = [...new Set(rows.map((r) => r.jobId).filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, 200);
      if (jobIds.length > 0) {
        const { data } = await (admin as any).from("missions").select("job_id,status,delivered_units,charged_points,reserved_points,plan_public").eq("user_id", auth.user.id).in("job_id", jobIds);
        for (const m of (data ?? []) as Array<Parameters<typeof missionWalletLineAr>[0]>) { const line = missionWalletLineAr(m); if (line && m.job_id) lineByJob.set(m.job_id, line); }
      }
    } catch { /* the rows are then listed one by one */ }
    t = mark("missions", t);
    // a job from before missions existed has no mission row: its one line is built from the job's own stored numbers, so the wallet lists it once too
    try {
      const missing = [...new Set(rows.map((r) => r.jobId).filter((x): x is string => typeof x === "string" && x.length > 0 && !lineByJob.has(x)))].slice(0, 200);
      if (missing.length > 0) {
        const { data } = await (admin as any).from("jobs").select("id,status,delivered_units,charged_credits,reserved_credits").eq("user_id", auth.user.id).in("id", missing);
        for (const j of (data ?? []) as Array<Parameters<typeof jobWalletLineAr>[0]>) { const line = jobWalletLineAr(j); if (line) lineByJob.set(j.id, line); }
      }
    } catch { /* those rows are then listed one by one */ }
    mark("jobs", t);
    const newestFirst = rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      type: r.type,
      kind: r.kind,
      labelAr: walletDisplayText(CREDIT_KIND_LABEL_AR[r.kind]),
      jobId: r.jobId,
      missionLineAr: r.jobId ? lineByJob.get(r.jobId) ?? null : null,
      topupId: r.topupId,
      // The stored note is never rewritten: it is cleaned (internal ids, Latin names) only in what the customer is sent.
      note: r.kind === "admin_grant" ? "" : walletNoteForDisplay(r.note),
      createdAt: r.createdAt,
    }));
    return NextResponse.json({ success: true, rows: newestFirst }, { headers: { "Server-Timing": [...marks, `total;dur=${Date.now() - started}`].join(", ") } });
  } catch {
    return NextResponse.json({ success: false, error: "تعذّر تحميل سجل الحركات الآن." }, { status: 500 });
  }
}
