import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import { loadMissionStatus } from "@/lib/server/missionStatus";

export const dynamic = "force-dynamic";

/**
 * The mission panel's data for one job: the stages with their states, counts and remaining times, the model's notes and the newest rows. Read only. The customer reads their own job
 * (an admin any); a job that is not a model-planned mission answers `mission: false`.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: jobId } = await params;
    if (!jobId) return NextResponse.json({ success: false, error: "معرف الطلب مطلوب" }, { status: 400 });
    const auth = await authenticateUser(req);
    if (!auth.ok) return auth.response;
    const admin = createAdminClient();
    const { data: job } = await admin.from("jobs").select("id, user_id, status, delivered_units, target_volume_max, error_message, created_at, reserved_credits, charged_credits").eq("id", jobId).maybeSingle();
    if (!job) return NextResponse.json({ success: false, error: "الطلب غير موجود." }, { status: 404 });
    if (job.user_id !== auth.user.id && auth.user.appRole !== "admin") return NextResponse.json({ success: false, error: "غير مصرح بعرض هذا الطلب." }, { status: 403 });
    const status = await loadMissionStatus(admin, job);
    return NextResponse.json({ success: true, ...status }, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    console.warn("[jobs:mission_status_failed]", String(err?.message || "").slice(0, 120));
    return NextResponse.json({ success: true, mission: false });
  }
}
