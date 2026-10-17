import { NextRequest, NextResponse, after } from "next/server";
import { createAdminClient } from "../../../../lib/supabase/server";
import {
  verifyCronSecret,
  resolveInternalBaseUrl,
  createInternalWorkerAuthHeaders,
} from "../../../../lib/server/cronAuth";
import {
  defaultTregAdapter,
  getInjectedProviderAdapter,
  createBuiltInMockAdapter,
} from "../../../../lib/server/tregAdapter";
import { getLiveProviderGateStatusFromSettings } from "../../../../lib/server/providerGate";
import { resolveJobExecutionSpec } from "../../../../lib/server/jobExecutionSpec";
import { sendPlatformEmail, getRecipient } from "../../../../lib/server/sendPlatformEmail";
import { getBalance } from "../../../../lib/supabase/ledger";
import {
  getConfiguredProviderSpendCapUsd,
  getConfiguredJobPointsCap,
} from "../../../../functions/shared/providerSpend";
import {
  generateMethodologyText,
  generateCsvReport,
  generateExcelReport,
  generatePdfReport,
} from "../../../../functions/shared/fileGenerators";
import { artifactVersionRowId } from "../../../../functions/shared/artifactVersions";
import { getInMemoryPartialStepFallback } from "../../../../lib/server/tregAdapter";
import {
  deduplicateAgainstBaseline,
  EntityRecord,
} from "../../../../lib/server/negativeListEngine";
import {
  detectCountryFromText,
  detectIndustryFromText,
  isCompanyRowMatchingConstraints,
} from "../../../../lib/planParameters";
import { reviewCompanyBatch } from "../../../../lib/server/relevanceValidationLayer";
import { toArabicDigits } from "../../../../lib/arabicDigits";
import { customerFacingCapabilityLabel } from "../../../../lib/customerFacingRequestLabels";
import { filterRowsByDateRange } from "../../../../lib/server/dateRangeFilter";
import { estimateRemainingSecondsFromBatchDurations } from "../../../../functions/shared/liveActivityFeed";
import { cleanupRetrySources, ensureRetrySeed, rowIdentity } from "../../../../lib/server/retryReuse";
import { getSocialCapability, socialResultTitleAr } from "../../../../lib/socialSources";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby maximum

// Fallback in-memory partial step store used ONLY when unit-test mock storage omits .download()
const inMemoryPartialStepFallback = getInMemoryPartialStepFallback();

function companyIdentity(row: any): string | null {
  return rowIdentity(row);
}

