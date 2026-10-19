import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "../../../../lib/supabase/server";
import { acceptQuoteSupabase } from "../../../../lib/supabase/quoteAccept";
import { getLiveProviderGateStatusFromSettings } from "../../../../lib/server/providerGate";
import { sanitizeCustomerErrorMessage } from "../../../../functions/shared/catalogClient";
import { resolveInternalBaseUrl, createInternalWorkerAuthHeaders } from "../../../../lib/server/cronAuth";
import { dispatchWorkerChunk, type WorkerChunkDispatchResult } from "../../../../lib/server/workerDispatch";
import { recordWorkerStartFailure, WORKER_START_RETRY_REASON_AR } from "../../../../lib/server/workerStartFailure";
import { PEOPLE_SETTLEMENT_UNAVAILABLE_AR, requirePeopleSettlementRpc } from "../../../../functions/shared/peopleSettlementReadiness";
import { hasExplicitQuoteApproval } from "../../../../lib/server/explicitQuoteApproval";
import { quoteScopeGaps } from "../../../../lib/quoteScopeGaps";

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

    // Acceptance and reservation are allowed only from the explicit plan-card
    // approval action. Polling, retries, nudges, and chat refreshes must never
    // infer consent from an accepted/active quote.
    if (!hasExplicitQuoteApproval(body)) {
      return NextResponse.json(
        { success: false, error: "اضغط زر الموافقة على الخطة لبدء البحث." },
        { status: 400 }
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

    // Scope guard: incomplete plans with scope gaps are never accepted or reserved
    const gaps = quoteScopeGaps(readinessItems);
    if (gaps.length > 0) {
      return NextResponse.json(
        { success: false, error: "الخطة غير مكتملة", gaps },
        { status: 409 }
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
    let workerDispatch: WorkerChunkDispatchResult = { started: false, status: 0, body: {} };
    try {
      const baseUrl = resolveInternalBaseUrl(req);
      workerDispatch = await dispatchWorkerChunk(
        baseUrl,
        acceptedJobId,
        0,
        createInternalWorkerAuthHeaders(acceptedJobId)
      );
      if (!workerDispatch.started) {
        console.error(`[accept-quote:worker_trigger_failed] jobId=${acceptedJobId} status=${workerDispatch.status} code=${workerDispatch.failureCode || "dispatch_failed"}`);
      } else {
        console.log(`[accept-quote:worker_triggered] jobId=${acceptedJobId} status=${workerDispatch.status}`);
      }
    } catch (chunkErr: any) {
      console.error(`[accept-quote:worker_trigger_failed] jobId=${acceptedJobId} code=${chunkErr?.name || "dispatch_failed"}`);
      workerDispatch = { started: false, status: 0, body: { dispatchFailed: true } };
    }

    if (!workerDispatch.started && workerDispatch.body?.claimed !== false) {
      const outcome = await recordWorkerStartFailure(adminClient, acceptedJobId);
      workerDispatch = {
        ...workerDispatch,
        body: { ...workerDispatch.body, retrying: !outcome.failed, failed: outcome.failed },
      };
    }

    return NextResponse.json({
      success: true,
      jobId: acceptRes.jobId,
      quoteId,
      reservedCredits: acceptRes.reservedCredits,
      workerDispatch,
      messageAr: workerDispatch.started
        ? "تم قبول الطلب وبدء التنفيذ."
        : WORKER_START_RETRY_REASON_AR,
    });
  } catch (err: any) {
    console.error("Accept quote error:", err);
    return NextResponse.json(
      { success: false, error: "حدث خطأ غير متوقع أثناء اعتماد العرض." },
      { status: 500 }
    );
  }
}
