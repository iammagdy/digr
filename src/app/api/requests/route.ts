import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { buildRequestIndex } from "@/lib/requests/buildIndex";
import { isRequestTab } from "@/lib/requests/tabs";
import { resolveMissionViewer } from "@/lib/server/missionViewer";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The customer's list of requests for «طلباتي»: ?tab=all|running|done|ended|refunded &q=<words of the request> &offset= &limit= (20 by default).
 * It answers the tab counts (for the current search), the requests of the page (newest first) and, on the «all» tab, the questions and plans that wait for the customer.
 * Only the customer's own requests; read only, except that planning with no live worker is ended and unanswered questions and plans past 72 hours (or beyond the newest 5) are expired (a status change; nothing is held before approval).
 */
export async function GET(req: NextRequest) {
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const sp = req.nextUrl.searchParams;
  const tabParam = sp.get("tab") ?? "all";
  const index = await buildRequestIndex(createAdminClient(), {
    userId: auth.viewer.userId,
    tab: isRequestTab(tabParam) ? tabParam : "all",
    q: sp.get("q") ?? "",
    offset: Number(sp.get("offset") ?? 0),
    limit: Number(sp.get("limit") ?? 0) || undefined,
  });
  return NextResponse.json({ success: true, ...index }, { headers: { "Cache-Control": "no-store" } });
}