function getWorkerBaseUrl(req?: NextRequest): string {
  return resolveInternalBaseUrl(req);
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
      // Email: refund (only on a NEW release with points actually returned;
      // never on an already-released job, and never blocks/fails the release)
      try {
        const releasedCredits = Number(relData?.released_credits) || 0;
        if (relData?.already_released !== true && releasedCredits > 0) {
          const { data: jobRow } = await adminClient
            .from("jobs")
            .select("user_id, endpoint_id")
            .eq("id", jobId)
            .maybeSingle();
          if (jobRow?.user_id) {
            try {
              await adminClient.from("job_events").insert({
                job_id: jobId,
                user_id: jobRow.user_id,
                message: `تعذر استكمال الاستخراج: ${reason} (تم استرداد ${toArabicDigits(Math.round(releasedCredits))} نقطة لرصيدك).`,
                units: 0,
                event_type: "error",
              });
            } catch (evtErr: any) {
              console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
            }

            const rcpt = await getRecipient(adminClient, jobRow.user_id, "refund");
            if (rcpt) {
              const balance = await getBalance(adminClient, jobRow.user_id);
              const endpointId =
                typeof jobRow.endpoint_id === "string" ? jobRow.endpoint_id : "";
              await sendPlatformEmail("refund", rcpt.email, {
                Name: rcpt.name,
                Points: String(Math.round(releasedCredits)),
                JobTitle: endpointId ? `نتائج استخراج ${endpointId}` : "بحثك",
                Reason: reason,
                Balance: String(balance),
              });
            }
          }
        }
      } catch (emailErr) {
        console.error("[email:refund_failed]", emailErr);
      }
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

    const gateStatus = await getLiveProviderGateStatusFromSettings(adminClient);
    const isLiveProviderReady = gateStatus.isReady;

    // A1 Safety Guard: when neither live provider nor non-production test adapter is active,
    // never advance delivered_units or settle; release full reserve with zero charge.
    if (!useMockProvider && !isLiveProviderReady) {
      console.warn("[worker_chunk:gate_blocked]", { jobId, reasonCode: gateStatus.reasonCode });
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

    // Retry reuse: rows the failed run already collected count as delivered by this
    // job (they are in the delivered file and are charged like any delivered row),
    // and the provider is asked only for the deficit.
    const retrySeedResult = spec.retryOfJobId
      ? await ensureRetrySeed(adminClient, {
          newJobId: jobId,
          userId,
          retryOfJobId: spec.retryOfJobId,
          currentStep,
          targetMax,
          newSpec: spec,
          fallback: inMemoryPartialStepFallback,
        })
      : null;
    const retrySeed = retrySeedResult && retrySeedResult.seed ? retrySeedResult.seed : null;
    if (retrySeedResult && !retrySeedResult.seed && retrySeedResult.reason !== "not_requested") {
      console.warn(`[worker:retry_reuse_skipped] jobId=${jobId} reason=${retrySeedResult.reason}`);
    }
    if (retrySeedResult && retrySeedResult.seed && retrySeedResult.created) {
      try {
        await adminClient.from("job_events").insert({
          job_id: jobId,
          user_id: userId,
          message: `أُعيد استخدام ${toArabicDigits(retrySeedResult.seed.rows.length)} سجل جُمعت في المحاولة السابقة، وسنجلب المتبقي فقط.`,
          units: retrySeedResult.seed.rows.length,
          event_type: "progress",
        });
      } catch (evtErr: any) {
        console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
      }
    }
    // Seed units are added to the stored count only by the first chunk; later chunks read them back from the job.
    const seededUnits = currentStep === 0 && retrySeed ? retrySeed.rows.length : 0;
    const effectiveDelivered = currentDelivered + seededUnits;

    const remainingUnits = Math.max(0, targetMax - effectiveDelivered);
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
    // A retried job whose reused rows already cover the target needs no provider call and reserves no provider spend.
    const needsProvider = remainingUnits > 0 || !retrySeed;
    const { data: spendReserve, error: spendErr } = needsProvider
      ? await adminClient.rpc("reserve_provider_spend_atomic", {
          p_job_id: jobId,
          p_provider: "treg",
          p_estimated_cost_usd: estimatedCostUsd,
          p_daily_cap_usd: dailyCapUsd,
        })
      : { data: { allowed: true, cost_id: null }, error: null };

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

    const noProviderCall: Awaited<ReturnType<typeof activeAdapter>> = {
      ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "",
    };
    const adapterResult = !needsProvider ? noProviderCall : await activeAdapter({
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
      deliveredSoFar: effectiveDelivered,
    });

    const actualCostUsd = Math.max(0, Number(adapterResult.costUsd) || 0);
    const providerRows = adapterResult.ok ? (adapterResult.rows || []) : [];
    const requestedDateFrom = typeof spec.params?.dateFrom === "string" ? spec.params.dateFrom : undefined;
    const requestedDateTo = typeof spec.params?.dateTo === "string" ? spec.params.dateTo : undefined;
    const dateFiltered = filterRowsByDateRange(providerRows, requestedDateFrom, requestedDateTo);
    let rawRows = dateFiltered.rows;
    const rawPageRowCount = rawRows.length;
    if (dateFiltered.excludedCount > 0) {
      try {
        await adminClient.from("job_events").insert({
          job_id: jobId,
          user_id: userId,
          message: `تم استبعاد ${toArabicDigits(dateFiltered.excludedCount)} سجل لوقوع تاريخه خارج الفترة المطلوبة أو لعدم توفر تاريخ نشر يمكن التحقق منه.`,
          units: effectiveDelivered,
          event_type: "progress",
        });
      } catch (evtErr: any) {
        console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
      }
    }

    const isCompanyCapability =
      spec.capabilitySlug.includes("company") ||
      spec.capabilitySlug.includes("companies") ||
      spec.capabilitySlug === "web-company-search" ||
      spec.endpointId.includes("icypeas");
    // Social rows (comments, videos) are de-duplicated across pages the same way company rows are: a provider
    // can repeat its first page, and a repeated comment must be neither delivered twice nor billed twice.
    const socialCapability = getSocialCapability(spec.capabilitySlug);
    const dedupeIdentity = isCompanyCapability ? companyIdentity : rowIdentity;
    let duplicateExcludedCount = 0;
    if ((isCompanyCapability || socialCapability) && rawRows.length) {
      const seen = new Set<string>();
      // Rows reused from a failed earlier run are already accepted rows of this job.
      for (const row of retrySeed?.rows || []) {
        const identity = dedupeIdentity(row);
        if (identity) seen.add(identity);
      }
      // A provider may repeat its first page or return overlapping cursor pages.
      // De-duplicate against already accepted rows before validating or billing.
      const partials = adminClient.storage.from("partials");
      for (let step = 0; step < currentStep; step++) {
        const key = `${jobId}/step_${step}.json`;
        let prior: any = inMemoryPartialStepFallback.get(key);
        if (typeof partials?.download === "function") {
          const { data: blob, error } = await partials.download(key);
          if (!error && blob) {
            try { prior = JSON.parse(await blob.text()); } catch { /* retain in-memory fallback */ }
          }
        }
        for (const row of Array.isArray(prior?.rows) ? prior.rows : []) {
          const identity = dedupeIdentity(row);
          if (identity) seen.add(identity);
        }
      }
      rawRows = rawRows.filter((row: any) => {
        const identity = dedupeIdentity(row);
        if (!identity) return true;
        if (seen.has(identity)) { duplicateExcludedCount += 1; return false; }
        seen.add(identity);
        return true;
      });
    }

    if (!isCompanyCapability && retrySeed && rawRows.length) {
      const seededIdentities = new Set<string>();
      for (const row of retrySeed.rows) {
        const identity = rowIdentity(row);
        if (identity) seededIdentities.add(identity);
      }
      rawRows = rawRows.filter((row: any) => {
        const identity = rowIdentity(row);
        if (identity && seededIdentities.has(identity)) { duplicateExcludedCount += 1; return false; }
        return true;
      });
    }

    let filteredRows = rawRows;
    if (spec.params?.exclusionRules && Array.isArray(rawRows) && rawRows.length > 0) {
      const rules = spec.params.exclusionRules;
      const baselineRecords: EntityRecord[] = [
        ...(rules.companyNames || []).map((name: string, i: number) => ({
          id: `base_name_${i}`,
          name,
        })),
        ...(rules.corporateDomains || []).map((domain: string, i: number) => ({
          id: `base_dom_${i}`,
          name: "",
          domain,
        })),
      ];

      const candidateRecords: EntityRecord[] = rawRows.map((r: any, i: number) => ({
        id: r.id || `cand_${i}`,
        name: r.company_name || r.name || r.title || "",
        domain: r.domain || r.website || r.url || "",
        crNumber: r.cr_number || r.commercial_registration,
        ...r,
      }));

      const dedupResult = deduplicateAgainstBaseline(candidateRecords, baselineRecords);
      filteredRows = dedupResult.delivered;
      const excludedCount = dedupResult.confirmedDuplicates?.length || 0;
      duplicateExcludedCount += excludedCount;
      if (excludedCount > 0) {
        try {
          await adminClient.from("job_events").insert({
            job_id: jobId,
            user_id: userId,
            message: `تم تدقيق السجلات واستبعاد ${toArabicDigits(excludedCount)} سجل مكرر.`,
            units: effectiveDelivered,
            event_type: "progress",
          });
        } catch (evtErr: any) {
          console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
        }
      }
    }

    let uncertainRows: any[] = [];
    let relevanceExcludedCount = 0;
    let relevanceSkipReasons: string[] = [];

    if (isCompanyCapability && Array.isArray(filteredRows) && filteredRows.length > 0) {
      const fullText = [
        spec.params?.search,
        spec.params?.query,
        spec.params?.keyword,
        spec.params?.topic,
        spec.params?.location,
        spec.params?.country,
        spec.params?.city,
        typeof spec.params?.query === "object" ? spec.params.query?.keyword?.include?.[0] : "",
        typeof spec.params?.query === "object" ? spec.params.query?.location?.include?.[0] : "",
      ]
        .filter((v) => typeof v === "string" && v.trim().length > 0)
        .join(" ");

      const targetCountryObj =
        detectCountryFromText(spec.params?.country || "") ||
        detectCountryFromText(spec.params?.location || "") ||
        detectCountryFromText(fullText);

      const expectedCountry = targetCountryObj?.canonicalEnglish || null;
      const expectedIndustry = detectIndustryFromText(fullText);

      const candidateRowsForReview = filteredRows.map((r: any, idx: number) => ({
        index: idx,
        id: r.id || `comp_${idx + 1}`,
        company_name: r.company_name || r.name,
        industry: r.industry,
        description: r.description,
        location: r.location || r.city || r.country,
        website: r.website || r.url,
      }));

      const reviews = await reviewCompanyBatch({
        customerRequest: fullText || spec.params?.search || "",
        // An omitted country must stay omitted. Never silently classify the
        // customer's request as Egypt when the brief has no geographic scope.
        targetCountry: expectedCountry || "",
        targetIndustryAr: expectedIndustry.arabicLabel,
        rows: candidateRowsForReview,
      });

      const matchedRows: any[] = [];
      const excludedRows: any[] = [];

      reviews.forEach((rev, idx) => {
        const originalRow = filteredRows[idx];
        if (rev.decision === "match") {
          matchedRows.push({ ...originalRow, _relevance_status: "مطابق", _relevance_reason: rev.reasonAr });
        } else if (rev.decision === "uncertain") {
          uncertainRows.push({ ...originalRow, _relevance_status: "قيد المراجعة والتدقيق", _relevance_reason: rev.reasonAr });
        } else {
          excludedRows.push({ ...originalRow, _relevance_status: "غير مطابق", _relevance_reason: rev.reasonAr });
        }
      });
      relevanceExcludedCount = excludedRows.length;
      relevanceSkipReasons = [...new Set(excludedRows.map((row) => String(row._relevance_reason || "غير مطابق")))].slice(0, 2);

      filteredRows = matchedRows;

      if (excludedRows.length > 0 || uncertainRows.length > 0) {
        console.log(
          `[worker:relevance_layer] Matched: ${matchedRows.length}, Uncertain: ${uncertainRows.length}, Excluded: ${excludedRows.length} (country: ${expectedCountry || "any"}, industry: ${expectedIndustry.arabicLabel})`
        );
      }

    }

    const acceptedRows = adapterResult.ok
      ? filteredRows.slice(0, remainingUnits)
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

    const newDeliveredUnits = effectiveDelivered + acceptedRows.length;
    const isShortLastPage =
      spec.paginationStrategy !== "none" &&
      acceptedRows.length < Math.min(effectivePageSize, remainingUnits) &&
      !adapterResult.nextCursor;
    // Multi-page fetching continues until targetMax matching rows are reached or cursor exhausted
    const hasMorePages =
      Boolean(adapterResult.nextCursor) &&
      newDeliveredUnits < targetMax &&
      !isShortLastPage;
    const isDone = !hasMorePages || newDeliveredUnits >= targetMax;

    // If done and zero rows were collected across the job, release full reserve with zero charge
    if (isDone && newDeliveredUnits === 0) {
      // A valid but empty answer and "records arrived but none matched the request" are different
      // situations and are explained differently; both release the full reserve with zero charge.
      const receivedFromSource = providerRows.length;
      const emptyErrorAr = receivedFromSource > 0
        ? `استلمنا ${toArabicDigits(receivedFromSource)} سجلاً من المصدر لكن لم يطابق أيٌّ منها نطاق طلبك${uncertainRows.length ? ` (أُحيل ${toArabicDigits(uncertainRows.length)} إلى المراجعة ولم يُحتسب)` : ""}؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.`
        : "لم يُعثر على أي بيانات مطابقة من المصدر؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.";
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
      rawRowsCount: rawPageRowCount,
      baselineExcludedCount: duplicateExcludedCount,
      relevanceExcludedCount,
      uncertainRowsCount: uncertainRows.length,
      totalDelivered: newDeliveredUnits,
      rows: acceptedRows,
      uncertainRows,
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

    // One concise customer event per real provider page with received,
    // accepted, cumulative and skipped counts; never include row-level PII.
    try {
      if (!compData.already_completed) {
        const skipReason = relevanceSkipReasons.length ? `سبب التخطي: ${relevanceSkipReasons.join("، ")}` : null;
        const etaParts: string[] = [];
        if (recordedDeliveredUnits < targetMax) {
          const { data: previousPageEvents } = await adminClient.from("job_events")
            .select("message, units, created_at")
            .eq("job_id", jobId)
            .eq("event_type", "progress")
            .order("created_at", { ascending: true })
            .limit(100);
          const { data: startedJob } = await adminClient.from("jobs").select("created_at").eq("id", jobId).maybeSingle();
          // Measured batch durations: job start -> first page, then page -> page, ending now.
          const marks = [
            Date.parse(String(startedJob?.created_at || "")),
            ...(previousPageEvents || [])
              .filter((event: any) => typeof event.message === "string" && /^الصفحة\s/u.test(event.message))
              .map((event: any) => Date.parse(String(event.created_at || ""))),
            Date.now(),
          ].filter((mark) => Number.isFinite(mark));
          const measuredBatchSeconds = marks.slice(1).map((mark, index) => (mark - marks[index]) / 1000);
          const etaSeconds = estimateRemainingSecondsFromBatchDurations({
            remainingRows: targetMax - recordedDeliveredUnits,
            pageSize: effectivePageSize,
            measuredBatchSeconds,
          });
          if (etaSeconds !== null) {
            const etaValue = etaSeconds < 60
              ? `نحو ${toArabicDigits(etaSeconds)} ثانية`
              : `نحو ${toArabicDigits(Math.ceil(etaSeconds / 60))} دقيقة`;
            etaParts.push(`الوقت المتوقع بحسب زمن الصفحات المسجل: ${etaValue}`);
          }
        }
        const parts = [
          `الصفحة ${toArabicDigits(currentStep + 1)}: استلمنا ${toArabicDigits(rawPageRowCount)} سجل`,
          `الجديد ${toArabicDigits(acceptedRows.length)}`,
          `الإجمالي ${toArabicDigits(recordedDeliveredUnits)}`,
          duplicateExcludedCount ? `مكرر أو مستبعد ${toArabicDigits(duplicateExcludedCount)}` : null,
          relevanceExcludedCount ? `غير مطابق ${toArabicDigits(relevanceExcludedCount)}` : null,
          uncertainRows.length ? `قيد المراجعة ${toArabicDigits(uncertainRows.length)}` : null,
          skipReason,
          ...etaParts,
        ].filter(Boolean) as string[];
        await adminClient.from("job_events").insert({
          job_id: jobId,
          user_id: userId,
          message: parts.join(" · "),
          units: recordedDeliveredUnits,
          event_type: "progress",
        });
      }
    } catch (evtErr: any) {
      console.warn("[worker:page_summary_event_warning]", evtErr?.message || "");
    }

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
      const collectedUncertainRows: Record<string, any>[] = [];
      let firstRawProfile: Record<string, any> | null = null;
      let rawRowsCollected = 0;
      let baselineExcludedCount = 0;
      let relevanceExcludedCount = 0;
      const partialsBucket = adminClient.storage.from("partials");

      // Rows reused from the failed earlier run come first; the stored delivered count already includes them.
      if (retrySeed) {
        collectedRows.push(...retrySeed.rows);
        collectedUncertainRows.push(...retrySeed.uncertainRows);
        rawRowsCollected += retrySeed.rawRowsCount;
        baselineExcludedCount += retrySeed.baselineExcludedCount;
        relevanceExcludedCount += retrySeed.relevanceExcludedCount;
      }

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
        if (Array.isArray(stepObj.uncertainRows)) collectedUncertainRows.push(...stepObj.uncertainRows);
        rawRowsCollected += Number(stepObj.rawRowsCount ?? stepObj.rows.length) || 0;
        baselineExcludedCount += Number(stepObj.baselineExcludedCount) || 0;
        relevanceExcludedCount += Number(stepObj.relevanceExcludedCount) || 0;
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
      const dateStr = completedAtIso.split("T")[0];
      const isProfileResearch =
        spec.pricingUnit === "call" &&
        (spec.capabilitySlug.endsWith("-profile") || spec.capabilitySlug.includes("profile")) &&
        !finalRows.some((r) => r.company_name || r.cr_number);

      const isCompanyResearch =
        !isProfileResearch &&
        (spec.capabilitySlug.includes("company") ||
         spec.capabilitySlug.includes("companies") ||
         spec.capabilitySlug === "web-company-search" ||
         finalRows.some((r) => r.company_name || r.cr_number || r.website_url || r.company_size || r.industry));

      const requestScopeText = [
        spec.params?.search,
        spec.params?.query?.keyword?.include,
        spec.params?.keyword,
        spec.params?.industry,
        spec.params?.country,
        spec.params?.location,
      ].flat(Infinity).filter((v) => typeof v === "string").join(" ");
      const detectedCountry = detectCountryFromText(
        [spec.params?.country, spec.params?.location, requestScopeText].filter(Boolean).join(" ")
      )?.arabicLabel || "";
      const detectedIndustry = detectIndustryFromText(requestScopeText);

      const methodologySummary = spec.params?.exclusionRules
        ? `يعرض التقرير ${toArabicDigits(finalRows.length)} سجلًا أعادها المصدر بتاريخ ${dateStr} بعد تطبيق قائمة الاستبعاد المرجعية (${spec.params.exclusionRules.fileName || "ملف الاستبعاد"}). وجود القيم في الحقول لا يثبت صحتها أو شمول النتائج.`
        : `يعرض التقرير ${toArabicDigits(finalRows.length)} سجلًا أعادها المصدر بتاريخ ${dateStr} ضمن نطاق خطة البحث. وجود القيم في الحقول لا يثبت صحتها أو شمول النتائج.`;

      const rawSearchTerms = [
        spec.params?.search,
        spec.params?.topic,
        spec.params?.keyword,
        ...(Array.isArray(spec.params?.query?.keyword?.include) ? spec.params.query.keyword.include : []),
      ];
      const searchTerms = [...new Set(rawSearchTerms
        .filter((term): term is string => typeof term === "string")
        .map((term) => term.trim())
        .filter(Boolean))].slice(0, 10);
      const reportContext = {
        scope: {
          country: detectedCountry || undefined,
          location: typeof spec.params?.city === "string"
            ? spec.params.city
            : typeof spec.params?.location === "string"
              ? spec.params.location
              : undefined,
          searchTerms,
          dateFrom: typeof spec.params?.dateFrom === "string" ? spec.params.dateFrom : undefined,
          dateTo: typeof spec.params?.dateTo === "string" ? spec.params.dateTo : undefined,
          industry: detectedIndustry.arabicLabel !== "قواعد بيانات الشركات"
            ? detectedIndustry.arabicLabel
            : typeof spec.params?.industry === "string" ? spec.params.industry : undefined,
        },
        collection: {
          methodLabel: customerFacingCapabilityLabel(spec.capabilitySlug),
          pagesFetched: currentStep + 1,
          paginationStrategy: spec.paginationStrategy,
          stopReason: finalRows.length >= targetMax ? "target_reached" : "source_exhausted",
        },
        counts: {
          rawRows: rawRowsCollected,
          acceptedRows: finalRows.length,
          baselineExclusions: baselineExcludedCount,
          relevanceExclusions: relevanceExcludedCount,
          uncertainRows: collectedUncertainRows.length,
        },
      };

      const cleanTitle = isCompanyResearch
        ? `شركات ${detectedIndustry.arabicLabel !== "قواعد بيانات الشركات" ? detectedIndustry.arabicLabel : "وأعمال"} في ${detectedCountry || "النطاق المطلوب"}`
        : socialCapability
        ? socialResultTitleAr(socialCapability)
        : "تقرير بيانات من المصادر المتاحة";

      const finalPayload: any = {
        metadata: {
          platform: socialCapability ? socialCapability.platform : "web",
          ...(socialCapability ? { socialKind: socialCapability.kind } : {}),
          country: detectedCountry,
          company: "Diger",
          title: cleanTitle,
          template: isCompanyResearch ? "شركات ومؤسسات" : spec.capabilitySlug,
          jobId,
          collectedAt: completedAtIso,
          rowsCount: finalRows.length,
          targetRequested: targetMax,
          entityType: isCompanyResearch ? "companies" : undefined,
          exclusionApplied: Boolean(spec.params?.exclusionRules),
          methodology: methodologySummary,
          reportContext,
        },
        profile: firstRawProfile || finalRows[0] || null,
        rows: finalRows,
          uncertainRows: collectedUncertainRows,
      };

      const csvPath = `${userId}/${jobId}/result.csv`;
      const xlsxPath = `${userId}/${jobId}/result.xlsx`;
      const pdfPath = `${userId}/${jobId}/result.pdf`;

      try {
        await adminClient.from("job_events").insert({
          job_id: jobId,
          user_id: userId,
          message: "جاري تجهيز ملفات النتائج وتنسيقها...",
          units: finalRows.length,
          event_type: "progress",
        });
      } catch (evtErr: any) {
        console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
      }

      const methodologyText = generateMethodologyText(finalPayload);
      const jsonBuffer = Buffer.from(JSON.stringify(finalPayload), "utf-8");
      const methBuffer = Buffer.from(methodologyText, "utf-8");

      // Save internal research dataset (data.json) & methodology text in partials bucket FIRST.
      // This guarantees customer collected data is NEVER lost even if report rendering fails.
      await Promise.allSettled([
        partialsBucket.upload(
          `${userId}/${jobId}/data.json`,
          jsonBuffer,
          { contentType: "application/json", upsert: true }
        ),
        partialsBucket.upload(
          `${jobId}/data.json`,
          jsonBuffer,
          { contentType: "application/json", upsert: true }
        ),
        partialsBucket.upload(
          `${userId}/${jobId}/methodology.txt`,
          methBuffer,
          { contentType: "text/plain; charset=utf-8", upsert: true }
        ),
        partialsBucket.upload(
          `${jobId}/methodology.txt`,
          methBuffer,
          { contentType: "text/plain; charset=utf-8", upsert: true }
        ),
      ]);

      let savedCsvPath: string | null = null;
      let savedXlsxPath: string | null = null;
      let savedPdfPath: string | null = null;
      const fileErrors: string[] = [];

      try {
        const resultsBucket = adminClient.storage.from("results");

        // 1. CSV Report
        if (spec.outputFormats.includes("csv")) try {
          const csvBuf = generateCsvReport(finalPayload);
          const csvUp = await resultsBucket.upload(csvPath, csvBuf, {
            contentType: "text/csv",
            upsert: true,
          });
          if (!csvUp?.error) {
            savedCsvPath = csvPath;
          } else {
            fileErrors.push(`csv: ${csvUp.error.message || "upload_failed"}`);
            console.error("[worker:csv_upload_error]", csvUp.error);
          }
        } catch (csvErr: any) {
          fileErrors.push(`csv: ${csvErr?.message || "gen_failed"}`);
          console.error("[worker:csv_gen_error]", csvErr?.message || csvErr);
        }

        // 2. Excel (.xlsx) Report
        if (spec.outputFormats.includes("xlsx")) try {
          const xlsxBuf = await generateExcelReport(finalPayload);
          const xlsxUp = await resultsBucket.upload(xlsxPath, xlsxBuf, {
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            upsert: true,
          });
          if (!xlsxUp?.error) {
            savedXlsxPath = xlsxPath;
          } else {
            fileErrors.push(`xlsx: ${xlsxUp.error.message || "upload_failed"}`);
            console.error("[worker:xlsx_upload_error]", xlsxUp.error);
          }
        } catch (xlsxErr: any) {
          fileErrors.push(`xlsx: ${xlsxErr?.message || "gen_failed"}`);
          console.error("[worker:xlsx_gen_error]", xlsxErr?.message || xlsxErr);
        }

        // 3. PDF Report
        if (spec.outputFormats.includes("pdf")) try {
          const pdfBuf = await generatePdfReport(finalPayload);
          const pdfUp = await resultsBucket.upload(pdfPath, pdfBuf, {
            contentType: "application/pdf",
            upsert: true,
          });
          if (!pdfUp?.error) {
            savedPdfPath = pdfPath;
          } else {
            fileErrors.push(`pdf: ${pdfUp.error.message || "upload_failed"}`);
            console.error("[worker:pdf_upload_error]", pdfUp.error);
          }
        } catch (pdfErr: any) {
          fileErrors.push(`pdf: ${pdfErr?.message || "gen_failed"}`);
          console.error("[worker:pdf_gen_error]", pdfErr?.message || pdfErr);
        }
      } catch (importErr: any) {
        fileErrors.push(`import: ${importErr?.message || "import_failed"}`);
        console.error("[worker:file_generators_import_failed]", importErr?.message || importErr);
      }

      if (!savedCsvPath && !savedXlsxPath && !savedPdfPath) {
        console.error(
          "[worker:results_upload_failed] all file generators or uploads failed",
          fileErrors.join("; ")
        );
        const uploadFailReason =
          "تعذر حفظ ملفات النتائج النهائية؛ تم الاحتفاظ بنسخة البيانات في النظام واسترداد كامل الرصيد المحجوز دون أي خصم.";
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
          file_id_xlsx: savedXlsxPath,
          file_id_pdf: savedPdfPath,
          file_id_csv: savedCsvPath,
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
      const primaryResultPath = savedCsvPath || savedXlsxPath || savedPdfPath || `${userId}/${jobId}/result.csv`;
      const { data: settleData, error: settleErr } = await adminClient.rpc("settle_job_atomic", {
        p_job_id: jobId,
        p_points_cap: jobPointsCap,
        p_result_file_id: primaryResultPath,
      });

      if (settleErr) {
        throw settleErr;
      }

      // The retried job has settled, so the failed run's rows and this job's seed are no longer needed.
      await cleanupRetrySources(adminClient, jobId, retrySeed, inMemoryPartialStepFallback);

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

      // Record completion event in job_events table
      try {
        await adminClient.from("job_events").insert({
          job_id: jobId,
          user_id: userId,
          message: `تم إكمال استخراج ${toArabicDigits(finalRows.length)} سجل بنجاح وحفظ ملفات النتائج.`,
          units: finalRows.length,
          event_type: "progress",
          created_at: completedAtIso,
        });

        const chargedPts = Math.round(Number(settleData?.charged_credits) || 0);
        const refundedPts = Math.round(Number(settleData?.refunded_credits) || 0);
        if (refundedPts > 0) {
          await adminClient.from("job_events").insert({
            job_id: jobId,
            user_id: userId,
            message: `تم خصم ${toArabicDigits(chargedPts)} نقطة وتحرير ${toArabicDigits(refundedPts)} نقطة متبقية تلقائياً لرصيدك.`,
            units: finalRows.length,
            event_type: "info",
            created_at: completedAtIso,
          });
        }
      } catch (evtErr: any) {
        console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
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

      // Email: job-done (never blocks or fails the request)
      try {
        const rcpt = await getRecipient(adminClient, userId, "job-done");
        if (rcpt) {
          await sendPlatformEmail("job-done", rcpt.email, {
            Name: rcpt.name,
            JobTitle: `نتائج استخراج ${spec.capabilitySlug}`,
          });
        }
      } catch (emailErr) {
        console.error("[email:job-done_failed]", emailErr);
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
    if (!useMockProvider || !body?.disableSelfChain) {
      const nextUrl = `${getWorkerBaseUrl(req)}/api/worker/chunk`;
      const authHeaders = createInternalWorkerAuthHeaders(jobId);
      const nextStep = currentStep + 1;
      scheduleNextChunkWithWaitUntil(async () => {
        try {
          const res = await fetch(nextUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...authHeaders,
            },
            body: JSON.stringify({
              jobId,
              expectedStep: nextStep,
            }),
          });
          console.log(`[worker:chunk_chained] jobId=${jobId} nextStep=${nextStep} status=${res.status}`);
        } catch (chainErr: any) {
          console.error(`[worker:chunk_chain_failed] jobId=${jobId} nextStep=${nextStep} error=${chainErr?.message || chainErr}`);
        }
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
