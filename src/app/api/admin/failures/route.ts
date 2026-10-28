import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { hidesTestAccounts } from "@/lib/server/adminTestAccounts";
import { KIND_LABEL_AR, loadFailureBoard } from "@/lib/server/failureBoard";

export const dynamic = "force-dynamic";

/** «لوحة الأعطال»: every failed or empty operation of the last 7 days with its reason, and the summary by service and reason. READ ONLY, admin only. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const board = await loadFailureBoard(createAdminClient(), { hideTest: hidesTestAccounts(req.nextUrl.searchParams.get("hideTest")) });
    return NextResponse.json({ success: true, kinds: KIND_LABEL_AR, ...board }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل لوحة الأعطال الآن." }, { status: 500 });
  }
}
