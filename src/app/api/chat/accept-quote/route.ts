import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "../../../../lib/supabase/server";
import { acceptQuoteSupabase } from "../../../../lib/supabase/quoteAccept";
import { getLiveProviderGateStatusFromSettings } from "../../../../lib/server/providerGate";
import { sanitizeCustomerErrorMessage } from "../../../../functions/shared/catalogClient";
import { InvalidInternalOriginError, resolveInternalBaseUrl, createInternalWorkerAuthHeaders } from "../../../../lib/server/cronAuth";
import { dispatchWorkerChunk } from "../../../../lib/server/workerDispatch";
import { PEOPLE_SETTLEMENT_UNAVAILABLE_AR, requirePeopleSettlementRpc } from "../../../../functions/shared/peopleSettlementReadiness";

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
    const adminClient = createAdminClient();
    const gateStatus = await getLiveProviderGateStatusFromSettings(adminClient);
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

    // Never reserve credits for a decision-maker quote unless its field-level
    // settlement function is installed. The worker repeats this check before
    // reserving provider spend as protection for already accepted jobs.
    const { data: quoteForReadiness } = await adminClient
      .from("plans_quotes")
      .select("items")
      .eq("id", quoteId)
      .maybeSingle();
    let readinessItems = quoteForReadiness?.items;
    if (typeof readinessItems === "string") {
      try { readinessItems = JSON.parse(readinessItems); } catch { readinessItems = []; }
    }
    const isPeopleQuote = Array.isArray(readinessItems) && readinessItems.some((item: any) =>
      item?.capabilitySlug === "professional-people-search" || item?.endpointId === "treg.people.search"
    );
    if (isPeopleQuote && !(await requirePeopleSettlementRpc(adminClient))) {
      return NextResponse.json(
        { success: false, error: PEOPLE_SETTLEMENT_UNAVAILABLE_AR },
        { status: 503 }
      );
    }

    // 2. Accept Quote & Reserve Credits atomically via Service Role
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

    // Replace the planning-history entry with the accepted job history entry.
    try {
      const { error: historyUpdateError } = await adminClient
        .from("messages")
        .update({ request_status: "accepted" })
        .eq("user_id", user.id)
        .eq("request_quote_id", quoteId);
      if (historyUpdateError) throw historyUpdateError;
    } catch (historyUpdateError: any) {
      console.warn("[accept-quote:request_history_update_failed]", historyUpdateError?.message || "unknown_error");
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
      if (chunkErr instanceof InvalidInternalOriginError) {
        const { data: released, error: releaseError } = await adminClient.rpc("release_job_atomic", {
          p_job_id: acceptedJobId,
          p_error_message: "تعذر بدء التنفيذ بسبب إعداد غير صالح. تم إلغاء الطلب وإرجاع النقاط المحجوزة.",
        });
        if (releaseError || released?.success !== true) {
          console.error(`[accept-quote:invalid_origin_release_failed] jobId=${acceptedJobId} code=${releaseError?.code || "rpc_failed"}`);
          return NextResponse.json(
            { success: false, jobId: acceptedJobId, error: "تعذر بدء البحث. لم نتمكن من تأكيد إرجاع النقاط، وسيُعاد التحقق تلقائياً." },
            { status: 503 }
          );
        }
        try {
          await adminClient.from("job_events").insert({
            job_id: acceptedJobId,
            user_id: user.id,
            message: "تعذر بدء التنفيذ بسبب إعداد غير صالح. تم إلغاء الطلب وإرجاع النقاط المحجوزة.",
            units: 0,
            event_type: "error",
          });
        } catch (eventError: any) {
          console.warn(`[accept-quote:invalid_origin_event_failed] jobId=${acceptedJobId} code=${eventError?.code || "unknown"}`);
        }
        return NextResponse.json(
          {
            success: false,
            jobId: acceptedJobId,
            releasedCredits: released.released_credits,
            error: "تعذر بدء البحث بسبب إعداد غير صالح. أُعيدت النقاط المحجوزة إلى رصيدك.",
          },
          { status: 503 }
        );
      }
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
