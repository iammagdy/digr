import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { parseCallLogQuery, readProviderCallLog } from "@/lib/server/multiProvider/callLog";
import { withJobContext } from "@/lib/server/adminCallsLog";

export const dynamic = "force-dynamic";

/**
 * The API call log of one provider: time, capability (Arabic internal label), job, units, cost, status, duration. Newest first,
 * 25 per page, filters by UTC date and status, with the job label, the owner and a link to the job on every row. READ ONLY and admin only: provider names, USD and capability labels never reach a
 * customer route.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const parsed = parseCallLogQuery(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.messageAr }, { status: 400 });
  try {
    const client = createAdminClient();
    const result = await readProviderCallLog(client, parsed.value);
    // Each row also says what its job is (a short Arabic label), who owns it (with the test-account flag) and where to open it. Read only.
    const rows = await withJobContext(client, result.rows).catch(() => result.rows);
    return NextResponse.json({ log: { ...result, rows } }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل سجل الاستدعاءات الآن." }, { status: 500 });
  }
}
