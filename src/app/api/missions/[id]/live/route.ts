import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { AGENT_BUCKET, MISSION_TABLE } from "@/lib/agentMission/constants";
import { newestSnapshotName, parsePollRequest, pollResponse, type LiveSnapshot } from "@/lib/agentMission/stage2/liveSheet";
import { stage2FlagForMission } from "@/lib/agentMission/stage2/askEditAction";
import { ADDON_MARKER_SELECT, isAddonRow } from "@/lib/agentMission/stage2/addonMarkerRule";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LIVE_FOLDER = "live";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * STAGE 2 S7 (docs/STAGE-2.md): THE LIVE SHEET'S POLLING ROUTE. The customer's own mission only (the viewer is resolved like the mission route; another customer's mission is «not found»),
 * and only when DIGER_STAGE2_LIVE_SHEET is on for the viewer (unset: 404, as if the route did not exist). It reads the NEWEST create-only snapshot the worker wrote (`live/snap_*`, the last
 * name of the listing) and answers ONE poll with the shared contract (`pollResponse`): «nothing changed» for the same cursor, else the counter, the newest work-log lines and one bounded
 * window of rows. Read only: nothing is written, nothing is charged. Never cached.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = safeMissionId((await ctx.params).id);
  if (!id) return NextResponse.json({ success: false, error: "bad_request" }, { status: 400, headers: NO_STORE });
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  if (!(await stage2FlagForMission(client, "DIGER_STAGE2_LIVE_SHEET", id))) return NextResponse.json({ success: false, error: "not_found" }, { status: 404, headers: NO_STORE });
  const { data: mission } = await client.from(MISSION_TABLE).select(`id,user_id,${ADDON_MARKER_SELECT}`).eq("id", id).maybeSingle();
  // an add-on row (a review or edit of a delivered file) is not a research mission and has no live sheet: «not found» (Money PR 7e)
  if (!mission || mission.user_id !== auth.viewer.userId || isAddonRow(mission)) return NextResponse.json({ success: false, error: "not_found" }, { status: 404, headers: NO_STORE });
  let snapshot: LiveSnapshot | null = null;
  try {
    const bucket = client.storage.from(AGENT_BUCKET);
    // the newest names first (a long job writes many snapshots: the listing is read from its end, never from its first page)
    const listed = await bucket.list(`${id}/${LIVE_FOLDER}`, { limit: 20, sortBy: { column: "name", order: "desc" } });
    // the final snapshot (equal to the file) always wins over a running one (NOV 6 2026: a fresh writer id could sort the done name before a running one at the same sequence)
    const newest = newestSnapshotName(((listed?.data ?? []) as Array<{ name: string }>).map((o) => o.name));
    if (newest) {
      const got = await bucket.download(`${id}/${LIVE_FOLDER}/${newest}`);
      if (!got?.error && got?.data) {
        const parsed = JSON.parse(await got.data.text()) as LiveSnapshot;
        if (parsed && parsed.v === 1 && parsed.missionId === id && Array.isArray(parsed.sheets)) snapshot = parsed;
      }
    }
  } catch { snapshot = null; /* the screen keeps today's panel and asks again later */ }
  return NextResponse.json({ success: true, ...pollResponse(snapshot, parsePollRequest(req.nextUrl.searchParams)) }, { headers: NO_STORE });
}
