import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import { defaultModelPlannerConfig } from "@/lib/modelPlanner/chatTurn";
import { advancePlanningSession, loadPlanningSession, logPlanningUsage, stepAnswer } from "@/lib/modelPlanner/planningSession";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * ONE step of a planning session (a model call or a source call, a few of them while the time allows; never past the function limit). The page calls it again while the answer is «running»;
 * the background driver does the same when the page is gone. The customer's own session only.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!ID_RE.test(id)) return NextResponse.json({ success: false, error: "bad_request" }, { status: 400 });
    const auth = await authenticateUser(req);
    if (!auth.ok) return auth.response;
    const admin = createAdminClient();
    const session = await loadPlanningSession(admin, id);
    if (!session || session.user_id !== auth.user.id) return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
    if (session.status !== "running") return NextResponse.json({ success: true, ...stepAnswer(session) }, { headers: { "Cache-Control": "no-store" } });
    const startedAt = Date.now();
    const config = defaultModelPlannerConfig();
    const adv = await advancePlanningSession({ client: admin, tables: admin, config, session, startedAtMs: startedAt });
    await logPlanningUsage(admin, auth.user.id, config.transport.model, adv.usageDelta, Date.now() - startedAt, adv.status === "done" ? `planning_step_${adv.shaped.outputType}` : "planning_step");
    return NextResponse.json({ success: true, ...stepAnswer(adv.session) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    console.warn("[chat:planning_step_failed]", String(err?.message || "").slice(0, 120));
    return NextResponse.json({ success: true, status: "running" }, { headers: { "Cache-Control": "no-store" } });
  }
}
