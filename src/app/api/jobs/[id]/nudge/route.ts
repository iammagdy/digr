import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient } from "../../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

function getWorkerBaseUrl(): string {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  }
  return "http://127.0.0.1:3000";
}

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

    // 4. Stalled or unassigned lease: Trigger worker chunk safely with CRON_SECRET
    if (process.env.CRON_SECRET) {
      const chunkUrl = `${getWorkerBaseUrl()}/api/worker/chunk`;
      fetch(chunkUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({
          jobId: job.id,
          expectedStep: job.step ?? 0,
        }),
      }).catch((fetchErr) => {
        console.error("Worker trigger on nudge error:", fetchErr);
      });
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
