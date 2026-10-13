import { NextRequest, NextResponse, after } from "next/server";
import { createHash } from "node:crypto";
import { createAdminClient } from "../../../../lib/supabase/server";
import { verifyCronSecret } from "../../../../lib/server/cronAuth";
import {
  defaultTregAdapter,
  getInjectedProviderAdapter,
  createBuiltInMockAdapter,
} from "../../../../lib/server/tregAdapter";
import { APPROVED_CAPABILITY_CATALOG } from "../../../../functions/shared/capabilityRegistry";
import { searchCatalog } from "../../../../functions/shared/catalogClient";
import {
  getConfiguredProviderSpendCapUsd,
  getConfiguredJobPointsCap,
} from "../../../../functions/shared/providerSpend";
import { generateMethodologyText } from "../../../../functions/shared/multiStepWorker";
import { artifactVersionRowId } from "../../../../functions/shared/artifactVersions";
import { getInMemoryPartialStepFallback } from "../../../../lib/server/tregAdapter";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby maximum

// Fallback in-memory partial step store used ONLY when unit-test mock storage omits .download()
const inMemoryPartialStepFallback = getInMemoryPartialStepFallback();

function getWorkerBaseUrl(): string {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  }
  return "http://127.0.0.1:3000";
}

function scheduleNextChunkWithWaitUntil(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    // Outside a Next.js request context (e.g., direct function invocation in tests/scripts)
    task().catch(() => {
      // Non-blocking background self-chain outside server context
    });
  }
}

async function resolveLimitsFromSettings(adminClient: any): Promise<{
  dailyCapUsd: number;
  jobPointsCap: number;
}> {
  let dailyCapUsd = getConfiguredProviderSpendCapUsd();
  let jobPointsCap = getConfiguredJobPointsCap();

  try {
    const query = adminClient?.from?.("settings_private")?.select?.("key, value");
    if (query && typeof query.eq === "function") {
      const { data: row } = await query.eq("key", "pricing").maybeSingle();
      const val = row?.value && typeof row.value === "object" ? row.value : row;
      if (typeof val?.providerDailySpendCapUsd === "number" && val.providerDailySpendCapUsd > 0) {
        dailyCapUsd = val.providerDailySpendCapUsd;
      }
      if (typeof val?.jobMaxPointsCap === "number" && val.jobMaxPointsCap > 0) {
        jobPointsCap = val.jobMaxPointsCap;
      }
    }
  } catch {
    // Fallback to configured env/default caps
  }

  return { dailyCapUsd, jobPointsCap };
}

