import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { listVersionSummaries, ownsMission, versionsAvailable } from "@/lib/agentMission/stage4/versionList";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const notFound = () => NextResponse.json({ success: false, error: "not_found" }, { status: 404, headers: NO_STORE });

/**
 * STAGE 4, S2 (docs/STAGE-4.md section 8), behind DIGER_STAGE4_VERSIONS: the versions of the customer's own mission, from the create-only objects `versions/vNNNN.json` of its folder: { version, parent, reason, createdAt, digest }[], oldest first.
 * With the flag off this route does not exist (404, before anyone is asked who they are); a mission that is not theirs is a 404 as well. Read-only: no write, no price, no charge. Never cached.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // THE FLAG FIRST: off answers before the id, the viewer or the database is looked at
  if (!versionsAvailable()) return notFound();
  const id = safeMissionId((await ctx.params).id);
  if (!id) return NextResponse.json({ success: false, error: "bad_request" }, { status: 400, headers: NO_STORE });
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  try {
    if (!(await ownsMission(client, id, auth.viewer.userId))) return notFound();
    return NextResponse.json({ success: true, versions: await listVersionSummaries(client, id) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ success: false, error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
