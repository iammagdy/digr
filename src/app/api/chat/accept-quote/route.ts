import { isLongJob, sendJobNotice, startedNoticeFull } from "@/lib/server/jobNotices";
import { liveDriverMode } from "@/lib/server/driverHeartbeat";
import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "../../../../lib/supabase/server";
import { acceptQuoteSupabase } from "../../../../lib/supabase/quoteAccept";
import { getLiveProviderGateStatusFromSettings } from "../../../../lib/server/providerGate";
import { sanitizeCustomerErrorMessage } from "../../../../functions/shared/catalogClient";
import { resolveInternalBaseUrl, createInternalWorkerAuthHeaders } from "../../../../lib/server/cronAuth";
import { dispatchWorkerChunk, type WorkerChunkDispatchResult } from "../../../../lib/server/workerDispatch";
import { recordWorkerStartFailure, startFailureEventAr, startFailureStillApplies, WORKER_START_RETRY_REASON_AR } from "../../../../lib/server/workerStartFailure";
import { PEOPLE_SETTLEMENT_UNAVAILABLE_AR, requirePeopleSettlementRpc } from "../../../../functions/shared/peopleSettlementReadiness";
import { countActiveJobs, evaluateConcurrentJobs } from "../../../../lib/server/concurrentJobs";
import { getBusyState } from "../../../../lib/server/busyState";
import { fakeProviderActive } from "../../../../lib/server/fakeProviderMode";
import { hasExplicitQuoteApproval } from "../../../../lib/server/explicitQuoteApproval";
import { quoteScopeGaps } from "../../../../lib/quoteScopeGaps";
import { modelPlanAcceptRefusal } from "../../../../lib/modelPlanner/acceptGuard";

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
      (process.env.NODE_ENV !== "production" && process.env.ENABLE_MOCK_PROVIDER === "true") || fakeProviderActive();

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

    // The provider's daily allowance or capacity is used up: no new request is started, and nothing is reserved. Read only; fails open.
    const busy = await getBusyState(adminClient);
    if (busy.busy) {
      return NextResponse.json({ success: false, busy: true, error: busy.messageAr, queueAhead: busy.queueAhead, position: busy.position }, { status: 503 });
    }

    // One account may not run more requests at once than the room can afford: the next one waits for one of its own. Read only; before the reserve.
    const concurrency = evaluateConcurrentJobs(await countActiveJobs(adminClient, user.id));
    if (!concurrency.allowed) {
      return NextResponse.json({ success: false, concurrentLimit: true, error: concurrency.messageAr, activeJobs: concurrency.active, maxJobs: concurrency.max }, { status: 429 });
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

    // A model-planned quote with a blocked endpoint, or a sensitive step for an account that may not use it or gave no purpose: refused before anything is reserved.
    const modelPlanRefusal = await modelPlanAcceptRefusal(adminClient, user.id, readinessItems);
    if (modelPlanRefusal) return NextResponse.json({ success: false, error: modelPlanRefusal.error }, { status: modelPlanRefusal.status });

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
      const timedOut = chunkErr?.name === "TimeoutError" || chunkErr?.name === "AbortError";
      workerDispatch = { started: false, status: 0, body: { dispatchFailed: true }, failureCode: timedOut ? "dispatch_timeout" : "dispatch_exception" };
    }

    if (!workerDispatch.started && workerDispatch.body?.claimed !== false && !(await startFailureStillApplies(adminClient, acceptedJobId, workerDispatch.failureCode))) {
      // The dispatch was cut by our own time limit but the worker has the job (running, or already finished): that is not a failed start. Nothing is
      // recorded and no warning is written, so the job's status stays as the worker keeps it and it can settle.
      console.log(`[accept-quote:worker_running_after_timeout] jobId=${acceptedJobId}`);
      workerDispatch = { ...workerDispatch, started: true, failureCode: undefined, body: { ...workerDispatch.body, workerAlreadyRunning: true } };
    }

    if (!workerDispatch.started && workerDispatch.body?.claimed !== false) {
      // The job is already accepted and reserved: a failure while recording the attempt must never turn the answer into an error.
      const outcome = await recordWorkerStartFailure(adminClient, acceptedJobId).catch(() => ({ attemptCount: null, failed: false, released: false, releaseConfirmed: false }));
      workerDispatch = {
        ...workerDispatch,
        body: { ...workerDispatch.body, retrying: !outcome.failed, failed: outcome.failed },
      };
      // The reason goes into the request's activity as a plain sentence and a number, so the conversation, «طلباتي» and support agree.
      if (!outcome.failed) {
        try {
          await adminClient.from("job_events").insert({
            job_id: acceptedJobId,
            user_id: user.id,
            message: startFailureEventAr(workerDispatch.failureCode).message,
            units: 0,
            event_type: "warning",
          });
        } catch {
          // the retry itself never depends on this line
        }
      }
    }

    // A large request is announced in-app when it starts (never blocks or fails the acceptance).
    try {
      const { data: startedQuote } = await adminClient.from("plans_quotes").select("items").eq("id", quoteId).maybeSingle();
      const items = Array.isArray(startedQuote?.items) ? startedQuote.items : [];
      const volume = items.reduce((sum: number, item: any) => sum + (Number(item?.targetVolumeMax) || 0), 0);
      if (workerDispatch.started && isLongJob(volume)) await sendJobNotice(adminClient, user.id, acceptedJobId, startedNoticeFull({ targetVolumeMax: volume, driver: await liveDriverMode(adminClient) }));
    } catch {
      // a missing notice never changes the acceptance
    }

    return NextResponse.json({
      success: true,
      jobId: acceptRes.jobId,
      quoteId,
      reservedCredits: acceptRes.reservedCredits,
      workerDispatch,
      // which driver runs the long job: the page says «تقدر تقفل الصفحة» only for «cron»
      driverMode: await liveDriverMode(adminClient),
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