async function resolveJobExecutionSpec(
  adminClient: any,
  jobId: string,
  userId: string,
  rawEndpointId: string,
  unitPricePoints: number
): Promise<{
  capabilitySlug: string;
  endpointId: string;
  method: "GET" | "POST";
  params: Record<string, any>;
  paginationStrategy: "cursor" | "offset" | "page" | "none";
  pricingUnit: "call" | "item" | "page";
  unitCostUsd: number;
  pageSize: number;
}> {
  let capabilitySlug = rawEndpointId || "tiktok-profile";
  let endpointId = rawEndpointId || "tikhub.tiktok.user.profile";
  let method: "GET" | "POST" | undefined;
  let params: Record<string, any> = {};
  let paginationStrategy: "cursor" | "offset" | "page" | "none" | undefined;
  let pricingUnit: "call" | "item" | "page" = "call";
  let unitCostUsd: number | undefined;

  // 1. Match accepted quote in plans_quotes where 'job_quote_' + md5(quote.id) === jobId
  try {
    const qSelect = adminClient?.from?.("plans_quotes")?.select?.("*");
    if (qSelect && typeof qSelect.eq === "function") {
      const { data: quotes } = await qSelect.eq("user_id", userId);
      if (Array.isArray(quotes)) {
        const matched = quotes.find((q: any) => {
          if (!q?.id) return false;
          const digest = createHash("md5").update(String(q.id)).digest("hex");
          return `job_quote_${digest}` === jobId || q.id === jobId;
        });
        if (matched) {
          const items = Array.isArray(matched.items)
            ? matched.items
            : Array.isArray(matched.items?.items)
            ? matched.items.items
            : [];
          const firstItem = items[0];
          if (firstItem && typeof firstItem === "object") {
            if (firstItem.capabilitySlug) capabilitySlug = String(firstItem.capabilitySlug);
            if (firstItem.endpointId) endpointId = String(firstItem.endpointId);
            if (firstItem.method === "GET" || firstItem.method === "POST") {
              method = firstItem.method;
            }
            if (firstItem.params && typeof firstItem.params === "object") {
              params = { ...firstItem.params };
            }
            if (
              firstItem.paginationStrategy === "cursor" ||
              firstItem.paginationStrategy === "offset" ||
              firstItem.paginationStrategy === "page" ||
              firstItem.paginationStrategy === "none"
            ) {
              paginationStrategy = firstItem.paginationStrategy;
            }
          }
        }
      }
    }
  } catch {
    // Continue with capability catalog resolution
  }

  // 2. Match capability in capability_registry table if available
  try {
    const capSelect = adminClient?.from?.("capability_registry")?.select?.("*");
    if (capSelect && typeof capSelect.eq === "function") {
      const { data: dbCap } = await capSelect.eq("slug", capabilitySlug).maybeSingle();
      if (dbCap) {
        if (dbCap.endpoint_id && !dbCap.endpoint_id.startsWith("/v1/")) {
          endpointId = String(dbCap.endpoint_id);
        }
        if (typeof dbCap.unit_cost_usd === "number" && dbCap.unit_cost_usd > 0) {
          unitCostUsd = Number(dbCap.unit_cost_usd);
        }
        if (
          dbCap.pagination_type === "cursor" ||
          dbCap.pagination_type === "offset" ||
          dbCap.pagination_type === "page" ||
          dbCap.pagination_type === "none"
        ) {
          paginationStrategy = paginationStrategy || dbCap.pagination_type;
        }
        if (
          dbCap.pricing_unit === "call" ||
          dbCap.pricing_unit === "item" ||
          dbCap.pricing_unit === "page"
        ) {
          pricingUnit = dbCap.pricing_unit;
        }
      }
    }
  } catch {
    // Fallback to APPROVED_CAPABILITY_CATALOG
  }

  // 3. Match APPROVED_CAPABILITY_CATALOG
  const approvedCap = APPROVED_CAPABILITY_CATALOG.find(
    (c) =>
      c.slug === capabilitySlug ||
      c.slug === rawEndpointId ||
      c.tregEndpointId === rawEndpointId ||
      c.tregEndpointId === endpointId
  );

  if (approvedCap) {
    capabilitySlug = approvedCap.slug;
    endpointId = approvedCap.tregEndpointId;
    method = method || approvedCap.tregMethod;
    paginationStrategy = paginationStrategy || approvedCap.paginationType;
    pricingUnit = approvedCap.pricingUnit;
    if (unitCostUsd === undefined && approvedCap.unitCostUsd > 0) {
      unitCostUsd = approvedCap.unitCostUsd;
    }
  } else if (endpointId === capabilitySlug || endpointId.startsWith("/v1/")) {
    try {
      const catalogHits = await searchCatalog(capabilitySlug);
      if (catalogHits.length > 0) {
        endpointId = catalogHits[0].id || endpointId;
        method = method || catalogHits[0].method;
        paginationStrategy = paginationStrategy || catalogHits[0].pagination?.type;
        if (unitCostUsd === undefined && catalogHits[0].catalogPriceUsd > 0) {
          unitCostUsd = catalogHits[0].catalogPriceUsd;
        }
      }
    } catch {
      // Keep resolved endpointId
    }
  }

  if (capabilitySlug === "tiktok-profile" || rawEndpointId === "tiktok-profile") {
    endpointId = "tikhub.tiktok.user.profile";
    method = method || "GET";
    paginationStrategy = paginationStrategy || "none";
    unitCostUsd = unitCostUsd ?? 0.001;
  }

  if (!method) {
    if (
      endpointId === "tikhub.tiktok.user.profile" ||
      endpointId.startsWith("scrapecreators.") ||
      endpointId.startsWith("tikhub.")
    ) {
      method = "GET";
    } else {
      method = "POST";
    }
  }

  if (!paginationStrategy) {
    paginationStrategy = endpointId === "tikhub.tiktok.user.profile" ? "none" : "cursor";
  }

  // Derive unitCostUsd from unitPricePoints / 5500 if not explicitly found in catalog
  const resolvedUnitCostUsd =
    typeof unitCostUsd === "number" && unitCostUsd > 0
      ? unitCostUsd
      : Math.max(0.0001, Number(((Number(unitPricePoints) || 1) / 5500).toFixed(6)));

  const rawPageSize = Number(params?.limit || params?.count || params?.per_page || 10);
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(50, rawPageSize) : 10;

  return {
    capabilitySlug,
    endpointId,
    method,
    params,
    paginationStrategy,
    pricingUnit,
    unitCostUsd: resolvedUnitCostUsd,
    pageSize,
  };
}

