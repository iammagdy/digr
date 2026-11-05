import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { listReviewedVersions, readReviewReport, reviewReportAvailable } from "@/lib/agentMission/stage4/reviewReport";
import { parseVersionNumber } from "@/lib/agentMission/stage4/versionFile";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, error: string) => NextResponse.json({ success: false, error }, { status, headers: NO_STORE });

/**
 * STAGE A, behind DIGER_STAGE4_REVIEW (read FIRST: off is a 404 before the id, the viewer or the database is looked at). READ-ONLY: it shows a report that already exists, which is free; it makes no add-on row and moves no money.
 *   ?version=N : the PUBLISHED review report of version N of the customer's own mission, checked against that version (docs: reviewReport.ts): { report: { version, reason, score, cells, rowsReviewed, reviewedAt, issues } }.
 *   (no version): the versions that have a published report, { versions: [N, ...] }.
 * 400 a bad id or a version that is not exactly one positive whole number; 401 not signed in; 404 a mission that is not theirs and one that does not exist (the same answer), or a version or report that is not published (a pending report is not);
 * 503 the storage or the database could not answer (never «missing», never a guessed score); 500 a stored version or report that is not exactly what it claims to be (never shown). Never cached.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!reviewReportAvailable()) return refuse(404, "not_found");
  const id = safeMissionId((await ctx.params).id);
  const asked = new URL(req.url).searchParams.getAll("version");
  const version = asked.length === 1 ? parseVersionNumber(asked[0]) : null;
  if (!id || asked.length > 1 || (asked.length === 1 && version === null)) return refuse(400, "bad_request");
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  if (version === null) {
    const r = await listReviewedVersions(client, { missionId: id, userId: auth.viewer.userId });
    return r.ok ? NextResponse.json({ success: true, versions: r.versions }, { headers: NO_STORE }) : refuse(r.status, r.error);
  }
  const r = await readReviewReport(client, { missionId: id, userId: auth.viewer.userId, version });
  return r.ok ? NextResponse.json({ success: true, report: r.report }, { headers: NO_STORE }) : refuse(r.status, r.error);
}
