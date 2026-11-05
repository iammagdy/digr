import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { fileWorkflowFor, workflowAvailable } from "@/lib/agentMission/stage4/fileWorkflow";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, error: string) => NextResponse.json({ success: false, error }, { status, headers: NO_STORE });

/**
 * STAGE C, behind DIGER_STAGE4_REVIEW or DIGER_STAGE4_EDITS (read FIRST: both off is a 404 before the id, the viewer or the database is looked at). READ-ONLY: the status of every review or edit request on the customer's own file, { workflow: { items: [{ kind, version, newVersion, phase, held?, chargedPoints? }] } },
 * decided on the server from the add-on rows and from what is verified published (docs: fileWorkflow.ts). Never a request id, job id or path. 400 a bad id; 401 not signed in; 404 a file that is not theirs and one that does not exist (the same answer);
 * 503 the database or the storage could not answer (never an empty list, never «delivered»). Never cached. No hold, no charge, no release, no write, no provider.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!workflowAvailable()) return refuse(404, "not_found");
  const id = safeMissionId((await ctx.params).id);
  if (!id) return refuse(400, "bad_request");
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const r = await fileWorkflowFor(createAdminClient(), { missionId: id, userId: auth.viewer.userId });
  return r.ok ? NextResponse.json({ success: true, workflow: r.workflow }, { headers: NO_STORE }) : refuse(r.status, r.error);
}
