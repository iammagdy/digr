import { pointsAr } from "@/lib/pointsFormat";
import { CALL_CAP_NOTE_AR, evaluateProviderCallCap, type CallCapReason } from "../../../../lib/server/providerCallCaps";
import { applyAdvisoryToReviews, applyStrictAdvisory, getRowAdvisor, REVIEW_CALL_COST_ESTIMATE_USD, REVIEW_STOPPED_LOW_YIELD_REASON_AR, REVIEW_DAILY_CEILING_USD, reviewStopForLowYield, socialReviewCapUsd, strictSocialReviewForcedByTests, UNREVIEWED_BY_BUDGET_REASON_AR } from "../../../../lib/server/rowReviewAdvisor";
import { PAGE_REJECTED_REASON_AR, pageRejectedEventAr, reviewSocialPage } from "../../../../lib/server/sampledReview";
import { isReviewCallFailure, REVIEW_COST_EVENT_TYPE, REVIEW_FAILURE_EVENT_TYPE, REVIEW_FALLBACK_EVENT_TYPE, reviewFailureEventMessage, reviewFallbackEventMessage, reviewSpendEventMessage, type ReviewCallFacts } from "../../../../lib/server/reviewSpendLog";
import { noteReviewSpend, resolveReviewBudget } from "../../../../lib/server/reviewDailyGuard";
import { groupRowsByVideo, judgeVideos, videoSelectionEventAr, VIDEO_UNREVIEWED_REASON_AR, type VideoEntry } from "../../../../lib/server/videoRelevance";
import { VIDEO_ADOPTED_KEY } from "../../../../lib/server/videoAdoption";
import type { VideoSelector } from "../../../../lib/server/socialAdapter";
import { regionNameAr } from "../../../../lib/regionNames";
import { refundedPointsFromSettle } from "../../../../lib/server/settleRefund";
import { getCompanyReviewer, hasInjectedCompanyReviewer, runCompanyReview, type CompanyReviewOutcome } from "../../../../lib/server/companyRelevanceReview";
import { decideCompanyRow } from "../../../../lib/server/relevanceDecision";
import { companyActivityKeywords } from "../../../../lib/server/relevanceEvidence";
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
  setProviderAdapterForTesting,
  createBuiltInMockAdapter,
} from "../../../../lib/server/tregAdapter";
import { fakeProviderActive } from "../../../../lib/server/fakeProviderMode";
import { createFakeProviderAdapter } from "../../../../lib/server/fakeSocialSource";
import { getLiveProviderGateStatusFromSettings } from "../../../../lib/server/providerGate";
import { resolveJobExecutionSpec } from "../../../../lib/server/jobExecutionSpec";
import { resultFileManifest } from "../../../../lib/server/resultFileManifest";
import {
  buildRejectedSample,
  mergeRejectedSample,
  REJECTED_SAMPLE_LIMIT,
  type RejectedRowSampleEntry,
} from "../../../../lib/server/rejectedRowSample";
import { sendPlatformEmail, getRecipient } from "../../../../lib/server/sendPlatformEmail";
import { completionNoticeFull, releasedNoticeFull, sendJobNotice } from "../../../../lib/server/jobNotices";
import { getBalance } from "../../../../lib/supabase/ledger";
import {
  getConfiguredProviderSpendCapUsd,
  getConfiguredJobPointsCap,
} from "../../../../functions/shared/providerSpend";
import { CEILING_MESSAGE_AR, evaluateSpendCeilings, readSpendForCeilings, resolveProviderLimits, type CeilingReason, type ProviderLimits } from "../../../../lib/server/providerLimits";
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
import { evaluateResearchRowRelevance, isTopicSearchRequest } from "../../../../lib/server/researchRelevanceGate";
import { decisionMakerDeliveredUnits } from "../../../../functions/shared/decisionMakerPricing";
import { PEOPLE_SETTLEMENT_UNAVAILABLE_AR, requirePeopleSettlementRpc } from "../../../../functions/shared/peopleSettlementReadiness";
import { toArabicDigits } from "../../../../lib/arabicDigits";
import { customerFacingCapabilityLabel } from "../../../../lib/customerFacingRequestLabels";
import { countApproximateDates, DATE_BASIS_KEY, filterRowsByDateRange, sampleUndatedFields, summarizeRowDates, VIDEO_PUBLISHED_AT_KEY, type RowDateSummary } from "../../../../lib/server/dateRangeFilter";
import { allRowsOutsideWindow, dateWindowPageEventAr, OUTSIDE_WINDOW_SENTENCE_AR, youtubeRecencySentenceAr } from "../../../../lib/server/dateWindowNotes";
import { estimateRemainingSecondsFromBatchDurations } from "../../../../functions/shared/liveActivityFeed";
import { cleanupRetrySources, ensureRetrySeed, rowIdentity } from "../../../../lib/server/retryReuse";
import { cursorKey, emptyRunningSet, extendRunningSet, loadRunningSet, rebuildRunningSet, removeRunningSets, runningSetKey, saveRunningSet, type RunningSet } from "../../../../lib/server/jobRunningSet";
import { getSocialCapability, socialResultTitleAr } from "../../../../lib/socialSources";
import { dedupeIdentityFor } from "../../../../lib/server/rowDedupe";
import {
  DECISION_MAKER_ROUTE_COST_CAP_USD,
  estimateDecisionMakerChunkSpendUsd,
  readDecisionMakerSpendToDate,
  remainingDecisionMakerSpendUsd,
} from "../../../../lib/server/decisionMakerSpend";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby maximum

// Fallback in-memory partial step store used ONLY when unit-test mock storage omits .download()
const inMemoryPartialStepFallback = getInMemoryPartialStepFallback();


/** The sentence the automatic reviewers are given as «what the customer asked for»: the plan's own words, the requested country and the sector. */
function reviewCustomerRequestFor(params: Record<string, any> | undefined): string {
  const p = params || {};
  const fullText = [
    p.search, p.query, p.keyword, p.topic, p.location, p.country, p.city,
    typeof p.query === "object" ? p.query?.keyword?.include?.[0] : "",
    typeof p.query === "object" ? p.query?.location?.include?.[0] : "",
  ]
    .filter((v) => typeof v === "string" && v.trim().length > 0)
    .join(" ");
  const requestedRegionAr = regionNameAr(p.region);
  return [p.query && typeof p.query === "string" ? p.query : "", requestedRegionAr ? `الدولة المطلوبة: ${requestedRegionAr}` : "", p.industry, p.country, p.title, p.q, fullText]
    .filter((part) => typeof part === "string" && part.trim()).join(" ").slice(0, 400);
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
  limits: ProviderLimits;
}> {
  // The daily limit and the per-job / per-user ceilings come from the ONE shared resolver (admin-editable, 30 s cache,
  // falls back to the current constants). The points cap stays on its own existing source.
  const { limits } = await resolveProviderLimits(adminClient);
  let jobPointsCap = getConfiguredJobPointsCap();

  try {
    const query = adminClient?.from?.("settings_private")?.select?.("key, value");
    if (query && typeof query.eq === "function") {
      const { data: row } = await query.eq("key", "pricing").maybeSingle();
      const val = row?.value && typeof row.value === "object" ? row.value : row;
      if (typeof val?.jobMaxPointsCap === "number" && val.jobMaxPointsCap > 0) {
        jobPointsCap = val.jobMaxPointsCap;
      }
    }
  } catch {
    // Fallback to configured env/default caps
  }

  return { dailyCapUsd: limits.dailyUsd, jobPointsCap, limits };
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
                message: `تعذر استكمال الاستخراج: ${reason} (تم استرداد ${pointsAr(Math.round(releasedCredits), toArabicDigits)} لرصيدك).`,
                units: 0,
                event_type: "error",
              });
            } catch (evtErr: any) {
              console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
            }

            // In-app: the request could not finish and the whole reserve came back (once per job; the refund e-mail below is its e-mail).
            await sendJobNotice(adminClient, jobRow.user_id, jobId, releasedNoticeFull(releasedCredits));

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

/** How many of the newest page lines the per-page time estimate reads. */
const PAGE_EVENTS_FOR_ETA = 30;

