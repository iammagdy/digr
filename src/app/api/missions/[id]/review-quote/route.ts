import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { stage4RouteOpen } from "@/lib/agentMission/stage4/testGate";
import { reviewPreviewAvailable, reviewQuoteFor, reviewableVersions } from "@/lib/agentMission/stage4/reviewPreview";
import { parseVersionNumber } from "@/lib/agentMission/stage4/versionFile";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, error: string) => NextResponse.json({ success: false, error }, { status, headers: NO_STORE });

/**
 * MONEY PR 7c (2B-2 task 2), behind DIGER_STAGE4_REVIEW (read FIRST: off is a 404 before the id, the viewer or the database is looked at). READ-ONLY.
 *   ?version=N : the price preview of reviewing published version N of the customer's own mission, computed here by the existing `reviewCellsOf` and `reviewCard` from the stored cells:
 *                { quote: { state: "offer", version, reason, cells, points } } or the state «reuse» (a completed review exists: free), «blocked» (another add-on is open), «too_large» or «nothing_to_review» (no price).
 *   (no version): the published versions the page may offer, { versions: [{ version, reason }] }.
 * 400 a bad id or a version that is not exactly one positive whole number; 401 not signed in; 404 a mission that is not theirs and one that does not exist (the same answer), or a version that is not published (a pending one is not);
 * 503 the storage or the database could not answer (never «missing», never a guessed price); 500 a stored object that is not this mission's version (never priced). Never cached. No hold, no charge, no release, no refund, no write, no provider, no model.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await stage4RouteOpen(req, ["DIGER_STAGE4_REVIEW"], reviewPreviewAvailable))) return refuse(404, "not_found");
  const id = safeMissionId((await ctx.params).id);
  const params = new URL(req.url).searchParams;
  const asked = params.getAll("version");
  const version = asked.length === 1 ? parseVersionNumber(asked[0]) : null;
  if (!id || asked.length > 1 || (asked.length === 1 && version === null)) return refuse(400, "bad_request");
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  if (version === null) {
    const r = await reviewableVersions(client, { missionId: id, userId: auth.viewer.userId });
    return r.ok ? NextResponse.json({ success: true, versions: r.versions }, { headers: NO_STORE }) : refuse(r.status, r.error);
  }
  const r = await reviewQuoteFor(client, { missionId: id, userId: auth.viewer.userId, version });
  return r.ok ? NextResponse.json({ success: true, quote: r.quote }, { headers: NO_STORE }) : refuse(r.status, r.error);
}
