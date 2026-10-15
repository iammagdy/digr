import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createServerSideClient } from "../../../../../lib/supabase/server";
import { resolveInternalBaseUrl, createInternalWorkerAuthHeaders } from "../../../../../lib/server/cronAuth";
import { dispatchWorkerChunk } from "../../../../../lib/server/workerDispatch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const ZERO_ATTEMPT_START_TIMEOUT_MS = 60_000;

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
      .select("id, user_id, status, step, attempt_count, created_at, lease_until, next_attempt_at, updated_at")
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
    if (["completed", "done", "failed", "cancelled", "refused"].includes(job.status)) {
      return NextResponse.json({
        success: true,
        nudged: false,
        status: job.status,
        message: "المهمة مكتملة أو منتهية بالفعل.",
      });
    }

    const now = new Date();

    if (job.status !== "queued" && job.status !== "running") {
      return NextResponse.json({
        success: true,
        nudged: false,
        status: job.status,
        message: "حالة المهمة لا تسمح ببدء جزء جديد.",
      });
    }

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

    // A newly accepted job that never acquired its first chunk must not hold
    // customer points indefinitely. The normal retry path gets 60 seconds;
    // after that, use the approved atomic release RPC (no direct ledger writes).
    const createdAt = job.created_at ? new Date(job.created_at).getTime() : Number.NaN;
    if (
      job.status === "queued" &&
      Number(job.attempt_count || 0) === 0 &&
      Number.isFinite(createdAt) &&
      now.getTime() - createdAt >= ZERO_ATTEMPT_START_TIMEOUT_MS
    ) {
      const adminClient = createAdminClient();
      const { data: released, error: releaseError } = await adminClient.rpc("release_job_atomic", {
        p_job_id: job.id,
        p_error_message: "تعذر بدء التنفيذ خلال دقيقة. تم إلغاء الطلب وإرجاع كامل النقاط المحجوزة.",
      });
      if (releaseError || released?.success !== true) {
        console.error(`[nudge:release_failed] jobId=${job.id} code=${releaseError?.code || "rpc_failed"}`);
        return NextResponse.json(
          { success: false, error: "تعذر بدء المهمة أو تأكيد إرجاع الرصيد. سيُعاد التحقق تلقائياً." },
          { status: 503 }
        );
      }
      try {
        await adminClient.from("job_events").insert({
          job_id: job.id,
          user_id: user.id,
          message: "تعذر بدء التنفيذ خلال دقيقة. تم إلغاء الطلب وإرجاع كامل النقاط المحجوزة.",
          units: 0,
          event_type: "error",
        });
      } catch (eventError: any) {
        console.warn(`[nudge:release_event_failed] jobId=${job.id} code=${eventError?.code || "unknown"}`);
      }
      return NextResponse.json({
        success: true,
        nudged: false,
        released: true,
        status: "failed",
        releasedCredits: released.released_credits,
        message: "تعذر بدء المهمة خلال دقيقة، وتم إرجاع النقاط المحجوزة.",
      });
    }

    // 4. Stalled or unassigned lease: Trigger worker chunk safely
    try {
      const baseUrl = resolveInternalBaseUrl(req);
      const workerResult = await dispatchWorkerChunk(
        baseUrl,
        job.id,
        job.step ?? 0,
        createInternalWorkerAuthHeaders(job.id)
      ).catch((fetchErr) => {
        console.error("Worker trigger on nudge error:", fetchErr);
        throw fetchErr;
      });
      if (workerResult.status < 200 || workerResult.status >= 300) {
        return NextResponse.json(
          { success: false, nudged: false, status: job.status, error: "تعذر بدء جزء التنفيذ. ستتم إعادة المحاولة تلقائياً.", workerStatus: workerResult.status },
          { status: 502 }
        );
      }
      return NextResponse.json({
        success: true,
        nudged: workerResult.started,
        status: job.status,
        jobId: job.id,
        step: job.step ?? 0,
        worker: workerResult.body,
        message: "تم تنفيذ محاولة تنشيط المهمة.",
      });
    } catch (nudgeErr) {
      console.warn("[nudge:trigger_warn]", nudgeErr);
    }

    return NextResponse.json(
      { success: false, nudged: false, status: job.status, error: "تعذر الاتصال بمحرك التنفيذ. ستتم إعادة المحاولة تلقائياً." },
      { status: 502 }
    );
  } catch (err: any) {
    console.error("Nudge job route error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ غير متوقع." },
      { status: 500 }
    );
  }
}
