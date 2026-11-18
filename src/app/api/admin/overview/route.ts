import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { MISSION_TABLE } from "@/lib/agentMission/constants";
import { withoutAddonRows } from "@/lib/agentMission/addonMarker";
import { OVERVIEW_COLUMNS, OVERVIEW_ROW_CAP, RUNNING_STATUSES, parseOverviewRange, summarizeMissions, type OverviewMissionRow } from "@/lib/server/adminOverview";

export const dynamic = "force-dynamic";

/**
 * Admin only, read only. What is NEW on the overview (DT-20261118-06 §3.3): the mission card and the live mission numbers, from the `missions` table.
 * Money, users and activity stay on /api/admin/stats (unchanged); the page calls both in parallel.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const range = parseOverviewRange(req.nextUrl.searchParams.get("range"));
  const now = Date.now();
  const since = new Date(now - range * 2 * 86_400_000).toISOString();
  const client = createAdminClient();
  const [windowRead, liveRead] = await Promise.all([
    client.from(MISSION_TABLE).select(OVERVIEW_COLUMNS).gte("created_at", since).order("created_at", { ascending: false }).limit(OVERVIEW_ROW_CAP),
    client.from(MISSION_TABLE).select(OVERVIEW_COLUMNS).in("status", [...RUNNING_STATUSES]).order("created_at", { ascending: false }).limit(OVERVIEW_ROW_CAP),
  ]);
  if (windowRead.error || liveRead.error) return NextResponse.json({ error: "تعذّر قراءة المهام الآن." }, { status: 500 });
  const rows = Array.isArray(windowRead.data) ? (windowRead.data as OverviewMissionRow[]) : [];
  const live = Array.isArray(liveRead.data) ? (liveRead.data as OverviewMissionRow[]) : [];
  const body = summarizeMissions({ rows: withoutAddonRows(rows), liveRows: withoutAddonRows(live), range, now, truncated: rows.length >= OVERVIEW_ROW_CAP });
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