interface ReleaseConfirmation {
  confirmed: boolean;
  data: any;
  diagnostic: string | null;
}

async function executeReleaseConfirmation(
  adminClient: any,
  jobId: string,
  reason: string
): Promise<ReleaseConfirmation> {
  try {
    const { data: relData, error: relErr } = await adminClient.rpc("release_job_atomic", {
      p_job_id: jobId,
      p_error_message: reason,
      p_force: true,
    });
    if (!relErr && Boolean(relData?.success === true || relData?.already_released === true)) {
      return { confirmed: true, data: relData, diagnostic: null };
    }
    const diagnostic =
      (typeof relErr?.message === "string" && relErr.message) ||
      (typeof relData?.error === "string" && relData.error) ||
      (relData && typeof relData === "object" && JSON.stringify(relData)) ||
      "release_rpc_failed";
    return {
      confirmed: false,
      data: relData || null,
      diagnostic,
    };
  } catch (rpcEx: any) {
    return {
      confirmed: false,
      data: null,
      diagnostic: rpcEx?.message || "release_exception",
    };
  }
}

function buildReleaseFailedResponse(
  jobId: string,
  diagnostic: string | null,
  extra: Record<string, any> = {}
) {
  return NextResponse.json(
    {
      success: false,
      released: false,
      chargedCredits: 0,
      deliveredUnits: 0,
      jobId,
      error: "تعذر تحرير الرصيد المحجوز للمهمة.",
      diagnostic: diagnostic || "release_failed",
      ...extra,
    },
    { status: 500 }
  );
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
  const injectedAdapter = getInjectedProviderAdapter();

  // 2. Mock Provider Injection Guard: strictly blocked when NODE_ENV === 'production' OR ENABLE_MOCK_PROVIDER !== 'true'
  const isMockRequested = Boolean(
    body?.mockProvider ||
      req.headers.get("x-mock-provider") === "true" ||
      process.env.PROVIDER_MOCK === "true" ||
      injectedAdapter !== null
  );

  if (
    isMockRequested &&
    (process.env.NODE_ENV === "production" || process.env.ENABLE_MOCK_PROVIDER !== "true")
  ) {
    return NextResponse.json(
      {
        success: false,
        error: "حقن المزود الوهمي محظور في بيئة الإنتاج.",
      },
      { status: 403 }
    );
  }

  let jobId: string = typeof body?.jobId === "string" ? body.jobId : "";
  let expectedStep: number | undefined = body?.expectedStep;
  const adminClient = createAdminClient();

  try {
    // 3. If jobId is not provided, pick up the oldest runnable job
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
      jobId = String(nextJob.id || "");
      expectedStep = nextJob.step ?? 0;
    }

    if (expectedStep === undefined || expectedStep === null) {
      expectedStep = 0;
    }

    // 4. Claim chunk atomically (lease duration 60s)
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
      step: currentStep = 0,
      current_cursor: currentCursor = null,
      delivered_units: currentDelivered = 0,
      target_volume_max: targetMax = 1,
      endpoint_id: rawEndpointId = "tiktok-profile",
      unit_price: unitPrice = 1,
    } = claimData;

    const useMockProvider = Boolean(
      isMockRequested &&
        process.env.NODE_ENV !== "production" &&
        process.env.ENABLE_MOCK_PROVIDER === "true"
    );

    const isLiveProviderReady =
      process.env.TREG_LIVE === "true" && Boolean(process.env.TREG_TOKEN?.trim());

    // A1 Safety Guard: when neither live provider nor non-production test adapter is active,
    // never advance delivered_units or settle; release full reserve with zero charge.
    if (!useMockProvider && !isLiveProviderReady) {
      const releaseReason =
        "محرك استخراج البيانات المباشر غير مفعل حالياً؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.";
      const rel = await executeReleaseConfirmation(adminClient, jobId, releaseReason);

      if (!rel.confirmed) {
        return buildReleaseFailedResponse(jobId, rel.diagnostic);
      }

      return NextResponse.json(
        {
          success: false,
          released: true,
          chargedCredits: 0,
          deliveredUnits: 0,
          jobId,
          error: releaseReason,
          release: rel.data,
        },
        { status: 503 }
      );
    }

    // 5. Resolve capability spec, real estimated unit cost, and daily spend cap from settings/env
    const { dailyCapUsd, jobPointsCap } = await resolveLimitsFromSettings(adminClient);
    const spec = await resolveJobExecutionSpec(
      adminClient,
      jobId,
      userId,
      rawEndpointId,
      Number(unitPrice) || 1
    );

    const remainingUnits = Math.max(0, targetMax - currentDelivered);
    const effectivePageSize =
      useMockProvider && typeof body?.mockBatchSize === "number" && body.mockBatchSize > 0
        ? Math.min(50, Math.floor(body.mockBatchSize))
        : spec.pageSize;

    const estUnitsThisCall =
      spec.pricingUnit === "item" ? Math.max(1, Math.min(effectivePageSize, remainingUnits)) : 1;
    const estimatedCostUsd =
      useMockProvider && typeof body?.mockEstimatedCostUsd === "number"
        ? body.mockEstimatedCostUsd
        : Math.max(0.0001, Number((spec.unitCostUsd * estUnitsThisCall).toFixed(6)));

    // 6. Reserve provider spend BEFORE calling provider
    let spendCostId: number | null = null;
    const { data: spendReserve, error: spendErr } = await adminClient.rpc(
      "reserve_provider_spend_atomic",
      {
        p_job_id: jobId,
        p_provider: "treg",
        p_estimated_cost_usd: estimatedCostUsd,
        p_daily_cap_usd: dailyCapUsd,
      }
    );

    if (spendErr || !spendReserve?.allowed) {
      const capErrorMsg =
        "تم تجاوز الحد اليومي لاستهلاك مزود البيانات؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.";
      await adminClient.rpc("record_chunk_failure", {
        p_job_id: jobId,
        p_error_message: capErrorMsg,
      });
      const rel = await executeReleaseConfirmation(adminClient, jobId, capErrorMsg);
      if (!rel.confirmed) {
        return buildReleaseFailedResponse(jobId, rel.diagnostic, { capExceeded: true });
      }

      return NextResponse.json(
        {
          success: false,
          released: true,
          chargedCredits: 0,
          capExceeded: true,
          jobId,
          error: "تم تجاوز الحد اليومي لاستهلاك المزود.",
          release: rel.data,
        },
        { status: 429 }
      );
    }
    spendCostId = spendReserve.cost_id ?? null;

    // 7. Call provider through adapter
    const activeAdapter =
      useMockProvider && injectedAdapter
        ? injectedAdapter
        : useMockProvider
        ? createBuiltInMockAdapter({
            simulateProviderError: Boolean(body?.simulateProviderError),
            mockBatchSize: body?.mockBatchSize,
            mockCostUsd: body?.mockCostUsd,
          })
        : defaultTregAdapter;

    const adapterResult = await activeAdapter({
      jobId,
      userId,
      step: currentStep,
      endpointId: spec.endpointId,
      capabilitySlug: spec.capabilitySlug,
      method: spec.method,
      params: spec.params,
      paginationStrategy:
        useMockProvider && !injectedAdapter && targetMax > effectivePageSize
          ? "cursor"
          : spec.paginationStrategy,
      cursor: currentCursor && currentCursor !== "completed" ? String(currentCursor) : null,
      pageSize: effectivePageSize,
      remainingNeeded: remainingUnits,
      targetVolumeMax: targetMax,
      deliveredSoFar: currentDelivered,
    });

    const actualCostUsd = Math.max(0, Number(adapterResult.costUsd) || 0);
    const acceptedRows = adapterResult.ok
      ? (adapterResult.rows || []).slice(0, remainingUnits)
      : [];

    // 8. Commit provider spend with the real cost from the provider response
    if (spendCostId !== null) {
      await adminClient.rpc("commit_provider_spend", {
        p_cost_id: spendCostId,
        p_actual_cost_usd: actualCostUsd,
        p_units: acceptedRows.length,
      });
    }

    // 9. Handle provider error: record failure and release full reserve with zero charge
    if (!adapterResult.ok) {
      throw new Error(
        adapterResult.errorMessageAr || "تعذر استخراج البيانات من المصدر بعد عدة محاولات."
      );
    }

    const newDeliveredUnits = currentDelivered + acceptedRows.length;
    const isShortLastPage =
      spec.paginationStrategy !== "none" &&
      acceptedRows.length < Math.min(effectivePageSize, remainingUnits) &&
      !adapterResult.nextCursor;
    const hasMorePages =
      Boolean(adapterResult.nextCursor) &&
      acceptedRows.length > 0 &&
      newDeliveredUnits < targetMax &&
      !isShortLastPage;
    const isDone = !hasMorePages || newDeliveredUnits >= targetMax;

    // If done and zero rows were collected across the job, release full reserve with zero charge
    if (isDone && newDeliveredUnits === 0) {
      const emptyErrorAr =
        "لم يُعثر على أي بيانات مطابقة من المصدر؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.";
      const rel = await executeReleaseConfirmation(adminClient, jobId, emptyErrorAr);
      if (!rel.confirmed) {
        return buildReleaseFailedResponse(jobId, rel.diagnostic);
      }

      return NextResponse.json(
        {
          success: false,
          released: true,
          chargedCredits: 0,
          deliveredUnits: 0,
          jobId,
          error: emptyErrorAr,
          release: rel.data,
        },
        { status: 422 }
      );
    }

    // 10. Save fetched rows to partials/<jobId>/step_<n>.json (a failed storage write MUST fail the chunk)
    const partialData = {
      jobId,
      step: currentStep,
      cursor: adapterResult.nextCursor,
      batchUnits: acceptedRows.length,
      totalDelivered: newDeliveredUnits,
      rows: acceptedRows,
      rawProfile: adapterResult.rawProfile || null,
      timestamp: new Date().toISOString(),
    };

    const partialUploadRes = await adminClient.storage
      .from("partials")
      .upload(
        `${jobId}/step_${currentStep}.json`,
        Buffer.from(JSON.stringify(partialData), "utf-8"),
        { contentType: "application/json", upsert: true }
      );

    if (partialUploadRes?.error) {
      throw new Error(
        `فشل حفظ البيانات المرحلية للدفعة (${currentStep}): ${
          partialUploadRes.error.message || "storage_write_failed"
        }`
      );
    }

    inMemoryPartialStepFallback.set(`${jobId}/step_${currentStep}.json`, partialData);

    // 11. Complete chunk atomically with real cursor and real delivered count
    const nextCursorValue = isDone ? "completed" : String(adapterResult.nextCursor);
    const { data: compData, error: completeErr } = await adminClient.rpc("complete_chunk", {
      p_job_id: jobId,
      p_expected_step: currentStep,
      p_new_cursor: nextCursorValue,
      p_new_delivered_units: newDeliveredUnits,
      p_cost_usd: actualCostUsd,
    });

    if (
      completeErr ||
      !compData ||
      compData.success !== true ||
      typeof compData.delivered_units !== "number" ||
      compData.delivered_units < 0
    ) {
      throw new Error(
        completeErr?.message ||
          "استجابة غير صالحة من complete_chunk: تعذر التحقق من تسجيل الوحدات المنجزة في قاعدة البيانات."
      );
    }

    const recordedDeliveredUnits: number = compData.delivered_units;

    if (compData.already_completed) {
      console.warn(
        `[worker:chunk_already_completed] jobId=${jobId} step=${currentStep} currentDbStep=${compData.current_step}`
      );
      if (!isDone) {
        return NextResponse.json({
          success: true,
          done: false,
          alreadyCompleted: true,
          jobId,
          step: compData.current_step ?? currentStep + 1,
          deliveredUnits: recordedDeliveredUnits,
          targetMax,
          spendCostId,
        });
      }

      // If isDone and chunk was already completed, check if job was already settled
      const { data: currentJobCheck } = await adminClient
        .from("jobs")
        .select("status, charged_credits, delivered_units")
        .eq("id", jobId)
        .maybeSingle();

      if (currentJobCheck?.status === "completed") {
        return NextResponse.json({
          success: true,
          done: true,
          alreadySettled: true,
          jobId,
          deliveredUnits: currentJobCheck.delivered_units ?? recordedDeliveredUnits,
          spendCostId,
        });
      }
    }

    // 12. If finished: assemble all rows, generate CSV/XLSX/PDF + methodology, upload to results/{userId}/{jobId}/result.{format}, write artifact_versions, and ONLY THEN settle_job_atomic
    if (isDone) {
      const collectedRows: Record<string, any>[] = [];
      let firstRawProfile: Record<string, any> | null = null;
      const partialsBucket = adminClient.storage.from("partials");

      for (let s = 0; s <= currentStep; s++) {
        const stepKey = `${jobId}/step_${s}.json`;
        let stepObj: any = null;
        let stepCorrupt = false;

        if (typeof partialsBucket.download === "function") {
          const { data: blob, error: dlErr } = await partialsBucket.download(stepKey);
          if (!dlErr && blob) {
            try {
              const text = typeof blob.text === "function" ? await blob.text() : String(blob);
              stepObj = JSON.parse(text);
            } catch {
              stepCorrupt = true;
              stepObj = null;
            }
          } else {
            stepObj = null;
          }
        } else if (inMemoryPartialStepFallback.has(stepKey)) {
          stepObj = inMemoryPartialStepFallback.get(stepKey);
        }

        if (stepObj && (typeof stepObj !== "object" || !Array.isArray(stepObj.rows))) {
          stepCorrupt = true;
          stepObj = null;
        }

        if (!stepObj) {
          const partialCorruptMsg = `تعذر قراءة بيانات الدفعة المرحلية (${s}) للمهمة؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.`;
          console.error(
            `[worker:assembly_failed] step=${s} reason=${stepCorrupt ? "corrupted_step_file" : "missing_step_file"}`
          );
          const rel = await executeReleaseConfirmation(adminClient, jobId, partialCorruptMsg);
          if (!rel.confirmed) {
            return buildReleaseFailedResponse(jobId, rel.diagnostic);
          }

          return NextResponse.json(
            {
              success: false,
              released: true,
              chargedCredits: 0,
              deliveredUnits: 0,
              jobId,
              error: partialCorruptMsg,
              release: rel.data,
            },
            { status: 500 }
          );
        }

        collectedRows.push(...stepObj.rows);
        if (!firstRawProfile && stepObj.rawProfile) {
          firstRawProfile = stepObj.rawProfile;
        }
      }

      // Strict reconciliation: generated data row count must strictly match recorded delivered units
      if (collectedRows.length !== recordedDeliveredUnits || collectedRows.length === 0) {
        const mismatchMsg = `عدم تطابق في عدد السجلات المجمعة (${collectedRows.length}) مع الوحدات المسجلة (${recordedDeliveredUnits})؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.`;
        console.error(
          `[worker:assembly_failed] reason=row_count_mismatch collected=${collectedRows.length} expected=${recordedDeliveredUnits}`
        );
        const rel = await executeReleaseConfirmation(adminClient, jobId, mismatchMsg);
        if (!rel.confirmed) {
          return buildReleaseFailedResponse(jobId, rel.diagnostic);
        }

        return NextResponse.json(
          {
            success: false,
            released: true,
            chargedCredits: 0,
            deliveredUnits: 0,
            jobId,
            error: mismatchMsg,
            release: rel.data,
          },
          { status: 500 }
        );
      }

      const finalRows = collectedRows;

      const completedAtIso = new Date().toISOString();
      const dateStr = completedAtIso.slice(0, 10);
      const finalPayload: any = {
        metadata: {
          platform: "Digr Data Platform",
          company: "Digr",
          title: `نتائج استخراج ${spec.capabilitySlug}`,
          template: spec.capabilitySlug,
          jobId,
          collectedAt: completedAtIso,
          rowsCount: finalRows.length,
          methodology: `تم استخراج ${finalRows.length} سجل بنجاح بتاريخ ${dateStr}. ملاحظة منهجية: هذه البيانات عامة ومتاحة علناً.`,
        },
        profile: firstRawProfile || finalRows[0] || null,
        rows: finalRows,
      };

      const csvPath = `${userId}/${jobId}/result.csv`;
      const xlsxPath = `${userId}/${jobId}/result.xlsx`;
      const pdfPath = `${userId}/${jobId}/result.pdf`;

      try {
        const {
          generateCsvReport,
          generateExcelReport,
          generatePdfReport,
        } = await import("../../../../functions/shared/fileGenerators");
        const csvBuf = generateCsvReport(finalPayload);
        const [xlsxBuf, pdfBuf] = await Promise.all([
          generateExcelReport(finalPayload),
          generatePdfReport(finalPayload),
        ]);
        const methodologyText = generateMethodologyText(finalPayload);

        const resultsBucket = adminClient.storage.from("results");
        const [csvUp, xlsxUp, pdfUp] = await Promise.all([
          resultsBucket.upload(csvPath, csvBuf, {
            contentType: "text/csv",
            upsert: true,
          }),
          resultsBucket.upload(xlsxPath, xlsxBuf, {
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            upsert: true,
          }),
          resultsBucket.upload(pdfPath, pdfBuf, {
            contentType: "application/pdf",
            upsert: true,
          }),
        ]);

        if (csvUp?.error || xlsxUp?.error || pdfUp?.error) {
          throw new Error(
            csvUp?.error?.message ||
              xlsxUp?.error?.message ||
              pdfUp?.error?.message ||
              "results_upload_error"
          );
        }

        // Save JSON & methodology text in partials bucket for /api/jobs/[id]/data & /methodology
        const [dataJsonUp1, dataJsonUp2, methUp] = await Promise.all([
          partialsBucket.upload(
            `${userId}/${jobId}/data.json`,
            Buffer.from(JSON.stringify(finalPayload), "utf-8"),
            { contentType: "application/json", upsert: true }
          ),
          partialsBucket.upload(
            `${jobId}/data.json`,
            Buffer.from(JSON.stringify(finalPayload), "utf-8"),
            { contentType: "application/json", upsert: true }
          ),
          partialsBucket.upload(
            `${userId}/${jobId}/methodology.txt`,
            Buffer.from(methodologyText, "utf-8"),
            { contentType: "text/plain; charset=utf-8", upsert: true }
          ),
        ]);

        if (dataJsonUp1?.error || dataJsonUp2?.error || methUp?.error) {
          throw new Error(
            dataJsonUp1?.error?.message ||
              dataJsonUp2?.error?.message ||
              methUp?.error?.message ||
              "partials_artifact_upload_error"
          );
        }
      } catch (uploadErr: any) {
        console.error(
          "[worker:results_upload_failed] reason=storage_upload_error",
          uploadErr?.message || ""
        );
        const uploadFailReason =
          "تعذر حفظ ملفات النتائج النهائية؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.";
        const rel = await executeReleaseConfirmation(adminClient, jobId, uploadFailReason);
        if (!rel.confirmed) {
          return buildReleaseFailedResponse(jobId, rel.diagnostic);
        }

        return NextResponse.json(
          {
            success: false,
            released: true,
            chargedCredits: 0,
            deliveredUnits: 0,
            jobId,
            error: uploadFailReason,
            release: rel.data,
          },
          { status: 500 }
        );
      }

      // Write artifact_versions BEFORE settle_job_atomic (strictly required before settlement)
      try {
        const versionId = artifactVersionRowId(jobId, 1);
        const avTable = adminClient.from("artifact_versions");
        const versionRow = {
          id: versionId,
          job_id: jobId,
          user_id: userId,
          version_number: 1,
          file_id_xlsx: xlsxPath,
          file_id_pdf: pdfPath,
          file_id_csv: csvPath,
          created_at: completedAtIso,
        };
        const avRes =
          typeof avTable.upsert === "function"
            ? await avTable.upsert(versionRow)
            : await avTable.insert(versionRow);
        if (avRes?.error) {
          throw new Error(
            `artifact_versions_db_error: ${avRes.error.message || avRes.error.code || "unknown"}`
          );
        }
      } catch (avErr: any) {
        console.error(
          `[worker:artifact_versions_write_failed] reason=db_error`,
          avErr?.message || ""
        );
        const avFailReason =
          "تعذر تسجيل نسخة المستندات النهائية؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.";
        const rel = await executeReleaseConfirmation(adminClient, jobId, avFailReason);
        if (!rel.confirmed) {
          return buildReleaseFailedResponse(jobId, rel.diagnostic);
        }

        return NextResponse.json(
          {
            success: false,
            released: true,
            chargedCredits: 0,
            deliveredUnits: 0,
            jobId,
            error: avFailReason,
            release: rel.data,
          },
          { status: 500 }
        );
      }

      // Settle job atomically (charges ceil(delivered * unit_price), capped at reserve & jobPointsCap)
      const { data: settleData, error: settleErr } = await adminClient.rpc("settle_job_atomic", {
        p_job_id: jobId,
        p_points_cap: jobPointsCap,
        p_result_file_id: csvPath,
      });

      if (settleErr) {
        throw settleErr;
      }

      // Clean up temporary step files from partials only after successful settlement
      try {
        const partialPaths = Array.from({ length: currentStep + 1 }, (_, idx) => {
          const k = `${jobId}/step_${idx}.json`;
          inMemoryPartialStepFallback.delete(k);
          return k;
        });
        if (
          partialPaths.length > 0 &&
          typeof adminClient.storage.from("partials").remove === "function"
        ) {
          await adminClient.storage.from("partials").remove(partialPaths);
        }
      } catch {
        // Non-blocking partial step cleanup
      }

      // Emit notification to user matching tracked migrations schema: (id, user_id, title, body, read, link, created_at)
      if (userId) {
        try {
          const notifRes = await adminClient.from("notifications").insert({
            id: `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            user_id: userId,
            title: "اكتمل طلب استخراج البيانات بنجاح",
            body: `تم استخراج ${finalRows.length} عنصر بنجاح. يمكنك الآن مراجعة وتحميل النتائج.`,
            link: `/dashboard/jobs`,
            read: false,
            created_at: completedAtIso,
          });
          if (notifRes?.error) {
            console.error(
              `[worker:notification_insert_failed] reason=db_error code=${
                notifRes.error.code || "unknown"
              }`
            );
          }
        } catch (notifErr: any) {
          console.error(
            `[worker:notification_insert_failed] reason=exception code=${
              notifErr?.code || "unknown"
            }`
          );
        }
      }

      return NextResponse.json({
        success: true,
        done: true,
        jobId,
        deliveredUnits: finalRows.length,
        spendCostId,
        resultFiles: {
          csv: csvPath,
          xlsx: xlsxPath,
          pdf: pdfPath,
        },
        settle: settleData,
      });
    }

    // 13. Not finished: chain next chunk via waitUntil (after from next/server) with cronAuth headers
    if (process.env.CRON_SECRET && (!useMockProvider || !body?.disableSelfChain)) {
      const nextUrl = `${getWorkerBaseUrl()}/api/worker/chunk`;
      const cronSecret = process.env.CRON_SECRET.trim();
      const nextStep = currentStep + 1;
      scheduleNextChunkWithWaitUntil(async () => {
        await fetch(nextUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cronSecret}`,
            "x-cron-secret": cronSecret,
          },
          body: JSON.stringify({
            jobId,
            expectedStep: nextStep,
          }),
        });
      });
    }

    return NextResponse.json({
      success: true,
      done: false,
      jobId,
      step: currentStep + 1,
      cursor: adapterResult.nextCursor,
      deliveredUnits: newDeliveredUnits,
      targetMax,
      spendCostId,
    });
  } catch (err: any) {
    console.error("Worker chunk execution failed:", err);
    const errorMsg = err?.message || "فشل غير متوقع أثناء معالجة الجزء.";
    if (jobId) {
      try {
        const attemptsToRecord =
          isMockRequested &&
          process.env.NODE_ENV !== "production" &&
          process.env.ENABLE_MOCK_PROVIDER === "true" &&
          body?.exhaustRetries === true
            ? 5
            : 1;
        let lastFailureData: any = null;
        for (let i = 0; i < attemptsToRecord; i++) {
          const { data: failData } = await adminClient.rpc("record_chunk_failure", {
            p_job_id: jobId,
            p_error_message: errorMsg,
          });
          lastFailureData = failData;
        }

        // Release full reserve with zero charge on unrecoverable chunk failure if not already released
        let releaseConfirmed = Boolean(lastFailureData?.released);
        let releaseResult = lastFailureData;
        let releaseDiagnostic: string | null = null;

        if (!releaseConfirmed && body?.retryOnly !== true) {
          const rel = await executeReleaseConfirmation(adminClient, jobId, errorMsg);
          if (rel.confirmed) {
            releaseConfirmed = true;
            releaseResult = {
              ...(lastFailureData || {}),
              released: true,
              release: rel.data,
            };
          } else {
            releaseConfirmed = false;
            releaseDiagnostic = rel.diagnostic;
          }
        }

        const safeArabicError = releaseConfirmed
          ? errorMsg
          : "تعذر تحرير الرصيد المحجوز للمهمة.";

        return NextResponse.json(
          {
            success: false,
            released: releaseConfirmed,
            chargedCredits: 0,
            deliveredUnits: 0,
            jobId,
            error: safeArabicError,
            failure: releaseResult,
            ...(releaseDiagnostic ? { diagnostic: releaseDiagnostic } : {}),
          },
          { status: 500 }
        );
      } catch (releaseCatchErr: any) {
        console.error(
          "[worker:failure_recovery_error] reason=rpc_error",
          releaseCatchErr?.message || ""
        );
      }
    }
    return NextResponse.json(
      {
        success: false,
        released: false,
        chargedCredits: 0,
        deliveredUnits: 0,
        jobId: jobId || undefined,
        error: "تعذر تحرير الرصيد المحجوز للمهمة.",
        diagnostic: "outer_catch_unhandled",
      },
      { status: 500 }
    );
  }
}
