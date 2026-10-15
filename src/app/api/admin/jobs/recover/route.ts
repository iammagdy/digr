import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Authenticated Admin Route to safely recover/release stuck jobs
 * using the existing atomic PostgreSQL release_job_atomic function.
 * Strictly verifies admin role before performing any operation.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const body = await req.json().catch(() => ({}));
    const { jobId, reason } = body;

    if (!jobId || typeof jobId !== "string") {
      return NextResponse.json(
        { success: false, error: "معرف المهمة (jobId) مطلوب." },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();
    const releaseReason =
      reason || "تم إلغاء الطلب واسترجاع الرصيد المحجوز بواسطة الإدارة.";

    const { data: releaseData, error: relErr } = await adminClient.rpc(
      "release_job_atomic",
      {
        p_job_id: jobId,
        p_error_message: releaseReason,
        p_force: true,
      }
    );

    if (relErr) {
      console.error("[admin:recover_job_rpc_error]", relErr);
      return NextResponse.json(
        { success: false, error: relErr.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: Boolean(releaseData?.success),
      jobId,
      releasedCredits: releaseData?.released_credits ?? 0,
      alreadyReleased: Boolean(releaseData?.already_released),
      message: "تم استرداد الرصيد المحجوز بنجاح.",
    });
  } catch (err: any) {
    console.error("[admin:recover_job_exception]", err);
    return NextResponse.json(
      { success: false, error: "حدث خطأ غير متوقع أثناء استرداد المهمة." },
      { status: 500 }
    );
  }
}
