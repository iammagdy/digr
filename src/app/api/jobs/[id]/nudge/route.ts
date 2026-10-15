import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient } from "../../../../../lib/supabase/server";
import { resolveInternalBaseUrl, createInternalWorkerAuthHeaders } from "../../../../../lib/server/cronAuth";

export const dynamic = "force-dynamic";

const nudgeRateLimitCache = new Map<string, number>();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const resolvedParams = await params;
    const jobId = resolvedParams?.id;

    if (!jobId || typeof jobId !== "string") {
      return NextResponse.json(
        { success: false, error: "معرف المهمة مطلوب." },
        { status: 400 }
      );
    }

    // 1. Authenticate user strictly via Supabase Auth
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    let user = null;

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7).trim();
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        user = data.user;
      }
    } else {
      const { data, error } = await supabase.auth.getUser();
      if (!error && data?.user) {
        user = data.user;
      }
    }

    if (!user) {
      return NextResponse.json(
        { success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    // 2. Fetch job and verify ownership
    const { data: job, error: jobErr } = await supabase
      .from("jobs")
      .select("id, user_id, status, step, lease_until, next_attempt_at, updated_at")
      .eq("id", jobId)
      .maybeSingle();

    if (jobErr || !job) {
      return NextResponse.json(
        { success: false, error: "المهمة غير موجودة." },
        { status: 404 }
      );
    }

    if (job.user_id !== user.id) {
      return NextResponse.json(
        { success: false, error: "ممنوع. لا يمكنك تنشيط مهمة لا تملكها." },
        { status: 403 }
      );
    }

    // 2b. Rate Limiting: max 1 nudge per 10 seconds per user/job
    const cacheKey = `${user.id}_${jobId}`;
    const nowTime = Date.now();
    const lastNudge = nudgeRateLimitCache.get(cacheKey) || 0;
    if (nowTime - lastNudge < 10_000) {
      return NextResponse.json(
        { success: false, error: "تم تنشيط المهمة مؤخراً. يرجى الانتظار بضع ثوانٍ قبل تكرار المحاولة." },
        { status: 429 }
      );
    }
    nudgeRateLimitCache.set(cacheKey, nowTime);

    // 3. Status guards
    if (job.status === "completed" || job.status === "failed") {
      return NextResponse.json({
        success: true,
        nudged: false,
        status: job.status,
        message: "المهمة مكتملة أو منتهية بالفعل.",
      });
    }

    const now = new Date();

    // If an active lease is held, don't interrupt it
    if (job.lease_until && new Date(job.lease_until) > now) {
      return NextResponse.json({
        success: true,
        nudged: false,
        status: job.status,
        message: "المهمة قيد التنفيذ حالياً تحت حيازة نشطة.",
      });
    }

    // If exponential backoff is active, respect backoff
    if (job.next_attempt_at && new Date(job.next_attempt_at) > now) {
      return NextResponse.json({
        success: true,
        nudged: false,
        status: job.status,
        message: "المهمة في فترة انتظار لإعادة المحاولة التلقائية.",
      });
    }

    // 4. Stalled or unassigned lease: Trigger worker chunk safely
    try {
      const baseUrl = resolveInternalBaseUrl(req);
      const authHeaders = createInternalWorkerAuthHeaders(job.id);
      fetch(`${baseUrl}/api/worker/chunk`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({
          jobId: job.id,
          expectedStep: job.step ?? 0,
        }),
      }).catch((fetchErr) => {
        console.error("Worker trigger on nudge error:", fetchErr);
      });
    } catch (nudgeErr) {
      console.warn("[nudge:trigger_warn]", nudgeErr);
    }

    return NextResponse.json({
      success: true,
      nudged: true,
      jobId: job.id,
      step: job.step ?? 0,
      message: "تم تنشيط المهمة بنجاح.",
    });
  } catch (err: any) {
    console.error("Nudge job route error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ غير متوقع." },
      { status: 500 }
    );
  }
}
