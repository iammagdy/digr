import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { summarizeReviewSpendByDay, type ReviewUsageRow } from "../../../../lib/server/reviewSpendDaily";
import { createAdminClient } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

const PAGE = 1000;
const MAX_PAGES = 30;

/** The owner's daily read of what the automatic review cost (read-only): `?days=7` (1 to 90), Cairo days, newest first. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const days = Math.min(90, Math.max(1, Math.floor(Number(req.nextUrl.searchParams.get("days"))) || 7));
  const since = new Date(Date.now() - (days + 1) * 86_400_000).toISOString();
  const rows: ReviewUsageRow[] = [];
  try {
    const client = createAdminClient();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { data, error } = await client.from("llm_usage").select("created_at, reason, cost_usd").like("reason", "relevance_review%").gte("created_at", since).order("created_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw error;
      rows.push(...((data as ReviewUsageRow[] | null) ?? []));
      if (!data || data.length < PAGE) break;
    }
  } catch {
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
  return NextResponse.json(summarizeReviewSpendByDay(rows, { days }));
}