export async function POST(req: NextRequest) {
  const routeStart = Date.now();
  const deadlineMs = routeStart + 45_000;

  // 1. Authenticate with CRON_SECRET (timing-safe)
  if (!verifyCronSecret(req)) {
    return NextResponse.json(
      { success: false, error: "غير مصرح. رمز الأمان الخاص بالمهام المجدولة غير صالح." },
      { status: 401 }
    );
  }

  const body = await req.json().catch(() => ({}));
  // The pressure test on a PREVIEW deployment (never the live site, never the live database: see fakeProviderMode.ts) serves jobs from
  // a built-in fake source. Everything after the provider call, the ledger included, is the production code.
  const fakeMode = fakeProviderActive();
  if (fakeMode && !getInjectedProviderAdapter()) setProviderAdapterForTesting(createFakeProviderAdapter());
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
    !fakeMode &&
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

    // The job's review budget, computed here from the job's own size, never by the model: the per-job rule (every collectable row, up to the per-job
    // ceiling). A job that has not started reviewing takes the previous rule instead when today's review spend has reached REVIEW_DAILY_CEILING_USD or
    // cannot be read (see resolveReviewBudget, below, once what the job has already reviewed is known).
    let reviewCapUsd = socialReviewCapUsd(Number(targetMax), Number(unitPrice));
    let reviewFallbackThisJob = false;

    const useMockProvider = Boolean(
      isMockRequested &&
        (fakeMode || (process.env.NODE_ENV !== "production" && process.env.ENABLE_MOCK_PROVIDER === "true"))
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
    const { dailyCapUsd, jobPointsCap, limits: providerLimits } = await resolveLimitsFromSettings(adminClient);
    const spec = await resolveJobExecutionSpec(
      adminClient,
      jobId,
      userId,
      rawEndpointId,
      Number(unitPrice) || 1
    );

    // The provider is called and billed after this point. Refuse a people job
    // until field-level settlement exists, and release its reserve through the
    // approved atomic release path without making any provider calls.
    if (spec.capabilitySlug === "professional-people-search" && !(await requirePeopleSettlementRpc(adminClient))) {
      const rel = await executeReleaseConfirmation(adminClient, jobId, PEOPLE_SETTLEMENT_UNAVAILABLE_AR);
      if (!rel.confirmed) return buildReleaseFailedResponse(jobId, rel.diagnostic);
      return NextResponse.json(
        {
          success: false,
          released: true,
          chargedCredits: 0,
          deliveredUnits: 0,
          jobId,
          error: PEOPLE_SETTLEMENT_UNAVAILABLE_AR,
          release: rel.data,
        },
        { status: 503 }
      );
    }

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

    const isPeopleJob = spec.capabilitySlug === "professional-people-search";
    const decisionMakerSpendBudgetUsd = isPeopleJob
      ? remainingDecisionMakerSpendUsd(await readDecisionMakerSpendToDate(adminClient, jobId))
      : undefined;

    // A directory search is billed for every record REQUESTED on the page, matched or not: the estimate (and the daily cap
    // gate that reads it) is the full page, not only the records still wanted.
    const isCompanySpecForCaps =
      spec.capabilitySlug.includes("compan") || spec.endpointId.includes("compan") || spec.endpointId.includes("icypeas.compan");
    const estUnitsThisCall =
      spec.pricingUnit === "item"
        ? (isCompanySpecForCaps ? Math.max(1, effectivePageSize) : Math.max(1, Math.min(effectivePageSize, remainingUnits)))
        : 1;
    const estimatedCostUsd = isPeopleJob
      ? Math.max(0.0001, Math.min(
          decisionMakerSpendBudgetUsd || 0,
          estimateDecisionMakerChunkSpendUsd(Math.min(effectivePageSize, Math.max(1, remainingUnits))),
        ))
      : useMockProvider && typeof body?.mockEstimatedCostUsd === "number"
      ? body.mockEstimatedCostUsd
      : Math.max(0.0001, Number((spec.unitCostUsd * estUnitsThisCall).toFixed(6)));

    // 6. Reserve provider spend BEFORE calling provider
    let spendCostId: number | null = null;
    let providerBudgetStopped = false;
    // A retried job whose reused rows already cover the target needs no provider call and reserves no provider spend.
    const needsProvider = (remainingUnits > 0 || !retrySeed) &&
      (!isPeopleJob || Number(decisionMakerSpendBudgetUsd) >= DECISION_MAKER_ROUTE_COST_CAP_USD);
    // Per-job and per-user ceilings (admin-editable). Read only when one is set, so the default path costs nothing extra.
    let ceilingHit: CeilingReason | null = null;
    if (needsProvider && (providerLimits.perJobUsd !== null || providerLimits.perUserDailyUsd !== null)) {
      ceilingHit = evaluateSpendCeilings(providerLimits, await readSpendForCeilings(adminClient, { jobId, userId }), estimatedCostUsd);
    }
    const { data: spendReserve, error: spendErr } = ceilingHit
      ? { data: { allowed: false }, error: null }
      : needsProvider
      ? await adminClient.rpc("reserve_provider_spend_atomic", {
          p_job_id: jobId,
          p_provider: "treg",
          p_estimated_cost_usd: estimatedCostUsd,
          p_daily_cap_usd: dailyCapUsd,
        })
      : { data: { allowed: true, cost_id: null }, error: null };

    if (spendErr || !spendReserve?.allowed) {
      const capErrorMsg = ceilingHit
        ? CEILING_MESSAGE_AR[ceilingHit]
        : "تم الوصول إلى حد المعالجة اليومي؛ حاول مرة أخرى لاحقاً. تم استرداد كامل الرصيد المحجوز دون أي خصم.";
      if (effectiveDelivered > 0) {
        // Do not make another billable call. Keep the matching rows already
        // collected and let the existing atomic settlement charge only them.
        providerBudgetStopped = true;
        console.info(`[worker:provider_budget_stop] jobId=${jobId} delivered=${effectiveDelivered}`);
      } else {
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
            error: ceilingHit ? CEILING_MESSAGE_AR[ceilingHit] : "تم تجاوز الحد اليومي لاستهلاك المزود.",
            ...(ceilingHit ? { ceiling: ceilingHit } : {}),
            release: rel.data,
          },
          { status: 429 }
        );
      }
    }
    if (!providerBudgetStopped) spendCostId = spendReserve.cost_id ?? null;

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

    // Comments of a topic search (TikTok, YouTube): the videos found are judged BEFORE any comment is read, so comments are read, paid for
    // and delivered only under videos about the topic, and an adopted video can be read deeply. The review is the same as the page-level
    // one below (evidence first, then one call on the list, fail closed, inside the job's review budget).
    const earlySocialCap = getSocialCapability(spec.capabilitySlug);
    const selectsVideosFirst = Boolean(earlySocialCap) && earlySocialCap?.kind === "comments" && ["tiktok", "youtube"].includes(String(earlySocialCap?.platform))
      && !isPeopleJob && isTopicSearchRequest(spec.params || {}) && (!useMockProvider || strictSocialReviewForcedByTests());
    // The owner's internal rows about review calls that failed, were cut at the output limit or left rows without a verdict (never customer text).
    const logReviewFailures = async (attempts: ReviewCallFacts[]) => {
      let call = 0;
      for (const attempt of attempts) {
        call += 1;
        if (!isReviewCallFailure(attempt)) continue;
        try {
          await adminClient.from("job_events").insert({ job_id: jobId, user_id: userId, message: reviewFailureEventMessage(currentStep, call, attempt), units: effectiveDelivered, event_type: REVIEW_FAILURE_EVENT_TYPE });
        } catch (evtErr: any) {
          console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
        }
      }
    };
    let videoSelectionUsd = 0;
    let videoSelectionCalls = 0;
    let videoSelectionUnreviewed = false;
    // What the job's earlier chunks already spent on review (read from the running record, before the adapter runs: the video selection
    // happens inside it). An unreadable record counts as nothing here; the page-level review below reads it again and rebuilds it.
    let reviewUsdBeforeThisChunk = 0;
    let priorReviewSet: RunningSet | null = null;
    if (currentStep > 0 && (selectsVideosFirst || earlySocialCap)) {
      try {
        priorReviewSet = await loadRunningSet(adminClient.storage.from("partials"), jobId, currentStep - 1);
      } catch {
        priorReviewSet = null;
      }
    }
    if (selectsVideosFirst) reviewUsdBeforeThisChunk = priorReviewSet?.reviewUsd ?? 0;
    // The daily review guard: never throws, one cached read per instance; chat and the rest of the job do not wait on anything else.
    if (earlySocialCap) {
      const budget = await resolveReviewBudget({
        admin: adminClient,
        targetMax: Number(targetMax),
        unitPricePoints: Number(unitPrice),
        stickyFallback: priorReviewSet?.reviewFallback === true,
        alreadyReviewing: (priorReviewSet?.reviewCallCount ?? 0) > 0 || (priorReviewSet?.reviewUsd ?? 0) > 0,
      });
      reviewCapUsd = budget.capUsd;
      reviewFallbackThisJob = budget.rule !== "normal";
      if (budget.fresh && jobId) {
        try {
          await adminClient.from("job_events").insert({
            job_id: jobId,
            user_id: userId,
            message: reviewFallbackEventMessage({ step: currentStep, reason: budget.rule === "read_failed" ? "read_failed" : "daily_ceiling", todayUsd: budget.todayUsd, ceilingUsd: REVIEW_DAILY_CEILING_USD, capUsd: budget.capUsd }),
            units: 0,
            event_type: REVIEW_FALLBACK_EVENT_TYPE,
          });
        } catch (evtErr: any) {
          console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
        }
      }
    }
    const videoSelector: VideoSelector | undefined = selectsVideosFirst
      ? async (refs) => {
          // A video with no text of its own cannot be judged from the list: its comments are read and the page-level review sees a few of them.
          const judgeable = refs.map((ref, i) => ({ ref, i })).filter(({ ref }) => Boolean((ref.title || "").trim()));
          const deferred = refs.filter((ref) => !(ref.title || "").trim());
          if (judgeable.length === 0) return { adopted: [], deferred };
          const videos: VideoEntry[] = judgeable.map(({ ref, i }) => ({ key: `v${i}`, title: ref.title || "", channel: ref.channel || "", rowIndexes: [i], sampleComments: [] }));
          const outcome = await judgeVideos({
            advisor: getRowAdvisor(),
            customerRequest: reviewCustomerRequestFor(spec.params),
            kind: `${String(spec.capabilitySlug || "")}-video-list`,
            videos,
            request: { query: typeof spec.params?.query === "string" ? spec.params.query : "", region: typeof spec.params?.region === "string" ? spec.params.region : "" },
            budgetUsd: Math.max(0, reviewCapUsd - reviewUsdBeforeThisChunk - videoSelectionUsd),
            callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD,
            deadlineMs: deadlineMs - 8_000,
          });
          videoSelectionUsd += outcome.costUsd;
          videoSelectionCalls += outcome.attempts.length;
          await logReviewFailures(outcome.attempts);
          videoSelectionUnreviewed = [...outcome.judgements.values()].some((judgement) => judgement.by === "unreviewed");
          if (userId) {
            for (const attempt of outcome.attempts) {
              try {
                await adminClient.from("llm_usage").insert({
                  user_id: userId,
                  tokens_in: attempt.usage?.inputTokens ?? 0,
                  tokens_out: attempt.usage?.outputTokens ?? 0,
                  model: attempt.usage?.model ?? (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim(),
                  latency_ms: attempt.usage?.latencyMs ?? 0,
                  reason: attempt.failure ? `relevance_review_failed:${attempt.failure}` : "relevance_review",
                  cost_usd: Number((attempt.usage?.costUsd ?? 0).toFixed(6)),
                  created_at: new Date().toISOString(),
                });
              } catch (usageErr: any) {
                console.warn("[worker:relevance_review_usage_log_failed]", usageErr?.message || "");
              }
              if (attempt.failure) console.warn(`[worker:relevance_review_failed] code=${attempt.failure} stop=${attempt.stopReason || ""}`);
            }
          }
          try {
            await adminClient.from("job_events").insert({ job_id: jobId, user_id: userId, message: videoSelectionEventAr(outcome.judgements.values()), units: effectiveDelivered, event_type: "info" });
          } catch (evtErr: any) {
            console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
          }
          return { adopted: judgeable.filter(({ i }) => outcome.judgements.get(`v${i}`)?.decision === "match").map(({ ref }) => ref), deferred };
        }
      : undefined;

    const noProviderCall: Awaited<ReturnType<typeof activeAdapter>> = {
      ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "",
    };
    const rawAdapterResult = providerBudgetStopped || !needsProvider ? noProviderCall : await activeAdapter({
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
      deadlineMs,
      ...(videoSelector ? { videoSelector } : {}),
      ...(isPeopleJob ? { decisionMakerSpendBudgetUsd } : {}),
    });

    // A page that fails AFTER rows were already delivered ends the collection instead of the job: the rows collected so
    // far are kept and the existing settlement charges only them (the same way a closed daily budget stops a job).
    // Nothing was delivered yet -> unchanged: the error below releases the whole reserve with zero charge.
    const providerFailedAfterDelivery = !rawAdapterResult.ok && effectiveDelivered > 0 && needsProvider && !providerBudgetStopped;
    const adapterResult = providerFailedAfterDelivery ? noProviderCall : rawAdapterResult;
    if (providerFailedAfterDelivery) {
      console.warn(`[worker:provider_failed_after_delivery] jobId=${jobId} delivered=${effectiveDelivered}`);
    }

    // The provider's real cost is committed whatever the outcome of the page.
    const actualCostUsd = Math.max(0, Number(rawAdapterResult.costUsd) || 0);
    const providerRows = adapterResult.ok ? (adapterResult.rows || []) : [];
    const requestedDateFrom = typeof spec.params?.dateFrom === "string" ? spec.params.dateFrom : undefined;
    const requestedDateTo = typeof spec.params?.dateTo === "string" ? spec.params.dateTo : undefined;
    // People and companies are directories with no publication date: an explicit window never removes a row that has none.
    const directoryJob = isPeopleJob || /compan|icypeas/i.test(`${spec.capabilitySlug} ${spec.endpointId}`);
    const dateFiltered = filterRowsByDateRange(providerRows, requestedDateFrom, requestedDateTo, { keepUndated: directoryJob });
    let rawRows = dateFiltered.rows;
    const rawPageRowCount = rawRows.length;
    // Feeds (X, TikTok, YouTube, Facebook) say WHY the window dropped rows: out of the window or no readable date, with the oldest/newest date seen.
    const feedHasWindow = Boolean(getSocialCapability(spec.capabilitySlug)) && Boolean(requestedDateFrom || requestedDateTo);
    const dateSummary: RowDateSummary | null = feedHasWindow && providerRows.length > 0
      ? summarizeRowDates(providerRows, requestedDateFrom, requestedDateTo)
      : null;
    const allRowsOutside = dateSummary ? allRowsOutsideWindow(dateSummary, providerRows.length) : false;
    // Rows with no readable date: which date-like fields they do carry (names and short values only), so the next failure proves its own cause.
    const undatedFieldSample = dateSummary && dateSummary.missing > 0 ? sampleUndatedFields(providerRows) : [];
    // Comments the source gave no date for were judged by the date of their video; the marks are internal and never delivered.
    const videoBasisRows = providerRows.filter((row: any) => row && row[DATE_BASIS_KEY] === "video").length;
    if (videoBasisRows > 0) {
      for (const row of rawRows as any[]) {
        delete row[DATE_BASIS_KEY];
        delete row[VIDEO_PUBLISHED_AT_KEY];
      }
    }
    if (dateSummary || dateFiltered.excludedCount > 0) {
      try {
        await adminClient.from("job_events").insert({
          job_id: jobId,
          user_id: userId,
          message: dateSummary
            ? dateWindowPageEventAr(dateSummary, providerRows.length, { videoBasis: videoBasisRows, approximate: countApproximateDates(providerRows) })
            : `تم استبعاد ${toArabicDigits(dateFiltered.excludedCount)} سجل لوقوع تاريخه خارج الفترة المطلوبة أو لعدم توفر تاريخ نشر يمكن التحقق منه.`,
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
    const dedupeIdentity = dedupeIdentityFor(isCompanyCapability ? "company" : isPeopleJob ? "person" : "social");
    let duplicateExcludedCount = 0;
    // Accepted rows of each earlier page (null = unreadable): feeds the stop rule for pages that find nothing.
    const priorBatchUnits: Array<number | null> = Array.from({ length: currentStep }, () => null);
    // Cursors already used by this job, in the form the running set keeps them (see cursorKey).
    const seenProviderCursors = new Set<string>();
    if (currentCursor && currentCursor !== "completed") seenProviderCursors.add(cursorKey(currentCursor));
    // What the earlier chunks left behind (row identities, cursors, rows per page), read from ONE running record, not rebuilt from every earlier chunk.
    const trackRunningSet = isCompanyCapability || Boolean(socialCapability) || isPeopleJob;
    let runningSet: RunningSet | null = currentStep === 0 ? emptyRunningSet() : null;
    if (trackRunningSet && (rawRows.length > 0 || currentStep > 0)) {
      const seen = new Set<string>();
      // Rows a sample job already delivered (the «عينة أولًا» remainder): never delivered again, never billed again.
      for (const key of Array.isArray(spec.params?.excludeRowKeys) ? spec.params.excludeRowKeys : []) {
        if (typeof key === "string" && key) seen.add(key);
      }
      // Rows reused from a failed earlier run are already accepted rows of this job.
      for (const row of retrySeed?.rows || []) {
        const identity = dedupeIdentity(row);
        if (identity) seen.add(identity);
      }
      // A provider may repeat its first page or return overlapping cursor pages.
      // De-duplicate against already accepted rows before validating or billing.
      const partials = adminClient.storage.from("partials");
      // (the guard above already read it for a social job: not downloaded twice)
      runningSet = currentStep === 0 ? emptyRunningSet() : priorReviewSet ?? await loadRunningSet(partials, jobId, currentStep - 1);
      if (!runningSet) {
        // No readable running record (a job that started before it existed, a lost or damaged file): rebuild it from the earlier chunks' files, as before.
        runningSet = await rebuildRunningSet(currentStep, dedupeIdentity, async (step) => {
          const key = `${jobId}/step_${step}.json`;
          let prior: any = inMemoryPartialStepFallback.get(key);
          if (typeof partials?.download === "function") {
            const { data: blob, error } = await partials.download(key);
            if (!error && blob) {
              try { prior = JSON.parse(await blob.text()); } catch { /* retain in-memory fallback */ }
            }
          }
          return prior ?? null;
        });
      }
      for (const identity of runningSet.identities) seen.add(identity);
      for (const cursor of runningSet.cursors) seenProviderCursors.add(cursor);
      runningSet.batchUnits.forEach((units, index) => { if (index < priorBatchUnits.length) priorBatchUnits[index] = units; });
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
    // Rows nobody reviewed because the job's review budget was used up: not delivered, not charged, listed apart in the «غير مراجَع» sheet.
    let unreviewedRows: any[] = [];
    const budgetUnreviewed = new Set<number>();
    let reviewBudgetUsedUp = false;
    let reviewUsdThisChunk = videoSelectionUsd;
    // Review calls of this chunk (the video selection inside the adapter counts), what the company review spent (logged, not part of the social budget), rows that reached the gate.
    let reviewCallsThisChunk = videoSelectionCalls;
    let companyReviewUsdThisChunk = 0;
    let rowsSeenThisChunk = 0;
    let reviewStoppedForLowYield = false;
    let reviewFailureCodes: string[] = [];
    let reviewDiagnostics: Array<Record<string, unknown>> = [];
    let reviewSampleSummary: Record<string, unknown> | null = null;
    let relevanceExcludedCount = 0;
    let relevanceSkipReasons: string[] = [];
    // Set when the automatic relevance review could not review some candidate rows: they go to the review sheet, paging
    // stops (no more provider rows are bought for rows nobody can check), and an all-unreviewed job releases the reserve.
    let reviewUnavailable = false;

    if (Array.isArray(filteredRows) && filteredRows.length > 0) {
      rowsSeenThisChunk = filteredRows.length;
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
      // The sector rules of the gate (for example the electricity checks) are keyed by the sector's full Arabic label.
      // A plan that carries the customer's short word («كهرباء») is read to that label first, so the rules still apply.
      const recognizedSector = isCompanyCapability
        ? detectIndustryFromText(`${typeof spec.params?.industry === "string" ? spec.params.industry : ""} ${fullText}`)
        : null;
      const expectedIndustry = isCompanyCapability
        ? String(recognizedSector?.exactTaxonomy?.length ? recognizedSector.arabicLabel : (spec.params?.industry || recognizedSector?.arabicLabel))
        : "";

      // The row gate is deterministic and runs for every capability before acceptedRows
      // is counted, saved, or charged. LLM classification is intentionally not on this
      // billing path: it may advise separately but cannot increase delivered units.
      let reviews = filteredRows.map((row: any, idx: number) => ({
        index: idx,
        ...evaluateResearchRowRelevance(row, {
          capabilitySlug: spec.capabilitySlug,
          endpointId: spec.endpointId,
          params: {
            ...(spec.params || {}),
            ...(isCompanyCapability ? {
              // The location matcher is keyed by the canonical English country; the plan's Arabic «مصر» would
              // reject every English «Cairo, Egypt» row.
              country: expectedCountry || spec.params?.country || "",
              industry: expectedIndustry,
            } : {}),
          },
        }),
      }));

      const reviewCustomerRequest = reviewCustomerRequestFor(spec.params);
      const matchedForAdvice = reviews
        .filter((rev) => rev.decision === "match")
        .map((rev) => ({ index: rev.index, row: filteredRows[rev.index] as Record<string, any> }));
      // Company rows: the strict review (production always; in tests only when a test injected a reviewer). A label alone
      // never delivers a row; a deterministic match is delivered only when Claude's structured review says the company
      // itself does the requested activity AND quotes its own text. Anything else (a doubt, a failure, a timeout, a
      // disabled reviewer) puts the row in the labelled review sheet: not delivered, not charged. Claude never promotes.
      const strictCompanyReview = isCompanyCapability && (!useMockProvider || hasInjectedCompanyReviewer());
      // Posts and comments of a topic search (X, TikTok, YouTube) are presumed on topic; only the rows the gate flags as doubtful are
      // reviewed, and those are delivered only when the review confirms them (fail closed). Feeds without a topic filter keep the strict gate., with the reviewer of rows and a cost cap per job.
      const strictSocialReview = ["x", "tiktok", "youtube"].includes(String(getSocialCapability(spec.capabilitySlug)?.platform)) && !isCompanyCapability && !isPeopleJob && (!useMockProvider || strictSocialReviewForcedByTests());

      // Comments of a topic search on TikTok or YouTube are judged by their video; X posts keep the per-post review.
      const socialCapabilityDef = getSocialCapability(spec.capabilitySlug);
      const videoLevelComments = strictSocialReview && socialCapabilityDef?.kind === "comments" && ["tiktok", "youtube"].includes(String(socialCapabilityDef.platform)) && isTopicSearchRequest(spec.params || {});

      if (strictCompanyReview) {
        const reviewKeywords = [...new Set([...companyActivityKeywords(spec.params), ...companyActivityKeywords({ industry: expectedIndustry }), ...(recognizedSector?.englishKeywords || [])])];
        const reviewModel = (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim();
        let outcome: CompanyReviewOutcome = { verdicts: new Map(), failure: null, attempts: 0 };
        if (matchedForAdvice.length > 0) {
          outcome = await runCompanyReview({
            reviewer: getCompanyReviewer(),
            request: { customerRequest: reviewCustomerRequest, activityKeywords: reviewKeywords, country: expectedCountry || "", rows: matchedForAdvice },
            // leave time after the review for saving the page, building the files and settling
            deadlineMs: deadlineMs - 8_000,
            onAttempt: async (attempt) => {
              reviewCallsThisChunk += 1;
              companyReviewUsdThisChunk += Math.max(0, attempt.usage?.costUsd ?? 0);
              if (!userId) return;
              try {
                await adminClient.from("llm_usage").insert({
                  user_id: userId,
                  tokens_in: attempt.usage?.inputTokens ?? 0,
                  tokens_out: attempt.usage?.outputTokens ?? 0,
                  model: attempt.usage?.model ?? reviewModel,
                  latency_ms: attempt.usage?.latencyMs ?? 0,
                  reason: attempt.failure ? "relevance_review_failed" : "relevance_review",
                  cost_usd: Number((attempt.usage?.costUsd ?? 0).toFixed(6)),
                  created_at: new Date().toISOString(),
                });
              } catch (usageErr: any) {
                console.warn("[worker:relevance_review_usage_log_failed]", usageErr?.message || "");
              }
              if (attempt.failure) console.warn(`[worker:relevance_review_failed] code=${attempt.failure}`);
            },
            onRetry: async () => {
              try {
                await adminClient.from("job_events").insert({
                  job_id: jobId,
                  user_id: userId,
                  message: "جاري إعادة التحقق من ملاءمة السجلات",
                  units: effectiveDelivered,
                  event_type: "progress",
                });
              } catch (evtErr: any) {
                console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
              }
            },
          });
        }
        let unreviewed = 0;
        reviews = reviews.map((rev) => {
          if (rev.decision !== "match") return rev;
          const decided = decideCompanyRow({
            deterministic: rev,
            verdict: outcome.verdicts.get(rev.index),
            row: filteredRows[rev.index] as Record<string, any>,
            keywords: reviewKeywords,
          });
          if (decided.reasonCode === "review_unavailable") unreviewed += 1;
          return { index: rev.index, decision: decided.decision, reasonAr: decided.reasonAr };
        });
        if (unreviewed > 0) {
          reviewUnavailable = true;
          console.warn(`[worker:relevance_review_unavailable] unreviewed=${unreviewed} failure=${outcome.failure || "incomplete"}`);
          try {
            await adminClient.from("job_events").insert({
              job_id: jobId,
              user_id: userId,
              message: `تعذّر التحقق الآلي من ملاءمة ${toArabicDigits(unreviewed)} سجل الآن؛ وُضعت في ورقة المراجعة ولم تُحتسب.`,
              units: effectiveDelivered,
              event_type: "info",
            });
          } catch (evtErr: any) {
            console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
          }
        }
      } else if (strictSocialReview && reviewStopForLowYield({
        spentUsd: (runningSet?.reviewUsd ?? 0) + videoSelectionUsd,
        budgetUsd: reviewCapUsd,
        // The accepted count is known only when every earlier chunk recorded it; an unknown one never stops a job.
        rowsSeen: (runningSet?.batchUnits ?? []).some((units) => units === null) ? undefined : runningSet?.rowsSeen,
        accepted: (runningSet?.batchUnits ?? []).reduce<number>((sum, units) => sum + (units ?? 0), 0),
      })) {
        // The job's review budget is used up and fewer than 10% of the rows seen so far were accepted: nothing more is reviewed or delivered.
        // The rows of this page wait in the review sheet (not delivered, not charged) and the job stops buying pages.
        reviewStoppedForLowYield = true;
        reviews = reviews.map((rev) => {
          if (rev.decision !== "match") return rev;
          budgetUnreviewed.add(rev.index);
          return { ...rev, decision: "uncertain" as const, reasonAr: REVIEW_STOPPED_LOW_YIELD_REASON_AR };
        });
        try {
          await adminClient.from("job_events").insert({
            job_id: jobId,
            user_id: userId,
            message: "توقّف التحقق الآلي لأن نسبة السجلات المطابقة بقيت منخفضة جداً بعد بلوغ الحد المسموح لهذا الطلب؛ وُضعت سجلات هذه الصفحة في ورقة «غير مراجَع» وتوقّف الجمع ولم يُحتسب عليك إلا ما سُلّم.",
            units: effectiveDelivered,
            event_type: "info",
          });
        } catch (evtErr: any) {
          console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
        }
      } else if (videoLevelComments) {
        // Select the VIDEOS of the page: evidence in the video's own text first, then the review of the list of videos (fail closed,
        // inside the job's review budget). The comments of selected videos are delivered; the other videos' comments are not.
        // Comments whose video the adapter already selected before reading them are not judged again.
        const notYetJudged = matchedForAdvice.filter(({ row }) => row[VIDEO_ADOPTED_KEY] !== true);
        if (notYetJudged.length > 0) {
          const { videos, withoutVideo } = groupRowsByVideo(notYetJudged);
          const priorReviewUsd = runningSet?.reviewUsd ?? 0;
          const outcome = await judgeVideos({
            advisor: getRowAdvisor(),
            customerRequest: reviewCustomerRequest,
            kind: `${String(spec.capabilitySlug || "")}-video-list`,
            videos,
            request: { query: typeof spec.params?.query === "string" ? spec.params.query : "", region: typeof spec.params?.region === "string" ? spec.params.region : "" },
            budgetUsd: Math.max(0, reviewCapUsd - priorReviewUsd - videoSelectionUsd),
            callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD,
            deadlineMs: deadlineMs - 8_000,
          });
          reviewUsdThisChunk += outcome.costUsd;
          reviewCallsThisChunk += outcome.attempts.length;
          await logReviewFailures(outcome.attempts);
          reviewFailureCodes = outcome.attempts.map((attempt) => attempt.failure).filter((code): code is NonNullable<typeof code> => Boolean(code));
          reviewDiagnostics = outcome.attempts.map((attempt) => ({
            rows: attempt.rows, failure: attempt.failure, stopReason: attempt.stopReason, detail: attempt.detail,
            tokensIn: attempt.usage?.inputTokens ?? 0, tokensOut: attempt.usage?.outputTokens ?? 0, latencyMs: attempt.usage?.latencyMs ?? 0,
          }));
          if (userId) {
            for (const attempt of outcome.attempts) {
              try {
                await adminClient.from("llm_usage").insert({
                  user_id: userId,
                  tokens_in: attempt.usage?.inputTokens ?? 0,
                  tokens_out: attempt.usage?.outputTokens ?? 0,
                  model: attempt.usage?.model ?? (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim(),
                  latency_ms: attempt.usage?.latencyMs ?? 0,
                  reason: attempt.failure ? `relevance_review_failed:${attempt.failure}` : "relevance_review",
                  cost_usd: Number((attempt.usage?.costUsd ?? 0).toFixed(6)),
                  created_at: new Date().toISOString(),
                });
              } catch (usageErr: any) {
                console.warn("[worker:relevance_review_usage_log_failed]", usageErr?.message || "");
              }
              if (attempt.failure) console.warn(`[worker:relevance_review_failed] code=${attempt.failure} stop=${attempt.stopReason || ""}`);
            }
          }
          const judgementOfRow = new Map<number, { decision: "match" | "no_match" | "uncertain"; reasonAr: string; budget?: boolean }>();
          for (const video of videos) {
            const judgement = outcome.judgements.get(video.key);
            for (const index of video.rowIndexes) judgementOfRow.set(index, judgement ?? { decision: "uncertain", reasonAr: VIDEO_UNREVIEWED_REASON_AR });
          }
          for (const index of withoutVideo) judgementOfRow.set(index, { decision: "uncertain", reasonAr: VIDEO_UNREVIEWED_REASON_AR });
          const judgedReviews = reviews.map((rev) => {
            if (rev.decision !== "match") return rev;
            const judgement = judgementOfRow.get(rev.index);
            if (!judgement || judgement.decision === "match") return rev;
            // A video the budget did not reach: its comments are not delivered, and wait in the «غير مراجَع» sheet.
            if (judgement.budget) budgetUnreviewed.add(rev.index);
            return { ...rev, decision: judgement.decision, reasonAr: judgement.reasonAr };
          });
          const heldRows = judgedReviews.filter((rev, i) => reviews[i].decision === "match" && rev.decision === "uncertain").length;
          const heldByBudget = judgedReviews.filter((rev, i) => reviews[i].decision === "match" && rev.decision === "uncertain" && budgetUnreviewed.has(rev.index)).length;
          if (heldByBudget > 0) reviewBudgetUsedUp = true;
          reviews = judgedReviews;
          const deliverableWithoutReview = reviews.filter((rev) => rev.decision === "match").length;
          try {
            await adminClient.from("job_events").insert({ job_id: jobId, user_id: userId, message: videoSelectionEventAr(outcome.judgements.values()), units: effectiveDelivered, event_type: "info" });
          } catch (evtErr: any) {
            console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
          }
          if (heldRows > 0) {
            // Paging stops only when no video of the page could be selected and the review could not run.
            reviewUnavailable = deliverableWithoutReview === 0 && [...outcome.judgements.values()].some((judgement) => judgement.by === "unreviewed");
            try {
              await adminClient.from("job_events").insert({
                job_id: jobId,
                user_id: userId,
                message: heldByBudget > 0
                  ? `وصل التحقق الآلي إلى الحد المسموح لهذا الطلب؛ وُضع ${toArabicDigits(heldByBudget)} تعليق في ورقة «غير مراجَع» ولم يُحتسب.`
                  : `وُضع ${toArabicDigits(heldRows)} تعليق في ورقة المراجعة ولم يُحتسب لعدم التأكد من موضوع فيديوهاتها.`,
                units: effectiveDelivered,
                event_type: "info",
              });
            } catch (evtErr: any) {
              console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
            }
          }
        }
      } else if (strictSocialReview) {
        // Posts and comments: every row of the page is reviewed (ONE call for the page) and a deterministic match is delivered only when the
        // review confirms it. A failed or unreadable review leaves the rows in the review sheet (not delivered, not charged) and stops paging.
        // A row the job's review budget did not reach is not delivered either: it goes to its own sheet, «غير مراجَع», not charged, and paging stops.
        if (matchedForAdvice.length > 0) {
          const priorReviewUsd = runningSet?.reviewUsd ?? 0;
          const outcome = await reviewSocialPage({
            advisor: getRowAdvisor(),
            customerRequest: reviewCustomerRequest,
            kind: String(spec.capabilitySlug || ""),
            rows: matchedForAdvice,
            budgetUsd: Math.max(0, reviewCapUsd - priorReviewUsd - videoSelectionUsd),
            callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD,
            deadlineMs: deadlineMs - 8_000,
          });
          reviewUsdThisChunk += outcome.costUsd;
          reviewCallsThisChunk += outcome.attempts.length;
          await logReviewFailures(outcome.attempts);
          reviewFailureCodes = outcome.attempts.map((attempt) => attempt.failure).filter((code): code is NonNullable<typeof code> => Boolean(code));
          // What each review call really did, kept in the step file so a failure proves its own cause (never row content).
          reviewDiagnostics = outcome.attempts.map((attempt) => ({
            rows: attempt.rows, failure: attempt.failure, stopReason: attempt.stopReason, detail: attempt.detail,
            tokensIn: attempt.usage?.inputTokens ?? 0, tokensOut: attempt.usage?.outputTokens ?? 0, latencyMs: attempt.usage?.latencyMs ?? 0,
          }));
          if (outcome.firstCall) reviewSampleSummary = { size: outcome.firstCall.size, reviewed: outcome.firstCall.reviewed, off: outcome.firstCall.off, rate: outcome.firstCall.rate === null ? null : Number(outcome.firstCall.rate.toFixed(3)), pageRejected: outcome.firstCall.pageRejected };
          if (userId) {
            for (const attempt of outcome.attempts) {
              try {
                await adminClient.from("llm_usage").insert({
                  user_id: userId,
                  tokens_in: attempt.usage?.inputTokens ?? 0,
                  tokens_out: attempt.usage?.outputTokens ?? 0,
                  model: attempt.usage?.model ?? (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim(),
                  latency_ms: attempt.usage?.latencyMs ?? 0,
                  reason: attempt.failure ? `relevance_review_failed:${attempt.failure}` : "relevance_review",
                  cost_usd: Number((attempt.usage?.costUsd ?? 0).toFixed(6)),
                  created_at: new Date().toISOString(),
                });
              } catch (usageErr: any) {
                console.warn("[worker:relevance_review_usage_log_failed]", usageErr?.message || "");
              }
              if (attempt.failure) console.warn(`[worker:relevance_review_failed] code=${attempt.failure} stop=${attempt.stopReason || ""}`);
            }
          }
          // A rejected page (most of its first call unrelated): the rows after it are excluded without a review of their own.
          const rejectedPageRows = new Set(outcome.rejected);
          reviews = reviews.map((rev) => (rejectedPageRows.has(rev.index) && rev.decision === "match" ? { ...rev, decision: "no_match" as const, reasonAr: PAGE_REJECTED_REASON_AR } : rev));
          const applied = applyStrictAdvisory(reviews, outcome.verdicts);
          reviews = applied.reviews;
          for (const index of outcome.unreviewedByBudget) budgetUnreviewed.add(index);
          reviews = reviews.map((rev) => (budgetUnreviewed.has(rev.index) && rev.decision === "uncertain" ? { ...rev, reasonAr: UNREVIEWED_BY_BUDGET_REASON_AR } : rev));
          if (outcome.firstCall?.pageRejected && outcome.firstCall.rate !== null) {
            try {
              await adminClient.from("job_events").insert({ job_id: jobId, user_id: userId, message: pageRejectedEventAr(outcome.firstCall.rate, outcome.rejected.length), units: effectiveDelivered, event_type: "info" });
            } catch (evtErr: any) {
              console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
            }
          }
          const heldByBudget = outcome.unreviewedByBudget.length;
          const heldByFailure = applied.unreviewed - heldByBudget;
          if (heldByBudget > 0) {
            // The budget is used up: nothing more on this job can be reviewed, so paging stops (no more rows are bought for rows nobody can check).
            reviewBudgetUsedUp = true;
            try {
              await adminClient.from("job_events").insert({
                job_id: jobId,
                user_id: userId,
                message: `وصل التحقق الآلي إلى الحد المسموح لهذا الطلب؛ وُضع ${toArabicDigits(heldByBudget)} سجل في ورقة «غير مراجَع» ولم يُحتسب.`,
                units: effectiveDelivered,
                event_type: "info",
              });
            } catch (evtErr: any) {
              console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
            }
          }
          if (heldByFailure > 0) {
            // Paging stops when the review confirmed nothing on the page; otherwise the rows it could not check wait in the review sheet
            // and the rest of the job goes on.
            reviewUnavailable = reviews.every((rev) => rev.decision !== "match");
            try {
              await adminClient.from("job_events").insert({
                job_id: jobId,
                user_id: userId,
                message: `تعذّر التحقق الآلي من ملاءمة ${toArabicDigits(heldByFailure)} سجل الآن؛ وُضعت في ورقة المراجعة ولم تُحتسب.`,
                units: effectiveDelivered,
                event_type: "info",
              });
            } catch (evtErr: any) {
              console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
            }
          }
        }
      } else if (matchedForAdvice.length > 0) {
        try {
          const advisory = await getRowAdvisor()({
            customerRequest: [spec.params?.query && typeof spec.params.query === "string" ? spec.params.query : "", spec.params?.industry, spec.params?.country, spec.params?.title, spec.params?.q, fullText]
              .filter((part) => typeof part === "string" && part.trim()).join(" ").slice(0, 400),
            kind: isCompanyCapability ? "companies" : isPeopleJob ? "people" : String(spec.capabilitySlug || ""),
            rows: matchedForAdvice,
          });
          const applied = applyAdvisoryToReviews(reviews, advisory.verdicts);
          reviews = applied.reviews;
          if (applied.demoted > 0) console.log(`[worker:relevance_advisory] moved ${applied.demoted} matched row(s) to review`);
          if (advisory.usage && userId && !advisory.failure) {
            await adminClient.from("llm_usage").insert({
              user_id: userId,
              tokens_in: advisory.usage.inputTokens,
              tokens_out: advisory.usage.outputTokens,
              model: advisory.usage.model,
              latency_ms: advisory.usage.latencyMs,
              reason: "relevance_review",
              cost_usd: Number(advisory.usage.costUsd.toFixed(6)),
              created_at: new Date().toISOString(),
            });
          } else if (advisory.failure && userId) {
            const fallbackModel = (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim();
            await adminClient.from("llm_usage").insert({
              user_id: userId,
              tokens_in: 0,
              tokens_out: 0,
              model: fallbackModel,
              latency_ms: advisory.usage?.latencyMs ?? 0,
              reason: "relevance_review_failed",
              cost_usd: 0,
              created_at: new Date().toISOString(),
            });
            console.warn(`[worker:relevance_advisory_failed] code=${advisory.failure}`);
          }
        } catch (advisoryErr: any) {
          console.warn("[worker:relevance_advisory_skipped]", advisoryErr?.message || "");
        }
      }

      const matchedRows: any[] = [];
      const excludedRows: any[] = [];

      reviews.forEach((rev, idx) => {
        const originalRow = filteredRows[idx];
        if (rev.decision === "match") {
          matchedRows.push({ ...originalRow, _relevance_status: "مطابق", _relevance_reason: rev.reasonAr });
        } else if (rev.decision === "uncertain" && budgetUnreviewed.has(idx)) {
          unreviewedRows.push({ ...originalRow, _relevance_status: "غير مراجَع", _relevance_reason: rev.reasonAr });
        } else if (rev.decision === "uncertain") {
          uncertainRows.push({ ...originalRow, _relevance_status: "قيد المراجعة والتدقيق", _relevance_reason: rev.reasonAr });
        } else {
          excludedRows.push({ ...originalRow, _relevance_status: "غير مطابق", _relevance_reason: rev.reasonAr });
        }
      });
      relevanceExcludedCount = excludedRows.length;
      relevanceSkipReasons = [...new Set(excludedRows.map((row) => String(row._relevance_reason || "غير مطابق")))].slice(0, 2);

      filteredRows = matchedRows;

      if (excludedRows.length > 0 || uncertainRows.length > 0 || unreviewedRows.length > 0) {
        console.log(
          `[worker:relevance_layer] Matched: ${matchedRows.length}, Uncertain: ${uncertainRows.length}, Unreviewed: ${unreviewedRows.length}, Excluded: ${excludedRows.length} (country: ${expectedCountry || "any"}, industry: ${expectedIndustry || "any"})`
        );
      }

      // Diagnosis only: keep a small masked sample of what the gate rejected, with reason codes. It is written
      // before any release path so a job whose rows were all rejected still leaves evidence, and a failure
      // here can never change the delivery, the charge or the chunk result.
      if (excludedRows.length > 0) {
        try {
          const samplePath = `${jobId}/rejected_sample.json`;
          const partialsStore = adminClient.storage.from("partials");
          let stored: RejectedRowSampleEntry[] = [];
          if (typeof partialsStore.download === "function") {
            const { data: blob } = await partialsStore.download(samplePath);
            if (blob) {
              const parsed = JSON.parse(typeof blob.text === "function" ? await blob.text() : String(blob));
              if (Array.isArray(parsed?.sample)) stored = parsed.sample;
            }
          }
          if (stored.length < REJECTED_SAMPLE_LIMIT) {
            const sample = mergeRejectedSample(stored, buildRejectedSample(excludedRows));
            await partialsStore.upload(
              samplePath,
              Buffer.from(JSON.stringify({ jobId, limit: REJECTED_SAMPLE_LIMIT, sample }), "utf-8"),
              { contentType: "application/json", upsert: true }
            );
          }
        } catch {
          // Best effort: the sample is for diagnosis and must not affect the job.
        }
      }

    }

    // This instance's review spend joins the daily guard's cached sum at once (the usage rows were written above).
    noteReviewSpend(reviewUsdThisChunk + companyReviewUsdThisChunk);

    // The job's review spend, for the owner to read later (USD and calls, per chunk and so far). An internal row (its own event type, hidden
    // from the customer's activity list); the customer's own lines above are Arabic and never carry an amount.
    if ((reviewCallsThisChunk > 0 || reviewStoppedForLowYield) && jobId) {
      try {
        await adminClient.from("job_events").insert({
          job_id: jobId,
          user_id: userId,
          message: reviewSpendEventMessage({
            step: currentStep,
            callsThisChunk: reviewCallsThisChunk,
            usdThisChunk: reviewUsdThisChunk + companyReviewUsdThisChunk,
            callsBefore: runningSet?.reviewCallCount ?? 0,
            usdBefore: runningSet?.reviewUsd ?? 0,
            rowsSeenThisChunk,
            stoppedLowYield: reviewStoppedForLowYield,
          }),
          units: effectiveDelivered,
          event_type: REVIEW_COST_EVENT_TYPE,
        });
      } catch (evtErr: any) {
        console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
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
        // DM units are provider call attempts, preserving a conservative
        // per-job estimate from route caps across worker chunks.
        p_units: isPeopleJob ? Number(rawAdapterResult.providerCallCount) || 0 : acceptedRows.length,
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
    const cursorWouldRepeat = Boolean(
      adapterResult.nextCursor && seenProviderCursors.has(cursorKey(adapterResult.nextCursor))
    );
    // Multi-page fetching continues until the requested matching count is reached,
    // the source is exhausted, a cursor cycles, or the spend gate closes.
    // Provider pages are capped per job (providerCallCaps): a search whose pages are mostly rejected stops, it does not
    // page until the source runs out. Rows already matched are kept and charged as usual.
    // Directory searches (companies) and feeds (comments, posts, videos) both stop on the same rule: keep going within the
    // documented caps until the MATCHING count is reached, then deliver honestly as partial and charge only matching rows.
    const pageCapReason = isCompanyCapability || socialCapability
      ? evaluateProviderCallCap({
          pagesDone: currentStep + 1,
          acceptedThisPage: acceptedRows.length,
          priorBatchUnits,
          targetMax,
          pageSize: effectivePageSize,
          kind: isCompanyCapability ? "directory" : "feed",
        })
      : null;
    // A review that could not run stops paging at once: no more provider rows are bought for rows nobody can check.
    const callCapReason: CallCapReason | null = reviewUnavailable ? "review_unavailable" : reviewStoppedForLowYield ? "review_low_yield" : reviewBudgetUsedUp ? "review_budget" : pageCapReason;
    const hasMorePages =
      Boolean(adapterResult.nextCursor) &&
      !cursorWouldRepeat &&
      newDeliveredUnits < targetMax &&
      !isShortLastPage &&
      !callCapReason;
    const isDone = !hasMorePages || newDeliveredUnits >= targetMax;

    // If done and zero rows were collected across the job, release full reserve with zero charge
    if (isDone && newDeliveredUnits === 0) {
      // A valid but empty answer and "records arrived but none matched the request" are different
      // situations and are explained differently; both release the full reserve with zero charge.
      const receivedFromSource = providerRows.length;
      const emptyErrorAr = reviewUnavailable
        ? "تعذّر التحقق الآلي الآن، ولم يُخصم أي رصيد. حاول مرة أخرى بعد قليل."
        : reviewBudgetUsedUp && unreviewedRows.length > 0
        ? `استلمنا ${toArabicDigits(receivedFromSource)} سجلاً من المصدر، لكن التحقق الآلي بلغ الحد المسموح لهذا الطلب قبل أن نتأكد من مطابقة أيٍّ منها لموضوعك؛ لم يُسلَّم شيء، وتم استرداد كامل الرصيد المحجوز دون أي خصم.`
        : receivedFromSource > 0
        ? socialCapability && rawPageRowCount > 0
          // The dates passed the window; what failed is the topic. Saying "your scope" here read as a date problem.
          ? `استلمنا ${toArabicDigits(receivedFromSource)} سجلاً من المصدر${feedHasWindow ? " وتواريخها داخل الفترة التي حددتها" : ""}، لكن لم يتحقق في أيٍّ منها موضوع طلبك${uncertainRows.length ? ` (أُحيل ${toArabicDigits(uncertainRows.length)} إلى المراجعة ولم يُحتسب)` : ""}؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.`
          : `استلمنا ${toArabicDigits(receivedFromSource)} سجلاً من المصدر لكن لم يطابق أيٌّ منها نطاق طلبك${allRowsOutside ? `: ${OUTSIDE_WINDOW_SENTENCE_AR}${youtubeRecencySentenceAr(rawAdapterResult.discoveryWindow) ? `؛ ${youtubeRecencySentenceAr(rawAdapterResult.discoveryWindow)}` : ""}` : ""}${uncertainRows.length ? ` (أُحيل ${toArabicDigits(uncertainRows.length)} إلى المراجعة ولم يُحتسب)` : ""}؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.`
        : rawAdapterResult.emptyReason === "no_relevant_videos" && socialCapability
        ? videoSelectionUnreviewed
          ? "تعذّر التحقق الآلي الآن، ولم يُخصم أي رصيد. حاول مرة أخرى بعد قليل."
          : `وجدنا فيديوهات عن بحثك على ${socialCapability.platform === "youtube" ? "يوتيوب" : "تيك توك"} لكن لم يتناول أيٌّ منها موضوع طلبك، فلم تُجمع تعليقات؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.`
        : rawAdapterResult.emptyReason === "no_videos" && socialCapability
        // The search for videos found none, so no comments were asked for: say that, not «no matching data».
        ? `لم يجد البحث أي فيديو عن موضوعك على ${socialCapability.platform === "youtube" ? "يوتيوب" : socialCapability.platform === "tiktok" ? "تيك توك" : "المنصة"} الآن، فلم تُجمع تعليقات؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.`
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
      ...(undatedFieldSample.length > 0 ? { undatedFieldSample } : {}),
      ...(dateSummary ? { dateWindow: { missing: dateSummary.missing, outside: dateSummary.outside, inside: dateSummary.inside, ...(videoBasisRows > 0 ? { videoBasis: videoBasisRows } : {}), oldest: dateSummary.oldest, newest: dateSummary.newest, sampleDates: dateSummary.sampleDates } } : {}),
      baselineExcludedCount: duplicateExcludedCount,
      relevanceExcludedCount,
      uncertainRowsCount: uncertainRows.length,
      unreviewedRowsCount: unreviewedRows.length,
      ...(reviewUsdThisChunk > 0 ? { reviewUsd: Number(reviewUsdThisChunk.toFixed(6)) } : {}),
      ...(reviewCallsThisChunk > 0 ? { reviewCallCount: reviewCallsThisChunk } : {}),
      ...(reviewFallbackThisJob ? { reviewFallback: true } : {}),
      rowsSeen: rowsSeenThisChunk,
      ...(reviewFailureCodes.length > 0 ? { reviewFailures: reviewFailureCodes } : {}),
      ...(reviewDiagnostics.length > 0 ? { reviewCalls: reviewDiagnostics } : {}),
      ...(reviewSampleSummary ? { reviewSample: reviewSampleSummary } : {}),
      totalDelivered: newDeliveredUnits,
      rows: acceptedRows,
      uncertainRows,
      unreviewedRows,
      rawProfile: adapterResult.rawProfile || null,
      timestamp: new Date().toISOString(),
    };

    // The running record AFTER this chunk, stored beside the chunk's own file (before complete_chunk, so a chunk that dies and re-runs
    // reads the same earlier record and writes this one again). A record that cannot be stored only makes the next chunk rebuild it.
    if (trackRunningSet && runningSet) {
      await saveRunningSet(adminClient.storage.from("partials"), jobId, extendRunningSet(runningSet, currentStep, partialData, dedupeIdentity));
    }

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
    // The previous running record can no longer be read by any chunk (this chunk is recorded as done).
    if (trackRunningSet && currentStep > 0) await removeRunningSets(adminClient.storage.from("partials"), jobId, [currentStep - 1]);

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
            .order("created_at", { ascending: false })
            .limit(PAGE_EVENTS_FOR_ETA);
          const { data: startedJob } = await adminClient.from("jobs").select("created_at").eq("id", jobId).maybeSingle();
          // Measured batch durations: job start -> first page, then page -> page, ending now.
          const marks = [
            Date.parse(String(startedJob?.created_at || "")),
            // the newest page lines, oldest first: after many pages the estimate follows the recent pace, not the first pages
            ...[...(previousPageEvents || [])].reverse()
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
          providerBudgetStopped
            ? "توقف جلب صفحات إضافية بعد بلوغ الحد اليومي الآمن"
            : providerFailedAfterDelivery
              ? "توقف جلب صفحات إضافية لتعذر الوصول إلى المصدر"
              : `الصفحة ${toArabicDigits(currentStep + 1)}: استلمنا ${toArabicDigits(rawPageRowCount)} سجل`,
          `الجديد ${toArabicDigits(acceptedRows.length)}`,
          `الإجمالي ${toArabicDigits(recordedDeliveredUnits)}`,
          duplicateExcludedCount ? `مكرر أو مستبعد ${toArabicDigits(duplicateExcludedCount)}` : null,
          relevanceExcludedCount ? `غير مطابق ${toArabicDigits(relevanceExcludedCount)}` : null,
          uncertainRows.length ? `قيد المراجعة ${toArabicDigits(uncertainRows.length)}` : null,
          unreviewedRows.length ? `غير مراجَع ${toArabicDigits(unreviewedRows.length)}` : null,
          cursorWouldRepeat ? "توقف الجمع لأن المصدر كرر صفحة سبق استلامها" : null,
          callCapReason && newDeliveredUnits < targetMax ? CALL_CAP_NOTE_AR[callCapReason] : null,
          providerBudgetStopped ? "توقف الجمع عند الحد اليومي الآمن، مع تسليم السجلات المطابقة التي جُمعت" : null,
          providerFailedAfterDelivery ? "توقف الجمع لأن المصدر لم يستجب، مع تسليم السجلات المطابقة التي جُمعت" : null,
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
      const collectedUnreviewedRows: Record<string, any>[] = [];
      let firstRawProfile: Record<string, any> | null = null;
      let rawRowsCollected = 0;
      let baselineExcludedCount = 0;
      let relevanceExcludedCount = 0;
      const partialsBucket = adminClient.storage.from("partials");

      // Rows reused from the failed earlier run come first; the stored delivered count already includes them.
      if (retrySeed) {
        collectedRows.push(...retrySeed.rows);
        collectedUncertainRows.push(...retrySeed.uncertainRows);
        collectedUnreviewedRows.push(...(retrySeed.unreviewedRows ?? []));
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
        if (Array.isArray(stepObj.unreviewedRows)) collectedUnreviewedRows.push(...stepObj.unreviewedRows);
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
          pagesFetched: currentStep + (providerBudgetStopped ? 0 : 1),
          paginationStrategy: spec.paginationStrategy,
          stopReason: finalRows.length >= targetMax ? "target_reached" : callCapReason ? "call_cap" : "source_exhausted",
        },
        counts: {
          rawRows: rawRowsCollected,
          acceptedRows: finalRows.length,
          baselineExclusions: baselineExcludedCount,
          relevanceExclusions: relevanceExcludedCount,
          uncertainRows: collectedUncertainRows.length,
          unreviewedRows: collectedUnreviewedRows.length,
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
        unreviewedRows: collectedUnreviewedRows,
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

      // Do not attempt settlement until the terminal cursor and collected count are persisted.
      // settle_job_atomic also guards this state in SQL and can retire a stale lease only after
      // this collection-complete marker has been committed.
      const { data: persistedCompletion, error: persistedCompletionErr } = await adminClient
        .from("jobs")
        .select("status, current_cursor, delivered_units, target_volume_max")
        .eq("id", jobId)
        .maybeSingle();
      if (
        persistedCompletionErr ||
        persistedCompletion?.status !== "running" ||
        persistedCompletion?.current_cursor !== "completed" ||
        Number(persistedCompletion?.delivered_units || 0) !== Number(recordedDeliveredUnits)
      ) {
        throw new Error("تعذر التحقق من اكتمال جمع البيانات قبل التسوية.");
      }

      // Settle job atomically (charges ceil(delivered * unit_price), capped at reserve & jobPointsCap)
      const primaryResultPath = savedCsvPath || savedXlsxPath || savedPdfPath || `${userId}/${jobId}/result.csv`;
      const peopleUnits = isPeopleJob
        ? decisionMakerDeliveredUnits(finalRows, Array.isArray(spec.params?.requiredContactFields)
            ? spec.params.requiredContactFields.filter((field: unknown) => field === "work_email" || field === "phone")
            : ["work_email", "phone"])
        : null;
      const { data: settleData, error: settleErr } = isPeopleJob
        ? await adminClient.rpc("settle_people_job_atomic", {
            p_job_id: jobId,
            p_base_units: peopleUnits!.baseUnits,
            p_email_units: peopleUnits!.emailUnits,
            p_phone_units: peopleUnits!.phoneUnits,
            p_points_cap: jobPointsCap,
            p_result_file_id: primaryResultPath,
          })
        : await adminClient.rpc("settle_job_atomic", {
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
        partialPaths.push(runningSetKey(jobId, currentStep), runningSetKey(jobId, currentStep - 1));
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

        // Fewer rows than requested: say why in the customer's words, never leave the gap unexplained.
        if (finalRows.length < targetMax) {
          const excluded = relevanceExcludedCount + baselineExcludedCount;
          const reason = providerFailedAfterDelivery
            ? "توقف الجمع قبل اكتمال العدد المطلوب لتعذر الوصول إلى المصدر، ولا يُحتسب عليك إلا ما سُلّم."
            : excluded > 0
            ? `استُبعد ${toArabicDigits(excluded)} سجل لأنه لا يطابق طلبك أو مكرر، ولا يُحتسب عليك.`
            : callCapReason
              ? CALL_CAP_NOTE_AR[callCapReason]
              : "لم يتوفر في المصدر عدد أكبر يطابق طلبك.";
          await adminClient.from("job_events").insert({
            job_id: jobId,
            user_id: userId,
            message: `المسلَّم ${toArabicDigits(finalRows.length)} من ${toArabicDigits(targetMax)} مطلوب. ${reason}`,
            units: finalRows.length,
            event_type: "info",
            created_at: completedAtIso,
          });
        }

        const chargedPts = Math.round(Number(settleData?.charged_credits) || 0);
        const refundedPts = refundedPointsFromSettle(settleData);
        if (refundedPts > 0) {
          await adminClient.from("job_events").insert({
            job_id: jobId,
            user_id: userId,
            message: `تم خصم ${pointsAr(chargedPts, toArabicDigits)} وتحرير ${pointsAr(refundedPts, toArabicDigits)} متبقية تلقائياً لرصيدك.`,
            units: finalRows.length,
            event_type: "info",
            created_at: completedAtIso,
          });
        }
      } catch (evtErr: any) {
        console.warn("[worker:job_events_insert_warning]", evtErr?.message || "");
      }

      // The completion notice of the job, in plain Arabic: complete, or partial with what was delivered, charged and returned.
      // One notice per job (a deterministic id), never blocks the request. A partial completion is e-mailed with its own wording.
      const completionFacts = {
        delivered: finalRows.length,
        requested: targetMax,
        chargedPoints: Math.round(Number(settleData?.charged_credits) || 0),
        refundedPoints: refundedPointsFromSettle(settleData),
      };
      const completionIsPartial = finalRows.length < targetMax;
      if (userId) {
        try {
          await sendJobNotice(adminClient, userId, jobId, completionNoticeFull(completionFacts), () => new Date(completedAtIso));
        } catch (notifErr: any) {
          console.error(`[worker:notification_insert_failed] reason=exception code=${notifErr?.code || "unknown"}`);
        }
      }

      // Email: job-done for a full completion (never blocks or fails the request); a partial one was e-mailed above by its notice
      try {
        const rcpt = completionIsPartial ? null : await getRecipient(adminClient, userId, "job-done");
        if (rcpt) {
          const chargedPoints = Math.round(Number(settleData?.charged_credits) || 0);
          await sendPlatformEmail("job-done", rcpt.email, {
            Name: rcpt.name,
            JobTitle: `بحث ${customerFacingCapabilityLabel(spec.capabilitySlug)}`,
            Delivered: toArabicDigits(finalRows.length),
            Requested: toArabicDigits(targetMax),
            Charged: toArabicDigits(chargedPoints),
            Refunded: toArabicDigits(refundedPointsFromSettle(settleData)),
            JobURL: `${(process.env.NEXT_PUBLIC_SITE_URL || "https://diger.tech").replace(/\/+$/, "")}/dashboard/requests?job=${encodeURIComponent(jobId)}`,
          }, `job-done:${jobId}`);
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
        resultFiles: resultFileManifest({
          csv: savedCsvPath,
          xlsx: savedXlsxPath,
          pdf: savedPdfPath,
        }),
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

        // The failure path released the job itself (after the allowed retries): tell the customer once, in the app.
        if (releaseConfirmed && lastFailureData?.released) {
          try {
            const { data: failedJob } = await adminClient.from("jobs").select("user_id").eq("id", jobId).maybeSingle();
            if (failedJob?.user_id) await sendJobNotice(adminClient, failedJob.user_id, jobId, releasedNoticeFull(Number(lastFailureData?.released_credits) || 0));
          } catch {
            // a notice never changes the failure response
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
