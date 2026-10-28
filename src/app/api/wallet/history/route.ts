import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import { fetchNewestLedgerRows } from "@/lib/server/typedLedger";
import { CREDIT_KIND_LABEL_AR } from "@/lib/creditKinds";
import { walletDisplayText, walletNoteForDisplay } from "@/lib/walletText";
import { missionWalletLineAr } from "@/lib/agentMission/walletLine";

export const dynamic = "force-dynamic";

/** The signed-in customer's own credit history, newest first, with the kind of every row. Never shows an admin's identity. */
export async function GET(req: NextRequest) {
  const auth = await authenticateUser(req);
  if (!auth.ok) return auth.response;
  try {
    const admin = createAdminClient();
    const rows = await fetchNewestLedgerRows(admin, { userId: auth.user.id }, 500);
    // the money line of every finished mission whose jobs appear in this history (the customer's own missions only): the wallet groups the hold, the charge and the release of one mission under it
    const lineByJob = new Map<string, string>();
    try {
      const jobIds = [...new Set(rows.map((r) => r.jobId).filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, 200);
      if (jobIds.length > 0) {
        const { data } = await (admin as any).from("missions").select("job_id,status,delivered_units,charged_points,reserved_points,plan_public").eq("user_id", auth.user.id).in("job_id", jobIds);
        for (const m of (data ?? []) as Array<Parameters<typeof missionWalletLineAr>[0]>) { const line = missionWalletLineAr(m); if (line && m.job_id) lineByJob.set(m.job_id, line); }
      }
    } catch { /* the rows are then listed one by one */ }
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
    return NextResponse.json({ success: true, rows: newestFirst });
  } catch {
    return NextResponse.json({ success: false, error: "تعذّر تحميل سجل الحركات الآن." }, { status: 500 });
  }
}
