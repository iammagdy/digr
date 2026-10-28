import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import { loadPlanningSession, stepAnswer } from "@/lib/modelPlanner/planningSession";

export const dynamic = "force-dynamic";

/** The state of a planning session without stepping it (a page that was closed and reopened reads the answer from here). The customer's own session only. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return NextResponse.json({ success: false, error: "bad_request" }, { status: 400 });
  const auth = await authenticateUser(req);
  if (!auth.ok) return auth.response;
  const session = await loadPlanningSession(createAdminClient(), id);
  if (!session || session.user_id !== auth.user.id) return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ success: true, ...stepAnswer(session) }, { headers: { "Cache-Control": "no-store" } });
}
