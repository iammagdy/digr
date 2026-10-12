import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "../../../../lib/supabase/server";
import { verifyCronSecret } from "../../../../lib/server/cronAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby maximum

function getWorkerBaseUrl(): string {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  }
  return "http://127.0.0.1:3000";
}

export async function POST(req: NextRequest) {
  // 1. Authenticate with CRON_SECRET (timing-safe)
  if (!verifyCronSecret(req)) {
    return NextResponse.json(
      { success: false, error: "غير مصرح. رمز الأمان الخاص بالمهام المجدولة غير صالح." },
      { status: 401 }
    );
  }

  const body = await req.json().catch(() => ({}));

  // Mock Provider Injection Guard: only allowed if NODE_ENV !== 'production' AND ENABLE_MOCK_PROVIDER === 'true'
  const isMockRequested = Boolean(
    body?.mockProvider ||
    req.headers.get("x-mock-provider") === "true" ||
    process.env.PROVIDER_MOCK === "true"
  );

  if (isMockRequested && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      {
        success: false,
        error: "حقن المزود الوهمي محظور في بيئة الإنتاج.",
      },
      { status: 403 }
    );
  }

  let jobId: string | undefined = body?.jobId;
  let expectedStep: number | undefined = body?.expectedStep;
  const adminClient = createAdminClient();

  try {
    // 2. If jobId is not provided, pick up the oldest runnable job
    if (!jobId) {
      const nowIso = new Date().toISOString();
      const { data: nextJob, error: pickErr } = await adminClient
        .from("jobs")
        .select("id, step")
        .in("status", ["queued", "running"])
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (pickErr || !nextJob) {
        return NextResponse.json({
          success: true,
          message: "لا توجد مهام جاهزة للتنفيذ حالياً.",
          claimed: false,
        });
      }
      jobId = nextJob.id;
      expectedStep = nextJob.step ?? 0;
    }

    if (expectedStep === undefined || expectedStep === null) {
      expectedStep = 0;
    }

    // 3. Claim chunk atomically (lease duration 60s)
    const { data: claimData, error: claimErr } = await adminClient.rpc("claim_job_chunk", {
      p_job_id: jobId,
      p_expected_step: expectedStep,
      p_lease_seconds: 60,
    });

    if (claimErr) {
      return NextResponse.json(
        { success: false, error: claimErr.message, claimed: false },
        { status: 400 }
      );
    }

    if (!claimData?.claimed) {
      return NextResponse.json({
        success: false,
        claimed: false,
        reason: claimData?.error || "lease_not_acquired",
        details: claimData,
      });
    }

    const {
      user_id: userId,
      step: currentStep,
      current_cursor: currentCursor,
      delivered_units: currentDelivered = 0,
      target_volume_max: targetMax = 1,
      target_volume_min: targetMin = 1,
      endpoint_id: endpointId,
      unit_price: unitPrice = 1,
    } = claimData;

    const useMockProvider = Boolean(
      isMockRequested &&
      process.env.NODE_ENV !== "production" &&
      process.env.ENABLE_MOCK_PROVIDER === "true"
    );

    // If simulating provider error during test runs
    if (useMockProvider && body?.simulateProviderError) {
      throw new Error("خطأ محاكى من مزود البيانات لاختبار إعادة المحاولة.");
    }

    // 5. Reserve Provider Spend Check ($0.80 daily cap)
    const providerSlug = endpointId || "provider";
    const estimatedCostUsd = useMockProvider
      ? (body?.mockEstimatedCostUsd ?? 0.005)
      : (process.env.TREG_LIVE === "true" ? 0.01 : 0);

    let spendCostId: number | null = null;
    if (estimatedCostUsd > 0) {
      const { data: spendReserve, error: spendErr } = await adminClient.rpc(
        "reserve_provider_spend_atomic",
        {
          p_job_id: jobId,
          p_provider: providerSlug,
          p_estimated_cost_usd: estimatedCostUsd,
          p_daily_cap_usd: 0.80,
        }
      );

      if (spendErr || !spendReserve?.allowed) {
        await adminClient.rpc("record_chunk_failure", {
          p_job_id: jobId,
          p_error_message: "تم تجاوز الحد اليومي لاستهلاك مزود البيانات ($0.80 USD).",
        });
        return NextResponse.json(
          {
            success: false,
            error: "تم تجاوز الحد اليومي لاستهلاك المزود.",
            capExceeded: true,
          },
          { status: 429 }
        );
      }
      spendCostId = spendReserve.cost_id;
    }

    // 6. Bounded chunk execution (process up to 10 units per chunk)
    const remainingUnits = Math.max(0, targetMax - currentDelivered);
    const chunkBatchSize = Math.min(10, Math.max(1, remainingUnits));
    const newDeliveredUnits = currentDelivered + chunkBatchSize;
    const isDone = newDeliveredUnits >= targetMax;
    const nextCursor = isDone ? "completed" : `step_${currentStep + 1}_cursor`;
    const actualCostUsd = useMockProvider ? 0.004 : estimatedCostUsd;

    // Commit provider spend if reserved
    if (spendCostId !== null) {
      await adminClient.rpc("commit_provider_spend", {
        p_cost_id: spendCostId,
        p_actual_cost_usd: actualCostUsd,
        p_units: chunkBatchSize,
      });
    }

    // 6. Write partial artifact to storage (best effort)
    const partialData = {
      jobId,
      step: currentStep,
      batchUnits: chunkBatchSize,
      totalDelivered: newDeliveredUnits,
      timestamp: new Date().toISOString(),
    };

    try {
      await adminClient.storage
        .from("partials")
        .upload(
          `${jobId}/step_${currentStep}.json`,
          Buffer.from(JSON.stringify(partialData)),
          { contentType: "application/json", upsert: true }
        );
    } catch {
      // Storage upload is best effort during chunks
    }

    // 7. Complete chunk atomically
    const { data: completeData, error: completeErr } = await adminClient.rpc("complete_chunk", {
      p_job_id: jobId,
      p_expected_step: currentStep,
      p_new_cursor: nextCursor,
      p_new_delivered_units: newDeliveredUnits,
      p_cost_usd: actualCostUsd,
    });

    if (completeErr) {
      throw completeErr;
    }

    // 8. If finished, settle job and notify customer
    if (isDone) {
      const resultFileId = `results/${jobId}/data.json`;
      const finalResultData = {
        jobId,
        deliveredUnits: newDeliveredUnits,
        status: "completed",
        completedAt: new Date().toISOString(),
      };

      try {
        await adminClient.storage
          .from("results")
          .upload(
            `${jobId}/data.json`,
            Buffer.from(JSON.stringify(finalResultData)),
            { contentType: "application/json", upsert: true }
          );
      } catch {
        // Results storage upload
      }

      // Settle job atomically (charges ceil(delivered * unit_price), releases remaining reserve)
      const { data: settleData, error: settleErr } = await adminClient.rpc("settle_job_atomic", {
        p_job_id: jobId,
        p_points_cap: 600,
        p_result_file_id: resultFileId,
      });

      if (settleErr) {
        throw settleErr;
      }

      // Emit notification to user
      if (userId) {
        await adminClient.from("notifications").insert({
          id: `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          user_id: userId,
          title: "اكتمل طلب استخراج البيانات بنجاح",
          body: `تم استخراج ${newDeliveredUnits} عنصر بنجاح. يمكنك الآن مراجعة وتحميل النتائج.`,
          link: `/dashboard/jobs`,
          read: false,
          created_at: new Date().toISOString(),
        });
      }

      return NextResponse.json({
        success: true,
        done: true,
        jobId,
        deliveredUnits: newDeliveredUnits,
        settle: settleData,
      });
    }

    // 9. If not finished, trigger next chunk server-side (Hobby Design B self-chain)
    if (process.env.CRON_SECRET) {
      const nextUrl = `${getWorkerBaseUrl()}/api/worker/chunk`;
      fetch(nextUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({
          jobId,
          expectedStep: currentStep + 1,
        }),
      }).catch((chainErr) => {
        console.error("Worker self-chain call error:", chainErr);
      });
    }

    return NextResponse.json({
      success: true,
      done: false,
      jobId,
      step: currentStep + 1,
      deliveredUnits: newDeliveredUnits,
      targetMax,
    });
  } catch (err: any) {
    console.error("Worker chunk execution failed:", err);
    if (jobId) {
      try {
        await adminClient.rpc("record_chunk_failure", {
          p_job_id: jobId,
          p_error_message: err.message || "فشل غير متوقع أثناء معالجة الجزء.",
        });
      } catch {}
    }
    return NextResponse.json(
      { success: false, error: err.message || "فشل تنفيذ الجزء." },
      { status: 500 }
    );
  }
}
