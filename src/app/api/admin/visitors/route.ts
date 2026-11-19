import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { SUMMARY_ROW_LIMIT, parseRange, rangeStart, summarizeVisits, type VisitEventRow } from "@/lib/analytics/summary";
import { MISSION_TABLE } from "@/lib/agentMission/constants";
import { ADDON_MARKER_COLUMN, withoutAddonRows } from "@/lib/agentMission/addonMarker";
import { ADDON_PLAN_PATH } from "@/lib/server/adminOverview";

export const dynamic = "force-dynamic";

const PAGE = 1000;
const COLUMNS = "visitor_id,session_id,kind,path,country,device_class,started_at,duration_seconds,user_id";

/**
 * The admin «الزوّار» numbers. READ ONLY and admin only. Bounded on purpose: at most SUMMARY_ROW_LIMIT visit rows are read (in pages of 1,000, newest first), and the
 * screen is told when a range is larger than that. The sign-ups and the submitted requests are counted from the accounts and missions tables themselves
 * (head counts, no rows), and the funnel's last step is a read-only look at the first request of the accounts that logged in. Before the table exists
 * (its SQL is a proposal until the owner applies it) the answer is `available: false`, never an error.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const range = parseRange(req.nextUrl.searchParams.get("range"));
  const since = rangeStart(range);
  try {
    const admin = createAdminClient();
    const rows: VisitEventRow[] = [];
    for (let from = 0; from < SUMMARY_ROW_LIMIT; from += PAGE) {
      let query = admin.from("visitor_events").select(COLUMNS).order("started_at", { ascending: false }).range(from, from + PAGE - 1);
      if (since) query = query.gte("started_at", since.toISOString());
      const { data, error } = await query;
      if (error) {
        // 42P01: the table is not applied yet
        if (String(error.code) === "42P01" || /does not exist|schema cache/i.test(String(error.message))) return NextResponse.json({ available: false }, { headers: { "Cache-Control": "no-store" } });
        throw error;
      }
      rows.push(...((data ?? []) as VisitEventRow[]));
      if (!data || data.length < PAGE) break;
    }
    const truncated = rows.length >= SUMMARY_ROW_LIMIT;

    // Funnel, last step: the first submitted request of the accounts that logged in on the visits of this range (read only, bounded).
    const userIds = [...new Set(rows.filter((row) => row.kind === "login" && row.user_id).map((row) => String(row.user_id)))].slice(0, 500);
    const firstRequestByUser = new Map<string, string>();
    if (userIds.length > 0) {
      // DT-20261118-06: a customer request is inserted in `missions` only (customerActions.ts); an add-on row (a paid review or fix) is not a request. 1,000 rows: the API's own page size.
      const { data: missions } = await admin.from(MISSION_TABLE).select(`user_id,created_at,${ADDON_MARKER_COLUMN}`).in("user_id", userIds).order("created_at", { ascending: true }).limit(1000);
      for (const mission of withoutAddonRows((missions ?? []) as Array<{ user_id: string; created_at: string; addon?: unknown }>)) if (!firstRequestByUser.has(mission.user_id)) firstRequestByUser.set(mission.user_id, mission.created_at);
    }

    const countSince = async (table: "profiles" | typeof MISSION_TABLE): Promise<number | null> => {
      try {
        let query = admin.from(table).select("id", { count: "exact", head: true });
        if (table === MISSION_TABLE) query = query.is(ADDON_PLAN_PATH, null);
        if (since) query = query.gte("created_at", since.toISOString());
        const { count, error } = await query;
        return error ? null : count ?? 0;
      } catch {
        return null;
      }
    };
    const [accounts, requests] = await Promise.all([countSince("profiles"), countSince(MISSION_TABLE)]);

    return NextResponse.json({
      available: true,
      summary: summarizeVisits(rows, { range, since, truncated, firstRequestByUser }),
      newAccounts: accounts,
      submittedRequests: requests,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل أرقام الزوّار الآن." }, { status: 500 });
  }
}
