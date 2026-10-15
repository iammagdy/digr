import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "../../../../lib/supabase/server";
import { acceptQuoteSupabase } from "../../../../lib/supabase/quoteAccept";
import { getLiveProviderGateStatus } from "../../../../lib/server/providerGate";
import { sanitizeCustomerErrorMessage } from "../../../../functions/shared/catalogClient";
import { resolveInternalBaseUrl, createInternalWorkerAuthHeaders } from "../../../../lib/server/cronAuth";
import { dispatchWorkerChunk } from "../../../../lib/server/workerDispatch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    const gateStatus = getLiveProviderGateStatus();
    const isTestMockAllowed =
      process.env.NODE_ENV !== "production" && process.env.ENABLE_MOCK_PROVIDER === "true";

    if (!gateStatus.isReady && !isTestMockAllowed) {
      console.warn("[accept-quote:gate_blocked]", { reasonCode: gateStatus.reasonCode });
      return NextResponse.json(
        {
          success: false,
          error: gateStatus.messageAr,
          reasonCode: gateStatus.reasonCode,
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
        { success: false, error: sanitizeCustomerErrorMessage(acceptRes.errorAr || "تعذر اعتماد العرض.") },
        { status: acceptRes.statusCode || 400 }
      );
    }

    // Record initial activity event in job_events table
    try {
      await adminClient.from("job_events").insert({
        job_id: acceptRes.jobId,
        user_id: user.id,
        message: `تم قبول الطلب وجاري بدء التنفيذ (تم حجز ${acceptRes.reservedCredits} نقطة)`,
        units: 0,
        event_type: "info",
      });
    } catch (evtErr: any) {
      console.warn("[accept-quote:job_events_insert_warning]", evtErr?.message || "");
    }

    // Await the first bounded chunk so acceptance does not report a silent start
    // while the reserved job remains queued. Later chunks self-chain in worker.
    const acceptedJobId = acceptRes.jobId;
    let workerDispatch: { started: boolean; status?: number } = { started: false };
    try {
      const baseUrl = resolveInternalBaseUrl(req);
      workerDispatch = await dispatchWorkerChunk(
        baseUrl,
        acceptedJobId,
        0,
        createInternalWorkerAuthHeaders(acceptedJobId)
      );
      if (!workerDispatch.started) {
        console.error(`[accept-quote:worker_trigger_failed] jobId=${acceptedJobId} status=${workerDispatch.status}`);
      } else {
        console.log(`[accept-quote:worker_triggered] jobId=${acceptedJobId} status=${workerDispatch.status}`);
      }
    } catch (chunkErr: any) {
      console.error(`[accept-quote:worker_trigger_failed] jobId=${acceptedJobId} error=${chunkErr?.message || chunkErr}`);
    }

    return NextResponse.json({
      success: true,
      jobId: acceptRes.jobId,
      quoteId,
      reservedCredits: acceptRes.reservedCredits,
      workerDispatch,
      messageAr: workerDispatch.started
        ? "تم قبول الطلب وبدء التنفيذ."
        : "تم قبول الطلب وحجز النقاط، وتعذر بدء التنفيذ الآن. سنعيد المحاولة تلقائياً، وسيُحرر الحجز إذا لم يبدأ خلال دقيقة.",
    });
  } catch (err: any) {
    console.error("Accept quote error:", err);
    return NextResponse.json(
      { success: false, error: "حدث خطأ غير متوقع أثناء اعتماد العرض." },
      { status: 500 }
    );
  }
}
