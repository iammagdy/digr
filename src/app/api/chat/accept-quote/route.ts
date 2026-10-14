import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "../../../../lib/supabase/server";
import { acceptQuoteSupabase } from "../../../../lib/supabase/quoteAccept";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { quoteId, expectedPlanHash } = body;

    if (!quoteId || typeof quoteId !== "string") {
      return NextResponse.json(
        { success: false, error: "معرف عرض السعر مطلوب" },
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

    // Enforce email verification
    const emailVerified = !!user.email_confirmed_at || user.user_metadata?.email_verified === true;
    if (!emailVerified) {
      return NextResponse.json(
        { success: false, error: "فعّل بريدك الإلكتروني أولًا لبدء البحث." },
        { status: 403 }
      );
    }

    // A1 Safety Guard: Do not silently accept a quote and start fake work when live provider is disabled
    const isLiveProviderReady =
      process.env.TREG_LIVE === "true" && Boolean(process.env.TREG_TOKEN?.trim());
    const isTestMockAllowed =
      process.env.NODE_ENV !== "production" && process.env.ENABLE_MOCK_PROVIDER === "true";

    if (!isLiveProviderReady && !isTestMockAllowed) {
      return NextResponse.json(
        {
          success: false,
          error:
            "محرك استخراج البيانات المباشر غير مفعل حالياً؛ لم يتم حجز أو خصم أي نقاط من رصيدك.",
        },
        { status: 503 }
      );
    }

    // 2. Accept Quote & Reserve Credits atomically via Service Role
    const adminClient = createAdminClient();
    const acceptRes = await acceptQuoteSupabase(adminClient, {
      userId: user.id,
      quoteId,
      expectedPlanHash,
    });

    if (!acceptRes.success || !acceptRes.jobId) {
      return NextResponse.json(
        { success: false, error: acceptRes.errorAr || "تعذر اعتماد العرض." },
        { status: acceptRes.statusCode || 400 }
      );
    }

    // Record initial activity event in job_events table
    try {
      await adminClient.from("job_events").insert({
        job_id: acceptRes.jobId,
        user_id: user.id,
        message: `تم حجز ${acceptRes.reservedCredits} نقطة وتأكيد الطلب. جاري البدء...`,
        units: 0,
        event_type: "info",
      });
    } catch (evtErr: any) {
      console.warn("[accept-quote:job_events_insert_warning]", evtErr?.message || "");
    }

    // Trigger initial chunk execution (Hobby Design B)
    if (process.env.CRON_SECRET) {
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : (process.env.NEXT_PUBLIC_SITE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
      fetch(`${baseUrl}/api/worker/chunk`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({
          jobId: acceptRes.jobId,
          expectedStep: 0,
        }),
      }).catch((chunkErr) => {
        console.error("Worker trigger on quote accept failed:", chunkErr);
      });
    }

    return NextResponse.json({
      success: true,
      jobId: acceptRes.jobId,
      quoteId,
      reservedCredits: acceptRes.reservedCredits,
      messageAr: "تم بدء استخراج البيانات بنجاح!",
    });
  } catch (err: any) {
    console.error("Accept quote error:", err);
    return NextResponse.json(
      { success: false, error: "حدث خطأ غير متوقع أثناء اعتماد العرض." },
      { status: 500 }
    );
  }
}
