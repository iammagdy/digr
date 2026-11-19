import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { MISSION_TABLE } from "@/lib/agentMission/constants";
import { withoutAddonRows } from "@/lib/agentMission/addonMarker";
import {
  ADDON_PLAN_PATH, ENDED_STATUSES, OVERVIEW_COLUMNS, OVERVIEW_PAGES, OVERVIEW_PAGE_SIZE, RECENT_COLUMNS, RUNNING_STATUSES,
  parseOverviewRange, recentMissionsOf, summarizeMissions, type OverviewMissionRow,
} from "@/lib/server/adminOverview";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
/** Read for the feed; add-on rows are removed after the read, so a few more than RECENT_MISSIONS. */
const RECENT_READ = 40;
const NO_STORE = { "Cache-Control": "no-store" };
const readError = () => NextResponse.json({ error: "تعذّر قراءة المهام الآن." }, { status: 500 });

type Client = ReturnType<typeof createAdminClient>;

/** The missions created since `since`, newest first (then by id: a total order, so a page boundary never loses a row), in pages of OVERVIEW_PAGE_SIZE (the API's cap), at most OVERVIEW_PAGES pages. `truncated`: the last page read was full at the cap. */
async function readWindow(client: Client, since: string): Promise<{ rows: OverviewMissionRow[]; truncated: boolean } | null> {
  const rows: OverviewMissionRow[] = [];
  for (let page = 0; page < OVERVIEW_PAGES; page += 1) {
    const from = page * OVERVIEW_PAGE_SIZE;
    const { data, error } = await client.from(MISSION_TABLE).select(OVERVIEW_COLUMNS).gte("created_at", since).order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, from + OVERVIEW_PAGE_SIZE - 1);
    if (error) return null;
    const got = Array.isArray(data) ? (data as unknown as OverviewMissionRow[]) : [];
    rows.push(...got);
    if (got.length < OVERVIEW_PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/**
 * Admin only, read only. What is NEW on the overview (DT-20261118-06 §3.3): the mission card, the live mission numbers and the activity feed's requests, from the `missions` table.
 * Money, users and the rest of the activity stay on /api/admin/stats (unchanged); the page calls both in parallel.
 * `?part=live`: only the running missions (the tiles and the attention card refresh it every 60 s; the heavy window is read on a range change only).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const range = parseOverviewRange(req.nextUrl.searchParams.get("range"));
  const now = Date.now();
  const client = createAdminClient();
  const readLive = () => client.from(MISSION_TABLE).select(OVERVIEW_COLUMNS).in("status", [...RUNNING_STATUSES]).order("created_at", { ascending: false }).limit(OVERVIEW_PAGE_SIZE);

  if (req.nextUrl.searchParams.get("part") === "live") {
    const liveRead = await readLive();
    if (liveRead.error) return readError();
    const liveRows = withoutAddonRows(Array.isArray(liveRead.data) ? (liveRead.data as unknown as OverviewMissionRow[]) : []);
    return NextResponse.json({ live: summarizeMissions({ rows: [], liveRows, range, now, truncated: false }).live }, { headers: NO_STORE });
  }

  // The window is exactly `range` days.
  const since = new Date(now - range * DAY_MS).toISOString();
  // previousSince: the start of the period before the window, read ONLY for the success-rate arrow (MissionOverview.successPctPrev) and only as two head counts (no rows).
  const previousSince = new Date(now - 2 * range * DAY_MS).toISOString();
  const previousCount = (narrow: (q: any) => any) =>
    narrow(client.from(MISSION_TABLE).select("id", { count: "exact", head: true })).gte("created_at", previousSince).lt("created_at", since).is(ADDON_PLAN_PATH, null) as PromiseLike<{ count: number | null; error: unknown }>;

  const [windowRead, liveRead, prevEnded, prevSucceeded, recentRead] = await Promise.all([
    readWindow(client, since),
    readLive(),
    previousCount((q) => q.in("status", [...ENDED_STATUSES])),
    previousCount((q) => q.eq("status", "completed").gte("delivered_units", 1)),
    client.from(MISSION_TABLE).select(RECENT_COLUMNS).order("created_at", { ascending: false }).limit(RECENT_READ),
  ]);
  if (!windowRead || liveRead.error || recentRead.error) return readError();
  const live = Array.isArray(liveRead.data) ? (liveRead.data as unknown as OverviewMissionRow[]) : [];
  // a failed previous count only hides the arrow
  const previous = prevEnded.error || prevSucceeded.error ? { ended: null, succeeded: null } : { ended: prevEnded.count ?? 0, succeeded: prevSucceeded.count ?? 0 };
  const body = summarizeMissions({ rows: withoutAddonRows(windowRead.rows), liveRows: withoutAddonRows(live), range, now, truncated: windowRead.truncated, previous });
  const recent = Array.isArray(recentRead.data) ? (recentRead.data as unknown as Array<Record<string, unknown>>) : [];
  return NextResponse.json({ ...body, recentMissions: recentMissionsOf(recent) }, { headers: NO_STORE });
}
