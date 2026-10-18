import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import { fetchTypedLedger } from "@/lib/server/typedLedger";
import { CREDIT_KIND_LABEL_AR } from "@/lib/creditKinds";

export const dynamic = "force-dynamic";

/** The signed-in customer's own credit history, newest first, with the kind of every row. Never shows an admin's identity. */
export async function GET(req: NextRequest) {
  const auth = await authenticateUser(req);
  if (!auth.ok) return auth.response;
  try {
    const rows = await fetchTypedLedger(createAdminClient(), { userId: auth.user.id }, 5000);
    const newestFirst = [...rows].reverse().slice(0, 500).map((r) => ({
      id: r.id,
      delta: r.delta,
      type: r.type,
      kind: r.kind,
      labelAr: CREDIT_KIND_LABEL_AR[r.kind],
      jobId: r.jobId,
      topupId: r.topupId,
      note: r.kind === "admin_grant" ? "" : r.note,
      createdAt: r.createdAt,
    }));
    return NextResponse.json({ success: true, rows: newestFirst });
  } catch {
    return NextResponse.json({ success: false, error: "تعذّر تحميل سجل الحركات الآن." }, { status: 500 });
  }
}
